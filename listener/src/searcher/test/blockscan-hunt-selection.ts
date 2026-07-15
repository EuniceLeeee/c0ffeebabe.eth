import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";

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

function runTests(): void {
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
  console.log("blockscan-hunt-selection PASS");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) runTests();
