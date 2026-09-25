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

## Step 5: token channels, with a USDM stand-in

The preprod USDM that `@x402/cardano` names is real (Moneta's tUSDM, 15.1 M in supply), but these
wallets hold none and getting some means an outside faucet. So the consumer minted a stand-in of
the same shape (`spike/mint.ts`): `sUSDM`, asset name `0014df10` + "sUSDM" (CIP-67 label 333), 6
decimals, 1,000,000 of them, under a native policy that needs the consumer's key and closed at
slot 134561842, an hour later, so the supply is fixed. The same transaction gave the provider 10
units of a second name under that policy, `sXTRA`, for a check below.

| Step | Transaction | Result |
|---|---|---|
| mint | `f5f98d482f30ffa76a19b0157e9faeec91087a0a42a052cffaaf807c6f83f295` | policy `085c41bd155d0562653d61a847bc00b0dae291f323ed43b347419c19`; 1,000,000 sUSDM to the consumer, 10 sXTRA to the provider |

`SUBBIT_CURRENCY=token` runs step 2's lifecycle and step 4's x402 run in sUSDM
(`spike/currency.ts`); amounts are in 10⁻⁶ sUSDM, so step 2's figures carry over unchanged.

**What the validator checks on a token channel** (`assets.ak`): on a channel input only the
currency's quantity counts; a continuing output must hold ADA and at most the currency, nothing
else; and only the currency's amount enters any step's arithmetic. The ADA a token channel holds
is kept up by the ledger's min-UTxO alone.

**Step 2's lifecycle in sUSDM**, with the validator read from step 3's reference script:

| Step | Transaction | Result |
|---|---|---|
| A open | `2987c04a180c820487be1d8c1d3ce945c513097eb372a53331d4d6ac06b83973` | 10 sUSDM and 2.133450 tADA, exactly the reserve |
| A sub | `f076726a96e428cf86f1eb6726b31a7a7737235a1d4335825c107e1c6a6355a8` | the provider redeems 1 sUSDM; the channel's ADA stays |
| A close | `f327b77a966ef9f813854c6c9e1938fc4542ac6091ce595c6879a08dc01d0105` | the consumer closes alone |
| A settle | `d89547a7dcc6b8d21c33bfb2d10406c143955c8a791d94a0caf62bddde187610` | the provider takes 3 − 1 = 2 sUSDM, 63 min before `elapse_at` |
| A end | `14607b393fb4b4820bc5263f5504d2b604501eb9aa93dea2cac2559b78f3adb0` | the consumer takes back 7 sUSDM and the 2.133450 tADA |
| B open | `0c94c72c44e2bc812a320e150c6024c79d501efe4954d0ff7193b5df00be8c1f` | 5 sUSDM and 2.133450 tADA |
| B close | `68245d148d7024960dcbe70b84784aae10e5ddccd8c10d08938685249fbfb0f6` | 500 IOUs never redeemed; the consumer closes |
| B elapse | `27e7bdab457ca1c9a3c829e27596002c76de264e8e9a3c11ceec50021557e745` | from `elapse_at`, all 5 sUSDM and the ADA back, no provider signature |

Every party's net change was read back in both sUSDM and ADA. The build-only checks came out as
in step 2 (all 17 refusals refused, the late settle accepted), and two more ran for tokens:

| Channel | Transaction | Validator |
|---|---|---|
| open | the continuing output also carries 1 sXTRA | refused |
| | the provider's sub also takes the channel's ADA down to that output's exact min-UTxO, 2.133450 → 2.042940 tADA | **accepted** (built, not submitted) |

The 8 transactions cost 2.006198 tADA in fees, against 1.869612 for their ADA twins in step 3:
the token makes each channel output larger.

**x402 in sUSDM.** Step 4's run again, the route priced at 1,000 units, 0.001 sUSDM:

| Phase | Transaction | Result |
|---|---|---|
| request 1 | `47f7170704019e9b74a5081326e9c36658c213a8e4cc2919a921253e938967c7` | the deposit opens a channel with 3 sUSDM and 2.133450 tADA; answered after 42.9 s |
| requests 2–200 | none | median 6.3 ms, p90 8.3 ms, max 37.0 ms; 2 HTTP calls each |
| claim | `4abaa2ec2912534ff56f449c3a46eb0d6a9205814e675e2f97a9e69ff2e7debf` | redeems 0.200000 sUSDM; fee 0.264632 tADA |
| corrective 402 | none | one request behind, then one ahead: 3 HTTP calls each, back in step |
| refund | `142ad42e713510823f30995e561a02345456cbdcabde6f982a36a8c52a215ebc`, `7070e997b1136c68031b3f34a25567273a0511aadb1d431a22b4991762dab30b` | a claim of the last 0.002 sUSDM, then `Mutual`: 2.798 sUSDM and the reserve back |

| Channels | Transaction | Bytes | Memory | Steps | Fee (tADA) | Per channel |
|---:|---|---:|---:|---:|---:|---:|
| 1 | `82ee0cb069144e8b6727d9345c8b3b3bb4831bf2ae3fb1ba60f57ab2d8d4c3e3` | 1,003 | 211,749 | 134,346,282 | 0.267227 | 0.267227 |
| 5 | `4132c0e4b1fb2652dc6d7ddf6d0505ddee58589789e12b318ff46184e390035d` | 2,759 | 1,039,560 | 682,807,406 | 0.431805 | 0.086361 |
| 5 | `1bd2a7c4be389b1eefdbd33e151466d703fc2eb46068d85e25d7c101b08122b5` | 2,759 | 1,039,560 | 682,807,406 | 0.431805 | 0.086361 |
| 9 | `ced326604ee4ebdb7d13f0cda2837e92edc6377656c724f205095e94e70caa20` | 4,515 | 1,820,728 | 1,205,026,270 | 0.591801 | 0.065756 |
| 10 | `44ce4a0f94cd3152e717ea467d54841a55ba23701c9a1112a3d16aec4630e814` | 4,954 | 2,021,838 | 1,338,875,191 | 0.632372 | 0.063237 |

A token channel adds 439 bytes to a claim, against 350 for ADA, and about 0.0406 tADA
(0.2267 + 0.0406 × N from the single and the ten-channel claims), so size binds at about 36
channels per transaction (extrapolated). Fees are paid in ADA and charges come in the token: at
ADA = $0.238 (2026-09-24) and 0.001 sUSDM a request, a claim over one channel pays for itself
after 64 requests, over ten after 16 per channel.

The ten batch channels were refunded with `Mutual` (`29cc8b4e…`, `44d05ef0…`, `ce9ea2f7…`,
`32acc779…`, `b0cbb39b…`, `d5057704…`, `bbb3b07e…`, `24d75395…`, `97399749…`, `bfcb0b5a…`; 645
bytes and 0.234657 tADA each), 0.095 sUSDM and the reserve back from each. **Reconciliation, in
both currencies:** sUSDM: consumer 999,997.000000 → 999,996.748000, provider 3.000000 → 3.252000,
nothing left in channels, so none created or lost. ADA: consumer 80.206828 → 75.474342, provider
22.152256 → 19.088929; the two lost 7.795813 tADA, exactly the 7.616672 of fees of the run's 29
transactions plus the 0.179141 of a UTxO tidy the provider made midway (`3c5df065…`, below).

What the run changed in the code:

- **The reserve includes the token.** The first token opening was refused by the ledger: the ADA
  put in, 1,909,330 lovelace, had been sized for an output without the token, which needs
  2,025,700. `channelReserve` now sizes the output with the currency at its widest quantity.
- **ADA-only UTxOs for collateral.** The SDK takes collateral only from at most three inputs,
  ADA-only first. Channel openings seeded from the largest ADA-only UTxO had folded the consumer's
  ADA into one token-laden UTxO, and claims did the same to the provider, whose change then held
  the redeemed tokens. Now a token channel seeds from a UTxO holding the token, and a claim pays
  the redeemed tokens to `payTo` in an output of their own, so its change stays ADA-only. Before
  that, `npm run mint -- tidy` gave each wallet three ADA-only UTxOs (`888cbe9c…` for the
  consumer, `3c5df065…` for the provider).
- **The manager holds back what it just spent.** A claim built seconds after another selected the
  provider input the first had spent: Blockfrost's address index still listed it, and the
  evaluator refused the transaction (`CannotCreateEvaluationContext`, an input missing from the
  UTxO set). The manager now keeps its claims' inputs out of coin selection, as the client does.
- **Retries on Blockfrost queries.** Builds failed twice fetching protocol parameters (the
  endpoint answered 200 a minute later; 3,896 calls that day, far below the quota). Builds now
  retry failed provider queries, and only those: a script failure is never retried.
- The SDK's asset unit is policy and name run together; its doc comment and x402 write them with
  a dot.

## Step 6: top-ups, and the server settling on its own

Two things steps 4–5 left out: a client adding funds to the channel it already has, and a server
noticing by itself that a consumer has closed a channel, and settling it before `elapse_at`. Both
ran on preprod in ADA and in sUSDM, with state in `out/x402-step6/` and `out/x402-step6-token/`.

**Top-ups.** A channel opened with room for 10 requests at 1,000 units each. When the next
voucher would pass that, the client reads the channel and builds `Main([Add])` on its current
position: the same address and datum, and 10 more requests' worth of the currency. It sends that
as a `deposit` whose voucher names the channel's position (`channelRef`) and pays for the
request. The facilitator checks and broadcasts it as it does an opening, and the channel keeps
its id. The server claims in between, so a top-up also lands on a channel that has had a
redemption.

| Currency | Step | Transaction | Result |
|---|---|---|---|
| tADA | request 1 | `ba849f6cb6f10022d4df25d5538448ecb3368fc80963d4c999f101aa409d4967` | opens; room for 10 requests |
| | request 11 | `e81a80261595fcdb003943cc9124c76fcd2007b0973fa13fe3cfd66f937f617e` | top-up: room for 20, same channel id; answered in 24.4 s, 2 HTTP calls |
| | claim | `e3852b8b5e25f96b59da7756455cfa0a27f7d2fcf9b2b0feb9f459ebc290679f` | redeems 0.015 tADA; the refund after it was refused (the capacity fix below) |
| | request 21 | `217ce7623ab85f8ddeccbbd46ac7fff328626ee0dee7d290a0a280eb28039943` | top-up after the claim: room for 30; answered in 115.3 s (a slow block) |
| | claim | `9194406a0378cae73f6c4660dda40b45f571d6c3ac51e2d03641a686779ab268` | redeems 0.015 tADA |
| | refund | `a7246f6c47d88661db1ed8b2c5a71dac12d952e41da42fb613b2952d994499ff` | `Mutual`: 1.500075 tADA back |
| sUSDM | request 1 | `b876ce673bef27e4ab3ab8db921fda3006c824c41338385a88bc50c93297a903` | opens; room for 10 requests, 2.133450 tADA reserve |
| | claim | `2c077ce28f90a5ea560973644ff406b9af070daa3117832de9cf33aa0cf3c8c4` | after request 5: redeems 0.005 sUSDM |
| | request 11 | `ae008a1c813d2ee6a6016a8829c3abe2f98e0ca5444dc676a2b7c3af36b10351` | top-up after the claim: room for 20; 30.4 s |
| | claim | `62b8054efa2b2e5001f2b339a23c1aedcf6fba6280c402914133895a5dea2809` | redeems 0.010 sUSDM |
| | refund | `648a92f56857705094cf0a5f5e2fc4ae6b9b2a398944252fdc4a087577cfb848` | 0.005 sUSDM and the reserve back |
| | again | `c0c69b45…`, `bf085483…`, `97c052b8…`, `6bb0c55f…`, `773d4604…` | the same run with the fixes below: top-up in 34.9 s |

Before each channel's first top-up went out, a second client on the same records built it
without sending it, and the facilitator was asked about it (verify only). In all four rounds:

| Top-up | Outcome |
|---|---|
| as the client built it | accepted |
| the deposit declares one unit more than the transaction adds | refused by the facilitator, `deposit_transaction` |
| the voucher one unit past the capacity the top-up makes (0.020001 / 0.030001) | refused by the facilitator, `cumulative_exceeds_balance` |
| the datum records `subbed` one unit higher | refused by the validator (the build's evaluation) |

The facilitator compares the whole datum as Plutus data either way; for this change the
validator refused too.

**The server settling on its own.** `ChannelManager.watch()` reads each channel the server holds
vouchers for every 15 s here (30 s by default). When a consumer has closed one, the server stops
accepting its vouchers (`withdrawRequestedAt`), and its next claim settles the channel with the
latest voucher: `Settle` in place of `Sub`, in the same batched transaction format, leaving the
channel `Settled` for its consumer to end. The consumer's close has a TTL 300 slots ahead and the
earliest `elapse_at` the validator allows with it: the TTL slot's start + the 900 s close period.

| Currency | Step | Transaction | Result |
|---|---|---|---|
| tADA | request 1 | `b5e0cd6598b47287c9963b494952b036ca1e2e47cc63c469bd7a966ee031cafe` | opens; 12 requests paid, nothing claimed |
| | close | `905bebb6c43bc95d42f09408008826ccf57730601eb27139f553b4bda45cdec8` | the consumer alone, `Main([Close])`; `elapse_at` 11:54:04Z |
| | settle | `d7ef18c8b8447c0a7df1e8a8ca193ce489cbea9de34ca61fbd28773a85a513eb` | the watcher saw the close 12 s after the client had it confirmed; takes 0.012 tADA; its block 62 s after the close's, 18.8 min before `elapse_at` |
| | end | `c756a7f69814ad7295e502f5f15b50dbebd07043502bc58bac6ba9c1b1fb9d32` | the consumer, `Main([End])`: 1.740620 tADA back |
| sUSDM | request 1 | `f82b9ac6d4beb9881afa65ec0cd3debc6e9b2112105de80ecc71051f9ced5c18` | opens; 12 requests paid |
| | close | `71ea2837d8c6ce13637d45ff26a13e0ad0d0f7a8389d08bd62185396087e6853` | `elapse_at` 12:04:50Z |
| | settle | `ed0c8468849254a4afa70ea90c24a962291e892a55782cbe134a7a81c8f69e4c` | seen after 8 s; takes 0.012 sUSDM; 30 s after the close, 18.3 min before `elapse_at` |
| | end | `546dd1105edcf3434da9889b0c89b1a7fa9137b19df4882483284454a612ff6a` | 0.008 sUSDM and 2.133450 tADA back |

Fees, in tADA, each read back from Blockfrost:

| Transaction | tADA channel | sUSDM channel |
|---|---:|---:|
| open | 0.175005 (445 B) | 0.180945 (580 B) |
| top-up | 0.272915 (1,294 B)¹ | 0.258089 (905 B) |
| claim, one channel | 0.256727 (803 B) | 0.267137 (1,001 B) |
| settle, one channel | 0.256809 (799 B) | 0.267219 (997 B) |
| refund (`Mutual`) | 0.232545 (597 B) | 0.234569 (643 B) |
| close | 0.250013 (747 B) | 0.255535 (834 B) |
| end | 0.230954 (475 B) | 0.233253 (521 B) |

¹ Carrying 14 unrelated tokens from a wallet UTxO into its change, about 480 B; fixed below, as
the sUSDM run's second top-up shows (the first was 1,383 B).

A settle costs what a claim does. The unilateral exit (close, settle, end) comes to 0.737776
tADA against 0.489272 for claim and refund; the consumer pays the close and the end.

**Reconciliation.** tADA run: consumer 75.474342 → 73.822899, provider 19.088929 → 18.360663; the
two lost 2.379709 tADA, exactly the fees of its 10 transactions. sUSDM run: the wallets lost
3.805853 tADA, exactly the fees of its 16 transactions (two of them wallet tidies, below); sUSDM
consumer 999,996.748 → 999,996.706, provider 3.252 → 3.294, nothing left in channels, so none
created or lost.

What the run changed in the code:

- **Capacity is cumulative.** The tADA run's first refund was refused: "voucher 15000 exceeds
  capacity 5000". Capacity was computed from what the channel held, but IOUs are cumulative:
  after 15,000 had been redeemed the channel held 5,000 more, so the limit was 20,000. Steps 4
  and 5 never came near theirs (3 tADA or 3 sUSDM against at most 0.2 charged), so it did not
  show. Capacity is now `subbed` plus what the channel can still pay out, for the facilitator,
  the client and the top-up check alike, with a chain-free test; the rerun's top-up after the
  claim, and both sUSDM top-ups, depend on it.
- **A voucher above the server's recorded balance goes to the facilitator**, which reads the
  channel, at most once per 30 s per channel. A top-up that confirms after its request gave up
  (preprod took 115 s for one here) or an `Add` made outside x402 would otherwise be refused
  until the server's view of the channel went stale, up to 5 minutes.
- **Openings and top-ups spend only UTxOs holding ADA and the channel's currency.** The public
  test wallet holds tokens strangers sent it, and coin selection had carried 14 of them into
  each tADA top-up's change.
- **A claim folds the provider's earlier token outputs into its own.** Each token claim paid the
  redeemed tokens to `payTo` in an output of their own, which holds a min-UTxO of ADA (about 1.17
  tADA). After step 5 and part of this run, the provider's largest ADA-only UTxO was 1.965 tADA,
  under what collateral needs, and a claim could not be built, which also means a settle could
  not. `npm run mint -- tidy provider` (`7ef33300…`) got the run going again; since then a claim
  also spends up to 5 earlier token-only outputs and pays one (`bf085483…`: 2 folded, +72 B,
  +0.004 tADA).
- **The consumer fragmented the same way** and needed `npm run mint -- tidy consumer`
  (`4e89d98d…`) before the rerun's refund: every token channel's refund or end returned the tokens
  with the reserve as a UTxO of their own, and a token top-up's change folded ADA-only UTxOs into
  tokens. Step 7 gives the client the provider's treatment.

## Step 7: the client folds its token UTxOs

The client now builds its token transactions the way the manager builds claims. An opening or a
top-up takes the tokens it needs from the wallet's UTxOs that hold ADA and the currency only,
largest first, folds more of them in up to five in all, and pays what is left to the wallet in
one output of its own; ADA and the fee come from ADA-only UTxOs, so the change stays ADA-only.
An end folds up to five older token outputs into the one that takes the channel's tokens back
(`planTokens` in `src/x402/cardano.ts`, with a chain-free test). The refund is left as it was:
the server co-signs it, and the facilitator lets it spend the channel and nothing else, so it
still returns one UTxO of tokens and reserve, which the consumer's next opening, top-up or end
folds in.

One more sUSDM run on preprod, from the wallets as step 6 left them (`out/x402-step7-token/`):

| Step | Transaction | Inputs | Result |
|---|---|---|---|
| open | `36f88a1ea934b973f18b196ae488e5b8f10f712ff36f348010efb65527dc207d` | 5 sUSDM UTxOs | their ADA covered the reserve and the fee; no ADA-only UTxO spent; 789 B, 0.190141 tADA |
| claim | `c2e89e949ea792d0ed9ac989a22d521979f4f85c82ff2bb2e74d352ecc1ec869` | channel, the provider's last token output, 1 ADA-only | 0.005 sUSDM |
| top-up | `832b1f9924c4582df336f510648ea4851e333797c2edb1ecbc51d00b53cced3b` | channel, 5 sUSDM UTxOs | 1,078 B, 0.267995 tADA; answered in 25.4 s |
| claim | `b9bf06fffb513605a3667745f3f7e4242e764ff54af628d094605a1fb8e270bc` | as above | 0.010 sUSDM |
| refund | `2cdb331f9cd08a2c1907689f0955a0d29c76687460aa49f2337030653c07bd15` | the channel alone | 0.005 sUSDM and the reserve back, in one UTxO |
| open | `c6178dc2dc7dabd79a4fbf0571baba69cd663abdbd9c6e4cc98d6d737e8c3ef4` | 2 sUSDM UTxOs, 1 ADA-only | 717 B, 0.186973 tADA |
| close | `fd0c8c68af3253dd93fab0956975617d620a36d9aa833f2feccae7cfb39c64af` | channel | the consumer alone |
| settle | `764ac1a9392f8dba5bada7107940065fc753cae40c9cbf4a4ee7cce82c86dcd6` | channel, the provider's token output, 1 ADA-only | by the watcher, 49 s after the close, 18.9 min before `elapse_at` |
| end | `cfb16cc3f7db87b72b099b4db38df189d3cf7907264b06822751d9a25a47680b` | channel, 1 sUSDM UTxO | 0.008 sUSDM and 2.133450 tADA back; 624 B, 0.238378 tADA |

Every opening, top-up and end paid its tokens to the wallet in one output and its change in
ADA alone. The wallets, before and after:

| | ADA-only UTxOs | largest | holding sUSDM | holding other tokens |
|---|---:|---:|---:|---:|
| consumer, before | 8 | 15.000000 | 9 | 1 |
| consumer, after | 11 | 15.000000 | 1 | 1 |
| provider, before | 4 | 5.627207 | 1 | 1 |
| provider, after | 4 | 4.819184 | 1 | 1 |

The folds moved the ADA that sat beside the tokens back into ADA-only UTxOs. They cost about
0.01 tADA a transaction at five folded (an opening 0.190141 against 0.180945 in step 6, a top-up
0.267995 against 0.258089), 0.005 at one (the end, 0.238378 against 0.233253). The provider's
largest ADA-only UTxO shrinks by the claims' fees, which it earns back only in sUSDM.

**Reconciliation.** ADA: consumer 71.553225 → 70.179634, provider 16.824484 → 16.016461; the
two lost 2.181614 tADA, exactly the fees of the 9 transactions. sUSDM: consumer 999,996.706 →
999,996.679, provider 3.294 → 3.321, nothing left in channels, so none created or lost.

## Step 8: finding the channels again after losing the records

A client's records hold three things about each channel that the chain does not: which server it
pays, the count, and the IOU key. The first comes back with the server's next 402 and the second
with a corrective 402, but a random IOU key, kept only in the records, was gone for good: such a
client could still leave its channels, never pay from them again. So the key now derives from the
wallet (spec, *IOUs*): the wallet signs one fixed message once with its payment key (CIP-8), and
each channel's key comes from that signature, the network and the channel's tag, by HKDF-SHA256.
`recover()` lists the validator's address, keeps the channels whose datum names this wallet as
consumer, follows each to where it stands, and derives its key again. Where the key matches the
datum's, the channel is usable: the next 402 on its terms supplies the one config field the chain
lacks, the server's address, and binds it. Any other channel can only be left, which `close`,
`end` and now `elapse` do without the server. In tADA, state in `out/x402-step8/`:

| Channel | Step | Transaction | Result |
|---|---|---|---|
| A, derived key | request 1 | `8418c08505da59a96c20b10e45630b5b3dbc8df5c8e4d2dd0bab233d614c97ec` | opens with room for 20 requests |
| | claim | `d71598b6c5b007081c78473e304a575315653277d574c30f402d1313b1d3c72c` | after request 8, 0.008 tADA; 4 more requests, the server counts 12,000 |
| | — | — | the client's records deleted; `recover` finds the channel and derives its key again: count 8,000 from the chain, room for 20 |
| | request 13 | none | binds the channel. Its voucher for 9,000 meets a corrective 402 carrying the server's voucher for 12,000, which verifies under the recovered key; the retry for 13,000 is served. 3 HTTP calls; both sides count 13,000 |
| | claim | `35102a76d60ac4fca80071f3d3f87fb0ca370a3015e5881a724c51386416d90e` | after 2 more requests, 0.007 tADA |
| | refund | `86c1821c08a10d0639a92b9f00696b11648b9f8c05fd864e55b2f66fdb0533fe` | `Mutual`, 1.505075 tADA back |
| B, random key | request 1 | `cb2ed4ad37413248497a16df4bad1d76fc3a71eb035d1b392d88c566dc562d9d` | 6 requests paid |
| | — | — | the client's records deleted; `recover` finds the channel, but its key does not derive from the wallet: exit-only |
| | close | `802d927b916a10dca301fd80287e60199fd9ca136bb920d85d5801cbc924b870` | the consumer alone |
| | settle | `e520f229d8f24fb40773855bf84337228576780c42654df399ecc6b316156532` | the server's watcher, 0.006 tADA |
| | end | `a417c4a0b998658d85fd0566e95abbd636c3e5a3b2eeff6bfb68bb7ae93f802a` | the rest back |
| C, both sides lose their records | request 1 | `e2f743018262bbf3bcc35d5cc3f491c76be74fbcf5b5d825039c4e735138c13d` | 3 requests paid |
| | — | — | the server's record deleted, then the client's; `recover` finds the channel |
| | close | `ee9e7a988d09be5a6ad8555f6a4be3457677e4aa1f5d481a74de4ff06fbb0434` | `elapse_at` 14:16:45Z |
| | elapse | `26e04c8e7150cad07b7764e58b1502b9fbfe0fc28d7d07dc115e8e4a8ea0fe07` | in a block 27 s after `elapse_at`, no server signature: all 1.752620 tADA back, the 3 requests never redeemed |

The corrective 402 does the whole resync: the client adopts the server's count only because the
server shows a voucher of this very key for that much, the rule it already applied (step 4). A
server that loses its records loses the charges it had not redeemed (C's 3 requests); with the
client still around, the client's next voucher, being cumulative, rebuilds the server's record and
count from there on (a chain-free test runs that through the server's hooks; not run on chain).

The exits of B and C cost more than step 6's: close 0.336818 tADA (3,760 B), end 0.317761
(3,488 B), elapse 0.318615 (3,494 B), against 0.250013 and 0.230954 there. A recovered channel
not yet bound to a server does not know the server's reference script, which only a 402 names,
so its transactions carry the validator inline, 0.087 tADA more each. The rest cost what they did
before: open 0.175005, claim 0.256727–0.256807, refund 0.232545.

**Reconciliation.** Consumer 70.179634 → 68.091062, provider 16.016461 → 15.267197 tADA; the two
lost 2.837836 tADA, exactly the fees of the 11 transactions.

## Step 9: answering a retry, and a server that holds no key

**A retry of the latest voucher.** When a paid request's response is lost on the way back, the
server has served and charged it and the client has not seen that, so the client's next request
carries the same voucher. The server now keeps, for each channel, its latest paid request: the
voucher and the response. A request with that very voucher gets the kept response, without the
handler running or a second charge (SVM's rule). An earlier voucher is still stale and gets the
corrective 402: a client resyncing after losing its records sends earlier amounts, and must get
the server's count, not old answers. In tADA, `out/x402-step9/`:

| Step | Transaction | Result |
|---|---|---|
| request 1 | `de2d61d909d8c9e73f3f02bf3d198c659a0d9c0569eb5b17db3b1dbe9f6d24b1` | opens; 3 requests |
| request 4 | none | sent by hand and its response thrown away: the server served `{"n":4,…}` and counts 4,000, the client 3,000 |
| retry | none | the same voucher, 2 HTTP calls: the same body back, byte for byte; the server still counts 4,000, the client catches up to 4,000 |
| request 5 | none | charged as usual, 5,000 |
| claim | `1a1fd9f1b1b93294f84add662be25675bacce4404a30ec0144ab2635cc596e07` | 0.005 tADA |
| refund | `e3684faf856de84c9622d1d7e71b0c61d7575f53cc34628d9e38e9af0f8a3879` | 1.515075 tADA back |

Reconciliation, from the chain, since the next run changed the wallets before this one's report:
consumer 68.091062 → 67.678512, provider 15.267197 → 15.015467 tADA, 0.664280 lost, exactly the
three transactions' fees. The closing balances are the next run's opening ones, the consumer's
plus the 30 tADA it then sent and that transaction's fee (0.171309, `1625a5d5…`).

**A server that holds no key.** A second resource server (127.0.0.1:7412, 0.1 tADA a request)
runs with no key at all. The facilitator holds its provider key, account 3 of the test mnemonic,
registered with the server's `payTo` and a secret the two share; the server's channels name that
key as `provider`. The facilitator builds, signs and pays the fees of the server's claims, paying
everything redeemed to `payTo` in one output, and co-signs its refunds, each only on the server's
authentication (`delegationMac`); after each claim the server checks on chain that `payTo` got
what was redeemed. Subbit does not restrict where a redemption pays, so the server trusts the
facilitator with its revenue. Account 3 got 30 tADA first (`1625a5d5…`); state in
`out/x402-step9-delegate/`:

| Channel | Step | Transaction | Result |
|---|---|---|---|
| A | request 1 | `c7ca1138fb1770b8fff28e3be6f4ef31da28aecdd07e78a1b8d37e5de3d1144e` | opens on the keyless server; its `provider` is account 3's key |
| | claim | `c844a2acd3c1fd5164200d0ecca96541252c16afef1ff05385644ad3c3223e5f` | after 10 requests, built and signed by the facilitator: 1.0 tADA to `payTo`, fee 0.259764 from account 3 |
| | claim | `f08a4e02763b49b354face04b281d848b6ebb6d0a06c19179f0bb5165bd97e60` | 5 more requests, 0.5 tADA: paid out as 0.969750, the min-UTxO, 0.469750 of it from account 3 |
| | refund | `f9a3b33deac02a083ed5e7e94440ea325fbd1cd3395e005aaf4ba6b7bffca127` | `Mutual`, co-signed by the facilitator: 2.000075 tADA back |
| B | request 1 | `cae44b2d7f8502613a9c8c06938a935082cdbc042d0417cb99dcba9b9e3fd340` | 12 requests |
| | close | `77915cfb1cb003003dea02927ae59440eaf4221c9a9474e6ef8d90d00ff15627` | the consumer alone |
| | settle | `ab35b98e828cf7777f2d141b4fcd67a85c02ec93084af2d65a3788d5d4cf2463` | the server's watcher asked, the facilitator settled: 1.2 tADA to `payTo` |
| | end | `dfe559d4503e21a13d10c7edbc9bcbfb59f2cebaf80e0ad0773680dc23ed6339` | the rest back |

A delegated claim is 872 B and 0.259764 tADA against 803 B and 0.256727 for the server's own: the
payout is an output of its own, which is also why min-UTxO binds. Account 3 went 30.000000 →
28.750961 tADA: 0.779289 in fees for three claims and 0.469750 topping up the 0.5 tADA payout.
`payTo` got 3.169750, the 2.7 redeemed plus that top-up.

**Reconciliation.** Consumer 37.507203 → 33.743683, `payTo` 15.015467 → 18.185217, account 3
30.000000 → 28.750961 tADA: the three lost 1.842809 tADA, exactly the fees of the 8 transactions.
The run first recorded account 3 at 0: it took its balances right after the funding, before the
address index listed it. Account 3's first transaction is that funding, which paid it exactly 30
tADA, so its opening balance is that; the funding step now waits for the index.

## Step 10: Moneta's real tUSDM

Steps 5–7 ran in sUSDM, a stand-in minted for the purpose. This one runs in Moneta's preprod
tUSDM, the asset `@x402/cardano` names (`e675b46e4d2242c991a8932a99db3044e80515ae14b4c4ccf6b3f4c9.0014df10745553444d`,
6 decimals). Its claim page (tusdm.moneta.global) sent the consumer 1,000 tUSDM and 5 tADA in
`628eca2962e60d5666e84718d708a1789b73b673a39175af2f4af43bc73ef4be` a few minutes after the address
was submitted. `SUBBIT_CURRENCY=tusdm` runs step 6's two phases in it, with step 7's folding;
state in `out/x402-step10-tusdm/`:

| Phase | Step | Transaction | Result |
|---|---|---|---|
| top-up | request 1 | `46335d0ac7ed15f43edfb226d6bc1788da389a942d1d4155e72d2de57fb720ed` | opens with room for 10 requests and the 2.133450 tADA reserve, from the faucet's UTxO |
| | claim | `30edbe18b3cec0973b3462612ad0be67fa03bc8e160fb3f680f75fc43c04b6d1` | after request 5, 0.005 tUSDM |
| | request 11 | `8914fba9b2dd1196d90b95a64d8592e499497f40451e34f358f684692e652b1c` | top-up after the claim, room for 20; 108.2 s (a slow block). The four build-only checks came out as before |
| | claim | `e61b93e1e57ec7ae5d560d5734b5deb9f3cb65ca5e5f5165fe1678ce46179226` | 0.010 tUSDM, the provider's first tUSDM output folded in |
| | refund | `0fe5048967c996db22f98108f620ee887b9c48a52a93a8e3b6053d9fc24206b8` | 0.005 tUSDM and the reserve back |
| automatic settle | request 1 | `99667614943332e9637d400bae7f09930806c8f8b0def4c4ca4b2373da96c599` | 12 requests |
| | close | `b09f876ccee525fd5fb02a6b572ec710e42a18efdabf8850295e1fa513b01bb8` | the consumer alone |
| | settle | `4e95e4283b8f1e588f08f11f9c00e0746c4940e6467d833e5f8c7359c1623b35` | the watcher, 58 s after the close, 18.9 min before `elapse_at`: 0.012 tUSDM |
| | end | `7ef6d2058e9a36abe3d48705e265c684179f91535a5455c67f5891722272b635` | 0.008 tUSDM and 2.133450 tADA back |

Nothing in the code changed for it: only the asset id differs from the stand-in, as step 5
expected. Fees and sizes match sUSDM's (a claim 1,001–1,037 B and 0.267–0.269 tADA, a top-up 970
B and 0.261476), and the wallets kept their shape: the consumer's tUSDM sat in one UTxO before and
after, the provider's in one after.

**Reconciliation.** ADA: consumer 38.743683 → 37.382944, provider 18.185217 → 17.379374 tADA,
account 3 untouched; the wallets lost 2.166582 tADA, exactly the fees of the 9 transactions. tUSDM:
consumer 1,000 → 999.973, provider 0 → 0.027, nothing left in channels, so none created or lost.

## Step 11: the watcher at scale, and the token paths not yet run

**Following the chain instead of polling it.** The watcher read every channel the server holds
on every pass, two requests each. It can now follow the validator's address instead
(`watch({ mode: "follow" })`): it reads every channel once, notes the address's latest
transaction, and from then on asks only for the address's new transactions, one request, reading
a transaction's outputs only when it spends a channel of this server. A spend with no continuing
output is an exit, read from the spending transaction itself, so no second look is needed. Ten
channels with three charged requests each, tADA, `out/x402-step11-scale/`, Blockfrost requests
counted at `fetch` (the SDK's included):

| Pass | Requests | Time |
|---|---:|---:|
| polling, 10 channels | 20 | 4.7 s |
| following, the first pass (reads every channel once) | 20 | 4.9 s |
| following, nothing new | 1 | 0.2 s |
| following, the pass that saw a close among the 10 | 3 to find it; 33 with the settle | |

Polling grows with the channels, two requests each per pass: at a 15 s interval a thousand
channels would be over 130 requests a second, far above what a Blockfrost project allows.
Following costs one request a pass plus two per transaction that concerns the server.

| Step | Transaction | Result |
|---|---|---|
| requests 1 | `db104fef…`, `581ca509…`, `cd2ab0df…`, `e436826d…`, `f7ff8a11…`, `525c7f01…`, `a6a521d7…`, `a2a8b0f0…`, `9e422518…`, `edc0211a…` | ten channels, three requests each |
| close | `cfe2d9538cfa57d4ab254dcfc28b4cf14689f3332cc10be20fbf1535411fb77c` | channel 1's consumer alone |
| settle | `a7b1170e9bcc4e76e3095b6757e4d76ace6dd297631024657c8d26a582430a72` | the follower, on the pass that saw the close |
| end | `75d6b6a0d029a4eb3741ee5e9100d45cbf0041d2fe131a709a839a514731d484` | channel 1's consumer |
| claim | `49ce6b1d13c77aef4235cad937d0a0c7fe54a6c1bb279e7e3da3a8a4ca807f2d` | the other nine in one transaction: 3,639 B, 0.542567 tADA |
| refunds | nine `Mutual`s, `dd5a3674…` the last | 1.513907 tADA back from each |

The first attempt stopped at the close: the consumer's largest ADA-only UTxO was 1.877 tADA, and
the collateral rule wanted one of at least 2.2. The ten openings had locked 17.5 tADA, and 23.9 tADA
sits in a UTxO that also holds strangers' tokens, which the client never spends. The SDK itself
takes up to three ADA-only UTxOs, largest first, until they reach the target, and fails when the
return is under min-UTxO; the rule now picks the largest target that works for the inputs the SDK
will take (at least 1 tADA, at most 5), so three UTxOs of 1.8 tADA do. The rerun took up the ten
open channels. **Reconciliation:** consumer 35.426394 → 31.021784, provider 20.909264 → 20.138304
tADA; the wallets lost 5.175570 tADA, exactly the fees of the 23 transactions.

**`elapse` on a token channel.** Step 8's channel C again, in tUSDM, `out/x402-step11-elapse-tusdm/`:
opened (`e115d5addd6352416e7377e171b72a68268c2f0c7a718c8cdfea5c7edc4ea14e`), 3 requests, the
server's record and the client's deleted, the channel recovered, closed alone
(`7c76954733dc0dfc5be3604708989fdc3dad1dec6da3196d0171c5d75e8760e4`), and elapsed
(`abfb361f9ffe04c5e6fcb703f1c48eef3305d637ed9cb5daac1d86840805f067`) in a block 145 s after
`elapse_at`: all 0.020 tUSDM and the 2.133450 tADA reserve back, the tokens into the consumer's one
tUSDM output. Not yet bound to a server, the channel's exits carried the validator inline (close
3,847 B, 0.342342 tADA; elapse 3,643 B, 0.326039). Reconciled: 0.853770 tADA lost, the three
fees; no tUSDM created or lost.

**Delegation on a token channel.** Step 9's keyless server, priced at 0.1 tUSDM,
`out/x402-step11-delegate-tusdm/`: A opened (`3ff537afbf1426fe91bf99990fa62aeda8e616ed3549933ae54a2bf60a1068cb`),
claimed by the facilitator (`e267d258acf3f655ded77bccc7dae6e389537eded546e18f5aefeb1d435c0e24`,
1.0 tUSDM; `4da2d59bba71890c083be447a01da9f412ac7330d21d41db4e20bc2a40961827`, 0.5), refunded
with its co-signature (`7e7aadd0a129c9d531029fcc62e098a570b7307ef507fbdffa3df3835e0578d5`); B
opened (`575ffd57ac62e40f2e64e5ace1b005b846990832b347580c1cc7de6013fbf6c4`), closed by its consumer
(`5a42e7554a125890a902e3ac5a642e2e0827b74052b7b3450613ab275b8915dd`), settled by the facilitator
on the watcher's request (`cbdf48e67e6cd0c29048c458d14b07ad6f69c633c96f6a97549a6710c283977d`, 1.2
tUSDM), ended (`e732fec10c0b97f9e805d308b1edc44bfb24610cf1b553b12494116023306fb5`). Every payout
is tUSDM in an output of its own, which needs 1.176630 tADA: account 3 put up 3.529890 tADA for the
three, besides 0.802466 in fees, and all of it stayed with `payTo`. Reconciled: the three wallets
lost 1.905246 tADA, the 8 fees; tUSDM consumer 999.973 → 997.273, provider 0.027 → 2.727.

## Step 12: a watcher that survives rollbacks

Step 11 listed rollbacks as open and called the cost of one a failed settle, retried. That was
too kind. The server's records moved with every transaction it saw, and a transaction can be
rolled back: after a claim, a record pointed at the claim's output, and had the claim been rolled
back the watcher would not have found the channel from there twice running and dropped the record,
and with it the only copy of the latest voucher. A close rolled back would have left the server
refusing the channel's vouchers for good.

Now each record also keeps an anchor, a position of the channel at least 3 blocks deep, and every
read starts there and follows the channel forward, so a transaction the chain has dropped is simply
not found again:

- A claim rolled back: the channel is found where the chain has it, what is redeemed is taken from
  there, and the charges are claimable again.
- A close rolled back: the channel is found open again; the watcher reports it and takes its
  vouchers again.
- A record goes only once the transaction that ended the channel, its settle or its consumer's
  end, is 3 blocks deep; the manager no longer drops a record the moment its settle confirms.
- Following, the watcher acts on a transaction only once it is 3 blocks deep.

A rollback cannot be ordered up on preprod, so the rollbacks themselves are shown by chain-free
tests (a claim and a close rolled back, a settle and an end kept until deep, a shallow transaction
left for a later pass), and preprod shows the depth rule doing no harm in step 6's automatic
settle, run once each way, `out/x402-step12/`:

| Watcher | Close | Settle | Result |
|---|---|---|---|
| polling | `bd2f95e079d481dcac28137b40d90f7be96383f5052addd194f3cc3b66a53f51` | `5d2f15cfc922d2bb33e4064801ec0a2f9c7fdeb594cd42da345902fdfce665e1` | close seen 6 s after the client had it; settle in a block 56 s after the close's, 18.1 min before `elapse_at`; the record dropped 35 s after the settle, once deep |
| following | `940f1d42674b199fea88d86181892380ceff1d002c4a26ef901a7e6f45f31d68` | `d5a03af65401abf1b3f1362d9a9255657eb9fbb232df5a219dbfc2deef7d125c` | close acted on once 3 blocks deep, 2 min 36 s after the client had it; settle 170 s after the close, 16.6 min before `elapse_at`; the record dropped 37 s after the settle |

Following trades about two minutes of the close period for never acting on a transaction that may
yet disappear; the shortest close period the binding allows, 900 s after a close that may take 300
s to land, leaves room for it. The channels were opened by `25821f95…` and `b169cb38…` and ended by
the consumer (`e6855813…`, `07e9edef…`). **Reconciliation:** consumer 31.021784 → 29.670002,
provider 20.138304 → 19.645522 tADA; the wallets lost 1.844564 tADA, exactly the fees of the 8
transactions.

## What this does not show yet

- Rollbacks deeper than the watcher's depth (3 blocks), and rollbacks on the client's side: a
  client whose own transaction is rolled back re-reads its channel from the last position it
  recorded, which may then be gone; its funds stay safe, and `recover` finds the channel again.
- Anything on mainnet.

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
- Claims batch: one transaction redeems up to about 45 ADA channels or 36 token channels
  (size-bound at preprod's parameters), at 0.221768 + 0.034959 × N tADA for ADA and about
  0.2267 + 0.0406 × N for tokens.
- A token channel carries exactly its reserve in ADA. The validator counts only the currency, so
  a redemption can take that ADA down to the output's exact min-UTxO; with the reserve as
  deposited, that is at most 0.09 tADA. The facilitator requires at least the reserve at opening.
- A token channel's refund always follows a claim: the provider's share would be a token output,
  which needs ADA of its own.
- Capacity (x402 `balance`) is cumulative, as IOUs are: `subbed` plus what the channel can still
  pay out. Computing it from the channel's holdings alone refuses vouchers once anything has been
  redeemed and the rest is short of the running total.
- A top-up is `Main([Add])` on the channel's current position with the datum unchanged; the
  channel keeps its id. Answered in 24–35 s on preprod, once 115 s.
- A server must watch its channels: nothing tells it a consumer has closed one. With a 15 s poll
  the close was seen within 12 s and settled 30–62 s after it, over 18 minutes before `elapse_at`
  with the shortest close period the binding allows.
- Every script transaction needs an ADA-only UTxO for collateral, over about 2.2 tADA with the
  margins used here. Token outputs each keep a min-UTxO of ADA, so a party that makes a new one per
  transaction runs out; outputs of the same token should be folded together.
- The only thing a client's records hold that the chain cannot give back is a channel's IOU key.
  Derived from the wallet, losing the records costs one corrective 402: the chain gives the
  channels and every config field but the server's address, the next 402 gives that, and the
  server's own voucher, which the client checks against the recovered key, gives the count.
- A channel the client cannot key again still returns everything the server has not redeemed,
  and without the server `elapse` needs only the consumer's key and the close period.
- A server that loses its records loses what it charged and did not redeem. Its count comes back
  with the client's next voucher, which is cumulative, and runs on from there.
- A lost response costs nothing when the server keeps each channel's latest answer: the retry
  carries the same voucher and gets the same answer, uncharged. Only the latest, or a client
  resyncing from `subbed` gets old answers instead of the corrective 402.
- A server with many channels should follow the validator's address, not poll each channel: one
  request a pass against two per channel, and a close found for three.
- What a server records about a channel must survive a rollback: keep a position that is deep
  enough, read from it forward, and let a record go only once what ended the channel is deep too.
  The record holds the only copy of the latest voucher.
- Collateral: the SDK takes up to three ADA-only UTxOs; sizing the target for those it will take
  keeps a wallet of small UTxOs usable. A token payout under delegation costs the facilitator a
  token output's min-UTxO, 1.176630 tADA each here.
- Delegating the provider key is custody on Subbit: the key can pay a redemption anywhere. It
  takes a key per server tied to its `payTo`, the server's authentication on every claim and
  refund (a channel settles once, and the key would otherwise settle on a consumer's say-so), and
  an audit of each payout. And each payout is an output of its own, so a delegated claim should
  redeem at least min-UTxO; the facilitator tops up anything less.

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

npm run mint -- mint          # step 5: the sUSDM stand-in
SUBBIT_CURRENCY=token SUBBIT_SCRIPT=ref npm run lifecycle -- all
SUBBIT_CURRENCY=token npm run x402 -- all

X402_OUT=x402-step6 npm run x402 -- topup        # step 6: claim, top-up, claim, refund
X402_OUT=x402-step6 npm run x402 -- autosettle   # the consumer closes; the watcher settles; the consumer ends
X402_OUT=x402-step6 npm run x402 -- report
SUBBIT_CURRENCY=token X402_OUT=x402-step6-token npm run x402 -- topup   # and autosettle, report

export SUBBIT_CURRENCY=token X402_OUT=x402-step7-token   # step 7: the same, with the client folding
npm run x402 -- wallets before && npm run x402 -- topup && npm run x402 -- autosettle
npm run x402 -- wallets after && npm run x402 -- report

export X402_OUT=x402-step8   # step 8: recovery after losing the records (unset SUBBIT_CURRENCY)
npm run x402 -- recover && npm run x402 -- recover-elapse && npm run x402 -- report   # ~30 min

X402_OUT=x402-step9 npm run x402 -- replay            # step 9: a lost response, retried
X402_OUT=x402-step9-delegate npm run x402 -- delegate  # a keyless server, account 3 held by the facilitator
X402_OUT=x402-step9-delegate npm run x402 -- report

export SUBBIT_CURRENCY=tusdm X402_OUT=x402-step10-tusdm   # step 10: Moneta's tUSDM, once the wallet holds some
npm run x402 -- wallets before && npm run x402 -- topup && npm run x402 -- autosettle
npm run x402 -- wallets after && npm run x402 -- report

X402_OUT=x402-step11-scale npm run x402 -- scale     # step 11 (tADA): polling against following, ten channels
SUBBIT_CURRENCY=tusdm X402_OUT=x402-step11-elapse-tusdm npm run x402 -- recover-elapse
SUBBIT_CURRENCY=tusdm X402_OUT=x402-step11-delegate-tusdm npm run x402 -- delegate

X402_OUT=x402-step12 npm run x402 -- autosettle            # step 12: the watcher polling, then following
X402_OUT=x402-step12 npm run x402 -- autosettle follow
```

`npm run lifecycle -- <phase>` runs one phase at a time (`b-open`, `b-close`, `a-open`, `a-sub`,
`a-close`, `a-settle`, `a-end`, `b-elapse`, `report`). State, including the throwaway IOU keys,
is in the gitignored `out/lifecycle.json`. Ref mode keeps its own, in `out/state-ref.json` and
`out/lifecycle-ref.json`; the deployed output is recorded in `out/refscript.json`. Step 4's
phases also run one at a time (`pay [n]`, `claim`, `corrective`, `refund`, `batch`,
`batch-refund`, `report`; `reset` clears its state), with state in `out/x402/`: the client's
and server's channel stores, and `results.json`. `X402_OUT` keeps a run's state elsewhere under
`out/`, as step 6 did; `refund topup` refunds the top-up phase's channel on its own.
