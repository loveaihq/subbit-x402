// Rules R1 and R2 of the sponsored validator (variant/sponsored/DESIGN.md), as the transactions this
// binding builds must satisfy them. The validator refuses a transaction that breaks either, but only
// once it has run: a refusal at submission costs a failed evaluation, or at worst the collateral. So
// each builder checks what it built, before anything is signed off or submitted.
//
//   R1  a continuing output of a sponsored channel (Add, Sub, Close, Settle) holds at least `floor`.
//   R2  an ending (End, Elapse) of one is matched by an output of the transaction at the sponsor's
//       address, whole, with the channel input's output reference as its inline datum, holding at
//       least `floor`. The reference changes with every step, so the repayment names the channel
//       as it stands when it ends.
import { Address, Assets, Data, InlineDatum, TxOut, type Transaction } from "@evolution-sdk/evolution";
import { repaymentDatum, type Sponsor } from "../subbit.ts";
import { isChannelOutput } from "./cardano.ts";

/** What `payToAddress` takes for R2's repayment of the channel at `channelRef` (`txHash#index`). */
export function repaymentOutput(sponsor: Sponsor, channelRef: string) {
  return {
    address: Address.fromBech32(sponsor.address),
    assets: Assets.fromLovelace(sponsor.floor),
    datum: new InlineDatum.InlineDatum({ data: repaymentDatum(channelRef) }),
    // The floor is at least a repayment's min-UTxO when the channel is opened (the facilitator
    // checks), so this only guards a channel opened some other way.
    autoMinUtxo: true,
  } as const;
}

/**
 * The least ADA an output to `address` needs to carry a repayment datum, sized with the widest
 * coin and an output index of up to 65,535, so it never falls short: the sponsored validator's
 * floor must be at least this, or the buyer pays the difference when it exits alone.
 */
export function minRepayment(address: Address.Address, coinsPerUtxoByte: bigint): bigint {
  const out = new TxOut.TransactionOutput({
    address,
    assets: Assets.fromLovelace(2n ** 63n),
    datumOption: new InlineDatum.InlineDatum({ data: repaymentDatum(`${"ff".repeat(32)}#65535`) }),
  });
  return coinsPerUtxoByte * (160n + BigInt(TxOut.toCBORBytes(out).length));
}

/**
 * Why `tx` does not repay the sponsor of the channel at `channelRef`, as R2 reads it over all the
 * transaction's outputs; undefined when it does.
 */
export function repaymentProblem(tx: Transaction.Transaction, channelRef: string, sponsor: Sponsor): string | undefined {
  const to = Address.toHex(Address.fromBech32(sponsor.address));
  const want = repaymentDatum(channelRef);
  const paid = tx.body.outputs.some(
    (o) =>
      Address.toHex(o.address) === to &&
      o.datumOption instanceof InlineDatum.InlineDatum &&
      Data.equals(o.datumOption.data, want) &&
      Assets.lovelaceOf(o.assets) >= sponsor.floor,
  );
  return paid ? undefined : `no output pays the sponsor ${sponsor.address} at least ${sponsor.floor} lovelace with ${channelRef} as its inline datum (R2)`;
}

/**
 * Why a continuing step of `tx` would break R1, or undefined. The outputs of `tx` at the validator
 * `scriptHash` are the continuing outputs of the channels that continue, in the order their steps
 * come; `floors` has one entry for each of those channels, undefined for one nobody sponsors.
 */
export function floorProblem(tx: Transaction.Transaction, scriptHash: string, floors: ReadonlyArray<bigint | undefined>): string | undefined {
  const outs = tx.body.outputs.filter((o) => isChannelOutput(o.address, scriptHash));
  if (outs.length !== floors.length) return `${floors.length} channel(s) continue but the transaction has ${outs.length} output(s) at the validator`;
  for (const [i, floor] of floors.entries()) {
    const held = Assets.lovelaceOf(outs[i]!.assets);
    if (floor !== undefined && held < floor) return `a continuing output holds ${held} lovelace, under its sponsor's floor of ${floor} (R1)`;
  }
  return undefined;
}

/** `floorProblem`, thrown. */
export function assertKeepsFloor(tx: Transaction.Transaction, scriptHash: string, floors: ReadonlyArray<bigint | undefined>): void {
  const problem = floorProblem(tx, scriptHash, floors);
  if (problem) throw new Error(problem);
}

/** `repaymentProblem`, thrown. */
export function assertRepays(tx: Transaction.Transaction, channelRef: string, sponsor: Sponsor): void {
  const problem = repaymentProblem(tx, channelRef, sponsor);
  if (problem) throw new Error(problem);
}
