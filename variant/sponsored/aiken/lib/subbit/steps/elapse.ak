// Modified from kompact-io/subbit-xyz @ 66648db for the sponsored variant (rule R2: the channel
// input's output reference and the transaction's outputs); see variant/sponsored/PROVENANCE.md.

use aiken/crypto.{VerificationKey}
use aiken/interval.{Finite}
use cardano/transaction.{Output, OutputReference}
use subbit/prelude.{Timebound}
use subbit/sponsor.{is_repaid}
use subbit/types as t

/// Elapse a Closed channel once its close period is over: nothing continues, and the consumer
/// signs. For a sponsored channel (variant/sponsored/DESIGN.md) the transaction must also repay
/// the sponsor (R2, `is_repaid` over all of `outputs`, naming `own_oref`, the output reference of
/// the channel input).
pub fn do(
  lower_bound: Timebound,
  constants: t.Constants,
  stage_in: t.Stage,
  own_oref: OutputReference,
  outputs: List<Output>,
) -> VerificationKey {
  let (_tag, _currency, _iou_key, consumer, _provider, _close_period, _sponsor)
    = constants
  expect t.Closed { elapse_at, .. } = stage_in
  expect Finite(lower_bound) = lower_bound
  expect elapse_at <= lower_bound
  expect is_repaid(constants, own_oref, outputs)
  consumer
}
