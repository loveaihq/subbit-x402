// A batch that no transaction of this binding is: one `Main` over two channels whose steps need two
// different signers, the consumer's `Add` and the provider's `Sub`. This binding's claims have one
// signer (the provider key) and its top-ups one channel, so it never builds such a batch; Subbit's
// validator at 66648db (hash 62ce4309…) could not take one whose signers came in descending order,
// and upstream's fix (74c20d2, hash 6d877463…) can (RESULTS.md, steps 15 and 18).
//
// Step order is the order of the channel inputs in the ledger (txHash, then index), and the builder
// cannot change it, but it can choose which channel gets which step. So it takes the two channels
// of one consumer and one provider, sorts them by that order, and gives the first the step whose
// signer is the larger key (`descending`: the later step's signer sorts first, which 66648db fails on)
// or the smaller (`ascending`, which every build takes).
//
// Nothing here submits anything. `spike/x402/fixed.ts` evaluates the result and, at the fixed
// validator alone, signs it with both keys and sends it; test/variant.test.ts runs it through the
// compiled scripts with `aiken tx simulate`.
import { Address, Assets, KeyHash, type UTxO } from "@evolution-sdk/evolution";
import { Redeemer, Step, inlineDatum, type Stage, type Validator } from "../../src/subbit.ts";
import { referenceFor, type ChannelView } from "../../src/x402/cardano.ts";
import { compareRefs } from "../../src/x402/claimtx.ts";
import { WITH_OUR_UTXOS, collateralTarget, type SeedWallet } from "../../src/x402/client.ts";

export type Order = "descending" | "ascending";

export interface MixedBatch {
  /** The consumer's wallet: it funds the `Add`, pays the fee and puts up the collateral. */
  wallet: SeedWallet;
  validator: Validator;
  /** Two ADA channels at `validator`, with one consumer (this wallet's key) and one provider between them. */
  channels: readonly [ChannelView, ChannelView];
  providerKeyHash: string;
  /** Where the `Sub`'s take goes, an address of the provider's. */
  payTo: string;
  /** What the `Add` puts into its channel, in lovelace. */
  add: bigint;
  /** The IOU amount of the `Sub`, which is also what it takes, from a channel that has had nothing taken. */
  owed: bigint;
  /** The signature of the IOU `(tag, amount)` by the IOU key of that channel. */
  iou: (tag: string, amount: bigint) => string;
  order: Order;
  /** A reference-script output to read the validator from, when it carries that validator; otherwise it is attached. */
  reference?: UTxO.UTxO;
  /** The consumer's UTxOs the builder may spend. */
  availableUtxos: UTxO.UTxO[];
}

/** One channel's part: its reference, the step on it, and who must sign that step. */
export interface MixedStep {
  ref: string;
  step: "Add" | "Sub";
  signer: string;
}

/**
 * Which channel gets which step, in ledger order, for the order asked: the first channel in the
 * ledger's order gets the step whose signer is the larger key (`descending`) or the smaller
 * (`ascending`). Keys compare as bytes, which for hex of one length is the string order.
 */
export function planMixedBatch(channels: readonly [ChannelView, ChannelView], providerKeyHash: string, order: Order): Array<{ v: ChannelView; step: MixedStep["step"]; signer: string }> {
  const [first, second] = [...channels].sort((x, y) => compareRefs(x.ref, y.ref)) as [ChannelView, ChannelView];
  const consumer = first.datum.constants.consumer;
  if (second.datum.constants.consumer !== consumer) throw new Error("the two channels must have one consumer: the wallet that builds the batch signs the Add");
  const provider = providerKeyHash.toLowerCase();
  if (first.datum.constants.provider !== provider || second.datum.constants.provider !== provider) throw new Error("the two channels must have the provider whose key signs the Sub");
  const addFirst = (consumer > provider) === (order === "descending");
  const [a, b] = addFirst ? ([[first, "Add", consumer], [second, "Sub", provider]] as const) : ([[first, "Sub", provider], [second, "Add", consumer]] as const);
  return [a, b].map(([v, step, signer]) => ({ v, step, signer }));
}

/**
 * Builds the batch, which runs it through the provider's evaluator as the SDK does for every
 * build: at a validator that refuses it, this throws the SDK's evaluation failure (`ScriptFailures`),
 * and nothing is signed or sent. The steps come back in ledger order, with their signers.
 */
export async function buildMixedBatch(o: MixedBatch) {
  for (const v of o.channels) {
    if (v.datum.constants.currency.kind !== "ada") throw new Error("this batch is of ADA channels");
    if (v.datum.stage.kind !== "opened" || v.datum.stage.subbed !== 0n) throw new Error(`channel ${v.ref} is not freshly opened`);
    if (v.datum.ownHash !== o.validator.hash) throw new Error(`channel ${v.ref} is at ${v.datum.ownHash}, not ${o.validator.hash}`);
  }
  const plan = planMixedBatch(o.channels, o.providerKeyHash, o.order);
  const consumer = plan[0]!.v.datum.constants.consumer;
  const steps = plan.map(({ v, step }) => (step === "Add" ? Step.add() : Step.sub(o.owed, o.iou(v.datum.constants.tag, o.owed))));

  let tx = o.wallet.newTx();
  plan.forEach(({ v }, i) => {
    tx = tx.collectFrom({ inputs: [v.utxo], redeemer: i === 0 ? Redeemer.main(steps) : Redeemer.defer() });
  });
  const ref = referenceFor(o.reference, o.validator);
  tx = ref ? tx.readFrom({ referenceInputs: [ref] }) : tx.attachScript({ script: o.validator.script });
  for (const { v, step } of plan) {
    const next: Stage = step === "Add" ? v.datum.stage : { kind: "opened", subbed: o.owed };
    const lovelace = step === "Add" ? v.lovelace + o.add : v.lovelace - o.owed;
    tx = tx.payToAddress({ address: v.address, assets: Assets.fromLovelace(lovelace), datum: inlineDatum(v.datum.constants, next, o.validator) });
  }
  tx = tx
    .payToAddress({ address: Address.fromBech32(o.payTo), assets: Assets.fromLovelace(o.owed) })
    .addSigner({ keyHash: KeyHash.fromHex(consumer) })
    .addSigner({ keyHash: KeyHash.fromHex(o.providerKeyHash) });
  const built = await tx.build({ changeAddress: await o.wallet.address(), availableUtxos: o.availableUtxos, setCollateral: collateralTarget(o.availableUtxos), ...WITH_OUR_UTXOS });
  const order: MixedStep[] = plan.map(({ v, step, signer }) => ({ ref: v.ref, step, signer }));
  return { built, order };
}
