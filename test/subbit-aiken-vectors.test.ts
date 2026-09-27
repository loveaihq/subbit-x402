import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { VECTORS_PATH, vectorsModule } from "./subbit-aiken-vectors.ts";

test("the validator tests' vectors are what the client produces now", () => {
  // Line endings may be CRLF in a Windows checkout; Aiken reads either.
  assert.equal(
    readFileSync(VECTORS_PATH, "utf8").replace(/\r\n/g, "\n"),
    vectorsModule(),
    "stale: run `npx tsx test/subbit-aiken-vectors.ts`, then `npm run validator`",
  );
});
