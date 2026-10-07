// Step 17: the sponsor-safe variant (variant/sponsored/DESIGN.md, SPONSORSHIP.md section 7) on preprod,
// at its own validator, `SPONSORED`, which this stack trusts, serves and names in every 402.
//
//   A   cooperative: open on the seller's offer, 12 requests, one sponsored top-up, the server's claim, the
//       sponsored Mutual refund. The buyer holds one UTxO of tUSDM and its min-ada, and nothing else.
//   B1  R3: the buyer spends its whole deposit and Closes alone, the server settles, which leaves the channel
//       empty, and the server Ends it as provider.
//   B2  Elapse: the buyer spends part and Closes alone; the server never settles it; after `elapse_at` the
//       buyer Elapses alone.
//   B3  the consumer's End: the buyer spends part and Closes, the server settles what it was owed, the
//       buyer Ends what is left.
//   Every exit repays payTo the channel's floor, with the channel input's output reference as its datum (R2).
//
// Negatives are evaluated, never submitted: each is a transaction this binding built, with one thing changed,
// next to the unchanged transaction as a control, both through Blockfrost's evaluator. A transaction that is
// expected to fail is never handed to anything that submits.
//
//   npm run variant -- balances | fund | run | report | sweep
//
// `run` is resumable: each step it finishes is recorded, and a second `run` goes on from there. State in
// out/x402-step17/ (X402_STEP17_OUT keeps a run elsewhere under out/).
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Address, Assets, Client, Data, InlineDatum, KeyHash, Transaction, TransactionBody, TransactionHash, TxOut, preprod, type UTxO } from "@evolution-sdk/evolution";
import { x402Facilitator } from "@x402/core/facilitator";
import { decodePaymentRequiredHeader, decodePaymentResponseHeader } from "@x402/core/http";
import { HTTPFacilitatorClient, x402HTTPResourceServer, x402ResourceServer, type HTTPAdapter, type RoutesConfig } from "@x402/core/server";
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { SPONSORED, channelAddress, parseDatum, repaymentDatum } from "../../src/subbit.ts";
import { isChannelOutput, refOf } from "../../src/x402/cardano.ts";
import { BlockfrostChain, causeChain, isScriptAddress, type Chain } from "../../src/x402/chain.ts";
import { BatchSettlementCardanoClient, FileClientStorage, type Authorization } from "../../src/x402/client.ts";
import { BatchSettlementCardanoFacilitator } from "../../src/x402/facilitator.ts";
import { ChannelManager } from "../../src/x402/manager.ts";
import { BatchSettlementCardanoServer, FileChannelStorage, walletProviderSigner } from "../../src/x402/server.ts";
import { SponsorPool } from "../../src/x402/sponsor.ts";
import { BF_BASE, ada, bf, keyHashHex, load, log, must, provider, run, save, submit, type BfUtxos } from "../chain.ts";

const NETWORK = "cardano:preprod";
const TUSDM = "e675b46e4d2242c991a8932a99db3044e80515ae14b4c4ccf6b3f4c9.0014df10745553444d";
const [POLICY, NAME] = TUSDM.split(".") as [string, string];
const UNIT = POLICY + NAME;
const PRICE = 100_000n; // 0.1 tUSDM a request
const CAPACITY = 1_000_000n; // 1 tUSDM a deposit: ten requests
const OFFER_LOVELACE = 4_000_000n; // a base-address payTo's change clears min-UTxO after the variant's larger reserve only from 4 tADA
const OFFERS = 8;
const OWN_ADA = 5_000_000n; // what each of B1 to B3's buyers is given of its own
const BUYER_TUSDM = 5_000_000n;
const POOL_MAX_FEE = 600_000n; // the validator is attached to each transaction, not read from a reference script: the fees are larger
const RES_PORT = 7442;
const FAC_PORT = 7443;
const URL_DATA = `http://127.0.0.1:${RES_PORT}/data`;
/** Seller, provider and payTo are one: account 1. The sponsor key is account 4, not the provider key. */
const ACCOUNT = { tokenFunder: 0, seller: 1, sponsor: 4, buyerA: 8, buyerB1: 5, buyerB2: 7, buyerB3: 2 } as const;
type Who = keyof typeof ACCOUNT;
/** Accounts 6 and 9 hold another project's funds: this script has no way to sign with them or spend from them. */
const FORBIDDEN = new Set([6, 9]);
for (const [name, i] of Object.entries(ACCOUNT)) if (FORBIDDEN.has(i)) throw new Error(`${name} is account ${i}, which is not this project's`);

const projectId = must("BLOCKFROST_PROJECT_ID");
const mnemonic = must("WALLET_MNEMONIC");
const wallet = (accountIndex: number) => {
  if (FORBIDDEN.has(accountIndex)) throw new Error(`account ${accountIndex} is not this project's`);
  return Client.make(preprod).withBlockfrost({ baseUrl: BF_BASE, projectId }).withSeed({ mnemonic, accountIndex });
};
const chain = new BlockfrostChain(NETWORK, BF_BASE, projectId);
/** The provider alone, for evaluating transactions that are never submitted. */
const evaluator = Client.make(preprod).withBlockfrost({ baseUrl: BF_BASE, projectId });
const OUT = new URL(`../../out/${process.env.X402_STEP17_OUT ?? "x402-step17"}/`, import.meta.url);
const STATE = new URL("state.json", OUT);
const dir = (name: string) => new URL(`${name}/`, OUT).pathname.replace(/^\/(\w:)/, "$1");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const CHANNEL_ADDRESS = channelAddress(0, undefined, SPONSORED);

// ---- state -----------------------------------------------------------------------------------

type Scenario = "A" | "B1" | "B2" | "B3";

interface Holding {
  lovelace: string;
  tusdm: string;
  utxos: number;
  /** Units besides ADA and tUSDM, by quantity. */
  other: Record<string, string>;
}
type Snapshot = Record<string, Holding>;

/** A transaction of a scenario; `paidBy` is whose ADA its fee came from. */
interface TxRec {
  scenario: Scenario;
  step: string;
  tx: string;
  paidBy: "seller" | "buyer";
  request?: number;
  ms?: number;
  note?: string;
}
interface Unit {
  tag: string;
  index: number;
  mem: string;
  steps: string;
}
interface NegRec {
  group: string;
  case: string;
  expect: "accepted" | "refused";
  outcome: "accepted" | "refused" | "other";
  units?: Unit[];
  detail?: string;
  at: string;
}
interface ChannelRec {
  channelId: string;
  buyer: Who;
  floor?: string;
  elapseAt?: string;
}
interface State {
  before?: Snapshot;
  after?: Snapshot;
  swept?: Snapshot;
  funding: Array<{ what: string; tx: string }>;
  sweeps: Array<{ what: string; tx: string }>;
  done: Record<string, string>;
  txs: TxRec[];
  channels: Partial<Record<Scenario, ChannelRec>>;
  negatives: NegRec[];
}
const state = (): State => ({ funding: [], sweeps: [], done: {}, txs: [], channels: {}, negatives: [], ...(load<State>(STATE) as Partial<State>) });
const record = (f: (s: State) => void) => {
  const s = state();
  f(s);
  save(STATE, s);
};
const addTx = (r: TxRec) =>
  record((s) => {
    if (!s.txs.some((t) => t.tx === r.tx)) s.txs.push(r);
  });

async function holdings(address: string): Promise<Holding> {
  const rows: Array<{ amount: Array<{ unit: string; quantity: string }> }> = [];
  for (let page = 1; ; page++) {
    // An address that has never held anything is a 404 to Blockfrost.
    const got = ((await bf(`/addresses/${address}/utxos?page=${page}`).catch((e: Error) => (/: 404/.test(e.message) ? [] : Promise.reject(e)))) ?? []) as typeof rows;
    rows.push(...got);
    if (got.length < 100) break;
  }
  let lovelace = 0n;
  let tusdm = 0n;
  const other: Record<string, bigint> = {};
  for (const r of rows) {
    for (const a of r.amount) {
      if (a.unit === "lovelace") lovelace += BigInt(a.quantity);
      else if (a.unit === UNIT) tusdm += BigInt(a.quantity);
      else other[a.unit] = (other[a.unit] ?? 0n) + BigInt(a.quantity);
    }
  }
  return { lovelace: lovelace.toString(), tusdm: tusdm.toString(), utxos: rows.length, other: Object.fromEntries(Object.entries(other).map(([k, v]) => [k, v.toString()])) };
}

async function snapshot(label: string, print = true): Promise<Snapshot> {
  const out: Snapshot = {};
  for (const [name, i] of Object.entries(ACCOUNT)) {
    const h = await holdings(Address.toBech32(await wallet(i).address()));
    out[name] = h;
    if (print) log(`${label} account ${i} ${name.padEnd(11)} ${String(h.utxos).padStart(2)} utxos, ${ada(BigInt(h.lovelace)).padStart(14)} tADA, ${Number(h.tusdm) / 1e6} tUSDM${Object.keys(h.other).length ? `, other: ${Object.entries(h.other).map(([u, q]) => `${u.slice(0, 8)}…${u.slice(-8)} ×${q}`).join(", ")}` : ""}`);
  }
  return out;
}

// ---- balances, fund ------------------------------------------------------------------------------

async function phaseBalances() {
  await snapshot("now");
}

/** The ADA-only UTxOs of an account, as Blockfrost lists them, and what they hold. */
async function adaOnly(accountIndex: number) {
  const utxos = await wallet(accountIndex).getWalletUtxos();
  const only = utxos.filter((u) => Assets.hasOnlyLovelace(u.assets));
  return { only, lovelace: only.reduce((s, u) => s + Assets.lovelaceOf(u.assets), 0n) };
}

/** The tUSDM an account holds in UTxOs that hold nothing else besides ADA, which is what a channel opening draws on. */
async function tokensOf(accountIndex: number) {
  const utxos = await wallet(accountIndex).getWalletUtxos();
  return utxos.filter((u) => Assets.getByUnit(u.assets, UNIT) > 0n && Assets.getUnits(u.assets).every((x) => x === "lovelace" || x === UNIT)).reduce((s, u) => s + Assets.getByUnit(u.assets, UNIT), 0n);
}

async function phaseFund() {
  const seller = wallet(ACCOUNT.seller);
  // The sponsor key's offers: ADA-only UTxOs of 4 tADA, which the pool offers (it offers 3.5 to 6 tADA).
  const sponsorAddr = await wallet(ACCOUNT.sponsor).address();
  const offerable = (await wallet(ACCOUNT.sponsor).getWalletUtxos()).filter((u) => Assets.hasOnlyLovelace(u.assets) && Assets.lovelaceOf(u.assets) >= 3_500_000n && Assets.lovelaceOf(u.assets) <= 6_000_000n).length;
  if (offerable < OFFERS) {
    let tx = seller.newTx();
    for (let k = offerable; k < OFFERS; k++) tx = tx.payToAddress({ address: sponsorAddr, assets: Assets.fromLovelace(OFFER_LOVELACE) });
    const sb = await tx.build();
    const hash = await submit(`the sponsor key (account ${ACCOUNT.sponsor}) funded: ${OFFERS - offerable} offers of ${ada(OFFER_LOVELACE)} tADA`, await sb.sign(), seller);
    record((s) => s.funding.push({ what: `sponsor offers: ${OFFERS - offerable} x ${ada(OFFER_LOVELACE)} tADA to account ${ACCOUNT.sponsor}`, tx: hash }));
  }
  // B1 to B3's buyers: ADA of their own, so that they can exit alone; and tUSDM for the one that holds none.
  const own: Array<[Who, bigint, bigint]> = [];
  for (const who of ["buyerB1", "buyerB2", "buyerB3"] as const) {
    const have = (await adaOnly(ACCOUNT[who])).lovelace;
    const tusdm = await tokensOf(ACCOUNT[who]);
    own.push([who, have >= OWN_ADA - 1_000_000n ? 0n : OWN_ADA, tusdm >= BUYER_TUSDM ? 0n : BUYER_TUSDM]);
  }
  if (own.some(([, a, t]) => a > 0n || t > 0n)) {
    let tx = seller.newTx();
    const what: string[] = [];
    for (const [who, a, t] of own) {
      const to = await wallet(ACCOUNT[who]).address();
      if (a > 0n) {
        tx = tx.payToAddress({ address: to, assets: Assets.fromLovelace(a) });
        what.push(`${ada(a)} tADA to account ${ACCOUNT[who]}`);
      }
      if (t > 0n) {
        tx = tx.payToAddress({ address: to, assets: Assets.fromHexStrings(POLICY, NAME, t, 0n), autoMinUtxo: true });
        what.push(`${Number(t) / 1e6} tUSDM and its min-ada to account ${ACCOUNT[who]}`);
      }
    }
    const sb = await tx.build();
    const hash = await submit(`buyers funded: ${what.join("; ")}`, await sb.sign(), seller);
    record((s) => s.funding.push({ what: what.join("; "), tx: hash }));
  }
  // Scenario A's buyer holds only tUSDM and its min-ada: no ADA-only UTxO. Say so, and stop if it is not so.
  const a = await wallet(ACCOUNT.buyerA).getWalletUtxos();
  if (a.some((u) => Assets.hasOnlyLovelace(u.assets))) throw new Error("scenario A's buyer holds an ADA-only UTxO: it is not a stablecoin-only buyer");
  if ((await tokensOf(ACCOUNT.buyerA)) < 5_000_000n) throw new Error("scenario A's buyer holds under 5 tUSDM");
  await sleep(25_000); // Blockfrost's address index trails a block
  const snap = await snapshot("funded");
  // What the run starts from. Once a step of it is done, a later `fund` does not move it.
  record((s) => {
    if (!s.before || Object.keys(s.done).length === 0) s.before = snap;
  });
}

// ---- the stack ----------------------------------------------------------------------------------

/** What the server's manager does just before it submits a transaction of its own (its End). */
let beforeServerSubmit: ((hex: string) => Promise<void>) | undefined;

async function stack() {
  const providerAddr = await provider.address();
  const payTo = Address.toBech32(providerAddr);
  const providerKeyHash = keyHashHex(providerAddr);
  if (keyHashHex(await wallet(ACCOUNT.sponsor).address()) === providerKeyHash) throw new Error("the sponsor key is the provider key");
  // The facilitator serves the variant alone, the server names it in every 402, the clients trust it alone.
  const facilitator = new x402Facilitator().register(NETWORK, new BatchSettlementCardanoFacilitator(chain, { validators: [SPONSORED], confirmationTimeoutMs: 180_000 }));
  const facServer = await listen(FAC_PORT, async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method === "GET" && url.pathname === "/supported") return json(res, 200, facilitator.getSupported());
    if (req.method === "POST" && (url.pathname === "/verify" || url.pathname === "/settle")) {
      const { paymentPayload, paymentRequirements } = JSON.parse((await body(req)) || "{}");
      const out = url.pathname === "/verify" ? await facilitator.verify(paymentPayload, paymentRequirements) : await facilitator.settle(paymentPayload, paymentRequirements);
      const failed = (out as { isValid?: boolean }).isValid === false || (out as { success?: boolean }).success === false;
      if (failed) log(`  facilitator ${url.pathname}: ${JSON.stringify(out).slice(0, 400)}`);
      return json(res, 200, out);
    }
    json(res, 404, { error: "not found" });
  });
  const facilitatorClient = new HTTPFacilitatorClient({ url: `http://127.0.0.1:${FAC_PORT}`, timeoutMs: 400_000 });
  const storage = new FileChannelStorage(dir("server"));
  const pool = new SponsorPool({ wallet: wallet(ACCOUNT.sponsor), maxFee: POOL_MAX_FEE });
  const scheme = new BatchSettlementCardanoServer({
    payTo,
    receiverAuthorizer: providerKeyHash,
    scriptHash: SPONSORED.hash,
    withdrawDelay: 900, // the shortest close period the binding allows
    storage,
    signAsProvider: walletProviderSigner(provider),
    chain,
    assetDecimals: { [TUSDM]: 6 },
    sponsor: { pool, log: (l) => log(`  ${l}`) },
  });
  const resource = new x402ResourceServer(facilitatorClient).register(NETWORK, scheme);
  const routes: RoutesConfig = {
    "GET /data": { accepts: { scheme: "batch-settlement", network: NETWORK, payTo, price: { asset: TUSDM, amount: PRICE.toString() }, maxTimeoutSeconds: 300, extra: {} }, description: "one datum for 0.1 tUSDM" },
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
    if (result.type === "payment-error") return send(res, result.response.status, result.response.headers, result.response.body ?? {});
    const payload = JSON.stringify({ n: ++served, at: new Date().toISOString() });
    const settle = await http.processSettlement(result.paymentPayload, result.paymentRequirements, result.declaredExtensions, { request: context, responseBody: Buffer.from(payload) }, undefined, result.beforeHandlerSettlement);
    if (!settle.success) {
      log(`  resource: settlement failed ${settle.errorReason} ${settle.errorMessage ?? ""}`);
      return send(res, settle.response.status, { ...settle.headers, ...settle.response.headers }, settle.response.body ?? {});
    }
    send(res, 200, settle.headers, payload);
  });
  // The manager's own submissions (its End) pass through `beforeServerSubmit`, which may evaluate variants of
  // the transaction first; everything else it asks of the chain goes straight through.
  const managerChain = new Proxy(chain, {
    get(target, prop) {
      if (prop === "submit") {
        return async (hex: string) => {
          await beforeServerSubmit?.(hex);
          return target.submit(hex);
        };
      }
      const v = Reflect.get(target, prop, target);
      return typeof v === "function" ? v.bind(target) : v;
    },
  }) as Chain;
  const manager = new ChannelManager({ storage, wallet: provider, providerKeyHash, chain: managerChain, facilitator: facilitatorClient, network: NETWORK, payTo, scriptHash: SPONSORED.hash });
  return {
    payTo,
    providerKeyHash,
    storage,
    pool,
    manager,
    close: async () => {
      await new Promise((r) => resServer.close(r));
      await new Promise((r) => facServer.close(r));
    },
  };
}
type Stack = Awaited<ReturnType<typeof stack>>;

/** Thrown by a buyer's `authorize` to stop the transaction it was shown before anything records or submits it. */
class Captured extends Error {
  constructor(readonly auth: Authorization) {
    super(`captured the ${auth.kind} transaction, not submitted`);
  }
}

function buyer(who: Who) {
  const storage = new FileClientStorage(dir(`client-${who}`));
  let armed: Authorization["kind"] | undefined;
  const scheme = new BatchSettlementCardanoClient({
    wallet: wallet(ACCOUNT[who]),
    storage,
    chain,
    capacity: CAPACITY,
    maxDeposit: 5_000_000n,
    iouKeys: "derived",
    trustedValidators: [SPONSORED],
    // A buyer's own exit is built, signed and shown to `authorize` before it is submitted: armed, `authorize`
    // keeps it and refuses it, so that variants of it can be evaluated and the exit itself made afterwards.
    authorize: async (a) => {
      if (armed !== undefined && armed === a.kind) {
        armed = undefined;
        throw new Captured(a);
      }
    },
  });
  // A payload that fails says why all the way down, which the SDK's message and the fetch wrapper leave out.
  const make = scheme.createPaymentPayload.bind(scheme);
  scheme.createPaymentPayload = async (version, requirements) => {
    try {
      return await make(version, requirements);
    } catch (e) {
      log(`  the payment payload failed: ${causeChain(e).join(" | ").slice(0, 800)}`);
      throw e;
    }
  };
  const client = x402Client.fromConfig({ schemes: [{ network: "cardano:*", client: scheme }], spendControls: false });
  /** Runs `fn`, an exit of this buyer's, and returns the signed transaction it would have submitted. Nothing is submitted. */
  const capture = async (kind: "close" | "end" | "elapse", fn: () => Promise<unknown>) => {
    armed = kind;
    try {
      await fn();
    } catch (e) {
      if (e instanceof Captured) return e.auth as Extract<Authorization, { kind: "close" | "end" | "elapse" }>;
      throw e;
    } finally {
      armed = undefined;
    }
    throw new Error(`the ${kind} was submitted instead of captured`);
  };
  return { who, storage, scheme, pay: wrapFetchWithPayment(fetch, client), capture };
}
type Buyer = ReturnType<typeof buyer>;
/** One client per buyer for the whole process: its record of what it has spent and is owed back is its own. */
const clients = new Map<Who, Buyer>();
const buyerFor = (who: Who): Buyer => {
  let b = clients.get(who);
  if (!b) clients.set(who, (b = buyer(who)));
  return b;
};

// ---- steps ------------------------------------------------------------------------------------------

async function step(name: string, fn: () => Promise<void>) {
  const done = state().done[name];
  if (done) {
    log(`[${name}] done already, at ${done}`);
    return;
  }
  log(`[${name}] begins`);
  await fn();
  record((s) => (s.done[name] = new Date().toISOString()));
  log(`[${name}] done`);
}

const SCENARIO_BUYER: Record<Scenario, Who> = { A: "buyerA", B1: "buyerB1", B2: "buyerB2", B3: "buyerB3" };

/** Requests until `upto` have been paid, the first of a channel opening it and a later one that outgrows it topping it up. */
async function payRequests(sc: Scenario, b: Buyer, upto: number) {
  const have = (await b.storage.list())[0];
  const paid = have ? Number(BigInt(have.chargedCumulativeAmount) / PRICE) : 0;
  for (let i = paid + 1; i <= upto; i++) {
    const t0 = Date.now();
    const r = await b.pay(URL_DATA);
    const text = await r.text();
    const header = r.headers.get("payment-response");
    const settle = header ? decodePaymentResponseHeader(header) : undefined;
    const ms = Date.now() - t0;
    if (r.status !== 200) {
      const why = r.headers.get("payment-required") ? decodePaymentRequiredHeader(r.headers.get("payment-required")!).error : text.slice(0, 300);
      throw new Error(`${sc} request ${i}: HTTP ${r.status}: ${why}`);
    }
    const onChain = settle?.transaction ? settle.transaction : undefined;
    if (onChain) {
      const kind = i === 1 ? "open" : "top-up";
      log(`${sc} request ${i}: ${kind} ${onChain} in ${(ms / 1000).toFixed(1)} s`);
      addTx({ scenario: sc, step: kind, tx: onChain, paidBy: "seller", request: i, ms });
    } else if (i % 5 === 0 || i === upto) {
      log(`${sc} request ${i}: voucher in ${ms} ms`);
    }
  }
}

/** The buyer's channel as its record and the chain give it. */
async function channelOf(sc: Scenario, b: Buyer) {
  const known = state().channels[sc];
  const ch = known ? await b.storage.get(known.channelId) : (await b.storage.list())[0];
  if (!ch?.channelRef) throw new Error(`${sc}: the buyer has no channel record to act on`);
  const view = await chain.followChannel(ch.channelRef, SPONSORED.hash, ch.channelId);
  if (!view) throw new Error(`${sc}: channel ${ch.channelId.slice(0, 16)}… is gone`);
  return { ch, view };
}

/** The opening names payTo as sponsor, with the channel's whole ADA as the floor, and the buyer's record knows the reserve is the seller's. */
async function checkOpened(sc: Scenario, b: Buyer, payTo: string) {
  const { ch, view } = await channelOf(sc, b);
  const sponsor = view.datum.constants.sponsor;
  if (!sponsor || sponsor.address !== payTo || sponsor.floor !== view.lovelace) throw new Error(`${sc}: the channel's datum does not name payTo as sponsor with its whole ADA as the floor: ${JSON.stringify(sponsor, (_, v) => (typeof v === "bigint" ? v.toString() : v))}, ${view.lovelace} lovelace`);
  if (ch.reserveFrom !== "seller") throw new Error(`${sc}: the buyer's record does not say the reserve is the seller's`);
  log(`${sc} channel ${ch.channelId.slice(0, 16)}… at ${view.ref}: sponsor ${sponsor.address.slice(0, 20)}… floor ${sponsor.floor} = the ${view.lovelace} lovelace it holds, ${view.amount} tokens`);
  record((s) => (s.channels[sc] = { ...(s.channels[sc] ?? { channelId: ch.channelId, buyer: SCENARIO_BUYER[sc] }), channelId: ch.channelId, buyer: SCENARIO_BUYER[sc], floor: sponsor.floor.toString() }));
}

// ---- evaluating what must not be submitted ----------------------------------------------------------

const hexOf = (s: string) => Uint8Array.from(Buffer.from(s, "hex"));

/** A transaction as it was, with its outputs or its required signers changed. Nothing else is checked, so the signatures need not be redone. */
function tamper(txHex: string, patch: { outputs?: (outputs: TxOut.TransactionOutput[]) => TxOut.TransactionOutput[]; requiredSigners?: string[] }): string {
  const tx = Transaction.fromCBORHex(txHex);
  return Transaction.toCBORHex(
    new Transaction.Transaction({
      body: new TransactionBody.TransactionBody({
        ...tx.body,
        ...(patch.outputs ? { outputs: patch.outputs([...tx.body.outputs]) } : {}),
        ...(patch.requiredSigners ? { requiredSigners: patch.requiredSigners.map((k) => KeyHash.fromHex(k)) as [KeyHash.KeyHash, ...KeyHash.KeyHash[]] } : {}),
      }),
      witnessSet: tx.witnessSet,
      isValid: true,
      auxiliaryData: null,
    }),
  );
}

/** An output with its address, its lovelace (the rest of its value kept) or its inline datum (none, if null) changed. */
const outputWith = (o: TxOut.TransactionOutput, over: { address?: Address.Address; lovelace?: bigint; datum?: Data.Data | null }) =>
  new TxOut.TransactionOutput({
    address: over.address ?? o.address,
    assets: over.lovelace === undefined ? o.assets : Assets.merge(Assets.withoutLovelace(o.assets), Assets.fromLovelace(over.lovelace)),
    ...(over.datum === null ? {} : over.datum !== undefined ? { datumOption: new InlineDatum.InlineDatum({ data: over.datum }) } : o.datumOption ? { datumOption: o.datumOption } : {}),
  });

/** A transaction with each output at `address` replaced by what `change` makes of it, or dropped when that is undefined. */
const alterAt = (txHex: string, address: Address.Address, change: (o: TxOut.TransactionOutput) => TxOut.TransactionOutput | undefined) =>
  tamper(txHex, { outputs: (outs) => outs.flatMap((o) => (Address.toHex(o.address) === Address.toHex(address) ? [change(o)].filter((x): x is TxOut.TransactionOutput => x !== undefined) : [o])) });

/** The UTxOs a transaction spends, puts up as collateral and reads, as the chain holds them now. */
async function inputsOf(hex: string): Promise<UTxO.UTxO[]> {
  const tx = Transaction.fromCBORHex(hex);
  const refs = new Set<string>();
  for (const i of [...tx.body.inputs, ...(tx.body.collateralInputs ?? []), ...(tx.body.referenceInputs ?? [])]) refs.add(`${TransactionHash.toHex(i.transactionId)}#${i.index}`);
  const out: UTxO.UTxO[] = [];
  for (const r of refs) {
    let u: UTxO.UTxO | undefined;
    for (let attempt = 0; attempt < 10 && !u; attempt++) {
      u = await chain.getUnspent(r);
      if (!u) await sleep(3_000); // Blockfrost's index may trail the block that made it
    }
    if (!u) throw new Error(`${r} is not an unspent output`);
    out.push(u);
  }
  return out;
}

type Evaluated = { ok: true; units: Unit[] } | { ok: false; scriptFailure: boolean; detail: string };

/** Through Blockfrost's evaluator, with the transaction's inputs given to it; never submits. */
async function evaluateOnly(hex: string, known: UTxO.UTxO[]): Promise<Evaluated> {
  try {
    const result = (await evaluator.evaluateTx(Transaction.fromCBORHex(hex), known)) as ReadonlyArray<{ redeemer_tag: string; redeemer_index: number; ex_units: { mem: bigint; steps: bigint } }>;
    return { ok: true, units: result.map((r) => ({ tag: r.redeemer_tag, index: r.redeemer_index, mem: r.ex_units.mem.toString(), steps: r.ex_units.steps.toString() })) };
  } catch (e) {
    const causes = causeChain(e).join(" | ");
    return { ok: false, scriptFailure: /ScriptFailures/.test(causes), detail: causes.slice(0, 900) };
  }
}

interface Case {
  name: string;
  expect: "accepted" | "refused";
  hex: string;
}

/**
 * Evaluates each case and records what came of it. A control the validator refuses, a negative it accepts,
 * and a failure of any other kind all stop the run, before the real transaction goes out.
 */
async function evaluateCases(group: string, known: UTxO.UTxO[], cases: Case[]) {
  for (const c of cases) {
    const r = await evaluateOnly(c.hex, known);
    const outcome: NegRec["outcome"] = r.ok ? "accepted" : r.scriptFailure ? "refused" : "other";
    const shown = r.ok ? `accepted, ${r.units.map((u) => `${u.tag}:${u.index} ${u.mem} mem ${u.steps} steps`).join("; ")}` : r.scriptFailure ? `refused: ${r.detail.slice(0, 160)}` : `FAILED, NOT BY THE VALIDATOR: ${r.detail}`;
    log(`  ${group} | ${c.name} -> ${shown}`);
    record((s) => {
      s.negatives = s.negatives.filter((n) => !(n.group === group && n.case === c.name));
      s.negatives.push({ group, case: c.name, expect: c.expect, outcome, ...(r.ok ? { units: r.units } : { detail: r.detail }), at: new Date().toISOString() });
    });
    if (outcome !== c.expect) throw new Error(`${group} | ${c.name}: expected ${c.expect}, the evaluator gave ${outcome}${r.ok ? "" : `: ${r.detail}`}`);
  }
}

/** What an exit's variants need to know about the channel it spends. */
function channelIn(known: UTxO.UTxO[]) {
  const channel = known.find((u) => isChannelOutput(u.address, SPONSORED.hash));
  if (!channel || !(channel.datumOption instanceof InlineDatum.InlineDatum)) throw new Error("the transaction spends no channel of the variant");
  const datum = parseDatum(channel.datumOption.data, SPONSORED, channel.address.networkId);
  if (!datum.constants.sponsor) throw new Error("the channel has no sponsor");
  return { ref: refOf(channel), tag: datum.constants.tag, consumer: datum.constants.consumer, provider: datum.constants.provider, sponsor: datum.constants.sponsor, held: Assets.getByUnit(channel.assets, UNIT), lovelace: Assets.lovelaceOf(channel.assets) };
}

/** A buyer's Close (R1): as built, re-encoded, and with the channel's continuing output a lovelace under its floor. */
function closeCases(hex: string): Case[] {
  return [
    { name: "the Close as built", expect: "accepted", hex },
    { name: "the same, re-encoded with nothing changed", expect: "accepted", hex: tamper(hex, {}) },
    { name: "the continuing output holds floor - 1 lovelace (R1)", expect: "refused", hex: alterAt(hex, CHANNEL_ADDRESS, (o) => outputWith(o, { lovelace: Assets.lovelaceOf(o.assets) - 1n })) },
  ];
}

/**
 * A transaction with its repayment, the output at `payTo` that carries an inline datum, replaced by what `change` makes of it,
 * or dropped when that is undefined. An output of payTo's without a datum, a change output, is left as it was.
 */
const alterRepayment = (txHex: string, payTo: Address.Address, change: (o: TxOut.TransactionOutput) => TxOut.TransactionOutput | undefined) =>
  tamper(txHex, {
    outputs: (outs) => outs.flatMap((o) => (Address.toHex(o.address) === Address.toHex(payTo) && o.datumOption instanceof InlineDatum.InlineDatum ? [change(o)].filter((x): x is TxOut.TransactionOutput => x !== undefined) : [o])),
  });

/** An End or an Elapse (R2): as built, re-encoded, and with its repayment to the sponsor changed one way at a time. */
function exitCases(hex: string, c: ReturnType<typeof channelIn>, payTo: Address.Address): Case[] {
  const [h, i] = c.ref.split("#") as [string, string];
  const otherRef = `${h}#${Number(i) + 1}`;
  const refused = (name: string, change: (o: TxOut.TransactionOutput) => TxOut.TransactionOutput | undefined): Case => ({ name, expect: "refused", hex: alterRepayment(hex, payTo, change) });
  return [
    { name: "the exit as built", expect: "accepted", hex },
    { name: "the same, re-encoded with nothing changed", expect: "accepted", hex: tamper(hex, {}) },
    { name: "the repayment is 1 lovelace over the floor", expect: "accepted", hex: alterRepayment(hex, payTo, (o) => outputWith(o, { lovelace: Assets.lovelaceOf(o.assets) + 1n })) },
    refused("no repayment (R2)", () => undefined),
    refused("the repayment is 1 lovelace short (R2)", (o) => outputWith(o, { lovelace: Assets.lovelaceOf(o.assets) - 1n })),
    refused("the repayment carries the channel's tag as its datum instead of the output reference (R2)", (o) => outputWith(o, { datum: hexOf(c.tag) })),
    refused("the repayment has no datum (R2)", (o) => outputWith(o, { datum: null })),
    refused("the repayment names another output reference (R2)", (o) => outputWith(o, { datum: repaymentDatum(otherRef) })),
    refused("the repayment goes to payTo's payment key alone, without its stake part (R2)", (o) => outputWith(o, { address: new Address.Address({ networkId: o.address.networkId, paymentCredential: o.address.paymentCredential }) })),
  ];
}

// ---- the scenarios ---------------------------------------------------------------------------------------

/** Opens the channel with the first request, pays up to `requests`, and checks what the opening wrote. */
async function openAndPay(sc: Scenario, s: Stack, requests: number) {
  const b = buyerFor(SCENARIO_BUYER[sc]);
  await payRequests(sc, b, requests);
  await checkOpened(sc, b, s.payTo);
  return b;
}

/** The buyer closes alone, with its own ADA; an R1 evaluation of the Close first, for the scenario that asks for it. */
async function closeAlone(sc: Scenario, withNegatives: boolean) {
  const b = buyerFor(SCENARIO_BUYER[sc]);
  const { ch } = await channelOf(sc, b);
  if (withNegatives) {
    const cap = await b.capture("close", () => b.scheme.close(ch.channelId));
    await evaluateCases(`${sc} Close`, await inputsOf(cap.transaction), closeCases(cap.transaction));
  }
  const t0 = Date.now();
  const { transaction, elapseAt } = await b.scheme.close(ch.channelId);
  log(`${sc} close: ${transaction} in ${((Date.now() - t0) / 1000).toFixed(1)} s, elapse_at ${new Date(Number(elapseAt)).toISOString()}`);
  addTx({ scenario: sc, step: "close", tx: transaction, paidBy: "buyer", ms: Date.now() - t0 });
  record((st) => (st.channels[sc] = { ...st.channels[sc]!, elapseAt: elapseAt.toString() }));
}

/** The server settles a channel its buyer closed, with the latest voucher it holds; `ended` is the End it made of an empty one. */
async function serverSettles(sc: Scenario, s: Stack) {
  const id = state().channels[sc]!.channelId;
  const t0 = Date.now();
  const results = await s.manager.claim({ channelIds: [id] });
  if (results.length !== 1 || results[0]!.channels.length !== 1) throw new Error(`${sc}: expected one claim of one channel, got ${JSON.stringify(results, (_, v) => (typeof v === "bigint" ? v.toString() : v))}`);
  const { transaction, channels } = results[0]!;
  const row = channels[0]!;
  log(`${sc} server settles: ${transaction}, took ${row.taken} of the channel in ${((Date.now() - t0) / 1000).toFixed(1)} s${row.ended ? `, and Ended it: ${row.ended}` : ""}${row.endError ? `, its End failed: ${row.endError}` : ""}`);
  addTx({ scenario: sc, step: "settle", tx: transaction, paidBy: "seller", note: `took ${row.taken}` });
  if (row.ended) addTx({ scenario: sc, step: "end (provider)", tx: row.ended, paidBy: "seller" });
  return row;
}

async function scenarioB1Settle(s: Stack) {
  // The End is the server's, built and submitted inside its claim. Variants of it are evaluated just before it goes out.
  const evaluated = { once: false };
  beforeServerSubmit = async (hex) => {
    if (evaluated.once) return;
    evaluated.once = true;
    const known = await inputsOf(hex);
    const c = channelIn(known);
    if (c.held !== 0n) throw new Error("B1: the server is about to End a channel that still holds tokens");
    const cases = exitCases(hex, c, Address.fromBech32(s.payTo));
    cases.push(
      { name: "signed by the consumer alone: the empty channel's End is the provider's (R3)", expect: "refused", hex: tamper(hex, { requiredSigners: [c.consumer] }) },
      { name: "signed by the consumer and the provider", expect: "accepted", hex: tamper(hex, { requiredSigners: [c.consumer, c.provider] }) },
    );
    await evaluateCases("B1 End by the provider, the channel empty", known, cases);
  };
  try {
    const b = buyerFor(SCENARIO_BUYER.B1);
    const { view } = await channelOf("B1", b);
    if (view.datum.stage.kind === "closed") {
      const row = await serverSettles("B1", s);
      if (!row.ended) {
        log(`B1: the server's End did not go out (${row.endError}); stopping rather than trying it again`);
        throw new Error(`B1: the server's End failed: ${row.endError}`);
      }
    } else if (view.datum.stage.kind === "settled" && view.amount === 0n) {
      // The settle landed in an earlier run and its End did not: the server's own call for that.
      const tx = await s.manager.endEmpty(view);
      log(`B1: the server's End: ${tx}`);
      addTx({ scenario: "B1", step: "end (provider)", tx, paidBy: "seller" });
    } else {
      throw new Error(`B1: the channel is ${view.datum.stage.kind} holding ${view.amount} tokens`);
    }
  } finally {
    beforeServerSubmit = undefined;
  }
}

/** The buyer ends a settled channel: an evaluation of variants first (R2, and R3 for a provider's End of what still holds tokens), then the End. */
async function scenarioB3End(s: Stack) {
  const b = buyerFor(SCENARIO_BUYER.B3);
  const { ch } = await channelOf("B3", b);
  const cap = await b.capture("end", () => b.scheme.end(ch.channelId));
  const known = await inputsOf(cap.transaction);
  const c = channelIn(known);
  if (c.held === 0n) throw new Error("B3: the settled channel holds none of its tokens: this is not the consumer's End");
  const cases = exitCases(cap.transaction, c, Address.fromBech32(s.payTo));
  cases.push(
    { name: "signed by the provider alone: a provider's End of a channel that still holds tokens (R3)", expect: "refused", hex: tamper(cap.transaction, { requiredSigners: [c.provider] }) },
    { name: "signed by the consumer and the provider", expect: "accepted", hex: tamper(cap.transaction, { requiredSigners: [c.consumer, c.provider] }) },
  );
  await evaluateCases("B3 End by the consumer, the channel still holding tokens", known, cases);
  const t0 = Date.now();
  const tx = await b.scheme.end(ch.channelId);
  log(`B3 end: ${tx} in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  addTx({ scenario: "B3", step: "end", tx, paidBy: "buyer", ms: Date.now() - t0 });
}

async function scenarioB2Elapse(s: Stack) {
  const b = buyerFor(SCENARIO_BUYER.B2);
  const { ch, view } = await channelOf("B2", b);
  if (view.datum.stage.kind !== "closed") throw new Error(`B2: the channel is ${view.datum.stage.kind}, not closed`);
  const server = await s.storage.get(ch.channelId);
  if (server && BigInt(server.totalClaimed) !== 0n) throw new Error("B2: the server has redeemed something of this channel, which it must not");
  log(`B2: waiting for elapse_at ${new Date(Number(view.datum.stage.elapseAt)).toISOString()}; the server has charged ${server?.chargedCumulativeAmount} and settled nothing`);
  const cap = await b.capture("elapse", () => b.scheme.elapse(ch.channelId));
  const known = await inputsOf(cap.transaction);
  const c = channelIn(known);
  await evaluateCases("B2 Elapse by the consumer", known, exitCases(cap.transaction, c, Address.fromBech32(s.payTo)));
  const t0 = Date.now();
  const tx = await b.scheme.elapse(ch.channelId);
  log(`B2 elapse: ${tx} in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  addTx({ scenario: "B2", step: "elapse", tx, paidBy: "buyer", ms: Date.now() - t0 });
}

async function scenarioA(s: Stack) {
  const b = buyerFor(SCENARIO_BUYER.A);
  await step("A.pay", async () => {
    await payRequests("A", b, 12);
    await checkOpened("A", b, s.payTo);
  });
  await step("A.claim", async () => {
    const id = state().channels.A!.channelId;
    const claims = await s.manager.claim({ channelIds: [id] });
    for (const c of claims) {
      log(`A claim: ${c.transaction}, ${c.channels.map((r) => `${r.channelId.slice(0, 16)}… +${r.taken}`).join(", ")}`);
      addTx({ scenario: "A", step: "claim", tx: c.transaction, paidBy: "seller", note: c.channels.map((r) => `took ${r.taken}`).join(", ") });
    }
  });
  await step("A.refund", async () => {
    const { ch } = await channelOf("A", b);
    const t0 = Date.now();
    const settle = await b.scheme.refund(URL_DATA, fetch, ch.channelId);
    log(`A refund: ${settle.transaction} in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    addTx({ scenario: "A", step: "refund", tx: settle.transaction, paidBy: "seller", ms: Date.now() - t0 });
  });
}

async function phaseRun() {
  if (!state().before) throw new Error("run `fund` first");
  const s = await stack();
  try {
    // B2 first: its elapse_at, the close plus the 15 minutes of the close period and the close's own validity window, is the longest wait.
    await step("B2.open", async () => void (await openAndPay("B2", s, 5)));
    await step("B2.close", () => closeAlone("B2", true));
    await step("B3.open", async () => void (await openAndPay("B3", s, 4)));
    await step("B3.close", () => closeAlone("B3", false));
    await step("B1.open", async () => void (await openAndPay("B1", s, 10)));
    await step("B1.close", () => closeAlone("B1", false));
    await step("B3.settle", async () => void (await serverSettles("B3", s)));
    await step("B1.settle", () => scenarioB1Settle(s));
    await scenarioA(s);
    await step("B3.end", () => scenarioB3End(s));
    await step("B2.elapse", () => scenarioB2Elapse(s));
  } finally {
    await s.close();
  }
  // What the run left, once: a `run` after the sweep has nothing to do and must not overwrite it.
  if (!state().after) {
    await sleep(25_000); // Blockfrost's address index trails a block
    const after = await snapshot("after");
    record((st) => (st.after = after));
  }
}

// ---- report ------------------------------------------------------------------------------------------------

interface TxFacts {
  hash: string;
  block: number;
  size: number;
  fee: bigint;
  redeemers: Array<{ purpose: string; index: number; mem: bigint; steps: bigint }>;
  io: BfUtxos;
}

async function txFacts(hash: string): Promise<TxFacts> {
  const t = (await bf(`/txs/${hash}`)) as { block_height: number; size: number; fees: string };
  const io = (await bf(`/txs/${hash}/utxos`)) as BfUtxos;
  const rs = (await bf(`/txs/${hash}/redeemers`).catch(() => [])) as Array<{ tx_index: number; purpose: string; unit_mem: string; unit_steps: string }>;
  return { hash, block: t.block_height, size: t.size, fee: BigInt(t.fees), redeemers: rs.map((r) => ({ purpose: r.purpose, index: r.tx_index, mem: BigInt(r.unit_mem), steps: BigInt(r.unit_steps) })), io };
}

const quantity = (amount: Array<{ unit: string; quantity: string }>, unit: string) => BigInt(amount.find((a) => a.unit === unit)?.quantity ?? "0");

/** A transaction's required signers and the keys that signed it, from its CBOR as Blockfrost keeps it; undefined when it will not say. */
async function signersOf(hash: string): Promise<{ required: string[]; witnesses: string[] } | undefined> {
  try {
    // One try: an endpoint that is not there is a 404, which `bf` would ask for again ten times.
    const res = await fetch(`${BF_BASE}/txs/${hash}/cbor`, { headers: { project_id: projectId } });
    if (!res.ok) return undefined;
    const r = (await res.json()) as { cbor?: string };
    if (!r.cbor) return undefined;
    const tx = Transaction.fromCBORHex(r.cbor);
    return { required: (tx.body.requiredSigners ?? []).map((k) => KeyHash.toHex(k)), witnesses: (tx.witnessSet.vkeyWitnesses ?? []).map((w) => KeyHash.toHex(KeyHash.fromVKey(w.vkey))) };
  } catch {
    return undefined;
  }
}

async function phaseReport() {
  const st = state();
  const names: Record<string, string> = {};
  const keys: Record<string, string> = {};
  for (const [name, i] of Object.entries(ACCOUNT)) {
    const a = await wallet(i).address();
    names[Address.toBech32(a)] = name === "seller" ? "seller (payTo, provider)" : name === "sponsor" ? "sponsor key" : name;
    keys[keyHashHex(a)] = name;
  }
  const payTo = Address.toBech32(await provider.address());
  const nameOf = (addr: string) => names[addr] ?? (isScriptAddress(addr, SPONSORED.hash) ? "channel script" : `${addr.slice(0, 16)}…`);
  const line = (c: string) => log(c);

  line("=== transactions ===");
  const facts = new Map<string, TxFacts>();
  const all: Array<{ label: string; tx: string }> = [
    ...st.funding.map((f) => ({ label: `fund: ${f.what}`, tx: f.tx })),
    ...st.txs.map((t) => ({ label: `${t.scenario} ${t.step}${t.request ? ` (request ${t.request})` : ""}`, tx: t.tx })),
    ...st.sweeps.map((f) => ({ label: `sweep: ${f.what}`, tx: f.tx })),
  ];
  for (const { label, tx } of all) {
    const f = await txFacts(tx);
    facts.set(tx, f);
    const units = f.redeemers.map((r) => `${r.purpose}:${r.index} ${r.mem} mem ${r.steps} steps`).join("; ");
    line(`${label.padEnd(34)} ${tx} block ${f.block} size ${f.size} B fee ${ada(f.fee)}${units ? ` | ${units}` : ""}`);
  }

  line("=== R2 on chain: what each exit paid payTo ===");
  for (const t of st.txs.filter((x) => ["end", "end (provider)", "elapse"].includes(x.step))) {
    const f = facts.get(t.tx)!;
    const ch = f.io.inputs.filter((i) => !i.collateral && !i.reference && isScriptAddress(i.address, SPONSORED.hash));
    const floor = BigInt(st.channels[t.scenario]?.floor ?? "0");
    if (ch.length !== 1) {
      line(`${t.scenario} ${t.step}: expected one channel input, found ${ch.length}`);
      continue;
    }
    const ref = `${ch[0]!.tx_hash}#${ch[0]!.output_index}`;
    const want = Data.toCBORHex(repaymentDatum(ref)).toLowerCase();
    const repaid = f.io.outputs.filter((o) => !o.collateral && o.address === payTo && o.inline_datum);
    const ok = repaid.filter((o) => (o.inline_datum ?? "").toLowerCase() === want && lovelaceOf(o) >= floor);
    // What the buyer's addresses gain of tUSDM over the transaction: what the channel held, less anything that went to the server.
    const mine = (a: string) => nameOf(a) === SCENARIO_BUYER[t.scenario];
    const back =
      f.io.outputs.filter((o) => !o.collateral && mine(o.address)).reduce((s, o) => s + quantity(o.amount, UNIT), 0n) -
      f.io.inputs.filter((i) => !i.collateral && !i.reference && mine(i.address)).reduce((s, i) => s + quantity(i.amount, UNIT), 0n);
    const held = quantity(ch[0]!.amount, UNIT);
    line(`${t.scenario} ${t.step}: channel input ${ref}; ${repaid.length} output(s) at payTo with an inline datum: ${repaid.map((o) => `${lovelaceOf(o)} lovelace, datum ${o.inline_datum}`).join("; ")}; floor ${floor}; datum = the channel input's reference and lovelace >= floor: ${ok.length === 1 ? "YES" : "NO"}; the channel held ${Number(held) / 1e6} tUSDM and ${lovelaceOf(ch[0]!)} lovelace, the buyer's addresses gained ${Number(back) / 1e6} tUSDM`);
    const who = await signersOf(t.tx);
    if (who) line(`${t.scenario} ${t.step}: required signers ${who.required.map((k) => keys[k] ?? k.slice(0, 8)).join(", ") || "none"}; vkey witnesses by ${who.witnesses.map((k) => keys[k] ?? k.slice(0, 8)).join(", ")}`);
  }

  line("=== the openings' datums ===");
  for (const t of st.txs.filter((x) => x.step === "open")) {
    const f = facts.get(t.tx)!;
    const out = f.io.outputs.find((o) => isScriptAddress(o.address, SPONSORED.hash));
    if (!out?.inline_datum) continue;
    const d = parseDatum(Data.fromCBORHex(out.inline_datum), SPONSORED, 0);
    line(`${t.scenario} open ${t.tx}: channel holds ${lovelaceOf(out)} lovelace, sponsor ${d.constants.sponsor?.address}, floor ${d.constants.sponsor?.floor}; ${d.constants.sponsor?.address === payTo && d.constants.sponsor?.floor === lovelaceOf(out) ? "payTo, and the floor is the channel's whole ADA: YES" : "NOT as expected"}`);
  }

  line("=== per scenario: net per address over its transactions ===");
  for (const sc of ["A", "B1", "B2", "B3"] as const) {
    const net: Record<string, { lovelace: bigint; tusdm: bigint }> = {};
    const fees = { seller: 0n, buyer: 0n };
    for (const t of st.txs.filter((x) => x.scenario === sc)) {
      const f = facts.get(t.tx)!;
      for (const i of f.io.inputs.filter((x) => !x.collateral && !x.reference)) {
        const k = nameOf(i.address);
        net[k] ??= { lovelace: 0n, tusdm: 0n };
        net[k]!.lovelace -= lovelaceOf(i);
        net[k]!.tusdm -= quantity(i.amount, UNIT);
      }
      for (const o of f.io.outputs.filter((x) => !x.collateral)) {
        const k = nameOf(o.address);
        net[k] ??= { lovelace: 0n, tusdm: 0n };
        net[k]!.lovelace += lovelaceOf(o);
        net[k]!.tusdm += quantity(o.amount, UNIT);
      }
      fees[t.paidBy] += f.fee;
    }
    line(`${sc}:`);
    for (const [k, v] of Object.entries(net)) line(`  ${k.padEnd(26)} ${v.lovelace >= 0n ? "+" : ""}${ada(v.lovelace)} tADA  ${v.tusdm >= 0n ? "+" : ""}${Number(v.tusdm) / 1e6} tUSDM`);
    const seller = (net["seller (payTo, provider)"]?.lovelace ?? 0n) + (net["sponsor key"]?.lovelace ?? 0n);
    const buyerAda = net[SCENARIO_BUYER[sc]]?.lovelace ?? 0n;
    line(`  seller side (payTo + sponsor key) ${ada(seller)} tADA; fees it paid ${ada(fees.seller)}: ${seller === -fees.seller ? "net = minus its fees, to the lovelace" : "NOT EQUAL"}`);
    line(`  buyer ${buyerAda === 0n ? "tADA +-0" : `${ada(buyerAda)} tADA`}; fees it paid ${ada(fees.buyer)}: ${buyerAda === -fees.buyer ? (fees.buyer === 0n ? "ADA unchanged to the lovelace" : "net = minus its own fees, to the lovelace") : "NOT EQUAL"}`);
  }

  line("=== balances per account: before, after, change ===");
  if (st.before && st.after) {
    for (const [name, i] of Object.entries(ACCOUNT)) {
      const b = st.before[name]!;
      const a = st.after[name]!;
      line(`account ${i} ${name.padEnd(11)} tADA ${ada(BigInt(b.lovelace))} -> ${ada(BigInt(a.lovelace))} (${ada(BigInt(a.lovelace) - BigInt(b.lovelace))}), tUSDM ${Number(b.tusdm) / 1e6} -> ${Number(a.tusdm) / 1e6} (${(Number(a.tusdm) - Number(b.tusdm)) / 1e6}), utxos ${b.utxos} -> ${a.utxos}`);
    }
  }

  line("=== evaluated, never submitted ===");
  for (const n of st.negatives) {
    line(`${n.group} | ${n.case}: expected ${n.expect}, got ${n.outcome}${n.units ? ` (${n.units.map((u) => `${u.tag}:${u.index} ${u.mem} mem ${u.steps} steps`).join("; ")})` : ""}${n.detail ? ` ${n.detail.slice(0, 200)}` : ""}`);
  }
}

const lovelaceOf = (o: { amount: Array<{ unit: string; quantity: string }> }) => quantity(o.amount, "lovelace");

// ---- sweep ---------------------------------------------------------------------------------------------------

/** Everything of an account back to account 1 in one transaction, when the account holds the ADA to pay the fee with. */
async function phaseSweep() {
  const sellerAddr = await wallet(ACCOUNT.seller).address();
  for (const who of ["sponsor", "buyerB1", "buyerB2", "buyerB3", "buyerA"] as const) {
    const w = wallet(ACCOUNT[who]);
    const utxos = [...(await w.getWalletUtxos())];
    if (utxos.length === 0) {
      log(`${who} (account ${ACCOUNT[who]}): nothing to sweep`);
      continue;
    }
    if (!utxos.some((u) => Assets.hasOnlyLovelace(u.assets) && Assets.lovelaceOf(u.assets) >= 2_000_000n)) {
      log(`${who} (account ${ACCOUNT[who]}): holds no ADA-only UTxO to pay a fee with: it keeps its ${utxos.length} UTxO(s), ${ada(utxos.reduce((s, u) => s + Assets.lovelaceOf(u.assets), 0n))} tADA, tokens and the ADA that backs them`);
      continue;
    }
    const sb = await w.newTx().collectFrom({ inputs: utxos }).build({ changeAddress: sellerAddr, availableUtxos: [] });
    const hash = await submit(`${who} (account ${ACCOUNT[who]}) swept to account ${ACCOUNT.seller}: ${utxos.length} UTxOs`, await sb.sign(), w);
    record((s) => s.sweeps.push({ what: `account ${ACCOUNT[who]} (${who}), ${utxos.length} UTxOs, all of it to account ${ACCOUNT.seller}`, tx: hash }));
  }
  // What landed at payTo is a UTxO with an inline datum, the channel's reference (R2). It is meant to spend like any other at a
  // key address (SPONSORSHIP.md section 7): spend those, and nothing else of account 1's, into one output of its own.
  const seller = wallet(ACCOUNT.seller);
  const repayments = (await seller.getWalletUtxos()).filter((u) => u.datumOption instanceof InlineDatum.InlineDatum && Assets.hasOnlyLovelace(u.assets));
  if (repayments.length > 0) {
    const sb = await seller.newTx().collectFrom({ inputs: repayments }).build({ changeAddress: sellerAddr, availableUtxos: [] });
    const hash = await submit(`the seller spends the ${repayments.length} repayment UTxOs at payTo (each with an inline datum) into one`, await sb.sign(), seller);
    record((s) => s.sweeps.push({ what: `account ${ACCOUNT.seller}: the ${repayments.length} repayment UTxOs, ${repayments.map((u) => `${TransactionHash.toHex(u.transactionId)}#${u.index}`).join(", ")}, spent into one output of its own`, tx: hash }));
  }
  await sleep(25_000);
  const swept = await snapshot("swept");
  record((s) => (s.swept = swept));
}

// ---- HTTP plumbing -------------------------------------------------------------------------------------------

function listen(port: number, handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>): Promise<Server> {
  const srv = createServer((req, res) =>
    handler(req, res).catch((e) => {
      log(`  server ${port}: ${(e as Error).stack ?? String(e)}`);
      json(res, 500, { error: String(e) });
    }),
  );
  // 127.0.0.1 only: a wider bind makes Windows ask about its firewall.
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

run(async () => {
  const phase = process.argv[2] ?? "report";
  if (phase === "balances") await phaseBalances();
  else if (phase === "fund") await phaseFund();
  else if (phase === "run") await phaseRun();
  else if (phase === "sweep") await phaseSweep();
  else if (phase !== "report") throw new Error(`unknown phase ${phase}`);
  if (phase === "report" || phase === "run") await phaseReport();
});
