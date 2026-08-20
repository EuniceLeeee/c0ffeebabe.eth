import assert from "node:assert/strict";
import {
  executeAdapterWork,
  frameworkWorkClassForAdapterStage,
  type AdapterWorkIntent,
  type AdapterWorkStage,
} from "../adapter-work-intent.js";
import {
  centralLaneForAdapterStage,
  createRethAdapterWorkRuntime,
  rethLaneForAdapterStage,
  transportPoolForAdapterRequirements,
  type RethAdapterBatchBackend,
  type RethAdapterBatchResult,
} from "../reth-adapter-work-runtime.js";
import {
  RethTransportScheduler,
  type RethTransportLane,
  type RethTransportLease,
} from "../reth-transport-scheduler.js";
import { familyId, instanceKey, routeKey } from "../venues/adapter-family-identifiers.js";
import type {
  AdapterRequest,
  AdapterRequestResult,
  CanonicalSource,
  MaterializedAdapterRequest,
  RequestProgram,
} from "../venues/adapter-request-program.js";

const FAMILY = familyId("runtime-test");
const INSTANCE = instanceKey("runtime-test:instance");
const ROUTE = routeKey("runtime-test:route");
const TARGET = "0x1111111111111111111111111111111111111111";
const EXECUTOR = "0x2222222222222222222222222222222222222222";
const OTHER_CALLER = "0x3333333333333333333333333333333333333333";
const SOURCE: CanonicalSource = Object.freeze({
  number: 21_000_000,
  hash: `0x${"ab".repeat(32)}`,
  generation: 19,
});

class RecordingScheduler {
  readonly lanes: RethTransportLane[] = [];
  readonly inner = new RethTransportScheduler({ capacity: 8, producerReserved: 2 });

  run<T>(
    lane: RethTransportLane,
    signal: AbortSignal,
    work: (lease: RethTransportLease) => Promise<T>,
  ): Promise<T> {
    this.lanes.push(lane);
    return this.inner.run(lane, signal, work);
  }
}

class RecordingBackend implements RethAdapterBatchBackend {
  readonly backendId = "recording-real-boundary";
  readonly supportedTransports = Object.freeze([
    "eth-call",
    "get-code",
    "get-storage",
  ] as const);
  readonly sources: CanonicalSource[] = [];
  readonly batches: MaterializedAdapterRequest[][] = [];
  failure: Extract<RethAdapterBatchResult, { readonly ok: false }>["failure"] | null = null;

  async executePinnedBatch(input: {
    readonly source: CanonicalSource;
    readonly requests: readonly MaterializedAdapterRequest[];
    readonly signal: AbortSignal;
  }): Promise<readonly RethAdapterBatchResult[]> {
    this.sources.push(input.source);
    this.batches.push([...input.requests]);
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => reject(input.signal.reason);
      input.signal.addEventListener("abort", onAbort, { once: true });
      setImmediate(() => {
        input.signal.removeEventListener("abort", onAbort);
        resolve();
      });
    });
    return Object.freeze(input.requests.map((request): RethAdapterBatchResult =>
      this.failure === null
        ? Object.freeze({
            id: request.id,
            ok: true as const,
            completion: "returned" as const,
            data: "0x1234",
          })
        : Object.freeze({
            id: request.id,
            ok: false as const,
            failure: this.failure!,
          })
    ));
  }
}

class BlockingBackend extends RecordingBackend {
  private release!: () => void;
  private readonly blocker = new Promise<void>((resolve) => {
    this.release = resolve;
  });
  active = 0;
  maxActive = 0;
  started = 0;

  override async executePinnedBatch(input: {
    readonly source: CanonicalSource;
    readonly requests: readonly MaterializedAdapterRequest[];
    readonly signal: AbortSignal;
  }): Promise<readonly RethAdapterBatchResult[]> {
    this.active++;
    this.started++;
    this.maxActive = Math.max(this.maxActive, this.active);
    try {
      await this.blocker;
      return await super.executePinnedBatch(input);
    } finally {
      this.active--;
    }
  }

  unblock(): void {
    this.release();
  }
}

function program(input: {
  readonly caller?: "executor" | "verified-actor";
  readonly requestCount?: number;
  readonly salt?: number;
  readonly idPrefix?: string;
} = {}): RequestProgram<void, readonly AdapterRequestResult[]> {
  return Object.freeze({
    requirements() {
      return Object.freeze({
        transports: Object.freeze(["eth-call"] as const),
        ...(input.caller === undefined ? {} : { caller: input.caller }),
      });
    },
    buildRequests() {
      return Object.freeze(
        Array.from({ length: input.requestCount ?? 1 }, (_, index) =>
          Object.freeze({
            id: `${input.idPrefix ?? `call-${input.salt ?? 0}`}-${index}`,
            kind: "eth-call" as const,
            to: TARGET,
            data: `0x${(index + 1 + (input.salt ?? 0)).toString(16).padStart(2, "0")}00`,
            ...(input.caller === undefined
              ? {}
              : {
                  caller: input.caller === "verified-actor"
                    ? Object.freeze({
                        kind: input.caller,
                        evidenceId: "runtime-test-verified-actor",
                      })
                    : Object.freeze({ kind: input.caller }),
                }),
            completion: "return-data" as const,
          })
        ),
      );
    },
    decode({ results }: {
      readonly programInput: void;
      readonly results: readonly AdapterRequestResult[];
    }) {
      return results;
    },
  });
}

function simulationProgram(): RequestProgram<void, string> {
  return Object.freeze({
    requirements() {
      return Object.freeze({
        transports: Object.freeze(["effect-delta-simulation"] as const),
        caller: "executor" as const,
        effects: Object.freeze(["token-delta"] as const),
      });
    },
    buildRequests() {
      return Object.freeze([Object.freeze({
        id: "effect",
        kind: "effect-delta-simulation" as const,
        call: Object.freeze({
          caller: Object.freeze({ kind: "executor" as const }),
          to: TARGET,
          data: "0x1234",
        }),
        overrideIntent: Object.freeze({
          caller: Object.freeze({ kind: "executor" as const }),
        }),
        observe: Object.freeze(["token-delta"] as const),
      })]);
    },
    decode() {
      return "must-not-decode";
    },
  });
}

function intent<Evidence>(
  stage: AdapterWorkStage,
  requestProgram: RequestProgram<void, Evidence>,
  subject: Readonly<{
    readonly instance?: typeof INSTANCE;
    readonly route?: typeof ROUTE;
  }> = {},
): AdapterWorkIntent<void, Evidence> {
  return Object.freeze({
    stage,
    familyId: FAMILY,
    instanceKey: subject.instance ?? INSTANCE,
    routeKey: subject.route ?? ROUTE,
    source: SOURCE,
    generation: SOURCE.generation,
    program: requestProgram,
    programInput: undefined,
  });
}

function harness(input: {
  readonly backend?: RecordingBackend;
  readonly scheduler?: RecordingScheduler;
  readonly executor?: string;
  readonly omitExecutorAuthority?: boolean;
  readonly maxPhysicalBatchSize?: number;
  readonly stageAttempts?: number;
  readonly stageTimeoutMs?: number;
  readonly physicalDedupeWindowMs?: number;
  readonly staleAtFenceCheck?: number;
  readonly nowMs?: () => number;
} = {}) {
  const backend = input.backend ?? new RecordingBackend();
  const scheduler = input.scheduler ?? new RecordingScheduler();
  const now = Date.now();
  let fenceChecks = 0;
  const stages: AdapterWorkStage[] = [
    "identity",
    "instance-static",
    "pricing-static",
    "pricing-current",
    "runtime-evidence",
    "exact-refine",
  ];
  const stageLimits = Object.fromEntries(stages.map((stage) => [stage, {
    timeoutMs: input.stageTimeoutMs ?? 60_000,
    maxAttempts: input.stageAttempts ?? 1,
  }])) as Record<AdapterWorkStage, { timeoutMs: number; maxAttempts: number }>;
  const runtime = createRethAdapterWorkRuntime({
    transportScheduler: scheduler,
    backends: { stateRead: backend },
    callerAuthority: {
      bind() {
        return input.omitExecutorAuthority
          ? Object.freeze({})
          : Object.freeze({
              executor: input.executor ?? EXECUTOR,
              verifiedActors: {
                "runtime-test-verified-actor": OTHER_CALLER,
              },
            });
      },
    },
    generationFence: {
      assertCurrent(generation, source) {
        fenceChecks++;
        if (fenceChecks === input.staleAtFenceCheck) {
          throw new Error("test generation superseded");
        }
        assert.equal(generation, SOURCE.generation);
        assert.equal(source.number, SOURCE.number);
        assert.equal(source.hash.toLowerCase(), SOURCE.hash.toLowerCase());
      },
    },
    nowMs: input.nowMs ?? (() => now),
    maxPhysicalBatchSize: input.maxPhysicalBatchSize ?? 32,
    ...(input.physicalDedupeWindowMs === undefined
      ? {}
      : { physicalDedupeWindowMs: input.physicalDedupeWindowMs }),
    stageLimits,
  });
  return { backend, scheduler, runtime, fenceChecks: () => fenceChecks };
}

async function stageAndPoolMapping(): Promise<void> {
  const expected: ReadonlyArray<readonly [
    AdapterWorkStage,
    ReturnType<typeof rethLaneForAdapterStage>,
    ReturnType<typeof centralLaneForAdapterStage>,
    ReturnType<typeof frameworkWorkClassForAdapterStage>,
  ]> = [
    ["identity", "discovery", "background", "background"],
    ["instance-static", "discovery", "background", "background"],
    ["pricing-static", "producer-bulk", "foreground", "foreground"],
    ["pricing-current", "producer-bulk", "foreground", "foreground"],
    ["runtime-evidence", "producer-critical", "critical-proof", "head-critical"],
    ["exact-refine", "exact", "foreground", "foreground"],
  ];
  const h = harness();
  for (const [stage, rethLane, centralLane, workClass] of expected) {
    assert.equal(rethLaneForAdapterStage(stage), rethLane);
    assert.equal(centralLaneForAdapterStage(stage), centralLane);
    const outcome = await executeAdapterWork({
      intent: intent(stage, program()),
      runtime: h.runtime,
    });
    assert.equal(
      outcome.status,
      "resolved",
      `${stage}: ${outcome.status === "unresolved" ? outcome.failure.message : ""}`,
    );
    assert.equal(outcome.receipt.schedule?.lane, centralLane);
    assert.equal(outcome.receipt.workClass, workClass);
    assert.notEqual(outcome.receipt.schedule?.transportPool, "final-sim");
  }
  assert.deepEqual(h.scheduler.lanes, expected.map((entry) => entry[1]));
  assert.equal(
    transportPoolForAdapterRequirements({
      transports: ["effect-delta-simulation"],
      effects: ["trace"],
    }),
    "effect-sim",
  );
  assert.equal(
    transportPoolForAdapterRequirements({
      transports: ["eth-call"],
      effects: ["trace"],
    }),
    "trace",
  );
}

async function sourceAndCallerBinding(): Promise<void> {
  const acceptedHarness = harness();
  const accepted = await executeAdapterWork({
    intent: intent("exact-refine", program({ caller: "executor" })),
    runtime: acceptedHarness.runtime,
  });
  assert.equal(accepted.status, "resolved");
  assert.equal(acceptedHarness.backend.sources.length, 1);
  const physicalRequest = acceptedHarness.backend.batches[0]?.[0];
  assert.equal(physicalRequest?.kind, "eth-call");
  if (physicalRequest?.kind === "eth-call") {
    assert.equal(physicalRequest.from, EXECUTOR.toLowerCase());
  }
  assert.deepEqual(acceptedHarness.backend.sources[0], {
    ...SOURCE,
    hash: SOURCE.hash.toLowerCase(),
  });
  if (accepted.status === "resolved") {
    const result = accepted.executed.evidence[0];
    assert(result?.ok);
    assert.equal(result.source.hash, SOURCE.hash.toLowerCase());
    assert.equal(result.provenance.kind, "reth-pinned-adapter-batch");
    assert.match(result.provenance.fingerprint, /^[0-9a-f]{64}$/);
    assert(Object.isFrozen(result));
  }

  const rejectedHarness = harness({ omitExecutorAuthority: true });
  const rejected = await executeAdapterWork({
    intent: intent(
      "exact-refine",
      program({ caller: "executor" }),
    ),
    runtime: rejectedHarness.runtime,
  });
  assert.equal(rejected.status, "unresolved");
  if (rejected.status === "unresolved") {
    assert.equal(rejected.failure.stage, "caller-authority");
    assert.equal(rejected.failure.code, "authority-failure");
  }
  assert.equal(rejectedHarness.backend.batches.length, 0);
}

async function dedupeAndPrioritySeparation(): Promise<void> {
  const duplicateHarness = harness();
  const duplicateProgram = program();
  const [first, second] = await Promise.all([
    executeAdapterWork({
      intent: intent("pricing-static", duplicateProgram),
      runtime: duplicateHarness.runtime,
    }),
    executeAdapterWork({
      intent: intent("pricing-static", duplicateProgram),
      runtime: duplicateHarness.runtime,
    }),
  ]);
  assert.equal(first.status, "resolved");
  assert.equal(second.status, "resolved");
  assert.equal(duplicateHarness.backend.batches.length, 1);
  assert.equal(duplicateHarness.scheduler.lanes.length, 1);
  assert.equal(duplicateHarness.runtime.snapshot().coalescedWaiters, 1);

  const beforeRemap = duplicateHarness.backend.batches.length;
  const [alpha, beta] = await Promise.all([
    executeAdapterWork({
      intent: intent("pricing-static", program({ idPrefix: "alpha" })),
      runtime: duplicateHarness.runtime,
    }),
    executeAdapterWork({
      intent: intent("pricing-static", program({ idPrefix: "beta" })),
      runtime: duplicateHarness.runtime,
    }),
  ]);
  assert.equal(alpha.status, "resolved");
  assert.equal(beta.status, "resolved");
  assert.equal(
    duplicateHarness.backend.batches.length - beforeRemap,
    1,
    "consumer-local request ids must not pollute physical dedupe",
  );
  if (alpha.status === "resolved" && beta.status === "resolved") {
    assert.equal(alpha.executed.evidence[0]?.id, "alpha-0");
    assert.equal(beta.executed.evidence[0]?.id, "beta-0");
  }

  const priorityHarness = harness();
  const [producer, exact] = await Promise.all([
    executeAdapterWork({
      intent: intent("pricing-static", program()),
      runtime: priorityHarness.runtime,
    }),
    executeAdapterWork({
      intent: intent("exact-refine", program()),
      runtime: priorityHarness.runtime,
    }),
  ]);
  assert.equal(producer.status, "resolved");
  assert.equal(exact.status, "resolved");
  assert.equal(
    producer.receipt.dedupeKey,
    exact.receipt.dedupeKey,
    "fixture holds central schedule bounds equal so only physical lane separates work",
  );
  assert.equal(priorityHarness.backend.batches.length, 2);
  assert.deepEqual(
    [...priorityHarness.scheduler.lanes].sort(),
    ["exact", "producer-bulk"],
  );

  const callerHarness = harness();
  const [executorCall, verifiedCall] = await Promise.all([
    executeAdapterWork({
      intent: intent("exact-refine", program({ caller: "executor" })),
      runtime: callerHarness.runtime,
    }),
    executeAdapterWork({
      intent: intent("exact-refine", program({ caller: "verified-actor" })),
      runtime: callerHarness.runtime,
    }),
  ]);
  assert.equal(executorCall.status, "resolved");
  assert.equal(verifiedCall.status, "resolved");
  assert.equal(
    callerHarness.backend.batches.length,
    2,
    "different materialized callers must not physically dedupe",
  );
  assert.deepEqual(
    callerHarness.backend.batches
      .map((batch) => batch[0])
      .filter((request) => request?.kind === "eth-call")
      .map((request) => request.from)
      .sort(),
    [EXECUTOR.toLowerCase(), OTHER_CALLER.toLowerCase()].sort(),
  );
}

async function nearbyConsumerDeadlinesShareOnePhysicalSession(): Promise<void> {
  let clock = Date.now();
  const backend = new BlockingBackend();
  const h = harness({
    backend,
    nowMs: () => clock++,
    physicalDedupeWindowMs: 1_000,
  });
  const works = [
    executeAdapterWork({
      intent: intent("pricing-static", program({ idPrefix: "short-a" })),
      runtime: h.runtime,
    }),
    executeAdapterWork({
      intent: intent("pricing-static", program({ idPrefix: "short-b" })),
      runtime: h.runtime,
    }),
  ];
  for (let turn = 0; backend.started < 1 && turn < 20; turn++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(backend.started, 1);
  assert.equal(h.runtime.snapshot().inFlightPrograms, 1);
  assert.equal(h.runtime.snapshot().coalescedWaiters, 1);
  backend.unblock();
  const [first, second] = await Promise.all(works);
  assert.equal(first.status, "resolved");
  assert.equal(second.status, "resolved");
  assert.equal(
    h.backend.batches.length,
    1,
    "near-simultaneous consumers must not lose dedupe to millisecond clock drift",
  );
}

async function longerConsumerOutsideWindowGetsIndependentSession(): Promise<void> {
  let clock = Date.now();
  const backend = new BlockingBackend();
  const h = harness({
    backend,
    nowMs: () => clock,
    physicalDedupeWindowMs: 100,
  });
  const first = executeAdapterWork({
    intent: intent("pricing-static", program({ idPrefix: "window-a" })),
    runtime: h.runtime,
  });
  for (let turn = 0; backend.started < 1 && turn < 20; turn++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(backend.started, 1);
  clock += 101;
  const second = executeAdapterWork({
    intent: intent("pricing-static", program({ idPrefix: "window-b" })),
    runtime: h.runtime,
  });
  for (
    let turn = 0;
    h.runtime.snapshot().inFlightPrograms < 2 && turn < 20;
    turn++
  ) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(
    h.runtime.snapshot().inFlightPrograms,
    2,
    "a longer consumer outside the bounded window needs independent physical work",
  );
  backend.unblock();
  const outcomes = await Promise.all([first, second]);
  assert(outcomes.every((outcome) => outcome.status === "resolved"));
  assert.equal(backend.batches.length, 2);
}

async function logicalDeadlineDoesNotReleasePhysicalOwnership(): Promise<void> {
  const backend = new BlockingBackend();
  const h = harness({
    backend,
    nowMs: Date.now,
    stageTimeoutMs: 15,
    physicalDedupeWindowMs: 200,
  });
  const outcome = await executeAdapterWork({
    intent: intent("pricing-static", program({ idPrefix: "logical-timeout" })),
    runtime: h.runtime,
  });
  assert.equal(outcome.status, "unresolved");
  if (outcome.status === "unresolved") {
    assert.equal(outcome.failure.stage, "transport");
    assert.equal(outcome.failure.code, "deadline");
  }
  assert.equal(backend.active, 1);
  assert.equal(h.runtime.snapshot().inFlightPrograms, 1);
  assert.equal(
    h.scheduler.inner.snapshot().activeTotal,
    1,
    "consumer timeout must not release the physical transport permit",
  );

  backend.unblock();
  for (
    let turn = 0;
    h.runtime.snapshot().inFlightPrograms > 0 && turn < 20;
    turn++
  ) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(h.runtime.snapshot().inFlightPrograms, 0);
  assert.equal(backend.active, 0);
  assert.equal(h.scheduler.inner.snapshot().activeTotal, 0);
}

async function failureTypingAndBoundedRetry(): Promise<void> {
  const backend = new RecordingBackend();
  backend.failure = "rpc";
  const h = harness({ backend, stageAttempts: 2 });
  const outcome = await executeAdapterWork({
    intent: intent("pricing-current", program()),
    runtime: h.runtime,
  });
  assert.equal(outcome.status, "unresolved");
  if (outcome.status === "unresolved") {
    assert.equal(outcome.failure.disposition, "unresolved");
    assert.equal(outcome.failure.stage, "transport");
    assert.equal(outcome.failure.code, "rpc");
    assert.equal(outcome.receipt.timing.attempts, 2);
  }
  assert.equal(backend.batches.length, 2, "retry must be bounded by maxAttempts");
  assert.deepEqual(h.scheduler.lanes, ["producer-bulk", "producer-bulk"]);
}

async function staleQueuedWorkStopsBeforePhysicalIo(): Promise<void> {
  const h = harness({ staleAtFenceCheck: 3 });
  const outcome = await executeAdapterWork({
    intent: intent("pricing-current", program()),
    runtime: h.runtime,
  });
  assert.equal(outcome.status, "unresolved");
  if (outcome.status === "unresolved") {
    assert.equal(outcome.failure.stage, "queue");
    assert.equal(outcome.failure.code, "aborted");
    assert.match(outcome.failure.message, /stale before physical I\/O/);
  }
  assert.equal(h.fenceChecks(), 3);
  assert.equal(h.backend.batches.length, 0);
  assert.equal(h.scheduler.inner.snapshot().activeTotal, 0);
}

async function instanceFairnessUsesOneCentralQueue(): Promise<void> {
  const backend = new BlockingBackend();
  const h = harness({ backend });
  const instanceA = instanceKey("runtime-test:instance-a");
  const instanceB = instanceKey("runtime-test:instance-b");
  const instanceC = instanceKey("runtime-test:instance-c");
  const works = [
    executeAdapterWork({
      intent: intent("pricing-static", program({ salt: 1 }), {
        instance: instanceA,
        route: routeKey("runtime-test:route-a1"),
      }),
      runtime: h.runtime,
    }),
    executeAdapterWork({
      intent: intent("pricing-static", program({ salt: 2 }), {
        instance: instanceA,
        route: routeKey("runtime-test:route-a2"),
      }),
      runtime: h.runtime,
    }),
    executeAdapterWork({
      intent: intent("pricing-static", program({ salt: 3 }), {
        instance: instanceB,
        route: routeKey("runtime-test:route-b"),
      }),
      runtime: h.runtime,
    }),
    executeAdapterWork({
      intent: intent("pricing-static", program({ salt: 4 }), {
        instance: instanceC,
        route: routeKey("runtime-test:route-c"),
      }),
      runtime: h.runtime,
    }),
  ];
  for (let turn = 0; backend.started < 3 && turn < 20; turn++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert(
    backend.started >= 3,
    "distinct instances of one Family must share the central queue without a Family cap",
  );
  assert.equal(
    h.runtime.snapshot().queuedBatches,
    1,
    "only the second request for the same instance remains queued",
  );
  backend.unblock();
  const outcomes = await Promise.all(works);
  assert(outcomes.every((outcome) => outcome.status === "resolved"));
  assert.equal(backend.maxActive, 3, "distinct instances may execute concurrently");
}

async function physicalPermitScopeAndFinalSimIsolation(): Promise<void> {
  const h = harness({ maxPhysicalBatchSize: 2 });
  const outcome = await executeAdapterWork({
    intent: intent("pricing-current", program({ requestCount: 5 })),
    runtime: h.runtime,
  });
  assert.equal(outcome.status, "resolved");
  assert.deepEqual(h.backend.batches.map((batch) => batch.length), [2, 2, 1]);
  assert.equal(h.scheduler.lanes.length, 3, "one permit must wrap each physical batch");
  assert(h.scheduler.inner.snapshot().activeTotal === 0, "all physical permits released");

  assert.throws(
    () => h.runtime.budgets.assertAdmitted({
      lane: "final-sim",
      deadlineAtMs: Date.now() + 1_000,
      maxAttempts: 1,
      transportPool: "final-sim",
      fairnessKey: "forbidden",
    }, []),
    /reserved final-sim/,
  );

  const unsupported = await executeAdapterWork({
    intent: intent("runtime-evidence", simulationProgram()),
    runtime: h.runtime,
  });
  assert.equal(unsupported.status, "unresolved");
  if (unsupported.status === "unresolved") {
    assert.equal(unsupported.failure.stage, "transport");
    assert.equal(unsupported.failure.code, "resource-limited");
  }
  assert.equal(
    h.backend.batches.length,
    3,
    "missing effect backend must fail closed before any physical transport",
  );
}

await stageAndPoolMapping();
await sourceAndCallerBinding();
await dedupeAndPrioritySeparation();
await nearbyConsumerDeadlinesShareOnePhysicalSession();
await longerConsumerOutsideWindowGetsIndependentSession();
await logicalDeadlineDoesNotReleasePhysicalOwnership();
await failureTypingAndBoundedRetry();
await staleQueuedWorkStopsBeforePhysicalIo();
await instanceFairnessUsesOneCentralQueue();
await physicalPermitScopeAndFinalSimIsolation();

console.log(
  "reth-adapter-work-runtime PASS " +
    "(lanes/source/caller/dedupe/fairness/retry/permits/final-sim isolation)",
);
