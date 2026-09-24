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
  Time,
  TransactionHash,
  TxOut,
  mainnet,
  preprod,
  preview,
  type UTxO,
} from "@evolution-sdk/evolution";
import { SUBBIT_HASH, inlineDatum, iouVerifier, parseDatum, type Constants, type Currency, type ParsedDatum, type Stage } from "../subbit.ts";
import { Err, LOVELACE, NETWORKS, type CardanoNetwork, type ChannelConfig, type ChannelState } from "./types.ts";

export function networkIdOf(network: string): number {
  const id = NETWORKS[network as CardanoNetwork];
  if (id === undefined) throw new Error(`unsupported network ${network}`);
  return id;
}

const SLOTS = { "cardano:mainnet": mainnet.slotConfig, "cardano:preprod": preprod.slotConfig, "cardano:preview": preview.slotConfig } as const;

/** Start of a slot in Unix ms: what a script sees for a validity bound set to that slot. */
export const msOfSlot = (network: string, slot: bigint) => Time.slotToUnixTime(slot, SLOTS[network as CardanoNetwork]);
/** The slot containing a Unix ms time; the SDK floors validity bounds the same way. */
export const slotOfMs = (network: string, ms: bigint) => Time.unixTimeToSlot(ms, SLOTS[network as CardanoNetwork]);

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
  /** How much of its currency it holds: its lovelace for an ADA channel, its tokens otherwise. */
  amount: bigint;
}

/** The SDK's name for a currency's unit: policy and asset name run together. */
export const sdkUnitOf = (c: Currency) => (c.kind === "ada" ? "lovelace" : c.policy + c.name);

/** How much of `c` a value holds. */
export const amountIn = (assets: Assets.Assets, c: Currency) => (c.kind === "ada" ? Assets.lovelaceOf(assets) : Assets.getByUnit(assets, sdkUnitOf(c)));

/** A channel value: `amount` of the currency, and for a token channel `lovelace` of ADA beside it. */
export const valueFor = (c: Currency, amount: bigint, lovelace: bigint) =>
  c.kind === "ada" ? Assets.fromLovelace(amount) : Assets.fromHexStrings(c.policy, c.name, amount, lovelace);

/** Whether a value holds ADA and at most the currency, as every channel output must. */
export const onlyCurrency = (assets: Assets.Assets, c: Currency) => Assets.getUnits(assets).every((u) => u === "lovelace" || u === sdkUnitOf(c));

/**
 * Reads a UTxO as a channel of `scriptHash`, or says why it is not one: wrong script, a
 * reference script riding on it, a datum that is not exactly Subbit's, or an asset besides ADA
 * and the channel's currency.
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
  const c = datum.constants.currency;
  if (!onlyCurrency(u.assets, c)) return { error: "channel holds an asset besides ADA and its currency" };
  return { utxo: u, ref: refOf(u), address: u.address, datum, lovelace: Assets.lovelaceOf(u.assets), amount: amountIn(u.assets, c) };
}

/**
 * The ADA a channel must keep: the min-UTxO of its largest continuing output, the `Closed`
 * datum, holding its currency, and sized with every integer at its widest CBOR form so the
 * figure never falls short when `subbed`, `elapse_at` or the value grow. An ADA channel keeps it
 * back from what IOUs may reach; a token channel carries exactly this much ADA beside its tokens.
 */
export function channelReserve(address: Address.Address, constants: Constants, coinsPerUtxoByte: bigint): bigint {
  const wide = 2n ** 63n;
  const c = constants.currency;
  const out = new TxOut.TransactionOutput({
    address,
    assets: c.kind === "ada" ? Assets.fromLovelace(wide) : Assets.fromHexStrings(c.policy, c.name, wide, wide),
    datumOption: inlineDatum(constants, { kind: "closed", subbed: wide, elapseAt: wide }),
  });
  return coinsPerUtxoByte * (160n + BigInt(TxOut.toCBORBytes(out).length));
}

/** How many of a wallet's token UTxOs one transaction folds into one. */
export const FOLD = 5;

/**
 * The token side of a transaction that spends `need` of a token currency from a wallet and hands
 * `back` of it to that wallet from a channel: which of the wallet's UTxOs holding ADA and this
 * currency only it spends (largest first, enough for `need`, then more up to `fold` in all), and
 * `rest`, what goes back to the wallet in one output of its own. Paying that explicitly, with the
 * fee and all other ADA from ADA-only UTxOs, keeps the change ADA-only. Otherwise every such
 * transaction folds an ADA-only UTxO, which collateral needs, into tokens, and every one that
 * returns tokens leaves another min-UTxO of ADA behind with them.
 */
export function planTokens(utxos: UTxO.UTxO[], c: Currency, need: bigint, back: bigint, fold = FOLD): { inputs: UTxO.UTxO[]; rest: bigint } {
  if (c.kind === "ada") throw new Error("planTokens is for token currencies");
  const held = utxos
    .filter((u) => !Assets.hasOnlyLovelace(u.assets) && onlyCurrency(u.assets, c) && amountIn(u.assets, c) > 0n)
    .sort((a, b) => {
      const [x, y] = [amountIn(a.assets, c), amountIn(b.assets, c)];
      return x > y ? -1 : x < y ? 1 : 0;
    });
  const inputs: UTxO.UTxO[] = [];
  let sum = 0n;
  for (const u of held) {
    if (sum >= need && inputs.length >= fold) break;
    inputs.push(u);
    sum += amountIn(u.assets, c);
  }
  if (sum < need) throw new Error(`the wallet holds ${sum} of the currency, ${need} needed`);
  return { inputs, rest: sum - need + back };
}

/**
 * x402 `balance`: how far IOUs may go and still be redeemable without the consumer. IOUs are
 * cumulative, so it counts what is already redeemed (`subbed`) plus what the channel can still
 * pay out: all of a token channel's tokens (its ADA stays behind), an ADA channel's lovelace
 * less its reserve.
 */
export function capacityOf(ch: ChannelView, coinsPerUtxoByte: bigint): bigint {
  return subbedOf(ch.datum.stage) + redeemableOf(ch.address, ch.datum.constants, ch.amount, coinsPerUtxoByte);
}

/** What a channel holding `held` of its currency can still pay out. */
export function redeemableOf(address: Address.Address, constants: Constants, held: bigint, coinsPerUtxoByte: bigint): bigint {
  if (constants.currency.kind !== "ada") return held;
  const reserve = channelReserve(address, constants, coinsPerUtxoByte);
  return held > reserve ? held - reserve : 0n;
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
