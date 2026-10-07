//// Properties by design, pinned here so that a change upstream shows. Each is safe for
//// subbit-x402 only because of something the binding does off chain, named in its doc.

use aiken/interval
use cardano/assets
use cardano/transaction.{InlineDatum, Output, Transaction}
use mark/fixture.{
  channel, constants, funds, input, iou, main, provider, reserve, run, settle,
  sub, to, tx, usdm,
}
use mark/vectors
use subbit/types as t

/// ADR batching.md, "What if the datum is bad?": a UTxO at the validator whose datum names
/// another hash is anyone's; `Main([])` spends it with no signature at all. Opening runs no
/// validator, so only whoever made it can lose by it, and a provider must check `own_hash`
/// before serving a channel. subbit-x402's facilitator refuses an opening whose datum names
/// another hash (cardano.ts, datumBindingError).
test bad_own_hash_is_anyones() {
  let d: t.Datum = (
    #"00000000000000000000000000000000000000000000000000000000",
    constants(t.Ada),
    t.Opened { subbed: 0 },
  )
  let bad = Output {
    ..channel(constants(t.Ada), t.Opened { subbed: 0 }, funds(t.Ada, 5_000_000)),
    datum: InlineDatum(d),
  }
  run(
    tx(
      [input(0, bad)],
      [
        to(
          #"99999999999999999999999999999999999999999999999999999999",
          funds(t.Ada, 5_000_000),
        ),
      ],
      [],
    ),
    [t.Main([])],
  )
}

/// ADR tag.md: an IOU is for an (IOU key, tag) pair, not for a channel, so two channels with the
/// same pair honour the same IOU: here one IOU of 5 ADA pays out twice. subbit-x402 never reuses
/// a pair: it derives an IOU key per tag, and each tag hashes an input its opening spends.
test same_key_and_tag_share_ious() {
  let c = constants(t.Ada)
  let open = channel(c, t.Opened { subbed: 0 }, funds(t.Ada, 10_000_000))
  main(
    tx(
      [input(0, open), input(1, open)],
      [
        channel(c, t.Opened { subbed: 5_000_000 }, funds(t.Ada, 5_000_000)),
        channel(c, t.Opened { subbed: 5_000_000 }, funds(t.Ada, 5_000_000)),
        to(provider, funds(t.Ada, 10_000_000)),
      ],
      [provider],
    ),
    [sub(5_000_000, iou(5_000_000)), sub(5_000_000, iou(5_000_000))],
  )
}

/// ADR funds.md: a token channel counts its tokens only. Its ADA is the consumer's, yet a sub
/// (on any IOU, even one for 0) or a settle may take it down to the ledger minimum. subbit-x402's
/// client puts in exactly the min-UTxO of the channel's widest continuing output (cardano.ts,
/// channelReserve), so what a provider could take is the room kept for wider datums: 0.09 tADA
/// as measured on preprod (the binding spec, "Minimum UTxO value").
test token_channel_ada_is_not_counted() {
  let c = constants(usdm)
  let tokens = assets.from_asset(vectors.policy, vectors.token_name, 1_000)
  main(
    tx(
      [input(0, channel(c, t.Opened { subbed: 0 }, funds(usdm, 1_000)))],
      [
        channel(
          c,
          t.Opened { subbed: 0 },
          tokens |> assets.merge(assets.from_lovelace(1)),
        ),
        to(provider, assets.from_lovelace(reserve - 1)),
      ],
      [provider],
    ),
    [sub(0, iou(0))],
  )
}

/// l1-spec.md: a settle has no deadline. After `elapse_at`, until the consumer elapses the
/// channel, the provider can still settle it on its latest IOU. A consumer who wants the whole
/// remainder elapses promptly (walletctl elapse); one who owes it anyway loses nothing.
test settle_after_elapse_at() {
  let c = constants(t.Ada)
  main(
    Transaction {
      ..tx(
        [
          input(
            0,
            channel(
              c,
              t.Closed { subbed: 0, elapse_at: 1_000 },
              funds(t.Ada, 10_000_000),
            ),
          ),
        ],
        [channel(c, t.Settled, funds(t.Ada, 5_000_000))],
        [provider],
      ),
      validity_range: interval.after(1_000_000_000_000),
    },
    [settle(5_000_000, iou(5_000_000))],
  )
}

/// A provider may put funds back with a sub, and `subbed` falls by as much. Harmless: the IOU
/// still caps what they can take in all.
test sub_can_put_funds_back() {
  let c = constants(t.Ada)
  main(
    tx(
      [
        input(
          0,
          channel(c, t.Opened { subbed: 3_000_000 }, funds(t.Ada, 5_000_000)),
        ),
      ],
      [channel(c, t.Opened { subbed: 1_000_000 }, funds(t.Ada, 7_000_000))],
      [provider],
    ),
    [sub(5_000_000, iou(5_000_000))],
  )
}
