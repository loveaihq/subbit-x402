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

## Step 3: the validator as a reference script

Steps 1 and 2 attached the validator to every transaction that spends a channel: 3,046 bytes of
each 3.5–3.8 KB transaction, paid for again every time. Here it goes on chain once, in an output
held by account 2 of the same mnemonic, and both runs are repeated with every channel transaction
reading it as a reference input instead (`SUBBIT_SCRIPT=ref`; `spike/refscript.ts` deploys,
checks and reports).

| Step | Transaction | Result |
|---|---|---|
| deploy | `544752f68665183e51c8ecb6e0a835543aec64a6ec8e7588d34470ddfd12cdb5` | output #0 carries the validator, its hash checked through Blockfrost and again through the SDK, and 14.154040 tADA: 4,310 × (160 + 3,124) bytes, exactly its min-UTxO; fee 0.306345 |
| step 1 open | `0ee2079b2f583410dfc10d7ef333756989d6b759eba4c5ae05d7d0667cb7dd47` | 20 tADA, as before |
| step 1 sub | `616c5dc674416897ad2107fa79fb8b344a744758cc4663f7ca50d7c235404923` | 5,000 IOUs redeemed in one transaction, 5 tADA; fee 0.254730 = **0.000050 ADA per request**, down from 0.000068 |
| step 1 mutual | `5caf3ee33b31198060a07f4e943bace1812ba7d2bb23d034078aee11cda8a20c` | the consumer gets the remaining 15 tADA back |
| A open | `bb77719cbd1f2ee33b0a50490f900e7720a5ba99d69f38824440ed3c13eb38da` | 10 tADA, close period 1 h |
| A sub | `78d11974c3108b9d07fc731f032c13068699396224a2fd6d2cd1494916135e44` | the provider redeems 1 tADA mid-life |
| A close | `10c144670edafa111abd910c61d0069178606b8b989020265ce4f38a7d6aabf2` | the consumer closes alone |
| A settle | `027ecd2ba759e1c112110c7af420cf1eaa165efe5c5657e40bf4f46bc0e28d24` | the provider takes 3 − 1 = 2 tADA, 62 min before `elapse_at` |
| A end | `726b72433c1b4ebcdf343e9530974cfc09b75b25a3825cb88439b693e42cfac6` | the consumer takes back the remaining 7 tADA |
| B open | `9f3dfbeb99d49c6eb63e38a6798a13b3a95eab526ce3b22ac383a95387d013ed` | 5 tADA, close period 10 min |
| B close | `dd9c6c319b492f2b3cd5b3e3cb9fc365ef4a220f8d75e61a72df5eda8e6f4d43` | 500 IOUs never redeemed; the consumer closes |
| B elapse | `ed81a7e2295d5e9823919212f5a5e15a56677a0233f7466bd25e32fc488c01da` | from `elapse_at`, the consumer recovers all 5 tADA |

Every read-back check of both runs passed again, and step 2's build-only checks came out as
they did with the validator attached: all 17 refusals refused, the late settle accepted.

Each channel transaction beside its inline twin, from `npm run refscript -- report`. The report
splits every fee the way the ledger charges it, at the parameters of the transaction's epoch:
44 lovelace per byte plus 155,381, execution units at 0.0577 per unit of memory and 0.0000721 per
step, and 15 lovelace per byte of reference script read.

| Transaction | Inline bytes | Inline fee | Ref bytes | Ref fee | Saved |
|---|---:|---:|---:|---:|---:|
| step 1 sub | 3,784 | 0.341537 | 771 | 0.254730 | 0.086807 (25.4%) |
| step 1 mutual | 3,544 | 0.316448 | 597 | 0.232545 | 0.083903 (26.5%) |
| A sub | 3,820 | 0.343714 | 807 | 0.256904 | 0.086810 (25.3%) |
| A close | 3,846 | 0.340604 | 1,080 | 0.264665 | 0.075939 (22.3%) |
| A settle | 3,778 | 0.341529 | 765 | 0.254722 | 0.086807 (25.4%) |
| A end | 3,488 | 0.317761 | 475 | 0.230954 | 0.086807 (27.3%) |
| B close | 3,842 | 0.340428 | 1,076 | 0.264489 | 0.075939 (22.3%) |
| B elapse | 3,494 | 0.318615 | 481 | 0.231808 | 0.086807 (27.2%) |
| **all eight** | | 2.660636 | | 1.990817 | **0.669819 (25.2%)** |

Step 1's sub, split: inline 0.341537 = 0.321877 for its size + 0.019616 for the script's
execution units + 44 lovelace; by reference 0.254730 = 0.189305 + 0.019616 + 0.045690 for reading
the script + 119 lovelace.

- The saving is all size. The execution units are identical in seven of the eight pairs and
  within 0.1% in the eighth (A sub, 3 lovelace), so the validator does the same work however it
  is supplied. Like for like, a transaction loses 3,013 bytes at 44 lovelace each and pays
  15 × 3,046 = 45,690 lovelace to read the script: 0.086807 tADA saved, whichever step it is.
- The rows that differ do so for reasons outside the script. The two closes saved 2,766 bytes
  because coin selection picked a consumer UTxO carrying 8 native tokens instead of 2, and the
  change output carried them along (247 bytes); the public abandon addresses hold tokens other
  people have sent. The ref-mode mutual has a collateral-return output the inline one lacked
  (66 bytes).
- The deploy's 0.306345 fee is repaid after four channel transactions. Its 14.154040 tADA is
  held, not spent: account 2 can spend the output back once the script is no longer needed.
- The builder paid 44–45 lovelace above the ledger's charge inline and 119–120 by reference. The
  extra 75 is the SDK pricing the reference script at its 3,051-byte CBOR form (`[3, script]`)
  where the ledger counts the script's 3,046 bytes (Blockfrost's `serialised_size`); it errs on
  the side that cannot be rejected.
- The run's eleven transactions cost 2.537084 tADA in fees, against 3.209763 for the same eleven
  inline. Consumer 113.010775 → 88.779662 tADA, provider 16.973220 → 24.206864. Less the
  14.154040 now in the reference-script output, the two lost exactly the 2.843429 tADA of fees
  paid by the deploy and the eleven transactions after it. The provider also reconciles on its
  own: 8 tADA received, 0.766356 paid in fees for its three transactions.

The first attempt at B's close failed at submission after passing evaluation. It was built
3 s after B's open had confirmed, from the same wallet. The runner printed only the SDK's top
error, so the node's reason is not known (`run()` now prints the whole `cause` chain). The
likely cause is Blockfrost's address index, which trails confirmation by ~20 s: it still listed
the input B's open had just spent, largest-first selection picked it, and the SDK evaluates
against the UTxOs it selected (`/utils/txs/evaluate/utxos`), so only the node could refuse it.
The same close built two minutes later went through, and `submit()` now waits until the wallet
no longer lists any input a confirmed transaction spent.

## Step 4: x402 `batch-settlement` end to end

Milestone 1 of `DESIGN.md`: the binding in `src/x402/` (client, resource-server and facilitator
schemes for `@x402/core` 2.27.0, and the server's channel manager), driven by
`spike/x402/e2e.ts`. The facilitator (127.0.0.1:7413, no key, no funds) and the resource server
(127.0.0.1:7411, `GET /data` priced 1,000 lovelace, close period 900 s) run in one process and talk
real HTTP; the client is `@x402/fetch`'s `wrapFetchWithPayment` around the binding's client
scheme. Channels read the validator from step 3's reference script. Consumer = account 0,
provider (`payTo`) = account 1.

| Phase | Transaction | Result |
|---|---|---|
| request 1 | `0614b7d062db1ffd1385333d08c55ca48326c4f56ebe374999ce263c2dc70981` | the deposit opens a channel with 3 tADA of capacity; answered after 35.5 s, a block included |
| requests 2–200 | none | median 14.8 ms, p90 30.1 ms, max 49.8 ms; no chain; 2 HTTP calls each (402, then paid); server and client both count 200,000 lovelace |
| claim | `de70bb06fca7c4f59720b81b7a4b847a456f8f7645f5ac626048076b3788da1d` | one `Sub` redeems 0.200000 tADA for the 200 requests to `payTo`; fee 0.256907 |
| corrective 402 | none | the client's count set one request behind, then one ahead: each time 3 HTTP calls and the counts back in step |
| refund | `d6c97926b18923bff9ec1e32f8637028c0e9f2a3ebb858255e13cc73a14538e1`, `b053c1d16da3f37e0f8c116e2ed03b6e90aa8a42a89414873641d2596d9184be` | a claim of the last 0.002 tADA, then the consumer's `Mutual`, co-signed by the server: 4.300979 tADA back |

**Batching.** Ten more channels, one paid request after another, then claims of 10, 5 and 1
channels per transaction, one `Main` over the first channel and `Defer` on the rest:

| Channels | Transaction | Bytes | Memory | Steps | Fee | Per channel |
|---:|---|---:|---:|---:|---:|---:|
| 1 | `32092dc3ac28fcccfc12b5dbc55c7ad941afc0b4287ab2073e29fd52a74b2347` | 803 | 191,022 | 127,363,413 | 0.256727 | 0.256727 |
| 5 | `9ce9a419839ad87c7d35c7672d68e033de9c3a877f9e04330be022945b9c6078` | 2,203 | 912,059 | 635,384,521 | 0.396566 | 0.079313 |
| 5 | `2030137c27fef7087352babc81b1e7ff7bca640a938b11bc2f9e9f444cdad520` | 2,203 | 912,059 | 635,384,521 | 0.396566 | 0.079313 |
| 9 | `b6d1183cc87dd1af69776610568d11ec8c8f3e9104ed3563f318d59741a567a3` | 3,603 | 1,633,294 | 1,143,182,869 | 0.536399 | 0.059600 |
| 10 | `4fa168b6dcdcbaf61bda06d57ebda03dab389f52b1d1bb68bb20ecf913c680dc` | 3,953 | 1,813,578 | 1,270,160,301 | 0.571358 | 0.057136 |

Every channel added costs the same: 350 bytes, 180,284 memory units, 126,977,432 steps, and
0.034959 tADA, so a claim over N channels costs 0.221768 + 0.034959 × N tADA. Of preprod's limits
per transaction (16,384 bytes, 17.5 M memory, 10 G steps), size binds first, at 45 channels
(extrapolated, not measured), about 0.040 tADA per channel. At 1,000 lovelace a request, a claim
over one channel pays for itself after 257 requests, over ten after 58 per channel.

Afterwards all eleven batch channels were refunded with `Mutual` (`3375a341…`, `2f42e704…`,
`debe4ac6…`, `cd6f3f07…`, `25355586…`, `dca3f90f…`, `66f80442…`, `88a5805a…`, `bbda9ac5…`,
`330a8229…`, `431b3d9f…`; 597 bytes and 0.232545 tADA each). **Reconciliation:** 31
transactions (12 deposits, 7 claims, 12 refunds), 7.559126 tADA in fees; consumer 88.369112 →
83.239416 tADA, provider 23.953134 → 21.523704, nothing left in channels, and the two wallets lost
exactly the fees. The provider is down because these runs redeemed 0.242 tADA of charges against
2.7 tADA of claim fees: at x402 prices a claim has to wait for volume.

What the run changed in the code:

- **A deposit that confirms late.** The eleventh deposit (`7e72cefe…`) landed at 06:20:22,
  2.5 minutes after it was submitted and 33 s after the facilitator stopped waiting; a lookup
  at 06:20:43 still got 404, as Blockfrost's transaction index trailed the tip. The facilitator
  had reported the settle as failed, and the client, after five minutes, gave the channel up
  and opened another; the first became an orphan holding 1.832620 tADA, recovered later by a
  cooperative refund (`25355586…`). Now the facilitator answers `settlement_pending` with the
  transaction id whenever confirmation is unknown, polling Blockfrost itself (the SDK's
  `awaitTx` throws when its timeout runs out, which a caller cannot tell from a failed query),
  and the client gives an opening up only when one of its inputs has been spent by another
  transaction, the one case in which it can never land.
- **Collateral.** The SDK takes the largest ADA-only UTxO as collateral against a fixed 5 ADA
  target and stops: with a 5.75 tADA UTxO the return came to 0.752942 tADA, below the 0.969750
  minimum, and the build failed without trying another input (its message blames tokens). Script
  transactions now set the target from the largest ADA-only UTxO.
- **A refund's payout floor.** The provider's share in a `Mutual` is an output of its own, which
  must clear min-UTxO (about 1 ADA); a share of 0.002 tADA cannot. The server claims it first,
  where `Sub` pays it into the provider's change, and the refund then owes nothing.
- **Reading spent outputs.** Through Blockfrost, the SDK's `getUtxosByOutRef` returns an output
  whether or not it has been spent. The facilitator's unspent check and its walk from a channel's
  old position to its current one read Blockfrost's `consumed_by_tx` instead.

## What this does not show yet

- A native-asset channel (USDM), where min-UTxO ADA rides alongside the currency.
  `@x402/cardano` already names a preprod USDM (`e675b46e…​.0014df10745553444d`).
- Top-ups (`Add`), and the manager settling a channel on its own when a consumer closes it
  unilaterally.
- The facilitator holding the provider key for servers that run none (DESIGN.md §8).

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
- A reference script takes about 3 KB and a quarter of the fee off every channel transaction
  (0.087 tADA at preprod's parameters), for one 0.31 tADA deploy and 14.15 tADA held in its
  output. Whoever builds most channel transactions, the provider or a facilitator acting for
  many, should keep one. It needs an address no wallet spends from: the SDK's coin selection
  skips only the reference inputs of the transaction being built.
- A paid request after the first touches no chain: 15 ms median on one machine, two HTTP round
  trips with `@x402/fetch` (the request, its 402, the paid request). Only the first request of a
  channel waits for its deposit to reach a block, 25–36 s on preprod.
- A deposit can confirm minutes after it is submitted. A facilitator that cannot confirm must say
  `settlement_pending` and give the transaction id, never failure, and a client must not give an
  opening up unless one of its inputs went to another transaction.
- A refund pays the provider its unredeemed share in an output of its own, so that share must
  clear min-UTxO; below it, the server claims first.
- Claims batch: one transaction redeems up to about 45 channels (size-bound at preprod's
  parameters), at 0.221768 + 0.034959 × N tADA.

## Reproduce

```
npm install
npm test
WALLET_MNEMONIC="abandon … art" BLOCKFROST_PROJECT_ID=preprod… npm run spike -- all
npm run spike -- negative
npm run lifecycle -- all   # ~20 min; B's close period runs down while A is exercised

npm run refscript -- deploy   # once: the validator into an output at account 2
npm run refscript -- check
SUBBIT_SCRIPT=ref npm run spike -- all
SUBBIT_SCRIPT=ref npm run lifecycle -- all
npm run refscript -- report   # both modes side by side, and the reconciliation

npm run x402 -- all           # step 4: pay 200, claim, corrective, refund, batch, batch-refund, report
```

`npm run lifecycle -- <phase>` runs one phase at a time (`b-open`, `b-close`, `a-open`, `a-sub`,
`a-close`, `a-settle`, `a-end`, `b-elapse`, `report`). State, including the throwaway IOU keys,
is in the gitignored `out/lifecycle.json`. Ref mode keeps its own, in `out/state-ref.json` and
`out/lifecycle-ref.json`; the deployed output is recorded in `out/refscript.json`. Step 4's
phases also run one at a time (`pay [n]`, `claim`, `corrective`, `refund`, `batch`,
`batch-refund`, `report`; `reset` clears its state), with state in `out/x402/`: the client's
and server's channel stores, and `results.json`.
