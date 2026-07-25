import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import type { TokenEdge } from "../planner/token-graph.js";
import { canonicalEdgeId } from "../venues/blockscan-state-capability.js";

export interface BlockScanHuntBudgets {
  scanBudgetMs: number;
  passBudgetMs: number;
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
