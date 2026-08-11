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
        default: normalizeBaselineUniv2InstanceItem,
      })
    ));
  }
  if (stage === "prices") {
    return Object.freeze(items.map((item) =>
      normalizeByFamily(item, {
        "univ3-standard": normalizeBaselineUniv3PriceItem,
        univ4: normalizeBaselineUniv4PriceItem,
        default: normalizeBaselineUniv2PriceItem,
      })
    ));
  }
  if (stage === "edges") {
    return Object.freeze(items.map((item) =>
      normalizeByFamily(item, {
        "univ3-standard": normalizeBaselineUniv3EdgeItem,
        univ4: normalizeBaselineUniv4EdgeItem,
        default: normalizeBaselineUniv2EdgeItem,
      })
    ));
  }
  if (stage === "enumeratedRoutes") {
    return Object.freeze(items.map((item) =>
      normalizeByFamily(item, {
        "univ3-standard": normalizeBaselineUniv3EnumeratedRouteItem,
        univ4: normalizeBaselineUniv4EnumeratedRouteItem,
        default: normalizeBaselineUniv2EnumeratedRouteItem,
      })
    ));
  }
  if (stage === "exactQuotes") {
    return Object.freeze(items.map((item) =>
      normalizeByFamily(item, {
        "univ3-standard": normalizeBaselineUniv3ExactQuoteItem,
        univ4: normalizeBaselineUniv4ExactQuoteItem,
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
    readonly default: (item: RawMigrationSemanticItem) =>
      RawMigrationSemanticItem;
  },
): RawMigrationSemanticItem {
  const familyId = baselineFamilyId(item);
  if (familyId === "univ3-standard") return handlers["univ3-standard"](item);
  if (familyId === "univ4") return handlers.univ4(item);
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
