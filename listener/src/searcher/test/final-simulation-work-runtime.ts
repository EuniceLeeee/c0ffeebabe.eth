import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  executeFinalSimulationWork,
  type AdapterGenerationFence,
  type FinalSimulationScheduleDecision,
  type FinalSimulationWorkIntent,
} from "../adapter-work-intent.js";
import {
  FinalSimulationWorkRuntimeError,
  createBlockScanWorkerFinalSimulationRunner,
  createFinalSimulationWorkRuntime,
  type FinalSimulationRunnerInput,
  type FinalSimulationTelemetryReceipt,
  type FinalSimulationWorkRuntime,
  type MandatoryFinalSimulationRunner,
} from "../final-simulation-work-runtime.js";
import { RethTransportScheduler } from "../reth-transport-scheduler.js";
import type { ResolvedPlan } from "../solver/solver.js";
import type { SimulationResult } from "../simulator/botvm-simulator.js";
import type { CanonicalSource } from "../venues/adapter-request-program.js";

interface TestPlan {
  readonly id: string;
  bytesHex: string;
  readonly expectedSha256: string;
  readonly signal?: AbortSignal;
}

interface TestResult {
  readonly id: string;
  readonly bytesHex: string;
}

interface TestResource {
  readonly id: string;
}

const source = (generation: number): CanonicalSource => Object.freeze({
  number: 25_800_000 + generation,
  hash: `0x${generation.toString(16).padStart(2, "0").repeat(32)}`,
  generation,
});

const hashBytes = (bytesHex: string): string => createHash("sha256")
  .update(Buffer.from(bytesHex.slice(2), "hex"))
  .digest("hex");

const plan = (id: string, byte: string, signal?: AbortSignal): TestPlan => {
  const bytesHex = `0x${byte.repeat(4)}`;
  return {
    id,
    bytesHex,
    expectedSha256: hashBytes(bytesHex),
    ...(signal === undefined ? {} : { signal }),
  };
};

const intent = (
  generation: number,
  resolvedPlan: TestPlan,
): FinalSimulationWorkIntent<TestPlan> => ({
  stage: "fork-final-sim",
  source: source(generation),
  generation,
  resolvedPlan,
});

class TestFence implements AdapterGenerationFence {
  readonly checks: Array<{ generation: number; source: CanonicalSource }> = [];
  readonly stale = new Set<number>();

  assertCurrent(generation: number, currentSource: CanonicalSource): void {
    this.checks.push({ generation, source: currentSource });
    if (
      this.stale.has(generation) ||
      currentSource.generation !== generation
    ) {
      throw new Error(`stale generation ${generation}`);
    }
  }
}

interface HarnessOptions {
  readonly fence?: TestFence;
  readonly resources?: number;
  readonly maxQueued?: number;
  readonly timeoutMs?: number;
  readonly runner?: MandatoryFinalSimulationRunner<
    TestResource,
    TestPlan,
    TestResult
  >;
  readonly telemetry?: FinalSimulationTelemetryReceipt[];
}

function harness(options: HarnessOptions = {}): {
  readonly fence: TestFence;
  readonly runtime: FinalSimulationWorkRuntime<TestPlan, TestResult>;
} {
  const fence = options.fence ?? new TestFence();
  const resources = options.resources ?? 1;
  const runner = options.runner ?? Object.freeze({
    async simulate(
      input: FinalSimulationRunnerInput<TestResource, TestPlan>,
    ): Promise<TestResult> {
      return { id: input.resolvedPlan.id, bytesHex: input.resolvedPlanBytesHex };
    },
  });
  return {
    fence,
    runtime: createFinalSimulationWorkRuntime({
      reservedResources: Object.freeze(Array.from(
        { length: resources },
        (_, index) => Object.freeze({
          id: `reserved-final-sim-${index}`,
          value: Object.freeze({ id: `worker-${index}` }),
        }),
      )),
      runner,
      generationFence: fence,
      planIdentity: Object.freeze({
        bytesHex: (resolved: TestPlan) => resolved.bytesHex,
        expectedSha256: (resolved: TestPlan) => resolved.expectedSha256,
        resultBytesHex: (result: TestResult) => result.bytesHex,
      }),
      timeoutMs: options.timeoutMs ?? 1_000,
      maxQueued: options.maxQueued ?? 2,
      signalForIntent: (work) => work.resolvedPlan.signal,
      onTelemetry: (receipt) => options.telemetry?.push(receipt),
    }),
  };
}

interface Deferred<T = void> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}

function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function runtimeFailure(
  promise: Promise<unknown>,
  code: FinalSimulationWorkRuntimeError["failureCode"],
): Promise<FinalSimulationWorkRuntimeError> {
  try {
    await promise;
    assert.fail(`expected final simulation failure ${code}`);
  } catch (error) {
    assert(error instanceof FinalSimulationWorkRuntimeError);
    assert.equal(error.failureCode, code);
    assert.equal(error.disposition, "unresolved");
    return error;
  }
}

async function scheduleAndRethIsolation(): Promise<void> {
  const reth = new RethTransportScheduler({ capacity: 3, producerReserved: 1 });
  const releaseReth = deferred();
  const exactStarted = deferred();
  const discoveryStarted = deferred();
  const signal = new AbortController().signal;
  const exact = reth.run("exact", signal, async () => {
    exactStarted.resolve();
    await releaseReth.promise;
  });
  const discovery = reth.run("discovery", signal, async () => {
    discoveryStarted.resolve();
    await releaseReth.promise;
  });
  await Promise.all([exactStarted.promise, discoveryStarted.promise]);
  assert.equal(reth.snapshot().activeTotal, 2);

  const receipts: FinalSimulationTelemetryReceipt[] = [];
  const simulationStarted = deferred();
  let exactPlanReference: TestPlan | null = null;
  const runner: MandatoryFinalSimulationRunner<
    TestResource,
    TestPlan,
    TestResult
  > = Object.freeze({
    async simulate(
      input: FinalSimulationRunnerInput<TestResource, TestPlan>,
    ): Promise<TestResult> {
      exactPlanReference = input.resolvedPlan;
      assert.equal(input.schedule.lane, "final-sim");
      assert.equal(input.schedule.transportPool, "final-sim");
      assert.equal(input.schedule.maxAttempts, 1);
      assert.equal(input.resolvedPlanBytesHex, input.resolvedPlan.bytesHex);
      assert.equal(input.resolvedPlanSha256, input.resolvedPlan.expectedSha256);
      simulationStarted.resolve();
      return {
        id: input.resolvedPlan.id,
        bytesHex: input.resolvedPlanBytesHex,
      };
    },
  });
  const h = harness({ runner, telemetry: receipts });
  const resolvedPlan = plan("isolated", "ab");
  const resultPromise = executeFinalSimulationWork({
    intent: intent(1, resolvedPlan),
    runtime: h.runtime,
  });
  await Promise.race([
    simulationStarted.promise,
    new Promise<never>((_resolve, reject) => setTimeout(
      () => reject(new Error("reserved final-sim slot was blocked by reth")),
      100,
    )),
  ]);
  assert.equal(
    reth.snapshot().activeTotal,
    2,
    "exact/discovery saturation must not own a reserved final-sim slot",
  );
  const result = await resultPromise;
  assert.equal(result.id, "isolated");
  assert.equal(exactPlanReference, resolvedPlan, "runner must receive exact plan object");
  assert(h.fence.checks.length >= 5, "all central and bridge fences must execute");
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].lane, "final-sim");
  assert.equal(receipts[0].transportPool, "final-sim");
  assert(receipts[0].queueWaitMs >= 0);
  assert(receipts[0].simulationWallMs >= 0);

  const bound = h.runtime.policy.bind({
    source: source(2),
    generation: 2,
    resolvedPlan: plan("schedule", "ac"),
  });
  assert.equal(bound.lane, "final-sim");
  assert.equal(bound.transportPool, "final-sim");
  assert.equal(bound.maxAttempts, 1);
  await runtimeFailure(
    h.runtime.scheduler.executeFinalSimulation({
      intent: intent(2, plan("wrong-schedule", "ad")),
      schedule: {
        ...bound,
        lane: "foreground",
        transportPool: "state-read",
      } as unknown as FinalSimulationScheduleDecision,
    }),
    "invalid-schedule",
  );

  releaseReth.resolve();
  await Promise.all([exact, discovery]);
}

async function boundedIngressAndNoReuse(): Promise<void> {
  const releases = new Map<string, Deferred>();
  const starts = new Map<string, Deferred>();
  let calls = 0;
  const runner: MandatoryFinalSimulationRunner<
    TestResource,
    TestPlan,
    TestResult
  > = Object.freeze({
    async simulate(
      input: FinalSimulationRunnerInput<TestResource, TestPlan>,
    ): Promise<TestResult> {
      calls++;
      starts.get(input.resolvedPlan.id)?.resolve();
      await releases.get(input.resolvedPlan.id)?.promise;
      return {
        id: input.resolvedPlan.id,
        bytesHex: input.resolvedPlanBytesHex,
      };
    },
  });
  for (const id of ["first", "second"]) {
    releases.set(id, deferred());
    starts.set(id, deferred());
  }
  const h = harness({ runner, maxQueued: 1 });
  const first = executeFinalSimulationWork({
    intent: intent(10, plan("first", "10")),
    runtime: h.runtime,
  });
  await starts.get("first")!.promise;
  const second = executeFinalSimulationWork({
    intent: intent(11, plan("second", "11")),
    runtime: h.runtime,
  });
  assert.deepEqual(
    { active: h.runtime.snapshot().active, queued: h.runtime.snapshot().queued },
    { active: 1, queued: 1 },
  );
  await runtimeFailure(
    executeFinalSimulationWork({
      intent: intent(12, plan("overflow", "12")),
      runtime: h.runtime,
    }),
    "ingress-full",
  );
  releases.get("first")!.resolve();
  await first;
  await starts.get("second")!.promise;
  releases.get("second")!.resolve();
  await second;
  assert.equal(calls, 2, "each intent must run mandatory sim; exact reuse is forbidden");
  const repeated = plan("repeated", "13");
  await executeFinalSimulationWork({
    intent: intent(13, repeated),
    runtime: h.runtime,
  });
  await executeFinalSimulationWork({
    intent: intent(13, repeated),
    runtime: h.runtime,
  });
  assert.equal(calls, 4, "identical final-sim intents must not reuse an exact result");
}

async function generationFences(): Promise<void> {
  const firstRelease = deferred();
  const firstStarted = deferred();
  const calls: string[] = [];
  const fence = new TestFence();
  const h = harness({
    fence,
    runner: Object.freeze({
      async simulate(
        input: FinalSimulationRunnerInput<TestResource, TestPlan>,
      ): Promise<TestResult> {
        calls.push(input.resolvedPlan.id);
        if (input.resolvedPlan.id === "active") {
          firstStarted.resolve();
          await firstRelease.promise;
        }
        if (input.resolvedPlan.id === "stale-after") {
          fence.stale.add(input.generation);
        }
        return {
          id: input.resolvedPlan.id,
          bytesHex: input.resolvedPlanBytesHex,
        };
      },
    }),
  });

  const active = executeFinalSimulationWork({
    intent: intent(20, plan("active", "20")),
    runtime: h.runtime,
  });
  await firstStarted.promise;
  const staleQueued = executeFinalSimulationWork({
    intent: intent(21, plan("stale-queued", "21")),
    runtime: h.runtime,
  });
  fence.stale.add(21);
  firstRelease.resolve();
  await active;
  await runtimeFailure(staleQueued, "stale-generation");
  assert.deepEqual(calls, ["active"], "stale queued generation must never simulate");

  await runtimeFailure(
    executeFinalSimulationWork({
      intent: intent(22, plan("stale-after", "22")),
      runtime: h.runtime,
    }),
    "stale-generation",
  );
  assert.deepEqual(calls, ["active", "stale-after"]);
  assert.equal(
    h.runtime.snapshot().completed,
    1,
    "a result made stale during simulation must not return/publish",
  );

  fence.stale.add(23);
  await assert.rejects(
    executeFinalSimulationWork({
      intent: intent(23, plan("stale-before", "23")),
      runtime: h.runtime,
    }),
    /stale generation 23/,
  );
  assert.deepEqual(calls, ["active", "stale-after"]);
}

async function planByteIntegrity(): Promise<void> {
  let calls = 0;
  const h = harness({
    runner: Object.freeze({
      async simulate(
        input: FinalSimulationRunnerInput<TestResource, TestPlan>,
      ): Promise<TestResult> {
        calls++;
        return {
          id: input.resolvedPlan.id,
          bytesHex: input.resolvedPlan.id === "wrong-result"
            ? "0xdeadbeef"
            : input.resolvedPlanBytesHex,
        };
      },
    }),
  });
  const wrong = plan("wrong-input", "31");
  wrong.bytesHex = "0x32323232";
  await runtimeFailure(
    executeFinalSimulationWork({ intent: intent(31, wrong), runtime: h.runtime }),
    "plan-integrity",
  );
  assert.equal(calls, 0, "wrong bytes must fail before the real runner");

  await runtimeFailure(
    executeFinalSimulationWork({
      intent: intent(32, plan("wrong-result", "32")),
      runtime: h.runtime,
    }),
    "plan-integrity",
  );
  assert.equal(calls, 1, "runner byte mismatch must fail before publication");

  const blockRelease = deferred();
  const blockStarted = deferred();
  const queuedCalls: string[] = [];
  const queuedHarness = harness({
    runner: Object.freeze({
      async simulate(
        input: FinalSimulationRunnerInput<TestResource, TestPlan>,
      ): Promise<TestResult> {
        queuedCalls.push(input.resolvedPlan.id);
        if (input.resolvedPlan.id === "block") {
          blockStarted.resolve();
          await blockRelease.promise;
        }
        return { id: input.resolvedPlan.id, bytesHex: input.resolvedPlanBytesHex };
      },
    }),
  });
  const block = executeFinalSimulationWork({
    intent: intent(33, plan("block", "33")),
    runtime: queuedHarness.runtime,
  });
  await blockStarted.promise;
  const mutable = plan("mutated-while-queued", "34");
  const queued = executeFinalSimulationWork({
    intent: intent(34, mutable),
    runtime: queuedHarness.runtime,
  });
  mutable.bytesHex = "0x35353535";
  blockRelease.resolve();
  await block;
  await runtimeFailure(queued, "plan-integrity");
  assert.deepEqual(queuedCalls, ["block"]);
}

async function typedTerminalFailures(): Promise<void> {
  let timeoutTerminations = 0;
  const timeoutHarness = harness({
    timeoutMs: 20,
    runner: Object.freeze({
      simulate: async () => new Promise<TestResult>(() => {}),
      terminate: () => {
        timeoutTerminations++;
      },
    }),
  });
  await runtimeFailure(
    executeFinalSimulationWork({
      intent: intent(40, plan("timeout", "40")),
      runtime: timeoutHarness.runtime,
    }),
    "timeout",
  );
  assert.equal(timeoutTerminations, 1);
  assert.equal(timeoutHarness.runtime.snapshot().healthyResources, 0);
  assert.equal(timeoutHarness.runtime.snapshot().retiredResources, 1);

  const controller = new AbortController();
  const abortStarted = deferred();
  let abortTerminations = 0;
  const abortHarness = harness({
    runner: Object.freeze({
      simulate: async () => {
        abortStarted.resolve();
        return new Promise<TestResult>(() => {});
      },
      terminate: () => {
        abortTerminations++;
      },
    }),
  });
  const aborted = executeFinalSimulationWork({
    intent: intent(41, plan("aborted", "41", controller.signal)),
    runtime: abortHarness.runtime,
  });
  await abortStarted.promise;
  controller.abort(new Error("pass superseded"));
  await runtimeFailure(aborted, "aborted");
  assert.equal(abortTerminations, 1);

  let resourceTerminations = 0;
  const resourceHarness = harness({
    runner: Object.freeze({
      async simulate(): Promise<TestResult> {
        throw new Error("Anvil worker exited");
      },
      terminate: () => {
        resourceTerminations++;
      },
    }),
  });
  await runtimeFailure(
    executeFinalSimulationWork({
      intent: intent(42, plan("resource", "42")),
      runtime: resourceHarness.runtime,
    }),
    "resource-failure",
  );
  assert.equal(resourceTerminations, 1);
  assert.equal(resourceHarness.runtime.snapshot().healthyResources, 0);
}

async function existingBlockScanRunnerAdapter(): Promise<void> {
  const resolvedPlan = Object.freeze({ id: "same-plan-reference" }) as unknown as
    ResolvedPlan;
  const simulation: SimulationResult = {
    success: true,
    profitToken: `0x${"11".repeat(20)}`,
    grossProfit: 1n,
    gasUsed: 1n,
    netProfit: 1n,
    calldata: "0x1234",
    scriptHex: "0xabcd",
  };
  let received: ResolvedPlan | null = null;
  let stopped = 0;
  const worker = {
    simulator: {
      async simulate(candidate: ResolvedPlan): Promise<SimulationResult> {
        received = candidate;
        return simulation;
      },
    },
    state: {
      stop(): void {
        stopped++;
      },
    },
  };
  const runner = createBlockScanWorkerFinalSimulationRunner<typeof worker>();
  const schedule: FinalSimulationScheduleDecision = {
    lane: "final-sim",
    transportPool: "final-sim",
    deadlineAtMs: Date.now() + 1_000,
    maxAttempts: 1,
    fairnessKey: "mandatory-final-sim:test",
  };
  const result = await runner.simulate({
    resource: worker,
    source: source(50),
    generation: 50,
    resolvedPlan,
    resolvedPlanBytesHex: "0xabcd",
    resolvedPlanSha256: hashBytes("0xabcd"),
    schedule,
    signal: new AbortController().signal,
  });
  assert.equal(result, simulation);
  assert.equal(received, resolvedPlan);
  runner.terminate?.({
    resource: worker,
    reason: new FinalSimulationWorkRuntimeError(
      "timeout",
      "simulation",
      "test termination",
    ),
  });
  assert.equal(stopped, 1, "existing timeout reaper must remain the terminator");
}

await scheduleAndRethIsolation();
await boundedIngressAndNoReuse();
await generationFences();
await planByteIntegrity();
await typedTerminalFailures();
await existingBlockScanRunnerAdapter();

console.log(
  "final-simulation-work-runtime PASS " +
    "(reserved pool/bounded ingress/fences/plan bytes/typed failures/telemetry)",
);
