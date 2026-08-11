import { hashCanonical } from "./venues/canonical-value.js";
import {
  canonicalAddress,
  lowerAddress,
} from "./venues/swaps/univ2-family/codec.js";
import { uniV2FeeRuleForFactory } from
  "./venues/swaps/univ2-family/fee-rule.js";
import { UNIV2_FAMILY_ID } from
  "./venues/swaps/univ2-family/manifest.js";
import { UNIV3_FAMILY_ID } from
  "./venues/swaps/univ3-family/manifest.js";
import { UNIV4_FAMILY_ID } from
  "./venues/swaps/univ4-family/manifest.js";
import { PSM_FAMILY_ID } from
  "./venues/protocols/psm-family/manifest.js";
import { WSTETH_FAMILY_ID } from
  "./venues/protocols/wsteth-family/manifest.js";
import { GOLDX_FAMILY_ID } from
  "./venues/protocols/goldx-family/manifest.js";
import { ROCKSOLID_FAMILY_ID } from
  "./venues/protocols/rocksolid-family/manifest.js";
import { METRONOME_HGUSDC_FAMILY_ID } from
  "./venues/protocols/metronome-hgusdc-family/manifest.js";
import { metronomeHgUsdcStaticProjection } from
  "./venues/protocols/metronome-hgusdc-family/shared.js";
import { METRONOME_SYNTH_FAMILY_ID } from
  "./venues/protocols/metronome-synth-family/manifest.js";
import { metronomeSynthStaticProjection } from
  "./venues/protocols/metronome-synth-family/shared.js";
import { ERC4626_SILO_REDEEM_FAMILY_ID } from
  "./venues/protocols/erc4626-silo-redeem-family/manifest.js";
import { erc4626SiloStaticProjection } from
  "./venues/protocols/erc4626-silo-redeem-family/shared.js";
import { ERC4626_FAMILY_ID } from
  "./venues/protocols/erc4626-family/manifest.js";
import { erc4626StaticProjection } from
  "./venues/protocols/erc4626-family/binding.js";
import { ETHERTOKEN_NATIVE_FAMILY_ID } from
  "./venues/protocols/ethertoken-native-redeem-family/manifest.js";
import { etherTokenNativeStaticProjection } from
  "./venues/protocols/ethertoken-native-redeem-family/shared.js";
import { SELF_BURN_NATIVE_FAMILY_ID } from
  "./venues/protocols/self-burn-native-family/manifest.js";
import { selfBurnNativeStaticProjection } from
  "./venues/protocols/self-burn-native-family/shared.js";
import { ASTRA_MULTITOKEN_FAMILY_ID } from
  "./venues/protocols/astra-multitoken-family/manifest.js";
import { astraStaticBindingProjection } from
  "./venues/protocols/astra-multitoken-family/binding.js";
import { EIGENPIE_FAMILY_ID } from
  "./venues/protocols/eigenpie-family/manifest.js";
import { eigenpieStaticBindingProjection } from
  "./venues/protocols/eigenpie-family/binding.js";
import { CURVE_UNDERLYING_FAMILY_ID } from
  "./venues/swaps/curve-underlying-family/manifest.js";
import { curveUnderlyingStaticBindingProjection } from
  "./venues/swaps/curve-underlying-family/instance.js";
import { PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG } from
  "./venues/production-family-composition.js";
import type {
  ArchitectureMigrationStage,
  CommonGraphMigrationStage,
  RawMigrationSemanticItem,
} from "./architecture-migration-parity-runner.js";

/**
 * Facts the frozen-ds baseline exporter attaches to each legacy edge item so
 * the trusted comparator can derive the same canonical identity the
 * challenger graph runtime produces. The normalizer is fixed before the
 * challenger freeze (§20.2.2): it must never be defined by the challenger
 * side per-run, and it must fail closed when the facts are missing or the
 * legacy fee does not match the reverse-verified factory rule.
 */
export interface BaselineUniv2EdgeFacts {
  readonly familyId: "univ2-standard";
  readonly pool: string;
  readonly token0: string;
  readonly token1: string;
  readonly tokenIn: string;
  readonly tokenOut: string;
  readonly feeBps: string;
  readonly factory: string;
  readonly reversePool: string;
}

export interface BaselineUniv3EdgeFacts {
  readonly familyId: "univ3-standard";
  readonly pool: string;
  readonly token0: string;
  readonly token1: string;
  readonly tokenIn: string;
  readonly tokenOut: string;
  readonly fee: string;
  readonly tickSpacing: number;
  readonly factory: string;
  readonly reversePool: string;
  readonly quoter: string | null;
  readonly router: string | null;
  readonly quoterProvenance: string;
}

export interface BaselineUniv4EdgeFacts {
  readonly familyId: "univ4";
  readonly manager: string;
  readonly poolId: string;
  readonly currency0: string;
  readonly currency1: string;
  readonly fee: number;
  readonly tickSpacing: number;
  readonly hooks: string;
  readonly graphToken0: string;
  readonly graphToken1: string;
  readonly tokenIn: string;
  readonly tokenOut: string;
  readonly stateView: string;
  readonly quoter: string;
  readonly managerCodeHash: string;
  readonly lpFee: string;
  readonly hookPolicy: "no-hook";
}

export interface BaselinePsmFacts {
  readonly familyId: "protocol:psm";
  readonly target: string;
  readonly gem: string;
  readonly dai: string;
  readonly decimalScale: string;
  readonly tokenIn: string;
  readonly tokenOut: string;
}

export interface BaselineWstethFacts {
  readonly familyId: "protocol:wsteth";
  readonly target: string;
  readonly steth: string;
  readonly wsteth: string;
  readonly tokenIn: string;
  readonly tokenOut: string;
}

export interface BaselineGoldxFacts {
  readonly familyId: "protocol:goldx";
  readonly target: string;
  readonly collateral: string;
  readonly receipt: string;
  readonly tokenIn: string;
  readonly tokenOut: string;
}

export interface BaselineRocksolidFacts {
  readonly familyId: "protocol:rocksolid";
  readonly target: string;
  readonly asset: string;
  readonly receipt: string;
  readonly tokenIn: string;
  readonly tokenOut: string;
}

export interface BaselineMetronomeHgUsdcFacts {
  readonly familyId: "protocol:metronome-hgusdc";
  readonly router: string;
  readonly curve: string;
  readonly vault: string;
  readonly tokenIn: string;
  readonly curveIntermediate: string;
  readonly tokenOut: string;
  readonly curveDirection: readonly number[];
  readonly pathHash: string;
}

export interface BaselineMetronomeSynthDirectionFacts {
  readonly tokenIn: string;
  readonly tokenOut: string;
}

export interface BaselineMetronomeSynthFacts {
  readonly familyId: "protocol:metronome-synth";
  readonly pool: string;
  readonly tokens: readonly string[];
  readonly directions: readonly BaselineMetronomeSynthDirectionFacts[];
  readonly oracleBinding: string;
  readonly tokenIn: string;
  readonly tokenOut: string;
}

export interface BaselineErc4626SiloRedeemFacts {
  readonly familyId: "protocol:erc4626-silo-redeem";
  readonly vault: string;
  readonly payoutToken: string;
  readonly underlyingAsset: string;
  readonly tokenIn: string;
  readonly tokenOut: string;
}

export interface BaselineErc4626Facts {
  readonly familyId: "protocol:erc4626";
  readonly vault: string;
  readonly asset: string;
  readonly share: string;
  readonly verifiedDirections: {
    readonly deposit: boolean;
    readonly redeem: boolean;
  };
  readonly direction: "deposit" | "redeem";
  readonly tokenIn: string;
  readonly tokenOut: string;
}

export interface BaselineEtherTokenNativeRedeemFacts {
  readonly familyId: "protocol:ethertoken-native-redeem";
  readonly token: string;
  readonly nativeAnchor: string;
  readonly tokenIn: string;
  readonly tokenOut: string;
}

export interface BaselineSelfBurnNativeFacts {
  readonly familyId: "protocol:self-burn-native";
  readonly token: string;
  readonly nativeAnchor: string;
  readonly tokenIn: string;
  readonly tokenOut: string;
}

export interface BaselineAstraTokenWeightFacts {
  readonly token: string;
  readonly weight: string;
  readonly codeHash: string;
}

export interface BaselineAstraBehaviorBindingFacts {
  readonly interfaceMode: "erc165" | "legacy-abi";
  readonly changesEnabled: true;
  readonly totalPercents: string;
  readonly changeFee: string;
  readonly inLendingMode: string | null;
  readonly activeProof: "registry-bound-effect-delta";
}

export interface BaselineAstraMultiTokenFacts {
  readonly familyId: "protocol:astra-multitoken";
  readonly target: string;
  readonly tokens: readonly string[];
  readonly tokenWeights: readonly BaselineAstraTokenWeightFacts[];
  readonly behaviorBinding: BaselineAstraBehaviorBindingFacts;
  readonly tokenIn: string;
  readonly tokenOut: string;
}

export interface BaselineEigenpieFacts {
  readonly familyId: "protocol:eigenpie";
  readonly target: string;
  readonly asset: string;
  readonly receipt: string;
  readonly tokenIn: string;
  readonly tokenOut: string;
}

export interface BaselineCurveUnderlyingFacts {
  readonly familyId: "curve-underlying";
  readonly pool: string;
  readonly coins: readonly string[];
  readonly registry: string;
  readonly handlers: readonly string[];
  readonly lookupSemantics:
    "get_registry_handlers_from_pool+get_underlying_coins";
  readonly verifiedDirections: readonly {
    readonly i: number;
    readonly j: number;
    readonly tokenIn: string;
    readonly tokenOut: string;
  }[];
  readonly i: number;
  readonly j: number;
  readonly tokenIn: string;
  readonly tokenOut: string;
}

/**
 * Maps legacy raw semantic items to the challenger canonical identity for
 * stages that carry route identities. Only `edges` currently has a wired
 * normalizer; other stages pass through unchanged until their comparators
 * land, so a missing mapping never silently drops a legacy item.
 */
export function normalizeBaselineMigrationItems(
  stage: ArchitectureMigrationStage | CommonGraphMigrationStage,
  items: readonly RawMigrationSemanticItem[],
): readonly RawMigrationSemanticItem[] {
  if (stage === "instances") {
    return Object.freeze(items.map((item) =>
      normalizeByFamily(item, {
        "univ3-standard": normalizeBaselineUniv3InstanceItem,
        univ4: normalizeBaselineUniv4InstanceItem,
        "protocol:psm": normalizeBaselinePsmInstanceItem,
        "protocol:wsteth": normalizeBaselineWstethInstanceItem,
        "protocol:goldx": normalizeBaselineGoldxInstanceItem,
        "protocol:rocksolid": normalizeBaselineRocksolidInstanceItem,
        "protocol:metronome-hgusdc":
          normalizeBaselineMetronomeHgUsdcInstanceItem,
        "protocol:metronome-synth":
          normalizeBaselineMetronomeSynthInstanceItem,
        "protocol:erc4626-silo-redeem":
          normalizeBaselineErc4626SiloRedeemInstanceItem,
        "protocol:erc4626": normalizeBaselineErc4626InstanceItem,
        "protocol:ethertoken-native-redeem":
          normalizeBaselineEtherTokenNativeRedeemInstanceItem,
        "protocol:self-burn-native":
          normalizeBaselineSelfBurnNativeInstanceItem,
        "protocol:astra-multitoken":
          normalizeBaselineAstraMultiTokenInstanceItem,
        "protocol:eigenpie": normalizeBaselineEigenpieInstanceItem,
        "curve-underlying": normalizeBaselineCurveUnderlyingInstanceItem,
        default: normalizeBaselineUniv2InstanceItem,
      })
    ));
  }
  if (stage === "prices") {
    return Object.freeze(items.map((item) =>
      normalizeByFamily(item, {
        "univ3-standard": normalizeBaselineUniv3PriceItem,
        univ4: normalizeBaselineUniv4PriceItem,
        "protocol:psm": normalizeBaselinePsmPriceItem,
        "protocol:wsteth": normalizeBaselineWstethPriceItem,
        "protocol:goldx": normalizeBaselineGoldxPriceItem,
        "protocol:rocksolid": normalizeBaselineRocksolidPriceItem,
        "protocol:metronome-hgusdc":
          normalizeBaselineMetronomeHgUsdcPriceItem,
        "protocol:metronome-synth":
          normalizeBaselineMetronomeSynthPriceItem,
        "protocol:erc4626-silo-redeem":
          normalizeBaselineErc4626SiloRedeemPriceItem,
        "protocol:erc4626": normalizeBaselineErc4626PriceItem,
        "protocol:ethertoken-native-redeem":
          normalizeBaselineEtherTokenNativeRedeemPriceItem,
        "protocol:self-burn-native":
          normalizeBaselineSelfBurnNativePriceItem,
        "protocol:astra-multitoken":
          normalizeBaselineAstraMultiTokenPriceItem,
        "protocol:eigenpie": normalizeBaselineEigenpiePriceItem,
        "curve-underlying": normalizeBaselineCurveUnderlyingPriceItem,
        default: normalizeBaselineUniv2PriceItem,
      })
    ));
  }
  if (stage === "edges") {
    return Object.freeze(items.map((item) =>
      normalizeByFamily(item, {
        "univ3-standard": normalizeBaselineUniv3EdgeItem,
        univ4: normalizeBaselineUniv4EdgeItem,
        "protocol:psm": normalizeBaselinePsmEdgeItem,
        "protocol:wsteth": normalizeBaselineWstethEdgeItem,
        "protocol:goldx": normalizeBaselineGoldxEdgeItem,
        "protocol:rocksolid": normalizeBaselineRocksolidEdgeItem,
        "protocol:metronome-hgusdc":
          normalizeBaselineMetronomeHgUsdcEdgeItem,
        "protocol:metronome-synth":
          normalizeBaselineMetronomeSynthEdgeItem,
        "protocol:erc4626-silo-redeem":
          normalizeBaselineErc4626SiloRedeemEdgeItem,
        "protocol:erc4626": normalizeBaselineErc4626EdgeItem,
        "protocol:ethertoken-native-redeem":
          normalizeBaselineEtherTokenNativeRedeemEdgeItem,
        "protocol:self-burn-native":
          normalizeBaselineSelfBurnNativeEdgeItem,
        "protocol:astra-multitoken":
          normalizeBaselineAstraMultiTokenEdgeItem,
        "protocol:eigenpie": normalizeBaselineEigenpieEdgeItem,
        "curve-underlying": normalizeBaselineCurveUnderlyingEdgeItem,
        default: normalizeBaselineUniv2EdgeItem,
      })
    ));
  }
  if (stage === "enumeratedRoutes") {
    return Object.freeze(items.map((item) =>
      normalizeByFamily(item, {
        "univ3-standard": normalizeBaselineUniv3EnumeratedRouteItem,
        univ4: normalizeBaselineUniv4EnumeratedRouteItem,
        "protocol:psm": normalizeBaselinePsmEnumeratedRouteItem,
        "protocol:wsteth": normalizeBaselineWstethEnumeratedRouteItem,
        "protocol:goldx": normalizeBaselineGoldxEnumeratedRouteItem,
        "protocol:rocksolid": normalizeBaselineRocksolidEnumeratedRouteItem,
        "protocol:metronome-hgusdc":
          normalizeBaselineMetronomeHgUsdcEnumeratedRouteItem,
        "protocol:metronome-synth":
          normalizeBaselineMetronomeSynthEnumeratedRouteItem,
        "protocol:erc4626-silo-redeem":
          normalizeBaselineErc4626SiloRedeemEnumeratedRouteItem,
        "protocol:erc4626":
          normalizeBaselineErc4626EnumeratedRouteItem,
        "protocol:ethertoken-native-redeem":
          normalizeBaselineEtherTokenNativeRedeemEnumeratedRouteItem,
        "protocol:self-burn-native":
          normalizeBaselineSelfBurnNativeEnumeratedRouteItem,
        "protocol:astra-multitoken":
          normalizeBaselineAstraMultiTokenEnumeratedRouteItem,
        "protocol:eigenpie":
          normalizeBaselineEigenpieEnumeratedRouteItem,
        "curve-underlying":
          normalizeBaselineCurveUnderlyingEnumeratedRouteItem,
        default: normalizeBaselineUniv2EnumeratedRouteItem,
      })
    ));
  }
  if (stage === "exactQuotes") {
    return Object.freeze(items.map((item) =>
      normalizeByFamily(item, {
        "univ3-standard": normalizeBaselineUniv3ExactQuoteItem,
        univ4: normalizeBaselineUniv4ExactQuoteItem,
        "protocol:psm": normalizeBaselinePsmExactQuoteItem,
        "protocol:wsteth": normalizeBaselineWstethExactQuoteItem,
        "protocol:goldx": normalizeBaselineGoldxExactQuoteItem,
        "protocol:rocksolid": normalizeBaselineRocksolidExactQuoteItem,
        "protocol:metronome-hgusdc":
          normalizeBaselineMetronomeHgUsdcExactQuoteItem,
        "protocol:metronome-synth":
          normalizeBaselineMetronomeSynthExactQuoteItem,
        "protocol:erc4626-silo-redeem":
          normalizeBaselineErc4626SiloRedeemExactQuoteItem,
        "protocol:erc4626": normalizeBaselineErc4626ExactQuoteItem,
        "protocol:ethertoken-native-redeem":
          normalizeBaselineEtherTokenNativeRedeemExactQuoteItem,
        "protocol:self-burn-native":
          normalizeBaselineSelfBurnNativeExactQuoteItem,
        "protocol:astra-multitoken":
          normalizeBaselineAstraMultiTokenExactQuoteItem,
        "protocol:eigenpie": normalizeBaselineEigenpieExactQuoteItem,
        "curve-underlying": normalizeBaselineCurveUnderlyingExactQuoteItem,
        default: normalizeBaselineUniv2ExactQuoteItem,
      })
    ));
  }
  if (stage === "executionFragments") {
    return Object.freeze(items.map((item) => {
      const familyId = baselineFamilyId(item);
      if (familyId === "flash-loan:balancer-v2" ||
          familyId === "flash-loan:morpho") {
        return normalizeBaselineFundingExecutionFragmentItem(item);
      }
      return normalizeByFamily(item, {
        "univ3-standard": normalizeBaselineUniv3ExecutionFragmentItem,
        univ4: normalizeBaselineUniv4ExecutionFragmentItem,
        "protocol:psm": normalizeBaselinePsmExecutionFragmentItem,
        "protocol:wsteth": normalizeBaselineWstethExecutionFragmentItem,
        "protocol:goldx": normalizeBaselineGoldxExecutionFragmentItem,
        "protocol:rocksolid": normalizeBaselineRocksolidExecutionFragmentItem,
        "protocol:metronome-hgusdc":
          normalizeBaselineMetronomeHgUsdcExecutionFragmentItem,
        "protocol:metronome-synth":
          normalizeBaselineMetronomeSynthExecutionFragmentItem,
        "protocol:erc4626-silo-redeem":
          normalizeBaselineErc4626SiloRedeemExecutionFragmentItem,
        "protocol:erc4626":
          normalizeBaselineErc4626ExecutionFragmentItem,
        "protocol:ethertoken-native-redeem":
          normalizeBaselineEtherTokenNativeRedeemExecutionFragmentItem,
        "protocol:self-burn-native":
          normalizeBaselineSelfBurnNativeExecutionFragmentItem,
        "protocol:astra-multitoken":
          normalizeBaselineAstraMultiTokenExecutionFragmentItem,
        "protocol:eigenpie":
          normalizeBaselineEigenpieExecutionFragmentItem,
        "curve-underlying":
          normalizeBaselineCurveUnderlyingExecutionFragmentItem,
        default: normalizeBaselineUniv2ExecutionFragmentItem,
      });
    }));
  }
  if (stage === "finalSimulations") {
    return Object.freeze(items.map((item) => {
      const familyId = baselineFamilyId(item);
      if (familyId === "flash-loan:balancer-v2" ||
          familyId === "flash-loan:morpho") {
        return normalizeBaselineFundingFinalSimulationItem(item);
      }
      return normalizeByFamily(item, {
        "univ3-standard": normalizeBaselineUniv3FinalSimulationItem,
        univ4: normalizeBaselineUniv4FinalSimulationItem,
        "protocol:psm": normalizeBaselinePsmFinalSimulationItem,
        "protocol:wsteth": normalizeBaselineWstethFinalSimulationItem,
        "protocol:goldx": normalizeBaselineGoldxFinalSimulationItem,
        "protocol:rocksolid": normalizeBaselineRocksolidFinalSimulationItem,
        "protocol:metronome-hgusdc":
          normalizeBaselineMetronomeHgUsdcFinalSimulationItem,
        "protocol:metronome-synth":
          normalizeBaselineMetronomeSynthFinalSimulationItem,
        "protocol:erc4626-silo-redeem":
          normalizeBaselineErc4626SiloRedeemFinalSimulationItem,
        "protocol:erc4626":
          normalizeBaselineErc4626FinalSimulationItem,
        "protocol:ethertoken-native-redeem":
          normalizeBaselineEtherTokenNativeRedeemFinalSimulationItem,
        "protocol:self-burn-native":
          normalizeBaselineSelfBurnNativeFinalSimulationItem,
        "protocol:astra-multitoken":
          normalizeBaselineAstraMultiTokenFinalSimulationItem,
        "protocol:eigenpie":
          normalizeBaselineEigenpieFinalSimulationItem,
        "curve-underlying":
          normalizeBaselineCurveUnderlyingFinalSimulationItem,
        default: normalizeBaselineUniv2FinalSimulationItem,
      });
    }));
  }
  return Object.freeze(items.map((item) =>
    item
  ));
}

function baselineFamilyId(item: RawMigrationSemanticItem): string | undefined {
  return (item.value as {
    readonly baselineFacts?: { readonly familyId?: string };
  })?.baselineFacts?.familyId;
}

function normalizeByFamily(
  item: RawMigrationSemanticItem,
  handlers: {
    readonly "univ3-standard": (item: RawMigrationSemanticItem) =>
      RawMigrationSemanticItem;
    readonly univ4: (item: RawMigrationSemanticItem) =>
      RawMigrationSemanticItem;
    readonly "protocol:psm": (item: RawMigrationSemanticItem) =>
      RawMigrationSemanticItem;
    readonly "protocol:wsteth": (item: RawMigrationSemanticItem) =>
      RawMigrationSemanticItem;
    readonly "protocol:goldx": (item: RawMigrationSemanticItem) =>
      RawMigrationSemanticItem;
    readonly "protocol:rocksolid": (item: RawMigrationSemanticItem) =>
      RawMigrationSemanticItem;
    readonly "protocol:metronome-hgusdc": (
      item: RawMigrationSemanticItem,
    ) => RawMigrationSemanticItem;
    readonly "protocol:metronome-synth": (
      item: RawMigrationSemanticItem,
    ) => RawMigrationSemanticItem;
    readonly "protocol:erc4626-silo-redeem": (
      item: RawMigrationSemanticItem,
    ) => RawMigrationSemanticItem;
    readonly "protocol:erc4626": (
      item: RawMigrationSemanticItem,
    ) => RawMigrationSemanticItem;
    readonly "protocol:ethertoken-native-redeem": (
      item: RawMigrationSemanticItem,
    ) => RawMigrationSemanticItem;
    readonly "protocol:self-burn-native": (
      item: RawMigrationSemanticItem,
    ) => RawMigrationSemanticItem;
    readonly "protocol:astra-multitoken": (
      item: RawMigrationSemanticItem,
    ) => RawMigrationSemanticItem;
    readonly "protocol:eigenpie": (
      item: RawMigrationSemanticItem,
    ) => RawMigrationSemanticItem;
    readonly "curve-underlying": (
      item: RawMigrationSemanticItem,
    ) => RawMigrationSemanticItem;
    readonly default: (item: RawMigrationSemanticItem) =>
      RawMigrationSemanticItem;
  },
): RawMigrationSemanticItem {
  const familyId = baselineFamilyId(item);
  if (familyId === "univ3-standard") return handlers["univ3-standard"](item);
  if (familyId === "univ4") return handlers.univ4(item);
  if (familyId === "protocol:psm") return handlers["protocol:psm"](item);
  if (familyId === "protocol:wsteth") {
    return handlers["protocol:wsteth"](item);
  }
  if (familyId === "protocol:goldx") {
    return handlers["protocol:goldx"](item);
  }
  if (familyId === "protocol:rocksolid") {
    return handlers["protocol:rocksolid"](item);
  }
  if (familyId === "protocol:metronome-hgusdc") {
    return handlers["protocol:metronome-hgusdc"](item);
  }
  if (familyId === "protocol:metronome-synth") {
    return handlers["protocol:metronome-synth"](item);
  }
  if (familyId === "protocol:erc4626-silo-redeem") {
    return handlers["protocol:erc4626-silo-redeem"](item);
  }
  if (familyId === "protocol:erc4626") {
    return handlers["protocol:erc4626"](item);
  }
  if (familyId === "protocol:ethertoken-native-redeem") {
    return handlers["protocol:ethertoken-native-redeem"](item);
  }
  if (familyId === "protocol:self-burn-native") {
    return handlers["protocol:self-burn-native"](item);
  }
  if (familyId === "protocol:astra-multitoken") {
    return handlers["protocol:astra-multitoken"](item);
  }
  if (familyId === "protocol:eigenpie") {
    return handlers["protocol:eigenpie"](item);
  }
  if (familyId === "curve-underlying") {
    return handlers["curve-underlying"](item);
  }
  return handlers.default(item);
}

interface BaselineUniv2ExecutionNode {
  readonly adapterId: string;
  readonly target: string;
  readonly tokenIn: string;
  readonly tokenOut: string;
  readonly amount: string;
  readonly params: {
    readonly amount0Out: string;
    readonly amount1Out: string;
    readonly to: string;
  };
  readonly children: readonly BaselineUniv2TransferNode[];
}

interface BaselineUniv2TransferNode {
  readonly adapterId: string;
  readonly target: string;
  readonly tokenIn: string;
  readonly tokenOut: string;
  readonly amount: string;
  readonly params: {
    readonly to: string;
    readonly amount: string;
  };
  readonly children: readonly unknown[];
}

export function normalizeBaselineUniv2ExecutionFragmentItem(
  item: RawMigrationSemanticItem,
): RawMigrationSemanticItem {
  const value = item.value as {
    readonly baselineFacts?: Partial<BaselineUniv2EdgeFacts>;
    readonly amountIn?: unknown;
    readonly amountOut?: unknown;
    readonly minAmountOut?: unknown;
    readonly node?: BaselineUniv2ExecutionNode;
  };
  const facts = value?.baselineFacts;
  if (
    facts === undefined ||
    facts.familyId !== "univ2-standard" ||
    typeof facts.pool !== "string" ||
    typeof facts.token0 !== "string" ||
    typeof facts.token1 !== "string" ||
    typeof facts.tokenIn !== "string" ||
    typeof facts.tokenOut !== "string" ||
    typeof facts.feeBps !== "string" ||
    typeof facts.factory !== "string" ||
    typeof facts.reversePool !== "string" ||
    typeof value.amountIn !== "string" ||
    typeof value.amountOut !== "string" ||
    typeof value.minAmountOut !== "string" ||
    value.node === undefined ||
    value.node.adapterId !== "univ2-swap" ||
    typeof value.node.amount !== "string" ||
    value.node.params === undefined ||
    typeof value.node.params.amount0Out !== "string" ||
    typeof value.node.params.amount1Out !== "string" ||
    typeof value.node.params.to !== "string" ||
    !Array.isArray(value.node.children) ||
    value.node.children.length !== 1
  ) {
    return item;
  }
  const completeFacts: Required<BaselineUniv2EdgeFacts> = {
    familyId: "univ2-standard",
    pool: facts.pool,
    token0: facts.token0,
    token1: facts.token1,
    tokenIn: facts.tokenIn,
    tokenOut: facts.tokenOut,
    feeBps: facts.feeBps,
    factory: facts.factory,
    reversePool: facts.reversePool,
  };
  const derived = deriveUniv2CanonicalEdge(completeFacts);
  const child = value.node.children[0]!;
  if (
    child.adapterId !== "erc20-transfer" ||
    typeof child.target !== "string" ||
    typeof child.tokenIn !== "string" ||
    typeof child.tokenOut !== "string" ||
    typeof child.amount !== "string" ||
    child.params === undefined ||
    typeof child.params.to !== "string" ||
    typeof child.params.amount !== "string" ||
    !Array.isArray(child.children) ||
    child.children.length !== 0
  ) {
    return item;
  }
  const node = Object.freeze({
    adapterId: value.node.adapterId,
    target: canonicalAddress(value.node.target),
    tokenIn: canonicalAddress(value.node.tokenIn),
    tokenOut: canonicalAddress(value.node.tokenOut),
    amount: BigInt(value.node.amount),
    params: Object.freeze({
      amount0Out: BigInt(value.node.params.amount0Out),
      amount1Out: BigInt(value.node.params.amount1Out),
      to: value.node.params.to,
    }),
    children: Object.freeze([Object.freeze({
      adapterId: child.adapterId,
      target: canonicalAddress(child.target),
      tokenIn: canonicalAddress(child.tokenIn),
      tokenOut: canonicalAddress(child.tokenOut),
      amount: BigInt(child.amount),
      params: Object.freeze({
        to: canonicalAddress(child.params.to),
        amount: BigInt(child.params.amount),
      }),
      children: Object.freeze([]),
    })]),
  });
  return Object.freeze({
    id: `${derived.id}\u001fexec:${value.amountIn}`,
    value: Object.freeze({
      routeKey: derived.value.routeKey,
      tokenIn: derived.value.tokenIn,
      tokenOut: derived.value.tokenOut,
      canonicalEdgeId: derived.id,
      amountIn: value.amountIn,
      amountOut: value.amountOut,
      minAmountOut: value.minAmountOut,
      actionAdapterId: value.node.adapterId,
      executionTarget: canonicalAddress(value.node.target),
      nodeFingerprint: hashCanonical(node),
    }),
  });
}

export function normalizeBaselineUniv2FinalSimulationItem(
  item: RawMigrationSemanticItem,
): RawMigrationSemanticItem {
  const value = item.value as {
    readonly baselineFacts?: Partial<BaselineUniv2EdgeFacts>;
    readonly amountIn?: unknown;
    readonly amountOut?: unknown;
    readonly minAmountOut?: unknown;
    readonly effects?: readonly {
      readonly kind?: unknown;
      readonly token?: unknown;
      readonly account?: unknown;
      readonly direction?: unknown;
    }[];
    readonly conservation?: unknown;
    readonly repayment?: unknown;
    readonly evInput?: unknown;
  };
  const facts = value?.baselineFacts;
  if (
    facts === undefined ||
    facts.familyId !== "univ2-standard" ||
    typeof facts.pool !== "string" ||
    typeof facts.token0 !== "string" ||
    typeof facts.token1 !== "string" ||
    typeof facts.tokenIn !== "string" ||
    typeof facts.tokenOut !== "string" ||
    typeof facts.feeBps !== "string" ||
    typeof facts.factory !== "string" ||
    typeof facts.reversePool !== "string" ||
    typeof value.amountIn !== "string" ||
    typeof value.amountOut !== "string" ||
    typeof value.minAmountOut !== "string" ||
    !Array.isArray(value.effects) ||
    value.effects.length !== 4 ||
    value.conservation !== "conserved" ||
    value.repayment !== "satisfied" ||
    value.evInput === null ||
    typeof value.evInput !== "object"
  ) {
    return item;
  }
  const completeFacts: Required<BaselineUniv2EdgeFacts> = {
    familyId: "univ2-standard",
    pool: facts.pool,
    token0: facts.token0,
    token1: facts.token1,
    tokenIn: facts.tokenIn,
    tokenOut: facts.tokenOut,
    feeBps: facts.feeBps,
    factory: facts.factory,
    reversePool: facts.reversePool,
  };
  const derived = deriveUniv2CanonicalEdge(completeFacts);
  const effects = value.effects.map((effect) => {
    if (
      effect.kind !== "token-delta" ||
      typeof effect.token !== "string" ||
      (effect.account !== "executor" &&
        effect.account !== "route-target") ||
      (effect.direction !== "increase" && effect.direction !== "decrease")
    ) {
      throw new Error("univ2 baseline final simulation effect is malformed");
    }
    return Object.freeze({
      kind: "token-delta",
      token: canonicalAddress(effect.token),
      account: effect.account,
      direction: effect.direction,
    });
  });
  const evInput = value.evInput as {
    readonly amountIn?: unknown;
    readonly amountOut?: unknown;
  };
  if (
    typeof evInput.amountIn !== "string" ||
    typeof evInput.amountOut !== "string"
  ) {
    return item;
  }
  return Object.freeze({
    id: `${derived.id}\u001fsim:${value.amountIn}`,
    value: Object.freeze({
      routeKey: derived.value.routeKey,
      tokenIn: derived.value.tokenIn,
      tokenOut: derived.value.tokenOut,
      canonicalEdgeId: derived.id,
      amountIn: value.amountIn,
      amountOut: value.amountOut,
      minAmountOut: value.minAmountOut,
      effectsFingerprint: hashCanonical(effects),
      conservation: value.conservation,
      repayment: value.repayment,
      evInput: Object.freeze({
        amountIn: evInput.amountIn,
        amountOut: evInput.amountOut,
      }),
    }),
  });
}

export function normalizeBaselineUniv2ExactQuoteItem(
  item: RawMigrationSemanticItem,
): RawMigrationSemanticItem {
  const value = item.value as {
    readonly baselineFacts?: Partial<BaselineUniv2EdgeFacts>;
    readonly amountIn?: unknown;
    readonly amountOut?: unknown;
    readonly feeBps?: unknown;
  };
  const facts = value?.baselineFacts;
  if (
    facts === undefined ||
    facts.familyId !== "univ2-standard" ||
    typeof facts.pool !== "string" ||
    typeof facts.token0 !== "string" ||
    typeof facts.token1 !== "string" ||
    typeof facts.tokenIn !== "string" ||
    typeof facts.tokenOut !== "string" ||
    typeof facts.feeBps !== "string" ||
    typeof facts.factory !== "string" ||
    typeof facts.reversePool !== "string" ||
    typeof value.amountIn !== "string" ||
    typeof value.amountOut !== "string" ||
    typeof value.feeBps !== "string"
  ) {
    return item;
  }
  const completeFacts: Required<BaselineUniv2EdgeFacts> = {
    familyId: "univ2-standard",
    pool: facts.pool,
    token0: facts.token0,
    token1: facts.token1,
    tokenIn: facts.tokenIn,
    tokenOut: facts.tokenOut,
    feeBps: facts.feeBps,
    factory: facts.factory,
    reversePool: facts.reversePool,
  };
  const derived = deriveUniv2CanonicalEdge(completeFacts);
  return Object.freeze({
    id: `${derived.id}\u001fexact:${value.amountIn}`,
    value: Object.freeze({
      routeKey: derived.value.routeKey,
      tokenIn: derived.value.tokenIn,
      tokenOut: derived.value.tokenOut,
      canonicalEdgeId: derived.id,
      amountIn: value.amountIn,
      amountOut: value.amountOut,
      feeBps: value.feeBps,
    }),
  });
}

export function normalizeBaselineUniv2EnumeratedRouteItem(
  item: RawMigrationSemanticItem,
): RawMigrationSemanticItem {
  const edge = normalizeBaselineUniv2EdgeItem(item);
  if (edge === item) return item;
  const order = (item.value as { readonly order?: unknown }).order;
  if (typeof order !== "number" || !Number.isSafeInteger(order) || order < 0) {
    throw new Error(
      "univ2 baseline enumerated route item must carry a non-negative order",
    );
  }
  return Object.freeze({
    id: edge.id,
    value: Object.freeze({
      ...(edge.value as Record<string, unknown>),
      order,
    }),
  });
}

/**
 * Replays the challenger `familyRouteCanonicalEdgeId` derivation for a
 * standard UniV2 edge from legacy facts only. The canonical id is:
 *
 *   familyId \x1f instanceKey \x1f target \x1f tokenIn>tokenOut
 *     \x1f hashCanonical({
 *         namespace: "adapter-family-graph-route-v1",
 *         routeKey, routeBindingFingerprint, venueIdentityHash,
 *       })
 *
 * and the value is normalized to the challenger edge value shape so the
 * semantic hash comparison is meaningful instead of comparing raw legacy
 * wrappers.
 */
export function normalizeBaselineUniv2EdgeItem(
  item: RawMigrationSemanticItem,
): RawMigrationSemanticItem {
  const value = item.value as {
    readonly baselineFacts?: Partial<BaselineUniv2EdgeFacts>;
  };
  const facts = value?.baselineFacts;
  if (
    facts === undefined ||
    facts.familyId !== "univ2-standard" ||
    typeof facts.pool !== "string" ||
    typeof facts.token0 !== "string" ||
    typeof facts.token1 !== "string" ||
    typeof facts.tokenIn !== "string" ||
    typeof facts.tokenOut !== "string" ||
    typeof facts.feeBps !== "string" ||
    typeof facts.factory !== "string" ||
    typeof facts.reversePool !== "string"
  ) {
    return item;
  }
  const completeFacts: Required<BaselineUniv2EdgeFacts> = {
    familyId: "univ2-standard",
    pool: facts.pool,
    token0: facts.token0,
    token1: facts.token1,
    tokenIn: facts.tokenIn,
    tokenOut: facts.tokenOut,
    feeBps: facts.feeBps,
    factory: facts.factory,
    reversePool: facts.reversePool,
  };
  const derived = deriveUniv2CanonicalEdge(completeFacts);
  return Object.freeze({
    id: derived.id,
    value: derived.value,
  });
}

export function normalizeBaselineUniv2InstanceItem(
  item: RawMigrationSemanticItem,
): RawMigrationSemanticItem {
  const value = item.value as {
    readonly baselineFacts?: Partial<BaselineUniv2EdgeFacts>;
  };
  const facts = value?.baselineFacts;
  if (
    facts === undefined ||
    facts.familyId !== "univ2-standard" ||
    typeof facts.pool !== "string" ||
    typeof facts.token0 !== "string" ||
    typeof facts.token1 !== "string" ||
    typeof facts.tokenIn !== "string" ||
    typeof facts.tokenOut !== "string" ||
    typeof facts.feeBps !== "string" ||
    typeof facts.factory !== "string" ||
    typeof facts.reversePool !== "string"
  ) {
    return item;
  }
  const completeFacts: Required<BaselineUniv2EdgeFacts> = {
    familyId: "univ2-standard",
    pool: facts.pool,
    token0: facts.token0,
    token1: facts.token1,
    tokenIn: facts.tokenIn,
    tokenOut: facts.tokenOut,
    feeBps: facts.feeBps,
    factory: facts.factory,
    reversePool: facts.reversePool,
  };
  const derived = deriveUniv2CanonicalFacts(completeFacts);
  const staticBindingFingerprint = hashCanonical({
    capability:
      UNIV2_CATALOG_FAMILY.hashes.instance.contentHash,
    projection: Object.freeze({
      pool: derived.pool,
      token0: derived.token0,
      token1: derived.token1,
      feeRule: Object.freeze({ ...derived.feeRule }),
      factoryBinding: Object.freeze({
        factory: derived.factory,
        reversePool: derived.reversePool,
      }),
    }),
    sharedBindings: Object.freeze([]),
  });
  return Object.freeze({
    id: derived.lowerPool,
    value: Object.freeze({
      familyId: "univ2-standard",
      instanceKey: derived.lowerPool,
      staticBindingFingerprint,
    }),
  });
}

export function normalizeBaselineUniv2PriceItem(
  item: RawMigrationSemanticItem,
): RawMigrationSemanticItem {
  const value = item.value as {
    readonly baselineFacts?: Partial<BaselineUniv2EdgeFacts>;
    readonly mid?: {
      readonly kind?: unknown;
      readonly pool?: unknown;
      readonly mid?: unknown;
      readonly feeBps?: unknown;
      readonly reserveA?: unknown;
      readonly reserveB?: unknown;
      readonly depthProxy?: unknown;
    };
  };
  const facts = value?.baselineFacts;
  const mid = value?.mid;
  if (
    facts === undefined ||
    facts.familyId !== "univ2-standard" ||
    typeof facts.pool !== "string" ||
    typeof facts.token0 !== "string" ||
    typeof facts.token1 !== "string" ||
    typeof facts.tokenIn !== "string" ||
    typeof facts.tokenOut !== "string" ||
    typeof facts.feeBps !== "string" ||
    typeof facts.factory !== "string" ||
    typeof facts.reversePool !== "string" ||
    mid === undefined ||
    mid.kind !== "v2" ||
    typeof mid.mid !== "number" ||
    typeof mid.feeBps !== "number" ||
    (typeof mid.reserveA !== "string" && typeof mid.reserveA !== "bigint") ||
    (typeof mid.reserveB !== "string" && typeof mid.reserveB !== "bigint") ||
    typeof mid.depthProxy !== "number"
  ) {
    return item;
  }
  const completeFacts: Required<BaselineUniv2EdgeFacts> = {
    familyId: "univ2-standard",
    pool: facts.pool,
    token0: facts.token0,
    token1: facts.token1,
    tokenIn: facts.tokenIn,
    tokenOut: facts.tokenOut,
    feeBps: facts.feeBps,
    factory: facts.factory,
    reversePool: facts.reversePool,
  };
  const derived = deriveUniv2CanonicalFacts(completeFacts);
  const routeEdge = Object.freeze({
    adapterId: "univ2-swap",
    instanceKey: derived.lowerPool,
    target: derived.pool,
    tokenIn: derived.tokenIn,
    tokenOut: derived.tokenOut,
    slotKind: "swap" as const,
    poolToken0: derived.token0,
    poolToken1: derived.token1,
    v2FeeBps: derived.feeRule.feeBps.toString(),
    factory: derived.factory,
    edgeKind: "swap" as const,
    leavesStandingPosition: false,
  });
  return Object.freeze({
    id: item.id,
    value: Object.freeze({
      stateKey: derived.lowerPool,
      mid: Object.freeze({
        kind: "v2",
        pool: derived.pool,
        edges: Object.freeze([routeEdge]),
        mid: mid.mid,
        feeBps: mid.feeBps,
        reserveA: BigInt(mid.reserveA).toString(),
        reserveB: BigInt(mid.reserveB).toString(),
        depthProxy: mid.depthProxy,
      }),
    }),
  });
}

function deriveUniv2CanonicalFacts(
  facts: Required<BaselineUniv2EdgeFacts>,
): {
  readonly pool: string;
  readonly token0: string;
  readonly token1: string;
  readonly tokenIn: string;
  readonly tokenOut: string;
  readonly factory: string;
  readonly reversePool: string;
  readonly feeRule: ReturnType<typeof uniV2FeeRuleForFactory>;
  readonly lowerPool: string;
  readonly lowerTokenIn: string;
  readonly lowerTokenOut: string;
  readonly routeKeyValue: string;
  readonly canonicalId: string;
} {
  const pool = canonicalAddress(facts.pool);
  const token0 = canonicalAddress(facts.token0);
  const token1 = canonicalAddress(facts.token1);
  const tokenIn = canonicalAddress(facts.tokenIn);
  const tokenOut = canonicalAddress(facts.tokenOut);
  const factory = canonicalAddress(facts.factory);
  const reversePool = canonicalAddress(facts.reversePool);
  const feeRule = uniV2FeeRuleForFactory(factory);
  if (BigInt(facts.feeBps) !== feeRule.feeBps) {
    throw new Error(
      `univ2 baseline edge feeBps ${facts.feeBps} does not match ` +
        `factory rule ${feeRule.feeBps}`,
    );
  }
  const bindingFingerprint = hashCanonical({
    pool,
    token0,
    token1,
    feeRule: Object.freeze({ ...feeRule }),
    factoryBinding: Object.freeze({ factory, reversePool }),
  });
  const lowerPool = lowerAddress(pool);
  const lowerTokenIn = lowerAddress(tokenIn);
  const lowerTokenOut = lowerAddress(tokenOut);
  const venueIdentityHash = hashCanonical({
    kind: "address-pool",
    pool: lowerPool,
  });
  const routeKeyValue = [
    "univ2-standard",
    lowerPool,
    lowerTokenIn,
    lowerTokenOut,
  ].join("\u001f");
  const executionVariantKey = hashCanonical({
    namespace: "adapter-family-graph-route-v1",
    routeKey: routeKeyValue,
    routeBindingFingerprint: bindingFingerprint,
    venueIdentityHash,
  });
  const canonicalId = [
    "univ2-standard",
    lowerPool,
    lowerPool,
    `${lowerTokenIn}>${lowerTokenOut}`,
    executionVariantKey,
  ].join("\u001f");
  return Object.freeze({
    pool,
    token0,
    token1,
    tokenIn,
    tokenOut,
    factory,
    reversePool,
    feeRule,
    lowerPool,
    lowerTokenIn,
    lowerTokenOut,
    routeKeyValue,
    canonicalId,
  });
}

function deriveUniv2CanonicalEdge(
  facts: Required<BaselineUniv2EdgeFacts>,
): {
  readonly id: string;
  readonly value: {
    readonly routeKey: string;
    readonly tokenIn: string;
    readonly tokenOut: string;
    readonly canonicalEdgeId: string;
  };
} {
  const derived = deriveUniv2CanonicalFacts(facts);
  return Object.freeze({
    id: derived.canonicalId,
    value: Object.freeze({
      routeKey: derived.routeKeyValue,
      tokenIn: derived.tokenIn,
      tokenOut: derived.tokenOut,
      canonicalEdgeId: derived.canonicalId,
    }),
  });
}

function univ3FactsGuard(
  facts: Partial<BaselineUniv3EdgeFacts> | undefined,
): facts is Required<BaselineUniv3EdgeFacts> {
  return facts !== undefined &&
    facts.familyId === "univ3-standard" &&
    typeof facts.pool === "string" &&
    typeof facts.token0 === "string" &&
    typeof facts.token1 === "string" &&
    typeof facts.tokenIn === "string" &&
    typeof facts.tokenOut === "string" &&
    typeof facts.fee === "string" &&
    typeof facts.tickSpacing === "number" &&
    typeof facts.factory === "string" &&
    typeof facts.reversePool === "string" &&
    (facts.quoter === null || typeof facts.quoter === "string") &&
    (facts.router === null || typeof facts.router === "string") &&
    typeof facts.quoterProvenance === "string";
}

function deriveUniv3CanonicalFacts(
  facts: Required<BaselineUniv3EdgeFacts>,
): {
  readonly pool: string;
  readonly token0: string;
  readonly token1: string;
  readonly tokenIn: string;
  readonly tokenOut: string;
  readonly factory: string;
  readonly reversePool: string;
  readonly quoter: string | null;
  readonly router: string | null;
  readonly fee: bigint;
  readonly tickSpacing: number;
  readonly lowerPool: string;
  readonly lowerTokenIn: string;
  readonly lowerTokenOut: string;
  readonly routeKeyValue: string;
  readonly canonicalId: string;
} {
  const pool = canonicalAddress(facts.pool);
  const token0 = canonicalAddress(facts.token0);
  const token1 = canonicalAddress(facts.token1);
  const tokenIn = canonicalAddress(facts.tokenIn);
  const tokenOut = canonicalAddress(facts.tokenOut);
  const factory = canonicalAddress(facts.factory);
  const reversePool = canonicalAddress(facts.reversePool);
  const quoter = facts.quoter === null ? null : canonicalAddress(facts.quoter);
  const router = facts.router === null ? null : canonicalAddress(facts.router);
  const fee = BigInt(facts.fee);
  const bindingFingerprint = hashCanonical({
    pool,
    token0,
    token1,
    fee,
    tickSpacing: facts.tickSpacing,
    factoryBinding: Object.freeze({ factory, reversePool }),
    quoterBinding: Object.freeze({
      quoter,
      router,
      provenance: facts.quoterProvenance,
    }),
  });
  const lowerPool = lowerAddress(pool);
  const lowerTokenIn = lowerAddress(tokenIn);
  const lowerTokenOut = lowerAddress(tokenOut);
  const venueIdentityHash = hashCanonical({
    kind: "address-pool",
    pool: lowerPool,
  });
  const routeKeyValue = [
    "univ3-standard",
    lowerPool,
    lowerTokenIn,
    lowerTokenOut,
  ].join("\u001f");
  const executionVariantKey = hashCanonical({
    namespace: "adapter-family-graph-route-v1",
    routeKey: routeKeyValue,
    routeBindingFingerprint: bindingFingerprint,
    venueIdentityHash,
  });
  const canonicalId = [
    "univ3-standard",
    lowerPool,
    lowerPool,
    `${lowerTokenIn}>${lowerTokenOut}`,
    executionVariantKey,
  ].join("\u001f");
  return Object.freeze({
    pool,
    token0,
    token1,
    tokenIn,
    tokenOut,
    factory,
    reversePool,
    quoter,
    router,
    fee,
    tickSpacing: facts.tickSpacing,
    lowerPool,
    lowerTokenIn,
    lowerTokenOut,
    routeKeyValue,
    canonicalId,
  });
}

function univ4FactsGuard(
  facts: Partial<BaselineUniv4EdgeFacts> | undefined,
): facts is Required<BaselineUniv4EdgeFacts> {
  return facts !== undefined &&
    facts.familyId === "univ4" &&
    typeof facts.manager === "string" &&
    typeof facts.poolId === "string" &&
    typeof facts.currency0 === "string" &&
    typeof facts.currency1 === "string" &&
    typeof facts.fee === "number" &&
    typeof facts.tickSpacing === "number" &&
    typeof facts.hooks === "string" &&
    typeof facts.graphToken0 === "string" &&
    typeof facts.graphToken1 === "string" &&
    typeof facts.tokenIn === "string" &&
    typeof facts.tokenOut === "string" &&
    typeof facts.stateView === "string" &&
    typeof facts.quoter === "string" &&
    typeof facts.managerCodeHash === "string" &&
    typeof facts.lpFee === "string" &&
    facts.hookPolicy === "no-hook";
}

function univ4FactsOf(item: RawMigrationSemanticItem) {
  const facts = (item.value as {
    readonly baselineFacts?: Partial<BaselineUniv4EdgeFacts>;
  })?.baselineFacts;
  if (!univ4FactsGuard(facts)) return null;
  return facts;
}

function deriveUniv4CanonicalFacts(
  facts: Required<BaselineUniv4EdgeFacts>,
): {
  readonly manager: string;
  readonly poolId: string;
  readonly currency0: string;
  readonly currency1: string;
  readonly fee: number;
  readonly tickSpacing: number;
  readonly hooks: string;
  readonly graphToken0: string;
  readonly graphToken1: string;
  readonly tokenIn: string;
  readonly tokenOut: string;
  readonly stateView: string;
  readonly quoter: string;
  readonly managerCodeHash: string;
  readonly lpFee: bigint;
  readonly lowerManager: string;
  readonly lowerPoolId: string;
  readonly lowerTokenIn: string;
  readonly lowerTokenOut: string;
  readonly instanceKeyValue: string;
  readonly routeKeyValue: string;
  readonly canonicalId: string;
} {
  const manager = canonicalAddress(facts.manager);
  const poolId = facts.poolId.toLowerCase();
  const currency0 = canonicalAddress(facts.currency0);
  const currency1 = canonicalAddress(facts.currency1);
  const hooks = canonicalAddress(facts.hooks);
  const graphToken0 = canonicalAddress(facts.graphToken0);
  const graphToken1 = canonicalAddress(facts.graphToken1);
  const tokenIn = canonicalAddress(facts.tokenIn);
  const tokenOut = canonicalAddress(facts.tokenOut);
  const stateView = canonicalAddress(facts.stateView);
  const quoter = canonicalAddress(facts.quoter);
  const managerCodeHash = facts.managerCodeHash.toLowerCase();
  const lpFee = BigInt(facts.lpFee);
  const poolKey = Object.freeze({
    currency0,
    currency1,
    fee: facts.fee,
    tickSpacing: facts.tickSpacing,
    hooks,
  });
  const bindingFingerprint = hashCanonical({
    poolId,
    poolKey,
    managerBinding: Object.freeze({
      manager,
      stateView,
      quoter,
      managerCodeHash,
    }),
    hookPolicy: facts.hookPolicy,
  });
  const lowerManager = lowerAddress(manager);
  const lowerPoolId = poolId;
  const lowerTokenIn = lowerAddress(tokenIn);
  const lowerTokenOut = lowerAddress(tokenOut);
  const venueIdentityHash = hashCanonical({
    kind: "manager-pool-id",
    manager: lowerManager,
    poolId: lowerPoolId,
  });
  const routeKeyValue = [
    "univ4",
    lowerManager,
    lowerPoolId,
    lowerTokenIn,
    lowerTokenOut,
  ].join("\u001f");
  const executionVariantKey = hashCanonical({
    namespace: "adapter-family-graph-route-v1",
    routeKey: routeKeyValue,
    routeBindingFingerprint: bindingFingerprint,
    venueIdentityHash,
  });
  const instanceKeyValue = `${lowerManager}\u001f${lowerPoolId}`;
  const canonicalId = [
    "univ4",
    lowerManager,
    lowerPoolId,
    lowerManager,
    `${lowerTokenIn}>${lowerTokenOut}`,
    executionVariantKey,
  ].join("\u001f");
  return Object.freeze({
    manager,
    poolId,
    currency0,
    currency1,
    fee: facts.fee,
    tickSpacing: facts.tickSpacing,
    hooks,
    graphToken0,
    graphToken1,
    tokenIn,
    tokenOut,
    stateView,
    quoter,
    managerCodeHash,
    lpFee,
    lowerManager,
    lowerPoolId,
    lowerTokenIn,
    lowerTokenOut,
    instanceKeyValue,
    routeKeyValue,
    canonicalId,
  });
}

export function normalizeBaselineUniv4EdgeItem(
  item: RawMigrationSemanticItem,
): RawMigrationSemanticItem {
  const facts = univ4FactsOf(item);
  if (facts === null) return item;
  const derived = deriveUniv4CanonicalFacts(facts);
  return Object.freeze({
    id: derived.canonicalId,
    value: Object.freeze({
      routeKey: derived.routeKeyValue,
      tokenIn: derived.tokenIn,
      tokenOut: derived.tokenOut,
      canonicalEdgeId: derived.canonicalId,
    }),
  });
}

export function normalizeBaselineUniv4EnumeratedRouteItem(
  item: RawMigrationSemanticItem,
): RawMigrationSemanticItem {
  const edge = normalizeBaselineUniv4EdgeItem(item);
  if (edge === item) return item;
  const order = (item.value as { readonly order?: unknown }).order;
  if (typeof order !== "number" || !Number.isSafeInteger(order) || order < 0) {
    throw new Error(
      "univ4 baseline enumerated route item must carry a non-negative order",
    );
  }
  return Object.freeze({
    id: edge.id,
    value: Object.freeze({
      ...(edge.value as Record<string, unknown>),
      order,
    }),
  });
}

export function normalizeBaselineUniv4InstanceItem(
  item: RawMigrationSemanticItem,
): RawMigrationSemanticItem {
  const facts = univ4FactsOf(item);
  if (facts === null) return item;
  const derived = deriveUniv4CanonicalFacts(facts);
  const poolKey = Object.freeze({
    currency0: derived.currency0,
    currency1: derived.currency1,
    fee: derived.fee,
    tickSpacing: derived.tickSpacing,
    hooks: derived.hooks,
  });
  const staticBindingFingerprint = hashCanonical({
    capability: UNIV4_CATALOG_FAMILY.hashes.instance.contentHash,
    projection: Object.freeze({
      poolId: derived.poolId,
      poolKey,
      managerBinding: Object.freeze({
        manager: derived.manager,
        stateView: derived.stateView,
        quoter: derived.quoter,
        managerCodeHash: derived.managerCodeHash,
      }),
      hookPolicy: facts.hookPolicy,
    }),
    sharedBindings: Object.freeze([]),
  });
  return Object.freeze({
    id: derived.instanceKeyValue,
    value: Object.freeze({
      familyId: "univ4",
      instanceKey: derived.instanceKeyValue,
      staticBindingFingerprint,
    }),
  });
}

export function normalizeBaselineUniv4PriceItem(
  item: RawMigrationSemanticItem,
): RawMigrationSemanticItem {
  const facts = univ4FactsOf(item);
  if (facts === null) return item;
  const mid = (item.value as {
    readonly mid?: {
      readonly mid?: unknown;
      readonly feeBps?: unknown;
      readonly reserveA?: unknown;
      readonly reserveB?: unknown;
      readonly sqrtABX96?: unknown;
      readonly liquidity?: unknown;
      readonly depthProxy?: unknown;
    };
  })?.mid;
  if (
    mid === undefined ||
    typeof mid.mid !== "number" ||
    typeof mid.feeBps !== "number" ||
    (typeof mid.reserveA !== "string" && typeof mid.reserveA !== "bigint") ||
    (typeof mid.reserveB !== "string" && typeof mid.reserveB !== "bigint") ||
    (typeof mid.sqrtABX96 !== "string" && typeof mid.sqrtABX96 !== "bigint") ||
    (typeof mid.liquidity !== "string" && typeof mid.liquidity !== "bigint") ||
    typeof mid.depthProxy !== "number"
  ) {
    return item;
  }
  const derived = deriveUniv4CanonicalFacts(facts);
  const routeEdge = Object.freeze({
    adapterId: "univ4-unlock",
    instanceKey: derived.instanceKeyValue,
    target: derived.manager,
    tokenIn: derived.tokenIn,
    tokenOut: derived.tokenOut,
    slotKind: "swap" as const,
    poolId: derived.poolId,
    poolToken0: derived.graphToken0,
    poolToken1: derived.graphToken1,
    v4PoolKey: Object.freeze({
      currency0: derived.currency0,
      currency1: derived.currency1,
      fee: derived.fee,
      tickSpacing: derived.tickSpacing,
      hooks: derived.hooks,
    }),
    edgeKind: "swap" as const,
    leavesStandingPosition: false,
  });
  return Object.freeze({
    id: item.id,
    value: Object.freeze({
      stateKey: derived.poolId,
      mid: Object.freeze({
        kind: "v4",
        pool: derived.manager,
        edges: Object.freeze([routeEdge]),
        mid: mid.mid,
        feeBps: mid.feeBps,
        reserveA: BigInt(mid.reserveA).toString(),
        reserveB: BigInt(mid.reserveB).toString(),
        sqrtABX96: BigInt(mid.sqrtABX96).toString(),
        liquidity: BigInt(mid.liquidity).toString(),
        depthProxy: mid.depthProxy,
      }),
    }),
  });
}

export function normalizeBaselineUniv4ExactQuoteItem(
  item: RawMigrationSemanticItem,
): RawMigrationSemanticItem {
  const facts = univ4FactsOf(item);
  if (facts === null) return item;
  const value = item.value as {
    readonly amountIn?: unknown;
    readonly amountOut?: unknown;
  };
  if (typeof value.amountIn !== "string" || typeof value.amountOut !== "string") {
    return item;
  }
  const derived = deriveUniv4CanonicalFacts(facts);
  return Object.freeze({
    id: `${derived.canonicalId}\u001fexact:${value.amountIn}`,
    value: Object.freeze({
      routeKey: derived.routeKeyValue,
      tokenIn: derived.tokenIn,
      tokenOut: derived.tokenOut,
      canonicalEdgeId: derived.canonicalId,
      amountIn: value.amountIn,
      amountOut: value.amountOut,
      feeBps: (Number(derived.lpFee) / 100).toString(),
    }),
  });
}

export function normalizeBaselineUniv4ExecutionFragmentItem(
  item: RawMigrationSemanticItem,
): RawMigrationSemanticItem {
  const facts = univ4FactsOf(item);
  if (facts === null) return item;
  const value = item.value as {
    readonly amountIn?: unknown;
    readonly amountOut?: unknown;
    readonly minAmountOut?: unknown;
    readonly nodeFingerprint?: unknown;
  };
  if (
    typeof value.amountIn !== "string" ||
    typeof value.amountOut !== "string" ||
    typeof value.minAmountOut !== "string" ||
    typeof value.nodeFingerprint !== "string"
  ) {
    return item;
  }
  const derived = deriveUniv4CanonicalFacts(facts);
  return Object.freeze({
    id: `${derived.canonicalId}\u001fexec:${value.amountIn}`,
    value: Object.freeze({
      routeKey: derived.routeKeyValue,
      tokenIn: derived.tokenIn,
      tokenOut: derived.tokenOut,
      canonicalEdgeId: derived.canonicalId,
      amountIn: value.amountIn,
      amountOut: value.amountOut,
      minAmountOut: value.minAmountOut,
      actionAdapterId: "univ4-unlock",
      executionTarget: derived.manager,
      nodeFingerprint: value.nodeFingerprint,
    }),
  });
}

export function normalizeBaselineUniv4FinalSimulationItem(
  item: RawMigrationSemanticItem,
): RawMigrationSemanticItem {
  const facts = univ4FactsOf(item);
  if (facts === null) return item;
  const value = item.value as {
    readonly amountIn?: unknown;
    readonly amountOut?: unknown;
    readonly minAmountOut?: unknown;
    readonly effectsFingerprint?: unknown;
    readonly conservation?: unknown;
    readonly repayment?: unknown;
    readonly evInput?: unknown;
  };
  if (
    typeof value.amountIn !== "string" ||
    typeof value.amountOut !== "string" ||
    typeof value.minAmountOut !== "string" ||
    typeof value.effectsFingerprint !== "string" ||
    value.conservation !== "conserved" ||
    value.repayment !== "satisfied" ||
    value.evInput === null ||
    typeof value.evInput !== "object"
  ) {
    return item;
  }
  const evInput = value.evInput as {
    readonly amountIn?: unknown;
    readonly amountOut?: unknown;
  };
  if (
    typeof evInput.amountIn !== "string" ||
    typeof evInput.amountOut !== "string"
  ) {
    return item;
  }
  const derived = deriveUniv4CanonicalFacts(facts);
  return Object.freeze({
    id: `${derived.canonicalId}\u001fsim:${value.amountIn}`,
    value: Object.freeze({
      routeKey: derived.routeKeyValue,
      tokenIn: derived.tokenIn,
      tokenOut: derived.tokenOut,
      canonicalEdgeId: derived.canonicalId,
      amountIn: value.amountIn,
      amountOut: value.amountOut,
      minAmountOut: value.minAmountOut,
      effectsFingerprint: value.effectsFingerprint,
      conservation: value.conservation,
      repayment: value.repayment,
      evInput: Object.freeze({
        amountIn: evInput.amountIn,
        amountOut: evInput.amountOut,
      }),
    }),
  });
}

function univ3FactsOf(item: RawMigrationSemanticItem) {
  const facts = (item.value as {
    readonly baselineFacts?: Partial<BaselineUniv3EdgeFacts>;
  })?.baselineFacts;
  if (!univ3FactsGuard(facts)) return null;
  return facts;
}

export function normalizeBaselineUniv3EdgeItem(
  item: RawMigrationSemanticItem,
): RawMigrationSemanticItem {
  const facts = univ3FactsOf(item);
  if (facts === null) return item;
  const derived = deriveUniv3CanonicalFacts(facts);
  return Object.freeze({
    id: derived.canonicalId,
    value: Object.freeze({
      routeKey: derived.routeKeyValue,
      tokenIn: derived.tokenIn,
      tokenOut: derived.tokenOut,
      canonicalEdgeId: derived.canonicalId,
    }),
  });
}

export function normalizeBaselineUniv3EnumeratedRouteItem(
  item: RawMigrationSemanticItem,
): RawMigrationSemanticItem {
  const edge = normalizeBaselineUniv3EdgeItem(item);
  if (edge === item) return item;
  const order = (item.value as { readonly order?: unknown }).order;
  if (typeof order !== "number" || !Number.isSafeInteger(order) || order < 0) {
    throw new Error(
      "univ3 baseline enumerated route item must carry a non-negative order",
    );
  }
  return Object.freeze({
    id: edge.id,
    value: Object.freeze({
      ...(edge.value as Record<string, unknown>),
      order,
    }),
  });
}

export function normalizeBaselineUniv3InstanceItem(
  item: RawMigrationSemanticItem,
): RawMigrationSemanticItem {
  const facts = univ3FactsOf(item);
  if (facts === null) return item;
  const derived = deriveUniv3CanonicalFacts(facts);
  const staticBindingFingerprint = hashCanonical({
    capability: UNIV3_CATALOG_FAMILY.hashes.instance.contentHash,
    projection: Object.freeze({
      pool: derived.pool,
      token0: derived.token0,
      token1: derived.token1,
      fee: derived.fee,
      tickSpacing: derived.tickSpacing,
      factoryBinding: Object.freeze({
        factory: derived.factory,
        reversePool: derived.reversePool,
      }),
      quoterBinding: Object.freeze({
        quoter: derived.quoter,
        router: derived.router,
        provenance: facts.quoterProvenance,
      }),
    }),
    sharedBindings: Object.freeze([]),
  });
  return Object.freeze({
    id: derived.lowerPool,
    value: Object.freeze({
      familyId: "univ3-standard",
      instanceKey: derived.lowerPool,
      staticBindingFingerprint,
    }),
  });
}

export function normalizeBaselineUniv3PriceItem(
  item: RawMigrationSemanticItem,
): RawMigrationSemanticItem {
  const facts = univ3FactsOf(item);
  if (facts === null) return item;
  const mid = (item.value as {
    readonly mid?: {
      readonly mid?: unknown;
      readonly feeBps?: unknown;
      readonly reserveA?: unknown;
      readonly reserveB?: unknown;
      readonly sqrtABX96?: unknown;
      readonly liquidity?: unknown;
      readonly depthProxy?: unknown;
    };
  })?.mid;
  if (
    mid === undefined ||
    typeof mid.mid !== "number" ||
    typeof mid.feeBps !== "number" ||
    (typeof mid.reserveA !== "string" && typeof mid.reserveA !== "bigint") ||
    (typeof mid.reserveB !== "string" && typeof mid.reserveB !== "bigint") ||
    (typeof mid.sqrtABX96 !== "string" && typeof mid.sqrtABX96 !== "bigint") ||
    (typeof mid.liquidity !== "string" && typeof mid.liquidity !== "bigint") ||
    typeof mid.depthProxy !== "number"
  ) {
    return item;
  }
  const derived = deriveUniv3CanonicalFacts(facts);
  const routeEdge = Object.freeze({
    adapterId: "univ3-swap",
    instanceKey: derived.lowerPool,
    target: derived.pool,
    tokenIn: derived.tokenIn,
    tokenOut: derived.tokenOut,
    slotKind: "swap" as const,
    poolToken0: derived.token0,
    poolToken1: derived.token1,
    v3Fee: Number(derived.fee),
    v3TickSpacing: derived.tickSpacing,
    factory: derived.factory,
    edgeKind: "swap" as const,
    leavesStandingPosition: false,
  });
  return Object.freeze({
    id: item.id,
    value: Object.freeze({
      stateKey: derived.lowerPool,
      mid: Object.freeze({
        kind: "v3",
        pool: derived.pool,
        edges: Object.freeze([routeEdge]),
        mid: mid.mid,
        feeBps: mid.feeBps,
        reserveA: BigInt(mid.reserveA).toString(),
        reserveB: BigInt(mid.reserveB).toString(),
        sqrtABX96: BigInt(mid.sqrtABX96).toString(),
        liquidity: BigInt(mid.liquidity).toString(),
        depthProxy: mid.depthProxy,
      }),
    }),
  });
}

export function normalizeBaselineUniv3ExactQuoteItem(
  item: RawMigrationSemanticItem,
): RawMigrationSemanticItem {
  const facts = univ3FactsOf(item);
  if (facts === null) return item;
  const value = item.value as {
    readonly amountIn?: unknown;
    readonly amountOut?: unknown;
  };
  if (typeof value.amountIn !== "string" || typeof value.amountOut !== "string") {
    return item;
  }
  const derived = deriveUniv3CanonicalFacts(facts);
  return Object.freeze({
    id: `${derived.canonicalId}\u001fexact:${value.amountIn}`,
    value: Object.freeze({
      routeKey: derived.routeKeyValue,
      tokenIn: derived.tokenIn,
      tokenOut: derived.tokenOut,
      canonicalEdgeId: derived.canonicalId,
      amountIn: value.amountIn,
      amountOut: value.amountOut,
      feeBps: (Number(derived.fee) / 100).toString(),
    }),
  });
}

interface BaselineUniv3ExecutionNode {
  readonly adapterId: string;
  readonly target: string;
  readonly tokenIn: string;
  readonly tokenOut: string;
  readonly amount: string;
  readonly params: {
    readonly zeroForOne: unknown;
    readonly amountSpecified: unknown;
    readonly sqrtPriceLimit: unknown;
  };
  readonly children: readonly {
    readonly adapterId: unknown;
    readonly target: unknown;
    readonly tokenIn: unknown;
    readonly tokenOut: unknown;
    readonly amount: unknown;
    readonly params: {
      readonly to: unknown;
      readonly amount: unknown;
    };
    readonly children: readonly unknown[];
  }[];
}

export function normalizeBaselineUniv3ExecutionFragmentItem(
  item: RawMigrationSemanticItem,
): RawMigrationSemanticItem {
  const facts = univ3FactsOf(item);
  if (facts === null) return item;
  const value = item.value as {
    readonly amountIn?: unknown;
    readonly amountOut?: unknown;
    readonly minAmountOut?: unknown;
    readonly node?: BaselineUniv3ExecutionNode;
  };
  if (
    typeof value.amountIn !== "string" ||
    typeof value.amountOut !== "string" ||
    typeof value.minAmountOut !== "string" ||
    value.node === undefined ||
    value.node.adapterId !== "univ3-swap" ||
    typeof value.node.amount !== "string" ||
    value.node.params === undefined ||
    typeof value.node.params.zeroForOne !== "boolean" ||
    typeof value.node.params.amountSpecified !== "string" ||
    typeof value.node.params.sqrtPriceLimit !== "string" ||
    !Array.isArray(value.node.children) ||
    value.node.children.length !== 1
  ) {
    return item;
  }
  const child = value.node.children[0]!;
  if (
    child.adapterId !== "erc20-transfer" ||
    typeof child.target !== "string" ||
    typeof child.tokenIn !== "string" ||
    typeof child.tokenOut !== "string" ||
    typeof child.amount !== "string" ||
    child.params === undefined ||
    typeof child.params.to !== "string" ||
    typeof child.params.amount !== "string" ||
    !Array.isArray(child.children) ||
    child.children.length !== 0
  ) {
    return item;
  }
  const derived = deriveUniv3CanonicalFacts(facts);
  const node = Object.freeze({
    adapterId: value.node.adapterId,
    target: canonicalAddress(value.node.target),
    tokenIn: canonicalAddress(value.node.tokenIn),
    tokenOut: canonicalAddress(value.node.tokenOut),
    amount: BigInt(value.node.amount),
    params: Object.freeze({
      zeroForOne: value.node.params.zeroForOne,
      amountSpecified: BigInt(value.node.params.amountSpecified),
      sqrtPriceLimit: BigInt(value.node.params.sqrtPriceLimit),
    }),
    children: Object.freeze([Object.freeze({
      adapterId: child.adapterId,
      target: canonicalAddress(child.target),
      tokenIn: canonicalAddress(child.tokenIn),
      tokenOut: canonicalAddress(child.tokenOut),
      amount: BigInt(child.amount),
      params: Object.freeze({
        to: canonicalAddress(child.params.to),
        amount: BigInt(child.params.amount),
      }),
      children: Object.freeze([]),
    })]),
  });
  return Object.freeze({
    id: `${derived.canonicalId}\u001fexec:${value.amountIn}`,
    value: Object.freeze({
      routeKey: derived.routeKeyValue,
      tokenIn: derived.tokenIn,
      tokenOut: derived.tokenOut,
      canonicalEdgeId: derived.canonicalId,
      amountIn: value.amountIn,
      amountOut: value.amountOut,
      minAmountOut: value.minAmountOut,
      actionAdapterId: value.node.adapterId,
      executionTarget: canonicalAddress(value.node.target),
      nodeFingerprint: hashCanonical(node),
    }),
  });
}

export function normalizeBaselineUniv3FinalSimulationItem(
  item: RawMigrationSemanticItem,
): RawMigrationSemanticItem {
  const facts = univ3FactsOf(item);
  if (facts === null) return item;
  const value = item.value as {
    readonly amountIn?: unknown;
    readonly amountOut?: unknown;
    readonly minAmountOut?: unknown;
    readonly effects?: readonly {
      readonly kind?: unknown;
      readonly token?: unknown;
      readonly account?: unknown;
      readonly direction?: unknown;
    }[];
    readonly conservation?: unknown;
    readonly repayment?: unknown;
    readonly evInput?: unknown;
  };
  if (
    typeof value.amountIn !== "string" ||
    typeof value.amountOut !== "string" ||
    typeof value.minAmountOut !== "string" ||
    !Array.isArray(value.effects) ||
    value.effects.length !== 4 ||
    value.conservation !== "conserved" ||
    value.repayment !== "satisfied" ||
    value.evInput === null ||
    typeof value.evInput !== "object"
  ) {
    return item;
  }
  const derived = deriveUniv3CanonicalFacts(facts);
  const effects = value.effects.map((effect) => {
    if (
      effect.kind !== "token-delta" ||
      typeof effect.token !== "string" ||
      (effect.account !== "executor" && effect.account !== "route-target") ||
      (effect.direction !== "increase" && effect.direction !== "decrease")
    ) {
      throw new Error("univ3 baseline final simulation effect is malformed");
    }
    return Object.freeze({
      kind: "token-delta",
      token: canonicalAddress(effect.token),
      account: effect.account,
      direction: effect.direction,
    });
  });
  const evInput = value.evInput as {
    readonly amountIn?: unknown;
    readonly amountOut?: unknown;
  };
  if (
    typeof evInput.amountIn !== "string" ||
    typeof evInput.amountOut !== "string"
  ) {
    return item;
  }
  return Object.freeze({
    id: `${derived.canonicalId}\u001fsim:${value.amountIn}`,
    value: Object.freeze({
      routeKey: derived.routeKeyValue,
      tokenIn: derived.tokenIn,
      tokenOut: derived.tokenOut,
      canonicalEdgeId: derived.canonicalId,
      amountIn: value.amountIn,
      amountOut: value.amountOut,
      minAmountOut: value.minAmountOut,
      effectsFingerprint: hashCanonical(effects),
      conservation: value.conservation,
      repayment: value.repayment,
      evInput: Object.freeze({
        amountIn: evInput.amountIn,
        amountOut: evInput.amountOut,
      }),
    }),
  });
}

function isFundingFamilyId(value: string | undefined): boolean {
  return value === "flash-loan:balancer-v2" || value === "flash-loan:morpho";
}

export function normalizeBaselineFundingExecutionFragmentItem(
  item: RawMigrationSemanticItem,
): RawMigrationSemanticItem {
  const value = item.value as {
    readonly familyId?: unknown;
    readonly asset?: unknown;
    readonly amount?: unknown;
    readonly minProfit?: unknown;
    readonly actionAdapterId?: unknown;
    readonly nodeFingerprint?: unknown;
  };
  if (
    !isFundingFamilyId(
      typeof value.familyId === "string" ? value.familyId : undefined,
    ) ||
    typeof value.familyId !== "string" ||
    typeof value.asset !== "string" ||
    typeof value.amount !== "string" ||
    (value.minProfit !== undefined && typeof value.minProfit !== "string") ||
    typeof value.actionAdapterId !== "string" ||
    typeof value.nodeFingerprint !== "string"
  ) {
    return item;
  }
  const minProfit = typeof value.minProfit === "string"
    ? value.minProfit
    : undefined;
  return Object.freeze({
    id: item.id,
    value: Object.freeze({
      familyId: value.familyId,
      asset: canonicalAddress(value.asset),
      amount: value.amount,
      ...(minProfit === undefined ? {} : { minProfit }),
      actionAdapterId: value.actionAdapterId,
      nodeFingerprint: value.nodeFingerprint,
    }),
  });
}

export function normalizeBaselineFundingFinalSimulationItem(
  item: RawMigrationSemanticItem,
): RawMigrationSemanticItem {
  const value = item.value as {
    readonly familyId?: unknown;
    readonly asset?: unknown;
    readonly amount?: unknown;
    readonly maxBorrow?: unknown;
    readonly repayment?: unknown;
    readonly conservation?: unknown;
    readonly evInput?: unknown;
  };
  if (
    !isFundingFamilyId(
      typeof value.familyId === "string" ? value.familyId : undefined,
    ) ||
    typeof value.familyId !== "string" ||
    typeof value.asset !== "string" ||
    typeof value.amount !== "string" ||
    typeof value.maxBorrow !== "string" ||
    value.repayment !== "satisfied" ||
    value.conservation !== "conserved" ||
    value.evInput === null ||
    typeof value.evInput !== "object"
  ) {
    return item;
  }
  const evInput = value.evInput as { readonly amount?: unknown };
  if (typeof evInput.amount !== "string") return item;
  return Object.freeze({
    id: item.id,
    value: Object.freeze({
      familyId: value.familyId,
      asset: canonicalAddress(value.asset),
      amount: value.amount,
      maxBorrow: value.maxBorrow,
      repayment: value.repayment,
      conservation: value.conservation,
      evInput: Object.freeze({ amount: evInput.amount }),
    }),
  });
}

function psmFactsGuard(
  facts: Partial<BaselinePsmFacts> | undefined,
): facts is Required<BaselinePsmFacts> {
  return facts !== undefined &&
    facts.familyId === "protocol:psm" &&
    typeof facts.target === "string" &&
    typeof facts.gem === "string" &&
    typeof facts.dai === "string" &&
    typeof facts.decimalScale === "string" &&
    typeof facts.tokenIn === "string" &&
    typeof facts.tokenOut === "string";
}

function psmFactsOf(item: RawMigrationSemanticItem) {
  const facts = (item.value as {
    readonly baselineFacts?: Partial<BaselinePsmFacts>;
  })?.baselineFacts;
  if (!psmFactsGuard(facts)) return null;
  return facts;
}

function derivePsmCanonicalFacts(facts: Required<BaselinePsmFacts>): {
  readonly target: string;
  readonly gem: string;
  readonly dai: string;
  readonly decimalScale: bigint;
  readonly tokenIn: string;
  readonly tokenOut: string;
  readonly lowerTarget: string;
  readonly lowerTokenIn: string;
  readonly lowerTokenOut: string;
  readonly routeKeyValue: string;
  readonly canonicalId: string;
} {
  const target = canonicalAddress(facts.target);
  const gem = canonicalAddress(facts.gem);
  const dai = canonicalAddress(facts.dai);
  const decimalScale = BigInt(facts.decimalScale);
  const tokenIn = canonicalAddress(facts.tokenIn);
  const tokenOut = canonicalAddress(facts.tokenOut);
  const lowerTarget = lowerAddress(target);
  const bindingFingerprint = hashCanonical({
    target: lowerTarget,
    gem: lowerAddress(gem),
    dai: lowerAddress(dai),
    decimalScale,
    feeSemantics: "lite-psm-tin-tout-wad-v1",
  });
  const venueIdentityHash = hashCanonical({
    kind: "address-protocol",
    target: lowerTarget,
  });
  const routeKeyValue = `protocol:psm\u001f${lowerTarget}\u001fsell-gem`;
  const lowerTokenIn = lowerAddress(tokenIn);
  const lowerTokenOut = lowerAddress(tokenOut);
  const executionVariantKey = hashCanonical({
    namespace: "adapter-family-graph-route-v1",
    routeKey: routeKeyValue,
    routeBindingFingerprint: bindingFingerprint,
    venueIdentityHash,
  });
  const canonicalId = [
    "protocol:psm",
    lowerTarget,
    lowerTarget,
    `${lowerTokenIn}>${lowerTokenOut}`,
    executionVariantKey,
  ].join("\u001f");
  return Object.freeze({
    target,
    gem,
    dai,
    decimalScale,
    tokenIn,
    tokenOut,
    lowerTarget,
    lowerTokenIn,
    lowerTokenOut,
    routeKeyValue,
    canonicalId,
  });
}

export function normalizeBaselinePsmEdgeItem(
  item: RawMigrationSemanticItem,
): RawMigrationSemanticItem {
  const facts = psmFactsOf(item);
  if (facts === null) return item;
  const derived = derivePsmCanonicalFacts(facts);
  return Object.freeze({
    id: derived.canonicalId,
    value: Object.freeze({
      routeKey: derived.routeKeyValue,
      tokenIn: derived.tokenIn,
      tokenOut: derived.tokenOut,
      canonicalEdgeId: derived.canonicalId,
    }),
  });
}

export function normalizeBaselinePsmEnumeratedRouteItem(
  item: RawMigrationSemanticItem,
): RawMigrationSemanticItem {
  const edge = normalizeBaselinePsmEdgeItem(item);
  if (edge === item) return item;
  const order = (item.value as { readonly order?: unknown }).order;
  if (typeof order !== "number" || !Number.isSafeInteger(order) || order < 0) {
    throw new Error(
      "psm baseline enumerated route item must carry a non-negative order",
    );
  }
  return Object.freeze({
    id: edge.id,
    value: Object.freeze({
      ...(edge.value as Record<string, unknown>),
      order,
    }),
  });
}

export function normalizeBaselinePsmInstanceItem(
  item: RawMigrationSemanticItem,
): RawMigrationSemanticItem {
  const facts = psmFactsOf(item);
  if (facts === null) return item;
  const derived = derivePsmCanonicalFacts(facts);
  const staticBindingFingerprint = hashCanonical({
    capability: PSM_CATALOG_FAMILY.hashes.instance.contentHash,
    projection: Object.freeze({
      target: derived.lowerTarget,
      gem: lowerAddress(derived.gem),
      dai: lowerAddress(derived.dai),
      decimalScale: derived.decimalScale,
      feeSemantics: "lite-psm-tin-tout-wad-v1",
    }),
    sharedBindings: Object.freeze([]),
  });
  return Object.freeze({
    id: derived.lowerTarget,
    value: Object.freeze({
      familyId: "protocol:psm",
      instanceKey: derived.lowerTarget,
      staticBindingFingerprint,
    }),
  });
}

export function normalizeBaselinePsmPriceItem(
  item: RawMigrationSemanticItem,
): RawMigrationSemanticItem {
  const facts = psmFactsOf(item);
  if (facts === null) return item;
  const mid = (item.value as {
    readonly mid?: {
      readonly mid?: unknown;
      readonly feeBps?: unknown;
      readonly reserveA?: unknown;
      readonly reserveB?: unknown;
      readonly depthProxy?: unknown;
    };
  })?.mid;
  if (
    mid === undefined ||
    typeof mid.mid !== "number" ||
    typeof mid.feeBps !== "number" ||
    (typeof mid.reserveA !== "string" && typeof mid.reserveA !== "bigint") ||
    (typeof mid.reserveB !== "string" && typeof mid.reserveB !== "bigint") ||
    typeof mid.depthProxy !== "number"
  ) {
    return item;
  }
  const derived = derivePsmCanonicalFacts(facts);
  const routeEdge = Object.freeze({
    adapterId: "psm",
    instanceKey: derived.lowerTarget,
    target: derived.target,
    tokenIn: derived.tokenIn,
    tokenOut: derived.tokenOut,
    slotKind: "protocol" as const,
    protocolAction: "convert" as const,
    edgeKind: "protocol" as const,
    leavesStandingPosition: false,
  });
  return Object.freeze({
    id: item.id,
    value: Object.freeze({
      stateKey: derived.lowerTarget,
      mid: Object.freeze({
        kind: "protocol",
        pool: derived.target,
        edges: Object.freeze([routeEdge]),
        mid: mid.mid,
        feeBps: mid.feeBps,
        reserveA: BigInt(mid.reserveA).toString(),
        reserveB: BigInt(mid.reserveB).toString(),
        depthProxy: mid.depthProxy,
      }),
    }),
  });
}

export function normalizeBaselinePsmExactQuoteItem(
  item: RawMigrationSemanticItem,
): RawMigrationSemanticItem {
  const facts = psmFactsOf(item);
  if (facts === null) return item;
  const value = item.value as {
    readonly amountIn?: unknown;
    readonly amountOut?: unknown;
  };
  if (typeof value.amountIn !== "string" || typeof value.amountOut !== "string") {
    return item;
  }
  const derived = derivePsmCanonicalFacts(facts);
  return Object.freeze({
    id: `${derived.canonicalId}\u001fexact:${value.amountIn}`,
    value: Object.freeze({
      routeKey: derived.routeKeyValue,
      tokenIn: derived.tokenIn,
      tokenOut: derived.tokenOut,
      canonicalEdgeId: derived.canonicalId,
      amountIn: value.amountIn,
      amountOut: value.amountOut,
      feeBps: "0",
    }),
  });
}

export function normalizeBaselinePsmExecutionFragmentItem(
  item: RawMigrationSemanticItem,
): RawMigrationSemanticItem {
  const facts = psmFactsOf(item);
  if (facts === null) return item;
  const value = item.value as {
    readonly amountIn?: unknown;
    readonly amountOut?: unknown;
    readonly minAmountOut?: unknown;
    readonly nodeFingerprint?: unknown;
  };
  if (
    typeof value.amountIn !== "string" ||
    typeof value.amountOut !== "string" ||
    typeof value.minAmountOut !== "string" ||
    typeof value.nodeFingerprint !== "string"
  ) {
    return item;
  }
  const derived = derivePsmCanonicalFacts(facts);
  return Object.freeze({
    id: `${derived.canonicalId}\u001fexec:${value.amountIn}`,
    value: Object.freeze({
      routeKey: derived.routeKeyValue,
      tokenIn: derived.tokenIn,
      tokenOut: derived.tokenOut,
      canonicalEdgeId: derived.canonicalId,
      amountIn: value.amountIn,
      amountOut: value.amountOut,
      minAmountOut: value.minAmountOut,
      actionAdapterId: "psm",
      executionTarget: derived.target,
      nodeFingerprint: value.nodeFingerprint,
    }),
  });
}

export function normalizeBaselinePsmFinalSimulationItem(
  item: RawMigrationSemanticItem,
): RawMigrationSemanticItem {
  const facts = psmFactsOf(item);
  if (facts === null) return item;
  const value = item.value as {
    readonly amountIn?: unknown;
    readonly amountOut?: unknown;
    readonly minAmountOut?: unknown;
    readonly effectsFingerprint?: unknown;
    readonly conservation?: unknown;
    readonly repayment?: unknown;
    readonly evInput?: unknown;
  };
  if (
    typeof value.amountIn !== "string" ||
    typeof value.amountOut !== "string" ||
    typeof value.minAmountOut !== "string" ||
    typeof value.effectsFingerprint !== "string" ||
    value.conservation !== "conserved" ||
    value.repayment !== "satisfied" ||
    value.evInput === null ||
    typeof value.evInput !== "object"
  ) {
    return item;
  }
  const evInput = value.evInput as {
    readonly amountIn?: unknown;
    readonly amountOut?: unknown;
  };
  if (
    typeof evInput.amountIn !== "string" ||
    typeof evInput.amountOut !== "string"
  ) {
    return item;
  }
  const derived = derivePsmCanonicalFacts(facts);
  return Object.freeze({
    id: `${derived.canonicalId}\u001fsim:${value.amountIn}`,
    value: Object.freeze({
      routeKey: derived.routeKeyValue,
      tokenIn: derived.tokenIn,
      tokenOut: derived.tokenOut,
      canonicalEdgeId: derived.canonicalId,
      amountIn: value.amountIn,
      amountOut: value.amountOut,
      minAmountOut: value.minAmountOut,
      effectsFingerprint: value.effectsFingerprint,
      conservation: value.conservation,
      repayment: value.repayment,
      evInput: Object.freeze({
        amountIn: evInput.amountIn,
        amountOut: evInput.amountOut,
      }),
    }),
  });
}

function wstethFactsGuard(
  facts: Partial<BaselineWstethFacts> | undefined,
): facts is Required<BaselineWstethFacts> {
  return facts !== undefined &&
    facts.familyId === "protocol:wsteth" &&
    typeof facts.target === "string" &&
    typeof facts.steth === "string" &&
    typeof facts.wsteth === "string" &&
    typeof facts.tokenIn === "string" &&
    typeof facts.tokenOut === "string";
}

function wstethFactsOf(item: RawMigrationSemanticItem) {
  const facts = (item.value as {
    readonly baselineFacts?: Partial<BaselineWstethFacts>;
  })?.baselineFacts;
  if (!wstethFactsGuard(facts)) return null;
  return facts;
}

function deriveWstethCanonicalFacts(
  facts: Required<BaselineWstethFacts>,
): {
  readonly target: string;
  readonly steth: string;
  readonly wsteth: string;
  readonly tokenIn: string;
  readonly tokenOut: string;
  readonly lowerTarget: string;
  readonly lowerTokenIn: string;
  readonly lowerTokenOut: string;
  readonly routeKeyValue: string;
  readonly canonicalId: string;
} {
  const target = canonicalAddress(facts.target);
  const steth = canonicalAddress(facts.steth);
  const wsteth = canonicalAddress(facts.wsteth);
  const tokenIn = canonicalAddress(facts.tokenIn);
  const tokenOut = canonicalAddress(facts.tokenOut);
  const lowerTarget = lowerAddress(target);
  const direction = lowerAddress(tokenIn) === lowerAddress(steth)
    ? "wrap"
    : "unwrap";
  const bindingFingerprint = hashCanonical({
    target: lowerTarget,
    steth: lowerAddress(steth),
    wsteth: lowerAddress(wsteth),
    conversionSemantics: "lido-wrap-unwrap-v1",
  });
  const venueIdentityHash = hashCanonical({
    kind: "address-protocol",
    target: lowerTarget,
  });
  const routeKeyValue = `protocol:wsteth\u001f${lowerTarget}\u001f${direction}`;
  const lowerTokenIn = lowerAddress(tokenIn);
  const lowerTokenOut = lowerAddress(tokenOut);
  const executionVariantKey = hashCanonical({
    namespace: "adapter-family-graph-route-v1",
    routeKey: routeKeyValue,
    routeBindingFingerprint: bindingFingerprint,
    venueIdentityHash,
  });
  const canonicalId = [
    "protocol:wsteth",
    lowerTarget,
    lowerTarget,
    `${lowerTokenIn}>${lowerTokenOut}`,
    executionVariantKey,
  ].join("\u001f");
  return Object.freeze({
    target,
    steth,
    wsteth,
    tokenIn,
    tokenOut,
    lowerTarget,
    lowerTokenIn,
    lowerTokenOut,
    routeKeyValue,
    canonicalId,
  });
}

export function normalizeBaselineWstethEdgeItem(
  item: RawMigrationSemanticItem,
): RawMigrationSemanticItem {
  const facts = wstethFactsOf(item);
  if (facts === null) return item;
  const derived = deriveWstethCanonicalFacts(facts);
  return Object.freeze({
    id: derived.canonicalId,
    value: Object.freeze({
      routeKey: derived.routeKeyValue,
      tokenIn: derived.tokenIn,
      tokenOut: derived.tokenOut,
      canonicalEdgeId: derived.canonicalId,
    }),
  });
}

export function normalizeBaselineWstethEnumeratedRouteItem(
  item: RawMigrationSemanticItem,
): RawMigrationSemanticItem {
  const edge = normalizeBaselineWstethEdgeItem(item);
  if (edge === item) return item;
  const order = (item.value as { readonly order?: unknown }).order;
  if (typeof order !== "number" || !Number.isSafeInteger(order) || order < 0) {
    throw new Error(
      "wsteth baseline enumerated route item must carry a non-negative order",
    );
  }
  return Object.freeze({
    id: edge.id,
    value: Object.freeze({
      ...(edge.value as Record<string, unknown>),
      order,
    }),
  });
}

export function normalizeBaselineWstethInstanceItem(
  item: RawMigrationSemanticItem,
): RawMigrationSemanticItem {
  const facts = wstethFactsOf(item);
  if (facts === null) return item;
  const derived = deriveWstethCanonicalFacts(facts);
  const staticBindingFingerprint = hashCanonical({
    capability: WSTETH_CATALOG_FAMILY.hashes.instance.contentHash,
    projection: Object.freeze({
      target: derived.lowerTarget,
      steth: lowerAddress(derived.steth),
      wsteth: lowerAddress(derived.wsteth),
      conversionSemantics: "lido-wrap-unwrap-v1",
    }),
    sharedBindings: Object.freeze([]),
  });
  return Object.freeze({
    id: derived.lowerTarget,
    value: Object.freeze({
      familyId: "protocol:wsteth",
      instanceKey: derived.lowerTarget,
      staticBindingFingerprint,
    }),
  });
}

export function normalizeBaselineWstethPriceItem(
  item: RawMigrationSemanticItem,
): RawMigrationSemanticItem {
  const facts = wstethFactsOf(item);
  if (facts === null) return item;
  const mid = (item.value as {
    readonly mid?: {
      readonly mid?: unknown;
      readonly feeBps?: unknown;
      readonly reserveA?: unknown;
      readonly reserveB?: unknown;
      readonly depthProxy?: unknown;
    };
  })?.mid;
  if (
    mid === undefined ||
    typeof mid.mid !== "number" ||
    typeof mid.feeBps !== "number" ||
    (typeof mid.reserveA !== "string" && typeof mid.reserveA !== "bigint") ||
    (typeof mid.reserveB !== "string" && typeof mid.reserveB !== "bigint") ||
    typeof mid.depthProxy !== "number"
  ) {
    return item;
  }
  const derived = deriveWstethCanonicalFacts(facts);
  const adapterId = derived.lowerTokenIn === lowerAddress(derived.steth)
    ? "wsteth-wrap"
    : "wsteth-unwrap";
  const routeEdge = Object.freeze({
    adapterId,
    instanceKey: derived.lowerTarget,
    target: derived.target,
    tokenIn: derived.tokenIn,
    tokenOut: derived.tokenOut,
    slotKind: "protocol" as const,
    protocolAction: adapterId === "wsteth-wrap" ? "wrap" : "unwrap",
    edgeKind: "protocol" as const,
    leavesStandingPosition: false,
  });
  return Object.freeze({
    id: item.id,
    value: Object.freeze({
      stateKey: derived.lowerTarget,
      mid: Object.freeze({
        kind: "protocol",
        pool: derived.target,
        edges: Object.freeze([routeEdge]),
        mid: mid.mid,
        feeBps: mid.feeBps,
        reserveA: BigInt(mid.reserveA).toString(),
        reserveB: BigInt(mid.reserveB).toString(),
        depthProxy: mid.depthProxy,
      }),
    }),
  });
}

export function normalizeBaselineWstethExactQuoteItem(
  item: RawMigrationSemanticItem,
): RawMigrationSemanticItem {
  const facts = wstethFactsOf(item);
  if (facts === null) return item;
  const value = item.value as {
    readonly amountIn?: unknown;
    readonly amountOut?: unknown;
  };
  if (typeof value.amountIn !== "string" || typeof value.amountOut !== "string") {
    return item;
  }
  const derived = deriveWstethCanonicalFacts(facts);
  return Object.freeze({
    id: `${derived.canonicalId}\u001fexact:${value.amountIn}`,
    value: Object.freeze({
      routeKey: derived.routeKeyValue,
      tokenIn: derived.tokenIn,
      tokenOut: derived.tokenOut,
      canonicalEdgeId: derived.canonicalId,
      amountIn: value.amountIn,
      amountOut: value.amountOut,
      feeBps: "0",
    }),
  });
}

export function normalizeBaselineWstethExecutionFragmentItem(
  item: RawMigrationSemanticItem,
): RawMigrationSemanticItem {
  const facts = wstethFactsOf(item);
  if (facts === null) return item;
  const value = item.value as {
    readonly amountIn?: unknown;
    readonly amountOut?: unknown;
    readonly minAmountOut?: unknown;
    readonly nodeFingerprint?: unknown;
  };
  if (
    typeof value.amountIn !== "string" ||
    typeof value.amountOut !== "string" ||
    typeof value.minAmountOut !== "string" ||
    typeof value.nodeFingerprint !== "string"
  ) {
    return item;
  }
  const derived = deriveWstethCanonicalFacts(facts);
  const adapterId = derived.lowerTokenIn === lowerAddress(derived.steth)
    ? "wsteth-wrap"
    : "wsteth-unwrap";
  return Object.freeze({
    id: `${derived.canonicalId}\u001fexec:${value.amountIn}`,
    value: Object.freeze({
      routeKey: derived.routeKeyValue,
      tokenIn: derived.tokenIn,
      tokenOut: derived.tokenOut,
      canonicalEdgeId: derived.canonicalId,
      amountIn: value.amountIn,
      amountOut: value.amountOut,
      minAmountOut: value.minAmountOut,
      actionAdapterId: adapterId,
      executionTarget: derived.target,
      nodeFingerprint: value.nodeFingerprint,
    }),
  });
}

export function normalizeBaselineWstethFinalSimulationItem(
  item: RawMigrationSemanticItem,
): RawMigrationSemanticItem {
  const facts = wstethFactsOf(item);
  if (facts === null) return item;
  const value = item.value as {
    readonly amountIn?: unknown;
    readonly amountOut?: unknown;
    readonly minAmountOut?: unknown;
    readonly effectsFingerprint?: unknown;
    readonly conservation?: unknown;
    readonly repayment?: unknown;
    readonly evInput?: unknown;
  };
  if (
    typeof value.amountIn !== "string" ||
    typeof value.amountOut !== "string" ||
    typeof value.minAmountOut !== "string" ||
    typeof value.effectsFingerprint !== "string" ||
    value.conservation !== "conserved" ||
    value.repayment !== "satisfied" ||
    value.evInput === null ||
    typeof value.evInput !== "object"
  ) {
    return item;
  }
  const evInput = value.evInput as {
    readonly amountIn?: unknown;
    readonly amountOut?: unknown;
  };
  if (
    typeof evInput.amountIn !== "string" ||
    typeof evInput.amountOut !== "string"
  ) {
    return item;
  }
  const derived = deriveWstethCanonicalFacts(facts);
  return Object.freeze({
    id: `${derived.canonicalId}\u001fsim:${value.amountIn}`,
    value: Object.freeze({
      routeKey: derived.routeKeyValue,
      tokenIn: derived.tokenIn,
      tokenOut: derived.tokenOut,
      canonicalEdgeId: derived.canonicalId,
      amountIn: value.amountIn,
      amountOut: value.amountOut,
      minAmountOut: value.minAmountOut,
      effectsFingerprint: value.effectsFingerprint,
      conservation: value.conservation,
      repayment: value.repayment,
      evInput: Object.freeze({
        amountIn: evInput.amountIn,
        amountOut: evInput.amountOut,
      }),
    }),
  });
}

function goldxFactsGuard(
  facts: Partial<BaselineGoldxFacts> | undefined,
): facts is Required<BaselineGoldxFacts> {
  return facts !== undefined &&
    facts.familyId === "protocol:goldx" &&
    typeof facts.target === "string" &&
    typeof facts.collateral === "string" &&
    typeof facts.receipt === "string" &&
    typeof facts.tokenIn === "string" &&
    typeof facts.tokenOut === "string";
}

function goldxFactsOf(item: RawMigrationSemanticItem) {
  const facts = (item.value as {
    readonly baselineFacts?: Partial<BaselineGoldxFacts>;
  })?.baselineFacts;
  if (!goldxFactsGuard(facts)) return null;
  return facts;
}

function deriveGoldxCanonicalFacts(
  facts: Required<BaselineGoldxFacts>,
): {
  readonly target: string;
  readonly collateral: string;
  readonly receipt: string;
  readonly tokenIn: string;
  readonly tokenOut: string;
  readonly lowerTarget: string;
  readonly lowerTokenIn: string;
  readonly lowerTokenOut: string;
  readonly routeKeyValue: string;
  readonly canonicalId: string;
} {
  const target = canonicalAddress(facts.target);
  const collateral = canonicalAddress(facts.collateral);
  const receipt = canonicalAddress(facts.receipt);
  const tokenIn = canonicalAddress(facts.tokenIn);
  const tokenOut = canonicalAddress(facts.tokenOut);
  const lowerTarget = lowerAddress(target);
  const bindingFingerprint = hashCanonical({
    target: lowerTarget,
    collateral: lowerAddress(collateral),
    receipt: lowerAddress(receipt),
    quoteSemantics: "floor(amount*unit/1e18)",
  });
  const venueIdentityHash = hashCanonical({
    kind: "address-protocol",
    target: lowerTarget,
  });
  const routeKeyValue = `protocol:goldx\u001f${lowerTarget}\u001fmint`;
  const lowerTokenIn = lowerAddress(tokenIn);
  const lowerTokenOut = lowerAddress(tokenOut);
  const executionVariantKey = hashCanonical({
    namespace: "adapter-family-graph-route-v1",
    routeKey: routeKeyValue,
    routeBindingFingerprint: bindingFingerprint,
    venueIdentityHash,
  });
  const canonicalId = [
    "protocol:goldx",
    lowerTarget,
    lowerTarget,
    `${lowerTokenIn}>${lowerTokenOut}`,
    executionVariantKey,
  ].join("\u001f");
  return Object.freeze({
    target,
    collateral,
    receipt,
    tokenIn,
    tokenOut,
    lowerTarget,
    lowerTokenIn,
    lowerTokenOut,
    routeKeyValue,
    canonicalId,
  });
}

export function normalizeBaselineGoldxEdgeItem(
  item: RawMigrationSemanticItem,
): RawMigrationSemanticItem {
  const facts = goldxFactsOf(item);
  if (facts === null) return item;
  const derived = deriveGoldxCanonicalFacts(facts);
  return Object.freeze({
    id: derived.canonicalId,
    value: Object.freeze({
      routeKey: derived.routeKeyValue,
      tokenIn: derived.tokenIn,
      tokenOut: derived.tokenOut,
      canonicalEdgeId: derived.canonicalId,
    }),
  });
}

export function normalizeBaselineGoldxEnumeratedRouteItem(
  item: RawMigrationSemanticItem,
): RawMigrationSemanticItem {
  const edge = normalizeBaselineGoldxEdgeItem(item);
  if (edge === item) return item;
  const order = (item.value as { readonly order?: unknown }).order;
  if (typeof order !== "number" || !Number.isSafeInteger(order) || order < 0) {
    throw new Error(
      "goldx baseline enumerated route item must carry a non-negative order",
    );
  }
  return Object.freeze({
    id: edge.id,
    value: Object.freeze({
      ...(edge.value as Record<string, unknown>),
      order,
    }),
  });
}

export function normalizeBaselineGoldxInstanceItem(
  item: RawMigrationSemanticItem,
): RawMigrationSemanticItem {
  const facts = goldxFactsOf(item);
  if (facts === null) return item;
  const derived = deriveGoldxCanonicalFacts(facts);
  const staticBindingFingerprint = hashCanonical({
    capability: GOLDX_CATALOG_FAMILY.hashes.instance.contentHash,
    projection: Object.freeze({
      target: derived.lowerTarget,
      collateral: lowerAddress(derived.collateral),
      receipt: lowerAddress(derived.receipt),
      quoteSemantics: "floor(amount*unit/1e18)",
    }),
    sharedBindings: Object.freeze([]),
  });
  return Object.freeze({
    id: derived.lowerTarget,
    value: Object.freeze({
      familyId: "protocol:goldx",
      instanceKey: derived.lowerTarget,
      staticBindingFingerprint,
    }),
  });
}

export function normalizeBaselineGoldxPriceItem(
  item: RawMigrationSemanticItem,
): RawMigrationSemanticItem {
  const facts = goldxFactsOf(item);
  if (facts === null) return item;
  const mid = (item.value as {
    readonly mid?: {
      readonly mid?: unknown;
      readonly feeBps?: unknown;
      readonly reserveA?: unknown;
      readonly reserveB?: unknown;
      readonly depthProxy?: unknown;
    };
  })?.mid;
  if (
    mid === undefined ||
    typeof mid.mid !== "number" ||
    typeof mid.feeBps !== "number" ||
    (typeof mid.reserveA !== "string" && typeof mid.reserveA !== "bigint") ||
    (typeof mid.reserveB !== "string" && typeof mid.reserveB !== "bigint") ||
    typeof mid.depthProxy !== "number"
  ) {
    return item;
  }
  const derived = deriveGoldxCanonicalFacts(facts);
  const routeEdge = Object.freeze({
    adapterId: "goldx-mint",
    instanceKey: derived.lowerTarget,
    target: derived.target,
    tokenIn: derived.tokenIn,
    tokenOut: derived.tokenOut,
    slotKind: "protocol" as const,
    protocolAction: "convert" as const,
    edgeKind: "protocol" as const,
    leavesStandingPosition: false,
  });
  return Object.freeze({
    id: item.id,
    value: Object.freeze({
      stateKey: derived.lowerTarget,
      mid: Object.freeze({
        kind: "protocol",
        pool: derived.target,
        edges: Object.freeze([routeEdge]),
        mid: mid.mid,
        feeBps: mid.feeBps,
        reserveA: BigInt(mid.reserveA).toString(),
        reserveB: BigInt(mid.reserveB).toString(),
        depthProxy: mid.depthProxy,
      }),
    }),
  });
}

export function normalizeBaselineGoldxExactQuoteItem(
  item: RawMigrationSemanticItem,
): RawMigrationSemanticItem {
  const facts = goldxFactsOf(item);
  if (facts === null) return item;
  const value = item.value as {
    readonly amountIn?: unknown;
    readonly amountOut?: unknown;
  };
  if (typeof value.amountIn !== "string" || typeof value.amountOut !== "string") {
    return item;
  }
  const derived = deriveGoldxCanonicalFacts(facts);
  return Object.freeze({
    id: `${derived.canonicalId}\u001fexact:${value.amountIn}`,
    value: Object.freeze({
      routeKey: derived.routeKeyValue,
      tokenIn: derived.tokenIn,
      tokenOut: derived.tokenOut,
      canonicalEdgeId: derived.canonicalId,
      amountIn: value.amountIn,
      amountOut: value.amountOut,
      feeBps: "0",
    }),
  });
}

export function normalizeBaselineGoldxExecutionFragmentItem(
  item: RawMigrationSemanticItem,
): RawMigrationSemanticItem {
  const facts = goldxFactsOf(item);
  if (facts === null) return item;
  const value = item.value as {
    readonly amountIn?: unknown;
    readonly amountOut?: unknown;
    readonly minAmountOut?: unknown;
    readonly nodeFingerprint?: unknown;
  };
  if (
    typeof value.amountIn !== "string" ||
    typeof value.amountOut !== "string" ||
    typeof value.minAmountOut !== "string" ||
    typeof value.nodeFingerprint !== "string"
  ) {
    return item;
  }
  const derived = deriveGoldxCanonicalFacts(facts);
  return Object.freeze({
    id: `${derived.canonicalId}\u001fexec:${value.amountIn}`,
    value: Object.freeze({
      routeKey: derived.routeKeyValue,
      tokenIn: derived.tokenIn,
      tokenOut: derived.tokenOut,
      canonicalEdgeId: derived.canonicalId,
      amountIn: value.amountIn,
      amountOut: value.amountOut,
      minAmountOut: value.minAmountOut,
      actionAdapterId: "goldx-mint",
      executionTarget: derived.target,
      nodeFingerprint: value.nodeFingerprint,
    }),
  });
}

export function normalizeBaselineGoldxFinalSimulationItem(
  item: RawMigrationSemanticItem,
): RawMigrationSemanticItem {
  const facts = goldxFactsOf(item);
  if (facts === null) return item;
  const value = item.value as {
    readonly amountIn?: unknown;
    readonly amountOut?: unknown;
    readonly minAmountOut?: unknown;
    readonly effectsFingerprint?: unknown;
    readonly conservation?: unknown;
    readonly repayment?: unknown;
    readonly evInput?: unknown;
  };
  if (
    typeof value.amountIn !== "string" ||
    typeof value.amountOut !== "string" ||
    typeof value.minAmountOut !== "string" ||
    typeof value.effectsFingerprint !== "string" ||
    value.conservation !== "conserved" ||
    value.repayment !== "satisfied" ||
    value.evInput === null ||
    typeof value.evInput !== "object"
  ) {
    return item;
  }
  const evInput = value.evInput as {
    readonly amountIn?: unknown;
    readonly amountOut?: unknown;
  };
  if (
    typeof evInput.amountIn !== "string" ||
    typeof evInput.amountOut !== "string"
  ) {
    return item;
  }
  const derived = deriveGoldxCanonicalFacts(facts);
  return Object.freeze({
    id: `${derived.canonicalId}\u001fsim:${value.amountIn}`,
    value: Object.freeze({
      routeKey: derived.routeKeyValue,
      tokenIn: derived.tokenIn,
      tokenOut: derived.tokenOut,
      canonicalEdgeId: derived.canonicalId,
      amountIn: value.amountIn,
      amountOut: value.amountOut,
      minAmountOut: value.minAmountOut,
      effectsFingerprint: value.effectsFingerprint,
      conservation: value.conservation,
      repayment: value.repayment,
      evInput: Object.freeze({
        amountIn: evInput.amountIn,
        amountOut: evInput.amountOut,
      }),
    }),
  });
}

function rocksolidFactsGuard(
  facts: Partial<BaselineRocksolidFacts> | undefined,
): facts is Required<BaselineRocksolidFacts> {
  return facts !== undefined &&
    facts.familyId === "protocol:rocksolid" &&
    typeof facts.target === "string" &&
    typeof facts.asset === "string" &&
    typeof facts.receipt === "string" &&
    typeof facts.tokenIn === "string" &&
    typeof facts.tokenOut === "string";
}

function rocksolidFactsOf(item: RawMigrationSemanticItem) {
  const facts = (item.value as {
    readonly baselineFacts?: Partial<BaselineRocksolidFacts>;
  })?.baselineFacts;
  if (!rocksolidFactsGuard(facts)) return null;
  return facts;
}

function deriveRocksolidCanonicalFacts(
  facts: Required<BaselineRocksolidFacts>,
): {
  readonly target: string;
  readonly asset: string;
  readonly receipt: string;
  readonly tokenIn: string;
  readonly tokenOut: string;
  readonly lowerTarget: string;
  readonly lowerTokenIn: string;
  readonly lowerTokenOut: string;
  readonly routeKeyValue: string;
  readonly canonicalId: string;
} {
  const target = canonicalAddress(facts.target);
  const asset = canonicalAddress(facts.asset);
  const receipt = canonicalAddress(facts.receipt);
  const tokenIn = canonicalAddress(facts.tokenIn);
  const tokenOut = canonicalAddress(facts.tokenOut);
  const lowerTarget = lowerAddress(target);
  const bindingFingerprint = hashCanonical({
    target: lowerTarget,
    asset: lowerAddress(asset),
    receipt: lowerAddress(receipt),
    execution: "syncDeposit(assets,receiver,zero-referral)",
  });
  const venueIdentityHash = hashCanonical({
    kind: "address-protocol",
    target: lowerTarget,
  });
  const routeKeyValue = `protocol:rocksolid\u001f${lowerTarget}\u001fsync-deposit`;
  const lowerTokenIn = lowerAddress(tokenIn);
  const lowerTokenOut = lowerAddress(tokenOut);
  const executionVariantKey = hashCanonical({
    namespace: "adapter-family-graph-route-v1",
    routeKey: routeKeyValue,
    routeBindingFingerprint: bindingFingerprint,
    venueIdentityHash,
  });
  const canonicalId = [
    "protocol:rocksolid",
    lowerTarget,
    lowerTarget,
    `${lowerTokenIn}>${lowerTokenOut}`,
    executionVariantKey,
  ].join("\u001f");
  return Object.freeze({
    target,
    asset,
    receipt,
    tokenIn,
    tokenOut,
    lowerTarget,
    lowerTokenIn,
    lowerTokenOut,
    routeKeyValue,
    canonicalId,
  });
}

export function normalizeBaselineRocksolidEdgeItem(
  item: RawMigrationSemanticItem,
): RawMigrationSemanticItem {
  const facts = rocksolidFactsOf(item);
  if (facts === null) return item;
  const derived = deriveRocksolidCanonicalFacts(facts);
  return Object.freeze({
    id: derived.canonicalId,
    value: Object.freeze({
      routeKey: derived.routeKeyValue,
      tokenIn: derived.tokenIn,
      tokenOut: derived.tokenOut,
      canonicalEdgeId: derived.canonicalId,
    }),
  });
}

export function normalizeBaselineRocksolidEnumeratedRouteItem(
  item: RawMigrationSemanticItem,
): RawMigrationSemanticItem {
  const edge = normalizeBaselineRocksolidEdgeItem(item);
  if (edge === item) return item;
  const order = (item.value as { readonly order?: unknown }).order;
  if (typeof order !== "number" || !Number.isSafeInteger(order) || order < 0) {
    throw new Error(
      "rocksolid baseline enumerated route item must carry a non-negative order",
    );
  }
  return Object.freeze({
    id: edge.id,
    value: Object.freeze({
      ...(edge.value as Record<string, unknown>),
      order,
    }),
  });
}

export function normalizeBaselineRocksolidInstanceItem(
  item: RawMigrationSemanticItem,
): RawMigrationSemanticItem {
  const facts = rocksolidFactsOf(item);
  if (facts === null) return item;
  const derived = deriveRocksolidCanonicalFacts(facts);
  const staticBindingFingerprint = hashCanonical({
    capability: ROCKSOLID_CATALOG_FAMILY.hashes.instance.contentHash,
    projection: Object.freeze({
      target: derived.lowerTarget,
      asset: lowerAddress(derived.asset),
      receipt: lowerAddress(derived.receipt),
      execution: "syncDeposit(assets,receiver,zero-referral)",
    }),
    sharedBindings: Object.freeze([]),
  });
  return Object.freeze({
    id: derived.lowerTarget,
    value: Object.freeze({
      familyId: "protocol:rocksolid",
      instanceKey: derived.lowerTarget,
      staticBindingFingerprint,
    }),
  });
}

export function normalizeBaselineRocksolidPriceItem(
  item: RawMigrationSemanticItem,
): RawMigrationSemanticItem {
  const facts = rocksolidFactsOf(item);
  if (facts === null) return item;
  const mid = (item.value as {
    readonly mid?: {
      readonly mid?: unknown;
      readonly feeBps?: unknown;
      readonly reserveA?: unknown;
      readonly reserveB?: unknown;
      readonly depthProxy?: unknown;
    };
  })?.mid;
  if (
    mid === undefined ||
    typeof mid.mid !== "number" ||
    typeof mid.feeBps !== "number" ||
    (typeof mid.reserveA !== "string" && typeof mid.reserveA !== "bigint") ||
    (typeof mid.reserveB !== "string" && typeof mid.reserveB !== "bigint") ||
    typeof mid.depthProxy !== "number"
  ) {
    return item;
  }
  const derived = deriveRocksolidCanonicalFacts(facts);
  const routeEdge = Object.freeze({
    adapterId: "rocksolid-sync-deposit",
    instanceKey: derived.lowerTarget,
    target: derived.target,
    tokenIn: derived.tokenIn,
    tokenOut: derived.tokenOut,
    slotKind: "protocol" as const,
    protocolAction: "wrap" as const,
    edgeKind: "protocol" as const,
    leavesStandingPosition: false,
  });
  return Object.freeze({
    id: item.id,
    value: Object.freeze({
      stateKey: derived.lowerTarget,
      mid: Object.freeze({
        kind: "protocol",
        pool: derived.target,
        edges: Object.freeze([routeEdge]),
        mid: mid.mid,
        feeBps: mid.feeBps,
        reserveA: BigInt(mid.reserveA).toString(),
        reserveB: BigInt(mid.reserveB).toString(),
        depthProxy: mid.depthProxy,
      }),
    }),
  });
}

export function normalizeBaselineRocksolidExactQuoteItem(
  item: RawMigrationSemanticItem,
): RawMigrationSemanticItem {
  const facts = rocksolidFactsOf(item);
  if (facts === null) return item;
  const value = item.value as {
    readonly amountIn?: unknown;
    readonly amountOut?: unknown;
  };
  if (typeof value.amountIn !== "string" || typeof value.amountOut !== "string") {
    return item;
  }
  const derived = deriveRocksolidCanonicalFacts(facts);
  return Object.freeze({
    id: `${derived.canonicalId}\u001fexact:${value.amountIn}`,
    value: Object.freeze({
      routeKey: derived.routeKeyValue,
      tokenIn: derived.tokenIn,
      tokenOut: derived.tokenOut,
      canonicalEdgeId: derived.canonicalId,
      amountIn: value.amountIn,
      amountOut: value.amountOut,
      feeBps: "0",
    }),
  });
}

export function normalizeBaselineRocksolidExecutionFragmentItem(
  item: RawMigrationSemanticItem,
): RawMigrationSemanticItem {
  const facts = rocksolidFactsOf(item);
  if (facts === null) return item;
  const value = item.value as {
    readonly amountIn?: unknown;
    readonly amountOut?: unknown;
    readonly minAmountOut?: unknown;
    readonly nodeFingerprint?: unknown;
  };
  if (
    typeof value.amountIn !== "string" ||
    typeof value.amountOut !== "string" ||
    typeof value.minAmountOut !== "string" ||
    typeof value.nodeFingerprint !== "string"
  ) {
    return item;
  }
  const derived = deriveRocksolidCanonicalFacts(facts);
  return Object.freeze({
    id: `${derived.canonicalId}\u001fexec:${value.amountIn}`,
    value: Object.freeze({
      routeKey: derived.routeKeyValue,
      tokenIn: derived.tokenIn,
      tokenOut: derived.tokenOut,
      canonicalEdgeId: derived.canonicalId,
      amountIn: value.amountIn,
      amountOut: value.amountOut,
      minAmountOut: value.minAmountOut,
      actionAdapterId: "rocksolid-sync-deposit",
      executionTarget: derived.target,
      nodeFingerprint: value.nodeFingerprint,
    }),
  });
}

export function normalizeBaselineRocksolidFinalSimulationItem(
  item: RawMigrationSemanticItem,
): RawMigrationSemanticItem {
  const facts = rocksolidFactsOf(item);
  if (facts === null) return item;
  const value = item.value as {
    readonly amountIn?: unknown;
    readonly amountOut?: unknown;
    readonly minAmountOut?: unknown;
    readonly effectsFingerprint?: unknown;
    readonly conservation?: unknown;
    readonly repayment?: unknown;
    readonly evInput?: unknown;
  };
  if (
    typeof value.amountIn !== "string" ||
    typeof value.amountOut !== "string" ||
    typeof value.minAmountOut !== "string" ||
    typeof value.effectsFingerprint !== "string" ||
    value.conservation !== "conserved" ||
    value.repayment !== "satisfied" ||
    value.evInput === null ||
    typeof value.evInput !== "object"
  ) {
    return item;
  }
  const evInput = value.evInput as {
    readonly amountIn?: unknown;
    readonly amountOut?: unknown;
  };
  if (
    typeof evInput.amountIn !== "string" ||
    typeof evInput.amountOut !== "string"
  ) {
    return item;
  }
  const derived = deriveRocksolidCanonicalFacts(facts);
  return Object.freeze({
    id: `${derived.canonicalId}\u001fsim:${value.amountIn}`,
    value: Object.freeze({
      routeKey: derived.routeKeyValue,
      tokenIn: derived.tokenIn,
      tokenOut: derived.tokenOut,
      canonicalEdgeId: derived.canonicalId,
      amountIn: value.amountIn,
      amountOut: value.amountOut,
      minAmountOut: value.minAmountOut,
      effectsFingerprint: value.effectsFingerprint,
      conservation: value.conservation,
      repayment: value.repayment,
      evInput: Object.freeze({
        amountIn: evInput.amountIn,
        amountOut: evInput.amountOut,
      }),
    }),
  });
}

function metronomeHgUsdcFactsGuard(
  facts: Partial<BaselineMetronomeHgUsdcFacts> | undefined,
): facts is Required<BaselineMetronomeHgUsdcFacts> {
  return facts !== undefined &&
    facts.familyId === "protocol:metronome-hgusdc" &&
    typeof facts.router === "string" &&
    typeof facts.curve === "string" &&
    typeof facts.vault === "string" &&
    typeof facts.tokenIn === "string" &&
    typeof facts.curveIntermediate === "string" &&
    typeof facts.tokenOut === "string" &&
    Array.isArray(facts.curveDirection) &&
    facts.curveDirection.length === 2 &&
    facts.curveDirection.every((value) => typeof value === "number") &&
    typeof facts.pathHash === "string";
}

function metronomeHgUsdcFactsOf(item: RawMigrationSemanticItem) {
  const facts = (item.value as {
    readonly baselineFacts?: Partial<BaselineMetronomeHgUsdcFacts>;
  })?.baselineFacts;
  if (!metronomeHgUsdcFactsGuard(facts)) return null;
  return facts;
}

function deriveMetronomeHgUsdcCanonicalFacts(
  facts: Required<BaselineMetronomeHgUsdcFacts>,
): {
  readonly router: string;
  readonly curve: string;
  readonly vault: string;
  readonly tokenIn: string;
  readonly curveIntermediate: string;
  readonly tokenOut: string;
  readonly lowerRouter: string;
  readonly lowerTokenIn: string;
  readonly lowerTokenOut: string;
  readonly routeKeyValue: string;
  readonly canonicalId: string;
} {
  const router = canonicalAddress(facts.router);
  const curve = canonicalAddress(facts.curve);
  const vault = canonicalAddress(facts.vault);
  const tokenIn = canonicalAddress(facts.tokenIn);
  const curveIntermediate = canonicalAddress(facts.curveIntermediate);
  const tokenOut = canonicalAddress(facts.tokenOut);
  const lowerRouter = lowerAddress(router);
  const pathHash = facts.pathHash.toLowerCase();
  const descriptor = Object.freeze({
    router,
    curve,
    vault,
    tokenIn,
    curveIntermediate,
    tokenOut,
    pathHash,
  }) as unknown as Parameters<typeof metronomeHgUsdcStaticProjection>[0];
  const bindingFingerprint = hashCanonical(
    metronomeHgUsdcStaticProjection(descriptor),
  );
  const venueIdentityHash = hashCanonical(Object.freeze({
    kind: "address-path-protocol",
    target: lowerRouter,
    pathHash,
  }));
  const routeKeyValue =
    `protocol:metronome-hgusdc\u001f${lowerRouter}`;
  const lowerTokenIn = lowerAddress(tokenIn);
  const lowerTokenOut = lowerAddress(tokenOut);
  const executionVariantKey = hashCanonical({
    namespace: "adapter-family-graph-route-v1",
    routeKey: routeKeyValue,
    routeBindingFingerprint: bindingFingerprint,
    venueIdentityHash,
  });
  const canonicalId = [
    "protocol:metronome-hgusdc",
    lowerRouter,
    lowerRouter,
    `${lowerTokenIn}>${lowerTokenOut}`,
    executionVariantKey,
  ].join("\u001f");
  return Object.freeze({
    router,
    curve,
    vault,
    tokenIn,
    curveIntermediate,
    tokenOut,
    lowerRouter,
    lowerTokenIn,
    lowerTokenOut,
    routeKeyValue,
    canonicalId,
  });
}

export function normalizeBaselineMetronomeHgUsdcEdgeItem(
  item: RawMigrationSemanticItem,
): RawMigrationSemanticItem {
  const facts = metronomeHgUsdcFactsOf(item);
  if (facts === null) return item;
  const derived = deriveMetronomeHgUsdcCanonicalFacts(facts);
  return Object.freeze({
    id: derived.canonicalId,
    value: Object.freeze({
      routeKey: derived.routeKeyValue,
      tokenIn: derived.tokenIn,
      tokenOut: derived.tokenOut,
      canonicalEdgeId: derived.canonicalId,
    }),
  });
}

export function normalizeBaselineMetronomeHgUsdcEnumeratedRouteItem(
  item: RawMigrationSemanticItem,
): RawMigrationSemanticItem {
  const edge = normalizeBaselineMetronomeHgUsdcEdgeItem(item);
  if (edge === item) return item;
  const order = (item.value as { readonly order?: unknown }).order;
  if (typeof order !== "number" || !Number.isSafeInteger(order) || order < 0) {
    throw new Error(
      "metronome-hgusdc baseline enumerated route item must carry a " +
        "non-negative order",
    );
  }
  return Object.freeze({
    id: edge.id,
    value: Object.freeze({
      ...(edge.value as Record<string, unknown>),
      order,
    }),
  });
}

export function normalizeBaselineMetronomeHgUsdcInstanceItem(
  item: RawMigrationSemanticItem,
): RawMigrationSemanticItem {
  const facts = metronomeHgUsdcFactsOf(item);
  if (facts === null) return item;
  const derived = deriveMetronomeHgUsdcCanonicalFacts(facts);
  const descriptor = Object.freeze({
    router: derived.router,
    curve: derived.curve,
    vault: derived.vault,
    tokenIn: derived.tokenIn,
    curveIntermediate: derived.curveIntermediate,
    tokenOut: derived.tokenOut,
    pathHash: facts.pathHash.toLowerCase(),
  }) as unknown as Parameters<typeof metronomeHgUsdcStaticProjection>[0];
  const staticBindingFingerprint = hashCanonical({
    capability: METRONOME_HGUSDC_CATALOG_FAMILY.hashes.instance.contentHash,
    projection: metronomeHgUsdcStaticProjection(descriptor),
    sharedBindings: Object.freeze([]),
  });
  return Object.freeze({
    id: derived.lowerRouter,
    value: Object.freeze({
      familyId: "protocol:metronome-hgusdc",
      instanceKey: derived.lowerRouter,
      staticBindingFingerprint,
    }),
  });
}

export function normalizeBaselineMetronomeHgUsdcPriceItem(
  item: RawMigrationSemanticItem,
): RawMigrationSemanticItem {
  const facts = metronomeHgUsdcFactsOf(item);
  if (facts === null) return item;
  const mid = (item.value as {
    readonly mid?: {
      readonly mid?: unknown;
      readonly feeBps?: unknown;
      readonly reserveA?: unknown;
      readonly reserveB?: unknown;
      readonly depthProxy?: unknown;
    };
  })?.mid;
  if (
    mid === undefined ||
    typeof mid.mid !== "number" ||
    typeof mid.feeBps !== "number" ||
    (typeof mid.reserveA !== "string" && typeof mid.reserveA !== "bigint") ||
    (typeof mid.reserveB !== "string" && typeof mid.reserveB !== "bigint") ||
    typeof mid.depthProxy !== "number"
  ) {
    return item;
  }
  const derived = deriveMetronomeHgUsdcCanonicalFacts(facts);
  const routeEdge = Object.freeze({
    adapterId: "metronome-hgusdc-exit",
    instanceKey: derived.lowerRouter,
    target: derived.router,
    tokenIn: derived.tokenIn,
    tokenOut: derived.tokenOut,
    slotKind: "protocol" as const,
    protocolAction: "redeem" as const,
    edgeKind: "protocol" as const,
    leavesStandingPosition: false,
  });
  return Object.freeze({
    id: item.id,
    value: Object.freeze({
      stateKey: derived.lowerRouter,
      mid: Object.freeze({
        kind: "protocol",
        pool: derived.router,
        edges: Object.freeze([routeEdge]),
        mid: mid.mid,
        feeBps: mid.feeBps,
        reserveA: BigInt(mid.reserveA).toString(),
        reserveB: BigInt(mid.reserveB).toString(),
        depthProxy: mid.depthProxy,
      }),
    }),
  });
}

export function normalizeBaselineMetronomeHgUsdcExactQuoteItem(
  item: RawMigrationSemanticItem,
): RawMigrationSemanticItem {
  const facts = metronomeHgUsdcFactsOf(item);
  if (facts === null) return item;
  const value = item.value as {
    readonly amountIn?: unknown;
    readonly amountOut?: unknown;
  };
  if (typeof value.amountIn !== "string" || typeof value.amountOut !== "string") {
    return item;
  }
  const derived = deriveMetronomeHgUsdcCanonicalFacts(facts);
  return Object.freeze({
    id: `${derived.canonicalId}\u001fexact:${value.amountIn}`,
    value: Object.freeze({
      routeKey: derived.routeKeyValue,
      tokenIn: derived.tokenIn,
      tokenOut: derived.tokenOut,
      canonicalEdgeId: derived.canonicalId,
      amountIn: value.amountIn,
      amountOut: value.amountOut,
      feeBps: "0",
    }),
  });
}

export function normalizeBaselineMetronomeHgUsdcExecutionFragmentItem(
  item: RawMigrationSemanticItem,
): RawMigrationSemanticItem {
  const facts = metronomeHgUsdcFactsOf(item);
  if (facts === null) return item;
  const value = item.value as {
    readonly amountIn?: unknown;
    readonly amountOut?: unknown;
    readonly minAmountOut?: unknown;
    readonly nodeFingerprint?: unknown;
  };
  if (
    typeof value.amountIn !== "string" ||
    typeof value.amountOut !== "string" ||
    typeof value.minAmountOut !== "string" ||
    typeof value.nodeFingerprint !== "string"
  ) {
    return item;
  }
  const derived = deriveMetronomeHgUsdcCanonicalFacts(facts);
  return Object.freeze({
    id: `${derived.canonicalId}\u001fexec:${value.amountIn}`,
    value: Object.freeze({
      routeKey: derived.routeKeyValue,
      tokenIn: derived.tokenIn,
      tokenOut: derived.tokenOut,
      canonicalEdgeId: derived.canonicalId,
      amountIn: value.amountIn,
      amountOut: value.amountOut,
      minAmountOut: value.minAmountOut,
      actionAdapterId: "metronome-hgusdc-exit",
      executionTarget: derived.router,
      nodeFingerprint: value.nodeFingerprint,
    }),
  });
}

export function normalizeBaselineMetronomeHgUsdcFinalSimulationItem(
  item: RawMigrationSemanticItem,
): RawMigrationSemanticItem {
  const facts = metronomeHgUsdcFactsOf(item);
  if (facts === null) return item;
  const value = item.value as {
    readonly amountIn?: unknown;
    readonly amountOut?: unknown;
    readonly minAmountOut?: unknown;
    readonly effectsFingerprint?: unknown;
    readonly conservation?: unknown;
    readonly repayment?: unknown;
    readonly evInput?: unknown;
  };
  if (
    typeof value.amountIn !== "string" ||
    typeof value.amountOut !== "string" ||
    typeof value.minAmountOut !== "string" ||
    typeof value.effectsFingerprint !== "string" ||
    value.conservation !== "conserved" ||
    value.repayment !== "satisfied" ||
    value.evInput === null ||
    typeof value.evInput !== "object"
  ) {
    return item;
  }
  const evInput = value.evInput as {
    readonly amountIn?: unknown;
    readonly amountOut?: unknown;
  };
  if (
    typeof evInput.amountIn !== "string" ||
    typeof evInput.amountOut !== "string"
  ) {
    return item;
  }
  const derived = deriveMetronomeHgUsdcCanonicalFacts(facts);
  return Object.freeze({
    id: `${derived.canonicalId}\u001fsim:${value.amountIn}`,
    value: Object.freeze({
      routeKey: derived.routeKeyValue,
      tokenIn: derived.tokenIn,
      tokenOut: derived.tokenOut,
      canonicalEdgeId: derived.canonicalId,
      amountIn: value.amountIn,
      amountOut: value.amountOut,
      minAmountOut: value.minAmountOut,
      effectsFingerprint: value.effectsFingerprint,
      conservation: value.conservation,
      repayment: value.repayment,
      evInput: Object.freeze({
        amountIn: evInput.amountIn,
        amountOut: evInput.amountOut,
      }),
    }),
  });
}

function metronomeSynthFactsGuard(
  facts: Partial<BaselineMetronomeSynthFacts> | undefined,
): facts is Required<BaselineMetronomeSynthFacts> {
  return facts !== undefined &&
    facts.familyId === "protocol:metronome-synth" &&
    typeof facts.pool === "string" &&
    Array.isArray(facts.tokens) &&
    facts.tokens.every((token) => typeof token === "string") &&
    Array.isArray(facts.directions) &&
    facts.directions.every((direction) =>
      typeof direction?.tokenIn === "string" &&
      typeof direction?.tokenOut === "string"
    ) &&
    typeof facts.oracleBinding === "string" &&
    typeof facts.tokenIn === "string" &&
    typeof facts.tokenOut === "string";
}

function metronomeSynthFactsOf(item: RawMigrationSemanticItem) {
  const facts = (item.value as {
    readonly baselineFacts?: Partial<BaselineMetronomeSynthFacts>;
  })?.baselineFacts;
  if (!metronomeSynthFactsGuard(facts)) return null;
  return facts;
}

function deriveMetronomeSynthCanonicalFacts(
  facts: Required<BaselineMetronomeSynthFacts>,
): {
  readonly pool: string;
  readonly tokenIn: string;
  readonly tokenOut: string;
  readonly lowerPool: string;
  readonly lowerTokenIn: string;
  readonly lowerTokenOut: string;
  readonly routeKeyValue: string;
  readonly canonicalId: string;
} {
  const pool = canonicalAddress(facts.pool);
  const tokenIn = canonicalAddress(facts.tokenIn);
  const tokenOut = canonicalAddress(facts.tokenOut);
  const lowerPool = lowerAddress(pool);
  const descriptor = Object.freeze({
    pool,
    tokens: facts.tokens.map(canonicalAddress),
    directions: facts.directions.map((direction) => Object.freeze({
      tokenIn: canonicalAddress(direction.tokenIn),
      tokenOut: canonicalAddress(direction.tokenOut),
    })),
    oracleBinding: facts.oracleBinding,
  }) as unknown as Parameters<typeof metronomeSynthStaticProjection>[0];
  const bindingFingerprint = hashCanonical(
    metronomeSynthStaticProjection(descriptor),
  );
  const venueIdentityHash = hashCanonical(Object.freeze({
    kind: "address-protocol",
    target: lowerPool,
  }));
  const lowerTokenIn = lowerAddress(tokenIn);
  const lowerTokenOut = lowerAddress(tokenOut);
  const routeKeyValue = [
    "protocol:metronome-synth",
    lowerPool,
    lowerTokenIn,
    lowerTokenOut,
  ].join("\u001f");
  const executionVariantKey = hashCanonical({
    namespace: "adapter-family-graph-route-v1",
    routeKey: routeKeyValue,
    routeBindingFingerprint: bindingFingerprint,
    venueIdentityHash,
  });
  const canonicalId = [
    "protocol:metronome-synth",
    lowerPool,
    lowerPool,
    `${lowerTokenIn}>${lowerTokenOut}`,
    executionVariantKey,
  ].join("\u001f");
  return Object.freeze({
    pool,
    tokenIn,
    tokenOut,
    lowerPool,
    lowerTokenIn,
    lowerTokenOut,
    routeKeyValue,
    canonicalId,
  });
}

export function normalizeBaselineMetronomeSynthEdgeItem(
  item: RawMigrationSemanticItem,
): RawMigrationSemanticItem {
  const facts = metronomeSynthFactsOf(item);
  if (facts === null) return item;
  const derived = deriveMetronomeSynthCanonicalFacts(facts);
  return Object.freeze({
    id: derived.canonicalId,
    value: Object.freeze({
      routeKey: derived.routeKeyValue,
      tokenIn: derived.tokenIn,
      tokenOut: derived.tokenOut,
      canonicalEdgeId: derived.canonicalId,
    }),
  });
}

export function normalizeBaselineMetronomeSynthEnumeratedRouteItem(
  item: RawMigrationSemanticItem,
): RawMigrationSemanticItem {
  const edge = normalizeBaselineMetronomeSynthEdgeItem(item);
  if (edge === item) return item;
  const order = (item.value as { readonly order?: unknown }).order;
  if (typeof order !== "number" || !Number.isSafeInteger(order) || order < 0) {
    throw new Error(
      "metronome-synth baseline enumerated route item must carry a " +
        "non-negative order",
    );
  }
  return Object.freeze({
    id: edge.id,
    value: Object.freeze({
      ...(edge.value as Record<string, unknown>),
      order,
    }),
  });
}

export function normalizeBaselineMetronomeSynthInstanceItem(
  item: RawMigrationSemanticItem,
): RawMigrationSemanticItem {
  const facts = metronomeSynthFactsOf(item);
  if (facts === null) return item;
  const derived = deriveMetronomeSynthCanonicalFacts(facts);
  const descriptor = Object.freeze({
    pool: derived.pool,
    tokens: facts.tokens.map(canonicalAddress),
    directions: facts.directions.map((direction) => Object.freeze({
      tokenIn: canonicalAddress(direction.tokenIn),
      tokenOut: canonicalAddress(direction.tokenOut),
    })),
    oracleBinding: facts.oracleBinding,
  }) as unknown as Parameters<typeof metronomeSynthStaticProjection>[0];
  const staticBindingFingerprint = hashCanonical({
    capability: METRONOME_SYNTH_CATALOG_FAMILY.hashes.instance.contentHash,
    projection: metronomeSynthStaticProjection(descriptor),
    sharedBindings: Object.freeze([]),
  });
  return Object.freeze({
    id: derived.lowerPool,
    value: Object.freeze({
      familyId: "protocol:metronome-synth",
      instanceKey: derived.lowerPool,
      staticBindingFingerprint,
    }),
  });
}

export function normalizeBaselineMetronomeSynthPriceItem(
  item: RawMigrationSemanticItem,
): RawMigrationSemanticItem {
  const facts = metronomeSynthFactsOf(item);
  if (facts === null) return item;
  const mid = (item.value as {
    readonly mid?: {
      readonly mid?: unknown;
      readonly feeBps?: unknown;
      readonly reserveA?: unknown;
      readonly reserveB?: unknown;
      readonly depthProxy?: unknown;
    };
  })?.mid;
  if (
    mid === undefined ||
    typeof mid.mid !== "number" ||
    typeof mid.feeBps !== "number" ||
    (typeof mid.reserveA !== "string" && typeof mid.reserveA !== "bigint") ||
    (typeof mid.reserveB !== "string" && typeof mid.reserveB !== "bigint") ||
    typeof mid.depthProxy !== "number"
  ) {
    return item;
  }
  const derived = deriveMetronomeSynthCanonicalFacts(facts);
  const routeEdge = Object.freeze({
    adapterId: "metronome-synth-swap",
    instanceKey: derived.lowerPool,
    target: derived.pool,
    tokenIn: derived.tokenIn,
    tokenOut: derived.tokenOut,
    slotKind: "protocol" as const,
    protocolAction: "convert" as const,
    edgeKind: "protocol" as const,
    leavesStandingPosition: false,
  });
  return Object.freeze({
    id: item.id,
    value: Object.freeze({
      stateKey: derived.lowerPool,
      mid: Object.freeze({
        kind: "protocol",
        pool: derived.pool,
        edges: Object.freeze([routeEdge]),
        mid: mid.mid,
        feeBps: mid.feeBps,
        reserveA: BigInt(mid.reserveA).toString(),
        reserveB: BigInt(mid.reserveB).toString(),
        depthProxy: mid.depthProxy,
      }),
    }),
  });
}

export function normalizeBaselineMetronomeSynthExactQuoteItem(
  item: RawMigrationSemanticItem,
): RawMigrationSemanticItem {
  const facts = metronomeSynthFactsOf(item);
  if (facts === null) return item;
  const value = item.value as {
    readonly amountIn?: unknown;
    readonly amountOut?: unknown;
  };
  if (typeof value.amountIn !== "string" || typeof value.amountOut !== "string") {
    return item;
  }
  const derived = deriveMetronomeSynthCanonicalFacts(facts);
  return Object.freeze({
    id: `${derived.canonicalId}\u001fexact:${value.amountIn}`,
    value: Object.freeze({
      routeKey: derived.routeKeyValue,
      tokenIn: derived.tokenIn,
      tokenOut: derived.tokenOut,
      canonicalEdgeId: derived.canonicalId,
      amountIn: value.amountIn,
      amountOut: value.amountOut,
      feeBps: "0",
    }),
  });
}

export function normalizeBaselineMetronomeSynthExecutionFragmentItem(
  item: RawMigrationSemanticItem,
): RawMigrationSemanticItem {
  const facts = metronomeSynthFactsOf(item);
  if (facts === null) return item;
  const value = item.value as {
    readonly amountIn?: unknown;
    readonly amountOut?: unknown;
    readonly minAmountOut?: unknown;
    readonly nodeFingerprint?: unknown;
  };
  if (
    typeof value.amountIn !== "string" ||
    typeof value.amountOut !== "string" ||
    typeof value.minAmountOut !== "string" ||
    typeof value.nodeFingerprint !== "string"
  ) {
    return item;
  }
  const derived = deriveMetronomeSynthCanonicalFacts(facts);
  return Object.freeze({
    id: `${derived.canonicalId}\u001fexec:${value.amountIn}`,
    value: Object.freeze({
      routeKey: derived.routeKeyValue,
      tokenIn: derived.tokenIn,
      tokenOut: derived.tokenOut,
      canonicalEdgeId: derived.canonicalId,
      amountIn: value.amountIn,
      amountOut: value.amountOut,
      minAmountOut: value.minAmountOut,
      actionAdapterId: "metronome-synth-swap",
      executionTarget: derived.pool,
      nodeFingerprint: value.nodeFingerprint,
    }),
  });
}

export function normalizeBaselineMetronomeSynthFinalSimulationItem(
  item: RawMigrationSemanticItem,
): RawMigrationSemanticItem {
  const facts = metronomeSynthFactsOf(item);
  if (facts === null) return item;
  const value = item.value as {
    readonly amountIn?: unknown;
    readonly amountOut?: unknown;
    readonly minAmountOut?: unknown;
    readonly effectsFingerprint?: unknown;
    readonly conservation?: unknown;
    readonly repayment?: unknown;
    readonly evInput?: unknown;
  };
  if (
    typeof value.amountIn !== "string" ||
    typeof value.amountOut !== "string" ||
    typeof value.minAmountOut !== "string" ||
    typeof value.effectsFingerprint !== "string" ||
    value.conservation !== "conserved" ||
    value.repayment !== "satisfied" ||
    value.evInput === null ||
    typeof value.evInput !== "object"
  ) {
    return item;
  }
  const evInput = value.evInput as {
    readonly amountIn?: unknown;
    readonly amountOut?: unknown;
  };
  if (
    typeof evInput.amountIn !== "string" ||
    typeof evInput.amountOut !== "string"
  ) {
    return item;
  }
  const derived = deriveMetronomeSynthCanonicalFacts(facts);
  return Object.freeze({
    id: `${derived.canonicalId}\u001fsim:${value.amountIn}`,
    value: Object.freeze({
      routeKey: derived.routeKeyValue,
      tokenIn: derived.tokenIn,
      tokenOut: derived.tokenOut,
      canonicalEdgeId: derived.canonicalId,
      amountIn: value.amountIn,
      amountOut: value.amountOut,
      minAmountOut: value.minAmountOut,
      effectsFingerprint: value.effectsFingerprint,
      conservation: value.conservation,
      repayment: value.repayment,
      evInput: Object.freeze({
        amountIn: evInput.amountIn,
        amountOut: evInput.amountOut,
      }),
    }),
  });
}

function erc4626SiloRedeemFactsGuard(
  facts: Partial<BaselineErc4626SiloRedeemFacts> | undefined,
): facts is Required<BaselineErc4626SiloRedeemFacts> {
  return facts !== undefined &&
    facts.familyId === "protocol:erc4626-silo-redeem" &&
    typeof facts.vault === "string" &&
    typeof facts.payoutToken === "string" &&
    typeof facts.underlyingAsset === "string" &&
    typeof facts.tokenIn === "string" &&
    typeof facts.tokenOut === "string";
}

function erc4626SiloRedeemFactsOf(item: RawMigrationSemanticItem) {
  const facts = (item.value as {
    readonly baselineFacts?: Partial<BaselineErc4626SiloRedeemFacts>;
  })?.baselineFacts;
  if (!erc4626SiloRedeemFactsGuard(facts)) return null;
  return facts;
}

function deriveErc4626SiloRedeemCanonicalFacts(
  facts: Required<BaselineErc4626SiloRedeemFacts>,
): {
  readonly vault: string;
  readonly payoutToken: string;
  readonly underlyingAsset: string;
  readonly lowerVault: string;
  readonly lowerPayout: string;
  readonly instanceKeyValue: string;
  readonly routeKeyValue: string;
  readonly canonicalId: string;
} {
  const vault = canonicalAddress(facts.vault);
  const payoutToken = canonicalAddress(facts.payoutToken);
  const underlyingAsset = canonicalAddress(facts.underlyingAsset);
  const lowerVault = lowerAddress(vault);
  const lowerPayout = lowerAddress(payoutToken);
  const descriptor = Object.freeze({
    vault,
    payoutToken,
    underlyingAsset,
  }) as unknown as Parameters<typeof erc4626SiloStaticProjection>[0];
  const bindingFingerprint = hashCanonical(
    erc4626SiloStaticProjection(descriptor),
  );
  const venueIdentityHash = hashCanonical(Object.freeze({
    kind: "address-subinstance",
    target: lowerVault,
    payoutToken: lowerPayout,
  }));
  const instanceKeyValue = `${lowerVault}:${lowerPayout}`;
  const routeKeyValue = [
    "protocol:erc4626-silo-redeem",
    lowerVault,
    lowerPayout,
  ].join("\u001f");
  const executionVariantKey = hashCanonical({
    namespace: "adapter-family-graph-route-v1",
    routeKey: routeKeyValue,
    routeBindingFingerprint: bindingFingerprint,
    venueIdentityHash,
  });
  const canonicalId = [
    "protocol:erc4626-silo-redeem",
    instanceKeyValue,
    lowerVault,
    `${lowerVault}>${lowerPayout}`,
    executionVariantKey,
  ].join("\u001f");
  return Object.freeze({
    vault,
    payoutToken,
    underlyingAsset,
    lowerVault,
    lowerPayout,
    instanceKeyValue,
    routeKeyValue,
    canonicalId,
  });
}

export function normalizeBaselineErc4626SiloRedeemEdgeItem(
  item: RawMigrationSemanticItem,
): RawMigrationSemanticItem {
  const facts = erc4626SiloRedeemFactsOf(item);
  if (facts === null) return item;
  const derived = deriveErc4626SiloRedeemCanonicalFacts(facts);
  return Object.freeze({
    id: derived.canonicalId,
    value: Object.freeze({
      routeKey: derived.routeKeyValue,
      tokenIn: derived.vault,
      tokenOut: derived.payoutToken,
      canonicalEdgeId: derived.canonicalId,
    }),
  });
}

export function normalizeBaselineErc4626SiloRedeemEnumeratedRouteItem(
  item: RawMigrationSemanticItem,
): RawMigrationSemanticItem {
  const edge = normalizeBaselineErc4626SiloRedeemEdgeItem(item);
  if (edge === item) return item;
  const order = (item.value as { readonly order?: unknown }).order;
  if (typeof order !== "number" || !Number.isSafeInteger(order) || order < 0) {
    throw new Error(
      "erc4626-silo-redeem baseline enumerated route item must carry a " +
        "non-negative order",
    );
  }
  return Object.freeze({
    id: edge.id,
    value: Object.freeze({
      ...(edge.value as Record<string, unknown>),
      order,
    }),
  });
}

export function normalizeBaselineErc4626SiloRedeemInstanceItem(
  item: RawMigrationSemanticItem,
): RawMigrationSemanticItem {
  const facts = erc4626SiloRedeemFactsOf(item);
  if (facts === null) return item;
  const derived = deriveErc4626SiloRedeemCanonicalFacts(facts);
  const descriptor = Object.freeze({
    vault: derived.vault,
    payoutToken: derived.payoutToken,
    underlyingAsset: derived.underlyingAsset,
  }) as unknown as Parameters<typeof erc4626SiloStaticProjection>[0];
  const staticBindingFingerprint = hashCanonical({
    capability: ERC4626_SILO_CATALOG_FAMILY.hashes.instance.contentHash,
    projection: erc4626SiloStaticProjection(descriptor),
    sharedBindings: Object.freeze([]),
  });
  return Object.freeze({
    id: derived.instanceKeyValue,
    value: Object.freeze({
      familyId: "protocol:erc4626-silo-redeem",
      instanceKey: derived.instanceKeyValue,
      staticBindingFingerprint,
    }),
  });
}

export function normalizeBaselineErc4626SiloRedeemPriceItem(
  item: RawMigrationSemanticItem,
): RawMigrationSemanticItem {
  const facts = erc4626SiloRedeemFactsOf(item);
  if (facts === null) return item;
  const mid = (item.value as {
    readonly mid?: {
      readonly mid?: unknown;
      readonly feeBps?: unknown;
      readonly reserveA?: unknown;
      readonly reserveB?: unknown;
      readonly depthProxy?: unknown;
    };
  })?.mid;
  if (
    mid === undefined ||
    typeof mid.mid !== "number" ||
    typeof mid.feeBps !== "number" ||
    (typeof mid.reserveA !== "string" && typeof mid.reserveA !== "bigint") ||
    (typeof mid.reserveB !== "string" && typeof mid.reserveB !== "bigint") ||
    typeof mid.depthProxy !== "number"
  ) {
    return item;
  }
  const derived = deriveErc4626SiloRedeemCanonicalFacts(facts);
  const routeEdge = Object.freeze({
    adapterId: "erc4626-redeem-silo",
    instanceKey: derived.instanceKeyValue,
    target: derived.vault,
    tokenIn: derived.vault,
    tokenOut: derived.payoutToken,
    slotKind: "protocol" as const,
    protocolAction: "redeem" as const,
    edgeKind: "protocol" as const,
    leavesStandingPosition: false,
  });
  return Object.freeze({
    id: item.id,
    value: Object.freeze({
      stateKey: derived.instanceKeyValue,
      mid: Object.freeze({
        kind: "protocol",
        pool: derived.vault,
        edges: Object.freeze([routeEdge]),
        mid: mid.mid,
        feeBps: mid.feeBps,
        reserveA: BigInt(mid.reserveA).toString(),
        reserveB: BigInt(mid.reserveB).toString(),
        depthProxy: mid.depthProxy,
      }),
    }),
  });
}

export function normalizeBaselineErc4626SiloRedeemExactQuoteItem(
  item: RawMigrationSemanticItem,
): RawMigrationSemanticItem {
  const facts = erc4626SiloRedeemFactsOf(item);
  if (facts === null) return item;
  const value = item.value as {
    readonly amountIn?: unknown;
    readonly amountOut?: unknown;
  };
  if (typeof value.amountIn !== "string" || typeof value.amountOut !== "string") {
    return item;
  }
  const derived = deriveErc4626SiloRedeemCanonicalFacts(facts);
  return Object.freeze({
    id: `${derived.canonicalId}\u001fexact:${value.amountIn}`,
    value: Object.freeze({
      routeKey: derived.routeKeyValue,
      tokenIn: derived.vault,
      tokenOut: derived.payoutToken,
      canonicalEdgeId: derived.canonicalId,
      amountIn: value.amountIn,
      amountOut: value.amountOut,
      feeBps: "0",
    }),
  });
}

export function normalizeBaselineErc4626SiloRedeemExecutionFragmentItem(
  item: RawMigrationSemanticItem,
): RawMigrationSemanticItem {
  const facts = erc4626SiloRedeemFactsOf(item);
  if (facts === null) return item;
  const value = item.value as {
    readonly amountIn?: unknown;
    readonly amountOut?: unknown;
    readonly minAmountOut?: unknown;
    readonly nodeFingerprint?: unknown;
  };
  if (
    typeof value.amountIn !== "string" ||
    typeof value.amountOut !== "string" ||
    typeof value.minAmountOut !== "string" ||
    typeof value.nodeFingerprint !== "string"
  ) {
    return item;
  }
  const derived = deriveErc4626SiloRedeemCanonicalFacts(facts);
  return Object.freeze({
    id: `${derived.canonicalId}\u001fexec:${value.amountIn}`,
    value: Object.freeze({
      routeKey: derived.routeKeyValue,
      tokenIn: derived.vault,
      tokenOut: derived.payoutToken,
      canonicalEdgeId: derived.canonicalId,
      amountIn: value.amountIn,
      amountOut: value.amountOut,
      minAmountOut: value.minAmountOut,
      actionAdapterId: "erc4626-redeem-silo",
      executionTarget: derived.vault,
      nodeFingerprint: value.nodeFingerprint,
    }),
  });
}

export function normalizeBaselineErc4626SiloRedeemFinalSimulationItem(
  item: RawMigrationSemanticItem,
): RawMigrationSemanticItem {
  const facts = erc4626SiloRedeemFactsOf(item);
  if (facts === null) return item;
  const value = item.value as {
    readonly amountIn?: unknown;
    readonly amountOut?: unknown;
    readonly minAmountOut?: unknown;
    readonly effectsFingerprint?: unknown;
    readonly conservation?: unknown;
    readonly repayment?: unknown;
    readonly evInput?: unknown;
  };
  if (
    typeof value.amountIn !== "string" ||
    typeof value.amountOut !== "string" ||
    typeof value.minAmountOut !== "string" ||
    typeof value.effectsFingerprint !== "string" ||
    value.conservation !== "conserved" ||
    value.repayment !== "satisfied" ||
    value.evInput === null ||
    typeof value.evInput !== "object"
  ) {
    return item;
  }
  const evInput = value.evInput as {
    readonly amountIn?: unknown;
    readonly amountOut?: unknown;
  };
  if (
    typeof evInput.amountIn !== "string" ||
    typeof evInput.amountOut !== "string"
  ) {
    return item;
  }
  const derived = deriveErc4626SiloRedeemCanonicalFacts(facts);
  return Object.freeze({
    id: `${derived.canonicalId}\u001fsim:${value.amountIn}`,
    value: Object.freeze({
      routeKey: derived.routeKeyValue,
      tokenIn: derived.vault,
      tokenOut: derived.payoutToken,
      canonicalEdgeId: derived.canonicalId,
      amountIn: value.amountIn,
      amountOut: value.amountOut,
      minAmountOut: value.minAmountOut,
      effectsFingerprint: value.effectsFingerprint,
      conservation: value.conservation,
      repayment: value.repayment,
      evInput: Object.freeze({
        amountIn: evInput.amountIn,
        amountOut: evInput.amountOut,
      }),
    }),
  });
}

function erc4626FactsGuard(
  facts: Partial<BaselineErc4626Facts> | undefined,
): facts is Required<BaselineErc4626Facts> {
  return facts !== undefined &&
    facts.familyId === "protocol:erc4626" &&
    typeof facts.vault === "string" &&
    typeof facts.asset === "string" &&
    typeof facts.share === "string" &&
    typeof facts.verifiedDirections === "object" &&
    facts.verifiedDirections !== null &&
    typeof facts.verifiedDirections.deposit === "boolean" &&
    typeof facts.verifiedDirections.redeem === "boolean" &&
    (facts.direction === "deposit" || facts.direction === "redeem") &&
    typeof facts.tokenIn === "string" &&
    typeof facts.tokenOut === "string";
}

function erc4626FactsOf(item: RawMigrationSemanticItem) {
  const facts = (item.value as {
    readonly baselineFacts?: Partial<BaselineErc4626Facts>;
  })?.baselineFacts;
  if (!erc4626FactsGuard(facts)) return null;
  return facts;
}

function deriveErc4626CanonicalFacts(
  facts: Required<BaselineErc4626Facts>,
): {
  readonly vault: string;
  readonly asset: string;
  readonly share: string;
  readonly direction: "deposit" | "redeem";
  readonly adapterId: "erc4626-deposit" | "erc4626-redeem";
  readonly protocolAction: "wrap" | "redeem";
  readonly lowerVault: string;
  readonly lowerTokenIn: string;
  readonly lowerTokenOut: string;
  readonly routeKeyValue: string;
  readonly canonicalId: string;
} {
  const vault = canonicalAddress(facts.vault);
  const asset = canonicalAddress(facts.asset);
  const share = canonicalAddress(facts.share);
  const direction = facts.direction;
  const lowerVault = lowerAddress(vault);
  const tokenIn = canonicalAddress(facts.tokenIn);
  const tokenOut = canonicalAddress(facts.tokenOut);
  const descriptor = Object.freeze({
    vault,
    asset,
    share,
    verifiedDirections: Object.freeze({
      deposit: facts.verifiedDirections.deposit,
      redeem: facts.verifiedDirections.redeem,
    }),
  }) as unknown as Parameters<typeof erc4626StaticProjection>[0];
  const bindingFingerprint = hashCanonical(
    erc4626StaticProjection(descriptor),
  );
  const venueIdentityHash = hashCanonical(Object.freeze({
    kind: "address-protocol",
    target: lowerVault,
  }));
  const routeKeyValue =
    `protocol:erc4626\u001f${lowerVault}\u001f${direction}`;
  const lowerTokenIn = lowerAddress(tokenIn);
  const lowerTokenOut = lowerAddress(tokenOut);
  const executionVariantKey = hashCanonical({
    namespace: "adapter-family-graph-route-v1",
    routeKey: routeKeyValue,
    routeBindingFingerprint: bindingFingerprint,
    venueIdentityHash,
  });
  const canonicalId = [
    "protocol:erc4626",
    lowerVault,
    lowerVault,
    `${lowerTokenIn}>${lowerTokenOut}`,
    executionVariantKey,
  ].join("\u001f");
  return Object.freeze({
    vault,
    asset,
    share,
    direction,
    adapterId: direction === "deposit"
      ? "erc4626-deposit" as const
      : "erc4626-redeem" as const,
    protocolAction: direction === "deposit"
      ? "wrap" as const
      : "redeem" as const,
    lowerVault,
    lowerTokenIn,
    lowerTokenOut,
    routeKeyValue,
    canonicalId,
  });
}

export function normalizeBaselineErc4626EdgeItem(
  item: RawMigrationSemanticItem,
): RawMigrationSemanticItem {
  const facts = erc4626FactsOf(item);
  if (facts === null) return item;
  const derived = deriveErc4626CanonicalFacts(facts);
  return Object.freeze({
    id: derived.canonicalId,
    value: Object.freeze({
      routeKey: derived.routeKeyValue,
      tokenIn: canonicalAddress(facts.tokenIn),
      tokenOut: canonicalAddress(facts.tokenOut),
      canonicalEdgeId: derived.canonicalId,
    }),
  });
}

export function normalizeBaselineErc4626EnumeratedRouteItem(
  item: RawMigrationSemanticItem,
): RawMigrationSemanticItem {
  const edge = normalizeBaselineErc4626EdgeItem(item);
  if (edge === item) return item;
  const order = (item.value as { readonly order?: unknown }).order;
  if (typeof order !== "number" || !Number.isSafeInteger(order) || order < 0) {
    throw new Error(
      "erc4626 baseline enumerated route item must carry a non-negative order",
    );
  }
  return Object.freeze({
    id: edge.id,
    value: Object.freeze({
      ...(edge.value as Record<string, unknown>),
      order,
    }),
  });
}

export function normalizeBaselineErc4626InstanceItem(
  item: RawMigrationSemanticItem,
): RawMigrationSemanticItem {
  const facts = erc4626FactsOf(item);
  if (facts === null) return item;
  const derived = deriveErc4626CanonicalFacts(facts);
  const descriptor = Object.freeze({
    vault: derived.vault,
    asset: derived.asset,
    share: derived.share,
    verifiedDirections: Object.freeze({
      deposit: facts.verifiedDirections.deposit,
      redeem: facts.verifiedDirections.redeem,
    }),
  }) as unknown as Parameters<typeof erc4626StaticProjection>[0];
  const staticBindingFingerprint = hashCanonical({
    capability: ERC4626_CATALOG_FAMILY.hashes.instance.contentHash,
    projection: erc4626StaticProjection(descriptor),
    sharedBindings: Object.freeze([]),
  });
  return Object.freeze({
    id: derived.lowerVault,
    value: Object.freeze({
      familyId: "protocol:erc4626",
      instanceKey: derived.lowerVault,
      staticBindingFingerprint,
    }),
  });
}

export function normalizeBaselineErc4626PriceItem(
  item: RawMigrationSemanticItem,
): RawMigrationSemanticItem {
  const facts = erc4626FactsOf(item);
  if (facts === null) return item;
  const mid = (item.value as {
    readonly mid?: {
      readonly mid?: unknown;
      readonly feeBps?: unknown;
      readonly reserveA?: unknown;
      readonly reserveB?: unknown;
      readonly depthProxy?: unknown;
    };
  })?.mid;
  if (
    mid === undefined ||
    typeof mid.mid !== "number" ||
    typeof mid.feeBps !== "number" ||
    (typeof mid.reserveA !== "string" && typeof mid.reserveA !== "bigint") ||
    (typeof mid.reserveB !== "string" && typeof mid.reserveB !== "bigint") ||
    typeof mid.depthProxy !== "number"
  ) {
    return item;
  }
  const derived = deriveErc4626CanonicalFacts(facts);
  const routeEdge = Object.freeze({
    adapterId: derived.adapterId,
    instanceKey: derived.lowerVault,
    target: derived.vault,
    tokenIn: canonicalAddress(facts.tokenIn),
    tokenOut: canonicalAddress(facts.tokenOut),
    slotKind: "protocol" as const,
    protocolAction: derived.protocolAction,
    edgeKind: "protocol" as const,
    leavesStandingPosition: false,
  });
  return Object.freeze({
    id: item.id,
    value: Object.freeze({
      stateKey: derived.lowerVault,
      mid: Object.freeze({
        kind: "protocol",
        pool: derived.vault,
        edges: Object.freeze([routeEdge]),
        mid: mid.mid,
        feeBps: mid.feeBps,
        reserveA: BigInt(mid.reserveA).toString(),
        reserveB: BigInt(mid.reserveB).toString(),
        depthProxy: mid.depthProxy,
      }),
    }),
  });
}

export function normalizeBaselineErc4626ExactQuoteItem(
  item: RawMigrationSemanticItem,
): RawMigrationSemanticItem {
  const facts = erc4626FactsOf(item);
  if (facts === null) return item;
  const value = item.value as {
    readonly amountIn?: unknown;
    readonly amountOut?: unknown;
  };
  if (typeof value.amountIn !== "string" || typeof value.amountOut !== "string") {
    return item;
  }
  const derived = deriveErc4626CanonicalFacts(facts);
  return Object.freeze({
    id: `${derived.canonicalId}\u001fexact:${value.amountIn}`,
    value: Object.freeze({
      routeKey: derived.routeKeyValue,
      tokenIn: canonicalAddress(facts.tokenIn),
      tokenOut: canonicalAddress(facts.tokenOut),
      canonicalEdgeId: derived.canonicalId,
      amountIn: value.amountIn,
      amountOut: value.amountOut,
      feeBps: "0",
    }),
  });
}

export function normalizeBaselineErc4626ExecutionFragmentItem(
  item: RawMigrationSemanticItem,
): RawMigrationSemanticItem {
  const facts = erc4626FactsOf(item);
  if (facts === null) return item;
  const value = item.value as {
    readonly amountIn?: unknown;
    readonly amountOut?: unknown;
    readonly minAmountOut?: unknown;
    readonly nodeFingerprint?: unknown;
  };
  if (
    typeof value.amountIn !== "string" ||
    typeof value.amountOut !== "string" ||
    typeof value.minAmountOut !== "string" ||
    typeof value.nodeFingerprint !== "string"
  ) {
    return item;
  }
  const derived = deriveErc4626CanonicalFacts(facts);
  return Object.freeze({
    id: `${derived.canonicalId}\u001fexec:${value.amountIn}`,
    value: Object.freeze({
      routeKey: derived.routeKeyValue,
      tokenIn: canonicalAddress(facts.tokenIn),
      tokenOut: canonicalAddress(facts.tokenOut),
      canonicalEdgeId: derived.canonicalId,
      amountIn: value.amountIn,
      amountOut: value.amountOut,
      minAmountOut: value.minAmountOut,
      actionAdapterId: derived.adapterId,
      executionTarget: derived.vault,
      nodeFingerprint: value.nodeFingerprint,
    }),
  });
}

export function normalizeBaselineErc4626FinalSimulationItem(
  item: RawMigrationSemanticItem,
): RawMigrationSemanticItem {
  const facts = erc4626FactsOf(item);
  if (facts === null) return item;
  const value = item.value as {
    readonly amountIn?: unknown;
    readonly amountOut?: unknown;
    readonly minAmountOut?: unknown;
    readonly effectsFingerprint?: unknown;
    readonly conservation?: unknown;
    readonly repayment?: unknown;
    readonly evInput?: unknown;
  };
  if (
    typeof value.amountIn !== "string" ||
    typeof value.amountOut !== "string" ||
    typeof value.minAmountOut !== "string" ||
    typeof value.effectsFingerprint !== "string" ||
    value.conservation !== "conserved" ||
    value.repayment !== "satisfied" ||
    value.evInput === null ||
    typeof value.evInput !== "object"
  ) {
    return item;
  }
  const evInput = value.evInput as {
    readonly amountIn?: unknown;
    readonly amountOut?: unknown;
  };
  if (
    typeof evInput.amountIn !== "string" ||
    typeof evInput.amountOut !== "string"
  ) {
    return item;
  }
  const derived = deriveErc4626CanonicalFacts(facts);
  return Object.freeze({
    id: `${derived.canonicalId}\u001fsim:${value.amountIn}`,
    value: Object.freeze({
      routeKey: derived.routeKeyValue,
      tokenIn: canonicalAddress(facts.tokenIn),
      tokenOut: canonicalAddress(facts.tokenOut),
      canonicalEdgeId: derived.canonicalId,
      amountIn: value.amountIn,
      amountOut: value.amountOut,
      minAmountOut: value.minAmountOut,
      effectsFingerprint: value.effectsFingerprint,
      conservation: value.conservation,
      repayment: value.repayment,
      evInput: Object.freeze({
        amountIn: evInput.amountIn,
        amountOut: evInput.amountOut,
      }),
    }),
  });
}

function etherTokenNativeRedeemFactsGuard(
  facts: Partial<BaselineEtherTokenNativeRedeemFacts> | undefined,
): facts is Required<BaselineEtherTokenNativeRedeemFacts> {
  return facts !== undefined &&
    facts.familyId === "protocol:ethertoken-native-redeem" &&
    typeof facts.token === "string" &&
    typeof facts.nativeAnchor === "string" &&
    typeof facts.tokenIn === "string" &&
    typeof facts.tokenOut === "string";
}

function etherTokenNativeRedeemFactsOf(item: RawMigrationSemanticItem) {
  const facts = (item.value as {
    readonly baselineFacts?: Partial<BaselineEtherTokenNativeRedeemFacts>;
  })?.baselineFacts;
  if (!etherTokenNativeRedeemFactsGuard(facts)) return null;
  return facts;
}

function deriveEtherTokenNativeRedeemCanonicalFacts(
  facts: Required<BaselineEtherTokenNativeRedeemFacts>,
): {
  readonly token: string;
  readonly nativeAnchor: string;
  readonly lowerToken: string;
  readonly lowerNative: string;
  readonly routeKeyValue: string;
  readonly canonicalId: string;
} {
  const token = canonicalAddress(facts.token);
  const nativeAnchor = canonicalAddress(facts.nativeAnchor);
  const lowerToken = lowerAddress(token);
  const lowerNative = lowerAddress(nativeAnchor);
  const descriptor = Object.freeze({
    token,
    nativeAnchor,
  }) as unknown as Parameters<typeof etherTokenNativeStaticProjection>[0];
  const bindingFingerprint = hashCanonical(
    etherTokenNativeStaticProjection(descriptor),
  );
  const venueIdentityHash = hashCanonical(Object.freeze({
    kind: "address-protocol",
    target: lowerToken,
  }));
  const routeKeyValue =
    `protocol:ethertoken-native-redeem\u001f${lowerToken}`;
  const executionVariantKey = hashCanonical({
    namespace: "adapter-family-graph-route-v1",
    routeKey: routeKeyValue,
    routeBindingFingerprint: bindingFingerprint,
    venueIdentityHash,
  });
  const canonicalId = [
    "protocol:ethertoken-native-redeem",
    lowerToken,
    lowerToken,
    `${lowerToken}>${lowerNative}`,
    executionVariantKey,
  ].join("\u001f");
  return Object.freeze({
    token,
    nativeAnchor,
    lowerToken,
    lowerNative,
    routeKeyValue,
    canonicalId,
  });
}

export function normalizeBaselineEtherTokenNativeRedeemEdgeItem(
  item: RawMigrationSemanticItem,
): RawMigrationSemanticItem {
  const facts = etherTokenNativeRedeemFactsOf(item);
  if (facts === null) return item;
  const derived = deriveEtherTokenNativeRedeemCanonicalFacts(facts);
  return Object.freeze({
    id: derived.canonicalId,
    value: Object.freeze({
      routeKey: derived.routeKeyValue,
      tokenIn: derived.token,
      tokenOut: derived.nativeAnchor,
      canonicalEdgeId: derived.canonicalId,
    }),
  });
}

export function normalizeBaselineEtherTokenNativeRedeemEnumeratedRouteItem(
  item: RawMigrationSemanticItem,
): RawMigrationSemanticItem {
  const edge = normalizeBaselineEtherTokenNativeRedeemEdgeItem(item);
  if (edge === item) return item;
  const order = (item.value as { readonly order?: unknown }).order;
  if (typeof order !== "number" || !Number.isSafeInteger(order) || order < 0) {
    throw new Error(
      "ethertoken-native-redeem baseline enumerated route item must carry " +
        "a non-negative order",
    );
  }
  return Object.freeze({
    id: edge.id,
    value: Object.freeze({
      ...(edge.value as Record<string, unknown>),
      order,
    }),
  });
}

export function normalizeBaselineEtherTokenNativeRedeemInstanceItem(
  item: RawMigrationSemanticItem,
): RawMigrationSemanticItem {
  const facts = etherTokenNativeRedeemFactsOf(item);
  if (facts === null) return item;
  const derived = deriveEtherTokenNativeRedeemCanonicalFacts(facts);
  const descriptor = Object.freeze({
    token: derived.token,
    nativeAnchor: derived.nativeAnchor,
  }) as unknown as Parameters<typeof etherTokenNativeStaticProjection>[0];
  const staticBindingFingerprint = hashCanonical({
    capability: ETHERTOKEN_NATIVE_CATALOG_FAMILY.hashes.instance.contentHash,
    projection: etherTokenNativeStaticProjection(descriptor),
    sharedBindings: Object.freeze([]),
  });
  return Object.freeze({
    id: derived.lowerToken,
    value: Object.freeze({
      familyId: "protocol:ethertoken-native-redeem",
      instanceKey: derived.lowerToken,
      staticBindingFingerprint,
    }),
  });
}

export function normalizeBaselineEtherTokenNativeRedeemPriceItem(
  item: RawMigrationSemanticItem,
): RawMigrationSemanticItem {
  const facts = etherTokenNativeRedeemFactsOf(item);
  if (facts === null) return item;
  const mid = (item.value as {
    readonly mid?: {
      readonly mid?: unknown;
      readonly feeBps?: unknown;
      readonly reserveA?: unknown;
      readonly reserveB?: unknown;
      readonly depthProxy?: unknown;
    };
  })?.mid;
  if (
    mid === undefined ||
    typeof mid.mid !== "number" ||
    typeof mid.feeBps !== "number" ||
    (typeof mid.reserveA !== "string" && typeof mid.reserveA !== "bigint") ||
    (typeof mid.reserveB !== "string" && typeof mid.reserveB !== "bigint") ||
    typeof mid.depthProxy !== "number"
  ) {
    return item;
  }
  const derived = deriveEtherTokenNativeRedeemCanonicalFacts(facts);
  const routeEdge = Object.freeze({
    adapterId: "ethertoken-native-redeem",
    instanceKey: derived.lowerToken,
    target: derived.token,
    tokenIn: derived.token,
    tokenOut: derived.nativeAnchor,
    slotKind: "protocol" as const,
    protocolAction: "redeem" as const,
    edgeKind: "protocol" as const,
    leavesStandingPosition: false,
  });
  return Object.freeze({
    id: item.id,
    value: Object.freeze({
      stateKey: derived.lowerToken,
      mid: Object.freeze({
        kind: "protocol",
        pool: derived.token,
        edges: Object.freeze([routeEdge]),
        mid: mid.mid,
        feeBps: mid.feeBps,
        reserveA: BigInt(mid.reserveA).toString(),
        reserveB: BigInt(mid.reserveB).toString(),
        depthProxy: mid.depthProxy,
      }),
    }),
  });
}

export function normalizeBaselineEtherTokenNativeRedeemExactQuoteItem(
  item: RawMigrationSemanticItem,
): RawMigrationSemanticItem {
  const facts = etherTokenNativeRedeemFactsOf(item);
  if (facts === null) return item;
  const value = item.value as {
    readonly amountIn?: unknown;
    readonly amountOut?: unknown;
  };
  if (typeof value.amountIn !== "string" || typeof value.amountOut !== "string") {
    return item;
  }
  const derived = deriveEtherTokenNativeRedeemCanonicalFacts(facts);
  return Object.freeze({
    id: `${derived.canonicalId}\u001fexact:${value.amountIn}`,
    value: Object.freeze({
      routeKey: derived.routeKeyValue,
      tokenIn: derived.token,
      tokenOut: derived.nativeAnchor,
      canonicalEdgeId: derived.canonicalId,
      amountIn: value.amountIn,
      amountOut: value.amountOut,
      feeBps: "0",
    }),
  });
}

export function normalizeBaselineEtherTokenNativeRedeemExecutionFragmentItem(
  item: RawMigrationSemanticItem,
): RawMigrationSemanticItem {
  const facts = etherTokenNativeRedeemFactsOf(item);
  if (facts === null) return item;
  const value = item.value as {
    readonly amountIn?: unknown;
    readonly amountOut?: unknown;
    readonly minAmountOut?: unknown;
    readonly nodeFingerprint?: unknown;
  };
  if (
    typeof value.amountIn !== "string" ||
    typeof value.amountOut !== "string" ||
    typeof value.minAmountOut !== "string" ||
    typeof value.nodeFingerprint !== "string"
  ) {
    return item;
  }
  const derived = deriveEtherTokenNativeRedeemCanonicalFacts(facts);
  return Object.freeze({
    id: `${derived.canonicalId}\u001fexec:${value.amountIn}`,
    value: Object.freeze({
      routeKey: derived.routeKeyValue,
      tokenIn: derived.token,
      tokenOut: derived.nativeAnchor,
      canonicalEdgeId: derived.canonicalId,
      amountIn: value.amountIn,
      amountOut: value.amountOut,
      minAmountOut: value.minAmountOut,
      actionAdapterId: "ethertoken-native-redeem",
      executionTarget: derived.token,
      nodeFingerprint: value.nodeFingerprint,
    }),
  });
}

export function normalizeBaselineEtherTokenNativeRedeemFinalSimulationItem(
  item: RawMigrationSemanticItem,
): RawMigrationSemanticItem {
  const facts = etherTokenNativeRedeemFactsOf(item);
  if (facts === null) return item;
  const value = item.value as {
    readonly amountIn?: unknown;
    readonly amountOut?: unknown;
    readonly minAmountOut?: unknown;
    readonly effectsFingerprint?: unknown;
    readonly conservation?: unknown;
    readonly repayment?: unknown;
    readonly evInput?: unknown;
  };
  if (
    typeof value.amountIn !== "string" ||
    typeof value.amountOut !== "string" ||
    typeof value.minAmountOut !== "string" ||
    typeof value.effectsFingerprint !== "string" ||
    value.conservation !== "conserved" ||
    value.repayment !== "satisfied" ||
    value.evInput === null ||
    typeof value.evInput !== "object"
  ) {
    return item;
  }
  const evInput = value.evInput as {
    readonly amountIn?: unknown;
    readonly amountOut?: unknown;
  };
  if (
    typeof evInput.amountIn !== "string" ||
    typeof evInput.amountOut !== "string"
  ) {
    return item;
  }
  const derived = deriveEtherTokenNativeRedeemCanonicalFacts(facts);
  return Object.freeze({
    id: `${derived.canonicalId}\u001fsim:${value.amountIn}`,
    value: Object.freeze({
      routeKey: derived.routeKeyValue,
      tokenIn: derived.token,
      tokenOut: derived.nativeAnchor,
      canonicalEdgeId: derived.canonicalId,
      amountIn: value.amountIn,
      amountOut: value.amountOut,
      minAmountOut: value.minAmountOut,
      effectsFingerprint: value.effectsFingerprint,
      conservation: value.conservation,
      repayment: value.repayment,
      evInput: Object.freeze({
        amountIn: evInput.amountIn,
        amountOut: evInput.amountOut,
      }),
    }),
  });
}

function selfBurnNativeFactsGuard(
  facts: Partial<BaselineSelfBurnNativeFacts> | undefined,
): facts is Required<BaselineSelfBurnNativeFacts> {
  return facts !== undefined &&
    facts.familyId === "protocol:self-burn-native" &&
    typeof facts.token === "string" &&
    typeof facts.nativeAnchor === "string" &&
    typeof facts.tokenIn === "string" &&
    typeof facts.tokenOut === "string";
}

function selfBurnNativeFactsOf(item: RawMigrationSemanticItem) {
  const facts = (item.value as {
    readonly baselineFacts?: Partial<BaselineSelfBurnNativeFacts>;
  })?.baselineFacts;
  if (!selfBurnNativeFactsGuard(facts)) return null;
  return facts;
}

function deriveSelfBurnNativeCanonicalFacts(
  facts: Required<BaselineSelfBurnNativeFacts>,
): {
  readonly token: string;
  readonly nativeAnchor: string;
  readonly lowerToken: string;
  readonly lowerNative: string;
  readonly routeKeyValue: string;
  readonly canonicalId: string;
} {
  const token = canonicalAddress(facts.token);
  const nativeAnchor = canonicalAddress(facts.nativeAnchor);
  const lowerToken = lowerAddress(token);
  const lowerNative = lowerAddress(nativeAnchor);
  const descriptor = Object.freeze({
    token,
    nativeAnchor,
  }) as unknown as Parameters<typeof selfBurnNativeStaticProjection>[0];
  const bindingFingerprint = hashCanonical(
    selfBurnNativeStaticProjection(descriptor),
  );
  const venueIdentityHash = hashCanonical(Object.freeze({
    kind: "address-protocol",
    target: lowerToken,
  }));
  const routeKeyValue =
    `protocol:self-burn-native\u001f${lowerToken}`;
  const executionVariantKey = hashCanonical({
    namespace: "adapter-family-graph-route-v1",
    routeKey: routeKeyValue,
    routeBindingFingerprint: bindingFingerprint,
    venueIdentityHash,
  });
  const canonicalId = [
    "protocol:self-burn-native",
    lowerToken,
    lowerToken,
    `${lowerToken}>${lowerNative}`,
    executionVariantKey,
  ].join("\u001f");
  return Object.freeze({
    token,
    nativeAnchor,
    lowerToken,
    lowerNative,
    routeKeyValue,
    canonicalId,
  });
}

export function normalizeBaselineSelfBurnNativeEdgeItem(
  item: RawMigrationSemanticItem,
): RawMigrationSemanticItem {
  const facts = selfBurnNativeFactsOf(item);
  if (facts === null) return item;
  const derived = deriveSelfBurnNativeCanonicalFacts(facts);
  return Object.freeze({
    id: derived.canonicalId,
    value: Object.freeze({
      routeKey: derived.routeKeyValue,
      tokenIn: derived.token,
      tokenOut: derived.nativeAnchor,
      canonicalEdgeId: derived.canonicalId,
    }),
  });
}

export function normalizeBaselineSelfBurnNativeEnumeratedRouteItem(
  item: RawMigrationSemanticItem,
): RawMigrationSemanticItem {
  const edge = normalizeBaselineSelfBurnNativeEdgeItem(item);
  if (edge === item) return item;
  const order = (item.value as { readonly order?: unknown }).order;
  if (typeof order !== "number" || !Number.isSafeInteger(order) || order < 0) {
    throw new Error(
      "self-burn-native baseline enumerated route item must carry a " +
        "non-negative order",
    );
  }
  return Object.freeze({
    id: edge.id,
    value: Object.freeze({
      ...(edge.value as Record<string, unknown>),
      order,
    }),
  });
}

export function normalizeBaselineSelfBurnNativeInstanceItem(
  item: RawMigrationSemanticItem,
): RawMigrationSemanticItem {
  const facts = selfBurnNativeFactsOf(item);
  if (facts === null) return item;
  const derived = deriveSelfBurnNativeCanonicalFacts(facts);
  const descriptor = Object.freeze({
    token: derived.token,
    nativeAnchor: derived.nativeAnchor,
  }) as unknown as Parameters<typeof selfBurnNativeStaticProjection>[0];
  const staticBindingFingerprint = hashCanonical({
    capability: SELF_BURN_NATIVE_CATALOG_FAMILY.hashes.instance.contentHash,
    projection: selfBurnNativeStaticProjection(descriptor),
    sharedBindings: Object.freeze([]),
  });
  return Object.freeze({
    id: derived.lowerToken,
    value: Object.freeze({
      familyId: "protocol:self-burn-native",
      instanceKey: derived.lowerToken,
      staticBindingFingerprint,
    }),
  });
}

export function normalizeBaselineSelfBurnNativePriceItem(
  item: RawMigrationSemanticItem,
): RawMigrationSemanticItem {
  const facts = selfBurnNativeFactsOf(item);
  if (facts === null) return item;
  const mid = (item.value as {
    readonly mid?: {
      readonly mid?: unknown;
      readonly feeBps?: unknown;
      readonly reserveA?: unknown;
      readonly reserveB?: unknown;
      readonly depthProxy?: unknown;
    };
  })?.mid;
  if (
    mid === undefined ||
    typeof mid.mid !== "number" ||
    typeof mid.feeBps !== "number" ||
    (typeof mid.reserveA !== "string" && typeof mid.reserveA !== "bigint") ||
    (typeof mid.reserveB !== "string" && typeof mid.reserveB !== "bigint") ||
    typeof mid.depthProxy !== "number"
  ) {
    return item;
  }
  const derived = deriveSelfBurnNativeCanonicalFacts(facts);
  const routeEdge = Object.freeze({
    adapterId: "self-burn-native-redeem",
    instanceKey: derived.lowerToken,
    target: derived.token,
    tokenIn: derived.token,
    tokenOut: derived.nativeAnchor,
    slotKind: "protocol" as const,
    protocolAction: "redeem" as const,
    edgeKind: "protocol" as const,
    leavesStandingPosition: false,
  });
  return Object.freeze({
    id: item.id,
    value: Object.freeze({
      stateKey: derived.lowerToken,
      mid: Object.freeze({
        kind: "protocol",
        pool: derived.token,
        edges: Object.freeze([routeEdge]),
        mid: mid.mid,
        feeBps: mid.feeBps,
        reserveA: BigInt(mid.reserveA).toString(),
        reserveB: BigInt(mid.reserveB).toString(),
        depthProxy: mid.depthProxy,
      }),
    }),
  });
}

export function normalizeBaselineSelfBurnNativeExactQuoteItem(
  item: RawMigrationSemanticItem,
): RawMigrationSemanticItem {
  const facts = selfBurnNativeFactsOf(item);
  if (facts === null) return item;
  const value = item.value as {
    readonly amountIn?: unknown;
    readonly amountOut?: unknown;
  };
  if (typeof value.amountIn !== "string" || typeof value.amountOut !== "string") {
    return item;
  }
  const derived = deriveSelfBurnNativeCanonicalFacts(facts);
  return Object.freeze({
    id: `${derived.canonicalId}\u001fexact:${value.amountIn}`,
    value: Object.freeze({
      routeKey: derived.routeKeyValue,
      tokenIn: derived.token,
      tokenOut: derived.nativeAnchor,
      canonicalEdgeId: derived.canonicalId,
      amountIn: value.amountIn,
      amountOut: value.amountOut,
      feeBps: "0",
    }),
  });
}

export function normalizeBaselineSelfBurnNativeExecutionFragmentItem(
  item: RawMigrationSemanticItem,
): RawMigrationSemanticItem {
  const facts = selfBurnNativeFactsOf(item);
  if (facts === null) return item;
  const value = item.value as {
    readonly amountIn?: unknown;
    readonly amountOut?: unknown;
    readonly minAmountOut?: unknown;
    readonly nodeFingerprint?: unknown;
  };
  if (
    typeof value.amountIn !== "string" ||
    typeof value.amountOut !== "string" ||
    typeof value.minAmountOut !== "string" ||
    typeof value.nodeFingerprint !== "string"
  ) {
    return item;
  }
  const derived = deriveSelfBurnNativeCanonicalFacts(facts);
  return Object.freeze({
    id: `${derived.canonicalId}\u001fexec:${value.amountIn}`,
    value: Object.freeze({
      routeKey: derived.routeKeyValue,
      tokenIn: derived.token,
      tokenOut: derived.nativeAnchor,
      canonicalEdgeId: derived.canonicalId,
      amountIn: value.amountIn,
      amountOut: value.amountOut,
      minAmountOut: value.minAmountOut,
      actionAdapterId: "self-burn-native-redeem",
      executionTarget: derived.token,
      nodeFingerprint: value.nodeFingerprint,
    }),
  });
}

export function normalizeBaselineSelfBurnNativeFinalSimulationItem(
  item: RawMigrationSemanticItem,
): RawMigrationSemanticItem {
  const facts = selfBurnNativeFactsOf(item);
  if (facts === null) return item;
  const value = item.value as {
    readonly amountIn?: unknown;
    readonly amountOut?: unknown;
    readonly minAmountOut?: unknown;
    readonly effectsFingerprint?: unknown;
    readonly conservation?: unknown;
    readonly repayment?: unknown;
    readonly evInput?: unknown;
  };
  if (
    typeof value.amountIn !== "string" ||
    typeof value.amountOut !== "string" ||
    typeof value.minAmountOut !== "string" ||
    typeof value.effectsFingerprint !== "string" ||
    value.conservation !== "conserved" ||
    value.repayment !== "satisfied" ||
    value.evInput === null ||
    typeof value.evInput !== "object"
  ) {
    return item;
  }
  const evInput = value.evInput as {
    readonly amountIn?: unknown;
    readonly amountOut?: unknown;
  };
  if (
    typeof evInput.amountIn !== "string" ||
    typeof evInput.amountOut !== "string"
  ) {
    return item;
  }
  const derived = deriveSelfBurnNativeCanonicalFacts(facts);
  return Object.freeze({
    id: `${derived.canonicalId}\u001fsim:${value.amountIn}`,
    value: Object.freeze({
      routeKey: derived.routeKeyValue,
      tokenIn: derived.token,
      tokenOut: derived.nativeAnchor,
      canonicalEdgeId: derived.canonicalId,
      amountIn: value.amountIn,
      amountOut: value.amountOut,
      minAmountOut: value.minAmountOut,
      effectsFingerprint: value.effectsFingerprint,
      conservation: value.conservation,
      repayment: value.repayment,
      evInput: Object.freeze({
        amountIn: evInput.amountIn,
        amountOut: evInput.amountOut,
      }),
    }),
  });
}

function astraMultiTokenFactsGuard(
  facts: Partial<BaselineAstraMultiTokenFacts> | undefined,
): facts is Required<BaselineAstraMultiTokenFacts> {
  return facts !== undefined &&
    facts.familyId === "protocol:astra-multitoken" &&
    typeof facts.target === "string" &&
    Array.isArray(facts.tokens) &&
    facts.tokens.every((token) => typeof token === "string") &&
    Array.isArray(facts.tokenWeights) &&
    facts.tokenWeights.every((binding) =>
      typeof binding?.token === "string" &&
      typeof binding?.weight === "string" &&
      typeof binding?.codeHash === "string"
    ) &&
    typeof facts.behaviorBinding === "object" &&
    facts.behaviorBinding !== null &&
    (facts.behaviorBinding.interfaceMode === "erc165" ||
      facts.behaviorBinding.interfaceMode === "legacy-abi") &&
    facts.behaviorBinding.changesEnabled === true &&
    typeof facts.behaviorBinding.totalPercents === "string" &&
    typeof facts.behaviorBinding.changeFee === "string" &&
    (facts.behaviorBinding.inLendingMode === null ||
      typeof facts.behaviorBinding.inLendingMode === "string") &&
    facts.behaviorBinding.activeProof === "registry-bound-effect-delta" &&
    typeof facts.tokenIn === "string" &&
    typeof facts.tokenOut === "string";
}

function astraMultiTokenFactsOf(item: RawMigrationSemanticItem) {
  const facts = (item.value as {
    readonly baselineFacts?: Partial<BaselineAstraMultiTokenFacts>;
  })?.baselineFacts;
  if (!astraMultiTokenFactsGuard(facts)) return null;
  return facts;
}

function astraDescriptorFor(
  facts: Required<BaselineAstraMultiTokenFacts>,
) {
  const target = canonicalAddress(facts.target);
  return Object.freeze({
    familyId: "protocol:astra-multitoken",
    lineageId: "astra-multitoken:observed-active-registry",
    instanceKey: lowerAddress(target),
    target,
    registryBinding: Object.freeze({
      registryContract: target,
      tokens: Object.freeze(facts.tokens.map(canonicalAddress)),
      tokenWeights: Object.freeze(facts.tokenWeights.map((binding) =>
        Object.freeze({
          token: canonicalAddress(binding.token),
          weight: BigInt(binding.weight),
          codeHash: binding.codeHash,
        })
      )),
    }),
    behaviorBinding: Object.freeze({
      interfaceMode: facts.behaviorBinding.interfaceMode,
      changesEnabled: facts.behaviorBinding.changesEnabled,
      totalPercents: BigInt(facts.behaviorBinding.totalPercents),
      changeFee: BigInt(facts.behaviorBinding.changeFee),
      inLendingMode: facts.behaviorBinding.inLendingMode === null
        ? null
        : BigInt(facts.behaviorBinding.inLendingMode),
      activeProof: facts.behaviorBinding.activeProof,
    }),
    runtimeRequirements: Object.freeze([]),
  }) as unknown as import("./venues/protocols/astra-multitoken-family/types.js")
    .AstraMultiTokenDescriptor;
}

function deriveAstraMultiTokenCanonicalFacts(
  facts: Required<BaselineAstraMultiTokenFacts>,
): {
  readonly target: string;
  readonly tokenIn: string;
  readonly tokenOut: string;
  readonly lowerTarget: string;
  readonly lowerTokenIn: string;
  readonly lowerTokenOut: string;
  readonly routeKeyValue: string;
  readonly canonicalId: string;
} {
  const target = canonicalAddress(facts.target);
  const tokenIn = canonicalAddress(facts.tokenIn);
  const tokenOut = canonicalAddress(facts.tokenOut);
  const lowerTarget = lowerAddress(target);
  const descriptor = astraDescriptorFor(facts);
  const bindingFingerprint = hashCanonical(
    astraStaticBindingProjection(descriptor),
  );
  const venueIdentityHash = hashCanonical(Object.freeze({
    kind: "address-protocol",
    target: lowerTarget,
  }));
  const lowerTokenIn = lowerAddress(tokenIn);
  const lowerTokenOut = lowerAddress(tokenOut);
  const routeKeyValue = [
    "protocol:astra-multitoken",
    lowerTarget,
    lowerTokenIn,
    lowerTokenOut,
  ].join("\u001f");
  const executionVariantKey = hashCanonical({
    namespace: "adapter-family-graph-route-v1",
    routeKey: routeKeyValue,
    routeBindingFingerprint: bindingFingerprint,
    venueIdentityHash,
  });
  const canonicalId = [
    "protocol:astra-multitoken",
    lowerTarget,
    lowerTarget,
    `${lowerTokenIn}>${lowerTokenOut}`,
    executionVariantKey,
  ].join("\u001f");
  return Object.freeze({
    target,
    tokenIn,
    tokenOut,
    lowerTarget,
    lowerTokenIn,
    lowerTokenOut,
    routeKeyValue,
    canonicalId,
  });
}

export function normalizeBaselineAstraMultiTokenEdgeItem(
  item: RawMigrationSemanticItem,
): RawMigrationSemanticItem {
  const facts = astraMultiTokenFactsOf(item);
  if (facts === null) return item;
  const derived = deriveAstraMultiTokenCanonicalFacts(facts);
  return Object.freeze({
    id: derived.canonicalId,
    value: Object.freeze({
      routeKey: derived.routeKeyValue,
      tokenIn: derived.tokenIn,
      tokenOut: derived.tokenOut,
      canonicalEdgeId: derived.canonicalId,
    }),
  });
}

export function normalizeBaselineAstraMultiTokenEnumeratedRouteItem(
  item: RawMigrationSemanticItem,
): RawMigrationSemanticItem {
  const edge = normalizeBaselineAstraMultiTokenEdgeItem(item);
  if (edge === item) return item;
  const order = (item.value as { readonly order?: unknown }).order;
  if (typeof order !== "number" || !Number.isSafeInteger(order) || order < 0) {
    throw new Error(
      "astra-multitoken baseline enumerated route item must carry a " +
        "non-negative order",
    );
  }
  return Object.freeze({
    id: edge.id,
    value: Object.freeze({
      ...(edge.value as Record<string, unknown>),
      order,
    }),
  });
}

export function normalizeBaselineAstraMultiTokenInstanceItem(
  item: RawMigrationSemanticItem,
): RawMigrationSemanticItem {
  const facts = astraMultiTokenFactsOf(item);
  if (facts === null) return item;
  const derived = deriveAstraMultiTokenCanonicalFacts(facts);
  const descriptor = astraDescriptorFor(facts);
  const staticBindingFingerprint = hashCanonical({
    capability: ASTRA_CATALOG_FAMILY.hashes.instance.contentHash,
    projection: astraStaticBindingProjection(descriptor),
    sharedBindings: Object.freeze([]),
  });
  return Object.freeze({
    id: derived.lowerTarget,
    value: Object.freeze({
      familyId: "protocol:astra-multitoken",
      instanceKey: derived.lowerTarget,
      staticBindingFingerprint,
    }),
  });
}

export function normalizeBaselineAstraMultiTokenPriceItem(
  item: RawMigrationSemanticItem,
): RawMigrationSemanticItem {
  const facts = astraMultiTokenFactsOf(item);
  if (facts === null) return item;
  const mid = (item.value as {
    readonly mid?: {
      readonly mid?: unknown;
      readonly feeBps?: unknown;
      readonly reserveA?: unknown;
      readonly reserveB?: unknown;
      readonly depthProxy?: unknown;
    };
  })?.mid;
  if (
    mid === undefined ||
    typeof mid.mid !== "number" ||
    typeof mid.feeBps !== "number" ||
    (typeof mid.reserveA !== "string" && typeof mid.reserveA !== "bigint") ||
    (typeof mid.reserveB !== "string" && typeof mid.reserveB !== "bigint") ||
    typeof mid.depthProxy !== "number"
  ) {
    return item;
  }
  const derived = deriveAstraMultiTokenCanonicalFacts(facts);
  const routeEdge = Object.freeze({
    adapterId: "astra-multitoken-change",
    instanceKey: derived.lowerTarget,
    target: derived.target,
    tokenIn: derived.tokenIn,
    tokenOut: derived.tokenOut,
    slotKind: "protocol" as const,
    protocolAction: "convert" as const,
    edgeKind: "protocol" as const,
    leavesStandingPosition: false,
  });
  return Object.freeze({
    id: item.id,
    value: Object.freeze({
      stateKey: derived.routeKeyValue,
      mid: Object.freeze({
        kind: "protocol",
        pool: derived.target,
        edges: Object.freeze([routeEdge]),
        mid: mid.mid,
        feeBps: mid.feeBps,
        reserveA: BigInt(mid.reserveA).toString(),
        reserveB: BigInt(mid.reserveB).toString(),
        depthProxy: mid.depthProxy,
      }),
    }),
  });
}

export function normalizeBaselineAstraMultiTokenExactQuoteItem(
  item: RawMigrationSemanticItem,
): RawMigrationSemanticItem {
  const facts = astraMultiTokenFactsOf(item);
  if (facts === null) return item;
  const value = item.value as {
    readonly amountIn?: unknown;
    readonly amountOut?: unknown;
  };
  if (typeof value.amountIn !== "string" || typeof value.amountOut !== "string") {
    return item;
  }
  const derived = deriveAstraMultiTokenCanonicalFacts(facts);
  return Object.freeze({
    id: `${derived.canonicalId}\u001fexact:${value.amountIn}`,
    value: Object.freeze({
      routeKey: derived.routeKeyValue,
      tokenIn: derived.tokenIn,
      tokenOut: derived.tokenOut,
      canonicalEdgeId: derived.canonicalId,
      amountIn: value.amountIn,
      amountOut: value.amountOut,
      feeBps: "0",
    }),
  });
}

export function normalizeBaselineAstraMultiTokenExecutionFragmentItem(
  item: RawMigrationSemanticItem,
): RawMigrationSemanticItem {
  const facts = astraMultiTokenFactsOf(item);
  if (facts === null) return item;
  const value = item.value as {
    readonly amountIn?: unknown;
    readonly amountOut?: unknown;
    readonly minAmountOut?: unknown;
    readonly nodeFingerprint?: unknown;
  };
  if (
    typeof value.amountIn !== "string" ||
    typeof value.amountOut !== "string" ||
    typeof value.minAmountOut !== "string" ||
    typeof value.nodeFingerprint !== "string"
  ) {
    return item;
  }
  const derived = deriveAstraMultiTokenCanonicalFacts(facts);
  return Object.freeze({
    id: `${derived.canonicalId}\u001fexec:${value.amountIn}`,
    value: Object.freeze({
      routeKey: derived.routeKeyValue,
      tokenIn: derived.tokenIn,
      tokenOut: derived.tokenOut,
      canonicalEdgeId: derived.canonicalId,
      amountIn: value.amountIn,
      amountOut: value.amountOut,
      minAmountOut: value.minAmountOut,
      actionAdapterId: "astra-multitoken-change",
      executionTarget: derived.target,
      nodeFingerprint: value.nodeFingerprint,
    }),
  });
}

export function normalizeBaselineAstraMultiTokenFinalSimulationItem(
  item: RawMigrationSemanticItem,
): RawMigrationSemanticItem {
  const facts = astraMultiTokenFactsOf(item);
  if (facts === null) return item;
  const value = item.value as {
    readonly amountIn?: unknown;
    readonly amountOut?: unknown;
    readonly minAmountOut?: unknown;
    readonly effectsFingerprint?: unknown;
    readonly conservation?: unknown;
    readonly repayment?: unknown;
    readonly evInput?: unknown;
  };
  if (
    typeof value.amountIn !== "string" ||
    typeof value.amountOut !== "string" ||
    typeof value.minAmountOut !== "string" ||
    typeof value.effectsFingerprint !== "string" ||
    value.conservation !== "conserved" ||
    value.repayment !== "satisfied" ||
    value.evInput === null ||
    typeof value.evInput !== "object"
  ) {
    return item;
  }
  const evInput = value.evInput as {
    readonly amountIn?: unknown;
    readonly amountOut?: unknown;
  };
  if (
    typeof evInput.amountIn !== "string" ||
    typeof evInput.amountOut !== "string"
  ) {
    return item;
  }
  const derived = deriveAstraMultiTokenCanonicalFacts(facts);
  return Object.freeze({
    id: `${derived.canonicalId}\u001fsim:${value.amountIn}`,
    value: Object.freeze({
      routeKey: derived.routeKeyValue,
      tokenIn: derived.tokenIn,
      tokenOut: derived.tokenOut,
      canonicalEdgeId: derived.canonicalId,
      amountIn: value.amountIn,
      amountOut: value.amountOut,
      minAmountOut: value.minAmountOut,
      effectsFingerprint: value.effectsFingerprint,
      conservation: value.conservation,
      repayment: value.repayment,
      evInput: Object.freeze({
        amountIn: evInput.amountIn,
        amountOut: evInput.amountOut,
      }),
    }),
  });
}

function eigenpieFactsGuard(
  facts: Partial<BaselineEigenpieFacts> | undefined,
): facts is Required<BaselineEigenpieFacts> {
  return facts !== undefined &&
    facts.familyId === "protocol:eigenpie" &&
    typeof facts.target === "string" &&
    typeof facts.asset === "string" &&
    typeof facts.receipt === "string" &&
    typeof facts.tokenIn === "string" &&
    typeof facts.tokenOut === "string";
}

function eigenpieFactsOf(item: RawMigrationSemanticItem) {
  const facts = (item.value as {
    readonly baselineFacts?: Partial<BaselineEigenpieFacts>;
  })?.baselineFacts;
  if (!eigenpieFactsGuard(facts)) return null;
  return facts;
}

function deriveEigenpieCanonicalFacts(
  facts: Required<BaselineEigenpieFacts>,
): {
  readonly target: string;
  readonly asset: string;
  readonly receipt: string;
  readonly lowerTarget: string;
  readonly lowerAsset: string;
  readonly lowerReceipt: string;
  readonly instanceKeyValue: string;
  readonly routeKeyValue: string;
  readonly canonicalId: string;
} {
  const target = canonicalAddress(facts.target);
  const asset = canonicalAddress(facts.asset);
  const receipt = canonicalAddress(facts.receipt);
  const lowerTarget = lowerAddress(target);
  const lowerAsset = lowerAddress(asset);
  const lowerReceipt = lowerAddress(receipt);
  const descriptor = Object.freeze({
    target,
    asset,
    receipt,
  }) as unknown as Parameters<typeof eigenpieStaticBindingProjection>[0];
  const bindingFingerprint = hashCanonical(
    eigenpieStaticBindingProjection(descriptor),
  );
  const venueIdentityHash = hashCanonical(Object.freeze({
    kind: "address-protocol",
    target: lowerTarget,
  }));
  const instanceKeyValue =
    `${lowerTarget}:${lowerAsset}:${lowerReceipt}`;
  const routeKeyValue = [
    "protocol:eigenpie",
    instanceKeyValue,
    "deposit-asset",
  ].join("\u001f");
  const executionVariantKey = hashCanonical({
    namespace: "adapter-family-graph-route-v1",
    routeKey: routeKeyValue,
    routeBindingFingerprint: bindingFingerprint,
    venueIdentityHash,
  });
  const canonicalId = [
    "protocol:eigenpie",
    instanceKeyValue,
    lowerTarget,
    `${lowerAsset}>${lowerReceipt}`,
    executionVariantKey,
  ].join("\u001f");
  return Object.freeze({
    target,
    asset,
    receipt,
    lowerTarget,
    lowerAsset,
    lowerReceipt,
    instanceKeyValue,
    routeKeyValue,
    canonicalId,
  });
}

export function normalizeBaselineEigenpieEdgeItem(
  item: RawMigrationSemanticItem,
): RawMigrationSemanticItem {
  const facts = eigenpieFactsOf(item);
  if (facts === null) return item;
  const derived = deriveEigenpieCanonicalFacts(facts);
  return Object.freeze({
    id: derived.canonicalId,
    value: Object.freeze({
      routeKey: derived.routeKeyValue,
      tokenIn: derived.asset,
      tokenOut: derived.receipt,
      canonicalEdgeId: derived.canonicalId,
    }),
  });
}

export function normalizeBaselineEigenpieEnumeratedRouteItem(
  item: RawMigrationSemanticItem,
): RawMigrationSemanticItem {
  const edge = normalizeBaselineEigenpieEdgeItem(item);
  if (edge === item) return item;
  const order = (item.value as { readonly order?: unknown }).order;
  if (typeof order !== "number" || !Number.isSafeInteger(order) || order < 0) {
    throw new Error(
      "eigenpie baseline enumerated route item must carry a non-negative order",
    );
  }
  return Object.freeze({
    id: edge.id,
    value: Object.freeze({
      ...(edge.value as Record<string, unknown>),
      order,
    }),
  });
}

export function normalizeBaselineEigenpieInstanceItem(
  item: RawMigrationSemanticItem,
): RawMigrationSemanticItem {
  const facts = eigenpieFactsOf(item);
  if (facts === null) return item;
  const derived = deriveEigenpieCanonicalFacts(facts);
  const descriptor = Object.freeze({
    target: derived.target,
    asset: derived.asset,
    receipt: derived.receipt,
  }) as unknown as Parameters<typeof eigenpieStaticBindingProjection>[0];
  const staticBindingFingerprint = hashCanonical({
    capability: EIGENPIE_CATALOG_FAMILY.hashes.instance.contentHash,
    projection: eigenpieStaticBindingProjection(descriptor),
    sharedBindings: Object.freeze([]),
  });
  return Object.freeze({
    id: derived.instanceKeyValue,
    value: Object.freeze({
      familyId: "protocol:eigenpie",
      instanceKey: derived.instanceKeyValue,
      staticBindingFingerprint,
    }),
  });
}

export function normalizeBaselineEigenpiePriceItem(
  item: RawMigrationSemanticItem,
): RawMigrationSemanticItem {
  const facts = eigenpieFactsOf(item);
  if (facts === null) return item;
  const mid = (item.value as {
    readonly mid?: {
      readonly mid?: unknown;
      readonly feeBps?: unknown;
      readonly reserveA?: unknown;
      readonly reserveB?: unknown;
      readonly depthProxy?: unknown;
    };
  })?.mid;
  if (
    mid === undefined ||
    typeof mid.mid !== "number" ||
    typeof mid.feeBps !== "number" ||
    (typeof mid.reserveA !== "string" && typeof mid.reserveA !== "bigint") ||
    (typeof mid.reserveB !== "string" && typeof mid.reserveB !== "bigint") ||
    typeof mid.depthProxy !== "number"
  ) {
    return item;
  }
  const derived = deriveEigenpieCanonicalFacts(facts);
  const routeEdge = Object.freeze({
    adapterId: "eigenpie-deposit-asset",
    instanceKey: derived.instanceKeyValue,
    target: derived.target,
    tokenIn: derived.asset,
    tokenOut: derived.receipt,
    slotKind: "protocol" as const,
    protocolAction: "wrap" as const,
    edgeKind: "protocol" as const,
    leavesStandingPosition: false,
  });
  return Object.freeze({
    id: item.id,
    value: Object.freeze({
      stateKey: derived.instanceKeyValue,
      mid: Object.freeze({
        kind: "protocol",
        pool: derived.target,
        edges: Object.freeze([routeEdge]),
        mid: mid.mid,
        feeBps: mid.feeBps,
        reserveA: BigInt(mid.reserveA).toString(),
        reserveB: BigInt(mid.reserveB).toString(),
        depthProxy: mid.depthProxy,
      }),
    }),
  });
}

export function normalizeBaselineEigenpieExactQuoteItem(
  item: RawMigrationSemanticItem,
): RawMigrationSemanticItem {
  const facts = eigenpieFactsOf(item);
  if (facts === null) return item;
  const value = item.value as {
    readonly amountIn?: unknown;
    readonly amountOut?: unknown;
  };
  if (typeof value.amountIn !== "string" || typeof value.amountOut !== "string") {
    return item;
  }
  const derived = deriveEigenpieCanonicalFacts(facts);
  return Object.freeze({
    id: `${derived.canonicalId}\u001fexact:${value.amountIn}`,
    value: Object.freeze({
      routeKey: derived.routeKeyValue,
      tokenIn: derived.asset,
      tokenOut: derived.receipt,
      canonicalEdgeId: derived.canonicalId,
      amountIn: value.amountIn,
      amountOut: value.amountOut,
      feeBps: "0",
    }),
  });
}

export function normalizeBaselineEigenpieExecutionFragmentItem(
  item: RawMigrationSemanticItem,
): RawMigrationSemanticItem {
  const facts = eigenpieFactsOf(item);
  if (facts === null) return item;
  const value = item.value as {
    readonly amountIn?: unknown;
    readonly amountOut?: unknown;
    readonly minAmountOut?: unknown;
    readonly nodeFingerprint?: unknown;
  };
  if (
    typeof value.amountIn !== "string" ||
    typeof value.amountOut !== "string" ||
    typeof value.minAmountOut !== "string" ||
    typeof value.nodeFingerprint !== "string"
  ) {
    return item;
  }
  const derived = deriveEigenpieCanonicalFacts(facts);
  return Object.freeze({
    id: `${derived.canonicalId}\u001fexec:${value.amountIn}`,
    value: Object.freeze({
      routeKey: derived.routeKeyValue,
      tokenIn: derived.asset,
      tokenOut: derived.receipt,
      canonicalEdgeId: derived.canonicalId,
      amountIn: value.amountIn,
      amountOut: value.amountOut,
      minAmountOut: value.minAmountOut,
      actionAdapterId: "eigenpie-deposit-asset",
      executionTarget: derived.target,
      nodeFingerprint: value.nodeFingerprint,
    }),
  });
}

export function normalizeBaselineEigenpieFinalSimulationItem(
  item: RawMigrationSemanticItem,
): RawMigrationSemanticItem {
  const facts = eigenpieFactsOf(item);
  if (facts === null) return item;
  const value = item.value as {
    readonly amountIn?: unknown;
    readonly amountOut?: unknown;
    readonly minAmountOut?: unknown;
    readonly effectsFingerprint?: unknown;
    readonly conservation?: unknown;
    readonly repayment?: unknown;
    readonly evInput?: unknown;
  };
  if (
    typeof value.amountIn !== "string" ||
    typeof value.amountOut !== "string" ||
    typeof value.minAmountOut !== "string" ||
    typeof value.effectsFingerprint !== "string" ||
    value.conservation !== "conserved" ||
    value.repayment !== "satisfied" ||
    value.evInput === null ||
    typeof value.evInput !== "object"
  ) {
    return item;
  }
  const evInput = value.evInput as {
    readonly amountIn?: unknown;
    readonly amountOut?: unknown;
  };
  if (
    typeof evInput.amountIn !== "string" ||
    typeof evInput.amountOut !== "string"
  ) {
    return item;
  }
  const derived = deriveEigenpieCanonicalFacts(facts);
  return Object.freeze({
    id: `${derived.canonicalId}\u001fsim:${value.amountIn}`,
    value: Object.freeze({
      routeKey: derived.routeKeyValue,
      tokenIn: derived.asset,
      tokenOut: derived.receipt,
      canonicalEdgeId: derived.canonicalId,
      amountIn: value.amountIn,
      amountOut: value.amountOut,
      minAmountOut: value.minAmountOut,
      effectsFingerprint: value.effectsFingerprint,
      conservation: value.conservation,
      repayment: value.repayment,
      evInput: Object.freeze({
        amountIn: evInput.amountIn,
        amountOut: evInput.amountOut,
      }),
    }),
  });
}

function curveUnderlyingFactsGuard(
  facts: Partial<BaselineCurveUnderlyingFacts> | undefined,
): facts is Required<BaselineCurveUnderlyingFacts> {
  return facts !== undefined &&
    facts.familyId === "curve-underlying" &&
    typeof facts.pool === "string" &&
    Array.isArray(facts.coins) &&
    facts.coins.every((coin) => typeof coin === "string") &&
    typeof facts.registry === "string" &&
    Array.isArray(facts.handlers) &&
    facts.handlers.every((handler) => typeof handler === "string") &&
    facts.lookupSemantics ===
      "get_registry_handlers_from_pool+get_underlying_coins" &&
    Array.isArray(facts.verifiedDirections) &&
    facts.verifiedDirections.every((direction) =>
      Number.isSafeInteger(direction?.i) &&
      Number.isSafeInteger(direction?.j) &&
      typeof direction?.tokenIn === "string" &&
      typeof direction?.tokenOut === "string"
    ) &&
    Number.isSafeInteger(facts.i) &&
    Number.isSafeInteger(facts.j) &&
    typeof facts.tokenIn === "string" &&
    typeof facts.tokenOut === "string";
}

function curveUnderlyingFactsOf(item: RawMigrationSemanticItem) {
  const facts = (item.value as {
    readonly baselineFacts?: Partial<BaselineCurveUnderlyingFacts>;
  })?.baselineFacts;
  if (!curveUnderlyingFactsGuard(facts)) return null;
  return facts;
}

function curveUnderlyingDescriptorFor(
  facts: Required<BaselineCurveUnderlyingFacts>,
) {
  const pool = canonicalAddress(facts.pool);
  const tokenIn = canonicalAddress(facts.tokenIn);
  const tokenOut = canonicalAddress(facts.tokenOut);
  return Object.freeze({
    pool,
    coins: Object.freeze(facts.coins.map(canonicalAddress)),
    registryBinding: Object.freeze({
      registry: canonicalAddress(facts.registry),
      handlers: Object.freeze(facts.handlers.map(canonicalAddress)),
      lookupSemantics: facts.lookupSemantics,
    }),
    verifiedDirections: Object.freeze(facts.verifiedDirections.map((direction) =>
      Object.freeze({
        i: direction.i,
        j: direction.j,
        tokenIn: canonicalAddress(direction.tokenIn),
        tokenOut: canonicalAddress(direction.tokenOut),
      })
    )),
  }) as unknown as import("./venues/swaps/curve-underlying-family/types.js")
    .CurveUnderlyingDescriptor;
}

function deriveCurveUnderlyingCanonicalFacts(
  facts: Required<BaselineCurveUnderlyingFacts>,
): {
  readonly pool: string;
  readonly tokenIn: string;
  readonly tokenOut: string;
  readonly lowerPool: string;
  readonly lowerTokenIn: string;
  readonly lowerTokenOut: string;
  readonly routeKeyValue: string;
  readonly canonicalId: string;
} {
  const pool = canonicalAddress(facts.pool);
  const tokenIn = canonicalAddress(facts.tokenIn);
  const tokenOut = canonicalAddress(facts.tokenOut);
  const lowerPool = lowerAddress(pool);
  const descriptor = curveUnderlyingDescriptorFor(facts);
  const bindingFingerprint = hashCanonical(
    curveUnderlyingStaticBindingProjection(descriptor),
  );
  const venueIdentityHash = hashCanonical(Object.freeze({
    kind: "address-pool",
    pool: lowerPool,
  }));
  const lowerTokenIn = lowerAddress(tokenIn);
  const lowerTokenOut = lowerAddress(tokenOut);
  const routeKeyValue = [
    "curve-underlying",
    lowerPool,
    facts.i,
    facts.j,
    lowerTokenIn,
    lowerTokenOut,
    "underlying",
  ].join("\u001f");
  const executionVariantKey = hashCanonical({
    namespace: "adapter-family-graph-route-v1",
    routeKey: routeKeyValue,
    routeBindingFingerprint: bindingFingerprint,
    venueIdentityHash,
  });
  const canonicalId = [
    "curve-underlying",
    lowerPool,
    lowerPool,
    `${lowerTokenIn}>${lowerTokenOut}`,
    executionVariantKey,
  ].join("\u001f");
  return Object.freeze({
    pool,
    tokenIn,
    tokenOut,
    lowerPool,
    lowerTokenIn,
    lowerTokenOut,
    routeKeyValue,
    canonicalId,
  });
}

export function normalizeBaselineCurveUnderlyingEdgeItem(
  item: RawMigrationSemanticItem,
): RawMigrationSemanticItem {
  const facts = curveUnderlyingFactsOf(item);
  if (facts === null) return item;
  const derived = deriveCurveUnderlyingCanonicalFacts(facts);
  return Object.freeze({
    id: derived.canonicalId,
    value: Object.freeze({
      routeKey: derived.routeKeyValue,
      tokenIn: derived.tokenIn,
      tokenOut: derived.tokenOut,
      canonicalEdgeId: derived.canonicalId,
    }),
  });
}

export function normalizeBaselineCurveUnderlyingEnumeratedRouteItem(
  item: RawMigrationSemanticItem,
): RawMigrationSemanticItem {
  const edge = normalizeBaselineCurveUnderlyingEdgeItem(item);
  if (edge === item) return item;
  const order = (item.value as { readonly order?: unknown }).order;
  if (typeof order !== "number" || !Number.isSafeInteger(order) || order < 0) {
    throw new Error(
      "curve-underlying baseline enumerated route item must carry a " +
        "non-negative order",
    );
  }
  return Object.freeze({
    id: edge.id,
    value: Object.freeze({
      ...(edge.value as Record<string, unknown>),
      order,
    }),
  });
}

export function normalizeBaselineCurveUnderlyingInstanceItem(
  item: RawMigrationSemanticItem,
): RawMigrationSemanticItem {
  const facts = curveUnderlyingFactsOf(item);
  if (facts === null) return item;
  const derived = deriveCurveUnderlyingCanonicalFacts(facts);
  const descriptor = curveUnderlyingDescriptorFor(facts);
  const staticBindingFingerprint = hashCanonical({
    capability: CURVE_UNDERLYING_CATALOG_FAMILY.hashes.instance.contentHash,
    projection: curveUnderlyingStaticBindingProjection(descriptor),
    sharedBindings: Object.freeze([]),
  });
  return Object.freeze({
    id: derived.lowerPool,
    value: Object.freeze({
      familyId: "curve-underlying",
      instanceKey: derived.lowerPool,
      staticBindingFingerprint,
    }),
  });
}

export function normalizeBaselineCurveUnderlyingPriceItem(
  item: RawMigrationSemanticItem,
): RawMigrationSemanticItem {
  const facts = curveUnderlyingFactsOf(item);
  if (facts === null) return item;
  const mid = (item.value as {
    readonly mid?: {
      readonly mid?: unknown;
      readonly feeBps?: unknown;
      readonly reserveA?: unknown;
      readonly reserveB?: unknown;
      readonly depthProxy?: unknown;
    };
  })?.mid;
  if (
    mid === undefined ||
    typeof mid.mid !== "number" ||
    typeof mid.feeBps !== "number" ||
    (typeof mid.reserveA !== "string" && typeof mid.reserveA !== "bigint") ||
    (typeof mid.reserveB !== "string" && typeof mid.reserveB !== "bigint") ||
    typeof mid.depthProxy !== "number"
  ) {
    return item;
  }
  const derived = deriveCurveUnderlyingCanonicalFacts(facts);
  const routeEdge = Object.freeze({
    adapterId: "curve-exchange-underlying",
    instanceKey: derived.lowerPool,
    target: derived.pool,
    tokenIn: derived.tokenIn,
    tokenOut: derived.tokenOut,
    slotKind: "swap" as const,
    curveI: facts.i,
    curveJ: facts.j,
    edgeKind: "swap" as const,
    leavesStandingPosition: false,
  });
  return Object.freeze({
    id: item.id,
    value: Object.freeze({
      stateKey: derived.routeKeyValue,
      mid: Object.freeze({
        kind: "curve-underlying",
        pool: derived.pool,
        edges: Object.freeze([routeEdge]),
        mid: mid.mid,
        feeBps: mid.feeBps,
        reserveA: BigInt(mid.reserveA).toString(),
        reserveB: BigInt(mid.reserveB).toString(),
        depthProxy: mid.depthProxy,
      }),
    }),
  });
}

export function normalizeBaselineCurveUnderlyingExactQuoteItem(
  item: RawMigrationSemanticItem,
): RawMigrationSemanticItem {
  const facts = curveUnderlyingFactsOf(item);
  if (facts === null) return item;
  const value = item.value as {
    readonly amountIn?: unknown;
    readonly amountOut?: unknown;
  };
  if (typeof value.amountIn !== "string" || typeof value.amountOut !== "string") {
    return item;
  }
  const derived = deriveCurveUnderlyingCanonicalFacts(facts);
  return Object.freeze({
    id: `${derived.canonicalId}\u001fexact:${value.amountIn}`,
    value: Object.freeze({
      routeKey: derived.routeKeyValue,
      tokenIn: derived.tokenIn,
      tokenOut: derived.tokenOut,
      canonicalEdgeId: derived.canonicalId,
      amountIn: value.amountIn,
      amountOut: value.amountOut,
      feeBps: "0",
    }),
  });
}

export function normalizeBaselineCurveUnderlyingExecutionFragmentItem(
  item: RawMigrationSemanticItem,
): RawMigrationSemanticItem {
  const facts = curveUnderlyingFactsOf(item);
  if (facts === null) return item;
  const value = item.value as {
    readonly amountIn?: unknown;
    readonly amountOut?: unknown;
    readonly minAmountOut?: unknown;
    readonly nodeFingerprint?: unknown;
  };
  if (
    typeof value.amountIn !== "string" ||
    typeof value.amountOut !== "string" ||
    typeof value.minAmountOut !== "string" ||
    typeof value.nodeFingerprint !== "string"
  ) {
    return item;
  }
  const derived = deriveCurveUnderlyingCanonicalFacts(facts);
  return Object.freeze({
    id: `${derived.canonicalId}\u001fexec:${value.amountIn}`,
    value: Object.freeze({
      routeKey: derived.routeKeyValue,
      tokenIn: derived.tokenIn,
      tokenOut: derived.tokenOut,
      canonicalEdgeId: derived.canonicalId,
      amountIn: value.amountIn,
      amountOut: value.amountOut,
      minAmountOut: value.minAmountOut,
      actionAdapterId: "curve-exchange-underlying",
      executionTarget: derived.pool,
      nodeFingerprint: value.nodeFingerprint,
    }),
  });
}

export function normalizeBaselineCurveUnderlyingFinalSimulationItem(
  item: RawMigrationSemanticItem,
): RawMigrationSemanticItem {
  const facts = curveUnderlyingFactsOf(item);
  if (facts === null) return item;
  const value = item.value as {
    readonly amountIn?: unknown;
    readonly amountOut?: unknown;
    readonly minAmountOut?: unknown;
    readonly effectsFingerprint?: unknown;
    readonly conservation?: unknown;
    readonly repayment?: unknown;
    readonly evInput?: unknown;
  };
  if (
    typeof value.amountIn !== "string" ||
    typeof value.amountOut !== "string" ||
    typeof value.minAmountOut !== "string" ||
    typeof value.effectsFingerprint !== "string" ||
    value.conservation !== "conserved" ||
    value.repayment !== "satisfied" ||
    value.evInput === null ||
    typeof value.evInput !== "object"
  ) {
    return item;
  }
  const evInput = value.evInput as {
    readonly amountIn?: unknown;
    readonly amountOut?: unknown;
  };
  if (
    typeof evInput.amountIn !== "string" ||
    typeof evInput.amountOut !== "string"
  ) {
    return item;
  }
  const derived = deriveCurveUnderlyingCanonicalFacts(facts);
  return Object.freeze({
    id: `${derived.canonicalId}\u001fsim:${value.amountIn}`,
    value: Object.freeze({
      routeKey: derived.routeKeyValue,
      tokenIn: derived.tokenIn,
      tokenOut: derived.tokenOut,
      canonicalEdgeId: derived.canonicalId,
      amountIn: value.amountIn,
      amountOut: value.amountOut,
      minAmountOut: value.minAmountOut,
      effectsFingerprint: value.effectsFingerprint,
      conservation: value.conservation,
      repayment: value.repayment,
      evInput: Object.freeze({
        amountIn: evInput.amountIn,
        amountOut: evInput.amountOut,
      }),
    }),
  });
}

const UNIV2_CATALOG_FAMILY =
  PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG.forFamily(
    UNIV2_FAMILY_ID,
  );

const UNIV3_CATALOG_FAMILY =
  PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG.forFamily(
    UNIV3_FAMILY_ID,
  );

const UNIV4_CATALOG_FAMILY =
  PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG.forFamily(
    UNIV4_FAMILY_ID,
  );

const PSM_CATALOG_FAMILY =
  PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG.forFamily(
    PSM_FAMILY_ID,
  );

const WSTETH_CATALOG_FAMILY =
  PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG.forFamily(
    WSTETH_FAMILY_ID,
  );

const GOLDX_CATALOG_FAMILY =
  PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG.forFamily(
    GOLDX_FAMILY_ID,
  );

const ROCKSOLID_CATALOG_FAMILY =
  PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG.forFamily(
    ROCKSOLID_FAMILY_ID,
  );

const METRONOME_HGUSDC_CATALOG_FAMILY =
  PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG.forFamily(
    METRONOME_HGUSDC_FAMILY_ID,
  );

const METRONOME_SYNTH_CATALOG_FAMILY =
  PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG.forFamily(
    METRONOME_SYNTH_FAMILY_ID,
  );

const ERC4626_SILO_CATALOG_FAMILY =
  PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG.forFamily(
    ERC4626_SILO_REDEEM_FAMILY_ID,
  );

const ERC4626_CATALOG_FAMILY =
  PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG.forFamily(
    ERC4626_FAMILY_ID,
  );

const ETHERTOKEN_NATIVE_CATALOG_FAMILY =
  PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG.forFamily(
    ETHERTOKEN_NATIVE_FAMILY_ID,
  );

const SELF_BURN_NATIVE_CATALOG_FAMILY =
  PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG.forFamily(
    SELF_BURN_NATIVE_FAMILY_ID,
  );

const ASTRA_CATALOG_FAMILY =
  PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG.forFamily(
    ASTRA_MULTITOKEN_FAMILY_ID,
  );

const EIGENPIE_CATALOG_FAMILY =
  PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG.forFamily(
    EIGENPIE_FAMILY_ID,
  );

const CURVE_UNDERLYING_CATALOG_FAMILY =
  PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG.forFamily(
    CURVE_UNDERLYING_FAMILY_ID,
  );
