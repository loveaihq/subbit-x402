# variant/sponsored

A fork of Subbit's validator with sponsor-safe token channels. What it adds, and why, is in
[DESIGN.md](DESIGN.md). **The validator and its tests; it ran on preprod in RESULTS.md step 17. Subbit is
alpha software by Kompact.io, and nothing here has been audited.**

## Fork base

- **Upstream.** [kompact-io/subbit-xyz](https://github.com/kompact-io/subbit-xyz), `aiken/`, at
  commit `66648db2e5dbc459b8cd335846af079328c4313f`: the same base as
  [vendor/subbit](../../vendor/subbit/PROVENANCE.md), copied from `vendor/subbit/aiken/` with
  `cp -r`, its `build/` included so that Aiken resolves the dependencies offline.
- **One fix from upstream's `demo` branch**, commit `21c1905`: in `lib/extra/xlist.ak`,
  `ordered_insert` has `Greater -> [item, x, ..xs]` where `66648db` has `Greater -> fail
  @"Impossible"`. That makes a batch whose signers come in descending order possible (RESULTS.md,
  step 15, "The defect"). The commit and the line are as the milestone brief gave them; this
  session had no network and did not fetch `21c1905`.
- **Licence.** Apache-2.0, as declared in upstream's `aiken/aiken.toml` (upstream has no top-level
  LICENSE file, and the files carry no copyright or NOTICE text of their own). The licence of this
  repository, Apache-2.0, is [../../LICENSE](../../LICENSE). Each of upstream's files that this
  variant changes opens with a notice that says so, as section 4(b) of the licence asks. The files
  it adds, and the tests in `lib/mark`, are this repository's, under the same licence.

## The validator

- **Spend validator `subbit.subbit.spend`:** `20b64ee22a509c164e0e16ad1189b12be7f0a497b0eb096180c923ea`
  (Plutus V3, 3,798 bytes of compiled code; upstream's `62ce4309…` is 3,046). Milestone 1's, before
  R2 named the channel input's output reference instead of the tag, was `bdf4e042…`.
- **Blueprint:** [plutus.json](plutus.json), the `aiken/plutus.json` that `aiken build` writes,
  sha256 `974b68c608c8971e7cde1cda473c92070ca404040bf7c4a04467d572b2ca7c52`. It has 16 entries:
  the real validator (spend and else) and upstream's dummy ones that expose its types.
- **Built with** Aiken v1.1.24+bacbeb3, `aiken build variant/sponsored/aiken`, default flags (no
  traces). The same compiler with the same flags builds `vendor/subbit/aiken` to the blueprint
  vendored beside it, hash and compiled code alike, for all 16 validators (checked in this
  session). The hash does not depend on the directory it is built in (checked).
- `aiken.toml` still says `compiler = "v1.1.23"`, as upstream's does; Aiken warns, and it is
  harmless.

## What changed, file by file

Paths are under `aiken/`. Everything not listed is byte for byte upstream's (and
`vendor/subbit/aiken`'s): `README.md`, `aiken.lock`, `validators/subbit.ak`, `validators/x.ak`,
`lib/conformance/iou.ak`, `lib/subbit/{assets,iou,prelude,spend,tbs_tests}.ak`,
`lib/subbit/spend/defer.ak`.

**Validator**

| File | Change |
|---|---|
| `aiken.toml` | Name `loveaihq/subbit-sponsored`, description, repository. Dependencies as upstream's. |
| `lib/subbit/types.ak` | `Sponsor = (Address, Int)`. `Constants` gets a 7th field, `Option<Sponsor>`. |
| `lib/subbit/io.ak` | `yield_in` also hands back the output reference of the channel input it finds: a new argument of its callback. R2's datum names it. Nothing else. |
| `lib/subbit/sponsor.ak` | **New.** R0 `currency_is_a_token`, R1 `keeps_the_floor`, R2 `is_repaid`: an output at the sponsor's address, with the input's output reference as its inline datum, and at least `floor`. |
| `lib/subbit/spend/main.ak` | R0 and R1 checked in `mk_with`. The transaction's outputs are passed down as `tx_outputs`, and `End` and `Elapse` are given them, with the input's output reference (`End` its input value too). |
| `lib/subbit/steps/end.ak` | R2, and R3: the provider signs when a sponsored channel holds none of its currency. New arguments: the input value, its output reference and the outputs. |
| `lib/subbit/steps/elapse.ak` | R2. New arguments: the input's output reference and the outputs. |
| `lib/subbit/steps/{add,sub,close,settle}.ak` | The 7-tuple destructuring. Nothing else. |
| `lib/subbit/spend/mutual.ak` | The same. Mutual is as it was. |
| `lib/extra/xlist.ak` | The `ordered_insert` fix above. |
| `lib/conformance/wire.ak` | The 7-tuple, and a `sponsor` wire check. Nothing uses this module. |

**Tests** (this repository's, ported from `vendor/subbit/aiken/lib/mark`)

| File | Change |
|---|---|
| `lib/mark/sponsored.ak` | **New.** 84 tests of R0 to R3, Mutual, the sponsor as a constant, whole lifecycles, upstream's datum, `io.yield_in`, and the repayment's datum and the channel's on the wire. |
| `lib/mark/fixture.ak` | `constants` and `tagged` have the 7th constant, `None`. Added: builders for sponsored channels, `repayment` (an output that names an output reference), transaction ids (`txid`, `other_txid`), `oref_of` and `input_at`. `oref` is built from `txid`. |
| `lib/mark/outputs.ak` | `output_keeps_the_constants` changes each of seven constants (the seventh: no sponsor to one). |
| `lib/mark/mutual.ak` | The 7-tuple in `mutual_can_rewrite_the_channel`. |
| `lib/mark/batch.ak` | The 7-tuple in `two_adds`. The three `bug_` tests lose `fail` and the prefix: `batch_passes_when_signers_descend`, `two_consumers_in_descending_order`, `ordered_insert_takes_a_smaller_item`. `fixed_insert`, a copy of the fix, goes: `fix_gathers_any_signers` tests `xlist.ordered_insert` itself. |
| `lib/mark/vectors.ak` | Three datum vectors end their constants with `d87a80`, no sponsor. Nothing else changes (checked against upstream's, ignoring comments and layout). The validator's hash in it stays upstream's. |
| `lib/mark/{steps,design,conformance}.ak` | Layout only, by `aiken fmt`: they are the same as upstream's once whitespace and trailing commas are ignored (checked). |

`lib/mark/vectors.ak` is generated from the TypeScript client in `vendor/subbit/aiken`; here its
three datum vectors are edited by hand to carry the seventh constant, `None`. The sponsored
vectors are the ones in `lib/mark/sponsored.ak`, and `test/variant.test.ts` reads them from that
file and matches the TypeScript encoders to them byte for byte.

## What was run

All offline: no network, no chain.

- **The suite:** `aiken check variant/sponsored/aiken --max-success 1000 --seed 66648`. All 158
  tests pass, in 85,073 checks and 146 s on Aiken v1.1.24. 74 are ported: this repository's 73 of
  upstream's behaviour, and upstream's own `test_drop2_with`. 84 are new, in
  `lib/mark/sponsored.ak`, 47 of them marked `fail`. Seed 12345 at the same depth passes too.
  The JSON is [check.log](check.log) (seed 66648) and `check-seed12345.log`, both ignored by git
  like every `*.log`.
- **`aiken fmt --check`:** clean, run in `aiken/`, in `variant/sponsored` and at the root.
- **A channel with no sponsor is upstream's, plus the fix.** The 73 ported tests pass with
  `sponsor = None`; three of the test modules are upstream's once layout is ignored, and the
  vectors differ by the three inserted bytes. It is not free: the 18 unit tests that both suites
  have, and that run a channel through the validator, use 3.9% to 10.5% more memory (mean 7.7%) and
  3.5% to 10.4% more CPU (mean 5.8%), the test's own work included, for the longer constants and
  the checks that find `None`.
- **Do the tests that should fail fail for the right reason?** 34 mutants of the validator,
  each in a scratch copy with one rule broken, were run against the suite. For R2's datum: the tag
  again (the earlier scheme), any datum, any inline datum, the transaction id ignored, the index
  ignored, a datum hash accepted. For the rest of R2: off, off by one, without its address, with
  the payment credential alone, without its lovelace, a floor fixed in the code, on End alone or
  Elapse alone, and reading what the continuing steps leave of the outputs instead of all of
  them. For `io.yield_in`: a constant output reference, and the next input's. And R0 and R1 off,
  off by one, or applied to every channel; R3 inverted, for every End, for unsponsored channels, or
  also on Elapse; the wrong signer; Mutual refusing a sponsored channel or needing one signer; the
  sponsor free to change on a continuing output; the old `ordered_insert`. Each of 46 of the
  47 tests marked `fail` in `lib/mark/sponsored.ak` fails, as a plain test, under at least one
  mutant. The other, `a_datum_with_six_constants_is_not_read`, fails on the cast in `io.coerce_datum`,
  as its trace shows. The mutants are not in this repository. The wire tests
  (`the_datum_with_a_sponsor_decodes`, `the_repayment_datum_on_the_wire`) fail when a byte of a
  vector is changed.

## Reproducing

```
npm run validator:sponsored                                         # aiken check variant/sponsored/aiken
aiken check variant/sponsored/aiken --max-success 1000 --seed 66648
aiken check variant/sponsored/aiken --max-success 1000 --seed 12345
aiken build variant/sponsored/aiken                                 # writes aiken/plutus.json, the hash above
cd variant/sponsored/aiken && aiken fmt --check
```

Without network, Aiken needs `aiken/build/packages` (stdlib v3.1.0, fuzz 2.2.0), which this copy
took from `vendor/subbit/aiken/build`. Both are git-ignored, as is `aiken/plutus.json`.
