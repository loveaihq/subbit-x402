// An SDK client built against no chain at all: Blockfrost's endpoints that building a transaction
// and reading a channel use (the protocol parameters, a wallet's UTxOs, a transaction's outputs, a
// script evaluation) answered from a table, by `fetch`. The builders then run for real, so a test
// sees the transaction that would go out. Nothing here touches a network. The parameters are
// mainnet's of 2025; the cost models are placeholders (nothing evaluates a script: every redeemer
// gets a fixed budget), and so nothing built here is valid for a ledger.
import { Address, Assets, Client, Data, InlineDatum, Transaction, TransactionHash, preprod, type UTxO } from "@evolution-sdk/evolution";
import { spendRedeemers } from "../src/x402/txcheck.ts";

export const OFFLINE_BASE = "https://blockfrost.invalid/api/v0";
export const TEST_MNEMONIC = `${"abandon ".repeat(23)}art`;

/** A seed wallet whose provider is the table below: `getWalletUtxos` and `build` need `offlineBlockfrost()` running. */
export const offlineWallet = (accountIndex = 0) =>
  Client.make(preprod).withBlockfrost({ baseUrl: OFFLINE_BASE, projectId: "unused" }).withSeed({ mnemonic: TEST_MNEMONIC, accountIndex });

const PARAMS = {
  min_fee_a: 44,
  min_fee_b: 155_381,
  pool_deposit: 500_000_000,
  key_deposit: 2_000_000,
  max_tx_size: 16_384,
  max_val_size: 5_000,
  price_mem: 0.0577,
  price_step: 0.0000721,
  max_tx_ex_mem: 14_000_000,
  max_tx_ex_steps: 10_000_000_000,
  max_block_size: 90_112,
  collateral_percent: 150,
  max_collateral_inputs: 3,
  coins_per_utxo_size: 4_310,
  min_fee_ref_script_cost_per_byte: 15,
  drep_deposit: 500_000_000,
  gov_action_deposit: 100_000_000_000,
  cost_models_raw: { PlutusV1: Array(166).fill(1), PlutusV2: Array(175).fill(1), PlutusV3: Array(297).fill(1) },
};

/** What each script evaluation costs, whatever it is. */
export const EX_UNITS = { memory: 500_000, steps: 200_000_000 };

/** An output as Blockfrost lists it, at an address or in its transaction. */
function listed(u: UTxO.UTxO) {
  return {
    address: Address.toBech32(u.address),
    tx_hash: TransactionHash.toHex(u.transactionId),
    tx_index: Number(u.index),
    output_index: Number(u.index),
    amount: Assets.getUnits(u.assets).map((unit) => ({ unit, quantity: Assets.getByUnit(u.assets, unit).toString() })),
    block: "00",
    data_hash: null,
    inline_datum: u.datumOption instanceof InlineDatum.InlineDatum ? Data.toCBORHex(u.datumOption.data) : null,
    reference_script_hash: null,
  };
}

export interface Offline {
  /** Every request made, as `METHOD /path`. */
  readonly calls: string[];
  /** What Blockfrost lists at an address (a wallet's UTxOs, for `getWalletUtxos`); any other address has none. These outputs are known by their transactions too. */
  setUtxos(address: Address.Address, utxos: UTxO.UTxO[]): void;
  /** Outputs Blockfrost knows by their transaction, unspent, for reading one by its reference. */
  know(...utxos: UTxO.UTxO[]): void;
  restore(): void;
}

export function offlineBlockfrost(): Offline {
  const real = globalThis.fetch;
  const calls: string[] = [];
  const at = new Map<string, UTxO.UTxO[]>();
  const byTx = new Map<string, UTxO.UTxO[]>();
  const know = (...utxos: UTxO.UTxO[]) => {
    for (const u of utxos) {
      const hash = TransactionHash.toHex(u.transactionId);
      byTx.set(hash, [...(byTx.get(hash) ?? []).filter((x) => x.index !== u.index), u]);
    }
  };
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push(`${init?.method ?? "GET"} ${url.pathname}`);
    const path = url.pathname.replace(/^\/api\/v0/, "");
    if (path === "/epochs/latest/parameters") return json(PARAMS);
    const owner = /^\/addresses\/([^/]+)\/utxos$/.exec(path)?.[1];
    if (owner !== undefined) return url.searchParams.get("page") === "1" && at.has(owner) ? json(at.get(owner)!.map(listed)) : new Response("not found", { status: 404 });
    const tx = /^\/txs\/([0-9a-f]{64})\/utxos$/.exec(path)?.[1];
    if (tx !== undefined) return byTx.has(tx) ? json({ hash: tx, inputs: [], outputs: byTx.get(tx)!.map((u) => ({ ...listed(u), collateral: false, consumed_by_tx: null })) }) : new Response("not found", { status: 404 });
    if (path === "/utils/txs/evaluate/utxos") {
      const built = Transaction.fromCBORHex((JSON.parse(String(init?.body)) as { cbor: string }).cbor);
      const result: Record<string, typeof EX_UNITS> = {};
      for (const i of spendRedeemers(built).keys()) result[`spend:${i}`] = EX_UNITS;
      return json({ type: "jsonwsp/response", result: { EvaluationResult: result } });
    }
    return new Response(`no such endpoint offline: ${path}`, { status: 404 });
  }) as typeof fetch;
  return {
    calls,
    setUtxos: (address, utxos) => {
      at.set(Address.toBech32(address), utxos);
      know(...utxos);
    },
    know,
    restore: () => void (globalThis.fetch = real),
  };
}
