// Step 1 of the plan, on preprod: can Cardano take x402-sized payments at all?
//
//   open    consumer locks 20 tADA in a Subbit channel (no validator runs here)
//   ious    consumer signs 5,000 cumulative IOUs of 0.001 ADA; provider verifies each
//   sub     provider redeems the latest IOU in ONE transaction, channel stays open
//   mutual  both sign to close; the consumer gets the rest back
//
// Every result is read back from Blockfrost, not taken from the builder's word.
// Usage: npm run spike -- <balance|open|ious|sub|mutual|all|negative>
// Env:   WALLET_MNEMONIC (preprod only), BLOCKFROST_PROJECT_ID, SUBBIT_SCRIPT=inline|ref (default inline)
import { createPrivateKey, sign as edSign } from "node:crypto";
import { Address, Assets, Data, KeyHash } from "@evolution-sdk/evolution";
import {
  Redeemer,
  SUBBIT_HASH,
  Step,
  iouBody,
  iouVerifier,
  inlineDatum,
  newIouSigner,
  parseDatum,
  tagFromInput,
  type Constants,
} from "../src/subbit.ts";
import {
  ada,
  bf,
  big,
  chan,
  checkChannel,
  consumer,
  expectEq,
  inputOf,
  keyHashHex,
  load as loadFile,
  log,
  lovelaceOfBf,
  netFor,
  outRef,
  provider,
  run,
  save as saveFile,
  SCRIPT_MODE,
  scriptsFailed,
  stateFile,
  submit,
  withSubbit,
  type BfOutput,
} from "./chain.ts";

const DEPOSIT = 20_000_000n; // 20 tADA into the channel
const PRICE = 1_000n; // 0.001 ADA per request: under Cardano's ~0.98 ADA per-output floor
const REQUESTS = 5_000;
const PROVIDER_FLOAT = 10_000_000n; // provider needs its own ADA for fees and collateral
const CLOSE_PERIOD_MS = 3_600_000n;
const STATE = stateFile("state");
const load = () => loadFile<State>(STATE);
const save = (s: State) => saveFile(STATE, s);

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
  log(`validator: ${SCRIPT_MODE === "ref" ? "read from the reference-script output" : "attached inline"}`);
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
    const c = checkChannel(channel, keyHashHex(providerAddr), st.constants, CLOSE_PERIOD_MS);
    const held = Assets.lovelaceOf(channel.assets);
    if (c.stage.kind !== "opened") throw new Error("channel is not open");
    const take = owed - c.stage.subbed;
    if (held - take < 2_000_000n) throw new Error("IOU would drain the channel below its min-UTxO reserve");

    const signBuilder = await (await withSubbit(provider.newTx()))
      .collectFrom({ inputs: [channel], redeemer: Redeemer.main([Step.sub(owed, sig)]) })
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

  const signBuilder = await (await withSubbit(consumer.newTx()))
    .collectFrom({ inputs: [channel], redeemer: Redeemer.mutual() })
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
      await (await withSubbit(provider.newTx()))
        .collectFrom({ inputs: [channel], redeemer: Redeemer.main([Step.sub(owed, sig)]) })
        .payToAddress({ address: chan, assets: Assets.fromLovelace(held - take), datum: inlineDatum(constants, { kind: "opened", subbed: take }) })
        .addSigner({ keyHash: providerKH })
        .build({ changeAddress: providerAddr });
      verdict = "accept";
    } catch (e) {
      // Only the evaluator reporting a script failure counts as a rejection; anything else (network, rate limit) is a broken test.
      if (!scriptsFailed(e)) throw e;
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
  const sb = await (await withSubbit(consumer.newTx()))
    .collectFrom({ inputs: [channel], redeemer: Redeemer.mutual() })
    .addSigner({ keyHash: KeyHash.fromHex(keyHashHex(consumerAddr)) })
    .addSigner({ keyHash: providerKH })
    .build({ changeAddress: consumerAddr });
  const w = [await sb.partialSign(), await provider.signTx(await sb.toTransaction())];
  const closed = await submit("negative/mutual", await sb.assemble(w), consumer);
  save({ ...load(), negative: { ...load().negative!, closed } });
  log(`negative: 4 dishonest subs refused by the validator, the honest one built; channel closed in ${closed}`);
}

run(main);
