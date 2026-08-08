import { createHash } from "node:crypto";
import { compilePlan } from "../shared/compiler/compiler.js";
import { bytesToHex } from "../shared/compiler/encoder.js";
import type {
  AdapterGenerationFence,
  CentralFinalSimulationPolicyInput,
  CentralFinalSimulationRuntime,
  FinalSimulationScheduleDecision,
  FinalSimulationWorkIntent,
} from "./adapter-work-intent.js";
import type { ResolvedPlan } from "./solver/solver.js";
import type {
  BotVMSimulator,
  SimulationResult,
} from "./simulator/botvm-simulator.js";
import type { CanonicalSource } from "./venues/adapter-request-program.js";

export type FinalSimulationRuntimeFailureCode =
  | "timeout"
  | "aborted"
  | "resource-failure"
  | "ingress-full"
  | "stale-generation"
  | "plan-integrity"
  | "invalid-schedule";

export type FinalSimulationRuntimeFailureStage =
  | "before-queue"
  | "queue"
  | "before-simulation"
  | "simulation"
  | "before-publication";

/** Infrastructure failures are unresolved; they never prove route behavior. */
export class FinalSimulationWorkRuntimeError extends Error {
  readonly disposition = "unresolved" as const;

  constructor(
    readonly failureCode: FinalSimulationRuntimeFailureCode,
    readonly failureStage: FinalSimulationRuntimeFailureStage,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "FinalSimulationWorkRuntimeError";
  }
}

export interface ReservedFinalSimulationResource<Resource> {
  readonly id: string;
  /** This resource is transferred exclusively to the final-sim runtime. */
  readonly value: Resource;
}

export interface FinalSimulationPlanIdentity<ResolvedPlan, Result> {
  /** Exact execution bytes derived at the trusted central plan boundary. */
  bytesHex(plan: ResolvedPlan): string;
  /** Optional pre-existing commitment; it must not be derived from new bytes. */
  expectedSha256?(plan: ResolvedPlan): string | undefined;
  /** When the real runner exposes executed bytes, bind them to the same plan. */
  resultBytesHex?(result: Result): string | undefined;
}

export interface FinalSimulationRunnerInput<Resource, ResolvedPlan> {
  readonly resource: Resource;
  readonly source: CanonicalSource;
  readonly generation: number;
  /** The exact object from FinalSimulationWorkIntent; the bridge never clones it. */
  readonly resolvedPlan: ResolvedPlan;
  readonly resolvedPlanBytesHex: string;
  readonly resolvedPlanSha256: string;
  readonly schedule: FinalSimulationScheduleDecision;
  readonly signal: AbortSignal;
}

export interface MandatoryFinalSimulationRunner<Resource, ResolvedPlan, Result> {
  simulate(
    input: FinalSimulationRunnerInput<Resource, ResolvedPlan>,
  ): Promise<Result>;
  /** Must synchronously make an interrupted resource unavailable for reuse. */
  terminate?(input: {
    readonly resource: Resource;
    readonly reason: FinalSimulationWorkRuntimeError;
  }): void;
}

export interface FinalSimulationTelemetryReceipt {
  readonly source: CanonicalSource;
  readonly generation: number;
  readonly lane: "final-sim";
  readonly transportPool: "final-sim";
  readonly fairnessKey: string;
  readonly resourceId: string | null;
  readonly resolvedPlanSha256: string | null;
  readonly status: "succeeded" | "unresolved";
  readonly failureCode: FinalSimulationRuntimeFailureCode | null;
  readonly failureStage: FinalSimulationRuntimeFailureStage | null;
  readonly queuedAtMs: number;
  readonly simulationStartedAtMs: number | null;
  readonly completedAtMs: number;
  readonly queueWaitMs: number;
  readonly simulationWallMs: number;
  readonly totalWallMs: number;
}

export interface FinalSimulationWorkRuntimeOptions<
  Resource,
  ResolvedPlan,
  Result,
> {
  /** A dedicated set: do not also register these resources with exact/discovery. */
  readonly reservedResources:
    readonly ReservedFinalSimulationResource<Resource>[];
  readonly runner: MandatoryFinalSimulationRunner<Resource, ResolvedPlan, Result>;
  readonly generationFence: AdapterGenerationFence;
  readonly planIdentity: FinalSimulationPlanIdentity<ResolvedPlan, Result>;
  readonly timeoutMs: number;
  /** Optional outer pass deadline; it may only shorten the stage timeout. */
  readonly deadlineAtMsForIntent?: (
    intent: FinalSimulationWorkIntent<ResolvedPlan>,
  ) => number;
  /** Waiting backlog only; active simulations are bounded by reservedResources. */
  readonly maxQueued: number;
  readonly nowMs?: () => number;
  readonly signalForIntent?: (
    intent: FinalSimulationWorkIntent<ResolvedPlan>,
  ) => AbortSignal | undefined;
  readonly parentSignal?: AbortSignal;
  readonly onTelemetry?: (receipt: FinalSimulationTelemetryReceipt) => void;
}

export interface FinalSimulationWorkRuntime<ResolvedPlan, Result>
  extends CentralFinalSimulationRuntime<ResolvedPlan, Result> {
  snapshot(): Readonly<{
    readonly active: number;
    readonly queued: number;
    readonly healthyResources: number;
    readonly retiredResources: number;
    readonly completed: number;
    readonly unresolved: number;
    readonly telemetryFailures: number;
    readonly lastReceipt: FinalSimulationTelemetryReceipt | null;
  }>;
  close(reason?: unknown): void;
}

interface CapturedPlanIdentity {
  readonly bytesHex: string;
  readonly sha256: string;
  readonly expectedSha256: string | null;
}

interface RuntimeResource<Resource> {
  readonly id: string;
  readonly value: Resource;
}

interface RuntimeTask<Resource, ResolvedPlan, Result> {
  readonly intent: FinalSimulationWorkIntent<ResolvedPlan>;
  readonly schedule: FinalSimulationScheduleDecision;
  readonly source: CanonicalSource;
  readonly generation: number;
  readonly plan: ResolvedPlan;
  readonly identity: CapturedPlanIdentity;
  readonly queuedAtMs: number;
  readonly controller: AbortController;
  detachSignals: () => void;
  readonly deadlineTimer: ReturnType<typeof setTimeout>;
  readonly resolve: (result: Result) => void;
  readonly reject: (error: FinalSimulationWorkRuntimeError) => void;
  state: "queued" | "active" | "settled";
  resourceId: string | null;
  simulationStartedAtMs: number | null;
}

class DeadlineSignal extends Error {
  constructor() {
    super("mandatory final simulation deadline reached");
    this.name = "DeadlineSignal";
  }
}

class ParentAbortSignal extends Error {
  constructor(readonly originalReason: unknown) {
    super("mandatory final simulation aborted");
    this.name = "ParentAbortSignal";
  }
}

/**
 * Composition-ready upper scheduler for the existing mandatory fork runner.
 * It owns only admission and reserved-worker checkout; the injected runner
 * remains the sole owner of fork preparation and BotVM simulation semantics.
 */
export function createFinalSimulationWorkRuntime<
  Resource,
  ResolvedPlan,
  Result,
>(
  options: FinalSimulationWorkRuntimeOptions<Resource, ResolvedPlan, Result>,
): FinalSimulationWorkRuntime<ResolvedPlan, Result> {
  const normalized = normalizeOptions(options);
  const scheduler = new ReservedFinalSimulationScheduler(normalized);
  const policy = Object.freeze({
    bind(
      input: CentralFinalSimulationPolicyInput<ResolvedPlan>,
    ): FinalSimulationScheduleDecision {
      assertSource(input.source, input.generation);
      const now = normalized.nowMs();
      const outerDeadline = normalized.deadlineAtMsForIntent?.(Object.freeze({
        stage: "fork-final-sim" as const,
        source: input.source,
        generation: input.generation,
        resolvedPlan: input.resolvedPlan,
      }));
      if (
        outerDeadline !== undefined &&
        (!Number.isFinite(outerDeadline) || outerDeadline <= now)
      ) {
        throw new FinalSimulationWorkRuntimeError(
          "timeout",
          "before-queue",
          "mandatory final simulation outer deadline elapsed before admission",
        );
      }
      return Object.freeze({
        lane: "final-sim" as const,
        deadlineAtMs: Math.min(
          now + normalized.timeoutMs,
          outerDeadline ?? Number.POSITIVE_INFINITY,
        ),
        maxAttempts: 1,
        transportPool: "final-sim" as const,
        fairnessKey: `mandatory-final-sim:${input.generation}`,
      });
    },
  });
  return Object.freeze({
    generationFence: options.generationFence,
    policy,
    scheduler,
    snapshot: () => scheduler.snapshot(),
    close: (reason?: unknown) => scheduler.close(reason),
  });
}

interface NormalizedOptions<Resource, ResolvedPlan, Result>
  extends FinalSimulationWorkRuntimeOptions<Resource, ResolvedPlan, Result> {
  readonly reservedResources: readonly RuntimeResource<Resource>[];
  readonly nowMs: () => number;
}

function normalizeOptions<Resource, ResolvedPlan, Result>(
  options: FinalSimulationWorkRuntimeOptions<Resource, ResolvedPlan, Result>,
): NormalizedOptions<Resource, ResolvedPlan, Result> {
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new Error("final simulation timeoutMs must be a positive safe integer");
  }
  if (!Number.isSafeInteger(options.maxQueued) || options.maxQueued < 0) {
    throw new Error("final simulation maxQueued must be a non-negative safe integer");
  }
  if (options.reservedResources.length === 0) {
    throw new Error("final simulation requires at least one reserved resource");
  }
  if (typeof options.runner.simulate !== "function") {
    throw new Error("final simulation runner must implement simulate");
  }
  if (typeof options.planIdentity.bytesHex !== "function") {
    throw new Error("final simulation plan identity must implement bytesHex");
  }
  const seen = new Set<string>();
  const resources = options.reservedResources.map((resource) => {
    if (
      typeof resource.id !== "string" ||
      resource.id.length === 0 ||
      resource.id.trim() !== resource.id ||
      seen.has(resource.id)
    ) {
      throw new Error("final simulation resource ids must be unique and normalized");
    }
    seen.add(resource.id);
    return Object.freeze({ id: resource.id, value: resource.value });
  });
  return Object.freeze({
    ...options,
    reservedResources: Object.freeze(resources),
    nowMs: options.nowMs ?? Date.now,
  });
}

class ReservedFinalSimulationScheduler<Resource, ResolvedPlan, Result> {
  private readonly idle: RuntimeResource<Resource>[];
  private readonly retired = new Set<string>();
  private readonly queue: Array<RuntimeTask<Resource, ResolvedPlan, Result>> = [];
  private readonly lifecycle = new AbortController();
  private active = 0;
  private completed = 0;
  private unresolved = 0;
  private telemetryFailures = 0;
  private lastReceipt: FinalSimulationTelemetryReceipt | null = null;

  constructor(
    private readonly options: NormalizedOptions<Resource, ResolvedPlan, Result>,
  ) {
    this.idle = [...options.reservedResources];
    if (options.parentSignal) {
      if (options.parentSignal.aborted) {
        this.close(options.parentSignal.reason);
      } else {
        options.parentSignal.addEventListener(
          "abort",
          () => this.close(options.parentSignal!.reason),
          { once: true },
        );
      }
    }
  }

  executeFinalSimulation(input: {
    readonly intent: FinalSimulationWorkIntent<ResolvedPlan>;
    readonly schedule: FinalSimulationScheduleDecision;
  }): Promise<Result> {
    const queuedAtMs = this.options.nowMs();
    let source: CanonicalSource;
    let identity: CapturedPlanIdentity | null = null;
    try {
      assertSchedule(input.schedule, queuedAtMs);
      source = captureSource(input.intent.source, input.intent.generation);
      this.assertFence(
        input.intent.generation,
        source,
        "before-queue",
      );
      identity = capturePlanIdentity(
        this.options.planIdentity,
        input.intent.resolvedPlan,
      );
      if (this.lifecycle.signal.aborted) {
        throw abortError("before-queue", this.lifecycle.signal.reason);
      }
      if (this.idle.length === 0 && this.queue.length >= this.options.maxQueued) {
        throw new FinalSimulationWorkRuntimeError(
          "ingress-full",
          "queue",
          `mandatory final simulation ingress is full (${this.options.maxQueued})`,
        );
      }
      if (this.healthyResourceCount() === 0) {
        throw new FinalSimulationWorkRuntimeError(
          "resource-failure",
          "queue",
          "mandatory final simulation has no healthy reserved resource",
        );
      }
    } catch (error) {
      const failure = normalizeFailure(error, "before-queue");
      this.unresolved++;
      this.recordReceipt({
        source: safeSource(input.intent),
        generation: safeGeneration(input.intent),
        schedule: input.schedule,
        resourceId: null,
        resolvedPlanSha256: identity?.sha256 ?? null,
        queuedAtMs,
        simulationStartedAtMs: null,
        failure,
      });
      return Promise.reject(failure);
    }

    const signal = this.linkedSignal(input.intent);
    const deadlineTimer = setTimeout(
      () => signal.controller.abort(new DeadlineSignal()),
      Math.max(0, input.schedule.deadlineAtMs - this.options.nowMs()),
    );

    return new Promise<Result>((resolve, reject) => {
      const task: RuntimeTask<Resource, ResolvedPlan, Result> = {
        intent: input.intent,
        schedule: input.schedule,
        source,
        generation: input.intent.generation,
        plan: input.intent.resolvedPlan,
        identity: identity!,
        queuedAtMs,
        controller: signal.controller,
        detachSignals: signal.detach,
        deadlineTimer,
        resolve,
        reject,
        state: "queued",
        resourceId: null,
        simulationStartedAtMs: null,
      };
      const onAbort = (): void => {
        if (task.state !== "queued") return;
        const index = this.queue.indexOf(task);
        if (index >= 0) this.queue.splice(index, 1);
        this.failTask(task, abortError("queue", task.controller.signal.reason));
        this.drain();
      };
      task.controller.signal.addEventListener("abort", onAbort, { once: true });
      const detach = task.detachSignals;
      task.detachSignals = () => {
        task.controller.signal.removeEventListener("abort", onAbort);
        detach();
      };
      this.queue.push(task);
      if (task.controller.signal.aborted) onAbort();
      else this.drain();
    });
  }

  snapshot(): ReturnType<FinalSimulationWorkRuntime<ResolvedPlan, Result>["snapshot"]> {
    return Object.freeze({
      active: this.active,
      queued: this.queue.length,
      healthyResources: this.healthyResourceCount(),
      retiredResources: this.retired.size,
      completed: this.completed,
      unresolved: this.unresolved,
      telemetryFailures: this.telemetryFailures,
      lastReceipt: this.lastReceipt,
    });
  }

  close(reason?: unknown): void {
    if (this.lifecycle.signal.aborted) return;
    this.lifecycle.abort(new ParentAbortSignal(reason));
  }

  private drain(): void {
    while (this.idle.length > 0 && this.queue.length > 0) {
      const task = this.queue.shift()!;
      if (task.state !== "queued") continue;
      if (task.controller.signal.aborted) {
        this.failTask(task, abortError("queue", task.controller.signal.reason));
        continue;
      }
      const resource = this.idle.shift()!;
      task.state = "active";
      task.resourceId = resource.id;
      this.active++;
      void this.runTask(task, resource).finally(() => {
        this.active--;
        this.drain();
      });
    }
    if (this.active === 0 && this.healthyResourceCount() === 0) {
      while (this.queue.length > 0) {
        this.failTask(
          this.queue.shift()!,
          new FinalSimulationWorkRuntimeError(
            "resource-failure",
            "queue",
            "mandatory final simulation reserved pool is exhausted",
          ),
        );
      }
    }
  }

  private async runTask(
    task: RuntimeTask<Resource, ResolvedPlan, Result>,
    resource: RuntimeResource<Resource>,
  ): Promise<void> {
    let simulationInvoked = false;
    let retire = false;
    try {
      this.assertIntentUnchanged(task, "before-simulation");
      assertDeadline(task.schedule, this.options.nowMs(), "before-simulation");
      this.assertFence(task.generation, task.source, "before-simulation");
      assertSamePlanIdentity(
        task.identity,
        capturePlanIdentity(this.options.planIdentity, task.plan),
        "plan changed while waiting for final simulation",
        "before-simulation",
      );
      if (task.controller.signal.aborted) {
        throw abortError("before-simulation", task.controller.signal.reason);
      }

      task.simulationStartedAtMs = this.options.nowMs();
      simulationInvoked = true;
      const simulation = Promise.resolve(this.options.runner.simulate({
        resource: resource.value,
        source: task.source,
        generation: task.generation,
        resolvedPlan: task.plan,
        resolvedPlanBytesHex: task.identity.bytesHex,
        resolvedPlanSha256: task.identity.sha256,
        schedule: task.schedule,
        signal: task.controller.signal,
      }));
      const result = await raceAbort(simulation, task.controller.signal);

      assertSamePlanIdentity(
        task.identity,
        capturePlanIdentity(this.options.planIdentity, task.plan),
        "resolved plan changed during final simulation",
        "before-publication",
      );
      let resultBytes: string | undefined;
      try {
        resultBytes = this.options.planIdentity.resultBytesHex?.(result);
      } catch (cause) {
        throw new FinalSimulationWorkRuntimeError(
          "plan-integrity",
          "before-publication",
          "failed to derive final simulation execution bytes",
          { cause },
        );
      }
      assertResultBytes(task.identity, resultBytes);
      this.assertIntentUnchanged(task, "before-publication");
      assertDeadline(task.schedule, this.options.nowMs(), "before-publication");
      this.assertFence(task.generation, task.source, "before-publication");
      this.release(resource);
      this.succeedTask(task, result);
    } catch (error) {
      const stage = task.simulationStartedAtMs === null
        ? "before-simulation"
        : "simulation";
      const failure = normalizeFailure(error, stage);
      retire = simulationInvoked && (
        failure.failureCode === "timeout" ||
        failure.failureCode === "aborted" ||
        failure.failureCode === "resource-failure"
      );
      if (retire) {
        this.retire(resource, failure);
      } else {
        this.release(resource);
      }
      this.failTask(task, failure);
    }
  }

  private linkedSignal(intent: FinalSimulationWorkIntent<ResolvedPlan>): {
    readonly controller: AbortController;
    readonly detach: () => void;
  } {
    const controller = new AbortController();
    let intentSignal: AbortSignal | undefined;
    try {
      intentSignal = this.options.signalForIntent?.(intent);
    } catch (error) {
      controller.abort(new ParentAbortSignal(error));
    }
    const sources = [this.lifecycle.signal, intentSignal]
      .filter((signal): signal is AbortSignal => signal !== undefined);
    const listeners = sources.map((source) => {
      const onAbort = (): void => {
        if (!controller.signal.aborted) {
          controller.abort(new ParentAbortSignal(source.reason));
        }
      };
      if (source.aborted) onAbort();
      else source.addEventListener("abort", onAbort, { once: true });
      return { source, onAbort };
    });
    return {
      controller,
      detach: () => listeners.forEach(({ source, onAbort }) =>
        source.removeEventListener("abort", onAbort)
      ),
    };
  }

  private assertFence(
    generation: number,
    source: CanonicalSource,
    stage: FinalSimulationRuntimeFailureStage,
  ): void {
    try {
      this.options.generationFence.assertCurrent(generation, source);
    } catch (cause) {
      throw new FinalSimulationWorkRuntimeError(
        "stale-generation",
        stage,
        `mandatory final simulation rejected stale source ${source.number}/${generation}`,
        { cause },
      );
    }
  }

  private assertIntentUnchanged(
    task: RuntimeTask<Resource, ResolvedPlan, Result>,
    stage: FinalSimulationRuntimeFailureStage,
  ): void {
    try {
      const current = captureSource(task.intent.source, task.intent.generation);
      if (
        current.number !== task.source.number ||
        current.hash !== task.source.hash ||
        current.generation !== task.source.generation ||
        task.intent.generation !== task.generation ||
        task.intent.resolvedPlan !== task.plan
      ) {
        throw new Error("final simulation intent changed after admission");
      }
    } catch (cause) {
      throw new FinalSimulationWorkRuntimeError(
        "stale-generation",
        stage,
        "mandatory final simulation source or generation changed after admission",
        { cause },
      );
    }
  }

  private release(resource: RuntimeResource<Resource>): void {
    if (!this.retired.has(resource.id)) this.idle.push(resource);
  }

  private retire(
    resource: RuntimeResource<Resource>,
    failure: FinalSimulationWorkRuntimeError,
  ): void {
    this.retired.add(resource.id);
    try {
      this.options.runner.terminate?.({
        resource: resource.value,
        reason: failure,
      });
    } catch {
      // The resource stays retired even if best-effort termination itself fails.
    }
  }

  private healthyResourceCount(): number {
    return this.options.reservedResources.length - this.retired.size;
  }

  private succeedTask(
    task: RuntimeTask<Resource, ResolvedPlan, Result>,
    result: Result,
  ): void {
    if (task.state === "settled") return;
    task.state = "settled";
    this.completed++;
    this.cleanupTask(task);
    this.recordReceipt({
      source: task.source,
      generation: task.generation,
      schedule: task.schedule,
      resourceId: task.resourceId,
      resolvedPlanSha256: task.identity.sha256,
      queuedAtMs: task.queuedAtMs,
      simulationStartedAtMs: task.simulationStartedAtMs,
      failure: null,
    });
    task.resolve(result);
  }

  private failTask(
    task: RuntimeTask<Resource, ResolvedPlan, Result>,
    failure: FinalSimulationWorkRuntimeError,
  ): void {
    if (task.state === "settled") return;
    task.state = "settled";
    this.unresolved++;
    this.cleanupTask(task);
    this.recordReceipt({
      source: task.source,
      generation: task.generation,
      schedule: task.schedule,
      resourceId: task.resourceId,
      resolvedPlanSha256: task.identity.sha256,
      queuedAtMs: task.queuedAtMs,
      simulationStartedAtMs: task.simulationStartedAtMs,
      failure,
    });
    task.reject(failure);
  }

  private cleanupTask(
    task: RuntimeTask<Resource, ResolvedPlan, Result>,
  ): void {
    clearTimeout(task.deadlineTimer);
    task.detachSignals();
  }

  private recordReceipt(input: {
    readonly source: CanonicalSource;
    readonly generation: number;
    readonly schedule: FinalSimulationScheduleDecision;
    readonly resourceId: string | null;
    readonly resolvedPlanSha256: string | null;
    readonly queuedAtMs: number;
    readonly simulationStartedAtMs: number | null;
    readonly failure: FinalSimulationWorkRuntimeError | null;
  }): void {
    const completedAtMs = Math.max(input.queuedAtMs, this.options.nowMs());
    const simulationStartedAtMs = input.simulationStartedAtMs;
    const receipt = Object.freeze({
      source: Object.freeze({ ...input.source }),
      generation: input.generation,
      lane: "final-sim" as const,
      transportPool: "final-sim" as const,
      fairnessKey: input.schedule.fairnessKey,
      resourceId: input.resourceId,
      resolvedPlanSha256: input.resolvedPlanSha256,
      status: input.failure === null ? "succeeded" as const : "unresolved" as const,
      failureCode: input.failure?.failureCode ?? null,
      failureStage: input.failure?.failureStage ?? null,
      queuedAtMs: input.queuedAtMs,
      simulationStartedAtMs,
      completedAtMs,
      queueWaitMs: simulationStartedAtMs === null
        ? Math.max(0, completedAtMs - input.queuedAtMs)
        : Math.max(0, simulationStartedAtMs - input.queuedAtMs),
      simulationWallMs: simulationStartedAtMs === null
        ? 0
        : Math.max(0, completedAtMs - simulationStartedAtMs),
      totalWallMs: Math.max(0, completedAtMs - input.queuedAtMs),
    });
    this.lastReceipt = receipt;
    try {
      this.options.onTelemetry?.(receipt);
    } catch {
      this.telemetryFailures++;
    }
  }
}

function assertSchedule(
  schedule: FinalSimulationScheduleDecision,
  nowMs: number,
): void {
  if (
    schedule === null ||
    typeof schedule !== "object" ||
    schedule.lane !== "final-sim" ||
    schedule.transportPool !== "final-sim" ||
    schedule.maxAttempts !== 1 ||
    !Number.isFinite(schedule.deadlineAtMs) ||
    typeof schedule.fairnessKey !== "string" ||
    schedule.fairnessKey.length === 0
  ) {
    throw new FinalSimulationWorkRuntimeError(
      "invalid-schedule",
      "before-queue",
      "mandatory final simulation requires one attempt on final-sim lane and pool",
    );
  }
  if (schedule.deadlineAtMs <= nowMs) {
    throw new FinalSimulationWorkRuntimeError(
      "timeout",
      "before-queue",
      "mandatory final simulation deadline elapsed before admission",
    );
  }
}

function assertDeadline(
  schedule: FinalSimulationScheduleDecision,
  nowMs: number,
  stage: FinalSimulationRuntimeFailureStage,
): void {
  if (nowMs >= schedule.deadlineAtMs) {
    throw new FinalSimulationWorkRuntimeError(
      "timeout",
      stage,
      "mandatory final simulation deadline reached",
    );
  }
}

function captureSource(
  source: CanonicalSource,
  generation: number,
): CanonicalSource {
  assertSource(source, generation);
  return Object.freeze({
    number: source.number,
    hash: source.hash.toLowerCase(),
    generation: source.generation,
  });
}

function assertSource(source: CanonicalSource, generation: number): void {
  if (
    source === null ||
    typeof source !== "object" ||
    !Number.isSafeInteger(source.number) ||
    source.number < 0 ||
    !Number.isSafeInteger(source.generation) ||
    source.generation < 0 ||
    !/^0x[0-9a-fA-F]{64}$/.test(source.hash) ||
    source.generation !== generation
  ) {
    throw new FinalSimulationWorkRuntimeError(
      "stale-generation",
      "before-queue",
      "mandatory final simulation requires one canonical source/generation",
    );
  }
}

function capturePlanIdentity<ResolvedPlan, Result>(
  identity: FinalSimulationPlanIdentity<ResolvedPlan, Result>,
  plan: ResolvedPlan,
): CapturedPlanIdentity {
  let bytesHex: string;
  let expectedSha256: string | undefined;
  try {
    bytesHex = normalizeBytesHex(identity.bytesHex(plan));
    expectedSha256 = identity.expectedSha256?.(plan);
  } catch (cause) {
    throw new FinalSimulationWorkRuntimeError(
      "plan-integrity",
      "before-queue",
      "failed to derive resolved plan execution bytes",
      { cause },
    );
  }
  const sha256 = sha256HexBytes(bytesHex);
  if (expectedSha256 !== undefined) {
    let normalizedExpected: string;
    try {
      normalizedExpected = normalizeSha256(expectedSha256);
    } catch (cause) {
      throw new FinalSimulationWorkRuntimeError(
        "plan-integrity",
        "before-queue",
        "resolved plan execution identity is not a SHA-256 digest",
        { cause },
      );
    }
    if (normalizedExpected !== sha256) {
      throw new FinalSimulationWorkRuntimeError(
        "plan-integrity",
        "before-queue",
        "resolved plan execution bytes do not match their existing identity",
      );
    }
    return Object.freeze({
      bytesHex,
      sha256,
      expectedSha256: normalizedExpected,
    });
  }
  return Object.freeze({ bytesHex, sha256, expectedSha256: null });
}

function assertSamePlanIdentity(
  expected: CapturedPlanIdentity,
  actual: CapturedPlanIdentity,
  message: string,
  stage: FinalSimulationRuntimeFailureStage,
): void {
  if (
    actual.bytesHex !== expected.bytesHex ||
    actual.sha256 !== expected.sha256 ||
    actual.expectedSha256 !== expected.expectedSha256
  ) {
    throw new FinalSimulationWorkRuntimeError(
      "plan-integrity",
      stage,
      message,
    );
  }
}

function assertResultBytes(
  identity: CapturedPlanIdentity,
  resultBytes: string | undefined,
): void {
  if (resultBytes === undefined) return;
  let normalized: string;
  try {
    normalized = normalizeBytesHex(resultBytes);
  } catch (cause) {
    throw new FinalSimulationWorkRuntimeError(
      "plan-integrity",
      "before-publication",
      "final simulation returned invalid execution bytes",
      { cause },
    );
  }
  if (normalized !== identity.bytesHex) {
    throw new FinalSimulationWorkRuntimeError(
      "plan-integrity",
      "before-publication",
      "final simulation executed bytes differ from the resolved plan",
    );
  }
}

function normalizeBytesHex(value: string): string {
  if (typeof value !== "string" || !/^0x(?:[0-9a-fA-F]{2})*$/.test(value)) {
    throw new Error("resolved plan bytes must be even-length hex");
  }
  return value.toLowerCase();
}

function sha256HexBytes(value: string): string {
  return createHash("sha256")
    .update(Buffer.from(value.slice(2), "hex"))
    .digest("hex");
}

function normalizeSha256(value: string): string {
  const normalized = value.toLowerCase().replace(/^0x/, "");
  if (!/^[0-9a-f]{64}$/.test(normalized)) {
    throw new Error("resolved plan identity must be a SHA-256 digest");
  }
  return normalized;
}

async function raceAbort<T>(
  work: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) throw abortError("simulation", signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      signal.removeEventListener("abort", onAbort);
      reject(abortError("simulation", signal.reason));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function abortError(
  stage: FinalSimulationRuntimeFailureStage,
  reason: unknown,
): FinalSimulationWorkRuntimeError {
  const timeout = reason instanceof DeadlineSignal;
  const cause = reason instanceof ParentAbortSignal
    ? reason.originalReason
    : reason;
  return new FinalSimulationWorkRuntimeError(
    timeout ? "timeout" : "aborted",
    stage,
    timeout
      ? "mandatory final simulation timed out"
      : "mandatory final simulation was aborted",
    { cause },
  );
}

function normalizeFailure(
  error: unknown,
  stage: FinalSimulationRuntimeFailureStage,
): FinalSimulationWorkRuntimeError {
  if (error instanceof FinalSimulationWorkRuntimeError) {
    if (
      error.failureCode === "plan-integrity" &&
      error.failureStage === "before-queue" &&
      stage !== "before-queue"
    ) {
      return new FinalSimulationWorkRuntimeError(
        error.failureCode,
        stage,
        error.message,
        { cause: error },
      );
    }
    return error;
  }
  return new FinalSimulationWorkRuntimeError(
    "resource-failure",
    stage,
    `mandatory final simulation resource failed: ${errorMessage(error)}`,
    { cause: error },
  );
}

function safeSource<ResolvedPlan>(
  intent: FinalSimulationWorkIntent<ResolvedPlan>,
): CanonicalSource {
  const source = intent?.source;
  return Object.freeze({
    number: Number.isSafeInteger(source?.number) ? source.number : 0,
    hash: typeof source?.hash === "string" && /^0x[0-9a-fA-F]{64}$/.test(source.hash)
      ? source.hash.toLowerCase()
      : `0x${"00".repeat(32)}`,
    generation: Number.isSafeInteger(source?.generation) ? source.generation : 0,
  });
}

function safeGeneration<ResolvedPlan>(
  intent: FinalSimulationWorkIntent<ResolvedPlan>,
): number {
  return Number.isSafeInteger(intent?.generation) ? intent.generation : 0;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Adapter over the exact worker shape used by blockscan production today. */
export function createBlockScanWorkerFinalSimulationRunner<
  Worker extends {
    readonly simulator: Pick<BotVMSimulator, "simulate">;
    readonly state: { stop(): void };
  },
>(): MandatoryFinalSimulationRunner<Worker, ResolvedPlan, SimulationResult> {
  return Object.freeze({
    simulate(input: FinalSimulationRunnerInput<Worker, ResolvedPlan>) {
      return input.resource.simulator.simulate(input.resolvedPlan);
    },
    terminate(input: { readonly resource: Worker }): void {
      input.resource.state.stop();
    },
  });
}

/**
 * Existing six-step evidence commits compilePlan bytes. This identity adapter
 * reuses that exact definition and, when supplied, verifies its frozen hash.
 */
export function createBotVmFinalSimulationPlanIdentity(input: {
  readonly executor: string;
  readonly expectedSha256?: (plan: ResolvedPlan) => string | undefined;
}): FinalSimulationPlanIdentity<ResolvedPlan, SimulationResult> {
  return Object.freeze({
    bytesHex(plan: ResolvedPlan): string {
      return bytesToHex(compilePlan(plan.root, input.executor));
    },
    expectedSha256: input.expectedSha256,
    resultBytesHex(result: SimulationResult): string | undefined {
      return result.scriptHex;
    },
  });
}
