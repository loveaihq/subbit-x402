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
import { decodePaymentSignatureHeader } from "@x402/core/http";
import { Assets, InlineDatum, KeyHash, Transaction, TransactionHash, TransactionWitnessSet, type Address } from "@evolution-sdk/evolution";
import { UPSTREAM, parseDatum, validatorByHash, type Validator } from "../subbit.ts";
import { channelReserve, currencyOf, isChannelOutput, msOfSlot, networkIdOf, txHashOf, verifyVoucherSignature } from "./cardano.ts";
import type { Chain } from "./chain.ts";
import {
  CAPABILITY_KEY,
  OFFER_KEY,
  WITNESS_KEY,
  checkSponsoredOpen,
  checkSponsoredRefund,
  checkSponsoredTopUp,
  offerIn,
  unsponsoredRefundProblem,
  type FeeSponsorOffer,
  type SponsorPool,
  type SponsorResult,
} from "./sponsor.ts";
import { checkMutual, decodeTx, sortedInputRefs } from "./txcheck.ts";
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
  /**
   * Where this server's latest claim left the channel, until a read finds it deep enough to stay;
   * a claim rolled back before then is found from `anchorRef`, and its charges are claimable again.
   */
  claimedRef?: string;
  balance: string;
  totalClaimed: string;
  withdrawRequestedAt: number;
  chargedCumulativeAmount: string;
  signedMaxClaimable: string;
  signature: string;
  onchainSyncedAt?: number;
  lastRequestTimestamp: number;
  pendingRequest?: { pendingId: string; signedMaxClaimable: string; expiresAt: number };
  /** `seller`: the channel's reserve came from this server's fee-sponsor offer, and goes back to it at the refund. */
  reserveFrom?: "seller";
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
  /**
   * The validator its channels live at: Subbit's as fixed upstream (`UPSTREAM.hash`, the default,
   * where new channels should open), Subbit's before the fix (`UPSTREAM_66648DB.hash`, for a server
   * whose earlier channels sit there: it follows, claims and refunds them as before), or the
   * sponsor-safe variant's (`SPONSORED.hash`), which is unaudited. It goes into every 402 as
   * `extra.scriptHash`, and a client that does not trust it refuses the 402. A server names one
   * validator: to keep channels at two, run a second server and manager at the other.
   */
  scriptHash?: string;
  referenceScript?: string;
  withdrawDelay?: number;
  storage?: ChannelStorage;
  /**
   * TTL: how long a channel's view, from a chain read or a `/verify`, serves for checking its
   * vouchers locally; past it the next voucher goes to `/verify`, which finds a close. At most
   * `clamp(withdrawDelay / 3, 30 s, 5 min)`; default `clamp(withdrawDelay / 15, 30 s, 5 min)`, 60 s
   * at the 900 s minimum. A server that makes idle claims instead of watching keeps TTL + T within
   * half the close period (`ChannelManager.idleClaims`), and a short TTL is the cheap side of that.
   */
  onchainStateTtlMs?: number;
  /**
   * Called once when `/verify` finds a channel closed that the server held open: what it owes is
   * to be settled now, e.g. `() => void idle.tick()` with the manager's idle claims. The server has
   * already marked it, so its vouchers are refused from then on.
   */
  onChannelClosed?: (channelId: string) => void;
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
  /** Sponsors the fees and reserve of token channels from the seller's own ADA (SPONSORSHIP.md). */
  sponsor?: SponsorConfig;
}

export interface SponsorConfig {
  /** The sponsor key's UTxOs; its key must not be the provider key. */
  pool: SponsorPool;
  /** Most total collateral a sponsored top-up or refund may put up. Default 2 ADA. */
  maxCollateral?: bigint;
  /** The longest an offer runs, capped by the accept's `maxTimeoutSeconds`, which is the default. */
  offerTtlSeconds?: number;
  /** Re-read the sponsor address at most this often while serving 402s. Default 20 s. */
  refreshMs?: number;
  log?: (line: string) => void;
}

interface RequestContext {
  channelId?: string;
  pendingId?: string;
  channelSnapshot?: ServerChannel;
  localVerify?: boolean;
  reservationCommitted?: boolean;
  /** This request repeats the channel's latest voucher: it gets that request's answer again. */
  replay?: Replay;
  /** The deposit or refund uses the fee-sponsor offer, bound to this transaction. */
  sponsor?: { offer: FeeSponsorOffer; txHash: string; opening: boolean };
  /** When the server handed this voucher to `/verify`: the view its answer gives is dated from then. */
  askedAt?: number;
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
  /** TTL, in ms: see `ServerConfig.onchainStateTtlMs`. */
  readonly ttlMs: number;
  /** When each channel was last re-read for a voucher above its recorded balance. */
  private readonly resyncedAt = new Map<string, number>();
  private readonly contexts = new WeakMap<object, RequestContext>();
  /** Each channel's latest paid request, by channel id, oldest first. */
  private readonly replays = new Map<string, Replay>();
  private readonly replayTtlMs: number;
  /** The facilitator merges fee-sponsor witnesses, so offers may go out. */
  private sponsorCapable = false;
  private lastPoolRefresh = 0;
  /** The validator it serves. */
  private readonly validator: Validator;

  constructor(private readonly config: ServerConfig) {
    const validator = validatorByHash(config.scriptHash ?? UPSTREAM.hash);
    if (!validator) throw new Error(`script ${config.scriptHash} is not a validator this package knows`);
    this.validator = validator;
    this.withdrawDelay = config.withdrawDelay ?? MIN_WITHDRAW_DELAY;
    this.replayTtlMs = config.replayTtlMs ?? 10 * 60_000;
    this.storage = config.storage ?? new InMemoryChannelStorage();
    const maxTtl = clamp(Math.floor((this.withdrawDelay * 1000) / 3), 30_000, 300_000);
    this.ttlMs = config.onchainStateTtlMs ?? clamp(Math.floor((this.withdrawDelay * 1000) / 15), 30_000, 300_000);
    if (this.ttlMs > maxTtl) throw new Error(`onchainStateTtlMs ${this.ttlMs} is above ${maxTtl}, clamp(withdrawDelay / 3, 30 s, 5 min)`);
    this.schemeHooks = {
      onBeforeVerify: (ctx) => this.beforeVerify(ctx.paymentPayload, ctx.requirements),
      onAfterVerify: (ctx) => this.afterVerify(ctx.paymentPayload, ctx.requirements, ctx.result),
      onBeforeSettle: (ctx) => this.beforeSettle(ctx.paymentPayload, ctx.requirements),
      onAfterSettle: (ctx) => this.afterSettle(ctx.paymentPayload, ctx.requirements, ctx.result),
      onVerifyFailure: async (ctx) => {
        if ((ctx.error as { invalidReason?: string } | undefined)?.invalidReason === Err.channelClosed) await this.noteClosed(ctx.paymentPayload);
        await this.clearPending(ctx.paymentPayload);
      },
      onSettleFailure: async (ctx) => {
        this.releaseSponsor(ctx.paymentPayload, (ctx.error as { response?: { errorReason?: string } } | undefined)?.response?.errorReason);
        await this.clearPending(ctx.paymentPayload);
      },
      onVerifiedPaymentCanceled: async (ctx) => {
        this.releaseSponsor(ctx.paymentPayload);
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

  async enhancePaymentRequirements(req: PaymentRequirements, kind: SupportedKind, _ext: string[]): Promise<PaymentRequirements> {
    if (this.config.sponsor && (kind.extra as Record<string, unknown> | undefined)?.[CAPABILITY_KEY] === true) this.sponsorCapable = true;
    const amount = BigInt(req.amount);
    const hinted = typeof req.extra?.minDeposit === "string" && /^\d+$/.test(req.extra.minDeposit) ? BigInt(req.extra.minDeposit) : amount * 10n;
    return {
      ...req,
      extra: {
        ...req.extra,
        scriptHash: this.validator.hash,
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
      this.merge(payload, { askedAt: Date.now() });
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
    if (!result.isValid && result.invalidReason === Err.channelClosed && !this.contexts.get(payload)?.localVerify) await this.noteClosed(payload);
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
        onchainSyncedAt: ctx.localVerify ? current?.onchainSyncedAt : (ctx.askedAt ?? now),
        // Moves when a voucher is committed, not when one is only reserved: idle claims count from it.
        lastRequestTimestamp: current?.lastRequestTimestamp ?? now,
        pendingRequest: { pendingId, signedMaxClaimable: p.voucher.maxClaimableAmount, expiresAt: now + clamp(req.maxTimeoutSeconds * 1000, MIN_PENDING_TTL_MS, MAX_PENDING_TTL_MS) },
      };
    });
    if (outcome === "busy") return { abort: true as const, reason: Err.channelBusy, message: "the channel is serving another request" };
    if (outcome === "stale") {
      this.merge(payload, { channelSnapshot: stale });
      return { abort: true as const, reason: Err.cumulativeAmountMismatch, message: "voucher does not follow the server's count" };
    }
    if (upd.status === "updated" && upd.channel) this.merge(payload, { reservationCommitted: true, channelSnapshot: upd.channel });
    if (p.type === "deposit") {
      const refused = await this.bindSponsoredDeposit(payload, req, p.deposit.transaction, !p.voucher.channelRef);
      if (refused) return refused;
    }
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

  /**
   * A sponsored deposit gets the seller's witness for its offer. A refund is checked against the
   * server's own record and co-signed; when its collateral is the offer, the seller checks it as
   * the collateral's owner too and adds that witness (SPONSORSHIP.md).
   */
  enrichSettlementPayload = async (ctx: SettleContext): Promise<Record<string, unknown> | void> => {
    const p = parseClientPayload(ctx.paymentPayload.payload);
    if (p.type === "deposit") {
      const sp = this.contexts.get(ctx.paymentPayload)?.sponsor ?? this.sponsoredDeposit(ctx.paymentPayload, ctx.requirements);
      if (!sp) return;
      const witness = this.config.sponsor!.pool.witnessFor(sp.offer, sp.txHash);
      if (!witness) throw new Error(`fee sponsor: ${sp.txHash} spends ${sp.offer.input} but is not the transaction bound to it`);
      return { [WITNESS_KEY]: witness };
    }
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
    const others = new Map<string, Address.Address>();
    for (const ref of sortedInputRefs(decodeTx(hex, Err.refundTransaction))) {
      if (ref === ch.channelRef) continue;
      const u = await this.config.chain.getUnspent(ref);
      if (!u) throw new Error(`${Err.refundTransaction}: input ${ref} is spent or unknown`);
      others.set(ref, u.address);
    }
    const owed = BigInt(ch.chargedCumulativeAmount) - BigInt(ch.totalClaimed);
    checkMutual(hex, ctx.requirements.network, this.validator.hash, ch.channelRef, ch.channelConfig.payer, this.config.receiverAuthorizer, this.config.payTo, currencyOf(ch.channelConfig.token), owed, collateral, true, others);
    const sponsorWitness = await this.signSponsoredRefund(ctx, hex, ch);
    if (!sponsorWitness) {
      // A refund without the seller's offer as its collateral still pays the seller's reserve back.
      const wrong = await unsponsoredRefundProblem(hex, ch, this.config.payTo, this.config.chain);
      if (wrong) throw new Error(`fee_sponsor_reserve: ${wrong}`);
    }
    this.merge(ctx.paymentPayload, { channelSnapshot: ch });
    const extra = sponsorWitness ? { [WITNESS_KEY]: sponsorWitness } : {};
    if (this.config.signAsProvider) return { providerWitness: await this.config.signAsProvider(hex), ...extra };
    // The facilitator holds the key: it signs this refund, having seen the server vouch for it.
    if (this.config.delegationSecret) return { delegationMac: delegationMac(this.config.delegationSecret, this.config.payTo, ctx.paymentPayload.payload), ...extra };
    throw new Error("this server holds no provider key and has no delegation");
  };

  private async afterSettle(payload: Payload, req: PaymentRequirements, result: SettleResponse) {
    if (!result.success || this.contexts.get(payload)?.replay) return;
    const p = parseClientPayload(payload.payload);
    const pendingId = this.contexts.get(payload)?.pendingId;
    const sponsored = this.contexts.get(payload)?.sponsor;
    if (sponsored) {
      // A deposit spent the sponsor UTxO. A refund only held it as collateral: it is free again.
      if (p.type === "refund") this.config.sponsor!.pool.release(sponsored.offer.input, sponsored.txHash, true);
      else this.config.sponsor!.pool.retire(sponsored.offer.input);
      this.sponsorLog(`settled ${sponsored.txHash.slice(0, 16)}… using ${sponsored.offer.input.slice(0, 16)}…#${sponsored.offer.input.split("#")[1]}`);
    }
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
        ...(sponsored?.opening ? { reserveFrom: "seller" as const } : {}),
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

  /**
   * Keeps a paid request's answer as its channel's latest: the handler's response and the
   * settlement. Over HTTP the response is the body the transport hands over; over MCP it is the
   * tool's result, kept only in a shape `@x402/mcp` can give back unchanged (`mcpAnswer`).
   */
  private keep(v: { channelId: string; maxClaimableAmount: string; signature: string }, ctx: SettleResultContext, enrichment?: Record<string, unknown>) {
    if (this.replayTtlMs <= 0 || !ctx.result.success) return;
    const t = ctx.transportContext as { responseBody?: Uint8Array; responseHeaders?: Record<string, string>; result?: unknown } | undefined;
    // The channel's earlier answer can no longer be served, whether or not this one can be kept;
    // a kept one is re-inserted, so the map stays oldest first.
    this.replays.delete(v.channelId);
    const answer = t?.responseBody ? httpAnswer(t.responseBody, t.responseHeaders) : mcpAnswer(t?.result);
    if (!answer) return;
    this.replays.set(v.channelId, {
      amount: v.maxClaimableAmount,
      signature: v.signature,
      contentType: answer.contentType,
      body: answer.body,
      result: structuredClone(ctx.result) as SettleResponse,
      ...(enrichment ? { enrichment: structuredClone(enrichment) } : {}),
      at: Date.now(),
    });
    while (this.replays.size > MAX_REPLAYS) this.replays.delete(this.replays.keys().next().value!);
  }

  /**
   * Each token accept gets a fee-sponsor offer when the server sponsors and its facilitator can
   * merge the seller's witness; a paid request that echoes an offer this pool made gets it back
   * verbatim, so it matches whether or not it spends it. On `cumulative_amount_mismatch`, the
   * accept also says where the server's count stands and what it last signed.
   */
  enrichPaymentRequiredResponse = async (ctx: SchemePaymentRequiredContext): Promise<PaymentRequirements[] | void> => {
    await this.offerSponsorship(ctx);
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

  // ---- fee sponsorship (SPONSORSHIP.md) -----------------------------------------------

  private async offerSponsorship(ctx: SchemePaymentRequiredContext): Promise<void> {
    const sp = this.config.sponsor;
    if (!sp || !this.sponsorCapable) return;
    const paid = (ctx.paymentPayload as PaymentPayload | undefined) ?? paidPayloadOf(ctx.transportContext);
    for (const accept of ctx.requirements) {
      if (accept.scheme !== SCHEME || accept.asset === LOVELACE || Object.prototype.hasOwnProperty.call(accept.extra ?? {}, OFFER_KEY)) continue;
      await this.refreshPool();
      const reused = this.reusedOffer(paid, accept);
      const offer = reused ?? (await sp.pool.offer(Math.min(sp.offerTtlSeconds ?? accept.maxTimeoutSeconds, accept.maxTimeoutSeconds) * 1000));
      if (offer) accept.extra = { ...accept.extra, areFeesSponsored: true, [OFFER_KEY]: offer };
    }
  }

  private reusedOffer(paid: PaymentPayload | undefined, accept: PaymentRequirements): FeeSponsorOffer | undefined {
    const a = paid?.accepted;
    if (!a || a.scheme !== accept.scheme || a.network !== accept.network || a.payTo !== accept.payTo || a.amount !== accept.amount || a.asset !== accept.asset || a.maxTimeoutSeconds !== accept.maxTimeoutSeconds) return undefined;
    try {
      const o = offerIn(a.extra);
      return o && this.config.sponsor!.pool.known(o) ? o : undefined;
    } catch {
      return undefined;
    }
  }

  /** Re-reads the pool now and then; a failed read keeps what it last read and is tried again next 402. */
  private async refreshPool(): Promise<void> {
    const sp = this.config.sponsor!;
    if (Date.now() - this.lastPoolRefresh < (sp.refreshMs ?? 20_000)) return;
    try {
      await sp.pool.refresh();
      this.lastPoolRefresh = Date.now();
    } catch (e) {
      this.sponsorLog(`pool refresh failed, serving from what it last read: ${(e as Error).message}`);
    }
  }

  /** The offer and transaction when this deposit spends the requirements' offer. */
  private sponsoredDeposit(payload: Payload, req: PaymentRequirements): { offer: FeeSponsorOffer; txHash: string; opening: boolean } | undefined {
    if (!this.config.sponsor) return undefined;
    try {
      const p = parseClientPayload(payload.payload);
      if (p.type !== "deposit") return undefined;
      const offer = offerIn(req.extra);
      if (!offer) return undefined;
      const hex = fromBase64(p.deposit.transaction);
      const spends = decodeTx(hex, Err.depositTransaction).body.inputs.some((i) => `${TransactionHash.toHex(i.transactionId)}#${Number(i.index)}` === offer.input);
      return spends ? { offer, txHash: txHashOf(hex), opening: !p.voucher.channelRef } : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * A deposit that spends the offer: the seller's rules for an opening or a top-up, then the
   * binding and the seller's witness, before the handler runs. A refusal aborts the request.
   */
  private async bindSponsoredDeposit(payload: Payload, req: PaymentRequirements, txB64: string, opening: boolean) {
    const found = this.sponsoredDeposit(payload, req);
    if (!found) return undefined;
    const sp = this.config.sponsor!;
    const hex = fromBase64(txB64);
    const me = await sp.pool.identity();
    if (found.offer.address !== me.address) return { abort: true as const, reason: "fee_sponsor_invalid", message: "the offer is not this seller's" };
    const base = {
      txHex: hex,
      offer: found.offer,
      network: req.network,
      payTo: this.config.payTo,
      sponsorKeyHash: me.keyHash,
      ownerOf: (ref: string) => this.ownerOf(ref),
      fees: await this.config.chain.feeParameters(),
      missingWitnesses: 1,
      ...(sp.maxCollateral !== undefined ? { maxCollateral: sp.maxCollateral } : {}),
    };
    let r: SponsorResult;
    if (opening) {
      const tx = decodeTx(hex, Err.depositTransaction);
      const out = tx.body.outputs.find((o) => isChannelOutput(o.address, this.validator.hash));
      if (!out || !(out.datumOption instanceof InlineDatum.InlineDatum)) return { abort: true as const, reason: "fee_sponsor_S4", message: "no channel output" };
      const reserve = channelReserve(out.address, parseDatum(out.datumOption.data, this.validator, networkIdOf(req.network)).constants, await this.config.chain.coinsPerUtxoByte());
      r = await checkSponsoredOpen({ ...base, scriptHash: this.validator.hash, reserve });
    } else {
      r = await checkSponsoredTopUp(base);
    }
    if (!r.ok) {
      this.sponsorLog(`refused ${r.rule}: ${r.detail}`);
      return { abort: true as const, reason: `fee_sponsor_${r.rule}`, message: r.detail };
    }
    const ttl = decodeTx(hex, Err.depositTransaction).body.ttl!;
    if (!sp.pool.bind(found.offer, r.txHash, Number(msOfSlot(req.network, ttl)))) {
      return { abort: true as const, reason: "fee_sponsor_taken", message: "the offered UTxO is bound to another transaction; pay again with a fresh offer" };
    }
    try {
      await sp.pool.sign(found.offer, r.txHash, hex);
    } catch (e) {
      sp.pool.release(found.offer.input, r.txHash);
      return { abort: true as const, reason: "fee_sponsor_S9", message: (e as Error).message };
    }
    this.merge(payload, { sponsor: found });
    this.sponsorLog(`bound ${found.offer.input.slice(0, 16)}…#${found.offer.input.split("#")[1]} to ${opening ? "opening" : "top-up"} ${r.txHash.slice(0, 16)}…, fee ${r.fee}`);
    return undefined;
  }

  /** A refund whose collateral is the offer: the seller's refund rules, binding, and witness. */
  private async signSponsoredRefund(ctx: SettleContext, hex: string, ch: ServerChannel): Promise<string | undefined> {
    const sp = this.config.sponsor;
    if (!sp) return undefined;
    let offer: FeeSponsorOffer | undefined;
    try {
      offer = offerIn(ctx.requirements.extra as Record<string, unknown>);
    } catch {
      return undefined;
    }
    const tx = decodeTx(hex, Err.refundTransaction);
    if (!offer || !(tx.body.collateralInputs ?? []).some((c) => `${TransactionHash.toHex(c.transactionId)}#${Number(c.index)}` === offer!.input)) return undefined;
    const me = await sp.pool.identity();
    if (offer.address !== me.address) throw new Error("fee_sponsor_invalid: the offer is not this seller's");
    const channel = await this.config.chain.getUnspent(ch.channelRef);
    if (!channel) throw new Error(`${Err.refundTransaction}: the channel is spent or unknown`);
    const r = await checkSponsoredRefund({
      txHex: hex,
      offer,
      network: ctx.requirements.network,
      payTo: this.config.payTo,
      sponsorKeyHash: me.keyHash,
      ownerOf: (ref: string) => this.ownerOf(ref),
      fees: await this.config.chain.feeParameters(),
      // The provider's witness and the seller's are both still to come.
      missingWitnesses: 2,
      ...(sp.maxCollateral !== undefined ? { maxCollateral: sp.maxCollateral } : {}),
      channelRef: ch.channelRef,
      channelLovelace: Assets.lovelaceOf(channel.assets),
      consumerKeyHash: ch.channelConfig.payer,
      reserveFromSeller: ch.reserveFrom === "seller",
      evaluate: () => this.config.chain.evaluate(hex),
    });
    if (!r.ok) {
      this.sponsorLog(`refused refund ${r.rule}: ${r.detail}`);
      throw new Error(`fee_sponsor_${r.rule}: ${r.detail}`);
    }
    if (!sp.pool.bind(offer, r.txHash, Number(msOfSlot(ctx.requirements.network, tx.body.ttl!)))) throw new Error("fee_sponsor_taken: the offered UTxO is bound to another transaction");
    const witness = await sp.pool.sign(offer, r.txHash, hex);
    sp.pool.witnessFor(offer, r.txHash);
    this.merge(ctx.paymentPayload, { sponsor: { offer, txHash: r.txHash, opening: false } });
    this.sponsorLog(`bound ${offer.input.slice(0, 16)}…#${offer.input.split("#")[1]} as collateral of refund ${r.txHash.slice(0, 16)}…${ch.reserveFrom === "seller" ? ", reserve back to payTo" : ""}`);
    return witness;
  }

  private async ownerOf(ref: string): Promise<{ exists: boolean; paymentKeyHash?: string }> {
    const u = await this.config.chain.getUnspent(ref);
    if (!u) return { exists: false };
    const pay = u.address.paymentCredential;
    return { exists: true, ...(pay instanceof KeyHash.KeyHash ? { paymentKeyHash: KeyHash.toHex(pay).toLowerCase() } : {}) };
  }

  /** A cancelled or failed request lets go of its binding when nothing it signed can land. */
  private releaseSponsor(payload: Payload, errorReason?: string) {
    const s = this.contexts.get(payload)?.sponsor;
    if (!s || !this.config.sponsor) return;
    this.config.sponsor.pool.release(s.offer.input, s.txHash, errorReason !== undefined && errorReason !== "settlement_pending");
  }

  private sponsorLog(line: string) {
    this.config.sponsor?.log?.(`[sponsor] ${line}`);
  }

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

  /**
   * `/verify` found the channel closed: the consumer has closed it on chain. From here its vouchers
   * are refused, here for the next TTL and at `/verify` after that, and what it owes is settled now
   * (`onChannelClosed`). Until a read gives the close's own value, `withdrawRequestedAt` holds when
   * the server learnt of it; a `/verify` that finds the channel open again sets it back to 0.
   */
  private async noteClosed(payload: Payload) {
    let channelId: string;
    try {
      channelId = parseClientPayload(payload.payload).voucher.channelId;
    } catch {
      return;
    }
    const askedAt = this.contexts.get(payload)?.askedAt ?? Date.now();
    const upd = await this.storage.updateChannel(channelId, (cur) =>
      cur && cur.withdrawRequestedAt === 0 && cur.channelRef !== "" ? { ...cur, withdrawRequestedAt: Math.floor(Date.now() / 1000), onchainSyncedAt: askedAt } : cur,
    );
    if (upd.status === "updated") this.config.onChannelClosed?.(channelId);
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

/** An HTTP response body to keep for a replay, parsed as its content type says. */
function httpAnswer(responseBody: Uint8Array, headers?: Record<string, string>): { contentType: string; body: unknown } {
  const contentType = Object.entries(headers ?? {}).find(([k]) => k.toLowerCase() === "content-type")?.[1] ?? "application/json";
  const bytes = Buffer.from(responseBody);
  if (/json/i.test(contentType)) {
    try {
      return { contentType, body: JSON.parse(bytes.toString("utf8")) };
    } catch {
      return { contentType, body: bytes.toString("utf8") };
    }
  }
  return { contentType, body: /^text\//i.test(contentType) ? bytes.toString("utf8") : bytes };
}

/**
 * An MCP tool's result to keep for a replay, or `undefined` when a replay could not give it back
 * unchanged. `@x402/mcp` turns a skip-handler body into a result itself: a string becomes one text
 * block, and an object becomes structured content with its JSON as that block. So only those two
 * shapes are kept. Anything else (several blocks, an image, an error, a `_meta` of the tool's own)
 * is not, and its retry is charged as a new request.
 */
function mcpAnswer(result: unknown): { contentType: string; body: unknown } | undefined {
  if (typeof result !== "object" || result === null) return undefined;
  const r = result as Record<string, unknown>;
  if (r.isError || Object.keys(r).some((k) => k !== "content" && k !== "structuredContent" && k !== "isError")) return undefined;
  if (!Array.isArray(r.content) || r.content.length !== 1) return undefined;
  const block = r.content[0] as Record<string, unknown>;
  if (block?.type !== "text" || typeof block.text !== "string" || Object.keys(block).length !== 2) return undefined;
  const s = r.structuredContent;
  if (s === undefined) return { contentType: "text/plain", body: block.text };
  const plain = typeof s === "object" && s !== null && !Array.isArray(s);
  return plain && JSON.stringify(s) === block.text ? { contentType: "application/json", body: s } : undefined;
}

/**
 * The paid payload behind a 402 being built for a paid request: core passes it in the transport
 * context only as `request.paymentHeader`, and only when the framework set it, so the adapter's
 * `PAYMENT-SIGNATURE` header and MCP's `_meta` are read too.
 */
function paidPayloadOf(transportContext: unknown): PaymentPayload | undefined {
  const t = transportContext as { request?: { paymentHeader?: unknown; adapter?: { getHeader?(n: string): string | undefined } }; meta?: Record<string, unknown> } | undefined;
  const header = typeof t?.request?.paymentHeader === "string" ? t.request.paymentHeader : (t?.request?.adapter?.getHeader?.("payment-signature") ?? t?.request?.adapter?.getHeader?.("PAYMENT-SIGNATURE"));
  if (header) {
    try {
      return decodePaymentSignatureHeader(header);
    } catch {
      return undefined;
    }
  }
  const meta = t?.meta?.["x402/payment"];
  return typeof meta === "object" && meta !== null && "accepted" in meta ? (meta as PaymentPayload) : undefined;
}

/** The provider signer for a seed wallet built with evolution-sdk: signs the exact bytes. */
export function walletProviderSigner(wallet: { signTx(tx: string): Promise<TransactionWitnessSet.TransactionWitnessSet> }): ProviderSigner {
  return async (hex) => TransactionWitnessSet.toCBORHex(await wallet.signTx(hex));
}

export { Transaction };
