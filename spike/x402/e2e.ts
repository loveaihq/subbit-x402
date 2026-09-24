// Step 4 of the plan, on preprod: x402 `batch-settlement` end to end over Subbit channels
// (DESIGN.md §10). A facilitator (127.0.0.1:7413) and a resource server (127.0.0.1:7411, one
// route priced 1,000 lovelace) run in this process and talk real HTTP; the client is
// @x402/fetch's wrapFetchWithPayment around this binding's client scheme.
//
//   pay [n]     n paid requests (default 200); the first opens the channel
//   claim       the server redeems what it charged, one Sub through the facilitator
//   corrective  the client's count is knocked one request off, both ways; the 402 resyncs it
//   refund      claim, then the client closes the channel with Mutual
//   batch       10 more channels; claims of N = 10, 5 and 1 channels per transaction
//   batch-refund  close the 10 batch channels with Mutual
//   report      every transaction's fee, and the wallets reconciled
//
// Usage: npm run x402 -- <phase|all>
// Env:   WALLET_MNEMONIC (preprod only), BLOCKFROST_PROJECT_ID; SUBBIT_CURRENCY=token prices the
//        route in the sUSDM stand-in (`npm run mint -- mint`) instead of lovelace, state in out/x402-token/
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { rmSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { x402Facilitator } from "@x402/core/facilitator";
import { HTTPFacilitatorClient, x402HTTPResourceServer, x402ResourceServer, type HTTPAdapter, type RoutesConfig } from "@x402/core/server";
import { decodePaymentResponseHeader } from "@x402/core/http";
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { Address, Assets } from "@evolution-sdk/evolution";
import { SUBBIT_HASH } from "../../src/subbit.ts";
import { BlockfrostChain } from "../../src/x402/chain.ts";
import { BatchSettlementCardanoClient, FileClientStorage, type ClientChannel } from "../../src/x402/client.ts";
import { BatchSettlementCardanoFacilitator } from "../../src/x402/facilitator.ts";
import { ChannelManager, type ClaimResult } from "../../src/x402/manager.ts";
import { BatchSettlementCardanoServer, FileChannelStorage, walletProviderSigner } from "../../src/x402/server.ts";
import { REF_STATE, BF_BASE, ada, bf, consumer, keyHashHex, load, log, must, provider, run, save } from "../chain.ts";
import { TOKEN, amountOf, token, unitName } from "../currency.ts";

const NETWORK = "cardano:preprod" as const;
const PRICE = 1_000n;
const FAC_PORT = 7413;
const RES_PORT = 7411;
const URL_DATA = `http://127.0.0.1:${RES_PORT}/data`;
const OUT = new URL(TOKEN ? "../../out/x402-token/" : "../../out/x402/", import.meta.url);
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
    close: async () => {
      await new Promise((r) => facServer.close(r));
      await new Promise((r) => resServer.close(r));
    },
  };
}

type Stack = Awaited<ReturnType<typeof stack>>;

/** A paying client with its own channel store, counting the HTTP calls it makes. */
function payer(storageDir: string, capacity: bigint) {
  const storage = new FileClientStorage(dir(storageDir));
  const scheme = new BatchSettlementCardanoClient({ wallet: consumer, storage, chain, capacity, maxDeposit: 20_000_000n, spentInputs });
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

async function phaseReport() {
  const r = load<Results>(RESULTS);
  const txs = [
    ...(r.deposits ?? []).map((d) => ["deposit", d.transaction] as const),
    ...(r.claims ?? []).map((c) => [`${c.phase} (${c.n})`, c.transaction] as const),
    ...(r.refunds ?? []).map((f) => ["refund", f.transaction] as const),
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
  for (const d of ["client", ...Array.from({ length: 10 }, (_, i) => `batch/${i}`)]) {
    if (!existsSync(dir(d))) continue;
    for (const c of await new FileClientStorage(dir(d)).list()) {
      if (c.status !== "open" || !c.channelRef) continue;
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
    if (phase === "refund" || phase === "all") await phaseRefund(s);
    if (phase === "batch" || phase === "all") await phaseBatch(s);
    if (phase === "batch-refund" || phase === "all") await phaseBatchRefund(s);
    if (phase === "report" || phase === "all") await phaseReport();
  } finally {
    await s.close();
  }
}

run(main);
