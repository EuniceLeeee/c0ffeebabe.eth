import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  createSemanticSixStepEvidence,
  semanticSixStepSequenceError,
  type SemanticSixStepEvidence,
  type SemanticSixStepStatus,
} from "../../shared/evidence/semantic-six-step.js";
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
): number[] {
  return Array.from(
    { length: Math.min(Math.max(0, topK), opportunityCount) },
    (_, index) => index,
  );
}

export function solveForOpportunityIndex<T extends { opportunityIndex: number }>(
  solved: readonly T[],
  opportunityIndex: number,
): T | null {
  return solved.find((entry) => entry.opportunityIndex === opportunityIndex) ?? null;
}

/**
 * Production-route evidence is one ordered prefix. A non-pass stage is
 * terminal even when the operator did not request `--stop-after`.
 */
export function productionDiagnosticStageTerminates(
  status: SemanticSixStepStatus,
  stopAfterStage: boolean,
): boolean {
  return status !== "pass" || stopAfterStage;
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
  assert.deepEqual(selectedReplayOpportunityIndexes(5, 3), [0, 1, 2]);
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
  const prefixPasses = productionDiagnosticPasses();
  const planFailure = createSemanticSixStepEvidence({
    profile: "production_route_stage",
    step: 4,
    status: "fail",
    output: { solve_succeeded: false },
    reasonCode: "plan_or_solver_failed",
  });
  const planFailurePrefix = [...prefixPasses.slice(0, 3), planFailure];
  assert.equal(
    productionDiagnosticStageTerminates(planFailure.status, false),
    true,
  );
  assert.equal(
    semanticSixStepSequenceError(planFailurePrefix),
    null,
    "a plan/sizing failure must be a valid terminal semantic prefix",
  );
  assert.match(
    semanticSixStepSequenceError([
      ...planFailurePrefix,
      prefixPasses[4],
    ]) ?? "",
    /terminate after step 4/,
  );

  const finalSimFailure = createSemanticSixStepEvidence({
    profile: "production_route_stage",
    step: 5,
    status: "fail",
    output: { success: false },
    reasonCode: "final_sim_revert",
  });
  const finalSimFailurePrefix = [...prefixPasses.slice(0, 4), finalSimFailure];
  assert.equal(
    productionDiagnosticStageTerminates(finalSimFailure.status, false),
    true,
  );
  assert.equal(
    semanticSixStepSequenceError(finalSimFailurePrefix),
    null,
    "a final-sim failure must be a valid terminal semantic prefix",
  );
  assert.match(
    semanticSixStepSequenceError([
      ...finalSimFailurePrefix,
      prefixPasses[5],
    ]) ?? "",
    /terminate after step 5/,
  );
  assert.equal(
    productionDiagnosticStageTerminates("pass", true),
    true,
    "stop-after must retain its existing successful-stage semantics",
  );
  assert.equal(productionDiagnosticStageTerminates("pass", false), false);

  const producerSource = readFileSync(
    new URL("./blockscan-hunt.ts", import.meta.url),
    "utf8",
  );
  const planTerminal = producerSource.search(
    /productionDiagnosticStageTerminates\(\s*solveStatus,/,
  );
  const finalSimRead = producerSource.indexOf(
    "const simulation = expectedSolve?.diagnosticSimulation",
  );
  const simTerminal = producerSource.search(
    /productionDiagnosticStageTerminates\(\s*finalSimStatus,/,
  );
  const evRead = producerSource.indexOf("const ev = expectedSolve?.diagnosticEv");
  assert(
    planTerminal >= 0 && finalSimRead > planTerminal,
    "producer must terminate a non-pass step 4 before reading step 5 evidence",
  );
  assert(
    simTerminal >= 0 && evRead > simTerminal,
    "producer must terminate a non-pass step 5 before reading step 6 evidence",
  );
  console.log("blockscan-hunt-selection PASS");
}

function productionDiagnosticPasses(): SemanticSixStepEvidence[] {
  const sha = "a".repeat(64);
  return [
    createSemanticSixStepEvidence({
      profile: "production_route_stage",
      step: 1,
      status: "pass",
      output: {
        source_block: 1,
        edge_set_sha256: sha,
        edge_set_size: 1,
        target_membership: "present",
      },
    }),
    createSemanticSixStepEvidence({
      profile: "production_route_stage",
      step: 2,
      status: "pass",
      output: {
        route_set_sha256: sha,
        route_set_size: 1,
        target_present: true,
      },
    }),
    createSemanticSixStepEvidence({
      profile: "production_route_stage",
      step: 3,
      status: "pass",
      output: {
        source_block: 1,
        route_sha256: sha,
        quote_status: "positive",
        probe_amount_in: "1",
        quoted_amount_out: "2",
        leg_quotes: [{ amount_in: "1", amount_out: "2" }],
      },
    }),
    createSemanticSixStepEvidence({
      profile: "production_route_stage",
      step: 4,
      status: "pass",
      output: {
        route_sha256: sha,
        selected_by_solve_policy: true,
        solve_succeeded: true,
        solver_selected_amount: "1",
        resolved_plan_sha256: sha,
        hop_amounts: [{ amount_in: "1", amount_out: "2" }],
      },
    }),
    createSemanticSixStepEvidence({
      profile: "production_route_stage",
      step: 5,
      status: "pass",
      output: {
        success: true,
        profit_token: "0x1",
        gross_profit: "1",
        net_profit: "1",
        gas_used: "1",
        calldata_sha256: sha,
        repayment_and_conservation: true,
        leaves_standing_position: false,
      },
    }),
    createSemanticSixStepEvidence({
      profile: "production_route_stage",
      step: 6,
      status: "pass",
      output: {
        decision: "allow",
        net_ev_wei: "1",
        gas_cost_eth: "1",
        bid_eth: "0",
        valuation_available: true,
        gas_measurement_available: true,
        fee_state_available: true,
      },
    }),
  ];
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
