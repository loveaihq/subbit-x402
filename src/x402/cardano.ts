// Cardano facts the binding's three parties share: how a channel UTxO reads as x402 channel
// state, how a channel config binds to its datum, the capacity rule for ADA channels (DESIGN.md
// §4), and transaction hashing from the exact bytes received.
import {
  Address,
  Assets,
  InlineDatum,
  KeyHash,
  ScriptHash,
  Transaction,
  TransactionBody,
  TransactionHash,
  TxOut,
  type UTxO,
} from "@evolution-sdk/evolution";
import { SUBBIT_HASH, inlineDatum, iouVerifier, parseDatum, type Constants, type Currency, type ParsedDatum, type Stage } from "../subbit.ts";
import { Err, LOVELACE, NETWORKS, type CardanoNetwork, type ChannelConfig, type ChannelState } from "./types.ts";

export function networkIdOf(network: string): number {
  const id = NETWORKS[network as CardanoNetwork];
  if (id === undefined) throw new Error(`unsupported network ${network}`);
  return id;
}

/** `lovelace` or `<policyId>.<assetNameHex>`, as Cardano `exact`. */
export function currencyOf(asset: string): Currency {
  if (asset === LOVELACE) return { kind: "ada" };
  const m = /^([0-9a-f]{56})\.([0-9a-f]{0,64})$/.exec(asset);
  if (!m) throw new Error(`not a Cardano asset id: ${asset}`);
  return { kind: "asset", policy: m[1]!, name: m[2]! };
}

export function constantsOf(config: ChannelConfig, tag: string): Constants {
  return {
    tag,
    currency: currencyOf(config.token),
    iouKey: config.payerAuthorizer,
    consumer: config.payer,
    provider: config.receiverAuthorizer,
    closePeriodMs: BigInt(config.withdrawDelay) * 1000n,
  };
}

/** Where a config's fields sit in the datum. Returns the first mismatch, if any. */
export function datumBindingError(d: ParsedDatum, config: ChannelConfig, channelId: string, scriptHash: string): string | undefined {
  const c = d.constants;
  if (d.ownHash !== scriptHash) return Err.channelState;
  if (c.tag !== channelId) return Err.channelIdMismatch;
  const want = currencyOf(config.token);
  const same = want.kind === c.currency.kind && (want.kind === "ada" || (c.currency.kind === "asset" && want.policy === c.currency.policy && want.name === c.currency.name));
  if (!same) return Err.tokenMismatch;
  if (c.iouKey !== config.payerAuthorizer || c.consumer !== config.payer) return Err.channelConfig;
  if (c.provider !== config.receiverAuthorizer) return Err.receiverAuthorizerMismatch;
  if (c.closePeriodMs !== BigInt(config.withdrawDelay) * 1000n) return Err.withdrawDelayMismatch;
  return undefined;
}

/** A channel UTxO as the binding sees it. */
export interface ChannelView {
  utxo: UTxO.UTxO;
  ref: string;
  address: Address.Address;
  datum: ParsedDatum;
  lovelace: bigint;
}

/**
 * Reads a UTxO as a channel of `scriptHash`, or says why it is not one: wrong script, a
 * reference script riding on it, a datum that is not exactly Subbit's, or (milestone 1) any
 * asset besides ADA.
 */
export function readChannel(u: UTxO.UTxO, scriptHash: string): ChannelView | { error: string } {
  const pay = u.address.paymentCredential;
  if (!(pay instanceof ScriptHash.ScriptHash) || ScriptHash.toHex(pay) !== scriptHash) return { error: "not at the channel script" };
  if (u.scriptRef) return { error: "channel output carries a reference script" };
  if (!(u.datumOption instanceof InlineDatum.InlineDatum)) return { error: "channel datum is not inline" };
  let datum: ParsedDatum;
  try {
    datum = parseDatum(u.datumOption.data);
  } catch (e) {
    return { error: `channel datum: ${(e as Error).message}` };
  }
  if (datum.ownHash !== scriptHash) return { error: "datum names another script" };
  if (datum.constants.currency.kind !== "ada" || !Assets.hasOnlyLovelace(u.assets)) return { error: "only ADA channels are supported" };
  return { utxo: u, ref: refOf(u), address: u.address, datum, lovelace: Assets.lovelaceOf(u.assets) };
}

/**
 * What an ADA channel must keep back: the min-UTxO of its largest continuing output, the
 * `Closed` datum, sized with every integer at its widest CBOR form so the figure never falls
 * short when `subbed`, `elapse_at` or the value grow.
 */
export function channelReserve(address: Address.Address, constants: Constants, coinsPerUtxoByte: bigint): bigint {
  const wide = 2n ** 63n;
  const out = new TxOut.TransactionOutput({
    address,
    assets: Assets.fromLovelace(wide),
    datumOption: inlineDatum(constants, { kind: "closed", subbed: wide, elapseAt: wide }),
  });
  return coinsPerUtxoByte * (160n + BigInt(TxOut.toCBORBytes(out).length));
}

/** x402 `balance`: how far IOUs may go and still be redeemable without the consumer. */
export function capacityOf(ch: ChannelView, coinsPerUtxoByte: bigint): bigint {
  const reserve = channelReserve(ch.address, ch.datum.constants, coinsPerUtxoByte);
  return ch.lovelace > reserve ? ch.lovelace - reserve : 0n;
}

export function subbedOf(stage: Stage): bigint {
  return stage.kind === "settled" ? 0n : stage.subbed;
}

export function channelStateOf(ch: ChannelView, coinsPerUtxoByte: bigint): ChannelState {
  const s = ch.datum.stage;
  return {
    channelId: ch.datum.constants.tag,
    channelRef: ch.ref,
    balance: capacityOf(ch, coinsPerUtxoByte).toString(),
    totalClaimed: subbedOf(s).toString(),
    withdrawRequestedAt: s.kind === "closed" ? Number((s.elapseAt - ch.datum.constants.closePeriodMs) / 1000n) : 0,
  };
}

export function verifyVoucherSignature(iouKey: string, tag: string, amount: bigint, signature: string): boolean {
  try {
    return iouVerifier(iouKey)(tag, amount, signature);
  } catch {
    return false;
  }
}

// ---- transactions ---------------------------------------------------------

export const refOf = (u: UTxO.UTxO) => `${TransactionHash.toHex(u.transactionId)}#${u.index}`;

/** The id of a transaction from the bytes as received, never from a re-encoding. */
export function txHashOf(cborHex: string): string {
  const body = Transaction.extractBodyBytes(Buffer.from(cborHex, "hex"));
  return TransactionHash.toHex(TransactionBody.toHashFromBytes(body));
}

export function keyHashOfAddress(bech32: string): string {
  const a = Address.fromBech32(bech32);
  if (!(a.paymentCredential instanceof KeyHash.KeyHash)) throw new Error("address has no key payment credential");
  return KeyHash.toHex(a.paymentCredential);
}

export const isChannelOutput = (address: Address.Address, scriptHash: string) =>
  address.paymentCredential instanceof ScriptHash.ScriptHash && ScriptHash.toHex(address.paymentCredential) === scriptHash;

export { SUBBIT_HASH };
