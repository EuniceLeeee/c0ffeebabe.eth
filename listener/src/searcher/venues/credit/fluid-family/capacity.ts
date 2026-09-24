import { ethers } from "ethers";
import type { AdapterRequest, AdapterRequestResult, CanonicalSource } from "../../adapter-request-program.js";
import { assertSource, canonicalAddress, requireSuccessfulResult, sameAddress } from "./codec.js";
import type { FluidCreditDescriptor } from "./types.js";

// Official mainnet VaultT1Resolver deployment. This is a read-only infrastructure
// identity, not an allowlist of vault instances or an execution permission.
export const FLUID_VAULT_T1_RESOLVER = "0xB21C67DD518F6d31257d3A4F12B0A6344885b268";
// The resolver's immutable LiquidityResolver reads this Liquidity deployment.
// A byte-identical vault attached elsewhere must not reuse its capacity values.
export const FLUID_RESOLVER_LIQUIDITY = "0x52Aa899454998Be5b000Ad077a46Bbe360F4e497";
// Old T1 cores have no TYPE(); this resolver identifies them via its Factory.
export const FLUID_RESOLVER_FACTORY = "0x324c5Dc1fC42c7a4D43d92df1eBA58a54d13Bf2d";
export const FLUID_CAPACITY_ID = "credit-current-capacity";

// Keep the complete deployed static tuple, including unused fields: omitting an
// intervening field silently shifts every subsequent capacity/configuration word.
const CONSTANTS = "(address liquidity,address factory,address adminImplementation,address secondaryImplementation,address supplyToken,address borrowToken,uint8 supplyDecimals,uint8 borrowDecimals,uint256 vaultId,bytes32 liquiditySupplyExchangePriceSlot,bytes32 liquidityBorrowExchangePriceSlot,bytes32 liquidityUserSupplySlot,bytes32 liquidityUserBorrowSlot)";
const CONFIGS = "(uint16 supplyRateMagnifier,uint16 borrowRateMagnifier,uint16 collateralFactor,uint16 liquidationThreshold,uint16 liquidationMaxLimit,uint16 withdrawalGap,uint16 liquidationPenalty,uint16 borrowFee,address oracle,uint256 oraclePriceOperate,uint256 oraclePriceLiquidate,address rebalancer)";
const PRICES = "(uint256 lastStoredLiquiditySupplyExchangePrice,uint256 lastStoredLiquidityBorrowExchangePrice,uint256 lastStoredVaultSupplyExchangePrice,uint256 lastStoredVaultBorrowExchangePrice,uint256 liquiditySupplyExchangePrice,uint256 liquidityBorrowExchangePrice,uint256 vaultSupplyExchangePrice,uint256 vaultBorrowExchangePrice,uint256 supplyRateVault,uint256 borrowRateVault,uint256 supplyRateLiquidity,uint256 borrowRateLiquidity,uint256 rewardsRate)";
const TOTALS = "(uint256 totalSupplyVault,uint256 totalBorrowVault,uint256 totalSupplyLiquidity,uint256 totalBorrowLiquidity,uint256 absorbedSupply,uint256 absorbedBorrow)";
const LIMITS = "(uint256 withdrawLimit,uint256 withdrawableUntilLimit,uint256 withdrawable,uint256 borrowLimit,uint256 borrowableUntilLimit,uint256 borrowable,uint256 borrowLimitUtilization,uint256 minimumBorrowing)";
const BRANCH = "(uint256 status,int256 minimaTick,uint256 debtFactor,uint256 partials,uint256 debtLiquidity,uint256 baseBranchId,int256 baseBranchMinima)";
const VAULT_STATE = `(uint256 totalPositions,int256 topTick,uint256 currentBranch,uint256 totalBranch,uint256 totalBorrow,uint256 totalSupply,${BRANCH} currentBranchState)`;
const USER_SUPPLY = "(bool modeWithInterest,uint256 supply,uint256 withdrawalLimit,uint256 lastUpdateTimestamp,uint256 expandPercent,uint256 expandDuration,uint256 baseWithdrawalLimit,uint256 withdrawableUntilLimit,uint256 withdrawable,uint256 decayEndTimestamp,uint256 decayAmount)";
const USER_BORROW = "(bool modeWithInterest,uint256 borrow,uint256 borrowLimit,uint256 lastUpdateTimestamp,uint256 expandPercent,uint256 expandDuration,uint256 baseBorrowLimit,uint256 maxBorrowLimit,uint256 borrowableUntilLimit,uint256 borrowable,uint256 borrowLimitUtilization)";
export const FLUID_CAPACITY_ABI = new ethers.Interface([
  `function getVaultEntireData(address vault_) view returns ((address vault,${CONSTANTS} constantVariables,${CONFIGS} configs,${PRICES} exchangePricesAndRates,${TOTALS} totalSupplyAndBorrow,${LIMITS} limitsAndAvailability,${VAULT_STATE} vaultState,${USER_SUPPLY} liquidityUserSupplyData,${USER_BORROW} liquidityUserBorrowData) vaultData_)`,
]);

type Binding = Pick<FluidCreditDescriptor, "vault" | "factoryBinding" | "supplyToken" | "borrowToken" | "supplyDecimals" | "borrowDecimals">;
export interface FluidCreditCapacity {
  readonly source: CanonicalSource;
  readonly vaultType: "T1";
  readonly vault: string;
  readonly factory: string;
  readonly liquidity: string;
  readonly supplyToken: string;
  readonly borrowToken: string;
  readonly supplyDecimals: number;
  readonly borrowDecimals: number;
  readonly vaultId: bigint;
  readonly borrowable: bigint;
  readonly borrowableUntilLimit: bigint;
  readonly minimumBorrowing: bigint;
  readonly oracle: string;
  readonly oracleRate: bigint;
  readonly collateralFactorBps: bigint;
  readonly borrowFeeBps: bigint;
  readonly supplyExchangePrice: bigint;
  readonly borrowExchangePrice: bigint;
  readonly liquiditySupplyExchangePrice: bigint;
  readonly liquidityBorrowExchangePrice: bigint;
  // These modes are not permission flags. The deployed resolver has no paused
  // fields; positive capacity is not proof that operate() will succeed.
  readonly supplyModeWithInterest: boolean;
  readonly borrowModeWithInterest: boolean;
}

export function fluidCapacityRequests(vault: string): readonly AdapterRequest[] {
  const address = canonicalAddress(vault);
  if (address === ethers.ZeroAddress) throw new Error("fluid-credit invalid capacity vault");
  return [Object.freeze({ id: FLUID_CAPACITY_ID, kind: "eth-call" as const,
    to: FLUID_VAULT_T1_RESOLVER, completion: "return-data" as const,
    data: FLUID_CAPACITY_ABI.encodeFunctionData("getVaultEntireData", [address]) })];
}

/** Resolver capacity is a conservative debt-output bound, NOT exact max input.
 * borrowableUntilLimit already includes the resolver's 999999/1000000 margin.
 * Zero capacity is valid current state and never an identity rejection. */
export function decodeFluidCapacity(binding: Binding, results: readonly AdapterRequestResult[],
  source: CanonicalSource): FluidCreditCapacity {
  if (results.filter(result => result.id === FLUID_CAPACITY_ID).length !== 1) {
    throw new Error("fluid-credit missing/duplicate capacity result");
  }
  const result = requireSuccessfulResult(results, FLUID_CAPACITY_ID);
  assertSource(result.source, source);
  const decoded = FLUID_CAPACITY_ABI.decodeFunctionResult("getVaultEntireData", result.data);
  if (FLUID_CAPACITY_ABI.encodeFunctionResult("getVaultEntireData", decoded).toLowerCase() !== result.data.toLowerCase()) {
    throw new Error("fluid-credit noncanonical capacity result");
  }
  const data = decoded[0] as ethers.Result;
  const constants = data.constantVariables as ethers.Result;
  const config = data.configs as ethers.Result;
  const prices = data.exchangePricesAndRates as ethers.Result;
  const limits = data.limitsAndAvailability as ethers.Result;
  const capacity: FluidCreditCapacity = {
    source: Object.freeze({ ...source }), vaultType: "T1", vault: canonicalAddress(data.vault),
    factory: canonicalAddress(constants.factory), liquidity: canonicalAddress(constants.liquidity),
    supplyToken: canonicalAddress(constants.supplyToken), borrowToken: canonicalAddress(constants.borrowToken),
    supplyDecimals: Number(constants.supplyDecimals), borrowDecimals: Number(constants.borrowDecimals),
    vaultId: BigInt(constants.vaultId), borrowable: BigInt(limits.borrowable),
    borrowableUntilLimit: BigInt(limits.borrowableUntilLimit), minimumBorrowing: BigInt(limits.minimumBorrowing),
    oracle: canonicalAddress(config.oracle), oracleRate: BigInt(config.oraclePriceOperate),
    collateralFactorBps: BigInt(config.collateralFactor), borrowFeeBps: BigInt(config.borrowFee),
    supplyExchangePrice: BigInt(prices.vaultSupplyExchangePrice), borrowExchangePrice: BigInt(prices.vaultBorrowExchangePrice),
    liquiditySupplyExchangePrice: BigInt(prices.liquiditySupplyExchangePrice),
    liquidityBorrowExchangePrice: BigInt(prices.liquidityBorrowExchangePrice),
    supplyModeWithInterest: Boolean(data.liquidityUserSupplyData.modeWithInterest),
    borrowModeWithInterest: Boolean(data.liquidityUserBorrowData.modeWithInterest),
  };
  // getVaultEntireData fills constants only for T1; every other type returns
  // vault plus a zero tuple. Require its full binding to the admitted instance.
  if ([capacity.vault, capacity.factory, capacity.liquidity, capacity.supplyToken, capacity.borrowToken]
      .some(address => address === ethers.ZeroAddress) ||
      !sameAddress(capacity.vault, binding.vault) || !sameAddress(capacity.vault, binding.factoryBinding.reverseVault) ||
      !sameAddress(capacity.factory, binding.factoryBinding.factory) || capacity.vaultId <= 0n ||
      !sameAddress(capacity.liquidity, FLUID_RESOLVER_LIQUIDITY) ||
      capacity.vaultId !== binding.factoryBinding.vaultId ||
      !sameAddress(capacity.supplyToken, binding.supplyToken) || !sameAddress(capacity.borrowToken, binding.borrowToken) ||
      sameAddress(capacity.supplyToken, capacity.borrowToken) ||
      capacity.supplyDecimals !== binding.supplyDecimals || capacity.borrowDecimals !== binding.borrowDecimals ||
      capacity.supplyDecimals > 36 || capacity.borrowDecimals > 36) {
    throw new Error("fluid-credit capacity resolver returned a foreign/non-T1 binding");
  }
  if (capacity.borrowable > capacity.borrowableUntilLimit || capacity.minimumBorrowing <= 0n ||
      capacity.oracle === ethers.ZeroAddress || capacity.oracleRate <= 0n ||
      capacity.collateralFactorBps > 10_000n || capacity.borrowFeeBps >= 10_000n ||
      capacity.supplyExchangePrice <= 0n || capacity.borrowExchangePrice <= 0n ||
      capacity.liquiditySupplyExchangePrice <= 0n || capacity.liquidityBorrowExchangePrice <= 0n) {
    throw new Error("fluid-credit capacity resolver returned invalid limits/config");
  }
  return Object.freeze(capacity);
}
