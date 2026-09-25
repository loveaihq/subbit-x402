# x402 `batch-settlement` on Cardano over Subbit channels: design (draft)

Status: approved 2026-09-24; milestone 1 (§10) is implemented in `src/x402/` and ran end to end
on preprod (`RESULTS.md`, step 4), which added three rules below: a refund whose provider share
is under min-UTxO is preceded by a claim (§5), an unconfirmed settle is `settlement_pending` with
the transaction id (§6), and a client abandons an opening only when an input of it was spent
elsewhere (§6). Milestone 2, token channels, ran the same way with a USDM stand-in (`RESULTS.md`,
step 5) and added the rules on a token channel's ADA (§4, §5). The binding as a specification
draft, in x402's format: `specs/scheme_batch_settlement_cardano.md`. It follows x402 `main` @ `80c2fa49`
(generic spec, EVM binding, SVM draft) and `@x402/core` / `@x402/evm` 2.27.0, and reuses the
Cardano conventions of `@x402/cardano` 2.27.0 (`exact`). Subbit is kompact-io/subbit-xyz @
66648db, as vendored; every Subbit fact below is from its Aiken source at that commit or from
steps 1–3 of this spike (`RESULTS.md`).

## 1. How the two fit

x402's `batch-settlement` is a lifecycle, Commit → Accumulate → Redeem, whose mechanics each
network binding defines (seven required sections, §9). EVM and SVM both implement it as a
unidirectional payment channel with cumulative vouchers; Subbit is exactly that, so the binding
reuses their message shapes and names wherever Subbit allows.

| x402 (EVM/SVM terms) | Subbit |
|---|---|
| channel escrow | a UTxO at the Subbit script, stage `Opened(subbed)` |
| `deposit` (first) | open: a transaction creating the channel output (runs no script) |
| `deposit` (top-up) | `Add` step, signed by the consumer |
| voucher, `maxClaimableAmount` | IOU: Ed25519 by `iou_key` over `serialiseData([tag, amount])`, amount cumulative |
| `claim` + `settle` | `Sub(n, sig)`, signed by the provider; value leaves the channel in the same transaction |
| cooperative `refund` | `Mutual`: consumer and provider both sign, channel must be the only Subbit input |
| payer's timed withdrawal | `Close` → `Closed(subbed, elapse_at)`; then `Elapse` after `elapse_at` |
| claim during the withdrawal delay | `Settle(n, sig)` → `Settled`; the consumer then `End`s |
| `withdrawDelay` (s) | `close_period` (ms in the datum) |
| `payer` / `payerAuthorizer` | `consumer` key hash / `iou_key` |
| `receiver` / `receiverAuthorizer` | `payTo` / `provider` key hash |
| `token` | `currency`: `Ada` or `Asset(policy, name)` |
| `channelId` | `tag` (immutable, bound into every IOU) |
| `totalClaimed` | `subbed` |

Two Subbit properties shape the design:

- **Partial redemption.** `Sub` requires the new `subbed` ≤ the IOU amount, and `Settle` takes at
  most IOU − `subbed`. So the IOU is a ceiling and the provider redeems what it actually charged:
  EVM-style dynamic pricing works, SVM's fixed-price restriction does not apply.
- **Many channels per transaction.** One transaction can spend several channels: the
  lexicographically first carries `Main(steps)`, the rest `Defer`, and `Main` walks the channels
  in input order. A provider can redeem N channels with one signature, one base fee and one read
  of the reference script. `Mutual` is the exception: it must be alone.

## 2. Identifiers

- `scheme`: `batch-settlement`.
- `network`: `cardano:mainnet | cardano:preprod | cardano:preview`, with `@x402/cardano`'s CIP-34
  aliases normalised on input. The spike runs on `cardano:preprod`.
- `asset`: `lovelace`, or `<policyId>.<assetNameHex>` as in Cardano `exact`. It maps one-to-one
  onto the datum's `currency`. Milestone 1 ran on `lovelace`, milestone 2 on a token: a stand-in
  shaped like USDM (`sUSDM`, CIP-67 label 333, 6 decimals), since the real preprod tUSDM that
  `@x402/cardano` names (`e675b46e…​.0014df10745553444d`) is not in these wallets.
- `amount`: the per-request maximum, in the asset's atomic units.
- `payTo`: the provider's bech32 address. Redemptions pay out to it.

## 3. `PaymentRequirements.extra`

| Field | Type | Req | Meaning |
|---|---|---|---|
| `scriptHash` | hex, 28 B | yes | Subbit validator hash the server accepts; pins the validator version and the channel's payment credential |
| `receiverAuthorizer` | hex, 28 B | yes | key hash that goes into the datum's `provider` field and must sign every redemption. Milestone 1: the payment key of `payTo`, held by the resource server |
| `withdrawDelay` | integer seconds | yes | the channel's close period; datum `close_period` = `withdrawDelay × 1000`. Range 900 – 2,592,000 and ≥ `maxTimeoutSeconds`, as EVM/SVM. Must match exactly |
| `referenceScript` | `txHash#index` | no | an output carrying the validator as a reference script (step 3's `544752f6…#0`). Clients and the server may read it instead of attaching 3,046 bytes; its script hash must equal `scriptHash` |
| `minDeposit` | atomic string | no | deposit-size hint, ≥ `amount`, as EVM. Never enforced by the facilitator |
| `confirmationPolicy` | `{l1Confirmations}` | no | as Cardano `exact`: evidence required before a deposit counts. Milestone 1 default: 0 (in a block) |
| `channelState`, `voucherState` | object | corrective 402 only | as EVM/SVM (§6) |

No `assetTransferMethod` (one method), and `paymentFlow` stays the default `authorization`.

## 4. Channel config and capacity

```ts
type ChannelConfig = {
  payer: string;              // consumer key hash (hex 28 B): signs open, add, close, end, elapse, mutual
  payerAuthorizer: string;    // IOU key, Ed25519 public key (hex 32 B); a fresh one per channel
  receiver: string;           // == payTo
  receiverAuthorizer: string; // == extra.receiverAuthorizer == datum provider
  token: string;              // == asset
  withdrawDelay: number;      // == extra.withdrawDelay
};
```

- **`channelId` = the Subbit `tag`**, 32 bytes hex. The client derives it as blake2b-256 of the
  CBOR of an input its open transaction spends (Subbit's ADR). Unlike EVM it cannot be recomputed
  from the config, so it travels in every voucher; a client that loses its state finds its
  channels by scanning the script address for its `payer` key hash.
- **`channelRef`**: the channel's current `txHash#index`. It changes with every `Sub` or `Add`;
  the server tracks it, and payloads may carry it as a hint.
- **Reserve**: the min-UTxO of the channel's largest continuing output (the `Closed` datum,
  holding its currency), at current parameters and with every integer at its widest encoding:
  1.73 tADA for an ADA channel, 2.13 tADA for a token one (the datum names the token too).
- **Capacity** (x402 `balance`): `subbed` plus what the channel can still pay out, since IOUs are
  cumulative. An ADA channel can pay out its lovelace minus the reserve, because every
  continuing output must keep its own min-UTxO; an IOU above capacity cannot be redeemed
  unilaterally, so the server never accepts one. A token channel can pay out all its tokens: its
  ADA is the reserve. (Until step 6 the code left `subbed` out; RESULTS.md step 6.)
- **A token channel's ADA.** The validator counts only the currency: a continuing output must
  hold ADA and the currency and nothing else, but how much ADA is left to the ledger's min-UTxO.
  A redemption can therefore take the channel's ADA down to that output's exact min-UTxO. So the
  client puts in exactly the reserve and no more, the facilitator requires at least the reserve
  (less could leave a later, larger output short), and what a provider can move is the reserve
  less the exact minimum: 0.09 tADA on preprod.

## 5. Payloads

Client → server (`PaymentPayload.payload`), mirroring EVM/SVM:

```ts
type Voucher = { channelId: string; maxClaimableAmount: string; signature: string /* hex 64 B */; channelRef?: string };

type DepositPayload = { type: "deposit"; channelConfig: ChannelConfig; voucher: Voucher;
                        deposit: { amount: string; transaction: string /* base64 CBOR, fully signed */ } };
type VoucherPayload = { type: "voucher"; channelConfig: ChannelConfig; voucher: Voucher };
type RefundPayload  = { type: "refund";  channelConfig: ChannelConfig; voucher: Voucher /* zero-charge */;
                        transaction: string /* Mutual, signed by the consumer */ };
```

- `deposit` opens a channel (the transaction creates exactly one channel output) or tops one up
  (`Add`). Its voucher is for `chargedCumulativeAmount + amount`.
- `voucher` is every later request: `maxClaimableAmount = chargedCumulativeAmount + amount`.
- `refund` closes the channel cooperatively. The client builds the `Mutual` transaction itself,
  paying the provider `charged − subbed` at `payTo` and the rest back to itself, fee taken from
  the channel, and signs it as consumer. The server checks the provider's payout and adds its
  signature; the facilitator broadcasts. Full refund only: the channel is consumed, and reuse
  means opening a new one (as SVM). The provider's share is an output of its own and must clear
  min-UTxO; when it would not, the server claims it first and the refund then owes nothing. For
  a token channel the share is always claimed first, since a token output needs ADA of its own.

Server → facilitator `/settle`, with synthetic requirements (`amount: "0"`, as EVM):

```ts
type ClaimPayload = { type: "claim"; transaction: string /* Sub over 1..N channels, signed by the provider */;
                      claims: { channelId: string; totalClaimed: string }[] };
```

Cardano has no separate sweep: `Sub` moves the value to `payTo` in the same transaction, so there
is no `settle` type.

## 6. Per-request flow (resource server hooks, as `@x402/evm`)

| Stage | Deposit | Voucher | Refund |
|---|---|---|---|
| `onBeforeVerify` | config ↔ `extra` binding; cumulative equality | the same; with fresh mirrored state (TTL), verify locally and skip the facilitator | cumulative equality (`== charged`) |
| facilitator `/verify` | decode the transaction; check its channel output and datum; voucher signature; inputs unspent | read the channel UTxO; datum, stage, capacity, `subbed`; voucher signature | read the channel; check the `Mutual` transaction's payouts |
| `onAfterVerify` | reserve the channel (one request in flight per channel) | reserve | reserve; skip the handler |
| handler | runs | runs | skipped |
| settle | facilitator broadcasts the open/`Add`, waits for the confirmation policy, returns `channelRef` | **local**: `charged += amount` (or the settlement override), no chain | server adds its signature (`enrichSettlementPayload`); facilitator broadcasts |
| response `extra` | `chargedAmount`, `commitmentId`, `channelState` | same | `channelState` |

- `commitmentId` = `"<channelId>:<maxClaimableAmount>"` (the generic spec requires one; SVM's form).
- `channelState` = `{channelId, channelRef, balance, totalClaimed, withdrawRequestedAt, chargedCumulativeAmount}`,
  with `withdrawRequestedAt` = (`elapse_at` − close period) in seconds once `Closed`, else 0.
- **Corrective 402** on `cumulative_amount_mismatch`, carrying `channelState` and
  `voucherState {signedMaxClaimable, signature}`. The client checks the stored voucher against
  its own IOU key and resynchronises, as EVM's `processCorrectivePaymentRequired`.
- An exact repeat of an accepted `(channelId, maxClaimableAmount)` gets the cached response
  without running the handler again (SVM). *Not in milestone 1.*
- A deposit, claim or refund whose confirmation the facilitator cannot establish in time is
  answered `settlement_pending` with the transaction id; core retries once and the facilitator
  only waits again. A client keeps such an opening `pending` and gives it up only when one of its
  inputs has been spent by another transaction.

## 7. Redemption (the server's channel manager)

The provider key never leaves the resource server. Its manager builds and signs a `Sub`
transaction over the channels with `charged > subbed` (inputs sorted as the ledger sorts them,
`Main` steps in that order, continuing outputs in the same order, the validator read from
`referenceScript`), and hands it to the facilitator as `type: "claim"` to evaluate, broadcast and
confirm. Triggers, as EVM: an interval, a threshold on unredeemed value, and at once when a
refresh finds a channel `Closed`, since `Settle` must land before `elapse_at` (step 2: the
validator itself gives settle no deadline, so after `elapse_at` it races the consumer's elapse).

## 8. Roles

- **Client**: holds the consumer key (transactions) and a per-channel IOU key (vouchers). Builds
  and signs its own open, `Add` and `Mutual` transactions and pays their fees, as Cardano `exact`.
  A wallet that enforces a spend policy sees each voucher and transaction through the client's
  `authorize` hook before anything is handed out or recorded, and can keep the network in another
  process (`refundPayload` builds a refund without sending it). Derived IOU keys are never written
  to the client's records: they are derived again for each voucher, so the records cannot sign.
- **Resource server**: holds the provider key and a chain reader; owns per-channel state (file
  storage with EVM's `get / list / updateChannel` interface); redeems.
- **Facilitator**: no key and no funds, like `@x402/cardano`'s `exact` facilitator. It verifies
  against the chain and broadcasts transactions other parties signed. It is not a channel party.
  Delegating the provider key to a facilitator (EVM's delegated `receiverAuthorizer`) is possible,
  but on Subbit that key can send redeemed funds anywhere, so it is custody, not an
  authorisation. Built in step 9 as an option: the facilitator holds one key per server,
  registered with that server's `payTo` and a shared secret; it builds, signs and pays for the
  server's claims, paying everything redeemed to `payTo`, and co-signs its refunds, but only for
  requests the server authenticates (`delegationMac`); the server checks each claim's payout on
  chain. Spec: *Delegating the provider key*.

## 9. The seven network requirements

1. **Commitment format**: §5; the IOU bytes are the validator's own
   (`0x9f ‖ bstr(tag) ‖ uint(amount) ‖ 0xff`, Ed25519, hex), with a published test vector.
2. **Verification rules**: §6; the facilitator's checks mirror the EVM list with Cardano fields
   (script hash, datum constants against `extra` and `channelConfig`, stage `Opened`, no reference
   script on the channel output, capacity, `subbed`, IOU signature).
3. **Storage behaviour**: the server stores the latest voucher per channel; the commitment
   identifier is `channelId:maxClaimableAmount`.
4. **Double-spend prevention**: onchain, `subbed` is a monotonic watermark that no redemption
   can pass; offchain, one request per channel at a time and exact cumulative equality (the
   response cache for exact repeats is not in milestone 1).
5. **Commitment expiry**: IOUs carry no expiry. Once the consumer closes, IOUs the provider has not
   redeemed by `Settle` before the consumer's `Elapse` lands become void.
6. **Redemption**: §7.
7. **Trust model**: capital-backed. The provider can always redeem its latest IOU while the channel
   is open, and for at least the close period after a unilateral close; the consumer can always
   recover everything not redeemed, and the validator never lets the provider take more than the
   latest IOU. The facilitator holds nothing.

Error codes: `invalid_batch_settlement_cardano_*`, reusing the EVM/SVM suffixes for shared cases
(`cumulative_amount_mismatch`, `cumulative_exceeds_balance`, `channel_busy`, `voucher_signature`, …).

## 10. Milestone 1: what gets built and measured

Scope: ADA channels, reading the reference script; `deposit` (open), `voucher`, corrective 402,
batched `claim`, cooperative `refund`. Deferred: top-up by `Add`, the manager's automatic settle
after a unilateral close, token channels (USDM), provider-key delegation, the upstream spec text.
Since done (RESULTS.md): token channels in step 5, the spec draft
(`specs/scheme_batch_settlement_cardano.md`), top-ups and the automatic settle in step 6, token
UTxO folding in step 7, recovery after state loss (IOU keys derived from the wallet) in step 8,
the response kept for retries and provider-key delegation in step 9, Moneta's tUSDM in step 10,
the watcher following the chain in step 11, and surviving rollbacks in step 12.

Code, in this repo:
- `src/x402/`: shared types and checks; client scheme (`SchemeNetworkClient`); server scheme
  (`SchemeNetworkServer` with the hooks of §6, file storage); facilitator scheme
  (`SchemeNetworkFacilitator`); the channel manager.
- `spike/x402/`: a facilitator on `127.0.0.1:7413` and a resource server on `:7411` (the pattern
  of `ada-agent-wallet/dev`), and a client driven through `@x402/fetch`.
- Dependencies to add: `@x402/core` and `@x402/fetch` 2.27.0.
- Chain-free tests: payload and IOU encoding, the verification rules on fixtures, cumulative and
  corrective-402 logic.

Preprod run, every figure read back from Blockfrost as in steps 1–3:
1. One consumer (account 0), provider = account 1, route priced 1,000 lovelace: the first request
   opens a channel; then 200 paid requests; latency of the first request (includes a block) and
   of the rest (no chain); HTTP round trips per request.
2. One `claim`: redemption lands at `payTo`; channel `subbed` = charged.
3. A client that lost its count: corrective 402, recovery, and the next request succeeds.
4. Cooperative refund: the consumer gets everything back except what was charged.
5. Batching: channels from several consumers (accounts 3+, funded from account 0) redeemed in one
   transaction; fee per channel for N = 1, 5, 10, and the largest N that fits.

## 11. Decisions for review

1. **Who holds the provider key.** Proposed: the resource server (§8). The alternative, delegating
   it to the facilitator, lets a server run with no key and no chain access, at the cost of the
   facilitator having custody of redemptions.
2. **When the first request is answered.** Proposed: after the open transaction is in a block
   (`l1Confirmations` 0; about 20 s on the first request only). Mempool acceptance (−1) is faster
   and leaves the server exposed for the requests served before the channel exists.
3. **Close period.** Proposed: EVM/SVM's 900 s – 30 days, default 900 s. It is the provider's
   window to settle after a unilateral close.
4. **Pricing.** Proposed: fixed price in milestone 1, with the design already allowing a smaller
   actual charge (Settlement-Overrides), which Subbit's partial redemption supports.
5. **Refund.** Proposed: full refund only, through `Mutual`, one round trip, fee from the channel.
