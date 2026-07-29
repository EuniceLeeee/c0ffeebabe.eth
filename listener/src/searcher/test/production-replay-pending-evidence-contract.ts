import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { ethers } from "ethers";
import type {
  PendingExecutionEvidence,
  PendingTransactionEvidenceInput,
} from "../venues/route-leg-adapter.js";
import type {
  PendingTransactionEvidenceFailure,
  PendingTransactionEvidenceProjection,
  PendingTransactionEvidenceTransport,
} from "../venues/adapter-family-registry.js";
import {
  loadFrozenPendingExecutionEvidenceArtifact,
  observeFrozenTransactionExecutionEvidence,
  pendingExecutionEvidenceFamilyIds,
  pendingExecutionEvidenceReport,
  selectFrozenRouteExecutionEvidence,
  writeFrozenPendingExecutionEvidenceArtifact,
} from "./production-replay-pending-evidence.js";

const FAMILY_A = "custom-swap:fixture-a" as const;
const FAMILY_B = "custom-swap:fixture-b" as const;
const FAMILY_UNRELATED = "protocol:fixture-unrelated" as const;
const FAMILY_OPTIONAL = "protocol:fixture-optional" as const;
const tx = Object.freeze({
  hash: `0x${"11".repeat(32)}`,
  to: `0x${"22".repeat(20)}`,
  data: "0x1234",
}) satisfies PendingTransactionEvidenceInput;
const head = Object.freeze({
  number: 123,
  hash: `0x${"33".repeat(32)}`,
});
const transport = Object.freeze({
  head,
  async call() {
    return "0x";
  },
}) satisfies PendingTransactionEvidenceTransport;

const routeFamilies = pendingExecutionEvidenceFamilyIds(
  [
    { adapterId: "plain-edge" },
    { adapterId: "optional-evidence-edge" },
    { adapterId: "evidence-edge-b" },
    { adapterId: "evidence-edge-a" },
    { adapterId: "evidence-edge-a" },
  ],
  {
    forEdge(adapterId) {
      if (adapterId === "plain-edge") {
        return { id: "custom-swap:fixture-plain" };
      }
      if (adapterId === "optional-evidence-edge") {
        return {
          id: "custom-swap:fixture-optional",
          pendingTransactionEvidence: {},
        };
      }
      return {
        id: adapterId === "evidence-edge-a" ? FAMILY_A : FAMILY_B,
        pendingTransactionEvidence: {
          routeActivation: "current-head-block-scan",
        },
      };
    },
  },
);
assert.deepEqual(
  routeFamilies,
  [FAMILY_A, FAMILY_B],
  "route evidence families must be registry-derived, unique, and stable",
);

let observedFamilyIds: readonly string[] = [];
const projection = fakeProjection(
  [FAMILY_B, FAMILY_OPTIONAL, FAMILY_UNRELATED, FAMILY_A],
  async (_input, _transport, familyIds) => {
    observedFamilyIds = familyIds;
    return {
      evidence: familyIds.map((familyId, index) =>
        evidence(familyId, `0x${(index + 4).toString(16).padStart(2, "0")}`)),
      failures: [],
    };
  },
);
const frozen = await observeFrozenTransactionExecutionEvidence({
  projection,
  transaction: tx,
  familyRequiresCurrentHeadEvidence,
  transport,
  timeoutMs: 100,
  maxReadsPerFamily: 4,
});
assert.deepEqual(
  observedFamilyIds,
  [FAMILY_A, FAMILY_B, FAMILY_UNRELATED],
  "producer must freeze the complete registry-derived candidate set before scan",
);
assert.equal(frozen.freezePoint, "before-natural-route-scan");
assert(Object.isFrozen(frozen), "frozen evidence envelope must be immutable");

const selected = selectFrozenRouteExecutionEvidence(frozen, routeFamilies);
assert.deepEqual(
  selected.map((item) => item.familyId),
  [FAMILY_A, FAMILY_B],
  "selected evidence must exactly match the route-required family set",
);
const temp = mkdtempSync(resolve(tmpdir(), "pending-evidence-contract-"));
try {
  const path = resolve(temp, "evidence.json");
  const sha256 = writeFrozenPendingExecutionEvidenceArtifact(path, frozen);
  const loaded = loadFrozenPendingExecutionEvidenceArtifact(path, sha256);
  assert.deepEqual(loaded, JSON.parse(readFileSync(path, "utf8")));
  assert(
    Object.isFrozen(loaded) &&
      Object.isFrozen(loaded.evidence) &&
      loaded.evidence.every(Object.isFrozen),
    "loaded evidence must remain immutable inside the hunt process",
  );
  const report = pendingExecutionEvidenceReport(
    loaded,
    routeFamilies,
    sha256,
  );
  assert.deepEqual(report.requiredFamilyIds, routeFamilies);
  assert.deepEqual(
    report.commitments.map((item) => item.familyId),
    routeFamilies,
  );
  assert(
    report.commitments.every((item) =>
      ethers.keccak256(item.canonicalPayload).toLowerCase() ===
        item.payloadHash
    ),
    "commitments must retain the canonical payload needed to verify payloadHash",
  );

  await assert.rejects(
    async () => loadFrozenPendingExecutionEvidenceArtifact(
      path,
      "0".repeat(64),
    ),
    /artifact SHA-256 mismatch/,
  );
  writeFileSync(path, `${readFileSync(path, "utf8")} `);
  assert.throws(
    () => loadFrozenPendingExecutionEvidenceArtifact(path, sha256),
    /artifact SHA-256 mismatch/,
    "challenger-modified artifact bytes must not be accepted",
  );
} finally {
  rmSync(temp, { recursive: true, force: true });
}

const unrelatedFailure = await observeFrozenTransactionExecutionEvidence({
  projection: fakeProjection(
    [FAMILY_A, FAMILY_UNRELATED],
    async (_input, _transport, familyIds) => ({
      evidence: familyIds
        .filter((familyId) => familyId === FAMILY_A)
        .map((familyId) => evidence(familyId, "0x42")),
      failures: [{
        familyId: FAMILY_UNRELATED,
        code: "observer_error",
      }],
    }),
  ),
  transaction: tx,
  familyRequiresCurrentHeadEvidence,
  transport,
  timeoutMs: 100,
  maxReadsPerFamily: 4,
});
assert.deepEqual(
  selectFrozenRouteExecutionEvidence(unrelatedFailure, [FAMILY_A])
    .map((item) => item.familyId),
  [FAMILY_A],
  "an unrelated observer failure must remain family-local",
);
assert.throws(
  () => selectFrozenRouteExecutionEvidence(
    unrelatedFailure,
    [FAMILY_UNRELATED],
  ),
  /pending_execution_evidence_observer_failed:protocol:fixture-unrelated\/observer_error/,
);

const noMatch = await observeFrozenTransactionExecutionEvidence({
  projection: fakeProjection([FAMILY_A], async () => ({
    evidence: [],
    failures: [],
  })),
  transaction: tx,
  familyRequiresCurrentHeadEvidence,
  transport,
  timeoutMs: 100,
  maxReadsPerFamily: 4,
});
assert.throws(
  () => selectFrozenRouteExecutionEvidence(noMatch, [FAMILY_A]),
  /pending_execution_evidence_cardinality:custom-swap:fixture-a\/0/,
);
assert.throws(
  () => selectFrozenRouteExecutionEvidence(frozen, [FAMILY_A, FAMILY_A]),
  /required_family_set_invalid/,
);
assert.throws(
  () => selectFrozenRouteExecutionEvidence(frozen, [
    "custom-swap:fixture-missing",
  ]),
  /pending_execution_evidence_prefilter_unmatched:custom-swap:fixture-missing/,
);

await assert.rejects(
  observeFrozenTransactionExecutionEvidence({
    projection: fakeProjection([FAMILY_A], async () => ({
      evidence: [evidence(FAMILY_B, "0x44")],
      failures: [],
    })),
    transaction: tx,
    familyRequiresCurrentHeadEvidence,
    transport,
    timeoutMs: 100,
    maxReadsPerFamily: 4,
  }),
  /pending_execution_evidence_result_set_invalid/,
);
await assert.rejects(
  observeFrozenTransactionExecutionEvidence({
    projection: fakeProjection([FAMILY_A], async () => ({
      evidence: [
        evidence(FAMILY_A, "0x45"),
        evidence(FAMILY_A, "0x46"),
      ],
      failures: [],
    })),
    transaction: tx,
    familyRequiresCurrentHeadEvidence,
    transport,
    timeoutMs: 100,
    maxReadsPerFamily: 4,
  }),
  /pending_execution_evidence_result_set_invalid/,
);
await assert.rejects(
  observeFrozenTransactionExecutionEvidence({
    projection: fakeProjection([FAMILY_A], async () => ({
      evidence: [evidenceForBinding(
        FAMILY_A,
        "0x47",
        `0x${"99".repeat(32)}`,
        head.number,
        head.hash,
      )],
      failures: [],
    })),
    transaction: tx,
    familyRequiresCurrentHeadEvidence,
    transport,
    timeoutMs: 100,
    maxReadsPerFamily: 4,
  }),
  /pending_execution_evidence_binding_mismatch:custom-swap:fixture-a/,
);
await assert.rejects(
  observeFrozenTransactionExecutionEvidence({
    projection: fakeProjection([FAMILY_A], async () => ({
      evidence: [{
        ...evidence(FAMILY_A, "0x48"),
        payloadHash: `0x${"88".repeat(32)}`,
      }],
      failures: [],
    })),
    transaction: tx,
    familyRequiresCurrentHeadEvidence,
    transport,
    timeoutMs: 100,
    maxReadsPerFamily: 4,
  }),
  /pending_execution_evidence_payload_hash_mismatch:custom-swap:fixture-a/,
);
await assert.rejects(
  observeFrozenTransactionExecutionEvidence({
    projection: fakeProjection([FAMILY_A], async () => ({
      evidence: [{
        ...evidence(FAMILY_A, "0x49"),
        evidenceHash: `0x${"77".repeat(32)}`,
      }],
      failures: [],
    })),
    transaction: tx,
    familyRequiresCurrentHeadEvidence,
    transport,
    timeoutMs: 100,
    maxReadsPerFamily: 4,
  }),
  /pending_execution_evidence_binding_hash_mismatch:custom-swap:fixture-a/,
);

console.log("production-replay-pending-evidence-contract PASS");

function familyRequiresCurrentHeadEvidence(
  familyId: PendingExecutionEvidence["familyId"],
): boolean {
  return familyId !== FAMILY_OPTIONAL;
}

function evidence(
  familyId: PendingExecutionEvidence["familyId"],
  canonicalPayload: string,
): PendingExecutionEvidence {
  return evidenceForBinding(
    familyId,
    canonicalPayload,
    tx.hash,
    head.number,
    head.hash,
  );
}

function evidenceForBinding(
  familyId: PendingExecutionEvidence["familyId"],
  canonicalPayload: string,
  txHash: string,
  headBlockNumber: number,
  headHash: string,
): PendingExecutionEvidence {
  const payloadHash = ethers.keccak256(canonicalPayload);
  const evidenceHash = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["string", "bytes32", "uint256", "bytes32", "bytes32"],
      [familyId, txHash, headBlockNumber, headHash, payloadHash],
    ),
  );
  return Object.freeze({
    familyId,
    txHash,
    headBlockNumber,
    headHash,
    canonicalPayload,
    payloadHash,
    evidenceHash,
  });
}

function fakeProjection(
  candidates: readonly PendingExecutionEvidence["familyId"][],
  observe: (
    input: PendingTransactionEvidenceInput,
    transport: PendingTransactionEvidenceTransport,
    familyIds: readonly PendingExecutionEvidence["familyId"][],
  ) => Promise<{
    readonly evidence: readonly PendingExecutionEvidence[];
    readonly failures: readonly PendingTransactionEvidenceFailure[];
  }>,
): PendingTransactionEvidenceProjection {
  const projection: PendingTransactionEvidenceProjection = {
    familyIds: Object.freeze([...candidates]),
    candidateFamilyIds() {
      return Object.freeze([...candidates]);
    },
    async observe(input, observedTransport, policy = {}) {
      const familyIds = Object.freeze([...(policy.familyIds ?? candidates)]);
      const result = await observe(input, observedTransport, familyIds);
      const failureIds = new Set(
        result.failures.map((failure) => failure.familyId),
      );
      return Object.freeze({
        attemptedFamilyIds: familyIds,
        successfulFamilyIds: Object.freeze(
          familyIds.filter((familyId) => !failureIds.has(familyId)),
        ),
        evidence: Object.freeze([...result.evidence]),
        matched: result.evidence.length > 0,
        failures: Object.freeze([...result.failures]),
      });
    },
  };
  return Object.freeze(projection);
}
