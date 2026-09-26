import { test } from "node:test";
import assert from "node:assert/strict";
import { Address } from "@evolution-sdk/evolution";
import { SUBBIT_HASH, channelAddress } from "../src/subbit.ts";
import { KoiosChain } from "../src/x402/koios.ts";

const h = (c: string) => c.repeat(64);
const WALLET = "addr_test1qqqt0pru382hy9vjlsxv3ye02z50sfvt8xunscg5pgden77z73dpdfng2ctw2ekqplqgrljelz7h4dneac27nn3qx3rqqpavzj";
const SCRIPT = Address.toBech32(channelAddress(0));

/** Koios on a table: each path answers from the request's JSON body; anything else is a 404. */
function koios(routes: Record<string, (body: Record<string, unknown>, url: URL) => unknown>) {
  const calls: string[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = url.pathname.replace(/^\/api\/v1/, "");
    calls.push(path);
    const route = routes[path];
    if (!route) return new Response("not found", { status: 404 });
    const out = route(init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {}, url);
    return out instanceof Response ? out : new Response(JSON.stringify(out), { status: 200 });
  }) as typeof fetch;
  return { calls, restore: () => void (globalThis.fetch = real) };
}
const chain = () => new KoiosChain("cardano:preprod", "https://koios.invalid/api/v1", undefined, 1);
const utxo = (hash: string, index: number, address: string, height: number, spent: boolean) => ({ tx_hash: hash, tx_index: index, address, block_height: height, is_spent: spent });
const out = (index: number, bech32: string, value: string, assets: unknown[] = []) => ({ tx_index: index, payment_addr: { bech32 }, value, asset_list: assets });

test("koios: the transaction in a block that spent an output, found among its address's transactions by their inputs", async () => {
  // aa#0 and aa#1 were made at block 100. bb spends something else, cc spends aa#1, dd spends aa#0.
  const txs: Record<string, { block_height: number | null; tx_block_index: number; inputs: Array<{ tx_hash: string; tx_index: number }> }> = {
    [h("b")]: { block_height: 101, tx_block_index: 0, inputs: [{ tx_hash: h("9"), tx_index: 0 }] },
    [h("c")]: { block_height: 102, tx_block_index: 0, inputs: [{ tx_hash: h("a"), tx_index: 1 }] },
    [h("d")]: { block_height: 103, tx_block_index: 0, inputs: [{ tx_hash: h("a"), tx_index: 0 }] },
  };
  const spent = new Set([`${h("a")}#0`, `${h("a")}#1`]);
  const k = koios({
    // aa's outputs are in block 100; ee's only in Koios' mempool.
    "/utxo_info": (b) => (b._utxo_refs as string[]).filter((r) => r.startsWith(h("a")) || r.startsWith(h("e"))).map((r) => (r.startsWith(h("e")) ? { ...utxo(h("e"), 0, WALLET, 0, false), block_height: null } : utxo(h("a"), Number(r.split("#")[1]), WALLET, 100, spent.has(r)))),
    // Newest first, the output's own transaction included, as Koios lists them.
    "/address_txs": (b) => {
      assert.equal(b._after_block_height, 100);
      return [h("d"), h("c"), h("b"), h("a")].map((tx_hash, i) => ({ tx_hash, block_height: 103 - i }));
    },
    "/tx_info": (b) => (b._tx_hashes as string[]).filter((x) => txs[x]).map((x) => ({ tx_hash: x, ...txs[x], outputs: [] })),
  });
  try {
    assert.equal(await chain().spentBy(`${h("a")}#0`), h("d"));
    assert.equal(await chain().spentBy(`${h("a")}#1`), h("c"));
    spent.delete(`${h("a")}#1`);
    assert.equal(await chain().spentBy(`${h("a")}#1`), null, "not spent");
    assert.equal(await chain().spentBy(`${h("f")}#0`), undefined, "not known");
    assert.equal(await chain().spentBy(`${h("e")}#0`), undefined, "only in the mempool: not on chain yet");
    // Spent by a transaction still in Koios' mempool, not yet in a block: unspent, as the chain stands.
    txs[h("d")]!.block_height = null;
    const before = k.calls.length;
    assert.equal(await chain().spentBy(`${h("a")}#0`), null);
    assert.equal(k.calls.slice(before).filter((p) => p === "/address_txs").length, 1, "asked once, not again and again");
  } finally {
    k.restore();
  }
});

test("koios: a channel's exit, when the transaction that spent its position does not continue it", async () => {
  const k = koios({
    "/utxo_info": (b) => (b._utxo_refs as string[]).map((r) => utxo(r.split("#")[0]!, 0, SCRIPT, 200, true)),
    "/address_txs": () => [{ tx_hash: h("f"), block_height: 201 }, { tx_hash: h("e"), block_height: 200 }],
    // The refund pays the wallet and leaves nothing at the script.
    "/tx_info": (b) => (b._tx_hashes as string[]).filter((x) => x === h("f")).map((x) => ({ tx_hash: x, block_height: 201, tx_block_index: 3, inputs: [{ tx_hash: h("e"), tx_index: 0 }], outputs: [out(0, WALLET, "1744477")] })),
  });
  try {
    assert.equal(await chain().followChannel(`${h("e")}#0`, SUBBIT_HASH, h("1")), undefined);
    assert.deepEqual(await chain().exitOf(`${h("e")}#0`, SUBBIT_HASH, h("1")), { txHash: h("f"), height: 201 });
  } finally {
    k.restore();
  }
});

test("koios: the script's activity in chain order, which only tx_info's block index gives within a block", async () => {
  // Newest first by height, in no order within a height.
  const listed = [
    { tx_hash: h("4"), block_height: 11 },
    { tx_hash: h("3"), block_height: 11 },
    { tx_hash: h("2"), block_height: 10 },
    { tx_hash: h("1"), block_height: 10 },
  ];
  const index: Record<string, [number, number]> = { [h("1")]: [10, 0], [h("2")]: [10, 3], [h("3")]: [11, 1], [h("4")]: [11, 0] };
  const k = koios({
    "/address_txs": (b, url) => {
      assert.equal((b._addresses as string[])[0], SCRIPT);
      const from = b._after_block_height as number | undefined;
      return listed.filter((r) => from === undefined || r.block_height >= from).slice(0, Number(url.searchParams.get("limit")));
    },
    "/tx_info": (b) => (b._tx_hashes as string[]).map((x) => ({ tx_hash: x, block_height: index[x]![0], tx_block_index: index[x]![1], outputs: [] })),
  });
  try {
    assert.deepEqual(await chain().scriptTip(SUBBIT_HASH), { hash: h("3"), height: 11, index: 1 });
    const after = { hash: h("1"), height: 10, index: 0 };
    assert.deepEqual((await chain().scriptActivity(SUBBIT_HASH, after)).map((c) => c.hash), [h("2"), h("4"), h("3")]);
    assert.deepEqual((await chain().scriptActivity(SUBBIT_HASH)).map((c) => c.hash), [h("1"), h("2"), h("4"), h("3")]);
  } finally {
    k.restore();
  }
});

test("koios: what a transaction paid an address, by unit; a 429 is asked again, a 400 is not", async () => {
  let tries = 0;
  const token = { policy_id: "ab".repeat(28), asset_name: "01", quantity: "5" };
  const k = koios({
    "/tx_info": (b) => {
      if (++tries === 1) return new Response("slow down", { status: 429 });
      if ((b._tx_hashes as string[])[0] === h("0")) return new Response("bad hash", { status: 400 });
      return [{ tx_hash: h("f"), block_height: 7, tx_block_index: 0, outputs: [out(0, WALLET, "1000000", [token]), out(1, SCRIPT, "2000000"), out(2, WALLET, "5")] }];
    },
  });
  try {
    assert.deepEqual(Object.fromEntries(await chain().paidTo(h("f"), WALLET)), { lovelace: 1_000_005n, [`${"ab".repeat(28)}01`]: 5n });
    assert.equal(tries, 2, "the 429 was asked again");
    await assert.rejects(chain().txHeight(h("0")), /Koios \/tx_info: 400 bad hash/);
    assert.equal(tries, 3, "the 400 was not");
  } finally {
    k.restore();
  }
});
