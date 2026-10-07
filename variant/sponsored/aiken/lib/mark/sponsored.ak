//// Sponsored channels (variant/sponsored/DESIGN.md), rule by rule.
////
//// - R0: a sponsored channel's currency is a token, never ADA.
//// - R1: while a sponsored channel continues (Add, Sub, Close, Settle), its output holds at
////   least the floor.
//// - R2: End and Elapse repay the sponsor: some output of the transaction, among all of them,
////   is at exactly the sponsor's address, has the output reference of the channel input that
////   ends as its inline datum, and holds at least the floor.
//// - R3: End of a sponsored channel that holds none of its currency is for the provider to sign.
//// - Mutual is as it was: both sign, nothing else is checked.
////
//// Each rule has a test that passes and tests that fail, built from the same transaction with one
//// thing changed. A property test marked `fail` passes only if every generated case fails.

use aiken/cbor
use aiken/collection/list
use aiken/fuzz
use aiken/interval
use aiken/primitive/bytearray
use cardano/address.{Address, Inline, Pointer, Script, VerificationKey}
use cardano/assets.{Value}
use cardano/transaction.{
  Datum, DatumHash, InlineDatum, NoDatum, Output, Transaction,
}
use mark/fixture.{
  add, amount, channel, close, constants, consumer, elapse, end, floor, input,
  input_at, iou, main, oref, oref_of, other_sponsor_key, other_txid, provider,
  repayment, reserve, run, settle, sponsor_address, sponsor_key,
  sponsor_stake_key, sponsored, sponsored_tagged, sub, to, tokens_and_ada, tx,
  txid, usdm, with_sponsor,
}
use mark/vectors
use subbit/io
use subbit/types as t

/// The tag of the fixture's channels (`constants`, `sponsored`). A repayment does not name it: tags
/// are not unique on chain, and output references are. It is here for the channels' constants,
/// and for the repayments that name it all the same, which count for nothing.
const tag_1: ByteArray = vectors.tag_1

// ---- builders: an ending ----------------------------------------------------------------------

/// The buyer's own output at an ending: its `held` tokens, and the ADA the sponsor does not take.
fn buyer_takes(held: Int, lovelace: Int) -> Output {
  to(consumer, tokens_and_ada(held, lovelace))
}

/// An honest ending's outputs: the sponsor repaid `paid` of the `reserve`, the buyer takes the
/// rest and the `held` tokens. The repayment's datum is `oref(0)`, the output reference of the
/// channel input: the builders below put their channel first.
fn repaying(paid: Int, held: Int) -> List<Output> {
  [
    repayment(sponsor_address(), oref(0), paid),
    buyer_takes(held, reserve - paid),
  ]
}

/// The same, with the repayment at `address`.
fn repaying_at(address: Address, held: Int) -> List<Output> {
  [repayment(address, oref(0), floor), buyer_takes(held, reserve - floor)]
}

/// The same, with the repayment's datum replaced.
fn repaying_with_datum(datum: Datum, held: Int) -> List<Output> {
  [
    Output { ..repayment(sponsor_address(), oref(0), floor), datum },
    buyer_takes(held, reserve - floor),
  ]
}

/// A closed channel `c`, past its time, holding `held` tokens and the `reserve`, elapsed by a
/// transaction with these outputs and signers.
fn elapsing(
  c: t.Constants,
  held: Int,
  outs: List<Output>,
  signers: List<ByteArray>,
) -> Transaction {
  Transaction {
    ..tx(
      [
        input(
          0,
          channel(
            c,
            t.Closed { subbed: 7, elapse_at: 1_000 },
            tokens_and_ada(held, reserve),
          ),
        ),
      ],
      outs,
      signers,
    ),
    validity_range: interval.after(2_000),
  }
}

/// A settled channel `c` holding `held` tokens and the `reserve`, ended by such a transaction.
fn ending(
  c: t.Constants,
  held: Int,
  outs: List<Output>,
  signers: List<ByteArray>,
) -> Transaction {
  tx(
    [input(0, channel(c, t.Settled, tokens_and_ada(held, reserve)))],
    outs,
    signers,
  )
}

/// A repayment from the floor up to just under the whole `reserve`, which leaves the buyer
/// something.
fn repaid_in_full() -> Fuzzer<Int> {
  fuzz.int_between(floor, reserve - 1)
}

/// ADA short of the floor, but not none.
fn below_the_floor() -> Fuzzer<Int> {
  fuzz.int_between(1, floor - 1)
}

// ---- R2: Elapse repays the sponsor ------------------------------------------------------------

test elapse_repays_the_sponsor(x via fuzz.both(amount(), repaid_in_full())) {
  let (held, paid) = x
  main(
    elapsing(sponsored(usdm), held, repaying(paid, held), [consumer]),
    [elapse],
  )
}

test elapse_repays_exactly_the_floor() {
  main(
    elapsing(sponsored(usdm), 1_000, repaying(floor, 1_000), [consumer]),
    [elapse],
  )
}

/// The buyer takes everything, as upstream lets it.
test elapse_needs_a_repayment(held via amount()) fail {
  main(
    elapsing(sponsored(usdm), held, [buyer_takes(held, reserve)], [consumer]),
    [elapse],
  )
}

test elapse_one_below_the_floor_is_no_repayment() fail {
  main(
    elapsing(sponsored(usdm), 1_000, repaying(floor - 1, 1_000), [consumer]),
    [elapse],
  )
}

test elapse_below_the_floor_is_no_repayment(
  x via fuzz.both(amount(), below_the_floor()),
) fail {
  let (held, paid) = x
  main(
    elapsing(sponsored(usdm), held, repaying(paid, held), [consumer]),
    [elapse],
  )
}

/// The old scheme named the channel's tag. Tags are not unique on chain (the opening runs no
/// script), so a repayment that names one counts for nothing: this channel's, or another's.
test elapse_repayment_with_a_tag_does_not_count(
  x via fuzz.both(amount(), fuzz.one_of([tag_1, vectors.tag_2])),
) fail {
  let (held, tag) = x
  main(
    elapsing(
      sponsored(usdm),
      held,
      repaying_with_datum(InlineDatum(tag), held),
      [consumer],
    ),
    [elapse],
  )
}

/// Another input of the same transaction: its output reference has this one's id and another
/// index. (The channel is `oref(0)`.)
test elapse_repayment_with_another_index_does_not_count(
  x via fuzz.both(amount(), other_indexes()),
) fail {
  let (held, index) = x
  main(
    elapsing(
      sponsored(usdm),
      held,
      repaying_with_datum(InlineDatum(oref_of(txid, index)), held),
      [consumer],
    ),
    [elapse],
  )
}

fn other_indexes() -> Fuzzer<Int> {
  fuzz.int_between(1, 1_000_000)
}

/// An output of another transaction, at the channel's own index.
test elapse_repayment_with_another_tx_id_does_not_count(
  x via fuzz.both(amount(), other_tx_ids()),
) fail {
  let (held, id) = x
  main(
    elapsing(
      sponsored(usdm),
      held,
      repaying_with_datum(InlineDatum(oref_of(id, 0)), held),
      [consumer],
    ),
    [elapse],
  )
}

fn other_tx_ids() -> Fuzzer<ByteArray> {
  fuzz.such_that(fuzz.bytearray_fixed(32), fn(id) { id != txid })
}

test elapse_repayment_needs_a_datum(held via amount()) fail {
  main(
    elapsing(
      sponsored(usdm),
      held,
      repaying_with_datum(NoDatum, held),
      [consumer],
    ),
    [elapse],
  )
}

/// The output reference as a datum hash is not the output reference inline.
test elapse_repayment_needs_an_inline_datum(held via amount()) fail {
  main(
    elapsing(
      sponsored(usdm),
      held,
      repaying_with_datum(DatumHash(txid), held),
      [consumer],
    ),
    [elapse],
  )
}

/// How Plutus V1 and V2 scripts see an output reference: the id in a constructor of its own. V3,
/// which this validator runs as, has the id bare.
type TxIdV2 {
  hash: ByteArray,
}

type OutputReferenceV2 {
  transaction_id: TxIdV2,
  output_index: Int,
}

/// Datums close to the channel's output reference, none of them it.
fn mangled_orefs() -> List<Datum> {
  [
    InlineDatum(#""),
    InlineDatum(txid),
    InlineDatum((txid, 0)),
    InlineDatum((0, txid)),
    InlineDatum([oref(0)]),
    InlineDatum(Some(oref(0))),
    InlineDatum(oref_of(bytearray.take(txid, 31), 0)),
    InlineDatum(oref_of(bytearray.concat(txid, #"00"), 0)),
    InlineDatum(oref_of(txid, -1)),
    InlineDatum(
      OutputReferenceV2 {
        transaction_id: TxIdV2 { hash: txid },
        output_index: 0,
      },
    ),
  ]
}

/// Only the output reference itself: not its parts alone or in a pair, not in a list or an option,
/// not with a short or a long id, not in the shape of the older script contexts.
test elapse_repayment_datum_is_exactly_the_output_reference(
  x via fuzz.both(amount(), fuzz.one_of(mangled_orefs())),
) fail {
  let (held, datum) = x
  main(
    elapsing(
      sponsored(usdm),
      held,
      repaying_with_datum(datum, held),
      [consumer],
    ),
    [elapse],
  )
}

/// The sponsor's payment key, but another stake key: not its address.
test elapse_repayment_needs_the_same_stake_credential(held via amount()) fail {
  main(
    elapsing(
      sponsored(usdm),
      held,
      repaying_at(
        Address {
          ..sponsor_address(),
          stake_credential: Some(Inline(VerificationKey(other_sponsor_key))),
        },
        held,
      ),
      [consumer],
    ),
    [elapse],
  )
}

/// Other addresses that share a part with the sponsor's.
fn near_misses() -> List<Address> {
  [
    Address { ..sponsor_address(), stake_credential: None },
    Address {
      ..sponsor_address(),
      stake_credential: Some(Inline(Script(sponsor_stake_key))),
    },
    Address {
      ..sponsor_address(),
      stake_credential: Some(
        Pointer { slot_number: 1, transaction_index: 2, certificate_index: 3 },
      ),
    },
    Address {
      ..sponsor_address(),
      payment_credential: VerificationKey(other_sponsor_key),
    },
    Address { ..sponsor_address(), payment_credential: Script(sponsor_key) },
    Address {
      payment_credential: VerificationKey(consumer),
      stake_credential: None,
    },
  ]
}

test elapse_repayment_needs_the_sponsors_address(
  x via fuzz.both(amount(), fuzz.one_of(near_misses())),
) fail {
  let (held, address) = x
  main(
    elapsing(sponsored(usdm), held, repaying_at(address, held), [consumer]),
    [elapse],
  )
}

/// The repayment is found among all the outputs, wherever it stands.
test elapse_repayment_may_stand_anywhere(
  x via fuzz.both(amount(), fuzz.int_between(0, 2)),
) {
  let (held, at) = x
  let others = [
    buyer_takes(held, reserve - floor),
    to(provider, assets.from_lovelace(5_000_000)),
  ]
  let outs = list.concat(
    list.take(others, at),
    [repayment(sponsor_address(), oref(0), floor), ..list.drop(others, at)],
  )
  main(elapsing(sponsored(usdm), held, outs, [consumer]), [elapse])
}

/// The repayment does not replace the consumer's signature.
test elapse_still_needs_the_consumer(held via amount()) fail {
  main(
    elapsing(sponsored(usdm), held, repaying(floor, held), [provider]),
    [elapse],
  )
}

// ---- R2: End repays the sponsor ---------------------------------------------------------------

test end_repays_the_sponsor(x via fuzz.both(amount(), repaid_in_full())) {
  let (held, paid) = x
  main(ending(sponsored(usdm), held, repaying(paid, held), [consumer]), [end])
}

test end_repays_exactly_the_floor() {
  main(
    ending(sponsored(usdm), 1_000, repaying(floor, 1_000), [consumer]),
    [end],
  )
}

test end_needs_a_repayment(held via amount()) fail {
  main(
    ending(sponsored(usdm), held, [buyer_takes(held, reserve)], [consumer]),
    [end],
  )
}

test end_one_below_the_floor_is_no_repayment() fail {
  main(
    ending(sponsored(usdm), 1_000, repaying(floor - 1, 1_000), [consumer]),
    [end],
  )
}

test end_repayment_with_a_tag_does_not_count(
  x via fuzz.both(amount(), fuzz.one_of([tag_1, vectors.tag_2])),
) fail {
  let (held, tag) = x
  main(
    ending(
      sponsored(usdm),
      held,
      repaying_with_datum(InlineDatum(tag), held),
      [consumer],
    ),
    [end],
  )
}

test end_repayment_with_another_output_reference_does_not_count(
  x via fuzz.both(
    amount(),
    fuzz.one_of([oref(1), oref(2), oref_of(other_txid, 0)]),
  ),
) fail {
  let (held, other) = x
  main(
    ending(
      sponsored(usdm),
      held,
      repaying_with_datum(InlineDatum(other), held),
      [consumer],
    ),
    [end],
  )
}

test end_repayment_needs_the_sponsors_address(
  x via fuzz.both(amount(), fuzz.one_of(near_misses())),
) fail {
  let (held, address) = x
  main(
    ending(sponsored(usdm), held, repaying_at(address, held), [consumer]),
    [end],
  )
}

// ---- R2: two channels, two repayments ---------------------------------------------------------

/// Two sponsored channels, `a` and `b` as they are, at `oref(0)` and `oref(1)`; the consumer ends
/// them in one transaction (`steps` at their stages), with these outputs.
fn ending_two(
  a: t.Constants,
  stage_a: t.Stage,
  b: t.Constants,
  stage_b: t.Stage,
  steps: t.Steps,
  outs: List<Output>,
) -> Bool {
  main(
    Transaction {
      ..tx(
        [
          input(0, channel(a, stage_a, tokens_and_ada(1_000, reserve))),
          input(1, channel(b, stage_b, tokens_and_ada(1_000, reserve))),
        ],
        outs,
        [consumer],
      ),
      validity_range: interval.after(2_000),
    },
    steps,
  )
}

fn closed() -> t.Stage {
  t.Closed { subbed: 7, elapse_at: 1_000 }
}

/// Channels with tags 1 and 2, both repaid at the sponsor's address.
fn pair_at(address: Address) -> (t.Constants, t.Constants) {
  (
    sponsored_tagged(tag_1, usdm, address),
    sponsored_tagged(vectors.tag_2, usdm, address),
  )
}

/// The repayments of the first and the second channel input, at the sponsor's address.
fn repays_first(lovelace: Int) -> Output {
  repayment(sponsor_address(), oref(0), lovelace)
}

fn repays_second(lovelace: Int) -> Output {
  repayment(sponsor_address(), oref(1), lovelace)
}

/// The old scheme's repayment: a tag for its datum, which counts for nothing.
fn repays_a_tag(tag: ByteArray, lovelace: Int) -> Output {
  Output { ..repays_first(lovelace), datum: InlineDatum(tag) }
}

/// The names that the same indexes have in another transaction.
fn repays_elsewhere(index: Int) -> Output {
  repayment(sponsor_address(), oref_of(other_txid, index), floor)
}

fn buyer_takes_both() -> Output {
  buyer_takes(2_000, 2 * ( reserve - floor ))
}

test two_channels_with_an_output_each() {
  let (a, b) = pair_at(sponsor_address())
  ending_two(
    a,
    closed(),
    b,
    closed(),
    [elapse, elapse],
    [repays_first(floor), repays_second(floor), buyer_takes_both()],
  )
}

test two_channels_with_their_outputs_in_the_other_order() {
  let (a, b) = pair_at(sponsor_address())
  ending_two(
    a,
    closed(),
    b,
    closed(),
    [elapse, elapse],
    [buyer_takes_both(), repays_second(floor), repays_first(floor)],
  )
}

/// Outputs that leave one of two channels unrepaid: one output for one of them, however much it
/// holds; or two, for the same one. And outputs that repay neither: the old scheme's, which name
/// the channels' tags; or the names of two inputs of another transaction, at the same indexes.
fn one_short() -> List<List<Output>> {
  [
    [repays_first(floor)],
    [repays_second(floor)],
    [repays_first(2 * floor)],
    [repays_second(2 * floor)],
    [repays_first(2 * floor), buyer_takes_both()],
    [repays_first(floor), repays_first(floor)],
    [repays_second(floor), repays_second(floor)],
    [repays_a_tag(tag_1, floor)],
    [repays_a_tag(tag_1, 2 * floor)],
    [repays_a_tag(tag_1, floor), repays_a_tag(vectors.tag_2, floor)],
    [repays_elsewhere(0), repays_elsewhere(1)],
  ]
}

/// One address, one output for one channel, however much it holds: the other channel is not
/// repaid. Nor is it by a second output for the same one.
test two_channels_need_an_output_each(outs via fuzz.one_of(one_short())) fail {
  let (a, b) = pair_at(sponsor_address())
  ending_two(a, closed(), b, closed(), [elapse, elapse], outs)
}

/// An End and an Elapse in one transaction each need their own.
test an_end_and_an_elapse_with_an_output_each() {
  let (a, b) = pair_at(sponsor_address())
  ending_two(
    a,
    t.Settled,
    b,
    closed(),
    [end, elapse],
    [repays_first(floor), repays_second(floor), buyer_takes_both()],
  )
}

test an_end_and_an_elapse_need_an_output_each(
  outs via fuzz.one_of(one_short()),
) fail {
  let (a, b) = pair_at(sponsor_address())
  ending_two(a, t.Settled, b, closed(), [end, elapse], outs)
}

fn other_sponsor_address() -> Address {
  Address {
    payment_credential: VerificationKey(other_sponsor_key),
    stake_credential: None,
  }
}

/// Two sponsors: each channel is repaid at its own.
test two_sponsors_each_get_their_own() {
  let a = sponsored_tagged(tag_1, usdm, sponsor_address())
  let b = sponsored_tagged(vectors.tag_2, usdm, other_sponsor_address())
  ending_two(
    a,
    closed(),
    b,
    closed(),
    [elapse, elapse],
    [
      repayment(sponsor_address(), oref(0), floor),
      repayment(other_sponsor_address(), oref(1), floor),
      buyer_takes_both(),
    ],
  )
}

/// Right output references, at each other's sponsors.
test two_sponsors_are_not_interchangeable() fail {
  let a = sponsored_tagged(tag_1, usdm, sponsor_address())
  let b = sponsored_tagged(vectors.tag_2, usdm, other_sponsor_address())
  ending_two(
    a,
    closed(),
    b,
    closed(),
    [elapse, elapse],
    [
      repayment(other_sponsor_address(), oref(0), floor),
      repayment(sponsor_address(), oref(1), floor),
      buyer_takes_both(),
    ],
  )
}

/// Tags are not unique on chain (the opening runs no script), so two channels can have one tag, and
/// one sponsor. A repayment names the input that ends, which is unique, so each of the two needs
/// its own output. (When a repayment named the tag, one output served both.)
test channels_with_one_tag_need_an_output_each() {
  let a = sponsored_tagged(tag_1, usdm, sponsor_address())
  ending_two(
    a,
    closed(),
    a,
    closed(),
    [elapse, elapse],
    [repays_first(floor), repays_second(floor), buyer_takes_both()],
  )
}

test channels_with_one_tag_do_not_share_a_repayment(
  outs via fuzz.one_of(one_short()),
) fail {
  let a = sponsored_tagged(tag_1, usdm, sponsor_address())
  ending_two(a, closed(), a, closed(), [elapse, elapse], outs)
}

/// A channel that nobody sponsors asks for nothing, beside one that does.
test an_unsponsored_channel_needs_no_repayment_beside_a_sponsored_one() {
  let (_, b) = pair_at(sponsor_address())
  ending_two(
    constants(usdm),
    closed(),
    b,
    closed(),
    [elapse, elapse],
    [repays_second(floor), buyer_takes_both()],
  )
}

test a_sponsored_channel_needs_its_repayment_beside_an_unsponsored_one() fail {
  let (_, b) = pair_at(sponsor_address())
  ending_two(
    constants(usdm),
    closed(),
    b,
    closed(),
    [elapse, elapse],
    [buyer_takes_both()],
  )
}

/// A repayment names the id of the transaction its input is an output of, as well as the index:
/// here the second channel is an output of another transaction, whatever its index.
test a_repayment_names_the_transaction_of_its_input(
  index via fuzz.int_between(0, 1_000),
) {
  let (a, b) = pair_at(sponsor_address())
  let second = oref_of(other_txid, index)
  main(
    Transaction {
      ..tx(
        [
          input(0, channel(a, closed(), tokens_and_ada(1_000, reserve))),
          input_at(second, channel(b, closed(), tokens_and_ada(1_000, reserve))),
        ],
        [
          repays_first(floor),
          repayment(sponsor_address(), second, floor),
          buyer_takes_both(),
        ],
        [consumer],
      ),
      validity_range: interval.after(2_000),
    },
    [elapse, elapse],
  )
}

// ---- R2 reads all the outputs, not what the continuing steps have left of them ----------------

/// An Add on channel A and an Elapse on channel B, A's input first. The Add's search for A's
/// continuing output goes past (and consumes) whatever stands before it, a repayment included; the
/// Elapse still finds B's repayment, wherever that stands.
test a_repayment_may_stand_before_the_continuing_outputs(before via fuzz.bool()) {
  let (a, b) = pair_at(sponsor_address())
  let continuing = channel(
    a,
    t.Opened { subbed: 0 },
    tokens_and_ada(1_500, reserve),
  )
  let repays = repays_second(floor)
  let outs = if before {
    [repays, continuing, buyer_takes(1_000, reserve - floor)]
  } else {
    [continuing, repays, buyer_takes(1_000, reserve - floor)]
  }
  main(
    Transaction {
      ..tx(
        [
          input(
            0,
            channel(a, t.Opened { subbed: 0 }, tokens_and_ada(1_000, reserve)),
          ),
          input(1, channel(b, closed(), tokens_and_ada(1_000, reserve))),
        ],
        outs,
        [consumer],
      ),
      validity_range: interval.after(2_000),
    },
    [add, elapse],
  )
}

/// The Add's continuing output is not a repayment: with none for B, the Elapse fails.
test an_add_does_not_repay_the_channel_that_elapses(before via fuzz.bool()) fail {
  let (a, b) = pair_at(sponsor_address())
  let continuing = channel(
    a,
    t.Opened { subbed: 0 },
    tokens_and_ada(1_500, reserve),
  )
  let outs = if before {
    [continuing, buyer_takes(1_000, reserve - floor)]
  } else {
    [buyer_takes(1_000, reserve - floor), continuing]
  }
  main(
    Transaction {
      ..tx(
        [
          input(
            0,
            channel(a, t.Opened { subbed: 0 }, tokens_and_ada(1_000, reserve)),
          ),
          input(1, channel(b, closed(), tokens_and_ada(1_000, reserve))),
        ],
        outs,
        [consumer],
      ),
      validity_range: interval.after(2_000),
    },
    [add, elapse],
  )
}

// ---- R3: who ends an empty channel ------------------------------------------------------------

/// An empty settled channel gives the consumer nothing: the provider ends it, and the sponsor
/// gets its reserve back.
test end_of_an_empty_channel_by_the_provider() {
  main(ending(sponsored(usdm), 0, repaying(floor, 0), [provider]), [end])
}

test end_of_an_empty_channel_by_both() {
  main(
    ending(sponsored(usdm), 0, repaying(floor, 0), [consumer, provider]),
    [end],
  )
}

test end_of_an_empty_channel_needs_the_provider() fail {
  main(ending(sponsored(usdm), 0, repaying(floor, 0), [consumer]), [end])
}

test end_of_a_funded_channel_needs_the_consumer(held via amount()) fail {
  main(ending(sponsored(usdm), held, repaying(floor, held), [provider]), [end])
}

/// The provider's End still repays the sponsor.
test end_of_an_empty_channel_still_repays(paid via below_the_floor()) fail {
  main(ending(sponsored(usdm), 0, repaying(paid, 0), [provider]), [end])
}

test end_of_an_empty_channel_without_a_repayment() fail {
  main(ending(sponsored(usdm), 0, [buyer_takes(0, reserve)], [provider]), [end])
}

/// R3 is for End: an empty Closed channel is still the consumer's to elapse.
test elapse_of_an_empty_channel_by_the_consumer() {
  main(elapsing(sponsored(usdm), 0, repaying(floor, 0), [consumer]), [elapse])
}

test elapse_of_an_empty_channel_needs_the_consumer() fail {
  main(elapsing(sponsored(usdm), 0, repaying(floor, 0), [provider]), [elapse])
}

/// R3 is for sponsored channels: with no sponsor, as upstream, the consumer ends an empty one.
test end_of_an_empty_unsponsored_channel_by_the_consumer() {
  main(ending(constants(usdm), 0, [buyer_takes(0, reserve)], [consumer]), [end])
}

test end_of_an_empty_unsponsored_channel_needs_the_consumer() fail {
  main(ending(constants(usdm), 0, [buyer_takes(0, reserve)], [provider]), [end])
}

// ---- the steps, one shape each, for R0 and R1 -------------------------------------------------

type Shape {
  Adding
  Subbing
  Closing
  Settling
  Ending
  Elapsing
}

fn any_shape() -> Fuzzer<Shape> {
  fuzz.one_of([Adding, Subbing, Closing, Settling, Ending, Elapsing])
}

/// What a channel `c` holds: `n` of its currency, and, for a token, `lovelace` of ADA beside it.
/// (An ADA channel's amount is its lovelace.)
fn holds(c: t.Constants, n: Int, lovelace: Int) -> Value {
  let (_tag, currency, _key, _consumer, _provider, _period, _sponsor) = c
  when currency is {
    t.Ada -> assets.from_lovelace(n)
    t.Asset { .. } -> tokens_and_ada(n, lovelace)
  }
}

/// A correct step of `shape` on a channel with constants `c`, run as the ledger would run it. The
/// ADA it hands on is `lovelace`: what the continuing output of a token channel holds, or what
/// repays the sponsor at an ending (at `sponsor_address()`, naming the channel input, `oref(0)`,
/// whatever `c` names). An ADA channel's amounts are lovelace, 5 ADA, and `lovelace` is for the
/// repayment alone. The one thing that ought to make it fail is what the test changes: `c`, or
/// `lovelace`.
fn doing(shape: Shape, c: t.Constants, lovelace: Int) -> Bool {
  when shape is {
    Adding ->
      main(
        tx(
          [
            input(
              0,
              channel(c, t.Opened { subbed: 0 }, holds(c, 5_000_000, reserve)),
            ),
          ],
          [channel(c, t.Opened { subbed: 0 }, holds(c, 6_000_000, lovelace))],
          [consumer],
        ),
        [add],
      )
    Subbing ->
      main(
        tx(
          [
            input(
              0,
              channel(c, t.Opened { subbed: 0 }, holds(c, 6_000_000, reserve)),
            ),
          ],
          [
            channel(
              c,
              t.Opened { subbed: 1_000_000 },
              holds(c, 5_000_000, lovelace),
            ),
            to(provider, holds(c, 1_000_000, reserve - lovelace)),
          ],
          [provider],
        ),
        [sub(5_000_000, iou(5_000_000))],
      )
    Closing ->
      main(
        Transaction {
          ..tx(
            [
              input(
                0,
                channel(c, t.Opened { subbed: 0 }, holds(c, 5_000_000, reserve)),
              ),
            ],
            [
              channel(
                c,
                t.Closed {
                  subbed: 0,
                  elapse_at: 1_000_000 + vectors.close_period,
                },
                holds(c, 5_000_000, lovelace),
              ),
            ],
            [consumer],
          ),
          validity_range: interval.before(1_000_000),
        },
        [close],
      )
    Settling ->
      main(
        tx(
          [
            input(
              0,
              channel(
                c,
                t.Closed { subbed: 0, elapse_at: 1_000_000 },
                holds(c, 6_000_000, reserve),
              ),
            ),
          ],
          [
            channel(c, t.Settled, holds(c, 5_000_000, lovelace)),
            to(provider, holds(c, 1_000_000, reserve - lovelace)),
          ],
          [provider],
        ),
        [settle(5_000_000, iou(5_000_000))],
      )
    Ending ->
      main(
        tx(
          [input(0, channel(c, t.Settled, holds(c, 5_000_000, reserve)))],
          [
            repayment(sponsor_address(), oref(0), lovelace),
            to(consumer, holds(c, 5_000_000, reserve - lovelace)),
          ],
          [consumer],
        ),
        [end],
      )
    Elapsing ->
      main(
        Transaction {
          ..tx(
            [
              input(
                0,
                channel(
                  c,
                  t.Closed { subbed: 7, elapse_at: 1_000 },
                  holds(c, 5_000_000, reserve),
                ),
              ),
            ],
            [
              repayment(sponsor_address(), oref(0), lovelace),
              to(consumer, holds(c, 5_000_000, reserve - lovelace)),
            ],
            [consumer],
          ),
          validity_range: interval.after(2_000),
        },
        [elapse],
      )
  }
}

// ---- R1: a continuing output keeps the floor --------------------------------------------------

test add_keeps_the_floor() {
  doing(Adding, sponsored(usdm), floor)
}

test add_one_below_the_floor() fail {
  doing(Adding, sponsored(usdm), floor - 1)
}

test sub_keeps_the_floor() {
  doing(Subbing, sponsored(usdm), floor)
}

test sub_one_below_the_floor() fail {
  doing(Subbing, sponsored(usdm), floor - 1)
}

test close_keeps_the_floor() {
  doing(Closing, sponsored(usdm), floor)
}

test close_one_below_the_floor() fail {
  doing(Closing, sponsored(usdm), floor - 1)
}

test settle_keeps_the_floor() {
  doing(Settling, sponsored(usdm), floor)
}

test settle_one_below_the_floor() fail {
  doing(Settling, sponsored(usdm), floor - 1)
}

/// Every step passes with the floor or more in its continuing output, or at an ending in its
/// repayment; and fails with less.
test every_step_passes_at_or_above_the_floor(
  x via fuzz.both(any_shape(), fuzz.int_between(floor, reserve)),
) {
  let (shape, lovelace) = x
  doing(shape, sponsored(usdm), lovelace)
}

test every_step_fails_below_the_floor(
  x via fuzz.both(any_shape(), below_the_floor()),
) fail {
  let (shape, lovelace) = x
  doing(shape, sponsored(usdm), lovelace)
}

/// The floor is the datum's, whatever it is: held exactly passes, one short fails.
test the_floor_is_the_datums(
  x via fuzz.both(any_shape(), fuzz.int_between(2, reserve)),
) {
  let (shape, at_least) = x
  doing(
    shape,
    with_sponsor(constants(usdm), Some((sponsor_address(), at_least))),
    at_least,
  )
}

test one_short_of_the_datums_floor_fails(
  x via fuzz.both(any_shape(), fuzz.int_between(2, reserve)),
) fail {
  let (shape, at_least) = x
  doing(
    shape,
    with_sponsor(constants(usdm), Some((sponsor_address(), at_least))),
    at_least - 1,
  )
}

/// Without a sponsor there is no floor: the same steps pass with next to nothing held.
test no_sponsor_no_floor(
  x via fuzz.both(any_shape(), fuzz.int_between(1, reserve)),
) {
  let (shape, lovelace) = x
  doing(shape, constants(usdm), lovelace)
}

// ---- R0: a sponsored channel carries a token --------------------------------------------------

test sponsored_ada_add_fails() fail {
  doing(Adding, sponsored(t.Ada), floor)
}

test sponsored_ada_sub_fails() fail {
  doing(Subbing, sponsored(t.Ada), floor)
}

test sponsored_ada_close_fails() fail {
  doing(Closing, sponsored(t.Ada), floor)
}

test sponsored_ada_settle_fails() fail {
  doing(Settling, sponsored(t.Ada), floor)
}

test sponsored_ada_end_fails() fail {
  doing(Ending, sponsored(t.Ada), floor)
}

test sponsored_ada_elapse_fails() fail {
  doing(Elapsing, sponsored(t.Ada), floor)
}

/// The same transactions on an ADA channel with no sponsor are upstream's, and pass: it is the
/// sponsor that they fail on.
test unsponsored_ada_steps_pass(shape via any_shape()) {
  doing(shape, constants(t.Ada), floor)
}

// ---- the sponsor is part of the constants, and constants do not change ------------------------

/// An Add on a sponsored channel whose continuing datum names `sponsor`.
fn adding_with_sponsor(sponsor: Option<t.Sponsor>) -> Bool {
  let c = sponsored(usdm)
  main(
    tx(
      [
        input(
          0,
          channel(c, t.Opened { subbed: 0 }, tokens_and_ada(1_000, reserve)),
        ),
      ],
      [
        channel(
          with_sponsor(c, sponsor),
          t.Opened { subbed: 0 },
          tokens_and_ada(1_500, reserve),
        ),
      ],
      [consumer],
    ),
    [add],
  )
}

test continuing_output_may_name_the_same_sponsor() {
  adding_with_sponsor(Some((sponsor_address(), floor)))
}

/// Sponsors that are not the channel's: none at all, another address, another floor.
fn other_sponsors() -> List<Option<t.Sponsor>> {
  [
    None,
    Some((other_sponsor_address(), floor)),
    Some((Address { ..sponsor_address(), stake_credential: None }, floor)),
    Some((sponsor_address(), floor - 1)),
    Some((sponsor_address(), floor + 1)),
    Some((sponsor_address(), 0)),
  ]
}

/// No other sponsor, another floor, or none at all: the buyer cannot send the reserve elsewhere
/// or ask less of it by rewriting the datum on the way.
test continuing_output_keeps_the_sponsor(
  sponsor via fuzz.one_of(other_sponsors()),
) fail {
  adding_with_sponsor(sponsor)
}

// ---- a floor of nothing -----------------------------------------------------------------------

/// A sponsor that asks for no ADA back (a floor of 0 or less) still has its output asked for: the
/// floor is how much, not whether. Opening is where a sponsor refuses such a datum.
test a_floor_of_nothing_still_needs_the_repayment_output(
  floor_ via fuzz.one_of([0, -1, -1_000_000]),
) {
  main(
    ending(
      with_sponsor(constants(usdm), Some((sponsor_address(), floor_))),
      1_000,
      [
        repayment(sponsor_address(), oref(0), 1),
        buyer_takes(1_000, reserve - 1),
      ],
      [consumer],
    ),
    [end],
  )
}

test a_floor_of_nothing_is_not_no_output(
  floor_ via fuzz.one_of([0, -1, -1_000_000]),
) fail {
  main(
    ending(
      with_sponsor(constants(usdm), Some((sponsor_address(), floor_))),
      1_000,
      [buyer_takes(1_000, reserve)],
      [consumer],
    ),
    [end],
  )
}

// ---- the signers of a batch -------------------------------------------------------------------

/// The provider ends an empty channel and the consumer adds to another, in one transaction. The
/// signers come in descending order (provider 22.., consumer 11..), which upstream's
/// `ordered_insert` refused: R3 makes the provider's End a case that the fix is needed for.
test an_empty_end_and_an_add_in_one_batch() {
  let (a, b) = pair_at(sponsor_address())
  main(
    tx(
      [
        input(0, channel(a, t.Settled, tokens_and_ada(0, reserve))),
        input(
          1,
          channel(b, t.Opened { subbed: 0 }, tokens_and_ada(1_000, reserve)),
        ),
      ],
      [
        repays_first(floor),
        channel(b, t.Opened { subbed: 0 }, tokens_and_ada(1_500, reserve)),
        buyer_takes(0, reserve - floor),
      ],
      [provider, consumer],
    ),
    [end, add],
  )
}

test an_empty_end_in_a_batch_still_needs_the_provider() fail {
  let (a, b) = pair_at(sponsor_address())
  main(
    tx(
      [
        input(0, channel(a, t.Settled, tokens_and_ada(0, reserve))),
        input(
          1,
          channel(b, t.Opened { subbed: 0 }, tokens_and_ada(1_000, reserve)),
        ),
      ],
      [
        repays_first(floor),
        channel(b, t.Opened { subbed: 0 }, tokens_and_ada(1_500, reserve)),
        buyer_takes(0, reserve - floor),
      ],
      [consumer],
    ),
    [end, add],
  )
}

// ---- a sponsored channel's whole life -----------------------------------------------------------

/// The ADA the sponsor put in, for a buyer that can exit alone: the floor, two fees of 0.25 ADA
/// and a token output of 1.18 ADA need 2.88 ADA, and the sponsor puts in 3.3.
const funded: Int = 3_300_000

const fee: Int = 250_000

/// Opened, closed by the consumer on the channel's own ADA (the fee comes out of it, the floor
/// stays), elapsed by the consumer after the close period, the sponsor repaid: the buyer's exit
/// without the server, the case the variant is for.
test the_buyer_exits_alone_on_its_allowance() {
  let c = sponsored(usdm)
  let closed_at = 1_000_000
  let elapse_at = closed_at + vectors.close_period
  let after_close = channel(
    c,
    t.Closed { subbed: 0, elapse_at },
    tokens_and_ada(1_000, funded - fee),
  )
  and {
    main(
      Transaction {
        ..tx(
          [
            input(
              0,
              channel(c, t.Opened { subbed: 0 }, tokens_and_ada(1_000, funded)),
            ),
          ],
          [after_close],
          [consumer],
        ),
        validity_range: interval.before(closed_at),
      },
      [close],
    ),
    main(
      Transaction {
        ..tx(
          [input(0, after_close)],
          [
            repayment(sponsor_address(), oref(0), floor),
            buyer_takes(1_000, funded - fee - floor - fee),
          ],
          [consumer],
        ),
        validity_range: interval.after(elapse_at),
      },
      [elapse],
    ),
  }
}

/// The same, but the buyer takes the whole channel at the Elapse, as upstream lets it.
test the_buyer_cannot_keep_the_reserve_on_exiting_alone() fail {
  let c = sponsored(usdm)
  let closed_at = 1_000_000
  let elapse_at = closed_at + vectors.close_period
  let after_close = channel(
    c,
    t.Closed { subbed: 0, elapse_at },
    tokens_and_ada(1_000, funded - fee),
  )
  main(
    Transaction {
      ..tx(
        [input(0, after_close)],
        [buyer_takes(1_000, funded - fee - fee)],
        [consumer],
      ),
      validity_range: interval.after(elapse_at),
    },
    [elapse],
  )
}

/// The cooperative life: a sub by the provider, the consumer's close, the provider's settle, then
/// the consumer ends it with what is left, repaying the sponsor.
test the_cooperative_life_ends_with_the_sponsor_repaid() {
  let c = sponsored(usdm)
  let closed_at = 1_000_000
  let opened = channel(
    c,
    t.Opened { subbed: 0 },
    tokens_and_ada(10_000, funded),
  )
  let subbed = channel(
    c,
    t.Opened { subbed: 1_000 },
    tokens_and_ada(9_000, funded),
  )
  let closed = channel(
    c,
    t.Closed { subbed: 1_000, elapse_at: closed_at + vectors.close_period },
    tokens_and_ada(9_000, funded - fee),
  )
  let settled = channel(c, t.Settled, tokens_and_ada(7_000, funded - fee))
  and {
    main(
      tx(
        [input(0, opened)],
        [subbed, to(provider, tokens_and_ada(1_000, 0))],
        [provider],
      ),
      [sub(5_000_000, iou(5_000_000))],
    ),
    main(
      Transaction {
        ..tx([input(0, subbed)], [closed], [consumer]),
        validity_range: interval.before(closed_at),
      },
      [close],
    ),
    main(
      tx(
        [input(0, closed)],
        [settled, to(provider, tokens_and_ada(2_000, 0))],
        [provider],
      ),
      [settle(5_000_000, iou(5_000_000))],
    ),
    main(
      tx(
        [input(0, settled)],
        [
          repayment(sponsor_address(), oref(0), floor),
          buyer_takes(7_000, funded - fee - floor - fee),
        ],
        [consumer],
      ),
      [end],
    ),
  }
}

/// And when the provider's settle takes every token, the consumer has nothing to end it for:
/// the provider does, and takes the sponsor's reserve back.
test the_provider_ends_a_channel_it_has_emptied() {
  let c = sponsored(usdm)
  let closed = channel(
    c,
    t.Closed { subbed: 0, elapse_at: 1_000_000 },
    tokens_and_ada(500, funded),
  )
  let settled = channel(c, t.Settled, tokens_and_ada(0, funded))
  and {
    main(
      tx(
        [input(0, closed)],
        [settled, to(provider, tokens_and_ada(500, 0))],
        [provider],
      ),
      [settle(5_000_000, iou(5_000_000))],
    ),
    main(
      tx(
        [input(0, settled)],
        [
          repayment(sponsor_address(), oref(0), floor),
          to(provider, assets.from_lovelace(funded - floor - fee)),
        ],
        [provider],
      ),
      [end],
    ),
  }
}

// ---- Mutual is unchanged ----------------------------------------------------------------------

/// A mutual spend of a sponsored channel: both sign, and no repayment is asked for.
fn splitting(
  c: t.Constants,
  stage: t.Stage,
  held: Int,
  signers: List<ByteArray>,
) -> Bool {
  run(
    tx(
      [input(0, channel(c, stage, holds(c, held, reserve)))],
      [to(consumer, holds(c, held, reserve))],
      signers,
    ),
    [t.Mutual],
  )
}

fn any_stage() -> Fuzzer<t.Stage> {
  fuzz.one_of(
    [t.Opened { subbed: 3 }, t.Closed { subbed: 3, elapse_at: 9 }, t.Settled],
  )
}

test mutual_on_a_sponsored_channel_needs_no_repayment(
  x via fuzz.both(any_stage(), amount()),
) {
  let (stage, held) = x
  splitting(sponsored(usdm), stage, held, [consumer, provider])
}

test mutual_on_a_sponsored_channel_needs_both(
  x via fuzz.tuple3(any_stage(), amount(), fuzz.bool()),
) fail {
  let (stage, held, consumer_signs) = x
  splitting(
    sponsored(usdm),
    stage,
    held,
    if consumer_signs {
      [consumer]
    } else {
      [provider]
    },
  )
}

/// R0 is for Main's steps: Mutual spends a sponsored ADA channel as any other.
test mutual_on_a_sponsored_ada_channel(x via fuzz.both(any_stage(), amount())) {
  let (stage, held) = x
  splitting(sponsored(t.Ada), stage, held, [consumer, provider])
}

// ---- upstream's datum, at this validator --------------------------------------------------------

/// A channel at this validator's address whose datum has `constants_data` for its constants.
fn channel_with_constants(constants_data: Data) -> Output {
  let d: Data = (fixture.own_hash, constants_data, t.Opened { subbed: 0 })
  Output {
    ..channel(
      constants(usdm),
      t.Opened { subbed: 0 },
      tokens_and_ada(1_000, reserve),
    ),
    datum: InlineDatum(d),
  }
}

/// Upstream's six constants, in a datum at this validator.
fn six_constants() -> Data {
  let (tag, currency, iou_key, cons, prov, period, _) = constants(usdm)
  let six: Data = (tag, currency, iou_key, cons, prov, period)
  six
}

fn seven_constants() -> Data {
  let seven: Data = constants(usdm)
  seven
}

/// Reads a channel input as every step does: `io.yield_in` finds it and reads its datum, then the
/// step takes the seven constants apart.
fn reads_as_a_channel(channel_in: Output) -> Bool {
  let _delegation, _value, c, _stage, _oref, _inputs <- io.yield_in(
    Script(fixture.own_hash),
    [input(0, channel_in)],
  )
  let (_tag, _currency, _key, _consumer, _provider, _period, _sponsor) = c
  True
}

/// `io.yield_in` hands back the output reference of the channel input that it finds: not that of an
/// input before it, nor of one after.
test yield_in_hands_back_the_channels_own_output_reference(
  index via fuzz.int_between(0, 1_000),
) {
  let c = channel(
    constants(usdm),
    t.Opened { subbed: 0 },
    tokens_and_ada(1_000, reserve),
  )
  let inputs = [
    input(0, to(consumer, assets.from_lovelace(5_000_000))),
    input_at(oref_of(other_txid, index), c),
    input_at(oref_of(other_txid, index + 1), c),
  ]
  let _delegation, _value, _c, _stage, own_oref, rest <- io.yield_in(
    Script(fixture.own_hash),
    inputs,
  )
  and {
    own_oref == oref_of(other_txid, index),
    list.length(rest) == 1,
  }
}

test a_datum_with_seven_constants_is_read() {
  reads_as_a_channel(channel_with_constants(seven_constants()))
}

/// A channel opened by a client that writes upstream's six constants cannot be read, so no step
/// can spend it. (Mutual reads them the same way, in the validator's datum argument.)
test a_datum_with_six_constants_is_not_read() fail {
  reads_as_a_channel(channel_with_constants(six_constants()))
}

// ---- the repayment's datum on the wire ---------------------------------------------------------

/// The repayment's datum, written out by hand from the encoding of Plutus data: an output
/// reference is `Constr 0 [B txid, I index]`, `d8799f 5820<txid> <index> ff`, with the 32 bytes of
/// the id bare (as in a V3 script context, not wrapped as in V1 and V2) and the index as CBOR
/// writes an integer, in the least width: 0 to 23 in a byte, then `18` and a byte, `19` and two,
/// `1a` and four. (index, the datum for `oref(index)`.)
const repayment_datums: List<(Int, ByteArray)> =
  [
    (
      0,
      #"d8799f5820cafecafecafecafecafecafecafecafecafecafecafecafecafecafecafecafe00ff",
    ),
    (
      1,
      #"d8799f5820cafecafecafecafecafecafecafecafecafecafecafecafecafecafecafecafe01ff",
    ),
    (
      23,
      #"d8799f5820cafecafecafecafecafecafecafecafecafecafecafecafecafecafecafecafe17ff",
    ),
    (
      24,
      #"d8799f5820cafecafecafecafecafecafecafecafecafecafecafecafecafecafecafecafe1818ff",
    ),
    (
      255,
      #"d8799f5820cafecafecafecafecafecafecafecafecafecafecafecafecafecafecafecafe18ffff",
    ),
    (
      256,
      #"d8799f5820cafecafecafecafecafecafecafecafecafecafecafecafecafecafecafecafe190100ff",
    ),
    (
      65535,
      #"d8799f5820cafecafecafecafecafecafecafecafecafecafecafecafecafecafecafecafe19ffffff",
    ),
    (
      65536,
      #"d8799f5820cafecafecafecafecafecafecafecafecafecafecafecafecafecafecafecafe1a00010000ff",
    ),
  ]

test the_repayment_datum_on_the_wire() {
  list.all(
    repayment_datums,
    fn(v) {
      let (index, bytes) = v
      let datum: Data = oref(index)
      and {
        cbor.serialise(datum) == bytes,
        cbor.deserialise(bytes) == Some(datum),
      }
    },
  )
}

// ---- the datum on the wire --------------------------------------------------------------------

/// An opened token channel's datum with a sponsor, written out by hand from the encoding of
/// Plutus data (the client does not write a sponsor yet, so this is not its output): the 7th
/// constant is `Some((address, floor))`, `d8799f 9f <address> <floor> ff ff`, an address being
/// `d8799f <payment> <stake> ff`, a key credential `d8799f 581c<hash> ff`, a stake credential
/// `Some(Inline(credential))`, `d8799f d8799f <credential> ff ff`. The floor is 1,200,000, `1a00124f80`.
const datum_opened_sponsored: ByteArray =
  #"9f581c62ce4309e37e09e5c633c96c6ae68061c434f122d32626d6912d7c2a9f582093cb371e45196099b32344fcf2f2facad64841df54158df5e2a33066131dfd96d87a9f581c33333333333333333333333333333333333333333333333333333333445553444dff58208a88e3dd7409f195fd52db2d3cba5d72ca6709bf1d94121bf3748801b40f6f5c581c11111111111111111111111111111111111111111111111111111111581c222222222222222222222222222222222222222222222222222222221a0036ee80d8799f9fd8799fd8799f581c66666666666666666666666666666666666666666666666666666666ffd8799fd8799fd8799f581c77777777777777777777777777777777777777777777777777777777ffffffff1a00124f80ffffffd8799f1a002625a0ffff"

test the_datum_with_a_sponsor_decodes() {
  let expected: Data = fixture.datum(
    sponsored(usdm),
    t.Opened { subbed: 2_500_000 },
  )
  cbor.deserialise(datum_opened_sponsored) == Some(expected)
}
