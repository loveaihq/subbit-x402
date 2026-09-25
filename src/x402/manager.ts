// The server's channel manager (DESIGN.md §7): redeems what clients were charged. One
// transaction covers up to `maxPerTx` channels: the channels in ledger order, the first spent
// with `Main([step, …])` listing one step per channel in that order (`Sub` for an open channel,
// `Settle` for one its consumer has closed), the rest with `Defer`, one continuing output per
// channel in the same order, and the redeemed value to `payTo`. The provider key signs it here;
// the facilitator only checks and broadcasts. `watch` does this on its own for closed channels,
// which must be settled before their `elapse_at`. When the facilitator holds the provider key
// instead (no `wallet`), the manager sends it the vouchers and checks, once each claim is on chain,
// that it paid `payTo` everything it redeemed.
import type { FacilitatorClient } from "@x402/core/server";
import type { PaymentRequirements } from "@x402/core/types";
import { subbedOf, type ChannelView } from "./cardano.ts";
import type { Chain } from "./chain.ts";
import { buildClaimTx, compareRefs, type ClaimLine, type ClaimRow } from "./claimtx.ts";
import type { SeedWallet } from "./client.ts";
import type { ChannelStorage, ServerChannel } from "./server.ts";
import { LOVELACE, SCHEME, delegationMac, toBase64, type CardanoNetwork } from "./types.ts";

export interface ManagerOptions {
  storage: ChannelStorage;
  /**
   * The provider's wallet: its key is the datum's `provider`; it pays fees and collateral. Absent
   * when the facilitator holds the provider key and builds each claim (`delegationSecret`).
   */
  wallet?: SeedWallet;
  providerKeyHash: string;
  /** The secret shared with the facilitator that holds the provider key: authenticates each claim. */
  delegationSecret?: string;
  chain: Chain;
  facilitator: FacilitatorClient;
  network: CardanoNetwork;
  payTo: string;
  scriptHash: string;
  referenceScript?: string;
}

export interface ClaimResult {
  transaction: string;
  channels: ClaimRow[];
}

export class ChannelManager {
  /** Watches every channel; settles those their consumers close. See `watchChannels`. */
  watch(opts: WatchOptions = {}): Watcher {
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
      const v = await this.o.chain.followChannel(c.anchorRef ?? c.channelRef, this.o.scriptHash, c.channelId);
      if (!v || v.datum.stage.kind === "settled") continue;
      if (BigInt(c.chargedCumulativeAmount) <= v.datum.stage.subbed) continue;
      out.push({ c, v });
    }
    return out.sort((a, b) => compareRefs(a.v.ref, b.v.ref));
  }

  /** Builds and signs one claim over `batch` (already in ledger order); nothing is submitted. */
  async buildClaim(batch: Array<{ c: ServerChannel; v: ChannelView }>): Promise<{ hex: string; rows: ClaimRow[] }> {
    if (!this.o.wallet) throw new Error("the facilitator holds the provider key: it builds the claims");
    const b = { wallet: this.o.wallet, providerKeyHash: this.o.providerKeyHash, chain: this.o.chain, payTo: this.o.payTo, payout: "own" as const, spent: this.spent };
    return buildClaimTx(this.o.referenceScript ? { ...b, referenceScript: this.o.referenceScript } : b, batch.map(lineOf));
  }

  /** Redeems every claimable channel, `maxPerTx` per transaction, through the facilitator. */
  async claim(opts: { channelIds?: string[]; maxPerTx?: number } = {}): Promise<ClaimResult[]> {
    const all = await this.claimable(opts.channelIds);
    const per = opts.maxPerTx ?? 10;
    const results: ClaimResult[] = [];
    for (let i = 0; i < all.length; i += per) {
      const batch = all.slice(i, i + per);
      const req: PaymentRequirements = { scheme: SCHEME, network: this.o.network, asset: LOVELACE, amount: "0", payTo: this.o.payTo, maxTimeoutSeconds: 0, extra: {} };
      let payload: Record<string, unknown>;
      let rows: ClaimRow[];
      if (this.o.wallet) {
        const built = await this.buildClaim(batch);
        rows = built.rows;
        payload = { type: "claim", transaction: toBase64(built.hex), claims: rows.map((r) => ({ channelId: r.channelId, totalClaimed: r.totalClaimed.toString() })) };
      } else {
        // The facilitator builds and signs it from the vouchers, on the server's authentication.
        if (!this.o.delegationSecret) throw new Error("no provider wallet and no delegation secret");
        rows = batch.map(({ c, v }) => ({ channelId: c.channelId, taken: BigInt(c.chargedCumulativeAmount) - subbedOf(v.datum.stage), totalClaimed: BigInt(c.chargedCumulativeAmount), channelRef: "" }));
        const claims = batch.map(({ c, v }) => ({ channelId: c.channelId, totalClaimed: c.chargedCumulativeAmount, channelRef: v.ref, voucher: { maxClaimableAmount: c.signedMaxClaimable, signature: c.signature } }));
        const body = { type: "claim", claims };
        payload = { ...body, delegationMac: delegationMac(this.o.delegationSecret, this.o.payTo, body) };
      }
      const res = await this.o.facilitator.settle({ x402Version: 2, accepted: req, payload }, req);
      if (!res.success) throw new Error(`claim refused: ${res.errorReason} ${res.errorMessage ?? ""} ${res.transaction}`);
      if (!this.o.wallet) await this.audit(res.transaction, rows, batch);
      // Follow each channel to where the claim left it, and record what is now redeemed.
      for (const [j, { c, v }] of batch.entries()) {
        const now = await this.after(v, c.channelId, res.transaction);
        rows[j]!.channelRef = now?.ref ?? "";
        if (v.datum.stage.kind === "closed") {
          // Settled, or already ended by its consumer. The watcher drops the record once that is
          // deep enough in the chain to stay: the record holds the voucher should the settle roll back.
          if (now && now.datum.stage.kind !== "settled") throw new Error(`channel ${c.channelId.slice(0, 16)}… is ${now.datum.stage.kind} after its settle`);
          if (now) await this.o.storage.updateChannel(c.channelId, (cur) => (cur ? { ...cur, channelRef: now.ref, onchainSyncedAt: Date.now() } : cur));
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

  /**
   * A delegated claim is the facilitator's own transaction, and nothing on chain makes it pay the
   * server: check that its outputs at `payTo` hold at least everything it redeemed.
   */
  private async audit(txHash: string, rows: ClaimRow[], batch: Array<{ v: ChannelView }>) {
    const paid = await this.o.chain.paidTo(txHash, this.o.payTo);
    const owed = new Map<string, bigint>();
    rows.forEach((r, j) => {
      const c = batch[j]!.v.datum.constants.currency;
      const unit = c.kind === "ada" ? LOVELACE : c.policy + c.name;
      owed.set(unit, (owed.get(unit) ?? 0n) + r.taken);
    });
    for (const [unit, amount] of owed) {
      if ((paid.get(unit) ?? 0n) < amount) throw new Error(`the facilitator's claim ${txHash} paid ${paid.get(unit) ?? 0n} ${unit} to payTo, having redeemed ${amount}`);
    }
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
  /** A close the watcher had seen is not on chain any more (rolled back): the channel's vouchers are accepted again. */
  | { kind: "reopened"; channelId: string }
  /** A pass failed; the next one tries again. */
  | { kind: "error"; error: unknown };

export interface Watcher {
  stop(): void;
  /** Runs one pass now; resolves when it is done. */
  tick(): Promise<void>;
}

export interface WatchOptions {
  intervalMs?: number;
  onEvent?: (e: WatchEvent) => void;
  /**
   * `poll` (the default) reads every channel on each pass: two or three queries each. `follow`
   * reads it all once, then only the validator address's new transactions, and the outputs of
   * those that spend this server's channels: one query a pass when nothing happens, however many
   * channels there are.
   */
  mode?: "poll" | "follow";
  /**
   * How many blocks deep a transaction must be before the watcher treats it as final: before it
   * drops a record, moves a channel's anchor, or, following, acts on it at all. Default 3; a
   * rollback deeper than that is outside the model.
   */
  depth?: number;
}

/**
 * Every `intervalMs`, reads each channel the server holds vouchers for. A channel its consumer
 * has closed is marked (so its vouchers are refused) and settled with the latest voucher in one
 * claim, well inside the close period. A record is dropped once the channel is settled, or once
 * two passes in a row find no channel at all: one missing read is not proof, since a lagging
 * index can hide a live channel, and the record holds the only copy of the latest voucher.
 */
export function watchChannels(manager: ChannelManager, o: ManagerOptions, opts: WatchOptions = {}): Watcher {
  let running: Promise<void> | undefined;
  const depth = opts.depth ?? 3;
  const drop = async (channelId: string) => {
    await o.storage.updateChannel(channelId, () => undefined);
    opts.onEvent?.({ kind: "gone", channelId });
  };
  /** A channel found closed: refuse its vouchers from here on; settle it if anything is owed. */
  const onClosed = async (c: ServerChannel, v: ChannelView, closed: string[]) => {
    const stage = v.datum.stage;
    if (stage.kind !== "closed") return;
    const withdrawRequestedAt = Number((stage.elapseAt - v.datum.constants.closePeriodMs) / 1000n);
    await o.storage.updateChannel(c.channelId, (cur) => (cur ? { ...cur, channelRef: v.ref, withdrawRequestedAt, onchainSyncedAt: Date.now() } : cur));
    if (c.withdrawRequestedAt === 0) opts.onEvent?.({ kind: "closed", channelId: c.channelId, elapseAt: stage.elapseAt });
    if (BigInt(c.chargedCumulativeAmount) > stage.subbed) closed.push(c.channelId);
  };
  const settle = async (closed: string[]) => {
    if (closed.length > 0) opts.onEvent?.({ kind: "settled", results: await manager.claim({ channelIds: closed }) });
  };
  let cursor: import("./chain.ts").ChainCursor | undefined;
  let synced = false;
  /**
   * Follows the validator's address from `cursor`, one transaction at a time once it is `depth`
   * blocks deep: only those that spend a channel of this server cost a second query.
   */
  const follow = async () => {
    const tip = await o.chain.tipHeight();
    const byRef = new Map((await o.storage.list()).filter((c) => c.channelRef).map((c) => [c.anchorRef ?? c.channelRef, c] as const));
    const closed: string[] = [];
    for (const t of await o.chain.scriptActivity(o.scriptHash, cursor)) {
      if (tip - t.height < depth) break; // the rest next pass, once they are deep enough
      const moves = await o.chain.channelMoves(t.hash, o.scriptHash, (ref) => byRef.has(ref));
      for (const ref of moves.spent) {
        const c = byRef.get(ref);
        if (!c) continue;
        byRef.delete(ref);
        const v = moves.channels?.find((x) => x.datum.constants.tag === c.channelId);
        // Spent with no continuing output (ended, elapsed, closed by agreement), or settled: done.
        // This read is the spending transaction itself, so a lagging index cannot fake it.
        if (!v || v.datum.stage.kind === "settled") {
          await drop(c.channelId);
          continue;
        }
        byRef.set(v.ref, { ...c, channelRef: v.ref, anchorRef: v.ref });
        await o.storage.updateChannel(c.channelId, (cur) => (cur ? { ...cur, channelRef: v.ref, anchorRef: v.ref, onchainSyncedAt: Date.now() } : cur));
        await onClosed(c, v, closed);
      }
      cursor = t;
    }
    await settle(closed);
  };
  const pass = async () => {
    if (opts.mode === "follow") {
      if (synced) return follow();
      // Where the address stands before reading every channel once, so nothing slips in between.
      const tip = await o.chain.scriptTip(o.scriptHash);
      await poll();
      cursor = tip;
      synced = true;
      return;
    }
    await poll();
  };
  /**
   * Reads every channel from its anchor forward. A position the chain has since dropped is not
   * found again, so the record follows the chain back: a rolled-back claim is claimable again, a
   * rolled-back close reopens the channel. What cannot be undone waits until it is `depth` deep:
   * a record goes only once the settle or the exit is, and an anchor moves only to such a position.
   */
  const poll = async () => {
    const closed: string[] = [];
    const tip = await o.chain.tipHeight();
    const deep = async (ref: string) => {
      const h = await o.chain.txHeight(ref.split("#")[0]!);
      return h !== undefined && tip - h >= depth;
    };
    for (const c of await o.storage.list()) {
      if (!c.channelRef) continue;
      const from = c.anchorRef ?? c.channelRef;
      const v = await o.chain.followChannel(from, o.scriptHash, c.channelId);
      if (!v) {
        // Gone, or the index lags: the transaction that ended it decides, once deep enough to stay.
        const exit = await o.chain.exitOf(from, o.scriptHash, c.channelId);
        if (exit && tip - exit.height >= depth) await drop(c.channelId);
        continue;
      }
      const settled = v.datum.stage.kind === "settled";
      const stable = v.ref === c.anchorRef || (await deep(v.ref));
      await o.storage.updateChannel(c.channelId, (cur) =>
        cur
          ? {
              ...cur,
              channelRef: v.ref,
              // Once deep, the chain's position and what it shows redeemed are the record's, lower
              // again if a claim was rolled back.
              ...(stable ? { anchorRef: v.ref, ...(settled ? {} : { totalClaimed: subbedOf(v.datum.stage).toString() }) } : {}),
              onchainSyncedAt: Date.now(),
            }
          : cur,
      );
      if (settled) {
        if (stable) await drop(c.channelId);
        continue;
      }
      if (v.datum.stage.kind === "opened" && c.withdrawRequestedAt !== 0) {
        await o.storage.updateChannel(c.channelId, (cur) => (cur ? { ...cur, withdrawRequestedAt: 0 } : cur));
        opts.onEvent?.({ kind: "reopened", channelId: c.channelId });
        continue;
      }
      await onClosed(c, v, closed);
    }
    await settle(closed);
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

export { compareRefs };

/** A channel's line in a claim: the server's count, on the voucher it holds. */
function lineOf({ c, v }: { c: ServerChannel; v: ChannelView }): ClaimLine {
  return { channelId: c.channelId, totalClaimed: BigInt(c.chargedCumulativeAmount), amount: BigInt(c.signedMaxClaimable), signature: c.signature, v };
}
