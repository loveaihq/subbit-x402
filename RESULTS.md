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

## Step 1: a provider gets paid at x402 prices

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

The check behind "rejected" here matched error text, which an evaluator outage produces too
(see [the refusal check](#the-refusal-check)). Step 2 built the same four again, on channel A
under the stricter check, and all four were refused.

## Step 2: each side is protected when the other stops cooperating

x402's batch-settlement trust model needs two things from a channel. A provider must be paid for
every IOU it holds even if the consumer closes on its own, and a consumer must get its deposit
back even if the provider disappears. Two channels, one for each (`spike/lifecycle.ts`).

**A: the consumer closes on its own, and the provider is still paid.** Close period 1 hour.

| Step | Transaction | Result |
|---|---|---|
| open | `7bfb526af6db57b829241747ee35593924de59f51f0cb3f0c3167d2d50f7aba4` | 10 tADA; the provider's checks on the channel pass |
| sub | `50bfdc1c8f42c540c9747627455fdf66248f2e7478d04b14313338003f257710` | after 1,000 IOUs the provider redeems 1 tADA; the channel stays open with `subbed` = 1 tADA |
| close | `f74664e9180398acbd311f87191d361d67e6b345a9b10f7e5ba5e9c1c1f72a61` | after 2,000 more IOUs the consumer closes without the provider: value unchanged, stage `Closed` with `subbed` still 1 tADA and `elapse_at` 03:20:37Z, which is the upper bound the script saw (the TTL, 02:20:37Z) plus 1 h |
| settle | `1a5b1232bc3690c5399b0329135cfcb5c0f38f43ac129aaf22413bf675c2cc39` | the provider presents its latest IOU, 3 tADA, and takes exactly 3 − 1 = 2 tADA, 63 min before `elapse_at`; stage `Settled` |
| end | `24ce6c5e4a6188d11f5f0c7f6eab9149d880d54f88561f1b1ee5ec386bc70c38` | the consumer takes back the remaining 7 tADA |

**B: the provider disappears, and the consumer gets everything back.** Close period 10 minutes,
short only so the run takes minutes rather than an hour; the validator's arithmetic is the same.

| Step | Transaction | Result |
|---|---|---|
| open | `b85b8e0ed44b086658e5bd033bc32a69d856955aa61cd41feb55f357a9c9bca8` | 5 tADA |
| close | `977dae21c565e4fe6ed8b30e54da240dc787ae19c9e273602c35efddbaf839b8` | 500 IOUs (0.5 tADA) never redeemed; the consumer closes, `elapse_at` 02:28:53Z; the provider takes no further part |
| elapse | `771e1f9224225baf517fe6a38fdf8cc5118dfba6ce38261811645fe36809948f` | valid from 02:28:53Z, exactly `elapse_at`; the consumer takes all 5 tADA back with no signature from the provider |

Before these steps, transactions the validator must refuse were built against Blockfrost's
evaluator and not submitted. Each differs in one value from the honest transaction that followed it:

| Channel | Transaction | Validator |
|---|---|---|
| open | step 1's four, at tighter margins: 1 lovelace more than the IOU covers, the IOU presented as one request larger, signed by a key the channel does not name, signed for another channel's tag | refused, all four |
| open → closed | `elapse_at` 1 ms short of the upper bound plus the close period | refused |
| | no upper bound on the validity range | refused |
| | the close moves 1 tADA out of the channel | refused |
| | the close records `subbed` = 3 tADA, cancelling the 2 tADA still owed to the provider | refused |
| | the provider signs the close instead of the consumer | refused |
| closed | the consumer elapses before `elapse_at` | refused |
| | the consumer ends before the provider has settled | refused |
| | the provider settles 1 lovelace more than owed − subbed | refused |
| | the provider settles but leaves the stage `Closed`, open to a second settle | refused |
| settled | the provider settles again | refused |
| | the provider ends the channel, taking the remaining 7 tADA | refused |
| closed, past `elapse_at` | the consumer elapses one slot (1 s) before `elapse_at` | refused |
| | the provider elapses, taking the 5 tADA | refused |
| | the provider settles late | **accepted** (built, not submitted; see the notes) |

Total cost of the run: 2.357853 tADA in fees over eight transactions. Afterwards the consumer
held 113.010775 tADA and the provider 16.973220, exactly what the fees and the 3 tADA paid to
the provider predict. Leaving without the other side costs more than leaving together: in A,
close + settle + end came to 0.999894 tADA across both parties, against 0.316448 for step 1's
mutual close.

### The refusal check

Step 1 counted a failed build as "rejected" when the error text matched
`/evaluat|script|validator|ExUnits|redeemer/i`. A failing script and an evaluator outage produce
the same message, `Script evaluation failed: Provider evaluation failed: Blockfrost evaluateTx
failed` (checked by making the evaluate endpoint answer HTTP 500), so that match could not tell
them apart. `refused()` in `spike/chain.ts` now requires Ogmios' `EvaluationFailure.ScriptFailures`
answer at the end of the error's `cause` chain, and stops the run on anything else. Blockfrost
returns `ScriptFailures: {}` with no detail, on both of its evaluate endpoints, so which condition
failed is shown by construction: each refused transaction is one value away from a control that
the same evaluator accepts.

## What this does not show yet

- A native-asset channel (USDM), where min-UTxO ADA rides alongside the currency.
- A reference script. The validator is attached inline, 3,046 bytes of every 3.5–3.8 KB script
  transaction, so every step pays for it again. At preprod's current parameters (44 lovelace per
  byte, 15 per reference-script byte, 155,381 base) a settle would cost about 0.255 tADA instead
  of 0.3415, about a quarter less (estimated, not measured), in exchange for one output holding
  the script, which ties up about 14 tADA of min-UTxO.
- Anything x402: no `PaymentRequirements`, no facilitator, no HTTP.

## Notes for the binding spec

- Opening a channel runs no validator. Everything a provider relies on — script hash in the
  datum, its own key hash, currency, close period, key and tag lengths, `subbed` — has to be
  checked off-chain before the first IOU is accepted (`checkChannel` in `spike/chain.ts`).
- An IOU is `ed25519(iouKey, serialiseData([tag, amount]))`, an indefinite-length CBOR list.
  Tags over 64 bytes would be chunked by `serialiseData`; `src/subbit.ts` refuses them.
- A redemption must leave the channel above its own min-UTxO, so the redeemable amount is the
  channel's lovelace minus that reserve, not the whole balance.
- Blockfrost lists collateral inputs and the collateral-return output of a valid transaction
  among its inputs and outputs, flagged; they were never spent or created.
- The provider always has at least the close period to settle, counted from when the close is on
  chain: a close must land before its TTL, and the validator requires `elapse_at` ≥ start of the
  TTL slot + close period, to the millisecond. A consumer can lengthen that window but not shorten
  it. In A the close landed 64.5 min before `elapse_at`, in B 14.7 min.
- Settle has no deadline in the validator. A settle after `elapse_at` still validates until the
  consumer's elapse lands, so the two race. `elapse_at` is the provider's deadline in practice,
  not in the script: the binding should tell providers to settle well before it, and a consumer
  should not treat an unredeemed IOU as void until its elapse has confirmed.
- Validity bounds reach the script as slot starts, and the SDK floors `setValidity` times to
  slots. So a consumer sets `elapse_at` = start of the TTL slot + close period. To elapse, it sets
  the lower bound to the first slot at or after `elapse_at` and submits only once the chain tip has
  reached that slot, since a node rejects a transaction whose validity interval has not begun.
- A close carries `subbed` unchanged into `Closed`, and a settle takes at most owed − subbed, so
  mid-life redemptions and the final settle never pay for the same requests twice.
- `end` checks no time: once the provider has settled, the consumer can end in the next block.
- The unilateral route is the fallback, not the normal exit: about three times the fees of a
  mutual close, and a wait of up to the close period when the provider is gone.

## Reproduce

```
npm install
npm test
WALLET_MNEMONIC="abandon … art" BLOCKFROST_PROJECT_ID=preprod… npm run spike -- all
npm run spike -- negative
npm run lifecycle -- all   # ~20 min; B's close period runs down while A is exercised
```

`npm run lifecycle -- <phase>` runs one phase at a time (`b-open`, `b-close`, `a-open`, `a-sub`,
`a-close`, `a-settle`, `a-end`, `b-elapse`, `report`). State, including the throwaway IOU keys,
is in the gitignored `out/lifecycle.json`.
