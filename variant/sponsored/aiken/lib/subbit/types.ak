// Modified from kompact-io/subbit-xyz @ 66648db for the sponsored variant (the 7th constant,
// `sponsor`); see variant/sponsored/PROVENANCE.md.

use aiken/crypto.{ScriptHash, Signature, VerificationKey, VerificationKeyHash}
use cardano/address.{Address}
use subbit/prelude.{Amount, Timestamp}

pub type Tag =
  ByteArray

pub type Currency {
  Ada
  Asset { hash: ScriptHash, name: ByteArray }
}

/// Who paid a token channel's reserve, and what they must get back.
///
/// `Address` is where the reserve goes back to when the channel ends (compared in full, stake
/// credential included). `Int` is the `floor`: the least lovelace that must reach it, and that a
/// continuing channel output must keep. See variant/sponsored/DESIGN.md.
pub type Sponsor =
  (Address, Int)

// Unwrap with
// let (tag, currency, iou_key, consumer, provider, close_period, sponsor) = constants
//
// `sponsor` is `None` for a channel that nobody sponsors: it then behaves as upstream's does.

pub type Constants =
  (
    Tag,
    Currency,
    VerificationKey,
    VerificationKeyHash,
    VerificationKeyHash,
    Int,
    Option<Sponsor>,
  )

// Flatten 
// { own_hash: ScriptHash, constants: Constants, stage: Stage, }
// Unwrap with: 
// let (own_hash, constants, stage) = datum
pub type Datum =
  (ScriptHash, Constants, Stage)

pub type Stage {
  Opened { subbed: Amount }
  Closed { subbed: Amount, elapse_at: Timestamp }
  Settled
}

pub type Redeemer {
  Defer
  Main(Steps)
  Mutual
}

pub type Step {
  StepCont(Cont)
  StepEol(Eol)
}

pub type Steps =
  List<Step>

pub type Cont {
  Add
  Sub { n: Amount, sig: Signature }
  Close
  Settle { n: Amount, sig: Signature }
}

pub type Eol {
  End
  Elapse
}
