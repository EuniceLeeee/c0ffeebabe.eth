import assert from "node:assert/strict";
import test from "node:test";
import { ethers } from "ethers";
import {
  assertPendingExecutionEvidence,
  assertShardCompleteness,
  requiredPendingExecutionEvidenceSha256,
} from "../six-step-validation-controller.js";
import type {
  FamilyOwnershipManifest,
  FamilyOwnershipManifestEntry,
} from "../../../listener/src/searcher/test/family-ownership-manifest.js";
import type {
  SixStepStateAnchor,
} from "../six-step-validation-lifecycle.js";

const FAMILY_A = "custom-swap:fixture-a";
const FAMILY_B = "protocol:fixture-b";
const FAMILY_PLAIN = "custom-swap:fixture-plain";
const TX = `0x${"11".repeat(32)}`;
const HEAD_HASH = `0x${"22".repeat(32)}`;
const SHA = "3".repeat(64);
const anchor = {
  base_block: 123,
  base_block_hash: HEAD_HASH,
} as SixStepStateAnchor;
const manifest: FamilyOwnershipManifest = {
  schema_version: 1,
  registry_order: [FAMILY_A, FAMILY_B, FAMILY_PLAIN],
  action_catalog_ids: [],
  registry_skeleton_sha256: SHA,
  action_index_skeleton_sha256: SHA,
  families: [
    family(FAMILY_A, true),
    family(FAMILY_B, true),
    family(FAMILY_PLAIN, false),
  ],
};

test("controller validates the exact registry-derived evidence-required set", () => {
  assert.doesNotThrow(() => assertPendingExecutionEvidence(
    raw([FAMILY_A, FAMILY_B]),
    [FAMILY_A, FAMILY_B, FAMILY_PLAIN],
    manifest,
    TX,
    anchor,
  ));
});

test("controller rejects empty, subset, duplicate, and unrequested evidence", () => {
  for (const [mutate, expected] of [
    [
      (value: Record<string, unknown>) => {
        value.requiredFamilyIds = [];
        value.commitments = [];
      },
      /required set is invalid/,
    ],
    [
      (value: Record<string, unknown>) => {
        value.requiredFamilyIds = [FAMILY_A];
        value.commitments = [commitment(FAMILY_A)];
      },
      /required set is invalid/,
    ],
    [
      (value: Record<string, unknown>) => {
        value.commitments = [
          commitment(FAMILY_A),
          commitment(FAMILY_A),
        ];
      },
      /family\/tx\/head binding is invalid/,
    ],
    [
      (value: Record<string, unknown>) => {
        value.commitments = [
          commitment(FAMILY_A),
          commitment("custom-swap:fixture-unrequested"),
        ];
      },
      /family\/tx\/head binding is invalid/,
    ],
  ] as const) {
    const report = raw([FAMILY_A, FAMILY_B]).executionEvidence;
    mutate(report);
    assert.throws(
      () => assertPendingExecutionEvidence(
        { executionEvidence: report },
        [FAMILY_A, FAMILY_B, FAMILY_PLAIN],
        manifest,
        TX,
        anchor,
      ),
      expected,
    );
  }
});

test("controller recomputes payload and binding hashes", () => {
  const txMismatch = raw([FAMILY_A, FAMILY_B]);
  txMismatch.executionEvidence.commitments[0].txHash =
    `0x${"99".repeat(32)}`;
  assert.throws(
    () => assertPendingExecutionEvidence(
      txMismatch,
      [FAMILY_A, FAMILY_B],
      manifest,
      TX,
      anchor,
    ),
    /family\/tx\/head binding is invalid/,
  );

  const headTypeMismatch = raw([FAMILY_A, FAMILY_B]);
  headTypeMismatch.executionEvidence.commitments[0].headBlockNumber = "123";
  assert.throws(
    () => assertPendingExecutionEvidence(
      headTypeMismatch,
      [FAMILY_A, FAMILY_B],
      manifest,
      TX,
      anchor,
    ),
    /family\/tx\/head binding is invalid/,
  );

  const payloadMismatch = raw([FAMILY_A, FAMILY_B]);
  payloadMismatch.executionEvidence.commitments[0].payloadHash =
    `0x${"88".repeat(32)}`;
  assert.throws(
    () => assertPendingExecutionEvidence(
      payloadMismatch,
      [FAMILY_A, FAMILY_B],
      manifest,
      TX,
      anchor,
    ),
    /payload hash is invalid/,
  );

  const evidenceMismatch = raw([FAMILY_A, FAMILY_B]);
  evidenceMismatch.executionEvidence.commitments[0].evidenceHash =
    `0x${"77".repeat(32)}`;
  assert.throws(
    () => assertPendingExecutionEvidence(
      evidenceMismatch,
      [FAMILY_A, FAMILY_B],
      manifest,
      TX,
      anchor,
    ),
    /binding hash is invalid/,
  );
});

test("final equivalence ignores unrelated full-artifact churn", () => {
  const checkpoint = raw([FAMILY_A]).executionEvidence;
  const final = raw([FAMILY_A]).executionEvidence;
  checkpoint.artifactSha256 = "4".repeat(64);
  final.artifactSha256 = "5".repeat(64);
  final.candidateFamilyIds = [FAMILY_A, FAMILY_B, "protocol:unrelated"];
  final.attemptedFamilyIds = [...final.candidateFamilyIds];
  assert.equal(
    requiredPendingExecutionEvidenceSha256(checkpoint),
    requiredPendingExecutionEvidenceSha256(final),
    "checkpoint/final equivalence must bind the selected route's required " +
      "commitments, not unrelated observer outcomes in the full artifact",
  );
});

test("required dynamic source coverage is an exact manifest-owned set", () => {
  const dynamicManifest: FamilyOwnershipManifest = {
    ...manifest,
    families: manifest.families.map((entry) =>
      entry.id === FAMILY_B
        ? {
            ...entry,
            candidate_source_ids: [
              "dex-token-domain",
              "observed-interaction",
            ],
          }
        : entry),
  };
  const proof = (sourceIds: readonly string[]) => ({
    discovery: {
      shardCompleteness: {
        requiredFamilyIds: [FAMILY_B],
        requiredComplete: true,
        familyShards: [{
          familyId: FAMILY_B,
          sourceKind: "dynamic-discovery",
          status: "complete",
          required: true,
          disposition: "required",
          sourceCoverage: sourceIds.map((sourceId) => ({
            sourceId,
            complete: true,
            issues: [],
          })),
        }],
      },
    },
  });
  assert.doesNotThrow(() => assertShardCompleteness(
    proof(["observed-interaction", "dex-token-domain"]),
    [FAMILY_B],
    dynamicManifest,
  ));
  assert.throws(
    () => assertShardCompleteness(
      proof(["observed-interaction"]),
      [FAMILY_B],
      dynamicManifest,
    ),
    /source coverage is not exact/,
  );
  assert.throws(
    () => assertShardCompleteness(
      proof([
        "observed-interaction",
        "dex-token-domain",
        "unexpected-source",
      ]),
      [FAMILY_B],
      dynamicManifest,
    ),
    /source coverage is not exact/,
  );
});

function raw(required: readonly string[]): {
  executionEvidence: {
    schemaVersion: number;
    freezePoint: string;
    artifactSha256: string;
    candidateFamilyIds: string[];
    attemptedFamilyIds: string[];
    requiredFamilyIds: string[];
    commitments: Array<Record<string, unknown>>;
  };
} {
  const candidates = [FAMILY_A, FAMILY_B];
  return {
    executionEvidence: {
      schemaVersion: 1,
      freezePoint: "before-natural-route-scan",
      artifactSha256: SHA,
      candidateFamilyIds: [...candidates],
      attemptedFamilyIds: [...candidates],
      requiredFamilyIds: [...required],
      commitments: required.map(commitment),
    },
  };
}

function commitment(familyId: string): Record<string, unknown> {
  const canonicalPayload = "0x1234";
  const payloadHash = ethers.keccak256(canonicalPayload);
  return {
    familyId,
    txHash: TX,
    headBlockNumber: anchor.base_block,
    headHash: HEAD_HASH,
    canonicalPayload,
    payloadHash,
    evidenceHash: ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ["string", "bytes32", "uint256", "bytes32", "bytes32"],
        [familyId, TX, anchor.base_block, HEAD_HASH, payloadHash],
      ),
    ),
  };
}

function family(
  id: string,
  pendingExecutionEvidence: boolean,
): FamilyOwnershipManifestEntry {
  return {
    id,
    kind: id.startsWith("protocol:") ? "protocol-conversion" : "swap",
    root_source: "src/searcher/venues/swaps/fixture.ts",
    root_export: "fixture",
    source_files: ["src/searcher/venues/swaps/fixture.ts"],
    pool_adapter_ids: [],
    edge_adapter_ids: [],
    owned_action_adapter_ids: [],
    owned_action_bindings: [],
    required_action_adapter_ids: [],
    required_action_bindings: [],
    candidate_source_ids: [],
    requires_current_head_execution_evidence: pendingExecutionEvidence,
    activation_sha256: SHA,
  };
}
