# vendor/subbit

`plutus.json` is the Aiken blueprint from [kompact-io/subbit-xyz](https://github.com/kompact-io/subbit-xyz),
copied unmodified from `aiken/plutus.json` at commit `66648db2e5dbc459b8cd335846af079328c4313f` (2026-09-01).

- Validator used: `subbit.subbit.spend`, Plutus V3, hash `62ce4309e37e09e5c633c96c6ae68061c434f122d32626d6912d7c2a`
- Compiler: Aiken v1.1.23+5bcde6d
- Licence: Apache-2.0, as declared in that repository's `aiken/aiken.toml` (the repository has no top-level LICENSE file)
- sha256 of this file: `0f114913c4f773a8bda639c2a2b6265b82339c00356cf57d2d60877f8d5e3c20`

Subbit is alpha software by Kompact.io. Nothing here has been audited.

## aiken/

**The source.** This is the Aiken source of that blueprint, `aiken/` from the same commit.
- **What was copied.** `aiken.toml`, `aiken.lock`, `README.md`, `lib/` and `validators/`: 24
  files. Each is byte-identical to that commit, checked by git blob SHA-1 against its tree.
- **What was not.** `plutus.json` (above), `export.sh`, `.gitignore`, `lib/subbit/logic.ak.txt`
  and the generated `out/`.
- **It compiles back.** It builds to exactly the blueprint above: all 16 validators, hash and
  compiled code alike, with Aiken v1.1.23+8949565 and v1.1.24+bacbeb3. This stays true with the
  tests below in place.

**The tests in `lib/mark/` are ours** (subbit-x402), not Kompact.io's.
- **Why there.** Subbit's README puts tests in `lib/mark` ("test" and "bench" are keywords,
  hence "mark"). At this commit the folder is gone. The only test left is `test_drop2_with`, of a
  list helper, and `lib/subbit/tbs_tests.ak` is empty.
- **Plan.** The tests follow Subbit's own plan, `docs/design/l1-tests.md`, and go further. The
  module list and results are in [RESULTS.md, step 15](../../RESULTS.md#step-15-the-validators-own-tests).
- **Vectors.** `lib/mark/vectors.ak` is written from this package's TypeScript by
  `test/subbit-aiken-vectors.ts`. `npm test` fails while it is stale.

```
npm run validator                                  # aiken check vendor/subbit/aiken
aiken check --max-success 1000 vendor/subbit/aiken # as recorded in RESULTS.md
```
