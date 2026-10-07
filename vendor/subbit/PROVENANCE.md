# vendor/subbit

Aiken blueprints of [kompact-io/subbit-xyz](https://github.com/kompact-io/subbit-xyz), in two builds
of one validator. **`plutus.json` is the default: Subbit's validator with the fix upstream merged in
its pull request #10.** `plutus-62ce4309.json` is the build before that fix, kept for channels opened
at it. Both are Plutus V3, Apache-2.0 (as declared in that repository's `aiken/aiken.toml`; it has no
top-level LICENSE file).

| | `plutus.json` (default) | `plutus-62ce4309.json` |
|---|---|---|
| Name in `src/subbit.ts` | `UPSTREAM` (`SUBBIT_HASH`, `subbitScript`) | `UPSTREAM_66648DB` |
| Validator | `subbit.subbit.spend` | `subbit.subbit.spend` |
| Hash | `6d8774631fece31d0c768afb960c9a8a9957f8a85fa31deae1159094` | `62ce4309e37e09e5c633c96c6ae68061c434f122d32626d6912d7c2a` |
| Compiled code | 3,058 bytes | 3,046 bytes |
| Source | `aiken/` here: upstream's 66648db plus the one line below | upstream's `aiken/` at `66648db2e5dbc459b8cd335846af079328c4313f` (2026-09-01), as the blueprint was copied |
| Compiler | Aiken v1.1.24+bacbeb3 | Aiken v1.1.23+5bcde6d |
| sha256 of the file | `519a5ac62bd5d7c9bbc584564f3bfadc95361cf11e3bab838630f296c349df1f` | `0f114913c4f773a8bda639c2a2b6265b82339c00356cf57d2d60877f8d5e3c20` |

`test/subbit.test.ts` pins both hashes and both sha256 sums.

Subbit is alpha software by Kompact.io. Nothing here has been audited.

## The fix

In `lib/extra/xlist.ak`, `ordered_insert` had `Greater -> fail @"Impossible"` at 66648db. It is
`Greater -> [item, x, ..xs]` now. `spend/main.ak` gathers each step's required signer with it, so a batch
with two different signers failed whenever the later step's signer sorted first, with every signature
present (RESULTS.md, step 15). It failed closed: no funds were at risk. Upstream merged this line in
its pull request #10 (its main is at 74c20d2).

- **What is new at 74c20d2 besides the line.** Upstream's main also moves to stdlib v4.0.0 and fuzz
  3.0.0 (the `Value` to `Assets` renames); that is as reported to this repository, and not read from
  upstream here (see the next point). This copy did not move: it stays on stdlib v3.1.0
  (`aiken.lock`), as at 66648db, and its blueprint is the same.
- **The blueprint is upstream's.** The one file `https://raw.githubusercontent.com/kompact-io/subbit-xyz/74c20d2/aiken/plutus.json`
  was fetched on 2026-10-07 for this comparison, and nothing else of that repository. `aiken build
  vendor/subbit/aiken` (Aiken v1.1.24+bacbeb3, default flags, offline) writes a blueprint that equals it as
  JSON: the preamble (compiler included), all 16 validators (title, hash and compiled code each) and
  all 18 definitions. `aiken` leaves off the file's last newline and `plutus.json` here has it, so
  that the file is upstream's byte for byte, sha256 as above.
- **The old blueprint is the same source without the line.** `aiken build` of this source with the one
  line put back builds the 16 validators of `plutus-62ce4309.json`, hash and compiled code alike (the
  preamble differs by the compiler: v1.1.24+bacbeb3 against v1.1.23+5bcde6d), checked on 2026-10-07.
  That file itself is copied unmodified from upstream's 66648db and is not rebuilt.
- **Why two.** A channel's address is its validator's hash, so a channel opened at `62ce4309…` stays
  there and is spent with that script, not this one. `src/subbit.ts` knows both: the client trusts both
  and the facilitator serves both by default, a server names the one its channels are at (`scriptHash`,
  `6d877463…` unless told otherwise), and a reference-script output is read only when it carries the
  validator at hand.

## aiken/

**The source.** `aiken/` of that repository at 66648db, with the one line above.
- **What was copied.** `aiken.toml`, `aiken.lock`, `README.md`, `lib/` and `validators/`: 24
  files. When first vendored each was byte-identical to that commit, checked by git blob SHA-1 against
  its tree. Since then one of them has changed: `lib/extra/xlist.ak`, by the line, and by a notice at
  its top that says so, as section 4(b) of the licence asks. The other 23 are as they were (`git diff`
  against the commit that vendored them is empty for them).
- **What was not.** `plutus.json` (above), `export.sh`, `.gitignore`, `lib/subbit/logic.ak.txt`
  and the generated `out/`.
- **It compiles back.** It builds to exactly the default blueprint (above) with Aiken v1.1.24+bacbeb3,
  all 16 validators, hash and compiled code alike. The tests below do not change that.

**The tests in `lib/mark/` are ours** (subbit-x402), not Kompact.io's.
- **Why there.** Subbit's README puts tests in `lib/mark` ("test" and "bench" are keywords,
  hence "mark"). At this commit the folder is gone. The only test left is `test_drop2_with`, of a
  list helper, and `lib/subbit/tbs_tests.ak` is empty.
- **Plan.** The tests follow Subbit's own plan, `docs/design/l1-tests.md`, and go further. The
  module list and results are in [RESULTS.md, step 15](../../RESULTS.md#step-15-the-validators-own-tests).
- **The three that pinned the defect now pass.** At 66648db `bug_batch_fails_when_signers_descend`,
  `bug_two_consumers_in_descending_order` and `bug_ordered_insert_refuses_a_smaller_item` were marked
  `fail`. They lost the mark and the prefix, as in `variant/sponsored`:
  `batch_passes_when_signers_descend`, `two_consumers_in_descending_order`,
  `ordered_insert_takes_a_smaller_item`. `fixed_insert`, a copy of the fix the tests used, went, and
  `fix_gathers_any_signers` tests `xlist.ordered_insert` itself. The compiled old build is held to its
  defect by `test/variant.test.ts`, which runs both blueprints on the same transactions
  (`aiken tx simulate`).
- **Vectors.** `lib/mark/vectors.ak` is written from this package's TypeScript by
  `test/subbit-aiken-vectors.ts`. `npm test` fails while it is stale. The one thing that changed in it
  with the fix is the validator's hash, in the vector and in the three datums that name it. (And one
  comment in `lib/mark/fixture.ak`, which said the source was unmodified.)
- **Run.** `aiken check --max-success 1000 --seed 66648` passes all 74 (28 unit tests and 46 property
  tests, 46,028 checks) on Aiken v1.1.24+bacbeb3, as before the fix.

```
npm run validator                                  # aiken check vendor/subbit/aiken
aiken check --max-success 1000 --seed 66648 vendor/subbit/aiken
aiken build vendor/subbit/aiken                    # writes aiken/plutus.json: equal to plutus.json as JSON
```

Without network, Aiken needs `aiken/build/packages` (stdlib v3.1.0, fuzz 2.2.0), which is
git-ignored, as is `aiken/plutus.json`.
