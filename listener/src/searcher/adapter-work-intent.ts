import type {
  FamilyId,
  InstanceKey,
  RouteKey,
} from "./venues/adapter-family-identifiers.js";
import {
  assertIssuedBoundedRequestExecutor,
  createBoundedRequestExecutor,
  physicalRequestSetFingerprint,
  FamilyDecodeError,
  runRequestProgram,
  RequiredAdapterRequestError,
  type AdapterRequest,
  type AdapterRequestResult,
  type BoundedRequestExecutor,
  type CanonicalSource,
  type ExecutedProgram,
  type RequestProgram,
  type RequestRequirements,
  type StaticEvidenceProgramLike,
} from "./venues/adapter-request-program.js";
import { hashCanonical } from "./venues/canonical-value.js";
import type { AdapterFamilyLifecycleContentCache } from
  "./adapter-family-lifecycle-content-cache.js";
import type { AdapterFamilyExactQuoteCache } from
  "./adapter-family-exact-quote-cache.js";

export const ADAPTER_WORK_STAGES = Object.freeze([
  "identity",
  "instance-static",
  "pricing-static",
  "pricing-current",
  "runtime-evidence",
  "exact-refine",
] as const);

export type AdapterWorkStage = (typeof ADAPTER_WORK_STAGES)[number];
export type CentralWorkStage = AdapterWorkStage | "fork-final-sim";
export type CentralWorkClass = "head-critical" | "foreground" | "background";

export interface AdapterWorkIntent<Input, Evidence> {
  readonly stage: AdapterWorkStage;
  readonly familyId: FamilyId;
  readonly instanceKey?: InstanceKey;
  readonly routeKey?: RouteKey;
  readonly source: CanonicalSource;
  readonly generation: number;
  readonly program: RequestProgram<Input, Evidence>;
  readonly programInput: Input;
}

export interface FinalSimulationWorkIntent<ResolvedPlan> {
  readonly stage: "fork-final-sim";
  readonly source: CanonicalSource;
  readonly generation: number;
  readonly resolvedPlan: ResolvedPlan;
}

export type CentralWorkIntent<Input, Evidence, ResolvedPlan> =
  | AdapterWorkIntent<Input, Evidence>
  | FinalSimulationWorkIntent<ResolvedPlan>;

export interface AdapterWorkSubject {
  readonly familyId: FamilyId;
  readonly instanceKey?: InstanceKey;
  readonly routeKey?: RouteKey;
}

export interface CentralScheduleDecision {
  readonly lane:
    | "critical-proof"
    | "foreground"
    | "background"
    | "final-sim";
  readonly deadlineAtMs: number;
  readonly maxAttempts: number;
  readonly transportPool:
    | "state-read"
    | "trace"
    | "effect-sim"
    | "final-sim";
  readonly fairnessKey: string;
}

export type FinalSimulationScheduleDecision = CentralScheduleDecision & {
  readonly lane: "final-sim";
  readonly transportPool: "final-sim";
};

/** Framework-owned caller facts. Adapter programs can consume but never issue them. */
export interface CentralCallerAuthority {
  readonly executor?: string;
  readonly observedSender?: string;
  readonly verifiedActors?: Readonly<Record<string, string>>;
}

export interface CentralCallerAuthorityInput {
  readonly stage: AdapterWorkStage;
  readonly familyId: FamilyId;
  readonly subject: AdapterWorkSubject;
  readonly subjectKey: string;
  readonly source: CanonicalSource;
  readonly callerRole: NonNullable<RequestRequirements["caller"]>;
}

export interface CentralCallerAuthorityProvider {
  bind(input: CentralCallerAuthorityInput): CentralCallerAuthority;
}

export interface CentralAdapterPolicyInput {
  readonly workClass: CentralWorkClass;
  readonly stage: AdapterWorkStage;
  readonly familyId: FamilyId;
  readonly subject: AdapterWorkSubject;
  readonly subjectKey: string;
  readonly source: CanonicalSource;
  readonly requirements: RequestRequirements;
  readonly requestCount: number;
}

export interface CentralAdapterPolicy {
  bind(input: CentralAdapterPolicyInput): CentralScheduleDecision;
}

export interface CentralAdapterBudgets {
  assertAdmitted(
    schedule: CentralScheduleDecision,
    requests: readonly AdapterRequest[],
  ): void;
}

export interface AdapterGenerationFence {
  assertCurrent(generation: number, source: CanonicalSource): void;
}

export interface CentralSchedulerTiming {
  readonly queueWaitMs: number;
  readonly transportWallMs: number;
  readonly attempts: number;
}

export interface SchedulerIssuedAdapterExecutor {
  /** Existing scheduler/backend-owned executor; this layer never owns raw I/O. */
  readonly executor: BoundedRequestExecutor;
  timing(): CentralSchedulerTiming;
}

export interface CentralAdapterScheduler {
  issueExecutor(input: {
    readonly schedule: CentralScheduleDecision;
    readonly source: CanonicalSource;
    readonly generation: number;
    readonly subject: AdapterWorkSubject;
    readonly subjectKey: string;
    readonly requirements: RequestRequirements;
    readonly requests: readonly AdapterRequest[];
    readonly dedupeKey: string;
    readonly callerAuthority: CentralCallerAuthority;
    readonly control?: AdapterWorkControl;
  }): SchedulerIssuedAdapterExecutor;
}

export interface AdapterWorkControl {
  readonly deadlineAtMs?: number;
  readonly signal?: AbortSignal;
}

export interface AdapterWorkClock {
  nowMs(): number;
}

export interface CentralAdapterRuntime {
  readonly policy: CentralAdapterPolicy;
  readonly budgets: CentralAdapterBudgets;
  readonly scheduler: CentralAdapterScheduler;
  readonly callerAuthority: CentralCallerAuthorityProvider;
  readonly generationFence: AdapterGenerationFence;
  readonly clock: AdapterWorkClock;
  /** Optional for non-production harnesses; real runtimes own one bounded cache. */
  readonly staticEvidenceCache?: AdapterFamilyLifecycleContentCache;
  /** Completed exact results; always block-hash and compatibility bound. */
  readonly exactQuoteCache?: AdapterFamilyExactQuoteCache;
}

export interface CentralFinalSimulationPolicyInput<ResolvedPlan> {
  readonly source: CanonicalSource;
  readonly generation: number;
  readonly resolvedPlan: ResolvedPlan;
}

export interface CentralFinalSimulationRuntime<ResolvedPlan, Result> {
  readonly generationFence: AdapterGenerationFence;
  readonly policy: {
    bind(
      input: CentralFinalSimulationPolicyInput<ResolvedPlan>,
    ): CentralScheduleDecision;
  };
  readonly scheduler: {
    executeFinalSimulation(input: {
      readonly intent: FinalSimulationWorkIntent<ResolvedPlan>;
      readonly schedule: FinalSimulationScheduleDecision;
    }): Promise<Result>;
  };
}

export type AdapterWorkFailureStage =
  | "intent"
  | "generation-fence-before-io"
  | "requirements"
  | "caller-authority"
  | "request-build"
  | "policy"
  | "admission"
  | "scheduler-issue"
  | "queue"
  | "transport"
  | "generation-fence-after-io"
  | "decode"
  | "generation-fence-before-publication"
  | "telemetry";

export type AdapterWorkFailureCode =
  | "invalid-intent"
  | "stale-generation"
  | "invalid-program"
  | "family-decode"
  | "chain-proven-rejected"
  | "authority-failure"
  | "policy-failure"
  | "admission-failure"
  | "scheduler-failure"
  | "ingress-full"
  | "rpc"
  | "deadline"
  | "aborted"
  | "resource-limited"
  | "decode-failure"
  | "telemetry-failure";

export interface AdapterWorkFailure {
  /** Framework failures never constitute protocol behavior rejection. */
  readonly disposition: "unresolved";
  readonly stage: AdapterWorkFailureStage;
  readonly code: AdapterWorkFailureCode;
  readonly message: string;
}

export interface AdapterWorkTiming {
  readonly startedAtMs: number;
  readonly completedAtMs: number;
  readonly declarationWallMs: number;
  readonly policyWallMs: number;
  readonly admissionWallMs: number;
  readonly queueWaitMs: number;
  readonly transportWallMs: number;
  readonly decodeWallMs: number;
  readonly totalWallMs: number;
  readonly attempts: number;
}

export interface AdapterWorkReceipt {
  readonly workClass: CentralWorkClass;
  readonly stage: AdapterWorkStage;
  readonly familyId: FamilyId;
  readonly subject: AdapterWorkSubject;
  readonly subjectKey: string;
  readonly source: CanonicalSource;
  readonly generation: number;
  readonly schedule: CentralScheduleDecision | null;
  readonly dedupeKey: string | null;
  readonly timing: AdapterWorkTiming;
  readonly failureStage: AdapterWorkFailureStage | null;
}

export interface ResolvedAdapterWork<Evidence> {
  readonly status: "resolved";
  readonly executed: ExecutedProgram<Evidence>;
  readonly receipt: AdapterWorkReceipt;
}

export interface UnresolvedAdapterWork {
  readonly status: "unresolved";
  readonly failure: AdapterWorkFailure;
  readonly receipt: AdapterWorkReceipt;
}

export type AdapterWorkOutcome<Evidence> =
  | ResolvedAdapterWork<Evidence>
  | UnresolvedAdapterWork;

export type CentralAdapterSchedulerFailureCode =
  | "ingress-full"
  | "rpc"
  | "deadline"
  | "aborted"
  | "resource-limited";

/** Lets an injected central scheduler preserve queue-vs-transport attribution. */
export class CentralAdapterSchedulerError extends Error {
  readonly failureStage: "queue" | "transport";
  readonly failureCode: CentralAdapterSchedulerFailureCode;

  constructor(input: {
    readonly stage: "queue" | "transport";
    readonly code: CentralAdapterSchedulerFailureCode;
    readonly message: string;
  }) {
    super(input.message);
    this.name = "CentralAdapterSchedulerError";
    this.failureStage = input.stage;
    this.failureCode = input.code;
  }
}

const ADAPTER_STAGE_SET = new Set<string>(ADAPTER_WORK_STAGES);
const LANES = new Set<CentralScheduleDecision["lane"]>([
  "critical-proof",
  "foreground",
  "background",
  "final-sim",
]);
const TRANSPORT_POOLS = new Set<CentralScheduleDecision["transportPool"]>([
  "state-read",
  "trace",
  "effect-sim",
  "final-sim",
]);
const FORBIDDEN_INTENT_SCHEDULE_FIELDS = Object.freeze([
  "workClass",
  "lane",
  "deadlineAtMs",
  "maxAttempts",
  "transportPool",
  "fairnessKey",
  "schedule",
  "callerAuthority",
  "executor",
  "observedSender",
  "verifiedActor",
  "verifiedActors",
] as const);

export function adapterWorkSubjectKey(subject: AdapterWorkSubject): string {
  return `adapter-subject:${hashCanonical({
    familyId: subject.familyId,
    instanceKey: subject.instanceKey ?? null,
    routeKey: subject.routeKey ?? null,
  })}`;
}

export function frameworkWorkClassForAdapterStage(
  stage: AdapterWorkStage,
): CentralWorkClass {
  switch (stage) {
    case "identity":
    case "instance-static":
      return "background";
    case "runtime-evidence":
      return "head-critical";
    case "pricing-static":
    case "pricing-current":
    case "exact-refine":
      return "foreground";
  }
}

export function canonicalAdapterWorkDedupeKey(input: {
  readonly intent: Pick<
    AdapterWorkIntent<unknown, unknown>,
    "source" | "generation"
  >;
  readonly requirements: RequestRequirements;
  readonly requests: readonly AdapterRequest[];
}): string {
  return `adapter-work:${hashCanonical({
    source: {
      number: input.intent.source.number,
      hash: input.intent.source.hash.toLowerCase(),
      generation: input.intent.source.generation,
    },
    generation: input.intent.generation,
    requirements: {
      transports: [...input.requirements.transports].sort(),
      caller: input.requirements.caller ?? null,
      completions: [...(input.requirements.completions ?? [])].sort(),
      effects: [...(input.requirements.effects ?? [])].sort(),
    },
    requestSet: physicalRequestSetFingerprint(input.requests),
  })}`;
}

/**
 * Upper scheduling plane for Adapter RequestPrograms. The injected scheduler
 * remains the sole owner of queues, physical permits, batching and transport.
 */
export async function executeAdapterWork<Input, Evidence>(input: {
  readonly intent: AdapterWorkIntent<Input, Evidence>;
  readonly runtime: CentralAdapterRuntime;
  readonly control?: AdapterWorkControl;
}): Promise<AdapterWorkOutcome<Evidence>> {
  const { intent, runtime } = input;
  let phase: AdapterWorkFailureStage = "intent";
  let startedAtMs = safeNow(runtime.clock, 0);
  let declarationWallMs = 0;
  let policyWallMs = 0;
  let admissionWallMs = 0;
  let decodeWallMs = 0;
  let schedule: CentralScheduleDecision | null = null;
  let dedupeKey: string | null = null;
  let issued: SchedulerIssuedAdapterExecutor | null = null;
  let callerAuthority: CentralCallerAuthority | null = null;
  let subject: AdapterWorkSubject = Object.freeze({
    familyId: intent.familyId,
  });
  let subjectKey = "";
  let source = Object.freeze({ ...intent.source });

  try {
    assertIntent(intent);
    startedAtMs = now(runtime.clock);
    source = Object.freeze({ ...intent.source });
    subject = freezeSubject(intent);
    subjectKey = adapterWorkSubjectKey(subject);

    phase = "generation-fence-before-io";
    assertAdapterWorkControl(input.control);
    runtime.generationFence.assertCurrent(intent.generation, source);

    let declaredRequirements: RequestRequirements | null = null;
    const callerBindings: Array<Parameters<
      BoundedRequestExecutor["assertCallerBinding"]
    >[0]> = [];
    const programMethods = {
      requirements(programInput: Input): RequestRequirements {
        phase = "requirements";
        const before = now(runtime.clock);
        try {
          return intent.program.requirements(programInput);
        } finally {
          declarationWallMs += elapsed(before, now(runtime.clock));
        }
      },
      buildRequests(programInput: Input): readonly AdapterRequest[] {
        phase = "request-build";
        const before = now(runtime.clock);
        try {
          return intent.program.buildRequests(programInput);
        } finally {
          declarationWallMs += elapsed(before, now(runtime.clock));
        }
      },
      decode(decodeInput: {
        readonly programInput: Input;
        readonly results: readonly AdapterRequestResult[];
      }): Evidence {
        phase = "decode";
        const before = now(runtime.clock);
        try {
          return intent.program.decode(decodeInput);
        } finally {
          decodeWallMs += elapsed(before, now(runtime.clock));
        }
      },
    };
    const measuredProgram: RequestProgram<Input, Evidence> =
      isStaticEvidenceProgram(intent.program)
        ? Object.freeze({
            ...programMethods,
            reusePolicy: intent.program.reusePolicy,
          }) as StaticEvidenceProgramLike<Input, Evidence>
        : Object.freeze(programMethods);

    const bridgeExecutor = createBoundedRequestExecutor({
      assertSupported(requirements) {
        declaredRequirements = requirements;
        phase = "caller-authority";
        callerAuthority = freezeCallerAuthority(runtime.callerAuthority.bind({
          stage: intent.stage,
          familyId: intent.familyId,
          subject,
          subjectKey,
          source,
          callerRole: requirements.caller ?? "none",
        }));
      },
      assertCallerBinding(binding) {
        if (
          binding.familyId !== intent.familyId ||
          binding.source.number !== source.number ||
          binding.source.hash.toLowerCase() !== source.hash.toLowerCase() ||
          binding.source.generation !== source.generation
        ) {
          throw new Error("central caller binding escaped its work intent");
        }
        if (callerAuthority === null) {
          throw new Error("central caller authority was not bound");
        }
        assertCallerAuthorized(binding, callerAuthority);
        callerBindings.push(Object.freeze({
          ...binding,
          source: Object.freeze({ ...binding.source }),
        }));
      },
      assertWithinBudget(familyId, requests) {
        if (familyId !== intent.familyId || declaredRequirements === null) {
          throw new Error("central RequestProgram preparation order mismatch");
        }

        phase = "policy";
        const policyBefore = now(runtime.clock);
        try {
          const bound = runtime.policy.bind({
            workClass: frameworkWorkClassForAdapterStage(intent.stage),
            stage: intent.stage,
            familyId: intent.familyId,
            subject,
            subjectKey,
            source,
            requirements: declaredRequirements,
            requestCount: requests.length,
          });
          schedule = freezeAdapterSchedule({
            ...bound,
            deadlineAtMs: Math.min(
              bound.deadlineAtMs,
              input.control?.deadlineAtMs ?? Number.POSITIVE_INFINITY,
            ),
          }, intent.stage);
        } finally {
          policyWallMs += elapsed(policyBefore, now(runtime.clock));
        }

        phase = "admission";
        const admissionBefore = now(runtime.clock);
        try {
          runtime.budgets.assertAdmitted(schedule, requests);
        } finally {
          admissionWallMs += elapsed(admissionBefore, now(runtime.clock));
        }

        dedupeKey = canonicalAdapterWorkDedupeKey({
          intent: {
            source,
            generation: intent.generation,
          },
          requirements: declaredRequirements,
          requests,
        });

        phase = "scheduler-issue";
        issued = runtime.scheduler.issueExecutor({
          schedule,
          source,
          generation: intent.generation,
          subject,
          subjectKey,
          requirements: declaredRequirements,
          requests,
          dedupeKey,
          callerAuthority: callerAuthority ?? EMPTY_CALLER_AUTHORITY,
          ...(input.control === undefined ? {} : { control: input.control }),
        });
        assertIssuedExecutor(issued);
        issued.executor.assertSupported(declaredRequirements);
        for (const binding of callerBindings) {
          issued.executor.assertCallerBinding(binding);
        }
        issued.executor.assertWithinBudget(familyId, requests);
      },
      async execute(executionInput) {
        const scheduled = issued as SchedulerIssuedAdapterExecutor | null;
        if (scheduled === null) {
          throw new Error("central scheduler executor was not issued");
        }

        phase = "generation-fence-before-io";
        assertAdapterWorkControl(input.control);
        runtime.generationFence.assertCurrent(intent.generation, source);

        phase = "transport";
        const results = await scheduled.executor.execute(executionInput);

        phase = "generation-fence-after-io";
        assertAdapterWorkControl(input.control);
        runtime.generationFence.assertCurrent(intent.generation, source);

        phase = "transport";
        if (!Array.isArray(results)) {
          throw new Error("central scheduler executor returned a non-array result set");
        }
        return results;
      },
      sealStaticEvidenceReuseProof(proofInput) {
        const scheduled = issued as SchedulerIssuedAdapterExecutor | null;
        if (scheduled === null) {
          throw new Error("central scheduler executor was not issued");
        }
        phase = "decode";
        return scheduled.executor.sealStaticEvidenceReuseProof(proofInput);
      },
    });

    const executed = await runRequestProgram({
      familyId: intent.familyId,
      program: measuredProgram,
      programInput: intent.programInput,
      source,
      executor: bridgeExecutor,
    });

    phase = "generation-fence-before-publication";
    runtime.generationFence.assertCurrent(intent.generation, source);

    phase = "telemetry";
    const schedulerTiming = readSchedulerTiming(issued);
    const completedAtMs = now(runtime.clock);
    const receipt = sealReceipt({
      intent,
      subject,
      subjectKey,
      source,
      schedule,
      dedupeKey,
      timing: {
        startedAtMs,
        completedAtMs,
        declarationWallMs,
        policyWallMs,
        admissionWallMs,
        queueWaitMs: schedulerTiming.queueWaitMs,
        transportWallMs: schedulerTiming.transportWallMs,
        decodeWallMs,
        totalWallMs: elapsed(startedAtMs, completedAtMs),
        attempts: schedulerTiming.attempts,
      },
      failureStage: null,
    });
    return Object.freeze({
      status: "resolved" as const,
      executed,
      receipt,
    });
  } catch (error) {
    const failure = freezeFailure(error, phase);
    const schedulerTiming = safeSchedulerTiming(issued);
    const completedAtMs = safeNow(runtime.clock, startedAtMs);
    const receipt = sealReceipt({
      intent,
      subject,
      subjectKey,
      source,
      schedule,
      dedupeKey,
      timing: {
        startedAtMs,
        completedAtMs,
        declarationWallMs,
        policyWallMs,
        admissionWallMs,
        queueWaitMs: schedulerTiming.queueWaitMs,
        transportWallMs: schedulerTiming.transportWallMs,
        decodeWallMs,
        totalWallMs: elapsed(startedAtMs, completedAtMs),
        attempts: schedulerTiming.attempts,
      },
      failureStage: failure.stage,
    });
    return Object.freeze({
      status: "unresolved" as const,
      failure,
      receipt,
    });
  }
}

/**
 * Typed reserved-pool boundary for mandatory final simulation. This module does
 * not install a production runtime; a composition root must inject the real
 * fork scheduler explicitly before this path can execute.
 */
export async function executeFinalSimulationWork<ResolvedPlan, Result>(input: {
  readonly intent: FinalSimulationWorkIntent<ResolvedPlan>;
  readonly runtime: CentralFinalSimulationRuntime<ResolvedPlan, Result>;
}): Promise<Result> {
  assertFinalSimulationIntent(input.intent);
  input.runtime.generationFence.assertCurrent(
    input.intent.generation,
    input.intent.source,
  );
  const schedule = freezeFinalSimulationSchedule(
    input.runtime.policy.bind({
      source: input.intent.source,
      generation: input.intent.generation,
      resolvedPlan: input.intent.resolvedPlan,
    }),
  );
  const result = await input.runtime.scheduler.executeFinalSimulation({
    intent: input.intent,
    schedule,
  });
  input.runtime.generationFence.assertCurrent(
    input.intent.generation,
    input.intent.source,
  );
  return result;
}

function isStaticEvidenceProgram<Input, Evidence>(
  program: RequestProgram<Input, Evidence>,
): program is StaticEvidenceProgramLike<Input, Evidence> {
  return "reusePolicy" in program;
}

function assertIntent<Input, Evidence>(
  intent: AdapterWorkIntent<Input, Evidence>,
): void {
  if (!ADAPTER_STAGE_SET.has(intent.stage)) {
    throw new Error(`unsupported Adapter work stage: ${String(intent.stage)}`);
  }
  if (typeof intent.familyId !== "string" || intent.familyId.length === 0) {
    throw new Error("Adapter work familyId must be non-empty");
  }
  if (!Number.isSafeInteger(intent.generation) || intent.generation < 0) {
    throw new Error("Adapter work generation must be a non-negative safe integer");
  }
  if (
    !Number.isSafeInteger(intent.source.number) ||
    intent.source.number < 0 ||
    !Number.isSafeInteger(intent.source.generation) ||
    intent.source.generation < 0 ||
    !/^0x[0-9a-fA-F]{64}$/.test(intent.source.hash)
  ) {
    throw new Error("Adapter work source must be canonical");
  }
  if (intent.generation !== intent.source.generation) {
    throw new Error("Adapter work generation must match its canonical source");
  }
  for (const [label, value] of [
    ["instanceKey", intent.instanceKey],
    ["routeKey", intent.routeKey],
  ] as const) {
    if (value !== undefined && (value.length === 0 || value.trim() !== value)) {
      throw new Error(`Adapter work ${label} must be non-empty and normalized`);
    }
  }
  if (
    intent.program === null ||
    typeof intent.program !== "object" ||
    typeof intent.program.requirements !== "function" ||
    typeof intent.program.buildRequests !== "function" ||
    typeof intent.program.decode !== "function"
  ) {
    throw new Error("Adapter work program must implement RequestProgram");
  }
  for (const field of FORBIDDEN_INTENT_SCHEDULE_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(intent, field)) {
      throw new Error(`Adapter work intent must not declare central field ${field}`);
    }
  }
}

function assertAdapterWorkControl(control: AdapterWorkControl | undefined): void {
  if (control === undefined) return;
  if (control.signal?.aborted) {
    throw control.signal.reason ?? new Error("adapter work aborted");
  }
  if (
    control.deadlineAtMs !== undefined &&
    Date.now() >= control.deadlineAtMs
  ) {
    throw new Error("adapter work deadline reached");
  }
}

function assertFinalSimulationIntent<ResolvedPlan>(
  intent: FinalSimulationWorkIntent<ResolvedPlan>,
): void {
  if (intent === null || typeof intent !== "object") {
    throw new Error("final simulation intent must be an object");
  }
  if (intent.stage !== "fork-final-sim") {
    throw new Error("final simulation intent must use fork-final-sim stage");
  }
  assertIntentSource(intent.generation, intent.source, "final simulation");
  if (intent.resolvedPlan === null || intent.resolvedPlan === undefined) {
    throw new Error("final simulation intent requires a resolved plan");
  }
  for (const field of FORBIDDEN_INTENT_SCHEDULE_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(intent, field)) {
      throw new Error(
        `final simulation intent must not declare central field ${field}`,
      );
    }
  }
}

function assertIntentSource(
  generation: number,
  source: CanonicalSource,
  label: string,
): void {
  if (
    !Number.isSafeInteger(generation) ||
    generation < 0 ||
    source === null ||
    typeof source !== "object" ||
    !Number.isSafeInteger(source.number) ||
    source.number < 0 ||
    !Number.isSafeInteger(source.generation) ||
    source.generation < 0 ||
    !/^0x[0-9a-fA-F]{64}$/.test(source.hash)
  ) {
    throw new Error(`${label} source must be canonical`);
  }
  if (generation !== source.generation) {
    throw new Error(`${label} generation must match its canonical source`);
  }
}

function freezeSubject<Input, Evidence>(
  intent: AdapterWorkIntent<Input, Evidence>,
): AdapterWorkSubject {
  return Object.freeze({
    familyId: intent.familyId,
    ...(intent.instanceKey === undefined
      ? {}
      : { instanceKey: intent.instanceKey }),
    ...(intent.routeKey === undefined ? {} : { routeKey: intent.routeKey }),
  });
}

function freezeScheduleDecision(
  schedule: CentralScheduleDecision,
): CentralScheduleDecision {
  if (schedule === null || typeof schedule !== "object") {
    throw new Error("central policy must return a schedule decision");
  }
  if (!LANES.has(schedule.lane)) {
    throw new Error(`central policy returned unsupported lane ${String(schedule.lane)}`);
  }
  if (!Number.isFinite(schedule.deadlineAtMs)) {
    throw new Error("central policy deadline must be finite");
  }
  if (!Number.isInteger(schedule.maxAttempts) || schedule.maxAttempts < 1) {
    throw new Error("central policy maxAttempts must be a positive integer");
  }
  if (!TRANSPORT_POOLS.has(schedule.transportPool)) {
    throw new Error(
      `central policy returned unsupported transport pool ${String(schedule.transportPool)}`,
    );
  }
  if (
    typeof schedule.fairnessKey !== "string" ||
    schedule.fairnessKey.length === 0 ||
    schedule.fairnessKey.trim() !== schedule.fairnessKey
  ) {
    throw new Error("central policy fairnessKey must be non-empty and normalized");
  }
  return Object.freeze({ ...schedule });
}

function freezeAdapterSchedule(
  schedule: CentralScheduleDecision,
  stage: AdapterWorkStage,
): CentralScheduleDecision {
  const frozen = freezeScheduleDecision(schedule);
  if (frozen.lane === "final-sim" || frozen.transportPool === "final-sim") {
    throw new Error(
      `Adapter stage ${stage} cannot consume the reserved final-sim lane or pool`,
    );
  }
  return frozen;
}

function freezeFinalSimulationSchedule(
  schedule: CentralScheduleDecision,
): FinalSimulationScheduleDecision {
  const frozen = freezeScheduleDecision(schedule);
  if (frozen.lane !== "final-sim" || frozen.transportPool !== "final-sim") {
    throw new Error(
      "final simulation must use the reserved final-sim lane and pool",
    );
  }
  return frozen as FinalSimulationScheduleDecision;
}

const EMPTY_CALLER_AUTHORITY: CentralCallerAuthority = Object.freeze({});

function freezeCallerAuthority(
  authority: CentralCallerAuthority,
): CentralCallerAuthority {
  if (
    authority === null ||
    typeof authority !== "object" ||
    Array.isArray(authority)
  ) {
    throw new Error("central caller authority must be an object");
  }
  const allowed = new Set(["executor", "observedSender", "verifiedActors"]);
  for (const key of Reflect.ownKeys(authority)) {
    if (typeof key !== "string" || !allowed.has(key)) {
      throw new Error(`central caller authority has unknown field ${String(key)}`);
    }
  }
  const executor = authority.executor === undefined
    ? undefined
    : normalizeAuthorityAddress(authority.executor, "executor");
  const observedSender = authority.observedSender === undefined
    ? undefined
    : normalizeAuthorityAddress(authority.observedSender, "observed sender");
  const verifiedActors = freezeVerifiedActors(authority.verifiedActors);
  return Object.freeze({
    ...(executor === undefined ? {} : { executor }),
    ...(observedSender === undefined ? {} : { observedSender }),
    ...(Object.keys(verifiedActors).length === 0
      ? {}
      : { verifiedActors }),
  });
}

function assertCallerAuthorized(
  binding: Parameters<BoundedRequestExecutor["assertCallerBinding"]>[0],
  authority: CentralCallerAuthority,
): void {
  switch (binding.callerRef.kind) {
    case "executor":
      if (authority.executor === undefined) {
        throw new Error("central executor caller authority is missing");
      }
      return;
    case "observed-sender":
      if (authority.observedSender === undefined) {
        throw new Error("central observed-sender caller authority is missing");
      }
      return;
    case "verified-actor": {
      const actor = authority.verifiedActors?.[binding.callerRef.evidenceId];
      if (actor === undefined) {
        throw new Error(
          `verified actor evidence ${binding.callerRef.evidenceId} is absent ` +
            "from the central caller authority",
        );
      }
      return;
    }
  }
}

function freezeVerifiedActors(
  actors: CentralCallerAuthority["verifiedActors"],
): Readonly<Record<string, string>> {
  if (actors === undefined) return Object.freeze({});
  if (actors === null || typeof actors !== "object" || Array.isArray(actors)) {
    throw new Error("central verified actor authority must be an evidence map");
  }
  const entries = Object.entries(actors).sort(([left], [right]) =>
    left.localeCompare(right)
  );
  const resolved: Record<string, string> = {};
  for (const [evidenceId, actor] of entries) {
    if (
      evidenceId.length === 0 || evidenceId.trim() !== evidenceId ||
      Object.hasOwn(resolved, evidenceId)
    ) {
      throw new Error("central verified actor evidence id must be unique and canonical");
    }
    resolved[evidenceId] = normalizeAuthorityAddress(
      actor,
      `verified actor ${evidenceId}`,
    );
  }
  return Object.freeze(resolved);
}

function normalizeAuthorityAddress(value: string, label: string): string {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value)) {
    throw new Error(`central ${label} authority must be a 20-byte address`);
  }
  return value.toLowerCase();
}

function assertIssuedExecutor(
  issued: SchedulerIssuedAdapterExecutor,
): void {
  if (
    issued === null ||
    typeof issued !== "object" ||
    issued.executor === null ||
    typeof issued.executor !== "object" ||
    typeof issued.executor.assertSupported !== "function" ||
    typeof issued.executor.assertCallerBinding !== "function" ||
    typeof issued.executor.assertWithinBudget !== "function" ||
    typeof issued.executor.execute !== "function" ||
    typeof issued.executor.sealStaticEvidenceReuseProof !== "function" ||
    typeof issued.timing !== "function"
  ) {
    throw new Error("central scheduler must issue a bounded RequestProgram executor");
  }
  assertIssuedBoundedRequestExecutor(issued.executor);
}

function readSchedulerTiming(
  issued: SchedulerIssuedAdapterExecutor | null,
): CentralSchedulerTiming {
  if (issued === null) return ZERO_SCHEDULER_TIMING;
  const timing = issued.timing();
  if (
    !Number.isFinite(timing.queueWaitMs) ||
    timing.queueWaitMs < 0 ||
    !Number.isFinite(timing.transportWallMs) ||
    timing.transportWallMs < 0 ||
    !Number.isInteger(timing.attempts) ||
    timing.attempts < 0
  ) {
    throw new Error("central scheduler returned invalid timing telemetry");
  }
  return Object.freeze({ ...timing });
}

function safeSchedulerTiming(
  issued: SchedulerIssuedAdapterExecutor | null,
): CentralSchedulerTiming {
  try {
    return readSchedulerTiming(issued);
  } catch {
    return ZERO_SCHEDULER_TIMING;
  }
}

const ZERO_SCHEDULER_TIMING: CentralSchedulerTiming = Object.freeze({
  queueWaitMs: 0,
  transportWallMs: 0,
  attempts: 0,
});

function freezeFailure(
  error: unknown,
  phase: AdapterWorkFailureStage,
): AdapterWorkFailure {
  if (error instanceof CentralAdapterSchedulerError) {
    return Object.freeze({
      disposition: "unresolved" as const,
      stage: error.failureStage,
      code: error.failureCode,
      message: error.message,
    });
  }
  if (error instanceof FamilyDecodeError) {
    // A Family decode failure is never chain evidence: whether a reverted
    // or empty result negates identity is the Family's own decision
    // (chain-proven-rejected). Transport-uncertain sets stay retryable;
    // fully deterministic sets are Family program errors that must never
    // become terminal rejections and are never auto-retried into one.
    return Object.freeze({
      disposition: "unresolved" as const,
      stage: "decode" as const,
      code: error.uncertainty === "transport"
        ? "decode-failure" as const
        : "family-decode" as const,
      message: error.message,
    });
  }
  if (error instanceof RequiredAdapterRequestError) {
    return Object.freeze({
      disposition: "unresolved" as const,
      stage: "transport" as const,
      code: error.failureCode,
      message: error.message,
    });
  }
  return Object.freeze({
    disposition: "unresolved" as const,
    stage: phase,
    code: failureCodeForStage(phase),
    message: error instanceof Error ? error.message : String(error),
  });
}

function failureCodeForStage(
  stage: AdapterWorkFailureStage,
): AdapterWorkFailureCode {
  switch (stage) {
    case "intent":
      return "invalid-intent";
    case "generation-fence-before-io":
    case "generation-fence-after-io":
    case "generation-fence-before-publication":
      return "stale-generation";
    case "requirements":
    case "request-build":
      return "invalid-program";
    case "caller-authority":
      return "authority-failure";
    case "policy":
      return "policy-failure";
    case "admission":
      return "admission-failure";
    case "scheduler-issue":
    case "queue":
    case "transport":
      return "scheduler-failure";
    case "decode":
      return "decode-failure";
    case "telemetry":
      return "telemetry-failure";
  }
}

function sealReceipt<Input, Evidence>(input: {
  readonly intent: AdapterWorkIntent<Input, Evidence>;
  readonly subject: AdapterWorkSubject;
  readonly subjectKey: string;
  readonly source: CanonicalSource;
  readonly schedule: CentralScheduleDecision | null;
  readonly dedupeKey: string | null;
  readonly timing: AdapterWorkTiming;
  readonly failureStage: AdapterWorkFailureStage | null;
}): AdapterWorkReceipt {
  return Object.freeze({
    workClass: frameworkWorkClassForAdapterStage(input.intent.stage),
    stage: input.intent.stage,
    familyId: input.intent.familyId,
    subject: input.subject,
    subjectKey: input.subjectKey,
    source: input.source,
    generation: input.intent.generation,
    schedule: input.schedule,
    dedupeKey: input.dedupeKey,
    timing: Object.freeze({ ...input.timing }),
    failureStage: input.failureStage,
  });
}

function now(clock: AdapterWorkClock): number {
  const value = clock.nowMs();
  if (!Number.isFinite(value)) {
    throw new Error("central Adapter work clock must return a finite value");
  }
  return value;
}

function safeNow(clock: AdapterWorkClock, fallback: number): number {
  try {
    return now(clock);
  } catch {
    return fallback;
  }
}

function elapsed(start: number, end: number): number {
  return Math.max(0, end - start);
}
