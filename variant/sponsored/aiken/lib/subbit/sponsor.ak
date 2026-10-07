//// Sponsored channels, the one thing this variant adds to Subbit (see variant/sponsored/DESIGN.md).
////
//// A seller can pay the reserve of a token channel (its min-UTxO ADA) for a buyer who holds no
//// ADA. Upstream lets a buyer who then exits alone, by Close and Elapse or by End, keep that ADA.
//// A channel whose constants name a sponsor, `Some((address, floor))`, sends it back instead:
////
//// - R0: the channel's currency is a token, never ADA.
//// - R1: while the channel continues, its output holds at least `floor` lovelace.
//// - R2: when it ends (End, Elapse), some output of the transaction, whichever it is, pays at
////   least `floor` lovelace to `address`, with the output reference of the channel input it ends
////   as its inline datum.
////
//// R3, about who signs an End, is in steps/end.ak. A channel with no sponsor is unaffected by any
//// of this.

use aiken/collection/list
use cardano/assets.{Value}
use cardano/transaction.{InlineDatum, Output, OutputReference}
use subbit/types as t

/// R0. A sponsored channel's currency must be `Asset`: its reserve is ADA, and a channel that
/// counts ADA as its funds has no reserve to tell apart. A channel with no sponsor may be either.
pub fn currency_is_a_token(constants: t.Constants) -> Bool {
  let (_tag, currency, _iou_key, _consumer, _provider, _close_period, sponsor) = constants
  when sponsor is {
    None -> True
    Some(_) ->
      when currency is {
        t.Ada -> False
        t.Asset { .. } -> True
      }
  }
}

/// R1. The continuing output of a sponsored channel holds at least `floor` lovelace, so a step
/// that leaves the channel in place (Add, Sub, Close, Settle) never takes the floor out of it.
pub fn keeps_the_floor(constants: t.Constants, value_out: Value) -> Bool {
  let (_tag, _currency, _iou_key, _consumer, _provider, _close_period, sponsor)
    = constants
  when sponsor is {
    None -> True
    Some((_address, floor)) -> assets.lovelace_of(value_out) >= floor
  }
}

/// R2. Some output of the transaction, found among all of `outputs`, is at exactly the sponsor's
/// address (stake credential included), has `own_oref` as its inline datum, and holds at least
/// `floor` lovelace. `own_oref` is the output reference of the channel input that is ending. It
/// is unique to that input, since a UTxO is spent once, which keeps one output from repaying two
/// channels: not even two with the same tag, which nothing on chain keeps from happening.
///
/// `outputs` must be the transaction's, whole: not what the continuing steps before this one
/// have left of it, which skips every output up to their own channel's.
pub fn is_repaid(
  constants: t.Constants,
  own_oref: OutputReference,
  outputs: List<Output>,
) -> Bool {
  let (_tag, _currency, _iou_key, _consumer, _provider, _close_period, sponsor)
    = constants
  when sponsor is {
    None -> True
    Some((address, floor)) ->
      list.any(
        outputs,
        fn(output) {
          and {
            output.address == address,
            output.datum == InlineDatum(own_oref),
            assets.lovelace_of(output.value) >= floor,
          }
        },
      )
  }
}
