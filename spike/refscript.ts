// Step 3 of the plan, on preprod: the validator as a reference script. Steps 1 and 2 attached
// its 3,046 bytes to every transaction that spends a channel. Here it goes on chain once, in an
// output account 2 holds, and steps 1 and 2 are run again reading it from there
// (SUBBIT_SCRIPT=ref), so each channel transaction can be set beside its inline twin.
//
//   deploy   the consumer pays the validator into one output at account 2, at its min-UTxO
//   check    reads that output back through the SDK, as every ref-mode transaction does
//   report   each channel transaction's fee in both modes, split into what the ledger charges
//            for, and the two wallets reconciled against every fee paid since the deploy
//
// Usage: npm run refscript -- <deploy|check|report>
//        between check and report: SUBBIT_SCRIPT=ref npm run spike -- all
//                                  SUBBIT_SCRIPT=ref npm run lifecycle -- all
// Env:   WALLET_MNEMONIC (preprod only), BLOCKFROST_PROJECT_ID
import { Address, Assets, TransactionHash } from "@evolution-sdk/evolution";
import { SUBBIT_HASH, subbitScript } from "../src/subbit.ts";
import {
  REF_STATE,
  ada,
  bf,
  consumer,
  expectEq,
  load as loadFile,
  log,
  lovelaceOfBf,
  provider,
  refHolder,
  refScriptUtxo,
  run,
  save as saveFile,
  stateFile,
  submit,
  type BfUtxos,
} from "./chain.ts";

interface State {
  out?: { txHash: string; index: number };
  /** What the output holds: the min-UTxO for its size, script included. */
  lovelace?: bigint;
  fee?: bigint;
  /** The consumer's and provider's ADA just before the deploy. */
  before?: { consumer: bigint; provider: bigint };
}

const load = () => loadFile<State>(REF_STATE);
const save = (s: State) => saveFile(REF_STATE, s);

async function main() {
  const phases: Record<string, () => Promise<void>> = { deploy, check, report };
  const phase = phases[process.argv[2] ?? ""];
  if (!phase) throw new Error(`usage: npm run refscript -- <${Object.keys(phases).join("|")}>`);
  await phase();
}

async function deploy() {
  const st = load();
  if (st.out) return log(`deploy: already done, ${st.out.txHash}#${st.out.index}`);
  const holder = await refHolder.address();
  const before = await walletsAda();
  const sb = await consumer
    .newTx()
    // autoMinUtxo solves for the least lovelace the output's own size, script included, allows.
    .payToAddress({ address: holder, assets: Assets.fromLovelace(0n), script: subbitScript, autoMinUtxo: true })
    .build({ changeAddress: await consumer.address() });
  const txHash = await submit("deploy", await sb.sign(), consumer);

  const outs = ((await bf(`/txs/${txHash}/utxos`)) as BfUtxos).outputs.filter((o) => o.address === Address.toBech32(holder));
  if (outs.length !== 1) throw new Error(`expected one output at account 2, found ${outs.length}`);
  const o = outs[0]!;
  expectEq("the output carries the Subbit validator", o.reference_script_hash, SUBBIT_HASH);
  expectEq("the output holds nothing but ADA", o.amount.length, 1);
  const lovelace = lovelaceOfBf(o);
  const fee = BigInt((await bf(`/txs/${txHash}`)).fees);
  save({ out: { txHash, index: o.output_index }, lovelace, fee, before });
  log(`deploy: ${txHash}#${o.output_index} holds the validator and ${ada(lovelace)} tADA; fee ${ada(fee)} tADA`);
}

async function check() {
  const u = await refScriptUtxo();
  const p = await paramsOfEpoch(Number((await bf("/epochs/latest")).epoch));
  const lovelace = Assets.lovelaceOf(u.assets);
  const bytes = await scriptBytes(SUBBIT_HASH);
  log(`check: ${TransactionHash.toHex(u.transactionId)}#${u.index} at ${Address.toBech32(u.address)}`);
  log(`  ok  the SDK reads it back carrying script ${SUBBIT_HASH}`);
  log(`  script ${bytes} bytes by Blockfrost's count; the blueprint's compiled code is 3046`);
  log(`  holds ${ada(lovelace)} tADA = ${p.coinsPerByte} × ${lovelace / p.coinsPerByte} bytes (160 of them the ledger's per-entry overhead)${lovelace % p.coinsPerByte ? `, remainder ${lovelace % p.coinsPerByte}` : ""}`);
  log(`  a transaction that reads it pays ${p.refPerByte} × ${bytes} = ${ada(p.refPerByte * bytes)} tADA for it`);
}

// ---- report ---------------------------------------------------------------

interface Step1 {
  open?: { txHash: string };
  sub?: { txHash: string };
  mutual?: { txHash: string };
}

interface Step2 {
  a?: { txs: Record<string, { txHash: string }> };
  b?: { txs: Record<string, { txHash: string }> };
}

/** The eight channel transactions that run the validator, the same in both modes. */
const PATHS: ReadonlyArray<[string, (s1: Step1, s2: Step2) => string | undefined]> = [
  ["step 1 sub", (s1) => s1.sub?.txHash],
  ["step 1 mutual", (s1) => s1.mutual?.txHash],
  ["A sub", (_, s2) => s2.a?.txs["a-sub"]?.txHash],
  ["A close", (_, s2) => s2.a?.txs["a-close"]?.txHash],
  ["A settle", (_, s2) => s2.a?.txs["a-settle"]?.txHash],
  ["A end", (_, s2) => s2.a?.txs["a-end"]?.txHash],
  ["B close", (_, s2) => s2.b?.txs["b-close"]?.txHash],
  ["B elapse", (_, s2) => s2.b?.txs["b-elapse"]?.txHash],
];

async function report() {
  const st = load();
  if (!st.out || st.lovelace === undefined || st.fee === undefined || !st.before) throw new Error("run deploy first");
  const runs = {
    inline: [loadFile<Step1>(stateFile("state", "inline")), loadFile<Step2>(stateFile("lifecycle", "inline"))] as const,
    ref: [loadFile<Step1>(stateFile("state", "ref")), loadFile<Step2>(stateFile("lifecycle", "ref"))] as const,
  };

  log(`fees per channel transaction, tADA; fee = size (a × bytes + b) + scripts run + reference scripts read + builder's margin`);
  log(`${"".padEnd(14)}${"mode".padEnd(7)}${"bytes".padStart(6)}${"mem".padStart(9)}${"steps".padStart(12)}${"fee".padStart(10)}  = ${"size".padStart(8)} + ${"run".padStart(8)} + ${"read".padStart(8)} + margin`);
  const total = { inline: 0n, ref: 0n };
  for (const [path, pick] of PATHS) {
    const pair: Partial<Record<"inline" | "ref", Cost>> = {};
    for (const mode of ["inline", "ref"] as const) {
      const hash = pick(...runs[mode]);
      if (!hash) throw new Error(`${mode} run has no ${path} transaction`);
      const c = await cost(hash);
      pair[mode] = c;
      total[mode] += c.fee;
      const margin = c.fee - c.bySize - c.byExec - c.byRef;
      if (margin < 0n) throw new Error(`${path} ${mode}: the fee is below what the ledger charges by this account; the account is wrong`);
      log(
        `${(mode === "inline" ? path : "").padEnd(14)}${mode.padEnd(7)}${String(c.size).padStart(6)}${String(c.mem).padStart(9)}${String(c.steps).padStart(12)}` +
          `${ada(c.fee).padStart(10)}  = ${ada(c.bySize).padStart(8)} + ${ada(c.byExec).padStart(8)} + ${ada(c.byRef).padStart(8)} + ${margin}`,
      );
    }
    const saved = pair.inline!.fee - pair.ref!.fee;
    log(`${"".padEnd(14)}${"saved".padEnd(7)}${String(pair.inline!.size - pair.ref!.size).padStart(6)}${"".padStart(21)}${ada(saved).padStart(10)}  (${pct(saved, pair.inline!.fee)})`);
  }
  const saved = total.inline - total.ref;
  log(`all eight: inline ${ada(total.inline)}, ref ${ada(total.ref)}; saved ${ada(saved)} (${pct(saved, total.inline)}), ${ada(saved / BigInt(PATHS.length))} per transaction`);
  if (saved > 0n) {
    log(`the deploy's ${ada(st.fee)} fee is repaid after ${ceilDiv(st.fee * BigInt(PATHS.length), saved)} channel transactions; its ${ada(st.lovelace)} tADA stays account 2's`);
  }

  // Every lovelace the two wallets held before the deploy is back in them, in the
  // reference-script output, or gone as a fee: all the ref-mode channels are closed.
  const [s1, s2] = runs.ref;
  const hashes = [
    ...[s1.open, s1.sub, s1.mutual].map((t) => t?.txHash),
    ...[s2.a, s2.b].flatMap((ch) => Object.values(ch?.txs ?? {}).map((t) => t.txHash)),
  ];
  if (hashes.some((h) => !h)) throw new Error("the ref runs are not complete");
  let fees = st.fee;
  for (const h of hashes) fees += BigInt((await bf(`/txs/${h}`)).fees);
  const after = await settledWalletsAda();
  log(`consumer ${ada(st.before.consumer)} → ${ada(after.consumer)}, provider ${ada(st.before.provider)} → ${ada(after.provider)} tADA`);
  expectEq(
    `before − after − the reference-script output = the fees of the deploy and ${hashes.length} transactions`,
    st.before.consumer + st.before.provider - after.consumer - after.provider - st.lovelace,
    fees,
  );
  log(`fees since the deploy: ${ada(fees)} tADA`);
}

interface Cost {
  size: bigint;
  fee: bigint;
  mem: bigint;
  steps: bigint;
  /** a × size + b */
  bySize: bigint;
  /** the scripts' execution units at the epoch's prices */
  byExec: bigint;
  /** the reference scripts of every input spent or read */
  byRef: bigint;
}

/** One confirmed transaction's fee, split by the ledger's own terms, from Blockfrost's record of it. */
async function cost(hash: string): Promise<Cost> {
  const tx = await bf(`/txs/${hash}`);
  const p = await paramsOfEpoch(Number((await bf(`/blocks/${tx.block}`)).epoch));
  const redeemers = (await bf(`/txs/${hash}/redeemers`)) as Array<{ unit_mem: string; unit_steps: string }>;
  const mem = redeemers.reduce((s, r) => s + BigInt(r.unit_mem), 0n);
  const steps = redeemers.reduce((s, r) => s + BigInt(r.unit_steps), 0n);
  const utxos = (await bf(`/txs/${hash}/utxos`)) as BfUtxos;
  let refBytes = 0n;
  for (const i of utxos.inputs) {
    if (!i.collateral && i.reference_script_hash) refBytes += await scriptBytes(i.reference_script_hash);
  }
  // The ledger prices reference-script bytes in tiers of 25,600, each 1.2× the last; one
  // 3,046-byte validator stays inside the first.
  if (refBytes >= 25_600n) throw new Error(`${hash}: ${refBytes} reference-script bytes, past the first price tier`);
  const size = BigInt(tx.size);
  const { priceMem: pm, priceStep: ps } = p;
  return {
    size,
    fee: BigInt(tx.fees),
    mem,
    steps,
    bySize: p.a * size + p.b,
    byExec: ceilDiv(pm.n * mem * ps.d + ps.n * steps * pm.d, pm.d * ps.d),
    byRef: p.refPerByte * refBytes,
  };
}

interface Ratio {
  n: bigint;
  d: bigint;
}

interface Params {
  a: bigint;
  b: bigint;
  priceMem: Ratio;
  priceStep: Ratio;
  refPerByte: bigint;
  coinsPerByte: bigint;
}

const paramsByEpoch = new Map<number, Promise<Params>>();

function paramsOfEpoch(epoch: number): Promise<Params> {
  let p = paramsByEpoch.get(epoch);
  if (!p) {
    p = bf(`/epochs/${epoch}/parameters`).then((j) => ({
      a: BigInt(j.min_fee_a),
      b: BigInt(j.min_fee_b),
      priceMem: ratio(j.price_mem),
      priceStep: ratio(j.price_step),
      refPerByte: BigInt(j.min_fee_ref_script_cost_per_byte),
      coinsPerByte: BigInt(j.coins_per_utxo_size),
    }));
    paramsByEpoch.set(epoch, p);
  }
  return p;
}

const scriptSizes = new Map<string, Promise<bigint>>();

function scriptBytes(hash: string): Promise<bigint> {
  let s = scriptSizes.get(hash);
  if (!s) {
    s = bf(`/scripts/${hash}`).then((j) => BigInt(j.serialised_size));
    scriptSizes.set(hash, s);
  }
  return s;
}

/** The exact ratio behind a decimal Blockfrost prints: 0.0577 → 577/10⁴, 7.21e-5 → 721/10⁷. */
function ratio(x: number | string): Ratio {
  const m = /^(\d+)(?:\.(\d+))?(?:e-(\d+))?$/i.exec(String(x));
  if (!m) throw new Error(`not a plain decimal: ${x}`);
  const frac = m[2] ?? "";
  return { n: BigInt(m[1]! + frac), d: 10n ** BigInt(frac.length + Number(m[3] ?? 0)) };
}

const ceilDiv = (x: bigint, y: bigint) => (x + y - 1n) / y;
const pct = (part: bigint, whole: bigint) => `${((Number(part) / Number(whole)) * 100).toFixed(1)}%`;

async function walletsAda() {
  const sum = async (w: typeof consumer) => (await w.getWalletUtxos()).reduce((s, u) => s + Assets.lovelaceOf(u.assets), 0n);
  return { consumer: await sum(consumer), provider: await sum(provider) };
}

/** Blockfrost's address index trails a confirmed transaction by ~20 s: read until two reads 30 s apart agree. */
async function settledWalletsAda() {
  let last = await walletsAda();
  for (let attempt = 0; attempt < 6; attempt++) {
    await new Promise((res) => setTimeout(res, 30_000));
    const now = await walletsAda();
    if (now.consumer === last.consumer && now.provider === last.provider) return now;
    last = now;
  }
  throw new Error("wallet balances did not settle in 3 minutes");
}

run(main);
