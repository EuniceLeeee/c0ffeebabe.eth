import { ethers } from "ethers";
import type { AdapterRequestResult, CanonicalSource } from "../../../adapter-request-program.js";
import { FLUID_CREDIT_STATE_ABI } from "../state.js";
import { FLUID_CAPACITY_ABI, FLUID_CAPACITY_ID, FLUID_RESOLVER_LIQUIDITY, type FluidCreditCapacity } from "../capacity.js";
import type { FluidCreditDescriptor } from "../types.js";

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

// Complete resolver tuple, not a shortened selection of capacity fields. These
// synthetic transport bytes prove decoding/contracts, not historical execution.
export function capacityFixture(source: CanonicalSource, descriptor: FluidCreditDescriptor,
  overrides: Partial<FluidCreditCapacity> = {}): readonly AdapterRequestResult[] {
  const state = { ...BORROW_STATE, ...overrides };
  const borrowable = overrides.borrowable ?? 30_833_211_853n;
  const untilLimit = overrides.borrowableUntilLimit ?? borrowable;
  const supplyPrice = overrides.liquiditySupplyExchangePrice ?? 10n ** 12n;
  const borrowPrice = overrides.liquidityBorrowExchangePrice ?? 1188700497544n;
  const oracle = overrides.oracle ?? ORACLE;
  return [{ id: FLUID_CAPACITY_ID, ok: true, source, completion: "returned",
    provenance: { kind: "fixture", fingerprint: "fluid-credit-local-capacity" },
    data: FLUID_CAPACITY_ABI.encodeFunctionResult("getVaultEntireData", [[
      overrides.vault ?? descriptor.vault,
      [overrides.liquidity ?? FLUID_RESOLVER_LIQUIDITY,
        overrides.factory ?? descriptor.factoryBinding.factory, ethers.ZeroAddress, ethers.ZeroAddress,
        overrides.supplyToken ?? descriptor.supplyToken, overrides.borrowToken ?? descriptor.borrowToken,
        overrides.supplyDecimals ?? descriptor.supplyDecimals, overrides.borrowDecimals ?? descriptor.borrowDecimals,
        overrides.vaultId ?? descriptor.factoryBinding.vaultId,
        ethers.ZeroHash, ethers.ZeroHash, ethers.ZeroHash, ethers.ZeroHash],
      [10000n, 10000n, state.collateralFactorBps, 9400n, 9600n, 500n, 200n, state.borrowFeeBps,
        oracle, state.oracleRate, state.oracleRate, ethers.ZeroAddress],
      [supplyPrice, borrowPrice, state.supplyExchangePrice, state.borrowExchangePrice,
        supplyPrice, borrowPrice, state.supplyExchangePrice, state.borrowExchangePrice, 0n, 0n, 0n, 0n, 0n],
      [0n, 0n, 0n, 0n, 0n, 0n],
      [0n, 0n, 0n, untilLimit, untilLimit, borrowable, untilLimit, overrides.minimumBorrowing ?? 10376n],
      [0n, 0n, 0n, 0n, 0n, 0n, [0n, 0n, 0n, 0n, 0n, 0n, 0n]],
      [overrides.supplyModeWithInterest ?? true, 0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n],
      [overrides.borrowModeWithInterest ?? true, 0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n],
    ]]) }];
}
