// What the facilitator and the server's channel manager read from and write to the chain,
// behind one interface so the checks can run on fixtures. The Blockfrost implementation reads
// UTxOs through the SDK (it resolves datums and reference scripts) and submits the exact bytes
// it was given, never a re-encoding, so the signatures on them stay valid.
import { Address, Client, ScriptHash, Transaction, TransactionHash, TransactionInput, preprod, type UTxO } from "@evolution-sdk/evolution";
import { networkIdOf, readChannel, refOf, type ChannelView } from "./cardano.ts";
import type { CardanoNetwork } from "./types.ts";

/** A transaction at the validator's address, and where it sits in the chain. */
export interface ChainCursor {
  hash: string;
  height: number;
  index: number;
}

export interface Chain {
  readonly network: CardanoNetwork;
  /** The output at `ref` if it exists and is unspent. */
  getUnspent(ref: string): Promise<UTxO.UTxO | undefined>;
  /** The transaction that spent `ref`: its id, null while unspent, undefined if `ref` is unknown. */
  spentBy(ref: string): Promise<string | null | undefined>;
  /**
   * The channel with this tag as it stands now: starts from `ref` (any earlier position of
   * the channel) and follows each transaction that spent it to the continuing output. Returns
   * undefined when the channel has been closed out (mutual, end, elapse).
   */
  followChannel(ref: string, scriptHash: string, tag: string): Promise<ChannelView | undefined>;
  coinsPerUtxoByte(): Promise<bigint>;
  /** Submits the transaction's exact bytes; returns its id. */
  submit(cborHex: string): Promise<string>;
  awaitTx(txHash: string, timeoutMs: number): Promise<boolean>;
  /** Runs every script through the evaluator; throws when one fails. */
  evaluate(cborHex: string, additionalUtxos?: UTxO.UTxO[]): Promise<void>;
  /** Every channel of this script at its address without a stake credential, as listed now. */
  channels(scriptHash: string): Promise<ChannelView[]>;
  /** The slot of the latest block. */
  tipSlot(): Promise<bigint>;
  /** The height of the latest block. */
  tipHeight(): Promise<number>;
  /** The height of the block holding a transaction; undefined while (or once) the index does not know it. */
  txHeight(txHash: string): Promise<number | undefined>;
  /**
   * For a channel `followChannel` finds gone: the transaction that spent its last position without
   * continuing it, and that transaction's height. Undefined when the channel is not gone after all,
   * or the index cannot say yet.
   */
  exitOf(ref: string, scriptHash: string, tag: string): Promise<{ txHash: string; height: number } | undefined>;
  /** What a transaction's outputs at `address` hold, by unit (`lovelace`, or policy and name run together). */
  paidTo(txHash: string, address: string): Promise<Map<string, bigint>>;
  /** The latest transaction at this script's address (without a stake credential): where following starts. */
  scriptTip(scriptHash: string): Promise<ChainCursor | undefined>;
  /** The transactions at that address after `after`, oldest first. */
  scriptActivity(scriptHash: string, after?: ChainCursor): Promise<ChainCursor[]>;
  /**
   * What a transaction spent, and, when `wanted` holds for one of those inputs, the channels it
   * left at the script: one query for any transaction, a second only for those that matter.
   */
  channelMoves(txHash: string, scriptHash: string, wanted: (ref: string) => boolean): Promise<{ spent: string[]; channels?: ChannelView[] }>;
}

interface BfOutput {
  address: string;
  output_index: number;
  consumed_by_tx?: string | null;
  amount?: Array<{ unit: string; quantity: string }>;
  collateral?: boolean;
}

/** How many times a read from Blockfrost is tried before its failure is the caller's. */
const READ_ATTEMPTS = 5;

export class BlockfrostChain implements Chain {
  private readonly provider;
  private params?: { at: number; coinsPerUtxoByte: bigint };

  constructor(
    readonly network: CardanoNetwork,
    private readonly baseUrl: string,
    private readonly projectId: string,
    /** The pause before a read's second try; each later one waits that much longer again. */
    private readonly retryMs = 3_000,
  ) {
    if (network !== "cardano:preprod") throw new Error("the spike's Blockfrost chain is preprod only");
    this.provider = Client.make(preprod).withBlockfrost({ baseUrl, projectId });
  }

  /**
   * A read from Blockfrost, tried again when it fails on the network or with a 429 or a 5xx.
   * Connections can fail for minutes at a time (Node gives each of a host's addresses 250 ms to
   * connect), and the read that follows a claim already on chain must not fail on that alone.
   * Any other answer, a 404 among them, is the caller's to read.
   */
  private async get(path: string): Promise<Response> {
    for (let attempt = 1; ; attempt++) {
      try {
        const r = await fetch(`${this.baseUrl}${path}`, { headers: { project_id: this.projectId } });
        if ((r.status !== 429 && r.status < 500) || attempt >= READ_ATTEMPTS) return r;
        await r.body?.cancel();
      } catch (e) {
        if (!isNetworkError(e) || attempt >= READ_ATTEMPTS) throw e;
      }
      await new Promise((res) => setTimeout(res, this.retryMs * attempt));
    }
  }

  async getUnspent(ref: string): Promise<UTxO.UTxO | undefined> {
    const [hash, index] = splitRef(ref);
    const outs = await this.txOutputs(hash);
    const o = outs?.find((x) => x.output_index === index);
    if (!o || o.consumed_by_tx) return undefined;
    const [u] = await retryQueries("an output", () => this.provider.getUtxosByOutRef([input(hash, index)]));
    return u;
  }

  async spentBy(ref: string): Promise<string | null | undefined> {
    const [hash, index] = splitRef(ref);
    const o = (await this.txOutputs(hash))?.find((x) => x.output_index === index);
    return o === undefined ? undefined : (o.consumed_by_tx ?? null);
  }

  async followChannel(ref: string, scriptHash: string, tag: string): Promise<ChannelView | undefined> {
    let [hash, index] = splitRef(ref);
    for (let hops = 0; hops < 1000; hops++) {
      const outs = await this.txOutputs(hash);
      const o = outs?.find((x) => x.output_index === index);
      if (!o) return undefined;
      if (!o.consumed_by_tx) {
        const [u] = await retryQueries("the channel", () => this.provider.getUtxosByOutRef([input(hash, index)]));
        if (!u) return undefined;
        const ch = readChannel(u, scriptHash);
        return "error" in ch || ch.datum.constants.tag !== tag ? undefined : ch;
      }
      // Find the continuing output of the same channel in the transaction that spent it.
      const next = o.consumed_by_tx;
      const nextOuts = (await this.txOutputs(next)) ?? [];
      const candidates = await retryQueries("the channel", () => this.provider.getUtxosByOutRef(nextOuts.map((x) => input(next, x.output_index))));
      const cont = candidates.find((u) => {
        const ch = readChannel(u, scriptHash);
        return !("error" in ch) && ch.datum.constants.tag === tag;
      });
      if (!cont) return undefined;
      [hash, index] = splitRef(refOf(cont));
    }
    throw new Error(`channel ${tag.slice(0, 16)}… moved more than 1000 times from ${ref}`);
  }

  async coinsPerUtxoByte(): Promise<bigint> {
    if (!this.params || Date.now() - this.params.at > 600_000) {
      const p = await retryQueries("protocol parameters", () => this.provider.getProtocolParameters());
      this.params = { at: Date.now(), coinsPerUtxoByte: p.coinsPerUtxoByte };
    }
    return this.params.coinsPerUtxoByte;
  }

  async submit(cborHex: string): Promise<string> {
    const r = await fetch(`${this.baseUrl}/tx/submit`, {
      method: "POST",
      headers: { project_id: this.projectId, "Content-Type": "application/cbor" },
      body: Buffer.from(cborHex, "hex"),
    });
    const text = await r.text();
    if (!r.ok) throw new SubmitError(r.status, text);
    return JSON.parse(text) as string;
  }

  /**
   * True once Blockfrost knows the transaction in a block. 404 means not yet; any other answer
   * or a network error is transient. The SDK's own awaitTx throws when its timeout runs out,
   * which a caller cannot tell from a failed query, so this polls itself and returns false.
   */
  async awaitTx(txHash: string, timeoutMs: number): Promise<boolean> {
    const until = Date.now() + timeoutMs;
    for (;;) {
      try {
        const r = await fetch(`${this.baseUrl}/txs/${txHash}`, { headers: { project_id: this.projectId } });
        if (r.ok) return true;
      } catch {
        // transient: keep polling until the deadline
      }
      if (Date.now() + 5_000 > until) return false;
      await new Promise((res) => setTimeout(res, 5_000));
    }
  }

  async evaluate(cborHex: string, additionalUtxos?: UTxO.UTxO[]): Promise<void> {
    await retryQueries("an evaluation", () => this.provider.evaluateTx(Transaction.fromCBORHex(cborHex), additionalUtxos));
  }

  async channels(scriptHash: string): Promise<ChannelView[]> {
    const address = new Address.Address({ networkId: networkIdOf(this.network), paymentCredential: ScriptHash.fromHex(scriptHash) });
    const utxos = await retryQueries("channels", () => this.provider.getUtxos(address));
    return utxos.flatMap((u) => {
      const ch = readChannel(u, scriptHash);
      return "error" in ch ? [] : [ch];
    });
  }

  async tipHeight(): Promise<number> {
    const r = await this.get("/blocks/latest");
    if (!r.ok) throw new Error(`Blockfrost /blocks/latest: ${r.status}`);
    return ((await r.json()) as { height: number }).height;
  }

  async txHeight(txHash: string): Promise<number | undefined> {
    const r = await this.get(`/txs/${txHash}`);
    if (r.status === 404) return undefined;
    if (!r.ok) throw new Error(`Blockfrost /txs/${txHash.slice(0, 16)}…: ${r.status}`);
    return ((await r.json()) as { block_height: number }).block_height;
  }

  async exitOf(ref: string, scriptHash: string, tag: string): Promise<{ txHash: string; height: number } | undefined> {
    let [hash, index] = splitRef(ref);
    for (let hops = 0; hops < 1000; hops++) {
      const o = (await this.txOutputs(hash))?.find((x) => x.output_index === index);
      if (!o?.consumed_by_tx) return undefined;
      const next = o.consumed_by_tx;
      const at = ((await this.txOutputs(next)) ?? []).filter((x) => !x.collateral && isScriptAddress(x.address, scriptHash));
      const candidates = at.length ? await retryQueries("the channel", () => this.provider.getUtxosByOutRef(at.map((x) => input(next, x.output_index)))) : [];
      const cont = candidates.find((u) => {
        const ch = readChannel(u, scriptHash);
        return !("error" in ch) && ch.datum.constants.tag === tag;
      });
      if (!cont) {
        const height = await this.txHeight(next);
        return height === undefined ? undefined : { txHash: next, height };
      }
      [hash, index] = splitRef(refOf(cont));
    }
    throw new Error(`channel ${tag.slice(0, 16)}… moved more than 1000 times from ${ref}`);
  }

  async tipSlot(): Promise<bigint> {
    const r = await this.get("/blocks/latest");
    if (!r.ok) throw new Error(`Blockfrost /blocks/latest: ${r.status}`);
    return BigInt(((await r.json()) as { slot: number }).slot);
  }

  async scriptTip(scriptHash: string): Promise<ChainCursor | undefined> {
    const rows = await this.addressTxs(scriptHash, "order=desc&count=1&page=1");
    return rows[0];
  }

  async scriptActivity(scriptHash: string, after?: ChainCursor): Promise<ChainCursor[]> {
    const out: ChainCursor[] = [];
    // `from` is inclusive and takes block:index; the index after the last one seen moves past it.
    const from = after ? `&from=${after.height}:${after.index + 1}` : "";
    for (let page = 1; ; page++) {
      const rows = await this.addressTxs(scriptHash, `order=asc&count=100&page=${page}${from}`);
      out.push(...rows.filter((r) => !after || r.hash !== after.hash));
      if (rows.length < 100) return out;
    }
  }

  async channelMoves(txHash: string, scriptHash: string, wanted: (ref: string) => boolean): Promise<{ spent: string[]; channels?: ChannelView[] }> {
    const r = await this.get(`/txs/${txHash}/utxos`);
    if (!r.ok) throw new Error(`Blockfrost /txs/${txHash.slice(0, 16)}…/utxos: ${r.status}`);
    const io = (await r.json()) as { inputs: Array<{ tx_hash: string; output_index: number; collateral?: boolean; reference?: boolean }>; outputs: BfOutput[] };
    const spent = io.inputs.filter((i) => !i.collateral && !i.reference).map((i) => `${i.tx_hash}#${i.output_index}`);
    if (!spent.some(wanted)) return { spent };
    const at = io.outputs.filter((o) => !o.collateral && isScriptAddress(o.address, scriptHash));
    const utxos = at.length ? await retryQueries("channel outputs", () => this.provider.getUtxosByOutRef(at.map((o) => input(txHash, o.output_index)))) : [];
    return {
      spent,
      channels: utxos.flatMap((u) => {
        const ch = readChannel(u, scriptHash);
        return "error" in ch ? [] : [ch];
      }),
    };
  }

  private async addressTxs(scriptHash: string, query: string): Promise<ChainCursor[]> {
    const address = Address.toBech32(new Address.Address({ networkId: networkIdOf(this.network), paymentCredential: ScriptHash.fromHex(scriptHash) }));
    const r = await this.get(`/addresses/${address}/transactions?${query}`);
    if (r.status === 404) return [];
    if (!r.ok) throw new Error(`Blockfrost /addresses/…/transactions: ${r.status}`);
    return ((await r.json()) as Array<{ tx_hash: string; block_height: number; tx_index: number }>).map((x) => ({ hash: x.tx_hash, height: x.block_height, index: x.tx_index }));
  }

  async paidTo(txHash: string, address: string): Promise<Map<string, bigint>> {
    const outs = await this.txOutputs(txHash);
    if (!outs) throw new Error(`transaction ${txHash.slice(0, 16)}… is not known`);
    const paid = new Map<string, bigint>();
    for (const o of outs) {
      if (o.address !== address || o.collateral) continue;
      for (const a of o.amount ?? []) paid.set(a.unit, (paid.get(a.unit) ?? 0n) + BigInt(a.quantity));
    }
    return paid;
  }

  /** A transaction's outputs with their spent-by field, or undefined if Blockfrost does not know it. */
  private async txOutputs(hash: string): Promise<BfOutput[] | undefined> {
    for (let attempt = 0; ; attempt++) {
      const r = await this.get(`/txs/${hash}/utxos`);
      if (r.ok) return ((await r.json()) as { outputs: BfOutput[] }).outputs;
      if (r.status !== 404) throw new Error(`Blockfrost /txs/${hash.slice(0, 16)}…/utxos: ${r.status}`);
      if (attempt >= 3) return undefined;
      await new Promise((res) => setTimeout(res, 2_000)); // indexer lag right after confirmation
    }
  }
}

export class SubmitError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`submit refused (${status}): ${body.slice(0, 400)}`);
  }
}

/**
 * Runs an SDK call again when Blockfrost fails a query (a burst limit or a 5xx; preprod runs
 * showed both) or when the request never got an answer, up to `attempts` times. A script failure
 * or anything else is thrown at once: retrying those would hide a real refusal.
 */
export async function retryQueries<T>(what: string, fn: () => Promise<T>, attempts = 4, pauseMs = 5_000): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (e) {
      const text = String((e as Error)?.message ?? e);
      const query = /Blockfrost (getProtocolParameters|getUtxos|getUtxosByOutRef|getDelegation|getDatum)[A-Za-z]* failed|Failed to fetch protocol parameters/.test(text) || isNetworkError(e);
      if (!query || /ScriptFailures|Script evaluation failed/.test(text) || i >= attempts) throw e;
      await new Promise((res) => setTimeout(res, pauseMs * i));
    }
  }
}

/** Where Effect's FiberFailure, which the SDK's calls reject with, keeps the cause they failed with. */
const FIBER_FAILURE_CAUSE = Symbol.for("effect/Runtime/FiberFailure/Cause");

/**
 * Whether a failure never got an answer from the other end: a connection refused, reset or timed
 * out, or a name that did not resolve. The network error sits a few levels down. Fetch throws
 * `TypeError: fetch failed` with it as the `cause`. The SDK rejects with a FiberFailure, whose
 * cause holds a `ProviderError`, whose `cause` is an `HttpRequestError`.
 */
export function isNetworkError(e: unknown): boolean {
  let x = e;
  for (let depth = 0; x && typeof x === "object" && depth < 8; depth++) {
    const { _tag, code, message } = x as { _tag?: unknown; code?: unknown; message?: unknown };
    if (_tag === "HttpRequestError") return true;
    if (typeof code === "string" && /^(ECONNRESET|ECONNREFUSED|ECONNABORTED|ETIMEDOUT|EPIPE|ENETUNREACH|EHOSTUNREACH|ENOTFOUND|EAI_AGAIN|UND_ERR_[A-Z_]+)$/.test(code)) return true;
    if (typeof message === "string" && /^fetch failed$|socket hang up|other side closed/.test(message)) return true;
    const fiber = (x as Record<symbol, unknown>)[FIBER_FAILURE_CAUSE] as { _tag?: unknown; error?: unknown } | undefined;
    x = fiber?._tag === "Fail" ? fiber.error : (x as { cause?: unknown }).cause;
  }
  return false;
}

/** Whether a bech32 address pays to this script, with any stake part. */
function isScriptAddress(bech32: string, scriptHash: string): boolean {
  try {
    const cred = Address.fromBech32(bech32).paymentCredential;
    return cred instanceof ScriptHash.ScriptHash && ScriptHash.toHex(cred) === scriptHash;
  } catch {
    return false;
  }
}

export function splitRef(ref: string): [string, number] {
  const m = /^([0-9a-f]{64})#(\d+)$/.exec(ref);
  if (!m) throw new Error(`not an out-ref: ${ref}`);
  return [m[1]!, Number(m[2])];
}

const input = (hash: string, index: number) => new TransactionInput.TransactionInput({ transactionId: TransactionHash.fromHex(hash), index: BigInt(index) });
