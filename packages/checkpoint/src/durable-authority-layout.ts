import { deepFreeze, hashDomain, type Hash } from "../../canonical-codec/src/index.ts";
import type { SQLiteDurableStore } from "../../durable-store/src/index.ts";
import {
  decodeRuntimeAuthorityProjectionV1,
  type RuntimeAuthorityClassV1,
  type RuntimeAuthorityProjectionV1,
} from "../../runtime-authority/src/index.ts";

export interface CheckpointDurableAuthorityLayoutV1 {
  readonly authorityClass: RuntimeAuthorityClassV1;
  readonly storeRole: "checkpoint" | "checkpoint-unsigned-dry-run";
  readonly rootKind: "aloha/checkpoint-root/v2" | "aloha/unsigned-dry-run-checkpoint-root/v1";
  readonly runKind: "aloha/in-progress-run/v2" | "aloha/unsigned-dry-run-in-progress-run/v1";
  readonly candidatePartitionAuthorityKind:
    | "aloha/candidate-partition-proof/v2"
    | "aloha/unsigned-dry-run-candidate-partition-commitment/v1";
  readonly outcomeKind:
    | "aloha/candidate-final-outcome/v1"
    | "aloha/unsigned-dry-run-candidate-final-outcome/v1";
  readonly partialOutcomeKind:
    | "aloha/attestation-partial-outcome/v1"
    | "aloha/unsigned-dry-run-attestation-partial-outcome/v1";
  readonly candidateIndexNamespace: "candidate" | "unsigned-dry-run/candidate";
  readonly outcomeIndexNamespace: "outcome" | "unsigned-dry-run/outcome";
  readonly partialOutcomeIndexNamespace: "partial-outcome" | "unsigned-dry-run/partial-outcome";
  readonly schemaId:
    | "aloha.checkpoint-durable-closure"
    | "aloha.unsigned-dry-run-checkpoint-durable-closure";
  readonly schemaVersion: "15.0.0" | "1.0.0";
  readonly schemaHash: Hash;
}

const SIGNED_LAYOUT_INPUT = Object.freeze({
  authorityClass: "signed-release" as const,
  storeRole: "checkpoint" as const,
  rootKind: "aloha/checkpoint-root/v2" as const,
  runKind: "aloha/in-progress-run/v2" as const,
  candidatePartitionAuthorityKind: "aloha/candidate-partition-proof/v2" as const,
  outcomeKind: "aloha/candidate-final-outcome/v1" as const,
  partialOutcomeKind: "aloha/attestation-partial-outcome/v1" as const,
  candidateIndexNamespace: "candidate" as const,
  outcomeIndexNamespace: "outcome" as const,
  partialOutcomeIndexNamespace: "partial-outcome" as const,
  schemaId: "aloha.checkpoint-durable-closure" as const,
  schemaVersion: "15.0.0" as const,
});

const UNSIGNED_LAYOUT_INPUT = Object.freeze({
  authorityClass: "unsigned-dry-run" as const,
  storeRole: "checkpoint-unsigned-dry-run" as const,
  rootKind: "aloha/unsigned-dry-run-checkpoint-root/v1" as const,
  runKind: "aloha/unsigned-dry-run-in-progress-run/v1" as const,
  candidatePartitionAuthorityKind: "aloha/unsigned-dry-run-candidate-partition-commitment/v1" as const,
  outcomeKind: "aloha/unsigned-dry-run-candidate-final-outcome/v1" as const,
  partialOutcomeKind: "aloha/unsigned-dry-run-attestation-partial-outcome/v1" as const,
  candidateIndexNamespace: "unsigned-dry-run/candidate" as const,
  outcomeIndexNamespace: "unsigned-dry-run/outcome" as const,
  partialOutcomeIndexNamespace: "unsigned-dry-run/partial-outcome" as const,
  schemaId: "aloha.unsigned-dry-run-checkpoint-durable-closure" as const,
  schemaVersion: "1.0.0" as const,
});

function sealLayout(
  input: typeof SIGNED_LAYOUT_INPUT | typeof UNSIGNED_LAYOUT_INPUT,
): CheckpointDurableAuthorityLayoutV1 {
  return deepFreeze({
    ...input,
    schemaHash: hashDomain("aloha/checkpoint-authority-layout/v1", input),
  });
}

export const SIGNED_RELEASE_CHECKPOINT_DURABLE_LAYOUT_V1 = sealLayout(SIGNED_LAYOUT_INPUT);
export const UNSIGNED_DRY_RUN_CHECKPOINT_DURABLE_LAYOUT_V1 = sealLayout(UNSIGNED_LAYOUT_INPUT);

export function checkpointDurableAuthorityLayoutV1(
  runtimeAuthorityInput: RuntimeAuthorityProjectionV1,
): CheckpointDurableAuthorityLayoutV1 {
  const runtimeAuthority = decodeRuntimeAuthorityProjectionV1(runtimeAuthorityInput);
  return runtimeAuthority.authorityClass === "signed-release"
    ? SIGNED_RELEASE_CHECKPOINT_DURABLE_LAYOUT_V1
    : UNSIGNED_DRY_RUN_CHECKPOINT_DURABLE_LAYOUT_V1;
}

/**
 * Persist the authority class in SQLite's tamper-evident role binding before
 * any checkpoint root is opened.  SQLiteDurableStore rejects a later bind to
 * the other role, so a signed database cannot be opened as unsigned and an
 * unsigned database cannot be opened as signed.
 */
export function bindCheckpointDurableAuthorityLayoutV1(
  durable: SQLiteDurableStore,
  runtimeAuthorityInput: RuntimeAuthorityProjectionV1,
): CheckpointDurableAuthorityLayoutV1 {
  const layout = checkpointDurableAuthorityLayoutV1(runtimeAuthorityInput);
  durable.bindStoreRole(layout.storeRole);
  return layout;
}
