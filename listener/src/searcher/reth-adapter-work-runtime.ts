import type { JsonRpcPayload } from "ethers";
import {
  postJsonRpc,
  type JsonRpcHttpResponse,
} from "../shared/state/state-backend.js";
import {
  CentralAdapterSchedulerError,
  frameworkWorkClassForAdapterStage,
  type AdapterGenerationFence,
  type AdapterWorkClock,
  type AdapterWorkStage,
  type CentralAdapterBudgets,
  type CentralAdapterPolicy,
  type CentralAdapterPolicyInput,
  type CentralAdapterRuntime,
  type CentralAdapterScheduler,
  type CentralCallerAuthority,
  type CentralCallerAuthorityProvider,
  type CentralScheduleDecision,
  type CentralSchedulerTiming,
  type SchedulerIssuedAdapterExecutor,
} from "./adapter-work-intent.js";
import {
  assertIssuedAdapterFamilyLifecycleContentCache,
  createAdapterFamilyLifecycleContentCache,
  type AdapterFamilyLifecycleContentCache,
  type AdapterStaticEvidenceReuseAuthority,
} from "./adapter-family-lifecycle-content-cache.js";
import {
  assertIssuedAdapterFamilyExactQuoteCache,
  createAdapterFamilyExactQuoteCache,
  type AdapterFamilyExactQuoteCache,
} from "./adapter-family-exact-quote-cache.js";
import type {
  RethTransportLane,
  RethTransportLease,
  RethTransportScheduler,
} from "./reth-transport-scheduler.js";
import {
  createBoundedRequestExecutor,
  physicalAdapterRequestFingerprint,
  requestSetFingerprint,
  type AdapterRequest,
  type AdapterRequestResult,
  type AdapterTransport,
  type CallerRef,
  type CanonicalSource,
  type MaterializedAdapterRequest,
  type ObservedEffects,
  type RequestRequirements,
  type ResolvedStaticEvidenceReusePolicy,
} from "./venues/adapter-request-program.js";
import { hashCanonical, type CanonicalValue } from "./venues/canonical-value.js";

type AdapterTransportPool = Exclude<
  CentralScheduleDecision["transportPool"],
  "final-sim"
>;

export type RethAdapterBatchResult =
  | {
      readonly id: string;
      readonly ok: true;
      readonly completion: "returned" | "reverted-as-declared";
      readonly data: string;
      readonly effects?: ObservedEffects;
    }
  | {
      readonly id: string;
      readonly ok: false;
      readonly failure: "rpc" | "deadline" | "aborted" | "resource-limited";
    };

/**
 * One invocation is exactly one physical request or JSON-RPC batch. The
 * central runtime always invokes it inside one RethTransportScheduler permit.
 * It deliberately returns no source or provenance: only the central bridge
 * can bind those facts and issue trusted AdapterRequestResults.
 */
export interface RethAdapterBatchBackend {
  readonly backendId: string;
  readonly supportedTransports: readonly AdapterTransport[];
  executePinnedBatch(input: {
    readonly source: CanonicalSource;
    readonly requests: readonly MaterializedAdapterRequest[];
    readonly signal: AbortSignal;
  }): Promise<readonly RethAdapterBatchResult[]>;
}

export interface RethAdapterWorkRuntimeOptions {
  readonly transportScheduler: Pick<RethTransportScheduler, "run">;
  readonly backends: Readonly<{
    readonly stateRead: RethAdapterBatchBackend;
    readonly trace?: RethAdapterBatchBackend;
    readonly effectSim?: RethAdapterBatchBackend;
  }>;
  readonly callerAuthority: CentralCallerAuthorityProvider;
  readonly generationFence: AdapterGenerationFence;
  readonly nowMs?: () => number;
  readonly maxRequestsPerProgram?: number;
  readonly maxPhysicalBatchSize?: number;
  readonly maxInFlightPrograms?: number;
  readonly maxQueuedBatches?: number;
  readonly maxActiveBatchesPerFairnessKey?: number;
  /**
   * Bounded physical-session grace used only to coalesce near-simultaneous
   * consumers. Each consumer still observes its own logical deadline.
   */
  readonly physicalDedupeWindowMs?: number;
  readonly maxStaticEvidenceCacheEntries?: number;
  readonly staticEvidenceCache?: AdapterFamilyLifecycleContentCache;
  readonly staticEvidenceReuseAuthority?: AdapterStaticEvidenceReuseAuthority;
  readonly maxExactQuoteCacheEntries?: number;
  readonly exactQuoteCache?: AdapterFamilyExactQuoteCache;
  readonly stageLimits?: Partial<Readonly<Record<
    AdapterWorkStage,
    Readonly<{
      readonly timeoutMs: number;
      readonly maxAttempts: number;
    }>
  >>>;
}

export interface RethAdapterWorkRuntime extends CentralAdapterRuntime {
  snapshot(): Readonly<{
    readonly inFlightPrograms: number;
    readonly coalescedWaiters: number;
    readonly activeBatchesByFairnessKey: Readonly<Record<string, number>>;
    readonly queuedBatches: number;
  }>;
}

const DEFAULT_STAGE_LIMITS: Readonly<Record<
  AdapterWorkStage,
  Readonly<{ readonly timeoutMs: number; readonly maxAttempts: number }>
>> = Object.freeze({
  identity: Object.freeze({ timeoutMs: 15_000, maxAttempts: 2 }),
  "instance-static": Object.freeze({ timeoutMs: 15_000, maxAttempts: 2 }),
  "pricing-static": Object.freeze({ timeoutMs: 12_000, maxAttempts: 2 }),
  "pricing-current": Object.freeze({ timeoutMs: 8_000, maxAttempts: 2 }),
  "runtime-evidence": Object.freeze({ timeoutMs: 8_000, maxAttempts: 1 }),
  "exact-refine": Object.freeze({ timeoutMs: 5_000, maxAttempts: 1 }),
});

const STAGE_LANES: Readonly<Record<
  AdapterWorkStage,
  Readonly<{
    readonly central: Exclude<CentralScheduleDecision["lane"], "final-sim">;
    readonly reth: RethTransportLane;
  }>
>> = Object.freeze({
  identity: Object.freeze({ central: "background", reth: "discovery" }),
  "instance-static": Object.freeze({
    central: "background",
    reth: "discovery",
  }),
  "pricing-static": Object.freeze({
    central: "foreground",
    reth: "producer-bulk",
  }),
  "pricing-current": Object.freeze({
    central: "foreground",
    reth: "producer-bulk",
  }),
  "runtime-evidence": Object.freeze({
    central: "critical-proof",
    reth: "producer-critical",
  }),
  "exact-refine": Object.freeze({ central: "foreground", reth: "exact" }),
});

const DEFAULT_MAX_REQUESTS_PER_PROGRAM = 256;
const DEFAULT_MAX_PHYSICAL_BATCH_SIZE = 32;
const DEFAULT_MAX_IN_FLIGHT_PROGRAMS = 256;
const DEFAULT_MAX_QUEUED_BATCHES = 256;
const DEFAULT_MAX_ACTIVE_BATCHES_PER_FAIRNESS_KEY = 1;
const DEFAULT_PHYSICAL_DEDUPE_WINDOW_MS = 25;

export function centralLaneForAdapterStage(
  stage: AdapterWorkStage,
): Exclude<CentralScheduleDecision["lane"], "final-sim"> {
  return STAGE_LANES[stage].central;
}

export function rethLaneForAdapterStage(
  stage: AdapterWorkStage,
): RethTransportLane {
  return STAGE_LANES[stage].reth;
}

export function transportPoolForAdapterRequirements(
  requirements: RequestRequirements,
): AdapterTransportPool {
  const transports = new Set(requirements.transports);
  if (
    transports.has("effect-delta-simulation") ||
    transports.has("state-override-simulation")
  ) {
    return "effect-sim";
  }
  if ((requirements.effects ?? []).includes("trace")) return "trace";
  return "state-read";
}

export function createRethAdapterWorkRuntime(
  options: RethAdapterWorkRuntimeOptions,
): RethAdapterWorkRuntime {
  const normalized = normalizeOptions(options);
  if (
    options.staticEvidenceCache !== undefined &&
    (
      options.maxStaticEvidenceCacheEntries !== undefined ||
      options.staticEvidenceReuseAuthority !== undefined
    )
  ) {
    throw new Error(
      "an injected static evidence cache cannot also declare cache construction options",
    );
  }
  const staticEvidenceCache = options.staticEvidenceCache ??
    createAdapterFamilyLifecycleContentCache({
      ...(options.maxStaticEvidenceCacheEntries === undefined
        ? {}
        : { capacity: options.maxStaticEvidenceCacheEntries }),
      ...(options.staticEvidenceReuseAuthority === undefined
        ? {}
        : { reuseAuthority: options.staticEvidenceReuseAuthority }),
    });
  assertIssuedAdapterFamilyLifecycleContentCache(staticEvidenceCache);
  if (
    options.exactQuoteCache !== undefined &&
    options.maxExactQuoteCacheEntries !== undefined
  ) {
    throw new Error(
      "an injected exact quote cache cannot also declare a cache capacity",
    );
  }
  const exactQuoteCache = options.exactQuoteCache ??
    createAdapterFamilyExactQuoteCache({
      ...(options.maxExactQuoteCacheEntries === undefined
        ? {}
        : { capacity: options.maxExactQuoteCacheEntries }),
    });
  assertIssuedAdapterFamilyExactQuoteCache(exactQuoteCache);
  const clock: AdapterWorkClock = Object.freeze({
    nowMs: normalized.nowMs,
  });
  const policy: CentralAdapterPolicy = Object.freeze({
    bind(input: CentralAdapterPolicyInput): CentralScheduleDecision {
      if (input.workClass !== frameworkWorkClassForAdapterStage(input.stage)) {
        throw new Error("Adapter workClass must be derived by the framework");
      }
      const limits = normalized.stageLimits[input.stage];
      return Object.freeze({
        lane: centralLaneForAdapterStage(input.stage),
        deadlineAtMs: normalized.nowMs() + limits.timeoutMs,
        maxAttempts: limits.maxAttempts,
        transportPool: transportPoolForAdapterRequirements(input.requirements),
        fairnessKey: adapterFairnessKey(input.stage, input.subjectKey),
      });
    },
  });
  const budgets: CentralAdapterBudgets = Object.freeze({
    assertAdmitted(
      schedule: CentralScheduleDecision,
      requests: readonly AdapterRequest[],
    ): void {
      assertAdapterSchedule(schedule);
      if (requests.length > normalized.maxRequestsPerProgram) {
        throw new Error(
          `Adapter request program has ${requests.length} requests; maximum is ` +
            normalized.maxRequestsPerProgram,
        );
      }
    },
  });
  const scheduler = new RethCentralAdapterScheduler(
    normalized,
    options.generationFence,
  );
  return Object.freeze({
    policy,
    budgets,
    scheduler,
    callerAuthority: options.callerAuthority,
    generationFence: options.generationFence,
    clock,
    staticEvidenceCache,
    exactQuoteCache,
    snapshot: () => scheduler.snapshot(),
  });
}

interface NormalizedRuntimeOptions {
  readonly transportScheduler: Pick<RethTransportScheduler, "run">;
  readonly backends: Readonly<{
    readonly stateRead: RethAdapterBatchBackend;
    readonly trace?: RethAdapterBatchBackend;
    readonly effectSim?: RethAdapterBatchBackend;
  }>;
  readonly nowMs: () => number;
  readonly maxRequestsPerProgram: number;
  readonly maxPhysicalBatchSize: number;
  readonly maxInFlightPrograms: number;
  readonly maxQueuedBatches: number;
  readonly maxActiveBatchesPerFairnessKey: number;
  readonly physicalDedupeWindowMs: number;
  readonly stageLimits: Readonly<Record<
    AdapterWorkStage,
    Readonly<{ readonly timeoutMs: number; readonly maxAttempts: number }>
  >>;
}

function normalizeOptions(
  options: RethAdapterWorkRuntimeOptions,
): NormalizedRuntimeOptions {
  if (options === null || typeof options !== "object") {
    throw new Error("Reth Adapter runtime options are required");
  }
  if (
    options.transportScheduler === null ||
    typeof options.transportScheduler?.run !== "function"
  ) {
    throw new Error("Reth Adapter runtime requires a transport scheduler");
  }
  assertBackend(options.backends?.stateRead, "state-read");
  if (options.backends.trace !== undefined) {
    assertBackend(options.backends.trace, "trace");
  }
  if (options.backends.effectSim !== undefined) {
    assertBackend(options.backends.effectSim, "effect-sim");
  }
  if (typeof options.callerAuthority?.bind !== "function") {
    throw new Error("Reth Adapter runtime requires caller authority binding");
  }
  if (typeof options.generationFence?.assertCurrent !== "function") {
    throw new Error("Reth Adapter runtime requires a generation fence");
  }
  const nowMs = options.nowMs ?? Date.now;
  if (typeof nowMs !== "function" || !Number.isFinite(nowMs())) {
    throw new Error("Reth Adapter runtime clock must return a finite value");
  }
  const stageLimits = Object.fromEntries(
    (Object.keys(DEFAULT_STAGE_LIMITS) as AdapterWorkStage[]).map((stage) => {
      const limits = options.stageLimits?.[stage] ?? DEFAULT_STAGE_LIMITS[stage];
      assertPositiveInteger(limits.timeoutMs, `${stage} timeoutMs`);
      assertPositiveInteger(limits.maxAttempts, `${stage} maxAttempts`);
      return [stage, Object.freeze({ ...limits })];
    }),
  ) as Record<
    AdapterWorkStage,
    Readonly<{ readonly timeoutMs: number; readonly maxAttempts: number }>
  >;
  const maxRequestsPerProgram = positiveOption(
    options.maxRequestsPerProgram,
    DEFAULT_MAX_REQUESTS_PER_PROGRAM,
    "maxRequestsPerProgram",
  );
  const maxPhysicalBatchSize = positiveOption(
    options.maxPhysicalBatchSize,
    DEFAULT_MAX_PHYSICAL_BATCH_SIZE,
    "maxPhysicalBatchSize",
  );
  if (maxPhysicalBatchSize > maxRequestsPerProgram) {
    throw new Error("physical batch size cannot exceed the program request cap");
  }
  return Object.freeze({
    transportScheduler: options.transportScheduler,
    backends: Object.freeze({ ...options.backends }),
    nowMs,
    maxRequestsPerProgram,
    maxPhysicalBatchSize,
    maxInFlightPrograms: positiveOption(
      options.maxInFlightPrograms,
      DEFAULT_MAX_IN_FLIGHT_PROGRAMS,
      "maxInFlightPrograms",
    ),
    maxQueuedBatches: positiveOption(
      options.maxQueuedBatches,
      DEFAULT_MAX_QUEUED_BATCHES,
      "maxQueuedBatches",
    ),
    maxActiveBatchesPerFairnessKey: positiveOption(
      options.maxActiveBatchesPerFairnessKey,
      DEFAULT_MAX_ACTIVE_BATCHES_PER_FAIRNESS_KEY,
      "maxActiveBatchesPerFairnessKey",
    ),
    physicalDedupeWindowMs: positiveOption(
      options.physicalDedupeWindowMs,
      DEFAULT_PHYSICAL_DEDUPE_WINDOW_MS,
      "physicalDedupeWindowMs",
    ),
    stageLimits: Object.freeze(stageLimits),
  });
}

interface MutableSchedulerTiming {
  queueWaitMs: number;
  transportWallMs: number;
  attempts: number;
}

interface SharedExecution {
  readonly promise: Promise<readonly AdapterRequestResult[]>;
  readonly requests: readonly AdapterRequest[];
  readonly timing: MutableSchedulerTiming;
  readonly physicalDedupeKey: string;
  readonly physicalDeadlineAtMs: number;
  waiters: number;
}

class RethCentralAdapterScheduler implements CentralAdapterScheduler {
  private readonly inFlight = new Map<string, SharedExecution>();
  private readonly instanceFairGate: FairPhysicalBatchGate;
  private coalescedWaiters = 0;
  private nextSharedExecutionId = 0;

  constructor(
    private readonly options: NormalizedRuntimeOptions,
    private readonly generationFence: AdapterGenerationFence,
  ) {
    this.instanceFairGate = new FairPhysicalBatchGate({
      maxQueued: options.maxQueuedBatches,
      maxActivePerKey: options.maxActiveBatchesPerFairnessKey,
    });
  }

  issueExecutor(
    input: Parameters<CentralAdapterScheduler["issueExecutor"]>[0],
  ): SchedulerIssuedAdapterExecutor {
    assertAdapterSchedule(input.schedule);
    const issuedStage = stageFromAdapterFairnessKey(input.schedule.fairnessKey);
    if (
      input.schedule.fairnessKey !==
      adapterFairnessKey(issuedStage, input.subjectKey)
    ) {
      throw new Error("Reth Adapter schedule fairness subject binding mismatch");
    }
    const rethLane = laneForIssuedSchedule(
      issuedStage,
      input.schedule,
      input.requirements,
    );
    const backend = this.backendFor(input.schedule.transportPool);
    const supported = new Set(backend?.supportedTransports ?? []);
    const expectedSource = freezeSource(input.source);
    const expectedRequirements = freezeRequirements(input.requirements);
    const expectedRequestFingerprint = requestSetFingerprint(input.requests);
    const expectedCallerAuthority = freezeCallerAuthority(input.callerAuthority);
    const timing: MutableSchedulerTiming = zeroTiming();
    let observedTiming = timing;

    const executor = createBoundedRequestExecutor({
      assertSupported: (requirements) => {
        assertSameRequirements(requirements, expectedRequirements);
        if (backend === undefined) {
          throw new CentralAdapterSchedulerError({
            stage: "transport",
            code: "resource-limited",
            message: `no real ${input.schedule.transportPool} Adapter backend is configured`,
          });
        }
        for (const transport of requirements.transports) {
          if (!supported.has(transport)) {
            throw new CentralAdapterSchedulerError({
              stage: "transport",
              code: "resource-limited",
              message:
                `${backend.backendId} does not support Adapter transport ${transport}`,
            });
          }
        }
      },
      assertCallerBinding: (binding) => {
        if (
          binding.familyId !== input.subject.familyId ||
          !sameSource(binding.source, expectedSource)
        ) {
          throw new Error("Reth Adapter caller binding escaped its issued work");
        }
        assertCallerRefAuthority(binding.callerRef, expectedCallerAuthority);
      },
      assertWithinBudget: (familyId, requests) => {
        if (familyId !== input.subject.familyId) {
          throw new Error("Reth Adapter executor family binding mismatch");
        }
        if (requestSetFingerprint(requests) !== expectedRequestFingerprint) {
          throw new Error("Reth Adapter executor request set binding mismatch");
        }
      },
      execute: async (execution) => {
        if (
          execution.familyId !== input.subject.familyId ||
          !sameSource(execution.source, expectedSource)
        ) {
          throw new Error("Reth Adapter execution escaped its issued source");
        }
        assertSameRequirements(execution.requirements, expectedRequirements);
        if (requestSetFingerprint(execution.requests) !== expectedRequestFingerprint) {
          throw new Error("Reth Adapter execution request set changed after admission");
        }
        if (backend === undefined) {
          throw new CentralAdapterSchedulerError({
            stage: "transport",
            code: "resource-limited",
            message: `no real ${input.schedule.transportPool} Adapter backend is configured`,
          });
        }
        const materializedRequests = materializeAdapterRequests(
          execution.requests,
          expectedCallerAuthority,
        );
        const physicalDedupeKey = [
          input.dedupeKey,
          materializedRequestSetFingerprint(materializedRequests),
          rethLane,
          input.schedule.transportPool,
          backend.backendId,
          input.schedule.maxAttempts,
        ].join("\u001f");
        const existing = this.findCompatibleSharedExecution(
          physicalDedupeKey,
          input.schedule.deadlineAtMs,
        );
        if (existing !== undefined) {
          existing.shared.waiters++;
          this.coalescedWaiters++;
          observedTiming = existing.shared.timing;
          return this.awaitSharedExecution({
            shared: existing.shared,
            consumerRequests: execution.requests,
            consumerDeadlineAtMs: input.schedule.deadlineAtMs,
            source: expectedSource,
          });
        }
        if (this.inFlight.size >= this.options.maxInFlightPrograms) {
          throw new CentralAdapterSchedulerError({
            stage: "queue",
            code: "ingress-full",
            message:
              `Reth Adapter ingress is full (${this.options.maxInFlightPrograms})`,
          });
        }
        const sharedTiming = zeroTiming();
        observedTiming = sharedTiming;
        const physicalDeadlineAtMs = boundedPhysicalDeadline(
          input.schedule.deadlineAtMs,
          this.options.physicalDedupeWindowMs,
        );
        const physicalSchedule = Object.freeze({
          ...input.schedule,
          deadlineAtMs: physicalDeadlineAtMs,
        });
        const promise = this.executeRequestSet({
          schedule: physicalSchedule,
          source: expectedSource,
          generation: input.generation,
          requests: materializedRequests,
          rethLane,
          backend,
          timing: sharedTiming,
          instanceFairnessKey: adapterInstanceFairnessKey(input),
        });
        const shared: SharedExecution = {
          promise,
          requests: Object.freeze([...execution.requests]),
          timing: sharedTiming,
          physicalDedupeKey,
          physicalDeadlineAtMs,
          waiters: 1,
        };
        const sharedExecutionKey = `${physicalDedupeKey}\u001f` +
          `session:${this.nextSharedExecutionId++}`;
        this.inFlight.set(sharedExecutionKey, shared);
        void promise.then(
          () => this.removeSharedExecution(sharedExecutionKey, shared),
          () => this.removeSharedExecution(sharedExecutionKey, shared),
        );
        return this.awaitSharedExecution({
          shared,
          consumerRequests: execution.requests,
          consumerDeadlineAtMs: input.schedule.deadlineAtMs,
          source: expectedSource,
        });
      },
      sealStaticEvidenceReuseProof: (proof) => {
        if (
          !sameSource(proof.source, expectedSource) ||
          requestSetFingerprint(proof.requests) !== expectedRequestFingerprint
        ) {
          throw new Error("static evidence proof escaped its Reth Adapter work");
        }
        return Object.freeze({
          proofHash: hashCanonical({
            kind: "reth-adapter-static-evidence-v1",
            source: sourceValue(expectedSource),
            policy: reusePolicyValue(proof.reusePolicy),
            requestFingerprint: expectedRequestFingerprint,
            trustedResultsFingerprint: proof.trustedResultsFingerprint,
            backendId: backend?.backendId ?? "unconfigured",
          }),
        });
      },
    });
    return Object.freeze({
      executor,
      timing: (): CentralSchedulerTiming => Object.freeze({ ...observedTiming }),
    });
  }

  snapshot(): ReturnType<RethAdapterWorkRuntime["snapshot"]> {
    return Object.freeze({
      inFlightPrograms: this.inFlight.size,
      coalescedWaiters: this.coalescedWaiters,
      activeBatchesByFairnessKey: this.instanceFairGate.activeSnapshot(),
      queuedBatches: this.instanceFairGate.queuedCount(),
    });
  }

  private removeSharedExecution(key: string, shared: SharedExecution): void {
    if (this.inFlight.get(key) === shared) this.inFlight.delete(key);
  }

  private findCompatibleSharedExecution(
    physicalDedupeKey: string,
    consumerDeadlineAtMs: number,
  ): Readonly<{ readonly key: string; readonly shared: SharedExecution }> |
    undefined {
    let selected:
      | Readonly<{ readonly key: string; readonly shared: SharedExecution }>
      | undefined;
    for (const [key, shared] of this.inFlight) {
      if (
        shared.physicalDedupeKey !== physicalDedupeKey ||
        shared.physicalDeadlineAtMs < consumerDeadlineAtMs
      ) {
        continue;
      }
      if (
        selected === undefined ||
        shared.physicalDeadlineAtMs < selected.shared.physicalDeadlineAtMs
      ) {
        selected = Object.freeze({ key, shared });
      }
    }
    return selected;
  }

  private async awaitSharedExecution(input: {
    readonly shared: SharedExecution;
    readonly consumerRequests: readonly AdapterRequest[];
    readonly consumerDeadlineAtMs: number;
    readonly source: CanonicalSource;
  }): Promise<readonly AdapterRequestResult[]> {
    const waited = await waitForConsumerDeadline({
      promise: input.shared.promise,
      deadlineAtMs: input.consumerDeadlineAtMs,
      nowMs: this.options.nowMs,
    });
    if (waited.status === "deadline") {
      return Object.freeze(input.consumerRequests.map((request) =>
        failedResult(request.id, input.source, "deadline")
      ));
    }
    return remapSharedResults({
      ownerRequests: input.shared.requests,
      consumerRequests: input.consumerRequests,
      results: waited.value,
    });
  }

  private backendFor(
    pool: CentralScheduleDecision["transportPool"],
  ): RethAdapterBatchBackend | undefined {
    switch (pool) {
      case "state-read":
        return this.options.backends.stateRead;
      case "trace":
        return this.options.backends.trace;
      case "effect-sim":
        return this.options.backends.effectSim;
      case "final-sim":
        throw new Error("Adapter work cannot use the reserved final-sim backend");
    }
  }

  private async executeRequestSet(input: {
    readonly schedule: CentralScheduleDecision;
    readonly source: CanonicalSource;
    readonly generation: number;
    readonly requests: readonly MaterializedAdapterRequest[];
    readonly rethLane: RethTransportLane;
    readonly backend: RethAdapterBatchBackend;
    readonly timing: MutableSchedulerTiming;
    readonly instanceFairnessKey: string;
  }): Promise<readonly AdapterRequestResult[]> {
    if (input.requests.length === 0) return Object.freeze([]);
    const results: AdapterRequestResult[] = [];
    for (
      let offset = 0;
      offset < input.requests.length;
      offset += this.options.maxPhysicalBatchSize
    ) {
      const batch = Object.freeze(
        input.requests.slice(offset, offset + this.options.maxPhysicalBatchSize),
      );
      const batchResults = await this.executePhysicalBatch({ ...input, requests: batch });
      results.push(...batchResults);
    }
    return Object.freeze(results);
  }

  private async executePhysicalBatch(input: {
    readonly schedule: CentralScheduleDecision;
    readonly source: CanonicalSource;
    readonly generation: number;
    readonly requests: readonly MaterializedAdapterRequest[];
    readonly rethLane: RethTransportLane;
    readonly backend: RethAdapterBatchBackend;
    readonly timing: MutableSchedulerTiming;
    readonly instanceFairnessKey: string;
  }): Promise<readonly AdapterRequestResult[]> {
    const completed = new Map<string, AdapterRequestResult>();
    let pending = [...input.requests];
    for (let attempt = 1; attempt <= input.schedule.maxAttempts; attempt++) {
      if (pending.length === 0) break;
      const controller = deadlineController(input.schedule.deadlineAtMs, this.options.nowMs);
      let rawResults: readonly RethAdapterBatchResult[];
      try {
        const fairnessWaitStarted = this.options.nowMs();
        const releaseFairness = await this.acquireFairness(input, controller.signal);
        input.timing.queueWaitMs += elapsed(
          fairnessWaitStarted,
          this.options.nowMs(),
        );
        try {
          rawResults = await this.runPhysicalAttempt({
            ...input,
            requests: Object.freeze([...pending]),
            signal: controller.signal,
          });
        } finally {
          releaseFairness();
        }
      } catch (error) {
        const failure = schedulerFailure(
          error,
          controller,
          input.schedule.deadlineAtMs,
          this.options.nowMs,
        );
        controller.dispose();
        if (
          failure.failureStage === "transport" &&
          retryable(failure.failureCode) &&
          attempt < input.schedule.maxAttempts
        ) {
          continue;
        }
        if (
          failure.failureStage === "queue" ||
          failure.failureCode === "ingress-full"
        ) throw failure;
        for (const request of pending) {
          completed.set(request.id, failedResult(request.id, input.source, failure.failureCode));
        }
        pending = [];
        break;
      }
      controller.dispose();
      assertPhysicalResultSet(pending, rawResults);
      const retry: MaterializedAdapterRequest[] = [];
      for (const request of pending) {
        const raw = rawResults.find((result) => result.id === request.id)!;
        if (!raw.ok) {
          if (retryable(raw.failure) && attempt < input.schedule.maxAttempts) {
            retry.push(request);
          } else {
            completed.set(request.id, failedResult(request.id, input.source, raw.failure));
          }
          continue;
        }
        completed.set(
          request.id,
          successfulResult(request, raw, input.source, input.backend.backendId),
        );
      }
      pending = retry;
    }
    for (const request of pending) {
      completed.set(request.id, failedResult(request.id, input.source, "rpc"));
    }
    return Object.freeze(
      input.requests.map((request) => {
        const result = completed.get(request.id);
        if (result === undefined) {
          throw new Error(`Reth Adapter execution omitted ${request.id}`);
        }
        return result;
      }),
    );
  }

  private async runPhysicalAttempt(input: {
    readonly schedule: CentralScheduleDecision;
    readonly source: CanonicalSource;
    readonly generation: number;
    readonly requests: readonly MaterializedAdapterRequest[];
    readonly rethLane: RethTransportLane;
    readonly backend: RethAdapterBatchBackend;
    readonly timing: MutableSchedulerTiming;
    readonly signal: AbortSignal;
  }): Promise<readonly RethAdapterBatchResult[]> {
    let transportStarted = false;
    try {
      return await this.options.transportScheduler.run(
        input.rethLane,
        input.signal,
        async (lease: RethTransportLease) => {
          input.timing.queueWaitMs += lease.queueWaitMs;
          try {
            this.generationFence.assertCurrent(input.generation, input.source);
          } catch (error) {
            throw new CentralAdapterSchedulerError({
              stage: "queue",
              code: "aborted",
              message: `Adapter generation became stale before physical I/O: ${errorMessage(error)}`,
            });
          }
          transportStarted = true;
          input.timing.attempts++;
          const startedAtMs = this.options.nowMs();
          try {
            return await input.backend.executePinnedBatch({
              source: input.source,
              requests: input.requests,
              signal: input.signal,
            });
          } finally {
            input.timing.transportWallMs += elapsed(
              startedAtMs,
              this.options.nowMs(),
            );
          }
        },
      );
    } catch (error) {
      if (error instanceof CentralAdapterSchedulerError) throw error;
      const code = classifyFailure(error, input.signal, input.schedule.deadlineAtMs, this.options.nowMs);
      throw new CentralAdapterSchedulerError({
        stage: transportStarted ? "transport" : "queue",
        code,
        message: errorMessage(error),
      });
    }
  }

  private async acquireFairness(
    input: Readonly<{
      readonly instanceFairnessKey: string;
      readonly rethLane: RethTransportLane;
    }>,
    signal: AbortSignal,
  ): Promise<() => void> {
    const priority = lanePriority(input.rethLane);
    // One central physical queue. The key is an opaque instance/work identity;
    // Family IDs never create a quota or a separate queue.
    return this.instanceFairGate.acquire({
      key: input.instanceFairnessKey,
      priority,
      signal,
    });
  }
}

interface FairWaiter {
  readonly key: string;
  readonly priority: number;
  readonly sequence: number;
  readonly signal: AbortSignal;
  readonly resolve: (release: () => void) => void;
  readonly reject: (reason?: unknown) => void;
  readonly onAbort: () => void;
}

class FairPhysicalBatchGate {
  private readonly activeByKey = new Map<string, number>();
  private readonly queuesByKey = new Map<string, FairWaiter[]>();
  private pending = 0;
  private sequence = 0;

  constructor(private readonly options: {
    readonly maxQueued: number;
    readonly maxActivePerKey: number;
  }) {}

  acquire(input: {
    readonly key: string;
    readonly priority: number;
    readonly signal: AbortSignal;
  }): Promise<() => void> {
    if (input.signal.aborted) return Promise.reject(abortReason(input.signal));
    if ((this.activeByKey.get(input.key) ?? 0) < this.options.maxActivePerKey) {
      this.activeByKey.set(input.key, (this.activeByKey.get(input.key) ?? 0) + 1);
      return Promise.resolve(this.releaseOnce(input.key));
    }
    if (this.pending >= this.options.maxQueued) {
      return Promise.reject(new CentralAdapterSchedulerError({
        stage: "queue",
        code: "ingress-full",
        message: `Reth Adapter fair queue is full (${this.options.maxQueued})`,
      }));
    }
    return new Promise<() => void>((resolve, reject) => {
      const onAbort = (): void => {
        const queue = this.queuesByKey.get(input.key);
        const index = queue?.indexOf(waiter) ?? -1;
        if (queue !== undefined && index >= 0) {
          queue.splice(index, 1);
          this.pending--;
          if (queue.length === 0) this.queuesByKey.delete(input.key);
        }
        input.signal.removeEventListener("abort", onAbort);
        reject(abortReason(input.signal));
      };
      const waiter: FairWaiter = {
        key: input.key,
        priority: input.priority,
        sequence: this.sequence++,
        signal: input.signal,
        resolve,
        reject,
        onAbort,
      };
      const queue = this.queuesByKey.get(input.key) ?? [];
      queue.push(waiter);
      queue.sort((left, right) =>
        left.priority - right.priority || left.sequence - right.sequence
      );
      this.queuesByKey.set(input.key, queue);
      this.pending++;
      input.signal.addEventListener("abort", onAbort, { once: true });
      if (input.signal.aborted) onAbort();
    });
  }

  queuedCount(): number {
    return this.pending;
  }

  activeSnapshot(): Readonly<Record<string, number>> {
    return Object.freeze(Object.fromEntries([...this.activeByKey].sort()));
  }

  private releaseOnce(key: string): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const active = (this.activeByKey.get(key) ?? 1) - 1;
      if (active === 0) this.activeByKey.delete(key);
      else this.activeByKey.set(key, active);
      this.drain(key);
    };
  }

  private drain(key: string): void {
    const queue = this.queuesByKey.get(key);
    if (queue === undefined) return;
    while (
      queue.length > 0 &&
      (this.activeByKey.get(key) ?? 0) < this.options.maxActivePerKey
    ) {
      const waiter = queue.shift()!;
      this.pending--;
      waiter.signal.removeEventListener("abort", waiter.onAbort);
      if (waiter.signal.aborted) {
        waiter.reject(abortReason(waiter.signal));
        continue;
      }
      this.activeByKey.set(key, (this.activeByKey.get(key) ?? 0) + 1);
      waiter.resolve(this.releaseOnce(key));
    }
    if (queue.length === 0) this.queuesByKey.delete(key);
  }
}

/**
 * Real EIP-1898 JSON-RPC backend for the ordinary state-read pool. Simulation
 * requests intentionally remain unsupported until a funded/effect backend can
 * materialize and independently observe their override intent.
 */
export class JsonRpcRethAdapterBatchBackend implements RethAdapterBatchBackend {
  readonly backendId = "reth-json-rpc-eip1898-v1";
  readonly supportedTransports = Object.freeze([
    "eth-call",
    "get-code",
    "get-storage",
  ] as const);

  constructor(private readonly rpcUrl: string) {
    if (typeof rpcUrl !== "string" || rpcUrl.length === 0) {
      throw new Error("Reth Adapter JSON-RPC URL is required");
    }
  }

  async executePinnedBatch(input: {
    readonly source: CanonicalSource;
    readonly requests: readonly MaterializedAdapterRequest[];
    readonly signal: AbortSignal;
  }): Promise<readonly RethAdapterBatchResult[]> {
    const block = Object.freeze({
      blockHash: input.source.hash,
      requireCanonical: true,
    });
    const payloads = input.requests.map((request, index) =>
      requestPayload(request, index + 1, block)
    );
    const response = await postJsonRpc(
      this.rpcUrl,
      payloads as unknown as JsonRpcPayload,
      input.signal,
    );
    return parseRpcBatchResponse(response, input.requests);
  }
}

function requestPayload(
  request: MaterializedAdapterRequest,
  id: number,
  block: Readonly<{ readonly blockHash: string; readonly requireCanonical: true }>,
): Readonly<{
  readonly jsonrpc: "2.0";
  readonly id: number;
  readonly method: string;
  readonly params: readonly unknown[];
}> {
  switch (request.kind) {
    case "eth-call":
      return Object.freeze({
        jsonrpc: "2.0",
        id,
        method: "eth_call",
        params: Object.freeze([Object.freeze({
          to: request.to,
          data: request.data,
          ...(request.from === undefined ? {} : { from: request.from }),
        }), block]),
      });
    case "get-code":
      return Object.freeze({
        jsonrpc: "2.0",
        id,
        method: "eth_getCode",
        params: Object.freeze([request.address, block]),
      });
    case "get-storage":
      return Object.freeze({
        jsonrpc: "2.0",
        id,
        method: "eth_getStorageAt",
        params: Object.freeze([request.address, request.slot, block]),
      });
    case "state-override-simulation":
    case "effect-delta-simulation":
      throw new Error(
        `${request.kind} requires a real funded/effect simulation backend`,
      );
  }
}

function parseRpcBatchResponse(
  response: JsonRpcHttpResponse,
  requests: readonly MaterializedAdapterRequest[],
): readonly RethAdapterBatchResult[] {
  if (response.statusCode < 200 || response.statusCode >= 300) {
    const failure = response.statusCode === 429 || response.statusCode === 503
      ? "resource-limited" as const
      : "rpc" as const;
    return Object.freeze(requests.map((request) => Object.freeze({
      id: request.id,
      ok: false as const,
      failure,
    })));
  }
  const entries = Array.isArray(response.body) ? response.body : [response.body];
  const byId = new Map<number, Readonly<Record<string, unknown>>>();
  for (const entry of entries) {
    if (!isRecord(entry) || !Number.isSafeInteger(entry.id)) continue;
    byId.set(entry.id as number, entry);
  }
  return Object.freeze(requests.map((request, index): RethAdapterBatchResult => {
    const entry = byId.get(index + 1);
    if (entry === undefined) return failedPhysical(request.id, "rpc");
    if (isRecord(entry.error)) {
      const message = typeof entry.error.message === "string"
        ? entry.error.message.toLowerCase()
        : "";
      const revertData = extractRevertData(entry.error.data);
      if (
        request.kind === "eth-call" &&
        request.completion === "return-or-revert-data" &&
        message.includes("revert") &&
        revertData !== null
      ) {
        return Object.freeze({
          id: request.id,
          ok: true as const,
          completion: "reverted-as-declared" as const,
          data: revertData,
        });
      }
      const code = typeof entry.error.code === "number" ? entry.error.code : 0;
      return failedPhysical(
        request.id,
        code === -32005 || message.includes("rate limit") || message.includes("too many")
          ? "resource-limited"
          : "rpc",
      );
    }
    if (!isEvenHex(entry.result)) return failedPhysical(request.id, "rpc");
    return Object.freeze({
      id: request.id,
      ok: true as const,
      completion: "returned" as const,
      data: entry.result,
    });
  }));
}

function successfulResult(
  request: MaterializedAdapterRequest,
  raw: Extract<RethAdapterBatchResult, { readonly ok: true }>,
  source: CanonicalSource,
  backendId: string,
): AdapterRequestResult {
  return Object.freeze({
    id: request.id,
    ok: true as const,
    source,
    provenance: Object.freeze({
      kind: "reth-pinned-adapter-batch",
      fingerprint: hashCanonical({
        version: "reth-adapter-provenance-v1",
        backendId,
        source: sourceValue(source),
        requestFingerprint: materializedAdapterRequestFingerprint(request),
        completion: raw.completion,
        data: raw.data.toLowerCase(),
        effects: effectsValue(raw.effects),
      }),
    }),
    completion: raw.completion,
    data: raw.data,
    ...(raw.effects === undefined ? {} : { effects: raw.effects }),
  });
}

function failedResult(
  id: string,
  source: CanonicalSource,
  failure: "rpc" | "deadline" | "aborted" | "resource-limited",
): AdapterRequestResult {
  return Object.freeze({ id, ok: false as const, source, failure });
}

function failedPhysical(
  id: string,
  failure: "rpc" | "deadline" | "aborted" | "resource-limited",
): RethAdapterBatchResult {
  return Object.freeze({ id, ok: false as const, failure });
}

function remapSharedResults(input: {
  readonly ownerRequests: readonly AdapterRequest[];
  readonly consumerRequests: readonly AdapterRequest[];
  readonly results: readonly AdapterRequestResult[];
}): readonly AdapterRequestResult[] {
  const resultByOwnerId = new Map(input.results.map((result) => [result.id, result]));
  const ownerBuckets = new Map<string, Array<{
    readonly request: AdapterRequest;
    readonly result: AdapterRequestResult;
  }>>();
  for (const request of input.ownerRequests) {
    const result = resultByOwnerId.get(request.id);
    if (result === undefined) {
      throw new Error(`shared Adapter result omitted owner id ${request.id}`);
    }
    const key = physicalAdapterRequestFingerprint(request);
    const bucket = ownerBuckets.get(key) ?? [];
    bucket.push({ request, result });
    bucket.sort((left, right) => left.request.id.localeCompare(right.request.id));
    ownerBuckets.set(key, bucket);
  }

  const consumerBuckets = new Map<string, AdapterRequest[]>();
  for (const request of input.consumerRequests) {
    const key = physicalAdapterRequestFingerprint(request);
    const bucket = consumerBuckets.get(key) ?? [];
    bucket.push(request);
    bucket.sort((left, right) => left.id.localeCompare(right.id));
    consumerBuckets.set(key, bucket);
  }

  const remapped = new Map<string, AdapterRequestResult>();
  for (const [key, consumers] of consumerBuckets) {
    const owners = ownerBuckets.get(key);
    if (owners === undefined || owners.length !== consumers.length) {
      throw new Error("shared Adapter physical request multiset changed");
    }
    consumers.forEach((consumer, index) => {
      remapped.set(consumer.id, Object.freeze({
        ...owners[index]!.result,
        id: consumer.id,
      }));
    });
  }
  if (remapped.size !== input.consumerRequests.length) {
    throw new Error("shared Adapter result remap was incomplete");
  }
  return Object.freeze(input.consumerRequests.map((request) => {
    const result = remapped.get(request.id);
    if (result === undefined) {
      throw new Error(`shared Adapter result omitted consumer id ${request.id}`);
    }
    return result;
  }));
}

function assertPhysicalResultSet(
  requests: readonly MaterializedAdapterRequest[],
  results: readonly RethAdapterBatchResult[],
): void {
  if (!Array.isArray(results)) {
    throw new Error("Reth Adapter backend must return a result array");
  }
  const expected = new Set(requests.map((request) => request.id));
  const actual = new Set<string>();
  for (const result of results) {
    if (!expected.has(result.id) || actual.has(result.id)) {
      throw new Error(`Reth Adapter backend returned invalid result id ${result.id}`);
    }
    actual.add(result.id);
    if (result.ok) {
      if (!isEvenHex(result.data)) {
        throw new Error(`Reth Adapter backend returned non-hex data for ${result.id}`);
      }
    } else if (!REQUEST_FAILURES.has(result.failure)) {
      throw new Error(`Reth Adapter backend returned invalid failure for ${result.id}`);
    }
  }
  if (actual.size !== expected.size) {
    throw new Error("Reth Adapter backend omitted a physical result");
  }
}

function laneForIssuedSchedule(
  stage: AdapterWorkStage,
  schedule: CentralScheduleDecision,
  requirements: RequestRequirements,
): RethTransportLane {
  assertAdapterSchedule(schedule);
  if (schedule.transportPool !== transportPoolForAdapterRequirements(requirements)) {
    throw new Error("Reth Adapter schedule transport pool disagrees with requirements");
  }
  if (schedule.lane !== centralLaneForAdapterStage(stage)) {
    throw new Error(`Reth Adapter ${stage} schedule has the wrong central lane`);
  }
  return rethLaneForAdapterStage(stage);
}

const FAIRNESS_KEY_PREFIX = "adapter-stage:";

function adapterFairnessKey(stage: AdapterWorkStage, subjectKey: string): string {
  return `${FAIRNESS_KEY_PREFIX}${stage}:${subjectKey}`;
}

function adapterInstanceFairnessKey(input: Parameters<
  CentralAdapterScheduler["issueExecutor"]
>[0]): string {
  return `adapter-instance:${hashCanonical({
    familyId: input.subject.familyId,
    instance: input.subject.instanceKey ?? input.subject.routeKey ?? input.subjectKey,
  })}`;
}

function stageFromAdapterFairnessKey(key: string): AdapterWorkStage {
  if (!key.startsWith(FAIRNESS_KEY_PREFIX)) {
    throw new Error("Reth Adapter schedule was not issued by central policy");
  }
  const stage = key.slice(FAIRNESS_KEY_PREFIX.length).split(":", 1)[0];
  if (!(stage in STAGE_LANES)) {
    throw new Error("Reth Adapter schedule has an invalid stage fairness key");
  }
  return stage as AdapterWorkStage;
}

function assertAdapterSchedule(schedule: CentralScheduleDecision): void {
  if (schedule.lane === "final-sim" || schedule.transportPool === "final-sim") {
    throw new Error("Adapter work cannot consume the reserved final-sim pool");
  }
  if (
    !Number.isFinite(schedule.deadlineAtMs) ||
    !Number.isInteger(schedule.maxAttempts) ||
    schedule.maxAttempts < 1
  ) {
    throw new Error("Reth Adapter schedule has invalid bounds");
  }
  if (
    typeof schedule.fairnessKey !== "string" ||
    schedule.fairnessKey.length === 0
  ) {
    throw new Error("Reth Adapter schedule requires a fairness key");
  }
}

function assertBackend(
  backend: RethAdapterBatchBackend | undefined,
  label: string,
): asserts backend is RethAdapterBatchBackend {
  if (
    backend === undefined ||
    typeof backend.backendId !== "string" ||
    backend.backendId.length === 0 ||
    !Array.isArray(backend.supportedTransports) ||
    typeof backend.executePinnedBatch !== "function"
  ) {
    throw new Error(`invalid ${label} Reth Adapter backend`);
  }
}

function freezeSource(source: CanonicalSource): CanonicalSource {
  return Object.freeze({
    number: source.number,
    hash: source.hash.toLowerCase(),
    generation: source.generation,
  });
}

function freezeRequirements(requirements: RequestRequirements): RequestRequirements {
  return Object.freeze({
    transports: Object.freeze([...requirements.transports]),
    ...(requirements.caller === undefined ? {} : { caller: requirements.caller }),
    ...(requirements.completions === undefined
      ? {}
      : { completions: Object.freeze([...requirements.completions]) }),
    ...(requirements.effects === undefined
      ? {}
      : { effects: Object.freeze([...requirements.effects]) }),
  });
}

function freezeCallerAuthority(
  authority: CentralCallerAuthority,
): CentralCallerAuthority {
  return Object.freeze({
    ...(authority.executor === undefined
      ? {}
      : { executor: authority.executor.toLowerCase() }),
    ...(authority.observedSender === undefined
      ? {}
      : { observedSender: authority.observedSender.toLowerCase() }),
    ...(authority.verifiedActors === undefined
      ? {}
      : {
          verifiedActors: Object.freeze(Object.fromEntries(
            Object.entries(authority.verifiedActors)
              .sort(([left], [right]) => left.localeCompare(right))
              .map(([evidenceId, actor]) => [evidenceId, actor.toLowerCase()]),
          )),
        }),
  });
}

function assertCallerRefAuthority(
  callerRef: Exclude<CallerRef, { readonly kind: "none" }>,
  authority: CentralCallerAuthority,
): void {
  resolveCallerRef(callerRef, authority);
}

/** Central-only binding used immediately before a real backend call. */
export function materializeAdapterRequests(
  requests: readonly AdapterRequest[],
  authority: CentralCallerAuthority,
): readonly MaterializedAdapterRequest[] {
  return Object.freeze(requests.map((request): MaterializedAdapterRequest => {
    switch (request.kind) {
      case "eth-call": {
        const from = request.caller === undefined || request.caller.kind === "none"
          ? undefined
          : resolveCallerRef(request.caller, authority);
        return Object.freeze({
          id: request.id,
          ...(request.required === undefined ? {} : { required: request.required }),
          kind: request.kind,
          to: request.to,
          data: request.data,
          ...(from === undefined ? {} : { from }),
          completion: request.completion,
        });
      }
      case "get-code":
      case "get-storage":
        return request;
      case "state-override-simulation":
      case "effect-delta-simulation": {
        const from = resolveCallerRef(request.call.caller, authority);
        const overrideCaller = resolveCallerRef(
          request.overrideIntent.caller,
          authority,
        );
        if (from !== overrideCaller) {
          throw new Error("materialized simulation override caller mismatch");
        }
        const preCalls = request.preCalls?.map((call) => {
          const preCallFrom = resolveCallerRef(call.caller, authority);
          if (preCallFrom !== from) {
            throw new Error("materialized simulation preCall caller mismatch");
          }
          return Object.freeze({ from: preCallFrom, to: call.to, data: call.data });
        });
        return Object.freeze({
          id: request.id,
          ...(request.required === undefined ? {} : { required: request.required }),
          kind: request.kind,
          ...(preCalls === undefined ? {} : { preCalls: Object.freeze(preCalls) }),
          call: Object.freeze({ from, to: request.call.to, data: request.call.data }),
          overrideIntent: Object.freeze({
            caller: overrideCaller,
            ...(request.overrideIntent.nativeBalanceWei === undefined
              ? {}
              : { nativeBalanceWei: request.overrideIntent.nativeBalanceWei }),
            ...(request.overrideIntent.tokenBalances === undefined
              ? {}
              : { tokenBalances: request.overrideIntent.tokenBalances }),
          }),
          observe: request.observe,
        });
      }
    }
  }));
}

function resolveCallerRef(
  callerRef: CallerRef,
  authority: CentralCallerAuthority,
): string {
  let address: string | undefined;
  switch (callerRef.kind) {
    case "none":
      throw new Error("caller ref none cannot materialize a physical caller");
    case "executor":
      address = authority.executor;
      break;
    case "observed-sender":
      address = authority.observedSender;
      break;
    case "verified-actor":
      address = authority.verifiedActors?.[callerRef.evidenceId];
      break;
  }
  if (address === undefined) {
    const evidence = callerRef.kind === "verified-actor"
      ? ` ${callerRef.evidenceId}`
      : "";
    throw new Error(`central ${callerRef.kind}${evidence} caller authority is missing`);
  }
  if (!/^0x[0-9a-f]{40}$/i.test(address)) {
    throw new Error(`central ${callerRef.kind} caller authority is not an address`);
  }
  return address.toLowerCase();
}

function materializedRequestSetFingerprint(
  requests: readonly MaterializedAdapterRequest[],
): string {
  return hashCanonical(
    requests.map(materializedAdapterRequestFingerprint).sort(),
  );
}

function materializedAdapterRequestFingerprint(
  request: MaterializedAdapterRequest,
): string {
  let value: CanonicalValue;
  switch (request.kind) {
    case "eth-call":
      value = {
        kind: request.kind,
        to: request.to.toLowerCase(),
        data: request.data.toLowerCase(),
        from: request.from?.toLowerCase() ?? null,
        completion: request.completion,
      };
      break;
    case "get-code":
      value = { kind: request.kind, address: request.address.toLowerCase() };
      break;
    case "get-storage":
      value = {
        kind: request.kind,
        address: request.address.toLowerCase(),
        slot: request.slot.toLowerCase(),
      };
      break;
    case "state-override-simulation":
    case "effect-delta-simulation":
      value = {
        kind: request.kind,
        preCalls: (request.preCalls ?? []).map((call) => ({
          from: call.from.toLowerCase(),
          to: call.to.toLowerCase(),
          data: call.data.toLowerCase(),
        })),
        call: {
          from: request.call.from.toLowerCase(),
          to: request.call.to.toLowerCase(),
          data: request.call.data.toLowerCase(),
        },
        overrideIntent: {
          caller: request.overrideIntent.caller.toLowerCase(),
          nativeBalanceWei: request.overrideIntent.nativeBalanceWei ?? null,
          tokenBalances: (request.overrideIntent.tokenBalances ?? []).map((item) => ({
            token: item.token.toLowerCase(),
            amount: item.amount,
          })),
        },
        observe: [...request.observe],
      };
      break;
  }
  return hashCanonical(value);
}

function assertSameRequirements(
  actual: RequestRequirements,
  expected: RequestRequirements,
): void {
  if (
    hashCanonical(requirementsValue(actual)) !==
    hashCanonical(requirementsValue(expected))
  ) {
    throw new Error("Reth Adapter requirements changed after policy binding");
  }
}

function requirementsValue(requirements: RequestRequirements): CanonicalValue {
  return {
    transports: [...requirements.transports].sort(),
    caller: requirements.caller ?? null,
    completions: [...(requirements.completions ?? [])].sort(),
    effects: [...(requirements.effects ?? [])].sort(),
  };
}

function sourceValue(source: CanonicalSource): CanonicalValue {
  return {
    number: source.number,
    hash: source.hash.toLowerCase(),
    generation: source.generation,
  };
}

function reusePolicyValue(
  policy: ResolvedStaticEvidenceReusePolicy,
): CanonicalValue {
  switch (policy.kind) {
    case "source-local":
      return { kind: policy.kind };
    case "immutable-code":
      return { kind: policy.kind, codeSubjects: [...policy.codeSubjects].sort() };
    case "dependency-proof":
      return { kind: policy.kind, dependencyKeys: [...policy.dependencyKeys].sort() };
  }
}

function effectsValue(effects: ObservedEffects | undefined): CanonicalValue {
  if (effects === undefined) return null;
  return {
    tokenDeltas: (effects.tokenDeltas ?? []).map((entry) => ({
      token: entry.token.toLowerCase(),
      account: entry.account.toLowerCase(),
      delta: entry.delta,
    })),
    nativeDeltas: (effects.nativeDeltas ?? []).map((entry) => ({
      account: entry.account.toLowerCase(),
      delta: entry.delta,
    })),
    totalSupplyDeltas: (effects.totalSupplyDeltas ?? []).map((entry) => ({
      token: entry.token.toLowerCase(),
      delta: entry.delta,
    })),
    logs: (effects.logs ?? []).map((entry) => ({
      address: entry.address.toLowerCase(),
      topics: entry.topics.map((topic) => topic.toLowerCase()),
      data: entry.data.toLowerCase(),
    })),
    traceRef: effects.traceRef ?? "",
  };
}

function sameSource(left: CanonicalSource, right: CanonicalSource): boolean {
  return left.number === right.number &&
    left.generation === right.generation &&
    left.hash.toLowerCase() === right.hash.toLowerCase();
}

function boundedPhysicalDeadline(
  consumerDeadlineAtMs: number,
  dedupeWindowMs: number,
): number {
  const deadline = consumerDeadlineAtMs + dedupeWindowMs;
  if (!Number.isFinite(deadline)) {
    throw new Error("Adapter physical dedupe deadline overflowed");
  }
  return deadline;
}

type ConsumerDeadlineResult<Value> =
  | { readonly status: "resolved"; readonly value: Value }
  | { readonly status: "deadline" };

function waitForConsumerDeadline<Value>(input: {
  readonly promise: Promise<Value>;
  readonly deadlineAtMs: number;
  readonly nowMs: () => number;
}): Promise<ConsumerDeadlineResult<Value>> {
  const remaining = input.deadlineAtMs - input.nowMs();
  if (remaining <= 0) {
    return Promise.resolve(Object.freeze({ status: "deadline" as const }));
  }
  return new Promise<ConsumerDeadlineResult<Value>>((resolve, reject) => {
    const timer = setTimeout(
      () => resolve(Object.freeze({ status: "deadline" as const })),
      remaining,
    );
    void input.promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(Object.freeze({ status: "resolved" as const, value }));
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function deadlineController(
  deadlineAtMs: number,
  nowMs: () => number,
): Readonly<{ readonly signal: AbortSignal; dispose(): void }> {
  const controller = new AbortController();
  const remaining = deadlineAtMs - nowMs();
  if (remaining <= 0) {
    controller.abort(new DOMException("Adapter work deadline reached", "TimeoutError"));
    return Object.freeze({ signal: controller.signal, dispose() {} });
  }
  const timer = setTimeout(
    () => controller.abort(new DOMException("Adapter work deadline reached", "TimeoutError")),
    remaining,
  );
  return Object.freeze({
    signal: controller.signal,
    dispose: () => clearTimeout(timer),
  });
}

function schedulerFailure(
  error: unknown,
  controller: Readonly<{ readonly signal: AbortSignal }>,
  deadlineAtMs: number,
  nowMs: () => number,
): CentralAdapterSchedulerError {
  if (error instanceof CentralAdapterSchedulerError) return error;
  return new CentralAdapterSchedulerError({
    stage: "queue",
    code: classifyFailure(error, controller.signal, deadlineAtMs, nowMs),
    message: errorMessage(error),
  });
}

function classifyFailure(
  error: unknown,
  signal: AbortSignal,
  deadlineAtMs: number,
  nowMs: () => number,
): "rpc" | "deadline" | "aborted" | "resource-limited" {
  const message = errorMessage(signal.aborted ? signal.reason : error).toLowerCase();
  if (
    nowMs() >= deadlineAtMs ||
    message.includes("deadline") ||
    message.includes("timeout") ||
    message.includes("timed out")
  ) return "deadline";
  if (
    signal.aborted ||
    message.includes("abort") ||
    message.includes("cancel") ||
    message.includes("supersed")
  ) return "aborted";
  if (
    message.includes("rate limit") ||
    message.includes("too many") ||
    message.includes("resource") ||
    message.includes("capacity") ||
    message.includes("429") ||
    message.includes("503")
  ) return "resource-limited";
  return "rpc";
}

function retryable(
  failure: "rpc" | "deadline" | "aborted" | "resource-limited" | "ingress-full",
): boolean {
  return failure === "rpc" || failure === "resource-limited";
}

function lanePriority(lane: RethTransportLane): number {
  switch (lane) {
    case "producer-critical":
      return 0;
    case "producer-bulk":
      return 1;
    case "exact":
      return 2;
    case "discovery":
      return 3;
  }
}

function zeroTiming(): MutableSchedulerTiming {
  return { queueWaitMs: 0, transportWallMs: 0, attempts: 0 };
}

function positiveOption(
  value: number | undefined,
  fallback: number,
  label: string,
): number {
  const resolved = value ?? fallback;
  assertPositiveInteger(resolved, label);
  return resolved;
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive safe integer`);
  }
}

function elapsed(startedAtMs: number, completedAtMs: number): number {
  return Math.max(0, completedAtMs - startedAtMs);
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("Aborted", "AbortError");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isEvenHex(value: unknown): value is string {
  return typeof value === "string" && /^0x(?:[0-9a-fA-F]{2})*$/.test(value);
}

function extractRevertData(value: unknown): string | null {
  if (isEvenHex(value)) return value;
  if (!isRecord(value)) return null;
  for (const key of ["data", "result", "returnData"]) {
    const nested = extractRevertData(value[key]);
    if (nested !== null) return nested;
  }
  return null;
}

const REQUEST_FAILURES = new Set([
  "rpc",
  "deadline",
  "aborted",
  "resource-limited",
]);
