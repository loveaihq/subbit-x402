import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Data, TransactionHash, TransactionInput } from "@evolution-sdk/evolution";
import {
  SUBBIT_HASH,
  UPSTREAM,
  UPSTREAM_66648DB,
  UPSTREAM_VALIDATORS,
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

/** The sha256 of a vendored file, its line ends as the repository has them: a Windows checkout may have CRLF. */
const sha256 = (path: string) => createHash("sha256").update(readFileSync(new URL(path, import.meta.url), "utf8").replace(/\r\n/g, "\n")).digest("hex");

test("the vendored scripts hash to their blueprints' validator hashes: the fixed one is Subbit's default, the one before the fix is kept beside it", () => {
  // Upstream's main, 74c20d2: the `ordered_insert` fix of its pull request #10. New channels open here.
  assert.equal(SUBBIT_HASH, "6d8774631fece31d0c768afb960c9a8a9957f8a85fa31deae1159094");
  assert.equal(UPSTREAM.hash, SUBBIT_HASH);
  // 66648db, before the fix: where every channel opened before it sits.
  assert.equal(UPSTREAM_66648DB.hash, "62ce4309e37e09e5c633c96c6ae68061c434f122d32626d6912d7c2a");
  assert.deepEqual(UPSTREAM_VALIDATORS, [UPSTREAM, UPSTREAM_66648DB]);
  // 3,058 bytes of compiled code against 3,046: the fix is twelve bytes.
  assert.deepEqual([UPSTREAM, UPSTREAM_66648DB].map((v) => Buffer.from((v.script as unknown as { bytes: Uint8Array }).bytes).length), [3_058, 3_046]);
  assert.deepEqual([UPSTREAM.sponsored, UPSTREAM_66648DB.sponsored], [false, false]);
});

test("the vendored blueprints are the bytes this package vouches for: upstream's own, the one at 74c20d2 and the one at 66648db", () => {
  // vendor/subbit/PROVENANCE.md names both; a change to either file is a change of validator.
  assert.equal(sha256("../vendor/subbit/plutus.json"), "519a5ac62bd5d7c9bbc584564f3bfadc95361cf11e3bab838630f296c349df1f");
  assert.equal(sha256("../vendor/subbit/plutus-62ce4309.json"), "0f114913c4f773a8bda639c2a2b6265b82339c00356cf57d2d60877f8d5e3c20");
});

test("the package ships every blueprint it loads: src/subbit.ts reads them from the installed package", () => {
  const files = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { files: string[] }).files;
  for (const blueprint of ["vendor/subbit/plutus.json", "vendor/subbit/plutus-62ce4309.json", "variant/sponsored/plutus.json"]) {
    assert.ok(files.includes(blueprint), `${blueprint} is in package.json's files`);
  }
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

test("datums round-trip through Data and CBOR for every stage and currency, at either of Subbit's validators", () => {
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
      // Named or not, a datum is the fixed validator's.
      const cbor = Data.toCBORBytes(datumData(c, stage));
      assert.deepEqual(parseDatum(Data.fromCBORBytes(cbor)), { ownHash: SUBBIT_HASH, constants: c, stage });
      // Each validator's own: the same six constants under its own hash, and nothing else different.
      const written = UPSTREAM_VALIDATORS.map((v) => Data.toCBORHex(datumData(c, stage, v)));
      for (const [i, v] of UPSTREAM_VALIDATORS.entries()) {
        assert.deepEqual(parseDatum(Data.fromCBORHex(written[i]!), v, 0), { ownHash: v.hash, constants: c, stage }, v.name);
      }
      assert.equal(written[0]!.replace(UPSTREAM.hash, UPSTREAM_66648DB.hash), written[1]!);
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
