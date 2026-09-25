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
is alpha software by Kompact.io, used unmodified, and neither it nor this code has been audited.

## What is here

| Path | What |
|---|---|
| [`specs/scheme_batch_settlement_cardano.md`](specs/scheme_batch_settlement_cardano.md) | the binding, in x402's spec format (draft v0.6) |
| `src/x402/` | client, resource-server and facilitator schemes for `@x402/core` 2.27, and the server's channel manager: batched claims, a watcher that settles channels their consumers close |
| `src/subbit.ts` | Subbit's datum, redeemers and IOU encoding |
| `spike/` | the preprod runs (`run.ts`, `lifecycle.ts`, `refscript.ts`, `mint.ts`, `x402/e2e.ts`) |
| [`RESULTS.md`](RESULTS.md) | every run, every transaction hash, and each run's reconciliation of the wallets |
| [`DESIGN.md`](DESIGN.md) | the design and its decisions |
| `vendor/subbit/` | Subbit's Aiken blueprint, unmodified ([provenance](vendor/subbit/PROVENANCE.md)) |

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

Each run's wallets reconcile to the lovelace against the fees of its transactions.

## Running it

```
npm install
npm test            # 31 chain-free tests
npm run typecheck
```

As a dependency, `npm i subbit-x402` (built, from npm) or a GitHub commit (which builds itself on
install); it exports `subbit-x402/subbit` and `subbit-x402/x402/<module>` (`client`, `server`,
`facilitator`, `manager`, `chain`, `cardano`, `txcheck`, `types`, `claimtx`). It takes the SDK's
objects, a wallet among them, so use the `@evolution-sdk/evolution` version it pins (0.5.13).
[ada-agent-wallet](https://github.com/loveaihq/ada-agent-wallet) uses the client that way: its
signing daemon runs `BatchSettlementCardanoClient` with an `authorize` hook that puts every
voucher and deposit through its spend policy.

The preprod runs take `WALLET_MNEMONIC`, a preprod test wallet (these used the public
all-`abandon` test mnemonic, accounts 0 to 3, which anyone can spend from: keep nothing of value
there), and `BLOCKFROST_PROJECT_ID`, a preprod Blockfrost key. The commands for each step are at
the end of [`RESULTS.md`](RESULTS.md#reproduce).

## Licence

Apache-2.0. `vendor/subbit/plutus.json` is Kompact.io's, Apache-2.0 as declared in its
repository. Written with AI assistance (Claude); the commits say so.
