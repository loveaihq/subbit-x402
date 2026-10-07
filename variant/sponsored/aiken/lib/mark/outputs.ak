//// The continuing output (io.ak's yield_out, assets.ak's amount_out): at the same address,
//// delegation included; an inline datum naming this validator, with unchanged constants; no
//// reference script; and nothing but the channel's currency (and ADA).

use aiken/fuzz
use cardano/address.{Address, Inline, VerificationKey}
use cardano/assets
use cardano/transaction.{DatumHash, InlineDatum, Output, Transaction}
use mark/fixture.{
  add, any_currency, channel, constants, consumer, floor, funds, input, main,
  sponsor_address, tx, usdm,
}
use mark/vectors
use subbit/types as t

/// An add whose continuing output is `edit` applied to the honest one.
fn add_with(currency: t.Currency, edit: fn(Output) -> Output) -> Transaction {
  let c = constants(currency)
  tx(
    [input(0, channel(c, t.Opened { subbed: 0 }, funds(currency, 1_000_000)))],
    [edit(channel(c, t.Opened { subbed: 0 }, funds(currency, 2_000_000)))],
    [consumer],
  )
}

fn delegated(o: Output) -> Output {
  Output {
    ..o,
    address: Address {
      ..o.address,
      stake_credential: Some(Inline(VerificationKey(consumer))),
    },
  }
}

/// The baseline the tests below each break in one way.
test honest_output(currency via any_currency()) {
  main(add_with(currency, fn(o) { o }), [add])
}

test output_keeps_a_delegation(currency via any_currency()) {
  let c = constants(currency)
  main(
    tx(
      [
        input(
          0,
          delegated(
            channel(c, t.Opened { subbed: 0 }, funds(currency, 1_000_000)),
          ),
        ),
      ],
      [
        delegated(
          channel(c, t.Opened { subbed: 0 }, funds(currency, 2_000_000)),
        ),
      ],
      [consumer],
    ),
    [add],
  )
}

test output_cannot_change_the_delegation(currency via any_currency()) fail {
  main(add_with(currency, delegated), [add])
}

test output_stays_at_the_validator(currency via any_currency()) fail {
  main(
    add_with(
      currency,
      fn(o) {
        Output {
          ..o,
          address: Address {
            payment_credential: VerificationKey(consumer),
            stake_credential: None,
          },
        }
      },
    ),
    [add],
  )
}

test output_has_no_reference_script(currency via any_currency()) fail {
  main(
    add_with(
      currency,
      fn(o) { Output { ..o, reference_script: Some(vectors.subbit_hash) } },
    ),
    [add],
  )
}

test output_has_an_inline_datum(currency via any_currency()) fail {
  main(
    add_with(
      currency,
      fn(o) {
        Output {
          ..o,
          datum: DatumHash(
            #"0000000000000000000000000000000000000000000000000000000000000000",
          ),
        }
      },
    ),
    [add],
  )
}

test output_datum_names_this_validator(currency via any_currency()) fail {
  main(
    add_with(
      currency,
      fn(o) {
        let d: t.Datum = (
          #"00000000000000000000000000000000000000000000000000000000",
          constants(currency),
          t.Opened { subbed: 0 },
        )
        Output { ..o, datum: InlineDatum(d) }
      },
    ),
    [add],
  )
}

/// Each of the seven constants, changed alone (the sponsor, from none to one).
test output_keeps_the_constants(
  x via fuzz.both(any_currency(), fuzz.int_between(0, 6)),
) fail {
  let (currency, which) = x
  let (tag, cur, key, cons, prov, period, sponsor) = constants(currency)
  let changed = when which is {
    0 -> (vectors.tag_2, cur, key, cons, prov, period, sponsor)
    1 ->
      (
        tag,
        if cur == t.Ada {
          usdm
        } else {
          t.Ada
        },
        key,
        cons,
        prov,
        period,
        sponsor,
      )
    2 -> (tag, cur, vectors.iou_key_b, cons, prov, period, sponsor)
    3 -> (tag, cur, key, prov, prov, period, sponsor)
    4 -> (tag, cur, key, cons, cons, period, sponsor)
    5 -> (tag, cur, key, cons, prov, period + 1, sponsor)
    _ -> (tag, cur, key, cons, prov, period, Some((sponsor_address(), floor)))
  }
  main(
    add_with(
      currency,
      fn(o) { channel(changed, t.Opened { subbed: 0 }, o.value) },
    ),
    [add],
  )
}

/// Token spam: any other asset in the continuing output, under another policy or the
/// currency's own.
test output_carries_only_the_currency(
  x via fuzz.tuple3(any_currency(), fuzz.bool(), fuzz.int_between(1, 1_000_000)),
) fail {
  let (currency, same_policy, n) = x
  let policy = if same_policy {
    vectors.policy
  } else {
    #"55555555555555555555555555555555555555555555555555555555"
  }
  main(
    add_with(
      currency,
      fn(o) { Output { ..o, value: assets.add(o.value, policy, "SPAM", n) } },
    ),
    [add],
  )
}
