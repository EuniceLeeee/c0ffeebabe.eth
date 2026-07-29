import assert from "node:assert/strict";
import { ethers } from "ethers";
import {
  createBlockScanExecutionAvailability,
  validateBlockScanPendingEvidenceTrigger,
} from "../blockscan-pending-evidence.js";
import type { TokenEdge } from "../planner/token-graph.js";
import type {
  ExecutionFamilyId,
  PendingExecutionEvidence,
} from "../venues/route-leg-adapter.js";

const txHash = `0x${"11".repeat(32)}`;
const headHash = `0x${"22".repeat(32)}`;
const familyId: ExecutionFamilyId = "univ4";
const evidence = pendingEvidence(familyId, "0x1234");
const trigger = Object.freeze({
  txHash,
  head: Object.freeze({ number: 123, hash: headHash }),
  observedAtMs: 1_000,
  observedAtMonotonicMs: 500,
  evidenceReadyAtMs: 1_010,
  evidenceReadyAtMonotonicMs: 510,
  evidence: Object.freeze([evidence]),
});
validateBlockScanPendingEvidenceTrigger(trigger);
assert.throws(
  () => validateBlockScanPendingEvidenceTrigger({
    ...trigger,
    head: { ...trigger.head, hash: `0x${"33".repeat(32)}` },
  }),
  /binding mismatch/,
);
assert.throws(
  () => validateBlockScanPendingEvidenceTrigger({
    ...trigger,
    evidence: [evidence, evidence],
  }),
  /binding mismatch/,
);
assert.throws(
  () => validateBlockScanPendingEvidenceTrigger({
    ...trigger,
    evidence: [{ ...evidence, evidenceHash: `0x${"44".repeat(32)}` }],
  }),
  /hash mismatch/,
);

const standard = edge("standard");
const locked = edge("locked", "authorized");
const unauthorizedSibling = edge("locked", "unauthorized");
const familyForEdge = (adapterId: string): ExecutionFamilyId | null =>
  adapterId === "locked" ? familyId : null;
const edgeScopeKey = (candidate: TokenEdge): string | null =>
  candidate.poolId ?? null;
const evidenceScopeKeys = (): readonly string[] => ["authorized"];

const periodic = createBlockScanExecutionAvailability({
  mode: "periodic",
  evidence: [],
  familyForEdge,
  edgeScopeKey,
  evidenceScopeKeys,
});
assert(periodic.edgeEligible(standard));
assert(!periodic.edgeEligible(locked));
assert(periodic.routeEligible([standard]));
assert(!periodic.routeEligible([standard, locked]));

const combined = createBlockScanExecutionAvailability({
  mode: "combined",
  evidence: [evidence],
  familyForEdge,
  edgeScopeKey,
  evidenceScopeKeys,
});
assert(combined.edgeEligible(standard) && combined.edgeEligible(locked));
assert(!combined.edgeEligible(unauthorizedSibling));
assert(combined.routeEligible([standard]));
assert(combined.routeEligible([standard, locked]));
assert(!combined.routeEligible([standard, unauthorizedSibling]));

const evidenceOnly = createBlockScanExecutionAvailability({
  mode: "evidence-only",
  evidence: [evidence],
  familyForEdge,
  edgeScopeKey,
  evidenceScopeKeys,
});
assert(evidenceOnly.edgeEligible(standard) && evidenceOnly.edgeEligible(locked));
assert(!evidenceOnly.routeEligible([standard]));
assert(evidenceOnly.routeEligible([standard, locked]));

console.log("blockscan-pending-evidence-contract PASS");

function edge(adapterId: string, poolId?: string): TokenEdge {
  return {
    adapterId,
    target: "0x0000000000000000000000000000000000000001",
    tokenIn: "0x0000000000000000000000000000000000000002",
    tokenOut: "0x0000000000000000000000000000000000000003",
    slotKind: "swap",
    edgeKind: "swap",
    leavesStandingPosition: false,
    ...(poolId === undefined ? {} : { poolId }),
  };
}

function pendingEvidence(
  id: ExecutionFamilyId,
  canonicalPayload: string,
): PendingExecutionEvidence {
  const payloadHash = ethers.keccak256(canonicalPayload);
  const evidenceHash = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["string", "bytes32", "uint256", "bytes32", "bytes32"],
      [id, txHash, 123, headHash, payloadHash],
    ),
  );
  return Object.freeze({
    familyId: id,
    txHash,
    headBlockNumber: 123,
    headHash,
    canonicalPayload,
    payloadHash,
    evidenceHash,
  });
}
