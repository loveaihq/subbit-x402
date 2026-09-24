import { test } from "node:test";
import assert from "node:assert/strict";
import { Data, TransactionHash, TransactionInput } from "@evolution-sdk/evolution";
import {
  SUBBIT_HASH,
  datumData,
  iouBody,
  iouVerifier,
  newIouSigner,
  parseDatum,
  tagFromInput,
  type Constants,
  type Stage,
} from "../src/subbit.ts";

const bytes = (h: string) => Uint8Array.from(Buffer.from(h, "hex"));

test("the vendored script hashes to the blueprint's validator hash", () => {
  assert.equal(SUBBIT_HASH, "62ce4309e37e09e5c633c96c6ae68061c434f122d32626d6912d7c2a");
});

test("iouBody is byte-for-byte serialiseData of (tag, amount) at every CBOR width", () => {
  const amounts = [0n, 23n, 24n, 255n, 256n, 65535n, 65536n, 2n ** 32n - 1n, 2n ** 32n, 2n ** 64n - 1n];
  const tags = ["", "ab", "00".repeat(23), "11".repeat(24), "22".repeat(32), "33".repeat(64)];
  for (const tag of tags) {
    for (const amount of amounts) {
      const expected = Data.toCBORBytes(Data.list([bytes(tag), amount]));
      assert.deepEqual(Buffer.from(iouBody(tag, amount)), Buffer.from(expected), `tag ${tag.length / 2}B, amount ${amount}`);
    }
  }
});

test("iouBody refuses what serialiseData would encode differently", () => {
  assert.throws(() => iouBody("44".repeat(65), 1n));
  assert.throws(() => iouBody("ab", -1n));
  assert.throws(() => iouBody("ab", 2n ** 64n));
});

test("an IOU verifies only for its own key, tag and amount", () => {
  const signer = newIouSigner();
  const other = newIouSigner();
  const ok = iouVerifier(signer.publicKey);
  const tag = "aa".repeat(32);
  const sig = signer.sign(tag, 5_000_000n);
  assert.equal(Buffer.from(sig, "hex").length, 64);
  assert.equal(ok(tag, 5_000_000n, sig), true);
  assert.equal(ok(tag, 5_000_001n, sig), false);
  assert.equal(ok("ab".repeat(32), 5_000_000n, sig), false);
  assert.equal(iouVerifier(other.publicKey)(tag, 5_000_000n, sig), false);
  assert.equal(ok(tag, 5_000_000n, sig.slice(0, 126)), false);
});

const constants: Constants = {
  tag: "01".repeat(32),
  currency: { kind: "ada" },
  iouKey: "02".repeat(32),
  consumer: "03".repeat(28),
  provider: "04".repeat(28),
  closePeriodMs: 86_400_000n,
};

test("datums round-trip through Data and CBOR for every stage and currency", () => {
  const stages: Stage[] = [
    { kind: "opened", subbed: 0n },
    { kind: "opened", subbed: 5_000_000n },
    { kind: "closed", subbed: 7n, elapseAt: 1_790_000_000_000n },
    { kind: "settled" },
  ];
  const currencies: Constants["currency"][] = [
    { kind: "ada" },
    { kind: "asset", policy: "c4".repeat(28), name: "5553444d" },
  ];
  for (const stage of stages) {
    for (const currency of currencies) {
      const c = { ...constants, currency };
      const cbor = Data.toCBORBytes(datumData(c, stage));
      const parsed = parseDatum(Data.fromCBORBytes(cbor));
      assert.deepEqual(parsed, { ownHash: SUBBIT_HASH, constants: c, stage });
    }
  }
});

test("parseDatum rejects anything that is not exactly a Subbit datum", () => {
  const good = datumData(constants, { kind: "opened", subbed: 0n }) as Data.Data[];
  assert.throws(() => parseDatum(good.slice(0, 2)));
  assert.throws(() => parseDatum([good[0]!, good[1]!, Data.constr(3n, [])]));
  assert.throws(() => parseDatum([good[0]!, (good[1] as Data.Data[]).slice(0, 5), good[2]!]));
  assert.throws(() => parseDatum([5n, good[1]!, good[2]!]));
});

test("tagFromInput is a stable 32-byte hash of the out-ref", () => {
  const input = new TransactionInput.TransactionInput({
    transactionId: TransactionHash.fromHex("37120eda148486250fd331b8c3be6ea134a111b5ccf4f951f659a0f71c4c7c06"),
    index: 0n,
  });
  const a = tagFromInput(input);
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.equal(a, tagFromInput(input));
  const b = tagFromInput(new TransactionInput.TransactionInput({ transactionId: input.transactionId, index: 1n }));
  assert.notEqual(a, b);
});
