//// Builders for the tests in lib/mark (subbit-x402's; the rest of this project is Subbit's
//// source at 66648db, with one line changed in lib/extra/xlist.ak): channels, transactions, and a
//// runner that validates a transaction as the ledger does, by running the validator for every
//// channel input.

use aiken/collection/list
use aiken/crypto.{ScriptHash, VerificationKeyHash}
use aiken/fuzz
use cardano/address.{Address, Script, VerificationKey}
use cardano/assets.{Value}
use cardano/transaction.{
  InlineDatum, Input, NoDatum, Output, OutputReference, Transaction,
}
use mark/vectors
use subbit/spend
use subbit/types as t

/// The validator's own hash: what every channel datum must name.
pub const own_hash: ScriptHash = vectors.subbit_hash

pub const consumer: VerificationKeyHash = vectors.consumer

pub const provider: VerificationKeyHash = vectors.provider

pub const usdm: t.Currency =
  t.Asset { hash: vectors.policy, name: vectors.token_name }

/// The ADA a token channel carries beside its tokens.
pub const reserve: Int = 2_000_000

/// Constants for tag_1: IOU key A, the fixture's consumer and provider, a one-hour close period.
pub fn constants(currency: t.Currency) -> t.Constants {
  (vectors.tag_1, currency, vectors.iou_key_a, consumer, provider, vectors.close_period)
}

/// The same with another tag, for channels that must differ.
pub fn tagged(tag: ByteArray, currency: t.Currency) -> t.Constants {
  (tag, currency, vectors.iou_key_a, consumer, provider, vectors.close_period)
}

pub fn datum(constants: t.Constants, stage: t.Stage) -> t.Datum {
  (own_hash, constants, stage)
}

pub fn channel_address() -> Address {
  Address { payment_credential: Script(own_hash), stake_credential: None }
}

/// A channel: at the validator, with an inline datum and no reference script.
pub fn channel(constants: t.Constants, stage: t.Stage, value: Value) -> Output {
  Output {
    address: channel_address(),
    value,
    datum: InlineDatum(datum(constants, stage)),
    reference_script: None,
  }
}

/// `amount` of the currency; a token channel also carries its ADA reserve.
pub fn funds(currency: t.Currency, amount: Int) -> Value {
  when currency is {
    t.Ada -> assets.from_lovelace(amount)
    t.Asset { hash, name } ->
      assets.from_asset(hash, name, amount)
        |> assets.merge(assets.from_lovelace(reserve))
  }
}

/// Output references of one transaction, so inputs sort by index as the ledger sorts them.
pub fn oref(index: Int) -> OutputReference {
  OutputReference {
    transaction_id: #"cafecafecafecafecafecafecafecafecafecafecafecafecafecafecafecafe",
    output_index: index,
  }
}

pub fn input(index: Int, output: Output) -> Input {
  Input { output_reference: oref(index), output }
}

/// A key-locked output, such as the provider's take or the consumer's refund.
pub fn to(owner: VerificationKeyHash, value: Value) -> Output {
  Output {
    address: Address {
      payment_credential: VerificationKey(owner),
      stake_credential: None,
    },
    value,
    datum: NoDatum,
    reference_script: None,
  }
}

pub fn tx(
  inputs: List<Input>,
  outputs: List<Output>,
  signers: List<VerificationKeyHash>,
) -> Transaction {
  Transaction {
    ..transaction.placeholder,
    inputs: inputs,
    outputs: outputs,
    extra_signatories: signers,
  }
}

fn is_channel(i: Input) -> Bool {
  i.output.address.payment_credential == Script(own_hash)
}

/// Validates `tx` as the ledger would: runs the validator for every input at its address, in
/// input order, each with the redeemer given for it. Valid only if every run passes.
pub fn run(tx: Transaction, redeemers: List<t.Redeemer>) -> Bool {
  let channels = tx.inputs |> list.filter(is_channel)
  expect list.length(channels) == list.length(redeemers)
  list.zip(channels, redeemers)
    |> list.all(
        fn(pair) {
          let (i, redeemer) = pair
          expect InlineDatum(raw) = i.output.datum
          expect d: t.Datum = raw
          spend.do(d, redeemer, i.output_reference, tx)
        },
      )
}

/// The standard shape: the first channel input carries `Main(steps)`, every other one `Defer`.
pub fn main(tx: Transaction, steps: t.Steps) -> Bool {
  let n = tx.inputs |> list.count(is_channel)
  run(tx, [t.Main(steps), ..list.repeat(t.Defer, n - 1)])
}

pub fn sub(owed: Int, sig: ByteArray) -> t.Step {
  t.StepCont(t.Sub { n: owed, sig })
}

pub fn settle(owed: Int, sig: ByteArray) -> t.Step {
  t.StepCont(t.Settle { n: owed, sig })
}

pub const add: t.Step = t.StepCont(t.Add)

pub const close: t.Step = t.StepCont(t.Close)

pub const end: t.Step = t.StepEol(t.End)

pub const elapse: t.Step = t.StepEol(t.Elapse)

/// Key A's IOU for tag_1 at `owed`, which must be one of the vectors.
pub fn iou(owed: Int) -> ByteArray {
  expect Some((_, sig)) =
    vectors.ious_a_tag_1 |> list.find(fn(v) { v.1st == owed })
  sig
}

/// Any of key A's IOUs for tag_1: (owed, signature).
pub fn any_iou() -> Fuzzer<(Int, ByteArray)> {
  fuzz.one_of(vectors.ious_a_tag_1)
}

/// ADA or USDM.
pub fn any_currency() -> Fuzzer<t.Currency> {
  fuzz.one_of([t.Ada, usdm])
}

/// What a channel holds of its currency: at least one unit, up to a billion. (An ADA channel's
/// output with no lovelace would be an empty value, which no ledger output is.)
pub fn amount() -> Fuzzer<Int> {
  fuzz.int_between(1, 1_000_000_000)
}
