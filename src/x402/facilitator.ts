// The facilitator side of the Cardano binding (DESIGN.md §6, §8). By default it holds no key and
// no funds: it checks payloads against the chain and broadcasts transactions other parties signed,
// the client's channel opening, the server's batched claim, the co-signed `Mutual` refund. A server
// may instead delegate its provider key to it (`delegates`): the facilitator then builds and signs
// that server's claims and co-signs its refunds, paying only the server's registered `payTo`, and
// only for requests the server has authenticated. Subbit does not restrict where a redemption pays,
// so this is custody, not an authorisation: the server trusts the facilitator with its revenue.
import { TransactionWitnessSet } from "@evolution-sdk/evolution";
import type { PaymentPayload, PaymentRequirements, SchemeNetworkFacilitator, SettleResponse, VerifyResponse } from "@x402/core/types";
import { Address, Data, Transaction, TransactionHash } from "@evolution-sdk/evolution";
import { capacityOf, channelStateOf, datumBindingError, readChannel, txHashOf, verifyVoucherSignature, type ChannelView } from "./cardano.ts";
import type { Chain } from "./chain.ts";
import { buildClaimTx, compareRefs, type ClaimLine } from "./claimtx.ts";
import type { SeedWallet } from "./client.ts";
import { channelOutputIndex, checkDeposit, checkInputWitnesses, checkMutual, checkTopUp, decodeTx, sortedInputRefs, spendRedeemers, TxCheckError } from "./txcheck.ts";
import {
  Err,
  PayloadError,
  SCHEME,
  SETTLEMENT_PENDING,
  checkDelegationMac,
  configBindingError,
  fromBase64,
  parseClaimPayload,
  parseClientPayload,
  parseExtra,
  type BatchExtra,
  type ClaimPayload,
  type DepositPayload,
  type RefundPayload,
  type VoucherPayload,
} from "./types.ts";

export interface FacilitatorOptions {
  /** The Subbit validator this facilitator serves. */
  scriptHash: string;
  /** How long `/settle` waits for a transaction to reach a block before answering `settlement_pending`. */
  confirmationTimeoutMs?: number;
  /** Provider keys servers have delegated to this facilitator, one per server. */
  delegates?: Delegate[];
}

/** A provider key held for one server. */
export interface Delegate {
  /** Its key is the `provider` of that server's channels; it pays claim fees and collateral. */
  wallet: SeedWallet;
  keyHash: string;
  /** The server's `payTo`: every claim this key signs pays there, and every refund it co-signs must. */
  payTo: string;
  /** Shared with the server, which authenticates each claim and refund with it (`delegationMac`). */
  secret: string;
  referenceScript?: string;
}

type Verified = { ok: true; payer: string; extra: Record<string, unknown>; channel?: ChannelView } | { ok: false; reason: string; message: string; payer?: string };

export class BatchSettlementCardanoFacilitator implements SchemeNetworkFacilitator {
  readonly scheme = SCHEME;
  readonly caipFamily = "cardano:*";
  /** Transactions already broadcast, so a retried `/settle` waits on the same one. */
  private readonly submitted = new Set<string>();
  /** Delegated keys by the `payTo` they serve, and the inputs each one's claims just spent. */
  private readonly delegates = new Map<string, { d: Delegate; spent: Map<string, number> }>();

  constructor(
    private readonly chain: Chain,
    private readonly options: FacilitatorOptions,
  ) {
    for (const d of options.delegates ?? []) {
      if (this.delegates.has(d.payTo)) throw new Error(`two delegated keys for ${d.payTo}`);
      this.delegates.set(d.payTo, { d, spent: new Map() });
    }
  }

  getExtra(): Record<string, unknown> | undefined {
    return undefined;
  }

  /** The provider keys it holds for servers, if any. Each server is told its own out of band. */
  getSigners(): string[] {
    return [...this.delegates.values()].map(({ d }) => d.keyHash);
  }

  async verify(paymentPayload: PaymentPayload, requirements: PaymentRequirements): Promise<VerifyResponse> {
    const v = await this.check(paymentPayload, requirements);
    return v.ok ? { isValid: true, payer: v.payer, extra: v.extra } : { isValid: false, invalidReason: v.reason, invalidMessage: v.message, ...(v.payer ? { payer: v.payer } : {}) };
  }

  async settle(paymentPayload: PaymentPayload, requirements: PaymentRequirements): Promise<SettleResponse> {
    const failed = (reason: string, message: string, transaction = "", payer?: string): SettleResponse => ({
      success: false,
      errorReason: reason,
      errorMessage: message,
      transaction,
      network: requirements.network,
      ...(payer ? { payer } : {}),
    });
    try {
      const raw = paymentPayload.payload as { type?: unknown };
      if (raw?.type === "claim") return await this.settleClaim(paymentPayload, requirements);
      if (raw?.type === "voucher") return failed(Err.payloadType, "vouchers are settled by the resource server, not on chain");

      const v = await this.check(paymentPayload, requirements);
      if (!v.ok) return failed(v.reason, v.message, "", v.payer);
      const p = parseClientPayload(paymentPayload.payload);
      if (p.type === "deposit") return await this.settleDeposit(p, requirements, v.payer);
      if (p.type === "refund") return await this.settleRefund(p, paymentPayload.payload, requirements, v.payer, v.channel!);
      return failed(Err.payloadType, "unsupported payload");
    } catch (e) {
      if (e instanceof PayloadError || e instanceof TxCheckError) return failed(e.reason, e.message);
      return failed(Err.transactionFailed, (e as Error).message);
    }
  }

  // ---- checks shared by verify and settle ------------------------------------------

  private async check(paymentPayload: PaymentPayload, requirements: PaymentRequirements): Promise<Verified> {
    let payer: string | undefined;
    try {
      if (paymentPayload.accepted.scheme !== SCHEME || requirements.scheme !== SCHEME) return bad(Err.scheme, "not batch-settlement");
      if (paymentPayload.accepted.network !== requirements.network) return bad(Err.network, "accepted network differs");
      const p = parseClientPayload(paymentPayload.payload);
      payer = p.channelConfig.payer;
      const extra = parseExtra(requirements);
      if (extra.scriptHash !== this.options.scriptHash) return bad(Err.extra, `this facilitator serves script ${this.options.scriptHash}`, payer);
      const bind = configBindingError(p.channelConfig, requirements, extra);
      if (bind) return bad(bind, "channel config does not match the payment requirements", payer);
      switch (p.type) {
        case "deposit":
          return await this.checkDeposit(p, requirements, extra);
        case "voucher":
          return await this.checkVoucher(p, extra, false);
        case "refund":
          return await this.checkRefund(p, requirements, extra);
      }
    } catch (e) {
      if (e instanceof PayloadError || e instanceof TxCheckError) return bad(e.reason, e.message, payer);
      return bad(Err.verificationStateUnavailable, (e as Error).message, payer);
    }
  }

  /**
   * A top-up: a deposit on a channel that already exists, named by `voucher.channelRef`. The
   * facilitator finds the channel open, checks the transaction's shape, has the evaluator run
   * the validator, and answers with the channel's state before the top-up, as EVM does.
   */
  private async checkTopUp(p: DepositPayload, req: PaymentRequirements, extra: BatchExtra): Promise<Verified> {
    const payer = p.channelConfig.payer;
    const found = await this.locate(p as unknown as VoucherPayload, extra);
    if ("ok" in found) return found;
    const ch = found;
    if (ch.datum.stage.kind !== "opened") return bad(Err.channelClosed, `channel is ${ch.datum.stage.kind}`, payer);
    const cpb = await this.chain.coinsPerUtxoByte();
    const hex = fromBase64(p.deposit.transaction);
    const t = checkTopUp(hex, req.network, ch, BigInt(p.deposit.amount), cpb);
    const resolved = [];
    for (const ref of t.otherInputRefs) {
      const u = await this.chain.getUnspent(ref);
      if (!u) return bad(Err.depositTransaction, `input ${ref} is spent or unknown`, payer);
      resolved.push(u.address);
    }
    checkInputWitnesses(t.tx, hex, resolved, Err.depositTransaction);
    try {
      await this.chain.evaluate(hex);
    } catch (e) {
      return bad(Err.depositTransaction, `evaluation: ${(e as Error).message}`, payer);
    }
    const ceiling = BigInt(p.voucher.maxClaimableAmount);
    if (ceiling > t.capacity) return bad(Err.cumulativeExceedsBalance, `voucher ${ceiling} exceeds capacity ${t.capacity} after the top-up`, payer);
    if (ceiling <= ch.datum.stage.subbed) return bad(Err.cumulativeBelowClaimed, `voucher ${ceiling} is not above what was redeemed`, payer);
    if (!verifyVoucherSignature(p.channelConfig.payerAuthorizer, p.voucher.channelId, ceiling, p.voucher.signature)) {
      return bad(Err.voucherSignature, "voucher signature does not verify", payer);
    }
    return { ok: true, payer, extra: { ...channelStateOf(ch, cpb) } };
  }

  private async checkDeposit(p: DepositPayload, req: PaymentRequirements, extra: BatchExtra): Promise<Verified> {
    if (p.voucher.channelRef) return this.checkTopUp(p, req, extra);
    const cpb = await this.chain.coinsPerUtxoByte();
    const hex = fromBase64(p.deposit.transaction);
    const d = checkDeposit(hex, req.network, p.channelConfig, p.voucher.channelId, extra.scriptHash, BigInt(p.deposit.amount), cpb);
    // Every input must exist and be unspent, and every key-locked one signed for.
    const resolved = [];
    for (const ref of d.inputRefs) {
      const u = await this.chain.getUnspent(ref);
      if (!u) return bad(Err.depositTransaction, `input ${ref} is spent or unknown`, p.channelConfig.payer);
      resolved.push(u.address);
    }
    checkInputWitnesses(d.tx, hex, resolved, Err.depositTransaction);
    const ceiling = BigInt(p.voucher.maxClaimableAmount);
    if (ceiling > d.capacity) return bad(Err.cumulativeExceedsBalance, `voucher ${ceiling} exceeds capacity ${d.capacity}`, p.channelConfig.payer);
    if (ceiling <= 0n) return bad(Err.cumulativeBelowClaimed, "a deposit voucher must charge something", p.channelConfig.payer);
    if (!verifyVoucherSignature(p.channelConfig.payerAuthorizer, p.voucher.channelId, ceiling, p.voucher.signature)) {
      return bad(Err.voucherSignature, "voucher signature does not verify", p.channelConfig.payer);
    }
    return {
      ok: true,
      payer: p.channelConfig.payer,
      extra: { channelId: p.voucher.channelId, channelRef: "", balance: d.capacity.toString(), totalClaimed: "0", withdrawRequestedAt: 0 },
    };
  }

  private async locate(p: VoucherPayload | RefundPayload, extra: BatchExtra): Promise<ChannelView | Verified> {
    if (!p.voucher.channelRef) return bad(Err.payload, "voucher.channelRef is required to find the channel", p.channelConfig.payer);
    const ch = await this.chain.followChannel(p.voucher.channelRef, extra.scriptHash, p.voucher.channelId);
    if (!ch) return bad(Err.channelNotFound, "no open channel with this id from that reference", p.channelConfig.payer);
    const bind = datumBindingError(ch.datum, p.channelConfig, p.voucher.channelId, extra.scriptHash);
    if (bind) return bad(bind, "channel datum does not match the channel config", p.channelConfig.payer);
    return ch;
  }

  private async checkVoucher(p: VoucherPayload | RefundPayload, extra: BatchExtra, isRefund: boolean): Promise<Verified> {
    const found = await this.locate(p, extra);
    if ("ok" in found) return found;
    const ch = found;
    const payer = p.channelConfig.payer;
    if (ch.datum.stage.kind !== "opened") return bad(Err.channelClosed, `channel is ${ch.datum.stage.kind}`, payer);
    const cpb = await this.chain.coinsPerUtxoByte();
    const ceiling = BigInt(p.voucher.maxClaimableAmount);
    const capacity = capacityOf(ch, cpb);
    const subbed = ch.datum.stage.subbed;
    if (ceiling > capacity) return bad(Err.cumulativeExceedsBalance, `voucher ${ceiling} exceeds capacity ${capacity}`, payer);
    if (isRefund ? ceiling < subbed : ceiling <= subbed) return bad(Err.cumulativeBelowClaimed, `voucher ${ceiling} is not above what was redeemed, ${subbed}`, payer);
    if (!verifyVoucherSignature(p.channelConfig.payerAuthorizer, p.voucher.channelId, ceiling, p.voucher.signature)) {
      return bad(Err.voucherSignature, "voucher signature does not verify", payer);
    }
    return { ok: true, payer, extra: { ...channelStateOf(ch, cpb) }, channel: ch };
  }

  private async checkRefund(p: RefundPayload, req: PaymentRequirements, extra: BatchExtra): Promise<Verified> {
    const v = await this.checkVoucher(p, extra, true);
    if (!v.ok) return v;
    const ch = v.channel!;
    const subbed = ch.datum.stage.kind === "opened" ? ch.datum.stage.subbed : 0n;
    const owed = BigInt(p.voucher.maxClaimableAmount) - subbed;
    const hex = p.providerWitness ? Transaction.addVKeyWitnessesHex(fromBase64(p.transaction), p.providerWitness) : fromBase64(p.transaction);
    const collateral = await this.resolveCollateral(hex);
    checkMutual(hex, req.network, extra.scriptHash, ch.ref, p.channelConfig.payer, p.channelConfig.receiverAuthorizer, req.payTo, ch.datum.constants.currency, owed, collateral);
    return v;
  }

  private async resolveCollateral(hex: string): Promise<Address.Address[]> {
    const tx = decodeTx(hex, Err.refundTransaction);
    const out: Address.Address[] = [];
    for (const c of tx.body.collateralInputs ?? []) {
      const ref = `${TransactionHash.toHex(c.transactionId)}#${c.index}`;
      const u = await this.chain.getUnspent(ref);
      if (!u) throw new TxCheckError(Err.refundTransaction, `collateral ${ref} is spent or unknown`);
      out.push(u.address);
    }
    return out;
  }

  // ---- settlement ---------------------------------------------------------------

  /** Broadcasts once, then waits for a block; a timeout is `settlement_pending`, and a retry only waits again. */
  private async broadcast(hex: string): Promise<{ txHash: string; confirmed: boolean }> {
    const txHash = txHashOf(hex);
    if (!this.submitted.has(txHash)) {
      await this.chain.submit(hex);
      this.submitted.add(txHash);
    }
    let confirmed = false;
    try {
      confirmed = await this.chain.awaitTx(txHash, this.options.confirmationTimeoutMs ?? 100_000);
    } catch {
      // Unknown is not failed: the transaction is out there and may still land.
    }
    return { txHash, confirmed };
  }

  private async settleDeposit(p: DepositPayload, req: PaymentRequirements, payer: string): Promise<SettleResponse> {
    const hex = fromBase64(p.deposit.transaction);
    const { txHash, confirmed } = await this.broadcast(hex);
    if (!confirmed) return { success: false, errorReason: SETTLEMENT_PENDING, transaction: txHash, network: req.network, payer };
    const index = channelOutputIndex(decodeTx(hex, Err.depositTransaction), parseExtra(req).scriptHash);
    const ch = await this.chain.followChannel(`${txHash}#${index}`, parseExtra(req).scriptHash, p.voucher.channelId);
    if (!ch) return { success: false, errorReason: Err.channelNotFound, errorMessage: "the opened channel is not readable", transaction: txHash, network: req.network, payer };
    return {
      success: true,
      transaction: txHash,
      network: req.network,
      payer,
      amount: p.deposit.amount,
      extra: { channelState: channelStateOf(ch, await this.chain.coinsPerUtxoByte()) },
    };
  }

  private async settleRefund(p: RefundPayload, raw: object, req: PaymentRequirements, payer: string, ch: ChannelView): Promise<SettleResponse> {
    let witness = p.providerWitness;
    if (!witness) {
      // A delegated key signs only its own server's refunds, and only those the server vouched for.
      const held = this.delegates.get(req.payTo);
      if (!held || held.d.keyHash !== ch.datum.constants.provider) {
        return { success: false, errorReason: Err.refundTransaction, errorMessage: "the provider has not signed", transaction: "", network: req.network, payer };
      }
      if (!checkDelegationMac(held.d.secret, req.payTo, raw)) {
        return { success: false, errorReason: Err.refundTransaction, errorMessage: "refund not authenticated by the server whose key this facilitator holds", transaction: "", network: req.network, payer };
      }
      witness = TransactionWitnessSet.toCBORHex(await held.d.wallet.signTx(fromBase64(p.transaction)));
    }
    const hex = Transaction.addVKeyWitnessesHex(fromBase64(p.transaction), witness);
    const { txHash, confirmed } = await this.broadcast(hex);
    if (!confirmed) return { success: false, errorReason: SETTLEMENT_PENDING, transaction: txHash, network: req.network, payer };
    const subbed = ch.datum.stage.kind === "opened" ? ch.datum.stage.subbed : 0n;
    const fee = decodeTx(hex, Err.refundTransaction).body.fee;
    const owed = BigInt(p.voucher.maxClaimableAmount) - subbed;
    // What the consumer nets in the currency: the channel less the provider's share, and for an
    // ADA channel less the fee paid out of it too (a token channel's fee comes from its ADA).
    const back = ch.amount - owed - (ch.datum.constants.currency.kind === "ada" ? fee : 0n);
    return {
      success: true,
      transaction: txHash,
      network: req.network,
      payer,
      amount: back.toString(),
      extra: { channelState: { channelId: p.voucher.channelId, channelRef: "", balance: "0", totalClaimed: p.voucher.maxClaimableAmount, withdrawRequestedAt: 0 } },
    };
  }

  /**
   * A server-signed claim (`Sub`, or `Settle` for a closed channel) over one or more channels: every spent channel of this script is
   * redeemed through `Main`/`Defer`, never `Mutual`; the evaluator must accept every script.
   * The facilitator broadcasts and reports where each channel now sits.
   */
  private async settleClaim(paymentPayload: PaymentPayload, req: PaymentRequirements): Promise<SettleResponse> {
    const p = parseClaimPayload(paymentPayload.payload);
    if (p.transaction === undefined) return this.settleDelegatedClaim(p, paymentPayload.payload, req);
    const hex = fromBase64(p.transaction);
    const tx = decodeTx(hex, Err.claimTransaction);
    const scriptHash = this.options.scriptHash;
    const refs = sortedInputRefs(tx);
    const redeemers = spendRedeemers(tx);
    const mutual = Data.toCBORHex(Data.constr(2n, []));
    let channels = 0;
    for (let i = 0; i < refs.length; i++) {
      const u = await this.chain.getUnspent(refs[i]!);
      if (!u) return { success: false, errorReason: Err.claimTransaction, errorMessage: `input ${refs[i]} is spent or unknown`, transaction: "", network: req.network };
      const ch = readChannel(u, scriptHash);
      if ("error" in ch) continue;
      channels++;
      const r = redeemers.get(i);
      if (!r || Data.toCBORHex(r) === mutual) return { success: false, errorReason: Err.claimTransaction, errorMessage: "a claim redeems through Main/Defer only", transaction: "", network: req.network };
    }
    if (channels !== p.claims.length) return { success: false, errorReason: Err.claimTransaction, errorMessage: `claims list ${p.claims.length} channels, transaction spends ${channels}`, transaction: "", network: req.network };
    try {
      await this.chain.evaluate(hex);
    } catch (e) {
      return { success: false, errorReason: Err.claimTransaction, errorMessage: `evaluation: ${(e as Error).message}`, transaction: "", network: req.network };
    }
    const { txHash, confirmed } = await this.broadcast(hex);
    if (!confirmed) return { success: false, errorReason: SETTLEMENT_PENDING, transaction: txHash, network: req.network };
    return { success: true, transaction: txHash, network: req.network, extra: { claims: p.claims } };
  }

  /**
   * A claim for a server whose provider key this facilitator holds: the server names each channel
   * and the voucher to redeem, and authenticates the request. The facilitator checks every
   * voucher against its channel on chain, then builds, signs and broadcasts the claim itself,
   * paying everything it redeems to the server's `payTo` in one output.
   */
  private async settleDelegatedClaim(p: ClaimPayload, raw: object, req: PaymentRequirements): Promise<SettleResponse> {
    const failed = (reason: string, message: string): SettleResponse => ({ success: false, errorReason: reason, errorMessage: message, transaction: "", network: req.network });
    const held = this.delegates.get(req.payTo);
    if (!held) return failed(Err.claimTransaction, "this facilitator holds no provider key for that payTo");
    if (!checkDelegationMac(held.d.secret, req.payTo, raw)) return failed(Err.claimTransaction, "claim not authenticated by the server whose key this facilitator holds");
    const lines: ClaimLine[] = [];
    for (const c of p.claims) {
      const v = await this.chain.followChannel(c.channelRef!, this.options.scriptHash, c.channelId);
      if (!v) return failed(Err.channelNotFound, `channel ${c.channelId.slice(0, 16)}… not found`);
      if (v.datum.constants.provider !== held.d.keyHash) return failed(Err.claimTransaction, `channel ${c.channelId.slice(0, 16)}… is not this server's`);
      const stage = v.datum.stage;
      if (stage.kind === "settled") return failed(Err.channelClosed, `channel ${c.channelId.slice(0, 16)}… is settled`);
      const amount = BigInt(c.voucher!.maxClaimableAmount);
      const total = BigInt(c.totalClaimed);
      if (!verifyVoucherSignature(v.datum.constants.iouKey, c.channelId, amount, c.voucher!.signature)) return failed(Err.voucherSignature, `voucher for ${c.channelId.slice(0, 16)}… does not verify`);
      if (total > amount) return failed(Err.chargeExceedsSignedCumulative, `claiming ${total} on a voucher for ${amount}`);
      if (total <= stage.subbed) return failed(Err.cumulativeBelowClaimed, `claiming ${total}, already redeemed ${stage.subbed}`);
      lines.push({ channelId: c.channelId, totalClaimed: total, amount, signature: c.voucher!.signature, v });
    }
    lines.sort((a, b) => compareRefs(a.v.ref, b.v.ref));
    const { d, spent } = held;
    const { hex } = await buildClaimTx({ wallet: d.wallet, providerKeyHash: d.keyHash, chain: this.chain, ...(d.referenceScript ? { referenceScript: d.referenceScript } : {}), payTo: d.payTo, payout: "delegated", spent }, lines);
    const { txHash, confirmed } = await this.broadcast(hex);
    if (!confirmed) return { success: false, errorReason: SETTLEMENT_PENDING, transaction: txHash, network: req.network };
    return { success: true, transaction: txHash, network: req.network, extra: { claims: p.claims.map((c) => ({ channelId: c.channelId, totalClaimed: c.totalClaimed })) } };
  }
}

function bad(reason: string, message: string, payer?: string): Verified {
  return { ok: false, reason, message, ...(payer ? { payer } : {}) };
}
