// The sponsor-safe validator (variant/sponsored/DESIGN.md) on the TypeScript side, chain-free: the
// datum and the repayment's datum against the bytes Aiken's tests pin, the trust a client and a
// facilitator give a validator, what the facilitator refuses at an opening, and the builders: an
// opening that names the seller, the exits that repay the sponsor, and the server's End. The
// builders run for real, on an SDK client whose provider is answered from a table (offline.ts).
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { PaymentPayload, PaymentRequired, PaymentRequirements } from "@x402/core/types";
import {
  Address,
  Assets,
  Data,
  InlineDatum,
  KeyHash,
  PrivateKey,
  Redeemer as SdkRedeemer,
  Redeemers,
  ScriptHash,
  Transaction,
  TransactionBody,
  TransactionHash,
  TransactionInput,
  TransactionWitnessSet,
  TxOut,
  UTxO,
  VKey,
  preprod,
} from "@evolution-sdk/evolution";
import {
  Redeemer,
  SPONSORED,
  SUBBIT_HASH,
  Step,
  UPSTREAM,
  VALIDATORS,
  addressData,
  channelAddress,
  datumData,
  inlineDatum,
  iouSignerFromSeed,
  parseDatum,
  repaymentDatum,
  subbitScript,
  tagFromInput,
  validatorByHash,
  type Constants,
  type Sponsor,
  type Stage,
  type Validator,
} from "../src/subbit.ts";
import { channelReserve, constantsOf, datumBindingError, readChannel, sameAddress, sponsoredChannel, txHashOf, type ChannelView } from "../src/x402/cardano.ts";
import { BlockfrostChain, type Chain } from "../src/x402/chain.ts";
import { BatchSettlementCardanoClient, EXIT_FEE_ADA, EXIT_TOKEN_OUTPUT_ADA, FileClientStorage, assertExitFunds, derivedIouSigner, iouRootOf, minAdaOutput, serverKey } from "../src/x402/client.ts";
import { buildClaimTx, buildEndTx, type ClaimBuilder } from "../src/x402/claimtx.ts";
import { BatchSettlementCardanoFacilitator } from "../src/x402/facilitator.ts";
import { ChannelManager } from "../src/x402/manager.ts";
import { assertKeepsFloor, floorProblem, minRepayment, repaymentOutput, repaymentProblem } from "../src/x402/repay.ts";
import { BatchSettlementCardanoServer, InMemoryChannelStorage } from "../src/x402/server.ts";
import { SponsorPool, checkSponsoredOpen, type FeeSponsorOffer } from "../src/x402/sponsor.ts";
import { TxCheckError, checkDeposit, checkTopUp, spendRedeemers } from "../src/x402/txcheck.ts";
import { Err, delegationMac, parseClientPayload, parseExtra, type ChannelConfig } from "../src/x402/types.ts";
import { OFFLINE_BASE, offlineBlockfrost, offlineWallet } from "./offline.ts";

const NETWORK = "cardano:preprod";
const POLICY = "e675b46e4d2242c991a8932a99db3044e80515ae14b4c4ccf6b3f4c9";
const NAME = "0014df10745553444d";
const TUSDM = `${POLICY}.${NAME}`;
const UNIT = POLICY + NAME;
const CPB = 4_310n;

function party(seed: number) {
  const key = PrivateKey.fromBytes(new Uint8Array(32).fill(seed));
  const kh = KeyHash.fromPrivateKey(key);
  const address = new Address.Address({ networkId: 0, paymentCredential: kh });
  return { key, keyHash: KeyHash.toHex(kh).toLowerCase(), address, bech32: Address.toBech32(address) };
}
const buyer = party(1);
const sponsorKey = party(2);
const seller = party(3);
const stranger = party(4);
const bech = (payment: KeyHash.KeyHash | ScriptHash.ScriptHash, stake?: KeyHash.KeyHash | ScriptHash.ScriptHash, networkId = 0) =>
  Address.toBech32(new Address.Address({ networkId, paymentCredential: payment, ...(stake ? { stakingCredential: stake } : {}) }));
const kh = (hex: string) => KeyHash.fromHex(hex);
/** The seller's address: a payment key and a stake key, as a wallet's is. */
const PAY_TO = bech(kh(seller.keyHash), kh(stranger.keyHash));
const OTHER = bech(kh(stranger.keyHash), kh(seller.keyHash));

const txid = (n: number) => n.toString(16).padStart(2, "0").repeat(32);
const input = (n: number, i = 0) => new TransactionInput.TransactionInput({ transactionId: TransactionHash.fromHex(txid(n)), index: BigInt(i) });
const refOf = (n: number, i = 0) => `${txid(n)}#${i}`;
const tokens = (q: bigint, lovelace: bigint) => Assets.fromHexStrings(POLICY, NAME, q, lovelace);
const out = (to: { address: Address.Address }, assets: Assets.Assets) => new TxOut.TransactionOutput({ address: to.address, assets });
const utxoAt = (address: Address.Address, n: number, i: number, assets: Assets.Assets, datum?: Data.Data) =>
  new UTxO.UTxO({ transactionId: TransactionHash.fromHex(txid(n)), index: BigInt(i), address, assets, ...(datum ? { datumOption: new InlineDatum.InlineDatum({ data: datum }) } : {}) });
const hexOf = (s: string) => Uint8Array.from(Buffer.from(s, "hex"));

const iou = iouSignerFromSeed(new Uint8Array(32).fill(1));
const cfg = (over: Partial<ChannelConfig> = {}): ChannelConfig => ({ payer: buyer.keyHash, payerAuthorizer: iou.publicKey, receiver: PAY_TO, receiverAuthorizer: seller.keyHash, token: TUSDM, withdrawDelay: 900, ...over });
const chan = channelAddress(0, undefined, SPONSORED);
const chanUp = channelAddress(0);
/** The buyer's UTxO an opening spends, and so the tag of its channel (ADR tag.md). */
const seedInput = input(0xb0, 1);
const TAG = tagFromInput(seedInput);
const buyerUtxo = utxoAt(buyer.address, 0xb0, 1, Assets.fromLovelace(20_000_000n));
const constantsFor = (over: Partial<Constants> = {}): Constants => ({ ...constantsOf(cfg(), TAG), ...over });

// ---- the validators ------------------------------------------------------------------------

test("validators: Subbit's and the variant's hashes and scripts, the registry, and the addresses", () => {
  assert.equal(UPSTREAM.hash, "62ce4309e37e09e5c633c96c6ae68061c434f122d32626d6912d7c2a");
  assert.equal(SPONSORED.hash, "20b64ee22a509c164e0e16ad1189b12be7f0a497b0eb096180c923ea");
  assert.deepEqual([UPSTREAM.sponsored, SPONSORED.sponsored], [false, true]);
  // The names this package has always exported are upstream's.
  assert.equal(SUBBIT_HASH, UPSTREAM.hash);
  assert.equal(subbitScript, UPSTREAM.script);
  for (const v of VALIDATORS) assert.equal(ScriptHash.toHex(ScriptHash.fromScript(v.script)), v.hash, `${v.name}'s script hashes to its blueprint's hash`);
  assert.equal(validatorByHash(SPONSORED.hash.toUpperCase()), SPONSORED);
  assert.equal(validatorByHash("00".repeat(28)), undefined);
  for (const v of VALIDATORS) assert.equal(ScriptHash.toHex(channelAddress(0, undefined, v).paymentCredential as ScriptHash.ScriptHash), v.hash);
  assert.equal(Address.toBech32(channelAddress(0)), Address.toBech32(chanUp), "a channel is upstream's unless the validator is named");
  assert.notEqual(Address.toBech32(chan), Address.toBech32(chanUp));
  // The delegation part is the consumer's choice, as before.
  assert.equal(Address.toBech32(channelAddress(0, kh(buyer.keyHash), SPONSORED)).startsWith("addr_test1z"), true);
  assert.ok("error" in readChannel(utxoAt(chanUp, 1, 0, Assets.fromLovelace(1n)), SPONSORED.hash), "a UTxO at one validator is not a channel of the other");
});

// ---- the datum on the wire: Aiken's pinned bytes ----------------------------------------------

/** variant/sponsored/aiken/lib/mark/sponsored.ak, where the vectors the validator's own tests pin are written down. A Windows checkout may have CRLF line ends. */
const AIKEN = readFileSync(new URL("../variant/sponsored/aiken/lib/mark/sponsored.ak", import.meta.url), "utf8").replace(/\r\n/g, "\n");

// What the Aiken fixture is built from (lib/mark/fixture.ak, vectors.ak): key A's IOU key, the tag of the input ab..ab#0,
// USDM at the policy 0x33.., consumer 0x11.., provider 0x22.., a one-hour close period, the sponsor's base address of the
// keys 0x66.. and 0x77.. with a floor of 1,200,000. The fixture's own_hash is upstream's, so the variant is asked for
// its datum under that hash, which is the one thing it changes.
const fixtureConstants = (): Constants => ({
  tag: tagFromInput(new TransactionInput.TransactionInput({ transactionId: TransactionHash.fromHex("ab".repeat(32)), index: 0n })),
  currency: { kind: "asset", policy: "33".repeat(28), name: Buffer.from("USDM").toString("hex") },
  iouKey: iou.publicKey,
  consumer: "11".repeat(28),
  provider: "22".repeat(28),
  closePeriodMs: 3_600_000n,
  sponsor: { address: bech(kh("66".repeat(28)), kh("77".repeat(28))), floor: 1_200_000n },
});
const asFixture: Validator = { ...SPONSORED, hash: UPSTREAM.hash };

test("the sponsored datum is byte for byte the Aiken test's, and reads back", () => {
  const vector = /const datum_opened_sponsored: ByteArray =\s*#"([0-9a-f]+)"/.exec(AIKEN)?.[1];
  assert.ok(vector, "the vector is where this test looks for it");
  const stage: Stage = { kind: "opened", subbed: 2_500_000n };
  assert.equal(Data.toCBORHex(datumData(fixtureConstants(), stage, asFixture)), vector);
  assert.deepEqual(parseDatum(Data.fromCBORHex(vector), asFixture, 0), { ownHash: UPSTREAM.hash, constants: fixtureConstants(), stage });
  // Under its own hash the datum is the same but for the `own_hash` it names.
  assert.equal(Data.toCBORHex(datumData(fixtureConstants(), stage, SPONSORED)), vector.replace(UPSTREAM.hash, SPONSORED.hash));
  // No sponsor is `None`, the three bytes `d87a80` that end the constants: the vector with its `Some((address, floor))` taken out.
  const { sponsor: _sponsor, ...bare } = fixtureConstants();
  const noSponsor = vector.replace(/1a0036ee80d8799f9f[0-9a-f]+1a00124f80ffffff/, "1a0036ee80d87a80ff");
  assert.notEqual(noSponsor, vector);
  assert.equal(Data.toCBORHex(datumData(bare, stage, asFixture)), noSponsor);
  assert.deepEqual(parseDatum(Data.fromCBORHex(noSponsor), asFixture, 0), { ownHash: UPSTREAM.hash, constants: bare, stage });
});

test("the repayment's datum is byte for byte the Aiken test's, for every width of the index", () => {
  const block = /const repayment_datums: List<\(Int, ByteArray\)> =\s*\[([\s\S]*?)\n\s*\]\n/.exec(AIKEN)?.[1];
  assert.ok(block, "the vectors are where this test looks for them");
  const vectors = [...block.matchAll(/\(\s*(\d+),\s*#"([0-9a-f]+)",?\s*\)/g)].map((m) => [Number(m[1]), m[2]!] as const);
  assert.deepEqual(vectors.map(([i]) => i), [0, 1, 23, 24, 255, 256, 65_535, 65_536]);
  for (const [index, hex] of vectors) {
    assert.equal(hex.slice(0, 14), "d8799f5820cafe", "the id is bare, 32 bytes of 0xcafe..");
    assert.equal(Data.toCBORHex(repaymentDatum(`${"cafe".repeat(16)}#${index}`)), hex, `index ${index}`);
  }
  assert.throws(() => repaymentDatum("cafe#0"), /not an output reference/);
  assert.throws(() => repaymentDatum(`${"cafe".repeat(16)}#01`), /not an output reference/);
});

test("datums round-trip through Data and CBOR at both validators, for every stage, currency and sponsor", () => {
  const key = (n: string) => kh(n.repeat(28));
  const script = (n: string) => ScriptHash.fromHex(n.repeat(28));
  const sponsors: Array<Sponsor | undefined> = [
    undefined,
    { address: bech(key("66"), key("77")), floor: 1_200_000n },
    { address: bech(key("66")), floor: 0n },
    { address: bech(script("88"), script("99")), floor: 2n ** 64n },
    { address: bech(key("66"), script("99")), floor: 23n },
  ];
  const stages: Stage[] = [{ kind: "opened", subbed: 0n }, { kind: "opened", subbed: 5_000_000n }, { kind: "closed", subbed: 7n, elapseAt: 1_790_000_000_000n }, { kind: "settled" }];
  const currencies: Constants["currency"][] = [{ kind: "ada" }, { kind: "asset", policy: "c4".repeat(28), name: "5553444d" }];
  let n = 0;
  for (const v of VALIDATORS) {
    for (const stage of stages) {
      for (const currency of currencies) {
        for (const sponsor of sponsors) {
          const { sponsor: _fixture, ...bare } = fixtureConstants();
          const c: Constants = { ...bare, currency, ...(sponsor ? { sponsor } : {}) };
          if (sponsor && !v.sponsored) {
            assert.throws(() => datumData(c, stage, v), /has no sponsor constant/);
            continue;
          }
          const parsed = parseDatum(Data.fromCBORBytes(Data.toCBORBytes(datumData(c, stage, v))), v, 0);
          assert.deepEqual(parsed, { ownHash: v.hash, constants: c, stage });
          n++;
        }
      }
    }
  }
  assert.equal(n, 4 * 2 * (1 + 5));
  // The constants have seven entries at the variant, six at upstream, whatever the sponsor.
  const constantsOf7 = (d: Data.Data) => ((d as Data.Data[])[1] as Data.Data[]).length;
  assert.equal(constantsOf7(datumData(fixtureConstants(), stages[0]!, SPONSORED)), 7);
  assert.equal(constantsOf7(datumData(constantsFor(), stages[0]!, SPONSORED)), 7);
  assert.equal(constantsOf7(datumData(constantsFor(), stages[0]!, UPSTREAM)), 6);
});

test("a sponsor's address is read on the channel's network: the datum holds the credentials, not the network", () => {
  const main = bech(kh("66".repeat(28)), kh("77".repeat(28)), 1);
  const test0 = bech(kh("66".repeat(28)), kh("77".repeat(28)), 0);
  assert.equal(Data.toCBORHex(addressData(main)), Data.toCBORHex(addressData(test0)));
  const datum = Data.fromCBORBytes(Data.toCBORBytes(datumData({ ...fixtureConstants(), sponsor: { address: main, floor: 5n } }, { kind: "settled" }, SPONSORED)));
  assert.equal(parseDatum(datum, SPONSORED, 1).constants.sponsor?.address, main);
  assert.equal(parseDatum(datum, SPONSORED, 0).constants.sponsor?.address, test0);
  assert.throws(() => (parseDatum as (d: Data.Data, v: Validator) => unknown)(datum, SPONSORED), /its network is needed to read it/);
});

test("a datum with the other validator's number of constants, or an address that cannot be read, is an error", () => {
  const stage: Stage = { kind: "opened", subbed: 0n };
  const seven = datumData(fixtureConstants(), stage, SPONSORED);
  const six = datumData(constantsFor(), stage, UPSTREAM);
  // Upstream's six constants under the variant's hash: the funds would be locked for good.
  const sixAtTheVariant = datumData(constantsFor(), stage, { ...UPSTREAM, hash: SPONSORED.hash });
  assert.throws(() => parseDatum(sixAtTheVariant, SPONSORED, 0), /6 where the sponsored validator reads 7: no step could read this datum, so whatever it holds is locked for good/);
  assert.throws(() => parseDatum(six, SPONSORED, 0), /6 where the sponsored validator reads 7/);
  assert.throws(() => parseDatum(seven, UPSTREAM, 0), /7 where the upstream validator reads 6/);
  assert.throws(() => parseDatum(seven), /7 where the upstream validator reads 6/);
  assert.doesNotThrow(() => parseDatum(six));
  assert.throws(() => datumData(fixtureConstants(), stage, UPSTREAM), /the upstream validator has no sponsor constant/);
  assert.throws(() => datumData({ ...fixtureConstants(), sponsor: { address: bech(kh("66".repeat(28))), floor: -1n } }, stage, SPONSORED), /must not be negative/);
  // A reward address, or a pointer stake credential, is no address a repayment can go to.
  assert.throws(() => addressData("stake_test1upnxvenxvenxvenxvenxvenxvenxvenxvenxvenxvenxveshap7dm"), /Invalid address prefix/);
  const doctored = (sponsor: Data.Data) => {
    const d = [...(seven as Data.Data[])];
    d[1] = [...(d[1] as Data.Data[]).slice(0, 6), sponsor];
    return d as Data.Data;
  };
  const pointer = Data.constr(0n, [Data.constr(0n, [hexOf("66".repeat(28))]), Data.constr(0n, [Data.constr(1n, [1n, 2n, 3n])])]);
  assert.throws(() => parseDatum(doctored(Data.constr(0n, [Data.list([pointer, 5n])])), SPONSORED, 0), /pointer stake credential is not supported/);
  const shortHash = Data.constr(0n, [Data.constr(0n, [hexOf("66".repeat(27))]), Data.constr(1n, [])]);
  assert.throws(() => parseDatum(doctored(Data.constr(0n, [Data.list([shortHash, 5n])])), SPONSORED, 0), /expected 28 bytes/);
  assert.throws(() => parseDatum(doctored(Data.constr(2n, [])), SPONSORED, 0), /sponsor: unknown constructor/);
  assert.throws(() => parseDatum(doctored(Data.constr(0n, [Data.list([5n])])), SPONSORED, 0), /sponsor: expected a list of 2/);
});

// ---- the reserve ---------------------------------------------------------------------------------

test("a sponsored channel's floor is its reserve, the fixed point of the floor's own size in the datum", () => {
  for (const sponsor of [PAY_TO, party(5).bech32]) {
    const { constants, reserve } = sponsoredChannel(chan, constantsOf(cfg(), "11".repeat(32)), sponsor, CPB);
    assert.equal(constants.sponsor?.floor, reserve, "the floor is the whole reserve");
    assert.equal(channelReserve(chan, constants, CPB), reserve, "which is what the datum with that floor needs");
    // Every continuing output the channel can have clears min-UTxO with it, and so does a repayment.
    for (const stage of [{ kind: "opened", subbed: 0n }, { kind: "opened", subbed: 2n ** 40n }, { kind: "closed", subbed: 2n ** 40n, elapseAt: 1_790_000_000_000n }, { kind: "settled" }] as const) {
      for (const q of [0n, 1n, 2n ** 50n]) {
        const o = new TxOut.TransactionOutput({ address: chan, assets: q === 0n ? Assets.fromLovelace(reserve) : tokens(q, reserve), datumOption: inlineDatum(constants, stage, SPONSORED) });
        assert.ok(CPB * (160n + BigInt(TxOut.toCBORBytes(o).length)) <= reserve, `${stage.kind} holding ${q}`);
      }
    }
    assert.ok(minRepayment(Address.fromBech32(sponsor), CPB) <= reserve, "the floor covers a repayment output's min-UTxO");
    // The variant's datum is longer than upstream's: its reserve is, by the bytes of the sponsor and the floor.
    const upstream = channelReserve(chanUp, constantsOf(cfg(), "11".repeat(32)), CPB);
    assert.ok(reserve - upstream > 40n * CPB && reserve - upstream < 100n * CPB, `${reserve} against ${upstream}`);
  }
  assert.throws(() => sponsoredChannel(chan, constantsOf(cfg({ token: "lovelace" }), "11".repeat(32)), PAY_TO, CPB), /only token channels are sponsored/);
  // The reserve is the datum's validator's: an unsponsored channel at the variant is a little longer than upstream's, by the `None`.
  const plain = constantsOf(cfg(), "11".repeat(32));
  assert.equal(channelReserve(chan, plain, CPB) - channelReserve(chanUp, plain, CPB), 3n * CPB);
});

// ---- trust -----------------------------------------------------------------------------------------

const req = (scriptHash: string, over: Partial<PaymentRequirements> = {}): PaymentRequirements => ({
  scheme: "batch-settlement",
  network: NETWORK,
  asset: TUSDM,
  amount: "100000",
  payTo: PAY_TO,
  maxTimeoutSeconds: 300,
  extra: { scriptHash, receiverAuthorizer: seller.keyHash, withdrawDelay: 900 },
  ...over,
});
const newStorage = () => new FileClientStorage(mkdtempSync(join(tmpdir(), "variant-")));

test("trust: a client opens, tops up and pays only at a validator it trusts, upstream's alone by default", async () => {
  // A wallet and a chain that would throw on first use: the refusal comes before either is touched.
  const bare = new BatchSettlementCardanoClient({ wallet: {} as never, storage: newStorage(), chain: {} as never });
  await assert.rejects(bare.createPaymentPayload(2, req(SPONSORED.hash)), /server asks for a validator this client does not trust: 20b64ee2.* \(it trusts 62ce4309/);
  await assert.rejects(bare.createPaymentPayload(2, req("ab".repeat(28))), /does not trust: abababab/);
  const pr: PaymentRequired = { x402Version: 2, resource: { url: "http://seller.invalid/refund" }, accepts: [req(SPONSORED.hash)] };
  await assert.rejects(bare.refundPayload(pr), /does not trust/);
  await assert.rejects(bare.recover(NETWORK, SPONSORED.hash), /does not trust/);
  assert.throws(() => new BatchSettlementCardanoClient({ wallet: {} as never, storage: newStorage(), chain: {} as never, trustedValidators: [] }), /would trust no validator/);
  // Naming the variant lets it past the check (and on to the wallet, which here is nothing).
  const both = new BatchSettlementCardanoClient({ wallet: {} as never, storage: newStorage(), chain: {} as never, trustedValidators: [UPSTREAM, SPONSORED] });
  await assert.rejects(both.createPaymentPayload(2, req(SPONSORED.hash)), (e: Error) => !/does not trust/.test(e.message));
  await assert.rejects(both.createPaymentPayload(2, req("ab".repeat(28))), /does not trust/);
  // Trusting the variant alone refuses upstream's.
  const only = new BatchSettlementCardanoClient({ wallet: {} as never, storage: newStorage(), chain: {} as never, trustedValidators: [SPONSORED] });
  await assert.rejects(only.createPaymentPayload(2, req(UPSTREAM.hash)), /does not trust: 62ce4309/);
});

test("recover: a client finds its channels at every validator it trusts, or at the one it is told", async () => {
  const wallet = offlineWallet();
  const me = KeyHash.toHex((await wallet.address()).paymentCredential as KeyHash.KeyHash);
  const view = (v: Validator, tag: string) => {
    const at = channelAddress(0, undefined, v);
    const constants = { ...constantsOf(cfg({ payer: me }), tag), consumer: me };
    return { ref: `${txid(v.sponsored ? 0xe1 : 0xe0)}#0`, address: at, lovelace: 2_500_000n, amount: 1_000n, datum: { ownHash: v.hash, constants, stage: { kind: "opened", subbed: 0n } } } as unknown as ChannelView;
  };
  const views = { [UPSTREAM.hash]: view(UPSTREAM, "a1".repeat(32)), [SPONSORED.hash]: view(SPONSORED, "b2".repeat(32)) };
  const asked: string[] = [];
  const chain = {
    network: NETWORK,
    channels: async (hash: string) => (asked.push(hash), [views[hash]!]),
    followChannel: async (ref: string) => Object.values(views).find((v) => v.ref === ref),
    coinsPerUtxoByte: async () => CPB,
    openingOf: async () => undefined,
  } as unknown as Chain;
  const run = async (trusted: Validator[] | undefined, hash?: string) => {
    asked.length = 0;
    const client = new BatchSettlementCardanoClient({ wallet, storage: newStorage(), chain, ...(trusted ? { trustedValidators: trusted } : {}) });
    const found = await client.recover(NETWORK, hash);
    return { asked: [...asked], found: found.map((c) => c.scriptHash) };
  };
  assert.deepEqual(await run(undefined), { asked: [UPSTREAM.hash], found: [UPSTREAM.hash] });
  assert.deepEqual(await run([UPSTREAM, SPONSORED]), { asked: [UPSTREAM.hash, SPONSORED.hash], found: [UPSTREAM.hash, SPONSORED.hash] });
  assert.deepEqual(await run([UPSTREAM, SPONSORED], SPONSORED.hash), { asked: [SPONSORED.hash], found: [SPONSORED.hash] });
  assert.deepEqual(await run([SPONSORED]), { asked: [SPONSORED.hash], found: [SPONSORED.hash] });
});

test("server: its configured validator's hash is what its 402 names, and one this package does not know is refused", async () => {
  const server = (scriptHash: string) => new BatchSettlementCardanoServer({ payTo: PAY_TO, receiverAuthorizer: seller.keyHash, scriptHash, chain: {} as never });
  for (const v of VALIDATORS) {
    const enhanced = await server(v.hash).enhancePaymentRequirements(req(UPSTREAM.hash), { x402Version: 2, scheme: "batch-settlement", network: NETWORK }, []);
    assert.equal(parseExtra(enhanced).scriptHash, v.hash);
  }
  assert.throws(() => server("ab".repeat(28)), /not a validator this package knows/);
});

// ---- the facilitator -----------------------------------------------------------------------------------

const SPONSORED_OPENING = sponsoredChannel(chan, constantsFor(), PAY_TO, CPB);
const RESERVE = SPONSORED_OPENING.reserve;

interface Parts {
  inputs: TransactionInput.TransactionInput[];
  outputs: TxOut.TransactionOutput[];
  fee: bigint;
  extra?: Partial<ConstructorParameters<typeof TransactionBody.TransactionBody>[0]>;
  witness?: Partial<ConstructorParameters<typeof TransactionWitnessSet.TransactionWitnessSet>[0]>;
}
const unsigned = (p: Parts) =>
  Transaction.toCBORHex(
    new Transaction.Transaction({
      body: new TransactionBody.TransactionBody({ inputs: p.inputs, outputs: p.outputs, fee: p.fee, ...p.extra }),
      witnessSet: new TransactionWitnessSet.TransactionWitnessSet({ ...p.witness }),
      isValid: true,
      auxiliaryData: null,
    }),
  );
function signedBy(hex: string, ...who: Array<{ key: PrivateKey.PrivateKey }>) {
  const hash = TransactionBody.toHashFromBytes(Transaction.extractBodyBytes(Buffer.from(hex, "hex")));
  const ws = who.map((w) => new TransactionWitnessSet.VKeyWitness({ vkey: VKey.fromPrivateKey(w.key), signature: PrivateKey.sign(w.key, hash.hash) }));
  return Transaction.addVKeyWitnessesHex(hex, TransactionWitnessSet.toCBORHex(TransactionWitnessSet.fromVKeyWitnesses(ws)));
}

/** An opening transaction: the buyer's UTxO in, one channel output with this datum and value, the change back. */
function opening(datum: Data.Data, assets: Assets.Assets, at: Address.Address = chan): string {
  const channel = new TxOut.TransactionOutput({ address: at, assets, datumOption: new InlineDatum.InlineDatum({ data: datum }) });
  return unsigned({ inputs: [seedInput], outputs: [channel, out(buyer, Assets.fromLovelace(8_000_000n))], fee: 200_000n });
}
const opened: Stage = { kind: "opened", subbed: 0n };
const sponsoredDatum = (over: Partial<Constants> = {}) => datumData({ ...SPONSORED_OPENING.constants, ...over }, opened, SPONSORED);
const plainDatum = (v: Validator = SPONSORED) => datumData(constantsFor(), opened, v);
const deposit = (hex: string, over: { config?: ChannelConfig; channelId?: string; amount?: bigint; scriptHash?: string; payTo?: string } = {}) =>
  checkDeposit(hex, NETWORK, over.config ?? cfg(), over.channelId ?? TAG, over.scriptHash ?? SPONSORED.hash, over.amount ?? 1_000_000n, CPB, over.payTo ?? PAY_TO);
const refuses = (f: () => unknown, message: RegExp, reason: string = Err.depositTransaction) =>
  assert.throws(f, (e: unknown) => e instanceof TxCheckError && e.reason === reason && message.test(e.message), String(message));

test("facilitator, an opening at the variant: a sponsored one passes when it names payTo and its whole ADA as the floor", () => {
  const ok = deposit(opening(sponsoredDatum(), tokens(1_000_000n, RESERVE)));
  assert.equal(ok.capacity, 1_000_000n);
  // A buyer that pays its own reserve names no sponsor, and the variant takes that too.
  const own = channelReserve(chan, constantsFor(), CPB);
  assert.equal(deposit(opening(plainDatum(), tokens(1_000_000n, own))).capacity, 1_000_000n);
  // At upstream's address, upstream's datum is as it was.
  const upstreamReserve = channelReserve(chanUp, constantsFor(), CPB);
  assert.equal(deposit(opening(plainDatum(UPSTREAM), tokens(1_000_000n, upstreamReserve), chanUp), { scriptHash: UPSTREAM.hash }).capacity, 1_000_000n);
});

test("facilitator, an opening at the variant: each way a datum could lock funds or cheat the sponsor is refused with its reason", () => {
  const six = datumData(constantsFor(), opened, { ...UPSTREAM, hash: SPONSORED.hash });
  refuses(() => deposit(opening(six, tokens(1_000_000n, RESERVE))), /channel datum: constants: 6 where the sponsored validator reads 7.*locked for good/);
  // And upstream's address takes no seven.
  refuses(() => deposit(opening(sponsoredDatum(), tokens(1_000_000n, RESERVE), chanUp), { scriptHash: UPSTREAM.hash }), /channel datum: constants: 7 where the upstream validator reads 6/);
  // R0: a sponsored channel in ADA could only be spent by Mutual.
  const ada = { ...SPONSORED_OPENING.constants, currency: { kind: "ada" } as const, sponsor: { address: PAY_TO, floor: RESERVE } };
  refuses(() => deposit(opening(datumData(ada, opened, SPONSORED), Assets.fromLovelace(1_000_000n + RESERVE)), { config: cfg({ token: "lovelace" }) }), /currency must be a token \(R0\)/);
  // The sponsor is payTo, whole: another address, or payTo's payment key with another stake key.
  for (const address of [OTHER, bech(kh(seller.keyHash)), stranger.bech32]) {
    refuses(() => deposit(opening(sponsoredDatum({ sponsor: { address, floor: RESERVE } }), tokens(1_000_000n, RESERVE))), /is not payTo/);
  }
  // The floor is the whole of the channel's ADA: not a lovelace less or more.
  for (const floor of [RESERVE - 1n, RESERVE + 1n, 0n]) {
    refuses(() => deposit(opening(sponsoredDatum({ sponsor: { address: PAY_TO, floor } }), tokens(1_000_000n, RESERVE))), new RegExp(`floor ${floor} is not the ${RESERVE} lovelace the channel holds`));
  }
  // And at least what a repayment output needs to exist: here the channel holds as little as the floor says.
  const small = 1_000_000n;
  refuses(() => deposit(opening(sponsoredDatum({ sponsor: { address: PAY_TO, floor: small } }), tokens(1_000_000n, small))), /floor 1000000 is under the \d+ lovelace a repayment output needs/);
  // An opening that carries less than its reserve is as refused as before.
  const sponsored = sponsoredChannel(chan, constantsFor(), PAY_TO, CPB);
  refuses(() => deposit(opening(sponsoredDatum({ sponsor: { address: PAY_TO, floor: sponsored.reserve - 1n } }), tokens(1_000_000n, sponsored.reserve - 1n))), /a token channel carries at least/);
});

test("facilitator: it serves the validators it is given, and reads an opening at the variant end to end", async () => {
  const signer = iou;
  const voucher = (amount: bigint) => ({ channelId: TAG, maxClaimableAmount: amount.toString(), signature: signer.sign(TAG, amount) });
  const chain = { network: NETWORK, coinsPerUtxoByte: async () => CPB, getUnspent: async (ref: string) => (ref === refOf(0xb0, 1) ? buyerUtxo : undefined) } as unknown as Chain;
  const pay = (r: PaymentRequirements, hex: string, config = cfg()): PaymentPayload => ({
    x402Version: 2,
    accepted: r,
    payload: { type: "deposit", channelConfig: config, voucher: voucher(1000n), deposit: { amount: "1000000", transaction: Buffer.from(signedBy(hex, buyer), "hex").toString("base64") } },
  });
  const good = opening(sponsoredDatum(), tokens(1_000_000n, RESERVE));
  const variant = req(SPONSORED.hash);

  // By default only upstream's: a payment at the variant is for a validator it does not serve.
  const plain = new BatchSettlementCardanoFacilitator(chain, {});
  const refused = await plain.verify(pay(variant, good), variant);
  assert.deepEqual([refused.isValid, refused.invalidReason], [false, Err.extra]);
  assert.match(refused.invalidMessage ?? "", /serves script 62ce4309/);
  assert.equal((await new BatchSettlementCardanoFacilitator(chain, { scriptHash: SUBBIT_HASH }).verify(pay(variant, good), variant)).invalidReason, Err.extra, "the old option still names upstream's alone");
  assert.throws(() => new BatchSettlementCardanoFacilitator(chain, { scriptHash: "ab".repeat(28) }), /not a validator this package knows/);

  const serving = new BatchSettlementCardanoFacilitator(chain, { validators: [UPSTREAM, SPONSORED] });
  const ok = await serving.verify(pay(variant, good), variant);
  assert.deepEqual([ok.isValid, ok.payer], [true, buyer.keyHash]);
  assert.equal((await new BatchSettlementCardanoFacilitator(chain, { scriptHash: SPONSORED.hash }).verify(pay(variant, good), variant)).isValid, true, "scriptHash alone can name the variant");
  assert.equal((await new BatchSettlementCardanoFacilitator(chain, { validators: [SPONSORED] }).verify(pay(req(UPSTREAM.hash), good), req(UPSTREAM.hash))).invalidReason, Err.extra);

  // Through verify, a refusal is the same reason and message as the check's, with the payer.
  const six = opening(datumData(constantsFor(), opened, { ...UPSTREAM, hash: SPONSORED.hash }), tokens(1_000_000n, RESERVE));
  const locked = await serving.verify(pay(variant, six), variant);
  assert.deepEqual([locked.isValid, locked.invalidReason, locked.payer], [false, Err.depositTransaction, buyer.keyHash]);
  assert.match(locked.invalidMessage ?? "", /locked for good/);
  // payTo is the requirements', so a datum that names another address as sponsor does not pass.
  const wrong = opening(sponsoredDatum({ sponsor: { address: OTHER, floor: RESERVE } }), tokens(1_000_000n, RESERVE));
  const named = await serving.verify(pay(variant, wrong), variant);
  assert.match(named.invalidMessage ?? "", /is not payTo/);
});

test("facilitator: a channel whose sponsor is not its receiver is not one it serves a voucher or a top-up on", () => {
  const d = (sponsor: string) => parseDatum(Data.fromCBORBytes(Data.toCBORBytes(sponsoredDatum({ sponsor: { address: sponsor, floor: RESERVE } }))), SPONSORED, 0);
  assert.equal(datumBindingError(d(PAY_TO), cfg(), TAG, SPONSORED.hash), undefined);
  assert.equal(datumBindingError(d(OTHER), cfg(), TAG, SPONSORED.hash), Err.receiverMismatch);
  assert.equal(sameAddress(PAY_TO, PAY_TO), true);
  assert.equal(sameAddress(PAY_TO, OTHER), false);
  assert.equal(sameAddress(PAY_TO, "not an address"), false);
});

const addRedeemer = Redeemers.makeRedeemerMap([new SdkRedeemer.Redeemer({ tag: "spend", index: 0n, data: Redeemer.main([Step.add()]), exUnits: new SdkRedeemer.ExUnits({ mem: 1_000n, steps: 1_000n }) })]);

test("facilitator, a top-up of a sponsored channel: its output keeps the floor (R1) as well as the reserve", () => {
  // A floor above the reserve is one a seller's own check refuses at the opening, but a facilitator
  // may be asked to top one up: the reserve alone would not keep the validator from refusing it.
  const floor = RESERVE + 50_000n;
  const constants = { ...SPONSORED_OPENING.constants, sponsor: { address: PAY_TO, floor } };
  const view = { ref: refOf(0xc0, 0), address: chan, lovelace: floor, amount: 1_000_000n, datum: { ownHash: SPONSORED.hash, constants, stage: opened } } as unknown as ChannelView;
  const topUp = (lovelace: bigint) =>
    signedBy(
      unsigned({
        inputs: [input(0xc0, 0)],
        outputs: [new TxOut.TransactionOutput({ address: chan, assets: tokens(1_500_000n, lovelace), datumOption: new InlineDatum.InlineDatum({ data: datumData(constants, opened, SPONSORED) }) })],
        fee: 200_000n,
        witness: { redeemers: addRedeemer },
      }),
      buyer,
    );
  assert.equal(checkTopUp(topUp(floor), NETWORK, view, 500_000n, CPB).capacity, 1_500_000n);
  refuses(() => checkTopUp(topUp(floor - 1n), NETWORK, view, 500_000n, CPB), /keeps at least its floor, 2\d+ lovelace \(R1\)/);
  // A channel nobody sponsors needs no more than its reserve.
  const { sponsor: _sponsor, ...bare } = constants;
  const reserve = channelReserve(chan, bare, CPB);
  const plainView = { ...view, lovelace: reserve, datum: { ownHash: SPONSORED.hash, constants: bare, stage: opened } } as unknown as ChannelView;
  const plainTx = signedBy(
    unsigned({
      inputs: [input(0xc0, 0)],
      outputs: [new TxOut.TransactionOutput({ address: chan, assets: tokens(1_500_000n, reserve), datumOption: new InlineDatum.InlineDatum({ data: datumData(bare, opened, SPONSORED) }) })],
      fee: 200_000n,
      witness: { redeemers: addRedeemer },
    }),
    buyer,
  );
  assert.equal(checkTopUp(plainTx, NETWORK, plainView, 500_000n, CPB).capacity, 1_500_000n);
});

// ---- R1 and R2 as the builders must satisfy them ---------------------------------------------------

test("R1: a continuing output must hold its channel's floor, each channel by its own, in order", () => {
  const tx = (...lovelace: bigint[]) =>
    new Transaction.Transaction({
      body: new TransactionBody.TransactionBody({ inputs: [input(0xc0)], outputs: [...lovelace.map((l) => new TxOut.TransactionOutput({ address: chan, assets: tokens(1n, l) })), out(buyer, Assets.fromLovelace(1_000_000n))], fee: 1n }),
      witnessSet: new TransactionWitnessSet.TransactionWitnessSet({}),
      isValid: true,
      auxiliaryData: null,
    });
  assert.equal(floorProblem(tx(2_500_000n), SPONSORED.hash, [2_500_000n]), undefined);
  assert.equal(floorProblem(tx(3_000_000n, 2_500_000n), SPONSORED.hash, [undefined, 2_500_000n]), undefined, "a channel nobody sponsors has no floor");
  assert.match(floorProblem(tx(2_499_999n), SPONSORED.hash, [2_500_000n]) ?? "", /holds 2499999 lovelace, under its sponsor's floor of 2500000 \(R1\)/);
  assert.match(floorProblem(tx(2_500_000n, 2_000_000n), SPONSORED.hash, [2_500_000n, 2_500_000n]) ?? "", /2000000 lovelace/);
  assert.match(floorProblem(tx(2_500_000n), SPONSORED.hash, [2_500_000n, 2_500_000n]) ?? "", /2 channel\(s\) continue but the transaction has 1/);
  assert.match(floorProblem(tx(2_500_000n), UPSTREAM.hash, [2_500_000n]) ?? "", /1 channel\(s\) continue but the transaction has 0/);
  assert.throws(() => assertKeepsFloor(tx(1n), SPONSORED.hash, [2n]), /\(R1\)/);
  assert.doesNotThrow(() => assertKeepsFloor(tx(2n), SPONSORED.hash, [2n]));
});

test("R2: an ending is repaid only by an output at the sponsor's whole address, with the channel's own reference as its datum, of at least the floor", () => {
  const sponsor: Sponsor = { address: PAY_TO, floor: 2_500_000n };
  const ref = refOf(0xc0, 1);
  const paying = (over: { address?: string; ref?: string; lovelace?: bigint; datum?: boolean } = {}) =>
    new Transaction.Transaction({
      body: new TransactionBody.TransactionBody({
        inputs: [input(0xc0, 1)],
        outputs: [
          new TxOut.TransactionOutput({
            address: Address.fromBech32(over.address ?? PAY_TO),
            assets: Assets.fromLovelace(over.lovelace ?? 2_500_000n),
            ...(over.datum === false ? {} : { datumOption: new InlineDatum.InlineDatum({ data: repaymentDatum(over.ref ?? ref) }) }),
          }),
        ],
        fee: 1n,
      }),
      witnessSet: new TransactionWitnessSet.TransactionWitnessSet({}),
      isValid: true,
      auxiliaryData: null,
    });
  assert.equal(repaymentProblem(paying(), ref, sponsor), undefined);
  assert.equal(repaymentProblem(paying({ lovelace: 9_000_000n }), ref, sponsor), undefined, "more than the floor is fine");
  for (const [what, tx] of Object.entries({
    "a lovelace short": paying({ lovelace: 2_499_999n }),
    "another address": paying({ address: OTHER }),
    "the payment key alone": paying({ address: bech(kh(seller.keyHash)) }),
    "another output reference": paying({ ref: refOf(0xc0, 2) }),
    "another transaction's": paying({ ref: refOf(0xc1, 1) }),
    "no datum": paying({ datum: false }),
  })) {
    assert.match(repaymentProblem(tx, ref, sponsor) ?? "", /no output pays the sponsor .* at least 2500000 lovelace with .* as its inline datum \(R2\)/, what);
  }
  // The output a builder is asked for.
  const o = repaymentOutput(sponsor, ref);
  assert.equal(Address.toBech32(o.address), PAY_TO);
  assert.equal(Assets.lovelaceOf(o.assets), 2_500_000n);
  assert.equal(Data.toCBORHex(o.datum.data), `d8799f5820${txid(0xc0)}01ff`);
});

// ---- the opening that names the seller --------------------------------------------------------------------

const WALLET_TOKENS = 20_000_000n;

/** A wallet with tUSDM and ADA, and a 402 for `scriptHash` that may carry the seller's fee-sponsor offer. */
async function openingWorld(scriptHash: string, withOffer: boolean, trusted: Validator[] = [UPSTREAM, SPONSORED]) {
  const offline = offlineBlockfrost();
  const wallet = offlineWallet();
  const me = await wallet.address();
  offline.setUtxos(me, [utxoAt(me, 0xb0, 0, tokens(WALLET_TOKENS, 1_176_630n)), utxoAt(me, 0xb1, 0, Assets.fromLovelace(20_000_000n))]);
  const offer: FeeSponsorOffer = { input: refOf(0xa0, 3), address: sponsorKey.bech32, lovelace: "4000000", maxFee: "500000", expiresAt: String(Date.now() + 300_000) };
  const chain = { network: NETWORK, getUnspent: async (ref: string) => (ref === offer.input ? utxoAt(sponsorKey.address, 0xa0, 3, Assets.fromLovelace(4_000_000n)) : undefined) } as unknown as Chain;
  const client = new BatchSettlementCardanoClient({ wallet, storage: newStorage(), chain, trustedValidators: trusted });
  const r = req(scriptHash, { extra: { scriptHash, receiverAuthorizer: seller.keyHash, withdrawDelay: 900, ...(withOffer ? { feeSponsor: offer } : {}) } });
  const open = async () => {
    const p = parseClientPayload((await client.createPaymentPayload(2, r)).payload);
    assert.equal(p.type, "deposit");
    if (p.type !== "deposit") throw new Error("unreachable");
    const hex = Buffer.from(p.deposit.transaction, "base64").toString("hex");
    const tx = Transaction.fromCBORHex(hex);
    const channel = tx.body.outputs.filter((o) => o.address.paymentCredential instanceof ScriptHash.ScriptHash && ScriptHash.toHex(o.address.paymentCredential) === scriptHash);
    assert.equal(channel.length, 1);
    return { p, hex, tx, channel: channel[0]!, me, offer };
  };
  return { offline, open };
}

test("a sponsored opening at the variant names payTo as sponsor and the whole reserve as floor, as the facilitator and the seller both read it", async () => {
  const w = await openingWorld(SPONSORED.hash, true);
  try {
    const { p, hex, channel, tx, offer } = await w.open();
    const datum = parseDatum((channel.datumOption as InlineDatum.InlineDatum).data, SPONSORED, 0);
    const expected = sponsoredChannel(chan, constantsOf(p.channelConfig, p.voucher.channelId), PAY_TO, CPB);
    assert.deepEqual(datum.constants.sponsor, { address: PAY_TO, floor: expected.reserve });
    assert.equal(Assets.lovelaceOf(channel.assets), expected.reserve, "the channel holds the floor, which is its whole reserve");
    assert.equal(Assets.getByUnit(channel.assets, UNIT), BigInt(p.deposit.amount));
    assert.deepEqual(datum.constants, expected.constants);
    assert.equal(Address.toBech32(channel.address), Address.toBech32(chan));
    // The facilitator accepts what the client wrote, and the seller's own check does.
    assert.equal(deposit(hex, { config: p.channelConfig, channelId: p.voucher.channelId, amount: BigInt(p.deposit.amount) }).capacity, BigInt(p.deposit.amount));
    const checked = await checkSponsoredOpen({
      txHex: hex,
      offer,
      network: NETWORK,
      payTo: PAY_TO,
      sponsorKeyHash: sponsorKey.keyHash,
      ownerOf: async (ref) => (ref.startsWith(txid(0xb0)) ? { exists: true, paymentKeyHash: "00".repeat(28) } : { exists: true }),
      fees: { minFeeA: 44n, minFeeB: 155_381n },
      missingWitnesses: 1,
      scriptHash: SPONSORED.hash,
      reserve: expected.reserve,
    });
    assert.ok(checked.ok, checked.ok ? "" : `${checked.rule}: ${checked.detail}`);
    // The buyer paid for none of it: the channel's ADA is the offer's, and its own ADA only passed through.
    assert.ok(tx.body.inputs.some((i) => `${TransactionHash.toHex(i.transactionId)}#${i.index}` === offer.input));
    // The offer must leave payTo a change that clears min-UTxO after the larger reserve: 4 ADA does, and
    // a pool's default smallest offer, 3.5 ADA, does not for a seller at a base address (it still does for upstream's reserve).
    const minChange = minAdaOutput(Address.fromBech32(PAY_TO), CPB);
    const toPayTo = tx.body.outputs.filter((o) => Address.toBech32(o.address) === PAY_TO).reduce((sum, o) => sum + Assets.lovelaceOf(o.assets), 0n);
    assert.equal(toPayTo, 4_000_000n - expected.reserve - tx.body.fee);
    assert.ok(toPayTo >= minChange);
    assert.ok(3_500_000n - expected.reserve - tx.body.fee < minChange, "a 3.5 ADA offer would leave payTo less than min-UTxO");
    assert.ok(3_500_000n - channelReserve(chanUp, constantsOf(p.channelConfig, p.voucher.channelId), CPB) - tx.body.fee >= minChange, "as upstream's smaller reserve does not");
  } finally {
    w.offline.restore();
  }
});

test("an opening at the variant with no offer names no sponsor: the buyer's reserve is the buyer's", async () => {
  const w = await openingWorld(SPONSORED.hash, false);
  try {
    const { p, hex, channel } = await w.open();
    const datum = parseDatum((channel.datumOption as InlineDatum.InlineDatum).data, SPONSORED, 0);
    assert.equal(datum.constants.sponsor, undefined);
    assert.equal((((channel.datumOption as InlineDatum.InlineDatum).data as Data.Data[])[1] as Data.Data[]).length, 7);
    assert.equal(Assets.lovelaceOf(channel.assets), channelReserve(chan, datum.constants, CPB));
    assert.equal(deposit(hex, { config: p.channelConfig, channelId: p.voucher.channelId, amount: BigInt(p.deposit.amount) }).capacity, BigInt(p.deposit.amount));
  } finally {
    w.offline.restore();
  }
});

test("an opening at upstream's validator is as it was, an offer or not: six constants, upstream's reserve", async () => {
  for (const withOffer of [true, false]) {
    const w = await openingWorld(UPSTREAM.hash, withOffer);
    try {
      const { p, hex, channel } = await w.open();
      const datum = parseDatum((channel.datumOption as InlineDatum.InlineDatum).data);
      assert.equal(datum.constants.sponsor, undefined);
      assert.equal((((channel.datumOption as InlineDatum.InlineDatum).data as Data.Data[])[1] as Data.Data[]).length, 6);
      assert.equal(Assets.lovelaceOf(channel.assets), channelReserve(chanUp, datum.constants, CPB));
      assert.equal(deposit(hex, { config: p.channelConfig, channelId: p.voucher.channelId, amount: BigInt(p.deposit.amount), scriptHash: UPSTREAM.hash }).capacity, BigInt(p.deposit.amount));
    } finally {
      w.offline.restore();
    }
  }
});

test("seller: an opening that spends its offer at the variant must name it as sponsor, or the reserve it pays is not coming back", async () => {
  const offer: FeeSponsorOffer = { input: refOf(0xa0, 3), address: sponsorKey.bech32, lovelace: "4000000", maxFee: "500000", expiresAt: String(Date.now() + 300_000) };
  const S = 4_000_000n;
  const fee = 200_000n;
  const spending = (datum: Data.Data, lovelace: bigint) =>
    signedBy(
      unsigned({
        inputs: [input(0xa0, 3), seedInput],
        outputs: [out(buyer, tokens(19_000_000n, 1_176_630n)), new TxOut.TransactionOutput({ address: chan, assets: tokens(1_000_000n, lovelace), datumOption: new InlineDatum.InlineDatum({ data: datum }) }), out({ address: Address.fromBech32(PAY_TO) }, Assets.fromLovelace(S - lovelace - fee))],
        fee,
        extra: { ttl: 100_000_000n },
      }),
      buyer,
    );
  const check = (hex: string) =>
    checkSponsoredOpen({
      txHex: hex,
      offer: { ...offer, expiresAt: String(Date.now() + 10 * 365 * 86_400_000) },
      network: NETWORK,
      payTo: PAY_TO,
      sponsorKeyHash: sponsorKey.keyHash,
      ownerOf: async (ref) => (ref.startsWith(txid(0xb0)) ? { exists: true, paymentKeyHash: buyer.keyHash } : { exists: true }),
      fees: { minFeeA: 0n, minFeeB: 0n },
      missingWitnesses: 0,
      scriptHash: SPONSORED.hash,
      reserve: RESERVE,
    });
  const good = await check(spending(sponsoredDatum(), RESERVE));
  assert.ok(good.ok, good.ok ? "" : `${good.rule}: ${good.detail}`);
  for (const [what, datum] of Object.entries({
    "no sponsor": plainDatum(),
    "another sponsor": sponsoredDatum({ sponsor: { address: OTHER, floor: RESERVE } }),
    "the right sponsor, a smaller floor": sponsoredDatum({ sponsor: { address: PAY_TO, floor: RESERVE - 1n } }),
  })) {
    const r = await check(spending(datum, RESERVE));
    assert.equal(r.ok ? "" : r.rule, "S4", what);
    assert.match(r.ok ? "" : r.detail, /names payTo as its sponsor with its whole \d+ lovelace as the floor/, what);
  }
});

/** The seller's pool of one 4 ADA UTxO, which signs as the sponsor key. */
async function poolOf(...utxos: UTxO.UTxO[]) {
  const pool = new SponsorPool({
    wallet: {
      address: async () => sponsorKey.address,
      getWalletUtxos: async () => utxos,
      signTx: async (txHex: string) => {
        const hash = TransactionBody.toHashFromBytes(Transaction.extractBodyBytes(Buffer.from(txHex, "hex")));
        return TransactionWitnessSet.fromVKeyWitnesses([new TransactionWitnessSet.VKeyWitness({ vkey: VKey.fromPrivateKey(sponsorKey.key), signature: PrivateKey.sign(sponsorKey.key, hash.hash) })]);
      },
    },
  });
  await pool.refresh();
  return pool;
}

test("server, at the variant: it signs for its offer only an opening that names it as sponsor, as its client writes one", async () => {
  const offline = offlineBlockfrost();
  try {
    const wallet = offlineWallet();
    const me = await wallet.address();
    const mine = utxoAt(me, 0xb0, 0, tokens(WALLET_TOKENS, 1_176_630n));
    offline.setUtxos(me, [mine, utxoAt(me, 0xb1, 0, Assets.fromLovelace(20_000_000n))]);
    const fees = { minFeeA: 44n, minFeeB: 155_381n };
    const world = async (pool: SponsorPool) => {
      const offer = (await pool.offer(120_000))!;
      const offered = utxoAt(sponsorKey.address, 0xa0, 3, Assets.fromLovelace(4_000_000n));
      const chain = {
        network: NETWORK,
        feeParameters: async () => fees,
        coinsPerUtxoByte: async () => CPB,
        getUnspent: async (ref: string) => (ref === offer.input ? offered : ref === refOf(0xb0, 0) ? mine : ref === refOf(0xb0, 1) ? buyerUtxo : undefined),
      } as unknown as Chain;
      const server = new BatchSettlementCardanoServer({ payTo: PAY_TO, receiverAuthorizer: seller.keyHash, scriptHash: SPONSORED.hash, chain, sponsor: { pool }, signAsProvider: async () => "" });
      const r = req(SPONSORED.hash, { extra: { scriptHash: SPONSORED.hash, receiverAuthorizer: seller.keyHash, withdrawDelay: 900, feeSponsor: offer } });
      const verify = async (payload: Record<string, unknown>) => {
        const paymentPayload = { x402Version: 2, accepted: r, payload } as PaymentPayload;
        const h = server.schemeHooks;
        assert.equal(await h.onBeforeVerify!({ paymentPayload, requirements: r, declaredExtensions: {} } as never), undefined);
        const result = { isValid: true, payer: buyer.keyHash, extra: { channelId: TAG, channelRef: "", balance: "1000000", totalClaimed: "0", withdrawRequestedAt: 0 } };
        return (await h.onAfterVerify!({ paymentPayload, requirements: r, declaredExtensions: {}, result } as never)) as { abort?: true; reason?: string; message?: string } | undefined;
      };
      return { offer, chain, r, verify };
    };

    // The opening the client writes: the server binds its offer to it and signs.
    const good = await poolOf(utxoAt(sponsorKey.address, 0xa0, 3, Assets.fromLovelace(4_000_000n)));
    const w = await world(good);
    const client = new BatchSettlementCardanoClient({ wallet, storage: newStorage(), chain: w.chain, trustedValidators: [SPONSORED] });
    const made = await client.createPaymentPayload(2, w.r);
    assert.equal(await w.verify(made.payload), undefined);
    assert.deepEqual(good.size(), { utxos: 1, bound: 1 }, "the offer is bound to that transaction");

    // One that spends the offer but names no sponsor, or another: refused before the seller signs.
    const fee = 400_000n;
    const spending = (datum: Data.Data, lovelace: bigint) =>
      signedBy(
        unsigned({
          inputs: [input(0xa0, 3), seedInput],
          outputs: [out(buyer, tokens(19_000_000n, 1_176_630n)), new TxOut.TransactionOutput({ address: chan, assets: tokens(1_000_000n, lovelace), datumOption: new InlineDatum.InlineDatum({ data: datum }) }), out({ address: Address.fromBech32(PAY_TO) }, Assets.fromLovelace(4_000_000n - lovelace - fee))],
          fee,
          extra: { ttl: 100_000_000n },
        }),
        buyer,
      );
    const plainReserve = channelReserve(chan, constantsFor(), CPB);
    for (const [what, datum, lovelace] of [["no sponsor", plainDatum(), plainReserve], ["another sponsor", sponsoredDatum({ sponsor: { address: OTHER, floor: RESERVE } }), RESERVE]] as const) {
      const pool = await poolOf(utxoAt(sponsorKey.address, 0xa0, 3, Assets.fromLovelace(4_000_000n)));
      const bad = await world(pool);
      const payload = { type: "deposit", channelConfig: cfg(), voucher: { channelId: TAG, maxClaimableAmount: "100000", signature: iou.sign(TAG, 100_000n) }, deposit: { amount: "1000000", transaction: Buffer.from(spending(datum, lovelace), "hex").toString("base64") } };
      const refused = await bad.verify(payload);
      assert.equal(refused?.reason, "fee_sponsor_S4", what);
      assert.match(refused?.message ?? "", /names payTo as its sponsor with its whole \d+ lovelace as the floor/, what);
      assert.deepEqual(pool.size(), { utxos: 1, bound: 0 }, `${what}: the offer stays free`);
    }
  } finally {
    offline.restore();
  }
});

// ---- reading a channel at the variant ----------------------------------------------------------------------

test("the chain reads a channel at the variant by the variant's datum, and a six-constant datum there is nobody's", async () => {
  const offline = offlineBlockfrost();
  try {
    const sponsored = utxoAt(chan, 0xc0, 1, tokens(1_000_000n, RESERVE), sponsoredDatum());
    const plain = utxoAt(chan, 0xc1, 0, tokens(5n, 3_000_000n), plainDatum());
    const six = utxoAt(chan, 0xc2, 0, tokens(5n, 3_000_000n), datumData(constantsFor(), opened, { ...UPSTREAM, hash: SPONSORED.hash }));
    const upstream = utxoAt(chanUp, 0xc3, 0, tokens(5n, 3_000_000n), plainDatum(UPSTREAM));
    offline.setUtxos(chan, [sponsored, plain, six]);
    offline.setUtxos(chanUp, [upstream]);
    const chain = new BlockfrostChain(NETWORK, OFFLINE_BASE, "key", 1);
    const atVariant = await chain.channels(SPONSORED.hash);
    assert.deepEqual(atVariant.map((c) => c.ref), [refOf(0xc0, 1), refOf(0xc1, 0)], "the datum with six constants is no channel: nothing could spend it");
    assert.deepEqual(atVariant[0]!.datum.constants.sponsor, { address: PAY_TO, floor: RESERVE });
    assert.equal(atVariant[1]!.datum.constants.sponsor, undefined);
    assert.deepEqual((await chain.channels(UPSTREAM.hash)).map((c) => c.ref), [refOf(0xc3, 0)]);
    // Followed from a position of it, a channel is read the same way, and only at its own validator.
    const followed = await chain.followChannel(refOf(0xc0, 1), SPONSORED.hash, TAG);
    assert.equal(followed?.lovelace, RESERVE);
    assert.deepEqual(followed?.datum.constants.sponsor, { address: PAY_TO, floor: RESERVE });
    assert.equal(await chain.followChannel(refOf(0xc0, 1), UPSTREAM.hash, TAG), undefined);
  } finally {
    offline.restore();
  }
});

test("a sponsor's address in a channel's datum is read on the network of the channel's own address", () => {
  const main = bech(kh(seller.keyHash), kh(stranger.keyHash), 1);
  const constants = { ...SPONSORED_OPENING.constants, sponsor: { address: main, floor: RESERVE } };
  for (const [networkId, sponsor] of [[1, main], [0, PAY_TO]] as const) {
    const at = channelAddress(networkId, undefined, SPONSORED);
    const ch = readChannel(utxoAt(at, 0xc0, 0, tokens(5n, RESERVE), datumData(constants, opened, SPONSORED)), SPONSORED.hash);
    assert.ok(!("error" in ch));
    assert.equal(ch.datum.constants.sponsor?.address, sponsor);
  }
  // A datum that names another script, or a reference script riding on the output, is no channel either.
  const named = readChannel(utxoAt(chan, 0xc0, 0, tokens(5n, RESERVE), datumData(constants, opened, { ...SPONSORED, hash: UPSTREAM.hash })), SPONSORED.hash);
  assert.deepEqual(named, { error: "datum names another script" });
});

// ---- the facilitator's claims, over the variant's channels ------------------------------------------------------

test("facilitator: a claim over channels at the variant is a claim only where it serves the variant, and a delegated one finds its channel at whichever validator it is", async () => {
  const w = await providerWorld({ stage: opened });
  try {
    const open = w.view(0xd1, opened, 1_000n);
    const { hex } = await buildClaimTx(w.builder, [{ channelId: TAG, totalClaimed: 400n, amount: 400n, signature: iou.sign(TAG, 400n), v: open }]);
    const inputs = new Map([[open.ref, open.utxo], [refOf(0xb1, 0), utxoAt(w.address, 0xb1, 0, Assets.fromLovelace(10_000_000n))]]);
    const sent: string[] = [];
    const asked: string[] = [];
    const chain = {
      network: NETWORK,
      getUnspent: async (ref: string) => inputs.get(ref),
      evaluate: async () => {},
      submit: async (h: string) => (sent.push(h), txHashOf(h)),
      awaitTx: async () => true,
      followChannel: async (ref: string, hash: string) => (asked.push(hash), hash === SPONSORED.hash && ref === open.ref ? open : undefined),
    } as unknown as Chain;
    const claimReq: PaymentRequirements = { scheme: "batch-settlement", network: NETWORK, asset: "lovelace", amount: "0", payTo: w.payTo, maxTimeoutSeconds: 0, extra: {} };
    const claim = (payload: Record<string, unknown>): PaymentPayload => ({ x402Version: 2, accepted: claimReq, payload });
    const body = { type: "claim", transaction: Buffer.from(hex, "hex").toString("base64"), claims: [{ channelId: TAG, totalClaimed: "400" }] };

    const ok = await new BatchSettlementCardanoFacilitator(chain, { validators: [UPSTREAM, SPONSORED] }).settle(claim(body), claimReq);
    assert.equal(ok.success, true, ok.errorMessage);
    assert.deepEqual(sent, [hex]);
    const refused = await new BatchSettlementCardanoFacilitator(chain, {}).settle(claim(body), claimReq);
    assert.equal(refused.success, false);
    assert.match(refused.errorMessage ?? "", /claims list 1 channels, transaction spends 0/);
    assert.equal(sent.length, 1, "nothing more was broadcast");

    // A claim the server asks the facilitator to build, for a provider key it holds: the channel is looked for at each validator served.
    const secret = "s3cret";
    const claims = [{ channelId: TAG, totalClaimed: "400", channelRef: open.ref, voucher: { maxClaimableAmount: "400", signature: iou.sign(TAG, 400n) } }];
    const delegated = { type: "claim", claims, delegationMac: delegationMac(secret, w.payTo, { type: "claim", claims }) };
    const delegating = new BatchSettlementCardanoFacilitator(chain, { validators: [UPSTREAM, SPONSORED], delegates: [{ wallet: w.wallet, keyHash: w.providerKeyHash, payTo: w.payTo, secret }] });
    const done = await delegating.settle(claim(delegated), claimReq);
    assert.equal(done.success, true, done.errorMessage);
    assert.deepEqual(asked, [UPSTREAM.hash, SPONSORED.hash]);
    const built = Transaction.fromCBORHex(sent.at(-1)!);
    assert.equal(ScriptHash.toHex(ScriptHash.fromScript(built.witnessSet.plutusV3Scripts![0]!)), SPONSORED.hash);
    assert.equal(floorProblem(built, SPONSORED.hash, [w.reserve]), undefined);
  } finally {
    w.offline.restore();
  }
});

// ---- the refund, the same at either validator -------------------------------------------------------------------------

/** A client with an open channel at `validator` holding 1,000,000 tokens and nothing owed, and the 402 to refund it by. */
async function refundWorld(o: { validator: Validator; sponsored: boolean }) {
  const offline = offlineBlockfrost();
  const wallet = offlineWallet();
  const me = await wallet.address();
  const payer = KeyHash.toHex(me.paymentCredential as KeyHash.KeyHash);
  const iouKey = derivedIouSigner(await iouRootOf(wallet), NETWORK, TAG);
  const walletUtxos = [utxoAt(me, 0xb0, 0, tokens(WALLET_TOKENS, 1_176_630n)), utxoAt(me, 0xb1, 0, Assets.fromLovelace(20_000_000n))];
  offline.setUtxos(me, walletUtxos);
  const at = channelAddress(0, undefined, o.validator);
  const config = cfg({ payer, payerAuthorizer: iouKey.publicKey });
  const base = constantsOf(config, TAG);
  const { constants, reserve } = o.sponsored ? sponsoredChannel(at, base, PAY_TO, CPB) : { constants: base, reserve: channelReserve(at, base, CPB) };
  const utxo = utxoAt(at, 0xc0, 1, tokens(1_000_000n, reserve), datumData(constants, opened, o.validator));
  offline.know(utxo);
  const view = { utxo, ref: refOf(0xc0, 1), address: at, datum: { ownHash: o.validator.hash, constants, stage: opened }, lovelace: reserve, amount: 1_000_000n } as unknown as ChannelView;
  const offer: FeeSponsorOffer = { input: refOf(0xa0, 3), address: sponsorKey.bech32, lovelace: "4000000", maxFee: "500000", expiresAt: String(Date.now() + 300_000) };
  const offerUtxo = utxoAt(sponsorKey.address, 0xa0, 3, Assets.fromLovelace(4_000_000n));
  const chain = { network: NETWORK, followChannel: async () => view, getUnspent: async (ref: string) => (ref === offer.input ? offerUtxo : undefined) } as unknown as Chain;
  const r = req(o.validator.hash, { extra: { scriptHash: o.validator.hash, receiverAuthorizer: seller.keyHash, withdrawDelay: 900, ...(o.sponsored ? { feeSponsor: offer } : {}) } });
  const storage = newStorage();
  await storage.set({ channelId: TAG, serverKey: serverKey(r, parseExtra(r)), channelConfig: config, iouKey: "derived", channelRef: view.ref, network: NETWORK, scriptHash: o.validator.hash, deposit: "1000000", balance: "1000000", chargedCumulativeAmount: "0", status: "open", openedAt: 1, ...(o.sponsored ? { reserveFrom: "seller" as const } : {}) });
  const client = new BatchSettlementCardanoClient({ wallet, storage, chain, trustedValidators: [o.validator] });
  const pr: PaymentRequired = { x402Version: 2, resource: { url: "http://seller.invalid/refund" }, accepts: [r] };
  return { offline, client, pr, reserve, me, payer, known: [utxo, ...walletUtxos, offerUtxo] };
}

test("a refund spends the channel with Mutual and the script of the validator it is at, sponsored or not", async () => {
  for (const [validator, sponsored] of [[UPSTREAM, false], [SPONSORED, false], [SPONSORED, true]] as const) {
    const w = await refundWorld({ validator, sponsored });
    try {
      const made = await w.client.refundPayload(w.pr, TAG);
      const p = parseClientPayload(made.payload);
      assert.equal(p.type, "refund");
      if (p.type !== "refund") throw new Error("unreachable");
      const tx = Transaction.fromCBORHex(Buffer.from(p.transaction, "base64").toString("hex"));
      const label = `${validator.name}${sponsored ? ", sponsored" : ""}`;
      assert.deepEqual((tx.witnessSet.plutusV3Scripts ?? []).map((s) => ScriptHash.toHex(ScriptHash.fromScript(s))), [validator.hash], label);
      assert.equal(Data.toCBORHex([...spendRedeemers(tx).values()][0]!), Data.toCBORHex(Redeemer.mutual()), label);
      assert.deepEqual((tx.body.requiredSigners ?? []).map((k) => KeyHash.toHex(k)).sort(), [w.payer, seller.keyHash].sort(), label);
      // Nothing is left at the validator, and a sponsored channel's reserve goes back to payTo, less the fee.
      assert.equal(tx.body.outputs.some((o) => o.address.paymentCredential instanceof ScriptHash.ScriptHash), false, label);
      if (sponsored) {
        const toSeller = tx.body.outputs.filter((o) => Address.toBech32(o.address) === PAY_TO).reduce((sum, o) => sum + Assets.lovelaceOf(o.assets), 0n);
        assert.equal(toSeller + tx.body.fee >= w.reserve, true, label);
      }
    } finally {
      w.offline.restore();
    }
  }
});

// ---- exits ---------------------------------------------------------------------------------------------------

const BASE_CLOSED_AT = 1_700_000_000_000n;

interface ExitWorld {
  readonly offline: ReturnType<typeof offlineBlockfrost>;
  readonly client: BatchSettlementCardanoClient;
  readonly view: ChannelView;
  readonly submitted: string[];
  readonly calls: { tipSlot: number };
  readonly me: Address.Address;
  readonly reserve: bigint;
  readonly floor: bigint | undefined;
  /** What the exit spends and puts up as collateral: the channel and the wallet's UTxOs. */
  readonly known: UTxO.UTxO[];
}

/**
 * A client whose channel sits at `validator` in `stage`, holding `held` tokens beside its reserve,
 * with the wallet's UTxOs as given. The chain answers only what an exit reads, and keeps what it is sent.
 */
async function exitWorld(o: { validator: Validator; sponsored: boolean; stage: Stage; held: bigint; wallet?: (me: Address.Address) => UTxO.UTxO[]; reserveFrom?: "seller"; tip?: bigint | ((read: number) => bigint) }): Promise<ExitWorld> {
  const offline = offlineBlockfrost();
  const wallet = offlineWallet();
  const me = await wallet.address();
  const payer = KeyHash.toHex(me.paymentCredential as KeyHash.KeyHash);
  const walletUtxos = (o.wallet ?? ((a) => [utxoAt(a, 0xb1, 0, Assets.fromLovelace(10_000_000n))]))(me);
  offline.setUtxos(me, walletUtxos);
  const at = channelAddress(0, undefined, o.validator);
  const base = constantsOf(cfg({ payer }), TAG);
  const { constants, reserve } = o.sponsored ? sponsoredChannel(at, base, PAY_TO, CPB) : { constants: base, reserve: channelReserve(at, base, CPB) };
  const datum = datumData(constants, o.stage, o.validator);
  const utxo = utxoAt(at, 0xc0, 1, o.held > 0n ? tokens(o.held, reserve) : Assets.fromLovelace(reserve), datum);
  const view = { utxo, ref: refOf(0xc0, 1), address: at, datum: { ownHash: o.validator.hash, constants, stage: o.stage }, lovelace: reserve, amount: o.held } as unknown as ChannelView;
  const submitted: string[] = [];
  const calls = { tipSlot: 0 };
  const chain = {
    network: NETWORK,
    followChannel: async () => view,
    tipSlot: async () => (calls.tipSlot++, typeof o.tip === "function" ? o.tip(calls.tipSlot) : (o.tip ?? 1_000_000_000n)),
    submit: async (hex: string) => (submitted.push(hex), txHashOf(hex)),
    awaitTx: async () => true,
    txHeight: async () => undefined,
    getUnspent: async () => undefined,
  } as unknown as Chain;
  const storage = newStorage();
  await storage.set({
    channelId: TAG,
    serverKey: serverKey(req(o.validator.hash), parseExtra(req(o.validator.hash))),
    channelConfig: cfg({ payer }),
    channelRef: view.ref,
    network: NETWORK,
    scriptHash: o.validator.hash,
    deposit: o.held.toString(),
    balance: o.held.toString(),
    chargedCumulativeAmount: "0",
    status: o.stage.kind === "opened" ? "open" : "closing",
    openedAt: 1,
    ...(o.reserveFrom ? { reserveFrom: o.reserveFrom } : {}),
  });
  // Exits act on the channel's own record: trusting the variant is for 402s, not for getting funds out of one.
  const client = new BatchSettlementCardanoClient({ wallet, storage, chain });
  return { offline, client, view, submitted, calls, me, reserve, floor: constants.sponsor?.floor, known: [utxo, ...walletUtxos] };
}

const closed: Stage = { kind: "closed", subbed: 0n, elapseAt: BASE_CLOSED_AT };
const settled: Stage = { kind: "settled" };

/** What a transaction pays `address`, per output, and the outputs that carry a datum. */
function paysTo(tx: Transaction.Transaction, address: string) {
  const hex = Address.toHex(Address.fromBech32(address));
  return tx.body.outputs.filter((o) => Address.toHex(o.address) === hex);
}
const sumIn = (tx: Transaction.Transaction, utxos: UTxO.UTxO[]) => utxos.filter((u) => tx.body.inputs.some((i) => TransactionHash.toHex(i.transactionId) === TransactionHash.toHex(u.transactionId) && i.index === u.index)).reduce((s, u) => s + Assets.lovelaceOf(u.assets), 0n);

for (const exit of ["elapse", "end"] as const) {
  test(`a sponsored channel's ${exit} by its buyer repays the sponsor out of the channel, and costs the buyer only the fee`, async () => {
    const stage = exit === "elapse" ? closed : settled;
    const w = await exitWorld({ validator: SPONSORED, sponsored: true, stage, held: 1_000_000n });
    try {
      const walletUtxos = [utxoAt(w.me, 0xb1, 0, Assets.fromLovelace(10_000_000n))];
      if (exit === "elapse") await w.client.elapse(TAG, { wait: false });
      else await w.client.end(TAG);
      assert.equal(w.submitted.length, 1);
      const tx = Transaction.fromCBORHex(w.submitted[0]!);

      // R2: an output at payTo whole, with the channel's reference as its datum, of at least the floor.
      const repaid = paysTo(tx, PAY_TO);
      assert.equal(repaid.length, 1);
      assert.equal(Assets.lovelaceOf(repaid[0]!.assets), w.floor);
      assert.equal(Data.toCBORHex((repaid[0]!.datumOption as InlineDatum.InlineDatum).data), `d8799f5820${txid(0xc0)}01ff`);
      assert.equal(repaymentProblem(tx, w.view.ref, { address: PAY_TO, floor: w.floor! }), undefined);

      // The tokens come home, the buyer signs, the validator is spent with the right step.
      const home = tx.body.outputs.filter((o) => Assets.getByUnit(o.assets, UNIT) === 1_000_000n);
      assert.equal(home.length, 1);
      assert.equal(Address.toBech32(home[0]!.address), Address.toBech32(w.me));
      assert.deepEqual((tx.body.requiredSigners ?? []).map((k) => KeyHash.toHex(k)), [KeyHash.toHex(w.me.paymentCredential as KeyHash.KeyHash)]);
      const redeemers = spendRedeemers(tx);
      assert.equal(redeemers.size, 1);
      assert.equal(Data.toCBORHex([...redeemers.values()][0]!), Data.toCBORHex(Redeemer.main([exit === "elapse" ? Step.elapse() : Step.end()])));
      assert.equal(tx.body.collateralInputs?.length, 1, "the buyer's own ADA is the collateral");
      assert.equal(tx.witnessSet.plutusV3Scripts?.length, 1, "the validator is attached, the variant's");

      // The buyer's ADA: it put in the fee and got the rest back, the token output's ADA among it. Nothing of the channel's.
      const toBuyer = paysTo(tx, Address.toBech32(w.me)).reduce((s, o) => s + Assets.lovelaceOf(o.assets), 0n);
      assert.equal(sumIn(tx, walletUtxos) - toBuyer, tx.body.fee, "the wallet pays the fee and nothing else");
      assert.ok(tx.body.fee > 150_000n && tx.body.fee < 700_000n, `fee ${tx.body.fee}`);
    } finally {
      w.offline.restore();
    }
  });
}

test("a sponsored channel that holds none of its currency is not the buyer's to end: R3 gives that to the provider", async () => {
  const w = await exitWorld({ validator: SPONSORED, sponsored: true, stage: settled, held: 0n });
  try {
    await assert.rejects(w.client.end(TAG), /holds none of its currency, so R3 leaves its End to the provider.*nothing to take/);
    assert.equal(w.submitted.length, 0);
  } finally {
    w.offline.restore();
  }
});

test("a solo exit of a sponsored channel fails early, and says why, for a wallet with no ADA of its own", async () => {
  const onlyTokens = (me: Address.Address) => [utxoAt(me, 0xb2, 0, tokens(5_000_000n, 1_300_000n))];
  for (const exit of ["elapse", "end"] as const) {
    const w = await exitWorld({ validator: SPONSORED, sponsored: true, stage: exit === "elapse" ? closed : settled, held: 1_000_000n, wallet: onlyTokens });
    try {
      await assert.rejects(exit === "elapse" ? w.client.elapse(TAG, { wait: false }) : w.client.end(TAG), /a solo (end|elapse) of a sponsored channel repays its sponsor \d+ lovelace out of the channel, so the fee, the min-ADA of the tokens that come back, and the collateral are this wallet's own to pay, and it holds no ADA-only UTxO/);
      assert.equal(w.submitted.length, 0);
      assert.equal(w.offline.calls.filter((c) => c.includes("/utils/txs/evaluate")).length, 0, "before it builds");
    } finally {
      w.offline.restore();
    }
  }
  // Some ADA, not enough: it is told how much, and that the collateral comes besides.
  const w = await exitWorld({ validator: SPONSORED, sponsored: true, stage: settled, held: 1_000_000n, wallet: (me) => [utxoAt(me, 0xb1, 0, Assets.fromLovelace(1_000_000n))] });
  try {
    await assert.rejects(w.client.end(TAG), new RegExp(`about ${EXIT_FEE_ADA + EXIT_TOKEN_OUTPUT_ADA} lovelace beside the collateral, and it holds 1000000`));
  } finally {
    w.offline.restore();
  }
  // Enough to pay, nothing to put up as collateral.
  const small = (me: Address.Address) => [utxoAt(me, 0xb1, 0, Assets.fromLovelace(900_000n)), utxoAt(me, 0xb2, 0, Assets.fromLovelace(900_000n))];
  const v = (await exitWorld({ validator: SPONSORED, sponsored: true, stage: settled, held: 1_000_000n })).view;
  assert.throws(() => assertExitFunds("end", small(party(7).address) as UTxO.UTxO[], v), /and it has none to put up: no ADA-only UTxOs large enough for collateral/);
  assert.doesNotThrow(() => assertExitFunds("end", [utxoAt(party(7).address, 0xb1, 0, Assets.fromLovelace(10_000_000n))], v));
  // An exit nobody sponsors is not this check's.
  const plain = (await exitWorld({ validator: SPONSORED, sponsored: false, stage: settled, held: 1_000_000n })).view;
  assert.doesNotThrow(() => assertExitFunds("end", [], plain));
});

test("an elapse that must wait for its time says first that the wallet cannot pay, and one that is only too early does not read the wallet", async () => {
  const onlyTokens = (me: Address.Address) => [utxoAt(me, 0xb2, 0, tokens(5_000_000n, 1_300_000n))];
  // The chain is years before the channel's elapse_at: waiting would take until then, and the wallet could not pay when it did.
  // An elapse that slept first would read the tip again after a minute; this one is stopped there rather than left to wait for ever.
  const tip = (read: number) => {
    if (read > 1) throw new Error("the elapse slept for its time and read the tip again: it never looked at the wallet first");
    return 1_000n;
  };
  const w = await exitWorld({ validator: SPONSORED, sponsored: true, stage: closed, held: 1_000_000n, wallet: onlyTokens, tip });
  try {
    await assert.rejects(w.client.elapse(TAG), /holds no ADA-only UTxO/);
    assert.equal(w.calls.tipSlot, 1, "it read the tip once, saw it had to wait, and looked at the wallet before it slept");
    const reads = () => w.offline.calls.filter((c) => c.includes("/addresses/")).length;
    const before = reads();
    w.calls.tipSlot = 0;
    await assert.rejects(w.client.elapse(TAG, { wait: false }), /^Error: not yet: the channel's elapse_at is/);
    assert.equal(reads(), before, "a refusal for being early costs no read of the wallet");
  } finally {
    w.offline.restore();
  }
});

test("a buyer's close keeps the channel's value, the floor with it, and its sponsor in the datum (R1)", async () => {
  const w = await exitWorld({ validator: SPONSORED, sponsored: true, stage: opened, held: 1_000_000n });
  try {
    const { transaction } = await w.client.close(TAG);
    const tx = Transaction.fromCBORHex(w.submitted[0]!);
    assert.equal(txHashOf(w.submitted[0]!), transaction);
    const at = tx.body.outputs.filter((o) => Address.toBech32(o.address) === Address.toBech32(chan));
    assert.equal(at.length, 1);
    assert.equal(Assets.lovelaceOf(at[0]!.assets), w.floor);
    assert.equal(Assets.getByUnit(at[0]!.assets, UNIT), 1_000_000n);
    const after = parseDatum((at[0]!.datumOption as InlineDatum.InlineDatum).data, SPONSORED, 0);
    assert.deepEqual(after.constants, w.view.datum.constants);
    assert.equal(after.stage.kind, "closed");
    assert.equal(floorProblem(tx, SPONSORED.hash, [w.floor]), undefined);
    // No repayment: the channel goes on.
    assert.equal(paysTo(tx, PAY_TO).length, 0);
  } finally {
    w.offline.restore();
  }
});

test("exits of a channel nobody sponsors add no repayment, at the variant or at upstream's validator", async () => {
  for (const [validator, exit] of [[SPONSORED, "elapse"], [SPONSORED, "end"], [UPSTREAM, "elapse"], [UPSTREAM, "end"]] as const) {
    const w = await exitWorld({ validator, sponsored: false, stage: exit === "elapse" ? closed : settled, held: 1_000_000n });
    try {
      if (exit === "elapse") await w.client.elapse(TAG, { wait: false });
      else await w.client.end(TAG);
      const tx = Transaction.fromCBORHex(w.submitted[0]!);
      assert.equal(paysTo(tx, PAY_TO).length, 0);
      assert.equal(tx.body.outputs.some((o) => o.datumOption instanceof InlineDatum.InlineDatum), false, `${validator.name} ${exit}`);
      // The channel's reserve comes back to the buyer: it nets the channel's ADA less the fee.
      const toBuyer = paysTo(tx, Address.toBech32(w.me)).reduce((s, o) => s + Assets.lovelaceOf(o.assets), 0n);
      assert.equal(toBuyer, sumIn(tx, [utxoAt(w.me, 0xb1, 0, Assets.fromLovelace(10_000_000n))]) + w.reserve - tx.body.fee, `${validator.name} ${exit}`);
      assert.equal(tx.witnessSet.plutusV3Scripts?.length, 1);
    } finally {
      w.offline.restore();
    }
  }
  // An empty channel nobody sponsors is the buyer's to end as before: R3 is for sponsored ones.
  const w = await exitWorld({ validator: SPONSORED, sponsored: false, stage: settled, held: 0n });
  try {
    await w.client.end(TAG);
    assert.equal(w.submitted.length, 1);
  } finally {
    w.offline.restore();
  }
});

// ---- a top-up, the same at either validator ---------------------------------------------------------------------------

/**
 * A client with an open channel at `validator` that a request will outgrow: 1,000,000 tokens held, 990,000 charged, and a 402 for 100,000 more.
 * A `sponsored` channel names `payTo` as its sponsor, and its 402 carries the seller's offer (`offer`, by default when it is sponsored).
 * `under` shows the channel the chain would have to show for it to be below its floor.
 */
async function topUpWorld(o: { validator: Validator; sponsored: boolean; offer?: boolean; under?: boolean }) {
  const offered = o.offer ?? o.sponsored;
  const offline = offlineBlockfrost();
  const wallet = offlineWallet();
  const me = await wallet.address();
  const payer = KeyHash.toHex(me.paymentCredential as KeyHash.KeyHash);
  const iouKey = derivedIouSigner(await iouRootOf(wallet), NETWORK, TAG);
  const walletUtxos = [utxoAt(me, 0xb0, 0, tokens(WALLET_TOKENS, 1_176_630n)), utxoAt(me, 0xb1, 0, Assets.fromLovelace(20_000_000n))];
  offline.setUtxos(me, walletUtxos);
  const at = channelAddress(0, undefined, o.validator);
  const config = cfg({ payer, payerAuthorizer: iouKey.publicKey });
  const base = constantsOf(config, TAG);
  const { constants, reserve } = o.sponsored ? sponsoredChannel(at, base, PAY_TO, CPB) : { constants: base, reserve: channelReserve(at, base, CPB) };
  const held = o.under ? reserve - 1n : reserve;
  const datum = datumData(constants, opened, o.validator);
  const utxo = utxoAt(at, 0xc0, 1, tokens(1_000_000n, held), datum);
  const view = { utxo, ref: refOf(0xc0, 1), address: at, datum: { ownHash: o.validator.hash, constants, stage: opened }, lovelace: held, amount: 1_000_000n } as unknown as ChannelView;
  const offer: FeeSponsorOffer = { input: refOf(0xa0, 3), address: sponsorKey.bech32, lovelace: "4000000", maxFee: "500000", expiresAt: String(Date.now() + 300_000) };
  const offerUtxo = utxoAt(sponsorKey.address, 0xa0, 3, Assets.fromLovelace(4_000_000n));
  const chain = {
    network: NETWORK,
    followChannel: async () => view,
    coinsPerUtxoByte: async () => CPB,
    getUnspent: async (ref: string) => (ref === offer.input ? offerUtxo : undefined),
  } as unknown as Chain;
  const r = req(o.validator.hash, { extra: { scriptHash: o.validator.hash, receiverAuthorizer: seller.keyHash, withdrawDelay: 900, ...(offered ? { feeSponsor: offer } : {}) } });
  const storage = newStorage();
  await storage.set({ channelId: TAG, serverKey: serverKey(r, parseExtra(r)), channelConfig: config, iouKey: "derived", channelRef: view.ref, network: NETWORK, scriptHash: o.validator.hash, deposit: "1000000", balance: "1000000", chargedCumulativeAmount: "990000", status: "open", openedAt: 1, ...(o.sponsored ? { reserveFrom: "seller" as const } : {}) });
  const client = new BatchSettlementCardanoClient({ wallet, storage, chain, trustedValidators: [o.validator] });
  const topUp = async () => {
    const p = parseClientPayload((await client.createPaymentPayload(2, r)).payload);
    assert.equal(p.type, "deposit");
    if (p.type !== "deposit") throw new Error("unreachable");
    const hex = Buffer.from(p.deposit.transaction, "base64").toString("hex");
    return { p, hex, tx: Transaction.fromCBORHex(hex) };
  };
  return { offline, topUp, view, offer, reserve, at, known: [utxo, ...walletUtxos, offerUtxo] };
}

test("a top-up keeps the channel's datum and its whole ADA, at either validator, sponsored or not, and the facilitator reads it as one", async () => {
  for (const [validator, sponsored, offer] of [[UPSTREAM, false, false], [SPONSORED, false, false], [SPONSORED, true, true], [SPONSORED, true, false]] as const) {
    const w = await topUpWorld({ validator, sponsored, offer });
    const label = `${validator.name}${sponsored ? ", sponsored" : ""}${offer ? ", on the seller's offer" : ""}`;
    try {
      const { p, hex, tx } = await w.topUp();
      assert.equal(p.voucher.channelRef, w.view.ref, label);
      const at = tx.body.outputs.filter((o) => Address.toBech32(o.address) === Address.toBech32(w.at));
      assert.equal(at.length, 1, label);
      assert.equal(Assets.lovelaceOf(at[0]!.assets), w.reserve, `${label}: the channel's ADA does not change`);
      assert.equal(Assets.getByUnit(at[0]!.assets, UNIT), 1_000_000n + BigInt(p.deposit.amount), label);
      assert.equal(Data.toCBORHex((at[0]!.datumOption as InlineDatum.InlineDatum).data), Data.toCBORHex((w.view.utxo.datumOption as InlineDatum.InlineDatum).data), `${label}: the datum is as it was`);
      assert.deepEqual((tx.witnessSet.plutusV3Scripts ?? []).map((s) => ScriptHash.toHex(ScriptHash.fromScript(s))), [validator.hash], label);
      assert.equal(Data.toCBORHex([...spendRedeemers(tx).values()][0]!), Data.toCBORHex(Redeemer.main([Step.add()])), label);
      if (offer) assert.deepEqual((tx.body.collateralInputs ?? []).map((i) => `${TransactionHash.toHex(i.transactionId)}#${i.index}`), [w.offer.input], `${label}: the offer is the collateral`);
      // What the facilitator makes of it.
      assert.equal(checkTopUp(hex, NETWORK, w.view, BigInt(p.deposit.amount), CPB).capacity, 1_000_000n + BigInt(p.deposit.amount), label);
    } finally {
      w.offline.restore();
    }
  }
});

test("a top-up that would take a sponsored channel under its floor is refused before it is signed, with the seller's offer or without (R1)", async () => {
  for (const offer of [true, false]) {
    const w = await topUpWorld({ validator: SPONSORED, sponsored: true, offer, under: true });
    try {
      await assert.rejects(w.topUp(), /holds \d+ lovelace, under its sponsor's floor of \d+ \(R1\)/, offer ? "with the offer" : "without");
    } finally {
      w.offline.restore();
    }
  }
});

// ---- the server: a claim that keeps the floor, and an End that gets it back ------------------------------------

/** The provider's wallet is account 1 of the test mnemonic; its address is the sponsor's `payTo`, as a seller's is. */
async function providerWorld(o: { validator?: Validator; sponsored?: boolean; sponsor?: string; held?: bigint; stage?: Stage; wallet?: (a: Address.Address) => UTxO.UTxO[] }) {
  const offline = offlineBlockfrost();
  const wallet = offlineWallet(1);
  const address = await wallet.address();
  const payTo = Address.toBech32(address);
  const providerKeyHash = KeyHash.toHex(address.paymentCredential as KeyHash.KeyHash);
  const walletUtxos = (o.wallet ?? ((a) => [utxoAt(a, 0xb1, 0, Assets.fromLovelace(10_000_000n))]))(address);
  offline.setUtxos(address, walletUtxos);
  const validator = o.validator ?? SPONSORED;
  const at = channelAddress(0, undefined, validator);
  const base = constantsOf(cfg({ receiver: payTo, receiverAuthorizer: providerKeyHash }), TAG);
  const { constants, reserve } = o.sponsored === false ? { constants: base, reserve: channelReserve(at, base, CPB) } : sponsoredChannel(at, base, o.sponsor ?? payTo, CPB);
  const held = o.held ?? 0n;
  const stage = o.stage ?? settled;
  const view = (n: number, s: Stage, amount: bigint, c: Constants = constants): ChannelView =>
    ({
      utxo: utxoAt(at, n, 0, amount > 0n ? tokens(amount, reserve) : Assets.fromLovelace(reserve), datumData(c, s, validator)),
      ref: refOf(n, 0),
      address: at,
      datum: { ownHash: validator.hash, constants: c, stage: s },
      lovelace: reserve,
      amount,
    }) as unknown as ChannelView;
  const submitted: string[] = [];
  const chain = {
    network: NETWORK,
    submit: async (hex: string) => (submitted.push(hex), txHashOf(hex)),
    awaitTx: async () => true,
    getUnspent: async () => undefined,
  } as unknown as Chain;
  const builder: ClaimBuilder = { wallet, providerKeyHash, chain, payTo, payout: "own", spent: new Map() };
  return { offline, wallet, address, payTo, providerKeyHash, constants, reserve, view, submitted, chain, builder, held, stage, walletUtxos };
}

test("the server's End of a settled, empty sponsored channel is the provider's, repays payTo, and is checked before it is signed (R2, R3)", async () => {
  const w = await providerWorld({});
  try {
    const v = w.view(0xd0, settled, 0n);
    const hex = await buildEndTx(w.builder, v);
    const tx = Transaction.fromCBORHex(hex);
    const repaid = paysTo(tx, w.payTo);
    const to = repaid.find((o) => o.datumOption instanceof InlineDatum.InlineDatum)!;
    assert.equal(Assets.lovelaceOf(to.assets), w.reserve, "the floor, which is the channel's whole ADA");
    assert.equal(Data.toCBORHex((to.datumOption as InlineDatum.InlineDatum).data), `d8799f5820${txid(0xd0)}00ff`);
    assert.deepEqual((tx.body.requiredSigners ?? []).map((k) => KeyHash.toHex(k)), [w.providerKeyHash], "R3: the provider signs, not the consumer");
    assert.equal(Data.toCBORHex([...spendRedeemers(tx).values()][0]!), Data.toCBORHex(Redeemer.main([Step.end()])));
    assert.equal(tx.body.collateralInputs?.length, 1);
    // The provider paid the fee out of its own ADA and got the floor back: it nets the floor less the fee.
    const net = repaid.reduce((s, o) => s + Assets.lovelaceOf(o.assets), 0n) - sumIn(tx, [utxoAt(w.address, 0xb1, 0, Assets.fromLovelace(10_000_000n))]);
    assert.equal(net, w.reserve - tx.body.fee);
    assert.ok(w.reserve > tx.body.fee, "it is worth doing");
  } finally {
    w.offline.restore();
  }
  // What it will not end.
  const x = await providerWorld({});
  try {
    await assert.rejects(buildEndTx(x.builder, x.view(0xd0, closed, 0n)), /closed, not settled/);
    await assert.rejects(buildEndTx({ ...x.builder, providerKeyHash: "ab".repeat(28) }, x.view(0xd0, settled, 0n)), /only the channel's own provider signs its End/);
    await assert.rejects(buildEndTx(x.builder, x.view(0xd0, settled, 5n)), /still holds its currency is ended by its consumer \(R3\)/);
    const noSponsor = { ...x.constants, sponsor: undefined };
    delete (noSponsor as { sponsor?: Sponsor }).sponsor;
    await assert.rejects(buildEndTx(x.builder, x.view(0xd0, settled, 0n, noSponsor)), /only a sponsored channel is ended by its provider/);
  } finally {
    x.offline.restore();
  }
});

test("the server's claim keeps a sponsored channel's floor in the channel (R1), and a channel under it is not claimed", async () => {
  const w = await providerWorld({});
  try {
    const line = (v: ChannelView, taken: bigint) => ({ channelId: TAG, totalClaimed: taken, amount: taken, signature: "00".repeat(64), v });
    const open = w.view(0xd1, opened, 1_000n);
    const { hex } = await buildClaimTx(w.builder, [line(open, 400n)]);
    const tx = Transaction.fromCBORHex(hex);
    assert.equal(floorProblem(tx, SPONSORED.hash, [w.reserve]), undefined);
    const continuing = tx.body.outputs.find((o) => Address.toBech32(o.address) === Address.toBech32(chan))!;
    assert.equal(Assets.lovelaceOf(continuing.assets), w.reserve);
    assert.equal(Assets.getByUnit(continuing.assets, UNIT), 600n);
    assert.deepEqual(parseDatum((continuing.datumOption as InlineDatum.InlineDatum).data, SPONSORED, 0).constants, open.datum.constants);
    // The same channel, by some means holding a lovelace under its floor: no claim signs off on it.
    const under = { ...open, lovelace: w.reserve - 1n, utxo: utxoAt(chan, 0xd1, 0, tokens(1_000n, w.reserve - 1n), (open.utxo.datumOption as InlineDatum.InlineDatum).data) } as unknown as ChannelView;
    await assert.rejects(buildClaimTx({ ...w.builder, spent: new Map() }, [line(under, 400n)]), /\(R1\)/);
  } finally {
    w.offline.restore();
  }
});

/** A manager over a channel its consumer closed with 1,000 tokens, which one settle takes whole. */
async function managerWorld(o: Parameters<typeof providerWorld>[0], afterSettle: (w: Awaited<ReturnType<typeof providerWorld>>) => void = () => {}, options: { endEmptySponsored?: boolean } = {}) {
  const w = await providerWorld({ ...o, stage: closed });
  const storage = new InMemoryChannelStorage();
  await storage.updateChannel(TAG, () => ({
    channelId: TAG,
    channelConfig: cfg({ receiver: w.payTo, receiverAuthorizer: w.providerKeyHash }),
    channelRef: refOf(0xe0, 0),
    balance: "1000",
    totalClaimed: "0",
    withdrawRequestedAt: 1_700_000,
    chargedCumulativeAmount: "1000",
    signedMaxClaimable: "1000",
    signature: "00".repeat(64),
    lastRequestTimestamp: Date.now(),
  }));
  const before = w.view(0xe0, closed, 1_000n);
  const after = w.view(0xe1, settled, 0n);
  let claimed = false;
  const chain = {
    ...w.chain,
    followChannel: async () => (claimed ? after : before),
    txHeight: async () => undefined,
  } as unknown as Chain;
  const facilitator = {
    settle: async () => {
      claimed = true;
      afterSettle(w);
      return { success: true, transaction: "aa".repeat(32), network: NETWORK };
    },
  };
  const manager = new ChannelManager({ storage, wallet: w.wallet, providerKeyHash: w.providerKeyHash, chain, facilitator: facilitator as never, network: NETWORK, payTo: w.payTo, scriptHash: SPONSORED.hash, ...options });
  return { w, manager, after, submitted: w.submitted };
}

test("the server, having settled a sponsored channel its consumer closed and emptied, ends it as provider and gets the floor back (R3)", async () => {
  // After the settle the wallet lists what that claim paid it, as the chain's index does once it catches up.
  const m = await managerWorld({}, (w) => w.offline.setUtxos(w.address, [utxoAt(w.address, 0xb2, 0, Assets.fromLovelace(9_500_000n))]));
  try {
    const [result] = await m.manager.claim();
    const row = result!.channels[0]!;
    assert.equal(row.taken, 1_000n);
    assert.equal(row.endError, undefined);
    assert.equal(m.submitted.length, 1, "one transaction of its own: the End");
    assert.equal(row.ended, txHashOf(m.submitted[0]!));
    const tx = Transaction.fromCBORHex(m.submitted[0]!);
    assert.equal(Data.toCBORHex([...spendRedeemers(tx).values()][0]!), Data.toCBORHex(Redeemer.main([Step.end()])));
    assert.equal(repaymentProblem(tx, m.after.ref, { address: m.w.payTo, floor: m.w.reserve }), undefined);
    assert.deepEqual((tx.body.requiredSigners ?? []).map((k) => KeyHash.toHex(k)), [m.w.providerKeyHash]);
  } finally {
    m.w.offline.restore();
  }
});

test("the server ends only a sponsored channel that is its own and empty, and a failed End is the row's, not the claim's", async () => {
  // A sponsor that is not this server's payTo: its reserve is not the server's to take back, so it does not pay to end it.
  const other = await managerWorld({ sponsor: OTHER }, (w) => w.offline.setUtxos(w.address, [utxoAt(w.address, 0xb2, 0, Assets.fromLovelace(9_500_000n))]));
  try {
    const [result] = await other.manager.claim();
    assert.deepEqual([result!.channels[0]!.ended, result!.channels[0]!.endError, other.submitted.length], [undefined, undefined, 0]);
    assert.equal(other.manager.endsOwn(other.after), false);
  } finally {
    other.w.offline.restore();
  }
  // No ADA left to pay for it: the claim stands, the row says why, and the End can be tried again.
  const poor = await managerWorld({}, (w) => w.offline.setUtxos(w.address, []));
  try {
    const [result] = await poor.manager.claim();
    const row = result!.channels[0]!;
    assert.equal(row.ended, undefined);
    assert.match(row.endError ?? "", /collateral/);
    assert.equal(poor.submitted.length, 0);
    assert.equal(poor.manager.endsOwn(poor.after), true);
    poor.w.offline.setUtxos(poor.w.address, [utxoAt(poor.w.address, 0xb3, 0, Assets.fromLovelace(9_000_000n))]);
    const txHash = await poor.manager.endEmpty(poor.after);
    assert.equal(txHash, txHashOf(poor.submitted[0]!));
  } finally {
    poor.w.offline.restore();
  }
  // Non-empty or not settled or not sponsored: not this manager's to end.
  const w = await providerWorld({});
  try {
    const manager = new ChannelManager({ storage: new InMemoryChannelStorage(), wallet: w.wallet, providerKeyHash: w.providerKeyHash, chain: w.chain, facilitator: {} as never, network: NETWORK, payTo: w.payTo, scriptHash: SPONSORED.hash });
    assert.equal(manager.endsOwn(w.view(0xd0, settled, 0n)), true);
    assert.equal(manager.endsOwn(w.view(0xd0, settled, 1n)), false);
    assert.equal(manager.endsOwn(w.view(0xd0, closed, 0n)), false);
    const another = new ChannelManager({ storage: new InMemoryChannelStorage(), wallet: w.wallet, providerKeyHash: "ab".repeat(28), chain: w.chain, facilitator: {} as never, network: NETWORK, payTo: w.payTo, scriptHash: SPONSORED.hash });
    assert.equal(another.endsOwn(w.view(0xd0, settled, 0n)), false, "a channel of another provider key is not this server's to end");
    const delegated = new ChannelManager({ storage: new InMemoryChannelStorage(), providerKeyHash: w.providerKeyHash, delegationSecret: "s", chain: w.chain, facilitator: {} as never, network: NETWORK, payTo: w.payTo, scriptHash: SPONSORED.hash });
    assert.equal(delegated.endsOwn(w.view(0xd0, settled, 0n)), false, "the facilitator that holds the key builds no Ends yet");
    await assert.rejects(delegated.endEmpty(w.view(0xd0, settled, 0n)), /builds no Ends/);
  } finally {
    w.offline.restore();
  }
});

test("a claim of a channel nobody sponsors is as it was at either validator: that validator's script and datum, no floor to keep", async () => {
  for (const validator of VALIDATORS) {
    const w = await providerWorld({ validator, sponsored: false });
    try {
      const open = w.view(0xd1, opened, 1_000n);
      const { hex } = await buildClaimTx(w.builder, [{ channelId: TAG, totalClaimed: 400n, amount: 400n, signature: "00".repeat(64), v: open }]);
      const tx = Transaction.fromCBORHex(hex);
      assert.deepEqual((tx.witnessSet.plutusV3Scripts ?? []).map((s) => ScriptHash.toHex(ScriptHash.fromScript(s))), [validator.hash], validator.name);
      const at = channelAddress(0, undefined, validator);
      const continuing = tx.body.outputs.filter((o) => Address.toBech32(o.address) === Address.toBech32(at));
      assert.equal(continuing.length, 1);
      assert.equal(Assets.getByUnit(continuing[0]!.assets, UNIT), 600n);
      const constants = (continuing[0]!.datumOption as InlineDatum.InlineDatum).data as Data.Data[];
      assert.equal((constants[1] as Data.Data[]).length, validator.sponsored ? 7 : 6, validator.name);
      assert.equal(parseDatum(constants, validator, 0).constants.sponsor, undefined);
    } finally {
      w.offline.restore();
    }
  }
});

test("the server leaves a settled, empty sponsored channel alone when told not to end them", async () => {
  const m = await managerWorld({}, (w) => w.offline.setUtxos(w.address, [utxoAt(w.address, 0xb2, 0, Assets.fromLovelace(9_500_000n))]), { endEmptySponsored: false });
  try {
    const [result] = await m.manager.claim();
    const row = result!.channels[0]!;
    assert.deepEqual([row.taken, row.ended, row.endError, m.submitted.length], [1_000n, undefined, undefined, 0]);
    assert.equal(m.manager.endsOwn(m.after), true, "it could: the option says it does not");
  } finally {
    m.w.offline.restore();
  }
});

test("facilitator: a voucher on a channel at the variant is read at the variant, and refused when its sponsor is not the receiver", async () => {
  const channelOf = (sponsor: string): ChannelView => {
    const constants = { ...SPONSORED_OPENING.constants, sponsor: { address: sponsor, floor: RESERVE } };
    return { ref: refOf(0xc0, 1), address: chan, lovelace: RESERVE, amount: 1_000_000n, utxo: {}, datum: { ownHash: SPONSORED.hash, constants, stage: opened } } as unknown as ChannelView;
  };
  const asked: string[] = [];
  const facilitatorOver = (view: ChannelView) =>
    new BatchSettlementCardanoFacilitator({ network: NETWORK, coinsPerUtxoByte: async () => CPB, followChannel: async (_ref: string, hash: string) => (asked.push(hash), view) } as unknown as Chain, { validators: [SPONSORED] });
  const r = req(SPONSORED.hash);
  const voucher = { channelId: TAG, maxClaimableAmount: "100000", signature: iou.sign(TAG, 100_000n), channelRef: refOf(0xc0, 1) };
  const payload: PaymentPayload = { x402Version: 2, accepted: r, payload: { type: "voucher", channelConfig: cfg(), voucher } };
  const ok = await facilitatorOver(channelOf(PAY_TO)).verify(payload, r);
  assert.deepEqual([ok.isValid, ok.payer, asked], [true, buyer.keyHash, [SPONSORED.hash]]);
  const refused = await facilitatorOver(channelOf(OTHER)).verify(payload, r);
  assert.deepEqual([refused.isValid, refused.invalidReason], [false, Err.receiverMismatch]);
});

// ---- the compiled validators, run locally ---------------------------------------------------------------------------------

/**
 * `aiken tx simulate` runs a transaction's scripts as a node's second phase would, on the UTxOs it spends, reads and puts up as collateral, and
 * on nothing else of the ledger: no fee, balance, signature or min-UTxO rule. So these tests ask the compiled validators themselves whether they
 * accept what this package builds, and refuse a transaction that leaves out what the variant asks of it. They need `aiken` on the PATH, a version with `tx simulate` (1.1.24 has it), and are skipped
 * where there is none. `VARIANT_UNITS=1` prints what each accepted transaction costs.
 */
const AIKEN_AVAILABLE = spawnSync("aiken", ["tx", "simulate", "--help"], { encoding: "utf8" }).status === 0;
const aiken = { skip: AIKEN_AVAILABLE ? false : "aiken is not on the PATH" };
/** The ledger's limits on one transaction's scripts, the same on preprod and mainnet. */
const MAX_MEM = 14_000_000;
const MAX_CPU = 10_000_000_000;

function simulate(txHex: string, known: UTxO.UTxO[]) {
  const tx = Transaction.fromCBORHex(txHex);
  const resolved: UTxO.UTxO[] = [];
  for (const i of [...tx.body.inputs, ...(tx.body.collateralInputs ?? []), ...(tx.body.referenceInputs ?? [])]) {
    const id = TransactionHash.toHex(i.transactionId);
    if (resolved.some((u) => TransactionHash.toHex(u.transactionId) === id && u.index === i.index)) continue;
    const u = known.find((k) => TransactionHash.toHex(k.transactionId) === id && k.index === i.index);
    if (!u) throw new Error(`the test did not say what ${id}#${i.index} is`);
    resolved.push(u);
  }
  const array = (items: Uint8Array[]) => Buffer.concat([Buffer.of(0x9f), ...items, Buffer.of(0xff)]);
  const dir = mkdtempSync(join(tmpdir(), "simulate-"));
  writeFileSync(join(dir, "tx.hex"), txHex);
  writeFileSync(join(dir, "inputs.hex"), array(resolved.map((u) => TransactionInput.toCBORBytes(new TransactionInput.TransactionInput({ transactionId: u.transactionId, index: u.index })))).toString("hex"));
  writeFileSync(join(dir, "outputs.hex"), array(resolved.map((u) => TxOut.toCBORBytes(new TxOut.TransactionOutput({ address: u.address, assets: u.assets, ...(u.datumOption ? { datumOption: u.datumOption } : {}) })))).toString("hex"));
  const slots = preprod.slotConfig;
  const r = spawnSync("aiken", ["tx", "simulate", "--zero-time", String(slots.zeroTime), "--zero-slot", String(slots.zeroSlot), "--slot-length", String(slots.slotLength), join(dir, "tx.hex"), join(dir, "inputs.hex"), join(dir, "outputs.hex")], { encoding: "utf8" });
  const out = `${r.stdout}\n${r.stderr}`;
  const used = [...out.matchAll(/"mem":\s*(\d+),\s*"cpu":\s*(\d+)/g)];
  return { ok: r.status === 0, out, mem: used.reduce((sum, m) => sum + Number(m[1]), 0), cpu: used.reduce((sum, m) => sum + Number(m[2]), 0) };
}

/** The validator takes the transaction, within the ledger's limits. */
function compiledAccepts(txHex: string, known: UTxO.UTxO[], label: string): void {
  const r = simulate(txHex, known);
  assert.ok(r.ok, `${label}: ${r.out}`);
  assert.ok(r.mem > 0 && r.mem < MAX_MEM && r.cpu < MAX_CPU, `${label}: ${r.mem} memory, ${r.cpu} steps`);
  if (process.env.VARIANT_UNITS) console.log(`units: ${label}: ${r.mem} memory, ${r.cpu} steps`);
}

/** The validator refuses it: its script fails, not the harness. */
function compiledRefuses(txHex: string, known: UTxO.UTxO[], label: string): void {
  const r = simulate(txHex, known);
  assert.equal(r.ok, false, `${label}: the validator took it`);
  assert.match(r.out, /failed script execution/, `${label}: ${r.out}`);
}

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

/** The same, with a lovelace less in the output at the channel's address, which is the floor's whole reserve: the floor is no longer kept (R1). */
const aLovelaceUnder = (txHex: string, at: Address.Address) => alterAt(txHex, at, (o) => outputWith(o, { lovelace: Assets.lovelaceOf(o.assets) - 1n }));

for (const exit of ["elapse", "end"] as const) {
  test(`the compiled variant accepts a buyer's ${exit} that repays the sponsor, and refuses each transaction like it that does not (R2)`, aiken, async () => {
    const w = await exitWorld({ validator: SPONSORED, sponsored: true, stage: exit === "elapse" ? closed : settled, held: 1_000_000n });
    try {
      if (exit === "elapse") await w.client.elapse(TAG, { wait: false });
      else await w.client.end(TAG);
      const hex = w.submitted[0]!;
      compiledAccepts(hex, w.known, `sponsored ${exit}`);
      const sponsorAddress = Address.fromBech32(PAY_TO);
      // The floor is a least: a lovelace more is as good.
      compiledAccepts(alterAt(hex, sponsorAddress, (o) => outputWith(o, { lovelace: Assets.lovelaceOf(o.assets) + 1n })), w.known, `${exit}, a lovelace over the floor`);
      const cases: Record<string, (o: TxOut.TransactionOutput) => TxOut.TransactionOutput | undefined> = {
        "no repayment": () => undefined,
        "a lovelace short": (o) => outputWith(o, { lovelace: Assets.lovelaceOf(o.assets) - 1n }),
        "no datum": (o) => outputWith(o, { datum: null }),
        "the payment key alone": (o) => outputWith(o, { address: Address.fromBech32(bech(kh(seller.keyHash))) }),
        "another stake key": (o) => outputWith(o, { address: Address.fromBech32(OTHER) }),
        "another output reference": (o) => outputWith(o, { datum: repaymentDatum(refOf(0xc0, 2)) }),
        "another transaction's reference": (o) => outputWith(o, { datum: repaymentDatum(refOf(0xc1, 1)) }),
        "the channel's tag instead": (o) => outputWith(o, { datum: hexOf(TAG) }),
      };
      for (const [what, change] of Object.entries(cases)) compiledRefuses(alterAt(hex, sponsorAddress, change), w.known, `${exit}, ${what}`);
    } finally {
      w.offline.restore();
    }
  });
}

test("the compiled variant accepts the provider's End of an empty sponsored channel, and not the consumer's alone (R3)", aiken, async () => {
  const w = await providerWorld({});
  try {
    const v = w.view(0xd0, settled, 0n);
    const hex = await buildEndTx(w.builder, v);
    const known = [v.utxo, ...w.walletUtxos];
    compiledAccepts(hex, known, "the provider's End");
    compiledRefuses(tamper(hex, { requiredSigners: [buyer.keyHash] }), known, "signed by the consumer alone");
    compiledAccepts(tamper(hex, { requiredSigners: [buyer.keyHash, w.providerKeyHash] }), known, "signed by both");
    compiledRefuses(alterAt(hex, Address.fromBech32(w.payTo), (o) => (o.datumOption ? undefined : o)), known, "no repayment");
  } finally {
    w.offline.restore();
  }
});

test("the compiled variant accepts the steps that keep a sponsored channel going, each by its own builder, and refuses each with a lovelace less in the channel (R1)", aiken, async () => {
  // Close, by the buyer.
  const closing = await exitWorld({ validator: SPONSORED, sponsored: true, stage: opened, held: 1_000_000n });
  try {
    await closing.client.close(TAG);
    compiledAccepts(closing.submitted[0]!, closing.known, "close");
    compiledRefuses(aLovelaceUnder(closing.submitted[0]!, chan), closing.known, "close, a lovelace under the floor");
  } finally {
    closing.offline.restore();
  }
  // Add, by the buyer's top-up, with its own ADA and on the seller's offer.
  for (const offer of [false, true]) {
    const w = await topUpWorld({ validator: SPONSORED, sponsored: true, offer });
    try {
      const { hex } = await w.topUp();
      compiledAccepts(hex, w.known, `add${offer ? " on the seller's offer" : ""}`);
      compiledRefuses(aLovelaceUnder(hex, chan), w.known, `add${offer ? " on the seller's offer" : ""}, a lovelace under the floor`);
    } finally {
      w.offline.restore();
    }
  }
  // Sub and Settle, in one claim of the server's over three channels, and Settle alone.
  const claims = await providerWorld({});
  try {
    const open1 = claims.view(0xd1, opened, 1_000n);
    const open2 = claims.view(0xd2, opened, 2_000n);
    const shut = claims.view(0xd3, closed, 3_000n);
    const line = (v: ChannelView, n: bigint) => ({ channelId: TAG, totalClaimed: n, amount: n, signature: iou.sign(TAG, n), v });
    const { hex } = await buildClaimTx(claims.builder, [line(open1, 400n), line(open2, 700n), line(shut, 3_000n)]);
    const known = [open1.utxo, open2.utxo, shut.utxo, ...claims.walletUtxos];
    compiledAccepts(hex, known, "one claim: Sub, Sub, Settle, with Defer for the others");
    compiledRefuses(aLovelaceUnder(hex, chan), known, "a claim, the first channel a lovelace under the floor");
    const alone = await buildClaimTx({ ...claims.builder, spent: new Map() }, [line(shut, 3_000n)]);
    compiledAccepts(alone.hex, known, "Settle");
    compiledRefuses(aLovelaceUnder(alone.hex, chan), known, "Settle, a lovelace under the floor");
  } finally {
    claims.offline.restore();
  }
});

test("the compiled variant accepts the mutual refunds the client builds, and the compiled upstream the same refund of a channel at its own address", aiken, async () => {
  for (const [validator, sponsored] of [[UPSTREAM, false], [SPONSORED, false], [SPONSORED, true]] as const) {
    const w = await refundWorld({ validator, sponsored });
    try {
      const p = parseClientPayload((await w.client.refundPayload(w.pr, TAG)).payload);
      if (p.type !== "refund") throw new Error("unreachable");
      compiledAccepts(Buffer.from(p.transaction, "base64").toString("hex"), w.known, `refund at ${validator.name}${sponsored ? ", sponsored" : ""}`);
    } finally {
      w.offline.restore();
    }
  }
});

test("the compiled validators accept a buyer's exit of a channel nobody sponsors, the variant's with no sponsor and upstream's, and the server's claims of them", aiken, async () => {
  for (const [validator, exit] of [[SPONSORED, "elapse"], [SPONSORED, "end"], [UPSTREAM, "elapse"], [UPSTREAM, "end"]] as const) {
    const w = await exitWorld({ validator, sponsored: false, stage: exit === "elapse" ? closed : settled, held: 1_000_000n });
    try {
      if (exit === "elapse") await w.client.elapse(TAG, { wait: false });
      else await w.client.end(TAG);
      compiledAccepts(w.submitted[0]!, w.known, `${validator.name} ${exit}, nobody sponsors`);
    } finally {
      w.offline.restore();
    }
  }
  for (const validator of VALIDATORS) {
    const w = await providerWorld({ validator, sponsored: false });
    try {
      const open = w.view(0xd1, opened, 1_000n);
      const { hex } = await buildClaimTx(w.builder, [{ channelId: TAG, totalClaimed: 400n, amount: 400n, signature: iou.sign(TAG, 400n), v: open }]);
      compiledAccepts(hex, [open.utxo, ...w.walletUtxos], `${validator.name} claim, nobody sponsors`);
    } finally {
      w.offline.restore();
    }
  }
});
