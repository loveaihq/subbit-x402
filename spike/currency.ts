// The currency the spike's channels run in: ADA (steps 1–4), the sUSDM stand-in (step 5,
// SUBBIT_CURRENCY=token, after `npm run mint -- mint`), or Moneta's real preprod tUSDM (step 10,
// SUBBIT_CURRENCY=tusdm, claimed from tusdm.moneta.global). Amounts are in the currency's own units,
// which for both is 10⁻⁶ of a whole coin, so step 2's figures carry over unchanged. A token
// channel's value is that many tokens plus the ADA the output needs; the validator counts only
// the tokens.
import { existsSync, readFileSync } from "node:fs";
import { Assets } from "@evolution-sdk/evolution";
import type { Currency } from "../src/subbit.ts";

export const TOKEN_STATE = new URL("../out/token.json", import.meta.url);

export interface TokenState {
  policyId: string;
  /** `policyId.assetNameHex`, as x402 and Cardano `exact` write assets. */
  unit: string;
  extraUnit: string;
  decimals: number;
  lockSlot: string;
  mintTx: string;
}

const MODE = process.env.SUBBIT_CURRENCY ?? "ada";
if (!["ada", "token", "tusdm"].includes(MODE)) throw new Error(`SUBBIT_CURRENCY must be ada, token or tusdm, not ${MODE}`);

/** Moneta's preprod tUSDM, the asset `@x402/cardano` names, 6 decimals. */
const TUSDM = "e675b46e4d2242c991a8932a99db3044e80515ae14b4c4ccf6b3f4c9.0014df10745553444d";

export const TOKEN = MODE !== "ada";

export const token: TokenState | undefined =
  MODE === "token" ? readToken() : MODE === "tusdm" ? { policyId: TUSDM.split(".")[0]!, unit: TUSDM, extraUnit: "", decimals: 6, lockSlot: "", mintTx: "" } : undefined;

function readToken(): TokenState {
  if (!existsSync(TOKEN_STATE)) throw new Error("no token yet: run `npm run mint -- mint` first");
  return JSON.parse(readFileSync(TOKEN_STATE, "utf8")) as TokenState;
}

const [policy, name] = token ? (token.unit.split(".") as [string, string]) : ["", ""];

export const currency: Currency = token ? { kind: "asset", policy, name } : { kind: "ada" };
export const unitName = MODE === "tusdm" ? "tUSDM" : token ? "sUSDM" : "tADA";
/** The SDK's unit: policy and name run together (its doc comment says dot-separated). */
const sdkUnit = policy + name;

/** How much of the channel's currency a value holds. */
export function amountOf(assets: Assets.Assets): bigint {
  return token ? Assets.getByUnit(assets, sdkUnit) : Assets.lovelaceOf(assets);
}

/** A channel value: `amount` of the currency, plus `lovelace` of ADA when the currency is a token. */
export function valueOf(amount: bigint, lovelace: bigint): Assets.Assets {
  return token ? Assets.fromHexStrings(policy, name, amount, lovelace) : Assets.fromLovelace(amount);
}

/** The same, for an output as Blockfrost lists it. */
export function amountOfBf(o: { amount: Array<{ unit: string; quantity: string }> }): bigint {
  const unit = token ? sdkUnit : "lovelace";
  return BigInt(o.amount.find((a) => a.unit === unit)?.quantity ?? "0");
}

/** Whether a value holds the currency and nothing else (ADA only rides along for a token). */
export function onlyCurrency(assets: Assets.Assets): boolean {
  if (!token) return Assets.hasOnlyLovelace(assets);
  return Assets.getUnits(assets).every((u) => u === "lovelace" || u === sdkUnit);
}
