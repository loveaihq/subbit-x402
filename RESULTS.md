# Spike results — preprod, 2026-09-24

Question: can Cardano take x402-sized payments (≈ $0.001–0.01) at all? On L1 it cannot:
every payment output must carry ≥ 0.978 ADA (`utxoCostPerByte` 4310), and `@x402/cardano`'s
facilitator enforces it (`invalid_exact_cardano_payload_min_utxo_insufficient`). x402's answer
for this is the `batch-settlement` scheme, which exists for EVM and in draft for SVM, not for
Cardano. This spike checks whether Subbit.xyz channels can carry it.

Validator: `subbit.subbit.spend` from kompact-io/subbit-xyz @ 66648db, unmodified
(`vendor/subbit/PROVENANCE.md`). Wallets: the public all-`abandon` test mnemonic, account 0 as
consumer, account 1 as provider. Every figure below was read back from Blockfrost, not taken
from the transaction builder.

| Step | Transaction | Result |
|---|---|---|
| open | `c5a5a138c162fd7fa96f102c6a57dcd484153d0b41035fc855e4a2837cb7bc5d` | 20 tADA locked; inline datum reads back field for field |
| 5,000 IOUs | off-chain | cumulative, 0.001 ADA apart; signing 56 µs, verifying 136 µs each |
| sub | `9b1d9addd28bd534acf4f770a6b9adbdf36dc0f9324d39846dc21571e41047f4` | provider redeems the latest IOU: 5 tADA out, channel stays open with `subbed = 5000000`; fee 0.341537 = **0.000068 ADA per request** |
| mutual | `dcce098c02a34645c9b2a3c44cc54b2c15cc05565b23e3f81e5f7b024b63a866` | both sign; consumer gets the remaining 15 tADA back |

The validator also has to refuse a provider who takes more than was signed for. On a second
channel (`d1576ecc…`, closed by `26c4bedc…`) with one 1 ADA IOU, these were built against
Blockfrost's evaluator and not submitted:

| Attempt | Validator |
|---|---|
| take 2 ADA on a 1 ADA IOU | rejected |
| claim the 1 ADA signature is for 2 ADA | rejected |
| IOU signed by a key the channel does not name | rejected |
| IOU signed for another channel's tag | rejected |
| control: take exactly the 1 ADA signed for | accepted |

Total cost of the run: 1.351459 tADA in fees over five transactions.

## What this does not show yet

- The unilateral lifecycle: consumer `close` → provider `settle` → consumer `end`, and `elapse`
  when the provider never settles. That is the seller's guarantee, and the x402 trust model rests on it.
- A native-asset channel (USDM), where min-UTxO ADA rides alongside the currency.
- A reference script: the validator is attached inline, 3,046 of the sub transaction's 3,784
  bytes, so every redemption pays for it again.
- Anything x402: no `PaymentRequirements`, no facilitator, no HTTP.

## Notes for the binding spec

- Opening a channel runs no validator. Everything a provider relies on — script hash in the
  datum, its own key hash, currency, close period, key and tag lengths, `subbed` — has to be
  checked off-chain before the first IOU is accepted (`checkChannel` in `spike/run.ts`).
- An IOU is `ed25519(iouKey, serialiseData([tag, amount]))`, an indefinite-length CBOR list.
  Tags over 64 bytes would be chunked by `serialiseData`; `src/subbit.ts` refuses them.
- A redemption must leave the channel above its own min-UTxO, so the redeemable amount is the
  channel's lovelace minus that reserve, not the whole balance.
- Blockfrost lists collateral inputs and the collateral-return output of a valid transaction
  among its inputs and outputs, flagged; they were never spent or created.

## Reproduce

```
npm install
npm test
WALLET_MNEMONIC="abandon … art" BLOCKFROST_PROJECT_ID=preprod… npm run spike -- all
npm run spike -- negative
```
