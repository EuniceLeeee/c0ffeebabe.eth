import assert from "node:assert/strict";
import {
  CentralAdapterSchedulerError,
  adapterWorkSubjectKey,
  executeAdapterWork,
  executeFinalSimulationWork,
  type AdapterGenerationFence,
  type AdapterWorkIntent,
  type CentralCallerAuthority,
  type CentralAdapterPolicyInput,
  type CentralAdapterRuntime,
  type CentralAdapterScheduler,
  type CentralFinalSimulationRuntime,
  type CentralScheduleDecision,
  type FinalSimulationWorkIntent,
} from "../adapter-work-intent.js";
import {
  familyId,
  instanceKey,
  routeKey,
} from "../venues/adapter-family-identifiers.js";
import {
  createBoundedRequestExecutor,
  type AdapterRequest,
  type AdapterRequestResult,
  type CanonicalSource,
  type RequestProgram,
  type RequestRequirements,
} from "../venues/adapter-request-program.js";

const FAMILY = familyId("swap:test-work-intent");
const INSTANCE = instanceKey("pool:0x1111");
const ROUTE = routeKey("route:token0-token1");
const OTHER_INSTANCE = instanceKey("pool:0x2222");
const OTHER_ROUTE = routeKey("route:token1-token0");
const CALLER = `0x${"22".repeat(20)}`;
const TARGET = `0x${"33".repeat(20)}`;
const UNTRUSTED_CALLER = `0x${"44".repeat(20)}`;

const source = (hashByte: string, generation = 7): CanonicalSource =>
  Object.freeze({
    number: 25_700_001,
    hash: `0x${hashByte.repeat(64)}`,
    generation,
  });

class TestFence implements AdapterGenerationFence {
  current = true;
  checks = 0;

  assertCurrent(): void {
    this.checks++;
    if (!this.current) throw new Error("synthetic stale generation");
  }
}

class IncrementingClock {
  private value = 10_000;

  nowMs(): number {
    return this.value++;
  }
}

interface SchedulerOptions {
  readonly afterTransport?: () => void;
  readonly failureResult?: "rpc" | "deadline" | "aborted" | "resource-limited";
  readonly thrownFailure?: CentralAdapterSchedulerError;
}

class CoalescingScheduler implements CentralAdapterScheduler {
  readonly issues: Array<Parameters<CentralAdapterScheduler["issueExecutor"]>[0]> = [];
  readonly callerRoles: string[] = [];
  readonly pending = new Map<string, Promise<readonly AdapterRequestResult[]>>();
  physicalExecutions = 0;

  constructor(private readonly options: SchedulerOptions = {}) {}

  issueExecutor(
    input: Parameters<CentralAdapterScheduler["issueExecutor"]>[0],
  ): ReturnType<CentralAdapterScheduler["issueExecutor"]> {
    this.issues.push(input);
    assert(Object.isFrozen(input.callerAuthority));
    const executor = createBoundedRequestExecutor({
      assertSupported(requirements) {
        assert.deepEqual(requirements, input.requirements);
      },
      assertCallerBinding: (binding) => {
        this.callerRoles.push(binding.callerRef.kind);
        assert.equal(binding.familyId, FAMILY);
        assert.equal(binding.source.hash.toLowerCase(), input.source.hash.toLowerCase());
      },
      assertWithinBudget(family, requests) {
        assert.equal(family, FAMILY);
        assert.deepEqual(requests, input.requests);
      },
      execute: async (executionInput) => {
        if (this.options.thrownFailure) throw this.options.thrownFailure;
        const sessionKey = [
          input.dedupeKey,
          input.schedule.lane,
          input.schedule.transportPool,
          input.schedule.deadlineAtMs,
          input.schedule.maxAttempts,
        ].join("\u001f");
        let shared = this.pending.get(sessionKey);
        if (!shared) {
          this.physicalExecutions++;
          shared = new Promise((resolve) => {
            setImmediate(() => {
              const results: readonly AdapterRequestResult[] =
                executionInput.requests.map((request) =>
                  this.options.failureResult
                    ? {
                        id: request.id,
                        ok: false as const,
                        source: executionInput.source,
                        failure: this.options.failureResult,
                      }
                    : {
                        id: request.id,
                        ok: true as const,
                        source: executionInput.source,
                        provenance: {
                          kind: "synthetic-pinned",
                          fingerprint: "scheduler-issued",
                        },
                        completion: "returned" as const,
                        data: "0x01",
                      }
                );
              this.options.afterTransport?.();
              resolve(results);
            });
          });
          this.pending.set(sessionKey, shared);
          void shared.finally(() => this.pending.delete(sessionKey));
        }
        return await shared;
      },
      sealStaticEvidenceReuseProof() {
        return { proofHash: "ab".repeat(32) };
      },
    });
    return Object.freeze({
      executor,
      timing: () => Object.freeze({
        queueWaitMs: 2,
        transportWallMs: 5,
        attempts: 1,
      }),
    });
  }
}

class StructurallyForgedScheduler implements CentralAdapterScheduler {
  issueExecutor(
    input: Parameters<CentralAdapterScheduler["issueExecutor"]>[0],
  ): ReturnType<CentralAdapterScheduler["issueExecutor"]> {
    const genuine = createBoundedRequestExecutor({
      assertSupported() {},
      assertCallerBinding() {},
      assertWithinBudget() {},
      async execute() {
        return [];
      },
      sealStaticEvidenceReuseProof() {
        return { proofHash: "ab".repeat(32) };
      },
    });
    const forged = {
      ...genuine,
      async execute(executionInput: Parameters<typeof genuine.execute>[0]) {
        return executionInput.requests.map((request) => ({
          id: request.id,
          ok: true as const,
          source: input.source,
          provenance: {
            kind: "forged",
            fingerprint: "must-not-be-reissued",
          },
          completion: "returned" as const,
          data: "0xdeadbeef",
        }));
      },
      sealStaticEvidenceReuseProof() {
        return { proofHash: "cd".repeat(32) };
      },
    };
    return {
      executor: forged as never,
      timing: () => ({ queueWaitMs: 0, transportWallMs: 0, attempts: 0 }),
    };
  }
}

interface RuntimeHarness {
  readonly runtime: CentralAdapterRuntime;
  readonly scheduler: CoalescingScheduler;
  readonly fence: TestFence;
  readonly policyInputs: CentralAdapterPolicyInput[];
  readonly admissions: Array<{
    readonly schedule: CentralScheduleDecision;
    readonly requestCount: number;
  }>;
}

function runtimeHarness(input: {
  readonly scheduler?: CoalescingScheduler;
  readonly fence?: TestFence;
  readonly rejectAdmission?: boolean;
  readonly callerAuthority?: CentralCallerAuthority;
  readonly scheduleOverride?: CentralScheduleDecision;
} = {}): RuntimeHarness {
  const scheduler = input.scheduler ?? new CoalescingScheduler();
  const fence = input.fence ?? new TestFence();
  const policyInputs: CentralAdapterPolicyInput[] = [];
  const admissions: Array<{
    readonly schedule: CentralScheduleDecision;
    readonly requestCount: number;
  }> = [];
  const runtime: CentralAdapterRuntime = {
    clock: new IncrementingClock(),
    generationFence: fence,
    callerAuthority: {
      bind() {
        return input.callerAuthority ?? {
          executor: CALLER,
          observedSender: CALLER,
          verifiedActors: { "test-verified-actor": CALLER },
        };
      },
    },
    policy: {
      bind(policyInput) {
        policyInputs.push(policyInput);
        if (input.scheduleOverride !== undefined) {
          return input.scheduleOverride;
        }
        const lane = policyInput.stage === "identity"
          ? "critical-proof"
          : policyInput.stage === "exact-refine"
            ? "foreground"
            : "background";
        return {
          lane,
          deadlineAtMs: 20_000,
          maxAttempts: policyInput.stage === "identity" ? 1 : 2,
          transportPool: policyInput.requirements.transports.includes("effect-delta-simulation")
            ? "effect-sim"
            : "state-read",
          fairnessKey: policyInput.subjectKey,
        };
      },
    },
    budgets: {
      assertAdmitted(schedule, requests) {
        admissions.push({ schedule, requestCount: requests.length });
        if (input.rejectAdmission) throw new Error("synthetic ingress full");
      },
    },
    scheduler,
  };
  return { runtime, scheduler, fence, policyInputs, admissions };
}

interface ProgramCounter {
  requirements: number;
  builds: number;
  decodes: number;
}

function callProgram(input: {
  readonly counter: ProgramCounter;
  readonly caller?: RequestRequirements["caller"];
  readonly completion?: "return-data" | "return-or-revert-data";
}): RequestProgram<void, string> {
  const completion = input.completion ?? "return-data";
  const request: AdapterRequest = Object.freeze({
    id: "state",
    kind: "eth-call",
    to: TARGET,
    data: "0x12345678",
    ...(input.caller === undefined || input.caller === "none"
      ? {}
      : {
          caller: input.caller === "verified-actor"
            ? Object.freeze({
                kind: input.caller,
                evidenceId: "test-verified-actor",
              })
            : Object.freeze({ kind: input.caller }),
        }),
    completion,
  });
  const program: RequestProgram<void, string> = {
    requirements() {
      input.counter.requirements++;
      return {
        transports: ["eth-call"],
        ...(input.caller === undefined ? {} : { caller: input.caller }),
      };
    },
    buildRequests() {
      input.counter.builds++;
      return [request];
    },
    decode({ results }) {
      input.counter.decodes++;
      assert.equal(results[0]?.ok, true);
      return "decoded";
    },
  };
  return Object.freeze(program);
}

function effectProgram(input: {
  readonly counter: ProgramCounter;
  readonly effect: "token-delta" | "native-delta";
}): RequestProgram<void, string> {
  const program: RequestProgram<void, string> = {
    requirements() {
      input.counter.requirements++;
      return {
        transports: ["effect-delta-simulation"],
        caller: "executor",
        effects: [input.effect],
      };
    },
    buildRequests() {
      input.counter.builds++;
      return [{
        id: "effect",
        kind: "effect-delta-simulation",
        call: {
          caller: { kind: "executor" },
          to: TARGET,
          data: "0xabcdef01",
        },
        overrideIntent: { caller: { kind: "executor" } },
        observe: [input.effect],
      }];
    },
    decode() {
      input.counter.decodes++;
      return "effect-decoded";
    },
  };
  return Object.freeze(program);
}

function intent(input: {
  readonly source?: CanonicalSource;
  readonly stage?: AdapterWorkIntent<void, string>["stage"];
  readonly instanceKey?: typeof INSTANCE;
  readonly routeKey?: typeof ROUTE;
  readonly program: RequestProgram<void, string>;
}): AdapterWorkIntent<void, string> {
  const canonicalSource = input.source ?? source("a");
  return Object.freeze({
    stage: input.stage ?? "pricing-current",
    familyId: FAMILY,
    instanceKey: input.instanceKey ?? INSTANCE,
    routeKey: input.routeKey ?? ROUTE,
    source: canonicalSource,
    generation: canonicalSource.generation,
    program: input.program,
    programInput: undefined,
  });
}

function counter(): ProgramCounter {
  return { requirements: 0, builds: 0, decodes: 0 };
}

async function staleBeforeIoStopsAtFence(): Promise<void> {
  const fence = new TestFence();
  fence.current = false;
  const harness = runtimeHarness({ fence });
  const calls = counter();
  const outcome = await executeAdapterWork({
    intent: intent({ program: callProgram({ counter: calls }) }),
    runtime: harness.runtime,
  });
  assert.equal(outcome.status, "unresolved");
  if (outcome.status !== "unresolved") return;
  assert.equal(outcome.failure.stage, "generation-fence-before-io");
  assert.equal(outcome.failure.code, "stale-generation");
  assert.deepEqual(calls, { requirements: 0, builds: 0, decodes: 0 });
  assert.equal(harness.scheduler.physicalExecutions, 0);
  assert.equal(harness.policyInputs.length, 0);
}

async function staleAfterIoBlocksDecodeAndPublication(): Promise<void> {
  const fence = new TestFence();
  const scheduler = new CoalescingScheduler({
    afterTransport: () => {
      fence.current = false;
    },
  });
  const harness = runtimeHarness({ fence, scheduler });
  const calls = counter();
  const outcome = await executeAdapterWork({
    intent: intent({ program: callProgram({ counter: calls }) }),
    runtime: harness.runtime,
  });
  assert.equal(outcome.status, "unresolved");
  if (outcome.status !== "unresolved") return;
  assert.equal(outcome.failure.stage, "generation-fence-after-io");
  assert.equal(outcome.failure.code, "stale-generation");
  assert.equal(calls.decodes, 0, "post-I/O stale work must not enter Adapter decode");
  assert.equal(scheduler.physicalExecutions, 1);
  assert.equal(outcome.receipt.failureStage, "generation-fence-after-io");
}

async function centralPolicyOwnsScheduleAndAdmission(): Promise<void> {
  const harness = runtimeHarness();
  const calls = counter();
  const work = intent({
    stage: "exact-refine",
    program: callProgram({ counter: calls }),
  });
  const outcome = await executeAdapterWork({ intent: work, runtime: harness.runtime });
  assert.equal(outcome.status, "resolved");
  if (outcome.status !== "resolved") return;
  assert.equal(harness.policyInputs[0]?.stage, "exact-refine");
  assert.equal(harness.policyInputs[0]?.workClass, "foreground");
  assert.equal(outcome.receipt.workClass, "foreground");
  assert.equal(outcome.receipt.schedule?.lane, "foreground");
  assert.equal(outcome.receipt.schedule?.fairnessKey, outcome.receipt.subjectKey);
  assert.equal(
    outcome.receipt.subjectKey,
    adapterWorkSubjectKey(outcome.receipt.subject),
  );
  assert.equal(harness.admissions.length, 1);
  assert.equal(harness.scheduler.issues.length, 1);
  assert.equal(harness.scheduler.issues[0]?.subjectKey, outcome.receipt.subjectKey);
  assert(Object.isFrozen(outcome));
  assert(Object.isFrozen(outcome.receipt));
  assert(Object.isFrozen(outcome.receipt.timing));
  assert.equal(outcome.receipt.timing.queueWaitMs, 2);
  assert.equal(outcome.receipt.timing.transportWallMs, 5);
  assert.equal(outcome.receipt.timing.attempts, 1);

  const rejectedHarness = runtimeHarness({ rejectAdmission: true });
  const rejected = await executeAdapterWork({
    intent: work,
    runtime: rejectedHarness.runtime,
  });
  assert.equal(rejected.status, "unresolved");
  if (rejected.status === "unresolved") {
    assert.equal(rejected.failure.stage, "admission");
    assert.equal(rejected.failure.code, "admission-failure");
  }
  assert.equal(rejectedHarness.scheduler.physicalExecutions, 0);

  const poisoned = {
    ...work,
    workClass: "background",
    lane: "background",
    deadlineAtMs: Number.MAX_SAFE_INTEGER,
  } as AdapterWorkIntent<void, string>;
  const poisonedHarness = runtimeHarness();
  const poisonedOutcome = await executeAdapterWork({
    intent: poisoned,
    runtime: poisonedHarness.runtime,
  });
  assert.equal(poisonedOutcome.status, "unresolved");
  if (poisonedOutcome.status === "unresolved") {
    assert.equal(poisonedOutcome.failure.stage, "intent");
    assert.match(poisonedOutcome.failure.message, /must not declare central field/);
  }
  assert.equal(poisonedHarness.policyInputs.length, 0);
}

async function centralCallerAuthorityCannotBeSelfAttested(): Promise<void> {
  const accepted = await executeAdapterWork({
    intent: intent({
      program: callProgram({
        counter: counter(),
        caller: "executor",
      }),
    }),
    runtime: runtimeHarness({
      callerAuthority: { executor: CALLER },
    }).runtime,
  });
  assert.equal(accepted.status, "resolved");

  for (const role of ["observed-sender", "verified-actor"] as const) {
    const harness = runtimeHarness({
      callerAuthority: role === "observed-sender"
        ? {}
        : { verifiedActors: { "different-evidence": CALLER } },
    });
    const outcome = await executeAdapterWork({
      intent: intent({
        program: callProgram({
          counter: counter(),
          caller: role,
        }),
      }),
      runtime: harness.runtime,
    });
    assert.equal(outcome.status, "unresolved");
    if (outcome.status === "unresolved") {
      assert.equal(outcome.failure.stage, "caller-authority");
      assert.equal(outcome.failure.code, "authority-failure");
    }
    assert.equal(harness.scheduler.physicalExecutions, 0);
  }
}

async function schedulerCannotForgeExecutorIssuance(): Promise<void> {
  const harness = runtimeHarness();
  const runtime: CentralAdapterRuntime = {
    ...harness.runtime,
    scheduler: new StructurallyForgedScheduler(),
  };
  const calls = counter();
  const outcome = await executeAdapterWork({
    intent: intent({ program: callProgram({ counter: calls }) }),
    runtime,
  });
  assert.equal(outcome.status, "unresolved");
  if (outcome.status === "unresolved") {
    assert.equal(outcome.failure.stage, "scheduler-issue");
    assert.match(outcome.failure.message, /issued by the central runtime/);
  }
  assert.equal(calls.decodes, 0, "forged results must never reach Adapter decode");
}

async function adapterCannotConsumeFinalSimulationReserve(): Promise<void> {
  const harness = runtimeHarness({
    scheduleOverride: {
      lane: "final-sim",
      deadlineAtMs: 20_000,
      maxAttempts: 1,
      transportPool: "final-sim",
      fairnessKey: "reserved-final-sim",
    },
  });
  const outcome = await executeAdapterWork({
    intent: intent({ program: callProgram({ counter: counter() }) }),
    runtime: harness.runtime,
  });
  assert.equal(outcome.status, "unresolved");
  if (outcome.status === "unresolved") {
    assert.equal(outcome.failure.stage, "policy");
    assert.match(outcome.failure.message, /reserved final-sim lane or pool/);
  }
  assert.equal(harness.scheduler.physicalExecutions, 0);
}

async function dedupeRequiresCompatibleBindings(): Promise<void> {
  const scheduler = new CoalescingScheduler();
  const harness = runtimeHarness({ scheduler });

  const duplicateA = counter();
  const duplicateB = counter();
  const duplicateOutcomes = await Promise.all([
    executeAdapterWork({
      intent: intent({ program: callProgram({ counter: duplicateA }) }),
      runtime: harness.runtime,
    }),
    executeAdapterWork({
      intent: intent({
        stage: "runtime-evidence",
        instanceKey: OTHER_INSTANCE,
        routeKey: OTHER_ROUTE,
        program: callProgram({ counter: duplicateB }),
      }),
      runtime: harness.runtime,
    }),
  ]);
  assert(duplicateOutcomes.every((outcome) => outcome.status === "resolved"));
  assert.equal(
    scheduler.physicalExecutions,
    1,
    "compatible physical reads coalesce across central work stages",
  );
  assert.equal(scheduler.issues[0]?.dedupeKey, scheduler.issues[1]?.dedupeKey);
  assert.notEqual(
    scheduler.issues[0]?.subjectKey,
    scheduler.issues[1]?.subjectKey,
    "distinct fairness subjects remain visible outside the physical dedupe key",
  );

  const beforePriority = scheduler.physicalExecutions;
  await Promise.all([
    executeAdapterWork({
      intent: intent({
        stage: "identity",
        program: callProgram({ counter: counter() }),
      }),
      runtime: harness.runtime,
    }),
    executeAdapterWork({
      intent: intent({
        stage: "pricing-current",
        program: callProgram({ counter: counter() }),
      }),
      runtime: harness.runtime,
    }),
  ]);
  assert.equal(
    scheduler.physicalExecutions - beforePriority,
    2,
    "critical work must not inherit a background schedule through dedupe",
  );
  assert.equal(
    scheduler.issues[2]?.dedupeKey,
    scheduler.issues[3]?.dedupeKey,
    "logical scheduling fields must not pollute physical request identity",
  );

  const beforeSource = scheduler.physicalExecutions;
  await Promise.all([
    executeAdapterWork({
      intent: intent({
        source: source("b"),
        program: callProgram({ counter: counter() }),
      }),
      runtime: harness.runtime,
    }),
    executeAdapterWork({
      intent: intent({
        source: source("c"),
        program: callProgram({ counter: counter() }),
      }),
      runtime: harness.runtime,
    }),
  ]);
  assert.equal(
    scheduler.physicalExecutions - beforeSource,
    2,
    "different canonical sources must not coalesce",
  );

  const beforeCaller = scheduler.physicalExecutions;
  await Promise.all([
    executeAdapterWork({
      intent: intent({
        program: callProgram({
          counter: counter(),
          caller: "executor",
        }),
      }),
      runtime: harness.runtime,
    }),
    executeAdapterWork({
      intent: intent({
        program: callProgram({
          counter: counter(),
          caller: "verified-actor",
        }),
      }),
      runtime: harness.runtime,
    }),
  ]);
  assert.equal(
    scheduler.physicalExecutions - beforeCaller,
    2,
    "different caller roles must not coalesce",
  );

  const beforeEffects = scheduler.physicalExecutions;
  await Promise.all([
    executeAdapterWork({
      intent: intent({
        program: effectProgram({ counter: counter(), effect: "token-delta" }),
      }),
      runtime: harness.runtime,
    }),
    executeAdapterWork({
      intent: intent({
        program: effectProgram({ counter: counter(), effect: "native-delta" }),
      }),
      runtime: harness.runtime,
    }),
  ]);
  assert.equal(
    scheduler.physicalExecutions - beforeEffects,
    2,
    "different effect contracts must not coalesce",
  );
}

async function transportFailuresStayUnresolved(): Promise<void> {
  const scheduler = new CoalescingScheduler({ failureResult: "rpc" });
  const harness = runtimeHarness({ scheduler });
  const calls = counter();
  const outcome = await executeAdapterWork({
    intent: intent({ program: callProgram({ counter: calls }) }),
    runtime: harness.runtime,
  });
  assert.equal(outcome.status, "unresolved");
  if (outcome.status !== "unresolved") return;
  assert.equal(outcome.failure.disposition, "unresolved");
  assert.equal(outcome.failure.stage, "transport");
  assert.equal(outcome.failure.code, "rpc");
  assert.equal(calls.decodes, 0, "RPC failure must not reach behavior decode");
  assert.equal("rejected" in outcome, false);

  const optionalCalls = counter();
  const optionalProgram: RequestProgram<void, string> = Object.freeze({
    requirements() {
      optionalCalls.requirements++;
      return { transports: ["eth-call"] as const };
    },
    buildRequests() {
      optionalCalls.builds++;
      return [{
        id: "optional-state",
        required: false as const,
        kind: "eth-call" as const,
        to: TARGET,
        data: "0x12345678",
        completion: "return-data" as const,
      }];
    },
    decode({ results }: {
      readonly programInput: void;
      readonly results: readonly AdapterRequestResult[];
    }) {
      optionalCalls.decodes++;
      assert.equal(results[0]?.ok, false);
      return "optional-failure-observed";
    },
  });
  const optionalOutcome = await executeAdapterWork({
    intent: intent({ program: optionalProgram }),
    runtime: runtimeHarness({
      scheduler: new CoalescingScheduler({ failureResult: "rpc" }),
    }).runtime,
  });
  assert.equal(optionalOutcome.status, "resolved");
  if (optionalOutcome.status === "resolved") {
    assert.equal(optionalOutcome.executed.evidence, "optional-failure-observed");
  }
  assert.equal(optionalCalls.decodes, 1);

  const thrownScheduler = new CoalescingScheduler({
    thrownFailure: new CentralAdapterSchedulerError({
      stage: "queue",
      code: "ingress-full",
      message: "synthetic bounded queue full",
    }),
  });
  const thrownOutcome = await executeAdapterWork({
    intent: intent({ program: callProgram({ counter: counter() }) }),
    runtime: runtimeHarness({ scheduler: thrownScheduler }).runtime,
  });
  assert.equal(thrownOutcome.status, "unresolved");
  if (thrownOutcome.status === "unresolved") {
    assert.equal(thrownOutcome.failure.stage, "queue");
    assert.equal(thrownOutcome.failure.code, "ingress-full");
  }
}

async function finalSimulationUsesOnlyItsReservedPool(): Promise<void> {
  const canonicalSource = source("f");
  const intent: FinalSimulationWorkIntent<{ readonly planHash: string }> =
    Object.freeze({
      stage: "fork-final-sim",
      source: canonicalSource,
      generation: canonicalSource.generation,
      resolvedPlan: Object.freeze({ planHash: "plan-v1" }),
    });
  const fence = new TestFence();
  const runtime: CentralFinalSimulationRuntime<
    { readonly planHash: string },
    string
  > = {
    generationFence: fence,
    policy: {
      bind() {
        return {
          lane: "final-sim",
          deadlineAtMs: 20_000,
          maxAttempts: 1,
          transportPool: "final-sim",
          fairnessKey: "mandatory-final-sim",
        };
      },
    },
    scheduler: {
      async executeFinalSimulation(input) {
        assert.equal(input.schedule.lane, "final-sim");
        assert.equal(input.schedule.transportPool, "final-sim");
        return input.intent.resolvedPlan.planHash;
      },
    },
  };
  assert.equal(await executeFinalSimulationWork({ intent, runtime }), "plan-v1");
  assert.equal(fence.checks, 2);

  const invalidRuntime: CentralFinalSimulationRuntime<
    { readonly planHash: string },
    string
  > = {
    ...runtime,
    policy: {
      bind() {
        return {
          lane: "foreground",
          deadlineAtMs: 20_000,
          maxAttempts: 1,
          transportPool: "state-read",
          fairnessKey: "not-reserved",
        };
      },
    },
  };
  await assert.rejects(
    executeFinalSimulationWork({ intent, runtime: invalidRuntime }),
    /must use the reserved final-sim lane and pool/,
  );
}

await staleBeforeIoStopsAtFence();
await staleAfterIoBlocksDecodeAndPublication();
await centralPolicyOwnsScheduleAndAdmission();
await centralCallerAuthorityCannotBeSelfAttested();
await schedulerCannotForgeExecutorIssuance();
await adapterCannotConsumeFinalSimulationReserve();
await dedupeRequiresCompatibleBindings();
await transportFailuresStayUnresolved();
await finalSimulationUsesOnlyItsReservedPool();

console.log(
  "adapter-work-intent PASS (central policy/fences/bounds/fair-dedupe/unresolved)",
);
