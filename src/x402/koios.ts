// The chain through Koios, for a wallet or a server with no Blockfrost key. Koios answers what the
// channel code asks much as Blockfrost does, with one gap: it says that an output was spent, not
// which transaction spent it. So the spender is found among the transactions at the output's
// address from its block on, by their inputs. UTxOs are still read through the SDK, which resolves
// their datums and reference scripts; evaluation goes through Koios' Ogmios endpoint the same way.
// Koios also shows what is only in its mempool: an output spent there, a transaction not yet in a
// block. The channel code works from the chain as it stands, as Blockfrost gives it, so only what is
// in a block counts here.
import { Address, Client, ScriptHash, Transaction, preprod, type UTxO } from "@evolution-sdk/evolution";
import { networkIdOf, readChannel, refOf, type ChannelView } from "./cardano.ts";
import { SubmitError, input, isNetworkError, isScriptAddress, retryQueries, splitRef, type Chain, type ChainCursor } from "./chain.ts";
import type { CardanoNetwork } from "./types.ts";

/** How many times a request to Koios is tried before its failure is the caller's. */
const ATTEMPTS = 5;
/** Transactions asked about in one tx_info request. */
const TX_BATCH = 50;
/** Rows in one page: Koios serves at most 1000. */
const PAGE = 1000;

/** An output as utxo_info gives it. */
interface UtxoRow {
  tx_hash: string;
  tx_index: number;
  address: string;
  block_height: number | null;
  is_spent: boolean;
}

/** A transaction as tx_info gives it: collateral and reference inputs, and the collateral output, are kept apart. */
interface TxRow {
  tx_hash: string;
  block_height: number | null;
  tx_block_index: number;
  inputs?: Array<{ tx_hash: string; tx_index: number }>;
  outputs: Array<{
    tx_index: number;
    payment_addr: { bech32: string };
    value: string;
    asset_list?: Array<{ policy_id: string; asset_name: string | null; quantity: string }> | null;
  }>;
}

export class KoiosChain implements Chain {
  private readonly provider;
  private params?: { at: number; coinsPerUtxoByte: bigint };

  constructor(
    readonly network: CardanoNetwork,
    private readonly baseUrl: string,
    /** A Koios bearer token, for a tier above the public one. */
    private readonly token?: string,
    /** The pause before a request's second try; each later one waits that much longer again. */
    private readonly retryMs = 3_000,
  ) {
    if (network !== "cardano:preprod") throw new Error("the spike's Koios chain is preprod only");
    this.provider = Client.make(preprod).withKoios({ baseUrl, ...(token ? { token } : {}) });
  }

  async getUnspent(ref: string): Promise<UTxO.UTxO | undefined> {
    const row = await this.utxo(ref);
    if (!row || (row.is_spent && (await this.spender(row)) !== null)) return undefined;
    const [hash, index] = splitRef(ref);
    const [u] = await retryQueries("an output", () => this.provider.getUtxosByOutRef([input(hash, index)]));
    return u;
  }

  async spentBy(ref: string): Promise<string | null | undefined> {
    const row = await this.utxo(ref);
    if (!row) return undefined;
    return row.is_spent ? this.spender(row) : null;
  }

  async followChannel(ref: string, scriptHash: string, tag: string): Promise<ChannelView | undefined> {
    let at = ref;
    for (let hops = 0; hops < 1000; hops++) {
      const row = await this.utxo(at);
      if (!row) return undefined;
      const next = row.is_spent ? await this.spender(row) : null;
      if (next === null) {
        const [hash, index] = splitRef(at);
        const [u] = await retryQueries("the channel", () => this.provider.getUtxosByOutRef([input(hash, index)]));
        if (!u) return undefined;
        const ch = readChannel(u, scriptHash);
        return "error" in ch || ch.datum.constants.tag !== tag ? undefined : ch;
      }
      const cont = await this.continuation(next, scriptHash, tag);
      if (!cont) return undefined;
      at = refOf(cont);
    }
    throw new Error(`channel ${tag.slice(0, 16)}… moved more than 1000 times from ${ref}`);
  }

  async exitOf(ref: string, scriptHash: string, tag: string): Promise<{ txHash: string; height: number } | undefined> {
    let at = ref;
    for (let hops = 0; hops < 1000; hops++) {
      const row = await this.utxo(at);
      const next = row?.is_spent ? await this.spender(row) : null;
      if (!next) return undefined;
      const cont = await this.continuation(next, scriptHash, tag);
      if (!cont) {
        const height = await this.txHeight(next);
        return height === undefined ? undefined : { txHash: next, height };
      }
      at = refOf(cont);
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
    const r = await fetch(`${this.baseUrl}/submittx`, {
      method: "POST",
      headers: { ...this.auth(), "Content-Type": "application/cbor" },
      body: Buffer.from(cborHex, "hex"),
    });
    const text = await r.text();
    if (!r.ok) throw new SubmitError(r.status, text);
    try {
      return JSON.parse(text) as string;
    } catch {
      return text.trim();
    }
  }

  /**
   * True once Koios has the transaction in a block, read from tx_info: the same index its UTxOs come
   * from, which has trailed the chain by over two minutes on preprod. Like Blockfrost's, a failed
   * poll is transient.
   */
  async awaitTx(txHash: string, timeoutMs: number): Promise<boolean> {
    const until = Date.now() + timeoutMs;
    for (;;) {
      try {
        if ((await this.txHeight(txHash)) !== undefined) return true;
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
    const utxos = await retryQueries("channels", () => this.provider.getUtxos(this.scriptAddress(scriptHash)));
    return utxos.flatMap((u) => {
      const ch = readChannel(u, scriptHash);
      return "error" in ch ? [] : [ch];
    });
  }

  async tipSlot(): Promise<bigint> {
    return BigInt((await this.tip()).abs_slot);
  }

  async tipHeight(): Promise<number> {
    return (await this.tip()).block_height;
  }

  async txHeight(txHash: string): Promise<number | undefined> {
    const [tx] = await this.txs([txHash]);
    return tx?.block_height ?? undefined;
  }

  async paidTo(txHash: string, address: string): Promise<Map<string, bigint>> {
    const [tx] = await this.txs([txHash]);
    if (!tx) throw new Error(`transaction ${txHash.slice(0, 16)}… is not known`);
    const paid = new Map<string, bigint>();
    const add = (unit: string, n: bigint) => paid.set(unit, (paid.get(unit) ?? 0n) + n);
    for (const o of tx.outputs) {
      if (o.payment_addr.bech32 !== address) continue;
      add("lovelace", BigInt(o.value));
      for (const a of o.asset_list ?? []) add(a.policy_id + (a.asset_name ?? ""), BigInt(a.quantity));
    }
    return paid;
  }

  async scriptTip(scriptHash: string): Promise<ChainCursor | undefined> {
    // Koios lists newest first but orders nothing within a block: the block's own index does.
    const rows = await this.addressTxs(Address.toBech32(this.scriptAddress(scriptHash)), undefined, 50);
    if (!rows.length) return undefined;
    const top = Math.max(...rows.map((r) => r.block_height));
    return (await this.cursors(rows.filter((r) => r.block_height === top).map((r) => r.tx_hash))).at(-1);
  }

  async scriptActivity(scriptHash: string, after?: ChainCursor): Promise<ChainCursor[]> {
    // From the cursor's block on, which Koios includes, less what the cursor has already seen in it.
    const rows = await this.addressTxs(Address.toBech32(this.scriptAddress(scriptHash)), after?.height);
    const all = await this.cursors([...new Set(rows.map((r) => r.tx_hash))]);
    return after ? all.filter((c) => c.height > after.height || (c.height === after.height && c.index > after.index)) : all;
  }

  async channelMoves(txHash: string, scriptHash: string, wanted: (ref: string) => boolean): Promise<{ spent: string[]; channels?: ChannelView[] }> {
    const [tx] = await this.txs([txHash], true);
    if (!tx) throw new Error(`Koios does not know ${txHash.slice(0, 16)}… yet`);
    const spent = (tx.inputs ?? []).map((i) => `${i.tx_hash}#${i.tx_index}`);
    if (!spent.some(wanted)) return { spent };
    const at = tx.outputs.filter((o) => isScriptAddress(o.payment_addr.bech32, scriptHash));
    const utxos = at.length ? await retryQueries("channel outputs", () => this.provider.getUtxosByOutRef(at.map((o) => input(txHash, o.tx_index)))) : [];
    return {
      spent,
      channels: utxos.flatMap((u) => {
        const ch = readChannel(u, scriptHash);
        return "error" in ch ? [] : [ch];
      }),
    };
  }

  /** The output of `txHash` that continues the channel with this tag, if it does. */
  private async continuation(txHash: string, scriptHash: string, tag: string): Promise<UTxO.UTxO | undefined> {
    const [tx] = await this.txs([txHash]);
    const at = (tx?.outputs ?? []).filter((o) => isScriptAddress(o.payment_addr.bech32, scriptHash));
    const candidates = at.length ? await retryQueries("the channel", () => this.provider.getUtxosByOutRef(at.map((o) => input(txHash, o.tx_index)))) : [];
    return candidates.find((u) => {
      const ch = readChannel(u, scriptHash);
      return !("error" in ch) && ch.datum.constants.tag === tag;
    });
  }

  /**
   * The transaction in a block that spent an output Koios reports spent, or null if none has: the
   * spend Koios knows of may still be in its mempool. Koios does not say which transaction it is, so
   * it is sought among the transactions at the output's address from the output's block on, by their
   * inputs, oldest first: one request for the list, one per 50 transactions.
   */
  private async spender(row: UtxoRow): Promise<string | null> {
    const listed = await this.addressTxs(row.address, row.block_height ?? undefined);
    const hashes = [...new Set(listed.map((t) => t.tx_hash).filter((h) => h !== row.tx_hash))].reverse();
    for (let i = 0; i < hashes.length; i += TX_BATCH) {
      const found = (await this.txs(hashes.slice(i, i + TX_BATCH), true)).find((t) => t.inputs?.some((x) => x.tx_hash === row.tx_hash && x.tx_index === row.tx_index));
      if (found) return found.tx_hash;
    }
    return null;
  }

  private scriptAddress(scriptHash: string): Address.Address {
    return new Address.Address({ networkId: networkIdOf(this.network), paymentCredential: ScriptHash.fromHex(scriptHash) });
  }

  private auth(): Record<string, string> {
    return this.token ? { Authorization: `Bearer ${this.token}` } : {};
  }

  /**
   * A request to Koios: a POST with a JSON body, or a GET without one. Tried again when it gets no
   * answer, a 429 or a 5xx; any other failure is the caller's.
   */
  private async request(path: string, body?: unknown): Promise<unknown> {
    for (let attempt = 1; ; attempt++) {
      try {
        const r = await fetch(`${this.baseUrl}${path}`, {
          method: body === undefined ? "GET" : "POST",
          headers: { ...this.auth(), Accept: "application/json", ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        if (r.ok) return await r.json();
        const retry = r.status === 429 || r.status >= 500;
        const text = retry ? (await r.body?.cancel(), "") : await r.text();
        if (!retry || attempt >= ATTEMPTS) throw new Error(`Koios ${path.split("?")[0]}: ${r.status} ${text.slice(0, 200)}`.trim());
      } catch (e) {
        if (!isNetworkError(e) || attempt >= ATTEMPTS) throw e;
      }
      await new Promise((res) => setTimeout(res, this.retryMs * attempt));
    }
  }

  private async tip(): Promise<{ abs_slot: number; block_height: number }> {
    const [t] = (await this.request("/tip")) as Array<{ abs_slot: number; block_height: number }>;
    if (!t) throw new Error("Koios /tip gave no block");
    return t;
  }

  /** An output in a block, as utxo_info has it, or undefined when Koios does not know it or has it only in its mempool. */
  private async utxo(ref: string): Promise<UtxoRow | undefined> {
    const [row] = (await this.request("/utxo_info", { _utxo_refs: [ref], _extended: false })) as UtxoRow[];
    return row && row.block_height !== null ? row : undefined;
  }

  /** Transactions in a block, as tx_info has them, with their inputs when asked for; the others are left out. */
  private async txs(hashes: string[], inputs = false): Promise<TxRow[]> {
    const out: TxRow[] = [];
    for (let i = 0; i < hashes.length; i += TX_BATCH) {
      const body = { _tx_hashes: hashes.slice(i, i + TX_BATCH), _inputs: inputs, _metadata: false, _assets: false, _withdrawals: false, _certs: false, _scripts: false, _bytecode: false };
      out.push(...((await this.request("/tx_info", body)) as TxRow[]).filter((t) => t.block_height !== null));
    }
    return out;
  }

  /** The transactions at an address, newest first, from a block height on (it included), or all of them; at most `limit` if given. */
  private async addressTxs(address: string, fromHeight?: number, limit?: number): Promise<Array<{ tx_hash: string; block_height: number }>> {
    const out: Array<{ tx_hash: string; block_height: number }> = [];
    const size = limit ?? PAGE;
    for (let offset = 0; ; offset += size) {
      const body = { _addresses: [address], ...(fromHeight === undefined ? {} : { _after_block_height: fromHeight }) };
      const rows = (await this.request(`/address_txs?offset=${offset}&limit=${size}`, body)) as Array<{ tx_hash: string; block_height: number | null }>;
      out.push(...rows.filter((r): r is { tx_hash: string; block_height: number } => r.block_height !== null));
      if (limit !== undefined || rows.length < size) return out;
    }
  }

  /** Where transactions sit in the chain, oldest first; those not in a block are left out. */
  private async cursors(hashes: string[]): Promise<ChainCursor[]> {
    return (await this.txs(hashes))
      .map((t) => ({ hash: t.tx_hash, height: t.block_height as number, index: t.tx_block_index }))
      .sort((a, b) => a.height - b.height || a.index - b.index);
  }
}
