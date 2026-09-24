// Step 1 of the plan, on preprod: can Cardano take x402-sized payments at all?
//
//   open    consumer locks 20 tADA in a Subbit channel (no validator runs here)
//   ious    consumer signs 5,000 cumulative IOUs of 0.001 ADA; provider verifies each
//   sub     provider redeems the latest IOU in ONE transaction, channel stays open
//   mutual  both sign to close; the consumer gets the rest back
//
// Every result is read back from Blockfrost, not taken from the builder's word.
// Usage: npm run spike -- <balance|open|ious|sub|mutual|all>
// Env:   WALLET_MNEMONIC (preprod only), BLOCKFROST_PROJECT_ID
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createPrivateKey, sign as edSign } from "node:crypto";
import {
  Address,
  Assets,
  Client,
  Data,
  InlineDatum,
  KeyHash,
  ScriptHash,
  TransactionHash,
  TransactionInput,
  preprod,
  type UTxO,
} from "@evolution-sdk/evolution";
import {
  Redeemer,
  SUBBIT_HASH,
  Step,
  channelAddress,
  iouBody,
  iouVerifier,
  inlineDatum,
  newIouSigner,
  parseDatum,
  subbitScript,
  tagFromInput,
  type Constants,
} from "../src/subbit.ts";

const DEPOSIT = 20_000_000n; // 20 tADA into the channel
const PRICE = 1_000n; // 0.001 ADA per request: under Cardano's ~0.98 ADA per-output floor
const REQUESTS = 5_000;
const PROVIDER_FLOAT = 10_000_000n; // provider needs its own ADA for fees and collateral
const CLOSE_PERIOD_MS = 3_600_000n;
const NETWORK_ID = 0;
const BF_BASE = "https://cardano-preprod.blockfrost.io/api/v0";
const STATE = new URL("../out/state.json", import.meta.url);

const MNEMONIC = must("WALLET_MNEMONIC");
const BF_KEY = must("BLOCKFROST_PROJECT_ID");

const wallet = (accountIndex: number) =>
  Client.make(preprod).withBlockfrost({ baseUrl: BF_BASE, projectId: BF_KEY }).withSeed({ mnemonic: MNEMONIC, accountIndex });
const consumer = wallet(0);
const provider = wallet(1);
const chan = channelAddress(NETWORK_ID);

interface State {
  constants?: Constants;
  iouPrivateKeyPem?: string;
  open?: { txHash: string; index: number };
  latest?: { amount: bigint; sig: string; count: number; signMs: number; verifyMs: number };
  sub?: { txHash: string; index: number };
  mutual?: { txHash: string };
  negative?: { constants: Constants; open: { txHash: string; index: number }; iouPrivateKeyPem: string; closed?: string };
}

async function main() {
  const phase = process.argv[2] ?? "all";
  const phases: Record<string, () => Promise<void>> = { balance, open, ious, sub, mutual, negative };
  if (phase === "all") {
    for (const p of ["balance", "open", "ious", "sub", "mutual"]) await phases[p]!();
  } else if (phases[phase]) {
    await phases[phase]!();
  } else {
    throw new Error(`unknown phase ${phase}`);
  }
}

async function balance() {
  for (const [name, c] of [["consumer", consumer], ["provider", provider]] as const) {
    const addr = await c.address();
    const utxos = await c.getWalletUtxos();
    const total = utxos.reduce((s, u) => s + Assets.lovelaceOf(u.assets), 0n);
    log(`${name.padEnd(8)} ${Address.toBech32(addr)}  ${ada(total)} tADA in ${utxos.length} UTxOs`);
  }
  log(`channel  ${Address.toBech32(chan)}  (script ${SUBBIT_HASH})`);
}

async function open() {
  const st = load();
  if (st.open) return log(`open: already done, ${st.open.txHash}#${st.open.index}`);
  const consumerAddr = await consumer.address();
  const providerAddr = await provider.address();

  // The tag must be unique per IOU key; ADR tag.md: hash an input this tx spends. So pin that input.
  const pure = (await consumer.getWalletUtxos())
    .filter((u) => Assets.hasOnlyLovelace(u.assets))
    .sort((a, b) => (Assets.lovelaceOf(b.assets) > Assets.lovelaceOf(a.assets) ? 1 : -1));
  const seed = pure[0];
  if (!seed) throw new Error("consumer has no ADA-only UTxO to derive the tag from");
  const signer = newIouSigner();
  const constants: Constants = {
    tag: tagFromInput(inputOf(seed)),
    currency: { kind: "ada" },
    iouKey: signer.publicKey,
    consumer: keyHashHex(consumerAddr),
    provider: keyHashHex(providerAddr),
    closePeriodMs: CLOSE_PERIOD_MS,
  };

  const providerHas = (await provider.getWalletUtxos()).reduce((s, u) => s + Assets.lovelaceOf(u.assets), 0n);
  let tx = consumer
    .newTx()
    .collectFrom({ inputs: [seed] })
    .payToAddress({ address: chan, assets: Assets.fromLovelace(DEPOSIT), datum: inlineDatum(constants, { kind: "opened", subbed: 0n }) });
  if (providerHas < PROVIDER_FLOAT) {
    tx = tx.payToAddress({ address: providerAddr, assets: Assets.fromLovelace(PROVIDER_FLOAT) });
  }
  const txHash = await submit("open", await (await tx.build({ changeAddress: consumerAddr })).sign(), consumer);

  // Read it back: exactly one output at the script, carrying our datum and exactly the deposit.
  const outs = (await bf(`/txs/${txHash}/utxos`)).outputs as BfOutput[];
  const at = outs.filter((o) => o.address === Address.toBech32(chan));
  if (at.length !== 1) throw new Error(`expected one channel output, found ${at.length}`);
  const o = at[0]!;
  expectEq("channel value", lovelaceOfBf(o), DEPOSIT);
  expectEq("channel datum", JSON.stringify(parseDatum(Data.fromCBORHex(o.inline_datum!)), big), JSON.stringify({ ownHash: SUBBIT_HASH, constants, stage: { kind: "opened", subbed: 0n } }, big));
  save({
    ...st,
    constants,
    iouPrivateKeyPem: signer.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    open: { txHash, index: o.output_index },
  });
  log(`open: channel ${txHash}#${o.output_index} holds ${ada(DEPOSIT)} tADA, tag ${constants.tag.slice(0, 16)}…`);
}

async function ious() {
  const st = load();
  if (!st.constants || !st.iouPrivateKeyPem) throw new Error("run open first");
  const { tag, iouKey } = st.constants;
  const key = createPrivateKey(st.iouPrivateKeyPem);
  const verifyIou = iouVerifier(iouKey);

  // Consumer side: one signature per request over the running total.
  const t0 = performance.now();
  const signed: Array<{ amount: bigint; sig: string }> = [];
  for (let i = 1; i <= REQUESTS; i++) {
    const amount = BigInt(i) * PRICE;
    signed.push({ amount, sig: edSign(null, iouBody(tag, amount), key).toString("hex") });
  }
  const signMs = performance.now() - t0;

  // Provider side: accept only a strictly larger total that grows by exactly the price.
  const t1 = performance.now();
  let accepted = 0n;
  for (const { amount, sig } of signed) {
    if (amount - accepted !== PRICE) throw new Error(`IOU for ${amount} does not follow ${accepted}`);
    if (!verifyIou(tag, amount, sig)) throw new Error(`IOU for ${amount} does not verify`);
    accepted = amount;
  }
  const verifyMs = performance.now() - t1;
  const latest = signed[signed.length - 1]!;
  save({ ...st, latest: { ...latest, count: REQUESTS, signMs, verifyMs } });
  log(
    `ious: ${REQUESTS} signed in ${signMs.toFixed(0)} ms, verified in ${verifyMs.toFixed(0)} ms ` +
      `(${((signMs * 1000) / REQUESTS).toFixed(0)} / ${((verifyMs * 1000) / REQUESTS).toFixed(0)} µs each); owed ${ada(accepted)} tADA`,
  );
}

async function sub() {
  const st = load();
  if (!st.open || !st.constants || !st.latest) throw new Error("run open and ious first");
  if (st.sub) return log(`sub: already done, ${st.sub.txHash}`);
  const providerAddr = await provider.address();
  const { amount: owed, sig } = st.latest;
  // `--resume <hash>` re-checks a sub that reached the chain but whose check did not finish.
  const resumed = process.argv[3] === "--resume" ? process.argv[4] : undefined;

  let txHash: string;
  if (resumed) {
    txHash = resumed;
    log(`sub: re-checking ${txHash} from chain data`);
  } else {
    const [channel] = await provider.getUtxosByOutRef([outRef(st.open.txHash, st.open.index)]);
    if (!channel) throw new Error("channel UTxO not found");

    // Opening ran no validator, so everything the provider relies on is checked here.
    const c = checkChannel(channel, keyHashHex(providerAddr), st.constants);
    const held = Assets.lovelaceOf(channel.assets);
    if (c.stage.kind !== "opened") throw new Error("channel is not open");
    const take = owed - c.stage.subbed;
    if (held - take < 2_000_000n) throw new Error("IOU would drain the channel below its min-UTxO reserve");

    const signBuilder = await provider
      .newTx()
      .collectFrom({ inputs: [channel], redeemer: Redeemer.main([Step.sub(owed, sig)]) })
      .attachScript({ script: subbitScript })
      .payToAddress({
        address: chan,
        assets: Assets.fromLovelace(held - take),
        datum: inlineDatum(st.constants, { kind: "opened", subbed: owed }),
      })
      .addSigner({ keyHash: KeyHash.fromHex(keyHashHex(providerAddr)) })
      .build({ changeAddress: providerAddr });
    txHash = await submit("sub", await signBuilder.sign(), provider);
  }

  // Everything below is read from Blockfrost: the channel before and after, and who got what.
  const utxos = await bf(`/txs/${txHash}/utxos`);
  const script = Address.toBech32(chan);
  const before = (utxos.inputs as Array<BfOutput & { tx_hash: string }>).filter((i) => i.address === script);
  const after = (utxos.outputs as BfOutput[]).filter((o) => o.address === script);
  if (before.length !== 1 || after.length !== 1) throw new Error(`expected 1 channel in and 1 out, got ${before.length}/${after.length}`);
  expectEq("spent the opened channel", `${before[0]!.tx_hash}#${before[0]!.output_index}`, `${st.open.txHash}#${st.open.index}`);
  const stageIn = parseDatum(Data.fromCBORHex(before[0]!.inline_datum!)).stage;
  const stageOut = parseDatum(Data.fromCBORHex(after[0]!.inline_datum!)).stage;
  if (stageIn.kind !== "opened") throw new Error("channel was not open");
  const take = lovelaceOfBf(before[0]!) - lovelaceOfBf(after[0]!);
  expectEq("taken = owed - subbed before", take, owed - stageIn.subbed);
  expectEq("subbed after sub", JSON.stringify(stageOut, big), JSON.stringify({ kind: "opened", subbed: owed }, big));
  const fee = BigInt((await bf(`/txs/${txHash}`)).fees);
  expectEq("provider net = taken - fee", netFor(utxos, Address.toBech32(providerAddr)), take - fee);
  save({ ...st, sub: { txHash, index: after[0]!.output_index } });
  log(`sub: provider redeemed ${ada(take)} tADA for ${st.latest.count} requests in one tx; fee ${ada(fee)} tADA = ${ada(fee / BigInt(st.latest.count))} per request`);
}

async function mutual() {
  const st = load();
  if (!st.sub || !st.constants) throw new Error("run sub first");
  if (st.mutual) return log(`mutual: already done, ${st.mutual.txHash}`);
  const consumerAddr = await consumer.address();
  const providerAddr = await provider.address();
  const [channel] = await consumer.getUtxosByOutRef([outRef(st.sub.txHash, st.sub.index)]);
  if (!channel) throw new Error("channel UTxO not found");
  const held = Assets.lovelaceOf(channel.assets);

  const signBuilder = await consumer
    .newTx()
    .collectFrom({ inputs: [channel], redeemer: Redeemer.mutual() })
    .attachScript({ script: subbitScript })
    .addSigner({ keyHash: KeyHash.fromHex(keyHashHex(consumerAddr)) })
    .addSigner({ keyHash: KeyHash.fromHex(keyHashHex(providerAddr)) })
    .build({ changeAddress: consumerAddr });
  const consumerWitness = await signBuilder.partialSign();
  const providerWitness = await provider.signTx(await signBuilder.toTransaction());
  const txHash = await submit("mutual", await signBuilder.assemble([consumerWitness, providerWitness]), consumer);

  const utxos = await bf(`/txs/${txHash}/utxos`);
  if ((utxos.outputs as BfOutput[]).some((o) => o.address === Address.toBech32(chan))) {
    throw new Error("mutual close left an output at the script");
  }
  const fee = BigInt((await bf(`/txs/${txHash}`)).fees);
  expectEq("consumer net = remaining - fee", netFor(utxos, Address.toBech32(consumerAddr)), held - fee);
  save({ ...st, mutual: { txHash } });
  log(`mutual: channel closed, consumer got ${ada(held)} tADA back less a ${ada(fee)} tADA fee`);
}

/**
 * The validator must refuse a provider who takes more than the consumer signed for. On a fresh
 * 10 tADA channel with one 1 ADA IOU, each attempt is only built — the builder runs the script
 * through Blockfrost's evaluator — and never submitted. The honest control must build.
 */
async function negative() {
  const st = load();
  if (st.negative?.closed) return log(`negative: already done`);
  const consumerAddr = await consumer.address();
  const providerAddr = await provider.address();
  const providerKH = KeyHash.fromHex(keyHashHex(providerAddr));
  const signer = newIouSigner();
  const stranger = newIouSigner();

  let constants: Constants;
  let openRef: { txHash: string; index: number };
  if (st.negative?.open) {
    ({ constants, open: openRef } = st.negative);
  } else {
    const seed = (await consumer.getWalletUtxos()).filter((u) => Assets.hasOnlyLovelace(u.assets))[0];
    if (!seed) throw new Error("no ADA-only UTxO for the tag");
    constants = {
      tag: tagFromInput(inputOf(seed)),
      currency: { kind: "ada" },
      iouKey: signer.publicKey,
      consumer: keyHashHex(consumerAddr),
      provider: keyHashHex(providerAddr),
      closePeriodMs: CLOSE_PERIOD_MS,
    };
    const b = consumer
      .newTx()
      .collectFrom({ inputs: [seed] })
      .payToAddress({ address: chan, assets: Assets.fromLovelace(10_000_000n), datum: inlineDatum(constants, { kind: "opened", subbed: 0n }) });
    const txHash = await submit("negative/open", await (await b.build({ changeAddress: consumerAddr })).sign(), consumer);
    const out = ((await bf(`/txs/${txHash}/utxos`)).outputs as BfOutput[]).find((o) => o.address === Address.toBech32(chan))!;
    openRef = { txHash, index: out.output_index };
    save({ ...st, negative: { constants, open: openRef, iouPrivateKeyPem: signer.privateKey.export({ type: "pkcs8", format: "pem" }).toString() } });
  }
  const iouKey = createPrivateKey(load().negative!.iouPrivateKeyPem);
  const signAs = (key: typeof iouKey, tag: string, amount: bigint) => edSign(null, iouBody(tag, amount), key).toString("hex");
  const [channel] = await provider.getUtxosByOutRef([outRef(openRef.txHash, openRef.index)]);
  if (!channel) throw new Error("negative channel not found");
  const held = Assets.lovelaceOf(channel.assets);
  const ONE = 1_000_000n;
  const iou = signAs(iouKey, constants.tag, ONE);

  const attempt = async (label: string, owed: bigint, sig: string, take: bigint, expect: "accept" | "reject") => {
    let verdict: string;
    try {
      await provider
        .newTx()
        .collectFrom({ inputs: [channel], redeemer: Redeemer.main([Step.sub(owed, sig)]) })
        .attachScript({ script: subbitScript })
        .payToAddress({ address: chan, assets: Assets.fromLovelace(held - take), datum: inlineDatum(constants, { kind: "opened", subbed: take }) })
        .addSigner({ keyHash: providerKH })
        .build({ changeAddress: providerAddr });
      verdict = "accept";
    } catch (e) {
      const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      // Only a script failure counts as a rejection; anything else (network, rate limit) is a broken test.
      if (!/evaluat|script|validator|ExUnits|redeemer/i.test(msg)) throw e;
      verdict = "reject";
    }
    if (verdict !== expect) throw new Error(`${label}: expected ${expect}, validator said ${verdict}`);
    log(`  ok  ${label}: ${verdict}ed`);
  };

  await attempt("take 2 ADA on a 1 ADA IOU", ONE, iou, 2n * ONE, "reject");
  await attempt("claim the 1 ADA signature is for 2 ADA", 2n * ONE, iou, 2n * ONE, "reject");
  await attempt("IOU signed by a key the channel does not name", ONE, signAs(stranger.privateKey, constants.tag, ONE), ONE, "reject");
  await attempt("IOU signed for another channel's tag", ONE, signAs(iouKey, "ab".repeat(32), ONE), ONE, "reject");
  await attempt("control: take exactly the 1 ADA signed for", ONE, iou, ONE, "accept");

  // Give the tADA back.
  const sb = await consumer
    .newTx()
    .collectFrom({ inputs: [channel], redeemer: Redeemer.mutual() })
    .attachScript({ script: subbitScript })
    .addSigner({ keyHash: KeyHash.fromHex(keyHashHex(consumerAddr)) })
    .addSigner({ keyHash: providerKH })
    .build({ changeAddress: consumerAddr });
  const w = [await sb.partialSign(), await provider.signTx(await sb.toTransaction())];
  const closed = await submit("negative/mutual", await sb.assemble(w), consumer);
  save({ ...load(), negative: { ...load().negative!, closed } });
  log(`negative: 4 dishonest subs refused by the validator, the honest one built; channel closed in ${closed}`);
}

// ---- the provider's own checks on a channel it did not open -------------

function checkChannel(utxo: UTxO.UTxO, providerKeyHash: string, expected: Constants) {
  const pay = utxo.address.paymentCredential;
  if (!(pay instanceof ScriptHash.ScriptHash) || ScriptHash.toHex(pay) !== SUBBIT_HASH) throw new Error("not at the Subbit script");
  if (utxo.scriptRef) throw new Error("channel carries a reference script");
  if (!Assets.hasOnlyLovelace(utxo.assets)) throw new Error("channel holds tokens besides ADA");
  if (!(utxo.datumOption instanceof InlineDatum.InlineDatum)) throw new Error("channel datum is not inline");
  const d = parseDatum(utxo.datumOption.data);
  if (d.ownHash !== SUBBIT_HASH) throw new Error("datum names another script");
  if (d.constants.provider !== providerKeyHash) throw new Error("channel is for another provider");
  if (d.constants.currency.kind !== "ada") throw new Error("channel currency is not ADA");
  if (d.constants.closePeriodMs < CLOSE_PERIOD_MS) throw new Error("close period too short to settle in");
  if (Buffer.from(d.constants.iouKey, "hex").length !== 32) throw new Error("IOU key is not 32 bytes");
  if (Buffer.from(d.constants.tag, "hex").length > 64) throw new Error("tag too long");
  if (d.constants.iouKey !== expected.iouKey || d.constants.tag !== expected.tag) throw new Error("channel is not the one the IOUs were signed for");
  return d;
}

// ---- plumbing -------------------------------------------------------------

async function submit(what: string, submitBuilder: { submit(): Promise<TransactionHash.TransactionHash> }, client: typeof consumer) {
  const hash = await submitBuilder.submit();
  const hex = TransactionHash.toHex(hash);
  log(`${what}: submitted ${hex}, waiting for a block…`);
  const ok = await client.awaitTx(hash, 5_000, 240_000);
  if (!ok) throw new Error(`${what}: ${hex} not confirmed in 4 minutes`);
  return hex;
}

interface BfOutput {
  address: string;
  amount: Array<{ unit: string; quantity: string }>;
  output_index: number;
  inline_datum?: string | null;
}

async function bf(path: string) {
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(BF_BASE + path, { headers: { project_id: BF_KEY } });
    if (r.ok) return r.json();
    if (r.status !== 404 || attempt >= 10) throw new Error(`Blockfrost ${path}: ${r.status}`);
    await new Promise((res) => setTimeout(res, 3_000)); // indexer lag right after confirmation
  }
}

function lovelaceOfBf(o: { amount: Array<{ unit: string; quantity: string }> }): bigint {
  return BigInt(o.amount.find((a) => a.unit === "lovelace")?.quantity ?? "0");
}

function netFor(utxos: { inputs: Array<{ address: string; amount: BfOutput["amount"] }>; outputs: BfOutput[] }, address: string): bigint {
  const sum = (xs: Array<{ address: string; amount: BfOutput["amount"] }>) =>
    xs.filter((x) => x.address === address).reduce((s, x) => s + lovelaceOfBf(x), 0n);
  // A valid transaction spends neither its collateral nor its reference inputs, and does not
  // create its collateral-return output — Blockfrost lists all three anyway, flagged.
  type Flags = { collateral?: boolean; reference?: boolean };
  const spent = utxos.inputs.filter((i) => !(i as Flags).collateral && !(i as Flags).reference);
  const created = utxos.outputs.filter((o) => !(o as Flags).collateral);
  return sum(created) - sum(spent);
}

function inputOf(u: UTxO.UTxO) {
  return new TransactionInput.TransactionInput({ transactionId: u.transactionId, index: u.index });
}

function outRef(txHash: string, index: number) {
  return new TransactionInput.TransactionInput({ transactionId: TransactionHash.fromHex(txHash), index: BigInt(index) });
}

function keyHashHex(a: Address.Address): string {
  if (!(a.paymentCredential instanceof KeyHash.KeyHash)) throw new Error("expected a key address");
  return KeyHash.toHex(a.paymentCredential);
}

function expectEq(what: string, actual: unknown, expected: unknown) {
  if (actual !== expected) throw new Error(`${what}: expected ${String(expected)}, got ${String(actual)}`);
  log(`  ok  ${what}`);
}

const big = (_: string, v: unknown) => (typeof v === "bigint" ? `${v}n` : v);

function load(): State {
  if (!existsSync(STATE)) return {};
  return JSON.parse(readFileSync(STATE, "utf8"), (_, v) => (typeof v === "string" && /^-?\d+n$/.test(v) ? BigInt(v.slice(0, -1)) : v));
}

function save(s: State) {
  mkdirSync(new URL(".", STATE), { recursive: true });
  writeFileSync(STATE, JSON.stringify(s, big, 2));
}

function ada(lovelace: bigint): string {
  const neg = lovelace < 0n;
  const v = neg ? -lovelace : lovelace;
  return `${neg ? "-" : ""}${v / 1_000_000n}.${(v % 1_000_000n).toString().padStart(6, "0")}`;
}

function must(k: string): string {
  const v = process.env[k];
  if (!v) throw new Error(`${k} is not set`);
  return v;
}

function log(s: string) {
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${s}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? (e.stack ?? e.message) : e);
  process.exit(1);
});
