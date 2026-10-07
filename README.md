# subbit-x402

x402's `batch-settlement` scheme on Cardano, over [Subbit.xyz](https://github.com/kompact-io/subbit-xyz)
payment channels: a binding spec in x402's format, and a reference implementation run end to end
on preprod.

Cardano cannot take x402-sized payments on its ledger directly. Every output must hold its
min-UTxO, about 0.98 ADA ($0.23 in September 2026), while 95% of the resources in x402's discovery
index sold for less than $0.27 then, and none of them accepted Cardano. `batch-settlement` is
x402's answer to prices that small: the client locks funds in a channel once, pays for each
request with a signed cumulative voucher that the server checks off-chain, and the server
redeems many requests in one transaction. The scheme has an EVM binding and an SVM draft; this is
one for Cardano, on Subbit's channel validator.

**Status: a research spike, preprod only.** Nothing here has run on mainnet. The Subbit validator
is alpha software by Kompact.io, used as upstream's main has it, with the one-line fix of its pull
request #10 (steps 15 and 18), and neither it nor this code has been audited. Its source is here
too, with tests of our own at the exact hash this code uses (step 15). Channels opened before that
fix sit at another hash, `62ce4309…`, and are still served ([Which validator](#which-validator)).
Steps 1 to 16 below ran at that earlier hash (step 17 at the sponsor-safe variant, step 18 at the
fixed one), which is why their hashes and fees differ a little from what the default build gives.

## What is here

| Path | What |
|---|---|
| [`specs/scheme_batch_settlement_cardano.md`](specs/scheme_batch_settlement_cardano.md) | the binding, in x402's spec format (draft v0.6) |
| `src/x402/` | client, resource-server and facilitator schemes for `@x402/core` 2.27, and the server's channel manager: batched claims, a watcher that settles channels their consumers close |
| `src/subbit.ts` | Subbit's datum, redeemers and IOU encoding |
| `spike/` | the preprod runs (`run.ts`, `lifecycle.ts`, `refscript.ts`, `mint.ts`, `x402/e2e.ts`, `x402/sponsored.ts`, `x402/variant.ts`, `x402/fixed.ts`) |
| [`RESULTS.md`](RESULTS.md) | every run, every transaction hash, and each run's reconciliation of the wallets |
| [`DESIGN.md`](DESIGN.md) | the design and its decisions |
| [`SPONSORSHIP.md`](SPONSORSHIP.md) | seller-sponsored channels: the seller's offer pays a token channel's fees and reserve |
| `vendor/subbit/` | Subbit's Aiken blueprints, the fixed build (`plutus.json`, `6d877463…`, the default) and the one before the fix (`plutus-62ce4309.json`), and its source, with that one line changed, and our tests of the validator in `aiken/lib/mark/` ([provenance](vendor/subbit/PROVENANCE.md)) |
| `variant/sponsored/` | an opt-in fork of that validator that sends a seller's reserve back to it when a buyer exits alone: unaudited, run on preprod (RESULTS.md step 17), trusted only when named ([DESIGN.md](variant/sponsored/DESIGN.md), [SPONSORSHIP.md](SPONSORSHIP.md) section 7) |

## What ran on preprod

| Step | |
|---:|---|
| 1 | 5,000 cumulative IOUs over one channel, redeemed by one `Sub`: 0.00007 ADA a request |
| 2 | Each side's unilateral exit (close, settle, end, elapse), and 17 transactions the validator must refuse |
| 3 | The validator as a reference script: a quarter off every channel transaction's fee |
| 4 | x402 `batch-settlement` end to end over HTTP: deposit, vouchers, corrective 402, batched claims, refund |
| 5 | Token channels, in a USDM stand-in |
| 6 | Top-ups (`Add`), and the server settling a channel its consumer closed |
| 7 | A client that keeps its token UTxOs folded |
| 8 | Finding the channels again after losing the client's records |
| 9 | A lost response's retry answered from the kept response; a server whose provider key the facilitator holds |
| 10 | Moneta's real preprod tUSDM |
| 11 | A watcher that follows the chain instead of polling every channel |
| 12 | A watcher that survives rollbacks |
| 13 | A retry after a lost MCP answer, answered from the kept result; a top-up that falls back to what the wallet can fund |
| 14 | Buyer and seller through Koios, with no Blockfrost key |
| 16 | Seller-sponsored channels: a buyer holding only tUSDM opens, tops up and is refunded without ADA of its own ([SPONSORSHIP.md](SPONSORSHIP.md)). From 0.2.1 the buyer checks the seller's offer against the chain before building with it; upgrade from 0.2.0 |
| 18 | Subbit's fixed validator (`6d877463…`): the x402 flow on it, open, paid requests, claim and refund, and the batch of two signers that `62ce4309…` refuses and it takes, on the chain |

Each run's wallets reconcile to the lovelace against the fees of its transactions.

**Step 15, the validator itself (no chain).** Subbit's Aiken source at the blueprint's commit
compiles to the same 16 validators with Aiken 1.1.23 and 1.1.24. It has 73 tests of our own:
- every test case in Subbit's own plan (its benchmarks aside);
- the mutual spends that plan left as TODO;
- batches and the continuing output;
- the design properties this binding relies on;
- byte-for-byte agreement with this package's encodings.

They found one defect. A batch that needs two different signers fails when the later step's
signer sorts first. It fails closed, and this binding never builds such a batch, because each of
its transactions has one signer. Upstream merged the fix in its pull request #10, `vendor/subbit`
has it, and step 18 ran the batch on preprod at both builds: the old one's evaluator refuses it, the fixed one
takes it.

## Which validator

Subbit's validator is here in two builds, besides this repository's variant of it, and a channel stays at the one it opened at:

| | Hash | Name in `src/subbit.ts` | Used |
|---|---|---|---|
| Subbit as upstream's main has it (the `ordered_insert` fix) | `6d877463…` | `UPSTREAM`; `SUBBIT_HASH` and `subbitScript` are its hash and script | by default, for every new channel |
| Subbit at 66648db, before the fix | `62ce4309…` | `UPSTREAM_66648DB` | for the channels already opened there, and when it is named |
| The sponsor-safe variant ([DESIGN.md](variant/sponsored/DESIGN.md)) | `20b64ee2…` | `SPONSORED` | only when named |

- **A client** trusts both of Subbit's by default (`UPSTREAM_VALIDATORS`) and opens at the one the server's
  402 names. It closes, ends and elapses a channel at its own validator, whichever that is, finds its
  channels at both again (`recover`), and refunds one through a 402 that names its validator.
- **A facilitator** serves both by default. Given `scriptHash` alone it serves that one alone, which is now the
  fixed one: to go on serving channels at `62ce4309…` give it `validators: UPSTREAM_VALIDATORS`.
- **A server and its manager** name one validator, `scriptHash`, and by default it is the fixed one. A server
  whose channels are at `62ce4309…` names `UPSTREAM_66648DB.hash` and claims, settles and refunds them as before;
  new channels need a server (or a second one) at `6d877463…`.
- **A reference-script output** is read only when it carries the validator at hand. One made for the
  build before the fix is not read at the fixed one: the script is attached instead.
- **The old build's one defect** (a batch of two signers in descending order) cannot be reached by this
  binding's own transactions, so nothing here has to avoid the old build; what the fix buys is the batches
  other builders may make.

## Running it

```
npm install
npm test            # 116 chain-free tests; 9 of them run the compiled validators and need aiken on the PATH
npm run typecheck
npm run validator   # the validator's Aiken tests; needs aiken 1.1.23 or later
```
Node 22 or newer. CI (`.github/workflows/ci.yml`) runs the tests and the typecheck on Linux, macOS
and Windows, each on Node 22 and 24, and `aiken check` once.

As a dependency, `npm i subbit-x402` (built, from npm) or a GitHub commit (which builds itself on
install); it exports `subbit-x402/subbit` and `subbit-x402/x402/<module>` (`client`, `server`,
`facilitator`, `manager`, `chain`, `koios`, `cardano`, `txcheck`, `types`, `claimtx`, `sponsor`, `repay`). It takes the SDK's
objects, a wallet among them, so use the `@evolution-sdk/evolution` version it pins (0.5.15).
[ada-agent-wallet](https://github.com/loveaihq/ada-agent-wallet) uses the client that way: its
signing daemon runs `BatchSettlementCardanoClient` with an `authorize` hook that puts every
voucher and deposit through its spend policy. The chain is read through `BlockfrostChain`
(`chain`), with a Blockfrost key, or `KoiosChain` (`koios`), which needs none. A server sponsors
token channels for buyers that hold no ADA by passing `sponsor: { pool: new SponsorPool({ wallet }) }`,
with a wallet at a key of its own, not the provider key (`sponsor`, SPONSORSHIP.md); its
facilitator must be this one, or another that merges `sponsorWitnesses`.

The preprod runs take `WALLET_MNEMONIC`, a preprod test wallet (these used the public
all-`abandon` test mnemonic, accounts 0 to 3 and, in step 16, 8 and 9, which anyone can spend from: keep nothing of value
there), and `BLOCKFROST_PROJECT_ID`, a preprod Blockfrost key. The commands for each step are at
the end of [`RESULTS.md`](RESULTS.md#reproduce).

## Licence

Apache-2.0. `vendor/subbit/plutus.json` and `vendor/subbit/aiken/`, all but `lib/mark/`, are
Kompact.io's, Apache-2.0 as declared in its repository. Written with AI assistance (Claude); the
commits say so.
