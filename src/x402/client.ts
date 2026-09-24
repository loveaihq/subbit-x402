// The client side of the Cardano binding (DESIGN.md §5–§6): opens a Subbit channel with the first
// paid request, signs a cumulative IOU for each one after it, keeps its count in step with the
// server's responses (and the corrective 402), and closes the channel cooperatively with a
// `Mutual` refund. It builds and signs every transaction itself and pays their fees.
import { createPrivateKey, sign as edSign } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
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
import { Address, Assets, Client, KeyHash, ScriptHash, Transaction, TransactionHash, TransactionInput, TransactionWitnessSet, TxOut, preprod, type UTxO } from "@evolution-sdk/evolution";
import { Redeemer, channelAddress, iouBody, inlineDatum, newIouSigner, subbitScript, tagFromInput } from "../subbit.ts";
import { amountIn, channelReserve, constantsOf, currencyOf, networkIdOf, refOf, txHashOf, valueFor, verifyVoucherSignature } from "./cardano.ts";
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
  iouPrivateKeyPem: string;
  channelRef?: string;
  /** Currency amount locked, and the capacity IOUs may reach. */
  deposit: string;
  balance: string;
  chargedCumulativeAmount: string;
  /** `failed`: the opening transaction never reached the chain. */
  status: "pending" | "open" | "closed" | "failed";
  openTx?: string;
  /** Position of the channel output in the opening transaction, and the inputs it spends. */
  openIndex?: number;
  openInputs?: string[];
  openedAt: number;
}

/** `{dir}/{channelId}.json`. The throwaway IOU keys live here, so the directory stays out of git. */
export class FileClientStorage {
  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }
  async get(id: string): Promise<ClientChannel | undefined> {
    const f = join(this.dir, `${id}.json`);
    return existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as ClientChannel) : undefined;
  }
  async set(c: ClientChannel): Promise<void> {
    writeFileSync(join(this.dir, `${c.channelId}.json`), JSON.stringify(c, null, 2));
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

export interface ClientOptions {
  wallet: SeedWallet;
  storage: FileClientStorage;
  /** Read-only chain access, for the refund. */
  chain: Chain;
  /** Capacity to open a channel with; the server's `minDeposit` and 10 × price are the floor. */
  capacity?: bigint;
  /** Refuse to lock more than this in one channel. */
  maxDeposit?: bigint;
  /** Shared by every client instance on one wallet: inputs their transactions just spent, and when. */
  spentInputs?: Map<string, number>;
}

/** How long spent inputs are held back from coin selection. */
const PENDING_MS = 5 * 60_000;

export class BatchSettlementCardanoClient implements SchemeNetworkClient {
  readonly scheme = SCHEME;
  readonly schemeHooks: SchemeClientHooks;
  /** Inputs spent recently, kept out of coin selection until the wallet's view drops them. */
  private readonly spent: Map<string, number>;

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
    let ch = await this.o.storage.current(serverKey(req, extra));
    if (ch?.status === "pending") ch = await this.settlePending(ch, extra);
    if (ch?.status === "open" && BigInt(ch.chargedCumulativeAmount) + amount <= BigInt(ch.balance)) {
      const ceiling = BigInt(ch.chargedCumulativeAmount) + amount;
      return {
        x402Version,
        payload: {
          type: "voucher",
          channelConfig: ch.channelConfig,
          voucher: { channelId: ch.channelId, maxClaimableAmount: ceiling.toString(), signature: signIou(ch, ceiling), ...(ch.channelRef ? { channelRef: ch.channelRef } : {}) },
        },
      };
    }
    return { x402Version, payload: await this.openChannel(req, extra, amount) };
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
    const signer = newIouSigner();
    const config: ChannelConfig = {
      payer,
      payerAuthorizer: signer.publicKey,
      receiver: req.payTo,
      receiverAuthorizer: extra.receiverAuthorizer,
      token: req.asset,
      withdrawDelay: extra.withdrawDelay,
    };
    const available = await this.available();
    // The tag can come from any input the opening spends. A token channel seeds from a UTxO that
    // holds the token, which is spent anyway; an ADA channel from the largest ADA-only UTxO. That
    // keeps openings from using up the ADA-only UTxOs that collateral comes from.
    const cur = currencyOf(req.asset);
    const size = (u: UTxO.UTxO) => (cur.kind === "ada" ? (Assets.hasOnlyLovelace(u.assets) ? Assets.lovelaceOf(u.assets) : -1n) : amountIn(u.assets, cur));
    const seed = available.filter((u) => size(u) > 0n).sort((a, b) => (size(b) > size(a) ? 1 : size(b) < size(a) ? -1 : 0))[0];
    if (!seed) throw new Error(`no UTxO to open a ${req.asset} channel from`);
    // The tag must be unique per IOU key; Subbit's ADR: hash an input this transaction spends.
    const tag = tagFromInput(new TransactionInput.TransactionInput({ transactionId: seed.transactionId, index: seed.index }));
    const constants = constantsOf(config, tag);
    const address = channelAddress(networkIdOf(req.network));
    if (ScriptHash.toHex(address.paymentCredential as ScriptHash.ScriptHash) !== extra.scriptHash) throw new Error("server asks for a validator this client does not have");
    const cpb = (await w.getProtocolParameters()).coinsPerUtxoByte;
    const floor = [this.o.capacity ?? 0n, extra.minDeposit ? BigInt(extra.minDeposit) : 0n, 10n * amount].reduce((a, b) => (a > b ? a : b));
    const reserve = channelReserve(address, constants, cpb);
    // An ADA channel holds its capacity plus the reserve; a token channel holds its capacity in
    // tokens and exactly the reserve in ADA, since the validator does not count that ADA.
    const isAda = constants.currency.kind === "ada";
    const deposit = isAda ? floor + reserve : floor;
    if (this.o.maxDeposit !== undefined && deposit > this.o.maxDeposit) throw new Error(`a channel needs ${deposit} units, above maxDeposit ${this.o.maxDeposit}`);

    const sb = await retryQueries("open", () =>
      w
        .newTx()
        .collectFrom({ inputs: [seed] })
        .payToAddress({ address, assets: valueFor(constants.currency, deposit, reserve), datum: inlineDatum(constants, { kind: "opened", subbed: 0n }) })
        .build({ changeAddress: me, availableUtxos: available }),
    );
    const signed = await signedHex(sb);
    const built = Transaction.fromCBORHex(signed);
    const openInputs = built.body.inputs.map((i) => `${TransactionHash.toHex(i.transactionId)}#${i.index}`);
    for (const r of openInputs) this.spent.set(r, Date.now());
    const openIndex = built.body.outputs.findIndex((o) => o.address.paymentCredential instanceof ScriptHash.ScriptHash && ScriptHash.toHex(o.address.paymentCredential) === extra.scriptHash);

    const ch: ClientChannel = {
      channelId: tag,
      serverKey: serverKey(req, extra),
      channelConfig: config,
      iouPrivateKeyPem: signer.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      deposit: deposit.toString(),
      balance: floor.toString(),
      chargedCumulativeAmount: "0",
      status: "pending",
      openTx: txHashOf(signed),
      openIndex,
      openInputs,
      openedAt: Date.now(),
    };
    await this.o.storage.set(ch);
    return {
      type: "deposit",
      channelConfig: config,
      voucher: { channelId: tag, maxClaimableAmount: amount.toString(), signature: signIou(ch, amount) },
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
    await this.o.storage.set({
      ...ch,
      chargedCumulativeAmount: next.toString(),
      ...(p.type === "deposit" ? { status: "open" as const } : {}),
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
    const pr = decodePaymentRequiredHeader(probe.headers.get("PAYMENT-REQUIRED") ?? "");
    const req = pr.accepts.find((a) => a.scheme === SCHEME);
    if (!req) throw new Error(`no ${SCHEME} option at ${url}`);
    const extra = parseExtra(req);
    const ch = channelId ? await this.o.storage.get(channelId) : await this.o.storage.current(serverKey(req, extra));
    if (!ch || ch.status !== "open" || !ch.channelRef) throw new Error("no open channel with this server");
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

    const payload: RefundPayload = {
      type: "refund",
      channelConfig: ch.channelConfig,
      voucher: { channelId: ch.channelId, maxClaimableAmount: charged.toString(), signature: signIou(ch, charged), channelRef: view.ref },
      transaction: toBase64(signed),
    };
    const paymentPayload: PaymentPayload = { x402Version: 2, accepted: req, payload: payload as unknown as Record<string, unknown>, ...(pr.resource ? { resource: pr.resource } : {}) };
    const res = await fetchImpl(url, { headers: { "PAYMENT-SIGNATURE": encodePaymentSignatureHeader(paymentPayload) } });
    const header = res.headers.get("PAYMENT-RESPONSE");
    if (res.status !== 200 || !header) {
      const detail = res.headers.get("PAYMENT-REQUIRED") ? decodePaymentRequiredHeader(res.headers.get("PAYMENT-REQUIRED")!).error : header ? decodePaymentResponseHeader(header).errorReason : await res.text();
      throw new Error(`refund failed (${res.status}): ${detail}`);
    }
    const settle = decodePaymentResponseHeader(header);
    if (settle.success) await this.o.storage.set({ ...ch, status: "closed" });
    return settle;
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

export function serverKey(req: PaymentRequirements, extra: BatchExtra): string {
  return [req.network, req.payTo, req.asset, extra.scriptHash, extra.receiverAuthorizer, extra.withdrawDelay].join("|");
}

function signIou(ch: ClientChannel, amount: bigint): string {
  return edSign(null, iouBody(ch.channelId, amount), createPrivateKey(ch.iouPrivateKeyPem)).toString("hex");
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
 * The SDK takes the largest ADA-only UTxO as collateral against a fixed 5 ADA target and fails
 * when what comes back is under min-UTxO, without trying another input or amount. Aim the
 * target so the return clears min-UTxO: 5 ADA when the UTxO allows it, else what it holds
 * less 1.2 ADA. Any of these still covers 150% of a fee this size many times over.
 */
export function collateralTarget(adaOnly: UTxO.UTxO[]): bigint {
  const largest = adaOnly.reduce((m, u) => (Assets.lovelaceOf(u.assets) > m ? Assets.lovelaceOf(u.assets) : m), 0n);
  const target = largest >= 6_200_000n ? 5_000_000n : largest - 1_200_000n;
  if (target < 1_000_000n) throw new Error(`no ADA-only UTxO large enough for collateral (largest ${largest})`);
  return target;
}

/** Min-UTxO of an ADA-only output at `address`. */
export function minAdaOutput(address: Address.Address, coinsPerUtxoByte: bigint): bigint {
  const out = new TxOut.TransactionOutput({ address, assets: Assets.fromLovelace(2n ** 63n) });
  return coinsPerUtxoByte * (160n + BigInt(TxOut.toCBORBytes(out).length));
}
