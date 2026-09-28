// Step 16: seller-sponsored channels on preprod (SPONSORSHIP.md). A buyer holding one UTxO of tUSDM
// and its min-ada opens a channel, pays 25 requests, tops up twice, and is refunded after the
// server's claim, every step sponsored by the seller's offer. `npm run sponsored -- fund | run |
// negatives | report`; state in out/x402-step16/.
import { rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Address, Assets, Client, Time, Transaction, TransactionBody, TransactionHash, TransactionInput, TransactionWitnessSet, TxOut, preprod } from "@evolution-sdk/evolution";
import { x402Facilitator } from "@x402/core/facilitator";
import { decodePaymentRequiredHeader, decodePaymentResponseHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import { HTTPFacilitatorClient, x402HTTPResourceServer, x402ResourceServer, type HTTPAdapter, type RoutesConfig } from "@x402/core/server";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { SUBBIT_HASH, channelAddress, inlineDatum, newIouSigner, tagFromInput } from "../../src/subbit.ts";
import { channelReserve, constantsOf, txHashOf } from "../../src/x402/cardano.ts";
import { BlockfrostChain, causeChain } from "../../src/x402/chain.ts";
import { BatchSettlementCardanoClient, FileClientStorage } from "../../src/x402/client.ts";
import { BatchSettlementCardanoFacilitator } from "../../src/x402/facilitator.ts";
import { ChannelManager } from "../../src/x402/manager.ts";
import { BatchSettlementCardanoServer, FileChannelStorage, walletProviderSigner } from "../../src/x402/server.ts";
import { SponsorPool, checkSponsoredOpen, feeFloor, offerIn, sizeWith, type FeeSponsorOffer } from "../../src/x402/sponsor.ts";
import { BF_BASE, ada, bf, keyHashHex, load, log, must, provider, run, save, submit } from "../chain.ts";

const NETWORK = "cardano:preprod";
const TUSDM = "e675b46e4d2242c991a8932a99db3044e80515ae14b4c4ccf6b3f4c9.0014df10745553444d";
const [POLICY, NAME] = TUSDM.split(".") as [string, string];
const UNIT = POLICY + NAME;
const PRICE = 100_000n; // 0.1 tUSDM a request
const CAPACITY = 1_000_000n; // 1 tUSDM a deposit: ten requests
const REQUESTS = 25;
const BUYER_USDM = 50_000_000n;
const OFFER_LOVELACE = 4_000_000n;
const OFFERS = 4;
const REFERENCE_SCRIPT = "544752f68665183e51c8ecb6e0a835543aec64a6ec8e7588d34470ddfd12cdb5#0";
const RES_PORT = 7422;
const FAC_PORT = 7423;
const URL_DATA = `http://127.0.0.1:${RES_PORT}/data`;
const ACCOUNT = { tokenFunder: 0, seller: 1, buyer: 8, sponsor: 9 } as const;

const projectId = must("BLOCKFROST_PROJECT_ID");
const mnemonic = must("WALLET_MNEMONIC");
const wallet = (accountIndex: number) => Client.make(preprod).withBlockfrost({ baseUrl: BF_BASE, projectId }).withSeed({ mnemonic, accountIndex });
const chain = new BlockfrostChain(NETWORK, BF_BASE, projectId);
// STEP16_OUT keeps a run's state elsewhere under out/, as X402_OUT does for the e2e.
const OUT = new URL(`../../out/${process.env.STEP16_OUT ?? "x402-step16"}/`, import.meta.url);
const STATE = new URL("state.json", OUT);
const dir = (name: string) => new URL(`${name}/`, OUT).pathname.replace(/^\/(\w:)/, "$1");

interface Step {
  step: string;
  request?: number;
  tx?: string;
  ms?: number;
  note?: string;
}
interface State {
  before?: Record<string, { lovelace: string; usdm: string; utxos: number }>;
  after?: Record<string, { lovelace: string; usdm: string; utxos: number }>;
  steps: Step[];
  negatives: Array<{ case: string; http?: string; facilitator?: string; seller?: string; landed: boolean }>;
  fund?: { buyer?: string; sponsor?: string };
}
const state = (): State => ({ steps: [], negatives: [], ...(load<State>(STATE) as Partial<State>) });
const record = (f: (s: State) => void) => {
  const s = state();
  f(s);
  save(STATE, s);
};

async function holdings(address: string) {
  const rows: Array<{ amount: Array<{ unit: string; quantity: string }> }> = [];
  for (let page = 1; ; page++) {
    // An address that has never held anything is a 404 to Blockfrost.
    const got = ((await bf(`/addresses/${address}/utxos?page=${page}`).catch((e: Error) => (/: 404/.test(e.message) ? [] : Promise.reject(e)))) ?? []) as typeof rows;
    rows.push(...got);
    if (got.length < 100) break;
  }
  let lovelace = 0n;
  let usdm = 0n;
  for (const r of rows) for (const a of r.amount) a.unit === "lovelace" ? (lovelace += BigInt(a.quantity)) : a.unit === UNIT ? (usdm += BigInt(a.quantity)) : 0;
  return { lovelace, usdm, utxos: rows.length };
}

async function snapshot(label: string) {
  const out: NonNullable<State["before"]> = {};
  for (const [name, i] of Object.entries(ACCOUNT)) {
    const h = await holdings(Address.toBech32(await wallet(i).address()));
    out[name] = { lovelace: h.lovelace.toString(), usdm: h.usdm.toString(), utxos: h.utxos };
    log(`${label} account ${i} ${name.padEnd(11)} ${h.utxos} utxos, ${ada(h.lovelace)} tADA, ${Number(h.usdm) / 1e6} tUSDM`);
  }
  return out;
}

// ---- fund -------------------------------------------------------------------------------

async function phaseFund() {
  const buyerAddr = await wallet(ACCOUNT.buyer).address();
  const sponsorAddr = await wallet(ACCOUNT.sponsor).address();
  if ((await holdings(Address.toBech32(buyerAddr))).utxos === 0) {
    // Account 0's tUSDM shares a UTxO with tokens strangers sent to the public test address, and
    // the change that carries them back needs more ADA than it has left: the seller lends some.
    const funder = await wallet(ACCOUNT.tokenFunder).address();
    if ((await holdings(Address.toBech32(funder))).lovelace < 8_000_000n) {
      const top = await wallet(ACCOUNT.seller).newTx().payToAddress({ address: funder, assets: Assets.fromLovelace(5_000_000n) }).build();
      await submit("token funder topped up with 5 tADA", await top.sign(), wallet(ACCOUNT.seller));
    }
    const sb = await wallet(ACCOUNT.tokenFunder)
      .newTx()
      .payToAddress({ address: buyerAddr, assets: Assets.fromHexStrings(POLICY, NAME, BUYER_USDM, 0n), autoMinUtxo: true })
      .build();
    const tx = await submit("buyer funded: 50 tUSDM and its min-ada", await sb.sign(), wallet(ACCOUNT.tokenFunder));
    record((s) => (s.fund = { ...s.fund, buyer: tx }));
  }
  // Up to OFFERS UTxOs the pool offers (3.5 to 6 ADA): a run after another starts with what that left.
  const offerable = (await wallet(ACCOUNT.sponsor).getWalletUtxos()).filter((u) => Assets.hasOnlyLovelace(u.assets) && Assets.lovelaceOf(u.assets) >= 3_500_000n && Assets.lovelaceOf(u.assets) <= 6_000_000n).length;
  if (offerable < OFFERS) {
    let tx = wallet(ACCOUNT.seller).newTx();
    for (let k = offerable; k < OFFERS; k++) tx = tx.payToAddress({ address: sponsorAddr, assets: Assets.fromLovelace(OFFER_LOVELACE) });
    const sb = await tx.build();
    const hash = await submit(`sponsor funded by the seller: ${OFFERS - offerable} × ${ada(OFFER_LOVELACE)} tADA`, await sb.sign(), wallet(ACCOUNT.seller));
    record((s) => (s.fund = { ...s.fund, sponsor: hash }));
  }
  await snapshot("funded");
}

// ---- the stack ----------------------------------------------------------------------------

async function stack() {
  const providerAddr = await provider.address();
  const payTo = Address.toBech32(providerAddr);
  const providerKeyHash = keyHashHex(providerAddr);
  const facilitator = new x402Facilitator().register(NETWORK, new BatchSettlementCardanoFacilitator(chain, { scriptHash: SUBBIT_HASH, confirmationTimeoutMs: 180_000 }));
  const facServer = await listen(FAC_PORT, async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method === "GET" && url.pathname === "/supported") return json(res, 200, facilitator.getSupported());
    if (req.method === "POST" && (url.pathname === "/verify" || url.pathname === "/settle")) {
      const { paymentPayload, paymentRequirements } = JSON.parse((await body(req)) || "{}");
      const out = url.pathname === "/verify" ? await facilitator.verify(paymentPayload, paymentRequirements) : await facilitator.settle(paymentPayload, paymentRequirements);
      const failed = (out as { isValid?: boolean }).isValid === false || (out as { success?: boolean }).success === false;
      if (failed) log(`  facilitator ${url.pathname}: ${JSON.stringify(out).slice(0, 280)}`);
      return json(res, 200, out);
    }
    json(res, 404, { error: "not found" });
  });
  const facilitatorClient = new HTTPFacilitatorClient({ url: `http://127.0.0.1:${FAC_PORT}`, timeoutMs: 400_000 });
  const storage = new FileChannelStorage(dir("server"));
  const pool = new SponsorPool({ wallet: wallet(ACCOUNT.sponsor) });
  const scheme = new BatchSettlementCardanoServer({
    payTo,
    receiverAuthorizer: providerKeyHash,
    scriptHash: SUBBIT_HASH,
    referenceScript: REFERENCE_SCRIPT,
    withdrawDelay: 900,
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
  const manager = new ChannelManager({ storage, wallet: provider, providerKeyHash, chain, facilitator: facilitatorClient, network: NETWORK, payTo, scriptHash: SUBBIT_HASH, referenceScript: REFERENCE_SCRIPT });
  return {
    payTo,
    storage,
    pool,
    manager,
    close: async () => {
      await new Promise((r) => resServer.close(r));
      await new Promise((r) => facServer.close(r));
    },
  };
}

function buyer() {
  const storage = new FileClientStorage(dir("client"));
  const scheme = new BatchSettlementCardanoClient({ wallet: wallet(ACCOUNT.buyer), storage, chain, capacity: CAPACITY, maxDeposit: 5_000_000n, iouKeys: "derived" });
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
  return { storage, scheme, pay: wrapFetchWithPayment(fetch, client) };
}

// ---- run: open, 25 requests with two top-ups, claim, refund ---------------------------------------

async function phaseRun() {
  if (!state().before) {
    const before = await snapshot("before");
    record((s) => (s.before = before));
  }
  const s = await stack();
  try {
    const b = buyer();
    for (let i = 1; i <= REQUESTS; i++) {
      const t0 = Date.now();
      const r = await b.pay(URL_DATA);
      const text = await r.text();
      const header = r.headers.get("payment-response");
      const settle = header ? decodePaymentResponseHeader(header) : undefined;
      const ms = Date.now() - t0;
      if (r.status !== 200) {
        const why = r.headers.get("payment-required") ? decodePaymentRequiredHeader(r.headers.get("payment-required")!).error : text.slice(0, 200);
        record((st) => st.steps.push({ step: "request", request: i, ms, note: `HTTP ${r.status}: ${why}` }));
        throw new Error(`request ${i}: HTTP ${r.status} ${why}`);
      }
      const onChain = settle?.transaction ? settle.transaction : undefined;
      const step = onChain ? (i === 1 ? "open" : "top-up") : "voucher";
      if (onChain || i % 5 === 0) log(`request ${i}: ${step}${onChain ? ` ${onChain}` : ""} in ${(ms / 1000).toFixed(1)} s`);
      record((st) => st.steps.push({ step, request: i, ...(onChain ? { tx: onChain } : {}), ms }));
    }
    // On the same stack: a second one in this process, on the same ports, met a pooled connection
    // to the first one's facilitator and failed its `/supported` with ECONNRESET.
    await finish(s);
  } finally {
    await s.close();
  }
  await snapshotAfter();
}

/** The server redeems what it charged, then the buyer takes the rest back. Resumes where a run stopped. */
async function phaseFinish() {
  const s = await stack();
  try {
    await finish(s);
  } finally {
    await s.close();
  }
  await snapshotAfter();
}

async function finish(s: Awaited<ReturnType<typeof stack>>) {
  let b = buyer();
  for (const c of await s.manager.claim()) {
    record((st) => st.steps.push({ step: "claim", tx: c.transaction }));
    log(`claim: ${c.transaction}, ${c.channels.map((r) => `${r.channelId.slice(0, 16)}… +${r.taken}`).join(", ")}`);
  }
  if (process.env.STEP16_RECOVER === "1") {
    // The buyer loses its channel records and finds the channel again on chain. Its opening shows
    // whose the reserve is, and the refund goes as it would have with the records.
    rmSync(dir("client"), { recursive: true, force: true });
    b = buyer();
    await new Promise((r) => setTimeout(r, 25_000)); // the claim's block, in Blockfrost's index
    const found = await b.scheme.recover(NETWORK, SUBBIT_HASH);
    const said = found.map((c) => `${c.channelId.slice(0, 16)}… ${c.status}, reserve ${c.reserveFrom === "seller" ? "the seller's" : "the buyer's"}`).join("; ");
    log(`recovered: ${said || "nothing"}`);
    record((st) => st.steps.push({ step: "recover", note: said }));
  }
  const ch = (await b.storage.list()).find((c) => c.status === "open");
  if (!ch) throw new Error("no open channel to refund");
  const t0 = Date.now();
  const settle = await b.scheme.refund(URL_DATA, fetch, ch.channelId);
  record((st) => st.steps.push({ step: "refund", tx: settle.transaction, ms: Date.now() - t0 }));
  log(`refund: ${settle.transaction} in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
}

async function snapshotAfter() {
  await new Promise((r) => setTimeout(r, 25_000)); // Blockfrost's address index trails a block
  const after = await snapshot("after");
  record((s) => (s.after = after));
}

// ---- negatives: crafted openings the seller must not sign, never broadcast ------------------------

async function phaseNegatives() {
  const s = await stack();
  try {
    const w = wallet(ACCOUNT.buyer);
    const me = await w.address();
    const payTo = Address.fromBech32(s.payTo);
    const providerKh = keyHashHex(await provider.address());
    const fees = await chain.feeParameters();
    const cpb = await chain.coinsPerUtxoByte();
    const identity = await s.pool.identity();
    const bu = (await w.getWalletUtxos()).find((u) => Assets.getByUnit(u.assets, UNIT) >= 1_000_000n);
    if (!bu) throw new Error("the buyer holds no tUSDM UTxO");
    const buRef = `${TransactionHash.toHex(bu.transactionId)}#${bu.index}`;
    const own = Assets.lovelaceOf(bu.assets);
    const toks = Assets.getByUnit(bu.assets, UNIT);
    const D = 1_000_000n;
    const input = (ref: string) => new TransactionInput.TransactionInput({ transactionId: TransactionHash.fromHex(ref.split("#")[0]!), index: BigInt(ref.split("#")[1]!) });

    const fresh = async () => {
      const r = await fetch(URL_DATA);
      return decodePaymentRequiredHeader(r.headers.get("payment-required")!).accepts[0] as PaymentRequirements;
    };
    /** An opening of 1 tUSDM on the offer, as the client builds it, with `change` applied; fee sized for both witnesses. */
    const craft = (o: FeeSponsorOffer, change: (p: { outputs: TxOut.TransactionOutput[]; fee: bigint }) => { outputs: TxOut.TransactionOutput[]; fee: bigint } = (p) => p) => {
      const tag = tagFromInput(input(buRef));
      const iou = newIouSigner();
      const config = { payer: keyHashHex(me), payerAuthorizer: iou.publicKey, receiver: s.payTo, receiverAuthorizer: providerKh, token: TUSDM, withdrawDelay: 900 };
      const constants = constantsOf(config, tag);
      const address = channelAddress(0);
      const reserve = channelReserve(address, constants, cpb);
      const S = BigInt(o.lovelace);
      const ttl = Time.unixTimeToSlot(BigInt(Math.min(Date.now() + 240_000, Number(o.expiresAt) - 5_000)), preprod.slotConfig);
      const draft = (fee: bigint) => {
        const p = change({
          outputs: [
            new TxOut.TransactionOutput({ address: me, assets: Assets.fromHexStrings(POLICY, NAME, toks - D, own) }),
            new TxOut.TransactionOutput({ address, assets: Assets.fromHexStrings(POLICY, NAME, D, reserve), datumOption: inlineDatum(constants, { kind: "opened", subbed: 0n }) }),
            new TxOut.TransactionOutput({ address: payTo, assets: Assets.fromLovelace(S - reserve - fee) }),
          ],
          fee,
        });
        return Transaction.toCBORHex(
          new Transaction.Transaction({
            body: new TransactionBody.TransactionBody({ inputs: [input(buRef), input(o.input)], outputs: p.outputs, fee: p.fee, ttl }),
            witnessSet: TransactionWitnessSet.empty(),
            isValid: true,
            auxiliaryData: null,
          }),
        );
      };
      let fee = 250_000n;
      for (let k = 0; k < 3; k++) fee = feeFloor(sizeWith(draft(fee), 2), fees);
      return { hex: draft(fee), config, iou, tag, reserve };
    };
    const signed = async (hex: string) => Transaction.addVKeyWitnessesHex(hex, TransactionWitnessSet.toCBORHex(await w.signTx(hex, { utxos: [bu] })));
    const payloadOf = (accepted: PaymentRequirements, c: ReturnType<typeof craft>, hex: string): PaymentPayload =>
      ({
        x402Version: 2,
        accepted,
        payload: { type: "deposit", channelConfig: c.config, voucher: { channelId: c.tag, maxClaimableAmount: PRICE.toString(), signature: c.iou.sign(c.tag, PRICE) }, deposit: { amount: D.toString(), transaction: Buffer.from(hex, "hex").toString("base64") } },
      }) as PaymentPayload;
    const landed = async (hex: string) => (await fetch(`${BF_BASE}/txs/${txHashOf(hex)}`, { headers: { project_id: projectId } })).status === 200;

    const tryCase = async (name: string, change: Parameters<typeof craft>[1]) => {
      const accepted = await fresh();
      const o = offerIn(accepted.extra)!;
      const c = craft(o, change);
      const hex = await signed(c.hex);
      const payload = payloadOf(accepted, c, hex);
      const r = await fetch(URL_DATA, { headers: { "PAYMENT-SIGNATURE": encodePaymentSignatureHeader(payload) } });
      const pr = r.headers.get("payment-required");
      const http = r.status === 200 ? "200 (PAID!)" : `${r.status} ${pr ? decodePaymentRequiredHeader(pr).error : ""}`;
      const fv = await (await fetch(`http://127.0.0.1:${FAC_PORT}/verify`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ paymentPayload: payload, paymentRequirements: accepted }) })).json();
      const facilitator = fv.isValid ? "valid" : `${fv.invalidReason}`;
      const sr = await checkSponsoredOpen({ txHex: hex, offer: o, network: NETWORK, payTo: s.payTo, sponsorKeyHash: identity.keyHash, ownerOf: async (ref) => (ref === buRef ? { exists: true, paymentKeyHash: keyHashHex(me) } : { exists: true }), fees, missingWitnesses: 1, scriptHash: SUBBIT_HASH, reserve: c.reserve });
      const seller = sr.ok ? "passes" : `${sr.rule}: ${sr.detail.replace(/^S\d: /, "").slice(0, 90)}`;
      const l = await landed(hex);
      log(`negative ${name}: HTTP ${http} | facilitator ${facilitator} | seller ${seller} | landed ${l}`);
      record((st) => st.negatives.push({ case: name, http, facilitator, seller, landed: l }));
    };

    await tryCase("open: 0.1 tADA more in the channel than its reserve", (p) => {
      const ch = p.outputs[1]!;
      return { ...p, outputs: [p.outputs[0]!, new TxOut.TransactionOutput({ address: ch.address, assets: Assets.withLovelace(ch.assets, Assets.lovelaceOf(ch.assets) + 100_000n), datumOption: ch.datumOption }), new TxOut.TransactionOutput({ address: payTo, assets: Assets.fromLovelace(Assets.lovelaceOf(p.outputs[2]!.assets) - 100_000n) })] };
    });
    await tryCase("open: 0.1 tADA of the sponsor's to the buyer", (p) => ({
      ...p,
      outputs: [new TxOut.TransactionOutput({ address: me, assets: Assets.fromHexStrings(POLICY, NAME, toks - D, own + 100_000n) }), p.outputs[1]!, new TxOut.TransactionOutput({ address: payTo, assets: Assets.fromLovelace(Assets.lovelaceOf(p.outputs[2]!.assets) - 100_000n) })],
    }));
    await tryCase("open: a fee over maxFee (0.51 tADA)", (p) => ({ outputs: [p.outputs[0]!, p.outputs[1]!, new TxOut.TransactionOutput({ address: payTo, assets: Assets.fromLovelace(Assets.lovelaceOf(p.outputs[2]!.assets) + p.fee - 510_000n) })], fee: 510_000n }));

    // F3: a well-formed sponsored opening sent straight to the facilitator's /settle, no seller witness.
    const accepted = await fresh();
    const o = offerIn(accepted.extra)!;
    const c = craft(o);
    const hex = await signed(c.hex);
    const out = await (await fetch(`http://127.0.0.1:${FAC_PORT}/settle`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ paymentPayload: payloadOf(accepted, c, hex), paymentRequirements: accepted }) })).json();
    await new Promise((r) => setTimeout(r, 20_000));
    const l = await landed(hex);
    log(`negative F3 settle without the seller's witness: ${out.success ? "SETTLED!" : `${out.errorReason}: ${out.errorMessage}`} | landed ${l}`);
    record((st) => st.negatives.push({ case: "F3: /settle without the seller's witness", facilitator: out.success ? "settled" : `${out.errorReason}: ${String(out.errorMessage).slice(0, 80)}`, landed: l }));
  } finally {
    await s.close();
  }
}

// ---- report ------------------------------------------------------------------------------------------

async function phaseReport() {
  const st = state();
  const names: Record<string, string> = {};
  for (const [name, i] of Object.entries(ACCOUNT)) names[Address.toBech32(await wallet(i).address())] = name;
  const net: Record<string, { lovelace: bigint; usdm: bigint }> = {};
  const add = (addr: string, l: bigint, u: bigint) => {
    const k = names[addr] ?? (addr.startsWith("addr_test1w") || addr.startsWith("addr_test1z") ? "channel script" : addr.slice(0, 18));
    net[k] ??= { lovelace: 0n, usdm: 0n };
    net[k].lovelace += l;
    net[k].usdm += u;
  };
  const q = (amount: Array<{ unit: string; quantity: string }>, unit: string) => BigInt(amount.find((a) => a.unit === unit)?.quantity ?? "0");
  const fees: Record<string, bigint> = {};
  for (const step of st.steps.filter((x) => x.tx)) {
    const u = (await bf(`/txs/${step.tx}/utxos`)) as { inputs: Array<{ address: string; amount: Array<{ unit: string; quantity: string }>; collateral: boolean; reference: boolean }>; outputs: Array<{ address: string; amount: Array<{ unit: string; quantity: string }>; collateral: boolean }> };
    const t = (await bf(`/txs/${step.tx}`)) as { fees: string; size: number; block_height: number };
    for (const i of u.inputs.filter((x) => !x.collateral && !x.reference)) add(i.address, -q(i.amount, "lovelace"), -q(i.amount, UNIT));
    for (const o of u.outputs.filter((x) => !x.collateral)) add(o.address, q(o.amount, "lovelace"), q(o.amount, UNIT));
    fees[step.step] = (fees[step.step] ?? 0n) + BigInt(t.fees);
    log(`${step.step.padEnd(8)}${step.request ? ` #${step.request}`.padEnd(5) : "     "} ${step.tx} fee ${ada(BigInt(t.fees))} size ${t.size} B block ${t.block_height}${step.ms ? ` (${(step.ms / 1000).toFixed(1)} s)` : ""}`);
  }
  log(`fees: ${Object.entries(fees).map(([k, v]) => `${k} ${ada(v)}`).join(", ")}`);
  log("net per address over those transactions:");
  for (const [k, v] of Object.entries(net)) log(`  ${k.padEnd(14)} ${v.lovelace >= 0n ? "+" : ""}${ada(v.lovelace)} tADA  ${v.usdm >= 0n ? "+" : ""}${Number(v.usdm) / 1e6} tUSDM`);
  const sellerSide = (net.seller?.lovelace ?? 0n) + (net.sponsor?.lovelace ?? 0n);
  log(`seller (payTo + sponsor) net ADA ${ada(sellerSide)}; fees on the sponsored steps ${ada((fees.open ?? 0n) + (fees["top-up"] ?? 0n) + (fees.refund ?? 0n))}, claim fee ${ada(fees.claim ?? 0n)}`);
  if (st.before && st.after) for (const who of ["buyer", "sponsor", "seller"] as const) log(`${who}: tADA ${ada(BigInt(st.before[who]!.lovelace))} → ${ada(BigInt(st.after[who]!.lovelace))}, tUSDM ${Number(st.before[who]!.usdm) / 1e6} → ${Number(st.after[who]!.usdm) / 1e6}, utxos ${st.before[who]!.utxos} → ${st.after[who]!.utxos}`);
  for (const n of st.negatives) log(`negative ${n.case}: ${n.http ?? "-"} | ${n.facilitator ?? "-"} | ${n.seller ?? "-"} | landed ${n.landed}`);
}

// ---- HTTP plumbing -------------------------------------------------------------------------------------

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

run(async () => {
  const phase = process.argv[2] ?? "report";
  if (phase === "fund") await phaseFund();
  else if (phase === "run") await phaseRun();
  else if (phase === "finish") await phaseFinish();
  else if (phase === "negatives") await phaseNegatives();
  else if (phase !== "report") throw new Error(`unknown phase ${phase}`);
  if (phase === "report" || phase === "run" || phase === "finish") await phaseReport();
});
