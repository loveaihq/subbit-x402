// Off-chain side of Subbit.xyz (kompact-io/subbit-xyz @ 66648db): the datum,
// redeemer and IOU encodings its validator checks, and the checks a provider
// must make itself because opening a channel runs no validator.
import { readFileSync } from "node:fs";
import { createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from "node:crypto";
import { blake2b } from "@noble/hashes/blake2.js";
import { Address, Data, InlineDatum, KeyHash, PlutusV3, ScriptHash, TransactionInput } from "@evolution-sdk/evolution";

const blueprint = JSON.parse(
  readFileSync(new URL("../vendor/subbit/plutus.json", import.meta.url), "utf8"),
) as { validators: Array<{ title: string; hash: string; compiledCode: string }> };
const spend = blueprint.validators.find((v) => v.title === "subbit.subbit.spend");
if (!spend) throw new Error("subbit.subbit.spend is missing from vendor/subbit/plutus.json");

export const SUBBIT_HASH = spend.hash;
export const subbitScript = new PlutusV3.PlutusV3({ bytes: hex(spend.compiledCode) });
const computedHash = ScriptHash.toHex(ScriptHash.fromScript(subbitScript));
if (computedHash !== SUBBIT_HASH) {
  throw new Error(`script bytes hash to ${computedHash}, blueprint says ${SUBBIT_HASH}`);
}

/** A channel lives at the script's payment credential; the stake part is the consumer's choice and must never change. */
export function channelAddress(networkId: number, delegation?: KeyHash.KeyHash | ScriptHash.ScriptHash): Address.Address {
  return new Address.Address({
    networkId,
    paymentCredential: ScriptHash.fromHex(SUBBIT_HASH),
    ...(delegation ? { stakingCredential: delegation } : {}),
  });
}

export type Currency = { readonly kind: "ada" } | { readonly kind: "asset"; readonly policy: string; readonly name: string };

export interface Constants {
  /** Unique per (iouKey, tag); ADR tag.md recommends blake2b-256 of an input the open tx spends. */
  readonly tag: string;
  readonly currency: Currency;
  /** Ed25519 public key (32 bytes) that signs IOUs. Hot; separate from the consumer's tx key. */
  readonly iouKey: string;
  readonly consumer: string;
  readonly provider: string;
  readonly closePeriodMs: bigint;
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

export function datumData(c: Constants, s: Stage): Data.Data {
  return Data.list([
    hex(SUBBIT_HASH),
    Data.list([hex(c.tag), currencyData(c.currency), hex(c.iouKey), hex(c.consumer), hex(c.provider), c.closePeriodMs]),
    stageData(s),
  ]);
}

export function inlineDatum(c: Constants, s: Stage): InlineDatum.InlineDatum {
  return new InlineDatum.InlineDatum({ data: datumData(c, s) });
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

/** Strict inverse of datumData: anything that is not exactly a Subbit datum throws. */
export function parseDatum(d: Data.Data): ParsedDatum {
  const [ownHash, constants, stage] = list(d, 3, "datum");
  const [tag, currency, iouKey, consumer, provider, closePeriod] = list(constants, 6, "constants");
  return {
    ownHash: bytes(ownHash, "own_hash"),
    constants: {
      tag: bytes(tag, "tag"),
      currency: parseCurrency(currency),
      iouKey: bytes(iouKey, "iou_key"),
      consumer: bytes(consumer, "consumer"),
      provider: bytes(provider, "provider"),
      closePeriodMs: int(closePeriod, "close_period"),
    },
    stage: parseStage(stage),
  };
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
