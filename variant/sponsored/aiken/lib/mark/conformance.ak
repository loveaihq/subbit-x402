//// subbit-x402's client (src/subbit.ts) and the validator agree: byte for byte where bytes are
//// signed (IOUs), and value for value where the validator decodes (datums, redeemers).

use aiken/cbor
use aiken/collection/list
use mark/fixture.{add, close, constants, datum, elapse, end, settle, sub, usdm}
use mark/vectors
use subbit/iou
use subbit/types as t

/// The IOU body the client signs (iouBody) is the message iou.ak verifies, at every CBOR
/// integer width.
test iou_bodies_match_the_client() {
  list.all(
    vectors.bodies_tag_1,
    fn(v) {
      let (owed, body) = v
      let message: Data = (vectors.tag_1, owed)
      cbor.serialise(message) == body
    },
  )
}

test client_ious_verify() {
  list.all(
    vectors.ious_a_tag_1,
    fn(v) { iou.verify(vectors.iou_key_a, vectors.tag_1, v.1st, v.2nd) },
  )
}

test client_ious_are_for_their_amount_only() {
  list.all(
    vectors.ious_a_tag_1,
    fn(v) { !iou.verify(vectors.iou_key_a, vectors.tag_1, v.1st + 1, v.2nd) },
  )
}

test client_ious_are_for_their_tag_only() {
  list.all(
    vectors.ious_a_tag_1,
    fn(v) { !iou.verify(vectors.iou_key_a, vectors.tag_2, v.1st, v.2nd) },
  )
}

/// The datums the client writes (datumData) decode to the validator's own values.
test client_datums_decode() {
  let opened: Data = datum(constants(t.Ada), t.Opened { subbed: 2_500_000 })
  let closed: Data = datum(
    constants(usdm),
    t.Closed { subbed: 7, elapse_at: 1_790_000_000_000 },
  )
  let settled: Data = datum(constants(t.Ada), t.Settled)
  and {
    cbor.deserialise(vectors.datum_opened_ada) == Some(opened),
    cbor.deserialise(vectors.datum_closed_token) == Some(closed),
    cbor.deserialise(vectors.datum_settled_ada) == Some(settled),
  }
}

test client_redeemers_decode() {
  let s = vectors.step_sig
  let main: Data = t.Main(
    [add, sub(5_000_000, s), close, settle(7, s), end, elapse],
  )
  let defer: Data = t.Defer
  let mutual: Data = t.Mutual
  and {
    cbor.deserialise(vectors.redeemer_main) == Some(main),
    cbor.deserialise(vectors.redeemer_defer) == Some(defer),
    cbor.deserialise(vectors.redeemer_mutual) == Some(mutual),
  }
}
