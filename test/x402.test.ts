import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPrivateKey, createPublicKey, sign as edSign, verify as edVerify } from "node:crypto";
import type { PaymentPayload, PaymentRequired, PaymentRequirements } from "@x402/core/types";
import { Assets, Client, KeyHash, TxOut, preprod, type UTxO } from "@evolution-sdk/evolution";
import { SUBBIT_HASH, channelAddress, iouBody, iouSignerFromSeed, inlineDatum, newIouSigner, parseDatum, datumData, type Stage } from "../src/subbit.ts";
import { capacityOf, channelReserve, constantsOf, datumBindingError, planTokens, type ChannelView } from "../src/x402/cardano.ts";
import type { Chain } from "../src/x402/chain.ts";
import { BatchSettlementCardanoClient, FileClientStorage, derivedIouSigner, iouRootOf } from "../src/x402/client.ts";
import { BatchSettlementCardanoServer, InMemoryChannelStorage } from "../src/x402/server.ts";
import { Err, PayloadError, configBindingError, parseClientPayload, parseExtra, type ChannelConfig } from "../src/x402/types.ts";

const PAY_TO = "addr_test1qrxchm0g4la6hqfd9wq6vuuldx7l20az52t7lvgpgujr8pvwmpzru5kuf4mpmvtaf0hlsjtz7t4r2h7tj9v3c02dhljq0wqkef";
const PROVIDER = "cd8bede8affbab812d2b81a6739f69bdf53fa2a297efb10147243385";
const TAG = "11".repeat(32);

const signer = newIouSigner();
const config: ChannelConfig = { payer: "ab".repeat(28), payerAuthorizer: signer.publicKey, receiver: PAY_TO, receiverAuthorizer: PROVIDER, token: "lovelace", withdrawDelay: 900 };
const baseReq: PaymentRequirements = {
  scheme: "batch-settlement",
  network: "cardano:preprod",
  asset: "lovelace",
  amount: "1000",
  payTo: PAY_TO,
  maxTimeoutSeconds: 300,
  extra: { scriptHash: SUBBIT_HASH, receiverAuthorizer: PROVIDER, withdrawDelay: 900 },
};
const voucher = (amount: bigint, s = signer) => ({ channelId: TAG, maxClaimableAmount: amount.toString(), signature: s.sign(TAG, amount), channelRef: `${"cd".repeat(32)}#0` });

test("the IOU test vector: Ed25519 over the validator's own serialiseData([tag, amount])", () => {
  // Private key seed 0x07 × 32; published so other implementations can check their encoding.
  const key = createPrivateKey({ key: Buffer.from("302e020100300506032b657004220420" + "07".repeat(32), "hex"), format: "der", type: "pkcs8" });
  assert.equal(Buffer.from(iouBody(TAG, 203000n)).toString("hex"), "9f5820" + TAG + "1a000318f8ff");
  assert.equal(
    edSign(null, iouBody(TAG, 203000n), key).toString("hex"),
    "d09aac1f109a70db6328acec3e83d01f9d894d6bab248b03e8689ac3818526582426262cbd8c14ec2d763696910748159405ff38ee3d049c1a3954ddfa073a08",
  );
});

test("client payloads parse strictly", () => {
  const ok = parseClientPayload({ type: "voucher", channelConfig: config, voucher: voucher(1000n) });
  assert.equal(ok.type, "voucher");
  const bad: Array<[unknown, string]> = [
    [{ type: "voucher", channelConfig: { ...config, payer: "ab" }, voucher: voucher(1000n) }, Err.payload],
    [{ type: "voucher", channelConfig: config, voucher: { ...voucher(1000n), maxClaimableAmount: "01" } }, Err.payload],
    [{ type: "voucher", channelConfig: config, voucher: { ...voucher(1000n), signature: "00" } }, Err.payload],
    [{ type: "voucher", channelConfig: config, voucher: { ...voucher(1000n), channelRef: "xyz#0" } }, Err.payload],
    [{ type: "deposit", channelConfig: config, voucher: voucher(1000n), deposit: { amount: "0", transaction: "AA==" } }, Err.payload],
    [{ type: "claim", channelConfig: config, voucher: voucher(1000n) }, Err.payloadType],
  ];
  for (const [p, reason] of bad) {
    assert.throws(() => parseClientPayload(p), (e: unknown) => e instanceof PayloadError && e.reason === reason);
  }
});

test("extra: the close period stays within 900 s – 30 days and at or above maxTimeoutSeconds", () => {
  assert.equal(parseExtra(baseReq).withdrawDelay, 900);
  for (const [delay, timeout] of [[899, 60], [2_592_001, 60], [900, 901]] as const) {
    assert.throws(
      () => parseExtra({ ...baseReq, maxTimeoutSeconds: timeout, extra: { ...baseReq.extra, withdrawDelay: delay } }),
      (e: unknown) => e instanceof PayloadError && e.reason === Err.withdrawDelayOutOfRange,
    );
  }
  assert.throws(() => parseExtra({ ...baseReq, extra: { ...baseReq.extra, scriptHash: "00" } }), (e: unknown) => e instanceof PayloadError && e.reason === Err.extra);
});

test("a channel config binds to the requirements and to the datum, field by field", () => {
  const extra = parseExtra(baseReq);
  assert.equal(configBindingError(config, baseReq, extra), undefined);
  assert.equal(configBindingError({ ...config, receiver: "addr_test1…" }, baseReq, extra), Err.receiverMismatch);
  assert.equal(configBindingError({ ...config, receiverAuthorizer: "00".repeat(28) }, baseReq, extra), Err.receiverAuthorizerMismatch);
  assert.equal(configBindingError({ ...config, token: "00".repeat(28) + ".00" }, baseReq, extra), Err.tokenMismatch);
  assert.equal(configBindingError({ ...config, withdrawDelay: 901 }, baseReq, extra), Err.withdrawDelayMismatch);

  const d = parseDatum(datumData(constantsOf(config, TAG), { kind: "opened", subbed: 0n }));
  assert.equal(datumBindingError(d, config, TAG, SUBBIT_HASH), undefined);
  assert.equal(datumBindingError(d, config, "22".repeat(32), SUBBIT_HASH), Err.channelIdMismatch);
  assert.equal(datumBindingError(d, { ...config, payerAuthorizer: newIouSigner().publicKey }, TAG, SUBBIT_HASH), Err.channelConfig);
  assert.equal(datumBindingError(d, { ...config, receiverAuthorizer: "00".repeat(28) }, TAG, SUBBIT_HASH), Err.receiverAuthorizerMismatch);
  assert.equal(datumBindingError(d, { ...config, withdrawDelay: 3600 }, TAG, SUBBIT_HASH), Err.withdrawDelayMismatch);
});

test("a token channel's reserve covers its continuing outputs, token included", () => {
  const address = channelAddress(0);
  const policy = "085c41bd155d0562653d61a847bc00b0dae291f323ed43b347419c19";
  const name = "0014df10735553444d";
  const constants = constantsOf({ ...config, token: `${policy}.${name}` }, TAG);
  const reserve = channelReserve(address, constants, 4310n);
  for (const stage of [{ kind: "opened", subbed: 0n }, { kind: "closed", subbed: 2n ** 40n, elapseAt: 1_790_000_000_000n }, { kind: "settled" }] as const) {
    for (const quantity of [1n, 5_000_000n, 2n ** 50n]) {
      const out = new TxOut.TransactionOutput({ address, assets: Assets.fromHexStrings(policy, name, quantity, reserve), datumOption: inlineDatum(constants, stage) });
      const exact = 4310n * (160n + BigInt(TxOut.toCBORBytes(out).length));
      assert.ok(reserve >= exact, `${stage.kind}, ${quantity}: reserve ${reserve} < ${exact}`);
    }
  }
});

test("capacity is cumulative, like IOUs: what is already redeemed counts toward it", () => {
  const address = channelAddress(0);
  const constants = constantsOf(config, TAG);
  const reserve = channelReserve(address, constants, 4310n);
  const view = (subbed: bigint, held: bigint) => ({ address, lovelace: held, amount: held, datum: { ownHash: SUBBIT_HASH, constants, stage: { kind: "opened", subbed } } }) as unknown as ChannelView;
  // 20,000 of room: nothing redeemed yet, then 15,000 of it redeemed and 5,000 left in the channel.
  assert.equal(capacityOf(view(0n, reserve + 20_000n), 4310n), 20_000n);
  assert.equal(capacityOf(view(15_000n, reserve + 5_000n), 4310n), 20_000n);
  const tokens = constantsOf({ ...config, token: "085c41bd155d0562653d61a847bc00b0dae291f323ed43b347419c19.0014df10735553444d" }, TAG);
  const tview = { address, lovelace: 2_133_450n, amount: 5_000n, datum: { ownHash: SUBBIT_HASH, constants: tokens, stage: { kind: "opened", subbed: 15_000n } } } as unknown as ChannelView;
  assert.equal(capacityOf(tview, 4310n), 20_000n);
});

test("token inputs: enough for what is needed, largest first, then folded up to five; the rest goes back in one output", () => {
  const policy = "085c41bd155d0562653d61a847bc00b0dae291f323ed43b347419c19";
  const name = "0014df10735553444d";
  const cur = { kind: "asset", policy, name } as const;
  const u = (tokens: bigint, lovelace = 1_900_000n) => ({ assets: Assets.fromHexStrings(policy, name, tokens, lovelace) }) as unknown as UTxO.UTxO;
  const adaOnly = { assets: Assets.fromLovelace(15_000_000n) } as unknown as UTxO.UTxO;
  const junk = { assets: Assets.merge(Assets.fromHexStrings(policy, name, 900n, 2_000_000n), Assets.fromHexStrings("ab".repeat(28), "01", 1n, 0n)) } as unknown as UTxO.UTxO;
  const wallet = [u(5n), adaOnly, u(1_000_000n), junk, u(30n), u(7n), u(2n), u(1n), u(3n)];
  const held = (x: UTxO.UTxO[]) => x.map((v) => Assets.getByUnit(v.assets, policy + name));

  // An opening needing 10,000: the big one covers it, four more are folded in; the rest goes back.
  const open = planTokens(wallet, cur, 10_000n, 0n);
  assert.deepEqual(held(open.inputs), [1_000_000n, 30n, 7n, 5n, 3n]);
  assert.equal(open.rest, 1_000_045n - 10_000n);
  // Never ADA-only UTxOs (they pay ADA and collateral) nor ones holding another token.
  assert.ok(!open.inputs.includes(adaOnly) && !open.inputs.includes(junk));
  // An end hands back 8,000 and spends nothing: up to five older outputs fold into its one.
  const end = planTokens(wallet, cur, 0n, 8_000n);
  assert.equal(end.inputs.length, 5);
  assert.equal(end.rest, 1_000_045n + 8_000n);
  // Needing more than the five largest hold takes as many as it needs.
  assert.equal(planTokens([u(1n), u(1n), u(1n), u(1n), u(1n), u(1n), u(1n)], cur, 6n, 0n).inputs.length, 6);
  assert.throws(() => planTokens(wallet, cur, 2_000_000n, 0n), /1000048 of the currency, 2000000 needed/);
});

test("the ADA reserve covers every continuing output the channel can have", () => {
  const address = channelAddress(0);
  const constants = constantsOf(config, TAG);
  const reserve = channelReserve(address, constants, 4310n);
  // Exact min-UTxO of real continuing outputs, at their own sizes.
  for (const stage of [
    { kind: "opened", subbed: 0n },
    { kind: "opened", subbed: 2n ** 40n },
    { kind: "closed", subbed: 2n ** 40n, elapseAt: 1_790_000_000_000n },
    { kind: "settled" },
  ] as const) {
    const out = new TxOut.TransactionOutput({ address, assets: Assets.fromLovelace(50_000_000n), datumOption: inlineDatum(constants, stage) });
    const exact = 4310n * (160n + BigInt(TxOut.toCBORBytes(out).length));
    assert.ok(reserve >= exact, `${stage.kind}: reserve ${reserve} < ${exact}`);
    assert.ok(reserve - exact < 100_000n, `${stage.kind}: reserve overshoots by ${reserve - exact}`);
  }
});

// ---- IOU keys a wallet can derive again, and recovery -------------------------------------

test("an IOU signer from a seed signs the test vector", () => {
  assert.equal(
    iouSignerFromSeed(new Uint8Array(32).fill(7)).sign(TAG, 203000n),
    "d09aac1f109a70db6328acec3e83d01f9d894d6bab248b03e8689ac3818526582426262cbd8c14ec2d763696910748159405ff38ee3d049c1a3954ddfa073a08",
  );
});

// The public all-zero-entropy test mnemonic; signing needs no network, so no provider is reached.
const TEST_MNEMONIC = `${"abandon ".repeat(23)}art`;
const testWallet = () => Client.make(preprod).withBlockfrost({ baseUrl: "http://127.0.0.1:9", projectId: "unused" }).withSeed({ mnemonic: TEST_MNEMONIC, accountIndex: 0 });

test("IOU keys derive again from the wallet: the same root each time, a different key per tag and network", async () => {
  const root = await iouRootOf(testWallet());
  assert.deepEqual(await iouRootOf(testWallet()), root);
  const k = derivedIouSigner(root, "cardano:preprod", TAG).publicKey;
  assert.equal(derivedIouSigner(root, "cardano:preprod", TAG).publicKey, k);
  assert.notEqual(derivedIouSigner(root, "cardano:preprod", "22".repeat(32)).publicKey, k);
  assert.notEqual(derivedIouSigner(root, "cardano:mainnet", TAG).publicKey, k);
  // Another account of the same mnemonic is another root.
  const other = Client.make(preprod).withBlockfrost({ baseUrl: "http://127.0.0.1:9", projectId: "unused" }).withSeed({ mnemonic: TEST_MNEMONIC, accountIndex: 1 });
  assert.notDeepEqual(await iouRootOf(other), root);
});

test("recover: this wallet's channels come back, usable when their IOU key derives again, and the next 402 binds one", async () => {
  const wallet = testWallet();
  const me = KeyHash.toHex((await wallet.address()).paymentCredential as KeyHash.KeyHash);
  const root = await iouRootOf(wallet);
  const address = channelAddress(0);
  const view = (tag: string, consumer: string, iouKey: string, stage: Stage, held: bigint, i: number) =>
    ({
      ref: `${"ef".repeat(32)}#${i}`,
      address,
      lovelace: held,
      amount: held,
      datum: { ownHash: SUBBIT_HASH, constants: { ...constantsOf({ ...config, payer: consumer, payerAuthorizer: iouKey }, tag), consumer }, stage },
    }) as unknown as ChannelView;
  const reserve = channelReserve(address, constantsOf(config, TAG), 4310n);
  const [a, b, c, d] = ["a1", "b2", "c3", "d4"].map((x) => x.repeat(32)) as [string, string, string, string];
  const views = [
    // Opened with a derived key: 8,000 redeemed, 12,000 of room left.
    view(a, me, derivedIouSigner(root, "cardano:preprod", a).publicKey, { kind: "opened", subbed: 8_000n }, reserve + 12_000n, 0),
    // A random key: only the exit is left.
    view(b, me, newIouSigner().publicKey, { kind: "opened", subbed: 0n }, reserve + 5_000n, 1),
    // Closed already, key derivable: it comes back closing, with its elapse_at.
    view(c, me, derivedIouSigner(root, "cardano:preprod", c).publicKey, { kind: "closed", subbed: 0n, elapseAt: 1_790_000_000_000n }, reserve + 3_000n, 2),
    // Someone else's.
    view(d, "cd".repeat(28), newIouSigner().publicKey, { kind: "opened", subbed: 0n }, reserve + 9_000n, 3),
  ];
  const chain = {
    network: "cardano:preprod",
    channels: async () => views,
    followChannel: async (ref: string) => views.find((v) => v.ref === ref),
    coinsPerUtxoByte: async () => 4310n,
  } as unknown as Chain;
  const storage = new FileClientStorage(mkdtempSync(join(tmpdir(), "recover-")));
  const client = new BatchSettlementCardanoClient({ wallet, storage, chain });

  const found = await client.recover("cardano:preprod", SUBBIT_HASH);
  assert.deepEqual(found.map((x) => [x.channelId.slice(0, 2), x.status, Boolean(x.exitOnly)]), [["a1", "open", false], ["b2", "open", true], ["c3", "closing", false]]);
  const ra = found[0]!;
  assert.equal(ra.balance, "20000");
  assert.equal(ra.chargedCumulativeAmount, "8000");
  assert.equal(ra.channelConfig.receiver, "");
  assert.equal(found[2]!.elapseAt, "1790000000000");
  // Running it again finds nothing new.
  assert.equal((await client.recover("cardano:preprod", SUBBIT_HASH)).length, 0);

  // The next 402 on this channel's terms binds it: the receiver comes from the 402, the count
  // starts from what the chain shows redeemed (a corrective 402 brings the server's), and the
  // IOU is this channel's key's.
  const made = await client.createPaymentPayload(2, baseReq);
  const p = parseClientPayload(made.payload);
  assert.equal(p.type, "voucher");
  assert.equal(p.voucher.channelId, a);
  assert.equal(p.voucher.maxClaimableAmount, "9000");
  assert.equal(p.channelConfig.receiver, PAY_TO);
  assert.ok(iouVerifierOf(views[0]!)(a, 9000n, p.voucher.signature));
  assert.equal((await storage.get(a))!.serverKey !== "", true);
  assert.equal((await storage.get(b))!.serverKey, "");
});

const iouVerifierOf = (v: ChannelView) => (tag: string, amount: bigint, sig: string) => {
  const key = createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(v.datum.constants.iouKey, "hex")]), format: "der", type: "spki" });
  return edVerify(null, iouBody(tag, amount), key, Buffer.from(sig, "hex"));
};

// ---- the server's count, through its real hooks -------------------------------------

async function serverWithChannel(balance = 1_000_000n) {
  const storage = new InMemoryChannelStorage();
  const server = new BatchSettlementCardanoServer({
    payTo: PAY_TO,
    receiverAuthorizer: PROVIDER,
    scriptHash: SUBBIT_HASH,
    storage,
    signAsProvider: async () => {
      throw new Error("not in these tests");
    },
    chain: {} as never,
  });
  const req = await server.enhancePaymentRequirements(baseReq, { x402Version: 2, scheme: "batch-settlement", network: "cardano:preprod" }, []);
  await storage.updateChannel(TAG, () => ({
    channelId: TAG,
    channelConfig: config,
    channelRef: `${"cd".repeat(32)}#0`,
    balance: balance.toString(),
    totalClaimed: "0",
    withdrawRequestedAt: 0,
    chargedCumulativeAmount: "0",
    signedMaxClaimable: "0",
    signature: "00".repeat(64),
    onchainSyncedAt: Date.now(),
    lastRequestTimestamp: Date.now(),
  }));
  return { server, storage, req };
}

const payloadFor = (req: PaymentRequirements, v: ReturnType<typeof voucher>): PaymentPayload => ({ x402Version: 2, accepted: req, payload: { type: "voucher", channelConfig: config, voucher: v } });

async function paidRequest(server: BatchSettlementCardanoServer, req: PaymentRequirements, v: ReturnType<typeof voucher>) {
  const paymentPayload = payloadFor(req, v);
  const h = server.schemeHooks;
  const before = (await h.onBeforeVerify!({ paymentPayload, requirements: req, declaredExtensions: {} } as never)) as { skip?: true; abort?: true; reason?: string; result?: { isValid: boolean; invalidReason?: string; payer?: string } } | undefined;
  if (before?.abort) return { stage: "beforeVerify" as const, reason: before.reason, paymentPayload };
  const result = before!.result!;
  if (!result.isValid) return { stage: "verify" as const, reason: result.invalidReason, paymentPayload };
  const after = (await h.onAfterVerify!({ paymentPayload, requirements: req, declaredExtensions: {}, result } as never)) as { abort?: true; reason?: string } | undefined;
  if (after?.abort) return { stage: "afterVerify" as const, reason: after.reason, paymentPayload };
  const settle = (await h.onBeforeSettle!({ paymentPayload, requirements: req, declaredExtensions: {}, phase: "after-handler" } as never)) as { skip: true; result: { success: boolean; extra: Record<string, unknown> } };
  return { stage: "settled" as const, extra: settle.result.extra, paymentPayload };
}

test("server: each voucher must be the count plus the price; the count moves only after the handler", async () => {
  const { server, storage, req } = await serverWithChannel();
  const r1 = await paidRequest(server, req, voucher(1000n));
  assert.equal(r1.stage, "settled");
  assert.equal(r1.extra!.chargedAmount, "1000");
  assert.equal((await storage.get(TAG))!.chargedCumulativeAmount, "1000");

  // The same ceiling again, and one that skips a request: both refused, with the server's state attached.
  for (const amount of [1000n, 3000n]) {
    const r = await paidRequest(server, req, voucher(amount));
    assert.equal(r.reason, Err.cumulativeAmountMismatch);
    const accepts = [structuredClone(req)];
    await server.enrichPaymentRequiredResponse({ requirements: accepts, paymentPayload: r.paymentPayload, resourceInfo: { url: "x" }, error: Err.cumulativeAmountMismatch, paymentRequiredResponse: {} as never });
    const x = accepts[0]!.extra as { channelState: { chargedCumulativeAmount: string }; voucherState: { signedMaxClaimable: string } };
    assert.equal(x.channelState.chargedCumulativeAmount, "1000");
    assert.equal(x.voucherState.signedMaxClaimable, "1000");
  }
  assert.equal((await paidRequest(server, req, voucher(2000n))).stage, "settled");
  assert.equal((await storage.get(TAG))!.chargedCumulativeAmount, "2000");
});

test("server: vouchers past capacity, signed by another key, or on a closed channel are refused locally", async () => {
  const { server, storage, req } = await serverWithChannel(1500n);
  assert.equal((await paidRequest(server, req, voucher(1000n, newIouSigner()))).reason, Err.voucherSignature);
  assert.equal((await paidRequest(server, req, voucher(1000n))).stage, "settled");
  // Past the recorded balance: the first such voucher goes to the facilitator, which reads the
  // channel for a top-up the server has not seen; the next one within 30 s is refused here.
  const h = server.schemeHooks;
  assert.equal(await h.onBeforeVerify!({ paymentPayload: payloadFor(req, voucher(2000n)), requirements: req, declaredExtensions: {} } as never), undefined);
  assert.equal((await paidRequest(server, req, voucher(2000n))).reason, Err.cumulativeExceedsBalance);
  await storage.updateChannel(TAG, (c) => ({ ...c!, balance: "10000", withdrawRequestedAt: 1_790_000_000 }));
  assert.equal((await paidRequest(server, req, voucher(2000n))).reason, Err.channelClosed);
});

test("server: with no record of a channel, the next voucher rebuilds it, the count taken from that voucher", async () => {
  const { server, storage, req } = await serverWithChannel();
  await storage.updateChannel(TAG, () => undefined);
  const paymentPayload = payloadFor(req, voucher(7000n));
  const h = server.schemeHooks;
  // No record, so nothing to verify locally: the facilitator reads the channel.
  assert.equal(await h.onBeforeVerify!({ paymentPayload, requirements: req, declaredExtensions: {} } as never), undefined);
  const result = { isValid: true, payer: config.payer, extra: { channelId: TAG, channelRef: `${"cd".repeat(32)}#0`, balance: "1000000", totalClaimed: "4000", withdrawRequestedAt: 0 } };
  assert.equal(await h.onAfterVerify!({ paymentPayload, requirements: req, declaredExtensions: {}, result } as never), undefined);
  const settle = (await h.onBeforeSettle!({ paymentPayload, requirements: req, declaredExtensions: {}, phase: "after-handler" } as never)) as { skip: true; result: { success: boolean } };
  assert.equal(settle.result.success, true);
  const rebuilt = (await storage.get(TAG))!;
  assert.equal(rebuilt.chargedCumulativeAmount, "7000");
  assert.equal(rebuilt.signedMaxClaimable, "7000");
  assert.equal(rebuilt.totalClaimed, "4000");
});

test("server: one request per channel at a time", async () => {
  const { server, req } = await serverWithChannel();
  const h = server.schemeHooks;
  const a = payloadFor(req, voucher(1000n));
  const b = payloadFor(req, voucher(1000n));
  const ra = (await h.onBeforeVerify!({ paymentPayload: a, requirements: req, declaredExtensions: {} } as never)) as { result: unknown };
  const rb = (await h.onBeforeVerify!({ paymentPayload: b, requirements: req, declaredExtensions: {} } as never)) as { result: unknown };
  assert.equal(await h.onAfterVerify!({ paymentPayload: a, requirements: req, declaredExtensions: {}, result: ra.result } as never), undefined);
  const second = (await h.onAfterVerify!({ paymentPayload: b, requirements: req, declaredExtensions: {}, result: rb.result } as never)) as { reason: string };
  assert.equal(second.reason, Err.channelBusy);
});

// ---- the client's side of the corrective 402 -------------------------------------

test("client: adopts the server's count only when the server holds this client's own voucher for it", async () => {
  const storage = new FileClientStorage(mkdtempSync(join(tmpdir(), "x402-client-")));
  const client = new BatchSettlementCardanoClient({ wallet: {} as never, storage, chain: {} as never });
  const pem = signer.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  await storage.set({ channelId: TAG, serverKey: "k", channelConfig: config, iouPrivateKeyPem: pem, channelRef: `${"cd".repeat(32)}#0`, deposit: "3000000", balance: "1000000", chargedCumulativeAmount: "4000", status: "open", openedAt: 1 });
  const corrective = (charged: bigint, signed: bigint, s = signer): PaymentRequired => ({
    x402Version: 2,
    error: Err.cumulativeAmountMismatch,
    resource: { url: "x" },
    accepts: [{ ...baseReq, extra: { ...baseReq.extra, channelState: { channelId: TAG, channelRef: `${"ef".repeat(32)}#1`, balance: "1000000", totalClaimed: "0", withdrawRequestedAt: 0, chargedCumulativeAmount: charged.toString() }, voucherState: { signedMaxClaimable: signed.toString(), signature: s.sign(TAG, signed) } } }],
  });
  const respond = (pr: PaymentRequired) => client.schemeHooks.onPaymentResponse!({ paymentPayload: {} as never, requirements: baseReq, paymentRequired: pr });

  assert.equal(await respond(corrective(3000n, 3000n, newIouSigner())), undefined, "another key's voucher");
  assert.equal(await respond(corrective(3000n, 2000n)), undefined, "count above the voucher it rests on");
  assert.equal((await storage.get(TAG))!.chargedCumulativeAmount, "4000");
  assert.deepEqual(await respond(corrective(3000n, 3000n)), { recovered: true });
  const after = (await storage.get(TAG))!;
  assert.equal(after.chargedCumulativeAmount, "3000");
  assert.equal(after.channelRef, `${"ef".repeat(32)}#1`);
});
