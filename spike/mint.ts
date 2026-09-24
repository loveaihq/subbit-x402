// Step 5 of the plan, on preprod: a stand-in for USDM. The real preprod tUSDM (Moneta's, the one
// `@x402/cardano` names) exists, but these wallets hold none, and getting it means an outside
// faucet. So the consumer mints its own: same shape (CIP-67 label 333 prefix, 6 decimals),
// under a policy only its key can use and only for an hour, so the supply is fixed.
//
//   mint    1,000,000 sUSDM to the consumer, and 10 units of a second name under the same policy
//           (sXTRA) to the provider, for checks that need a token besides the currency
//   show    the recorded policy, units and balances
//   tidy [consumer|provider]  three ADA-only outputs (15 / 5 tADA) to that wallet: channel openings keep taking its
//           largest ADA-only UTxO, and the SDK wants 5 ADA of collateral from at most three
//           inputs, ADA-only first, so a wallet with one big token-laden UTxO has none to give
//
// Usage: npm run mint -- <mint|show|tidy>
// Env:   WALLET_MNEMONIC (preprod only), BLOCKFROST_PROJECT_ID
import { Address, Assets, KeyHash, NativeScripts, ScriptHash } from "@evolution-sdk/evolution";
import { ada, bf, consumer, expectEq, keyHashHex, load, log, msOf, provider, run, save, slotOf, nowMs, submit, type BfUtxos } from "./chain.ts";
import { TOKEN_STATE, type TokenState } from "./currency.ts";

const LABEL_333 = "0014df10";
const CURRENCY_NAME = LABEL_333 + Buffer.from("sUSDM").toString("hex");
const EXTRA_NAME = LABEL_333 + Buffer.from("sXTRA").toString("hex");
const SUPPLY = 1_000_000_000_000n; // 1,000,000 sUSDM at 6 decimals
const EXTRA = 10n;

async function mint() {
  const st = load<Partial<TokenState>>(TOKEN_STATE);
  if (st.mintTx) return log(`mint: already done, ${st.mintTx}`);
  const me = await consumer.address();
  const lockSlot = slotOf(nowMs()) + 3_600n;
  const policy = NativeScripts.makeScriptAll([
    NativeScripts.makeScriptPubKey(KeyHash.toBytes(KeyHash.fromHex(keyHashHex(me)))).script,
    NativeScripts.makeInvalidHereafter(lockSlot).script,
  ]);
  const policyId = ScriptHash.toHex(ScriptHash.fromScript(policy));
  const minted = Assets.addByHex(Assets.fromHexStrings(policyId, CURRENCY_NAME, SUPPLY, 0n), policyId, EXTRA_NAME, EXTRA);
  const sb = await consumer
    .newTx()
    .mintAssets({ assets: minted })
    .attachScript({ script: policy })
    .setValidity({ to: msOf(lockSlot) })
    .payToAddress({ address: me, assets: Assets.fromHexStrings(policyId, CURRENCY_NAME, SUPPLY, 0n), autoMinUtxo: true })
    .payToAddress({ address: await provider.address(), assets: Assets.fromHexStrings(policyId, EXTRA_NAME, EXTRA, 0n), autoMinUtxo: true })
    .build({ changeAddress: me });
  const mintTx = await submit("mint", await sb.sign(), consumer);

  const unit = `${policyId}.${CURRENCY_NAME}`;
  const extraUnit = `${policyId}.${EXTRA_NAME}`;
  const outs = ((await bf(`/txs/${mintTx}/utxos`)) as BfUtxos).outputs;
  const qty = (addr: string, u: string) => outs.filter((o) => o.address === addr).reduce((s, o) => s + BigInt(o.amount.find((a) => a.unit === u.replace(".", ""))?.quantity ?? "0"), 0n);
  expectEq("consumer holds the minted sUSDM", qty(Address.toBech32(me), unit), SUPPLY);
  expectEq("provider holds the sXTRA", qty(Address.toBech32(await provider.address()), extraUnit), EXTRA);
  save(TOKEN_STATE, { policyId, unit, extraUnit, decimals: 6, lockSlot: lockSlot.toString(), mintTx } satisfies TokenState);
  log(`mint: ${mintTx}; policy ${policyId} closes at slot ${lockSlot}; ${SUPPLY / 1_000_000n} sUSDM to the consumer, ${EXTRA} sXTRA to the provider`);
}

async function show() {
  const st = load<Partial<TokenState>>(TOKEN_STATE);
  if (!st.unit) return log("show: nothing minted yet");
  for (const [name, w] of [["consumer", consumer], ["provider", provider]] as const) {
    const utxos = await w.getWalletUtxos();
    // The SDK's unit is policy and name run together; its doc comment says dot-separated.
    const sum = (u: string) => utxos.reduce((s, x) => s + Assets.getByUnit(x.assets, u.replace(".", "")), 0n);
    log(`${name.padEnd(8)} ${ada(utxos.reduce((s, x) => s + Assets.lovelaceOf(x.assets), 0n))} tADA, ${sum(st.unit)} sUSDM units, ${sum(st.extraUnit!)} sXTRA`);
  }
  log(`unit ${st.unit}`);
}

async function tidy(who: string) {
  const w = who === "provider" ? provider : consumer;
  const size = who === "provider" ? 5_000_000n : 15_000_000n;
  const me = await w.address();
  let tx = w.newTx();
  for (let i = 0; i < 3; i++) tx = tx.payToAddress({ address: me, assets: Assets.fromLovelace(size) });
  const hash = await submit(`tidy ${who}`, await (await tx.build({ changeAddress: me })).sign(), w);
  log(`tidy ${who}: ${hash}`);
}

async function main() {
  const phase = process.argv[2] ?? "show";
  if (phase === "mint") return mint();
  if (phase === "show") return show();
  if (phase === "tidy") return tidy(process.argv[3] ?? "consumer");
  throw new Error(`unknown phase ${phase}`);
}

run(main);
