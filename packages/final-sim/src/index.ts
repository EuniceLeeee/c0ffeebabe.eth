import {
  assertExactKeys,
  assertHash,
  assertNonEmptyString,
  decodeCanonicalJson,
  deepFreeze,
  encodeCanonicalJson,
  hashDomain,
  type CanonicalJson,
  type Hash,
} from "../../canonical-codec/src/index.ts";
import {
  RevmSimulationClient,
  RevmSimulationError,
  hashFrozenProgram,
  type RevmWorkerAuthorityBindingV1,
  type FrozenProgramWire,
  type RevmCallerBinding,
  type RevmSimulationReceipt,
} from "../../../runtime/revm-workers/src/index.ts";
import {
  normalizeEffectTransportDeclaration,
  sameEffectTransportDeclaration,
  type EffectTransportDeclarationV1,
} from "../../execution-program/src/index.ts";
import type { RevmWorkerAuthorityIssuer } from "../../../runtime/revm-workers/src/lifecycle.ts";
import { assertIssuedRevmWorkerAuthorityIssuer } from "../../../runtime/revm-workers/src/internal/authority.ts";
import { decodeExecutorExecuteCalldata } from "../../execution-program/src/index.ts";
import {
  readQualifiedFinalSimulationExecutorStateSnapshot,
  type QualifiedFinalSimulationExecutorStateSnapshotCapabilityV1,
} from "./internal/state-snapshot.ts";
import {
  SchedulerError,
  WorkScheduler,
  type CallerAuthority,
  type SchedulerPermit,
  type SchedulerWorkCompletionHandleV1,
} from "../../scheduler/src/index.ts";
export {
  assertIssuedQualifiedFinalSimulationPortFactory,
} from "./internal/final-simulation-owner.ts";
export type {
  QualifiedFinalSimulationPortFactoryV1,
} from "./internal/final-simulation-owner.ts";

/** Structural mirrors of the search-pipeline final-sim contract.  Keeping
 * these as type-only local declarations avoids making this low-level bridge
 * import graph/canonical-source implementation code. */
export interface SourceViewV1 {
  readonly chainId: string;
  readonly number: string;
  readonly hash: string;
  readonly stateRoot: string;
}

export interface CurrentSourceSessionV1 {
  readonly source: SourceViewV1;
  readonly assertCurrent: () => Promise<void> | void;
}

export interface ExecutionProgramArtifactV1 {
  readonly kind: "execution-program";
  readonly generationId: string;
  readonly source: SourceViewV1;
  readonly routeHash: Hash;
  readonly programBytes: string;
  readonly payloadHash: Hash;
  readonly issuerRef: Hash;
  readonly obligationRoot: Hash;
  readonly effectTransport?: EffectTransportDeclarationV1;
  readonly programHash: Hash;
}

interface GraphLeaseBindingLikeV1 {
  readonly generationId: string;
  readonly cutoff: SourceViewV1;
}

export interface FinalSimulationReceiptV1<Simulation> {
  readonly kind: "final-simulation-passed";
  readonly generationId: string;
  readonly source: SourceViewV1;
  readonly programHash: Hash;
  readonly simulation: Simulation;
  readonly effectsHash: Hash;
  readonly effectTransport?: EffectTransportDeclarationV1;
  readonly receiptHash: Hash;
}

export type FinalSimulationOutcomeV1<Simulation> =
  | {
    readonly kind: "passed";
    readonly receipt: FinalSimulationReceiptV1<Simulation>;
    readonly schedulerJoinSeed?: QualifiedFinalSimulationSchedulerJoinSeedCapabilityV1;
    readonly sixStepEvidence?: QualifiedFinalSimulationSixStepEvidenceCapabilityV1;
  }
  | { readonly kind: "retryable"; readonly stage: "final-sim"; readonly code: string }
  | { readonly kind: "invalidProgram"; readonly stage: "final-sim"; readonly code: string }
  | {
    readonly kind: "chainProvenRejected";
    readonly stage: "final-sim";
    readonly code: string;
    readonly evidenceHash: Hash;
    readonly capability: QualifiedFinalSimulationRejectionCapabilityV1;
  };

export interface QualifiedFinalSimulationRejectionCapabilityV1 {
  readonly kind: "opaque-qualified-stage-rejection-capability";
}

export interface QualifiedFinalSimulationRejectionReceiptV1 {
  readonly kind: "aloha.qualified-stage-rejection-v1";
  readonly stage: "final-sim";
  readonly routeHash: Hash;
  readonly source: SourceViewV1;
  readonly correlationId: Hash;
  readonly inputArtifactHash: Hash;
  readonly programHash: Hash;
  readonly code: string;
  readonly evidenceHash: Hash;
  readonly ownerReceiptHash: Hash;
  readonly receiptHash: Hash;
}

/** Process-local proof that the passed simulation ran inside this exact scheduler permit. */
export type QualifiedFinalSimulationSchedulerJoinSeedCapabilityV1 = object;

export interface QualifiedFinalSimulationSchedulerJoinSeedV1 {
  readonly correlationId: Hash;
  readonly generationId: string;
  readonly source: SourceViewV1;
  readonly programHash: Hash;
  readonly finalSimulationReceiptHash: Hash;
  /** Opaque identity only. It is never canonicalized or included in a receipt hash. */
  readonly schedulerCompletion: SchedulerWorkCompletionHandleV1;
}

export interface QualifiedFinalSimulationSchedulerJoinAuthorityV1 {
  readonly read: (
    capability: QualifiedFinalSimulationSchedulerJoinSeedCapabilityV1,
  ) => QualifiedFinalSimulationSchedulerJoinSeedV1;
}

export type QualifiedFinalSimulationSixStepEvidenceCapabilityV1 = object;

export interface QualifiedFinalSimulationSixStepEvidenceV1 {
  readonly schemaVersion: 1;
  readonly kind: "aloha.final-simulation-six-step-evidence-v1";
  readonly correlationId: Hash;
  readonly generationId: string;
  readonly source: SourceViewV1;
  readonly programHash: Hash;
  readonly finalSimulationReceiptHash: Hash;
  readonly facts: CanonicalJson;
  readonly evidenceRoot: Hash;
}

export interface QualifiedFinalSimulationSixStepEvidenceAuthorityV1 {
  readonly read: (
    capability: QualifiedFinalSimulationSixStepEvidenceCapabilityV1,
  ) => QualifiedFinalSimulationSixStepEvidenceV1;
}

export interface FinalSimulationPortV1<Simulation> {
  readonly simulate: (input: {
    readonly binding: GraphLeaseBindingLikeV1;
    readonly program: ExecutionProgramArtifactV1;
    readonly source: CurrentSourceSessionV1;
    readonly callerId: string;
    readonly correlationId: Hash;
    readonly deadlineAtMs: number;
    readonly signal?: AbortSignal;
  }) => Promise<FinalSimulationOutcomeV1<Simulation>> | FinalSimulationOutcomeV1<Simulation>;
  readonly rejectionAuthority: {
    readonly read: (capability: QualifiedFinalSimulationRejectionCapabilityV1) => QualifiedFinalSimulationRejectionReceiptV1;
  };
  readonly schedulerJoinAuthority?: QualifiedFinalSimulationSchedulerJoinAuthorityV1;
  readonly sixStepEvidenceAuthority?: QualifiedFinalSimulationSixStepEvidenceAuthorityV1;
}

/**
 * The projection is deliberately limited to fields that the generic bridge
 * cannot derive from an execution artifact.  It is a request projection, not
 * a simulation or success port: EVM execution still happens only in the
 * concrete, qualified RevmSimulationClient.
 */
export interface QualifiedFinalSimulationProjectionV1 {
  readonly input: CanonicalJson;
  readonly caller: RevmCallerBinding;
  readonly observeAccounts: readonly string[];
  readonly effectTransport?: EffectTransportDeclarationV1;
}

export interface QualifiedFinalSimulationProjectionPortV1 {
  readonly project: (input: {
    readonly program: ExecutionProgramArtifactV1;
    readonly callerId: string;
    readonly generationId: string;
    readonly cutoff: SourceViewV1;
  }) => QualifiedFinalSimulationProjectionV1;
}

/**
 * Release-bound executor state supplied by the chain/state owner.  The
 * projection below accepts no guessed defaults: the executor account, its
 * bytecode/configuration hashes, and the explicit account state must all be
 * present and mutually consistent before an EVM request is formed.
 */
export interface QualifiedFinalSimulationExecutorStateFactV1 {
  readonly kind: "aloha.qualified-final-simulation-executor-state-v1";
  /** Process-local binding issued by the release-qualified worker authority. */
  readonly authorityBinding: RevmWorkerAuthorityBindingV1;
  readonly generationId: string;
  readonly cutoff: SourceViewV1;
  readonly source: SourceViewV1;
  readonly executorAddress: string;
  readonly callerAddress: string;
  readonly executorCode: string;
  readonly executorCodeHash: Hash;
  readonly executorConfig: CanonicalJson;
  readonly executorConfigHash: Hash;
  readonly stateInput: CanonicalJson;
  readonly stateAccounts: CanonicalJson;
}

export type { QualifiedFinalSimulationExecutorStateSnapshotCapabilityV1 } from "./internal/state-snapshot.ts";
export {
  createRethQualifiedExecutorStateOwner,
  RethQualifiedExecutorStateOwner,
  RethStateOwnerError,
  type RethQualifiedExecutorStateOwnerRequestV1,
  type RethStateOwnerAccountRequestV1,
  type RethStateOwnerSessionV1,
  type RethStateOwnerTransportOptions,
} from "./internal/reth-state-owner.ts";

const EXECUTOR_CODE_HASH_DOMAIN = "aloha/qualified-final-simulation-executor-code/v1";
const EXECUTOR_CONFIG_HASH_DOMAIN = "aloha/qualified-final-simulation-executor-config/v1";
const EXECUTOR_INPUT_RESERVED_KEYS = Object.freeze(["accounts", "state", "stateOverrides", "to", "target", "data", "calldata"]);

function address(value: unknown, path: string): string {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value)) throw new TypeError(`${path} must be a 20-byte address`);
  return value.toLowerCase();
}

function bytes(value: unknown, path: string, allowEmpty = false): string {
  if (typeof value !== "string" || !/^0x(?:[0-9a-fA-F]{2})*$/.test(value) || (!allowEmpty && value.length === 2)) {
    throw new TypeError(`${path} must be even-length hex bytes`);
  }
  return value.toLowerCase();
}

function canonicalRecord(value: unknown, path: string): Record<string, CanonicalJson> {
  const normalized = assertCanonical(value, path);
  if (normalized === null || typeof normalized !== "object" || Array.isArray(normalized)) throw new TypeError(`${path} must be an object`);
  return normalized as Record<string, CanonicalJson>;
}

function sourceBoundState(
  value: QualifiedFinalSimulationExecutorStateFactV1,
  authority: RevmWorkerAuthorityIssuer,
): QualifiedFinalSimulationExecutorStateFactV1 & { readonly authorityRoot: Hash; readonly workerEpoch: string; readonly executorSessionHash: Hash } {
  if (value === null || typeof value !== "object") throw new TypeError("qualified executor state fact is required");
  authority.assertCurrent(value.authorityBinding);
  const normalizedSource = source(value.source, "executorState.source");
  const generationId = assertNonEmptyString(value.generationId, "executorState.generationId");
  const cutoff = source(value.cutoff, "executorState.cutoff");
  if (cutoff.chainId !== normalizedSource.chainId) throw new TypeError("executor state cutoff chain mismatch");
  const executorAddress = address(value.executorAddress, "executorState.executorAddress");
  const callerAddress = address(value.callerAddress, "executorState.callerAddress");
  const executorCode = bytes(value.executorCode, "executorState.executorCode");
  const executorCodeHash = assertHash(value.executorCodeHash, "executorState.executorCodeHash");
  if (executorCodeHash !== hashDomain(EXECUTOR_CODE_HASH_DOMAIN, executorCode)) throw new TypeError("executor state code hash mismatch");
  const executorConfig = assertCanonical(value.executorConfig, "executorState.executorConfig");
  const executorConfigHash = assertHash(value.executorConfigHash, "executorState.executorConfigHash");
  if (executorConfigHash !== hashDomain(EXECUTOR_CONFIG_HASH_DOMAIN, executorConfig)) throw new TypeError("executor state config hash mismatch");
  const stateInput = canonicalRecord(value.stateInput, "executorState.stateInput");
  if (EXECUTOR_INPUT_RESERVED_KEYS.some(key => Object.prototype.hasOwnProperty.call(stateInput, key))) {
    throw new TypeError("executor state input contains an execution binding field");
  }
  const stateAccounts = canonicalRecord(value.stateAccounts, "executorState.stateAccounts");
  for (const key of Object.keys(stateAccounts)) {
    if (address(key, "executorState.stateAccounts.address") !== key) throw new TypeError("executor state account address is not canonical");
  }
  const executorAccount = stateAccounts[executorAddress];
  if (executorAccount === undefined || executorAccount === null || typeof executorAccount !== "object" || Array.isArray(executorAccount)) {
    throw new TypeError("executor state account is missing");
  }
  const executorRecord = executorAccount as Record<string, unknown>;
  if (bytes(executorRecord.code, "executorState.stateAccounts.executor.code") !== executorCode) throw new TypeError("executor state executor code mismatch");
  const callerAccount = stateAccounts[callerAddress];
  if (callerAccount === undefined || callerAccount === null || typeof callerAccount !== "object" || Array.isArray(callerAccount)) {
    throw new TypeError("executor state caller account is missing");
  }
  if (Object.prototype.hasOwnProperty.call(callerAccount, "code") && bytes((callerAccount as Record<string, unknown>).code, "executorState.stateAccounts.caller.code", true) !== "0x") {
    throw new TypeError("top-level executor caller must not have code");
  }
  return deepFreeze({
    kind: "aloha.qualified-final-simulation-executor-state-v1",
    authorityBinding: value.authorityBinding,
    generationId,
    cutoff,
    source: normalizedSource,
    executorAddress,
    callerAddress,
    executorCode,
    executorCodeHash,
    executorConfig,
    executorConfigHash,
    stateInput,
    stateAccounts,
    authorityRoot: value.authorityBinding.authorityRoot,
    workerEpoch: value.authorityBinding.workerEpoch,
    executorSessionHash: value.authorityBinding.executorSessionHash,
  });
}

/** Create the only generic projection that can bind an artifact to a known executor state. */
export function createSourceBoundExecutorProjection(
  input: {
    readonly snapshot: QualifiedFinalSimulationExecutorStateSnapshotCapabilityV1 | null | undefined;
    readonly authority: RevmWorkerAuthorityIssuer;
  },
): QualifiedFinalSimulationProjectionPortV1 {
  if (input === null || typeof input !== "object" || input.snapshot === null || input.snapshot === undefined) throw new TypeError("qualified executor state snapshot capability is required");
  const authority = assertIssuedRevmWorkerAuthorityIssuer(input.authority);
  const state = sourceBoundState(readQualifiedFinalSimulationExecutorStateSnapshot(input.snapshot), authority);
  return Object.freeze({
      project({ program, callerId, generationId, cutoff }: { readonly program: ExecutionProgramArtifactV1; readonly callerId: string; readonly generationId: string; readonly cutoff: SourceViewV1 }): QualifiedFinalSimulationProjectionV1 {
        const normalizedProgram = assertExecutionProgram(program);
        decodeExecutorExecuteCalldata(normalizedProgram.programBytes);
        if (!sameSource(normalizedProgram.source, state.source)) throw new TypeError("executor state source mismatch");
        if (generationId !== state.generationId) throw new TypeError("executor state generation mismatch");
        if (!sameSource(source(cutoff, "executorProjection.cutoff"), state.cutoff)) throw new TypeError("executor state cutoff mismatch");
        if (address(callerId, "callerId") !== state.callerAddress) throw new TypeError("executor caller binding mismatch");
      const config = canonicalRecord(state.executorConfig, "executorState.executorConfig");
      const stateInput = canonicalRecord(state.stateInput, "executorState.stateInput");
      const stateAccounts = canonicalRecord(state.stateAccounts, "executorState.stateAccounts");
      const input = {
        ...config,
        ...stateInput,
        to: state.executorAddress,
        target: state.executorAddress,
        data: normalizedProgram.programBytes,
        calldata: normalizedProgram.programBytes,
        accounts: stateAccounts,
        executorCodeHash: state.executorCodeHash,
        executorConfigHash: state.executorConfigHash,
        executorAuthorityRoot: state.authorityRoot,
        executorWorkerEpoch: state.workerEpoch,
        executorSessionHash: state.executorSessionHash,
      } as unknown as CanonicalJson;
      return deepFreeze({
        input: assertCanonical(input, "executorProjection.input"),
        caller: {
          address: state.callerAddress,
          mode: "top-level" as const,
          observedSender: state.callerAddress,
          verifiedActors: {},
        },
        observeAccounts: Object.freeze(Object.keys(stateAccounts).sort()),
        ...(program.effectTransport === undefined ? {} : { effectTransport: program.effectTransport }),
      });
    },
  });
}

export interface QualifiedFinalSimulationFactV1 {
  readonly kind: "aloha.qualified-revm-final-simulation-v1";
  readonly requestId: Hash;
  readonly attemptId: Hash;
  readonly callerId: string;
  readonly ownerRef: Hash;
  readonly generationId: string;
  readonly source: SourceViewV1;
  readonly artifactProgramHash: Hash;
  readonly wireProgramHash: Hash;
  readonly inputHash: Hash;
  readonly authorityRoot: Hash;
  readonly workerEpoch: string;
  readonly executorSessionHash: Hash;
  readonly engine: "revm";
  readonly engineBuildFingerprint: string;
  readonly executableFingerprint: string;
  readonly qualifiedExecutorRegistryRoot: Hash;
  readonly selectedExecutorLeafHash: Hash;
  readonly releaseRoleManifestRoot: Hash;
  readonly caller: RevmCallerBinding;
  readonly observeAccounts: readonly string[];
  readonly status: "returned";
  readonly output: string;
  readonly effects: RevmSimulationReceipt["effects"];
  readonly effectTransport?: EffectTransportDeclarationV1;
  readonly executionReceiptHash: Hash;
}

export interface QualifiedFinalSimulationOptions {
  /** The already-composed scheduler.  This is the only admission surface. */
  readonly scheduler: WorkScheduler;
  /** Concrete client; arbitrary `{ simulate() {} }` objects are rejected. */
  readonly client: RevmSimulationClient;
  /** Exact deployment qualification selected by the signed release. */
  readonly qualification: Readonly<{
    readonly engineBuildFingerprint: string;
    readonly executableFingerprint: string;
    readonly qualifiedExecutorRegistryRoot: Hash;
    readonly selectedExecutorLeafHash: Hash;
    readonly releaseRoleManifestRoot: Hash;
  }>;
  /** Schema identity selected by the execution-program release composition. */
  readonly schemaHash: Hash;
  /** Owner-specific request metadata projection; it cannot return a receipt. */
  readonly projection: QualifiedFinalSimulationProjectionPortV1;
}

const PROGRAM_KEYS = Object.freeze([
  "kind",
  "generationId",
  "source",
  "routeHash",
  "programBytes",
  "payloadHash",
  "issuerRef",
  "obligationRoot",
  "programHash",
] as const);

const SOURCE_KEYS = Object.freeze(["chainId", "number", "hash", "stateRoot"] as const);
const CALLER_KEYS = Object.freeze(["address", "mode", "observedSender", "verifiedActors"] as const);

function sameSource(left: SourceViewV1, right: SourceViewV1): boolean {
  return left.chainId === right.chainId
    && left.number === right.number
    && left.hash === right.hash
    && left.stateRoot === right.stateRoot;
}

function source(value: unknown, path: string): SourceViewV1 {
  assertExactKeys(value, SOURCE_KEYS, path);
  const record = value as Record<string, unknown>;
  return deepFreeze({
    chainId: assertNonEmptyString(record.chainId, `${path}.chainId`),
    number: assertNonEmptyString(record.number, `${path}.number`),
    hash: assertHash(record.hash, `${path}.hash`),
    stateRoot: assertHash(record.stateRoot, `${path}.stateRoot`),
  });
}

function assertCanonical(value: unknown, path: string): CanonicalJson {
  try {
    return deepFreeze(decodeCanonicalJson(encodeCanonicalJson(value)));
  } catch (error) {
    throw new TypeError(`${path} is not canonical: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function assertExecutionProgram(value: ExecutionProgramArtifactV1): ExecutionProgramArtifactV1 {
  if (value === null || typeof value !== "object") throw new TypeError("execution program is required");
  const keys: string[] = [...PROGRAM_KEYS];
  if (Object.prototype.hasOwnProperty.call(value, "effectTransport")) keys.splice(keys.length - 1, 0, "effectTransport");
  assertExactKeys(value, keys, "executionProgram");
  if (value.kind !== "execution-program") throw new TypeError("execution program kind is unsupported");
  const normalized = {
    kind: "execution-program" as const,
    generationId: assertNonEmptyString(value.generationId, "executionProgram.generationId"),
    source: source(value.source, "executionProgram.source"),
    routeHash: assertHash(value.routeHash, "executionProgram.routeHash"),
    programBytes: assertNonEmptyString(value.programBytes, "executionProgram.programBytes"),
    payloadHash: assertHash(value.payloadHash, "executionProgram.payloadHash"),
    issuerRef: assertHash(value.issuerRef, "executionProgram.issuerRef"),
    obligationRoot: assertHash(value.obligationRoot, "executionProgram.obligationRoot"),
    ...(Object.prototype.hasOwnProperty.call(value, "effectTransport")
      ? { effectTransport: normalizeEffectTransportDeclaration(value.effectTransport, "executionProgram.effectTransport") }
      : {}),
  };
  const programHash = assertHash(value.programHash, "executionProgram.programHash");
  if (programHash !== hashDomain("aloha/execution-program-artifact/v1", normalized)) {
    throw new TypeError("execution program hash mismatch");
  }
  return deepFreeze({ ...normalized, programHash });
}

function assertCaller(value: RevmCallerBinding): RevmCallerBinding {
  if (value === null || typeof value !== "object") throw new TypeError("final simulation caller is required");
  assertExactKeys(value, CALLER_KEYS, "finalSimulation.caller");
  const mode = value.mode;
  if (mode !== "top-level" && mode !== "impersonated-call-frame") throw new TypeError("final simulation caller mode is unsupported");
  if (typeof value.verifiedActors !== "object" || value.verifiedActors === null || Array.isArray(value.verifiedActors)) {
    throw new TypeError("final simulation verified actors are invalid");
  }
  const verifiedActors: Record<string, string> = {};
  for (const [key, actor] of Object.entries(value.verifiedActors)) {
    if (key.length === 0 || typeof actor !== "string" || actor.length === 0) throw new TypeError("final simulation verified actors are invalid");
    verifiedActors[key] = actor;
  }
  const caller = {
    address: assertNonEmptyString(value.address, "finalSimulation.caller.address"),
    mode,
    observedSender: assertNonEmptyString(value.observedSender, "finalSimulation.caller.observedSender"),
    verifiedActors: Object.freeze(verifiedActors),
  } satisfies RevmCallerBinding;
  if (mode === "top-level" && caller.observedSender !== caller.address) throw new TypeError("top-level caller observedSender must equal address");
  if (mode === "impersonated-call-frame" && Object.keys(caller.verifiedActors).length === 0) throw new TypeError("impersonated caller requires verified actors");
  return deepFreeze(caller);
}

function assertObservedAccounts(value: readonly string[]): readonly string[] {
  if (!Array.isArray(value)) throw new TypeError("final simulation observeAccounts must be an array");
  const accounts = value.map((account, index) => assertNonEmptyString(account, `finalSimulation.observeAccounts[${index}]`));
  const sorted = [...accounts].sort();
  if (accounts.some((account, index) => account !== sorted[index]) || new Set(accounts).size !== accounts.length) {
    throw new TypeError("final simulation observeAccounts must be sorted and unique");
  }
  return Object.freeze(accounts);
}

function projectionFor(
  projection: QualifiedFinalSimulationProjectionPortV1,
  program: ExecutionProgramArtifactV1,
  callerId: string,
  binding: GraphLeaseBindingLikeV1,
): QualifiedFinalSimulationProjectionV1 {
  if (!projection || typeof projection !== "object" || typeof projection.project !== "function") throw new TypeError("qualified final simulation projection is required");
  const projected = projection.project({ program, callerId, generationId: binding.generationId, cutoff: binding.cutoff });
  if (projected === null || typeof projected !== "object") throw new TypeError("qualified final simulation projection is invalid");
  const keys = ["input", "caller", "observeAccounts"];
  if (Object.prototype.hasOwnProperty.call(projected, "effectTransport")) keys.push("effectTransport");
  assertExactKeys(projected, keys, "finalSimulation.projection");
  const effectTransport = Object.prototype.hasOwnProperty.call(projected, "effectTransport")
    ? normalizeEffectTransportDeclaration(projected.effectTransport, "finalSimulation.projection.effectTransport")
    : undefined;
  if (!sameEffectTransportDeclaration(effectTransport, program.effectTransport)) throw new TypeError("final simulation projection effect transport mismatch");
  return deepFreeze({
    input: assertCanonical(projected.input, "finalSimulation.projection.input"),
    caller: assertCaller(projected.caller),
    observeAccounts: assertObservedAccounts(projected.observeAccounts),
    ...(effectTransport === undefined ? {} : { effectTransport }),
  });
}

function wireProgram(program: ExecutionProgramArtifactV1, schemaHash: Hash): FrozenProgramWire {
  const body = {
    format: "frozen-program-v1" as const,
    schemaHash,
    bytes: program.programBytes,
    ...(program.effectTransport === undefined ? {} : { effectTransport: program.effectTransport }),
  };
  return deepFreeze({ ...body, programHash: hashFrozenProgram({ ...body, programHash: "placeholder" }) });
}

function requestIdFor(input: {
  readonly correlationId: Hash;
  readonly program: ExecutionProgramArtifactV1;
}): Hash {
  return hashDomain("aloha/qualified-revm-final-simulation-request/v1", {
    correlationId: input.correlationId,
    generationId: input.program.generationId,
    routeHash: input.program.routeHash,
    artifactProgramHash: input.program.programHash,
  });
}

function attemptIdFor(requestId: Hash): Hash {
  return hashDomain("aloha/qualified-revm-final-simulation-attempt/v1", requestId);
}

function schedulerCaller(callerId: string): CallerAuthority {
  return Object.freeze({
    callerId,
    authorityToken: hashDomain("aloha/qualified-final-simulation-scheduler-caller/v1", callerId),
  });
}

function failure(
  kind: "retryable" | "invalidProgram",
  code: string,
): FinalSimulationOutcomeV1<QualifiedFinalSimulationFactV1> {
  return Object.freeze({ kind, stage: "final-sim" as const, code });
}

const qualifiedRejections = new WeakMap<object, QualifiedFinalSimulationRejectionReceiptV1>();

interface QualifiedFinalSimulationSchedulerJoinSeedStateV1 {
  readonly owner: object;
  readonly value: QualifiedFinalSimulationSchedulerJoinSeedV1;
}

const qualifiedSchedulerJoinSeeds = new WeakMap<object, QualifiedFinalSimulationSchedulerJoinSeedStateV1>();
const qualifiedSixStepEvidence = new WeakMap<object, QualifiedFinalSimulationSixStepEvidenceV1>();

function issueQualifiedSixStepEvidence(
  input: Omit<QualifiedFinalSimulationSixStepEvidenceV1, "evidenceRoot">,
): QualifiedFinalSimulationSixStepEvidenceCapabilityV1 {
  const evidence = deepFreeze({
    ...input,
    evidenceRoot: hashDomain("aloha/final-simulation-six-step-evidence/v1", input as unknown as CanonicalJson),
  });
  const capability = Object.freeze(Object.create(null)) as QualifiedFinalSimulationSixStepEvidenceCapabilityV1;
  qualifiedSixStepEvidence.set(capability, evidence);
  return capability;
}

function readQualifiedSixStepEvidence(
  capability: QualifiedFinalSimulationSixStepEvidenceCapabilityV1,
): QualifiedFinalSimulationSixStepEvidenceV1 {
  if (capability === null || typeof capability !== "object") throw new TypeError("qualified final-simulation six-step evidence capability is required");
  const evidence = qualifiedSixStepEvidence.get(capability);
  if (evidence === undefined) throw new TypeError("qualified final-simulation six-step evidence capability was not issued");
  const { evidenceRoot: _evidenceRoot, ...body } = evidence;
  if (evidence.evidenceRoot !== hashDomain("aloha/final-simulation-six-step-evidence/v1", body as unknown as CanonicalJson)) {
    throw new TypeError("qualified final-simulation six-step evidence identity mismatch");
  }
  return evidence;
}

function issueQualifiedSchedulerJoinSeed(
  owner: object,
  input: QualifiedFinalSimulationSchedulerJoinSeedV1,
): QualifiedFinalSimulationSchedulerJoinSeedCapabilityV1 {
  if (input.schedulerCompletion === null || typeof input.schedulerCompletion !== "object") {
    throw new TypeError("final simulation scheduler completion handle is required");
  }
  const value = Object.freeze({
    correlationId: assertHash(input.correlationId, "finalSimulation.schedulerJoin.correlationId"),
    generationId: assertNonEmptyString(input.generationId, "finalSimulation.schedulerJoin.generationId"),
    source: source(input.source, "finalSimulation.schedulerJoin.source"),
    programHash: assertHash(input.programHash, "finalSimulation.schedulerJoin.programHash"),
    finalSimulationReceiptHash: assertHash(input.finalSimulationReceiptHash, "finalSimulation.schedulerJoin.finalSimulationReceiptHash"),
    schedulerCompletion: input.schedulerCompletion,
  });
  const capability = Object.freeze(Object.create(null)) as QualifiedFinalSimulationSchedulerJoinSeedCapabilityV1;
  qualifiedSchedulerJoinSeeds.set(capability, Object.freeze({ owner, value }));
  return capability;
}

function readQualifiedSchedulerJoinSeed(
  owner: object,
  capability: QualifiedFinalSimulationSchedulerJoinSeedCapabilityV1,
): QualifiedFinalSimulationSchedulerJoinSeedV1 {
  if (capability === null || typeof capability !== "object") {
    throw new TypeError("qualified final simulation scheduler join seed is required");
  }
  const state = qualifiedSchedulerJoinSeeds.get(capability);
  if (state === undefined || state.owner !== owner) {
    throw new TypeError("qualified final simulation scheduler join seed was not issued by this owner");
  }
  return state.value;
}

function rejectionReceiptHash(value: Omit<QualifiedFinalSimulationRejectionReceiptV1, "receiptHash">): Hash {
  return hashDomain("aloha/qualified-stage-rejection-receipt/v1", value);
}

function issueQualifiedRejection(input: {
  readonly program: ExecutionProgramArtifactV1;
  readonly correlationId: Hash;
  readonly ownerReceiptHash: Hash;
  readonly source: SourceViewV1;
  readonly code: string;
}): Extract<FinalSimulationOutcomeV1<QualifiedFinalSimulationFactV1>, { readonly kind: "chainProvenRejected" }> {
  const code = assertNonEmptyString(input.code, "finalSimulation.rejection.code");
  const ownerReceiptHash = assertHash(input.ownerReceiptHash, "finalSimulation.rejection.ownerReceiptHash");
  const normalizedSource = source(input.source, "finalSimulation.rejection.source");
  if (!sameSource(normalizedSource, input.program.source)) throw new TypeError("final simulation rejection source mismatch");
  const evidenceHash = hashDomain("aloha/qualified-final-simulation-reverted/v1", {
    correlationId: input.correlationId,
    ownerReceiptHash,
    source: normalizedSource,
    routeHash: input.program.routeHash,
    programHash: input.program.programHash,
  });
  const body = {
    kind: "aloha.qualified-stage-rejection-v1" as const,
    stage: "final-sim" as const,
    routeHash: input.program.routeHash,
    source: normalizedSource,
    correlationId: assertHash(input.correlationId, "finalSimulation.rejection.correlationId"),
    inputArtifactHash: input.program.programHash,
    programHash: input.program.programHash,
    code,
    evidenceHash,
    ownerReceiptHash,
  };
  const receipt = deepFreeze({ ...body, receiptHash: rejectionReceiptHash(body) });
  const capability = Object.freeze({ kind: "opaque-qualified-stage-rejection-capability" as const });
  qualifiedRejections.set(capability, receipt);
  return Object.freeze({ kind: "chainProvenRejected", stage: "final-sim", code, evidenceHash, capability });
}

function readQualifiedRejection(
  capability: QualifiedFinalSimulationRejectionCapabilityV1,
): QualifiedFinalSimulationRejectionReceiptV1 {
  if (capability === null || typeof capability !== "object") throw new TypeError("qualified final simulation rejection capability is required");
  const receipt = qualifiedRejections.get(capability);
  if (receipt === undefined) throw new TypeError("qualified final simulation rejection capability was not issued");
  return receipt;
}

function mapSchedulerFailure(error: SchedulerError): FinalSimulationOutcomeV1<QualifiedFinalSimulationFactV1> {
  if (error.code === "impossible-cost" || error.code === "caller-mismatch" || error.code === "permit-mismatch") {
    return failure("invalidProgram", `scheduler-${error.code}`);
  }
  return failure("retryable", `scheduler-${error.code}`);
}

function mapSimulationFailure(error: RevmSimulationError): FinalSimulationOutcomeV1<QualifiedFinalSimulationFactV1> {
  const invalid: readonly string[] = [
    "invalid-response",
    "program-mismatch",
    "caller-mismatch",
    "observe-scope-mismatch",
    "owner-mismatch",
    "generation-mismatch",
    "attempt-mismatch",
  ];
  const unavailable: readonly string[] = ["worker-unavailable", "worker-error", "retired"];
  return failure(
    invalid.includes(error.code) ? "invalidProgram" : "retryable",
    unavailable.includes(error.code) ? "revm-worker-unavailable" : `revm-${error.code}`,
  );
}

function finalReceipt(
  input: {
    readonly program: ExecutionProgramArtifactV1;
    readonly simulation: QualifiedFinalSimulationFactV1;
  },
): FinalSimulationReceiptV1<QualifiedFinalSimulationFactV1> {
  const effectsHash = assertHash(input.simulation.effects.effectsHash, "finalSimulation.effectsHash");
  const body = {
    kind: "final-simulation-passed" as const,
    generationId: input.program.generationId,
    source: input.program.source,
    programHash: input.program.programHash,
    simulation: input.simulation,
    effectsHash,
    ...(input.program.effectTransport === undefined ? {} : { effectTransport: input.program.effectTransport }),
  };
  return deepFreeze({
    ...body,
    receiptHash: hashDomain("aloha/qualified-final-simulation-receipt/v1", body),
  });
}

function factFromReceipt(
  input: {
    readonly clientReceipt: RevmSimulationReceipt;
    readonly program: ExecutionProgramArtifactV1;
    readonly wire: FrozenProgramWire;
    readonly callerId: string;
    readonly qualification: QualifiedFinalSimulationOptions["qualification"];
  },
): QualifiedFinalSimulationFactV1 {
  const receipt = input.clientReceipt;
  if (receipt.status !== "returned") throw new TypeError("reverted simulation cannot become a passed final-simulation fact");
  if (receipt.generationId !== input.program.generationId) throw new TypeError("final simulation generation mismatch");
  if (!sameSource(receipt.source, input.program.source)) throw new TypeError("final simulation source mismatch");
  if (receipt.programHash !== input.wire.programHash) throw new TypeError("final simulation wire program mismatch");
  if (receipt.ownerRef !== input.program.issuerRef) throw new TypeError("final simulation owner mismatch");
  if (receipt.engineBuildFingerprint !== input.qualification.engineBuildFingerprint) throw new TypeError("final simulation engine qualification mismatch");
  if (!sameEffectTransportDeclaration(receipt.effectTransport, input.program.effectTransport)) throw new TypeError("final simulation effect transport mismatch");
  return deepFreeze({
    kind: "aloha.qualified-revm-final-simulation-v1",
    requestId: assertHash(receipt.requestId, "finalSimulation.requestId"),
    attemptId: assertHash(receipt.attemptId, "finalSimulation.attemptId"),
    callerId: assertNonEmptyString(input.callerId, "callerId"),
    ownerRef: assertHash(receipt.ownerRef, "finalSimulation.ownerRef"),
    generationId: receipt.generationId,
    source: source(receipt.source, "finalSimulation.source"),
    artifactProgramHash: assertHash(input.program.programHash, "executionProgram.programHash"),
    wireProgramHash: assertHash(receipt.programHash, "finalSimulation.wireProgramHash"),
    inputHash: assertHash(receipt.inputHash, "finalSimulation.inputHash"),
    authorityRoot: assertHash(receipt.authority.authorityRoot, "finalSimulation.authorityRoot"),
    workerEpoch: assertNonEmptyString(receipt.workerEpoch, "finalSimulation.workerEpoch"),
    executorSessionHash: assertHash(receipt.authority.executorSessionHash, "finalSimulation.executorSessionHash"),
    engine: "revm",
    engineBuildFingerprint: assertNonEmptyString(receipt.engineBuildFingerprint, "finalSimulation.engineBuildFingerprint"),
    executableFingerprint: assertNonEmptyString(input.qualification.executableFingerprint, "finalSimulation.executableFingerprint"),
    qualifiedExecutorRegistryRoot: assertHash(input.qualification.qualifiedExecutorRegistryRoot, "finalSimulation.qualifiedExecutorRegistryRoot"),
    selectedExecutorLeafHash: assertHash(input.qualification.selectedExecutorLeafHash, "finalSimulation.selectedExecutorLeafHash"),
    releaseRoleManifestRoot: assertHash(input.qualification.releaseRoleManifestRoot, "finalSimulation.releaseRoleManifestRoot"),
    caller: assertCaller(receipt.caller),
    observeAccounts: assertObservedAccounts(receipt.observeAccounts),
    status: "returned",
    output: assertNonEmptyString(receipt.output, "finalSimulation.output"),
    effects: deepFreeze({ ...receipt.effects, observedAccounts: Object.freeze([...receipt.effects.observedAccounts]) }),
    ...(receipt.effectTransport === undefined ? {} : { effectTransport: normalizeEffectTransportDeclaration(receipt.effectTransport, "finalSimulation.effectTransport") }),
    executionReceiptHash: assertHash(receipt.executionReceiptHash, "finalSimulation.executionReceiptHash"),
  });
}

/**
 * Compose the only final-simulation port exposed to search-pipeline.  The
 * concrete client owns qualified worker dispatch and the scheduler owns the
 * final-sim permit.  With no worker pool the returned outcome is explicitly
 * unavailable; this function never manufactures a simulation receipt.
 */
export function createQualifiedFinalSimulationPort(
  options: QualifiedFinalSimulationOptions,
): FinalSimulationPortV1<QualifiedFinalSimulationFactV1> {
  if (!options || typeof options !== "object") throw new TypeError("qualified final simulation options are required");
  if (!(options.scheduler instanceof WorkScheduler)) throw new TypeError("qualified final simulation scheduler is not a WorkScheduler");
  if (!(options.client instanceof RevmSimulationClient)) throw new TypeError("qualified final simulation client is not a RevmSimulationClient");
  if (Object.prototype.hasOwnProperty.call(options.client, "simulate") || Object.getPrototypeOf(options.client)?.simulate !== options.client.simulate) throw new TypeError("qualified final simulation client method is not concrete");
  const schemaHash = assertHash(options.schemaHash, "finalSimulation.schemaHash");
  const qualification = Object.freeze({
    engineBuildFingerprint: assertNonEmptyString(options.qualification?.engineBuildFingerprint, "finalSimulation.qualification.engineBuildFingerprint"),
    executableFingerprint: assertNonEmptyString(options.qualification?.executableFingerprint, "finalSimulation.qualification.executableFingerprint"),
    qualifiedExecutorRegistryRoot: assertHash(options.qualification?.qualifiedExecutorRegistryRoot, "finalSimulation.qualification.qualifiedExecutorRegistryRoot"),
    selectedExecutorLeafHash: assertHash(options.qualification?.selectedExecutorLeafHash, "finalSimulation.qualification.selectedExecutorLeafHash"),
    releaseRoleManifestRoot: assertHash(options.qualification?.releaseRoleManifestRoot, "finalSimulation.qualification.releaseRoleManifestRoot"),
  });
  if (!options.projection || typeof options.projection !== "object" || typeof options.projection.project !== "function") throw new TypeError("qualified final simulation projection is required");
  const scheduler = options.scheduler;
  const client = options.client;
  const projection = options.projection;
  const schedulerJoinOwner = Object.freeze(Object.create(null));
  return Object.freeze({
    rejectionAuthority: Object.freeze({ read: readQualifiedRejection }),
    schedulerJoinAuthority: Object.freeze({
      read: (capability: QualifiedFinalSimulationSchedulerJoinSeedCapabilityV1) => readQualifiedSchedulerJoinSeed(schedulerJoinOwner, capability),
    }),
    sixStepEvidenceAuthority: Object.freeze({ read: readQualifiedSixStepEvidence }),
    async simulate(input: Parameters<FinalSimulationPortV1<QualifiedFinalSimulationFactV1>["simulate"]>[0]): Promise<FinalSimulationOutcomeV1<QualifiedFinalSimulationFactV1>> {
      try {
        if (!input || typeof input !== "object") return failure("invalidProgram", "input-required");
        const inputKeys = ["binding", "program", "source", "callerId", "correlationId", "deadlineAtMs"];
        if (Object.prototype.hasOwnProperty.call(input, "signal")) inputKeys.push("signal");
        assertExactKeys(input, inputKeys, "finalSimulation.input");
        const program = assertExecutionProgram(input.program);
        if (input.binding === null || typeof input.binding !== "object" || input.binding.generationId !== program.generationId) return failure("invalidProgram", "generation-binding-mismatch");
        const currentSource = input.source;
        const sourceView = source(currentSource.source, "currentSource.source");
        if (!sameSource(sourceView, program.source)) return failure("invalidProgram", "source-program-mismatch");
        const callerId = assertNonEmptyString(input.callerId, "callerId");
        const correlationId = assertHash(input.correlationId, "correlationId");
        if (typeof input.deadlineAtMs !== "number" || !Number.isFinite(input.deadlineAtMs)) return failure("invalidProgram", "deadline-invalid");
        try {
          await currentSource.assertCurrent();
        } catch {
          return failure("retryable", "source-stale");
        }
        const projected = projectionFor(projection, program, callerId, input.binding);
        const wire = wireProgram(program, schemaHash);
        const requestId = requestIdFor({ correlationId, program });
        const attemptId = attemptIdFor(requestId);
        const workCaller = schedulerCaller(callerId);
        let schedulerCompletion: SchedulerWorkCompletionHandleV1 | null = null;
        const result = await scheduler.run({
          work: {
            workId: requestId,
            phase: "final-sim",
            workClassRef: "qualified-revm-final-simulation-v1",
            ownerRef: program.issuerRef,
            lane: "final-sim",
            resource: "final-sim",
            quotaKey: "final-sim",
            deadlineAtMs: input.deadlineAtMs,
            signal: input.signal,
          },
          caller: workCaller,
          execute: async (permit: SchedulerPermit): Promise<RevmSimulationReceipt> => {
            if (schedulerCompletion !== null || permit.completion === null || typeof permit.completion !== "object") {
              throw new TypeError("final simulation scheduler completion handle is invalid");
            }
            schedulerCompletion = permit.completion;
            return client.simulate({
              requestId,
              ownerRef: program.issuerRef,
              generationId: program.generationId,
              attemptId,
              source: program.source,
              caller: projected.caller,
              observeAccounts: projected.observeAccounts,
              program: wire,
              input: projected.input,
              deadlineAtMs: input.deadlineAtMs,
              signal: permit.signal,
            });
          },
        });
        try {
          await currentSource.assertCurrent();
        } catch {
          return failure("retryable", "source-stale");
        }
        if (result.status === "reverted") {
          if (result.requestId !== requestId
            || result.attemptId !== attemptId
            || result.generationId !== program.generationId
            || result.ownerRef !== program.issuerRef
            || result.programHash !== wire.programHash
            || !sameSource(source(result.source, "finalSimulation.rejection.source"), program.source)) {
            return failure("invalidProgram", "rejection-receipt-binding-mismatch");
          }
          return issueQualifiedRejection({
            program,
            correlationId,
            ownerReceiptHash: assertHash(result.executionReceiptHash, "finalSimulation.rejection.executionReceiptHash"),
            source: result.source,
            code: "simulation-reverted",
          });
        }
        const simulation = factFromReceipt({ clientReceipt: result, program, wire, callerId, qualification });
        if (simulation.requestId !== requestId || simulation.attemptId !== attemptId) return failure("invalidProgram", "request-binding-mismatch");
        if (schedulerCompletion === null) return failure("invalidProgram", "scheduler-completion-handle-missing");
        const receipt = finalReceipt({ program, simulation });
        const facts = assertCanonical({
          kind: "aloha.qualified-final-simulation-owner-facts-v1",
          executorQualification: qualification,
          projection: {
            input: projected.input,
            caller: projected.caller,
            observeAccounts: projected.observeAccounts,
            ...(projected.effectTransport === undefined ? {} : { effectTransport: projected.effectTransport }),
          },
          workerReceipt: {
            requestId: result.requestId,
            attemptId: result.attemptId,
            ownerRef: result.ownerRef,
            generationId: result.generationId,
            authority: result.authority,
            inputHash: result.inputHash,
            deadlineAtMs: result.deadlineAtMs,
            authorityRoot: result.authority.authorityRoot,
            workerEpoch: result.workerEpoch,
            executorSessionHash: result.authority.executorSessionHash,
            engine: result.engine,
            engineBuildFingerprint: result.engineBuildFingerprint,
            caller: result.caller,
            observeAccounts: result.observeAccounts,
            source: result.source,
            programHash: result.programHash,
            status: result.status,
            output: result.output,
            effects: result.effects,
            ...(result.effectTransport === undefined ? {} : { effectTransport: result.effectTransport }),
            executionReceiptHash: result.executionReceiptHash,
          },
        }, "finalSimulation.sixStepEvidence.facts");
        const sixStepEvidence = issueQualifiedSixStepEvidence({
          schemaVersion: 1,
          kind: "aloha.final-simulation-six-step-evidence-v1",
          correlationId,
          generationId: program.generationId,
          source: program.source,
          programHash: program.programHash,
          finalSimulationReceiptHash: receipt.receiptHash,
          facts,
        });
        const schedulerJoinSeed = issueQualifiedSchedulerJoinSeed(schedulerJoinOwner, {
          correlationId,
          generationId: program.generationId,
          source: program.source,
          programHash: program.programHash,
          finalSimulationReceiptHash: receipt.receiptHash,
          schedulerCompletion,
        });
        return Object.freeze({ kind: "passed" as const, receipt, schedulerJoinSeed, sixStepEvidence });
      } catch (error) {
        if (error instanceof SchedulerError) return mapSchedulerFailure(error);
        if (error instanceof RevmSimulationError) return mapSimulationFailure(error);
        return failure("invalidProgram", error instanceof Error ? `bridge-${error.message}` : "bridge-error");
      }
    },
  });
}
