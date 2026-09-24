// The server's channel manager (DESIGN.md §7): redeems what clients were charged. One
// transaction covers up to `maxPerTx` channels: the channels in ledger order, the first spent
// with `Main([step, …])` listing one step per channel in that order (`Sub` for an open channel,
// `Settle` for one its consumer has closed), the rest with `Defer`, one continuing output per
// channel in the same order, and the redeemed value to `payTo`. The provider key signs it here;
// the facilitator only checks and broadcasts. `watch` does this on its own for closed channels,
// which must be settled before their `elapse_at`.
import type { FacilitatorClient } from "@x402/core/server";
import type { PaymentRequirements } from "@x402/core/types";
import { Address, Assets, KeyHash, Transaction, TransactionHash } from "@evolution-sdk/evolution";
import { Redeemer, Step, inlineDatum, subbitScript, type Stage } from "../subbit.ts";
import { refOf, valueFor, type ChannelView } from "./cardano.ts";
import { retryQueries, type Chain } from "./chain.ts";
import { collateralTarget, signedHex, type SeedWallet } from "./client.ts";
import type { ChannelStorage, ServerChannel } from "./server.ts";
import { LOVELACE, SCHEME, toBase64, type CardanoNetwork } from "./types.ts";

export interface ManagerOptions {
  storage: ChannelStorage;
  /** The provider's wallet: its key is the datum's `provider`; it pays fees and collateral. */
  wallet: SeedWallet;
  providerKeyHash: string;
  chain: Chain;
  facilitator: FacilitatorClient;
  network: CardanoNetwork;
  payTo: string;
  scriptHash: string;
  referenceScript?: string;
}

/** How many of the provider's earlier token outputs one claim folds into its own. */
const FOLD = 5;

export interface ClaimResult {
  transaction: string;
  channels: Array<{ channelId: string; taken: bigint; totalClaimed: bigint; channelRef: string }>;
}

export class ChannelManager {
  /** Watches every channel; settles those their consumers close. See `watchChannels`. */
  watch(opts: { intervalMs?: number; onEvent?: (e: WatchEvent) => void } = {}): Watcher {
    return watchChannels(this, this.o, opts);
  }

  /**
   * Inputs of claims this manager built, and when. Blockfrost's address index trails a confirmed
   * transaction by ~20 s, so a claim built right after another would otherwise pick an input the
   * last one spent; the evaluator then refuses it as missing from the UTxO set.
   */
  private readonly spent = new Map<string, number>();

  constructor(private readonly o: ManagerOptions) {}

  /**
   * Channels with charges not yet redeemed, oldest reference first: open ones (a `Sub` takes
   * them) and ones their consumer has closed (a `Settle` takes them and ends the server's part).
   */
  async claimable(channelIds?: string[]): Promise<Array<{ c: ServerChannel; v: ChannelView }>> {
    const out = [];
    for (const c of await this.o.storage.list()) {
      if (channelIds && !channelIds.includes(c.channelId)) continue;
      if (!c.channelRef) continue;
      if (BigInt(c.chargedCumulativeAmount) <= BigInt(c.totalClaimed)) continue;
      const v = await this.o.chain.followChannel(c.channelRef, this.o.scriptHash, c.channelId);
      if (!v || v.datum.stage.kind === "settled") continue;
      if (BigInt(c.chargedCumulativeAmount) <= v.datum.stage.subbed) continue;
      out.push({ c, v });
    }
    return out.sort((a, b) => compareRefs(a.v.ref, b.v.ref));
  }

  /** Builds and signs one claim over `batch` (already in ledger order); nothing is submitted. */
  async buildClaim(batch: Array<{ c: ServerChannel; v: ChannelView }>): Promise<{ hex: string; rows: ClaimResult["channels"] }> {
    const steps = batch.map(({ c, v }) =>
      v.datum.stage.kind === "closed" ? Step.settle(BigInt(c.signedMaxClaimable), c.signature) : Step.sub(BigInt(c.signedMaxClaimable), c.signature),
    );
    let tx = this.o.wallet.newTx();
    batch.forEach(({ v }, i) => {
      tx = tx.collectFrom({ inputs: [v.utxo], redeemer: i === 0 ? Redeemer.main(steps) : Redeemer.defer() });
    });
    const ref = this.o.referenceScript ? await this.o.chain.getUnspent(this.o.referenceScript) : undefined;
    tx = ref?.scriptRef ? tx.readFrom({ referenceInputs: [ref] }) : tx.attachScript({ script: subbitScript });
    const rows: ClaimResult["channels"] = [];
    let redeemedTokens: Assets.Assets | undefined;
    for (const { c, v } of batch) {
      const stage = v.datum.stage;
      if (stage.kind === "settled") throw new Error("a settled channel has nothing left to claim");
      const charged = BigInt(c.chargedCumulativeAmount);
      const taken = charged - stage.subbed;
      // The channel keeps its ADA: for a token channel that is the reserve, which is the consumer's.
      const value = valueFor(v.datum.constants.currency, v.amount - taken, v.lovelace);
      const next: Stage = stage.kind === "closed" ? { kind: "settled" } : { kind: "opened", subbed: charged };
      tx = tx.payToAddress({ address: v.address, assets: value, datum: inlineDatum(v.datum.constants, next) });
      rows.push({ channelId: c.channelId, taken, totalClaimed: charged, channelRef: "" });
      const cur = v.datum.constants.currency;
      if (cur.kind !== "ada") redeemedTokens = Assets.merge(redeemedTokens ?? Assets.zero, Assets.fromHexStrings(cur.policy, cur.name, taken, 0n));
    }
    const listed = await this.o.wallet.getWalletUtxos();
    const refs = new Set(listed.map(refOf));
    for (const [r, at] of [...this.spent]) if (!refs.has(r) || Date.now() - at > 5 * 60_000) this.spent.delete(r);
    const unspent = listed.filter((u) => !this.spent.has(refOf(u)));
    if (redeemedTokens) {
      // Redeemed tokens go to payTo in an output of their own, so the provider's change stays
      // ADA-only: otherwise each claim folds an ADA-only UTxO, which collateral needs, into
      // tokens. Earlier such outputs are folded into it, up to FOLD of them: each holds a
      // min-UTxO of ADA, and one new output per claim spread the provider's ADA until no ADA-only
      // UTxO was big enough for collateral (after step 5 and part of step 6's token run).
      const units = new Set(Assets.getUnits(redeemedTokens));
      const mine = Address.toBech32(await this.o.wallet.address()) === this.o.payTo;
      const folds = mine ? unspent.filter((u) => !Assets.hasOnlyLovelace(u.assets) && Assets.getUnits(u.assets).every((x) => x === "lovelace" || units.has(x))).slice(0, FOLD) : [];
      for (const u of folds) {
        tx = tx.collectFrom({ inputs: [u] });
        redeemedTokens = Assets.merge(redeemedTokens, Assets.withoutLovelace(u.assets));
      }
      tx = tx.payToAddress({ address: Address.fromBech32(this.o.payTo), assets: redeemedTokens, autoMinUtxo: true });
    }
    // ADA-only wallet UTxOs for fees and collateral: a token-laden collateral input can leave its return below min-UTxO.
    const availableUtxos = unspent.filter((u) => Assets.hasOnlyLovelace(u.assets));
    const signed = tx.addSigner({ keyHash: KeyHash.fromHex(this.o.providerKeyHash) });
    const sb = await retryQueries("claim", () => signed.build({ changeAddress: Address.fromBech32(this.o.payTo), availableUtxos, setCollateral: collateralTarget(availableUtxos) }));
    const hex = await signedHex(sb);
    for (const i of Transaction.fromCBORHex(hex).body.inputs) this.spent.set(`${TransactionHash.toHex(i.transactionId)}#${i.index}`, Date.now());
    return { hex, rows };
  }

  /** Redeems every claimable channel, `maxPerTx` per transaction, through the facilitator. */
  async claim(opts: { channelIds?: string[]; maxPerTx?: number } = {}): Promise<ClaimResult[]> {
    const all = await this.claimable(opts.channelIds);
    const per = opts.maxPerTx ?? 10;
    const results: ClaimResult[] = [];
    for (let i = 0; i < all.length; i += per) {
      const batch = all.slice(i, i + per);
      const { hex, rows } = await this.buildClaim(batch);
      const req: PaymentRequirements = { scheme: SCHEME, network: this.o.network, asset: LOVELACE, amount: "0", payTo: this.o.payTo, maxTimeoutSeconds: 0, extra: {} };
      const payload = { type: "claim", transaction: toBase64(hex), claims: rows.map((r) => ({ channelId: r.channelId, totalClaimed: r.totalClaimed.toString() })) };
      const res = await this.o.facilitator.settle({ x402Version: 2, accepted: req, payload }, req);
      if (!res.success) throw new Error(`claim refused: ${res.errorReason} ${res.errorMessage ?? ""} ${res.transaction}`);
      // Follow each channel to where the claim left it, and record what is now redeemed.
      for (const [j, { c, v }] of batch.entries()) {
        const now = await this.after(v, c.channelId, res.transaction);
        rows[j]!.channelRef = now?.ref ?? "";
        if (v.datum.stage.kind === "closed") {
          // Settled, or already ended by its consumer: the server's part in this channel is over.
          if (now && now.datum.stage.kind !== "settled") throw new Error(`channel ${c.channelId.slice(0, 16)}… is ${now.datum.stage.kind} after its settle`);
          await this.o.storage.updateChannel(c.channelId, () => undefined);
          continue;
        }
        if (!now || now.datum.stage.kind === "settled") throw new Error(`channel ${c.channelId.slice(0, 16)}… not found after the claim`);
        // Open, or closed if its consumer closed right after the claim; the watcher takes it from there.
        const subbed = now.datum.stage.subbed;
        await this.o.storage.updateChannel(c.channelId, (cur) => (cur ? { ...cur, channelRef: now.ref, totalClaimed: subbed.toString(), onchainSyncedAt: Date.now() } : cur));
      }
      results.push({ transaction: res.transaction, channels: rows });
    }
    return results;
  }

  /** Where a channel sits once `txHash` has spent it, waiting out an index that still shows it unspent. */
  private async after(v: ChannelView, channelId: string, txHash: string): Promise<ChannelView | undefined> {
    for (let i = 0; ; i++) {
      const now = await this.o.chain.followChannel(v.ref, this.o.scriptHash, channelId);
      if (!now || now.ref !== v.ref) return now;
      if (i === 6) throw new Error(`channel ${channelId.slice(0, 16)}… still shows at ${v.ref} after ${txHash}`);
      await new Promise((r) => setTimeout(r, 5_000));
    }
  }
}

export type WatchEvent =
  /** A consumer closed a channel on its own; the server refuses its vouchers from here on. */
  | { kind: "closed"; channelId: string; elapseAt: bigint }
  /** Closed channels settled, in one claim transaction or more. */
  | { kind: "settled"; results: ClaimResult[] }
  /** The server's part in a channel is over (settled, ended, elapsed or closed by agreement); its record is dropped. */
  | { kind: "gone"; channelId: string }
  /** A pass failed; the next one tries again. */
  | { kind: "error"; error: unknown };

export interface Watcher {
  stop(): void;
  /** Runs one pass now; resolves when it is done. */
  tick(): Promise<void>;
}

/**
 * Every `intervalMs`, reads each channel the server holds vouchers for. A channel its consumer
 * has closed is marked (so its vouchers are refused) and settled with the latest voucher in one
 * claim, well inside the close period. A record is dropped once the channel is settled, or once
 * two passes in a row find no channel at all: one missing read is not proof, since a lagging
 * index can hide a live channel, and the record holds the only copy of the latest voucher.
 */
export function watchChannels(manager: ChannelManager, o: ManagerOptions, opts: { intervalMs?: number; onEvent?: (e: WatchEvent) => void } = {}): Watcher {
  let running: Promise<void> | undefined;
  const missing = new Set<string>();
  const drop = async (channelId: string) => {
    await o.storage.updateChannel(channelId, () => undefined);
    missing.delete(channelId);
    opts.onEvent?.({ kind: "gone", channelId });
  };
  const pass = async () => {
    const closed: string[] = [];
    for (const c of await o.storage.list()) {
      if (!c.channelRef) continue;
      const v = await o.chain.followChannel(c.channelRef, o.scriptHash, c.channelId);
      if (!v) {
        if (missing.has(c.channelId)) await drop(c.channelId);
        else missing.add(c.channelId);
        continue;
      }
      missing.delete(c.channelId);
      const stage = v.datum.stage;
      if (stage.kind === "settled") {
        await drop(c.channelId);
        continue;
      }
      if (stage.kind !== "closed") continue;
      // Refuse vouchers from here on: the channel can only be settled now.
      const withdrawRequestedAt = Number((stage.elapseAt - v.datum.constants.closePeriodMs) / 1000n);
      await o.storage.updateChannel(c.channelId, (cur) => (cur ? { ...cur, channelRef: v.ref, withdrawRequestedAt, onchainSyncedAt: Date.now() } : cur));
      if (c.withdrawRequestedAt === 0) opts.onEvent?.({ kind: "closed", channelId: c.channelId, elapseAt: stage.elapseAt });
      if (BigInt(c.chargedCumulativeAmount) > stage.subbed) closed.push(c.channelId);
    }
    if (closed.length > 0) opts.onEvent?.({ kind: "settled", results: await manager.claim({ channelIds: closed }) });
  };
  const tick = () => {
    running ??= pass()
      .catch((error: unknown) => opts.onEvent?.({ kind: "error", error }))
      .finally(() => {
        running = undefined;
      });
    return running;
  };
  const timer = setInterval(() => void tick(), opts.intervalMs ?? 30_000);
  void tick();
  return { stop: () => clearInterval(timer), tick };
}

export function compareRefs(a: string, b: string): number {
  const [ha, ia] = a.split("#") as [string, string];
  const [hb, ib] = b.split("#") as [string, string];
  return ha < hb ? -1 : ha > hb ? 1 : Number(ia) - Number(ib);
}
