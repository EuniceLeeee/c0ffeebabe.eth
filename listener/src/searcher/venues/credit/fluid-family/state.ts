import { ethers } from "ethers";
import { bindRequestResultRound } from "../../adapter-family-plugin.js";
import type { AdapterRequest, AdapterRequestResult, CanonicalSource } from "../../adapter-request-program.js";
import { assertSource, requireSuccessfulResult } from "./codec.js";
import { assertFluidBorrowState, type FluidBorrowState } from "./borrow-math.js";

export const FLUID_CREDIT_STATE_ABI = new ethers.Interface([
  "function readFromStorage(bytes32 slot) view returns (uint256)",
  "function updateExchangePrices(uint256 vars) view returns (uint256,uint256,uint256,uint256)",
  "function getExchangeRateOperate() view returns (uint256)",
]);
export const CONFIG_ID = "credit-current-config";
const ORACLE_ID = "credit-current-oracle";
const RATES_ID = "credit-current-rates";
export interface FluidCreditSnapshot extends FluidBorrowState {
  readonly source: CanonicalSource;
  readonly oracle: string;
}
function call(id: string, to: string, name: string, args: readonly unknown[] = []): AdapterRequest {
  return { id, kind: "eth-call", to, data: FLUID_CREDIT_STATE_ABI.encodeFunctionData(name, args), completion: "return-data" };
}
export function fluidConfigRequests(vault: string): readonly AdapterRequest[] {
  return [call(CONFIG_ID, vault, "readFromStorage", [ethers.toBeHex(1n, 32)])];
}
export function decodeFluidConfig(results: readonly AdapterRequestResult[]) {
  const result = requireSuccessfulResult(results, CONFIG_ID);
  const packed = BigInt(FLUID_CREDIT_STATE_ABI.decodeFunctionResult("readFromStorage", result.data)[0]);
  const oracle = ethers.getAddress(ethers.toBeHex(packed >> 96n, 20));
  const collateralFactorBps = ((packed >> 32n) & 1023n) * 10n;
  const borrowFeeBps = (packed >> 82n) & 1023n;
  if (oracle === ethers.ZeroAddress || collateralFactorBps <= 0n || collateralFactorBps > 10_000n) {
    throw new Error("fluid-credit invalid oracle/collateral factor");
  }
  return { packed, oracle, collateralFactorBps, borrowFeeBps, source: result.source };
}
export function fluidRateProgram(vault: string, results: readonly AdapterRequestResult[]) {
  const config = decodeFluidConfig(results);
  return bindRequestResultRound({ transports: ["eth-call"] }, [
    call(ORACLE_ID, config.oracle, "getExchangeRateOperate"),
    call(RATES_ID, vault, "updateExchangePrices", [config.packed]),
  ]);
}
export function decodeFluidCurrentState(results: readonly AdapterRequestResult[]): FluidCreditSnapshot {
  const config = decodeFluidConfig(results);
  const oracle = requireSuccessfulResult(results, ORACLE_ID);
  const rates = requireSuccessfulResult(results, RATES_ID);
  assertSource(oracle.source, config.source);
  assertSource(rates.source, config.source);
  const decoded = FLUID_CREDIT_STATE_ABI.decodeFunctionResult("updateExchangePrices", rates.data);
  const state = { source: config.source, oracle: config.oracle, collateralFactorBps: config.collateralFactorBps,
    borrowFeeBps: config.borrowFeeBps,
    oracleRate: BigInt(FLUID_CREDIT_STATE_ABI.decodeFunctionResult("getExchangeRateOperate", oracle.data)[0]),
    supplyExchangePrice: BigInt(decoded[2]), borrowExchangePrice: BigInt(decoded[3]) };
  assertFluidBorrowState(state);
  return Object.freeze(state);
}
