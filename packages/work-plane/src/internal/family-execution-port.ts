import { randomUUID } from "node:crypto";
import {
  decodeCanonicalJson,
  deepFreeze,
  encodeCanonicalJson,
  hashDomain,
  type Hash,
} from "../../../../packages/canonical-codec/src/index.ts";
import type {
  QualifiedExecutorAuthorityCapability,
  QualifiedExecutorAuthorityIssuer,
  QualifiedExecutorAuthorityProvenanceV1,
} from "../../../../packages/scheduler/src/index.ts";
import { assertIssuedQualifiedExecutorAuthorityIssuer } from "../../../../packages/scheduler/src/internal/authority-consumer.ts";
import {
  assertCapabilityWorkIntent,
  type CapabilityWorkIntentV1,
  type FamilyFrozenProgramExecutionInput,
  type FamilyFrozenProgramExecutionPort,
  type FamilyFrozenProgramExecutionResult,
  type FamilyStampedFactView,
} from "../index.ts";

interface SchedulerOwnedFamilyExecutionInput<Fact> {
  readonly issuer: QualifiedExecutorAuthorityIssuer;
  readonly capability: QualifiedExecutorAuthorityCapability;
  /** Framework-owned physical execution; no scheduler or permit is exposed to the Family callback. */
  readonly execute: (input: {
    readonly intent: CapabilityWorkIntentV1;
    readonly signal: AbortSignal;
    readonly provenance: QualifiedExecutorAuthorityProvenanceV1;
    readonly executionSessionHash: Hash;
  }) => Promise<Fact>;
}

function detachedIntent(intent: CapabilityWorkIntentV1): CapabilityWorkIntentV1 {
  const detached = decodeCanonicalJson(encodeCanonicalJson(intent)) as unknown as CapabilityWorkIntentV1;
  assertCapabilityWorkIntent(detached);
  return deepFreeze(detached);
}

/** Internal-only composition constructor; package `.` deliberately does not export it. */
export function createSchedulerOwnedFamilyExecutionPort<Fact>(
  input: SchedulerOwnedFamilyExecutionInput<Fact>,
): FamilyFrozenProgramExecutionPort<Fact> {
  if (!input || typeof input !== "object") throw new TypeError("family execution input is required");
  const issuer = assertIssuedQualifiedExecutorAuthorityIssuer(input.issuer);
  if (!input.capability || (typeof input.capability !== "object" && typeof input.capability !== "function")) throw new TypeError("family execution capability is required");
  if (typeof input.execute !== "function") throw new TypeError("family frozen-program executor is required");
  const capability = input.capability;
  return Object.freeze({
    async executeFrozenProgram(request: FamilyFrozenProgramExecutionInput): Promise<FamilyFrozenProgramExecutionResult<Fact>> {
      if (!request || typeof request !== "object") throw new TypeError("family frozen-program request is required");
      for (const key of Reflect.ownKeys(request)) {
        if (typeof key !== "string" || !["intent", "attemptId", "signal"].includes(key)) throw new TypeError(`unknown family frozen-program request field ${String(key)}`);
      }
      if (!Object.prototype.hasOwnProperty.call(request, "intent")) throw new TypeError("family frozen-program request intent is required");
      const intent = detachedIntent(request.intent);
      const signal = request.signal ?? new AbortController().signal;
      const provenance = issuer.provenance(capability);
      const executionSessionHash = hashDomain("aloha/qualified-execution-session/v1", {
        authorityRoot: provenance.authorityRoot,
        executorSession: provenance.executorSession,
        version: provenance.version,
        nonce: randomUUID(),
        attemptId: request.attemptId ?? String(intent.intentId),
        intentId: intent.intentId,
        source: intent.source,
        generationLeaseRef: intent.generationLeaseRef,
        frozenProgramRef: intent.frozenProgramRef,
        programInputRef: intent.programInputRef,
        programInput: intent.programInput,
      });
      const fact = await input.execute({ intent, signal, provenance, executionSessionHash });
      const current = issuer.provenance(capability);
      if (current.authorityRoot !== provenance.authorityRoot
        || current.workerEpoch !== provenance.workerEpoch
        || current.executorSession !== provenance.executorSession
        || current.version !== provenance.version) {
        throw new Error("qualified executor authority changed during execution");
      }
      const stamped: FamilyStampedFactView<Fact> = {
        fact: deepFreeze(fact),
        source: Object.freeze({ ...intent.source }),
        authorityRoot: provenance.authorityRoot,
        workerEpoch: provenance.workerEpoch,
        executorSession: provenance.executorSession,
        executionSessionHash,
      };
      return deepFreeze(stamped);
    },
  });
}
