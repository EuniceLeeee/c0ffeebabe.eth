import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import type { TokenEdge } from "../planner/token-graph.js";
import { canonicalEdgeId } from "../venues/blockscan-state-capability.js";
import {
  isVerifiedRetainedTopologyProof,
  type VerifiedRetainedTopologyProof,
} from "./blockscan-hunt-protocol-cache.js";

export interface BlockScanHuntBudgets {
  scanBudgetMs: number;
  passBudgetMs: number;
}

export type BlockScanHuntVerdict =
  | "no_candidates"
  | "ev_positive_found"
  | "candidates_all_negative"
  | "targeted_indeterminate";

export interface AdapterFamilyQuoteCoverageSummary {
  readonly familyId: string;
  readonly graphEdges: number;
  readonly positiveQuotes: number;
  readonly unavailableEdges: number;
  readonly unresolvedEdges: number;
}

export type AdapterFamilyCoverageState =
  | "covered"
  | "not_observed"
  | "unresolved";

export interface AdapterFamilyQuoteCoverageAssessment {
  readonly structurallyValid: boolean;
  /**
   * A targeted hunt may continue through covered siblings. Route-specific
   * diagnostics still fail closed if their own edges were unresolved.
   */
  readonly targetedHuntMayContinue: boolean;
  /**
   * Global completeness/no-opportunity claims need both a trusted-runner
   * topology proof and current coverage for every registered family.
   */
  readonly globallyComplete: boolean;
  readonly families: readonly {
    readonly familyId: string;
    readonly state: AdapterFamilyCoverageState;
  }[];
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

export interface ExpectedSwapPathStep {
  readonly pool_id: string;
  readonly direction: "0for1" | "1for0";
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

export function resolveBlockScanHuntVerdict(
  opportunityCount: number,
  bestNet: bigint | null,
  globallyComplete: boolean,
): BlockScanHuntVerdict {
  if (bestNet !== null && bestNet > 0n) return "ev_positive_found";
  if (!globallyComplete) return "targeted_indeterminate";
  return opportunityCount === 0
    ? "no_candidates"
    : "candidates_all_negative";
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
 * Global all-family completeness is stronger than one targeted hunt. A
 * zero-edge family is `not_observed`, not a reason to stop covered siblings,
 * and never evidence for a global no-opportunity claim. Only a trusted-runner
 * topology proof plus current coverage for every family can produce
 * `globallyComplete=true`.
 */
export function adapterFamilyQuoteCoverageIsComplete(
  coverage: readonly AdapterFamilyQuoteCoverageSummary[],
  expectedFamilyIds: readonly string[],
  retainedTopologyProof: VerifiedRetainedTopologyProof | null = null,
): boolean {
  return assessAdapterFamilyQuoteCoverage(
    coverage,
    expectedFamilyIds,
    retainedTopologyProof,
  ).globallyComplete;
}

export function assessAdapterFamilyQuoteCoverage(
  coverage: readonly AdapterFamilyQuoteCoverageSummary[],
  expectedFamilyIds: readonly string[],
  retainedTopologyProof: VerifiedRetainedTopologyProof | null = null,
): AdapterFamilyQuoteCoverageAssessment {
  const expected = [...expectedFamilyIds].sort();
  const actual = coverage.map((family) => family.familyId).sort();
  if (
    new Set(expected).size !== expected.length ||
    new Set(actual).size !== actual.length ||
    expected.length !== actual.length ||
    expected.some((familyId, index) => familyId !== actual[index])
  ) {
    return {
      structurallyValid: false,
      targetedHuntMayContinue: false,
      globallyComplete: false,
      families: [],
    };
  }
  let structurallyValid = true;
  const families = coverage.map((family) => {
    const counts = [
      family.graphEdges,
      family.positiveQuotes,
      family.unavailableEdges,
      family.unresolvedEdges,
    ];
    if (counts.some((count) => !Number.isSafeInteger(count) || count < 0)) {
      structurallyValid = false;
      return { familyId: family.familyId, state: "unresolved" as const };
    }
    if (
      family.graphEdges !==
        family.positiveQuotes +
          family.unavailableEdges +
          family.unresolvedEdges
    ) {
      structurallyValid = false;
      return { familyId: family.familyId, state: "unresolved" as const };
    }
    if (family.graphEdges === 0) {
      return {
        familyId: family.familyId,
        state: "not_observed" as const,
      };
    }
    return {
      familyId: family.familyId,
      state:
        family.unresolvedEdges > 0
          ? "unresolved" as const
          : "covered" as const,
    };
  });
  const globallyComplete =
    structurallyValid &&
    isVerifiedRetainedTopologyProof(retainedTopologyProof) &&
    families.every((family) => family.state === "covered");
  return {
    structurallyValid,
    targetedHuntMayContinue: structurallyValid,
    globallyComplete,
    families,
  };
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
  if (actual.length !== expected.length || actual.length === 0) return false;
  for (let offset = 0; offset < expected.length; offset++) {
    if (actual.every((step, index) =>
      routeStepMatchesExpected(
        step,
        expected[(index + offset) % expected.length],
      )
    )) return true;
  }
  return false;
}

/**
 * A funded closed route may start at any flash token. The swap-only projection
 * therefore has the same cyclic identity as the full route even when protocol
 * legs between two swaps are omitted from this legacy diagnostic field.
 */
export function swapPathMatchesExpected(
  actual: readonly ExpectedSwapPathStep[],
  expected: readonly ExpectedSwapPathStep[],
): boolean {
  if (actual.length !== expected.length || actual.length === 0) return false;
  for (let offset = 0; offset < expected.length; offset++) {
    if (actual.every((step, index) => {
      const wanted = expected[(index + offset) % expected.length];
      return step.pool_id === wanted.pool_id
        && step.direction === wanted.direction;
    })) return true;
  }
  return false;
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
  assert.equal(
    resolveBlockScanHuntVerdict(0, null, false),
    "targeted_indeterminate",
    "incomplete family coverage cannot prove a global no-candidate result",
  );
  assert.equal(
    resolveBlockScanHuntVerdict(2, 0n, false),
    "targeted_indeterminate",
    "incomplete family coverage cannot prove all candidates are non-positive",
  );
  assert.equal(
    resolveBlockScanHuntVerdict(2, 1n, false),
    "ev_positive_found",
    "a positive route remains valid existential evidence",
  );
  assert.equal(resolveBlockScanHuntVerdict(0, null, true), "no_candidates");
  assert.equal(
    resolveBlockScanHuntVerdict(2, 0n, true),
    "candidates_all_negative",
  );
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
    false,
  );
  assert.deepEqual(
    assessAdapterFamilyQuoteCoverage(
      completeCoverage,
      ["swap", "observed-only"],
    ),
    {
      structurallyValid: true,
      targetedHuntMayContinue: true,
      globallyComplete: false,
      families: [
        { familyId: "observed-only", state: "not_observed" },
        { familyId: "swap", state: "covered" },
      ],
    },
    "not_observed siblings must not block one targeted hunt or become a global completeness claim",
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
  assert.deepEqual(
    assessAdapterFamilyQuoteCoverage(
      completeCoverage.map((family) =>
        family.familyId === "swap"
          ? { ...family, unavailableEdges: 0, unresolvedEdges: 1 }
          : family
      ),
      ["swap", "observed-only"],
    ).families,
    [
      { familyId: "observed-only", state: "not_observed" },
      { familyId: "swap", state: "unresolved" },
    ],
    "an unresolved family must be isolated without changing sibling state",
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
  const expectedCycle: ExpectedRouteStep[] = [
    expectedRoute[0],
    {
      adapterId: "fixture-protocol",
      slotKind: "protocol",
      target: "0x3333333333333333333333333333333333333333",
      tokenIn: "0x3333333333333333333333333333333333333333",
      tokenOut: "0x4444444444444444444444444444444444444444",
    },
    {
      adapterId: "fixture-swap",
      slotKind: "swap",
      target: "0x5555555555555555555555555555555555555555",
      tokenIn: "0x4444444444444444444444444444444444444444",
      tokenOut: "0x2222222222222222222222222222222222222222",
    },
  ];
  assert.equal(routeMatchesExpected(
    [expectedCycle[2], expectedCycle[0], expectedCycle[1]],
    expectedCycle,
  ), true);
  const expectedSwapPath: ExpectedSwapPathStep[] = [
    { pool_id: "0x1111111111111111111111111111111111111111", direction: "0for1" },
    { pool_id: "0x2222222222222222222222222222222222222222", direction: "1for0" },
  ];
  assert.equal(swapPathMatchesExpected(
    [expectedSwapPath[1], expectedSwapPath[0]],
    expectedSwapPath,
  ), true);
  assert.equal(swapPathMatchesExpected(
    [{ ...expectedSwapPath[1], direction: "0for1" }, expectedSwapPath[0]],
    expectedSwapPath,
  ), false);
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
