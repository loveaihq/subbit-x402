// Modified from kompact-io/subbit-xyz @ 66648db for the sponsored variant (rules R0 to R2, and the
// transaction's outputs and the channel input's output reference passed down to the steps); see
// variant/sponsored/PROVENANCE.md.

use aiken/collection/list
use aiken/crypto.{VerificationKey, VerificationKeyHash}
use aiken/interval.{Interval, IntervalBound}
use cardano/address.{Address, Credential, Script}
use cardano/transaction.{Input, Output, Transaction}
use extra/xlist.{foldl3}
use subbit/io.{yield_in, yield_out}
use subbit/prelude.{Timebound}
use subbit/sponsor.{currency_is_a_token, keeps_the_floor}
use subbit/steps/add
use subbit/steps/close
use subbit/steps/elapse
use subbit/steps/end
use subbit/steps/settle
use subbit/steps/sub
use subbit/types as t

/// In a standard tx, the "main" invocation does all the verification steps for all
/// channels.
pub fn do(datum: t.Datum, steps: List<t.Step>, tx: Transaction) {
  let Transaction { inputs, outputs, validity_range, extra_signatories, .. } = tx
  let  
      Interval {
        lower_bound: IntervalBound { bound_type: lower_bound, .. },
        upper_bound: IntervalBound { bound_type: upper_bound, .. },
      }
    = validity_range
  let (own_hash, _, _) = datum
  let own_cred = Script(own_hash)
  let with = mk_with(own_cred, lower_bound, upper_bound, outputs, _, _, _, _, _)
  let inputs, _outputs, vkhs <- foldl3(steps, inputs, outputs, [], with, _)
  expect
    vkhs
      |> list.all(fn(vkey) { extra_signatories |> list.has(vkey) })
  inputs
    |> list.all(fn(i) { i.output.address.payment_credential != own_cred })
}

type WithReturn<result> =
  fn(List<Input>, List<Output>, List<VerificationKey>) -> result

/// `tx_outputs` is every output of the transaction. `outputs` is what the continuing steps
/// before this one have not yet consumed: they skip to their own channel's output and drop
/// everything up to it. An end-of-life step looks through `tx_outputs` (see sponsor.is_repaid).
fn mk_with(
  own_cred: Credential,
  lb: Timebound,
  ub: Timebound,
  tx_outputs: List<Output>,
  step: t.Step,
  inputs: List<Input>,
  outputs: List<Output>,
  vkhs: List<VerificationKeyHash>,
  return: WithReturn<result>,
) -> result {
  let delegation, v_in, c, s_in, own_oref, inputs <- yield_in(own_cred, inputs)
  // R0: a sponsored channel's currency is a token.
  expect currency_is_a_token(c)
  when step is {
    t.StepCont(step) -> {
      let v_out, s_out, outputs <- yield_out(own_cred, delegation, c, outputs)
      // R1: a sponsored channel keeps its floor in the continuing output.
      expect keeps_the_floor(c, v_out)
      let vkey = when step is {
        t.Add -> add.do(c, v_in, s_in, v_out, s_out)
        t.Sub { n, sig } -> sub.do(c, v_in, s_in, v_out, s_out, n, sig)
        t.Close -> close.do(ub, c, v_in, s_in, v_out, s_out)
        t.Settle { n, sig } -> settle.do(c, v_in, s_in, v_out, s_out, n, sig)
      }
      let vkhs = vkhs |> xlist.ordered_insert(vkey)
      return(inputs, outputs, vkhs)
    }
    t.StepEol(step) -> {
      // R2 and R3 are in the steps. They need the transaction's outputs and this input's output
      // reference, and End the input's value.
      let vkey = when step is {
        t.End -> end.do(c, v_in, s_in, own_oref, tx_outputs)
        t.Elapse -> elapse.do(lb, c, s_in, own_oref, tx_outputs)
      }
      let vkhs = vkhs |> xlist.ordered_insert(vkey)
      return(inputs, outputs, vkhs)
    }
  }
}
