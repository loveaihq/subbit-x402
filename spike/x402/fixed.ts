// Step 18 of the plan, on preprod: Subbit's validator with upstream's fix (hash 6d877463…, upstream
// main at 74c20d2) against the one before it (62ce4309…, 66648db), on the defect the fix is for
// (RESULTS.md, steps 15 and 18). A batch whose two steps need two different signers, the later
// step's signer sorting first, failed at 66648db with "Impossible" in `xlist.ordered_insert`, with
// every signature present. This binding never builds one (a claim has one signer), so here it is
// built by hand (`spike/x402/mixed.ts`): one `Main` over two channels, the consumer's `Add` on one
// and the provider's `Sub` on the other, the step order picked from the key hashes.
//
//   fund-e2e  account 1 gives account 4 two UTxOs, 10 and 5 tADA, for part (a): `SPIKE_CONSUMER=4 npm run x402`
//   sweep-e2e account 4's ADA back to account 1, when (a) is done
//   fund      account 1 gives account 5 six UTxOs of 5 tADA
//   open      two ADA channels at each build, account 5 the consumer and account 1 the provider
//   batch     the batch in both orders at both builds, each EVALUATED through Blockfrost; at 66648db
//             nothing is sent (the descending batch is expected to be refused); at the fixed build the
//             descending batch is signed by both keys and SENT, and must land
//   refund    the four channels closed with Mutual, the ADA back to account 5
//   sweep     account 5's ADA (and any account of SWEEP_ACCOUNTS) back to account 1
//   report    every transaction's fee, size and units, and the two accounts' ADA before and after
//   balances  the two accounts' ADA now
//
// Usage: npm run fixed -- <fund-e2e|sweep-e2e|fund|open|batch|refund|sweep|report|balances>
// Env:   WALLET_MNEMONIC (preprod only), BLOCKFROST_PROJECT_ID; X402_STEP18_OUT=<name> keeps the
//        state in out/<name>/ (default out/x402-step18/); SWEEP_ACCOUNTS=5,7 for `sweep` (3, 4, 5 and 7
//        only). Accounts 6 and 9 are another project's and are refused, account 8 is left alone, and
//        account 2 holds the reference script and is never swept. Nothing is sent that is expected to fail.
//        Part (a) is spike/x402/e2e.ts with the consumer at account 4 and its state in out/x402-step18-e2e/.
import { Address, Assets, Client, Data, KeyHash, Transaction, preprod, type UTxO } from "@evolution-sdk/evolution";
import { Redeemer, UPSTREAM, UPSTREAM_66648DB, channelAddress, inlineDatum, iouSignerFromSeed, parseDatum, tagFromInput, type Constants, type Validator } from "../../src/subbit.ts";
import { referenceFor, type ChannelView } from "../../src/x402/cardano.ts";
import { BlockfrostChain, causeChain, retryQueries } from "../../src/x402/chain.ts";
import { WITH_OUR_UTXOS, collateralTarget } from "../../src/x402/client.ts";
import { BF_BASE, REF_STATE, ada, bf, inputOf, keyHashHex, load, log, must, run, save, scriptsFailed, submit, type BfUtxos } from "../chain.ts";
import { buildMixedBatch, planMixedBatch, type MixedStep, type Order } from "./mixed.ts";

const NETWORK = "cardano:preprod";
const DEPOSIT = 3_000_000n; // each channel's ADA
const SEED = 5_000_000n; // each of the consumer's UTxOs
const SEEDS = 6;
const ADD = 500_000n; // what the batch's Add puts into its channel
const OWED = 1_000_000n; // the batch's Sub: an IOU of 1 tADA, which the provider takes
/** Seller and provider: account 1. The consumer of the four channels: account 5. */
const ACCOUNT = { provider: 1, consumer: 5 } as const;
const FORBIDDEN = new Set([2, 6, 8, 9]);
for (const [name, i] of Object.entries(ACCOUNT)) if (FORBIDDEN.has(i)) throw new Error(`${name} is account ${i}, which is not this project's to use`);

const projectId = must("BLOCKFROST_PROJECT_ID");
const mnemonic = must("WALLET_MNEMONIC");
const wallet = (accountIndex: number) => {
  if (FORBIDDEN.has(accountIndex)) throw new Error(`account ${accountIndex} is not this script's to use`);
  return Client.make(preprod).withBlockfrost({ baseUrl: BF_BASE, projectId }).withSeed({ mnemonic, accountIndex });
};
const provider = wallet(ACCOUNT.provider);
const consumer = wallet(ACCOUNT.consumer);
type Wallet = typeof consumer;
const chain = new BlockfrostChain(NETWORK, BF_BASE, projectId);
const OUT = new URL(`../../out/${process.env.X402_STEP18_OUT ?? "x402-step18"}/`, import.meta.url);
const STATE = new URL("fixed.json", OUT);

// ---- state --------------------------------------------------------------------------------------

type Build = "old" | "fixed";
const BUILDS: Build[] = ["old", "fixed"];
const VALIDATOR: Record<Build, Validator> = { fixed: UPSTREAM, old: UPSTREAM_66648DB };

interface TxRec {
  what: string;
  tx: string;
}
interface ChannelRec {
  tag: string;
  /** The seed of its IOU key: deterministic, so that a resumed run signs for the channel again. */
  seed: number;
  /** Its position: as opened, and as it stands after what the run did to it. */
  ref: string;
}
interface Unit {
  tag: string;
  index: number;
  mem: string;
  steps: string;
}
interface Evaluation {
  build: Build;
  order: Order;
  steps: MixedStep[];
  outcome: "accepted" | "refused";
  units?: Unit[];
  detail?: string;
  /** The transaction, if this is the one that was sent. */
  sent?: string;
}
interface State {
  before?: Record<string, string>;
  after?: Record<string, string>;
  txs: TxRec[];
  /** Funding and sweeping around part (a): outside the window `before` and `after` bound. */
  e2eTxs?: TxRec[];
  channels: Partial<Record<Build, ChannelRec[]>>;
  evaluations: Evaluation[];
}
const state = (): State => ({ txs: [], channels: {}, evaluations: [], ...(load<Partial<State>>(STATE) as Partial<State>) });
const record = (f: (s: State) => void) => {
  const s = state();
  f(s);
  save(STATE, s);
};
const addTx = (what: string, tx: string) => record((s) => void (s.txs.some((t) => t.tx === tx) || s.txs.push({ what, tx })));
const addE2eTx = (what: string, tx: string) => record((s) => void ((s.e2eTxs ??= []).some((t) => t.tx === tx) || s.e2eTxs.push({ what, tx })));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const signerOf = (c: ChannelRec) => iouSignerFromSeed(new Uint8Array(32).fill(c.seed));
const adaOnlyOf = async (w: Wallet) => (await w.getWalletUtxos()).filter((u) => Assets.hasOnlyLovelace(u.assets));

// ---- balances ------------------------------------------------------------------------------------

async function lovelaceAt(address: string): Promise<bigint> {
  let total = 0n;
  for (let page = 1; ; page++) {
    // An address that has never held anything is a 404 to Blockfrost.
    const rows = ((await bf(`/addresses/${address}/utxos?page=${page}`).catch((e: Error) => (/: 404/.test(e.message) ? [] : Promise.reject(e)))) ?? []) as Array<{ amount: Array<{ unit: string; quantity: string }> }>;
    for (const r of rows) total += BigInt(r.amount.find((a) => a.unit === "lovelace")?.quantity ?? "0");
    if (rows.length < 100) return total;
  }
}

async function read(): Promise<Record<string, string>> {
  return {
    provider: (await lovelaceAt(Address.toBech32(await provider.address()))).toString(),
    consumer: (await lovelaceAt(Address.toBech32(await consumer.address()))).toString(),
  };
}

/** Both accounts' ADA, read until two reads 25 s apart agree: Blockfrost's address index trails a block. */
async function settled(label: string): Promise<Record<string, string>> {
  let last = await read();
  for (let attempt = 0; attempt < 6; attempt++) {
    await sleep(25_000);
    const now = await read();
    if (now.provider === last.provider && now.consumer === last.consumer) {
      log(`${label}: account ${ACCOUNT.provider} (provider) ${ada(BigInt(now.provider))}, account ${ACCOUNT.consumer} (consumer) ${ada(BigInt(now.consumer))} tADA`);
      return now;
    }
    last = now;
  }
  throw new Error("the balances did not settle in 3 minutes");
}

async function phaseBalances() {
  const now = await read();
  log(`now: account ${ACCOUNT.provider} ${ada(BigInt(now.provider))}, account ${ACCOUNT.consumer} ${ada(BigInt(now.consumer))} tADA`);
}

// ---- part (a): the consumer of the e2e run --------------------------------------------------------

const E2E_CONSUMER = 4;

async function phaseFundE2e() {
  if (state().e2eTxs?.some((t) => t.what === "fund e2e")) return log("fund-e2e: done");
  const to = await wallet(E2E_CONSUMER).address();
  let tx = provider.newTx();
  for (const amount of [10_000_000n, 5_000_000n]) tx = tx.payToAddress({ address: to, assets: Assets.fromLovelace(amount) });
  const sb = await tx.build({ changeAddress: await provider.address(), availableUtxos: await adaOnlyOf(provider) });
  addE2eTx("fund e2e", await submit(`fund-e2e: account ${E2E_CONSUMER} gets 10 and 5 tADA`, await sb.sign(), provider));
}

async function phaseSweepE2e() {
  addE2eTx(`sweep account ${E2E_CONSUMER}`, await sweepAccount(E2E_CONSUMER));
}

/** Everything of one account to account 1 in one transaction; its hash. */
async function sweepAccount(i: number): Promise<string> {
  if (![3, 4, 5, 7].includes(i)) throw new Error(`account ${i} is not one this script sweeps`);
  const w = wallet(i);
  const utxos = [...(await w.getWalletUtxos())];
  if (utxos.length === 0) throw new Error(`account ${i} holds nothing`);
  const sb = await w.newTx().collectFrom({ inputs: utxos }).build({ changeAddress: await provider.address(), availableUtxos: [] });
  return submit(`account ${i} swept to account ${ACCOUNT.provider}: ${utxos.length} UTxOs, ${ada(utxos.reduce((x, u) => x + Assets.lovelaceOf(u.assets), 0n))} tADA`, await sb.sign(), w);
}

// ---- fund, open ----------------------------------------------------------------------------------

async function phaseFund() {
  if (state().txs.some((t) => t.what === "fund")) return log("fund: done");
  const before = await settled("before");
  record((s) => (s.before = before));
  let tx = provider.newTx();
  const to = await consumer.address();
  for (let i = 0; i < SEEDS; i++) tx = tx.payToAddress({ address: to, assets: Assets.fromLovelace(SEED) });
  const sb = await tx.build({ changeAddress: await provider.address(), availableUtxos: await adaOnlyOf(provider) });
  addTx("fund", await submit(`fund: account ${ACCOUNT.consumer} gets ${SEEDS} UTxOs of ${ada(SEED)} tADA`, await sb.sign(), provider));
}

async function phaseOpen() {
  for (const build of BUILDS) {
    if (state().channels[build]) {
      log(`open ${build}: done`);
      continue;
    }
    const v = VALIDATOR[build];
    const at = channelAddress(0, undefined, v);
    const me = await consumer.address();
    const providerKeyHash = keyHashHex(await provider.address());
    const seeds = (await adaOnlyOf(consumer)).filter((u) => Assets.lovelaceOf(u.assets) === SEED).slice(0, 2);
    if (seeds.length < 2) throw new Error(`the consumer holds ${seeds.length} UTxOs of ${ada(SEED)} tADA and two are needed: run fund`);
    // One transaction opens both: a channel's tag is the hash of an input it spends, a different one each.
    const planned = seeds.map((seed, i) => {
      const n = (build === "old" ? 0x20 : 0x30) + i;
      const constants: Constants = { tag: tagFromInput(inputOf(seed)), currency: { kind: "ada" }, iouKey: iouSignerFromSeed(new Uint8Array(32).fill(n)).publicKey, consumer: keyHashHex(me), provider: providerKeyHash, closePeriodMs: 900_000n };
      return { n, constants };
    });
    let tx = consumer.newTx().collectFrom({ inputs: seeds });
    for (const { constants } of planned) tx = tx.payToAddress({ address: at, assets: Assets.fromLovelace(DEPOSIT), datum: inlineDatum(constants, { kind: "opened", subbed: 0n }, v) });
    const sb = await tx.build({ changeAddress: me, availableUtxos: [] });
    const hash = await submit(`open two channels at ${v.name} (${v.hash.slice(0, 8)}…)`, await sb.sign(), consumer);
    addTx(`open ${build}`, hash);
    // Where each landed, and which is which, from the chain: the outputs at the channel address, by the tag in their datums.
    const landed = ((await bf(`/txs/${hash}/utxos`)) as BfUtxos).outputs.filter((o) => o.address === Address.toBech32(at));
    const recs: ChannelRec[] = landed.map((o) => {
      const tag = parseDatum(Data.fromCBORHex(o.inline_datum!), v, 0).constants.tag;
      const n = planned.find((p) => p.constants.tag === tag)?.n;
      if (n === undefined) throw new Error(`a channel output of ${hash} carries a tag this run did not plan`);
      return { tag, seed: n, ref: `${hash}#${o.output_index}` };
    });
    if (recs.length !== 2) throw new Error(`expected two channel outputs, found ${recs.length}`);
    record((s) => (s.channels[build] = recs));
    log(`open ${build}: ${recs.map((r) => r.ref).join(" and ")}`);
  }
}

// ---- batch ---------------------------------------------------------------------------------------

/** The redeemers' units of a transaction as built. */
function unitsOf(tx: Transaction.Transaction): Unit[] {
  const r = tx.witnessSet.redeemers as unknown as { _tag?: string; value?: unknown } | undefined;
  if (!r) return [];
  const rows: Unit[] = [];
  if (r._tag === "RedeemerMap") {
    for (const [[tag, index], v] of r.value as Map<[string, bigint], { exUnits: { mem: bigint; steps: bigint } }>) rows.push({ tag, index: Number(index), mem: v.exUnits.mem.toString(), steps: v.exUnits.steps.toString() });
  } else {
    for (const x of (r.value ?? r) as Array<{ tag: string; index: bigint; exUnits: { mem: bigint; steps: bigint } }>) rows.push({ tag: x.tag, index: Number(x.index), mem: x.exUnits.mem.toString(), steps: x.exUnits.steps.toString() });
  }
  return rows;
}

async function viewOf(build: Build, c: ChannelRec): Promise<ChannelView> {
  const v = await chain.followChannel(c.ref, VALIDATOR[build].hash, c.tag);
  if (!v) throw new Error(`channel ${c.ref} is not at ${VALIDATOR[build].name}, or not there any more`);
  if (v.datum.stage.kind !== "opened") throw new Error(`channel ${c.ref} is ${v.datum.stage.kind}`);
  // Followed to where it is now: if that is not where this run left it, something else has moved it, and nothing is built on a guess.
  if (v.ref !== c.ref) throw new Error(`channel ${c.ref} has moved on to ${v.ref} since this run recorded it: look before going on`);
  return v;
}

/** The reference-script output for the fixed build, if one was deployed (`REFSCRIPT_FROM=1 npm run refscript -- deploy`), read only if it carries that build. */
async function referenceOf(build: Build): Promise<UTxO.UTxO | undefined> {
  const out = load<{ out?: { txHash: string; index: number } }>(REF_STATE).out;
  return build === "fixed" && out ? referenceFor(await chain.getUnspent(`${out.txHash}#${out.index}`), VALIDATOR.fixed) : undefined;
}

async function phaseBatch() {
  const s = state();
  if (s.evaluations.some((e) => e.sent)) return log(`batch: done, ${s.evaluations.find((e) => e.sent)!.sent}`);
  const providerAddress = Address.toBech32(await provider.address());
  const providerKeyHash = keyHashHex(await provider.address());
  for (const build of BUILDS) {
    const v = VALIDATOR[build];
    const recs = state().channels[build];
    if (!recs) throw new Error(`no ${build} channels: run open`);
    const views = (await Promise.all(recs.map((r) => viewOf(build, r)))) as [ChannelView, ChannelView];
    const reference = await referenceOf(build);
    const iou = (tag: string, amount: bigint) => signerOf(recs.find((r) => r.tag === tag)!).sign(tag, amount);
    // Ascending first: every build takes it, so it is the control the descending one is read against.
    for (const order of ["ascending", "descending"] as const) {
      if (state().evaluations.some((e) => e.build === build && e.order === order)) continue;
      const label = `${v.name} (${v.hash.slice(0, 8)}…), ${order}`;
      let built;
      let steps: MixedStep[];
      try {
        ({ built, order: steps } = await retryQueries("batch", async () =>
          buildMixedBatch({ wallet: consumer, validator: v, channels: views, providerKeyHash, payTo: providerAddress, add: ADD, owed: OWED, iou, order, ...(reference ? { reference } : {}), availableUtxos: await adaOnlyOf(consumer) }),
        ));
      } catch (e) {
        if (!scriptsFailed(e)) throw e;
        // The evaluator said the script failed. Anything but the old build's descending batch is not what was expected.
        const detail = causeChain(e).join(" | ").slice(0, 600);
        if (build !== "old" || order !== "descending") throw new Error(`${label}: the evaluator refused a batch that was expected to be accepted: ${detail}`);
        const planned = planMixedBatch(views, providerKeyHash, order).map(({ v: x, step, signer }) => ({ ref: x.ref, step, signer }));
        record((x) => x.evaluations.push({ build, order, steps: planned, outcome: "refused", detail }));
        log(`batch: ${label}: REFUSED by the evaluator, as expected (${detail.slice(0, 160)}); not sent`);
        continue;
      }
      const tx = await built.toTransaction();
      const units = unitsOf(tx);
      if (build === "old" && order === "descending") throw new Error(`${label}: the validator before the fix ACCEPTED the descending batch, which it should not; nothing was sent, and the funds stay where they are`);
      log(`batch: ${label}: accepted by the evaluator, ${units.map((u) => `${u.tag}:${u.index} ${u.mem} / ${u.steps}`).join("; ")}; steps ${steps.map((t) => `${t.step} by ${t.signer.slice(0, 8)}…`).join(", then ")}`);
      if (!(build === "fixed" && order === "descending")) {
        record((x) => x.evaluations.push({ build, order, steps, outcome: "accepted", units }));
      } else {
        // The one that is sent, with both keys: the consumer builds and signs it, the provider adds its witness.
        const witnessed = await built.assemble([await built.partialSign(), await provider.signTx(await built.toTransaction())]);
        const hash = await submit(`the descending batch at ${v.name}`, witnessed, consumer);
        addTx("batch at the fixed validator, descending", hash);
        record((x) => x.evaluations.push({ build, order, steps, outcome: "accepted", units, sent: hash }));
        // The channels' new positions, from the chain.
        const at = Address.toBech32(channelAddress(0, undefined, v));
        const landed = ((await bf(`/txs/${hash}/utxos`)) as BfUtxos).outputs.filter((o) => o.address === at);
        const moved = recs.map((r) => {
          const o = landed.find((x) => parseDatum(Data.fromCBORHex(x.inline_datum!), v, 0).constants.tag === r.tag);
          if (!o) throw new Error(`the batch left no output for channel ${r.tag.slice(0, 16)}…`);
          return { ...r, ref: `${hash}#${o.output_index}` };
        });
        record((x) => (x.channels.fixed = moved));
      }
    }
  }
}

// ---- refund --------------------------------------------------------------------------------------

async function phaseRefund() {
  const me = await consumer.address();
  const providerKeyHash = keyHashHex(await provider.address());
  for (const build of BUILDS) {
    const v = VALIDATOR[build];
    for (const c of state().channels[build] ?? []) {
      if (state().txs.some((t) => t.what === `refund ${build} ${c.tag.slice(0, 8)}`)) continue;
      const seen = await chain.followChannel(c.ref, v.hash, c.tag);
      if (!seen || seen.datum.stage.kind !== "opened") {
        log(`refund: ${c.ref} is not an open channel at ${v.name} now (${seen ? seen.datum.stage.kind : "gone"}); left alone`);
        continue;
      }
      const reference = await referenceOf(build);
      let tx = consumer.newTx().collectFrom({ inputs: [seen.utxo], redeemer: Redeemer.mutual() }).addSigner({ keyHash: KeyHash.fromHex(keyHashHex(me)) }).addSigner({ keyHash: KeyHash.fromHex(providerKeyHash) });
      tx = reference ? tx.readFrom({ referenceInputs: [reference] }) : tx.attachScript({ script: v.script });
      const adaOnly = await adaOnlyOf(consumer);
      const sb = await retryQueries("refund", () => tx.build({ changeAddress: me, availableUtxos: adaOnly, setCollateral: collateralTarget(adaOnly), ...WITH_OUR_UTXOS }));
      const witnessed = await sb.assemble([await sb.partialSign(), await provider.signTx(await sb.toTransaction())]);
      addTx(`refund ${build} ${c.tag.slice(0, 8)}`, await submit(`refund the ${build} channel ${c.ref.slice(0, 12)}…: ${ada(seen.lovelace)} tADA back to the consumer`, witnessed, consumer));
    }
  }
}

// ---- sweep ---------------------------------------------------------------------------------------

/** Everything of the named accounts back to account 1, one transaction each. Accounts 3, 4, 5 and 7 only. */
async function phaseSweep() {
  const accounts = (process.env.SWEEP_ACCOUNTS ?? String(ACCOUNT.consumer)).split(",").map(Number);
  for (const i of accounts) {
    if ((await wallet(i).getWalletUtxos()).length === 0) {
      log(`sweep: account ${i} holds nothing`);
      continue;
    }
    addTx(`sweep account ${i}`, await sweepAccount(i));
  }
}

// ---- report --------------------------------------------------------------------------------------

async function phaseReport() {
  const s = state();
  if (!s.before) throw new Error("no `before` snapshot: run fund");
  const after = s.after ?? (await settled("after"));
  record((x) => (x.after = after));
  log("transactions:");
  let fees = 0n;
  for (const t of s.txs) {
    const tx = await bf(`/txs/${t.tx}`);
    const redeemers = ((await bf(`/txs/${t.tx}/redeemers`).catch(() => [])) ?? []) as Array<{ purpose: string; tx_index: number; unit_mem: string; unit_steps: string }>;
    const fee = BigInt(tx.fees);
    fees += fee;
    log(`  ${t.what.padEnd(46)} ${t.tx} block ${tx.block_height} ${String(tx.size).padStart(5)} B fee ${ada(fee)}${redeemers.length ? `  units ${redeemers.map((r) => `${r.purpose}:${r.tx_index} ${r.unit_mem}/${r.unit_steps}`).join(", ")}` : ""}`);
  }
  for (const t of s.e2eTxs ?? []) {
    const tx = await bf(`/txs/${t.tx}`);
    log(`  (part a) ${t.what.padEnd(37)} ${t.tx} block ${tx.block_height} ${String(tx.size).padStart(5)} B fee ${ada(BigInt(tx.fees))}`);
  }
  log("evaluations:");
  for (const e of s.evaluations) {
    log(`  ${e.build.padEnd(5)} ${e.order.padEnd(11)} ${e.outcome.padEnd(9)} ${e.units ? e.units.map((u) => `${u.tag}:${u.index} ${u.mem}/${u.steps}`).join(", ") : (e.detail ?? "").slice(0, 120)}${e.sent ? `  SENT ${e.sent}` : "  (not sent)"}`);
  }
  const total = (r: Record<string, string>) => BigInt(r.provider!) + BigInt(r.consumer!);
  log(`account ${ACCOUNT.provider}: ${ada(BigInt(s.before.provider!))} → ${ada(BigInt(after.provider!))} (${ada(BigInt(after.provider!) - BigInt(s.before.provider!))}); account ${ACCOUNT.consumer}: ${ada(BigInt(s.before.consumer!))} → ${ada(BigInt(after.consumer!))} (${ada(BigInt(after.consumer!) - BigInt(s.before.consumer!))}) tADA`);
  log(`together ${ada(total(s.before))} → ${ada(total(after))}: ${ada(total(s.before) - total(after))} lost; the fees of the ${s.txs.length} transactions: ${ada(fees)}`);
  if (total(s.before) - total(after) !== fees) log("  NOT EQUAL: something besides fees moved between these accounts and the rest");
  const open = Object.entries(s.channels).flatMap(([build, cs]) => (cs ?? []).map((c) => `${build} ${c.ref}`));
  log(`channels (positions after the run): ${open.join("; ")}`);
}

// ---- main -----------------------------------------------------------------------------------------

run(async () => {
  const phases: Record<string, () => Promise<void>> = { "fund-e2e": phaseFundE2e, "sweep-e2e": phaseSweepE2e, fund: phaseFund, open: phaseOpen, batch: phaseBatch, refund: phaseRefund, sweep: phaseSweep, report: phaseReport, balances: phaseBalances };
  const phase = phases[process.argv[2] ?? ""];
  if (!phase) throw new Error(`usage: npm run fixed -- <${Object.keys(phases).join("|")}>`);
  log(`step 18: ${VALIDATOR.fixed.name} ${VALIDATOR.fixed.hash} against ${VALIDATOR.old.name} ${VALIDATOR.old.hash}; provider account ${ACCOUNT.provider}, consumer account ${ACCOUNT.consumer}`);
  await phase();
});
