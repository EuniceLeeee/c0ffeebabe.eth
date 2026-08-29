import {
  decodeCanonicalJson,
  deepFreeze,
  encodeCanonicalJson,
  assertExactKeys,
  assertHash,
  assertNonEmptyString,
  hashDomain,
  type CanonicalJson,
  type Hash,
} from "../../../packages/canonical-codec/src/index.ts";
import {
  WorkScheduler,
  type CallerAuthority,
  type SchedulerLane,
  type SchedulerPermit,
  type SchedulerResource,
  type SchedulerWorkDescriptor,
  monotonicNow,
} from "../../../packages/scheduler/src/index.ts";
import type { FamilyRawEvidenceReadPortV1 } from "../../../packages/family-sdk/runtime/index.ts";
import {
  readWorkPlaneCallerCapability,
  workPlaneCallerIntentBindingHash,
} from "./internal/caller-authority-state.ts";

export interface WorkSourceView {
  readonly chainId: string;
  readonly number: string;
  readonly hash: string;
  readonly stateRoot: string;
}

export type OpaqueRef = string | Readonly<Record<string, string>>;

export interface GenerationLeaseRef {
  readonly ref: OpaqueRef;
  readonly source: WorkSourceView;
  readonly generation: string;
}

export interface FrozenProgramRef {
  readonly ref: OpaqueRef;
  readonly schemaHash: string;
  readonly programHash: string;
  readonly programInputHash: Hash;
  readonly issuerRef: OpaqueRef;
}

export interface CapabilityWorkIntentV1 {
  readonly intentId: Hash | string;
  readonly ownerRef: OpaqueRef;
  readonly capabilityRef: OpaqueRef;
  readonly workClassRef: OpaqueRef;
  readonly phase: string;
  readonly source: WorkSourceView;
  readonly generationLeaseRef: GenerationLeaseRef;
  readonly frozenProgramRef: FrozenProgramRef;
  readonly programInputRef: OpaqueRef;
  readonly consumerDeadline: number;
  readonly programInput: CanonicalJson;
}

export interface WorkClassDeclaration {
  readonly phase: string;
  readonly lane: SchedulerLane;
  readonly resource: SchedulerResource;
  readonly quotaKey?: string;
  readonly cost?: number;
}

declare const workPlaneCallerCapabilityBrand: unique symbol;

/** Owner-issued process-local authority. It has no structural wire form. */
export interface WorkPlaneCallerCapabilityV1 {
  readonly [workPlaneCallerCapabilityBrand]: "WorkPlaneCallerCapabilityV1";
}

export interface WorkReceiptV1 {
  readonly receiptId: Hash;
  readonly intentId: string;
  readonly workKeyHash: Hash;
  readonly ownerRef: OpaqueRef;
  readonly capabilityRef: OpaqueRef;
  readonly workClassRef: OpaqueRef;
  readonly phase: string;
  readonly source: WorkSourceView;
  readonly generationLeaseRef: GenerationLeaseRef;
  readonly callerId: string;
  readonly authorityTokenHash: Hash;
  readonly permitId: string | null;
  readonly queueWaitMs: number | null;
  readonly lane: SchedulerLane | null;
  readonly resource: SchedulerResource | null;
  readonly startedAtMs: number;
  readonly finishedAtMs: number;
  readonly phases: readonly WorkPhaseReceipt[];
  readonly outcome: "resolved" | "unresolved";
  readonly failureStage: WorkFailureStage | null;
  readonly failureCode: WorkFailureCode | null;
}

export interface WorkPhaseReceipt {
  readonly phase: string;
  readonly startedAtMs: number;
  readonly finishedAtMs: number;
  readonly status: "completed" | "failed";
}

export type WorkFailureStage =
  | "intent"
  | "authority"
  | "admission"
  | "queue"
  | "transport"
  | "interpretation"
  | "pre-publication-fence";

export type WorkFailureCode =
  | "invalid-intent"
  | "unknown-capability"
  | "caller-mismatch"
  | "lease-invalid"
  | "queue-full"
  | "resource-limit"
  | "impossible-cost"
  | "abort"
  | "deadline"
  | "transport-error"
  | "invalid-program"
  | "plugin-error"
  | "source-stale"
  | "failed-closed";

export interface WorkFailure {
  readonly stage: WorkFailureStage;
  readonly code: WorkFailureCode;
  readonly retryClass: "retryable" | "invalid-program";
  readonly message: string;
}

export type CapabilityWorkOutcomeV1<Fact> =
  | { readonly kind: "resolved"; readonly fact: Fact; readonly receipt: WorkReceiptV1 }
  | { readonly kind: "unresolved"; readonly failure: WorkFailure; readonly receipt: WorkReceiptV1 };

export interface WorkProgramExecutionInput {
  readonly intent: CapabilityWorkIntentV1;
  readonly signal: AbortSignal;
  readonly permit: SchedulerPermit;
}

/**
 * The only execution surface a Family receives.  Scheduler permits, the
 * registry issuer, and durable/checkpoint services stay on the framework side
 * of this boundary.
 */
export interface FamilyFrozenProgramExecutionInput {
  readonly intent: CapabilityWorkIntentV1;
  readonly rawEvidence: FamilyRawEvidenceReadPortV1;
  readonly attemptId?: string;
  readonly signal?: AbortSignal;
}

/**
 * Exact result returned by the physical work owner.  It deliberately has no
 * source, authority, session, or program fingerprint fields.  Those facts
 * are release-owned and are added only by the Family transport bridge after
 * the scheduler authority has been observed again.
 */
export type SourceLessTransportResultV1 =
  | {
    readonly kind: "returned";
    readonly requestId: Hash;
    readonly dataHex: string;
  }
  | {
    readonly kind: "reverted";
    readonly requestId: Hash;
    readonly dataHex: string;
  }
  | {
    readonly kind: "transportFailure";
    readonly requestId: Hash;
    readonly failureCode: "rpc" | "deadline" | "abort" | "queue-full" | "resource-limit" | "worker-crash" | "source-stale";
  };

export interface FamilyStampedFactView<Fact> {
  readonly fact: Fact;
  readonly source: WorkSourceView;
  readonly authorityRoot: Hash;
  readonly workerEpoch: string;
  readonly executorSession: Hash;
  /** Derived for this frozen-program attempt; never capability-global. */
  readonly executionSessionHash: Hash;
}

export type FamilyFrozenProgramExecutionResult<Fact> = FamilyStampedFactView<Fact>;

export interface FamilyFrozenProgramExecutionPort<Fact> {
  readonly executeFrozenProgram: (
    input: FamilyFrozenProgramExecutionInput,
  ) => Promise<FamilyFrozenProgramExecutionResult<Fact>>;
}

/**
 * Owner-issued physical execution edge. The release bootstrap consumes only
 * this opaque capability; it never accepts a raw scheduler callback.
 */
export interface QualifiedPhysicalExecutionPortV1<Fact> {
  readonly execute: (input: {
    readonly intent: CapabilityWorkIntentV1;
    readonly rawEvidence: FamilyRawEvidenceReadPortV1;
    readonly signal: AbortSignal;
  }) => Promise<Fact>;
}

export interface WorkPlanePorts<ProgramResult, Fact> {
  readonly scheduler: WorkScheduler;
  readonly resolveWorkClass: (intent: CapabilityWorkIntentV1) => WorkClassDeclaration;
  /** Exact schema decoding and required-field validation. */
  readonly decodeIntent: (intent: CapabilityWorkIntentV1) => void;
  /** Generated declaration membership check; this is not an admission allowlist. */
  readonly assertMembership: (input: {
    readonly ownerRef: OpaqueRef;
    readonly capabilityRef: OpaqueRef;
    readonly workClassRef: OpaqueRef;
    readonly programIssuerRef: OpaqueRef;
  }) => void;
  readonly fence: {
    readonly assertCurrent: (input: {
      readonly source: WorkSourceView;
      readonly generationLeaseRef: GenerationLeaseRef;
    }) => void;
  };
  /** Executes the complete frozen program; no local EVM substitute is provided. */
  readonly execute: (input: WorkProgramExecutionInput) => Promise<ProgramResult>;
  /** Owning generated interpreter turns returned typed data into a fact. */
  readonly interpret: (input: {
    readonly intent: CapabilityWorkIntentV1;
    readonly result: ProgramResult;
  }) => Fact;
  readonly clock?: () => number;
}

export interface ExecuteWorkInput {
  readonly intent: CapabilityWorkIntentV1;
  readonly caller: WorkPlaneCallerCapabilityV1;
  readonly signal?: AbortSignal;
}

function now(clock: () => number): number { return clock(); }

function refKey(ref: OpaqueRef): string {
  return typeof ref === "string" ? ref : hashDomain("aloha/work-plane-ref/v1", ref);
}

function sourceCopy(source: WorkSourceView): WorkSourceView {
  assertExactKeys(source, ["chainId", "number", "hash", "stateRoot"]);
  if (typeof source.chainId !== "string" || source.chainId.length === 0 || typeof source.number !== "string" || source.number.length === 0 || typeof source.hash !== "string" || source.hash.length === 0 || typeof source.stateRoot !== "string" || source.stateRoot.length === 0) {
    throw new TypeError("work source is incomplete");
  }
  return Object.freeze({ ...source });
}

function canonicalProgramInput(value: unknown): CanonicalJson {
  // Encode/decode creates the exact schema-owned value; deepFreeze alone
  // would preserve caller aliases and would not establish canonical bytes.
  return deepFreeze(decodeCanonicalJson(encodeCanonicalJson(value)));
}

function opaqueCopy<T extends OpaqueRef>(value: T, name: string): T {
  if (typeof value === "string") {
    if (value.length === 0) throw new TypeError(`${name} must be non-empty`);
    return value;
  }
  const copy = deepFreeze(decodeCanonicalJson(encodeCanonicalJson(value)));
  if (copy === null || typeof copy !== "object" || Array.isArray(copy)) throw new TypeError(`${name} must be an opaque object or string`);
  for (const [key, item] of Object.entries(copy)) {
    if (key.length === 0 || typeof item !== "string") throw new TypeError(`${name} must contain string fields`);
  }
  return copy as T;
}

function programInputHash(value: CanonicalJson): Hash {
  return hashDomain("aloha/work-plane-program-input/v1", value);
}

function intentKey(intent: CapabilityWorkIntentV1): Hash {
  return hashDomain("aloha/work-plane-key/v1", {
    intentId: intent.intentId,
    ownerRef: intent.ownerRef,
    capabilityRef: intent.capabilityRef,
    workClassRef: intent.workClassRef,
    phase: intent.phase,
    source: intent.source,
    generationLeaseRef: intent.generationLeaseRef,
    frozenProgramRef: intent.frozenProgramRef,
    programInputRef: intent.programInputRef,
    programInput: intent.programInput,
  });
}

function authorityTokenHash(caller: CallerAuthority): Hash {
  return hashDomain("aloha/work-plane-authority-token/v1", caller.authorityToken);
}

function receiptOpaque(value: unknown): OpaqueRef {
  try {
    return opaqueCopy(value as OpaqueRef, "receipt reference");
  } catch {
    return "invalid";
  }
}

function receiptLease(value: unknown, source: WorkSourceView): GenerationLeaseRef {
  if (value !== null && typeof value === "object") {
    const lease = value as Record<string, unknown>;
    try {
      const leaseSource = sourceCopy(lease.source as WorkSourceView);
      if (typeof lease.generation === "string" && lease.generation.length > 0 && leaseSource.chainId === source.chainId && leaseSource.number === source.number && leaseSource.hash === source.hash && leaseSource.stateRoot === source.stateRoot) {
        return Object.freeze({ ref: receiptOpaque(lease.ref), source: leaseSource, generation: lease.generation });
      }
    } catch {
      // The failed receipt below uses an explicit invalid lease.
    }
  }
  return Object.freeze({ ref: "invalid", source, generation: "invalid" });
}

export function assertCapabilityWorkIntent(intent: CapabilityWorkIntentV1): void {
  if (!intent || typeof intent !== "object") throw new TypeError("work intent must be an object");
  assertExactKeys(intent, ["intentId", "ownerRef", "capabilityRef", "workClassRef", "phase", "source", "generationLeaseRef", "frozenProgramRef", "programInputRef", "consumerDeadline", "programInput"]);
  if (typeof intent.intentId !== "string" || intent.intentId.length === 0) throw new TypeError("intentId must be non-empty");
  if (typeof intent.phase !== "string" || intent.phase.length === 0) throw new TypeError("phase must be non-empty");
  if (typeof intent.consumerDeadline !== "number" || !Number.isFinite(intent.consumerDeadline)) throw new TypeError("consumerDeadline must be finite");
  sourceCopy(intent.source);
  if (!intent.generationLeaseRef || typeof intent.generationLeaseRef !== "object") throw new TypeError("generationLeaseRef is required");
  assertExactKeys(intent.generationLeaseRef, ["ref", "source", "generation"]);
  opaqueCopy(intent.generationLeaseRef.ref, "generationLeaseRef.ref");
  sourceCopy(intent.generationLeaseRef.source);
  if (typeof intent.generationLeaseRef.generation !== "string" || intent.generationLeaseRef.generation.length === 0) throw new TypeError("generation lease generation is incomplete");
  if (intent.generationLeaseRef.source.chainId !== intent.source.chainId || intent.generationLeaseRef.source.number !== intent.source.number || intent.generationLeaseRef.source.hash !== intent.source.hash || intent.generationLeaseRef.source.stateRoot !== intent.source.stateRoot) throw new TypeError("generation lease is not source-bound");
  if (!intent.frozenProgramRef || typeof intent.frozenProgramRef !== "object") throw new TypeError("frozenProgramRef is required");
  assertExactKeys(intent.frozenProgramRef, ["ref", "schemaHash", "programHash", "programInputHash", "issuerRef"]);
  opaqueCopy(intent.frozenProgramRef.ref, "frozenProgramRef.ref");
  opaqueCopy(intent.frozenProgramRef.issuerRef, "frozenProgramRef.issuerRef");
  if (typeof intent.frozenProgramRef.schemaHash !== "string" || intent.frozenProgramRef.schemaHash.length === 0 || typeof intent.frozenProgramRef.programHash !== "string" || intent.frozenProgramRef.programHash.length === 0 || typeof intent.frozenProgramRef.programInputHash !== "string" || intent.frozenProgramRef.programInputHash.length === 0) throw new TypeError("frozen program binding is incomplete");
  if (typeof intent.frozenProgramRef.issuerRef !== "string" && (intent.frozenProgramRef.issuerRef === null || typeof intent.frozenProgramRef.issuerRef !== "object")) throw new TypeError("frozen program issuer is opaque");
  for (const [name, value] of [["ownerRef", intent.ownerRef], ["capabilityRef", intent.capabilityRef], ["workClassRef", intent.workClassRef], ["programInputRef", intent.programInputRef]] as const) {
    opaqueCopy(value, name);
  }
  const input = canonicalProgramInput(intent.programInput);
  if (programInputHash(input) !== intent.frozenProgramRef.programInputHash) throw new TypeError("program input hash is not bound to frozen program");
}

function errorCode(error: unknown): WorkFailureCode {
  const code = typeof error === "object" && error !== null && "code" in error ? (error as { code?: unknown }).code : undefined;
  const byCode: Record<string, WorkFailureCode> = {
    "queue-full": "queue-full",
    "resource-limit": "resource-limit",
    "impossible-cost": "impossible-cost",
    aborted: "abort",
    deadline: "deadline",
    "caller-mismatch": "caller-mismatch",
    "permit-mismatch": "caller-mismatch",
    "source-stale": "source-stale",
    "lease-invalid": "lease-invalid",
    "unknown-capability": "unknown-capability",
    "invalid-intent": "invalid-intent",
    "plugin-error": "plugin-error",
    "transport-error": "transport-error",
    "invalid-program": "invalid-program",
  };
  return typeof code === "string" && byCode[code] ? byCode[code] : "failed-closed";
}

function failureStage(code: WorkFailureCode, fallback: WorkFailureStage): WorkFailureStage {
  if (code === "queue-full" || code === "resource-limit" || code === "impossible-cost") return "admission";
  if (code === "abort" || code === "deadline") return "queue";
  if (code === "transport-error") return "transport";
  if (code === "caller-mismatch" || code === "lease-invalid") return "authority";
  if (code === "invalid-program" || code === "invalid-intent") return "intent";
  if (code === "plugin-error") return "interpretation";
  return fallback;
}

class WorkPlanePortError extends Error {
  readonly code: WorkFailureCode;

  constructor(code: WorkFailureCode, error: unknown) {
    super(error instanceof Error ? error.message : String(error));
    this.name = "WorkPlanePortError";
    this.code = code;
  }
}

function invokePort<T>(code: WorkFailureCode, operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error) throw error;
    throw new WorkPlanePortError(code, error);
  }
}

async function invokePortAsync<T>(code: WorkFailureCode, operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error) throw error;
    throw new WorkPlanePortError(code, error);
  }
}

function freezeReceipt(input: Omit<WorkReceiptV1, "receiptId">): WorkReceiptV1 {
  const payload = deepFreeze({
    ...input,
    source: { ...input.source },
    generationLeaseRef: {
      ...input.generationLeaseRef,
      source: { ...input.generationLeaseRef.source },
    },
    phases: input.phases.map((phase) => ({ ...phase })),
  });
  return deepFreeze({
    ...payload,
    receiptId: hashDomain("aloha/work-plane-receipt/v1", payload),
  });
}

/** Generic phase/lane/work-class work plane. */
export class WorkPlane<ProgramResult, Fact> {
  private readonly ports: WorkPlanePorts<ProgramResult, Fact>;
  private readonly clock: () => number;

  constructor(ports: WorkPlanePorts<ProgramResult, Fact>) {
    this.ports = ports;
    this.clock = ports.clock ?? monotonicNow;
  }

  async execute(input: ExecuteWorkInput): Promise<CapabilityWorkOutcomeV1<Fact>> {
    const rawIntent = input.intent;
    let intent = rawIntent;
    const start = now(this.clock);
    const phases: WorkPhaseReceipt[] = [];
    let currentPhase = "intent";
    let caller: Readonly<CallerAuthority> | null = null;
    let declaration: WorkClassDeclaration | null = null;
    let permitId: string | null = null;
    let queueWaitMs: number | null = null;
    let lane: SchedulerLane | null = null;
    let resource: SchedulerResource | null = null;
    let workKey: Hash = "0x" + "0".repeat(64) as Hash;
    let source: WorkSourceView = { chainId: "", number: "", hash: "", stateRoot: "" };
    try {
      intent = Object.freeze({
        ...rawIntent,
        ownerRef: opaqueCopy(rawIntent.ownerRef, "ownerRef"),
        capabilityRef: opaqueCopy(rawIntent.capabilityRef, "capabilityRef"),
        workClassRef: opaqueCopy(rawIntent.workClassRef, "workClassRef"),
        programInputRef: opaqueCopy(rawIntent.programInputRef, "programInputRef"),
        source: sourceCopy(rawIntent.source),
        generationLeaseRef: Object.freeze({
          ...rawIntent.generationLeaseRef,
          ref: opaqueCopy(rawIntent.generationLeaseRef.ref, "generationLeaseRef.ref"),
          source: sourceCopy(rawIntent.generationLeaseRef.source),
        }),
        frozenProgramRef: Object.freeze({ ...rawIntent.frozenProgramRef, ref: opaqueCopy(rawIntent.frozenProgramRef.ref, "frozenProgramRef.ref"), issuerRef: opaqueCopy(rawIntent.frozenProgramRef.issuerRef, "frozenProgramRef.issuerRef") }),
        programInput: canonicalProgramInput(rawIntent.programInput),
      });
      assertCapabilityWorkIntent(intent);
      source = sourceCopy(intent.source);
      workKey = intentKey(intent);
      const runPhase = async <T>(name: string, operation: () => Promise<T> | T): Promise<T> => {
        currentPhase = name;
        const phaseStart = now(this.clock);
        try {
          const result = await operation();
          phases.push(Object.freeze({ phase: name, startedAtMs: phaseStart, finishedAtMs: now(this.clock), status: "completed" }));
          return result;
        } catch (error) {
          phases.push(Object.freeze({ phase: name, startedAtMs: phaseStart, finishedAtMs: now(this.clock), status: "failed" }));
          throw error;
        }
      };
      await runPhase("intent", () => invokePort("invalid-intent", () => this.ports.decodeIntent(intent)));
      await runPhase("authority", () => invokePort("unknown-capability", () => this.ports.assertMembership({
        ownerRef: intent.ownerRef,
        capabilityRef: intent.capabilityRef,
        workClassRef: intent.workClassRef,
        programIssuerRef: intent.frozenProgramRef.issuerRef,
      })));
      await runPhase("authority", () => invokePort("lease-invalid", () => this.ports.fence.assertCurrent({ source, generationLeaseRef: intent.generationLeaseRef })));
      await runPhase("authority", () => {
        const issued = readWorkPlaneCallerCapability(input.caller);
        if (issued.scheduler !== this.ports.scheduler) {
          throw new TypeError("work-plane caller capability belongs to another scheduler");
        }
        if (issued.intentBindingHash !== workPlaneCallerIntentBindingHash(intent)) {
          throw new TypeError("work-plane caller capability belongs to another intent");
        }
        caller = issued.caller;
      });
      declaration = await runPhase("admission", () => invokePort("unknown-capability", () => this.ports.resolveWorkClass(intent)));
      if (declaration.phase !== intent.phase) throw new WorkPlanePortError("unknown-capability", new Error("work class phase declaration mismatch"));
      lane = declaration.lane;
      resource = declaration.resource;
      const work: SchedulerWorkDescriptor = Object.freeze({
        workId: String(intent.intentId),
        phase: intent.phase,
        workClassRef: refKey(intent.workClassRef),
        ownerRef: refKey(intent.ownerRef),
        lane: declaration.lane,
        resource: declaration.resource,
        cost: declaration.cost,
        quotaKey: declaration.quotaKey,
        deadlineAtMs: intent.consumerDeadline,
        signal: input.signal,
      });
      let result: ProgramResult;
      result = await runPhase("admission", () => this.ports.scheduler.run({
        work,
        caller: Object.freeze({ callerId: (caller as CallerAuthority).callerId, authorityToken: (caller as CallerAuthority).authorityToken }),
        execute: async (permit) => {
          permitId = permit.permitId;
          queueWaitMs = permit.queueWaitMs;
          return runPhase("transport", () => invokePortAsync("transport-error", () => this.ports.execute({ intent, signal: permit.signal, permit })));
        },
      }));
      await runPhase("pre-publication-fence", () => invokePort("source-stale", () => this.ports.fence.assertCurrent({ source, generationLeaseRef: intent.generationLeaseRef })));
      const fact = await runPhase("interpretation", () => invokePort("plugin-error", () => this.ports.interpret({ intent, result })));
      await runPhase("pre-publication-fence", () => invokePort("source-stale", () => this.ports.fence.assertCurrent({ source, generationLeaseRef: intent.generationLeaseRef })));
      const finished = now(this.clock);
      const receipt = freezeReceipt({
        intentId: String(intent.intentId),
        workKeyHash: workKey,
        ownerRef: intent.ownerRef,
        capabilityRef: intent.capabilityRef,
        workClassRef: intent.workClassRef,
        phase: intent.phase,
        source,
        generationLeaseRef: intent.generationLeaseRef,
        callerId: caller!.callerId,
        authorityTokenHash: authorityTokenHash(caller!),
        permitId,
        queueWaitMs,
        lane,
        resource,
        startedAtMs: start,
        finishedAtMs: finished,
        phases,
        outcome: "resolved",
        failureStage: null,
        failureCode: null,
      });
      return Object.freeze({ kind: "resolved" as const, fact, receipt });
    } catch (error) {
      const observedCode = errorCode(error);
      const code: WorkFailureCode = observedCode !== "failed-closed"
        ? observedCode
        : currentPhase === "intent"
          ? "invalid-intent"
          : currentPhase === "interpretation"
            ? "plugin-error"
            : currentPhase === "transport"
              ? "transport-error"
              : currentPhase === "authority"
                ? "caller-mismatch"
                : "failed-closed";
      const stage = failureStage(code, currentPhase as WorkFailureStage);
      const failure: WorkFailure = Object.freeze({
        stage,
        code,
        retryClass: ["invalid-program", "invalid-intent", "unknown-capability", "plugin-error", "caller-mismatch"].includes(code) ? "invalid-program" : "retryable",
        message: error instanceof Error ? error.message : String(error),
      });
      const finished = now(this.clock);
      const failedCaller = caller ?? Object.freeze({ callerId: "invalid", authorityToken: "invalid" });
      const failedLease = receiptLease(intent?.generationLeaseRef, source);
      const receipt = freezeReceipt({
        intentId: typeof intent?.intentId === "string" ? intent.intentId : "invalid",
        workKeyHash: workKey,
        ownerRef: receiptOpaque(intent?.ownerRef),
        capabilityRef: receiptOpaque(intent?.capabilityRef),
        workClassRef: receiptOpaque(intent?.workClassRef),
        phase: typeof intent?.phase === "string" ? intent.phase : "invalid",
        source,
        generationLeaseRef: failedLease,
        callerId: failedCaller.callerId,
        authorityTokenHash: authorityTokenHash(failedCaller),
        permitId,
        queueWaitMs,
        lane,
        resource,
        startedAtMs: start,
        finishedAtMs: finished,
        phases,
        outcome: "unresolved",
        failureStage: stage,
        failureCode: code,
      });
      return Object.freeze({ kind: "unresolved" as const, failure, receipt });
    }
  }
}

export async function executeWork<ProgramResult, Fact>(
  ports: WorkPlanePorts<ProgramResult, Fact>,
  input: ExecuteWorkInput,
): Promise<CapabilityWorkOutcomeV1<Fact>> {
  return new WorkPlane(ports).execute(input);
}
