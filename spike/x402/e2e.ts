// Step 4 of the plan, on preprod: x402 `batch-settlement` end to end over Subbit channels
// (DESIGN.md §10). A facilitator (127.0.0.1:7413) and a resource server (127.0.0.1:7411, one
// route priced 1,000 lovelace) run in this process and talk real HTTP; the client is
// @x402/fetch's wrapFetchWithPayment around this binding's client scheme.
//
//   pay [n]     n paid requests (default 200); the first opens the channel
//   claim       the server redeems what it charged, one Sub through the facilitator
//   corrective  the client's count is knocked one request off, both ways; the 402 resyncs it
//   refund [dir]  claim, then the client closes the channel with Mutual (dir: whose channels, default client)
//   batch       10 more channels; claims of N = 10, 5 and 1 channels per transaction
//   batch-refund  close the 10 batch channels with Mutual
//   topup       a channel with room for 10 requests serves 15: a claim after the 5th, a top-up (Add) at the 11th
//   autosettle  the consumer closes a channel alone; the server's watcher settles it; the consumer ends it
//   recover     after losing its records the client finds its channels again: one with a derived
//               IOU key goes on serving; one with a random key can only be closed, settled and ended
//   recover-elapse  both sides lose their records; the consumer closes and, ~20 min on, elapses
//   wallets [label]  how each wallet's UTxOs are split, recorded under the label
//   report      every transaction's fee, and the wallets reconciled
//
// Usage: npm run x402 -- <phase|all>   (`all` is step 4's sequence; topup and autosettle run on their own)
// Env:   WALLET_MNEMONIC (preprod only), BLOCKFROST_PROJECT_ID; SUBBIT_CURRENCY=token prices the
//        route in the sUSDM stand-in (`npm run mint -- mint`) instead of lovelace, state in out/x402-token/;
//        X402_OUT=<name> keeps a run's state in out/<name>/ instead
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { rmSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { x402Facilitator } from "@x402/core/facilitator";
import { HTTPFacilitatorClient, x402HTTPResourceServer, x402ResourceServer, type HTTPAdapter, type RoutesConfig } from "@x402/core/server";
import { decodePaymentRequiredHeader, decodePaymentResponseHeader } from "@x402/core/http";
import type { PaymentRequirements } from "@x402/core/types";
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { Address, Assets, KeyHash } from "@evolution-sdk/evolution";
import { Redeemer, Step, SUBBIT_HASH, inlineDatum, subbitScript, type Stage } from "../../src/subbit.ts";
import { capacityOf, valueFor, type ChannelView } from "../../src/x402/cardano.ts";
import { BlockfrostChain } from "../../src/x402/chain.ts";
import { BatchSettlementCardanoClient, FileClientStorage, collateralTarget, signIou, signedHex, type ClientChannel } from "../../src/x402/client.ts";
import { BatchSettlementCardanoFacilitator } from "../../src/x402/facilitator.ts";
import { ChannelManager, type ClaimResult } from "../../src/x402/manager.ts";
import { BatchSettlementCardanoServer, FileChannelStorage, walletProviderSigner } from "../../src/x402/server.ts";
import { Err, parseExtra, toBase64, type DepositPayload } from "../../src/x402/types.ts";
import { REF_STATE, BF_BASE, ada, bf, consumer, expectEq, iso, keyHashHex, load, log, must, provider, run, save, scriptsFailed } from "../chain.ts";
import { TOKEN, amountOf, onlyCurrency, token, unitName } from "../currency.ts";

const NETWORK = "cardano:preprod" as const;
const PRICE = 1_000n;
const FAC_PORT = 7413;
const RES_PORT = 7411;
const URL_DATA = `http://127.0.0.1:${RES_PORT}/data`;
const OUT = new URL(`../../out/${process.env.X402_OUT ?? (TOKEN ? "x402-token" : "x402")}/`, import.meta.url);
const ASSET = TOKEN ? token!.unit : "lovelace";
const dir = (p: string) => fileURLToPath(new URL(p, OUT));
const RESULTS = new URL("results.json", OUT);

interface Wallets {
  consumer: bigint;
  provider: bigint;
  /** The currency's units, when it is a token. */
  consumerTokens: bigint;
  providerTokens: bigint;
}

interface Results {
  before?: Wallets;
  pay?: { n: number; firstMs: number; restMs: number[]; httpPerRequest: number; deposit: string; channelId: string };
  claims?: Array<{ phase: string; n: number; transaction: string }>;
  corrective?: Array<{ direction: string; httpCalls: number; ok: boolean }>;
  refunds?: Array<{ channelId: string; transaction: string }>;
  deposits?: Array<{ channelId: string; transaction: string }>;
  topUps?: Array<{ channelId: string; transaction: string; ms: number; httpCalls: number; capacityBefore: string; capacityAfter: string }>;
  /** The consumer's own transactions outside x402. */
  exits?: Array<{ what: "close" | "end" | "elapse"; channelId: string; transaction: string }>;
  recoveries?: Array<{ channel: string; channelId: string; status: string; exitOnly: boolean; charged: string; balance: string; httpCalls?: number }>;
  autosettle?: { channelId: string; close: string; settle: string; end: string; closeToSettleSec: number; settleBeforeElapseSec: number; watchIntervalMs: number };
  checks?: Array<{ phase: string; what: string; outcome: string }>;
  /** Wallet housekeeping during the run (a `mint -- tidy`), so the report counts its fee. */
  other?: Array<{ what: string; transaction: string }>;
  shapes?: Array<{ at: string; consumer: Shape; provider: Shape }>;
}

/** A wallet's UTxOs: the ADA-only ones (collateral comes from the largest), those holding the currency, those holding other tokens. */
interface Shape {
  adaOnly: number;
  largestAdaOnly: bigint;
  withCurrency: number;
  withOther: number;
}

/** Loads the results, applies `f`, saves: phases that call other phases never write over each other. */
function record(f: (r: Results) => void) {
  const r = load<Results>(RESULTS);
  f(r);
  save(RESULTS, r);
}

const chain = new BlockfrostChain(NETWORK, BF_BASE, must("BLOCKFROST_PROJECT_ID"));
const spentInputs = new Map<string, number>();

async function stack() {
  const providerAddr = await provider.address();
  const payTo = Address.toBech32(providerAddr);
  const providerKeyHash = keyHashHex(providerAddr);
  const ref = load<{ out?: { txHash: string; index: number } }>(REF_STATE).out;
  const referenceScript = ref ? `${ref.txHash}#${ref.index}` : undefined;

  // Facilitator: no key, broadcast only.
  const facilitator = new x402Facilitator().register(NETWORK, new BatchSettlementCardanoFacilitator(chain, { scriptHash: SUBBIT_HASH, confirmationTimeoutMs: 120_000 }));
  const facServer = await listen(FAC_PORT, async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method === "GET" && url.pathname === "/supported") return json(res, 200, facilitator.getSupported());
    if (req.method === "POST" && (url.pathname === "/verify" || url.pathname === "/settle")) {
      const { paymentPayload, paymentRequirements } = JSON.parse((await body(req)) || "{}");
      const out = url.pathname === "/verify" ? await facilitator.verify(paymentPayload, paymentRequirements) : await facilitator.settle(paymentPayload, paymentRequirements);
      if ((out as { isValid?: boolean; success?: boolean }).isValid === false || (out as { success?: boolean }).success === false) {
        log(`  facilitator ${url.pathname}: ${JSON.stringify(out).slice(0, 300)}`);
      }
      return json(res, 200, out);
    }
    json(res, 404, { error: "not found" });
  });

  // Resource server: the provider key signs refunds here; the manager redeems.
  const facilitatorClient = new HTTPFacilitatorClient({ url: `http://127.0.0.1:${FAC_PORT}`, timeoutMs: 300_000 });
  const storage = new FileChannelStorage(dir("server"));
  const scheme = new BatchSettlementCardanoServer({
    payTo,
    receiverAuthorizer: providerKeyHash,
    scriptHash: SUBBIT_HASH,
    ...(referenceScript ? { referenceScript } : {}),
    withdrawDelay: 900,
    storage,
    signAsProvider: walletProviderSigner(provider),
    chain,
    ...(TOKEN ? { assetDecimals: { [ASSET]: token!.decimals } } : {}),
  });
  const resource = new x402ResourceServer(facilitatorClient).register(NETWORK, scheme);
  const routes: RoutesConfig = {
    "GET /data": {
      accepts: { scheme: "batch-settlement", network: NETWORK, payTo, price: { asset: ASSET, amount: PRICE.toString() }, maxTimeoutSeconds: 300, extra: {} },
      description: `one datum for 0.001 ${unitName}`,
    },
  };
  const http = new x402HTTPResourceServer(resource, routes);
  await http.initialize();
  let served = 0;
  const resServer = await listen(RES_PORT, async (req, res) => {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${RES_PORT}`);
    if (url.pathname !== "/data") return json(res, 404, { error: "not found" });
    await body(req);
    const context = { adapter: adapter(req, url), path: url.pathname, method: req.method ?? "GET" };
    const result = await http.processHTTPRequest(context);
    if (result.type === "no-payment-required") return json(res, 200, { n: ++served });
    if (result.type === "payment-error") {
      const r = result.response;
      return send(res, r.status, r.headers, r.body ?? {});
    }
    const payload = JSON.stringify({ n: ++served, at: new Date().toISOString() });
    const settle = await http.processSettlement(result.paymentPayload, result.paymentRequirements, result.declaredExtensions, { request: context, responseBody: Buffer.from(payload) }, undefined, result.beforeHandlerSettlement);
    if (!settle.success) {
      log(`  resource: settlement failed ${settle.errorReason} ${settle.errorMessage ?? ""}`);
      return send(res, settle.response.status, { ...settle.headers, ...settle.response.headers }, settle.response.body ?? {});
    }
    send(res, 200, settle.headers, payload);
  });

  const manager = new ChannelManager({ storage, wallet: provider, providerKeyHash, chain, facilitator: facilitatorClient, network: NETWORK, payTo, scriptHash: SUBBIT_HASH, ...(referenceScript ? { referenceScript } : {}) });
  return {
    payTo,
    storage,
    manager,
    facilitator,
    close: async () => {
      await new Promise((r) => facServer.close(r));
      await new Promise((r) => resServer.close(r));
    },
  };
}

type Stack = Awaited<ReturnType<typeof stack>>;

/** A paying client with its own channel store, counting the HTTP calls it makes. */
function payer(storageDir: string, capacity: bigint, spent = spentInputs, iouKeys: "derived" | "random" = "derived") {
  const storage = new FileClientStorage(dir(storageDir));
  const scheme = new BatchSettlementCardanoClient({ wallet: consumer, storage, chain, capacity, maxDeposit: 20_000_000n, spentInputs: spent, iouKeys });
  const client = x402Client.fromConfig({ schemes: [{ network: "cardano:*", client: scheme }], spendControls: false });
  let calls = 0;
  const counting: typeof fetch = (input, init) => {
    calls++;
    return fetch(input, init);
  };
  return { storage, scheme, pay: wrapFetchWithPayment(counting, client), calls: () => calls, reset: () => (calls = 0) };
}

async function paid(p: ReturnType<typeof payer>) {
  const res = await p.pay(URL_DATA);
  const header = res.headers.get("PAYMENT-RESPONSE");
  const text = await res.text();
  if (res.status !== 200 || !header) throw new Error(`paid request failed: ${res.status} ${text.slice(0, 300)}`);
  return decodePaymentResponseHeader(header);
}

// ---- phases -----------------------------------------------------------------

async function phasePay(s: Stack, n: number) {
  const r = load<Results>(RESULTS);
  const p = payer("client", 3_000_000n);
  if (!r.before) r.before = await walletsAda();
  const restMs: number[] = [];
  let firstMs = 0;
  let deposit = "";
  let channelId = "";
  for (let i = 1; i <= n; i++) {
    p.reset();
    const t0 = performance.now();
    const settle = await paid(p);
    const ms = performance.now() - t0;
    const state = settle.extra?.channelState as { channelId: string } | undefined;
    if (i === 1) {
      firstMs = ms;
      deposit = settle.transaction;
      channelId = state?.channelId ?? "";
      log(`pay: request 1 opened channel ${channelId.slice(0, 16)}… in ${settle.transaction} (${(ms / 1000).toFixed(1)} s, ${p.calls()} HTTP calls)`);
      (r.deposits ??= []).push({ channelId, transaction: settle.transaction });
    } else {
      restMs.push(ms);
      if (settle.transaction !== "") throw new Error(`request ${i} settled on chain: ${settle.transaction}`);
    }
    if (i % 50 === 0) log(`pay: ${i} requests, charged ${(settle.extra?.channelState as { chargedCumulativeAmount?: string })?.chargedCumulativeAmount}`);
  }
  const httpPerRequest = p.calls();
  r.pay = { n, firstMs, restMs, httpPerRequest, deposit, channelId };
  save(RESULTS, r);
  const sorted = [...restMs].sort((a, b) => a - b);
  log(`pay: ${n} requests; first ${(firstMs / 1000).toFixed(1)} s; the other ${restMs.length}: median ${q(sorted, 0.5)} ms, p90 ${q(sorted, 0.9)} ms, max ${q(sorted, 1)} ms; ${httpPerRequest} HTTP calls per request`);
  const ch = await s.storage.get(channelId);
  log(`pay: server count ${ch?.chargedCumulativeAmount}, channel ${ch?.channelRef}`);
}

async function phaseClaim(s: Stack, label = "claim", opts: { channelIds?: string[]; maxPerTx?: number } = {}): Promise<ClaimResult[]> {
  const r = load<Results>(RESULTS);
  const results = await s.manager.claim(opts);
  for (const c of results) {
    const fee = BigInt((await bf(`/txs/${c.transaction}`)).fees);
    const taken = c.channels.reduce((x, y) => x + y.taken, 0n);
    log(`${label}: ${c.transaction} redeems ${c.channels.length} channel(s), ${ada(taken)} ${unitName}, fee ${ada(fee)} tADA`);
    (r.claims ??= []).push({ phase: label, n: c.channels.length, transaction: c.transaction });
  }
  if (results.length === 0) log(`${label}: nothing to claim`);
  save(RESULTS, r);
  return results;
}

async function phaseCorrective(s: Stack) {
  const r = load<Results>(RESULTS);
  const p = payer("client", 3_000_000n);
  const out: NonNullable<Results["corrective"]> = [];
  for (const [direction, delta] of [["client one request behind", -PRICE], ["client one request ahead", PRICE]] as const) {
    const [ch] = (await p.storage.list()).filter((c) => c.status === "open");
    if (!ch) throw new Error("no open channel: run pay first");
    await p.storage.set({ ...ch, chargedCumulativeAmount: (BigInt(ch.chargedCumulativeAmount) + delta).toString() });
    p.reset();
    const settle = await paid(p);
    const after = (await p.storage.get(ch.channelId))!;
    const server = await s.storage.get(ch.channelId);
    const ok = settle.success && after.chargedCumulativeAmount === server?.chargedCumulativeAmount;
    out.push({ direction, httpCalls: p.calls(), ok });
    log(`corrective: ${direction}: ${p.calls()} HTTP calls, counts now client ${after.chargedCumulativeAmount} / server ${server?.chargedCumulativeAmount} ${ok ? "(in step)" : "(MISMATCH)"}`);
    if (!ok) throw new Error("counts did not resync");
  }
  r.corrective = out;
  save(RESULTS, r);
}

async function phaseRefund(s: Stack, storageDir = "client") {
  const p = payer(storageDir, 3_000_000n);
  for (const ch of (await p.storage.list()).filter((c) => c.status === "open")) {
    await phaseClaim(s, "claim before refund", { channelIds: [ch.channelId] });
    const settle = await p.scheme.refund(URL_DATA, fetch, ch.channelId);
    log(`refund: ${ch.channelId.slice(0, 16)}… closed by ${settle.transaction}, ${ada(BigInt(settle.amount || "0"))} ${unitName} back to the consumer`);
    const r = load<Results>(RESULTS); // after the claim, which saved its own entry
    (r.refunds ??= []).push({ channelId: ch.channelId, transaction: settle.transaction });
    save(RESULTS, r);
  }
}

async function phaseBatch(s: Stack) {
  const r = load<Results>(RESULTS);
  const K = 10;
  const clients = Array.from({ length: K }, (_, i) => payer(`batch/${i}`, 100_000n));
  for (const [i, p] of clients.entries()) {
    if ((await p.storage.list()).some((c) => c.status === "open")) continue;
    const settle = await paid(p);
    const id = (settle.extra?.channelState as { channelId: string }).channelId;
    (r.deposits ??= []).push({ channelId: id, transaction: settle.transaction });
    save(RESULTS, r);
    log(`batch: channel ${i + 1}/${K} ${id.slice(0, 16)}… opened by ${settle.transaction}`);
  }
  const ids = async () => (await Promise.all(clients.map(async (p) => (await p.storage.list()).find((c) => c.status === "open")!))).map((c: ClientChannel) => c.channelId);
  const round = async (label: string, maxPerTx: number, only?: number) => {
    for (const p of clients) await paid(p);
    const all = await ids();
    return phaseClaim(s, label, { channelIds: only ? all.slice(0, only) : all, maxPerTx });
  };
  await round("batch N=10", 10);
  await round("batch N=5", 5);
  await round("batch N=1", 1, 1);
  await phaseClaim(s, "batch cleanup", { channelIds: await ids(), maxPerTx: 10 });
}

async function phaseBatchRefund(s: Stack) {
  for (let i = 0; i < 10; i++) await phaseRefund(s, `batch/${i}`);
}

// ---- step 6: top-ups, and the consumer's own exit ---------------------------------------

/**
 * A channel with room for 10 requests serves 15. After the 5th the server claims, so the top-up
 * comes after a redemption: request 11 finds the channel short and tops it up with `Add`, on the
 * same channel id. Just before, `topUpChecks` has the facilitator look at that top-up without
 * sending it. Then the server claims and the client takes the rest back.
 */
async function phaseTopUp(s: Stack) {
  const before = await walletsAda();
  record((r) => (r.before ??= before));
  const p = payer("topup", 10n * PRICE);
  let channelId = (await p.storage.list()).find((c) => c.status === "open")?.channelId ?? "";
  let topUps = 0;
  for (let i = 1; i <= 15; i++) {
    const was = channelId ? await p.storage.get(channelId) : undefined;
    const short = was !== undefined && BigInt(was.chargedCumulativeAmount) + PRICE > BigInt(was.balance);
    if (short) await topUpChecks(s, was);
    p.reset();
    const t0 = performance.now();
    const settle = await paid(p);
    const ms = performance.now() - t0;
    const state = settle.extra?.channelState as { channelId: string } | undefined;
    if (!was) {
      channelId = state?.channelId ?? "";
      const opened = (await p.storage.get(channelId))!;
      record((r) => (r.deposits ??= []).push({ channelId, transaction: settle.transaction }));
      log(`topup: request ${i} opened channel ${channelId.slice(0, 16)}… in ${settle.transaction}, room for ${BigInt(opened.balance) / PRICE} requests`);
    } else if (short) {
      if (!settle.transaction) throw new Error(`request ${i} should have topped the channel up`);
      expectEq("the top-up keeps the channel id", state?.channelId, channelId);
      const now = (await p.storage.get(channelId))!;
      const server = (await s.storage.get(channelId))!;
      const view = (await chain.followChannel(server.channelRef, SUBBIT_HASH, channelId))!;
      expectEq("the channel now sits at the top-up's output", server.channelRef.split("#")[0], settle.transaction);
      expectEq("client and server agree on the new capacity", now.balance, server.balance);
      expectEq("the capacity grew by the deposit", BigInt(now.balance) - BigInt(was.balance), BigInt(now.deposit) - BigInt(was.deposit));
      expectEq("the chain agrees on the capacity", capacityOf(view, await chain.coinsPerUtxoByte()).toString(), now.balance);
      topUps++;
      record((r) =>
        (r.topUps ??= []).push({ channelId, transaction: settle.transaction, ms, httpCalls: p.calls(), capacityBefore: was.balance, capacityAfter: now.balance }),
      );
      log(`topup: request ${i} topped channel ${channelId.slice(0, 16)}… up in ${settle.transaction} (${(ms / 1000).toFixed(1)} s, ${p.calls()} HTTP calls): room for ${BigInt(was.balance) / PRICE} → ${BigInt(now.balance) / PRICE} requests`);
    } else if (settle.transaction !== "") throw new Error(`request ${i} settled on chain: ${settle.transaction}`);
    if (i === 5) await phaseClaim(s, "claim before top-up", { channelIds: [channelId] });
  }
  const client = (await p.storage.get(channelId))!;
  const server = (await s.storage.get(channelId))!;
  expectEq("client and server count the same 15 requests", client.chargedCumulativeAmount, server.chargedCumulativeAmount);
  log(`topup: 15 requests on one channel with ${topUps} top-up; charged ${ada(BigInt(server.chargedCumulativeAmount))} ${unitName}`);
  await phaseRefund(s, "topup");
}

/**
 * Before the first top-up goes out: a second client on the same records builds it without
 * sending it, and the facilitator is asked about it (verify only, nothing is submitted). It
 * accepts the top-up as built; refuses it with the deposit declared one unit high, or with the
 * voucher one unit past the capacity the top-up makes; and a top-up whose datum records one
 * unit more as redeemed is refused, by the validator if the evaluator says so, else by the
 * facilitator's own datum rule.
 */
async function topUpChecks(s: Stack, ch: ClientChannel) {
  // Its own spent-input list: what it builds is never sent, so the real top-up may reuse those inputs.
  const probe = payer("topup", 10n * PRICE, new Map());
  const req = await requirements();
  const made = (await probe.scheme.createPaymentPayload(2, req)).payload as unknown as DepositPayload;
  if (made.type !== "deposit" || !made.voucher.channelRef) throw new Error("expected a top-up");
  const verify = (pl: DepositPayload) => s.facilitator.verify({ x402Version: 2, accepted: req, payload: pl as unknown as Record<string, unknown> }, req);
  const note = (what: string, outcome: string) => {
    log(`  ok  ${outcome}: ${what}`);
    record((r) => (r.checks ??= []).push({ phase: "topup", what, outcome }));
  };
  const control = await verify(made);
  if (!control.isValid) throw new Error(`the facilitator refused the top-up as built: ${control.invalidReason} ${control.invalidMessage ?? ""}`);
  const add = BigInt(made.deposit.amount);
  const after = BigInt(ch.balance) + add;
  note(`the top-up as the client built it: Main([Add]), ${ada(add)} ${unitName} more, voucher for request ${BigInt(made.voucher.maxClaimableAmount) / PRICE}`, "accepted");
  const refusedFor = async (what: string, pl: DepositPayload, reason: string) => {
    const v = await verify(pl);
    if (v.isValid) throw new Error(`${what}: the facilitator accepted it`);
    if (v.invalidReason !== reason) throw new Error(`${what}: refused as ${v.invalidReason} (${v.invalidMessage ?? ""}), expected ${reason}`);
    note(what, `refused, ${reason.replace("invalid_batch_settlement_cardano_", "")}`);
  };
  await refusedFor(`the deposit declares ${ada(add + 1n)}, one unit more than the transaction adds`, { ...made, deposit: { ...made.deposit, amount: (add + 1n).toString() } }, Err.depositTransaction);
  await refusedFor(
    `the voucher is for ${ada(after + 1n)}, one unit past the ${ada(after)} the top-up makes room for`,
    { ...made, voucher: { ...made.voucher, maxClaimableAmount: (after + 1n).toString(), signature: signIou(ch, after + 1n) } },
    Err.cumulativeExceedsBalance,
  );
  const view = (await chain.followChannel(made.voucher.channelRef, SUBBIT_HASH, ch.channelId))!;
  if (view.datum.stage.kind !== "opened") throw new Error("the channel is not open");
  const what = `a top-up whose datum records subbed = ${view.datum.stage.subbed + 1n}, one unit more than the channel's`;
  let hex: string | undefined;
  try {
    hex = await buildTopUp(view, add, { kind: "opened", subbed: view.datum.stage.subbed + 1n }, parseExtra(req).referenceScript);
  } catch (e) {
    if (!scriptsFailed(e)) throw e;
  }
  if (hex === undefined) note(what, "refused by the validator");
  else await refusedFor(`${what} (the validator accepts it)`, { ...made, deposit: { ...made.deposit, transaction: toBase64(hex) } }, Err.depositTransaction);
}

/** The consumer's `Main([Add])` on `view` with a datum of the caller's choosing; built and signed, not sent. */
async function buildTopUp(view: ChannelView, add: bigint, stage: Stage, referenceScript?: string): Promise<string> {
  const me = await consumer.address();
  let tx = consumer.newTx().collectFrom({ inputs: [view.utxo], redeemer: Redeemer.main([Step.add()]) });
  const ref = referenceScript ? await chain.getUnspent(referenceScript) : undefined;
  tx = ref?.scriptRef ? tx.readFrom({ referenceInputs: [ref] }) : tx.attachScript({ script: subbitScript });
  tx = tx
    .payToAddress({ address: view.address, assets: valueFor(view.datum.constants.currency, view.amount + add, view.lovelace), datum: inlineDatum(view.datum.constants, stage) })
    .addSigner({ keyHash: KeyHash.fromHex(keyHashHex(me)) });
  const all = await consumer.getWalletUtxos();
  const adaOnly = all.filter((u) => Assets.hasOnlyLovelace(u.assets));
  return signedHex(await tx.build({ changeAddress: me, availableUtxos: all, setCollateral: collateralTarget(adaOnly) }));
}

/**
 * The consumer closes a channel alone, outside x402 (`Main([Close])`). The server's watcher
 * sees the close on a later pass, refuses the channel's vouchers from then on, and settles the
 * latest one (`Main([Settle])`) long before elapse_at; the consumer then ends the channel
 * (`Main([End])`) and takes the rest back.
 */
async function phaseAutoSettle(s: Stack) {
  const before = await walletsAda();
  record((r) => (r.before ??= before));
  const p = payer("autosettle", 20n * PRICE);
  let ch = (await p.storage.list()).find((c) => c.status === "open" || c.status === "closing");
  if (!ch) {
    for (let i = 1; i <= 12; i++) {
      const settle = await paid(p);
      if (i > 1) continue;
      const id = (settle.extra?.channelState as { channelId: string }).channelId;
      record((r) => (r.deposits ??= []).push({ channelId: id, transaction: settle.transaction }));
      log(`autosettle: request 1 opened channel ${id.slice(0, 16)}… in ${settle.transaction}`);
    }
    ch = (await p.storage.list()).find((c) => c.status === "open")!;
    log(`autosettle: 12 requests paid, ${ada(BigInt(ch.chargedCumulativeAmount))} ${unitName} charged, none of it claimed`);
  }
  const channelId = ch.channelId;
  const charged = BigInt(ch.chargedCumulativeAmount);
  const intervalMs = 15_000;
  const got: { settled?: ClaimResult } = {};
  const watcher = s.manager.watch({
    intervalMs,
    onEvent: (e) => {
      if (e.kind === "closed") log(`autosettle: watcher: ${e.channelId.slice(0, 16)}… closed by its consumer, elapse_at ${iso(e.elapseAt)}; its vouchers are refused from here on`);
      else if (e.kind === "settled") {
        for (const x of e.results) log(`autosettle: watcher: settled ${x.channels.length} channel(s) in ${x.transaction}`);
        got.settled ??= e.results.find((x) => x.channels.some((c) => c.channelId === channelId));
      } else if (e.kind === "gone") log(`autosettle: watcher: ${e.channelId.slice(0, 16)}… needs nothing more from the server; record dropped`);
      else log(`autosettle: watcher: a pass failed, the next one retries: ${String((e.error as Error)?.message ?? e.error).slice(0, 240)}`);
    },
  });
  let close: string;
  let elapseAt: bigint;
  try {
    if (ch.status === "open") {
      ({ transaction: close, elapseAt } = await p.scheme.close(channelId));
      record((r) => (r.exits ??= []).push({ what: "close", channelId, transaction: close }));
    } else {
      close = load<Results>(RESULTS).exits?.find((x) => x.channelId === channelId && x.what === "close")?.transaction ?? "";
      elapseAt = BigInt(ch.elapseAt!);
    }
    log(`autosettle: the consumer closed ${channelId.slice(0, 16)}… alone in ${close}; elapse_at ${iso(elapseAt)}`);
    const deadline = Date.now() + 12 * 60_000;
    while (!got.settled && Date.now() < deadline) await new Promise((res) => setTimeout(res, 3_000));
  } finally {
    watcher.stop();
  }
  if (!got.settled) throw new Error("the watcher did not settle the channel within 12 minutes");
  const settle = got.settled.transaction;
  const row = got.settled.channels.find((c) => c.channelId === channelId)!;
  record((r) => (r.claims ??= []).push({ phase: "auto-settle", n: got.settled!.channels.length, transaction: settle }));
  const [ct, st] = [await bf(`/txs/${close}`), await bf(`/txs/${settle}`)];
  const closeToSettleSec = Number(st.block_time) - Number(ct.block_time);
  const settleBeforeElapseSec = Number(elapseAt / 1000n) - Number(st.block_time);
  expectEq("the settle took everything charged", row.taken, charged);
  expectEq("the server dropped its record", await s.storage.get(channelId), undefined);
  const { view } = await p.scheme.openView(channelId);
  expectEq("the channel is settled on chain", view.datum.stage.kind, "settled");
  log(`autosettle: the settle landed ${closeToSettleSec} s after the close, ${(settleBeforeElapseSec / 60).toFixed(1)} min before elapse_at; it took ${ada(row.taken)} ${unitName}`);
  const end = await p.scheme.end(channelId);
  record((r) => {
    (r.exits ??= []).push({ what: "end", channelId, transaction: end });
    r.autosettle = { channelId, close, settle, end, closeToSettleSec, settleBeforeElapseSec, watchIntervalMs: intervalMs };
  });
  log(`autosettle: the consumer ended ${channelId.slice(0, 16)}… in ${end}: ${ada(view.amount)} ${unitName}${TOKEN ? ` and ${ada(view.lovelace)} tADA` : ""} back`);
}

async function phaseWallets(label: string) {
  const one = async (w: typeof consumer): Promise<Shape> => {
    const us = await w.getWalletUtxos();
    const ada_ = us.filter((u) => Assets.hasOnlyLovelace(u.assets));
    const mine = us.filter((u) => !Assets.hasOnlyLovelace(u.assets) && TOKEN && onlyCurrency(u.assets));
    return {
      adaOnly: ada_.length,
      largestAdaOnly: ada_.reduce((m, u) => (Assets.lovelaceOf(u.assets) > m ? Assets.lovelaceOf(u.assets) : m), 0n),
      withCurrency: mine.length,
      withOther: us.length - ada_.length - mine.length,
    };
  };
  const shape = { consumer: await one(consumer), provider: await one(provider) };
  record((r) => (r.shapes ??= []).push({ at: label, ...shape }));
  const fmt = (x: Shape) => `${x.adaOnly} ADA-only (largest ${ada(x.largestAdaOnly)}), ${x.withCurrency} holding ${unitName}, ${x.withOther} holding other tokens`;
  log(`wallets, ${label}: consumer ${fmt(shape.consumer)}; provider ${fmt(shape.provider)}`);
}

// ---- step 8: after losing the records -------------------------------------------------

/** Opens a channel for `storageDir` and pays `n` requests on it, claiming after the `claimAt`-th. */
async function payRun(s: Stack, p: ReturnType<typeof payer>, label: string, n: number, claimAt?: number): Promise<string> {
  let id = "";
  for (let i = 1; i <= n; i++) {
    const settle = await paid(p);
    if (i === 1) {
      id = (settle.extra?.channelState as { channelId: string }).channelId;
      record((r) => (r.deposits ??= []).push({ channelId: id, transaction: settle.transaction }));
      log(`${label}: request 1 opened channel ${id.slice(0, 16)}… in ${settle.transaction}`);
    }
    if (i === claimAt) await phaseClaim(s, `${label}: claim`, { channelIds: [id] });
  }
  return id;
}

/** Deletes a client's records, then has a fresh client with no records find its channels on chain. */
async function loseAndRecover(label: string, storageDir: string, channelId: string) {
  rmSync(dir(storageDir), { recursive: true, force: true });
  log(`${label}: the client's records are gone`);
  const p = payer(storageDir, 20n * PRICE);
  const found = await p.scheme.recover(NETWORK, SUBBIT_HASH);
  for (const c of found) {
    log(`${label}: recovered ${c.channelId.slice(0, 16)}… ${c.status}${c.exitOnly ? ", exit-only (its IOU key does not derive from this wallet)" : ", IOU key derived again"}; count ${c.chargedCumulativeAmount} from the chain, room for ${BigInt(c.balance) / PRICE} requests`);
  }
  const mine = found.find((c) => c.channelId === channelId);
  if (!mine) throw new Error(`${label}: channel ${channelId.slice(0, 16)}… not recovered`);
  record((r) =>
    (r.recoveries ??= []).push({ channel: label, channelId, status: mine.status, exitOnly: Boolean(mine.exitOnly), charged: mine.chargedCumulativeAmount, balance: mine.balance }),
  );
  return { p, mine };
}

/**
 * A: a channel with a derived IOU key serves 12 requests, the first 8 claimed, and the client
 * loses its records. `recover` finds the channel on chain and derives its key again; the next
 * request binds it to the server, and the corrective 402 brings the server's count back, proved by
 * a voucher of that key. The channel serves on until a refund closes it.
 * B: a channel with a random IOU key serves 6 requests, and the client loses its records. It comes
 * back exit-only: the consumer closes it, the server's watcher settles it, the consumer ends it.
 */
async function phaseRecover(s: Stack) {
  const before = await walletsAda();
  record((r) => (r.before ??= before));

  const aId = await payRun(s, payer("recover-a", 20n * PRICE), "recover A", 12, 8);
  const held = (await s.storage.get(aId))!;
  log(`recover A: 12 requests, 8 claimed; the server counts ${held.chargedCumulativeAmount}`);
  const { p: a, mine: ra } = await loseAndRecover("recover A", "recover-a", aId);
  expectEq("A comes back usable", Boolean(ra.exitOnly), false);
  a.reset();
  await paid(a);
  const calls = a.calls();
  const [client, server] = [(await a.storage.get(aId))!, (await s.storage.get(aId))!];
  log(`recover A: the next request bound the channel and took ${calls} HTTP calls (a corrective 402); counts client ${client.chargedCumulativeAmount} / server ${server.chargedCumulativeAmount}`);
  expectEq("client and server count the same 13 requests", client.chargedCumulativeAmount, server.chargedCumulativeAmount);
  record((r) => {
    const x = r.recoveries!.find((y) => y.channelId === aId)!;
    x.httpCalls = calls;
  });
  for (let i = 0; i < 2; i++) await paid(a);
  await phaseRefund(s, "recover-a");

  const bId = await payRun(s, payer("recover-b", 20n * PRICE, spentInputs, "random"), "recover B", 6);
  const { p: b, mine: rb } = await loseAndRecover("recover B", "recover-b", bId);
  expectEq("B comes back exit-only", Boolean(rb.exitOnly), true);
  const got: { settled?: ClaimResult } = {};
  const watcher = s.manager.watch({
    intervalMs: 15_000,
    onEvent: (e) => {
      if (e.kind === "settled") got.settled ??= e.results.find((x) => x.channels.some((c) => c.channelId === bId));
      if (e.kind === "error") log(`recover B: watcher: a pass failed, the next one retries: ${String((e.error as Error)?.message ?? e.error).slice(0, 240)}`);
    },
  });
  try {
    const { transaction: close } = await b.scheme.close(bId);
    record((r) => (r.exits ??= []).push({ what: "close", channelId: bId, transaction: close }));
    log(`recover B: the consumer closed it in ${close}`);
    const deadline = Date.now() + 12 * 60_000;
    while (!got.settled && Date.now() < deadline) await new Promise((res) => setTimeout(res, 3_000));
  } finally {
    watcher.stop();
  }
  if (!got.settled) throw new Error("recover B: the watcher did not settle the channel within 12 minutes");
  const settleTx = got.settled.transaction;
  record((r) => (r.claims ??= []).push({ phase: "recover B: settle", n: got.settled!.channels.length, transaction: settleTx }));
  log(`recover B: the server settled it in ${settleTx}, taking ${ada(got.settled.channels.find((c) => c.channelId === bId)!.taken)} ${unitName}`);
  const end = await b.scheme.end(bId);
  record((r) => (r.exits ??= []).push({ what: "end", channelId: bId, transaction: end }));
  log(`recover B: the consumer ended it in ${end}`);
}

/**
 * C: a channel serves 3 requests, and then both sides lose their records, as when the server is
 * gone. The client recovers the channel, closes it, and once `elapse_at` has passed takes
 * everything back with `elapse`, which needs nothing from the server. The close period is the
 * binding's minimum, 900 s, so this takes about 20 minutes.
 */
async function phaseRecoverElapse(s: Stack) {
  const before = await walletsAda();
  record((r) => (r.before ??= before));
  const cId = await payRun(s, payer("recover-c", 20n * PRICE), "recover C", 3);
  await s.storage.updateChannel(cId, () => undefined);
  log("recover C: the server's record is gone");
  const { p: c } = await loseAndRecover("recover C", "recover-c", cId);
  const { transaction: close, elapseAt } = await c.scheme.close(cId);
  record((r) => (r.exits ??= []).push({ what: "close", channelId: cId, transaction: close }));
  log(`recover C: the consumer closed it in ${close}; elapse_at ${iso(elapseAt)}`);
  const { view } = await c.scheme.openView(cId);
  const elapse = await c.scheme.elapse(cId);
  record((r) => (r.exits ??= []).push({ what: "elapse", channelId: cId, transaction: elapse }));
  const t = await bf(`/txs/${elapse}`);
  log(`recover C: the consumer elapsed it in ${elapse}, in a block ${Number(t.block_time) - Number(elapseAt / 1000n)} s after elapse_at: all ${ada(view.amount)} ${unitName}${TOKEN ? ` and ${ada(view.lovelace)} tADA` : ""} back, the 3 requests never redeemed`);
}

/** The route's payment requirements, as its 402 states them. */
async function requirements(): Promise<PaymentRequirements> {
  const res = await fetch(URL_DATA);
  await res.text();
  if (res.status !== 402) throw new Error(`expected a 402, got ${res.status}`);
  const accept = decodePaymentRequiredHeader(res.headers.get("PAYMENT-REQUIRED") ?? "").accepts.find((a) => a.scheme === "batch-settlement");
  if (!accept) throw new Error("no batch-settlement option");
  return accept;
}

async function phaseReport() {
  const r = load<Results>(RESULTS);
  const txs = [
    ...(r.deposits ?? []).map((d) => ["deposit", d.transaction] as const),
    ...(r.topUps ?? []).map((t) => ["top-up", t.transaction] as const),
    ...(r.claims ?? []).map((c) => [`${c.phase} (${c.n})`, c.transaction] as const),
    ...(r.refunds ?? []).map((f) => ["refund", f.transaction] as const),
    ...(r.exits ?? []).map((x) => [x.what, x.transaction] as const),
    ...(r.other ?? []).map((x) => [x.what, x.transaction] as const),
  ];
  let fees = 0n;
  for (const [what, hash] of txs) {
    const tx = await bf(`/txs/${hash}`);
    fees += BigInt(tx.fees);
    const reds = (await bf(`/txs/${hash}/redeemers`)) as Array<{ unit_mem: string; unit_steps: string }>;
    const mem = reds.reduce((a, x) => a + BigInt(x.unit_mem), 0n);
    const steps = reds.reduce((a, x) => a + BigInt(x.unit_steps), 0n);
    log(`${what.padEnd(22)} ${hash}  ${String(tx.size).padStart(6)} B  fee ${ada(BigInt(tx.fees))}  mem ${mem}  steps ${steps}`);
  }
  const now = await settledWallets();
  const open = await openChannelValue();
  const b = r.before!;
  log(`consumer ${ada(b.consumer)} → ${ada(now.consumer)}; provider ${ada(b.provider)} → ${ada(now.provider)} tADA; still in open channels ${ada(open.lovelace)} tADA`);
  const lost = b.consumer + b.provider - now.consumer - now.provider - open.lovelace;
  log(`${lost === fees ? "  ok " : "  MISMATCH"} the two wallets lost ${ada(lost)} tADA, the ${txs.length} transactions' fees total ${ada(fees)}`);
  if (TOKEN) {
    log(`consumer ${ada(b.consumerTokens)} → ${ada(now.consumerTokens)}; provider ${ada(b.providerTokens)} → ${ada(now.providerTokens)} ${unitName}; still in open channels ${ada(open.amount)}`);
    const moved = now.consumerTokens + now.providerTokens + open.amount - b.consumerTokens - b.providerTokens;
    log(`${moved === 0n ? "  ok " : "  MISMATCH"} ${unitName} across the wallets and channels: ${moved === 0n ? "none created or lost" : `off by ${moved}`}`);
  }
}

// ---- helpers ------------------------------------------------------------------

async function walletsAda(): Promise<Wallets> {
  const [c, p] = [await consumer.getWalletUtxos(), await provider.getWalletUtxos()];
  const ada_ = (us: typeof c) => us.reduce((a, u) => a + Assets.lovelaceOf(u.assets), 0n);
  const tok = (us: typeof c) => (TOKEN ? us.reduce((a, u) => a + amountOf(u.assets), 0n) : 0n);
  return { consumer: ada_(c), provider: ada_(p), consumerTokens: tok(c), providerTokens: tok(p) };
}

async function settledWallets() {
  let last = await walletsAda();
  for (let i = 0; i < 6; i++) {
    await new Promise((res) => setTimeout(res, 30_000));
    const now = await walletsAda();
    if (JSON.stringify(now, (_, v) => (typeof v === "bigint" ? v.toString() : v)) === JSON.stringify(last, (_, v) => (typeof v === "bigint" ? v.toString() : v))) return now;
    last = now;
  }
  throw new Error("balances did not settle");
}

async function openChannelValue(): Promise<{ lovelace: bigint; amount: bigint }> {
  let lovelace = 0n;
  let amount = 0n;
  for (const d of ["client", "topup", "autosettle", "recover-a", "recover-b", "recover-c", ...Array.from({ length: 10 }, (_, i) => `batch/${i}`)]) {
    if (!existsSync(dir(d))) continue;
    for (const c of await new FileClientStorage(dir(d)).list()) {
      if ((c.status !== "open" && c.status !== "closing") || !c.channelRef) continue;
      const v = await chain.followChannel(c.channelRef, SUBBIT_HASH, c.channelId);
      if (v) {
        lovelace += v.lovelace;
        amount += TOKEN ? v.amount : 0n;
      }
    }
  }
  return { lovelace, amount };
}

const q = (sorted: number[], at: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(at * (sorted.length - 1)))]!.toFixed(1) : "-");

function listen(port: number, handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>): Promise<Server> {
  const srv = createServer((req, res) =>
    handler(req, res).catch((e) => {
      log(`  server ${port}: ${(e as Error).stack ?? String(e)}`);
      json(res, 500, { error: String(e) });
    }),
  );
  return new Promise((ok) => srv.listen(port, "127.0.0.1", () => ok(srv)));
}

function adapter(req: IncomingMessage, url: URL): HTTPAdapter {
  return {
    getHeader: (name: string) => req.headers[name.toLowerCase()] as string | undefined,
    getMethod: () => req.method ?? "GET",
    getPath: () => url.pathname,
    getUrl: () => url.toString(),
    getAcceptHeader: () => (req.headers.accept as string) ?? "application/json",
    getUserAgent: () => (req.headers["user-agent"] as string) ?? "",
    getQueryParams: () => Object.fromEntries(url.searchParams.entries()),
    getQueryParam: (name: string) => url.searchParams.get(name) ?? undefined,
  };
}

function body(req: IncomingMessage): Promise<string> {
  return new Promise((ok, err) => {
    let s = "";
    req.on("data", (d) => (s += d));
    req.on("end", () => ok(s));
    req.on("error", err);
  });
}

function send(res: ServerResponse, status: number, headers: Record<string, string>, b: unknown) {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(typeof b === "string" ? b : JSON.stringify(b));
}

const json = (res: ServerResponse, status: number, b: unknown) => send(res, status, {}, b);

async function main() {
  const phase = process.argv[2] ?? "all";
  if (phase === "reset") {
    rmSync(dir(""), { recursive: true, force: true });
    return log("x402 state cleared");
  }
  const s = await stack();
  try {
    if (phase === "pay" || phase === "all") await phasePay(s, Number(process.argv[3] ?? 200));
    if (phase === "claim" || phase === "all") await phaseClaim(s);
    if (phase === "corrective" || phase === "all") await phaseCorrective(s);
    if (phase === "refund" || phase === "all") await phaseRefund(s, phase === "refund" ? (process.argv[3] ?? "client") : "client");
    if (phase === "batch" || phase === "all") await phaseBatch(s);
    if (phase === "batch-refund" || phase === "all") await phaseBatchRefund(s);
    if (phase === "wallets") await phaseWallets(process.argv[3] ?? new Date().toISOString());
    if (phase === "recover") await phaseRecover(s);
    if (phase === "recover-elapse") await phaseRecoverElapse(s);
    if (phase === "topup") await phaseTopUp(s);
    if (phase === "autosettle") await phaseAutoSettle(s);
    if (phase === "report" || phase === "all") await phaseReport();
  } finally {
    await s.close();
  }
}

run(main);
