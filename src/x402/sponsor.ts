// Seller-sponsored channels (SPONSORSHIP.md): the fee-sponsorship offer of cardano-x402-sponsor, its
// pool of the seller's ADA-only UTxOs, and what the seller checks before its witness goes on a
// sponsored opening, top-up or refund. The offer's wire format and the pool are that project's; the
// per-step rules are this binding's.
import {
  Address,
  Assets,
  Ed25519Signature,
  KeyHash,
  Transaction,
  TransactionHash,
  TransactionWitnessSet,
  UTxO,
  VKey,
} from "@evolution-sdk/evolution";
import { isChannelOutput, msOfSlot, networkIdOf, txHashOf } from "./cardano.ts";

// ---- the offer ---------------------------------------------------------------------

/** Key of the offer in `PaymentRequirements.extra`. */
export const OFFER_KEY = "feeSponsor";
/** Key a facilitator sets in its `/supported` kind `extra` when it merges the seller's witnesses. */
export const CAPABILITY_KEY = "acceptsSponsorWitnesses";
/** Key the resource server adds to the settlement payload: the seller's witness set, CBOR hex. */
export const WITNESS_KEY = "sponsorWitnesses";

export interface FeeSponsorOffer {
  /** The sponsor UTxO, lowercase `txHash#index`: ADA-only, at a key-credential address. */
  input: string;
  address: string;
  /** Its exact lovelace. */
  lovelace: string;
  /** The largest network fee the sponsor pays, in lovelace. */
  maxFee: string;
  /** POSIX ms; a transaction's validity upper bound may not be later. */
  expiresAt: string;
}

const REF = /^[0-9a-f]{64}#(0|[1-9][0-9]*)$/;
const INT = /^(0|[1-9][0-9]*)$/;
const FIELDS = ["input", "address", "lovelace", "maxFee", "expiresAt"] as const;

/** The offer an accept's `extra` carries, or undefined. Throws on a malformed one. */
export function offerIn(extra: Record<string, unknown> | undefined): FeeSponsorOffer | undefined {
  const raw = extra?.[OFFER_KEY];
  if (raw === undefined) return undefined;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error(`${OFFER_KEY} is not an object`);
  const o = raw as Record<string, unknown>;
  for (const f of FIELDS) if (typeof o[f] !== "string") throw new Error(`${OFFER_KEY}.${f} is not a string`);
  const unknown = Object.keys(o).filter((k) => !(FIELDS as readonly string[]).includes(k));
  if (unknown.length) throw new Error(`${OFFER_KEY} has unknown fields: ${unknown.join(", ")}`);
  return { input: o.input as string, address: o.address as string, lovelace: o.lovelace as string, maxFee: o.maxFee as string, expiresAt: o.expiresAt as string };
}

/** Why the offer cannot be used on `network` at `nowMs`, or undefined when it can. */
export function offerProblem(offer: FeeSponsorOffer, network: string, nowMs: number, marginMs = 5_000): string | undefined {
  if (!REF.test(offer.input)) return "input is not a lowercase txHash#index";
  let keyHash: string | undefined;
  try {
    keyHash = offerKeyHash(offer, network);
  } catch (e) {
    return (e as Error).message;
  }
  if (!keyHash) return "address has no key payment credential";
  for (const f of ["lovelace", "maxFee", "expiresAt"] as const) if (!INT.test(offer[f])) return `${f} is not a canonical integer`;
  if (BigInt(offer.maxFee) <= 0n || BigInt(offer.maxFee) >= BigInt(offer.lovelace)) return "maxFee must be positive and below lovelace";
  if (Number(offer.expiresAt) <= nowMs + marginMs) return "offer has expired";
  return undefined;
}

/** The payment key hash of the offer's address, or undefined for a script. Throws on another network. */
export function offerKeyHash(offer: Pick<FeeSponsorOffer, "address">, network: string): string | undefined {
  let a: Address.Address;
  try {
    a = Address.fromBech32(offer.address);
  } catch {
    throw new Error("address does not parse");
  }
  if (a.networkId !== networkIdOf(network)) throw new Error("address is on another network");
  return keyHashOf(a);
}

export function keyHashOf(a: Address.Address): string | undefined {
  return a.paymentCredential instanceof KeyHash.KeyHash ? KeyHash.toHex(a.paymentCredential).toLowerCase() : undefined;
}

/** The offer as the UTxO the SDK builds with. */
export function offerUtxo(offer: FeeSponsorOffer): UTxO.UTxO {
  const [h, i] = offer.input.split("#") as [string, string];
  return new UTxO.UTxO({ transactionId: TransactionHash.fromHex(h), index: BigInt(i), address: Address.fromBech32(offer.address), assets: Assets.fromLovelace(BigInt(offer.lovelace)) });
}

/**
 * Why a buyer must not build with `offer`, given what the chain holds at `offer.input` (undefined
 * when it holds nothing unspent there), or undefined when it may. The offer's address never enters
 * the transaction: the ledger asks for the witness of the UTxO's real owner. So an offer naming one
 * of the buyer's own UTxOs, under any address, has the buyer's own signature spend it, and its ADA
 * goes to `payTo` as the sponsor's would. The buyer reads the UTxO itself before trusting a field.
 */
export function offerOnChainProblem(offer: FeeSponsorOffer, onChain: UTxO.UTxO | undefined, buyerKeyHash: string): string | undefined {
  if (!onChain) return "the offered UTxO is not on chain unspent";
  const owner = keyHashOf(onChain.address);
  if (owner === buyerKeyHash.toLowerCase()) return "the offered UTxO is this wallet's own";
  if (Address.toBech32(onChain.address) !== offer.address) return "the offered UTxO is at another address than the offer names";
  if (!owner) return "the offered UTxO is not at a key";
  if (!Assets.hasOnlyLovelace(onChain.assets)) return "the offered UTxO holds tokens";
  if (Assets.lovelaceOf(onChain.assets) !== BigInt(offer.lovelace)) return `the offered UTxO holds ${Assets.lovelaceOf(onChain.assets)} lovelace, not the ${offer.lovelace} offered`;
  // Spending it would add the reference-script fee, which a fee built from the offer leaves out.
  if (onChain.scriptRef) return "the offered UTxO carries a reference script";
  return undefined;
}

/**
 * Why a refund of a channel whose reserve is the seller's does not pay that reserve back to
 * `payTo`, less the fee, or undefined when it does. It holds however the refund is paid for:
 * with the seller's offer as its collateral, or without one.
 */
export function reserveNotReturned(txHex: string, payTo: string, channelLovelace: bigint): string | undefined {
  const b = Transaction.fromCBORHex(txHex).body;
  const toPayTo = b.outputs.filter((o) => Address.toBech32(o.address) === payTo).reduce((s, o) => s + Assets.lovelaceOf(o.assets), 0n);
  if (toPayTo + b.fee >= channelLovelace) return undefined;
  return `the channel's ${channelLovelace} lovelace is the seller's reserve, and the refund pays payTo ${toPayTo} of it, with a fee of ${b.fee}`;
}

// ---- fees and witnesses ----------------------------------------------------------

export interface FeeParameters {
  minFeeA: bigint;
  minFeeB: bigint;
}

/** The ledger's fee floor for `sizeBytes`, script execution aside. */
export function feeFloor(sizeBytes: number, fees: FeeParameters): bigint {
  return fees.minFeeA * BigInt(sizeBytes) + fees.minFeeB;
}

/**
 * The fee floor once `n` more vkey witnesses are merged, measured by merging placeholders: the
 * size-dependent part plus, for a transaction that runs scripts, the execution cost already in
 * its fee over the size floor, which the witnesses do not change.
 */
export function sizeWith(txHex: string, n: number): number {
  if (n === 0) return txHex.length / 2;
  const placeholders = Array.from({ length: n }, (_, i) => {
    const key = new Uint8Array(32);
    key[0] = 0xfe;
    key[1] = i;
    return new TransactionWitnessSet.VKeyWitness({ vkey: VKey.fromBytes(key), signature: Ed25519Signature.fromBytes(new Uint8Array(64)) });
  });
  return Transaction.addVKeyWitnessesHex(txHex, TransactionWitnessSet.toCBORHex(TransactionWitnessSet.fromVKeyWitnesses(placeholders))).length / 2;
}

/** Key hashes (lowercase hex) of every vkey witness on a transaction. */
export function witnessKeyHashesOf(txHex: string): string[] {
  return (Transaction.fromCBORHex(txHex).witnessSet.vkeyWitnesses ?? []).map((w) => KeyHash.toHex(KeyHash.fromVKey(w.vkey)).toLowerCase());
}

// ---- the pool --------------------------------------------------------------------------

/** What the pool needs from the sponsor's wallet; an evolution-sdk seed client has all of it. */
export interface SponsorWallet {
  address(): Promise<Address.Address>;
  getWalletUtxos(): Promise<ReadonlyArray<UTxO.UTxO>>;
  signTx(txHex: string, context: { utxos: UTxO.UTxO[] }): Promise<TransactionWitnessSet.TransactionWitnessSet>;
}

export interface SponsorPoolConfig {
  wallet: SponsorWallet;
  /** Smallest UTxO worth offering: a channel's reserve, the fee, and an ADA-only change. Default 3.5 ADA. */
  minOfferLovelace?: bigint;
  /** Largest UTxO the pool offers; bigger ones are left for splitting. Default 6 ADA. */
  maxOfferLovelace?: bigint;
  /** Default 0.5 ADA: a channel's opening and top-up cost more than a plain payment. */
  maxFee?: bigint;
  now?: () => number;
}

interface Slot {
  utxo: UTxO.UTxO;
  lovelace: bigint;
  lastOffered: number;
}

interface Binding {
  txHash: string;
  witness?: string;
  /** Handed to settlement: the transaction may be on its way to the chain. */
  submitted: boolean;
  /** POSIX ms after which nothing that could spend the UTxO can still land. */
  validUntil: number;
}

const refOfUtxo = (u: UTxO.UTxO) => UTxO.toOutRefString(u).toLowerCase();
const sameOffer = (a: FeeSponsorOffer, b: FeeSponsorOffer) =>
  a.input === b.input && a.address === b.address && a.lovelace === b.lovelace && a.maxFee === b.maxFee && a.expiresAt === b.expiresAt;
const GRACE_MS = 120_000;

/**
 * The sponsor key's offer-sized UTxOs. Offers are soft: serving one locks nothing, so unpaid 402s
 * cannot drain the pool. Binding is exclusive: the seller signs at most one transaction per UTxO.
 */
export class SponsorPool {
  readonly maxFee: bigint;
  private readonly minOffer: bigint;
  private readonly maxOffer: bigint;
  private readonly now: () => number;
  private address?: string;
  private keyHash?: string;
  private readonly slots = new Map<string, Slot>();
  private readonly offers = new Map<string, FeeSponsorOffer[]>();
  private readonly bindings = new Map<string, Binding>();

  constructor(private readonly cfg: SponsorPoolConfig) {
    this.maxFee = cfg.maxFee ?? 500_000n;
    this.minOffer = cfg.minOfferLovelace ?? 3_500_000n;
    this.maxOffer = cfg.maxOfferLovelace ?? 6_000_000n;
    this.now = cfg.now ?? Date.now;
    if (this.maxFee >= this.minOffer) throw new Error("maxFee must be below minOfferLovelace");
  }

  async identity(): Promise<{ address: string; keyHash: string }> {
    if (!this.address) {
      const a = await this.cfg.wallet.address();
      const kh = keyHashOf(a);
      if (!kh) throw new Error("the sponsor wallet's address has no key payment credential");
      this.address = Address.toBech32(a);
      this.keyHash = kh;
    }
    return { address: this.address, keyHash: this.keyHash! };
  }

  /**
   * Re-reads the sponsor address. A slot whose UTxO is gone was spent by a transaction the seller
   * signed and is retired, unless it is bound and was never handed to settlement: then the listing
   * is behind. A binding whose transaction can no longer land is released.
   */
  async refresh(): Promise<void> {
    await this.identity();
    let listed: ReadonlyArray<UTxO.UTxO> | undefined;
    for (let attempt = 1; !listed; attempt++) {
      try {
        listed = await this.cfg.wallet.getWalletUtxos();
      } catch (e) {
        if (attempt >= 3) throw e;
        await new Promise((r) => setTimeout(r, 1_500 * attempt));
      }
    }
    const seen = new Set<string>();
    for (const u of listed) {
      const lovelace = Assets.lovelaceOf(u.assets);
      if (!Assets.hasOnlyLovelace(u.assets) || lovelace < this.minOffer || lovelace > this.maxOffer) continue;
      const r = refOfUtxo(u);
      seen.add(r);
      if (!this.slots.has(r)) this.slots.set(r, { utxo: u, lovelace, lastOffered: 0 });
    }
    for (const r of [...this.slots.keys()]) {
      if (seen.has(r)) continue;
      const b = this.bindings.get(r);
      if (!b || b.submitted) this.retire(r);
    }
    const now = this.now();
    for (const [r, b] of this.bindings) if (now > b.validUntil + GRACE_MS && this.slots.has(r)) this.bindings.delete(r);
    for (const [r, list] of this.offers) {
      const live = list.filter((o) => Number(o.expiresAt) > now);
      if (live.length) this.offers.set(r, live);
      else this.offers.delete(r);
    }
  }

  size(): { utxos: number; bound: number } {
    return { utxos: this.slots.size, bound: this.bindings.size };
  }

  /** A fresh offer running `ttlMs` on the unbound UTxO offered least recently, or undefined. */
  async offer(ttlMs: number): Promise<FeeSponsorOffer | undefined> {
    const { address } = await this.identity();
    const pick = [...this.slots.entries()].filter(([r]) => !this.bindings.has(r)).sort((a, b) => a[1].lastOffered - b[1].lastOffered)[0];
    if (!pick) return undefined;
    const [r, slot] = pick;
    const now = this.now();
    slot.lastOffered = now;
    const o: FeeSponsorOffer = { input: r, address, lovelace: slot.lovelace.toString(), maxFee: this.maxFee.toString(), expiresAt: String(now + ttlMs) };
    this.offers.set(r, [...(this.offers.get(r) ?? []), o]);
    return o;
  }

  /**
   * An offer this pool made, not yet expired, on a UTxO it still holds, whether or not someone has
   * bound it since: a paid request echoing it must match its 402 even when it does not spend it.
   */
  known(o: FeeSponsorOffer): boolean {
    return Number(o.expiresAt) > this.now() && this.slots.has(o.input) && (this.offers.get(o.input) ?? []).some((x) => sameOffer(x, o));
  }

  /** Binds the offer's UTxO to `txHash`; false if unknown, expired, or bound to another transaction. */
  bind(o: FeeSponsorOffer, txHash: string, validUntil: number): boolean {
    if (!this.known(o)) return false;
    const b = this.bindings.get(o.input);
    if (b && b.txHash !== txHash) return false;
    if (!b) this.bindings.set(o.input, { txHash, submitted: false, validUntil });
    return true;
  }

  /** Signs for the bound UTxO, as an input or as collateral: exactly one vkey witness, kept. */
  async sign(o: FeeSponsorOffer, txHash: string, txHex: string): Promise<string> {
    const b = this.bindings.get(o.input);
    const slot = this.slots.get(o.input);
    if (!b || b.txHash !== txHash || !slot) throw new Error("the offer is not bound to this transaction");
    if (b.witness) return b.witness;
    const ws = await this.cfg.wallet.signTx(txHex, { utxos: [slot.utxo] });
    if (ws.vkeyWitnesses?.length !== 1) throw new Error(`the sponsor wallet produced ${ws.vkeyWitnesses?.length ?? 0} witnesses, expected 1`);
    b.witness = TransactionWitnessSet.toCBORHex(ws);
    return b.witness;
  }

  /** The stored witness for the bound transaction; marks it handed to settlement. */
  witnessFor(o: FeeSponsorOffer, txHash: string): string | undefined {
    const b = this.bindings.get(o.input);
    if (!b || b.txHash !== txHash || !b.witness) return undefined;
    b.submitted = true;
    return b.witness;
  }

  /** Ends a binding whose transaction cannot have landed, or, for collateral, has landed. */
  release(input: string, txHash: string, definitive = false): void {
    const b = this.bindings.get(input);
    if (b && b.txHash === txHash && (!b.submitted || definitive)) this.bindings.delete(input);
  }

  /** The UTxO was spent: drop it, its offers and its binding. */
  retire(input: string): void {
    this.slots.delete(input);
    this.offers.delete(input);
    this.bindings.delete(input);
  }
}

// ---- what the seller checks before it signs ----------------------------------------

export type OwnerLookup = (ref: string) => Promise<{ exists: boolean; paymentKeyHash?: string }>;

export interface SponsorCheck {
  /** The transaction as it will be broadcast, less the witnesses still to come. */
  txHex: string;
  offer: FeeSponsorOffer;
  network: string;
  /** bech32 */
  payTo: string;
  sponsorKeyHash: string;
  ownerOf: OwnerLookup;
  fees: FeeParameters;
  /** Vkey witnesses still to be merged before broadcast. */
  missingWitnesses: number;
  /** Most total collateral the sponsor's UTxO may put up. Default 2 ADA. */
  maxCollateral?: bigint;
}

export type SponsorResult = { ok: true; txHash: string; fee: bigint } | { ok: false; rule: string; detail: string };

export class SponsorRefusal extends Error {
  constructor(
    readonly rule: string,
    readonly detail: string,
  ) {
    super(`${rule}: ${detail}`);
  }
}

const no = (rule: string, detail: string): never => {
  throw new SponsorRefusal(rule, detail);
};
const present = (v: unknown) => v !== undefined && v !== null && !(Array.isArray(v) && v.length === 0);
const refOfInput = (i: { transactionId: TransactionHash.TransactionHash; index: bigint }) => `${TransactionHash.toHex(i.transactionId).toLowerCase()}#${Number(i.index)}`;

/**
 * The checks every sponsored step shares (S5, S6, S7, S9, and S2 over inputs and collateral), with
 * the offered input allowed only in the role `role` gives it. Returns the decoded transaction.
 */
async function common(c: SponsorCheck, role: "input" | "collateral"): Promise<Transaction.Transaction> {
  let tx: Transaction.Transaction;
  try {
    tx = Transaction.fromCBORHex(c.txHex);
  } catch (e) {
    return no("decode", (e as Error).message);
  }
  const b = tx.body;
  const inputs = b.inputs.map(refOfInput);
  const collateral = (b.collateralInputs ?? []).map(refOfInput);
  if (role === "input" && !inputs.includes(c.offer.input)) no("S1", "the transaction does not spend the offered input");
  if (role === "collateral" && (!collateral.includes(c.offer.input) || inputs.includes(c.offer.input))) no("S1", "the offered input must be collateral, and only collateral");
  if (present(b.mint) || present(b.withdrawals) || present(b.certificates) || present(b.votingProcedures) || present(b.proposalProcedures) || present(b.donation) || present(b.currentTreasuryValue)) {
    no("S6", "mint, withdrawals, certificates, governance and treasury fields are not allowed");
  }
  if (tx.isValid === false) no("S3", "the transaction is marked phase-2 invalid");
  if (b.fee > BigInt(c.offer.maxFee)) no("S5", `fee ${b.fee} exceeds maxFee ${c.offer.maxFee}`);
  if (b.ttl === undefined) no("S7", "the transaction has no validity upper bound");
  if (msOfSlot(c.network, b.ttl!) > BigInt(c.offer.expiresAt)) no("S7", "the validity upper bound is after the offer expires");
  const floor = feeFloor(sizeWith(c.txHex, c.missingWitnesses), c.fees);
  // A script's execution units are paid on top of the size floor; the witnesses change only the size.
  if (b.fee < floor) no("S9", `fee ${b.fee} is below the size floor ${floor} for the fully witnessed transaction`);
  for (const ref of [...inputs, ...collateral]) {
    if (ref === c.offer.input) continue;
    let owner: Awaited<ReturnType<OwnerLookup>>;
    try {
      owner = await c.ownerOf(ref);
    } catch (e) {
      return no("S2", `could not look up ${ref}: ${(e as Error).message}`);
    }
    if (!owner.exists) no("S2", `input ${ref} is spent or unknown`);
    if (owner.paymentKeyHash?.toLowerCase() === c.sponsorKeyHash) no("S2", `input ${ref} is at the sponsor's key too`);
  }
  return tx;
}

/** Lovelace of the outputs at `payTo`. */
function toPayTo(tx: Transaction.Transaction, payTo: string): bigint {
  return tx.body.outputs.filter((o) => Address.toBech32(o.address) === payTo).reduce((s, o) => s + Assets.lovelaceOf(o.assets), 0n);
}

/** Collateral: only the offered input, a return to `payTo` or the sponsor, and a bounded total. */
function collateralOnlyOffered(tx: Transaction.Transaction, c: SponsorCheck) {
  const b = tx.body;
  const collateral = (b.collateralInputs ?? []).map(refOfInput);
  if (collateral.some((r) => r !== c.offer.input)) no("S3", "collateral may only be the offered input");
  if (b.collateralReturn && ![c.payTo, c.offer.address].includes(Address.toBech32(b.collateralReturn.address))) no("S3", "the collateral return must pay payTo or the sponsor");
  const total = b.totalCollateral ?? (collateral.length ? BigInt(c.offer.lovelace) - (b.collateralReturn ? Assets.lovelaceOf(b.collateralReturn.assets) : 0n) : 0n);
  if (total > (c.maxCollateral ?? 2_000_000n)) no("S3", `total collateral ${total} exceeds ${c.maxCollateral ?? 2_000_000n}`);
}

/**
 * An opening: the offered input pays the channel's reserve and the fee, the rest goes to `payTo`,
 * and the channel holds no more ADA than its reserve. No script runs, so no collateral.
 */
export async function checkSponsoredOpen(c: SponsorCheck & { scriptHash: string; reserve: bigint }): Promise<SponsorResult> {
  try {
    const tx = await common(c, "input");
    const b = tx.body;
    if (present(b.collateralInputs) || present(b.collateralReturn) || present(b.totalCollateral) || present(b.scriptDataHash)) no("S3", "an opening runs no script: no collateral");
    const w = tx.witnessSet;
    if (present(w.redeemers) || present(w.plutusV1Scripts) || present(w.plutusV2Scripts) || present(w.plutusV3Scripts) || present(w.nativeScripts)) no("S3", "an opening runs no script");
    const channels = b.outputs.filter((o) => isChannelOutput(o.address, c.scriptHash));
    if (channels.length !== 1) no("S4", `expected one channel output, found ${channels.length}`);
    const channelL = Assets.lovelaceOf(channels[0]!.assets);
    if (channelL > c.reserve) no("S4", `the channel holds ${channelL} lovelace, more than its reserve ${c.reserve}`);
    const s = BigInt(c.offer.lovelace);
    const paid = toPayTo(tx, c.payTo);
    if (paid + channelL + b.fee < s) no("S4", `channel ${channelL} + payTo ${paid} + fee ${b.fee} < the sponsor's ${s}: the rest would go elsewhere`);
    return { ok: true, txHash: txHashOf(c.txHex), fee: b.fee };
  } catch (e) {
    if (e instanceof SponsorRefusal) return { ok: false, rule: e.rule, detail: e.detail };
    throw e;
  }
}

/**
 * A top-up: the offered input pays the fee and is the collateral; everything else of it goes to
 * `payTo`, so none of it reaches the channel or the buyer.
 */
export async function checkSponsoredTopUp(c: SponsorCheck): Promise<SponsorResult> {
  try {
    const tx = await common(c, "input");
    collateralOnlyOffered(tx, c);
    const s = BigInt(c.offer.lovelace);
    const paid = toPayTo(tx, c.payTo);
    if (paid + tx.body.fee < s) no("S4", `payTo ${paid} + fee ${tx.body.fee} < the sponsor's ${s}: the rest would reach the channel or the buyer`);
    return { ok: true, txHash: txHashOf(c.txHex), fee: tx.body.fee };
  } catch (e) {
    if (e instanceof SponsorRefusal) return { ok: false, rule: e.rule, detail: e.detail };
    throw e;
  }
}

/**
 * A refund: the offered input is only its collateral. For a channel whose reserve is the seller's,
 * the channel's ADA less the fee goes back to `payTo`, and every other input is the consumer's own.
 * The evaluator must accept the transaction: the collateral is forfeit only if a script fails.
 */
export async function checkSponsoredRefund(
  c: SponsorCheck & { channelRef: string; channelLovelace: bigint; consumerKeyHash: string; reserveFromSeller: boolean; evaluate: () => Promise<void> },
): Promise<SponsorResult> {
  try {
    const tx = await common(c, "collateral");
    collateralOnlyOffered(tx, c);
    if (c.reserveFromSeller) {
      for (const ref of tx.body.inputs.map(refOfInput)) {
        if (ref === c.channelRef) continue;
        const owner = await c.ownerOf(ref);
        if (owner.paymentKeyHash?.toLowerCase() !== c.consumerKeyHash) no("S4", `input ${ref} is not the consumer's own`);
      }
      const paid = toPayTo(tx, c.payTo);
      if (paid + tx.body.fee < c.channelLovelace) no("S4", `payTo ${paid} + fee ${tx.body.fee} < the channel's ${c.channelLovelace}: the seller's reserve would go elsewhere`);
    }
    try {
      await c.evaluate();
    } catch (e) {
      no("S3", `evaluation: ${(e as Error).message}`);
    }
    return { ok: true, txHash: txHashOf(c.txHex), fee: tx.body.fee };
  } catch (e) {
    if (e instanceof SponsorRefusal) return { ok: false, rule: e.rule, detail: e.detail };
    throw e;
  }
}
