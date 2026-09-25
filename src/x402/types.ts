// Wire types of the Cardano `batch-settlement` binding (DESIGN.md §3–§6): the requirements'
// `extra`, the client payloads, the server's claim, and the channel snapshot every response
// carries. Shapes and names follow x402's EVM and SVM bindings wherever Subbit allows.
import { createHmac, timingSafeEqual } from "node:crypto";
import type { PaymentRequirements } from "@x402/core/types";

export const SCHEME = "batch-settlement";
/** CAIP-2 ids as `@x402/cardano` uses them. The spike only runs on preprod. */
export const NETWORKS = { "cardano:mainnet": 1, "cardano:preprod": 0, "cardano:preview": 0 } as const;
export type CardanoNetwork = keyof typeof NETWORKS;
export const LOVELACE = "lovelace";

/** EVM/SVM bounds on the withdraw delay (the channel's close period), in seconds. */
export const MIN_WITHDRAW_DELAY = 900;
export const MAX_WITHDRAW_DELAY = 2_592_000;

const E = (s: string) => `invalid_batch_settlement_cardano_${s}`;
export const Err = {
  payloadType: E("payload_type"),
  payload: E("payload"),
  network: E("network_mismatch"),
  scheme: E("scheme"),
  extra: E("extra"),
  channelConfig: E("channel_config"),
  receiverMismatch: E("receiver_mismatch"),
  receiverAuthorizerMismatch: E("receiver_authorizer_mismatch"),
  tokenMismatch: E("token_mismatch"),
  withdrawDelayMismatch: E("withdraw_delay_mismatch"),
  withdrawDelayOutOfRange: E("withdraw_delay_out_of_range"),
  channelNotFound: E("channel_not_found"),
  channelIdMismatch: E("channel_id_mismatch"),
  channelState: E("channel_state"),
  channelClosed: E("channel_closed"),
  channelBusy: E("channel_busy"),
  missingChannel: E("missing_channel"),
  voucherSignature: E("voucher_signature"),
  cumulativeAmountMismatch: E("cumulative_amount_mismatch"),
  cumulativeBelowClaimed: E("cumulative_below_claimed"),
  cumulativeExceedsBalance: E("cumulative_exceeds_balance"),
  chargeExceedsSignedCumulative: E("charge_exceeds_signed_cumulative"),
  depositTransaction: E("deposit_transaction"),
  depositBelowMinDeposit: E("deposit_below_min_deposit"),
  refundTransaction: E("refund_transaction"),
  claimTransaction: E("claim_transaction"),
  transactionFailed: E("transaction_failed"),
  verificationStateUnavailable: E("verification_state_unavailable"),
} as const;
export const SETTLEMENT_PENDING = "settlement_pending";

/** `PaymentRequirements.extra` for this scheme. */
export interface BatchExtra {
  scriptHash: string;
  receiverAuthorizer: string;
  withdrawDelay: number;
  referenceScript?: string;
  minDeposit?: string;
  confirmationPolicy?: { l1Confirmations: number };
  channelState?: ChannelState;
  voucherState?: VoucherState;
}

export interface ChannelConfig {
  /** Consumer key hash (hex 28 B): signs open, add, close, end, elapse and mutual. */
  payer: string;
  /** IOU key (Ed25519 public key, hex 32 B). */
  payerAuthorizer: string;
  /** == `payTo`. */
  receiver: string;
  /** == `extra.receiverAuthorizer` == the datum's `provider`. */
  receiverAuthorizer: string;
  /** == `asset`. */
  token: string;
  /** == `extra.withdrawDelay`, seconds; the datum holds it in milliseconds. */
  withdrawDelay: number;
}

export interface Voucher {
  /** The Subbit tag, hex 32 B. */
  channelId: string;
  maxClaimableAmount: string;
  /** Ed25519 over the IOU body, hex 64 B. */
  signature: string;
  /** The channel's current `txHash#index` as the client last saw it; a lookup hint only. */
  channelRef?: string;
}

export interface DepositPayload {
  type: "deposit";
  channelConfig: ChannelConfig;
  voucher: Voucher;
  /** `amount` is the channel's currency amount; `transaction` is base64 CBOR, fully signed. */
  deposit: { amount: string; transaction: string };
}

export interface VoucherPayload {
  type: "voucher";
  channelConfig: ChannelConfig;
  voucher: Voucher;
}

export interface RefundPayload {
  type: "refund";
  channelConfig: ChannelConfig;
  /** Zero-charge: `maxClaimableAmount` equals what has been charged. */
  voucher: Voucher;
  /** Base64 CBOR of a `Mutual` transaction the consumer has signed. */
  transaction: string;
  /** Added by the server before `/settle`: its witness set, CBOR hex. */
  providerWitness?: string;
  /** Added instead by a server whose provider key the facilitator holds: see `delegationMac`. */
  delegationMac?: string;
}

export interface ClaimPayload {
  type: "claim";
  /**
   * Base64 CBOR of a claim transaction (`Sub` and `Settle` steps) over one or more channels,
   * signed by the provider. Absent when the server has delegated its provider key to the
   * facilitator, which then builds and signs the claim from the vouchers listed.
   */
  transaction?: string;
  claims: Array<{
    channelId: string;
    totalClaimed: string;
    /** Without a transaction: where the channel was last seen, and the voucher it redeems. */
    channelRef?: string;
    voucher?: { maxClaimableAmount: string; signature: string };
  }>;
  /** Without a transaction: the delegating server's authentication, see `delegationMac`. */
  delegationMac?: string;
}

export type ClientPayload = DepositPayload | VoucherPayload | RefundPayload;

export interface ChannelState {
  channelId: string;
  channelRef: string;
  /** Capacity: what IOUs may reach and still be redeemable unilaterally. */
  balance: string;
  /** The datum's `subbed`. */
  totalClaimed: string;
  /** Seconds; (`elapse_at` − close period) once the consumer has closed, else 0. */
  withdrawRequestedAt: number;
  chargedCumulativeAmount?: string;
}

export interface VoucherState {
  signedMaxClaimable: string;
  signature: string;
}

// ---- strict parsing of what arrives over the wire ----------------------------

const HEX = (bytes: number) => new RegExp(`^[0-9a-f]{${bytes * 2}}$`);
const hex28 = HEX(28);
const hex32 = HEX(32);
const hex64 = HEX(64);
const uint = /^(0|[1-9][0-9]*)$/;
const outRef = /^[0-9a-f]{64}#(0|[1-9][0-9]*)$/;
const base64 = /^[A-Za-z0-9+/]+={0,2}$/;

export class PayloadError extends Error {
  constructor(readonly reason: string, message: string) {
    super(message);
  }
}

function need(ok: boolean, what: string): void {
  if (!ok) throw new PayloadError(Err.payload, what);
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown, re: RegExp) => typeof v === "string" && re.test(v);

export function parseChannelConfig(v: unknown): ChannelConfig {
  need(isObj(v), "channelConfig is not an object");
  const c = v as Record<string, unknown>;
  need(str(c.payer, hex28), "channelConfig.payer");
  need(str(c.payerAuthorizer, hex32), "channelConfig.payerAuthorizer");
  need(typeof c.receiver === "string" && c.receiver.length > 0, "channelConfig.receiver");
  need(str(c.receiverAuthorizer, hex28), "channelConfig.receiverAuthorizer");
  need(typeof c.token === "string" && c.token.length > 0, "channelConfig.token");
  need(Number.isSafeInteger(c.withdrawDelay) && (c.withdrawDelay as number) > 0, "channelConfig.withdrawDelay");
  return {
    payer: c.payer as string,
    payerAuthorizer: c.payerAuthorizer as string,
    receiver: c.receiver as string,
    receiverAuthorizer: c.receiverAuthorizer as string,
    token: c.token as string,
    withdrawDelay: c.withdrawDelay as number,
  };
}

export function parseVoucher(v: unknown): Voucher {
  need(isObj(v), "voucher is not an object");
  const o = v as Record<string, unknown>;
  need(str(o.channelId, hex32), "voucher.channelId");
  need(str(o.maxClaimableAmount, uint), "voucher.maxClaimableAmount");
  need(str(o.signature, hex64), "voucher.signature");
  need(o.channelRef === undefined || str(o.channelRef, outRef), "voucher.channelRef");
  return {
    channelId: o.channelId as string,
    maxClaimableAmount: o.maxClaimableAmount as string,
    signature: o.signature as string,
    ...(o.channelRef !== undefined ? { channelRef: o.channelRef as string } : {}),
  };
}

export function parseClientPayload(v: unknown): ClientPayload {
  need(isObj(v), "payload is not an object");
  const p = v as Record<string, unknown>;
  const channelConfig = parseChannelConfig(p.channelConfig);
  const voucher = parseVoucher(p.voucher);
  switch (p.type) {
    case "deposit": {
      need(isObj(p.deposit), "deposit is not an object");
      const d = p.deposit as Record<string, unknown>;
      need(str(d.amount, uint) && d.amount !== "0", "deposit.amount");
      need(str(d.transaction, base64), "deposit.transaction");
      return { type: "deposit", channelConfig, voucher, deposit: { amount: d.amount as string, transaction: d.transaction as string } };
    }
    case "voucher":
      return { type: "voucher", channelConfig, voucher };
    case "refund":
      need(str(p.transaction, base64), "refund.transaction");
      need(p.providerWitness === undefined || (typeof p.providerWitness === "string" && /^[0-9a-f]+$/.test(p.providerWitness)), "refund.providerWitness");
      need(p.delegationMac === undefined || str(p.delegationMac, hex32), "refund.delegationMac");
      return {
        type: "refund",
        channelConfig,
        voucher,
        transaction: p.transaction as string,
        ...(p.providerWitness !== undefined ? { providerWitness: p.providerWitness as string } : {}),
        ...(p.delegationMac !== undefined ? { delegationMac: p.delegationMac as string } : {}),
      };
    default:
      throw new PayloadError(Err.payloadType, `unknown payload type ${String(p.type)}`);
  }
}

export function parseClaimPayload(v: unknown): ClaimPayload {
  need(isObj(v), "payload is not an object");
  const p = v as Record<string, unknown>;
  if (p.type !== "claim") throw new PayloadError(Err.payloadType, `unknown payload type ${String(p.type)}`);
  need(p.transaction === undefined || str(p.transaction, base64), "claim.transaction");
  need(Array.isArray(p.claims) && p.claims.length > 0, "claim.claims");
  const claims = (p.claims as unknown[]).map((c) => {
    need(isObj(c), "claim entry");
    const o = c as Record<string, unknown>;
    need(str(o.channelId, hex32) && str(o.totalClaimed, uint), "claim entry fields");
    need(o.channelRef === undefined || str(o.channelRef, outRef), "claim entry channelRef");
    let voucher: { maxClaimableAmount: string; signature: string } | undefined;
    if (o.voucher !== undefined) {
      need(isObj(o.voucher), "claim entry voucher");
      const w = o.voucher as Record<string, unknown>;
      need(str(w.maxClaimableAmount, uint) && str(w.signature, hex64), "claim entry voucher fields");
      voucher = { maxClaimableAmount: w.maxClaimableAmount as string, signature: w.signature as string };
    }
    if (p.transaction === undefined) need(o.channelRef !== undefined && voucher !== undefined, "a claim without a transaction names each channel's position and voucher");
    return {
      channelId: o.channelId as string,
      totalClaimed: o.totalClaimed as string,
      ...(o.channelRef !== undefined ? { channelRef: o.channelRef as string } : {}),
      ...(voucher ? { voucher } : {}),
    };
  });
  need(p.delegationMac === undefined || str(p.delegationMac, hex32), "claim.delegationMac");
  return {
    type: "claim",
    ...(p.transaction !== undefined ? { transaction: p.transaction as string } : {}),
    claims,
    ...(p.delegationMac !== undefined ? { delegationMac: p.delegationMac as string } : {}),
  };
}

/**
 * What a server whose provider key a facilitator holds adds to each claim and refund it asks the
 * facilitator to sign: HMAC-SHA256, keyed with the secret the two share, over the server's `payTo`
 * and the payload without this field, as canonical JSON. The facilitator signs for that server
 * only what carries it: a consumer could otherwise have it settle a closed channel with an early,
 * smaller voucher, or co-sign a refund that pays the server less than it charged.
 */
export function delegationMac(secret: string, payTo: string, payload: object): string {
  const { delegationMac: _, ...rest } = payload as Record<string, unknown>;
  return createHmac("sha256", secret).update(canonicalJson({ payTo, payload: rest })).digest("hex");
}

export function checkDelegationMac(secret: string, payTo: string, payload: object): boolean {
  const given = (payload as { delegationMac?: unknown }).delegationMac;
  if (typeof given !== "string" || !/^[0-9a-f]{64}$/.test(given)) return false;
  return timingSafeEqual(Buffer.from(given, "hex"), Buffer.from(delegationMac(secret, payTo, payload), "hex"));
}

/** JSON with every object's keys sorted and undefined members left out. */
function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v !== null && typeof v === "object") {
    const o = v as Record<string, unknown>;
    const keys = Object.keys(o).filter((k) => o[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(v);
}

/** The scheme's `extra`, checked field by field. */
export function parseExtra(req: PaymentRequirements): BatchExtra {
  const x = req.extra ?? {};
  if (!str(x.scriptHash, hex28)) throw new PayloadError(Err.extra, "extra.scriptHash");
  if (!str(x.receiverAuthorizer, hex28)) throw new PayloadError(Err.extra, "extra.receiverAuthorizer");
  const delay = x.withdrawDelay;
  if (!Number.isSafeInteger(delay)) throw new PayloadError(Err.extra, "extra.withdrawDelay");
  if ((delay as number) < MIN_WITHDRAW_DELAY || (delay as number) > MAX_WITHDRAW_DELAY || (delay as number) < req.maxTimeoutSeconds) {
    throw new PayloadError(Err.withdrawDelayOutOfRange, `withdrawDelay ${String(delay)} outside ${MIN_WITHDRAW_DELAY}..${MAX_WITHDRAW_DELAY} or below maxTimeoutSeconds`);
  }
  if (x.referenceScript !== undefined && !str(x.referenceScript, outRef)) throw new PayloadError(Err.extra, "extra.referenceScript");
  if (x.minDeposit !== undefined && !str(x.minDeposit, uint)) throw new PayloadError(Err.extra, "extra.minDeposit");
  return {
    scriptHash: x.scriptHash as string,
    receiverAuthorizer: x.receiverAuthorizer as string,
    withdrawDelay: delay as number,
    ...(x.referenceScript !== undefined ? { referenceScript: x.referenceScript as string } : {}),
    ...(x.minDeposit !== undefined ? { minDeposit: x.minDeposit as string } : {}),
    ...(isObj(x.confirmationPolicy) ? { confirmationPolicy: x.confirmationPolicy as { l1Confirmations: number } } : {}),
    ...(isObj(x.channelState) ? { channelState: x.channelState as unknown as ChannelState } : {}),
    ...(isObj(x.voucherState) ? { voucherState: x.voucherState as unknown as VoucherState } : {}),
  };
}

/**
 * The binding between a channel config and the requirements it is used under (EVM rules 2–5):
 * the same receiver, provider key, token and close period. Returns the failing reason, if any.
 */
export function configBindingError(config: ChannelConfig, req: PaymentRequirements, extra: BatchExtra): string | undefined {
  if (config.receiver !== req.payTo) return Err.receiverMismatch;
  if (config.receiverAuthorizer !== extra.receiverAuthorizer) return Err.receiverAuthorizerMismatch;
  if (config.token !== req.asset) return Err.tokenMismatch;
  if (config.withdrawDelay !== extra.withdrawDelay) return Err.withdrawDelayMismatch;
  return undefined;
}

export const commitmentId = (channelId: string, maxClaimableAmount: string) => `${channelId}:${maxClaimableAmount}`;
export const toBase64 = (hex: string) => Buffer.from(hex, "hex").toString("base64");
export const fromBase64 = (b64: string) => Buffer.from(b64, "base64").toString("hex");
