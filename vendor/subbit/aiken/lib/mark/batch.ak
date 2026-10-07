//// Batches (ADR batching.md, l1-spec.md "Batch tx"): the first channel input carries
//// `Main(steps)` for every channel in the transaction, the others `Defer`; inputs, steps and
//// continuing outputs pair up in order. Includes a defect that 66648db had and this copy has fixed:
//// see "signers come in descending order" below.

use aiken/collection/list
use aiken/fuzz
use aiken/primitive/bytearray
use cardano/assets
use cardano/transaction.{InlineDatum, Output}
use extra/xlist
use mark/fixture.{
  add, channel, constants, consumer, funds, input, main, provider, run, settle,
  sub, tagged, to, tx,
}
use mark/vectors
use subbit/types as t

/// Channel `i` of a batch, with its own tag; `iou(i)` is key A's IOU of 5 ADA for that tag.
fn member(i: Int, stage: t.Stage, held: Int) -> Output {
  expect Some((tag, _)) = list.at(vectors.batch_ious, i)
  channel(tagged(tag, t.Ada), stage, funds(t.Ada, held))
}

fn iou(i: Int) -> ByteArray {
  expect Some((_, sig)) = list.at(vectors.batch_ious, i)
  sig
}

/// The spec's example: three subs and a settle in one transaction, by the provider.
test spec_batch_three_subs_and_a_settle() {
  main(
    tx(
      [
        input(0, member(0, t.Opened { subbed: 0 }, 10_000_000)),
        input(1, member(1, t.Opened { subbed: 1_000_000 }, 10_000_000)),
        input(2, member(2, t.Opened { subbed: 0 }, 10_000_000)),
        input(
          3,
          member(3, t.Closed { subbed: 0, elapse_at: 1_000_000 }, 10_000_000),
        ),
      ],
      [
        member(0, t.Opened { subbed: 5_000_000 }, 5_000_000),
        member(1, t.Opened { subbed: 5_000_000 }, 6_000_000),
        member(2, t.Opened { subbed: 2_000_000 }, 8_000_000),
        member(3, t.Settled, 5_000_000),
        to(provider, assets.from_lovelace(16_000_000)),
      ],
      [provider],
    ),
    [
      sub(5_000_000, iou(0)),
      sub(5_000_000, iou(1)),
      sub(5_000_000, iou(2)),
      settle(5_000_000, iou(3)),
    ],
  )
}

/// One to four channels, each subbed within its IOU, in one transaction.
test batch_of_subs(
  takes via fuzz.list_between(fuzz.int_between(0, 5_000_000), 1, 4),
) {
  let ins =
    list.indexed_map(
      takes,
      fn(i, _) { input(i, member(i, t.Opened { subbed: 0 }, 5_000_001)) },
    )
  let outs =
    list.indexed_map(
      takes,
      fn(i, take) { member(i, t.Opened { subbed: take }, 5_000_001 - take) },
    )
  let steps = list.indexed_map(takes, fn(i, _) { sub(5_000_000, iou(i)) })
  main(tx(ins, outs, [provider]), steps)
}

/// Two channels, each subbed by 1 ADA; the redeemers are the test's.
fn pair_of_subs() -> t.Steps {
  [sub(5_000_000, iou(0)), sub(5_000_000, iou(1))]
}

fn two_channels(outs: List<Output>) {
  tx(
    [
      input(0, member(0, t.Opened { subbed: 0 }, 10_000_000)),
      input(1, member(1, t.Opened { subbed: 0 }, 10_000_000)),
    ],
    outs,
    [provider],
  )
}

fn both_subbed() -> List<Output> {
  [
    member(0, t.Opened { subbed: 1_000_000 }, 9_000_000),
    member(1, t.Opened { subbed: 1_000_000 }, 9_000_000),
  ]
}

test two_subs_with_main_and_defer() {
  run(two_channels(both_subbed()), [t.Main(pair_of_subs()), t.Defer])
}

/// Every channel input deferring: the first finds that it is the main input itself.
test defer_needs_a_main() fail {
  run(two_channels(both_subbed()), [t.Defer, t.Defer])
}

/// Main on the second input: the first's Defer finds it is the main input.
test main_must_be_the_first_channel() fail {
  run(two_channels(both_subbed()), [t.Defer, t.Main(pair_of_subs())])
}

/// A channel input with no step: without this check it would leave on a Defer alone.
test main_covers_every_channel() fail {
  run(
    two_channels(
      [
        member(0, t.Opened { subbed: 1_000_000 }, 9_000_000),
        to(provider, assets.from_lovelace(11_000_000)),
      ],
    ),
    [t.Main([sub(5_000_000, iou(0))]), t.Defer],
  )
}

/// Double satisfaction: two identical channels, one continuing output for both.
test two_channels_cannot_share_an_output() fail {
  let c = constants(t.Ada)
  let open = channel(c, t.Opened { subbed: 0 }, funds(t.Ada, 1_000_000))
  main(
    tx(
      [input(0, open), input(1, open)],
      [channel(c, t.Opened { subbed: 0 }, funds(t.Ada, 3_000_000))],
      [consumer],
    ),
    [add, add],
  )
}

/// Continuing outputs follow the inputs' order.
test outputs_follow_input_order() fail {
  run(
    two_channels(
      [
        member(1, t.Opened { subbed: 1_000_000 }, 9_000_000),
        member(0, t.Opened { subbed: 1_000_000 }, 9_000_000),
      ],
    ),
    [t.Main(pair_of_subs()), t.Defer],
  )
}

// ---- bad datums (ADR batching.md, "What if the datum is bad?") ------------------------------

/// A UTxO at the validator whose datum names another hash.
fn impostor() -> Output {
  let d: t.Datum =
    (
      #"00000000000000000000000000000000000000000000000000000000",
      constants(t.Ada),
      t.Opened { subbed: 0 },
    )
  Output {
    ..channel(constants(t.Ada), t.Opened { subbed: 0 }, funds(t.Ada, 1_000_000)),
    datum: InlineDatum(d),
  }
}

/// Placed first, it would be the main input of a real channel that defers to it.
test bad_datum_cannot_shield_a_channel() fail {
  run(
    tx(
      [
        input(0, impostor()),
        input(1, member(1, t.Opened { subbed: 0 }, 10_000_000)),
      ],
      [to(provider, assets.from_lovelace(11_000_000))],
      [],
    ),
    [t.Main([]), t.Defer],
  )
}

/// Placed after a real channel, it is a channel input the main steps do not account for.
test bad_datum_cannot_join_a_batch() fail {
  run(
    tx(
      [
        input(0, member(0, t.Opened { subbed: 0 }, 10_000_000)),
        input(1, impostor()),
      ],
      [member(0, t.Opened { subbed: 1_000_000 }, 9_000_000)],
      [provider],
    ),
    [t.Main([sub(5_000_000, iou(0))]), t.Defer],
  )
}

// ---- a batch whose signers come in descending order (a bug at 66648db, fixed here) -----------
//
// main.ak gathers each step's required signer with xlist.ordered_insert, whose doc says it
// inserts "into the correct place", but which, at 66648db, failed with "Impossible" on an item
// smaller than one already in the list. l1-spec.md says of batches "There is no restriction on
// which steps appears", and each step only needs its own signer. So a batch needing two different
// signers failed whenever the later step's signer sorts first, with every signature present;
// step order is input order, so the builder cannot choose. Fail-closed: no funds at risk, but
// such batches could not be made. The fix is one line, `Greater -> [item, x, ..xs]`, which
// upstream merged in its pull request #10 (main at 74c20d2) and this copy has too. The three
// tests below pinned the defect with `fail`, under a `bug_` name (RESULTS.md, step 15); they pass now.

/// Two channels, the first stepped by `first`, the second by `second`; both parties sign.
fn mixed(first: t.Step, second: t.Step, outs: List<Output>) -> Bool {
  main(
    tx(
      [
        input(0, member(0, t.Opened { subbed: 0 }, 10_000_000)),
        input(1, member(1, t.Opened { subbed: 0 }, 10_000_000)),
      ],
      outs,
      [consumer, provider],
    ),
    [first, second],
  )
}

/// An add by the consumer (11..), then a sub by the provider (22..): ascending. Passes.
test batch_passes_when_signers_ascend() {
  mixed(
    add,
    sub(5_000_000, iou(1)),
    [
      member(0, t.Opened { subbed: 0 }, 11_000_000),
      member(1, t.Opened { subbed: 1_000_000 }, 9_000_000),
    ],
  )
}

/// The same two steps the other way round: provider, then consumer. Both have signed. At 66648db
/// the transaction failed on "Impossible"; with the fix it passes.
test batch_passes_when_signers_descend() {
  mixed(
    sub(5_000_000, iou(0)),
    add,
    [
      member(0, t.Opened { subbed: 1_000_000 }, 9_000_000),
      member(1, t.Opened { subbed: 0 }, 11_000_000),
    ],
  )
}

/// Two distinct keys, lower first.
fn two_keys() -> Fuzzer<(ByteArray, ByteArray)> {
  fuzz.map(
    fuzz.such_that(
      fuzz.both(fuzz.bytearray_fixed(28), fuzz.bytearray_fixed(28)),
      fn(k) { k.1st != k.2nd },
    ),
    fn(k) {
      let (a, b) = k
      if bytearray.compare(a, b) == Less {
        (a, b)
      } else {
        (b, a)
      }
    },
  )
}

/// Two consumers, each adding to their own channel, in one transaction: the first channel's
/// consumer is `first`.
fn two_adds(first: ByteArray, second: ByteArray) -> Bool {
  let c =
    fn(i, who) {
      expect Some((tag, _)) = list.at(vectors.batch_ious, i)
      (tag, t.Ada, vectors.iou_key_a, who, provider, vectors.close_period)
    }
  main(
    tx(
      [
        input(
          0,
          channel(c(0, first), t.Opened { subbed: 0 }, funds(t.Ada, 1_000_000)),
        ),
        input(
          1,
          channel(c(1, second), t.Opened { subbed: 0 }, funds(t.Ada, 1_000_000)),
        ),
      ],
      [
        channel(c(0, first), t.Opened { subbed: 0 }, funds(t.Ada, 2_000_000)),
        channel(c(1, second), t.Opened { subbed: 0 }, funds(t.Ada, 2_000_000)),
      ],
      [first, second],
    ),
    [add, add],
  )
}

test two_consumers_in_ascending_order(keys via two_keys()) {
  let (low, high) = keys
  two_adds(low, high)
}

/// Any two consumers whose keys come in descending order: at 66648db, every such batch failed.
test two_consumers_in_descending_order(keys via two_keys()) {
  let (low, high) = keys
  two_adds(high, low)
}

test ordered_insert_upwards() {
  xlist.ordered_insert([#"11"], #"22") == [#"11", #"22"]
}

test ordered_insert_takes_a_smaller_item() {
  xlist.ordered_insert([#"22"], #"11") == [#"11", #"22"]
}

fn ascending(xs: List<ByteArray>) -> Bool {
  when xs is {
    [a, b, ..rest] -> bytearray.compare(a, b) == Less && ascending([b, ..rest])
    _ -> True
  }
}

/// With the fix, signers in any order, repeats included, gather into an ascending set of
/// exactly those keys.
test fix_gathers_any_signers(
  keys via fuzz.list_between(fuzz.bytearray_fixed(1), 1, 8),
) {
  let set = list.foldl(keys, [], fn(k, acc) { xlist.ordered_insert(acc, k) })
  and {
    ascending(set),
    list.all(keys, fn(k) { list.has(set, k) }),
    list.all(set, fn(k) { list.has(keys, k) }),
  }
}
