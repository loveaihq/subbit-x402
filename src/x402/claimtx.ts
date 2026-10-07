// One claim transaction over a batch of channels (DESIGN.md §7): the channels in ledger order, the
// first spent with `Main([step, …])` listing one step per channel in that order (`Sub` for an open
// channel, `Settle` for one its consumer has closed), the rest with `Defer`, and one continuing
// output per channel in the same order. Whoever holds the provider key builds and signs it: the
// server's own channel manager, or a facilitator the server has delegated the key to.
import { Address, Assets, KeyHash, Transaction, TransactionHash, type UTxO } from "@evolution-sdk/evolution";
import { Redeemer, Step, inlineDatum, type Stage, type Validator } from "../subbit.ts";
import { FOLD, refOf, valueFor, validatorOf, type ChannelView } from "./cardano.ts";
import { retryQueries, type Chain } from "./chain.ts";
import { WITH_OUR_UTXOS, collateralTarget, signedHex, type SeedWallet } from "./client.ts";
import { assertKeepsFloor, assertRepays, repaymentOutput } from "./repay.ts";

export interface ClaimBuilder {
  /** Holds the provider key; pays the fee and puts up the collateral. */
  wallet: SeedWallet;
  providerKeyHash: string;
  chain: Chain;
  referenceScript?: string;
  /** Where the redeemed value goes. */
  payTo: string;
  /**
   * `own`: the wallet is the server's own, at `payTo`. Redeemed ADA joins its change; redeemed
   * tokens go to `payTo` in an output of their own, with its older token outputs folded in.
   * `delegated`: the wallet is a facilitator's. Everything redeemed goes to `payTo` in one output,
   * topped up to its min-UTxO from the facilitator's wallet when it falls short, and the change
   * goes back to the facilitator.
   */
  payout: "own" | "delegated";
  /** Inputs this builder's recent transactions spent, and when: kept out of coin selection. */
  spent: Map<string, number>;
}

export interface ClaimLine {
  channelId: string;
  /** What the claim brings the channel's `subbed` up to: the server's count. */
  totalClaimed: bigint;
  /** The voucher it redeems: at least `totalClaimed`. */
  amount: bigint;
  signature: string;
  v: ChannelView;
}

export interface ClaimRow {
  channelId: string;
  taken: bigint;
  totalClaimed: bigint;
  channelRef: string;
  /** The transaction that ended this channel once its settle left it empty and sponsored (R3), where the server did. */
  ended?: string;
  /** Why it did not, when it tried: the sponsor's floor stays in the channel until `ChannelManager.endEmpty` succeeds. */
  endError?: string;
}

/** The one validator a claim's channels are at: a transaction attaches one script, and `Main` lists steps for it alone. */
function validatorOfBatch(views: ChannelView[]): Validator {
  const hashes = new Set(views.map((v) => validatorOf(v).hash));
  if (hashes.size !== 1) throw new Error("one claim redeems the channels of one validator");
  return validatorOf(views[0]!);
}

/** The wallet's UTxOs less those this builder's recent transactions spent, which its provider may still list. */
async function unspentOf(b: ClaimBuilder): Promise<UTxO.UTxO[]> {
  const listed = await b.wallet.getWalletUtxos();
  const refs = new Set(listed.map(refOf));
  for (const [r, at] of [...b.spent]) if (!refs.has(r) || Date.now() - at > 5 * 60_000) b.spent.delete(r);
  return listed.filter((u) => !b.spent.has(refOf(u)));
}

/** Builds and signs one claim over `batch`, which must be in ledger order; nothing is submitted. */
export async function buildClaimTx(b: ClaimBuilder, batch: ClaimLine[]): Promise<{ hex: string; rows: ClaimRow[] }> {
  const validator = validatorOfBatch(batch.map((l) => l.v));
  const steps = batch.map(({ amount, signature, v }) => (v.datum.stage.kind === "closed" ? Step.settle(amount, signature) : Step.sub(amount, signature)));
  let tx = b.wallet.newTx();
  batch.forEach(({ v }, i) => {
    tx = tx.collectFrom({ inputs: [v.utxo], redeemer: i === 0 ? Redeemer.main(steps) : Redeemer.defer() });
  });
  const ref = b.referenceScript ? await b.chain.getUnspent(b.referenceScript) : undefined;
  tx = ref?.scriptRef ? tx.readFrom({ referenceInputs: [ref] }) : tx.attachScript({ script: validator.script });
  const rows: ClaimRow[] = [];
  let redeemed = Assets.zero;
  for (const { channelId, totalClaimed, v } of batch) {
    const stage = v.datum.stage;
    if (stage.kind === "settled") throw new Error("a settled channel has nothing left to claim");
    const taken = totalClaimed - stage.subbed;
    // The channel keeps its ADA: for a token channel that is the reserve, which is the consumer's.
    const value = valueFor(v.datum.constants.currency, v.amount - taken, v.lovelace);
    const next: Stage = stage.kind === "closed" ? { kind: "settled" } : { kind: "opened", subbed: totalClaimed };
    tx = tx.payToAddress({ address: v.address, assets: value, datum: inlineDatum(v.datum.constants, next, validator) });
    rows.push({ channelId, taken, totalClaimed, channelRef: "" });
    const c = v.datum.constants.currency;
    redeemed = Assets.merge(redeemed, c.kind === "ada" ? Assets.fromLovelace(taken) : Assets.fromHexStrings(c.policy, c.name, taken, 0n));
  }
  const unspent = await unspentOf(b);
  const payTo = Address.fromBech32(b.payTo);
  const tokens = Assets.withoutLovelace(redeemed);
  if (b.payout === "delegated") {
    tx = tx.payToAddress({ address: payTo, assets: redeemed, autoMinUtxo: true });
  } else if (!Assets.isEmpty(tokens)) {
    // Redeemed tokens go to payTo in an output of their own, so the provider's change stays
    // ADA-only: otherwise each claim folds an ADA-only UTxO, which collateral needs, into tokens.
    // Earlier such outputs are folded into it, up to FOLD of them: each holds a min-UTxO of ADA,
    // and one new output per claim spread the provider's ADA until no ADA-only UTxO was big
    // enough for collateral (after step 5 and part of step 6's token run).
    const units = new Set(Assets.getUnits(tokens));
    const mine = Address.toBech32(await b.wallet.address()) === b.payTo;
    const folds = mine ? unspent.filter((u) => !Assets.hasOnlyLovelace(u.assets) && Assets.getUnits(u.assets).every((x) => x === "lovelace" || units.has(x))).slice(0, FOLD) : [];
    let out = tokens;
    for (const u of folds) {
      tx = tx.collectFrom({ inputs: [u] });
      out = Assets.merge(out, Assets.withoutLovelace(u.assets));
    }
    tx = tx.payToAddress({ address: payTo, assets: out, autoMinUtxo: true });
  }
  // ADA-only wallet UTxOs for fees and collateral: a token-laden collateral input can leave its return below min-UTxO.
  const availableUtxos = unspent.filter((u) => Assets.hasOnlyLovelace(u.assets));
  const change = b.payout === "delegated" ? await b.wallet.address() : payTo;
  const signed = tx.addSigner({ keyHash: KeyHash.fromHex(b.providerKeyHash) });
  const sb = await retryQueries("claim", () => signed.build({ changeAddress: change, availableUtxos, setCollateral: collateralTarget(availableUtxos), ...WITH_OUR_UTXOS }));
  const hex = await signedHex(sb);
  const built = Transaction.fromCBORHex(hex);
  // R1, before the provider key signs off on it: every sponsored channel keeps its floor. Each
  // continuing output above holds the channel's own lovelace, so this guards a builder that changes.
  assertKeepsFloor(built, validator.hash, batch.map(({ v }) => v.datum.constants.sponsor?.floor));
  for (const i of built.body.inputs) b.spent.set(`${TransactionHash.toHex(i.transactionId)}#${i.index}`, Date.now());
  return { hex, rows };
}

/**
 * Builds and signs the End of a settled sponsored channel that holds none of its currency, as its
 * provider (R3): such an End is the provider's to sign, since an empty channel gives its consumer
 * nothing to take. The channel's ADA goes back to the sponsor (R2), and the provider's own ADA pays
 * the fee and the collateral. Nothing is submitted.
 */
export async function buildEndTx(b: ClaimBuilder, v: ChannelView): Promise<string> {
  const sponsor = v.datum.constants.sponsor;
  if (!sponsor) throw new Error("only a sponsored channel is ended by its provider");
  if (v.datum.stage.kind !== "settled") throw new Error(`channel is ${v.datum.stage.kind}, not settled`);
  if (v.amount !== 0n) throw new Error("a channel that still holds its currency is ended by its consumer (R3)");
  if (v.datum.constants.provider !== b.providerKeyHash) throw new Error("R3: only the channel's own provider signs its End, and the provider key here is another's");
  const validator = validatorOf(v);
  let tx = b.wallet.newTx().collectFrom({ inputs: [v.utxo], redeemer: Redeemer.main([Step.end()]) });
  const ref = b.referenceScript ? await b.chain.getUnspent(b.referenceScript) : undefined;
  tx = ref?.scriptRef ? tx.readFrom({ referenceInputs: [ref] }) : tx.attachScript({ script: validator.script });
  tx = tx.payToAddress(repaymentOutput(sponsor, v.ref)).addSigner({ keyHash: KeyHash.fromHex(b.providerKeyHash) });
  const availableUtxos = (await unspentOf(b)).filter((u) => Assets.hasOnlyLovelace(u.assets));
  const change = b.payout === "delegated" ? await b.wallet.address() : Address.fromBech32(b.payTo);
  const sb = await retryQueries("end", () => tx.build({ changeAddress: change, availableUtxos, setCollateral: collateralTarget(availableUtxos), ...WITH_OUR_UTXOS }));
  const hex = await signedHex(sb);
  const built = Transaction.fromCBORHex(hex);
  assertRepays(built, v.ref, sponsor);
  for (const i of built.body.inputs) b.spent.set(`${TransactionHash.toHex(i.transactionId)}#${i.index}`, Date.now());
  return hex;
}

export function compareRefs(a: string, b: string): number {
  const [ha, ia] = a.split("#") as [string, string];
  const [hb, ib] = b.split("#") as [string, string];
  return ha < hb ? -1 : ha > hb ? 1 : Number(ia) - Number(ib);
}
