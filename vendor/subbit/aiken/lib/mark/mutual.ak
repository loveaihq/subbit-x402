//// Mutual spends (ADR mutual-txs.md): anything goes if both participants sign, but no other
//// channel may be spent in the same transaction. Subbit's own plan left these as "TODO".

use aiken/fuzz
use cardano/transaction.{Transaction}
use mark/fixture.{
  amount, any_currency, channel, constants, consumer, funds, input, provider, run,
  tagged, to, tx,
}
use mark/vectors
use subbit/types as t

fn any_stage() -> Fuzzer<t.Stage> {
  fuzz.one_of(
    [t.Opened { subbed: 3 }, t.Closed { subbed: 3, elapse_at: 9 }, t.Settled],
  )
}

/// The two parties split a channel however they agreed.
fn splitting(
  currency: t.Currency,
  stage: t.Stage,
  to_provider: Int,
  to_consumer: Int,
  signers: List<ByteArray>,
) -> Transaction {
  tx(
    [
      input(
        0,
        channel(
          constants(currency),
          stage,
          funds(currency, to_provider + to_consumer),
        ),
      ),
    ],
    [
      to(provider, funds(currency, to_provider)),
      to(consumer, funds(currency, to_consumer)),
    ],
    signers,
  )
}

fn split_case() -> Fuzzer<(t.Currency, t.Stage, Int, Int)> {
  fuzz.tuple4(any_currency(), any_stage(), amount(), amount())
}

test mutual_with_both_signatures(x via split_case()) {
  let (currency, stage, p, c) = x
  run(splitting(currency, stage, p, c, [consumer, provider]), [t.Mutual])
}

test mutual_needs_the_consumer(x via split_case()) fail {
  let (currency, stage, p, c) = x
  run(splitting(currency, stage, p, c, [provider]), [t.Mutual])
}

test mutual_needs_the_provider(x via split_case()) fail {
  let (currency, stage, p, c) = x
  run(splitting(currency, stage, p, c, [consumer]), [t.Mutual])
}

/// It may rewrite the channel, a new IOU key included (the ADR's example).
test mutual_can_rewrite_the_channel(x via fuzz.both(any_currency(), amount())) {
  let (currency, held) = x
  let (tag, cur, _, cons, prov, period) = constants(currency)
  run(
    tx(
      [
        input(
          0,
          channel(constants(currency), t.Opened { subbed: 0 }, funds(currency, held)),
        ),
      ],
      [
        channel(
          (tag, cur, vectors.iou_key_b, cons, prov, period),
          t.Opened { subbed: 0 },
          funds(currency, held),
        ),
      ],
      [consumer, provider],
    ),
    [t.Mutual],
  )
}

/// Not alongside another channel, whether that one defers or is mutual too.
test mutual_is_alone(x via fuzz.both(any_currency(), fuzz.bool())) fail {
  let (currency, both_mutual) = x
  let second =
    if both_mutual {
      t.Mutual
    } else {
      t.Defer
    }
  run(
    tx(
      [
        input(
          0,
          channel(constants(currency), t.Opened { subbed: 0 }, funds(currency, 1_000_000)),
        ),
        input(
          1,
          channel(
            tagged(vectors.tag_2, currency),
            t.Opened { subbed: 0 },
            funds(currency, 1_000_000),
          ),
        ),
      ],
      [to(consumer, funds(currency, 2_000_000))],
      [consumer, provider],
    ),
    [t.Mutual, second],
  )
}
