# Sponsor-safe Subbit channels

**Status: the validator, its tests and the TypeScript binding. All of it ran on preprod on
2026-10-07 (RESULTS.md, step 17): four sponsored channels, each ended another way, and 21 changed
versions of their transactions, each breaking R1, R2 or R3, refused by Blockfrost's evaluator. Nothing
has been audited. Preprod only, like the rest of this repository.** The source is
[`aiken/`](aiken); [PROVENANCE.md](PROVENANCE.md) says what it changes in Subbit's, and its
spend hash. `npm run validator:sponsored` runs the tests.

## What it is for

A seller can sponsor a token channel for a buyer who holds no ADA ([SPONSORSHIP.md](../../SPONSORSHIP.md)):
the seller's ADA pays the channel's reserve, the min-UTxO ADA every token channel carries (about
2.13 tADA with upstream's datum). With upstream's validator, a buyer who ends such a channel alone
may keep that ADA: by Close and then Elapse, or by End once the seller has settled. This variant
sends it back to the sponsor.

## The datum

`Constants` gets a seventh field, `sponsor: Option<(Address, Int)>`.

- `None`: nothing changes. The channel behaves as upstream's does, plus the `ordered_insert` fix
  (PROVENANCE.md).
- `Some((address, floor))`: `address` is where the reserve goes back to, a `cardano/address`
  `Address` compared whole, stake part included. `floor` is the least lovelace that must reach it.

On the wire, `None` is `d87a80` and `Some((address, floor))` is `d8799f 9f <address> <floor> ff ff`
(Plutus data). `lib/mark/sponsored.ak` pins one example, byte for byte.

The sponsor is one of the constants, and a continuing output must repeat all of them. So neither
the address nor the floor changes while the channel lives. Only `Mutual` can rewrite them.

## The rules

| Rule | Steps | A sponsored channel must |
|---|---|---|
| R0 | every `Main` step | have `currency = Asset`. With `Ada`, every step fails. |
| R1 | Add, Sub, Close, Settle | have a continuing output holding at least `floor` lovelace. This comes on top of each step's own checks. |
| R2 | End, Elapse | be matched by an output of the transaction at `address` (whole), with `InlineDatum(own_oref)` and at least `floor` lovelace. `own_oref` is the `OutputReference` of the channel input that the step spends. The search is over all of the transaction's outputs, not what the continuing steps before it have left. |
| R3 | End | need the **provider's** signature, not the consumer's, if the channel input holds none of its currency. Otherwise the consumer signs, as upstream. |
| Mutual | | be as before: both sign, nothing else is checked. |

- **R0.** With ADA as the currency, the sponsor's ADA and the buyer's funds are one coin, and
  nothing tells the reserve from the funds.
- **The output reference in R2.** It names the one UTxO that ends, and an output reference is
  unique by construction: a UTxO is spent once. So two channels ended in one transaction need two
  outputs, even with the same sponsor address, and even with the same tag. Tags are not unique on
  chain, since the opening runs no script. (A repayment that named the tag instead would let one
  output repay every channel that had it.) The datum is `Constr 0 [B txid, I index]`, written
  `d8799f 5820<txid> <index> ff`, the id bare as in a V3 script context; the tests pin it byte for
  byte. The reference changes at every step, since each continuing step makes a new UTxO, so the
  server matches a repayment to the channel UTxO as it stood when the channel ended.
- **R3.** An empty settled channel gives the consumer nothing, so it has no reason to end it, and
  the sponsor's floor would stay locked. Elapse needs no such rule: the provider can settle an
  empty closed channel, and then end it under R3.
- **Mutual skips every rule.** The provider's key must sign it, so the sponsor is safe as long as
  that key is its own, as the seller's is in SPONSORSHIP.md, where the sponsor key and the
  provider key are two keys of one seller.

## Choosing the floor

- **Recommended: `floor` = the full reserve**, the lovelace the sponsor put into the channel. R1
  then keeps all of it in the channel and R2 sends all of it back, so the sponsor's exposure is
  about nothing: the opening fee. A buyer that exits alone pays its own fees and its token output's
  ADA, and posts its own collateral. It needs free ADA for the collateral in any case, since
  collateral must come from key-locked inputs and a channel is not one. The cooperative refund, a
  `Mutual`, is unchanged and stays sponsored.
- **`floor` below the reserve is allowed.** The server then subsidises a solo exit: the buyer may
  take the difference out of the channel with the steps it signs (Add, Close). The sponsor's
  exposure is `reserve - floor` per channel, plus the opening fee. The provider can take the same
  difference back at any time with a Sub or Settle, which may leave as little as `floor` in the
  channel (upstream's may take the channel's ADA down to the ledger's minimum).
- **Abandoned channels.** An Opened or non-empty channel that the buyer abandons keeps the floor
  until the buyer acts, or until a Mutual. The buyer gains nothing from that: the ADA just stays
  in the channel. R3 lets the provider end an empty settled channel.
If the server does subsidise, the difference must cover what the buyer's exit costs: the fee of
Close, the fee of Elapse, and the min-UTxO of its token output. Measured on preprod (RESULTS.md,
steps 11 and 16) a fee is 0.19 to 0.35 ADA, the more with the validator inline rather than as a
reference script, and a token output needs 1.18 ADA: 1.6 to 1.9 ADA in all. A `reserve` of 3.1 ADA
with a `floor` of 1.2 ADA leaves 1.9. A smaller difference means a buyer needs ADA of its own to
exit.

## What the server must check at opening

The opening runs no script, so only these checks stand between a bad datum and the sponsor's ADA.

1. The datum is the 7-tuple of constants, and `own_hash` is this validator's hash. Refuse a datum
   with upstream's six constants at this validator's address: nothing can read it, so whatever it
   holds is locked for good. One naming another hash is anyone's, as upstream.
2. `sponsor` is `Some((address, floor))`, with `address` the sponsor's own, whole, stake part
   included.
3. `floor` is at least the min-UTxO of a repayment output: `address`, ADA, and an inline datum of
   an output reference. That is (160 + size) × 4,310 lovelace, and the size is 113 bytes for a
   base address with key credentials, 114 if the index is 24 or more, so 1,176,630 or 1,180,940;
   85 or 86 bytes for an enterprise address, so 1,055,950 or 1,060,260. (Sized with the SDK's
   `TxOut.toCBORBytes` and a coin that fits four bytes; the client's `minAdaOutput` uses the
   widest, four bytes more.) Add a margin in case `coinsPerUTxOByte` changes. Below this the
   buyer must pay more than `floor` anyway, and `reserve - floor` is not what is really left.
4. `floor` is at most the channel's lovelace at opening. Above it R1 can never hold, and the
   channel can only end by Mutual.
5. `currency` is `Asset`. A sponsored ADA channel can only be spent by Mutual.
6. `provider` is the server's key and `consumer` the buyer's.

## What it costs

- **The datum** is longer by 88 bytes with a base-address sponsor and by 49 with an enterprise
  address (measured), so about 0.38 or 0.21 ADA more min-UTxO on the channel, at 4,310 lovelace a
  byte. `reserve` must cover it.
- **The script** is 3,798 bytes against upstream's 3,046, so a reference-script output for it needs
  about 3.2 ADA more.
- **Execution units** of a channel with no sponsor rise, because of the longer constants and the
  checks that find `None`: in the 18 unit tests that upstream's suite and this one share and that
  run a channel through the validator, 3.9% to 10.5% more memory (mean 7.7%) and 3.5% to 10.4% more
  CPU (mean 5.8%), the test's own work included.

## The TypeScript side

`src/subbit.ts` knows both validators (`UPSTREAM`, `SPONSORED`) and writes and reads both datums,
and `src/x402/repay.ts` checks R1 and R2 on every transaction the binding builds before it is
signed. The variant is opt-in: the client, the facilitator and the server use upstream's validator
alone unless told otherwise. `test/variant.test.ts` holds the TypeScript encodings to the bytes
`lib/mark/sponsored.ak` pins, and runs this validator on the transactions the builders make
(`aiken tx simulate`).

It ran on preprod on 2026-10-07 (RESULTS.md, step 17; `npm run variant`), through the whole stack with
the variant named at every end: the clients with `trustedValidators: [SPONSORED]`, the facilitator with
`validators: [SPONSORED]`, the server with `scriptHash: SPONSORED.hash`, a sponsor pool of 4 tADA offers
at a key that is not the provider's, Blockfrost as the chain, and the validator attached to each
transaction (no reference script). Four channels were opened on the seller's offer and ended by a
sponsored `Mutual` refund, the buyer's End, the provider's End (R3) and the buyer's Elapse. All 15
transactions landed the first time, each exit repaid `payTo` its 2,529,970 lovelace with the channel
input's output reference as the datum, and the seller's net ADA in each channel was minus its fees, to the
lovelace. The ledger's own checks (fees, collateral, min-UTxO) raised nothing. The execution units are the
local runs': Close and Add exactly, the others between 9% under and 5% over, none above 2.2% of the
ledger's limits. A solo exit's fee was 0.37 to 0.39 tADA with the script attached, so Close, Elapse and the
min-ADA of the tokens' output came to 1.94 tADA, a little over the 1.6 to 1.9 given under "Choosing the
floor".
