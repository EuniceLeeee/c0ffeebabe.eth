import { randomUUID } from "node:crypto";
import {
  assertExactKeys,
  assertHash,
  assertNonEmptyString,
  decodeCanonicalJson,
  deepFreeze,
  encodeCanonicalJson,
  hashDomain,
  type Hash,
} from "../../../../packages/canonical-codec/src/index.ts";
import type { RetryableTransportCodeV1, TransportFactV1 } from "../../../../packages/capability-interpreters/src/index.ts";
import type {
  QualifiedExecutorAuthorityCapability,
  QualifiedExecutorAuthorityIssuer,
} from "../../../../packages/scheduler/src/index.ts";
import { assertIssuedQualifiedExecutorAuthorityIssuer } from "../../../../packages/scheduler/src/internal/authority-consumer.ts";
import {
  readQualifiedSharedSchedulerRuntimePort,
  type QualifiedSharedSchedulerRuntimePortV1,
} from "../../../../packages/scheduler/src/internal/shared-runtime-owner.ts";
import {
  assertCapabilityWorkIntent,
  type SourceLessTransportResultV1,
  type CapabilityWorkIntentV1,
  type FamilyFrozenProgramExecutionInput,
  type FamilyFrozenProgramExecutionPort,
  type FamilyFrozenProgramExecutionResult,
  type FamilyStampedFactView,
  type QualifiedPhysicalExecutionPortV1,
} from "../index.ts";
import type {
  FamilyRuntimeStageV1,
  FamilyStageProgramV1,
  RuntimeStageExecutorV1,
} from "../../../../packages/family-sdk/runtime/index.ts";

interface SchedulerOwnedFamilyExecutionInput<Fact> {
  readonly issuer: QualifiedExecutorAuthorityIssuer;
  readonly capability: QualifiedExecutorAuthorityCapability;
  /** Framework-owned physical execution, already bound to this issuer/capability. */
  readonly physicalExecution: QualifiedPhysicalExecutionPortV1<Fact>;
}

const FAMILY_RUNTIME_STAGES = Object.freeze([
  "nomination",
  "identity",
  "materialization",
  "projection",
  "rehydration",
] as const satisfies readonly FamilyRuntimeStageV1[]);

const issuedFamilyExecutionPorts = new WeakMap<object, {
  readonly issuer: QualifiedExecutorAuthorityIssuer;
  readonly capability: QualifiedExecutorAuthorityCapability;
}>();
const physicalExecutionPorts = new WeakMap<object, {
  readonly issuer: QualifiedExecutorAuthorityIssuer;
  readonly capability: QualifiedExecutorAuthorityCapability;
  readonly schedulerRuntime: QualifiedSharedSchedulerRuntimePortV1;
  readonly execute: QualifiedPhysicalExecutionPortV1<unknown>["execute"];
}>();

/** Deployment/work-plane owner edge; its returned object is the only shape accepted by bootstrap. */
export function issueQualifiedPhysicalExecutionPort<Fact>(input: {
  readonly issuer: QualifiedExecutorAuthorityIssuer;
  readonly capability: QualifiedExecutorAuthorityCapability;
  readonly schedulerRuntime: QualifiedSharedSchedulerRuntimePortV1;
  readonly execute: QualifiedPhysicalExecutionPortV1<Fact>["execute"];
}): QualifiedPhysicalExecutionPortV1<Fact> {
  const issuer = assertIssuedQualifiedExecutorAuthorityIssuer(input.issuer);
  if (!input.capability || (typeof input.capability !== "object" && typeof input.capability !== "function")) {
    throw new TypeError("physical execution capability is required");
  }
  if (typeof input.execute !== "function") throw new TypeError("physical execution callback is required");
  issuer.provenance(input.capability);
  readQualifiedSharedSchedulerRuntimePort(input.schedulerRuntime, issuer, input.capability);
  const port = Object.freeze({ execute: input.execute });
  physicalExecutionPorts.set(port, {
    issuer,
    capability: input.capability,
    schedulerRuntime: input.schedulerRuntime,
    execute: input.execute as QualifiedPhysicalExecutionPortV1<unknown>["execute"],
  });
  return port;
}

/** Bootstrap-only identity join between the physical executor and release scheduler. */
export function assertQualifiedPhysicalExecutionSchedulerRuntime(
  physicalExecution: unknown,
  schedulerRuntime: QualifiedSharedSchedulerRuntimePortV1,
  issuer: QualifiedExecutorAuthorityIssuer,
  capability: QualifiedExecutorAuthorityCapability,
): void {
  assertPhysicalExecutionPort(physicalExecution, issuer, capability);
  const state = physicalExecutionPorts.get(physicalExecution as object)!;
  if (state.schedulerRuntime !== schedulerRuntime) {
    throw new TypeError("physical execution and release discovery do not share one scheduler runtime");
  }
}

function assertPhysicalExecutionPort<Fact>(
  value: unknown,
  issuer: QualifiedExecutorAuthorityIssuer,
  capability: QualifiedExecutorAuthorityCapability,
): QualifiedPhysicalExecutionPortV1<Fact>["execute"] {
  if (value === null || typeof value !== "object") throw new TypeError("physical execution port is not owner-issued");
  const state = physicalExecutionPorts.get(value);
  if (state === undefined || state.capability !== capability) {
    throw new TypeError("physical execution port is not bound to this qualified executor");
  }
  const physical = state.issuer.provenance(state.capability);
  const requested = issuer.provenance(capability);
  if (
    physical.authorityRoot !== requested.authorityRoot
    || physical.workerEpoch !== requested.workerEpoch
    || physical.executorSession !== requested.executorSession
    || physical.version !== requested.version
  ) throw new TypeError("physical execution port is not bound to this qualified executor");
  return state.execute as QualifiedPhysicalExecutionPortV1<Fact>["execute"];
}

export function assertIssuedFamilyFrozenProgramExecutionPort(
  value: unknown,
): asserts value is FamilyFrozenProgramExecutionPort<unknown> {
  if (value === null || (typeof value !== "object" && typeof value !== "function") || !issuedFamilyExecutionPorts.has(value as object)) {
    throw new TypeError("Family frozen-program execution port is not release-issued");
  }
}

/** Owner-only exact binding used by runtime-release-authority before it joins
 * the execution port to generated Family metadata. */
export function readIssuedFamilyFrozenProgramExecutionBinding(value: unknown): {
  readonly authorityRoot: string;
  readonly workerEpoch: string;
  readonly executorSession: string;
  readonly version: number;
} {
  assertIssuedFamilyFrozenProgramExecutionPort(value);
  const state = issuedFamilyExecutionPorts.get(value as object)!;
  return Object.freeze({ ...state.issuer.provenance(state.capability) });
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
  const capability = input.capability;
  const physicalExecute = assertPhysicalExecutionPort<Fact>(input.physicalExecution, issuer, capability);
  const port = Object.freeze({
    async executeFrozenProgram(request: FamilyFrozenProgramExecutionInput): Promise<FamilyFrozenProgramExecutionResult<Fact>> {
      if (!request || typeof request !== "object") throw new TypeError("family frozen-program request is required");
      for (const key of Reflect.ownKeys(request)) {
        if (typeof key !== "string" || !["intent", "rawEvidence", "attemptId", "signal"].includes(key)) throw new TypeError(`unknown family frozen-program request field ${String(key)}`);
      }
      if (!Object.prototype.hasOwnProperty.call(request, "intent")) throw new TypeError("family frozen-program request intent is required");
      if (request.rawEvidence === null || typeof request.rawEvidence !== "object" || typeof request.rawEvidence.read !== "function") {
        throw new TypeError("family frozen-program raw-evidence read port is required");
      }
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
      const fact = await physicalExecute({ intent, rawEvidence: request.rawEvidence, signal });
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
  issuedFamilyExecutionPorts.set(port, Object.freeze({ issuer, capability }));
  return port;
}

function exactSourceLessResult(value: unknown, path: string): SourceLessTransportResultV1 {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${path} must be a source-less transport result`);
  const kind = (value as { readonly kind?: unknown }).kind;
  if (kind === "returned" || kind === "reverted") {
    assertExactKeys(value, ["kind", "requestId", "dataHex"], path);
    const requestId = assertHash((value as { readonly requestId: unknown }).requestId, `${path}.requestId`);
    const dataHex = assertNonEmptyString((value as { readonly dataHex: unknown }).dataHex, `${path}.dataHex`);
    if (!/^0x(?:[0-9a-f]{2})*$/.test(dataHex)) throw new TypeError(`${path}.dataHex must be canonical bytes`);
    return Object.freeze({ kind, requestId, dataHex });
  }
  if (kind === "transportFailure") {
    assertExactKeys(value, ["kind", "requestId", "failureCode"], path);
    const requestId = assertHash((value as { readonly requestId: unknown }).requestId, `${path}.requestId`);
    const failureCode = (value as { readonly failureCode?: unknown }).failureCode;
    if (typeof failureCode !== "string" || !["rpc", "deadline", "abort", "queue-full", "resource-limit", "worker-crash", "source-stale"].includes(failureCode)) {
      throw new TypeError(`${path}.failureCode is invalid`);
    }
    return Object.freeze({ kind, requestId, failureCode: failureCode as RetryableTransportCodeV1 });
  }
  throw new TypeError(`${path}.kind is invalid`);
}

function stageIntent(program: FamilyStageProgramV1): CapabilityWorkIntentV1 {
  const programInput = decodeCanonicalJson(program.frozenProgram.canonicalPayloadBytes);
  const programInputHash = hashDomain("aloha/work-plane-program-input/v1", programInput);
  const source = Object.freeze({
    chainId: program.source.chainId,
    number: program.source.number,
    hash: program.source.hash,
    stateRoot: program.source.stateRoot,
  });
  const intent = {
    intentId: program.requestFingerprint,
    ownerRef: program.stageRef.ownerRef,
    capabilityRef: program.stageRef.capabilityId,
    workClassRef: program.stageRef.capabilityId,
    phase: program.stage,
    source,
    generationLeaseRef: Object.freeze({ ref: program.source.hash, source, generation: program.source.number }),
    frozenProgramRef: Object.freeze({
      ref: program.frozenProgramRef.recordHash,
      schemaHash: program.stageRef.schemaHash,
      programHash: program.frozenProgram.requestFingerprint,
      programInputHash,
      issuerRef: program.stageRef.ownerRef,
    }),
    programInputRef: Object.freeze({
      recordHash: program.frozenProgramRef.recordHash,
      familyId: String(program.familyId),
      familyDefinitionHash: program.familyDefinitionHash,
      familyCandidateKey: program.candidateKey,
    }),
    consumerDeadline: Number.MAX_SAFE_INTEGER,
    programInput,
  } satisfies CapabilityWorkIntentV1;
  assertCapabilityWorkIntent(intent);
  return deepFreeze(intent);
}

function transportFacts(
  program: FamilyStageProgramV1,
  result: FamilyFrozenProgramExecutionResult<unknown>,
): readonly TransportFactV1[] {
  if (
    result.source.chainId !== program.source.chainId
    || result.source.number !== program.source.number
    || result.source.hash !== program.source.hash
    || result.source.stateRoot !== program.source.stateRoot
  ) throw new TypeError("Family transport source does not match frozen program");
  const values = Array.isArray(result.fact) ? result.fact : [result.fact];
  return Object.freeze(values.map((value, index) => {
    const raw = exactSourceLessResult(value, `familyTransport.results[${index}]`);
    const source = Object.freeze({
      chainId: result.source.chainId,
      blockNumber: result.source.number,
      blockHash: assertHash(result.source.hash, "familyTransport.source.hash"),
      stateRoot: assertHash(result.source.stateRoot, "familyTransport.source.stateRoot"),
      executorAuthorityRoot: result.authorityRoot,
      workerEpoch: result.workerEpoch,
      executorSessionHash: result.executorSession,
    });
    return raw.kind === "transportFailure"
      ? Object.freeze({ ...raw, requestFingerprint: program.frozenProgram.requestFingerprint, source })
      : Object.freeze({ ...raw, requestFingerprint: program.frozenProgram.requestFingerprint, source });
  }));
}

/**
 * Derive all five lifecycle executors from one owner-issued execution port.
 * No Family or deployment code can replace one stage without replacing the
 * single release-owned port, and every transport fact is stamped here.
 */
export function createFamilyRuntimeStageExecutors<Fact>(input: {
  readonly execution: FamilyFrozenProgramExecutionPort<Fact>;
}): readonly { readonly stage: FamilyRuntimeStageV1; readonly executor: RuntimeStageExecutorV1 }[] {
  assertIssuedFamilyFrozenProgramExecutionPort(input.execution);
  const execute = async ({
    program,
    rawEvidence,
    attemptId,
    signal,
  }: Parameters<RuntimeStageExecutorV1["execute"]>[0]) => {
    const result = await input.execution.executeFrozenProgram({ intent: stageIntent(program), rawEvidence, attemptId, signal });
    return transportFacts(program, result as FamilyFrozenProgramExecutionResult<unknown>);
  };
  return Object.freeze(FAMILY_RUNTIME_STAGES.map(stage => Object.freeze({
    stage,
    executor: Object.freeze({ execute }),
  })));
}
