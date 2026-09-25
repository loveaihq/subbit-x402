// The client side of the Cardano binding (DESIGN.md §5–§6): opens a Subbit channel with the first
// paid request, signs a cumulative IOU for each one after it, keeps its count in step with the
// server's responses (and the corrective 402), and closes the channel cooperatively with a
// `Mutual` refund. It builds and signs every transaction itself and pays their fees. Its IOU keys
// derive from the wallet, so after losing its records it finds its channels again (`recover`).
// A wallet that decides what may leave it (a spend policy) sees each voucher and transaction
// through `authorize` before anything is handed out or recorded.
import { createPrivateKey, hkdfSync, sign as edSign } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  PaymentPayload,
  PaymentPayloadResult,
  PaymentRequired,
  PaymentRequirements,
  SchemeClientHooks,
  SchemeNetworkClient,
  SettleResponse,
} from "@x402/core/types";
import { decodePaymentRequiredHeader, decodePaymentResponseHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import { Address, Assets, Client, InlineDatum, KeyHash, ScriptHash, Transaction, TransactionHash, TransactionInput, TransactionWitnessSet, TxOut, preprod, type UTxO } from "@evolution-sdk/evolution";
import { Redeemer, Step, channelAddress, iouBody, iouSignerFromSeed, inlineDatum, newIouSigner, subbitScript, tagFromInput, type Currency } from "../subbit.ts";
import {
  assetOf,
  capacityOf,
  channelReserve,
  constantsOf,
  currencyOf,
  msOfSlot,
  networkIdOf,
  planTokens,
  refOf,
  slotAtOrAfter,
  slotOfMs,
  subbedOf,
  txHashOf,
  valueFor,
  verifyVoucherSignature,
  type ChannelView,
} from "./cardano.ts";
import { retryQueries, type Chain } from "./chain.ts";
import {
  Err,
  LOVELACE,
  SCHEME,
  parseClientPayload,
  parseExtra,
  toBase64,
  type BatchExtra,
  type ChannelConfig,
  type ChannelState,
  type RefundPayload,
  type VoucherState,
} from "./types.ts";

export type SeedWallet = ReturnType<ReturnType<ReturnType<typeof Client.make>["withBlockfrost"]>["withSeed"]>;
void preprod;

// ---- storage -------------------------------------------------------------------

export interface ClientChannel {
  channelId: string;
  /** Which server (payTo, key, script, asset, close period) the channel is for. */
  serverKey: string;
  channelConfig: ChannelConfig;
  /**
   * A random IOU key, which exists nowhere else. A derived one is not stored: it is derived again
   * for each voucher, so a record on disk cannot sign one. (Records from before that change carry
   * their derived key here too, and it is used.)
   */
  iouPrivateKeyPem?: string;
  channelRef?: string;
  /** Currency amount locked, and the capacity IOUs may reach. */
  deposit: string;
  balance: string;
  chargedCumulativeAmount: string;
  /** `failed`: the opening transaction never reached the chain. `closing`: closed on chain, not yet ended or elapsed. */
  status: "pending" | "open" | "closing" | "closed" | "failed";
  openTx?: string;
  /** Position of the channel output in the opening transaction, and the inputs it spends. */
  openIndex?: number;
  openInputs?: string[];
  openedAt: number;
  /** What the unilateral exit needs without a server: where the channel lives. */
  network?: string;
  scriptHash?: string;
  referenceScript?: string;
  /** Set once the channel is closed on chain. */
  elapseAt?: string;
  /** How its IOU key was made: derived from the wallet, so `recover` can make it again, or random. */
  iouKey?: "derived" | "random";
  /** When `recover` found it on chain. Until a 402 binds it to a server, `serverKey` and `channelConfig.receiver` are empty. */
  recoveredAt?: number;
  /** Found by `recover` with an IOU key this wallet cannot derive: it can only be closed, then ended or elapsed. */
  exitOnly?: boolean;
}

/** Where a client keeps its channels. */
export interface ClientStorage {
  get(id: string): Promise<ClientChannel | undefined>;
  set(c: ClientChannel): Promise<void>;
  list(): Promise<ClientChannel[]>;
  /** The newest channel for this server that is open or still opening. */
  current(serverKey: string): Promise<ClientChannel | undefined>;
}

/**
 * `{dir}/{channelId}.json`, owner-only, each written whole or not at all: a torn record would stop
 * the client reading any of them. Random IOU keys live here, so the directory stays out of git.
 */
export class FileClientStorage implements ClientStorage {
  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  async get(id: string): Promise<ClientChannel | undefined> {
    const f = join(this.dir, `${id}.json`);
    return existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as ClientChannel) : undefined;
  }
  async set(c: ClientChannel): Promise<void> {
    const f = join(this.dir, `${c.channelId}.json`);
    writeFileSync(`${f}.tmp`, JSON.stringify(c, null, 2), { mode: 0o600 });
    renameSync(`${f}.tmp`, f);
  }
  async list(): Promise<ClientChannel[]> {
    return readdirSync(this.dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => JSON.parse(readFileSync(join(this.dir, f), "utf8")) as ClientChannel);
  }
  /** The newest channel for this server that is open or still opening. */
  async current(serverKey: string): Promise<ClientChannel | undefined> {
    return (await this.list()).filter((c) => c.serverKey === serverKey && (c.status === "open" || c.status === "pending")).sort((a, b) => b.openedAt - a.openedAt)[0];
  }
}

// ---- the scheme ----------------------------------------------------------------

/**
 * What the client is about to hand out or submit, for `authorize`. `amount` is the voucher's
 * cumulative `maxClaimableAmount`; `transaction` is signed CBOR hex. Nothing has been recorded
 * yet, and `channel` is the record as it will be written.
 */
export type Authorization =
  | { kind: "voucher"; channel: ClientChannel; amount: bigint; requirements: PaymentRequirements }
  | {
      kind: "open";
      channel: ClientChannel;
      amount: bigint;
      /** What the channel output holds of its currency: an ADA channel's reserve included. */
      deposit: bigint;
      /** The ADA the channel keeps for min-UTxO: inside `deposit` for ADA, beside the tokens otherwise. */
      reserve: bigint;
      transaction: string;
      requirements: PaymentRequirements;
    }
  | { kind: "topUp"; channel: ClientChannel; amount: bigint; deposit: bigint; transaction: string; view: ChannelView; requirements: PaymentRequirements }
  | { kind: "refund"; channel: ClientChannel; amount: bigint; /** Paid to `payTo`: charged and not yet redeemed. */ payout: bigint; transaction: string; view: ChannelView; requirements: PaymentRequirements }
  | { kind: "close" | "end" | "elapse"; channel: ClientChannel; transaction: string; view: ChannelView };

export interface ClientOptions {
  wallet: SeedWallet;
  storage: ClientStorage;
  /** Read-only chain access, for the refund. */
  chain: Chain;
  /**
   * Capacity to open a channel with, and to add in a top-up: one amount, or one per 402. The
   * server's `minDeposit` and 10 × price are the floor.
   */
  capacity?: bigint | ((req: PaymentRequirements) => bigint);
  /**
   * The most one deposit may lock of the currency, an ADA channel's reserve included. The client
   * locks less than `capacity` to stay within it, and refuses when even the floor would not fit.
   */
  maxDeposit?: bigint | ((req: PaymentRequirements) => bigint | undefined);
  /**
   * Sees every voucher and transaction before it is handed out or submitted, and before anything
   * about it is recorded; throwing refuses it, and the client is left as it was.
   */
  authorize?: (a: Authorization) => Promise<void>;
  /** Shared by every client instance on one wallet: inputs their transactions just spent, and when. */
  spentInputs?: Map<string, number>;
  /**
   * How IOU keys are made. `derived` (the default): from the channel's tag and the wallet's
   * signature of `IOU_ROOT_MESSAGE`, so a client that has lost its records derives them again
   * and keeps using its channels. `random`: a fresh key per channel, kept only in the records;
   * such a channel, once its record is lost, can only be closed.
   */
  iouKeys?: "derived" | "random";
}

/** How long spent inputs are held back from coin selection (`spentInputs` entries expire after it). */
export const PENDING_MS = 5 * 60_000;

export class BatchSettlementCardanoClient implements SchemeNetworkClient {
  readonly scheme = SCHEME;
  readonly schemeHooks: SchemeClientHooks;
  /** Inputs spent recently, kept out of coin selection until the wallet's view drops them. */
  private readonly spent: Map<string, number>;
  /** The wallet's IOU root, asked for once. */
  private root?: Promise<Uint8Array>;

  constructor(private readonly o: ClientOptions) {
    this.spent = o.spentInputs ?? new Map<string, number>();
    this.schemeHooks = {
      onPaymentResponse: async (ctx) => {
        if (ctx.settleResponse) {
          await this.applySettle(ctx.paymentPayload, ctx.requirements, ctx.settleResponse);
          return;
        }
        if (ctx.paymentRequired && (await this.applyCorrective(ctx.paymentRequired))) return { recovered: true as const };
      },
    };
  }

  async createPaymentPayload(x402Version: number, req: PaymentRequirements): Promise<PaymentPayloadResult> {
    currencyOf(req.asset); // lovelace or policy.name, else throws
    const extra = parseExtra(req);
    const amount = BigInt(req.amount);
    let ch = (await this.o.storage.current(serverKey(req, extra))) ?? (await this.bindRecovered(req, extra));
    if (ch?.status === "pending") ch = await this.settlePending(ch, extra);
    if (ch?.status === "open") {
      const ceiling = BigInt(ch.chargedCumulativeAmount) + amount;
      if (ceiling <= BigInt(ch.balance)) return { x402Version, payload: await this.voucher(ch, ceiling, req) };
      // Short of capacity. Read the channel first: a top-up that landed late may already cover it.
      const view = ch.channelRef ? await this.o.chain.followChannel(ch.channelRef, extra.scriptHash, ch.channelId) : undefined;
      if (view && view.datum.stage.kind === "opened") {
        const capacity = capacityOf(view, await this.o.chain.coinsPerUtxoByte());
        if (capacity.toString() !== ch.balance || view.ref !== ch.channelRef) {
          ch = { ...ch, balance: capacity.toString(), channelRef: view.ref };
          await this.o.storage.set(ch);
        }
        if (ceiling <= capacity) return { x402Version, payload: await this.voucher(ch, ceiling, req) };
        return { x402Version, payload: await this.topUp(req, extra, ch, view, amount) };
      }
      await this.o.storage.set({ ...ch, status: "closed" }); // gone from under us: open a new one
    }
    return { x402Version, payload: await this.openChannel(req, extra, amount) };
  }

  /** A voucher for `ceiling` on an open channel, once `authorize` has seen it. */
  private async voucher(ch: ClientChannel, ceiling: bigint, req: PaymentRequirements) {
    await this.o.authorize?.({ kind: "voucher", channel: ch, amount: ceiling, requirements: req });
    return {
      type: "voucher",
      channelConfig: ch.channelConfig,
      voucher: { channelId: ch.channelId, maxClaimableAmount: ceiling.toString(), signature: await this.signVoucher(ch, ceiling), ...(ch.channelRef ? { channelRef: ch.channelRef } : {}) },
    };
  }

  /** `depositWithin` for this 402: `capacity` wanted, the server's `minDeposit` and 10 × price the floor. */
  private depositFor(req: PaymentRequirements, extra: BatchExtra, amount: bigint, room?: bigint): bigint {
    const minDeposit = extra.minDeposit ? BigInt(extra.minDeposit) : 0n;
    const floor = minDeposit > 10n * amount ? minDeposit : 10n * amount;
    return depositWithin(typeof this.o.capacity === "function" ? this.o.capacity(req) : (this.o.capacity ?? 0n), floor, room);
  }

  private maxDepositFor(req: PaymentRequirements): bigint | undefined {
    return typeof this.o.maxDeposit === "function" ? this.o.maxDeposit(req) : this.o.maxDeposit;
  }

  /**
   * A deposit on the channel that already exists: `Main([Add])` on its current position, the
   * same datum, and more of the currency; the voucher covers this request on the larger capacity.
   */
  private async topUp(req: PaymentRequirements, extra: BatchExtra, ch: ClientChannel, view: ChannelView, amount: bigint) {
    const w = this.o.wallet;
    const me = await w.address();
    const add = this.depositFor(req, extra, amount, this.maxDepositFor(req));
    const all = await this.available();
    // ADA-only UTxOs pay the ADA and the fee, so no other token rides along into the change; a
    // token channel's tokens come from the UTxOs `planTokens` picks, folding older ones in.
    const adaOnly = all.filter((u) => Assets.hasOnlyLovelace(u.assets));
    const c = view.datum.constants.currency;
    let tx = w.newTx().collectFrom({ inputs: [view.utxo], redeemer: Redeemer.main([Step.add()]) });
    tx = await this.withValidator(tx, extra.referenceScript);
    if (c.kind !== "ada") tx = withTokens(tx, me, c, planTokens(all, c, add, 0n));
    tx = tx
      .payToAddress({ address: view.address, assets: valueFor(c, view.amount + add, view.lovelace), datum: view.utxo.datumOption as InlineDatum.InlineDatum })
      .addSigner({ keyHash: KeyHash.fromHex(ch.channelConfig.payer) });
    const sb = await retryQueries("top-up", () => tx.build({ changeAddress: me, availableUtxos: adaOnly, setCollateral: collateralTarget(adaOnly) }));
    const signed = await signedHex(sb);
    const ceiling = BigInt(ch.chargedCumulativeAmount) + amount;
    await this.o.authorize?.({ kind: "topUp", channel: ch, amount: ceiling, deposit: add, transaction: signed, view, requirements: req });
    for (const i of Transaction.fromCBORHex(signed).body.inputs) this.spent.set(`${TransactionHash.toHex(i.transactionId)}#${i.index}`, Date.now());
    return {
      type: "deposit",
      channelConfig: ch.channelConfig,
      voucher: { channelId: ch.channelId, maxClaimableAmount: ceiling.toString(), signature: await this.signVoucher(ch, ceiling), channelRef: view.ref },
      deposit: { amount: add.toString(), transaction: toBase64(signed) },
    };
  }

  private async withValidator(tx: ReturnType<SeedWallet["newTx"]>, referenceScript?: string) {
    const ref = referenceScript ? await this.o.chain.getUnspent(referenceScript) : undefined;
    return ref?.scriptRef ? tx.readFrom({ referenceInputs: [ref] }) : tx.attachScript({ script: subbitScript });
  }

  /**
   * A channel whose opening the server never confirmed. If the transaction reached the chain,
   * carry on with it (the server counts from zero: it never counted the first request). It is
   * given up only when one of its inputs has gone to another transaction, since only then can it
   * never land; a slow block or a lagging index is not proof, and preprod has produced both.
   */
  private async settlePending(ch: ClientChannel, extra: BatchExtra): Promise<ClientChannel | undefined> {
    if (ch.openTx === undefined || ch.openIndex === undefined || !ch.openInputs) throw new Error(`channel ${ch.channelId.slice(0, 16)}… has no opening record to check`);
    const v = await this.o.chain.followChannel(`${ch.openTx}#${ch.openIndex}`, extra.scriptHash, ch.channelId);
    if (v && v.datum.stage.kind === "opened") {
      const open: ClientChannel = { ...ch, status: "open", channelRef: v.ref, chargedCumulativeAmount: v.datum.stage.subbed.toString() };
      await this.o.storage.set(open);
      return open;
    }
    for (const input of ch.openInputs) {
      const by = await this.o.chain.spentBy(input);
      if (by && by !== ch.openTx) {
        await this.o.storage.set({ ...ch, status: "failed" });
        return undefined;
      }
    }
    throw new Error(`channel ${ch.channelId.slice(0, 16)}… is still opening (${ch.openTx}); retry shortly`);
  }

  /** A new channel whose opening transaction is the deposit, with the first request's IOU. */
  private async openChannel(req: PaymentRequirements, extra: BatchExtra, amount: bigint) {
    const w = this.o.wallet;
    const me = await w.address();
    const payer = keyHash(me);
    const cur = currencyOf(req.asset);
    const cap = this.maxDepositFor(req);
    // A token channel's deposit is its tokens alone; an ADA channel's holds its reserve too, which
    // is known only further down.
    const tokens = cur.kind === "ada" ? undefined : this.depositFor(req, extra, amount, cap);
    const all = await this.available();
    // As for a top-up: ADA from ADA-only UTxOs, a token channel's tokens from `planTokens`.
    const adaOnly = all.filter((u) => Assets.hasOnlyLovelace(u.assets));
    const plan = tokens === undefined ? undefined : planTokens(all, cur, tokens, 0n);
    // The tag can come from any input the opening spends. A token channel seeds from the largest
    // UTxO holding its token, which it spends anyway; an ADA channel from the largest ADA-only
    // UTxO. That keeps openings from using up the ADA-only UTxOs that collateral comes from.
    const seed = plan ? plan.inputs[0] : [...adaOnly].sort((a, b) => (Assets.lovelaceOf(b.assets) > Assets.lovelaceOf(a.assets) ? 1 : -1))[0];
    if (!seed) throw new Error(`no UTxO to open a ${req.asset} channel from`);
    // The tag must be unique per IOU key; Subbit's ADR: hash an input this transaction spends.
    const tag = tagFromInput(new TransactionInput.TransactionInput({ transactionId: seed.transactionId, index: seed.index }));
    const random = this.o.iouKeys === "random";
    const signer = random ? newIouSigner() : derivedIouSigner(await this.iouRoot(), req.network, tag);
    const config: ChannelConfig = {
      payer,
      payerAuthorizer: signer.publicKey,
      receiver: req.payTo,
      receiverAuthorizer: extra.receiverAuthorizer,
      token: req.asset,
      withdrawDelay: extra.withdrawDelay,
    };
    const constants = constantsOf(config, tag);
    const address = channelAddress(networkIdOf(req.network));
    if (ScriptHash.toHex(address.paymentCredential as ScriptHash.ScriptHash) !== extra.scriptHash) throw new Error("server asks for a validator this client does not have");
    const cpb = (await w.getProtocolParameters()).coinsPerUtxoByte;
    const reserve = channelReserve(address, constants, cpb);
    // An ADA channel holds its capacity plus the reserve; a token channel holds its capacity in
    // tokens and exactly the reserve in ADA, since the validator does not count that ADA.
    const isAda = constants.currency.kind === "ada";
    const capacity = tokens ?? this.depositFor(req, extra, amount, cap === undefined ? undefined : cap - reserve);
    const deposit = isAda ? capacity + reserve : capacity;

    const tx = (plan ? withTokens(w.newTx(), me, cur, plan) : w.newTx().collectFrom({ inputs: [seed] })).payToAddress({
      address,
      assets: valueFor(constants.currency, deposit, reserve),
      datum: inlineDatum(constants, { kind: "opened", subbed: 0n }),
    });
    const sb = await retryQueries("open", () => tx.build({ changeAddress: me, availableUtxos: adaOnly }));
    const signed = await signedHex(sb);
    const built = Transaction.fromCBORHex(signed);
    const openInputs = built.body.inputs.map((i) => `${TransactionHash.toHex(i.transactionId)}#${i.index}`);
    const openIndex = built.body.outputs.findIndex((o) => o.address.paymentCredential instanceof ScriptHash.ScriptHash && ScriptHash.toHex(o.address.paymentCredential) === extra.scriptHash);

    const ch: ClientChannel = {
      channelId: tag,
      serverKey: serverKey(req, extra),
      channelConfig: config,
      ...(random ? { iouPrivateKeyPem: signer.privateKey.export({ type: "pkcs8", format: "pem" }).toString() } : {}),
      iouKey: random ? "random" : "derived",
      deposit: deposit.toString(),
      balance: capacity.toString(),
      chargedCumulativeAmount: "0",
      status: "pending",
      openTx: txHashOf(signed),
      openIndex,
      openInputs,
      openedAt: Date.now(),
      network: req.network,
      scriptHash: extra.scriptHash,
      ...(extra.referenceScript ? { referenceScript: extra.referenceScript } : {}),
    };
    await this.o.authorize?.({ kind: "open", channel: ch, amount, deposit, reserve, transaction: signed, requirements: req });
    for (const r of openInputs) this.spent.set(r, Date.now());
    await this.o.storage.set(ch);
    return {
      type: "deposit",
      channelConfig: config,
      voucher: { channelId: tag, maxClaimableAmount: amount.toString(), signature: signer.sign(tag, amount) },
      deposit: { amount: deposit.toString(), transaction: toBase64(signed) },
    };
  }

  /** The server's receipt moves the local count only by what it says it charged, never past the request's price. */
  private async applySettle(payload: PaymentPayload, req: PaymentRequirements, settle: SettleResponse) {
    if (!settle.success) return;
    let p;
    try {
      p = parseClientPayload(payload.payload);
    } catch {
      return;
    }
    const ch = await this.o.storage.get(p.voucher.channelId);
    if (!ch) return;
    const state = (settle.extra?.channelState ?? {}) as Partial<ChannelState>;
    if (p.type === "refund") {
      await this.o.storage.set({ ...ch, status: "closed" });
      return;
    }
    const charged = settle.extra?.chargedAmount === undefined ? 0n : BigInt(String(settle.extra.chargedAmount));
    if (charged > BigInt(req.amount)) throw new Error("the server charged more than the price");
    const next = BigInt(ch.chargedCumulativeAmount) + charged;
    if (state.chargedCumulativeAmount !== undefined && BigInt(state.chargedCumulativeAmount) !== next) return;
    // A deposit on a channel already open is a top-up: its capacity and deposit grow by the amount.
    const topUp = p.type === "deposit" && ch.status === "open" ? BigInt(p.deposit.amount) : 0n;
    await this.o.storage.set({
      ...ch,
      chargedCumulativeAmount: next.toString(),
      ...(p.type === "deposit" ? { status: "open" as const } : {}),
      ...(topUp > 0n ? { balance: (BigInt(ch.balance) + topUp).toString(), deposit: (BigInt(ch.deposit) + topUp).toString() } : {}),
      ...(state.channelRef ? { channelRef: state.channelRef } : {}),
    });
  }

  /**
   * A corrective 402: adopt the server's count only when it holds a voucher this client signed
   * for at least that much, as @x402/evm's client does.
   */
  private async applyCorrective(pr: PaymentRequired): Promise<boolean> {
    if (pr.error !== Err.cumulativeAmountMismatch && pr.error !== Err.cumulativeBelowClaimed) return false;
    const accept = pr.accepts.find((a) => a.scheme === SCHEME);
    const state = accept?.extra?.channelState as ChannelState | undefined;
    const vs = accept?.extra?.voucherState as VoucherState | undefined;
    if (!state?.chargedCumulativeAmount || !vs) return false;
    const ch = await this.o.storage.get(state.channelId);
    if (!ch) return false;
    const charged = BigInt(state.chargedCumulativeAmount);
    const signed = BigInt(vs.signedMaxClaimable);
    if (charged > signed || charged < BigInt(state.totalClaimed)) return false;
    if (!verifyVoucherSignature(ch.channelConfig.payerAuthorizer, ch.channelId, signed, vs.signature)) return false;
    await this.o.storage.set({ ...ch, chargedCumulativeAmount: charged.toString(), ...(state.channelRef ? { channelRef: state.channelRef } : {}) });
    return true;
  }

  // ---- refund ------------------------------------------------------------------

  /**
   * Closes the current channel for `url`'s server with a `Mutual` this client builds and signs,
   * paying the provider what it charged and not yet redeemed, and taking the rest back.
   */
  async refund(url: string, fetchImpl: typeof fetch = fetch, channelId?: string): Promise<SettleResponse> {
    const probe = await fetchImpl(url);
    if (probe.status !== 402) throw new Error(`refund probe expected 402, got ${probe.status}`);
    const paymentPayload = await this.refundPayload(decodePaymentRequiredHeader(probe.headers.get("PAYMENT-REQUIRED") ?? ""), channelId);
    const res = await fetchImpl(url, { headers: { "PAYMENT-SIGNATURE": encodePaymentSignatureHeader(paymentPayload) } });
    const header = res.headers.get("PAYMENT-RESPONSE");
    if (res.status !== 200 || !header) {
      const detail = res.headers.get("PAYMENT-REQUIRED") ? decodePaymentRequiredHeader(res.headers.get("PAYMENT-REQUIRED")!).error : header ? decodePaymentResponseHeader(header).errorReason : await res.text();
      throw new Error(`refund failed (${res.status}): ${detail}`);
    }
    const settle = decodePaymentResponseHeader(header);
    await this.applySettle(paymentPayload, paymentPayload.accepted, settle);
    return settle;
  }

  /**
   * `refund` without the HTTP: the payload to send `pr`'s server, for its current channel or for
   * `channelId`. It goes out as a paid request's would, and the answer comes back through
   * `onPaymentResponse`, which marks the channel closed once it settled. For a wallet that keeps
   * the network and the key in different processes.
   */
  async refundPayload(pr: PaymentRequired, channelId?: string): Promise<PaymentPayload> {
    const req = pr.accepts.find((a) => a.scheme === SCHEME);
    if (!req) throw new Error(`no ${SCHEME} option in this 402`);
    const extra = parseExtra(req);
    let ch = channelId ? await this.o.storage.get(channelId) : ((await this.o.storage.current(serverKey(req, extra))) ?? (await this.bindRecovered(req, extra)));
    if (ch && ch.status === "open" && this.bindable(ch, req, extra)) ch = await this.bind(ch, req, extra);
    if (!ch || ch.status !== "open" || !ch.channelRef || ch.serverKey !== serverKey(req, extra)) throw new Error("no open channel with this server");
    const view = await this.o.chain.followChannel(ch.channelRef, extra.scriptHash, ch.channelId);
    if (!view || view.datum.stage.kind !== "opened") throw new Error("the channel is not open on chain");
    const charged = BigInt(ch.chargedCumulativeAmount);
    const owed = charged - view.datum.stage.subbed;
    const w = this.o.wallet;
    const me = await w.address();
    const payTo = Address.fromBech32(req.payTo);
    const cur = view.datum.constants.currency;
    if (owed > 0n) {
      // A token share would need ADA of its own; an ADA share must clear min-UTxO. Either way,
      // what cannot be its own output is claimed by the server first.
      if (cur.kind !== "ada") throw new Error(`owed ${owed} tokens; the server must claim them before a refund`);
      const min = minAdaOutput(payTo, (await w.getProtocolParameters()).coinsPerUtxoByte);
      if (owed < min) throw new Error(`owed ${owed} is below the ${min} lovelace an output needs; the server must claim it first`);
    }
    const [channelUtxo] = await w.getUtxosByOutRef([new TransactionInput.TransactionInput({ transactionId: TransactionHash.fromHex(view.ref.split("#")[0]!), index: BigInt(view.ref.split("#")[1]!) })]);
    if (!channelUtxo) throw new Error("channel output not readable");
    let tx = w
      .newTx()
      .collectFrom({ inputs: [channelUtxo], redeemer: Redeemer.mutual() })
      .addSigner({ keyHash: KeyHash.fromHex(ch.channelConfig.payer) })
      .addSigner({ keyHash: KeyHash.fromHex(ch.channelConfig.receiverAuthorizer) });
    const ref = extra.referenceScript ? await this.o.chain.getUnspent(extra.referenceScript) : undefined;
    tx = ref?.scriptRef ? tx.readFrom({ referenceInputs: [ref] }) : tx.attachScript({ script: subbitScript });
    if (owed > 0n) tx = tx.payToAddress({ address: payTo, assets: Assets.fromLovelace(owed) });
    const adaOnly = (await this.available()).filter((u) => Assets.hasOnlyLovelace(u.assets));
    const sb = await retryQueries("refund", () => tx.build({ changeAddress: me, availableUtxos: adaOnly, setCollateral: collateralTarget(adaOnly) }));
    const signed = await signedHex(sb);
    await this.o.authorize?.({ kind: "refund", channel: ch, amount: charged, payout: owed > 0n ? owed : 0n, transaction: signed, view, requirements: req });

    const payload: RefundPayload = {
      type: "refund",
      channelConfig: ch.channelConfig,
      voucher: { channelId: ch.channelId, maxClaimableAmount: charged.toString(), signature: await this.signVoucher(ch, charged), channelRef: view.ref },
      transaction: toBase64(signed),
    };
    return { x402Version: 2, accepted: req, payload: payload as unknown as Record<string, unknown>, ...(pr.resource ? { resource: pr.resource } : {}) };
  }

  // ---- the consumer's own exit (outside x402) -----------------------------------------

  /**
   * Closes a channel without the server: `Main([Close])`, value and `subbed` unchanged, with the
   * earliest `elapse_at` the validator allows (the TTL slot's start plus the close period). The
   * server may still settle its latest IOU until then; after it has, `end` takes the rest.
   */
  async close(channelId: string): Promise<{ transaction: string; elapseAt: bigint }> {
    const { ch, view, network } = await this.openView(channelId);
    if (view.datum.stage.kind !== "opened") throw new Error(`channel is ${view.datum.stage.kind}`);
    const to = msOfSlot(network, slotOfMs(network, BigInt(Date.now())) + 300n);
    const elapseAt = to + view.datum.constants.closePeriodMs;
    let tx = this.o.wallet.newTx().collectFrom({ inputs: [view.utxo], redeemer: Redeemer.main([Step.close()]) });
    tx = await this.withValidator(tx, ch.referenceScript);
    tx = tx
      .payToAddress({ address: view.address, assets: view.utxo.assets, datum: inlineDatum(view.datum.constants, { kind: "closed", subbed: view.datum.stage.subbed, elapseAt }) })
      .addSigner({ keyHash: KeyHash.fromHex(ch.channelConfig.payer) })
      .setValidity({ to });
    const transaction = await this.submitOwn("close", tx, ch, view);
    await this.o.storage.set({ ...ch, status: "closing", elapseAt: elapseAt.toString() });
    return { transaction, elapseAt };
  }

  /** After the server has settled a channel this client closed: `Main([End])`, everything left comes back. */
  async end(channelId: string): Promise<string> {
    const { ch, view } = await this.openView(channelId);
    if (view.datum.stage.kind !== "settled") throw new Error(`channel is ${view.datum.stage.kind}, not settled`);
    let tx = this.o.wallet.newTx().collectFrom({ inputs: [view.utxo], redeemer: Redeemer.main([Step.end()]) });
    tx = await this.withValidator(tx, ch.referenceScript);
    tx = tx.addSigner({ keyHash: KeyHash.fromHex(ch.channelConfig.payer) });
    // The tokens coming back go out in one output with the wallet's older ones, not as a new UTxO of their own.
    const c = view.datum.constants.currency;
    if (c.kind !== "ada") tx = withTokens(tx, await this.o.wallet.address(), c, planTokens(await this.available(), c, 0n, view.amount));
    const transaction = await this.submitOwn("end", tx, ch, view);
    await this.o.storage.set({ ...ch, status: "closed" });
    return transaction;
  }

  /**
   * After `elapse_at`, when the server has not settled: `Main([Elapse])` takes everything back
   * without it. The lower validity bound is the first slot starting at or after `elapse_at`; a
   * node refuses the transaction until the chain has reached that slot, so this waits for it.
   */
  async elapse(channelId: string): Promise<string> {
    const { ch, view, network } = await this.openView(channelId);
    const stage = view.datum.stage;
    if (stage.kind !== "closed") throw new Error(`channel is ${stage.kind}, not closed`);
    const from = slotAtOrAfter(network, stage.elapseAt);
    for (let tip = await this.o.chain.tipSlot(); tip < from; tip = await this.o.chain.tipSlot()) {
      await new Promise((r) => setTimeout(r, Math.min(60_000, Number(from - tip) * 1_000 + 5_000)));
    }
    let tx = this.o.wallet.newTx().collectFrom({ inputs: [view.utxo], redeemer: Redeemer.main([Step.elapse()]) });
    tx = await this.withValidator(tx, ch.referenceScript);
    tx = tx.addSigner({ keyHash: KeyHash.fromHex(ch.channelConfig.payer) }).setValidity({ from: msOfSlot(network, from) });
    const c = view.datum.constants.currency;
    if (c.kind !== "ada") tx = withTokens(tx, await this.o.wallet.address(), c, planTokens(await this.available(), c, 0n, view.amount));
    const transaction = await this.submitOwn("elapse", tx, ch, view);
    await this.o.storage.set({ ...ch, status: "closed" });
    return transaction;
  }

  // ---- after losing the records ----------------------------------------------------

  /**
   * Finds this wallet's channels at the validator's address and records each one it has no
   * record of, at its current position. A channel whose IOU key this wallet derives again is
   * usable: the next 402 from a server on its terms binds it (`bindRecovered`), and its count
   * comes back through the corrective 402, which adopts only a count the server proves with a
   * voucher of this key. Any other channel is exit-only: `close`, then `end` once the server has
   * settled, or `elapse` after `elapse_at`. Only the address without a stake credential is
   * searched: that is where this client opens channels.
   */
  async recover(network: string, scriptHash: string): Promise<ClientChannel[]> {
    const me = keyHash(await this.o.wallet.address());
    const known = new Set((await this.o.storage.list()).map((c) => c.channelId));
    const cpb = await this.o.chain.coinsPerUtxoByte();
    const found: ClientChannel[] = [];
    for (const seen of await this.o.chain.channels(scriptHash)) {
      const d = seen.datum.constants;
      if (d.consumer !== me || known.has(d.tag)) continue;
      known.add(d.tag);
      // The address index can trail the chain: take the channel from where it stands now.
      const v = await this.o.chain.followChannel(seen.ref, scriptHash, d.tag);
      if (!v) continue;
      const signer = this.o.iouKeys === "random" ? undefined : derivedIouSigner(await this.iouRoot(), network, d.tag);
      const usable = signer !== undefined && signer.publicKey === d.iouKey;
      const stage = v.datum.stage;
      const subbed = subbedOf(stage);
      const ch: ClientChannel = {
        channelId: d.tag,
        serverKey: "",
        channelConfig: { payer: me, payerAuthorizer: d.iouKey, receiver: "", receiverAuthorizer: d.provider, token: assetOf(d.currency), withdrawDelay: Number(d.closePeriodMs / 1000n) },
        channelRef: v.ref,
        // Everything put in so far: what the server has redeemed plus what the channel holds.
        deposit: (subbed + v.amount).toString(),
        balance: capacityOf(v, cpb).toString(),
        // The chain's lower bound; the server's own count comes back with the corrective 402.
        chargedCumulativeAmount: subbed.toString(),
        status: stage.kind === "opened" ? "open" : "closing",
        openedAt: 0,
        network,
        scriptHash,
        ...(stage.kind === "closed" ? { elapseAt: stage.elapseAt.toString() } : {}),
        ...(usable ? { iouKey: "derived" as const } : { exitOnly: true }),
        recoveredAt: Date.now(),
      };
      await this.o.storage.set(ch);
      found.push(ch);
    }
    return found;
  }

  /**
   * A recovered channel not yet bound to a server, on this server's terms, bound to it: the one
   * with most room left. The 402 supplies the one config field the chain does not hold, the
   * receiver address, so the config matches the server's record of the channel again.
   */
  private async bindRecovered(req: PaymentRequirements, extra: BatchExtra): Promise<ClientChannel | undefined> {
    const room = (c: ClientChannel) => BigInt(c.balance) - BigInt(c.chargedCumulativeAmount);
    const fits = (await this.o.storage.list()).filter((c) => c.status === "open" && this.bindable(c, req, extra));
    const best = fits.sort((a, b) => (room(b) > room(a) ? 1 : room(b) < room(a) ? -1 : 0))[0];
    return best ? this.bind(best, req, extra) : undefined;
  }

  private bindable(c: ClientChannel, req: PaymentRequirements, extra: BatchExtra): boolean {
    const k = c.channelConfig;
    return (
      c.serverKey === "" &&
      !c.exitOnly &&
      c.network === req.network &&
      c.scriptHash === extra.scriptHash &&
      k.receiverAuthorizer === extra.receiverAuthorizer &&
      k.token === req.asset &&
      k.withdrawDelay === extra.withdrawDelay
    );
  }

  private async bind(c: ClientChannel, req: PaymentRequirements, extra: BatchExtra): Promise<ClientChannel> {
    const bound: ClientChannel = {
      ...c,
      serverKey: serverKey(req, extra),
      channelConfig: { ...c.channelConfig, receiver: req.payTo },
      ...(extra.referenceScript ? { referenceScript: extra.referenceScript } : {}),
    };
    await this.o.storage.set(bound);
    return bound;
  }

  /** The wallet's IOU root, asked for once per client. */
  private iouRoot(): Promise<Uint8Array> {
    return (this.root ??= iouRootOf(this.o.wallet));
  }

  /**
   * The channel's IOU for `amount`, as hex: with the key its record holds, or, for a derived one,
   * the key derived again from the wallet, checked against the channel's own.
   */
  async signVoucher(ch: ClientChannel, amount: bigint): Promise<string> {
    if (ch.iouPrivateKeyPem) return edSign(null, iouBody(ch.channelId, amount), createPrivateKey(ch.iouPrivateKeyPem)).toString("hex");
    if (ch.iouKey !== "derived" || !ch.network) throw new Error(`no IOU key for channel ${ch.channelId.slice(0, 16)}…: it can only be closed`);
    const signer = derivedIouSigner(await this.iouRoot(), ch.network, ch.channelId);
    if (signer.publicKey !== ch.channelConfig.payerAuthorizer) throw new Error(`channel ${ch.channelId.slice(0, 16)}… names an IOU key this wallet does not derive`);
    return signer.sign(ch.channelId, amount);
  }

  /** The channel as it stands on chain, for this client's own exit. */
  async openView(channelId: string) {
    const ch = await this.o.storage.get(channelId);
    if (!ch?.channelRef || !ch.scriptHash || !ch.network) throw new Error(`no record of channel ${channelId.slice(0, 16)}… to act on`);
    const view = await this.o.chain.followChannel(ch.channelRef, ch.scriptHash, ch.channelId);
    if (!view) throw new Error(`channel ${channelId.slice(0, 16)}… is gone`);
    return { ch, view, network: ch.network };
  }

  /** Builds, signs and submits a transaction of this client's own, and waits for a block. */
  private async submitOwn(what: "close" | "end" | "elapse", tx: ReturnType<SeedWallet["newTx"]>, ch: ClientChannel, view: ChannelView): Promise<string> {
    const adaOnly = (await this.available()).filter((u) => Assets.hasOnlyLovelace(u.assets));
    const me = await this.o.wallet.address();
    const sb = await retryQueries(what, () => tx.build({ changeAddress: me, availableUtxos: adaOnly, setCollateral: collateralTarget(adaOnly) }));
    const hex = await signedHex(sb);
    await this.o.authorize?.({ kind: what, channel: ch, transaction: hex, view });
    for (const i of Transaction.fromCBORHex(hex).body.inputs) this.spent.set(`${TransactionHash.toHex(i.transactionId)}#${i.index}`, Date.now());
    const txHash = await this.o.chain.submit(hex);
    if (!(await this.o.chain.awaitTx(txHash, 300_000))) throw new Error(`${what}: ${txHash} not in a block after 5 minutes`);
    return txHash;
  }

  /**
   * Wallet UTxOs minus the ones this client's recent transactions spent. An entry goes once the
   * wallet no longer lists it (the spend is indexed) or after PENDING_MS (the spend never landed).
   */
  private async available(): Promise<UTxO.UTxO[]> {
    const all = await this.o.wallet.getWalletUtxos();
    const listed = new Set(all.map(refOf));
    for (const [r, at] of [...this.spent]) if (!listed.has(r) || Date.now() - at > PENDING_MS) this.spent.delete(r);
    return all.filter((u) => !this.spent.has(refOf(u)));
  }
}

// ---- helpers -------------------------------------------------------------

/**
 * What a wallet signs, once, for its IOU keys (CIP-8 `signData` with its payment key). Whoever
 * holds that signature can derive the IOU key of every channel the wallet opens, so a wallet must
 * sign this message for its own x402 client and nothing else.
 */
export const IOU_ROOT_MESSAGE =
  "x402 batch-settlement on Cardano, IOU keys v1. Sign this only for your own x402 client: this signature derives the keys that authorize payments from your channels.";

/**
 * The root of a wallet's IOU keys: HKDF-SHA256 over the Ed25519 signature inside the wallet's
 * COSE_Sign1 of `IOU_ROOT_MESSAGE`. Ed25519 is deterministic, so the same wallet software
 * gives the same root every time; another wallet that encodes the COSE headers differently
 * would not, and its channels would come back exit-only.
 */
export async function iouRootOf(wallet: Pick<SeedWallet, "address" | "signMessage">): Promise<Uint8Array> {
  const { signature } = await wallet.signMessage(await wallet.address(), new TextEncoder().encode(IOU_ROOT_MESSAGE));
  // The SDK's seed wallet answers the COSE_Sign1 as hex; the type says bytes.
  const s = signature as unknown as string | Uint8Array;
  const cose = typeof s === "string" ? Buffer.from(s, "hex") : Buffer.from(s);
  // A COSE_Sign1 ends with its signature, a 64-byte byte string: 0x58 0x40, then the 64 bytes.
  const n = cose.length;
  if (n < 66 || cose[n - 66] !== 0x58 || cose[n - 65] !== 0x40) throw new Error("the wallet's signature is not a COSE_Sign1 ending in an Ed25519 signature");
  return new Uint8Array(hkdfSync("sha256", cose.subarray(n - 64), "x402 batch-settlement cardano", "iou root v1", 32));
}

/** A channel's IOU signer: its seed is HKDF-SHA256 of the wallet's IOU root, the network and the channel's tag. */
export function derivedIouSigner(root: Uint8Array, network: string, tag: string) {
  return iouSignerFromSeed(new Uint8Array(hkdfSync("sha256", root, "x402 batch-settlement cardano", `iou key v1 ${network} ${tag}`, 32)));
}

/**
 * How much a deposit puts in, of the currency and before any reserve: `want`, never under
 * `floor`, and cut to `room` — what `maxDeposit` leaves — when that is given; refused when even
 * the floor does not fit.
 */
export function depositWithin(want: bigint, floor: bigint, room?: bigint): bigint {
  const amount = want > floor ? want : floor;
  if (room === undefined || amount <= room) return amount;
  if (room < floor) throw new Error(`a deposit here needs at least ${floor} units, more than maxDeposit leaves room for (${room < 0n ? 0n : room})`);
  return room;
}

/** `planTokens`' side of a transaction: its inputs, and one output at `me` of what goes back. */
function withTokens<T extends ReturnType<SeedWallet["newTx"]>>(tx: T, me: Address.Address, c: Currency, plan: { inputs: UTxO.UTxO[]; rest: bigint }): T {
  if (c.kind === "ada") return tx;
  let out = plan.inputs.length ? tx.collectFrom({ inputs: plan.inputs }) : tx;
  if (plan.rest > 0n) out = out.payToAddress({ address: me, assets: Assets.fromHexStrings(c.policy, c.name, plan.rest, 0n), autoMinUtxo: true });
  return out as T;
}

export function serverKey(req: PaymentRequirements, extra: BatchExtra): string {
  return [req.network, req.payTo, req.asset, extra.scriptHash, extra.receiverAuthorizer, extra.withdrawDelay].join("|");
}

function keyHash(a: Address.Address): string {
  if (!(a.paymentCredential instanceof KeyHash.KeyHash)) throw new Error("wallet address has no key payment credential");
  return KeyHash.toHex(a.paymentCredential);
}

/** The builder's unsigned transaction with this wallet's witnesses added, as exact bytes. */
export async function signedHex(sb: { toTransaction(): Promise<Transaction.Transaction>; partialSign(): Promise<TransactionWitnessSet.TransactionWitnessSet> }): Promise<string> {
  const unsigned = Transaction.toCBORHex(await sb.toTransaction());
  return Transaction.addVKeyWitnessesHex(unsigned, TransactionWitnessSet.toCBORHex(await sb.partialSign()));
}

/**
 * The collateral to ask the SDK for. It takes ADA-only UTxOs largest first, up to three, until
 * they reach the target, puts up exactly the target, and fails when what comes back is under
 * min-UTxO, without trying another amount. So the target is picked for the inputs it will take:
 * the largest one for which that many inputs leave at least 1 ADA to return, at most 5 ADA and at
 * least 1 ADA, which covers 150% of any fee here. One UTxO of 2 ADA does it, and so do three of
 * 0.7 ADA; the old rule wanted a single UTxO of 2.2 ADA.
 */
export function collateralTarget(adaOnly: UTxO.UTxO[]): bigint {
  const RETURN = 1_000_000n; // above an ADA-only output's min-UTxO at these addresses (0.969750)
  const CAP = 5_000_000n;
  const FLOOR = 1_000_000n;
  const top = adaOnly.map((u) => Assets.lovelaceOf(u.assets)).sort((x, y) => (y > x ? 1 : y < x ? -1 : 0)).slice(0, 3);
  let best = 0n;
  let taken = 0n;
  for (const [k, amount] of top.entries()) {
    const before = taken; // the SDK takes k + 1 inputs exactly when the target is above this
    taken += amount;
    const target = taken - RETURN < CAP ? taken - RETURN : CAP;
    if ((k === 0 || target > before) && target > best) best = target;
  }
  if (best < FLOOR) throw new Error(`no ADA-only UTxOs large enough for collateral (largest three ${top.join(", ")})`);
  return best;
}

/** Min-UTxO of an ADA-only output at `address`. */
export function minAdaOutput(address: Address.Address, coinsPerUtxoByte: bigint): bigint {
  const out = new TxOut.TransactionOutput({ address, assets: Assets.fromLovelace(2n ** 63n) });
  return coinsPerUtxoByte * (160n + BigInt(TxOut.toCBORBytes(out).length));
}
