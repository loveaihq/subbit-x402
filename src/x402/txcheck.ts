// Structural checks on transactions one party built and another must accept: the client's
// channel-opening deposit (facilitator), and the client's `Mutual` refund, which the server
// co-signs as provider. A provider signature authorises the whole transaction, so the refund
// check is strict about everything that could need that key besides the channel itself.
import { createPublicKey, verify } from "node:crypto";
import { blake2b } from "@noble/hashes/blake2.js";
import {
  Address,
  Assets,
  Data,
  Ed25519Signature,
  InlineDatum,
  KeyHash,
  Transaction,
  TransactionHash,
  VKey,
  type TransactionInput,
} from "@evolution-sdk/evolution";
import { parseDatum, tagFromInput } from "../subbit.ts";
import { channelReserve, datumBindingError, isChannelOutput, networkIdOf, txHashOf } from "./cardano.ts";
import { Err, type ChannelConfig } from "./types.ts";

const SPKI_ED25519 = Buffer.from("302a300506032b6570032100", "hex");

export class TxCheckError extends Error {
  constructor(
    readonly reason: string,
    message: string,
  ) {
    super(message);
  }
}

const fail = (reason: string, message: string): never => {
  throw new TxCheckError(reason, message);
};

export function decodeTx(cborHex: string, reason: string): Transaction.Transaction {
  try {
    return Transaction.fromCBORHex(cborHex);
  } catch (e) {
    return fail(reason, `transaction does not decode: ${(e as Error).message}`);
  }
}

const refOfInput = (i: TransactionInput.TransactionInput) => `${TransactionHash.toHex(i.transactionId)}#${i.index}`;

/** Inputs in ledger order, which is the order spend redeemer indices refer to. */
export function sortedInputRefs(tx: Transaction.Transaction): string[] {
  return tx.body.inputs.map(refOfInput).sort((a, b) => {
    const [ha, ia] = a.split("#") as [string, string];
    const [hb, ib] = b.split("#") as [string, string];
    return ha < hb ? -1 : ha > hb ? 1 : Number(ia) - Number(ib);
  });
}

/** Spend redeemers by input position in ledger order. */
export function spendRedeemers(tx: Transaction.Transaction): Map<number, Data.Data> {
  const out = new Map<number, Data.Data>();
  const r = tx.witnessSet.redeemers as unknown;
  if (!r) return out;
  const tagged = r as { _tag?: string; value?: unknown };
  if (tagged._tag === "RedeemerMap") {
    for (const [[tag, index], v] of tagged.value as Map<[string, bigint], { data: Data.Data }>) {
      if (tag === "spend") out.set(Number(index), v.data);
    }
  } else {
    for (const x of (tagged.value ?? r) as Array<{ tag: string; index: bigint; data: Data.Data }>) {
      if (x.tag === "spend") out.set(Number(x.index), x.data);
    }
  }
  return out;
}

/** Key hashes of the vkey witnesses present. */
export function witnessKeyHashes(tx: Transaction.Transaction): Set<string> {
  const out = new Set<string>();
  for (const w of tx.witnessSet.vkeyWitnesses ?? []) {
    out.add(Buffer.from(blake2b(Buffer.from(VKey.toHex(w.vkey), "hex"), { dkLen: 28 })).toString("hex"));
  }
  return out;
}

function checkNoExtras(tx: Transaction.Transaction, reason: string) {
  const b = tx.body;
  if (b.certificates || b.withdrawals || b.mint || b.votingProcedures || b.proposalProcedures || b.donation || b.currentTreasuryValue) {
    fail(reason, "transaction carries certificates, withdrawals, minting or governance actions");
  }
}

// ---- deposit (channel opening) --------------------------------------------------

export interface DepositCheck {
  tx: Transaction.Transaction;
  /** Position of the channel output. */
  outputIndex: number;
  capacity: bigint;
  inputRefs: string[];
}

/**
 * A channel-opening transaction as the binding requires it: exactly one output at the channel
 * script, with the Subbit datum this config and tag describe at stage `Opened(0)`, holding
 * exactly `amount` lovelace and nothing else, no reference script on it, and a tag derived
 * from one of the transaction's own inputs (Subbit ADR tag.md).
 */
export function checkDeposit(
  cborHex: string,
  network: string,
  config: ChannelConfig,
  channelId: string,
  scriptHash: string,
  amount: bigint,
  coinsPerUtxoByte: bigint,
): DepositCheck {
  const R = Err.depositTransaction;
  const tx = decodeTx(cborHex, R);
  const netId = networkIdOf(network);
  if (tx.body.networkId !== undefined && tx.body.networkId !== netId) fail(Err.network, "transaction network id");
  if (tx.body.outputs.some((o) => o.address.networkId !== netId)) fail(Err.network, "an output is on another network");
  checkNoExtras(tx, R);

  const at = tx.body.outputs.flatMap((o, i) => (isChannelOutput(o.address, scriptHash) ? [i] : []));
  if (at.length !== 1) fail(R, `expected one channel output, found ${at.length}`);
  const outputIndex = at[0]!;
  const o = tx.body.outputs[outputIndex]!;
  if (o.scriptRef) fail(R, "channel output carries a reference script");
  if (!(o.datumOption instanceof InlineDatum.InlineDatum)) fail(R, "channel datum is not inline");
  let d;
  try {
    d = parseDatum((o.datumOption as InlineDatum.InlineDatum).data);
  } catch (e) {
    return fail(R, `channel datum: ${(e as Error).message}`);
  }
  const bind = datumBindingError(d, config, channelId, scriptHash);
  if (bind) fail(bind, "channel datum does not match the channel config");
  if (d.stage.kind !== "opened" || d.stage.subbed !== 0n) fail(R, "a new channel must open at Opened(0)");
  if (!Assets.hasOnlyLovelace(o.assets)) fail(R, "channel output holds tokens besides ADA");
  if (Assets.lovelaceOf(o.assets) !== amount) fail(R, `channel output holds ${Assets.lovelaceOf(o.assets)}, deposit says ${amount}`);
  if (!tx.body.inputs.some((i) => tagFromInput(i) === channelId)) fail(Err.channelIdMismatch, "channelId is not derived from an input this transaction spends");

  const reserve = channelReserve(o.address, d.constants, coinsPerUtxoByte);
  const capacity = amount > reserve ? amount - reserve : 0n;
  return { tx, outputIndex, capacity, inputRefs: tx.body.inputs.map(refOfInput) };
}

/**
 * Every vkey witness must be a valid signature over the transaction's id, and every key-locked
 * input the caller resolved must carry its key's witness. The node checks both; checking first
 * means a facilitator does not broadcast what cannot land.
 */
export function checkInputWitnesses(tx: Transaction.Transaction, cborHex: string, inputAddresses: Address.Address[], reason: string) {
  const id = Buffer.from(txHashOf(cborHex), "hex");
  for (const w of tx.witnessSet.vkeyWitnesses ?? []) {
    const key = createPublicKey({ key: Buffer.concat([SPKI_ED25519, Buffer.from(VKey.toHex(w.vkey), "hex")]), format: "der", type: "spki" });
    if (!verify(null, id, key, Buffer.from(Ed25519Signature.toHex(w.signature), "hex"))) fail(reason, "a witness signature does not verify against the transaction id");
  }
  const have = witnessKeyHashes(tx);
  for (const a of inputAddresses) {
    const pay = a.paymentCredential;
    if (pay instanceof KeyHash.KeyHash && !have.has(KeyHash.toHex(pay))) fail(reason, "an input's key has not signed the transaction");
  }
}

// ---- refund (Mutual) -------------------------------------------------------------

export interface MutualCheck {
  tx: Transaction.Transaction;
  providerPayout: bigint;
}

/**
 * The only shape of refund the provider co-signs: the transaction spends the channel at
 * `channelRef` and nothing else locked by the channel script or by the provider's key; the
 * channel's redeemer is `Mutual`; the required signers are exactly consumer and provider;
 * no certificates, withdrawals, minting or governance; and `payTo` receives at least
 * `minPayout` in ADA-only outputs. The consumer's signature must already be on it.
 */
export function checkMutual(
  cborHex: string,
  network: string,
  scriptHash: string,
  channelRef: string,
  consumer: string,
  provider: string,
  payTo: string,
  minPayout: bigint,
  /** Resolved addresses of the collateral inputs; none may be locked by the provider's key. */
  collateralAddresses: Address.Address[],
  consumerMustHaveSigned = true,
): MutualCheck {
  const R = Err.refundTransaction;
  const tx = decodeTx(cborHex, R);
  const netId = networkIdOf(network);
  if (tx.body.networkId !== undefined && tx.body.networkId !== netId) fail(Err.network, "transaction network id");
  checkNoExtras(tx, R);

  const inputs = sortedInputRefs(tx);
  if (inputs.length !== 1 || inputs[0] !== channelRef) fail(R, "a refund must spend the channel and nothing else");
  const collateral = tx.body.collateralInputs ?? [];
  if (collateral.some((c) => refOfInput(c) === channelRef)) fail(R, "the channel cannot be collateral");
  if (collateralAddresses.length !== collateral.length) fail(R, "every collateral input must be resolved");
  for (const a of collateralAddresses) {
    const pay = a.paymentCredential;
    if (!(pay instanceof KeyHash.KeyHash) || KeyHash.toHex(pay) === provider) fail(R, "collateral must be the consumer's own key-locked ADA");
  }
  const redeemer = spendRedeemers(tx).get(0);
  if (redeemer === undefined || Data.toCBORHex(redeemer) !== Data.toCBORHex(Data.constr(2n, []))) fail(R, "the channel must be spent with Mutual");

  const signers = (tx.body.requiredSigners ?? []).map((k) => KeyHash.toHex(k)).sort();
  if (signers.length !== 2 || !signers.includes(consumer) || !signers.includes(provider)) fail(R, "required signers must be exactly consumer and provider");
  if (consumerMustHaveSigned && !witnessKeyHashes(tx).has(consumer)) fail(R, "the consumer has not signed");

  const payToAddr = Address.fromBech32(payTo);
  let providerPayout = 0n;
  for (const o of tx.body.outputs) {
    if (Address.toBech32(o.address) === Address.toBech32(payToAddr)) {
      if (!Assets.hasOnlyLovelace(o.assets)) fail(R, "the provider's payout must be ADA only");
      providerPayout += Assets.lovelaceOf(o.assets);
    }
    if (isChannelOutput(o.address, scriptHash)) fail(R, "a refund leaves nothing at the channel script");
  }
  if (providerPayout < minPayout) fail(R, `the provider is paid ${providerPayout}, owed ${minPayout}`);
  return { tx, providerPayout };
}
