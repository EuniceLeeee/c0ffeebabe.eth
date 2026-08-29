import type { StartupRuntimeV1 } from "../index.ts";
import {
  type ReadyStage12EvidenceCapabilityV1,
  type ReadyStage12EvidenceReaderPortV1,
  type ReadyStage12EvidenceSnapshotV1,
} from "../../../checkpoint/src/ready-stage12-evidence.ts";
import { assertCheckpointReadyStage12EvidenceReader } from "../../../checkpoint/src/internal/ready-stage12-evidence-consumer.ts";
import type { ReadyFullFamilyEvidenceReaderPortV1 } from "../../../checkpoint/src/ready-full-family-evidence.ts";
import { assertCheckpointReadyFullFamilyEvidenceReader } from "../../../checkpoint/src/internal/ready-full-family-evidence-consumer.ts";

const issued = new WeakSet<object>();
const stage12Evidence = new WeakMap<object, {
  readonly capability: (generationId?: string) => ReadyStage12EvidenceCapabilityV1;
  readonly reader: ReadyStage12EvidenceReaderPortV1;
  readonly fullFamilyReader: ReadyFullFamilyEvidenceReaderPortV1;
}>();

export interface StartupFullFamilyEvidenceBindingV1 {
  readonly checkpointReader: ReadyFullFamilyEvidenceReaderPortV1;
  readonly stage12Capability: ReadyStage12EvidenceCapabilityV1;
}

/** Register the exact runtime object assembled by startup. */
export function issueStartupRuntime(
  value: StartupRuntimeV1,
): StartupRuntimeV1 {
  if (value === null || typeof value !== "object") {
    throw new TypeError("startup runtime must be an object");
  }
  issued.add(value);
  return value;
}

/** Production startup binds the durable Stage 1/2 seam at issuance time. */
export function issueStartupRuntimeWithStage12Evidence(
  value: StartupRuntimeV1,
  evidence: {
    readonly capability: ReadyStage12EvidenceCapabilityV1 | ((generationId?: string) => ReadyStage12EvidenceCapabilityV1);
    readonly reader: ReadyStage12EvidenceReaderPortV1;
    readonly fullFamilyReader: ReadyFullFamilyEvidenceReaderPortV1;
  },
): StartupRuntimeV1 {
  if (evidence?.capability === null
    || (typeof evidence?.capability !== "object" && typeof evidence?.capability !== "function")) {
    throw new TypeError("startup stage1/2 evidence capability is missing");
  }
  issueStartupRuntime(value);
  const readCapability: (generationId?: string) => ReadyStage12EvidenceCapabilityV1 = typeof evidence.capability === "function"
    ? evidence.capability as (generationId?: string) => ReadyStage12EvidenceCapabilityV1
    : () => evidence.capability as ReadyStage12EvidenceCapabilityV1;
  stage12Evidence.set(value, Object.freeze({
    capability: readCapability,
    reader: evidence.reader,
    fullFamilyReader: evidence.fullFamilyReader,
  }));
  return value;
}

/**
 * The application entry may consume only the startup owner's object. A
 * copied structural runner would otherwise be able to replace the frozen
 * ready/session seam while preserving the public method names.
 */
export function assertIssuedStartupRuntime(value: unknown): asserts value is StartupRuntimeV1 {
  if (value === null || typeof value !== "object" || !issued.has(value)) {
    throw new TypeError("startup runtime is not owner-issued");
  }
}

/**
 * Narrow read-only seam for the later SixStep owner. The runtime carries the
 * exact capability selected during startup; callers cannot provide a ready
 * DTO, substitute a reader, or mint another capability.
 */
export function readStartupStage12Evidence(
  value: unknown,
): Promise<ReadyStage12EvidenceSnapshotV1> {
  assertIssuedStartupRuntime(value);
  const evidence = stage12Evidence.get(value);
  if (!evidence) throw new TypeError("startup stage1/2 evidence is unavailable");
  const reader = assertCheckpointReadyStage12EvidenceReader(evidence.reader);
  return reader.read(evidence.capability());
}

/** Durable replay verifier: re-loads the checkpoint-owned closure and exact-compares every byte. */
export function verifyStartupStage12Evidence(
  value: unknown,
  snapshot: ReadyStage12EvidenceSnapshotV1,
): Promise<ReadyStage12EvidenceSnapshotV1> {
  assertIssuedStartupRuntime(value);
  const evidence = stage12Evidence.get(value as object);
  if (!evidence) throw new TypeError("startup stage1/2 evidence is unavailable");
  const reader = assertCheckpointReadyStage12EvidenceReader(evidence.reader);
  return reader.verify(evidence.capability(), snapshot);
}

/**
 * Narrow owner-to-owner bridge for the external Full-Family observer. It
 * exposes only the exact Checkpoint reader and Stage 1/2 capability selected
 * by startup; no ready DTO or caller-provided locator can be substituted.
 */
export function readStartupFullFamilyEvidenceBinding(
  value: unknown,
  generationId?: string,
): StartupFullFamilyEvidenceBindingV1 {
  assertIssuedStartupRuntime(value);
  const evidence = stage12Evidence.get(value as object);
  if (!evidence) throw new TypeError("startup full-family evidence is unavailable");
  return Object.freeze({
    checkpointReader: assertCheckpointReadyFullFamilyEvidenceReader(evidence.fullFamilyReader),
    stage12Capability: evidence.capability(generationId),
  });
}
