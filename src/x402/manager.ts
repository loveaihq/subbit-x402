// The server's channel manager (DESIGN.md §7): redeems what clients were charged. One `Sub`
// transaction covers up to `maxPerTx` channels: the channels in ledger order, the first spent
// with `Main([Sub(n, sig), …])` listing one step per channel in that order, the rest with
// `Defer`, one continuing output per channel in the same order, and the redeemed value to
// `payTo` as the transaction's change. The provider key signs it here; the facilitator only
// checks and broadcasts.
import type { FacilitatorClient } from "@x402/core/server";
import type { PaymentRequirements } from "@x402/core/types";
import { Address, Assets, KeyHash, Transaction, TransactionHash } from "@evolution-sdk/evolution";
import { Redeemer, Step, inlineDatum, subbitScript } from "../subbit.ts";
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

export interface ClaimResult {
  transaction: string;
  channels: Array<{ channelId: string; taken: bigint; totalClaimed: bigint; channelRef: string }>;
}

export class ChannelManager {
  /**
   * Inputs of claims this manager built, and when. Blockfrost's address index trails a confirmed
   * transaction by ~20 s, so a claim built right after another would otherwise pick an input the
   * last one spent; the evaluator then refuses it as missing from the UTxO set.
   */
  private readonly spent = new Map<string, number>();

  constructor(private readonly o: ManagerOptions) {}

  /** Channels with charges not yet redeemed, open on chain, oldest reference first. */
  async claimable(channelIds?: string[]): Promise<Array<{ c: ServerChannel; v: ChannelView }>> {
    const out = [];
    for (const c of await this.o.storage.list()) {
      if (channelIds && !channelIds.includes(c.channelId)) continue;
      if (!c.channelRef || c.withdrawRequestedAt !== 0) continue;
      if (BigInt(c.chargedCumulativeAmount) <= BigInt(c.totalClaimed)) continue;
      const v = await this.o.chain.followChannel(c.channelRef, this.o.scriptHash, c.channelId);
      if (!v || v.datum.stage.kind !== "opened") continue;
      if (BigInt(c.chargedCumulativeAmount) <= v.datum.stage.subbed) continue;
      out.push({ c, v });
    }
    return out.sort((a, b) => compareRefs(a.v.ref, b.v.ref));
  }

  /** Builds and signs one claim over `batch` (already in ledger order); nothing is submitted. */
  async buildClaim(batch: Array<{ c: ServerChannel; v: ChannelView }>): Promise<{ hex: string; rows: ClaimResult["channels"] }> {
    const steps = batch.map(({ c }) => Step.sub(BigInt(c.signedMaxClaimable), c.signature));
    let tx = this.o.wallet.newTx();
    batch.forEach(({ v }, i) => {
      tx = tx.collectFrom({ inputs: [v.utxo], redeemer: i === 0 ? Redeemer.main(steps) : Redeemer.defer() });
    });
    const ref = this.o.referenceScript ? await this.o.chain.getUnspent(this.o.referenceScript) : undefined;
    tx = ref?.scriptRef ? tx.readFrom({ referenceInputs: [ref] }) : tx.attachScript({ script: subbitScript });
    const rows: ClaimResult["channels"] = [];
    let redeemedTokens: Assets.Assets | undefined;
    for (const { c, v } of batch) {
      if (v.datum.stage.kind !== "opened") throw new Error("claimable channels are open");
      const charged = BigInt(c.chargedCumulativeAmount);
      const taken = charged - v.datum.stage.subbed;
      // The channel keeps its ADA: for a token channel that is the reserve, which is the consumer's.
      const value = valueFor(v.datum.constants.currency, v.amount - taken, v.lovelace);
      tx = tx.payToAddress({ address: v.address, assets: value, datum: inlineDatum(v.datum.constants, { kind: "opened", subbed: charged }) });
      rows.push({ channelId: c.channelId, taken, totalClaimed: charged, channelRef: "" });
      const cur = v.datum.constants.currency;
      if (cur.kind !== "ada") redeemedTokens = Assets.merge(redeemedTokens ?? Assets.zero, Assets.fromHexStrings(cur.policy, cur.name, taken, 0n));
    }
    // Redeemed tokens go to payTo in an output of their own, so the provider's change stays
    // ADA-only: otherwise each claim folds an ADA-only UTxO, which collateral needs, into tokens.
    if (redeemedTokens) tx = tx.payToAddress({ address: Address.fromBech32(this.o.payTo), assets: redeemedTokens, autoMinUtxo: true });
    // ADA-only wallet UTxOs for fees and collateral: a token-laden collateral input can leave its return below min-UTxO.
    const listed = await this.o.wallet.getWalletUtxos();
    const refs = new Set(listed.map(refOf));
    for (const [r, at] of [...this.spent]) if (!refs.has(r) || Date.now() - at > 5 * 60_000) this.spent.delete(r);
    const availableUtxos = listed.filter((u) => Assets.hasOnlyLovelace(u.assets) && !this.spent.has(refOf(u)));
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
        const now = await this.o.chain.followChannel(v.ref, this.o.scriptHash, c.channelId);
        if (!now || now.datum.stage.kind !== "opened") throw new Error(`channel ${c.channelId.slice(0, 16)}… not found after the claim`);
        const subbed = now.datum.stage.subbed;
        rows[j]!.channelRef = refOf(now.utxo);
        await this.o.storage.updateChannel(c.channelId, (cur) => (cur ? { ...cur, channelRef: now.ref, totalClaimed: subbed.toString(), onchainSyncedAt: Date.now() } : cur));
      }
      results.push({ transaction: res.transaction, channels: rows });
    }
    return results;
  }
}

export function compareRefs(a: string, b: string): number {
  const [ha, ia] = a.split("#") as [string, string];
  const [hb, ib] = b.split("#") as [string, string];
  return ha < hb ? -1 : ha > hb ? 1 : Number(ia) - Number(ib);
}
