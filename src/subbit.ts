// Off-chain side of Subbit.xyz (kompact-io/subbit-xyz @ 66648db): the datum,
// redeemer and IOU encodings its validator checks, and the checks a provider
// must make itself because opening a channel runs no validator. Two validators
// are known: Subbit's own, and this repository's sponsor-safe variant
// (variant/sponsored/DESIGN.md), whose datum has a seventh constant.
import { readFileSync } from "node:fs";
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from "node:crypto";
import { blake2b } from "@noble/hashes/blake2.js";
import { Address, Data, InlineDatum, KeyHash, PlutusV3, ScriptHash, TransactionInput } from "@evolution-sdk/evolution";

// ---- the validators ----------------------------------------------------

/** One build of the Subbit spend validator: what a channel's address, datum and script depend on. */
export interface Validator {
  /** `upstream`: Subbit's, six constants. `sponsored`: this repository's variant, seven. */
  readonly name: "upstream" | "sponsored";
  /** The spend validator's script hash, lowercase hex. */
  readonly hash: string;
  readonly script: PlutusV3.PlutusV3;
  /** Its datum's constants end with the sponsor (`Option<(Address, Int)>`), and it enforces rules R0 to R3. */
  readonly sponsored: boolean;
}

/** The validator in a blueprint, its script bytes checked against the hash the blueprint states. */
function loadValidator(name: Validator["name"], blueprintUrl: URL, sponsored: boolean): Validator {
  const blueprint = JSON.parse(readFileSync(blueprintUrl, "utf8")) as { validators: Array<{ title: string; hash: string; compiledCode: string }> };
  const spend = blueprint.validators.find((v) => v.title === "subbit.subbit.spend");
  if (!spend) throw new Error(`subbit.subbit.spend is missing from the ${name} blueprint`);
  const script = new PlutusV3.PlutusV3({ bytes: hex(spend.compiledCode) });
  const computedHash = ScriptHash.toHex(ScriptHash.fromScript(script));
  if (computedHash !== spend.hash) {
    throw new Error(`script bytes hash to ${computedHash}, blueprint says ${spend.hash}`);
  }
  return { name, hash: spend.hash, script, sponsored };
}

/** Subbit's validator, vendor/subbit/plutus.json: six constants, nothing audited. */
export const UPSTREAM: Validator = loadValidator("upstream", new URL("../vendor/subbit/plutus.json", import.meta.url), false);
/** The sponsor-safe variant, variant/sponsored/plutus.json: seven constants, nothing audited; run on preprod (RESULTS.md, step 17). */
export const SPONSORED: Validator = loadValidator("sponsored", new URL("../variant/sponsored/plutus.json", import.meta.url), true);
/** Every validator this package can build a transaction for. A client or facilitator serves the ones it is told to trust. */
export const VALIDATORS: readonly Validator[] = [UPSTREAM, SPONSORED];

/** Upstream's, under the names this package has always exported them by. */
export const SUBBIT_HASH = UPSTREAM.hash;
export const subbitScript = UPSTREAM.script;

/** The known validator with this script hash, if any. */
export function validatorByHash(hash: string): Validator | undefined {
  const h = hash.toLowerCase();
  return VALIDATORS.find((v) => v.hash === h);
}

/** A channel lives at the script's payment credential; the stake part is the consumer's choice and must never change. */
export function channelAddress(networkId: number, delegation?: KeyHash.KeyHash | ScriptHash.ScriptHash, v: Validator = UPSTREAM): Address.Address {
  return new Address.Address({
    networkId,
    paymentCredential: ScriptHash.fromHex(v.hash),
    ...(delegation ? { stakingCredential: delegation } : {}),
  });
}

export type Currency = { readonly kind: "ada" } | { readonly kind: "asset"; readonly policy: string; readonly name: string };

/**
 * Who paid a token channel's reserve and must get it back (the sponsored validator's seventh
 * constant). The validator keeps `floor` lovelace in every continuing output (R1) and, when the
 * channel ends, wants an output of at least `floor` at `address` that names the channel input (R2).
 */
export interface Sponsor {
  /** bech32, compared whole by the validator, stake part included. */
  readonly address: string;
  readonly floor: bigint;
}

export interface Constants {
  /** Unique per (iouKey, tag); ADR tag.md recommends blake2b-256 of an input the open tx spends. */
  readonly tag: string;
  readonly currency: Currency;
  /** Ed25519 public key (32 bytes) that signs IOUs. Hot; separate from the consumer's tx key. */
  readonly iouKey: string;
  readonly consumer: string;
  readonly provider: string;
  readonly closePeriodMs: bigint;
  /** The sponsored validator's seventh constant; absent is `None`. Upstream's validator has no such constant. */
  readonly sponsor?: Sponsor;
}

export type Stage =
  | { readonly kind: "opened"; readonly subbed: bigint }
  | { readonly kind: "closed"; readonly subbed: bigint; readonly elapseAt: bigint }
  | { readonly kind: "settled" };

// Aiken tuples are Data lists, enums are constructors (see the blueprint's definitions).
const unit = (index: bigint) => Data.constr(index, []);

function currencyData(c: Currency): Data.Data {
  return c.kind === "ada" ? unit(0n) : Data.constr(1n, [hex(c.policy), hex(c.name)]);
}

function stageData(s: Stage): Data.Data {
  switch (s.kind) {
    case "opened":
      return Data.constr(0n, [s.subbed]);
    case "closed":
      return Data.constr(1n, [s.subbed, s.elapseAt]);
    case "settled":
      return unit(2n);
  }
}

/**
 * An address as Aiken's `Address` (`cardano/address`): a payment credential, and `Option` of an
 * inline stake credential. Only base and enterprise addresses have one; anything else throws.
 */
export function addressData(bech32: string): Data.Data {
  const a = Address.fromBech32(bech32);
  const credential = (c: KeyHash.KeyHash | ScriptHash.ScriptHash): Data.Data =>
    c instanceof KeyHash.KeyHash ? Data.constr(0n, [hex(KeyHash.toHex(c))]) : Data.constr(1n, [hex(ScriptHash.toHex(c))]);
  const stake = a.stakingCredential ? Data.constr(0n, [Data.constr(0n, [credential(a.stakingCredential)])]) : unit(1n);
  return Data.constr(0n, [credential(a.paymentCredential), stake]);
}

/** The sponsor constant: `None`, or `Some((address, floor))`, a tuple being a Data list. */
function sponsorData(s: Sponsor | undefined): Data.Data {
  if (!s) return unit(1n);
  if (s.floor < 0n) throw new Error("a sponsor's floor must not be negative");
  return Data.constr(0n, [Data.list([addressData(s.address), s.floor])]);
}

/**
 * The datum of a channel at validator `v`, whose `own_hash` is that validator's hash. Upstream's
 * has six constants and no sponsor, the variant's seven: a sponsor given for upstream throws
 * rather than being dropped.
 */
export function datumData(c: Constants, s: Stage, v: Validator = UPSTREAM): Data.Data {
  if (c.sponsor && !v.sponsored) throw new Error(`the ${v.name} validator has no sponsor constant`);
  return Data.list([
    hex(v.hash),
    Data.list([
      hex(c.tag),
      currencyData(c.currency),
      hex(c.iouKey),
      hex(c.consumer),
      hex(c.provider),
      c.closePeriodMs,
      ...(v.sponsored ? [sponsorData(c.sponsor)] : []),
    ]),
    stageData(s),
  ]);
}

export function inlineDatum(c: Constants, s: Stage, v: Validator = UPSTREAM): InlineDatum.InlineDatum {
  return new InlineDatum.InlineDatum({ data: datumData(c, s, v) });
}

/**
 * The repayment datum rule R2 looks for: the output reference of the channel input that ends,
 * `Constr 0 [B txid, I index]`, the id bare as in a V3 script context. `ref` is `txHash#index`.
 */
export function repaymentDatum(ref: string): Data.Data {
  const m = /^([0-9a-f]{64})#(0|[1-9][0-9]*)$/.exec(ref);
  if (!m) throw new Error(`not an output reference: ${ref}`);
  return Data.constr(0n, [hex(m[1]!), BigInt(m[2]!)]);
}

export const Redeemer = {
  defer: (): Data.Data => unit(0n),
  main: (steps: ReadonlyArray<Data.Data>): Data.Data => Data.constr(1n, [Data.list([...steps])]),
  mutual: (): Data.Data => unit(2n),
};

export const Step = {
  add: (): Data.Data => Data.constr(0n, [unit(0n)]),
  sub: (owed: bigint, sig: string): Data.Data => Data.constr(0n, [Data.constr(1n, [owed, hex(sig)])]),
  close: (): Data.Data => Data.constr(0n, [unit(2n)]),
  settle: (owed: bigint, sig: string): Data.Data => Data.constr(0n, [Data.constr(3n, [owed, hex(sig)])]),
  end: (): Data.Data => Data.constr(1n, [unit(0n)]),
  elapse: (): Data.Data => Data.constr(1n, [unit(1n)]),
};

export interface ParsedDatum {
  readonly ownHash: string;
  readonly constants: Constants;
  readonly stage: Stage;
}

/**
 * Strict inverse of datumData: anything that is not exactly a datum of validator `v` throws, one
 * with another validator's number of constants included. The sponsored validator's datum names an
 * address, whose network the datum does not hold, so `networkId` is the channel's.
 */
export function parseDatum(d: Data.Data): ParsedDatum;
export function parseDatum(d: Data.Data, v: Validator, networkId: number): ParsedDatum;
export function parseDatum(d: Data.Data, v: Validator = UPSTREAM, networkId?: number): ParsedDatum {
  const [ownHash, constants, stage] = list(d, 3, "datum");
  const want = v.sponsored ? 7 : 6;
  // The other validator's shape is not a typo to tolerate: the channel could never be spent.
  if (Array.isArray(constants) && constants.length === (v.sponsored ? 6 : 7)) {
    throw new Error(`constants: ${constants.length} where the ${v.name} validator reads ${want}: no step could read this datum, so whatever it holds is locked for good`);
  }
  const [tag, currency, iouKey, consumer, provider, closePeriod, sponsor] = list(constants, want, "constants");
  if (v.sponsored && networkId === undefined) throw new Error("a sponsored datum names an address: its network is needed to read it");
  const sponsorOf = v.sponsored ? parseSponsor(sponsor!, networkId!) : undefined;
  return {
    ownHash: bytes(ownHash, "own_hash"),
    constants: {
      tag: bytes(tag, "tag"),
      currency: parseCurrency(currency),
      iouKey: bytes(iouKey, "iou_key"),
      consumer: bytes(consumer, "consumer"),
      provider: bytes(provider, "provider"),
      closePeriodMs: int(closePeriod, "close_period"),
      ...(sponsorOf ? { sponsor: sponsorOf } : {}),
    },
    stage: parseStage(stage),
  };
}

function parseSponsor(d: Data.Data, networkId: number): Sponsor | undefined {
  const c = constr(d, "sponsor");
  if (c.index === 1n && c.fields.length === 0) return undefined;
  if (c.index !== 0n || c.fields.length !== 1) throw new Error("sponsor: unknown constructor");
  const [address, floor] = list(c.fields[0]!, 2, "sponsor");
  return { address: parseAddress(address!, networkId), floor: int(floor!, "floor") };
}

/** Aiken's `Address` as bech32: a key or script payment credential, and no stake credential or an inline one. */
function parseAddress(d: Data.Data, networkId: number): string {
  const a = constr(d, "sponsor address");
  if (a.index !== 0n || a.fields.length !== 2) throw new Error("sponsor address: unknown constructor");
  const stake = constr(a.fields[1]!, "sponsor stake credential");
  let stakingCredential: KeyHash.KeyHash | ScriptHash.ScriptHash | undefined;
  if (stake.index === 0n && stake.fields.length === 1) {
    const inline = constr(stake.fields[0]!, "sponsor stake credential");
    if (inline.index !== 0n || inline.fields.length !== 1) throw new Error("sponsor address: a pointer stake credential is not supported");
    stakingCredential = parseCredential(inline.fields[0]!, "sponsor stake credential");
  } else if (!(stake.index === 1n && stake.fields.length === 0)) {
    throw new Error("sponsor address: unknown stake credential");
  }
  return Address.toBech32(new Address.Address({ networkId, paymentCredential: parseCredential(a.fields[0]!, "sponsor payment credential"), ...(stakingCredential ? { stakingCredential } : {}) }));
}

function parseCredential(d: Data.Data, what: string): KeyHash.KeyHash | ScriptHash.ScriptHash {
  const c = constr(d, what);
  if (c.fields.length !== 1 || (c.index !== 0n && c.index !== 1n)) throw new Error(`${what}: unknown constructor`);
  const h = bytes(c.fields[0]!, what);
  if (h.length !== 56) throw new Error(`${what}: expected 28 bytes`);
  return c.index === 0n ? KeyHash.fromHex(h) : ScriptHash.fromHex(h);
}

function parseCurrency(d: Data.Data): Currency {
  const c = constr(d, "currency");
  if (c.index === 0n && c.fields.length === 0) return { kind: "ada" };
  if (c.index === 1n && c.fields.length === 2) {
    return { kind: "asset", policy: bytes(c.fields[0]!, "policy"), name: bytes(c.fields[1]!, "name") };
  }
  throw new Error("currency: unknown constructor");
}

function parseStage(d: Data.Data): Stage {
  const c = constr(d, "stage");
  if (c.index === 0n && c.fields.length === 1) return { kind: "opened", subbed: int(c.fields[0]!, "subbed") };
  if (c.index === 1n && c.fields.length === 2) {
    return { kind: "closed", subbed: int(c.fields[0]!, "subbed"), elapseAt: int(c.fields[1]!, "elapse_at") };
  }
  if (c.index === 2n && c.fields.length === 0) return { kind: "settled" };
  throw new Error("stage: unknown constructor");
}

// ---- IOUs --------------------------------------------------------------

/**
 * The signed body is `cbor.serialise((tag, amount))` in the validator (iou.ak): Plutus
 * serialiseData of a two-element list, which is an indefinite-length array. Tags over
 * 64 bytes would be chunked by serialiseData, so they are refused rather than guessed.
 */
export function iouBody(tag: string, amount: bigint): Uint8Array {
  const t = hex(tag);
  if (t.length > 64) throw new Error("tag over 64 bytes is not supported");
  if (amount < 0n || amount >= 2n ** 64n) throw new Error("IOU amount out of range");
  return Buffer.concat([Buffer.of(0x9f), cborHead(2, BigInt(t.length)), t, cborHead(0, amount), Buffer.of(0xff)]);
}

function cborHead(major: number, n: bigint): Buffer {
  const m = major << 5;
  if (n < 24n) return Buffer.of(m | Number(n));
  if (n < 0x100n) return Buffer.of(m | 24, Number(n));
  const width = n < 0x10000n ? 2 : n < 0x100000000n ? 4 : 8;
  return Buffer.concat([Buffer.of(m | (width === 2 ? 25 : width === 4 ? 26 : 27)), bigEndian(n, width)]);
}

function bigEndian(n: bigint, width: number): Buffer {
  const out = Buffer.alloc(width);
  for (let i = width - 1; i >= 0; i--) {
    out[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return out;
}

const SPKI_ED25519 = Buffer.from("302a300506032b6570032100", "hex");

export interface IouSigner {
  readonly publicKey: string;
  sign(tag: string, amount: bigint): string;
}

export function newIouSigner(): IouSigner & { readonly privateKey: KeyObject } {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  return {
    publicKey: Buffer.from(raw).toString("hex"),
    privateKey,
    sign: (tag, amount) => sign(null, iouBody(tag, amount), privateKey).toString("hex"),
  };
}

const PKCS8_ED25519 = Buffer.from("302e020100300506032b657004220420", "hex");

/** The IOU signer whose private key is this 32-byte Ed25519 seed (RFC 8032). */
export function iouSignerFromSeed(seed: Uint8Array): IouSigner & { readonly privateKey: KeyObject } {
  if (seed.length !== 32) throw new Error("an Ed25519 seed is 32 bytes");
  const privateKey = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519, seed]), format: "der", type: "pkcs8" });
  const raw = createPublicKey(privateKey).export({ format: "der", type: "spki" }).subarray(-32);
  return {
    publicKey: Buffer.from(raw).toString("hex"),
    privateKey,
    sign: (tag, amount) => sign(null, iouBody(tag, amount), privateKey).toString("hex"),
  };
}

export function iouVerifier(publicKey: string): (tag: string, amount: bigint, sig: string) => boolean {
  const key = createPublicKey({ key: Buffer.concat([SPKI_ED25519, hex(publicKey)]), format: "der", type: "spki" });
  return (tag, amount, sig) => {
    const s = hex(sig);
    return s.length === 64 && verify(null, iouBody(tag, amount), key, s);
  };
}

/** ADR tag.md's default: blake2b-256 of one of the inputs the open transaction spends. */
export function tagFromInput(input: TransactionInput.TransactionInput): string {
  return Buffer.from(blake2b(TransactionInput.toCBORBytes(input), { dkLen: 32 })).toString("hex");
}

// ---- small helpers -----------------------------------------------------

function hex(h: string): Uint8Array {
  if (!/^([0-9a-f]{2})*$/i.test(h)) throw new Error(`not hex: ${h.slice(0, 16)}`);
  return Uint8Array.from(Buffer.from(h, "hex"));
}

function list(d: Data.Data, n: number, what: string): Data.Data[] {
  if (!Array.isArray(d) || d.length !== n) throw new Error(`${what}: expected a list of ${n}`);
  return d as Data.Data[];
}

function constr(d: Data.Data, what: string): { index: bigint; fields: ReadonlyArray<Data.Data> } {
  if (!Data.isConstr(d)) throw new Error(`${what}: expected a constructor`);
  return d as unknown as { index: bigint; fields: ReadonlyArray<Data.Data> };
}

function bytes(d: Data.Data, what: string): string {
  if (!(d instanceof Uint8Array)) throw new Error(`${what}: expected bytes`);
  return Buffer.from(d).toString("hex");
}

function int(d: Data.Data, what: string): bigint {
  if (typeof d !== "bigint") throw new Error(`${what}: expected an integer`);
  return d;
}
