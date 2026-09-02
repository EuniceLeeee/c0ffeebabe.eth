import {
  assertHash,
  assertNonEmptyString,
  decodeCanonicalJson,
  decodeExactObject,
  deepFreeze,
  encodeCanonicalJson,
  hashDomain,
  type CanonicalJson,
  type Hash,
} from "../../canonical-codec/src/index.ts";
import {
  interpretCapabilityProgram,
  type FrameworkFactSetCapabilityV1,
  type ProgramInterpretationDraftV1,
  type ProgramInterpretationV1,
  type RetryableTransportCodeV1,
  type TransportFactSetCapabilityV1,
  type TransportFactV1,
} from "../../capability-interpreters/src/index.ts";
import {
  decodeFrozenProgramEnvelope,
  type FrozenProgramEnvelopeV1,
  type ProgramPayloadCodecV1,
  type ProgramSourceAnchorV1,
} from "../../request-program/src/index.ts";
import {
  asFamilyId,
  asFamilyInstanceKey,
  assertStageCapabilityRef,
  type FamilyCandidateKey,
  type FamilyId,
  type FamilyInstanceKey,
  type StageCapabilityRefV1,
} from "../runtime-refs/index.ts";
import type {
  CapabilityId,
  CapabilityVersion,
  SchemaRef,
} from "../../capability-contracts/src/index.ts";
import type {
  CandidateNominationV1,
  CanonicalCutoffV1,
  FamilySourcePlanDefinitionV1,
  RawEvidenceLocatorContentV1,
  SourcePlanEvidenceReceiptV1,
  SourcePlanExecutionV1,
  SourcePlanRefV1,
} from "../../discovery/src/index.ts";
import {
  decodeCanonicalCutoff,
  decodeRawEvidenceLocatorContent,
  decodeSourcePlanRef,
  validateRawEvidenceLocatorContents,
} from "../../discovery/src/index.ts";
import type { RecentObservationReceiptV1 } from "../../observation/src/index.ts";
import {
  decodeRuntimeAuthorityProjectionV1,
  type RuntimeAuthorityProjectionV1,
} from "../../runtime-authority/src/index.ts";

export const FAMILY_RUNTIME_STAGES = Object.freeze([
  "nomination",
  "identity",
  "materialization",
  "projection",
  "rehydration",
] as const);

export type FamilyRuntimeStageV1 = (typeof FAMILY_RUNTIME_STAGES)[number];

/** The production cold-start observation horizon used by every Family source
 * that derives candidates from recent chain activity. This range supplies
 * positive observations only; it never proves older instances absent. */
export const FAMILY_ROLLING_OBSERVATION_BLOCKS_V1 = 14_400n;

export function familyRollingObservationRangeV1(
  cutoffNumber: string,
  ownerRange?: Readonly<{ readonly from: string; readonly through: string }>,
): Readonly<{
  readonly from: string;
  readonly through: string;
}> {
  if (!/^(0|[1-9][0-9]*)$/.test(cutoffNumber)) {
    throw new TypeError("Family rolling observation cutoff must be a decimal block number");
  }
  const through = BigInt(cutoffNumber);
  const from = through + 1n > FAMILY_ROLLING_OBSERVATION_BLOCKS_V1
    ? through - FAMILY_ROLLING_OBSERVATION_BLOCKS_V1 + 1n
    : 0n;
  const derived = Object.freeze({ from: from.toString(10), through: through.toString(10) });
  if (ownerRange === undefined) return derived;
  if (
    typeof ownerRange.from !== "string"
    || typeof ownerRange.through !== "string"
    || !/^(0|[1-9][0-9]*)$/.test(ownerRange.from)
    || !/^(0|[1-9][0-9]*)$/.test(ownerRange.through)
    || ownerRange.from !== derived.from
    || ownerRange.through !== derived.through
  ) throw new TypeError("Family rolling observation range is not owner-issued for this cutoff");
  return Object.freeze({ from: ownerRange.from, through: ownerRange.through });
}

/** Source-less request owned by one Family lifecycle adapter.  The runtime
 * supplies only a neutral RPC transport; target/data selection remains in
 * the Family closure. */
export interface FamilyPhysicalRpcRequestV1 {
  readonly requestId: Hash;
  readonly method: "eth_call" | "eth_getCode";
  readonly params: CanonicalJson;
}

export type FamilyPhysicalTransportFailureCodeV1 =
  | "rpc"
  | "deadline"
  | "abort"
  | "queue-full"
  | "resource-limit"
  | "worker-crash"
  | "source-stale";

/** One physical RPC completion.  The request already owns correlation
 * identity; this result carries only the transport fact and never a Family
 * verdict. */
export type FamilyPhysicalRpcCompletionV1 =
  | { readonly kind: "returned"; readonly dataHex: string }
  | { readonly kind: "reverted"; readonly dataHex: string }
  | {
    readonly kind: "transportFailure";
    readonly failureCode: FamilyPhysicalTransportFailureCodeV1;
  };

export interface FamilyPhysicalRpcPortV1 {
  readonly request: (
    input: FamilyPhysicalRpcRequestV1,
    signal: AbortSignal,
  ) => Promise<FamilyPhysicalRpcCompletionV1>;
}

export type FamilyPhysicalTransportResultV1 =
  | { readonly kind: "returned"; readonly requestId: Hash; readonly dataHex: string }
  | { readonly kind: "reverted"; readonly requestId: Hash; readonly dataHex: string }
  | {
    readonly kind: "transportFailure";
    readonly requestId: Hash;
    readonly failureCode: FamilyPhysicalTransportFailureCodeV1;
  };

export interface FamilyPhysicalLifecycleExecutionV1 {
  readonly familyId: string;
  readonly familyDefinitionHash: Hash;
  readonly stage: FamilyRuntimeStageV1;
  readonly source: ProgramSourceAnchorV1;
  readonly programInput: CanonicalJson;
}

/** Exact owner-provided physical resources.  RPC supplies transport facts;
 * rawEvidence exposes only the already-qualified content-addressed join. */
export interface FamilyPhysicalLifecyclePortsV1 {
  readonly rpc: FamilyPhysicalRpcPortV1;
  readonly rawEvidence: FamilyRawEvidenceReadPortV1;
}

export interface FamilyPhysicalLifecycleAdapterV1 {
  readonly kind: "aloha.family-physical-lifecycle-adapter";
  readonly version: 1;
  readonly familyId: string;
  readonly familyDefinitionHash: Hash;
  readonly execute: (
    input: FamilyPhysicalLifecycleExecutionV1,
    ports: FamilyPhysicalLifecyclePortsV1,
    signal: AbortSignal,
  ) => Promise<readonly FamilyPhysicalTransportResultV1[]>;
}

export type FamilyPhysicalLifecycleAdapterFactoryV1 = () => FamilyPhysicalLifecycleAdapterV1;

export const FAMILY_PHYSICAL_LIFECYCLE_ADAPTER_ROLE_V1 = "physical-lifecycle/v1" as const;

export const FAMILY_STAGE_PROGRAM_SCHEMA = hashDomain("aloha/family-stage-program-schema/v1", {
  fields: [
    "kind",
    "version",
    "familyId",
    "familyDefinitionHash",
    "stage",
    "stageRef",
    "candidateKey",
    "instanceKey",
    "source",
    "evidenceRoot",
    "frozenProgram",
    "frozenProgramRef",
    "requestFingerprint",
  ],
});

export interface FamilyRuntimeAuthorityBindingV1 {
  readonly familyId: FamilyId;
  readonly familyDefinitionHash: Hash;
  readonly releaseAuthorityRoot: Hash;
  readonly programAuthorityHash: Hash;
  readonly executorAuthorityRoot: Hash;
  readonly workerEpoch: string;
  readonly executorSessionHash: Hash;
}

export interface FamilyStageIssueInputV1 {
  readonly candidateKey: FamilyCandidateKey;
  readonly instanceKey: FamilyInstanceKey | null;
  readonly evidenceRoot: Hash;
  readonly invocation: FamilyStageGenericInvocationV1;
}

/**
 * The only lifecycle input that crosses the central/runtime seam.  It is
 * intentionally protocol-neutral: candidate and prior-stage values are
 * canonical opaque data, while the Family definition owns their exact
 * payload projection.
 */
export interface FamilyStageGenericInvocationV1 {
  readonly stage: FamilyRuntimeStageV1;
  readonly candidate: CanonicalJson;
  readonly cutoff: ProgramSourceAnchorV1;
  readonly identityMemo: CanonicalJson | null;
  readonly materializationOutput: CanonicalJson | null;
  /** Exact prior verified publication, supplied only through the
   * checkpoint-owned memo-reuse capability path. */
  readonly reusePublication?: CanonicalJson | null;
}

export interface FamilyStageProgramV1 {
  readonly kind: "aloha.family-stage-program";
  readonly version: 1;
  readonly familyId: FamilyId;
  readonly familyDefinitionHash: Hash;
  readonly stage: FamilyRuntimeStageV1;
  readonly stageRef: StageCapabilityRefV1;
  readonly candidateKey: FamilyCandidateKey;
  readonly instanceKey: FamilyInstanceKey | null;
  readonly source: ProgramSourceAnchorV1;
  readonly evidenceRoot: Hash;
  readonly frozenProgram: FrozenProgramEnvelopeV1;
  /** Content-addressed ref for the exact envelope; the bytes remain owner-decoded. */
  readonly frozenProgramRef: FamilyFrozenProgramRefV1;
  /** Covers the stage ref, lifecycle identity, source, evidence, and payload fingerprint. */
  readonly requestFingerprint: Hash;
}

export interface FamilyFrozenProgramRefV1 {
  readonly requestFingerprint: Hash;
  readonly recordHash: Hash;
}

export interface FamilyStageExecuteInputV1 {
  readonly program: FamilyStageProgramV1;
  readonly rawEvidence: FamilyRawEvidenceReadPortV1;
  readonly attemptId?: string;
  readonly signal?: AbortSignal;
}

/**
 * The executor is supplied by generated runtime composition.  A Family never
 * receives this callback or the issuer below; it only receives the opaque
 * TransportFactSetCapability returned by the stage port.
 */
export interface RuntimeStageExecutorV1 {
  readonly execute: (input: {
    readonly program: FamilyStageProgramV1;
    readonly rawEvidence: FamilyRawEvidenceReadPortV1;
    readonly attemptId: string;
    readonly signal: AbortSignal;
  }) => Promise<readonly TransportFactV1[]>;
}

/**
 * Family-owned definition. It contains no generated owner/interpreter ref,
 * executor, issuer, or process authority. The runtime composition supplies
 * the exact StageCapabilityRefV1 separately.
 */
export interface FamilyStageDefinitionV1 {
  readonly stage: FamilyRuntimeStageV1;
  readonly capabilityId: CapabilityId;
  readonly version: CapabilityVersion;
  readonly schemaHash: SchemaRef;
  readonly payloadCodec: ProgramPayloadCodecV1;
  readonly dependencyIds: readonly CapabilityId[];
  readonly outputSchemaRef: Hash;
  readonly implementationClosureHash: Hash;
  readonly outputCodecHash: Hash;
  readonly outputCodec: { readonly decodeExact: (value: unknown) => CanonicalJson };
  /** Converts only the generic lifecycle envelope into this Family's payload. */
  readonly prepareIssueValue: (input: FamilyStageGenericInvocationV1) => unknown;
  readonly interpret: (input: {
    readonly program: FrozenProgramEnvelopeV1;
    readonly payload: CanonicalJson;
    readonly facts: readonly TransportFactV1[];
    readonly dependencyRefs: readonly StageCapabilityRefV1[];
    readonly factSet: FrameworkFactSetCapabilityV1;
  }) => ProgramInterpretationDraftV1;
}

/** Process-local generated binding for one exact definition/ref pair. */
export interface RuntimeStageDefinitionBindingV1 {
  readonly opaque: object;
}

/** Generated runtime composition binds a definition to the owner-held executor. */
export interface RuntimeStageBindingV1 {
  readonly stageRef: StageCapabilityRefV1;
  readonly definition: FamilyStageDefinitionV1;
  readonly definitionBinding: RuntimeStageDefinitionBindingV1;
  readonly executor: RuntimeStageExecutorV1;
}

export interface FamilyStageOutcomeBindingV1 {
  readonly familyId: FamilyId;
  readonly familyDefinitionHash: Hash;
  readonly stage: FamilyRuntimeStageV1;
  readonly stageRef: StageCapabilityRefV1;
  readonly candidateKey: FamilyCandidateKey;
  readonly instanceKey: FamilyInstanceKey | null;
  readonly source: ProgramSourceAnchorV1;
  readonly requestFingerprint: Hash;
  readonly evidenceRoot: Hash;
}

export type FamilyLifecycleOutcomeV1 =
  | (FamilyStageOutcomeBindingV1 & {
    readonly kind: "verified";
    readonly output: CanonicalJson;
    readonly outputSchemaRef: Hash;
  })
  | (FamilyStageOutcomeBindingV1 & {
    readonly kind: "chainProvenRejected";
    readonly factSet: FrameworkFactSetCapabilityV1;
    readonly decisionCode: string;
  })
  | (FamilyStageOutcomeBindingV1 & {
    readonly kind: "retryable";
    readonly failureCode: RetryableTransportCodeV1;
  })
  | (FamilyStageOutcomeBindingV1 & {
    readonly kind: "invalidProgram";
    readonly code: string;
  });

export interface FamilyStageRuntimePortV1 {
  /** The only Family identity exposed to this port is one generated stage ref. */
  readonly stageRef: StageCapabilityRefV1;
  issue(input: FamilyStageIssueInputV1): FamilyStageProgramV1;
  execute(input: FamilyStageExecuteInputV1): Promise<TransportFactSetCapabilityV1>;
  interpret(input: {
    readonly program: FamilyStageProgramV1;
    readonly factSet: TransportFactSetCapabilityV1;
  }): FamilyLifecycleOutcomeV1;
}

export interface FamilyRuntimePortV1 {
  /** Generated composition resolves a stage ref to its narrow stage port. */
  getStage(stageRef: StageCapabilityRefV1): FamilyStageRuntimePortV1;
}

export interface FamilyRuntimeOwnerV1 {
  readonly port: FamilyRuntimePortV1;
  /** Owner-only route capability issuer; structurally compatible with Graph. */
  readonly routeHandles: FamilyRouteHandleIssuerPortV1;
  revoke(): void;
  /** Rotates only the process-local route lease; a new executor session needs a new runtime owner. */
  rotate(input: { readonly executorSessionHash: Hash }): void;
}

export interface FamilyRoutePublicationV1 {
  readonly familyId: string;
  readonly familyDefinitionHash: Hash;
  readonly instanceKey: string;
  readonly identityMemo: CanonicalJson;
  readonly identityMemoHash: Hash;
  readonly instancePublicationHash: Hash;
  readonly staticProjectionMemoHash: Hash;
  readonly requestedArtifactDependencyRoot: Hash;
}

export interface FamilyRouteProjectionV1 {
  readonly staticProjectionHash: Hash;
  readonly projectionHash: Hash;
}

export interface FamilyRouteRehydrationRefV1 {
  readonly familyDefinitionHash: Hash;
  readonly instanceKey: string;
  readonly instancePublicationHash: Hash;
  readonly staticProjectionMemoHash: Hash;
  readonly requestedArtifactDependencyRoot: Hash;
}

/** Structurally compatible with Graph's IssuedRouteHandle, but not serializable. */
export interface FamilyIssuedRouteHandleV1 {
  readonly opaque: object;
}

export interface FamilyRouteHandleBindingV1 {
  readonly familyId: string;
  readonly familyDefinitionHash: Hash;
  readonly instanceKey: string;
  readonly identityMemo: CanonicalJson;
  readonly identityMemoHash: Hash;
  readonly instancePublicationHash: Hash;
  readonly staticProjectionMemoHash: Hash;
  readonly requestedArtifactDependencyRoot: Hash;
  readonly staticProjectionHash: Hash;
  readonly projectionHash: Hash;
  readonly authoritySessionHash: Hash;
}

export interface FamilyRouteHandleIssuerPortV1 {
  issueRouteHandle(
    publication: FamilyRoutePublicationV1,
    projection: FamilyRouteProjectionV1,
    ref: FamilyRouteRehydrationRefV1,
  ): FamilyIssuedRouteHandleV1;
  resolveRouteHandle(handle: FamilyIssuedRouteHandleV1): FamilyRouteHandleBindingV1;
  assertRouteHandleActive(handle: FamilyIssuedRouteHandleV1): void;
  rotate(next: { readonly executorSessionHash: Hash }): void;
  revoke(): void;
}

export function familyStageProgramFingerprint(input: Omit<FamilyStageProgramV1, "requestFingerprint">): Hash {
  return hashDomain("aloha/family-stage-program/v1", {
    familyId: input.familyId,
    familyDefinitionHash: input.familyDefinitionHash,
    stage: input.stage,
    stageRef: input.stageRef,
    candidateKey: input.candidateKey,
    instanceKey: input.instanceKey,
    source: input.source,
    evidenceRoot: input.evidenceRoot,
    frozenProgramFingerprint: input.frozenProgram.requestFingerprint,
    frozenProgramRecordHash: input.frozenProgramRef.recordHash,
  });
}

function source(value: unknown, path: string): ProgramSourceAnchorV1 {
  return deepFreeze(decodeExactObject<ProgramSourceAnchorV1>(value, {
    chainId: (item, itemPath) => assertNonEmptyString(item, itemPath),
    number: (item, itemPath) => assertNonEmptyString(item, itemPath),
    hash: (item, itemPath) => assertHash(item, itemPath),
    stateRoot: (item, itemPath) => assertHash(item, itemPath),
  }, path));
}

function stage(value: unknown, path: string): FamilyRuntimeStageV1 {
  if (typeof value !== "string" || !(FAMILY_RUNTIME_STAGES as readonly string[]).includes(value)) {
    throw new TypeError(`unknown Family runtime stage at ${path}`);
  }
  return value as FamilyRuntimeStageV1;
}

function stageRef(value: unknown, path: string): StageCapabilityRefV1 {
  assertStageCapabilityRef(value, path);
  return deepFreeze(decodeCanonicalJson(encodeCanonicalJson(value))) as unknown as StageCapabilityRefV1;
}

function candidate(value: unknown, path: string): FamilyCandidateKey {
  return assertHash(value, path) as FamilyCandidateKey;
}

function instance(value: unknown, path: string): FamilyInstanceKey | null {
  if (value === null) return null;
  return asFamilyInstanceKey(assertNonEmptyString(value, path), path);
}

function familyProgram(value: unknown, path = "familyStageProgram"): FamilyStageProgramV1 {
  const decoded = decodeExactObject(value, {
    kind: (item, itemPath) => { if (item !== "aloha.family-stage-program") throw new TypeError(`invalid Family stage program kind at ${itemPath}`); return "aloha.family-stage-program" as const; },
    version: (item, itemPath) => { if (item !== 1) throw new TypeError(`unsupported Family stage program version at ${itemPath}`); return 1 as const; },
    familyId: (item, itemPath) => asFamilyId(assertNonEmptyString(item, itemPath), itemPath),
    familyDefinitionHash: (item, itemPath) => assertHash(item, itemPath),
    stage: (item, itemPath) => stage(item, itemPath),
    stageRef: (item, itemPath) => stageRef(item, itemPath),
    candidateKey: (item, itemPath) => candidate(item, itemPath),
    instanceKey: (item, itemPath) => instance(item, itemPath),
    source: (item, itemPath) => source(item, itemPath),
    evidenceRoot: (item, itemPath) => assertHash(item, itemPath),
    frozenProgram: (item, itemPath) => decodeFrozenProgramEnvelope(item, itemPath),
    frozenProgramRef: (item, itemPath) => decodeExactObject(item, {
      requestFingerprint: (field, fieldPath) => assertHash(field, fieldPath),
      recordHash: (field, fieldPath) => assertHash(field, fieldPath),
    }, itemPath),
    requestFingerprint: (item, itemPath) => assertHash(item, itemPath),
  }, path);
  if (decoded.stageRef.familyId !== decoded.familyId || decoded.stageRef.familyDefinitionHash !== decoded.familyDefinitionHash || decoded.stageRef.stage !== decoded.stage) {
    throw new TypeError("Family stage program ref mismatch");
  }
  if (encodeCanonicalJson(decoded.source) !== encodeCanonicalJson(decoded.frozenProgram.source)) {
    throw new TypeError("Family stage program source mismatch");
  }
  if (decoded.frozenProgramRef.requestFingerprint !== decoded.frozenProgram.requestFingerprint) {
    throw new TypeError("Family stage program ref fingerprint mismatch");
  }
  if (decoded.frozenProgramRef.recordHash !== hashDomain("aloha/frozen-program-record/v1", encodeCanonicalJson(decoded.frozenProgram))) {
    throw new TypeError("Family stage program ref record mismatch");
  }
  if (familyStageProgramFingerprint(decoded) !== decoded.requestFingerprint) {
    throw new TypeError("Family stage program fingerprint mismatch");
  }
  return deepFreeze(decoded);
}

export function decodeFamilyStageProgram(value: unknown, path = "familyStageProgram"): FamilyStageProgramV1 {
  return familyProgram(value, path);
}

export function assertFamilyStageProgram(value: unknown, path = "familyStageProgram"): asserts value is FamilyStageProgramV1 {
  familyProgram(value, path);
}

export function familyStageOutcomeBinding(program: FamilyStageProgramV1): FamilyStageOutcomeBindingV1 {
  const decoded = familyProgram(program);
  return deepFreeze({
    familyId: decoded.familyId,
    familyDefinitionHash: decoded.familyDefinitionHash,
    stage: decoded.stage,
    stageRef: decoded.stageRef,
    candidateKey: decoded.candidateKey,
    instanceKey: decoded.instanceKey,
    source: decoded.source,
    requestFingerprint: decoded.requestFingerprint,
    evidenceRoot: decoded.evidenceRoot,
  });
}

export function mapFamilyProgramInterpretation(
  program: FamilyStageProgramV1,
  interpretation: ProgramInterpretationV1,
): FamilyLifecycleOutcomeV1 {
  const binding = familyStageOutcomeBinding(program);
  if (interpretation.kind === "verified") return deepFreeze({ ...binding, kind: "verified", output: interpretation.output, outputSchemaRef: interpretation.outputSchemaRef });
  if (interpretation.kind === "chainProvenRejected") return deepFreeze({ ...binding, kind: "chainProvenRejected", factSet: interpretation.factSet, decisionCode: interpretation.decisionCode });
  if (interpretation.kind === "retryable") return deepFreeze({ ...binding, kind: "retryable", failureCode: interpretation.failureCode });
  return deepFreeze({ ...binding, kind: "invalidProgram", code: interpretation.code });
}

export function isFamilyRuntimeStage(value: string): value is FamilyRuntimeStageV1 {
  return (FAMILY_RUNTIME_STAGES as readonly string[]).includes(value);
}

export interface FamilySourcePlanPhysicalRequestV1 {
  readonly familyDefinitionHash: Hash;
  readonly plan: SourcePlanRefV1;
  readonly cutoff: CanonicalCutoffV1;
  readonly requestSchemaHash: Hash;
  readonly request: FamilySourcePlanRpcRequestV1;
}

/**
 * Exact transport-neutral JSON-RPC envelope emitted by generated Family
 * source semantics.  The runtime owner supplies provider/source/authority
 * fields and records the returned bytes; a Family can never provide those
 * fields itself.
 */
export interface FamilySourcePlanRpcRequestV1 {
  readonly [key: string]: CanonicalJson;
  readonly kind: "family-source-plan-rpc";
  readonly version: 1;
  readonly method: string;
  readonly params: CanonicalJson;
  readonly target: CanonicalJson;
  readonly manager: CanonicalJson;
  readonly topic: CanonicalJson;
  readonly lookback: CanonicalJson;
  readonly chunk: CanonicalJson;
}

/** Content decoded from an owner-recorded raw source-plan locator. */
export interface FamilySourcePlanPhysicalObservationV1 {
  readonly kind: "family-source-plan-physical-observation";
  readonly version: 1;
  readonly requestId: Hash;
  readonly runtimeAuthority: RuntimeAuthorityProjectionV1;
  readonly sourceAuthorityRoot: Hash;
  readonly sourceAnchorRoot: Hash;
  readonly provider: string;
  readonly backendEpoch: string;
  readonly familyDefinitionHash: Hash;
  readonly plan: SourcePlanRefV1;
  readonly cutoff: CanonicalCutoffV1;
  readonly requestSchemaHash: Hash;
  readonly request: FamilySourcePlanRpcRequestV1;
  readonly response: CanonicalJson;
}

/**
 * A successful physical read returns its canonical response and an immutable
 * copy of the owner-recorded raw locator. The runtime owner retains the
 * authoritative copy and exact-compares it after Family interpretation.
 */
export interface FamilySourcePlanPhysicalResultV1 {
  readonly response: CanonicalJson;
  readonly rawLocatorHash: Hash;
  readonly evidenceRef: Hash;
  readonly rawEvidenceLocator: RawEvidenceLocatorContentV1;
}

function canonicalJsonField(value: unknown): CanonicalJson {
  return deepFreeze(decodeCanonicalJson(encodeCanonicalJson(value)));
}

export function decodeFamilySourcePlanRpcRequest(
  value: unknown,
  path = "familySourcePlanRpcRequest",
): FamilySourcePlanRpcRequestV1 {
  return deepFreeze(decodeExactObject(value, {
    kind: (field, itemPath) => field === "family-source-plan-rpc"
      ? field
      : (() => { throw new TypeError(`${itemPath} is invalid`); })(),
    version: (field, itemPath) => field === 1
      ? field
      : (() => { throw new TypeError(`${itemPath} is invalid`); })(),
    method: (field, itemPath) => assertNonEmptyString(field, itemPath),
    params: field => canonicalJsonField(field),
    target: field => canonicalJsonField(field),
    manager: field => canonicalJsonField(field),
    topic: field => canonicalJsonField(field),
    lookback: field => canonicalJsonField(field),
    chunk: field => canonicalJsonField(field),
  }, path));
}

export function decodeFamilySourcePlanPhysicalRequest(
  value: unknown,
  path = "familySourcePlanPhysicalRequest",
): FamilySourcePlanPhysicalRequestV1 {
  return deepFreeze(decodeExactObject(value, {
    familyDefinitionHash: (field, itemPath) => assertHash(field, itemPath),
    plan: (field, itemPath) => decodeSourcePlanRef(field, itemPath),
    cutoff: (field, itemPath) => decodeCanonicalCutoff(field, itemPath),
    requestSchemaHash: (field, itemPath) => assertHash(field, itemPath),
    request: (field, itemPath) => decodeFamilySourcePlanRpcRequest(field, itemPath),
  }, path));
}

export function decodeFamilySourcePlanPhysicalObservation(
  value: unknown,
  path = "familySourcePlanPhysicalObservation",
): FamilySourcePlanPhysicalObservationV1 {
  const input = typeof value === "string" || value instanceof Uint8Array
    ? decodeCanonicalJson(value)
    : value;
  return deepFreeze(decodeExactObject(input, {
    kind: (field, itemPath) => field === "family-source-plan-physical-observation"
      ? field
      : (() => { throw new TypeError(`${itemPath} is invalid`); })(),
    version: (field, itemPath) => field === 1
      ? field
      : (() => { throw new TypeError(`${itemPath} is invalid`); })(),
    requestId: (field, itemPath) => assertHash(field, itemPath),
    runtimeAuthority: field => decodeRuntimeAuthorityProjectionV1(field),
    sourceAuthorityRoot: (field, itemPath) => assertHash(field, itemPath),
    sourceAnchorRoot: (field, itemPath) => assertHash(field, itemPath),
    provider: (field, itemPath) => assertNonEmptyString(field, itemPath),
    backendEpoch: (field, itemPath) => assertNonEmptyString(field, itemPath),
    familyDefinitionHash: (field, itemPath) => assertHash(field, itemPath),
    plan: (field, itemPath) => decodeSourcePlanRef(field, itemPath),
    cutoff: (field, itemPath) => decodeCanonicalCutoff(field, itemPath),
    requestSchemaHash: (field, itemPath) => assertHash(field, itemPath),
    request: (field, itemPath) => decodeFamilySourcePlanRpcRequest(field, itemPath),
    response: field => canonicalJsonField(field),
  }, path));
}

export function decodeFamilySourcePlanPhysicalResult(
  value: unknown,
  path = "familySourcePlanPhysicalResult",
): FamilySourcePlanPhysicalResultV1 {
  const decoded = decodeExactObject(value, {
    response: field => canonicalJsonField(field),
    rawLocatorHash: (field, itemPath) => assertHash(field, itemPath),
    evidenceRef: (field, itemPath) => assertHash(field, itemPath),
    rawEvidenceLocator: (field, itemPath) => decodeRawEvidenceLocatorContent(field, itemPath),
  }, path);
  if (decoded.rawEvidenceLocator.rawLocatorHash !== decoded.rawLocatorHash) {
    throw new TypeError(`${path}.rawEvidenceLocator hash mismatch`);
  }
  return Object.freeze(decoded);
}

/** Physical discovery facts are untrusted until the generated Family runtime interprets them. */
export interface FamilySourcePlanPhysicalPortV1 {
  request(
    input: FamilySourcePlanPhysicalRequestV1,
    signal: AbortSignal,
  ): Promise<FamilySourcePlanPhysicalResultV1>;
}

export interface FamilySourcePlanExecutionInputV1 {
  readonly plan: SourcePlanRefV1;
  readonly cutoff: CanonicalCutoffV1;
  readonly previousAppliedThrough: string | null;
  /** Production owner supplies this once for rolling sources. The optional
   * shape keeps direct Family contract tests source-compatible; production
   * runtime owners must never rely on the local cutoff fallback. */
  readonly rollingObservationRange?: Readonly<{
    readonly from: string;
    readonly through: string;
  }>;
  /** Release-owner-issued durable predecessor; absent is equivalent to null only for direct Family unit tests. */
  readonly predecessor?: FamilySourcePlanExecutionPredecessorV1 | null;
}

export interface FamilySourcePlanExecutionPredecessorV1 {
  readonly persistedExecutionRoot: Hash;
  readonly execution: SourcePlanExecutionV1;
  readonly sourceEvidence: SourcePlanEvidenceReceiptV1;
  readonly rawEvidence: FamilyRawEvidenceReadPortV1;
}

export interface FamilySourcePlanExecutionResultV1 {
  readonly execution: SourcePlanExecutionV1;
  readonly sourceEvidence: SourcePlanEvidenceReceiptV1;
  readonly rawEvidenceLocators: readonly RawEvidenceLocatorContentV1[];
}

/**
 * Family-owned byte access. Central code may validate the hash/join and issue
 * this narrow port, but it never decodes or interprets the bytes. Reads return
 * a copy so a Family cannot mutate the durable evidence backing another read.
 */
export interface FamilyRawEvidenceReadPortV1 {
  read(rawLocatorHash: Hash): Uint8Array;
}

export function issueFamilyRawEvidenceReadPort(
  input: {
    readonly values: readonly RawEvidenceLocatorContentV1[];
    readonly recent: RecentObservationReceiptV1;
    readonly sourceEvidence: readonly SourcePlanEvidenceReceiptV1[];
  },
): FamilyRawEvidenceReadPortV1 {
  const expectedHashes = familyRawEvidenceHashSet({ recent: input.recent, sourceEvidence: input.sourceEvidence });
  const decoded = validateRawEvidenceLocatorContents(input.values, expectedHashes, "familyRawEvidence");
  const entries = new Map<Hash, Uint8Array>(decoded.map(value => [value.rawLocatorHash, new Uint8Array(value.bytes)]));
  return Object.freeze({
    read(rawLocatorHash: Hash): Uint8Array {
      assertHash(rawLocatorHash, "rawLocatorHash");
      const bytes = entries.get(rawLocatorHash);
      if (bytes === undefined) throw new TypeError(`raw evidence locator is not in the exact family join: ${rawLocatorHash}`);
      return new Uint8Array(bytes);
    },
  });
}

/** The exact cross-stage locator join a Family runtime may request. */
export function familyRawEvidenceHashSet(input: {
  readonly recent: RecentObservationReceiptV1;
  readonly sourceEvidence: readonly SourcePlanEvidenceReceiptV1[];
}): readonly Hash[] {
  const hashes = [
    ...input.recent.rawLocatorHashes,
    ...input.sourceEvidence.flatMap(value => value.rawLocatorHashes),
  ];
  if (new Set(hashes).size !== hashes.length) {
    // Shared raw bytes are allowed across evidence refs, but the join itself
    // must expose each locator once.
    return Object.freeze([...new Set(hashes)].sort());
  }
  return Object.freeze([...hashes].sort());
}

export interface FamilySourcePlanNominationInputV1 {
  readonly execution: SourcePlanExecutionV1;
  readonly sourceEvidence: SourcePlanEvidenceReceiptV1;
  readonly recent: RecentObservationReceiptV1;
  readonly rawEvidence: FamilyRawEvidenceReadPortV1;
}

/**
 * The exact Family-owned semantic program imported by generated composition.
 * It emits claims only; the runtime discovery owner derives denominators,
 * qualification bindings and the final receipt/closure mechanically.
 */
export interface FamilySourcePlanNominationProgramV1 {
  readonly kind: "aloha.family-source-plan-nomination-program";
  readonly version: 1;
  readonly schemaHash: Hash;
  evaluate(
    input: FamilySourcePlanNominationInputV1,
    signal: AbortSignal,
  ): Promise<readonly CandidateNominationV1[]>;
}

export function assertFamilySourcePlanNominationProgram(
  value: unknown,
  path = "familySourcePlanNominationProgram",
): asserts value is FamilySourcePlanNominationProgramV1 {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${path} must be an object`);
  }
  const record = value as Record<string, unknown>;
  const expected = ["kind", "version", "schemaHash", "evaluate"].sort();
  const actual = Reflect.ownKeys(record).map(key => {
    if (typeof key !== "string") throw new TypeError(`${path} has a symbol key`);
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (!descriptor || !("value" in descriptor)) throw new TypeError(`${path} has an accessor`);
    return key;
  }).sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new TypeError(`${path} has non-exact keys`);
  }
  if (record.kind !== "aloha.family-source-plan-nomination-program" || record.version !== 1) {
    throw new TypeError(`${path} identity is invalid`);
  }
  assertHash(record.schemaHash, `${path}.schemaHash`);
  if (typeof record.evaluate !== "function") throw new TypeError(`${path}.evaluate is required`);
}

/**
 * Generated static import for one Family source plan. The runtime owner picks
 * the exact plan set; the Family owns physical request projection and
 * nomination meaning.
 */
export interface FamilySourcePlanRuntimeV1 extends FamilySourcePlanDefinitionV1 {
  execute(
    input: FamilySourcePlanExecutionInputV1,
    physical: FamilySourcePlanPhysicalPortV1,
    signal: AbortSignal,
  ): Promise<FamilySourcePlanExecutionResultV1>;
}

export function assertFamilySourcePlanRuntime(
  value: unknown,
  path = "familySourcePlanRuntime",
): asserts value is FamilySourcePlanRuntimeV1 {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${path} must be an object`);
  }
  const record = value as Record<string, unknown>;
  const expected = ["sourcePlanId", "completeness", "historyStartBlock", "schemaHash", "execute"].sort();
  const actual = Reflect.ownKeys(record).map(key => {
    if (typeof key !== "string") throw new TypeError(`${path} has a symbol key`);
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (!descriptor || !("value" in descriptor)) throw new TypeError(`${path} has an accessor`);
    return key;
  }).sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new TypeError(`${path} has non-exact keys`);
  }
  assertNonEmptyString(record.sourcePlanId, `${path}.sourcePlanId`);
  if (!["complete-snapshot", "contiguous-history", "rolling-observation", "point-lookup", "nomination-only"].includes(record.completeness as string)) {
    throw new TypeError(`${path}.completeness is invalid`);
  }
  if (record.historyStartBlock !== null && (typeof record.historyStartBlock !== "string" || !/^(0|[1-9][0-9]*)$/.test(record.historyStartBlock))) {
    throw new TypeError(`${path}.historyStartBlock is invalid`);
  }
  if ((record.completeness === "contiguous-history") !== (record.historyStartBlock !== null)) {
    throw new TypeError(`${path}.historyStartBlock must exist only for contiguous-history`);
  }
  assertHash(record.schemaHash, `${path}.schemaHash`);
  if (typeof record.execute !== "function") throw new TypeError(`${path}.execute is required`);
}
