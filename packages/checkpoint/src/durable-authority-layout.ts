import { deepFreeze, hashDomain, type Hash } from "../../canonical-codec/src/index.ts";
import type { SQLiteDurableStore } from "../../durable-store/src/index.ts";
import {
  decodeRuntimeAuthorityProjectionV1,
  type RuntimeAuthorityProjectionV1,
} from "../../runtime-authority/src/index.ts";

export interface CheckpointDurableAuthorityLayoutV1 {
  readonly storeRole: "checkpoint-runtime";
  readonly rootKind: "aloha/checkpoint-root/v1";
  readonly runKind: "aloha/in-progress-run/v1";
  readonly candidatePartitionAuthorityKind: "aloha/candidate-partition-commitment/v1";
  readonly outcomeKind: "aloha/candidate-final-outcome/v1";
  readonly partialOutcomeKind: "aloha/attestation-partial-outcome/v1";
  readonly candidateIndexNamespace: "candidate";
  readonly outcomeIndexNamespace: "outcome";
  readonly partialOutcomeIndexNamespace: "partial-outcome";
  readonly schemaId: "aloha.checkpoint-durable-closure";
  readonly schemaVersion: "1.0.0";
  readonly schemaHash: Hash;
}

const LAYOUT_INPUT = Object.freeze({
  storeRole: "checkpoint-runtime" as const,
  rootKind: "aloha/checkpoint-root/v1" as const,
  runKind: "aloha/in-progress-run/v1" as const,
  candidatePartitionAuthorityKind: "aloha/candidate-partition-commitment/v1" as const,
  outcomeKind: "aloha/candidate-final-outcome/v1" as const,
  partialOutcomeKind: "aloha/attestation-partial-outcome/v1" as const,
  candidateIndexNamespace: "candidate" as const,
  outcomeIndexNamespace: "outcome" as const,
  partialOutcomeIndexNamespace: "partial-outcome" as const,
  schemaId: "aloha.checkpoint-durable-closure" as const,
  schemaVersion: "1.0.0" as const,
});

export const CHECKPOINT_DURABLE_LAYOUT_V1: CheckpointDurableAuthorityLayoutV1 = deepFreeze({
  ...LAYOUT_INPUT,
  schemaHash: hashDomain("aloha/checkpoint-authority-layout/v1", LAYOUT_INPUT),
});

export function checkpointDurableAuthorityLayoutV1(
  runtimeAuthorityInput: RuntimeAuthorityProjectionV1,
): CheckpointDurableAuthorityLayoutV1 {
  decodeRuntimeAuthorityProjectionV1(runtimeAuthorityInput);
  return CHECKPOINT_DURABLE_LAYOUT_V1;
}

export function bindCheckpointDurableAuthorityLayoutV1(
  durable: SQLiteDurableStore,
  runtimeAuthorityInput: RuntimeAuthorityProjectionV1,
): CheckpointDurableAuthorityLayoutV1 {
  const layout = checkpointDurableAuthorityLayoutV1(runtimeAuthorityInput);
  durable.bindStoreRole(layout.storeRole);
  return layout;
}
