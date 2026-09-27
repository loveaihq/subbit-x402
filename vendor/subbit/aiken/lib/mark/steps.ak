//// Each step alone, after Subbit's own test plan (docs/design/l1-tests.md, "Steps succeed" and
//// "Steps fail"): every step passes when it should, fuzzed, and fails without its signer or with
//// the wrong numbers. A property test marked `fail` passes only if every generated case fails.

use aiken/fuzz
use aiken/interval
use cardano/transaction.{Transaction}
use mark/fixture.{
  add, amount, any_currency, any_iou, channel, close, constants, consumer,
  elapse, end, funds, input, main, provider, settle, sub, to, tx,
}
use mark/vectors
use subbit/types as t

// ---- add ------------------------------------------------------------------------------------

/// The consumer adds to an opened channel: `before` in, `after` out.
fn adding(
  currency: t.Currency,
  before: Int,
  after: Int,
  subbed: Int,
  signers: List<ByteArray>,
) -> Transaction {
  let c = constants(currency)
  tx(
    [input(0, channel(c, t.Opened { subbed }, funds(currency, before)))],
    [channel(c, t.Opened { subbed }, funds(currency, after))],
    signers,
  )
}

test add_puts_more_in(
  x via fuzz.tuple4(
    any_currency(),
    amount(),
    fuzz.int_between(1, 1_000_000_000),
    amount(),
  ),
) {
  let (currency, before, more, subbed) = x
  main(adding(currency, before, before + more, subbed, [consumer]), [add])
}

test add_needs_the_consumer(
  x via fuzz.tuple3(any_currency(), amount(), fuzz.int_between(1, 1_000_000)),
) fail {
  let (currency, before, more) = x
  main(adding(currency, before, before + more, 0, [provider]), [add])
}

/// Upstream's `add_less`: the channel does not grow (equal included).
test add_less(x via fuzz.tuple3(any_currency(), amount(), amount())) fail {
  let (currency, after, less) = x
  main(adding(currency, after + less - 1, after, 0, [consumer]), [add])
}

test add_needs_an_opened_channel(
  x via fuzz.both(any_currency(), fuzz.int_between(1, 1_000_000)),
) fail {
  let (currency, more) = x
  let c = constants(currency)
  let stage = t.Closed { subbed: 0, elapse_at: 1_000 }
  main(
    tx(
      [input(0, channel(c, stage, funds(currency, 1_000_000)))],
      [channel(c, stage, funds(currency, 1_000_000 + more))],
      [consumer],
    ),
    [add],
  )
}

// ---- sub ------------------------------------------------------------------------------------

/// The provider subs `take` from an opened channel holding `take + left`, `subbed` before.
fn subbing(
  currency: t.Currency,
  subbed: Int,
  take: Int,
  left: Int,
  signers: List<ByteArray>,
) -> Transaction {
  let c = constants(currency)
  tx(
    [input(0, channel(c, t.Opened { subbed }, funds(currency, take + left)))],
    [
      channel(c, t.Opened { subbed: subbed + take }, funds(currency, left)),
      to(provider, funds(currency, take)),
    ],
    signers,
  )
}

/// A currency, an IOU (owed, signature), `subbed` at or under it, a take within the rest of
/// it, and what stays in the channel.
fn within_iou() -> Fuzzer<(t.Currency, Int, ByteArray, Int, Int, Int)> {
  fuzz.and_then(
    any_iou(),
    fn(iou) {
      let (owed, sig) = iou
      fuzz.and_then(
        fuzz.int_between(0, owed),
        fn(subbed) {
          fuzz.map3(
            any_currency(),
            fuzz.int_between(0, owed - subbed),
            amount(),
            fn(currency, take, left) { (currency, owed, sig, subbed, take, left) },
          )
        },
      )
    },
  )
}

/// The same, with a take that goes past what the IOU leaves.
fn beyond_iou() -> Fuzzer<(t.Currency, Int, ByteArray, Int, Int, Int)> {
  fuzz.and_then(
    any_iou(),
    fn(iou) {
      let (owed, sig) = iou
      fuzz.and_then(
        fuzz.int_between(0, owed),
        fn(subbed) {
          fuzz.map3(
            any_currency(),
            fuzz.int_between(owed - subbed + 1, owed - subbed + 1_000_000_000),
            amount(),
            fn(currency, take, left) { (currency, owed, sig, subbed, take, left) },
          )
        },
      )
    },
  )
}

test sub_within_the_iou(x via within_iou()) {
  let (currency, owed, sig, subbed, take, left) = x
  main(subbing(currency, subbed, take, left, [provider]), [sub(owed, sig)])
}

/// Upstream's `sub_too_much`.
test sub_too_much(x via beyond_iou()) fail {
  let (currency, owed, sig, subbed, take, left) = x
  main(subbing(currency, subbed, take, left, [provider]), [sub(owed, sig)])
}

/// Taking more than the new `subbed` records.
test sub_must_record_what_it_takes(
  x via fuzz.both(within_iou(), fuzz.int_between(1, 1_000_000_000)),
) fail {
  let ((currency, owed, sig, subbed, take, left), extra) = x
  let c = constants(currency)
  main(
    tx(
      [
        input(
          0,
          channel(c, t.Opened { subbed }, funds(currency, take + extra + left)),
        ),
      ],
      [channel(c, t.Opened { subbed: subbed + take }, funds(currency, left))],
      [provider],
    ),
    [sub(owed, sig)],
  )
}

test sub_needs_the_provider(x via within_iou()) fail {
  let (currency, owed, sig, subbed, take, left) = x
  main(subbing(currency, subbed, take, left, [consumer]), [sub(owed, sig)])
}

/// Upstream's `sub_bad_id`: a valid IOU from the same key, for another tag.
test sub_bad_id() fail {
  main(
    subbing(fixture.usdm, 0, 1, 1_000, [provider]),
    [sub(5_000_000, vectors.iou_a_tag_2_5m)],
  )
}

/// Upstream's `sub_bad_sig`: the right body, signed by another key.
test sub_bad_sig() fail {
  main(
    subbing(fixture.usdm, 0, 1, 1_000, [provider]),
    [sub(5_000_000, vectors.iou_b_tag_1_5m)],
  )
}

/// A signature covers its amount: key A's IOU for `owed` does not vouch for `owed + 1`.
test sub_iou_is_for_its_amount(x via any_iou()) fail {
  let (owed, sig) = x
  main(subbing(t.Ada, 0, 1, 1_000, [provider]), [sub(owed + 1, sig)])
}

test sub_needs_an_opened_channel(x via within_iou()) fail {
  let (currency, owed, sig, subbed, take, left) = x
  let c = constants(currency)
  main(
    tx(
      [
        input(
          0,
          channel(
            c,
            t.Closed { subbed, elapse_at: 1_000 },
            funds(currency, take + left),
          ),
        ),
      ],
      [
        channel(
          c,
          t.Closed { subbed: subbed + take, elapse_at: 1_000 },
          funds(currency, left),
        ),
      ],
      [provider],
    ),
    [sub(owed, sig)],
  )
}

// ---- close ----------------------------------------------------------------------------------

/// The consumer closes a channel holding `held`, adding `more`; the transaction is valid until
/// `ub`, and the channel may elapse from `elapse_at`.
fn closing(
  currency: t.Currency,
  held: Int,
  more: Int,
  subbed: Int,
  ub: Int,
  elapse_at: Int,
  signers: List<ByteArray>,
) -> Transaction {
  let c = constants(currency)
  Transaction {
    ..tx(
      [input(0, channel(c, t.Opened { subbed }, funds(currency, held)))],
      [channel(c, t.Closed { subbed, elapse_at }, funds(currency, held + more))],
      signers,
    ),
    validity_range: interval.before(ub),
  }
}

fn close_case() -> Fuzzer<(t.Currency, Int, Int, Int, Int, Int)> {
  fuzz.tuple6(
    any_currency(),
    amount(),
    fuzz.int_between(0, 1_000_000),
    amount(),
    fuzz.int_between(0, 2_000_000_000_000),
    fuzz.int_between(0, 1_000_000_000),
  )
}

test close_starts_the_close_period(x via close_case()) {
  let (currency, held, more, subbed, ub, slack) = x
  main(
    closing(
      currency,
      held,
      more,
      subbed,
      ub,
      ub + vectors.close_period + slack,
      [consumer],
    ),
    [close],
  )
}

/// Upstream's `close_bad_expire`: the channel could elapse before a full close period.
test close_bad_expire(x via close_case()) fail {
  let (currency, held, more, subbed, ub, slack) = x
  main(
    closing(
      currency,
      held,
      more,
      subbed,
      ub,
      ub + vectors.close_period - 1 - slack,
      [consumer],
    ),
    [close],
  )
}

/// Upstream's `close_bad_data`: the continuing datum changes more than its stage.
test close_bad_data(x via fuzz.both(close_case(), fuzz.int_between(1, 1_000))) fail {
  let ((currency, held, more, subbed, ub, slack), d) = x
  let c = constants(currency)
  main(
    Transaction {
      ..tx(
        [input(0, channel(c, t.Opened { subbed }, funds(currency, held)))],
        [
          channel(
            c,
            t.Closed {
              subbed: subbed - d,
              elapse_at: ub + vectors.close_period + slack,
            },
            funds(currency, held + more),
          ),
        ],
        [consumer],
      ),
      validity_range: interval.before(ub),
    },
    [close],
  )
}

test close_takes_nothing_out(
  x via fuzz.both(close_case(), fuzz.int_between(1, 1_000)),
) fail {
  let ((currency, held, _, subbed, ub, slack), less) = x
  main(
    closing(
      currency,
      held + less,
      -less,
      subbed,
      ub,
      ub + vectors.close_period + slack,
      [consumer],
    ),
    [close],
  )
}

test close_needs_the_consumer(x via close_case()) fail {
  let (currency, held, more, subbed, ub, slack) = x
  main(
    closing(
      currency,
      held,
      more,
      subbed,
      ub,
      ub + vectors.close_period + slack,
      [provider],
    ),
    [close],
  )
}

/// Without an upper bound on validity, there is no time to count the close period from.
test close_needs_an_upper_bound(x via close_case()) fail {
  let (currency, held, more, subbed, ub, slack) = x
  main(
    Transaction {
      ..closing(
          currency,
          held,
          more,
          subbed,
          ub,
          ub + vectors.close_period + slack,
          [consumer],
        ),
      validity_range: interval.after(0),
    },
    [close],
  )
}

// ---- settle ---------------------------------------------------------------------------------

/// The provider settles a closed channel holding `take + left`, taking `take`.
fn settling(
  currency: t.Currency,
  subbed: Int,
  take: Int,
  left: Int,
  signers: List<ByteArray>,
) -> Transaction {
  let c = constants(currency)
  tx(
    [
      input(
        0,
        channel(
          c,
          t.Closed { subbed, elapse_at: 1_000_000 },
          funds(currency, take + left),
        ),
      ),
    ],
    [
      channel(c, t.Settled, funds(currency, left)),
      to(provider, funds(currency, take)),
    ],
    signers,
  )
}

test settle_within_the_iou(x via within_iou()) {
  let (currency, owed, sig, subbed, take, left) = x
  main(settling(currency, subbed, take, left, [provider]), [settle(owed, sig)])
}

test settle_too_much(x via beyond_iou()) fail {
  let (currency, owed, sig, subbed, take, left) = x
  main(settling(currency, subbed, take, left, [provider]), [settle(owed, sig)])
}

test settle_needs_the_provider(x via within_iou()) fail {
  let (currency, owed, sig, subbed, take, left) = x
  main(settling(currency, subbed, take, left, [consumer]), [settle(owed, sig)])
}

test settle_bad_sig() fail {
  main(
    settling(t.Ada, 0, 1, 1_000, [provider]),
    [settle(5_000_000, vectors.iou_b_tag_1_5m)],
  )
}

test settle_needs_a_closed_channel(x via within_iou()) fail {
  let (currency, owed, sig, subbed, take, left) = x
  let c = constants(currency)
  main(
    tx(
      [input(0, channel(c, t.Opened { subbed }, funds(currency, take + left)))],
      [channel(c, t.Settled, funds(currency, left))],
      [provider],
    ),
    [settle(owed, sig)],
  )
}

// ---- end ------------------------------------------------------------------------------------

/// The consumer takes everything a channel at `stage` holds.
fn ending(
  currency: t.Currency,
  held: Int,
  stage: t.Stage,
  signers: List<ByteArray>,
) -> Transaction {
  tx(
    [input(0, channel(constants(currency), stage, funds(currency, held)))],
    [to(consumer, funds(currency, held))],
    signers,
  )
}

test end_after_settle(x via fuzz.both(any_currency(), amount())) {
  let (currency, held) = x
  main(ending(currency, held, t.Settled, [consumer]), [end])
}

test end_needs_the_consumer(x via fuzz.both(any_currency(), amount())) fail {
  let (currency, held) = x
  main(ending(currency, held, t.Settled, [provider]), [end])
}

fn not_settled() -> Fuzzer<(t.Currency, Int, t.Stage)> {
  fuzz.tuple3(
    any_currency(),
    amount(),
    fuzz.one_of([t.Opened { subbed: 0 }, t.Closed { subbed: 0, elapse_at: 0 }]),
  )
}

test end_needs_a_settled_channel(x via not_settled()) fail {
  let (currency, held, stage) = x
  main(ending(currency, held, stage, [consumer]), [end])
}

// ---- elapse ---------------------------------------------------------------------------------

/// The consumer takes everything a closed channel holds, from `lb` on.
fn elapsing(
  currency: t.Currency,
  held: Int,
  elapse_at: Int,
  lb: Int,
  signers: List<ByteArray>,
) -> Transaction {
  Transaction {
    ..tx(
      [
        input(
          0,
          channel(
            constants(currency),
            t.Closed { subbed: 7, elapse_at },
            funds(currency, held),
          ),
        ),
      ],
      [to(consumer, funds(currency, held))],
      signers,
    ),
    validity_range: interval.after(lb),
  }
}

fn elapse_case() -> Fuzzer<(t.Currency, Int, Int, Int)> {
  fuzz.tuple4(
    any_currency(),
    amount(),
    fuzz.int_between(0, 2_000_000_000_000),
    fuzz.int_between(0, 1_000_000_000),
  )
}

test elapse_after_the_close_period(x via elapse_case()) {
  let (currency, held, elapse_at, late) = x
  main(elapsing(currency, held, elapse_at, elapse_at + late, [consumer]), [elapse])
}

/// Upstream's `expire_too_soon` (the step is now called elapse).
test elapse_too_soon(x via elapse_case()) fail {
  let (currency, held, elapse_at, early) = x
  main(
    elapsing(currency, held, elapse_at, elapse_at - 1 - early, [consumer]),
    [elapse],
  )
}

test elapse_needs_the_consumer(x via elapse_case()) fail {
  let (currency, held, elapse_at, late) = x
  main(elapsing(currency, held, elapse_at, elapse_at + late, [provider]), [elapse])
}

/// Without a lower bound on validity, the transaction does not show the time has come.
test elapse_needs_a_lower_bound(x via elapse_case()) fail {
  let (currency, held, elapse_at, late) = x
  main(
    Transaction {
      ..elapsing(currency, held, elapse_at, elapse_at + late, [consumer]),
      validity_range: interval.before(elapse_at + late),
    },
    [elapse],
  )
}

test elapse_needs_a_closed_channel(x via fuzz.both(any_currency(), amount())) fail {
  let (currency, held) = x
  main(ending(currency, held, t.Opened { subbed: 0 }, [consumer]), [elapse])
}
