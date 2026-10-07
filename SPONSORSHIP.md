# Seller-sponsored channels: design

**Status: step 16 passed on preprod on 2026-09-28 (RESULTS.md step 16), and section 7's variant on
2026-10-07 (step 17). Preprod only.** 0.2.0's
client trusted the offer's fields; from 0.2.1 it reads the offered UTxO from the chain first
(section 3, "What the buyer checks"). This brings the fee sponsorship of
[cardano-x402-sponsor](https://github.com/loveaihq/cardano-x402-sponsor) (seller-sponsored fees for
x402 `exact`, milestone 1 passed on preprod on 2026-09-27) to this binding's channels, so that a
buyer holding only a stablecoin can open, top up and cooperatively close a channel. The offer, its
wire format and the pool are the same as there; this document covers what channels change.

## 1. What a stablecoin-only buyer lacks today

A buyer whose wallet is token UTxOs, each with the min-ada that came with it, has no ADA-only UTxO.
Every step of a channel's life that the buyer builds needs one:

| Step | ADA the buyer must bring today | Why |
|---|---|---|
| open | the reserve (2.13 tADA for a token channel) + fee | the channel output's ADA; no script runs |
| top-up (`Add`) | fee + collateral | spends the channel: a script runs |
| refund (`Mutual`) | collateral | the fee comes from the channel, but a script runs |
| close / end / elapse | fee + collateral | the buyer's own exit, without the server |

And `openChannel` refuses outright when the opening would leave the wallet no ADA-only UTxO for the
refund's collateral (step 13).

## 2. The idea, per step

The 402 carries a `feeSponsor` offer, as for `exact`: one of the seller's ADA-only UTxOs at a
sponsor key that is not the provider key. The client builds each transaction around it; the seller
checks it and signs for its UTxO; the facilitator merges the witness at settlement.

- **Open.** The sponsor UTxO pays the channel's reserve and the fee; what is left goes to `payTo`.
  The buyer's own ADA passes through to its change, as in `exact`. The channel holds exactly the
  reserve, as every token channel does, but now it is the seller's.
- **Top-up.** The sponsor UTxO pays the fee, and is also the collateral: the SDK takes collateral
  from any available UTxO, inputs included, and a collateral input is only consumed if a script
  fails, which the facilitator's evaluation rules out before broadcast. What is left goes to
  `payTo`, and so does the collateral return. The channel's ADA does not change.
- **Refund.** The sponsor UTxO is only the collateral: nothing of it is spent. The channel's
  reserve is the seller's, so the channel's ADA less the fee goes back to `payTo`, and the refunded
  tokens join one of the buyer's own UTxOs, whose ADA covers them, so the buyer's ADA still does not
  move. A channel the buyer funded itself is refunded as before, with the collateral the opening
  left it: the SDK sends a collateral return to the change address, and such a refund would need
  the change at the buyer and the return at the seller.

The client prefers an offer whenever the 402 carries one. Without one everything is as before.

| Per channel, stablecoin-only buyer | Buyer's ADA | Seller's ADA |
|---|---|---|
| open → vouchers → claim → refund | ±0 | − (open fee + refund fee), plus its own claim fees |
| open → buyer exits alone | + reserve − its own exit costs | − reserve − open fee |

The second row is the seller's exposure: at most one reserve (2.13 tADA) per sponsored channel,
and a buyer that exits alone needs ADA for collateral and fees at that point. The pool's size is
the seller's budget for it.

## 3. What the seller checks before signing

Common to all three, as S1–S9 for `exact`: the offered input is spent (open, top-up) or is the
collateral (refund); no other input or collateral at the sponsor's key, looked up on chain (S2);
nothing that moves value outside inputs and outputs (S6); fee ≤ `maxFee` (S5); a validity upper
bound no later than `expiresAt` (S7); the fee covers the floor once every witness is merged (S9).

Per step, where the sponsor's ADA may go:

- **Open**: channel output ADA + `payTo` ADA + fee ≥ the sponsor UTxO, and the channel output holds
  no more ADA than its reserve. So the buyer gets none of it, and the seller's exposure is exactly
  one reserve. No collateral, no redeemers: the opening runs no script (S3).
- **Top-up**: `payTo` ADA + fee ≥ the sponsor UTxO, so none of it reaches the channel or the buyer.
  Collateral: the offered input only; its return pays `payTo` or the sponsor address; total
  collateral ≤ 2 ADA.
- **Refund**: the offered input is the only collateral, it is not also spent, its return pays
  `payTo` or the sponsor address, total collateral ≤ 2 ADA, and the seller runs the evaluator
  before signing. For a channel whose reserve is the seller's, also `payTo` ADA + fee ≥ the
  channel's ADA, and every input besides the channel is the consumer's own.
- **Any refund of a channel whose reserve is the seller's** (0.2.2): `payTo` ADA + fee ≥ the
  channel's ADA, also when the refund does not use the offer and the buyer puts up collateral of
  its own. Before 0.2.2 only a sponsored refund was held to it.

S9 for a top-up or a refund checks the size part of the fee: with the seller's witnesses merged,
the fee still covers `minFeeA × size + minFeeB`. What the scripts' execution adds is the builder's
estimate, and the SDK's counts a witness for every key-locked input and collateral. A fee short of
it fails at submission, before anything moves.

### What the buyer checks

The offer is the seller's claim, and its address never enters the transaction: the ledger asks
for the witness of the UTxO's real owner. An offer naming one of the buyer's own UTxOs, with its
true lovelace under any address, gives a body that balances and needs no witness but the buyer's.
That UTxO's ADA then goes where the sponsor's would: to `payTo`, and into the channel as a reserve
the refund pays back to `payTo`.

So the client reads `offer.input` from the chain before building with it. It uses the offer only
if the chain holds an ADA-only UTxO there, at exactly the offer's address, with exactly its
lovelace, with no reference script, and not at the wallet's payment key (`offerOnChainProblem`).
It then builds with the UTxO the chain returned. A top-up's or a refund's collateral must be that
UTxO and nothing else. When an offer fails these checks, an opening or a top-up goes ahead as if
none had been made. A refund of a channel whose reserve is the seller's fails, with the reason.
0.2.0's client checked none of this (RESULTS.md, "Step 16, after the release").

### A buyer that lost its records

`recover` finds a wallet's channels on chain, but a record's `reserveFrom` goes with the record.
From 0.2.2, `recover` walks each token channel back to the transaction that opened it
(`Chain.openingOf`). A channel whose opening took none of the wallet's ADA, and spent an input of
someone else's, was opened on an offer: its reserve is the seller's, and its refund is sponsored
as it would have been. Nothing the seller answers is taken for it.

The facilitator's existing checks still apply: the channel output and datum (open), the `Add`
shape and evaluation (top-up), and `checkMutual` (refund), whose "the channel and nothing else"
becomes "the channel, plus only key-locked inputs of the consumer".

## 4. Wire and roles

- The offer is `extra.feeSponsor`, with `areFeesSponsored: true`, exactly as for `exact`. The
  facilitator advertises `acceptsSponsorWitnesses: true` in its `/supported` kind. A server offers
  only then.
- Deposits and refunds carry the buyer-signed transaction, as today. At settlement the server adds
  `sponsorWitnesses` (the seller's witness set, CBOR hex) to the payload; a refund also gets
  `providerWitness` as today. The facilitator merges both before its settle-time check.
- At verify the facilitator accepts a deposit whose only unsigned key-locked input is the offered
  one, and sizes its fee floor with that witness added.
- A paid request that names an offer the pool made and that has not expired gets that offer back
  verbatim in the 402 core matches against, even if the offer is bound to someone else by then.
  A voucher never spends the offer, and must not fail to match because another buyer took it. A
  deposit that spends a taken offer is refused at binding.
- The server records a channel opened with a sponsor UTxO as `reserveFrom: "seller"`, and so does
  the client, which then builds its refund to match.

## 5. Milestone (step 16)

Done means, on preprod, with the stack of steps 4–14 and tUSDM: a buyer holding one UTxO of tUSDM
and its min-ada opens a channel, pays for many requests, tops the channel up, and gets a
cooperative refund after the server's claim, all sponsored; its ADA is unchanged to the lovelace,
and the seller's net ADA is minus the fees it paid. A buyer with ADA of its own still opens and
refunds the old way when no offer is made. Build-only negatives for the per-step rules of section 3
are refused. Chain-free tests cover the rules, the relaxed `checkMutual`, and the facilitator's
witness handling.

## 6. After the Dijkstra hard fork (CIP-118)

CIP-118's nested transactions (read on 2026-09-29, at `61b21c8` of cardano-foundation/CIPs; status
Proposed; the Dijkstra hard fork is expected between December 2026 and March 2027) let a buyer sign
a sub-transaction that is short of ADA, and leave its fee and min-UTxO to whoever wraps it in the
top-level transaction. Which of the steps in section 1 that could sponsor turns on whether the step
runs a script:

| Step | Runs Subbit's validator (PlutusV3) | Sponsored by a nested transaction |
|---|---|---|
| open | no | possible: the buyer's opening as a sub-transaction, the seller paying the reserve and the fee in the top-level one |
| top-up, refund, close, end, elapse | yes | no |

A sub-transaction cannot run PlutusV3 or earlier scripts. A top-level transaction can, in the CIP's
"special mode" for PlutusV1–V3, but then it "will have to balance out by itself", so no
sub-transaction can pay its fee or put up its collateral. The steps that spend a channel therefore
keep needing the seller's UTxO as an input of the same transaction, co-signed, as sections 2 and 3
describe, unless Subbit's validator is rebuilt as PlutusV4: a new script hash, and its author's
decision. cardano-x402-sponsor's DESIGN.md section 12 has the same reading for `exact`.

## 7. The sponsor-safe variant

**Status: the TypeScript side is built and tested without a chain, its transactions pass the compiled
variant when that is run locally (`aiken tx simulate`, in `test/variant.test.ts`), and the whole of it
ran on preprod on 2026-10-07 (RESULTS.md, step 17). The validator has had no audit. Opt-in, preprod
only.**

With upstream's validator the reserve is the buyer's to keep when it exits alone (the last row of
section 2's table). [`variant/sponsored/`](variant/sponsored/DESIGN.md) is a fork of Subbit's
validator (spend hash `20b64ee2…`; upstream's is `62ce4309…`) that sends it back. Its datum has a
seventh constant, `sponsor: Option<(Address, floor)>`, and a sponsored channel must keep `floor`
lovelace in every continuing output (R1), repay the sponsor at least `floor` when it ends (R2), and,
when it holds none of its currency, be ended by its provider (R3).

| | Upstream's validator | The variant |
|---|---|---|
| The 402's `extra.scriptHash` | `62ce4309…` | `20b64ee2…`. The client must be told to trust it (`trustedValidators: [UPSTREAM, SPONSORED]`), the facilitator to serve it (`validators`), the server to name it (`scriptHash: SPONSORED.hash`) |
| Opening on the seller's offer | six constants | seven, with `sponsor = (payTo, floor)` and `floor` the channel's whole reserve. The client writes it; the facilitator and the seller each refuse an opening that does not |
| Opening the buyer pays for | as before | `sponsor = None` |
| A token channel's reserve | 2.13 tADA | 2.53 tADA for a base-address `payTo`, 2.36 for an enterprise one: the datum carries the address and the floor |
| Top-up, claim, close | as before | as before, and each builder checks that the continuing output holds `floor` before it signs |
| Mutual refund | as before | as before: it skips the validator's rules, both keys sign, and the seller's refund checks are unchanged |
| The buyer's Elapse, or End | all the channel's ADA to the buyer | `floor` of it to `payTo` first, with the channel input's output reference as the output's inline datum: the client adds it and checks it |
| End of a channel that a settle left empty | – | the server ends it as provider and gets the floor back, less its fee |

**Exposure.** With `floor` = the reserve, a buyer's solo exit sends the whole reserve back, so what
the seller loses per sponsored channel is about the opening's fee (0.19 tADA in the step 16 runs,
0.194233 at the variant in step 17).
Section 2's last row becomes: buyer − its own exit costs, seller − the open fee. What it does not
remove is abandonment: a channel whose buyer never acts, or that a settle leaves holding a few
tokens (only its buyer may End one that is not empty), keeps the floor in the channel until a mutual
refund or the buyer's exit, and the seller's only limits on that are the size of its pool and the
`minDeposit` it asks.

**What a solo exit costs the buyer.** The channel's ADA no longer pays for it, and none of it comes
back. The buyer pays its own fee (0.37 to 0.39 tADA at the variant on preprod, in step 17, with the validator
attached to the transaction; 0.19 to 0.35 in the earlier runs) and needs ADA beside it, for
the collateral (one ADA-only UTxO of 2 tADA, or two of 1.5, which come back) and for the min-ADA of the
output the tokens return in (1.18 tADA, which stays its own). A buyer with none cannot exit alone, as
with upstream's validator, and the client says so before it builds anything. A settled channel that
holds none of its currency is not the buyer's to End at all (R3): it has nothing to take there, and
nothing to pay.

**The server's End.** `ChannelManager.claim` tries it once, after a settle that leaves a channel at
the variant empty with `payTo` as its sponsor: it builds the End (`buildEndTx`), signs as provider,
pays the fee out of its own ADA and takes the floor at `payTo`. A failed End is reported in the
claim's row (`endError`) and `endEmpty` tries it again; `endEmptySponsored: false` turns it off.
Not yet: a closed channel that nothing was owed on, which needs a settle of nothing first, and a
server whose facilitator holds its key. A repayment is an output with an inline datum, so what lands
at `payTo` is a UTxO that carries one: it spends like any other at a key address.

**A pool for it** offers UTxOs of 4 tADA or more. A sponsored opening's change goes to `payTo` and
must clear min-UTxO after the larger reserve: with the pool's default smallest offer, 3.5 tADA, it
does not for a base-address `payTo`.

**Run on preprod** (RESULTS.md, step 17, 2026-10-07): four sponsored channels at the variant, each opened
on the seller's offer, with the validator attached to each transaction. A stablecoin-only buyer's open,
top-up, claim and refund moved its ADA by nothing and the seller's net ADA by minus its fees, to the
lovelace. A buyer that closed alone was settled and ended its channel itself (R2, 0.6 tUSDM back); a buyer
whose server did not settle elapsed (R2, all of its 1.0 tUSDM back); and the server ended the channel its
settle had emptied (R3). Each of the three exits repaid `payTo` 2.529970 tADA, the floor, with the channel
input's output reference as the datum, and the seller's net ADA in each channel was minus its fees to the
lovelace: the opening's 0.194233 tADA alone, for the buyer that left alone and was never settled. 21
changed versions of those transactions, each breaking R1, R2 or R3 (no repayment, a lovelace short, the
channel's tag for the reference, a Close at the floor less a lovelace, a provider's End of a channel that
held tokens, among them), were refused by Blockfrost's evaluator, against 13 unchanged ones that it took.
