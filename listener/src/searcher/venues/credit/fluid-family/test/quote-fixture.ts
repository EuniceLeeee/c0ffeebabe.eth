import { ethers } from "ethers";
import type { AdapterRequestResult, CanonicalSource } from "../../../adapter-request-program.js";
import { FLUID_CREDIT_STATE_ABI } from "../state.js";

export const BORROW_STATE = Object.freeze({ oracleRate: 1132951122394340n,
  collateralFactorBps: 9200n, borrowFeeBps: 0n,
  supplyExchangePrice: 1000000000000n, borrowExchangePrice: 1037548642347n });
export const ORACLE = "0x6666666666666666666666666666666666666666";
export function stateFixture(source: CanonicalSource, state = BORROW_STATE): readonly AdapterRequestResult[] {
  const config = (BigInt(ORACLE) << 96n) | ((state.collateralFactorBps / 10n) << 32n) |
    (940n << 42n) | (960n << 52n) | (state.borrowFeeBps << 82n);
  return [["credit-current-config", "readFromStorage", [config]],
    ["credit-current-oracle", "getExchangeRateOperate", [state.oracleRate]],
    ["credit-current-rates", "updateExchangePrices", [10n ** 12n, 10n ** 12n,
      state.supplyExchangePrice, state.borrowExchangePrice]]].map(([id, method, args]) => ({
      id: String(id), ok: true as const, source, completion: "returned" as const,
      provenance: { kind: "fixture", fingerprint: "fluid-credit-current-state" },
      data: FLUID_CREDIT_STATE_ABI.encodeFunctionResult(String(method), args as readonly ethers.BigNumberish[]),
    }));
}
