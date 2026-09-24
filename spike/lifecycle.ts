// Step 2 of the plan, on preprod: what each side can still do once the other stops
// cooperating. x402's batch-settlement trust model rests on these two guarantees.
//
//   A — the consumer closes on its own; the provider still gets paid
//     a-open    consumer locks 10 tADA, close period 1 h; the provider checks the channel
//     a-sub     1,000 requests paid by IOU; the provider redeems them (1 tADA) mid-life,
//               after step 1's four dishonest subs are refused again with a stricter check
//     a-close   2,000 more requests, then the consumer closes without the provider
//     a-settle  the provider settles its latest IOU: 3 tADA owed, 1 already redeemed
//     a-end     the consumer takes back what is left
//
//   B — the provider disappears; the consumer still gets its money back
//     b-open    consumer locks 5 tADA, close period 10 min (short only to keep the run short)
//     b-close   500 requests paid by IOU, then the consumer closes; the provider never answers
//     b-elapse  once elapse_at has passed, the consumer takes everything back on its own
//
// Before A's sub, close, settle and end, and B's elapse, build-only attempts (evaluated, never
// submitted) check what the validator must refuse, each one change away from the honest
// transaction. The honest transaction is built last, as the control, and is the one submitted.
//
// Usage: npm run lifecycle -- <phase|all|report>
//        `all` runs b-open and b-close first, so B's close period runs down while A runs.
// Env:   WALLET_MNEMONIC (preprod only), BLOCKFROST_PROJECT_ID, SUBBIT_SCRIPT=inline|ref (default inline)
import { createPrivateKey, sign as edSign, type KeyObject } from "node:crypto";
import { Address, Assets, Data, InlineDatum, KeyHash, TxOut, type UTxO } from "@evolution-sdk/evolution";
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
  type Stage,
} from "../src/subbit.ts";
import {
  accepted,
  ada,
  bf,
  big,
  chan,
  checkChannel,
  consumer,
  expectEq,
  inputOf,
  iso,
  keyHashHex,
  load as loadFile,
  log,
  lovelaceOfBf,
  msOf,
  netFor,
  nowMs,
  outRef,
  provider,
  refused,
  run,
  save as saveFile,
  SCRIPT_MODE,
  slotAtOrAfter,
  slotOf,
  stateFile,
  submit,
  waitForSlot,
  withSubbit,
  type BfUtxos,
} from "./chain.ts";
import { channelReserve } from "../src/x402/cardano.ts";
import { TOKEN, amountOf, amountOfBf, currency, token, unitName, valueOf } from "./currency.ts";

const PRICE = 1_000n; // 0.001 ADA per request, as in step 1
const ONE = 1_000_000n;
const A = { deposit: 10_000_000n, closePeriodMs: 3_600_000n };
const B = { deposit: 5_000_000n, closePeriodMs: 600_000n };
/** How long a close stays submittable. elapse_at lands this far out plus the close period. */
const CLOSE_TTL_SLOTS = 300n;
const STATE = stateFile(TOKEN ? "lifecycle-token" : "lifecycle");

interface Iou {
  amount: bigint;
  sig: string;
  count: number;
}

interface Channel {
  constants: Constants;
  iouPrivateKeyPem: string;
  /** The channel's current output. */
  at: { txHash: string; index: number };
  /** The latest IOU the provider has verified. */
  latest?: Iou;
  /** Submitted steps, by phase. */
  txs: Record<string, { txHash: string; fee: bigint }>;
}

interface State {
  a?: Channel;
  b?: Channel;
}

const load = () => loadFile<State>(STATE);
const save = (s: State) => saveFile(STATE, s);

async function main() {
  const phase = process.argv[2] ?? "all";
  log(`validator: ${SCRIPT_MODE === "ref" ? "read from the reference-script output" : "attached inline"}`);
  const phases: Record<string, () => Promise<void>> = {
    "a-open": aOpen,
    "a-sub": aSub,
    "a-close": aClose,
    "a-settle": aSettle,
    "a-end": aEnd,
    "b-open": bOpen,
    "b-close": bClose,
    "b-elapse": bElapse,
    report,
  };
  if (phase === "all") {
    for (const p of ["b-open", "b-close", "a-open", "a-sub", "a-close", "a-settle", "a-end", "b-elapse", "report"]) await phases[p]!();
  } else if (phases[phase]) {
    await phases[phase]!();
  } else {
    throw new Error(`unknown phase ${phase}`);
  }
}

// ---- A: the consumer closes on its own ------------------------------------

async function aOpen() {
  const st = load();
  if (st.a) return log(`a-open: already done, ${st.a.txs["a-open"]!.txHash}`);
  st.a = await openChannel("a-open", A.deposit, A.closePeriodMs);
  save(st);
}

async function aSub() {
  const st = load();
  const a = need(st.a, "a-open");
  if (a.txs["a-sub"]) return log(`a-sub: already done, ${a.txs["a-sub"].txHash}`);
  payUpTo(a, 1_000);
  save(st);
  const providerAddr = await provider.address();
  const utxo = await channelUtxo(a);
  const d = checkChannel(utxo, keyHashHex(providerAddr), a.constants, A.closePeriodMs);
  if (d.stage.kind !== "opened") throw new Error("channel is not open");
  const { amount: owed, sig } = a.latest!;
  const held = amountOf(utxo.assets);
  const take = owed - d.stage.subbed;
  const honest: SubTx = { owed, sig, keep: held - take, subbedOut: owed };
  const build = (change: Partial<SubTx>) => subTx(a, utxo, { ...honest, ...change });
  const signAs = (key: KeyObject, tag: string, amount: bigint) => edSign(null, iouBody(tag, amount), key).toString("hex");

  // Step 1's four dishonest subs again: its check matched error text, which an evaluator outage shares.
  await refused("the provider takes 1 lovelace more than the IOU covers", () => build({ keep: held - take - 1n, subbedOut: owed + 1n }));
  await refused("the provider presents the IOU as one for a request more", () =>
    build({ owed: owed + PRICE, keep: held - take - PRICE, subbedOut: owed + PRICE }),
  );
  await refused("an IOU signed by a key the channel does not name", () => build({ sig: signAs(newIouSigner().privateKey, a.constants.tag, owed) }));
  await refused("an IOU signed for another channel's tag", () => build({ sig: signAs(createPrivateKey(a.iouPrivateKeyPem), "ab".repeat(32), owed) }));
  if (TOKEN) {
    // A continuing output may hold ADA and the currency, nothing else.
    await refused("the continuing output also carries a token besides the currency", () => build({ extra: token!.extraUnit }));
    // The validator counts only the currency; the ADA riding along is held up by min-UTxO alone.
    const cpb = (await provider.getProtocolParameters()).coinsPerUtxoByte;
    const floor = minAdaFor(valueOf(held - take, 0n), inlineDatum(a.constants, { kind: "opened", subbed: owed }), cpb);
    await accepted(`(built, not submitted) the sub also takes the channel's ADA down to its min-UTxO, ${ada(Assets.lovelaceOf(utxo.assets))} -> ${ada(floor)} tADA`, () => build({ lovelace: floor }));
  }
  const sb = await accepted(`the provider subs exactly what the IOU covers, ${ada(take)} ${unitName}`, () => build({}));
  const txHash = await submit("a-sub", await sb.sign(), provider);

  const r = await readBack(a, txHash);
  expectEq("taken = owed − subbed before", r.valueIn - r.out!.value, take);
  expectEq("stage after sub", show(r.out!.stage), show({ kind: "opened", subbed: owed }));
  expectNet("provider net = taken − fee", r.utxos, Address.toBech32(providerAddr), take, r.fee, 0n);
  record(a, "a-sub", txHash, r);
  save(st);
  log(`a-sub: provider redeemed ${ada(take)} ${unitName} mid-life; the channel stays open with subbed = ${ada(owed)}`);
}

async function aClose() {
  const st = load();
  const a = need(st.a, "a-open");
  if (!a.txs["a-sub"]) throw new Error("run a-sub first");
  if (a.txs["a-close"]) return log(`a-close: already done, ${a.txs["a-close"].txHash}`);
  payUpTo(a, 3_000);
  save(st);
  await close(a, "a-close", true);
  save(st);
}

async function aSettle() {
  const st = load();
  const a = need(st.a, "a-open");
  if (!a.txs["a-close"]) throw new Error("run a-close first");
  if (a.txs["a-settle"]) return log(`a-settle: already done, ${a.txs["a-settle"].txHash}`);
  const providerAddr = await provider.address();
  const utxo = await channelUtxo(a);
  const d = checkChannel(utxo, keyHashHex(providerAddr), a.constants, A.closePeriodMs);
  if (d.stage.kind !== "closed") throw new Error("channel is not closed");
  const elapseAt = d.stage.elapseAt;
  if (nowMs() >= elapseAt) log(`a-settle: past elapse_at ${iso(elapseAt)}; from here a settle races the consumer's elapse`);
  const held = amountOf(utxo.assets);
  const { amount: owed, sig } = a.latest!;
  const take = owed - d.stage.subbed;
  const honest: SettleTx = { by: "provider", owed, sig, keep: held - take, stageOut: { kind: "settled" } };
  const build = (change: Partial<SettleTx>) => settleTx(a, utxo, { ...honest, ...change });

  // The consumer cannot cut the provider's window short…
  await refused("the consumer elapses before elapse_at", () => elapseTx(utxo, "consumer", msOf(slotOf(nowMs()))));
  await refused("the consumer ends the channel before the provider has settled", () => endTx(utxo, "consumer"));
  // …and the provider cannot take more than the consumer signed for.
  await refused("the provider settles 1 lovelace more than owed − subbed", () => build({ keep: held - take - 1n }));
  await refused("the provider settles but leaves the channel closed, free to settle again", () => build({ stageOut: d.stage }));
  const sb = await accepted(`the provider settles exactly owed − subbed = ${ada(take)} ${unitName}`, () => build({}));
  const txHash = await submit("a-settle", await sb.sign(), provider);

  const r = await readBack(a, txHash);
  expectEq("taken = owed − subbed", r.valueIn - r.out!.value, take);
  expectEq("stage after settle", show(r.out!.stage), show({ kind: "settled" }));
  expectNet("provider net = taken − fee", r.utxos, Address.toBech32(providerAddr), take, r.fee, 0n);
  record(a, "a-settle", txHash, r);
  save(st);
  log(`a-settle: the provider got its ${ada(take)} ${unitName} after the consumer's unilateral close, ${(elapseAt - r.blockTimeMs) / 60_000n} min before elapse_at`);
}

async function aEnd() {
  const st = load();
  const a = need(st.a, "a-open");
  if (!a.txs["a-settle"]) throw new Error("run a-settle first");
  if (a.txs["a-end"]) return log(`a-end: already done, ${a.txs["a-end"].txHash}`);
  const consumerAddr = await consumer.address();
  const utxo = await channelUtxo(a);
  if (datumOf(utxo).stage.kind !== "settled") throw new Error("channel is not settled");
  const held = amountOf(utxo.assets);
  const { amount: owed, sig } = a.latest!;

  await refused("the provider settles a second time", () => settleTx(a, utxo, { by: "provider", owed, sig, keep: held - ONE, stageOut: { kind: "settled" } }));
  await refused("the provider ends the channel and takes the rest", () => endTx(utxo, "provider"));
  const sb = await accepted("the consumer ends it", () => endTx(utxo, "consumer"));
  const txHash = await submit("a-end", await sb.sign(), consumer);

  const r = await readBack(a, txHash);
  expectEq("no channel output remains", r.out, undefined);
  expectNet("consumer net = remaining − fee", r.utxos, Address.toBech32(consumerAddr), held, r.fee, r.lovelaceIn);
  record(a, "a-end", txHash, r);
  save(st);
  log(`a-end: the consumer took back the remaining ${ada(held)} ${unitName}`);
}

// ---- B: the provider disappears ------------------------------------------

async function bOpen() {
  const st = load();
  if (st.b) return log(`b-open: already done, ${st.b.txs["b-open"]!.txHash}`);
  st.b = await openChannel("b-open", B.deposit, B.closePeriodMs);
  save(st);
}

async function bClose() {
  const st = load();
  const b = need(st.b, "b-open");
  if (b.txs["b-close"]) return log(`b-close: already done, ${b.txs["b-close"].txHash}`);
  payUpTo(b, 500);
  save(st);
  await close(b, "b-close", false);
  save(st);
  log(`b-close: from here on the provider does nothing`);
}

async function bElapse() {
  const st = load();
  const b = need(st.b, "b-open");
  if (!b.txs["b-close"]) throw new Error("run b-close first");
  if (b.txs["b-elapse"]) return log(`b-elapse: already done, ${b.txs["b-elapse"].txHash}`);
  const consumerAddr = await consumer.address();
  const d = datumOf(await channelUtxo(b));
  if (d.stage.kind !== "closed") throw new Error("channel is not closed");
  const first = slotAtOrAfter(d.stage.elapseAt);
  log(`b-elapse: elapse_at ${iso(d.stage.elapseAt)}, the start of slot ${first}`);
  await waitForSlot(first, "b-elapse");

  const utxo = await channelUtxo(b); // untouched while the provider was away
  const held = amountOf(utxo.assets);
  const { amount: owed, sig } = b.latest!;
  await refused("the consumer elapses one slot before elapse_at", () => elapseTx(utxo, "consumer", msOf(first - 1n)));
  await refused("the provider elapses the channel and takes the funds", () => elapseTx(utxo, "provider", msOf(first)));
  // Not a failure: the validator gives settle no deadline, so after elapse_at the two race.
  await accepted("(built, not submitted) a late settle by the provider after elapse_at", () =>
    settleTx(b, utxo, { by: "provider", owed, sig, keep: held - owed, stageOut: { kind: "settled" } }),
  );
  const sb = await accepted("the consumer elapses from elapse_at, with no provider signature", () => elapseTx(utxo, "consumer", msOf(first)));
  const txHash = await submit("b-elapse", await sb.sign(), consumer);

  const r = await readBack(b, txHash);
  expectEq("lower bound the script saw = elapse_at", r.from, d.stage.elapseAt);
  expectEq("no channel output remains", r.out, undefined);
  expectNet("consumer net = everything − fee", r.utxos, Address.toBech32(consumerAddr), held, r.fee, r.lovelaceIn);
  record(b, "b-elapse", txHash, r);
  save(st);
  log(`b-elapse: the consumer recovered all ${ada(held)} ${unitName} without the provider, whose unredeemed ${ada(owed)} ${unitName} IOU is now void`);
}

async function report() {
  const st = load();
  let total = 0n;
  for (const [name, ch] of [["A", st.a], ["B", st.b]] as const) {
    if (!ch) continue;
    for (const [phase, { txHash, fee }] of Object.entries(ch.txs)) {
      total += fee;
      log(`${name} ${phase.padEnd(9)} ${txHash}  fee ${ada(fee)}`);
    }
  }
  log(`total fees ${ada(total)} tADA`);
}

// ---- steps shared by A and B ----------------------------------------------

async function openChannel(what: string, deposit: bigint, closePeriodMs: bigint): Promise<Channel> {
  const consumerAddr = await consumer.address();
  const providerAddr = await provider.address();
  // The tag must be unique per IOU key; ADR tag.md: hash an input this tx spends. So pin that input.
  const seed = (await consumer.getWalletUtxos())
    .filter((u) => Assets.hasOnlyLovelace(u.assets))
    .sort((x, y) => (Assets.lovelaceOf(y.assets) > Assets.lovelaceOf(x.assets) ? 1 : -1))[0];
  if (!seed) throw new Error("consumer has no ADA-only UTxO to derive the tag from");
  const signer = newIouSigner();
  const constants: Constants = {
    tag: tagFromInput(inputOf(seed)),
    currency,
    iouKey: signer.publicKey,
    consumer: keyHashHex(consumerAddr),
    provider: keyHashHex(providerAddr),
    closePeriodMs,
  };
  // A token channel carries the ADA its largest continuing output needs, and no more (see a-sub).
  const reserve = TOKEN ? channelReserve(chan, constants, (await consumer.getProtocolParameters()).coinsPerUtxoByte) : 0n;
  const sb = await consumer
    .newTx()
    .collectFrom({ inputs: [seed] })
    .payToAddress({ address: chan, assets: valueOf(deposit, reserve), datum: inlineDatum(constants, { kind: "opened", subbed: 0n }) })
    .build({ changeAddress: consumerAddr });
  const txHash = await submit(what, await sb.sign(), consumer);

  const outs = ((await bf(`/txs/${txHash}/utxos`)) as BfUtxos).outputs.filter((o) => o.address === Address.toBech32(chan));
  if (outs.length !== 1) throw new Error(`expected one channel output, found ${outs.length}`);
  const o = outs[0]!;
  expectEq("channel value", amountOfBf(o), deposit);
  if (TOKEN) expectEq("channel ADA = the reserve", lovelaceOfBf(o), reserve);
  expectEq("channel datum", show(parseDatum(Data.fromCBORHex(o.inline_datum!))), show({ ownHash: SUBBIT_HASH, constants, stage: { kind: "opened", subbed: 0n } }));
  const ch: Channel = {
    constants,
    iouPrivateKeyPem: signer.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    at: { txHash, index: o.output_index },
    txs: { [what]: { txHash, fee: BigInt((await bf(`/txs/${txHash}`)).fees) } },
  };
  // The provider's own check, before it serves a single request against the channel.
  checkChannel(await channelUtxo(ch), keyHashHex(providerAddr), constants, closePeriodMs);
  log(`  ok  the provider's checks on the channel pass`);
  log(`${what}: channel ${txHash}#${o.output_index} holds ${ada(deposit)} ${unitName}${TOKEN ? ` and ${ada(reserve)} tADA` : ""}, close period ${closePeriodMs / 60_000n} min`);
  return ch;
}

/** Requests up to `count` in all, PRICE each: the consumer signs every running total, the provider checks each follows the last. */
function payUpTo(ch: Channel, count: number) {
  const key = createPrivateKey(ch.iouPrivateKeyPem);
  const verifyIou = iouVerifier(ch.constants.iouKey);
  const tag = ch.constants.tag;
  let latest: Iou = ch.latest ?? { amount: 0n, sig: "", count: 0 };
  const from = latest.count;
  for (let i = from + 1; i <= count; i++) {
    const amount = BigInt(i) * PRICE;
    const sig = edSign(null, iouBody(tag, amount), key).toString("hex");
    if (amount - latest.amount !== PRICE || !verifyIou(tag, amount, sig)) throw new Error(`IOU ${i} refused`);
    latest = { amount, sig, count: i };
  }
  ch.latest = latest;
  if (count > from) log(`  requests ${from + 1}–${count} paid by IOU; the provider holds one for ${ada(latest.amount)} ${unitName}`);
}

/** The consumer closes alone. With `probe`, first the closes the validator must refuse. */
async function close(ch: Channel, what: string, probe: boolean) {
  const consumerAddr = await consumer.address();
  const utxo = await channelUtxo(ch);
  const d = datumOf(utxo);
  if (d.stage.kind !== "opened") throw new Error("channel is not open");
  const held = amountOf(utxo.assets);
  const period = ch.constants.closePeriodMs;
  // The script sees the start of the TTL slot as the upper bound and wants
  // elapse_at ≥ upper bound + close period. The consumer takes the earliest it allows.
  const to = msOf(slotOf(nowMs()) + CLOSE_TTL_SLOTS);
  const honest: CloseTx = { by: "consumer", to, elapseAt: to + period, keep: held, subbed: d.stage.subbed };
  const build = (change: Partial<CloseTx>) => closeTx(ch, utxo, { ...honest, ...change });

  if (probe) {
    await refused("elapse_at 1 ms short of upper bound + close period", () => build({ elapseAt: to + period - 1n }));
    await refused("no upper bound on the validity range", () => build({ to: undefined }));
    await refused(`the close takes 1 ${unitName} out of the channel`, () => build({ keep: held - ONE }));
    await refused(`the close records subbed = ${ada(ch.latest!.amount)}, all that is owed, voiding the provider's claim`, () =>
      build({ subbed: ch.latest!.amount }),
    );
    await refused("the provider closes, without the consumer's signature", () => build({ by: "provider" }));
  }
  const sb = await accepted("the consumer's honest close", () => build({}));
  const txHash = await submit(what, await sb.sign(), consumer);

  const r = await readBack(ch, txHash);
  expectEq("upper bound the script saw = the TTL asked for", r.to, to);
  expectEq("value unchanged", r.out!.value, held);
  expectEq("stage after close", show(r.out!.stage), show({ kind: "closed", subbed: d.stage.subbed, elapseAt: to + period }));
  expectEq("consumer paid only the fee", netFor(r.utxos, Address.toBech32(consumerAddr)), -r.fee);
  record(ch, what, txHash, r);
  log(`${what}: closed by the consumer alone; elapse_at ${iso(to + period)}, and the provider can settle until then`);
}

// ---- transactions, honest or not ------------------------------------------

type Who = "consumer" | "provider";
const walletOf = (who: Who) => (who === "consumer" ? consumer : provider);

interface SubTx {
  owed: bigint;
  sig: string;
  keep: bigint;
  subbedOut: bigint;
  /** ADA left in a token channel's continuing output; by default all it had. */
  lovelace?: bigint;
  /** One unit of another token, added to the continuing output. */
  extra?: string;
}

async function subTx(ch: Channel, utxo: UTxO.UTxO, o: SubTx) {
  const me = await provider.address();
  return (await withSubbit(provider.newTx()))
    .collectFrom({ inputs: [utxo], redeemer: Redeemer.main([Step.sub(o.owed, o.sig)]) })
    .payToAddress({ address: chan, assets: withExtra(valueOf(o.keep, o.lovelace ?? Assets.lovelaceOf(utxo.assets)), o.extra), datum: inlineDatum(ch.constants, { kind: "opened", subbed: o.subbedOut }) })
    .addSigner({ keyHash: KeyHash.fromHex(keyHashHex(me)) })
    .build({ changeAddress: me });
}

interface CloseTx {
  by: Who;
  to?: bigint;
  elapseAt: bigint;
  keep: bigint;
  subbed: bigint;
}

async function closeTx(ch: Channel, utxo: UTxO.UTxO, o: CloseTx) {
  const w = walletOf(o.by);
  const me = await w.address();
  let tx = (await withSubbit(w.newTx()))
    .collectFrom({ inputs: [utxo], redeemer: Redeemer.main([Step.close()]) })
    .payToAddress({
      address: chan,
      assets: valueOf(o.keep, Assets.lovelaceOf(utxo.assets)),
      datum: inlineDatum(ch.constants, { kind: "closed", subbed: o.subbed, elapseAt: o.elapseAt }),
    })
    .addSigner({ keyHash: KeyHash.fromHex(keyHashHex(me)) });
  if (o.to !== undefined) tx = tx.setValidity({ to: o.to });
  return tx.build({ changeAddress: me });
}

interface SettleTx {
  by: Who;
  owed: bigint;
  sig: string;
  keep: bigint;
  stageOut: Stage;
}

async function settleTx(ch: Channel, utxo: UTxO.UTxO, o: SettleTx) {
  const w = walletOf(o.by);
  const me = await w.address();
  return (await withSubbit(w.newTx()))
    .collectFrom({ inputs: [utxo], redeemer: Redeemer.main([Step.settle(o.owed, o.sig)]) })
    .payToAddress({ address: chan, assets: valueOf(o.keep, Assets.lovelaceOf(utxo.assets)), datum: inlineDatum(ch.constants, o.stageOut) })
    .addSigner({ keyHash: KeyHash.fromHex(keyHashHex(me)) })
    .build({ changeAddress: me });
}

/** End and elapse leave no channel output: everything goes to whoever builds the transaction. */
async function endTx(utxo: UTxO.UTxO, by: Who) {
  const w = walletOf(by);
  const me = await w.address();
  return (await withSubbit(w.newTx()))
    .collectFrom({ inputs: [utxo], redeemer: Redeemer.main([Step.end()]) })
    .addSigner({ keyHash: KeyHash.fromHex(keyHashHex(me)) })
    .build({ changeAddress: me });
}

async function elapseTx(utxo: UTxO.UTxO, by: Who, from: bigint) {
  const w = walletOf(by);
  const me = await w.address();
  return (await withSubbit(w.newTx()))
    .collectFrom({ inputs: [utxo], redeemer: Redeemer.main([Step.elapse()]) })
    .addSigner({ keyHash: KeyHash.fromHex(keyHashHex(me)) })
    .setValidity({ from })
    .build({ changeAddress: me });
}

// ---- reading a step back from the chain -----------------------------------

interface Readback {
  utxos: BfUtxos;
  fee: bigint;
  /** Validity bounds as the script saw them, in Unix ms. */
  from?: bigint;
  to?: bigint;
  blockTimeMs: bigint;
  valueIn: bigint;
  /** The channel input's ADA: all of it for an ADA channel, what rode along for a token one. */
  lovelaceIn: bigint;
  out?: { index: number; value: bigint; stage: Stage };
}

/** Everything a phase asserts comes from here: Blockfrost's view of the confirmed transaction. */
async function readBack(ch: Channel, txHash: string): Promise<Readback> {
  const utxos = (await bf(`/txs/${txHash}/utxos`)) as BfUtxos;
  const tx = await bf(`/txs/${txHash}`);
  const script = Address.toBech32(chan);
  const ins = utxos.inputs.filter((i) => i.address === script && !i.collateral && !i.reference);
  const outs = utxos.outputs.filter((o) => o.address === script && !o.collateral);
  if (ins.length !== 1 || outs.length > 1) throw new Error(`expected 1 channel in and at most 1 out, got ${ins.length}/${outs.length}`);
  expectEq("spent the channel's current output", `${ins[0]!.tx_hash}#${ins[0]!.output_index}`, `${ch.at.txHash}#${ch.at.index}`);
  let out: Readback["out"];
  if (outs[0]) {
    const d = parseDatum(Data.fromCBORHex(outs[0].inline_datum!));
    if (show(d.constants) !== show(ch.constants)) throw new Error("the continuing output changed the channel's constants");
    out = { index: outs[0].output_index, value: amountOfBf(outs[0]), stage: d.stage };
  }
  return {
    utxos,
    fee: BigInt(tx.fees),
    from: tx.invalid_before == null ? undefined : msOf(BigInt(tx.invalid_before)),
    to: tx.invalid_hereafter == null ? undefined : msOf(BigInt(tx.invalid_hereafter)),
    blockTimeMs: BigInt(tx.block_time) * 1_000n,
    valueIn: amountOfBf(ins[0]!),
    lovelaceIn: lovelaceOfBf(ins[0]!),
    out,
  };
}

function record(ch: Channel, what: string, txHash: string, r: Readback) {
  ch.txs[what] = { txHash, fee: r.fee };
  if (r.out) ch.at = { txHash, index: r.out.index };
}

async function channelUtxo(ch: Channel): Promise<UTxO.UTxO> {
  let last: unknown;
  for (let attempt = 0; ; attempt++) {
    const [u] = await provider.getUtxosByOutRef([outRef(ch.at.txHash, ch.at.index)]).catch((e: unknown) => ((last = e), []));
    if (u) return u;
    if (attempt >= 10) throw new Error(`channel output ${ch.at.txHash}#${ch.at.index} not found`, { cause: last });
    await new Promise((res) => setTimeout(res, 3_000)); // indexer lag right after confirmation
  }
}

function datumOf(u: UTxO.UTxO) {
  if (!(u.datumOption instanceof InlineDatum.InlineDatum)) throw new Error("channel datum is not inline");
  return parseDatum(u.datumOption.data);
}

function need<T>(v: T | undefined, phase: string): T {
  if (v === undefined) throw new Error(`run ${phase} first`);
  return v;
}

const show = (v: unknown) => JSON.stringify(v, big);

/**
 * A party's net change from a transaction. For an ADA channel, `amount` less the fee. For a token
 * channel, `amount` in tokens, and in ADA whatever `lovelace` it got back less the fee.
 */
function expectNet(what: string, utxos: BfUtxos, address: string, amount: bigint, fee: bigint, lovelace: bigint) {
  if (!TOKEN) return expectEq(what, netFor(utxos, address), amount - fee);
  expectEq(`${what}, in ${unitName}`, netAmountFor(utxos, address), amount);
  expectEq(`${what}, in tADA`, netFor(utxos, address), lovelace - fee);
}

function netAmountFor(utxos: BfUtxos, address: string): bigint {
  type Flags = { collateral?: boolean; reference?: boolean };
  const spent = utxos.inputs.filter((i) => i.address === address && !(i as Flags).collateral && !(i as Flags).reference);
  const created = utxos.outputs.filter((o) => o.address === address && !(o as Flags).collateral);
  return created.reduce((s, o) => s + amountOfBf(o), 0n) - spent.reduce((s, i) => s + amountOfBf(i), 0n);
}

function withExtra(value: Assets.Assets, unit?: string): Assets.Assets {
  if (!unit) return value;
  const [policy, name] = unit.split(".") as [string, string];
  return Assets.addByHex(value, policy, name, 1n);
}

/** The exact min-UTxO of a channel output holding `value` and `datum`: the fixed point in its own ADA. */
function minAdaFor(value: Assets.Assets, datum: InlineDatum.InlineDatum, coinsPerUtxoByte: bigint): bigint {
  let lovelace = 1_000_000n;
  for (let i = 0; i < 5; i++) {
    const out = new TxOut.TransactionOutput({ address: chan, assets: Assets.withLovelace(value, lovelace), datumOption: datum });
    const need = coinsPerUtxoByte * (160n + BigInt(TxOut.toCBORBytes(out).length));
    if (need === lovelace) break;
    lovelace = need;
  }
  return lovelace;
}

run(main);
