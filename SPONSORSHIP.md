# Seller-sponsored channels: design

**Status: step 16 passed on preprod on 2026-09-28 (RESULTS.md step 16). Preprod only.** 0.2.0's
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
