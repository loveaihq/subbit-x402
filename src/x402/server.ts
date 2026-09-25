// The resource-server side of the Cardano binding (DESIGN.md §6): per-channel state, the hooks
// @x402/core runs around each paid request, and the corrective 402. It follows @x402/evm's
// batch-settlement server step for step; what differs is Cardano's: the channel's position
// (`channelRef`) moves with each redemption, capacity keeps an ADA reserve, and the server
// co-signs a client-built `Mutual` refund after checking its shape itself. A retry of a channel's
// latest voucher gets the answer it already paid for, not a second charge (SVM's rule).
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  AssetAmount,
  DeepReadonly,
  Network,
  PaymentPayload,
  PaymentRequirements,
  Price,
  SchemeNetworkServer,
  SchemePaymentRequiredContext,
  SchemeServerHooks,
  SettleContext,
  SettleResponse,
  SettleResultContext,
  SupportedKind,
  VerifyResponse,
} from "@x402/core/types";
import { Transaction, TransactionHash, TransactionWitnessSet, type Address } from "@evolution-sdk/evolution";
import { currencyOf, verifyVoucherSignature } from "./cardano.ts";
import type { Chain } from "./chain.ts";
import { checkMutual, decodeTx } from "./txcheck.ts";
import {
  Err,
  LOVELACE,
  MIN_WITHDRAW_DELAY,
  SCHEME,
  commitmentId,
  configBindingError,
  delegationMac,
  fromBase64,
  parseClientPayload,
  parseExtra,
  type ChannelConfig,
  type ChannelState,
  type ClientPayload,
} from "./types.ts";

// ---- storage -------------------------------------------------------------------

export interface ServerChannel {
  channelId: string;
  channelConfig: ChannelConfig;
  /** Current `txHash#index`; empty until the opening transaction is on chain. */
  channelRef: string;
  /**
   * A position of the channel deep enough in the chain to stay there (the watcher's `depth`).
   * Reads start here and follow the channel forward, so a transaction rolled back after
   * `channelRef` moved on is simply not found again. Absent in older records: `channelRef` serves.
   */
  anchorRef?: string;
  balance: string;
  totalClaimed: string;
  withdrawRequestedAt: number;
  chargedCumulativeAmount: string;
  signedMaxClaimable: string;
  signature: string;
  onchainSyncedAt?: number;
  lastRequestTimestamp: number;
  pendingRequest?: { pendingId: string; signedMaxClaimable: string; expiresAt: number };
}

export interface ChannelUpdateResult {
  channel: ServerChannel | undefined;
  status: "updated" | "unchanged" | "deleted";
}

export interface ChannelStorage {
  get(channelId: string): Promise<ServerChannel | undefined>;
  list(): Promise<ServerChannel[]>;
  /** Atomic read-modify-write; return undefined to delete, the same object to leave it. */
  updateChannel(channelId: string, update: (current: ServerChannel | undefined) => ServerChannel | undefined): Promise<ChannelUpdateResult>;
}

/** One process only: a promise chain per channel serialises updates. */
export class InMemoryChannelStorage implements ChannelStorage {
  protected readonly channels = new Map<string, ServerChannel>();
  private readonly locks = new Map<string, Promise<unknown>>();

  async get(id: string) {
    return this.channels.get(id);
  }
  async list() {
    return [...this.channels.values()];
  }
  async updateChannel(id: string, update: (c: ServerChannel | undefined) => ServerChannel | undefined): Promise<ChannelUpdateResult> {
    const prev = this.locks.get(id) ?? Promise.resolve();
    let result!: ChannelUpdateResult;
    const next = prev.then(async () => {
      const current = await this.get(id);
      const out = update(current);
      if (out === current) result = { channel: current, status: "unchanged" };
      else if (out === undefined) {
        await this.remove(id);
        result = { channel: undefined, status: "deleted" };
      } else {
        await this.put(id, out);
        result = { channel: out, status: "updated" };
      }
    });
    this.locks.set(id, next.catch(() => undefined));
    await next;
    return result;
  }
  protected async put(id: string, c: ServerChannel) {
    this.channels.set(id, c);
  }
  protected async remove(id: string) {
    this.channels.delete(id);
  }
}

/** `{dir}/{channelId}.json`, loaded at start; same in-process locking as the in-memory store. */
export class FileChannelStorage extends InMemoryChannelStorage {
  constructor(private readonly dir: string) {
    super();
    mkdirSync(dir, { recursive: true });
    for (const f of readdirSync(dir)) {
      if (f.endsWith(".json")) {
        const c = JSON.parse(readFileSync(join(dir, f), "utf8")) as ServerChannel;
        this.channels.set(c.channelId, c);
      }
    }
  }
  protected override async put(id: string, c: ServerChannel) {
    this.channels.set(id, c);
    writeFileSync(join(this.dir, `${id}.json`), JSON.stringify(c, null, 2));
  }
  protected override async remove(id: string) {
    this.channels.delete(id);
    const f = join(this.dir, `${id}.json`);
    if (existsSync(f)) rmSync(f);
  }
}

// ---- the scheme ---------------------------------------------------------------

/** Signs a transaction's exact bytes with the provider key; returns the witness set, CBOR hex. */
export type ProviderSigner = (txCborHex: string) => Promise<string>;

export interface ServerConfig {
  payTo: string;
  /** Provider key hash: the datum's `provider`, the key that signs every redemption. */
  receiverAuthorizer: string;
  scriptHash: string;
  referenceScript?: string;
  withdrawDelay?: number;
  storage?: ChannelStorage;
  onchainStateTtlMs?: number;
  /**
   * How long the answer to each channel's latest paid request is kept, for a retry of that very
   * voucher (a client whose response was lost); 0 keeps none. Default 10 minutes.
   */
  replayTtlMs?: number;
  /** Co-signs refunds as provider. Absent when the facilitator holds the provider key (`delegationSecret`). */
  signAsProvider?: ProviderSigner;
  /**
   * The secret shared with the facilitator that holds this server's provider key: the server then
   * authenticates each refund it passes on (`delegationMac`) instead of signing it.
   */
  delegationSecret?: string;
  /** Resolves a refund's collateral inputs before the provider signs. */
  chain: Chain;
  /** Decimals of the token assets the server prices in, for `$`-free settlement overrides. */
  assetDecimals?: Record<string, number>;
}

interface RequestContext {
  channelId?: string;
  pendingId?: string;
  channelSnapshot?: ServerChannel;
  localVerify?: boolean;
  reservationCommitted?: boolean;
  /** This request repeats the channel's latest voucher: it gets that request's answer again. */
  replay?: Replay;
}

/** A channel's latest paid request: its voucher, the handler's response, and the settlement answered. */
interface Replay {
  amount: string;
  signature: string;
  contentType: string;
  body: unknown;
  result: SettleResponse;
  enrichment?: Record<string, unknown>;
  at: number;
}

type Payload = DeepReadonly<PaymentPayload>;

const MIN_PENDING_TTL_MS = 5_000;
/** How often a voucher above a channel's recorded balance may send the server back to the chain. */
const RESYNC_MS = 30_000;
const MAX_PENDING_TTL_MS = 10 * 60_000;
/** At most this many channels' latest answers are kept; the oldest go first. */
const MAX_REPLAYS = 10_000;

export class BatchSettlementCardanoServer implements SchemeNetworkServer {
  readonly scheme = SCHEME;
  readonly defaultAssetTransferMethod = "default";
  readonly paymentFlows = { default: { supported: ["authorization" as const], default: "authorization" as const } };
  readonly schemeHooks: SchemeServerHooks;
  readonly withdrawDelay: number;
  readonly storage: ChannelStorage;
  private readonly ttlMs: number;
  /** When each channel was last re-read for a voucher above its recorded balance. */
  private readonly resyncedAt = new Map<string, number>();
  private readonly contexts = new WeakMap<object, RequestContext>();
  /** Each channel's latest paid request, by channel id, oldest first. */
  private readonly replays = new Map<string, Replay>();
  private readonly replayTtlMs: number;

  constructor(private readonly config: ServerConfig) {
    this.withdrawDelay = config.withdrawDelay ?? MIN_WITHDRAW_DELAY;
    this.replayTtlMs = config.replayTtlMs ?? 10 * 60_000;
    this.storage = config.storage ?? new InMemoryChannelStorage();
    this.ttlMs = config.onchainStateTtlMs ?? Math.min(300_000, Math.max(30_000, Math.floor((this.withdrawDelay * 1000) / 3)));
    this.schemeHooks = {
      onBeforeVerify: (ctx) => this.beforeVerify(ctx.paymentPayload, ctx.requirements),
      onAfterVerify: (ctx) => this.afterVerify(ctx.paymentPayload, ctx.requirements, ctx.result),
      onBeforeSettle: (ctx) => this.beforeSettle(ctx.paymentPayload, ctx.requirements),
      onAfterSettle: (ctx) => this.afterSettle(ctx.paymentPayload, ctx.requirements, ctx.result),
      onVerifyFailure: async (ctx) => {
        await this.clearPending(ctx.paymentPayload);
      },
      onSettleFailure: async (ctx) => {
        await this.clearPending(ctx.paymentPayload);
      },
      onVerifiedPaymentCanceled: async (ctx) => {
        await this.clearPending(ctx.paymentPayload);
      },
    };
  }

  // ---- requirements --------------------------------------------------------------

  async parsePrice(price: Price, network: Network): Promise<AssetAmount> {
    if (typeof price === "object" && price !== null && "amount" in price) {
      currencyOf(price.asset); // lovelace or policy.name, else throws
      return { amount: price.amount, asset: price.asset, extra: price.extra ?? {} };
    }
    throw new Error(`give ${network} prices as { asset, amount } in atomic units; this binding has no money parser`);
  }

  getAssetDecimals(asset: string): number | undefined {
    return asset === LOVELACE ? 6 : this.config.assetDecimals?.[asset];
  }

  async enhancePaymentRequirements(req: PaymentRequirements, _kind: SupportedKind, _ext: string[]): Promise<PaymentRequirements> {
    const amount = BigInt(req.amount);
    const hinted = typeof req.extra?.minDeposit === "string" && /^\d+$/.test(req.extra.minDeposit) ? BigInt(req.extra.minDeposit) : amount * 10n;
    return {
      ...req,
      extra: {
        ...req.extra,
        scriptHash: this.config.scriptHash,
        receiverAuthorizer: this.config.receiverAuthorizer,
        withdrawDelay: this.withdrawDelay,
        ...(this.config.referenceScript ? { referenceScript: this.config.referenceScript } : {}),
        minDeposit: (hinted > amount ? hinted : amount).toString(),
      },
    };
  }

  // ---- hooks ----------------------------------------------------------------

  private async beforeVerify(payload: Payload, req: PaymentRequirements) {
    let p: ClientPayload;
    try {
      p = parseClientPayload(payload.payload);
    } catch {
      return; // the facilitator names the defect
    }
    const bind = configBindingError(p.channelConfig, req, parseExtra(req));
    if (bind) return { abort: true as const, reason: bind, message: "channel config does not match the payment requirements" };
    try {
      const channelId = p.voucher.channelId;
      const snapshot = await this.storage.get(channelId);
      const isRefund = p.type === "refund";
      // The channel's latest voucher again, as a retry sends it: that request's answer, no charge.
      // An earlier voucher is stale and gets the corrective 402 below, which is what a client
      // resyncing after losing its records needs, rather than old answers.
      const replay = isRefund ? undefined : this.replayOf(snapshot, p.voucher);
      if (replay) {
        this.merge(payload, { channelId, replay });
        return { skip: true as const, result: { isValid: true, payer: p.channelConfig.payer } };
      }
      const charged = snapshot?.chargedCumulativeAmount ?? inferCharged(p.voucher.maxClaimableAmount, req.amount, !isRefund);
      const expected = isRefund ? BigInt(charged) : BigInt(charged) + BigInt(req.amount);
      if (BigInt(p.voucher.maxClaimableAmount) !== expected) {
        this.merge(payload, { channelSnapshot: snapshot ?? provisional(p, charged) });
        return { abort: true as const, reason: Err.cumulativeAmountMismatch, message: "voucher does not follow the server's count" };
      }
      this.merge(payload, { channelId, pendingId: randomUUID(), channelSnapshot: snapshot });
      if (p.type === "voucher" && snapshot && this.fresh(snapshot) && !this.resync(snapshot, p.voucher.maxClaimableAmount)) {
        const result = this.verifyLocally(p.channelConfig, p.voucher.maxClaimableAmount, p.voucher.signature, snapshot);
        this.merge(payload, { localVerify: true });
        return { skip: true as const, result };
      }
    } catch {
      return { abort: true as const, reason: Err.verificationStateUnavailable, message: "channel state unavailable" };
    }
  }

  /** The facilitator's checks, from the server's own mirror of the channel. */
  private verifyLocally(config: ChannelConfig, ceilingStr: string, signature: string, ch: ServerChannel): VerifyResponse {
    const invalid = (reason: string): VerifyResponse => ({ isValid: false, invalidReason: reason, payer: config.payer });
    if (JSON.stringify(config) !== JSON.stringify(ch.channelConfig)) return invalid(Err.channelConfig);
    if (ch.withdrawRequestedAt !== 0) return invalid(Err.channelClosed);
    const ceiling = BigInt(ceilingStr);
    if (!verifyVoucherSignature(config.payerAuthorizer, ch.channelId, ceiling, signature)) return invalid(Err.voucherSignature);
    if (ceiling > BigInt(ch.balance)) return invalid(Err.cumulativeExceedsBalance);
    if (ceiling <= BigInt(ch.totalClaimed)) return invalid(Err.cumulativeBelowClaimed);
    return { isValid: true, payer: config.payer, extra: { ...this.stateOf(ch) } };
  }

  private async afterVerify(payload: Payload, req: PaymentRequirements, result: VerifyResponse) {
    const replay = this.contexts.get(payload)?.replay;
    if (replay) return { skipHandler: true as const, response: { contentType: replay.contentType, body: replay.body } };
    if (!result.isValid || !result.payer) return;
    const p = parseClientPayload(payload.payload);
    const ctx = this.contexts.get(payload);
    if (!ctx?.pendingId) return { abort: true as const, reason: Err.verificationStateUnavailable, message: "no request context" };
    const pendingId = ctx.pendingId;
    const isRefund = p.type === "refund";
    const ex = (result.extra ?? {}) as Partial<ChannelState>;
    const now = Date.now();
    let outcome: "busy" | "stale" | "reserved" | undefined;
    let stale: ServerChannel | undefined;
    const upd = await this.storage.updateChannel(p.voucher.channelId, (current) => {
      if (current?.pendingRequest && current.pendingRequest.expiresAt > now) {
        outcome = "busy";
        return current;
      }
      const base = current?.chargedCumulativeAmount ?? inferCharged(p.voucher.maxClaimableAmount, req.amount, !isRefund);
      const expected = isRefund ? BigInt(base) : BigInt(base) + BigInt(req.amount);
      if (BigInt(p.voucher.maxClaimableAmount) !== expected) {
        outcome = "stale";
        stale = current ?? provisional(p, base);
        return current;
      }
      outcome = "reserved";
      return {
        channelId: p.voucher.channelId,
        channelConfig: p.channelConfig,
        channelRef: ex.channelRef || current?.channelRef || "",
        balance: ex.balance ?? current?.balance ?? "0",
        totalClaimed: ex.totalClaimed ?? current?.totalClaimed ?? "0",
        withdrawRequestedAt: ex.withdrawRequestedAt ?? current?.withdrawRequestedAt ?? 0,
        chargedCumulativeAmount: base,
        signedMaxClaimable: p.voucher.maxClaimableAmount,
        signature: p.voucher.signature,
        onchainSyncedAt: ctx.localVerify ? current?.onchainSyncedAt : now,
        lastRequestTimestamp: now,
        pendingRequest: { pendingId, signedMaxClaimable: p.voucher.maxClaimableAmount, expiresAt: now + clamp(req.maxTimeoutSeconds * 1000, MIN_PENDING_TTL_MS, MAX_PENDING_TTL_MS) },
      };
    });
    if (outcome === "busy") return { abort: true as const, reason: Err.channelBusy, message: "the channel is serving another request" };
    if (outcome === "stale") {
      this.merge(payload, { channelSnapshot: stale });
      return { abort: true as const, reason: Err.cumulativeAmountMismatch, message: "voucher does not follow the server's count" };
    }
    if (upd.status === "updated" && upd.channel) this.merge(payload, { reservationCommitted: true, channelSnapshot: upd.channel });
    if (isRefund && upd.status === "updated") {
      return { skipHandler: true as const, response: { contentType: "application/json", body: { message: "Refund acknowledged", channelId: p.voucher.channelId } } };
    }
  }

  private async beforeSettle(payload: Payload, req: PaymentRequirements) {
    const replay = this.contexts.get(payload)?.replay;
    if (replay) return { skip: true as const, result: structuredClone(replay.result) };
    const p = parseClientPayload(payload.payload);
    if (p.type !== "voucher") return;
    const pendingId = this.contexts.get(payload)?.pendingId;
    const increment = BigInt(req.amount);
    const cap = BigInt(p.voucher.maxClaimableAmount);
    let outcome: "missing" | "mismatch" | "cap" | "committed" | undefined;
    let previous: ServerChannel | undefined;
    let committed: ServerChannel | undefined;
    await this.storage.updateChannel(p.voucher.channelId, (current) => {
      if (!current) {
        outcome = "missing";
        return current;
      }
      if (!pendingId || current.pendingRequest?.pendingId !== pendingId) {
        outcome = "mismatch";
        return current;
      }
      const charged = BigInt(current.chargedCumulativeAmount) + increment;
      if (charged > cap) {
        outcome = "cap";
        return { ...current, pendingRequest: undefined };
      }
      outcome = "committed";
      previous = current;
      committed = { ...current, chargedCumulativeAmount: charged.toString(), signedMaxClaimable: p.voucher.maxClaimableAmount, signature: p.voucher.signature, lastRequestTimestamp: Date.now(), pendingRequest: undefined };
      return committed;
    });
    this.take(payload);
    if (outcome === "missing") return { abort: true as const, reason: Err.missingChannel, message: "no channel record" };
    if (outcome === "cap") return { abort: true as const, reason: Err.chargeExceedsSignedCumulative, message: "charge exceeds the signed voucher" };
    if (outcome !== "committed") return { abort: true as const, reason: Err.channelBusy, message: "the channel changed during the request" };
    const result: SettleResponse = {
      success: true,
      payer: previous!.channelConfig.payer,
      transaction: "",
      network: req.network,
      amount: "",
      extra: {
        chargedAmount: req.amount,
        commitmentId: commitmentId(p.voucher.channelId, p.voucher.maxClaimableAmount),
        channelState: { ...this.stateOf(previous!), chargedCumulativeAmount: committed!.chargedCumulativeAmount },
      },
    };
    return { skip: true as const, result };
  }

  /** Refunds only: check the client's `Mutual` against the server's own record, then co-sign it. */
  enrichSettlementPayload = async (ctx: SettleContext): Promise<Record<string, unknown> | void> => {
    const p = parseClientPayload(ctx.paymentPayload.payload);
    if (p.type !== "refund") return;
    const ch = await this.storage.get(p.voucher.channelId);
    if (!ch) throw new Error(Err.missingChannel);
    const pendingId = this.contexts.get(ctx.paymentPayload)?.pendingId;
    if (!pendingId || ch.pendingRequest?.pendingId !== pendingId) throw new Error(Err.channelBusy);
    if (BigInt(p.voucher.maxClaimableAmount) !== BigInt(ch.chargedCumulativeAmount)) throw new Error(Err.cumulativeAmountMismatch);
    if (p.voucher.signature !== ch.signature) throw new Error(Err.voucherSignature);
    const hex = fromBase64(p.transaction);
    const collateral: Address.Address[] = [];
    for (const c of decodeTx(hex, Err.refundTransaction).body.collateralInputs ?? []) {
      const u = await this.config.chain.getUnspent(`${TransactionHash.toHex(c.transactionId)}#${c.index}`);
      if (!u) throw new Error(`${Err.refundTransaction}: collateral is spent or unknown`);
      collateral.push(u.address);
    }
    const owed = BigInt(ch.chargedCumulativeAmount) - BigInt(ch.totalClaimed);
    checkMutual(hex, ctx.requirements.network, this.config.scriptHash, ch.channelRef, ch.channelConfig.payer, this.config.receiverAuthorizer, this.config.payTo, currencyOf(ch.channelConfig.token), owed, collateral);
    this.merge(ctx.paymentPayload, { channelSnapshot: ch });
    if (this.config.signAsProvider) return { providerWitness: await this.config.signAsProvider(hex) };
    // The facilitator holds the key: it signs this refund, having seen the server vouch for it.
    if (this.config.delegationSecret) return { delegationMac: delegationMac(this.config.delegationSecret, this.config.payTo, ctx.paymentPayload.payload) };
    throw new Error("this server holds no provider key and has no delegation");
  };

  private async afterSettle(payload: Payload, req: PaymentRequirements, result: SettleResponse) {
    if (!result.success || this.contexts.get(payload)?.replay) return;
    const p = parseClientPayload(payload.payload);
    const pendingId = this.contexts.get(payload)?.pendingId;
    if (p.type === "refund") {
      await this.storage.updateChannel(p.voucher.channelId, (current) => (current && current.pendingRequest?.pendingId === pendingId ? undefined : current));
      return;
    }
    if (p.type !== "deposit") return;
    const state = (result.extra?.channelState ?? {}) as Partial<ChannelState>;
    const upd = await this.storage.updateChannel(p.voucher.channelId, (current) => {
      if (!current || !pendingId || current.pendingRequest?.pendingId !== pendingId) return current;
      return {
        ...current,
        channelRef: state.channelRef ?? current.channelRef,
        balance: state.balance ?? current.balance,
        totalClaimed: state.totalClaimed ?? current.totalClaimed,
        withdrawRequestedAt: state.withdrawRequestedAt ?? current.withdrawRequestedAt,
        chargedCumulativeAmount: (BigInt(current.chargedCumulativeAmount) + BigInt(req.amount)).toString(),
        onchainSyncedAt: Date.now(),
        lastRequestTimestamp: Date.now(),
        pendingRequest: undefined,
      };
    });
    if (upd.status !== "updated" || !upd.channel) throw new Error(Err.channelBusy);
    this.merge(payload, { channelSnapshot: upd.channel });
  }

  enrichSettlementResponse = async (ctx: SettleResultContext): Promise<Record<string, unknown> | void> => {
    const replay = this.contexts.get(ctx.paymentPayload)?.replay;
    if (replay) {
      this.take(ctx.paymentPayload);
      return replay.enrichment && structuredClone(replay.enrichment);
    }
    const p = parseClientPayload(ctx.paymentPayload.payload);
    if (p.type === "voucher") {
      this.keep(p.voucher, ctx);
      return;
    }
    const ch = this.take(ctx.paymentPayload)?.channelSnapshot;
    if (!ch) return;
    if (p.type === "refund") {
      this.replays.delete(p.voucher.channelId);
      return { channelState: { chargedCumulativeAmount: ch.chargedCumulativeAmount } };
    }
    const enrichment = {
      chargedAmount: ctx.requirements.amount,
      commitmentId: commitmentId(p.voucher.channelId, p.voucher.maxClaimableAmount),
      channelState: { chargedCumulativeAmount: ch.chargedCumulativeAmount },
    };
    this.keep(p.voucher, ctx, enrichment);
    return enrichment;
  };

  /** The kept answer to this very voucher, if it is still the channel's latest. */
  private replayOf(snapshot: ServerChannel | undefined, v: { channelId: string; maxClaimableAmount: string; signature: string }): Replay | undefined {
    const r = this.replays.get(v.channelId);
    if (!r || !snapshot) return undefined;
    if (Date.now() - r.at > this.replayTtlMs) {
      this.replays.delete(v.channelId);
      return undefined;
    }
    return r.amount === v.maxClaimableAmount && r.signature === v.signature && snapshot.chargedCumulativeAmount === r.amount ? r : undefined;
  }

  /** Keeps a paid request's answer as its channel's latest: the handler's response (HTTP only) and the settlement. */
  private keep(v: { channelId: string; maxClaimableAmount: string; signature: string }, ctx: SettleResultContext, enrichment?: Record<string, unknown>) {
    if (this.replayTtlMs <= 0 || !ctx.result.success) return;
    const t = ctx.transportContext as { responseBody?: Uint8Array; responseHeaders?: Record<string, string> } | undefined;
    if (!t?.responseBody) return;
    const contentType = Object.entries(t.responseHeaders ?? {}).find(([k]) => k.toLowerCase() === "content-type")?.[1] ?? "application/json";
    const bytes = Buffer.from(t.responseBody);
    let body: unknown = bytes;
    if (/json/i.test(contentType)) {
      try {
        body = JSON.parse(bytes.toString("utf8"));
      } catch {
        body = bytes.toString("utf8");
      }
    } else if (/^text\//i.test(contentType)) body = bytes.toString("utf8");
    this.replays.delete(v.channelId); // re-inserted, so the map stays oldest first
    this.replays.set(v.channelId, {
      amount: v.maxClaimableAmount,
      signature: v.signature,
      contentType,
      body,
      result: structuredClone(ctx.result) as SettleResponse,
      ...(enrichment ? { enrichment: structuredClone(enrichment) } : {}),
      at: Date.now(),
    });
    while (this.replays.size > MAX_REPLAYS) this.replays.delete(this.replays.keys().next().value!);
  }

  /** On `cumulative_amount_mismatch`, tell the client where the server's count stands and what it last signed. */
  enrichPaymentRequiredResponse = async (ctx: SchemePaymentRequiredContext): Promise<PaymentRequirements[] | void> => {
    if (ctx.error !== Err.cumulativeAmountMismatch || !ctx.paymentPayload) return;
    let p: ClientPayload;
    try {
      p = parseClientPayload(ctx.paymentPayload.payload);
    } catch {
      return;
    }
    const ch = this.take(ctx.paymentPayload)?.channelSnapshot ?? (await this.storage.get(p.voucher.channelId));
    if (!ch) return;
    const accept = ctx.requirements.find((r) => r.scheme === SCHEME && r.network === ctx.paymentPayload!.accepted.network);
    if (!accept) return;
    accept.extra = {
      ...accept.extra,
      channelState: { ...this.stateOf(ch), chargedCumulativeAmount: ch.chargedCumulativeAmount },
      voucherState: { signedMaxClaimable: ch.signedMaxClaimable, signature: ch.signature },
    };
  };

  // ---- helpers -------------------------------------------------------------

  stateOf(ch: ServerChannel): ChannelState {
    return { channelId: ch.channelId, channelRef: ch.channelRef, balance: ch.balance, totalClaimed: ch.totalClaimed, withdrawRequestedAt: ch.withdrawRequestedAt };
  }

  /**
   * A voucher above the recorded balance may follow a top-up this server has not seen: one that
   * reached a block after its request gave up, or an `Add` made outside x402. The facilitator
   * then reads the channel (and the balance is taken from what it finds), at most once per
   * RESYNC_MS for each channel; otherwise the voucher is refused locally.
   */
  private resync(ch: ServerChannel, ceiling: string): boolean {
    if (BigInt(ceiling) <= BigInt(ch.balance)) return false;
    const now = Date.now();
    if (now - (this.resyncedAt.get(ch.channelId) ?? 0) < RESYNC_MS) return false;
    this.resyncedAt.set(ch.channelId, now);
    return true;
  }

  private fresh(ch: ServerChannel) {
    return ch.channelRef !== "" && ch.onchainSyncedAt !== undefined && Date.now() - ch.onchainSyncedAt <= this.ttlMs;
  }

  private merge(payload: object, c: RequestContext) {
    this.contexts.set(payload, { ...this.contexts.get(payload), ...c });
  }

  private take(payload: object): RequestContext | undefined {
    const c = this.contexts.get(payload);
    this.contexts.delete(payload);
    return c;
  }

  /** Releases this request's reservation; a channel that only existed for it goes away. */
  private async clearPending(payload: Payload) {
    const c = this.take(payload);
    if (!c?.reservationCommitted || !c.channelId || !c.pendingId) return;
    await this.storage.updateChannel(c.channelId, (current) => {
      if (!current || current.pendingRequest?.pendingId !== c.pendingId) return current;
      if (current.channelRef === "") return undefined;
      return { ...current, pendingRequest: undefined };
    });
  }
}

/** With no record, EVM's rule: the client's ceiling minus this request's price is the base. */
function inferCharged(signed: string, price: string, paid: boolean): string {
  if (!paid) return signed;
  const s = BigInt(signed);
  const a = BigInt(price);
  return s < a ? "0" : (s - a).toString();
}

function provisional(p: ClientPayload, charged: string): ServerChannel {
  return {
    channelId: p.voucher.channelId,
    channelConfig: p.channelConfig,
    channelRef: "",
    balance: "0",
    totalClaimed: "0",
    withdrawRequestedAt: 0,
    chargedCumulativeAmount: charged,
    signedMaxClaimable: p.voucher.maxClaimableAmount,
    signature: p.voucher.signature,
    lastRequestTimestamp: Date.now(),
  };
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** The provider signer for a seed wallet built with evolution-sdk: signs the exact bytes. */
export function walletProviderSigner(wallet: { signTx(tx: string): Promise<TransactionWitnessSet.TransactionWitnessSet> }): ProviderSigner {
  return async (hex) => TransactionWitnessSet.toCBORHex(await wallet.signTx(hex));
}

export { Transaction };
