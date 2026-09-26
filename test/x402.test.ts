import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPrivateKey, createPublicKey, sign as edSign, verify as edVerify } from "node:crypto";
import type { PaymentPayload, PaymentRequired, PaymentRequirements } from "@x402/core/types";
import { Address, Assets, Client, KeyHash, TransactionHash, TxOut, preprod, type Transaction, type UTxO } from "@evolution-sdk/evolution";
import { SUBBIT_HASH, channelAddress, iouBody, iouSignerFromSeed, inlineDatum, newIouSigner, parseDatum, datumData, type Stage } from "../src/subbit.ts";
import { capacityOf, channelReserve, constantsOf, datumBindingError, planTokens, refOf, type ChannelView } from "../src/x402/cardano.ts";
import { BlockfrostChain, isNetworkError, retryQueries, type Chain, type ChainCursor } from "../src/x402/chain.ts";
import { ChannelManager, type WatchEvent } from "../src/x402/manager.ts";
import { BatchSettlementCardanoClient, FileClientStorage, TOP_UP_HEADROOM, adaOnlyAfter, assertLeavesCollateral, collateralTarget, depositWithin, derivedIouSigner, firstThatBuilds, iouRootOf, serverKey, topUpAmounts, type Authorization, type OwnOutput, type SeedWallet } from "../src/x402/client.ts";
import { BatchSettlementCardanoServer, InMemoryChannelStorage } from "../src/x402/server.ts";
import { BatchSettlementCardanoFacilitator } from "../src/x402/facilitator.ts";
import { Err, PayloadError, checkDelegationMac, configBindingError, delegationMac, parseClaimPayload, parseClientPayload, parseExtra, type ChannelConfig } from "../src/x402/types.ts";

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

test("a claim for the facilitator to build names each channel's position and voucher, and carries the server's MAC", () => {
  const entry = { channelId: TAG, totalClaimed: "5000", channelRef: `${"cd".repeat(32)}#0`, voucher: { maxClaimableAmount: "6000", signature: "ab".repeat(64) } };
  const body = { type: "claim", claims: [entry] };
  const payload = { ...body, delegationMac: delegationMac("s3cret", PAY_TO, body) };
  assert.deepEqual(parseClaimPayload(payload), payload);
  assert.throws(() => parseClaimPayload({ type: "claim", claims: [{ channelId: TAG, totalClaimed: "5000" }] }), PayloadError);
  // The MAC holds for the same content in any key order, and for nothing else.
  const reordered = { delegationMac: payload.delegationMac, claims: [{ voucher: { signature: entry.voucher.signature, maxClaimableAmount: "6000" }, channelRef: entry.channelRef, totalClaimed: "5000", channelId: TAG }], type: "claim" };
  assert.ok(checkDelegationMac("s3cret", PAY_TO, reordered));
  assert.ok(!checkDelegationMac("other", PAY_TO, payload));
  assert.ok(!checkDelegationMac("s3cret", "addr_test1vqsomewhereelse", payload));
  assert.ok(!checkDelegationMac("s3cret", PAY_TO, { ...payload, claims: [{ ...entry, totalClaimed: "1000" }] }));
  assert.ok(!checkDelegationMac("s3cret", PAY_TO, body));
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

test("collateral: the largest target the SDK's pick of up to three ADA-only inputs can return change from", () => {
  const ada = (...xs: bigint[]) => xs.map((x) => ({ assets: Assets.fromLovelace(x) }) as unknown as UTxO.UTxO);
  assert.equal(collateralTarget(ada(30_000_000n)), 5_000_000n);
  assert.equal(collateralTarget(ada(2_500_000n)), 1_500_000n);
  // Three small ones: all three go in, 1 ADA comes back.
  assert.equal(collateralTarget(ada(1_877_274n, 1_800_000n, 1_700_000n, 1_000_000n)), 4_377_274n);
  assert.equal(collateralTarget(ada(1_900_000n, 1_900_000n)), 2_800_000n);
  assert.equal(collateralTarget(ada(1_500_000n, 1_500_000n)), 2_000_000n);
  // Each input after the first must bring over 1 ADA: three of 0.7 never leave 1 ADA to return.
  assert.throws(() => collateralTarget(ada(700_000n, 700_000n, 700_000n)), /no ADA-only UTxOs large enough/);
  // A big one covers the cap alone; adding the small ones would not be taken anyway.
  assert.equal(collateralTarget(ada(6_000_000n, 500_000n, 500_000n)), 5_000_000n);
  assert.throws(() => collateralTarget(ada(1_500_000n)), /no ADA-only UTxOs large enough/);
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

test("server: a retry of the latest voucher gets the same answer, charged once; an earlier voucher gets the corrective 402", async () => {
  const { server, storage, req } = await serverWithChannel();
  const h = server.schemeHooks;
  const pay = async (amount: bigint, body?: string) => {
    const r = await paidRequest(server, req, voucher(amount));
    if (r.stage === "settled" && body) {
      const result = { success: true, transaction: "", network: req.network, extra: r.extra };
      await server.enrichSettlementResponse({ paymentPayload: r.paymentPayload, requirements: req, declaredExtensions: {}, phase: "after-handler", result, transportContext: { responseBody: Buffer.from(body) } } as never);
    }
    return r;
  };
  await pay(1000n, '{"n":1}');
  await pay(2000n, '{"n":2}');
  // The voucher for 2,000 again, as a client sends it when the response never reached it.
  const again = payloadFor(req, voucher(2000n));
  const before = (await h.onBeforeVerify!({ paymentPayload: again, requirements: req, declaredExtensions: {} } as never)) as { skip?: true };
  assert.equal(before?.skip, true);
  const after = (await h.onAfterVerify!({ paymentPayload: again, requirements: req, declaredExtensions: {}, result: { isValid: true, payer: config.payer } } as never)) as { skipHandler?: true; response?: { body: unknown } };
  assert.equal(after?.skipHandler, true);
  assert.deepEqual(after?.response?.body, { n: 2 });
  const settled = (await h.onBeforeSettle!({ paymentPayload: again, requirements: req, declaredExtensions: {}, phase: "after-handler" } as never)) as unknown as { skip: true; result: { extra: { chargedAmount: string } } };
  assert.equal(settled.result.extra.chargedAmount, "1000");
  assert.equal((await storage.get(TAG))!.chargedCumulativeAmount, "2000");
  // An earlier voucher is stale: the corrective 402, not an old answer.
  assert.equal((await paidRequest(server, req, voucher(1000n))).reason, Err.cumulativeAmountMismatch);
  // The next one is charged as usual.
  assert.equal((await pay(3000n)).stage, "settled");
  assert.equal((await storage.get(TAG))!.chargedCumulativeAmount, "3000");
});

test("server: over MCP a retry gets the tool's result again when @x402/mcp can give it back unchanged", async () => {
  const { server, storage, req } = await serverWithChannel();
  const h = server.schemeHooks;
  let n = 0;
  // A paid request whose tool returned `result`, then the same voucher again, as a client sends
  // it when the answer never reached it: what does the retry get?
  const retry = async (result: unknown) => {
    const amount = BigInt(++n) * 1000n;
    const r = await paidRequest(server, req, voucher(amount));
    assert.equal(r.stage, "settled");
    const settled = { success: true, transaction: "", network: req.network, extra: r.extra };
    await server.enrichSettlementResponse({ paymentPayload: r.paymentPayload, requirements: req, declaredExtensions: {}, phase: "after-handler", result: settled, transportContext: { toolName: "quote", arguments: {}, meta: {}, result } } as never);
    const again = payloadFor(req, voucher(amount));
    const before = (await h.onBeforeVerify!({ paymentPayload: again, requirements: req, declaredExtensions: {} } as never)) as { skip?: true; reason?: string };
    if (!before?.skip) return { replayed: false as const, reason: before?.reason };
    const after = (await h.onAfterVerify!({ paymentPayload: again, requirements: req, declaredExtensions: {}, result: { isValid: true, payer: config.payer } } as never)) as { skipHandler?: true; response?: { body: unknown } };
    await h.onBeforeSettle!({ paymentPayload: again, requirements: req, declaredExtensions: {}, phase: "after-handler" } as never);
    assert.equal(after?.skipHandler, true);
    return { replayed: true as const, body: after?.response?.body };
  };

  // One text block: the body is its text, which @x402/mcp turns back into that block.
  assert.deepEqual(await retry({ content: [{ type: "text", text: '{"price":"0.2380"}' }] }), { replayed: true, body: '{"price":"0.2380"}' });
  // Structured content with its JSON as the block: the body is the object.
  const s = { price: "0.2380", n: 2 };
  assert.deepEqual(await retry({ content: [{ type: "text", text: JSON.stringify(s) }], structuredContent: s }), { replayed: true, body: s });
  assert.equal((await storage.get(TAG))!.chargedCumulativeAmount, "2000", "each charged once");

  // Shapes a replay would change are not kept: the retry gets the corrective 402 and pays again.
  for (const result of [
    { content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] },
    { content: [{ type: "image", data: "AA==", mimeType: "image/png" }] },
    { content: [{ type: "text", text: "{}" }], structuredContent: { other: true } },
    { content: [{ type: "text", text: "x", annotations: { audience: ["user"] } }] },
    { content: [{ type: "text", text: "x" }], _meta: { mine: 1 } },
  ]) {
    assert.deepEqual(await retry(result), { replayed: false, reason: Err.cumulativeAmountMismatch }, JSON.stringify(result));
  }
});

test("facilitator: a retry after settlement_pending only waits again, though its transaction has moved the channel on", async () => {
  const f = new BatchSettlementCardanoFacilitator({} as Chain, { scriptHash: SUBBIT_HASH });
  const inside = f as unknown as { check: () => Promise<unknown>; settleDeposit: () => Promise<unknown> };
  let checks = 0;
  // The first check passes. By the retry the top-up has landed, and a second check would refuse it.
  inside.check = async () => (++checks === 1 ? { ok: true, payer: config.payer, extra: {} } : { ok: false, reason: Err.depositTransaction, message: "the top-up does not spend the channel at its current position" });
  const tx = "cc".repeat(32);
  const outcomes = [
    { success: false, errorReason: "settlement_pending", transaction: tx, network: baseReq.network },
    { success: true, transaction: tx, network: baseReq.network },
  ];
  inside.settleDeposit = async () => outcomes.shift();
  const payload = { x402Version: 2, accepted: baseReq, payload: { type: "deposit", channelConfig: config, voucher: voucher(2000n), deposit: { amount: "10000", transaction: "AAAA" } } } as unknown as PaymentPayload;
  assert.equal((await f.settle(payload, baseReq)).errorReason, "settlement_pending");
  assert.equal((await f.settle(payload, baseReq)).success, true);
  assert.equal(checks, 1, "the retry kept the first check");
  // Anything else is checked as before: a payload that differs, or the same one once it has settled.
  const other = { ...payload, payload: { ...(payload.payload as object), voucher: voucher(3000n) } } as PaymentPayload;
  assert.equal((await f.settle(other, baseReq)).success, false);
  assert.equal((await f.settle(payload, baseReq)).success, false);
  assert.equal(checks, 3);
});

test("watcher, following: after one full read a quiet pass costs one query; closes and exits come from the transactions themselves", async () => {
  const storage = new InMemoryChannelStorage();
  const A = "a1".repeat(32);
  const B = "b2".repeat(32);
  const refA = `${"0a".repeat(32)}#0`;
  const refB = `${"0b".repeat(32)}#0`;
  const record = (id: string, ref: string) => ({ channelId: id, channelConfig: config, channelRef: ref, balance: "20000", totalClaimed: "3000", withdrawRequestedAt: 0, chargedCumulativeAmount: "3000", signedMaxClaimable: "3000", signature: "00".repeat(64), onchainSyncedAt: Date.now(), lastRequestTimestamp: Date.now() });
  await storage.updateChannel(A, () => record(A, refA));
  await storage.updateChannel(B, () => record(B, refB));
  const view = (tag: string, ref: string, stage: Stage) => ({ ref, datum: { constants: constantsOf(config, tag), stage } }) as unknown as ChannelView;
  const calls = { follow: 0, activity: 0, moves: 0 };
  let activity: ChainCursor[] = [];
  const moves = new Map<string, { spent: string[]; channels?: ChannelView[] }>();
  const chain = {
    followChannel: async (ref: string, _s: string, tag: string) => {
      calls.follow++;
      return view(tag, ref, { kind: "opened", subbed: 3000n });
    },
    tipHeight: async () => 100,
    txHeight: async () => 90,
    scriptTip: async () => ({ hash: "00".repeat(32), height: 1, index: 0 }),
    scriptActivity: async () => {
      calls.activity++;
      const out = activity;
      activity = [];
      return out;
    },
    channelMoves: async (hash: string, _s: string, wanted: (ref: string) => boolean) => {
      calls.moves++;
      const m = moves.get(hash)!;
      return m.spent.some(wanted) ? m : { spent: m.spent };
    },
  } as unknown as Chain;
  const manager = new ChannelManager({ storage, providerKeyHash: PROVIDER, chain, facilitator: {} as never, network: "cardano:preprod", payTo: PAY_TO, scriptHash: SUBBIT_HASH });
  const events: WatchEvent[] = [];
  const w = manager.watch({ intervalMs: 3_600_000, mode: "follow", onEvent: (e) => events.push(e) });
  try {
    await w.tick(); // the first pass reads each channel once
    await w.tick(); // nothing new at the address
    assert.deepEqual(calls, { follow: 2, activity: 1, moves: 0 });
    // Someone else's transaction; A's consumer closes (nothing is owed, so nothing to settle); B is closed out by agreement.
    const closedA = view(A, `${"1a".repeat(32)}#0`, { kind: "closed", subbed: 3000n, elapseAt: 1_790_000_000_000n });
    moves.set("t1", { spent: [`${"ff".repeat(32)}#0`] });
    moves.set("t2", { spent: [refA], channels: [closedA] });
    moves.set("t3", { spent: [refB], channels: [] });
    activity = ["t1", "t2", "t3"].map((hash, i) => ({ hash, height: 2, index: i }));
    await w.tick();
    assert.deepEqual(calls, { follow: 2, activity: 2, moves: 3 });
    assert.deepEqual(events.map((e) => e.kind), ["closed", "gone"]);
    const a = (await storage.get(A))!;
    assert.equal(a.channelRef, closedA.ref);
    assert.equal(a.anchorRef, closedA.ref);
    assert.equal(a.withdrawRequestedAt, 1_789_999_100);
    assert.equal(await storage.get(B), undefined);
    // A transaction not yet 3 blocks deep waits for a later pass.
    moves.set("t4", { spent: [closedA.ref], channels: [] });
    activity = [{ hash: "t4", height: 99, index: 0 }];
    await w.tick();
    assert.ok(await storage.get(A));
  } finally {
    w.stop();
  }
});

test("watcher, polling: rolled-back claims and closes are followed back; a record goes only once its end is deep", async () => {
  const storage = new InMemoryChannelStorage();
  const [A, B, C, D] = ["a1", "b2", "c3", "d4"].map((x) => x.repeat(32)) as [string, string, string, string];
  const pos = (x: string) => `${x.repeat(32)}#0`;
  const base = (id: string) => ({ channelId: id, channelConfig: config, channelRef: pos("0" + id[1]), anchorRef: pos("0" + id[1]), balance: "20000", totalClaimed: "0", withdrawRequestedAt: 0, chargedCumulativeAmount: "3000", signedMaxClaimable: "3000", signature: "00".repeat(64), onchainSyncedAt: Date.now(), lastRequestTimestamp: Date.now() });
  // A: a claim took it to 5,000 redeemed at a position the chain then lost. B: seen closed, the
  // close then rolled back. C: settled one block ago. D: ended by its consumer one block ago.
  await storage.updateChannel(A, () => ({ ...base(A), channelRef: pos("aa"), totalClaimed: "5000", chargedCumulativeAmount: "5000" }));
  await storage.updateChannel(B, () => ({ ...base(B), withdrawRequestedAt: 1_789_999_100 }));
  await storage.updateChannel(C, () => base(C));
  await storage.updateChannel(D, () => base(D));
  const view = (tag: string, ref: string, stage: Stage) => ({ ref, datum: { constants: constantsOf(config, tag), stage } }) as unknown as ChannelView;
  let tip = 100;
  const chain = {
    tipHeight: async () => tip,
    txHeight: async (hash: string) => ({ ["cc".repeat(32)]: 99 })[hash] ?? 50,
    followChannel: async (_ref: string, _s: string, tag: string) =>
      tag === A ? view(A, pos("01"), { kind: "opened", subbed: 2000n }) : tag === B ? view(B, pos("02"), { kind: "opened", subbed: 0n }) : tag === C ? view(C, pos("cc"), { kind: "settled" }) : undefined,
    exitOf: async () => ({ txHash: "dd".repeat(32), height: 99 }),
  } as unknown as Chain;
  const manager = new ChannelManager({ storage, providerKeyHash: PROVIDER, chain, facilitator: {} as never, network: "cardano:preprod", payTo: PAY_TO, scriptHash: SUBBIT_HASH });
  const events: WatchEvent[] = [];
  const w = manager.watch({ intervalMs: 3_600_000, onEvent: (e) => events.push(e) });
  try {
    await w.tick();
    // A is back where the chain has it, with 2,000 redeemed: claimable again, being charged 5,000.
    assert.equal((await storage.get(A))!.channelRef, pos("01"));
    assert.equal((await storage.get(A))!.totalClaimed, "2000");
    assert.equal((await manager.claimable()).map((x) => x.c.channelId).includes(A), true);
    // B takes vouchers again.
    assert.equal((await storage.get(B))!.withdrawRequestedAt, 0);
    // C and D stay while what ended them is one block deep.
    assert.ok(await storage.get(C));
    assert.ok(await storage.get(D));
    tip = 110;
    await w.tick();
    assert.equal(await storage.get(C), undefined);
    assert.equal(await storage.get(D), undefined);
    assert.deepEqual(events.map((e) => e.kind), ["reopened", "gone", "gone"]);
  } finally {
    w.stop();
  }
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

// ---- a wallet that decides what leaves it --------------------------------------

test("client: a voucher is seen by authorize before it leaves; refused, nothing is signed or recorded", async () => {
  const wallet = testWallet();
  const root = await iouRootOf(wallet);
  const key = derivedIouSigner(root, "cardano:preprod", TAG);
  const storage = new FileClientStorage(mkdtempSync(join(tmpdir(), "x402-authorize-")));
  const seen: Authorization[] = [];
  let refuse = true;
  const client = new BatchSettlementCardanoClient({
    wallet,
    storage,
    chain: {} as never,
    authorize: async (a) => {
      seen.push(a);
      if (refuse) throw new Error("over the cap");
    },
  });
  const record = {
    channelId: TAG,
    serverKey: serverKey(baseReq, parseExtra(baseReq)),
    channelConfig: { ...config, payerAuthorizer: key.publicKey },
    iouKey: "derived" as const,
    network: "cardano:preprod",
    scriptHash: SUBBIT_HASH,
    channelRef: `${"cd".repeat(32)}#0`,
    deposit: "3000000",
    balance: "1000000",
    chargedCumulativeAmount: "4000",
    status: "open" as const,
    openedAt: 1,
  };
  await storage.set(record);

  await assert.rejects(client.createPaymentPayload(2, baseReq), /over the cap/);
  assert.deepEqual(seen.map((a) => [a.kind, "amount" in a ? a.amount : undefined]), [["voucher", 5000n]]);
  assert.deepEqual(await storage.get(TAG), record, "the record is as it was");

  refuse = false;
  const p = parseClientPayload((await client.createPaymentPayload(2, baseReq)).payload);
  assert.equal(p.voucher.maxClaimableAmount, "5000");
  assert.ok(iouVerifierOf({ datum: { constants: { iouKey: key.publicKey } } } as unknown as ChannelView)(TAG, 5000n, p.voucher.signature));
  // The key was derived again for the signature; nothing on disk holds it.
  assert.equal((await storage.get(TAG))!.iouPrivateKeyPem, undefined);
});

test("client: a record naming an IOU key this wallet does not derive signs nothing", async () => {
  const storage = new FileClientStorage(mkdtempSync(join(tmpdir(), "x402-foreign-")));
  const client = new BatchSettlementCardanoClient({ wallet: testWallet(), storage, chain: {} as never });
  const ch = { channelId: TAG, serverKey: "k", channelConfig: config, iouKey: "derived" as const, network: "cardano:preprod", deposit: "1", balance: "1", chargedCumulativeAmount: "0", status: "open" as const, openedAt: 1 };
  await assert.rejects(client.signVoucher(ch, 1000n), /does not derive/);
  await assert.rejects(client.signVoucher({ ...ch, iouKey: undefined }, 1000n), /can only be closed/);
});

test("client: a deposit is what capacity asks, never under the floor, cut to what maxDeposit leaves", () => {
  assert.equal(depositWithin(50_000n, 10_000n), 50_000n);
  assert.equal(depositWithin(0n, 10_000n), 10_000n, "the floor when capacity asks less");
  assert.equal(depositWithin(50_000n, 10_000n, 30_000n), 30_000n, "cut to the room left");
  assert.equal(depositWithin(50_000n, 10_000n, 10_000n), 10_000n);
  assert.throws(() => depositWithin(50_000n, 10_000n, 9_999n), /at least 10000/);
  assert.throws(() => depositWithin(50_000n, 10_000n, -5n), /room for \(0\)/);
});

test("client: a top-up the wallet cannot fund falls back to what it can, down to this request's shortfall", async () => {
  // A 0.05 request on a channel opened for 0.01 ones asks for 100 x 0.05. A wallet showing 3.32
  // can fund 0.82 of it and still pay the fee and keep the refund's collateral.
  assert.deepEqual(topUpAmounts(5_000_000n, 50_000n, 3_320_075n - TOP_UP_HEADROOM), [5_000_000n, 820_075n, 50_000n]);
  // Showing 2.32, as a wallet can before the chain's index shows its own change: only the shortfall.
  assert.deepEqual(topUpAmounts(5_000_000n, 50_000n, 2_320_075n - TOP_UP_HEADROOM), [5_000_000n, 50_000n]);
  // Enough for what capacity asks: that, and the shortfall only as a last resort.
  assert.deepEqual(topUpAmounts(1_000_000n, 50_000n, 9_000_000n), [1_000_000n, 50_000n]);
  // What the wallet can fund does not cover the request: no point trying it.
  assert.deepEqual(topUpAmounts(5_000_000n, 50_000n, 30_000n), [5_000_000n, 50_000n]);
  assert.deepEqual(topUpAmounts(1_000n, 1_000n, 0n), [1_000n]);

  const short = (amount: bigint) => new Error(`Coin selection failed for lovelace: ${amount}`);
  const tried: bigint[] = [];
  const got = await firstThatBuilds([5_000_000n, 820_075n, 50_000n], async (a) => {
    tried.push(a);
    if (a > 1_000_000n) throw short(a);
    return `tx for ${a}`;
  });
  assert.deepEqual(got, { built: "tx for 820075", amount: 820_075n });
  assert.deepEqual(tried, [5_000_000n, 820_075n]);
  // A token the wallet holds too little of moves on the same way, and so does a top-up that would
  // leave nothing to put up as the refund's collateral.
  assert.equal((await firstThatBuilds([10n, 7n], async (a) => (a > 7n ? Promise.reject(new Error("the wallet holds 7 of the currency, 10 needed")) : "ok"))).amount, 7n);
  // Holding the amount but not the fee and a change output besides, as 5.169291 tADA against a
  // top-up of 5 did on preprod: the SDK's other way of saying the wallet is short.
  const noChange = new Error("Cannot create valid change: Insufficient funds to cover payment, fees, and minimum UTxO requirements. Available: 169291 lovelace. Required: At least 969750 lovelace for change output");
  assert.equal((await firstThatBuilds([5_000_000n, 2_669_291n], async (a) => (a > 2_669_291n ? Promise.reject(noChange) : "ok"))).amount, 2_669_291n);
  const noCollateral = (a: bigint) => new Error(`a top-up of ${a} would leave no ADA-only UTxOs large enough for the refund's collateral (left: 1230000, 900000)`);
  assert.equal((await firstThatBuilds([820_075n, 50_000n], async (a) => (a > 50_000n ? Promise.reject(noCollateral(a)) : "ok"))).amount, 50_000n);

  // What is left once a top-up is on chain: the wallet's UTxOs it did not spend and its change to
  // itself, not the channel's output nor the tokens going back.
  const me = Address.fromBech32("addr_test1qqqt0pru382hy9vjlsxv3ye02z50sfvt8xunscg5pgden77z73dpdfng2ctw2ekqplqgrljelz7h4dneac27nn3qx3rqqpavzj");
  const id = (n: number) => TransactionHash.fromHex(n.toString(16).padStart(64, "0"));
  const utxo = (n: number, lovelace: bigint) => ({ transactionId: id(n), index: 0n, assets: Assets.fromLovelace(lovelace) }) as unknown as UTxO.UTxO;
  const topUp = (spends: number[], change: bigint) =>
    ({
      body: {
        inputs: spends.map((n) => ({ transactionId: id(n), index: 0n })),
        outputs: [
          { address: channelAddress(0), assets: Assets.fromLovelace(5_000_000n) },
          { address: me, assets: Assets.fromHexStrings("085c41bd155d0562653d61a847bc00b0dae291f323ed43b347419c19", "0014df10735553444d", 5n, 1_200_000n) },
          { address: me, assets: Assets.fromLovelace(change) },
        ],
      },
    }) as unknown as Transaction.Transaction;
  const wallet = [utxo(1, 2_320_075n), utxo(2, 900_000n)];
  // Spending the 2.32 for 0.82 leaves change of about 1.23, which with the 0.9 cannot put up
  // collateral: that top-up is refused. The shortfall's leaves about 2.0, which can.
  assert.deepEqual(adaOnlyAfter(topUp([1], 1_230_000n), wallet, me), [900_000n, 1_230_000n]);
  assert.throws(() => collateralTarget(adaOnlyAfter(topUp([1], 1_230_000n), wallet, me).map((x) => ({ assets: Assets.fromLovelace(x) }) as unknown as UTxO.UTxO)), /large enough for collateral/);
  assert.equal(collateralTarget(adaOnlyAfter(topUp([1], 2_000_000n), wallet, me).map((x) => ({ assets: Assets.fromLovelace(x) }) as unknown as UTxO.UTxO)), 1_000_000n);
  assert.deepEqual(adaOnlyAfter(topUp([1, 2], 2_000_000n), wallet, me), [2_000_000n]);
  // The same check stands in front of an opening: refused with what it would leave, or let through.
  const built = (spends: number[], change: bigint) => ({ toTransaction: async () => topUp(spends, change) });
  await assert.rejects(assertLeavesCollateral(built([1], 1_230_000n), wallet, me, "an opening of 2732620"), /an opening of 2732620 would leave no ADA-only UTxOs large enough for the refund's collateral \(left: 900000, 1230000\)/);
  await assertLeavesCollateral(built([1], 2_000_000n), wallet, me, "an opening of 2732620");
  // Anything else is not a shortfall: thrown at once, with no smaller top-up tried.
  let calls = 0;
  await assert.rejects(
    firstThatBuilds([5_000_000n, 50_000n], async () => {
      calls++;
      throw new Error("Blockfrost getUtxos failed: 500");
    }),
    /getUtxos failed/,
  );
  assert.equal(calls, 1);
  // Short of even the shortfall: the last shortfall is what the caller sees.
  await assert.rejects(firstThatBuilds([5_000_000n, 50_000n], async (a) => Promise.reject(short(a))), /lovelace: 50000$/);
});

test("chain: a read that fails on the network, or with a 429 or a 5xx, is tried again; any other answer is the caller's", async () => {
  // Node's fetch when every address of the host timed out, as preprod produced it. And what the SDK
  // (0.5.14) rejects with: Effect's FiberFailure, the SDK's errors inside its cause.
  const fetchFailed = new TypeError("fetch failed", { cause: Object.assign(new AggregateError([], ""), { code: "ETIMEDOUT" }) });
  const sdkFailure = (operation: string, cause: unknown) =>
    Object.assign(new Error(`Blockfrost ${operation} failed`), {
      name: "(FiberFailure) ProviderError",
      [Symbol.for("effect/Runtime/FiberFailure/Cause")]: { _tag: "Fail", error: { _tag: "ProviderError", message: `Blockfrost ${operation} failed`, cause } },
    });
  const noAnswer = sdkFailure("evaluateTx", { _tag: "HttpRequestError", message: "POST https://x/utils/txs/evaluate/utxos failed", cause: fetchFailed });
  const scriptFailure = sdkFailure("evaluateTx", { _tag: "HttpResponseError", status: 400, message: "non 2xx status code : ScriptFailures" });
  assert.equal(isNetworkError(fetchFailed), true);
  assert.equal(isNetworkError(noAnswer), true);
  assert.equal(isNetworkError(new Error("Blockfrost /txs/ab…: 400")), false);
  assert.equal(isNetworkError(scriptFailure), false);

  const real = globalThis.fetch;
  let answers: Array<() => Response> = [];
  let calls = 0;
  globalThis.fetch = (async () => answers[calls++]!()) as typeof fetch;
  try {
    const chain = new BlockfrostChain("cardano:preprod", "https://blockfrost.invalid/api/v0", "key", 1);
    answers = [
      () => {
        throw fetchFailed;
      },
      () => new Response("", { status: 503 }),
      () => new Response(JSON.stringify({ block_height: 42 }), { status: 200 }),
    ];
    assert.equal(await chain.txHeight("ab".repeat(32)), 42);
    assert.equal(calls, 3);
    // A 404 is an answer: the transaction is not in a block yet.
    [calls, answers] = [0, [() => new Response("", { status: 404 })]];
    assert.equal(await chain.txHeight("ab".repeat(32)), undefined);
    assert.equal(calls, 1);
    // Failing every time: the last failure is the caller's, after five tries.
    calls = 0;
    answers = Array.from({ length: 5 }, () => () => {
      throw fetchFailed;
    });
    await assert.rejects(chain.txHeight("ab".repeat(32)), /fetch failed/);
    assert.equal(calls, 5);
  } finally {
    globalThis.fetch = real;
  }

  // The SDK's calls: an evaluation that got no answer is tried again, a script failure is not.
  let tries = 0;
  assert.equal(await retryQueries("an evaluation", async () => (++tries < 3 ? Promise.reject(noAnswer) : "ok"), 4, 1), "ok");
  assert.equal(tries, 3);
  tries = 0;
  await assert.rejects(
    retryQueries("an evaluation", async () => {
      tries++;
      throw scriptFailure;
    }, 4, 1),
    /evaluateTx failed/,
  );
  assert.equal(tries, 1);
});

test("client: a build waits for the wallet to list what its own transaction in a block paid back to it", async () => {
  const landed = "ab".repeat(32);
  const neverLanded = "cd".repeat(32);
  const utxo = (tx: string, index: bigint, lovelace: bigint) => ({ transactionId: TransactionHash.fromHex(tx), index, assets: Assets.fromLovelace(lovelace) }) as unknown as UTxO.UTxO;
  const old = utxo("ef".repeat(32), 0n, 1_498_491n);
  const change = utxo(landed, 1n, 1_732_968n);
  // Blockfrost lists the opening's change from the second look on.
  let lists = 0;
  const wallet = { getWalletUtxos: async () => (++lists < 2 ? [old] : [old, change]) } as unknown as SeedWallet;
  const chain = { txHeight: async (tx: string) => (tx === landed ? 5_221_695 : undefined) } as unknown as Chain;
  const client = new BatchSettlementCardanoClient({ wallet, storage: new FileClientStorage(mkdtempSync(join(tmpdir(), "x402-own-"))), chain });
  const inside = client as unknown as { ownOutputs: Map<string, OwnOutput>; available(): Promise<UTxO.UTxO[]> };
  inside.ownOutputs.set(`${landed}#1`, { tx: landed, at: Date.now() });
  inside.ownOutputs.set(`${neverLanded}#1`, { tx: neverLanded, at: Date.now() });

  assert.deepEqual((await inside.available()).map(refOf), [refOf(old), refOf(change)]);
  assert.equal(lists, 2, "read again until the change is listed");
  assert.deepEqual([...inside.ownOutputs.keys()], [`${neverLanded}#1`], "listed now, so no longer waited for; the other stays until it lands or expires");
  // A transaction not in a block has nothing to wait for.
  lists = 0;
  await inside.available();
  assert.equal(lists, 1);
});

test("client: right after its own top-up, it waits for the chain's index instead of topping up again", async () => {
  const wallet = testWallet();
  const key = derivedIouSigner(await iouRootOf(wallet), "cardano:preprod", TAG);
  const cfg = { ...config, payerAuthorizer: key.publicKey };
  const address = channelAddress(0);
  const reserve = channelReserve(address, constantsOf(cfg, TAG), 4310n);
  const at = (ref: string, held: bigint) =>
    ({ ref, address, lovelace: held, amount: held, utxo: {}, datum: { ownHash: SUBBIT_HASH, constants: constantsOf(cfg, TAG), stage: { kind: "opened", subbed: 0n } } }) as unknown as ChannelView;
  // Where the top-up spent the channel from (room for 10,000), and where it put it (20,000).
  const before = at(`${"aa".repeat(32)}#0`, reserve + 10_000n);
  const after = at(`${"bb".repeat(32)}#0`, reserve + 20_000n);
  let reads = 0;
  const chain = { followChannel: async () => (++reads < 2 ? before : after), coinsPerUtxoByte: async () => 4310n } as unknown as Chain;
  const storage = new FileClientStorage(mkdtempSync(join(tmpdir(), "x402-topup-")));
  const client = new BatchSettlementCardanoClient({ wallet, storage, chain });
  await storage.set({
    channelId: TAG,
    serverKey: serverKey(baseReq, parseExtra(baseReq)),
    channelConfig: cfg,
    iouKey: "derived",
    network: "cardano:preprod",
    scriptHash: SUBBIT_HASH,
    channelRef: before.ref,
    deposit: "0",
    balance: "10000",
    chargedCumulativeAmount: "10000",
    status: "open",
    openedAt: 1,
  });
  // The top-up this client just made; its receipt never came back, so the record still says 10,000.
  (client as unknown as { topUps: Map<string, unknown> }).topUps.set(TAG, { from: before.ref, tx: "cc".repeat(32), at: Date.now() });

  const p = parseClientPayload((await client.createPaymentPayload(2, baseReq)).payload);
  assert.equal(p.type, "voucher", "a voucher on the larger channel, not a second top-up of an output that is gone");
  assert.equal(p.voucher.maxClaimableAmount, "11000");
  assert.equal(reads, 2, "the index was read again once it still showed the old position");
  assert.equal((await storage.get(TAG))!.channelRef, after.ref);
});

test("client: elapse without waiting refuses a channel whose elapse_at the chain has not reached", async () => {
  const address = channelAddress(0);
  const elapseAt = 1_790_000_000_000n;
  const closed = { ref: `${"dd".repeat(32)}#0`, address, lovelace: 5_000_000n, amount: 5_000_000n, utxo: {}, datum: { ownHash: SUBBIT_HASH, constants: constantsOf(config, TAG), stage: { kind: "closed", subbed: 0n, elapseAt } } } as unknown as ChannelView;
  let tips = 0;
  // The tip is a slot before elapse_at: preprod slot 0 is 1654041600 s.
  const chain = { followChannel: async () => closed, tipSlot: async () => (tips++, 1_000n) } as unknown as Chain;
  const storage = new FileClientStorage(mkdtempSync(join(tmpdir(), "x402-elapse-")));
  const client = new BatchSettlementCardanoClient({ wallet: {} as never, storage, chain });
  await storage.set({ channelId: TAG, serverKey: "k", channelConfig: config, channelRef: closed.ref, network: "cardano:preprod", scriptHash: SUBBIT_HASH, deposit: "0", balance: "0", chargedCumulativeAmount: "0", status: "closing", openedAt: 1 });
  await assert.rejects(client.elapse(TAG, { wait: false }), /^Error: not yet: the channel's elapse_at is 2026-09-21T/);
  assert.equal(tips, 1, "one read of the tip, no waiting");
});
