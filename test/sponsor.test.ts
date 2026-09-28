// Seller-sponsored channels (SPONSORSHIP.md), chain-free: the seller's rules for an opening, a
// top-up and a refund on offline transactions signed for real, the relaxed `checkMutual`, and the
// pool's soft offers and exclusive bindings.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  Address,
  Assets,
  Data,
  KeyHash,
  PrivateKey,
  Redeemer as SdkRedeemer,
  Redeemers,
  Transaction,
  TransactionBody,
  TransactionHash,
  TransactionInput,
  TransactionWitnessSet,
  TxOut,
  UTxO,
  VKey,
  Time,
  preprod,
} from "@evolution-sdk/evolution";
import { channelAddress, inlineDatum } from "../src/subbit.ts";
import { channelReserve, constantsOf } from "../src/x402/cardano.ts";
import {
  SponsorPool,
  checkSponsoredOpen,
  checkSponsoredRefund,
  checkSponsoredTopUp,
  offerIn,
  sizeWith,
  type FeeSponsorOffer,
  type OwnerLookup,
  type SponsorWallet,
} from "../src/x402/sponsor.ts";
import { checkMutual } from "../src/x402/txcheck.ts";
import type { ChannelConfig } from "../src/x402/types.ts";

const NETWORK = "cardano:preprod";
const POLICY = "e675b46e4d2242c991a8932a99db3044e80515ae14b4c4ccf6b3f4c9";
const NAME = "0014df10745553444d";
const TUSDM = `${POLICY}.${NAME}`;
const FEES = { minFeeA: 44n, minFeeB: 155_381n };
const CPB = 4_310n;

function party(seed: number) {
  const key = PrivateKey.fromBytes(new Uint8Array(32).fill(seed));
  const kh = KeyHash.fromPrivateKey(key);
  const address = new Address.Address({ networkId: 0, paymentCredential: kh });
  return { key, keyHash: KeyHash.toHex(kh).toLowerCase(), address, bech32: Address.toBech32(address) };
}
const buyer = party(1);
const sponsor = party(2);
const seller = party(3);
const stranger = party(4);

const txid = (n: number) => n.toString(16).padStart(2, "0").repeat(32);
const input = (n: number, i = 0) => new TransactionInput.TransactionInput({ transactionId: TransactionHash.fromHex(txid(n)), index: BigInt(i) });
const refOf = (n: number, i = 0) => `${txid(n)}#${i}`;
const tokens = (q: bigint, lovelace: bigint) => Assets.fromHexStrings(POLICY, NAME, q, lovelace);
const out = (to: { address: Address.Address }, assets: Assets.Assets) => new TxOut.TransactionOutput({ address: to.address, assets });

const config: ChannelConfig = { payer: buyer.keyHash, payerAuthorizer: "aa".repeat(32), receiver: seller.bech32, receiverAuthorizer: seller.keyHash, token: TUSDM, withdrawDelay: 900 };
const TAG = "11".repeat(32);
const constants = constantsOf(config, TAG);
const chan = channelAddress(0);
const SCRIPT = Buffer.from((chan.paymentCredential as unknown as { hash: Uint8Array }).hash).toString("hex");
const RESERVE = channelReserve(chan, constants, CPB);
const channelOut = (q: bigint, lovelace = RESERVE) => new TxOut.TransactionOutput({ address: chan, assets: tokens(q, lovelace), datumOption: inlineDatum(constants, { kind: "opened", subbed: 0n }) });

const OWN = 1_176_630n; // the buyer's min-ada, which came with its tokens
const S = 4_000_000n;
const offer = (over: Partial<FeeSponsorOffer> = {}): FeeSponsorOffer => ({ input: refOf(0xa0, 3), address: sponsor.bech32, lovelace: S.toString(), maxFee: "500000", expiresAt: String(Date.now() + 300_000), ...over });
const ttl = (o: FeeSponsorOffer) => Time.unixTimeToSlot(BigInt(Number(o.expiresAt) - 30_000), preprod.slotConfig);

interface Parts {
  inputs: TransactionInput.TransactionInput[];
  outputs: TxOut.TransactionOutput[];
  fee: bigint;
  ttl?: bigint;
  extra?: Partial<ConstructorParameters<typeof TransactionBody.TransactionBody>[0]>;
  witness?: Partial<ConstructorParameters<typeof TransactionWitnessSet.TransactionWitnessSet>[0]>;
}
const unsigned = (p: Parts) =>
  Transaction.toCBORHex(
    new Transaction.Transaction({
      body: new TransactionBody.TransactionBody({ inputs: p.inputs, outputs: p.outputs, fee: p.fee, ...(p.ttl !== undefined ? { ttl: p.ttl } : {}), ...p.extra }),
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
/** Fee for the size with `total` witnesses; `draft(fee)` builds the parts. */
function sized(draft: (fee: bigint) => Parts, total: number): string {
  let fee = 300_000n;
  for (let k = 0; k < 3; k++) fee = FEES.minFeeA * BigInt(sizeWith(unsigned(draft(fee)), total)) + FEES.minFeeB;
  return signedBy(unsigned(draft(fee)), buyer);
}

const owners: OwnerLookup = async (ref) => {
  if (ref.startsWith(txid(0xb0))) return { exists: true, paymentKeyHash: buyer.keyHash };
  if (ref === refOf(0xa0, 9)) return { exists: true, paymentKeyHash: sponsor.keyHash };
  if (ref.startsWith(txid(0xd0))) return { exists: true, paymentKeyHash: stranger.keyHash };
  if (ref.startsWith(txid(0xc0))) return { exists: true };
  return { exists: false };
};
const base = (o: FeeSponsorOffer, txHex: string, missing = 1) => ({ txHex, offer: o, network: NETWORK, payTo: seller.bech32, sponsorKeyHash: sponsor.keyHash, ownerOf: owners, fees: FEES, missingWitnesses: missing });

// ---- opening ----

const D = 1_000_000n;
function openTx(o: FeeSponsorOffer, change: (p: Parts) => Parts = (p) => p) {
  return sized(
    (fee) =>
      change({
        inputs: [input(0xb0, 1), input(0xa0, 3)],
        outputs: [out(buyer, tokens(20_000_000n - D, OWN)), channelOut(D), out(seller, Assets.fromLovelace(S - RESERVE - fee))],
        fee,
        ttl: ttl(o),
      }),
    2,
  );
}

async function refusedOpen(hex: string, rule: string, o = offer()) {
  const r = await checkSponsoredOpen({ ...base(o, hex), scriptHash: SCRIPT, reserve: RESERVE });
  assert.equal(r.ok, false, `expected ${rule}`);
  if (!r.ok) assert.equal(r.rule, rule, r.detail);
}

test("a sponsored opening passes: the channel holds its reserve, the buyer its own ADA, payTo the rest", async () => {
  const o = offer();
  const r = await checkSponsoredOpen({ ...base(o, openTx(o)), scriptHash: SCRIPT, reserve: RESERVE });
  assert.ok(r.ok, r.ok ? "" : `${r.rule}: ${r.detail}`);
  assert.ok(RESERVE > 2_000_000n && RESERVE < 2_300_000n, `reserve ${RESERVE}`);
});

test("opening: more ADA in the channel than its reserve, or the sponsor's ADA to the buyer, is refused", async () => {
  const o = offer();
  await refusedOpen(openTx(o, (p) => ({ ...p, outputs: [p.outputs[0]!, channelOut(D, RESERVE + 100_000n), out(seller, Assets.fromLovelace(S - RESERVE - 100_000n - p.fee))] })), "S4", o);
  await refusedOpen(openTx(o, (p) => ({ ...p, outputs: [out(buyer, tokens(20_000_000n - D, OWN + 100_000n)), p.outputs[1]!, out(seller, Assets.fromLovelace(S - RESERVE - 100_000n - p.fee))] })), "S4", o);
});

test("opening: collateral, a second sponsor UTxO, a fee over maxFee or no validity bound is refused", async () => {
  const o = offer();
  await refusedOpen(openTx(o, (p) => ({ ...p, extra: { collateralInputs: [input(0xb0, 1)] } })), "S3", o);
  await refusedOpen(openTx(o, (p) => ({ ...p, inputs: [...p.inputs, input(0xa0, 9)] })), "S2", o);
  await refusedOpen(openTx({ ...o, maxFee: "150000" }), "S5", { ...o, maxFee: "150000" });
  await refusedOpen(openTx(o, (p) => ({ ...p, ttl: undefined })), "S7", o);
});

// ---- top-up ----

const COLLATERAL = 1_000_000n;
function topUpTx(o: FeeSponsorOffer, change: (p: Parts) => Parts = (p) => p) {
  return sized(
    (fee) =>
      change({
        inputs: [input(0xc0, 0), input(0xb0, 1), input(0xa0, 3)],
        outputs: [out(buyer, tokens(19_000_000n - D, OWN)), channelOut(2n * D), out(seller, Assets.fromLovelace(S - fee))],
        fee,
        ttl: ttl(o),
        extra: { collateralInputs: [input(0xa0, 3)], collateralReturn: out(seller, Assets.fromLovelace(S - COLLATERAL)), totalCollateral: COLLATERAL },
      }),
    2,
  );
}

async function refusedTopUp(hex: string, rule: string, o = offer()) {
  const r = await checkSponsoredTopUp(base(o, hex));
  assert.equal(r.ok, false, `expected ${rule}`);
  if (!r.ok) assert.equal(r.rule, rule, r.detail);
}

test("a sponsored top-up passes: the offer pays the fee, stands as collateral, and the rest goes to payTo", async () => {
  const o = offer();
  const r = await checkSponsoredTopUp(base(o, topUpTx(o)));
  assert.ok(r.ok, r.ok ? "" : `${r.rule}: ${r.detail}`);
});

test("top-up: the sponsor's ADA into the channel or to the buyer is refused", async () => {
  const o = offer();
  await refusedTopUp(topUpTx(o, (p) => ({ ...p, outputs: [p.outputs[0]!, channelOut(2n * D, RESERVE + 500_000n), out(seller, Assets.fromLovelace(S - 500_000n - p.fee))] })), "S4", o);
  await refusedTopUp(topUpTx(o, (p) => ({ ...p, outputs: [out(buyer, tokens(19_000_000n - D, OWN + 1n)), p.outputs[1]!, out(seller, Assets.fromLovelace(S - 1n - p.fee))] })), "S4", o);
});

test("top-up: collateral that is not the offer, returns elsewhere, or puts up more than 2 ADA is refused", async () => {
  const o = offer();
  await refusedTopUp(topUpTx(o, (p) => ({ ...p, extra: { ...p.extra, collateralInputs: [input(0xa0, 3), input(0xd0, 0)] } })), "S3", o);
  await refusedTopUp(topUpTx(o, (p) => ({ ...p, extra: { ...p.extra, collateralReturn: out(buyer, Assets.fromLovelace(S - COLLATERAL)) } })), "S3", o);
  await refusedTopUp(topUpTx(o, (p) => ({ ...p, extra: { collateralInputs: [input(0xa0, 3)], collateralReturn: out(seller, Assets.fromLovelace(S - 2_500_000n)), totalCollateral: 2_500_000n } })), "S3", o);
});

// ---- refund ----

const CHANNEL_ADA = RESERVE;
function refundTx(o: FeeSponsorOffer, change: (p: Parts) => Parts = (p) => p) {
  return sized(
    (fee) =>
      change({
        inputs: [input(0xc0, 0), input(0xb0, 2)],
        outputs: [out(buyer, tokens(18_000_000n + 500_000n, OWN)), out(seller, Assets.fromLovelace(CHANNEL_ADA - fee))],
        fee,
        ttl: ttl(o),
        extra: { collateralInputs: [input(0xa0, 3)], collateralReturn: out(seller, Assets.fromLovelace(S - COLLATERAL)), totalCollateral: COLLATERAL },
      }),
    3,
  );
}
const refundCheck = (o: FeeSponsorOffer, hex: string, over: { evaluate?: () => Promise<void>; reserveFromSeller?: boolean } = {}) =>
  checkSponsoredRefund({
    ...base(o, hex, 2),
    channelRef: refOf(0xc0, 0),
    channelLovelace: CHANNEL_ADA,
    consumerKeyHash: buyer.keyHash,
    reserveFromSeller: over.reserveFromSeller ?? true,
    evaluate: over.evaluate ?? (async () => {}),
  });

test("a sponsored refund passes: the offer is only collateral, the reserve goes back to payTo, the tokens join the buyer's UTxO", async () => {
  const o = offer();
  const r = await refundCheck(o, refundTx(o));
  assert.ok(r.ok, r.ok ? "" : `${r.rule}: ${r.detail}`);
});

test("refund: the seller's reserve to the buyer, a stranger's input, the offer spent, or a failing script is refused", async () => {
  const o = offer();
  const toBuyer = refundTx(o, (p) => ({ ...p, outputs: [out(buyer, tokens(18_500_000n, OWN + 300_000n)), out(seller, Assets.fromLovelace(CHANNEL_ADA - 300_000n - p.fee))] }));
  const r1 = await refundCheck(o, toBuyer);
  assert.equal(r1.ok ? "" : r1.rule, "S4");
  const r2 = await refundCheck(o, refundTx(o, (p) => ({ ...p, inputs: [...p.inputs, input(0xd0, 1)] })));
  assert.equal(r2.ok ? "" : r2.rule, "S4");
  const r3 = await refundCheck(o, refundTx(o, (p) => ({ ...p, inputs: [...p.inputs, input(0xa0, 3)] })));
  assert.equal(r3.ok ? "" : r3.rule, "S1");
  const r4 = await refundCheck(o, refundTx(o), {
    evaluate: async () => {
      throw new Error("script failed");
    },
  });
  assert.equal(r4.ok ? "" : r4.rule, "S3");
  // A channel the buyer funded itself: its reserve is the buyer's, and may go back to it.
  const r5 = await refundCheck(o, toBuyer, { reserveFromSeller: false });
  assert.ok(r5.ok, r5.ok ? "" : `${r5.rule}: ${r5.detail}`);
});

// ---- checkMutual: the consumer's own inputs besides the channel ----

test("checkMutual lets the consumer's own key-locked inputs through beside the channel, and nothing else", () => {
  const redeemers = Redeemers.makeRedeemerMap([new SdkRedeemer.Redeemer({ tag: "spend", index: 0n, data: Data.constr(2n, []), exUnits: new SdkRedeemer.ExUnits({ mem: 1_000n, steps: 1_000n }) })]);
  const mutual = (extraInput?: TransactionInput.TransactionInput) =>
    signedBy(
      unsigned({
        inputs: [input(0x01, 0), ...(extraInput ? [extraInput] : [])],
        outputs: [out(buyer, tokens(1_000_000n, OWN)), out(seller, Assets.fromLovelace(2_000_000n))],
        fee: 400_000n,
        extra: { requiredSigners: [KeyHash.fromHex(buyer.keyHash), KeyHash.fromHex(seller.keyHash)] },
        witness: { redeemers },
      }),
      buyer,
    );
  const channelRef = refOf(0x01, 0);
  const currency = { kind: "asset" as const, policy: POLICY, name: NAME };
  // The channel alone, as before.
  checkMutual(mutual(), NETWORK, SCRIPT, channelRef, buyer.keyHash, seller.keyHash, seller.bech32, currency, 0n, []);
  // Plus the consumer's own UTxO, sorted after the channel.
  checkMutual(mutual(input(0xb0, 2)), NETWORK, SCRIPT, channelRef, buyer.keyHash, seller.keyHash, seller.bech32, currency, 0n, [], true, new Map([[refOf(0xb0, 2), buyer.address]]));
  // A stranger's, or one the check was not told about, is refused.
  assert.throws(() => checkMutual(mutual(input(0xd0, 0)), NETWORK, SCRIPT, channelRef, buyer.keyHash, seller.keyHash, seller.bech32, currency, 0n, [], true, new Map([[refOf(0xd0, 0), stranger.address]])), /consumer's own/);
  assert.throws(() => checkMutual(mutual(input(0xb0, 2)), NETWORK, SCRIPT, channelRef, buyer.keyHash, seller.keyHash, seller.bech32, currency, 0n, []), /consumer's own/);
});

// ---- the pool ----

function fakeWallet(utxos: UTxO.UTxO[]): SponsorWallet {
  return {
    async address() {
      return sponsor.address;
    },
    async getWalletUtxos() {
      return utxos;
    },
    async signTx(txHex: string) {
      const hash = TransactionBody.toHashFromBytes(Transaction.extractBodyBytes(Buffer.from(txHex, "hex")));
      return TransactionWitnessSet.fromVKeyWitnesses([new TransactionWitnessSet.VKeyWitness({ vkey: VKey.fromPrivateKey(sponsor.key), signature: PrivateKey.sign(sponsor.key, hash.hash) })]);
    },
  };
}
const utxo = (n: number, i: number, lovelace: bigint) => new UTxO.UTxO({ transactionId: TransactionHash.fromHex(txid(n)), index: BigInt(i), address: sponsor.address, assets: Assets.fromLovelace(lovelace) });

test("pool: only UTxOs of 3.5–6 ADA are offered; an offer another buyer bound is still known, so its echo matches", async () => {
  const pool = new SponsorPool({ wallet: fakeWallet([utxo(0xa0, 0, 4_000_000n), utxo(0xa0, 1, 1_500_000n), utxo(0xa0, 2, 10_000_000n)]) });
  await pool.refresh();
  assert.deepEqual(pool.size(), { utxos: 1, bound: 0 });
  const o = (await pool.offer(60_000))!;
  assert.equal(o.maxFee, "500000");
  assert.ok(pool.bind(o, "tx1", Date.now() + 60_000));
  assert.equal(pool.bind(o, "tx2", Date.now() + 60_000), false);
  assert.ok(pool.known(o), "a voucher that echoes the offer still matches its 402");
  assert.equal(await pool.offer(60_000), undefined, "a bound UTxO is not offered again");
  assert.deepEqual(offerIn({ feeSponsor: o }), o);
});
