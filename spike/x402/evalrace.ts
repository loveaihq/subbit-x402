// Whether a script transaction built the moment Blockfrost's index lists the one before it passes
// evaluation (RESULTS.md, "Step 16 with 0.2.2"). Two ways: the SDK's default, which leaves Blockfrost
// to find the inputs in its own view of the chain, and with the UTxOs passed along
// (`passAdditionalUtxos`, what 0.2.2's builds do).
//
// An ADA channel of account 3, with account 1 as its provider. It opens; then each round waits,
// polling every 200 ms, until Blockfrost lists the last transaction, and at once builds the next
// top-up both ways, from that transaction's own outputs. Neither build is sent; the second is
// signed and submitted as the next round's top-up. A Mutual refund closes the channel at the end.
// `npm run evalrace -- [rounds]` (default 5), state in out/evalrace.json.
import { Address, Assets, Client, InlineDatum, KeyHash, Transaction, TransactionHash, TxOut, UTxO, preprod } from "@evolution-sdk/evolution";
import { Redeemer, Step, UPSTREAM, channelAddress, inlineDatum, newIouSigner, subbitScript, tagFromInput, type Constants } from "../../src/subbit.ts";
import { referenceFor, txHashOf } from "../../src/x402/cardano.ts";
import { BlockfrostChain, causeChain } from "../../src/x402/chain.ts";
import { collateralTarget, signedHex } from "../../src/x402/client.ts";
import { BF_BASE, REF_STATE, ada, inputOf, keyHashHex, load, log, must, run, save } from "../chain.ts";

const NETWORK = "cardano:preprod";
/** The reference-script output `npm run refscript -- deploy` recorded for the validator these runs use, if any: the output is read only when it carries that validator. */
const deployed = load<{ out?: { txHash: string; index: number } }>(REF_STATE).out;
const REFERENCE_SCRIPT = deployed ? `${deployed.txHash}#${deployed.index}` : undefined;
const DEPOSIT = 2_000_000n;
const ADD = 100_000n;
const ACCOUNT = { consumer: 3, provider: 1 } as const;
const STATE = new URL("../../out/evalrace.json", import.meta.url);

const projectId = must("BLOCKFROST_PROJECT_ID");
const mnemonic = must("WALLET_MNEMONIC");
const wallet = (accountIndex: number) => Client.make(preprod).withBlockfrost({ baseUrl: BF_BASE, projectId }).withSeed({ mnemonic, accountIndex });
const consumer = wallet(ACCOUNT.consumer);
const provider = wallet(ACCOUNT.provider);
const chain = new BlockfrostChain(NETWORK, BF_BASE, projectId);
const chan = channelAddress(0);

interface Round {
  round: number;
  after: string;
  withoutMs: number;
  without: string;
  withMs: number;
  with: string;
  sent?: string;
}

/** Polls Blockfrost for a transaction every 200 ms; the moment it is listed. */
async function listed(txHash: string): Promise<number> {
  for (const until = Date.now() + 300_000; Date.now() < until; ) {
    const r = await fetch(`${BF_BASE}/txs/${txHash}`, { headers: { project_id: projectId } }).catch(() => undefined);
    if (r?.ok) return Date.now();
    await r?.body?.cancel().catch(() => {});
    await new Promise((res) => setTimeout(res, 200));
  }
  throw new Error(`${txHash} not listed after 5 minutes`);
}

/** An output of a transaction of ours, from its own body: what the next one spends, whatever the index says. */
function ours(hex: string, index: number): UTxO.UTxO {
  const o = Transaction.fromCBORHex(hex).body.outputs[index]!;
  return new UTxO.UTxO({ transactionId: TransactionHash.fromHex(txHashOf(hex)), index: BigInt(index), address: o.address, assets: o.assets, ...(o.datumOption ? { datumOption: o.datumOption } : {}) });
}

function indexOf(hex: string, where: (o: TxOut.TransactionOutput) => boolean): number {
  const i = Transaction.fromCBORHex(hex).body.outputs.findIndex(where);
  if (i < 0) throw new Error("no such output");
  return i;
}

const atChannel = (o: TxOut.TransactionOutput) => Address.toBech32(o.address) === Address.toBech32(chan);

async function topUp(channel: UTxO.UTxO, change: UTxO.UTxO, pass: boolean) {
  const me = await consumer.address();
  const ref = referenceFor(REFERENCE_SCRIPT ? await chain.getUnspent(REFERENCE_SCRIPT) : undefined, UPSTREAM);
  let tx = consumer.newTx().collectFrom({ inputs: [channel], redeemer: Redeemer.main([Step.add()]) });
  tx = ref ? tx.readFrom({ referenceInputs: [ref] }) : tx.attachScript({ script: subbitScript });
  tx = tx
    .payToAddress({ address: channel.address, assets: Assets.fromLovelace(Assets.lovelaceOf(channel.assets) + ADD), datum: channel.datumOption as InlineDatum.InlineDatum })
    .addSigner({ keyHash: KeyHash.fromHex(keyHashHex(me)) });
  return tx.build({ changeAddress: me, availableUtxos: [change], setCollateral: collateralTarget([change]), passAdditionalUtxos: pass });
}

run(async () => {
  const rounds = Number(process.argv[2] ?? 5);
  const me = await consumer.address();
  const mine = (o: TxOut.TransactionOutput) => Address.toBech32(o.address) === Address.toBech32(me);

  // Open.
  const seed = (await consumer.getWalletUtxos()).filter((u) => Assets.hasOnlyLovelace(u.assets)).sort((a, b) => (Assets.lovelaceOf(b.assets) > Assets.lovelaceOf(a.assets) ? 1 : -1))[0];
  if (!seed) throw new Error("account 3 holds no ADA-only UTxO");
  const constants: Constants = {
    tag: tagFromInput(inputOf(seed)),
    currency: { kind: "ada" },
    iouKey: newIouSigner().publicKey,
    consumer: keyHashHex(me),
    provider: keyHashHex(await provider.address()),
    closePeriodMs: 900_000n,
  };
  const opened = await consumer.newTx().collectFrom({ inputs: [seed] }).payToAddress({ address: chan, assets: Assets.fromLovelace(DEPOSIT), datum: inlineDatum(constants, { kind: "opened", subbed: 0n }) }).build({ changeAddress: me });
  let hex = await signedHex(opened);
  await chain.submit(hex);
  log(`opened ${txHashOf(hex)}`);
  const results: Round[] = [];
  save(STATE, { opened: txHashOf(hex), rounds: results });

  for (let round = 1; round <= rounds; round++) {
    const seen = await listed(txHashOf(hex));
    const channel = ours(hex, indexOf(hex, atChannel));
    const change = ours(hex, indexOf(hex, mine));
    const attempt = async (pass: boolean) => {
      const t0 = Date.now();
      try {
        return { ms: t0 - seen, built: await topUp(channel, change, pass), said: "passed" };
      } catch (e) {
        return { ms: t0 - seen, built: undefined, said: `failed: ${causeChain(e).join(" | ").slice(0, 600)}` };
      }
    };
    const without = await attempt(false);
    const withOurs = await attempt(true);
    const r: Round = { round, after: txHashOf(hex), withoutMs: without.ms, without: without.said, withMs: withOurs.ms, with: withOurs.said };
    log(`round ${round}: ${without.ms} ms after the index listed ${txHashOf(hex).slice(0, 16)}…, without the UTxOs ${without.said.slice(0, 160)}; ${withOurs.ms} ms, with them ${withOurs.said.slice(0, 160)}`);
    if (!withOurs.built) {
      results.push(r);
      break;
    }
    hex = await signedHex(withOurs.built);
    await chain.submit(hex);
    r.sent = txHashOf(hex);
    results.push(r);
    save(STATE, { ...load<Record<string, unknown>>(STATE), rounds: results });
  }

  // Close: a Mutual refund, both keys, everything back to account 3.
  await listed(txHashOf(hex));
  await new Promise((res) => setTimeout(res, 20_000)); // Blockfrost's address index, for the SDK's own reads
  const channel = ours(hex, indexOf(hex, atChannel));
  const change = ours(hex, indexOf(hex, mine));
  const ref = referenceFor(REFERENCE_SCRIPT ? await chain.getUnspent(REFERENCE_SCRIPT) : undefined, UPSTREAM);
  let tx = consumer
    .newTx()
    .collectFrom({ inputs: [channel], redeemer: Redeemer.mutual() })
    .addSigner({ keyHash: KeyHash.fromHex(constants.consumer) })
    .addSigner({ keyHash: KeyHash.fromHex(constants.provider) });
  tx = ref ? tx.readFrom({ referenceInputs: [ref] }) : tx.attachScript({ script: subbitScript });
  const sb = await tx.build({ changeAddress: me, availableUtxos: [change], setCollateral: collateralTarget([change]), passAdditionalUtxos: true });
  const witnessed = await sb.assemble([await sb.partialSign(), await provider.signTx(await sb.toTransaction())]);
  const refund = TransactionHash.toHex(await witnessed.submit());
  await listed(refund);
  log(`refunded ${refund}: ${ada(Assets.lovelaceOf(channel.assets))} tADA back to account 3, less the fee`);
  save(STATE, { ...load<Record<string, unknown>>(STATE), refund });
  const without = results.filter((r) => r.without !== "passed").length;
  const withOurs = results.filter((r) => r.with !== "passed").length;
  log(`summary: ${results.length} round(s); without the UTxOs ${without} failed, with them ${withOurs} failed`);
});
