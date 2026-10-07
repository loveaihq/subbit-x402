// Modified from kompact-io/subbit-xyz @ 66648db for the sponsored variant (rules R2 and R3: the
// input value, its output reference and the transaction's outputs); see
// variant/sponsored/PROVENANCE.md.

use aiken/crypto.{VerificationKey}
use cardano/assets.{Value}
use cardano/transaction.{Output, OutputReference}
use subbit/assets.{amount_in} as assets_
use subbit/sponsor.{is_repaid}
use subbit/types as t

/// End a Settled channel: nothing continues, whatever it holds goes wherever the signer says.
///
/// Upstream, the consumer signs. For a sponsored channel (variant/sponsored/DESIGN.md) the
/// transaction must also repay the sponsor (R2, `is_repaid` over all of `outputs`, naming
/// `own_oref`, the output reference of the channel input), and when the channel holds none of its
/// currency the provider signs instead of the consumer (R3): ending an empty channel gives the
/// consumer nothing to take, so it is for the provider to get the sponsor's reserve back.
pub fn do(
  constants: t.Constants,
  value_in: Value,
  stage_in: t.Stage,
  own_oref: OutputReference,
  outputs: List<Output>,
) -> VerificationKey {
  let (_tag, currency, _iou_key, consumer, provider, _close_period, sponsor) = constants
  expect t.Settled = stage_in
  expect is_repaid(constants, own_oref, outputs)
  when sponsor is {
    None -> consumer
    Some(_) ->
      if amount_in(currency, value_in) == 0 {
        provider
      } else {
        consumer
      }
  }
}
