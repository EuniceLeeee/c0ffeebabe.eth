import { hashCanonical } from "./venues/canonical-value.js";
import { lowerAddress } from "./venues/swaps/univ2-family/codec.js";
import { uniV2FeeRuleForFactory } from
  "./venues/swaps/univ2-family/fee-rule.js";
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
  if (stage !== "edges") return items;
  return Object.freeze(items.map((item) =>
    normalizeBaselineUniv2EdgeItem(item)
  ));
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
  const pool = facts.pool.toLowerCase();
  const token0 = facts.token0.toLowerCase();
  const token1 = facts.token1.toLowerCase();
  const tokenIn = facts.tokenIn.toLowerCase();
  const tokenOut = facts.tokenOut.toLowerCase();
  const factory = facts.factory.toLowerCase();
  const reversePool = facts.reversePool.toLowerCase();
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
  const venueIdentityHash = hashCanonical({
    kind: "address-pool",
    pool: lowerAddress(pool),
  });
  const routeKeyValue = [
    "univ2-standard",
    pool,
    tokenIn,
    tokenOut,
  ].join("\u001f");
  const executionVariantKey = hashCanonical({
    namespace: "adapter-family-graph-route-v1",
    routeKey: routeKeyValue,
    routeBindingFingerprint: bindingFingerprint,
    venueIdentityHash,
  });
  const canonicalId = [
    "univ2-standard",
    pool,
    pool,
    `${tokenIn}>${tokenOut}`,
    executionVariantKey,
  ].join("\u001f");
  return Object.freeze({
    id: canonicalId,
    value: Object.freeze({
      routeKey: routeKeyValue,
      tokenIn,
      tokenOut,
      canonicalEdgeId: canonicalId,
    }),
  });
}
