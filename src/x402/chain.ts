// What the facilitator and the server's channel manager read from and write to the chain,
// behind one interface so the checks can run on fixtures. The Blockfrost implementation reads
// UTxOs through the SDK (it resolves datums and reference scripts) and submits the exact bytes
// it was given, never a re-encoding, so the signatures on them stay valid.
import { Client, Transaction, TransactionHash, TransactionInput, preprod, type UTxO } from "@evolution-sdk/evolution";
import { readChannel, refOf, type ChannelView } from "./cardano.ts";
import type { CardanoNetwork } from "./types.ts";

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
}

interface BfOutput {
  address: string;
  output_index: number;
  consumed_by_tx?: string | null;
}

export class BlockfrostChain implements Chain {
  private readonly provider;
  private params?: { at: number; coinsPerUtxoByte: bigint };

  constructor(
    readonly network: CardanoNetwork,
    private readonly baseUrl: string,
    private readonly projectId: string,
  ) {
    if (network !== "cardano:preprod") throw new Error("the spike's Blockfrost chain is preprod only");
    this.provider = Client.make(preprod).withBlockfrost({ baseUrl, projectId });
  }

  async getUnspent(ref: string): Promise<UTxO.UTxO | undefined> {
    const [hash, index] = splitRef(ref);
    const outs = await this.txOutputs(hash);
    const o = outs?.find((x) => x.output_index === index);
    if (!o || o.consumed_by_tx) return undefined;
    const [u] = await this.provider.getUtxosByOutRef([input(hash, index)]);
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
        const [u] = await this.provider.getUtxosByOutRef([input(hash, index)]);
        if (!u) return undefined;
        const ch = readChannel(u, scriptHash);
        return "error" in ch || ch.datum.constants.tag !== tag ? undefined : ch;
      }
      // Find the continuing output of the same channel in the transaction that spent it.
      const next = o.consumed_by_tx;
      const nextOuts = (await this.txOutputs(next)) ?? [];
      const candidates = await this.provider.getUtxosByOutRef(nextOuts.map((x) => input(next, x.output_index)));
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
      const p = await this.provider.getProtocolParameters();
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
    await this.provider.evaluateTx(Transaction.fromCBORHex(cborHex), additionalUtxos);
  }

  /** A transaction's outputs with their spent-by field, or undefined if Blockfrost does not know it. */
  private async txOutputs(hash: string): Promise<BfOutput[] | undefined> {
    for (let attempt = 0; ; attempt++) {
      const r = await fetch(`${this.baseUrl}/txs/${hash}/utxos`, { headers: { project_id: this.projectId } });
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
 * showed both), up to `attempts` times. A script failure or anything else is thrown at once:
 * retrying those would hide a real refusal.
 */
export async function retryQueries<T>(what: string, fn: () => Promise<T>, attempts = 4): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (e) {
      const text = String((e as Error)?.message ?? e);
      const query = /Blockfrost (getProtocolParameters|getUtxos|getUtxosByOutRef|getDelegation|getDatum)[A-Za-z]* failed|Failed to fetch protocol parameters/.test(text);
      if (!query || /ScriptFailures|Script evaluation failed/.test(text) || i >= attempts) throw e;
      await new Promise((res) => setTimeout(res, 5_000 * i));
    }
  }
}

export function splitRef(ref: string): [string, number] {
  const m = /^([0-9a-f]{64})#(\d+)$/.exec(ref);
  if (!m) throw new Error(`not an out-ref: ${ref}`);
  return [m[1]!, Number(m[2])];
}

const input = (hash: string, index: number) => new TransactionInput.TransactionInput({ transactionId: TransactionHash.fromHex(hash), index: BigInt(index) });
