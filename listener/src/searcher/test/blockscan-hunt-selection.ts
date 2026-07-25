import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import type { TokenEdge } from "../planner/token-graph.js";
import { canonicalEdgeId } from "../venues/blockscan-state-capability.js";

export interface BlockScanHuntBudgets {
  scanBudgetMs: number;
  passBudgetMs: number;
}

export interface AdapterFamilyQuoteCoverageSummary {
  readonly familyId: string;
  readonly graphEdges: number;
  readonly positiveQuotes: number;
  readonly unavailableEdges: number;
  readonly unresolvedEdges: number;
}

export interface ExpectedRouteStep {
  readonly adapterId: string;
  readonly slotKind: "swap" | "protocol";
  readonly target: string;
  readonly tokenIn: string;
  readonly tokenOut: string;
  readonly edgeKind?: string;
  readonly leavesStandingPosition?: boolean;
  readonly poolId?: string;
}

export function resolveBlockScanHuntBudgets(
  env: Readonly<Record<string, string | undefined>>,
): BlockScanHuntBudgets {
  const legacy = optionalNonNegativeInt(env.HUNT_BUDGET_MS, "HUNT_BUDGET_MS");
  return {
    scanBudgetMs: nonNegativeInt(
      env.HUNT_SCAN_BUDGET_MS,
      legacy ?? 1_500,
      "HUNT_SCAN_BUDGET_MS",
    ),
    passBudgetMs: nonNegativeInt(
      env.HUNT_PASS_BUDGET_MS,
      legacy ?? 11_000,
      "HUNT_PASS_BUDGET_MS",
    ),
  };
}

export function blockScanPassBudgetExceeded(
  deadlineAtMs: number,
  deadlineHit: boolean,
  nowMs = Date.now(),
): boolean {
  return deadlineHit || nowMs >= deadlineAtMs;
}

export function selectedReplayOpportunityIndexes(
  opportunityCount: number,
  topK: number,
  expectedIndex: number | null,
): number[] {
  const indexes = Array.from(
    { length: Math.min(Math.max(0, topK), opportunityCount) },
    (_, index) => index,
  );
  if (
    expectedIndex !== null
    && expectedIndex >= 0
    && expectedIndex < opportunityCount
    && !indexes.includes(expectedIndex)
  ) {
    indexes.push(expectedIndex);
  }
  return indexes;
}

export function solveForOpportunityIndex<T extends { opportunityIndex: number }>(
  solved: readonly T[],
  opportunityIndex: number,
): T | null {
  return solved.find((entry) => entry.opportunityIndex === opportunityIndex) ?? null;
}

/**
 * A production family may legitimately own no instances in one source-aligned
 * graph (for example an observed-interaction-only protocol with no events in
 * the frozen window). Every family must still be represented in telemetry,
 * and every graph-present edge must be partitioned exactly into a positive
 * quote or a behavior-proven unavailable edge. Unknown/unresolved edges remain
 * a hard failure.
 */
export function adapterFamilyQuoteCoverageIsComplete(
  coverage: readonly AdapterFamilyQuoteCoverageSummary[],
  expectedFamilyIds: readonly string[],
): boolean {
  const expected = [...expectedFamilyIds].sort();
  const actual = coverage.map((family) => family.familyId).sort();
  if (
    new Set(expected).size !== expected.length ||
    new Set(actual).size !== actual.length ||
    expected.length !== actual.length ||
    expected.some((familyId, index) => familyId !== actual[index])
  ) {
    return false;
  }
  return coverage.every((family) => {
    const counts = [
      family.graphEdges,
      family.positiveQuotes,
      family.unavailableEdges,
      family.unresolvedEdges,
    ];
    if (counts.some((count) => !Number.isSafeInteger(count) || count < 0)) {
      return false;
    }
    if (
      family.graphEdges !==
        family.positiveQuotes +
          family.unavailableEdges +
          family.unresolvedEdges ||
      family.unresolvedEdges !== 0
    ) {
      return false;
    }
    if (family.graphEdges === 0) {
      return family.positiveQuotes === 0 && family.unavailableEdges === 0;
    }
    return family.positiveQuotes > 0;
  });
}

/**
 * Expected routes are partial predicates: edge taxonomy is optional in the
 * operator-supplied fixture, while actual reports always carry it. Comparing
 * the two objects with JSON.stringify therefore creates a false negative even
 * when every required route identity field is equal.
 */
export function routeMatchesExpected(
  actual: readonly ExpectedRouteStep[],
  expected: readonly ExpectedRouteStep[],
): boolean {
  return actual.length === expected.length &&
    actual.every((step, index) => routeStepMatchesExpected(step, expected[index]));
}

export function routeStepMatchesExpected(
  actual: ExpectedRouteStep,
  expected: ExpectedRouteStep,
): boolean {
  return actual.adapterId === expected.adapterId
    && actual.slotKind === expected.slotKind
    && actual.target === expected.target
    && actual.tokenIn === expected.tokenIn
    && actual.tokenOut === expected.tokenOut
    && (expected.edgeKind === undefined || actual.edgeKind === expected.edgeKind)
    && (expected.leavesStandingPosition === undefined
      || actual.leavesStandingPosition === expected.leavesStandingPosition)
    && (expected.poolId === undefined || actual.poolId === expected.poolId);
}

/**
 * `createVerifiedGraphView` preserves graph order while attaching canonical
 * edge ids. Diagnostics resolve their route against the raw graph first, so
 * they must use the corresponding verified objects for coverage/mid lookups.
 */
export function remapExpectedRouteToVerifiedGraph(
  rawGraph: readonly TokenEdge[],
  verifiedGraph: readonly TokenEdge[],
  expectedRoute: readonly TokenEdge[],
): TokenEdge[] | null {
  if (rawGraph.length !== verifiedGraph.length) return null;
  const remapped: TokenEdge[] = [];
  for (const edge of expectedRoute) {
    const index = rawGraph.indexOf(edge);
    if (index < 0) return null;
    remapped.push(verifiedGraph[index]);
  }
  return remapped;
}

function runTests(): void {
  assert.deepEqual(resolveBlockScanHuntBudgets({}), {
    scanBudgetMs: 1_500,
    passBudgetMs: 11_000,
  });
  assert.deepEqual(resolveBlockScanHuntBudgets({ HUNT_BUDGET_MS: "120000" }), {
    scanBudgetMs: 120_000,
    passBudgetMs: 120_000,
  });
  assert.deepEqual(resolveBlockScanHuntBudgets({
    HUNT_BUDGET_MS: "120000",
    HUNT_SCAN_BUDGET_MS: "1500",
    HUNT_PASS_BUDGET_MS: "11000",
  }), {
    scanBudgetMs: 1_500,
    passBudgetMs: 11_000,
  });
  assert.throws(
    () => resolveBlockScanHuntBudgets({ HUNT_PASS_BUDGET_MS: "-1" }),
    /HUNT_PASS_BUDGET_MS must be a non-negative integer/,
  );
  assert.equal(blockScanPassBudgetExceeded(100, false, 99), false);
  assert.equal(blockScanPassBudgetExceeded(100, false, 100), true);
  assert.equal(blockScanPassBudgetExceeded(100, true, 1), true);
  assert.deepEqual(selectedReplayOpportunityIndexes(5, 3, null), [0, 1, 2]);
  assert.deepEqual(selectedReplayOpportunityIndexes(5, 3, 1), [0, 1, 2]);
  assert.deepEqual(selectedReplayOpportunityIndexes(5, 3, 4), [0, 1, 2, 4]);
  assert.deepEqual(selectedReplayOpportunityIndexes(5, 3, -1), [0, 1, 2]);
  assert.deepEqual(selectedReplayOpportunityIndexes(5, 3, 5), [0, 1, 2]);
  assert.equal(
    solveForOpportunityIndex([{ opportunityIndex: 0 }, { opportunityIndex: 4 }], 4)?.opportunityIndex,
    4,
  );
  assert.equal(solveForOpportunityIndex([{ opportunityIndex: 0 }], 4), null);
  const completeCoverage: AdapterFamilyQuoteCoverageSummary[] = [
    {
      familyId: "observed-only",
      graphEdges: 0,
      positiveQuotes: 0,
      unavailableEdges: 0,
      unresolvedEdges: 0,
    },
    {
      familyId: "swap",
      graphEdges: 3,
      positiveQuotes: 2,
      unavailableEdges: 1,
      unresolvedEdges: 0,
    },
  ];
  assert.equal(
    adapterFamilyQuoteCoverageIsComplete(
      completeCoverage,
      ["swap", "observed-only"],
    ),
    true,
  );
  assert.equal(
    adapterFamilyQuoteCoverageIsComplete(
      completeCoverage,
      ["swap", "observed-only", "missing"],
    ),
    false,
  );
  assert.equal(
    adapterFamilyQuoteCoverageIsComplete(
      [...completeCoverage, completeCoverage[0]],
      ["swap", "observed-only"],
    ),
    false,
  );
  assert.equal(
    adapterFamilyQuoteCoverageIsComplete(
      completeCoverage.map((family) =>
        family.familyId === "swap"
          ? { ...family, unavailableEdges: 0, unresolvedEdges: 1 }
          : family
      ),
      ["swap", "observed-only"],
    ),
    false,
  );
  assert.equal(
    adapterFamilyQuoteCoverageIsComplete(
      completeCoverage.map((family) =>
        family.familyId === "swap"
          ? { ...family, positiveQuotes: 0, unavailableEdges: 3 }
          : family
      ),
      ["swap", "observed-only"],
    ),
    false,
  );
  const expectedRoute: ExpectedRouteStep[] = [{
    adapterId: "fixture-swap",
    slotKind: "swap",
    target: "0x1111111111111111111111111111111111111111",
    tokenIn: "0x2222222222222222222222222222222222222222",
    tokenOut: "0x3333333333333333333333333333333333333333",
  }];
  const actualRoute: ExpectedRouteStep[] = [{
    ...expectedRoute[0],
    edgeKind: "swap",
    leavesStandingPosition: false,
  }];
  assert.equal(routeMatchesExpected(actualRoute, expectedRoute), true);
  assert.equal(routeMatchesExpected(actualRoute, [{
    ...expectedRoute[0],
    leavesStandingPosition: true,
  }]), false);
  assert.equal(routeMatchesExpected(actualRoute, []), false);
  const rawEdge: TokenEdge = {
    adapterId: "fixture-swap",
    target: "0x1111111111111111111111111111111111111111",
    tokenIn: "0x2222222222222222222222222222222222222222",
    tokenOut: "0x3333333333333333333333333333333333333333",
    slotKind: "swap",
    edgeKind: "swap",
    leavesStandingPosition: false,
  };
  const verifiedEdge: TokenEdge = {
    ...rawEdge,
    canonicalEdgeId: canonicalEdgeId("fixture-family", rawEdge),
  };
  assert.deepEqual(
    remapExpectedRouteToVerifiedGraph(
      [rawEdge],
      [verifiedEdge],
      [rawEdge],
    ),
    [verifiedEdge],
  );
  assert.equal(
    remapExpectedRouteToVerifiedGraph([], [verifiedEdge], [rawEdge]),
    null,
  );
  console.log("blockscan-hunt-selection PASS");
}

function optionalNonNegativeInt(raw: string | undefined, name: string): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  return nonNegativeInt(raw, 0, name);
}

function nonNegativeInt(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer, got ${raw}`);
  }
  return parsed;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) runTests();
