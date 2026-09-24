// Chain plumbing shared by the spike's steps: the preprod wallets, where transactions get
// the validator from, submitting and waiting, reading results back from Blockfrost, slot
// arithmetic, build-only validator checks, and the checks a provider makes before serving
// a channel it did not open.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import {
  Address,
  Assets,
  Client,
  InlineDatum,
  KeyHash,
  ScriptHash,
  Time,
  TransactionHash,
  TransactionInput,
  preprod,
  type UTxO,
} from "@evolution-sdk/evolution";
import { SUBBIT_HASH, channelAddress, parseDatum, subbitScript, type Constants } from "../src/subbit.ts";

export const NETWORK_ID = 0;
export const BF_BASE = "https://cardano-preprod.blockfrost.io/api/v0";

const MNEMONIC = must("WALLET_MNEMONIC");
const BF_KEY = must("BLOCKFROST_PROJECT_ID");

const wallet = (accountIndex: number) =>
  Client.make(preprod).withBlockfrost({ baseUrl: BF_BASE, projectId: BF_KEY }).withSeed({ mnemonic: MNEMONIC, accountIndex });
export const consumer = wallet(0);
export const provider = wallet(1);
export type Wallet = typeof consumer;
export const chan = channelAddress(NETWORK_ID);

// ---- where a transaction gets the validator from --------------------------

/**
 * `SUBBIT_SCRIPT=ref` has every transaction that spends a channel read the validator from the
 * reference-script output `npm run refscript -- deploy` made. The default, `inline`, attaches
 * its 3,046 bytes to each such transaction, as steps 1 and 2 did.
 */
export const SCRIPT_MODE = scriptMode();
/**
 * Account 2 holds the reference-script output and never builds a transaction. The SDK's coin
 * selection skips only the reference inputs of the transaction being built, so in a spending
 * wallet the output could go out as plain ADA in the next ordinary transaction.
 */
export const refHolder = wallet(2);
export const REF_STATE = new URL("../out/refscript.json", import.meta.url);

/** A step's state file. Each mode keeps its own, so a run in one never resumes the other's. */
export const stateFile = (step: string, mode = SCRIPT_MODE) => new URL(`../out/${step}${mode === "ref" ? "-ref" : ""}.json`, import.meta.url);

type TxBuilder = ReturnType<Wallet["newTx"]>;
let refUtxo: Promise<UTxO.UTxO> | undefined;

/** Gives a transaction that spends a channel its validator: attached, or by reference, per SUBBIT_SCRIPT. */
export async function withSubbit(tx: TxBuilder): Promise<TxBuilder> {
  if (SCRIPT_MODE === "inline") return tx.attachScript({ script: subbitScript });
  refUtxo ??= refScriptUtxo();
  return tx.readFrom({ referenceInputs: [await refUtxo] });
}

/** The deployed reference-script output, read from the chain and checked to carry exactly the Subbit validator. */
export async function refScriptUtxo(): Promise<UTxO.UTxO> {
  const ref = load<{ out?: { txHash: string; index: number } }>(REF_STATE).out;
  if (!ref) throw new Error("no reference script yet: run `npm run refscript -- deploy` first");
  const at = `${ref.txHash}#${ref.index}`;
  for (let attempt = 0; ; attempt++) {
    const [u] = await refHolder.getUtxosByOutRef([outRef(ref.txHash, ref.index)]).catch(() => []);
    if (u?.scriptRef) {
      const hash = ScriptHash.toHex(ScriptHash.fromScript(u.scriptRef));
      if (hash !== SUBBIT_HASH) throw new Error(`${at} carries script ${hash}, not the Subbit validator`);
      return u;
    }
    // Right after the deploy the indexer may not have the output yet, and the SDK drops a
    // reference script it cannot fetch instead of failing, so both are retried.
    if (attempt >= 10) throw new Error(u ? `${at} carries no reference script` : `${at} is spent or unknown`);
    await new Promise((res) => setTimeout(res, 3_000));
  }
}

function scriptMode(): "inline" | "ref" {
  const m = process.env.SUBBIT_SCRIPT ?? "inline";
  if (m !== "inline" && m !== "ref") throw new Error(`SUBBIT_SCRIPT must be inline or ref, not ${m}`);
  return m;
}

// ---- the provider's own checks on a channel it did not open -------------

/** Opening runs no validator, so everything the provider relies on is checked here, before the first IOU. */
export function checkChannel(utxo: UTxO.UTxO, providerKeyHash: string, expected: Constants, minClosePeriodMs: bigint) {
  const pay = utxo.address.paymentCredential;
  if (!(pay instanceof ScriptHash.ScriptHash) || ScriptHash.toHex(pay) !== SUBBIT_HASH) throw new Error("not at the Subbit script");
  if (utxo.scriptRef) throw new Error("channel carries a reference script");
  if (!Assets.hasOnlyLovelace(utxo.assets)) throw new Error("channel holds tokens besides ADA");
  if (!(utxo.datumOption instanceof InlineDatum.InlineDatum)) throw new Error("channel datum is not inline");
  const d = parseDatum(utxo.datumOption.data);
  if (d.ownHash !== SUBBIT_HASH) throw new Error("datum names another script");
  if (d.constants.provider !== providerKeyHash) throw new Error("channel is for another provider");
  if (d.constants.currency.kind !== "ada") throw new Error("channel currency is not ADA");
  if (d.constants.closePeriodMs < minClosePeriodMs) throw new Error("close period too short to settle in");
  if (Buffer.from(d.constants.iouKey, "hex").length !== 32) throw new Error("IOU key is not 32 bytes");
  if (Buffer.from(d.constants.tag, "hex").length > 64) throw new Error("tag too long");
  if (d.constants.iouKey !== expected.iouKey || d.constants.tag !== expected.tag) throw new Error("channel is not the one the IOUs were signed for");
  return d;
}

// ---- build-only validator checks ------------------------------------------

/**
 * `build()` runs every script through Blockfrost's evaluator; nothing here is submitted.
 * Only the evaluator answering that the script failed counts as a refusal. A network error,
 * an HTTP fault or an input the evaluator cannot find means the check itself is broken.
 *
 * Blockfrost answers `ScriptFailures: {}` with no detail (checked against both of its
 * evaluate endpoints), so which condition failed is shown by construction: every refused
 * transaction is one value away from a control that the same evaluator accepts.
 */
export async function refused(label: string, build: () => Promise<unknown>) {
  try {
    await build();
  } catch (e) {
    if (!scriptsFailed(e)) throw e;
    log(`  ok  refused: ${label}`);
    return;
  }
  throw new Error(`${label}: expected the validator to refuse it, but the transaction built`);
}

export async function accepted<T>(label: string, build: () => Promise<T>): Promise<T> {
  const built = await build();
  log(`  ok  accepted: ${label}`);
  return built;
}

/**
 * The SDK nests the evaluator's answer at the end of a `cause` chain: TransactionBuilderError
 * → EvaluationError → ProviderError → ProviderError → Ogmios' EvaluationFailure. Only its
 * `ScriptFailures` form means the scripts ran; every other form, or none, is something else.
 */
export function scriptsFailed(e: unknown): boolean {
  for (let v = e, depth = 0; v !== null && typeof v === "object" && depth < 10; v = (v as { cause?: unknown }).cause, depth++) {
    if ("ScriptFailures" in v) return true;
  }
  return false;
}

// ---- time -----------------------------------------------------------------

/** Start of a slot in Unix ms, which is what a script sees for a validity bound set to that slot. */
export const msOf = (slot: bigint) => Time.slotToUnixTime(slot, preprod.slotConfig);
/** The slot containing a Unix ms time. `setValidity` floors times to slots the same way. */
export const slotOf = (ms: bigint) => Time.unixTimeToSlot(ms, preprod.slotConfig);
/** The first slot starting at or after `ms`: a lower bound set there is never below `ms`. */
export const slotAtOrAfter = (ms: bigint) => {
  const s = slotOf(ms);
  return msOf(s) < ms ? s + 1n : s;
};
export const nowMs = () => BigInt(Date.now());
export const iso = (ms: bigint) => new Date(Number(ms)).toISOString().slice(0, 19) + "Z";

/** Waits until the chain's tip has reached `slot`, so a transaction valid from `slot` is admitted. */
export async function waitForSlot(slot: bigint, what: string) {
  for (;;) {
    const tip = BigInt((await bf("/blocks/latest")).slot);
    if (tip >= slot) return tip;
    log(`${what}: tip at slot ${tip}, ${slot - tip} slots (s) to go`);
    await new Promise((res) => setTimeout(res, Math.min(120_000, Number(slot - tip) * 1_000 + 5_000)));
  }
}

// ---- submitting and reading back ------------------------------------------

export async function submit(what: string, submitBuilder: { submit(): Promise<TransactionHash.TransactionHash> }, client: Wallet) {
  const hash = await submitBuilder.submit();
  const hex = TransactionHash.toHex(hash);
  log(`${what}: submitted ${hex}, waiting for a block…`);
  const ok = await client.awaitTx(hash, 5_000, 240_000);
  if (!ok) throw new Error(`${what}: ${hex} not confirmed in 4 minutes`);
  await untilIndexed(hex, client);
  return hex;
}

/**
 * Blockfrost's address index trails a confirmed transaction by ~20 s, and until it catches up
 * the wallet still lists the inputs just spent. The SDK evaluates against the UTxOs it selected
 * (`/utils/txs/evaluate/utxos`), so a build that picks one of them passes evaluation and fails
 * only at submission. Wait until none of them is listed.
 */
async function untilIndexed(txHash: string, client: Wallet) {
  const spent = new Set(
    ((await bf(`/txs/${txHash}/utxos`)) as BfUtxos).inputs.filter((i) => !i.collateral && !i.reference).map((i) => `${i.tx_hash}#${i.output_index}`),
  );
  for (let attempt = 0; attempt < 20; attempt++) {
    const listed = (await client.getWalletUtxos()).map((u) => `${TransactionHash.toHex(u.transactionId)}#${u.index}`);
    if (!listed.some((k) => spent.has(k))) return;
    await new Promise((res) => setTimeout(res, 3_000));
  }
  throw new Error(`${txHash}: a minute after confirmation the wallet still lists inputs it spent`);
}

export interface BfOutput {
  address: string;
  amount: Array<{ unit: string; quantity: string }>;
  output_index: number;
  inline_datum?: string | null;
  reference_script_hash?: string | null;
}

export interface BfUtxos {
  inputs: Array<BfOutput & { tx_hash: string; collateral?: boolean; reference?: boolean }>;
  outputs: Array<BfOutput & { collateral?: boolean }>;
}

export async function bf(path: string) {
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(BF_BASE + path, { headers: { project_id: BF_KEY } });
    if (r.ok) return r.json();
    if (r.status !== 404 || attempt >= 10) throw new Error(`Blockfrost ${path}: ${r.status}`);
    await new Promise((res) => setTimeout(res, 3_000)); // indexer lag right after confirmation
  }
}

export function lovelaceOfBf(o: { amount: Array<{ unit: string; quantity: string }> }): bigint {
  return BigInt(o.amount.find((a) => a.unit === "lovelace")?.quantity ?? "0");
}

export function netFor(utxos: { inputs: Array<{ address: string; amount: BfOutput["amount"] }>; outputs: BfOutput[] }, address: string): bigint {
  const sum = (xs: Array<{ address: string; amount: BfOutput["amount"] }>) =>
    xs.filter((x) => x.address === address).reduce((s, x) => s + lovelaceOfBf(x), 0n);
  // A valid transaction spends neither its collateral nor its reference inputs, and does not
  // create its collateral-return output — Blockfrost lists all three anyway, flagged.
  type Flags = { collateral?: boolean; reference?: boolean };
  const spent = utxos.inputs.filter((i) => !(i as Flags).collateral && !(i as Flags).reference);
  const created = utxos.outputs.filter((o) => !(o as Flags).collateral);
  return sum(created) - sum(spent);
}

export function inputOf(u: UTxO.UTxO) {
  return new TransactionInput.TransactionInput({ transactionId: u.transactionId, index: u.index });
}

export function outRef(txHash: string, index: number) {
  return new TransactionInput.TransactionInput({ transactionId: TransactionHash.fromHex(txHash), index: BigInt(index) });
}

export function keyHashHex(a: Address.Address): string {
  if (!(a.paymentCredential instanceof KeyHash.KeyHash)) throw new Error("expected a key address");
  return KeyHash.toHex(a.paymentCredential);
}

// ---- small helpers -----------------------------------------------------

export function expectEq(what: string, actual: unknown, expected: unknown) {
  if (actual !== expected) throw new Error(`${what}: expected ${String(expected)}, got ${String(actual)}`);
  log(`  ok  ${what}`);
}

export const big = (_: string, v: unknown) => (typeof v === "bigint" ? `${v}n` : v);

export function load<T>(file: URL): T {
  if (!existsSync(file)) return {} as T;
  return JSON.parse(readFileSync(file, "utf8"), (_, v) => (typeof v === "string" && /^-?\d+n$/.test(v) ? BigInt(v.slice(0, -1)) : v));
}

export function save<T>(file: URL, s: T) {
  mkdirSync(new URL(".", file), { recursive: true });
  writeFileSync(file, JSON.stringify(s, big, 2));
}

export function ada(lovelace: bigint): string {
  const neg = lovelace < 0n;
  const v = neg ? -lovelace : lovelace;
  return `${neg ? "-" : ""}${v / 1_000_000n}.${(v % 1_000_000n).toString().padStart(6, "0")}`;
}

export function must(k: string): string {
  const v = process.env[k];
  if (!v) throw new Error(`${k} is not set`);
  return v;
}

export function log(s: string) {
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${s}`);
}

export function run(main: () => Promise<void>) {
  main().catch((e) => {
    const hide = (s: string) => s.replaceAll(BF_KEY, "<project id>");
    console.error(hide(e instanceof Error ? (e.stack ?? e.message) : String(e)));
    // The SDK wraps the node's or the evaluator's own answer several causes deep.
    for (let c = causeOf(e), depth = 0; c != null && depth < 10; c = causeOf(c), depth++) {
      console.error(hide(`  caused by: ${c instanceof Error ? c.message : JSON.stringify(c, big)}`));
    }
    process.exit(1);
  });
}

const causeOf = (v: unknown) => (v !== null && typeof v === "object" ? (v as { cause?: unknown }).cause : undefined);
