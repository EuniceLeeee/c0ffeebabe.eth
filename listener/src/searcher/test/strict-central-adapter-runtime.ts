import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createStrictCentralAdapterRuntime,
  type StrictSimulationTransport,
} from "../strict-central-adapter-runtime.js";
import {
  executeAdapterWork,
  type AdapterWorkControl,
  type CentralAdapterRuntime,
} from "../adapter-work-intent.js";
import {
  runStrictFamilyLifecycle,
} from "../strict-family-lifecycle-runner.js";
import {
  physicalAdapterRequestFingerprint,
  type AdapterRequest,
  type AdapterRequestResult,
  type CanonicalSource,
} from "../venues/adapter-request-program.js";
import { hashCanonical } from "../venues/canonical-value.js";
import { RethTransportScheduler } from "../reth-transport-scheduler.js";
import {
  PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG,
} from "../venues/production-family-composition.js";
import { WSTETH_FAMILY_ID } from
  "../venues/protocols/wsteth-family/manifest.js";
import { WSTETH_INTERFACE } from
  "../venues/protocols/wsteth-family/codec.js";
import {
  PRODUCTION_STRICT_VERIFIED_ACTORS,
} from "../venues/production-verified-actors.js";

const catalog = PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG;
const SOURCE: CanonicalSource = Object.freeze({
  number: 25_700_444,
  hash: `0x${"51".repeat(32)}`,
  generation: 44,
});
const WSTETH = "0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0";
const STETH = "0xae7ab96520de3a18e5e111b5eaab095312d7fe84";

function mockProvider() {
  return Object.freeze({
    call: async (tx: { readonly to: string; readonly data: string }) => {
      const data = tx.data.toLowerCase();
      if (data.startsWith(WSTETH_INTERFACE.getFunction("stETH")!.selector)) {
        return WSTETH_INTERFACE.encodeFunctionResult("stETH", [STETH]);
      }
      if (data.startsWith(
        WSTETH_INTERFACE.getFunction("getWstETHByStETH")!.selector,
      )) {
        return WSTETH_INTERFACE.encodeFunctionResult("getWstETHByStETH", [
          10n ** 18n,
        ]);
      }
      if (data.startsWith(
        WSTETH_INTERFACE.getFunction("getStETHByWstETH")!.selector,
      )) {
        return WSTETH_INTERFACE.encodeFunctionResult("getStETHByWstETH", [
          10n ** 18n,
        ]);
      }
      if (data.startsWith(WSTETH_INTERFACE.getFunction("wrap")!.selector)) {
        return WSTETH_INTERFACE.encodeFunctionResult("getWstETHByStETH", [
          10n ** 18n,
        ]);
      }
      if (data.startsWith(WSTETH_INTERFACE.getFunction("unwrap")!.selector)) {
        return WSTETH_INTERFACE.encodeFunctionResult("getStETHByWstETH", [
          10n ** 18n,
        ]);
      }
      if (data === "0x") {
        return "0x";
      }
      throw new Error(`unexpected mock call ${data}`);
    },
    getCode: async () => "0x00",
    getStorage: async () => `0x${"0".repeat(64)}`,
  });
}

async function main(): Promise<void> {
  const runtime = createStrictCentralAdapterRuntime({
    provider: mockProvider() as never,
    generationFence: Object.freeze({ assertCurrent() {} }),
  });
  const publication = await runStrictFamilyLifecycle({
    catalog,
    familyId: WSTETH_FAMILY_ID,
    source: SOURCE,
    observations: Object.freeze([Object.freeze({
      kind: "call" as const,
      source: SOURCE,
      target: WSTETH,
      data: `${WSTETH_INTERFACE.getFunction("wrap")!.selector}${"0".repeat(64)}`,
    })]),
    runtime,
  });
  assert(publication.instances.length >= 1);
  assert.equal(publication.instances[0]!.familyId, WSTETH_FAMILY_ID);

  const issued = runtime.scheduler.issueExecutor({} as never);
  const simulationRequest = Object.freeze({
    id: "sim:effect",
    kind: "effect-delta-simulation" as const,
    call: Object.freeze({
      caller: Object.freeze({ kind: "executor" as const }),
      to: WSTETH,
      data: "0x",
    }),
    overrideIntent: Object.freeze({ caller: Object.freeze({ kind: "executor" as const }) }),
    observe: Object.freeze([] as const),
  });
  const unresolved = await issued.executor.execute({
    requests: Object.freeze([simulationRequest]),
    source: SOURCE,
  } as never);
  assert.equal(unresolved[0]!.ok, false);
  assert(unresolved[0]!.ok === false);
  assert.equal(unresolved[0]!.failure, "resource-limited");

  const simulatedRuntime = createStrictCentralAdapterRuntime({
    provider: mockProvider() as never,
    generationFence: Object.freeze({ assertCurrent() {} }),
    simulator: Object.freeze({
      simulate: async () => Object.freeze({
        data: "0xdeadbeef",
        effects: Object.freeze({
          tokenDeltas: Object.freeze([Object.freeze({
            token: `0x${"22".repeat(20)}`,
            account: `0x${"33".repeat(20)}`,
            delta: 5n,
          })]),
        }),
      }),
    }),
  });
  const simulatedIssued = simulatedRuntime.scheduler.issueExecutor({} as never);
  const simulated = await simulatedIssued.executor.execute({
    requests: Object.freeze([simulationRequest]),
    source: SOURCE,
  } as never);
  assert.equal(simulated[0]!.ok, true);
  assert(simulated[0]!.ok === true);
  assert.equal(simulated[0]!.data, "0xdeadbeef");
  assert.equal(simulated[0]!.effects?.tokenDeltas?.[0]?.delta, 5n);

  const revertProvider = Object.freeze({
    call: async () => {
      const error = new Error("execution reverted");
      (error as { data?: string }).data = "0xdeadbeef";
      throw error;
    },
    getCode: async () => "0x00",
    getStorage: async () => `0x${"0".repeat(64)}`,
  });
  const revertRuntime = createStrictCentralAdapterRuntime({
    provider: revertProvider as never,
    generationFence: Object.freeze({ assertCurrent() {} }),
  });
  const revertExecutor = revertRuntime.scheduler.issueExecutor({} as never);
  const revertResults = await revertExecutor.executor.execute({
    requests: Object.freeze([
      Object.freeze({
        id: "declared-revert",
        kind: "eth-call" as const,
        to: WSTETH,
        data: "0x12345678",
        completion: "return-or-revert-data" as const,
      }),
      Object.freeze({
        id: "plain-call",
        kind: "eth-call" as const,
        to: WSTETH,
        data: "0x12345678",
        completion: "return-data" as const,
      }),
    ]),
    source: SOURCE,
  } as never);
  assert.equal(revertResults[0]!.ok, true);
  assert(revertResults[0]!.ok === true);
  assert.equal(revertResults[0]!.completion, "reverted-as-declared");
  assert.equal(revertResults[0]!.data, "0xdeadbeef");
  // An execution-layer revert is chain-proven evidence at the fixed cutoff
  // even when the request declared return-data: retrying cannot change a
  // deterministic revert, so it must not be classified as a transport rpc.
  assert.equal(revertResults[1]!.ok, true);
  assert(revertResults[1]!.ok === true);
  assert.equal(revertResults[1]!.completion, "reverted-as-declared");
  assert.equal(revertResults[1]!.data, "0xdeadbeef");

  let directProducerCalls = 0;
  let batchedProducerCalls = 0;
  const producerBatchRuntime = createStrictCentralAdapterRuntime({
    provider: {
      ...mockProvider(),
      async call() {
        directProducerCalls++;
        throw new Error("producer eth_call bypassed batch transport");
      },
    } as never,
    producerCallBackend: Object.freeze({
      async call() {
        batchedProducerCalls++;
        return "0x1234";
      },
    }),
    generationFence: Object.freeze({ assertCurrent() {} }),
  });
  const producerBatchExecutor = producerBatchRuntime.scheduler.issueExecutor({
    schedule: Object.freeze({ rethLane: "producer-bulk" }),
  } as never);
  const producerBatchResults = await producerBatchExecutor.executor.execute({
    requests: Object.freeze([Object.freeze({
      id: "producer-batch-call",
      kind: "eth-call" as const,
      to: WSTETH,
      data: "0x12345678",
      completion: "return-data" as const,
    })]),
    source: SOURCE,
  } as never);
  assert.equal(producerBatchResults[0]!.ok, true);
  assert.equal(batchedProducerCalls, 1);
  assert.equal(directProducerCalls, 0);

  const failingSimulatorRuntime = createStrictCentralAdapterRuntime({
    provider: mockProvider() as never,
    generationFence: Object.freeze({ assertCurrent() {} }),
    simulator: Object.freeze({
      simulate: async () => {
        throw new Error("cannot resolve verified-actor caller");
      },
    }),
  });
  const failingSimulatorExecutor =
    failingSimulatorRuntime.scheduler.issueExecutor({} as never);
  const failingSimulator = await failingSimulatorExecutor.executor.execute({
    requests: Object.freeze([simulationRequest]),
    source: SOURCE,
  } as never);
  assert.equal(failingSimulator[0]!.ok, false);
  assert(failingSimulator[0]!.ok === false);
  assert.equal(failingSimulator[0]!.failure, "resource-limited");

  // Real scheduler telemetry: transport wall time is measured, attempts are
  // observable and the reuse seal binds the executed inputs.
  const telemetryRuntime = createStrictCentralAdapterRuntime({
    provider: mockProvider() as never,
    generationFence: Object.freeze({ assertCurrent() {} }),
  });
  const telemetryExecutor = telemetryRuntime.scheduler.issueExecutor({} as never);
  await telemetryExecutor.executor.execute({
    requests: Object.freeze([Object.freeze({
      id: "telemetry-call",
      kind: "eth-call" as const,
      to: WSTETH,
      data: "0x",
      completion: "return-data" as const,
    })]),
    source: SOURCE,
  } as never);
  const timing = telemetryExecutor.timing();
  assert(timing.transportWallMs >= 0);
  assert.equal(timing.attempts, 1);
  const reuseA = telemetryExecutor.executor.sealStaticEvidenceReuseProof({
    reusePolicy: Object.freeze({ kind: "source-local" }) as never,
    source: SOURCE,
    requests: Object.freeze([]),
    results: Object.freeze([]),
    trustedResultsFingerprint: "fingerprint-a",
  } as never);
  const reuseB = telemetryExecutor.executor.sealStaticEvidenceReuseProof({
    reusePolicy: Object.freeze({ kind: "source-local" }) as never,
    source: SOURCE,
    requests: Object.freeze([]),
    results: Object.freeze([]),
    trustedResultsFingerprint: "fingerprint-b",
  } as never);
  assert.match(reuseA.proofHash, /^[0-9a-f]{64}$/);
  assert.notEqual(reuseA.proofHash, reuseB.proofHash);

  // Real budgets: positive deadline and a configured batch cap are enforced.
  const cappedRuntime = createStrictCentralAdapterRuntime({
    provider: mockProvider() as never,
    generationFence: Object.freeze({ assertCurrent() {} }),
    maxRequestsPerBatch: 2,
  });
  assert.throws(
    () => cappedRuntime.budgets.assertAdmitted(
      Object.freeze({ deadlineAtMs: 0 }) as never,
      Object.freeze([Object.freeze({}), Object.freeze({})]) as never,
    ),
    /positive deadline/,
  );
  assert.throws(
    () => cappedRuntime.budgets.assertAdmitted(
      Object.freeze({ deadlineAtMs: 1000 }) as never,
      Object.freeze([
        Object.freeze({}),
        Object.freeze({}),
        Object.freeze({}),
      ]) as never,
    ),
    /batch cap/,
  );

  // Simulation provenance is a real content binding, not a fixed constant.
  const provenanceRuntime = createStrictCentralAdapterRuntime({
    provider: mockProvider() as never,
    generationFence: Object.freeze({ assertCurrent() {} }),
    simulator: Object.freeze({
      simulate: async () => Object.freeze({ data: "0xdeadbeef" }),
    }),
  });
  const provenanceExecutor =
    provenanceRuntime.scheduler.issueExecutor({} as never);
  const provenanceResults = await provenanceExecutor.executor.execute({
    requests: Object.freeze([simulationRequest]),
    source: SOURCE,
  } as never);
  assert.equal(provenanceResults[0]!.ok, true);
  assert(provenanceResults[0]!.ok === true);
  assert.match(
    provenanceResults[0]!.provenance.fingerprint,
    /^[0-9a-f]{64}$/,
  );
  assert.notEqual(
    provenanceResults[0]!.provenance.fingerprint,
    "9".repeat(64),
  );

  // Verified-actor caller authority: without the evidence map the central
  // runtime fails closed at caller-authority; with the production map the
  // family-declared actor binds and the request executes.
  const bareAuthorityRuntime = createStrictCentralAdapterRuntime({
    provider: mockProvider() as never,
    generationFence: Object.freeze({ assertCurrent() {} }),
  });
  assert.deepEqual(
    bareAuthorityRuntime.callerAuthority.bind({} as never),
    {},
  );
  const actorRuntime = createStrictCentralAdapterRuntime({
    provider: mockProvider() as never,
    generationFence: Object.freeze({ assertCurrent() {} }),
    verifiedActors: PRODUCTION_STRICT_VERIFIED_ACTORS,
  });
  const boundAuthority = actorRuntime.callerAuthority.bind({
    callerRole: "verified-actor",
  } as never) as { readonly verifiedActors?: Readonly<Record<string, string>> };
  assert.equal(
    boundAuthority.verifiedActors?.["erc4626-probe-actor"],
    PRODUCTION_STRICT_VERIFIED_ACTORS["erc4626-probe-actor"],
  );
  const observedSender = `0x${"7a".repeat(20)}`;
  const observedRuntime = createStrictCentralAdapterRuntime({
    provider: mockProvider() as never,
    generationFence: Object.freeze({ assertCurrent() {} }),
    executor: `0x${"7b".repeat(20)}`,
    observedSender,
  });
  const observedAuthority = observedRuntime.callerAuthority.bind({
    callerRole: "observed-sender",
  } as never) as { readonly observedSender?: string; readonly executor?: string };
  assert.equal(observedAuthority.observedSender, observedSender);
  assert.notEqual(
    observedAuthority.observedSender,
    observedAuthority.executor,
    "the executor must never impersonate the observed sender",
  );
  const executorOnlyRuntime = createStrictCentralAdapterRuntime({
    provider: mockProvider() as never,
    generationFence: Object.freeze({ assertCurrent() {} }),
    executor: `0x${"7b".repeat(20)}`,
  });
  assert.equal(
    (executorOnlyRuntime.callerAuthority.bind({
      callerRole: "observed-sender",
    } as never) as { readonly observedSender?: string }).observedSender,
    undefined,
    "observed-sender authority fails closed without canonical evidence",
  );
  const verifiedProgram = Object.freeze({
    requirements: () => Object.freeze({
      transports: ["eth-call" as const],
      caller: "verified-actor" as const,
    }),
    buildRequests: () => Object.freeze([Object.freeze({
      id: "verified-probe",
      kind: "eth-call" as const,
      to: WSTETH,
      data: "0x",
      completion: "return-data" as const,
      caller: Object.freeze({
        kind: "verified-actor" as const,
        evidenceId: "erc4626-probe-actor",
      }),
    })]),
    decode: () => Object.freeze({ ok: true }),
  });
  const verifiedIntent = Object.freeze({
    stage: "identity" as const,
    familyId: "protocol:test" as never,
    source: SOURCE,
    generation: SOURCE.generation,
    program: verifiedProgram,
    programInput: Object.freeze({}),
  });
  const denied = await executeAdapterWork({
    intent: verifiedIntent,
    runtime: bareAuthorityRuntime,
  });
  assert.equal(denied.status, "unresolved");
  if (denied.status === "unresolved") {
    assert.equal(denied.failure.stage, "caller-authority");
    assert.equal(denied.failure.code, "authority-failure");
  }
  const accepted = await executeAdapterWork({
    intent: verifiedIntent,
    runtime: actorRuntime,
  });
  assert.equal(accepted.status, "resolved");

  // Caller-sensitive eth_call and its successful-byte cache must share the
  // exact same from field. No implicit zero sender or cross-actor cache hit.
  const executorAddress = `0x${"12".repeat(20)}`;
  const observedAddress = `0x${"23".repeat(20)}`;
  const actorAddress = `0x${"34".repeat(20)}`;
  const originAddress = `0x${"ab".repeat(20)}`;
  const capturedOriginReads: (string | undefined)[] = [];
  const originOptions = {
    provider: { ...mockProvider(), call: async (tx: { to: string; data: string; from?: string }) => {
      capturedOriginReads.push(tx.from); return "0x";
    } },
    generationFence: { assertCurrent() {} },
    transactionOrigin: `0x${"AB".repeat(20)}`,
  };
  const capturedOriginRuntime = createStrictCentralAdapterRuntime(originOptions);
  originOptions.transactionOrigin = executorAddress;
  const capturedOrigin = capturedOriginRuntime.callerAuthority.bind({} as never);
  assert.equal(capturedOrigin.transactionOrigin, originAddress);
  assert(Object.isFrozen(capturedOrigin));
  assert.throws(() => { (capturedOrigin as { transactionOrigin: string }).transactionOrigin = executorAddress; });
  for (const transactionOrigin of [null, 42, false, "", "bad", "0x1234", `0x${"00".repeat(20)}`]) {
    assert.throws(() => createStrictCentralAdapterRuntime({
      ...originOptions, transactionOrigin,
    } as never), /transaction.origin/i);
  }
  const originProgram = {
    requirements: () => ({ transports: ["eth-call" as const], caller: "transaction-origin" as const }),
    buildRequests: () => [{ id: "origin", kind: "eth-call" as const, to: WSTETH, data: "0x",
      caller: { kind: "transaction-origin" as const }, completion: "return-data" as const }],
    decode: () => true,
  };
  const capturedRead = await executeAdapterWork({ runtime: capturedOriginRuntime, intent: {
    stage: "exact-refine", familyId: "test:origin" as never, source: SOURCE,
    generation: SOURCE.generation, programInput: {}, program: originProgram,
  } });
  assert.equal(capturedRead.status, "resolved");
  assert.deepEqual(capturedOriginReads, [originAddress], "constructor mutation cannot change physical from");
  let forbiddenReads = 0;
  const missingOrigin = await executeAdapterWork({
    runtime: createStrictCentralAdapterRuntime({
      provider: { ...mockProvider(), call: async () => { forbiddenReads++; return "0x"; } },
      exactCallBackend: { call: async () => { forbiddenReads++; return "0x"; } },
      producerCallBackend: { call: async () => { forbiddenReads++; return "0x"; } },
      producerCallCache: { callCached: () => { forbiddenReads++; return Promise.resolve("0x"); } },
      generationFence: { assertCurrent() {} }, executor: executorAddress,
      observedSender: observedAddress, verifiedActors: { actor: actorAddress },
    }),
    intent: { stage: "exact-refine", familyId: "test:origin" as never,
      source: SOURCE, generation: SOURCE.generation,
      programInput: { transactionOrigin: originAddress }, program: originProgram },
  });
  assert.equal(missingOrigin.status, "unresolved");
  if (missingOrigin.status === "unresolved") assert.equal(missingOrigin.failure.stage, "caller-authority");
  assert.equal(forbiddenReads, 0, "origin must not fall back to another caller");

  const originPhysicalKeys = new Set<string>();
  const originProvenance = new Set<string>();
  for (const transport of ["provider", "batch", "cache", "producer", "producer-cache", "cache-provider-miss"] as const) {
    for (const [caller, expected] of [
      [{ kind: "executor" as const }, executorAddress],
      [{ kind: "observed-sender" as const }, observedAddress],
      [{ kind: "verified-actor" as const, evidenceId: "actor" }, actorAddress],
      [{ kind: "transaction-origin" as const }, originAddress],
      [{ kind: "none" as const }, undefined],
    ] as const) {
      const reads: { to: string; data: string; from?: string; path: string }[] = [];
      const producer = transport === "producer" || transport === "producer-cache";
      const cached = transport === "cache" || transport === "producer-cache";
      const control = { signal: new AbortController().signal, deadlineAtMs: Date.now() + 60_000 };
      const observe = (tx: { to: string; data: string; from?: string }, actualControl: typeof control | undefined, path: string) => {
        assert.equal(actualControl?.signal, control.signal);
        assert.equal(actualControl?.deadlineAtMs, control.deadlineAtMs);
        reads.push({ ...tx, path });
        if (caller.kind === "transaction-origin") {
          originPhysicalKeys.add(JSON.stringify([SOURCE.hash, tx.to.toLowerCase(), tx.data, tx.from]));
        }
      };
      const wired = createStrictCentralAdapterRuntime({
        provider: { ...mockProvider(), call: async (tx, block, actualControl) => {
          assert.equal(block, SOURCE.number);
          observe(tx, actualControl as typeof control, "provider"); return "0x";
        } },
        executor: executorAddress, observedSender: observedAddress, verifiedActors: { actor: actorAddress },
        transactionOrigin: originAddress,
        generationFence: { assertCurrent(generation, source) {
          assert.equal(generation, SOURCE.generation); assert.deepEqual(source, SOURCE);
        } },
        ...(transport === "provider" || transport === "cache-provider-miss" ? {} : producer
          ? { producerCallBackend: { call: async (tx, actualControl) => {
            observe(tx, actualControl as typeof control, "producer"); return "0x";
          } } }
          : { exactCallBackend: { call: async (tx, actualControl) => {
            observe(tx, actualControl as typeof control, "batch"); return "0x";
          } } }),
        ...(transport === "provider" ? {} : { producerCallCache: { callCached: (tx, actualControl, hash) => {
          assert.equal(hash, SOURCE.hash);
          observe(tx, actualControl as typeof control, "cache");
          return cached ? Promise.resolve("0x") : undefined;
        } } }),
      });
      const result = await executeAdapterWork({ runtime: wired, control, intent: {
        stage: producer ? "pricing-current" : "exact-refine", familyId: "test:caller" as never, source: SOURCE, generation: SOURCE.generation,
        programInput: {}, program: {
          requirements: () => ({ transports: ["eth-call"], caller: caller.kind }),
          buildRequests: () => [{ kind: "eth-call", id: "caller", to: WSTETH,
            data: "0x", caller, completion: "return-data" }],
          decode: ({ results }) => {
            assert.deepEqual(results[0]!.source, SOURCE);
            assert(Object.isFrozen(results[0]!.source));
            if (caller.kind === "transaction-origin" && results[0]!.ok) {
              originProvenance.add(results[0]!.provenance.fingerprint);
            }
            return { ok: true };
          },
        },
      } });
      assert.equal(result.status, "resolved");
      assert.equal(reads.at(-1)?.path, cached ? "cache" : producer ? "producer"
        : transport === "cache-provider-miss" ? "provider" : transport);
      assert.equal(reads.length, transport === "provider" || cached ? 1 : 2);
      assert(reads.length > 0 && reads.every(tx => tx.from === expected));
    }
  }
  assert.equal(originPhysicalKeys.size, 1, "all read entrances use identical source/to/data/from cache identity");
  assert.equal(originProvenance.size, 1, "transport choice must not alter result provenance");

  let simulationCalls = 0;
  const originSimulation = await executeAdapterWork({
    runtime: createStrictCentralAdapterRuntime({
      ...originOptions, transactionOrigin: originAddress,
      simulator: { simulate: async () => { simulationCalls++; return { data: "0x" }; } },
    }),
    intent: { stage: "exact-refine", familyId: "test:origin" as never,
      source: SOURCE, generation: SOURCE.generation, programInput: {}, program: {
        requirements: () => ({ transports: ["effect-delta-simulation"], caller: "transaction-origin" }),
        buildRequests: () => [{ id: "origin-sim", kind: "effect-delta-simulation",
          call: { caller: { kind: "transaction-origin" }, to: WSTETH, data: "0x" },
          overrideIntent: { caller: { kind: "transaction-origin" } }, observe: [] }],
        decode: () => assert.fail("unsupported origin simulation cannot decode"),
      } },
  });
  assert.equal(originSimulation.status, "unresolved");
  assert.equal(simulationCalls, 0, "unsupported simulation role must not reach a transport with different caller semantics");

  const originObservationCases = [];
  for (const kind of ["state-override-simulation", "effect-delta-simulation"] as const) {
    let simulatorCalls = 0;
    let decoderCalls = 0;
    const outcome = await executeAdapterWork({
      runtime: createStrictCentralAdapterRuntime({
        provider: mockProvider(), executor: executorAddress, transactionOrigin: originAddress,
        generationFence: { assertCurrent() {} },
        simulator: { simulate: async () => {
          simulatorCalls++;
          return { data: "0x", effects: { tokenDeltas: [
            { token: STETH, account: executorAddress, delta: 1n },
          ] } };
        } },
      }),
      intent: { stage: "exact-refine", familyId: "test:origin" as never,
        source: SOURCE, generation: SOURCE.generation, programInput: {}, program: {
          requirements: () => ({ transports: [kind], caller: "executor", effects: ["token-delta"] }),
          buildRequests: () => [{ id: "origin-observation", kind,
            call: { caller: { kind: "executor" }, to: WSTETH, data: "0x" },
            overrideIntent: { caller: { kind: "executor" } },
            observe: ["token-delta"],
            observeTokenBalances: [{ token: STETH, account: { kind: "transaction-origin" } }],
          }],
          decode: () => { decoderCalls++; return true; },
        } },
    });
    originObservationCases.push({ kind, outcome, simulatorCalls, decoderCalls });
  }
  assert.deepEqual(originObservationCases.map(({ kind, outcome, simulatorCalls, decoderCalls }) => ({
    kind, status: outcome.status, simulatorCalls, decoderCalls,
  })), ["state-override-simulation", "effect-delta-simulation"].map(kind => ({
    kind, status: "unresolved", simulatorCalls: 0, decoderCalls: 0,
  })), "origin-only observations must fail closed before either simulator or decoder runs");
  for (const { outcome } of originObservationCases) {
    assert(outcome.status === "unresolved");
    assert.equal(outcome.failure.stage, "request-build");
    assert.match(outcome.failure.message, /unsupported transaction-origin token-balance observation/);
  }
  console.log("strict-central-adapter-runtime PASS");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

type EffectRequest = Extract<AdapterRequest, {
  kind: "state-override-simulation" | "effect-delta-simulation";
}>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const schedulingRequests: readonly AdapterRequest[] = [
  { id: "code", kind: "get-code", address: WSTETH },
  { id: "call-a", kind: "eth-call", to: WSTETH, data: "0x1111",
    caller: { kind: "executor" }, completion: "return-data" },
  { id: "storage", kind: "get-storage", address: STETH, slot: `0x${"00".repeat(32)}` },
  { id: "call-b", kind: "eth-call", to: STETH, data: "0x2222",
    caller: { kind: "executor" }, completion: "return-or-revert-data" },
];

function runSchedulingProgram(runtime: CentralAdapterRuntime,
  control: AdapterWorkControl | undefined,
  decode: (results: readonly AdapterRequestResult[]) => void,
  requests = schedulingRequests) {
  return executeAdapterWork({ runtime, control, intent: {
    stage: "exact-refine", familyId: "test:read-scheduling" as never,
    source: SOURCE, generation: SOURCE.generation, programInput: undefined,
    program: {
      requirements: () => ({ transports: [...new Set(requests.map(request => request.kind))],
        caller: requests.some(request => request.kind === "eth-call" && request.caller?.kind === "executor")
          ? "executor" : "none" }),
      buildRequests: () => requests,
      decode: ({ results }) => { decode(results); return results; },
    },
  } });
}

const schedulingTurn = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

for (const blockedAt of ["permit", "provider"] as const) {
  test(`mixed reads: batch dispatch while direct ${blockedAt} is blocked`, async () => {
    const admission = deferred<void>();
    const code = deferred<string>();
    const storage = deferred<string>();
    const batch = deferred<void>();
    const scheduler = new RethTransportScheduler({ capacity: 4, producerReserved: 1 });
    const control = { signal: new AbortController().signal, deadlineAtMs: Date.now() + 60_000 };
    let centralPermits = 0;
    let backendPermits = 0;
    let directCalls = 0;
    let decoded = 0;
    let dependentDecoded = 0;
    const enqueued: string[] = [];
    const completed: string[] = [];
    const checkControl = (actual: AdapterWorkControl | undefined) => {
      assert.equal(actual?.signal, control.signal);
      assert.equal(actual?.deadlineAtMs, control.deadlineAtMs);
    };
    const runtime = createStrictCentralAdapterRuntime({
      provider: {
        call: async () => assert.fail("batched eth_call bypassed its backend"),
        getCode: async (address, block, actualControl) => {
          directCalls++; checkControl(actualControl);
          assert.equal(address, WSTETH); assert.equal(block, SOURCE.number);
          const data = await code.promise; completed.push("code"); return data;
        },
        getStorage: async (address, slot, block, actualControl) => {
          directCalls++; checkControl(actualControl);
          assert.equal(address, STETH); assert.equal(slot, `0x${"00".repeat(32)}`);
          assert.equal(block, SOURCE.number);
          const data = await storage.promise; completed.push("storage"); return data;
        },
      },
      executor: STETH,
      generationFence: { assertCurrent(generation, source) {
        assert.equal(generation, SOURCE.generation); assert.deepEqual(source, SOURCE);
      } },
      transportScheduler: { async run(lane, signal, work) {
        centralPermits++;
        assert.equal(lane, "exact"); assert.equal(signal, control.signal);
        if (blockedAt === "permit") await admission.promise;
        return scheduler.run(lane, signal, work);
      } },
      exactCallBackend: { async call(tx, actualControl) {
        checkControl(actualControl); assert.equal(tx.from, STETH);
        enqueued.push(tx.data);
        // The backend owns its physical permit. A central wrapper around
        // eth_call would be an extra acquisition, even with spare capacity.
        return scheduler.run("exact", actualControl!.signal!, async () => {
          backendPermits++;
          await batch.promise;
          completed.push(tx.data);
          return tx.data;
        });
      } },
    });
    const pending = (async () => {
      const first = await runSchedulingProgram(runtime, control, results => {
        decoded++;
        assert.deepEqual(results.map(result => result.id), schedulingRequests.map(request => request.id));
        assert(results.every(result => result.ok));
        assert(results.every(result => Object.isFrozen(result.source)));
        assert(results.every(result => result.source.hash === SOURCE.hash));
        assert.deepEqual(results.map(result => result.ok && result.data), ["0x6000", "0x1111", "0x00", "0x2222"]);
      });
      assert(first.status === "resolved");
      const codeResult = first.executed.evidence[0]!;
      assert(codeResult.ok);
      const next = await runSchedulingProgram(runtime, control, () => { dependentDecoded++; }, [
        { id: "dependent", kind: "eth-call", to: WSTETH, data: codeResult.data,
          caller: { kind: "executor" }, completion: "return-data" },
      ]);
      assert.equal(next.status, "resolved");
      return first;
    })();
    const settled = pending.then(value => ({ value }), error => ({ error }));
    try {
      await schedulingTurn();
      assert.deepEqual(enqueued, ["0x1111", "0x2222"], "independent calls must enqueue before direct reads finish");
      assert.equal(backendPermits, 2);
      assert.equal(centralPermits, 1, "batched calls must not take nested central permits");
      assert.equal(directCalls, blockedAt === "permit" ? 0 : 2);
      assert.equal(decoded, 0); assert.equal(dependentDecoded, 0);
      batch.resolve();
      await schedulingTurn();
      assert.deepEqual(completed, ["0x1111", "0x2222"]);
      assert.equal(decoded, 0, "completed independent reads cannot start decode or dependent work");
      admission.resolve();
      storage.resolve("0x00");
      await schedulingTurn();
      assert.equal(decoded, 0, "every required initial read must complete before decode");
      code.resolve("0x6000");
      const outcome = await settled;
      if ("error" in outcome) throw outcome.error;
      assert.equal(decoded, 1); assert.equal(dependentDecoded, 1);
      assert.deepEqual(enqueued, ["0x1111", "0x2222", "0x6000"]);
      assert.equal(centralPermits, 1); assert.equal(backendPermits, 3);
      assert.equal(scheduler.snapshot().activeTotal, 0);
      assert.equal(scheduler.snapshot().queuedByLane.exact, 0);
    } finally {
      admission.resolve(); code.resolve("0x6000"); storage.resolve("0x00"); batch.resolve();
      await settled;
    }
  });
}

for (const interruption of ["abort", "deadline", "generation"] as const) {
  for (const firstGroup of ["direct", "batch"] as const) {
    test(`mixed reads: ${interruption} drains ${firstGroup}-first rejection without stale decode`, async context => {
      const releases = Array.from({ length: 4 }, () => deferred<void>());
      const scheduler = new RethTransportScheduler({ capacity: 4, producerReserved: 1 });
      const controller = new AbortController();
      const control = { signal: controller.signal, deadlineAtMs: Date.now() + 60_000 };
      let current = true;
      let entered = 0;
      let finished = 0;
      let decoded = 0;
      let workSettled = false;
      const read = async (index: number) => {
        entered++;
        await releases[index]!.promise;
        finished++;
        // Even a late CALL_EXCEPTION must not convert a cancelled/stale
        // program into successful revert evidence.
        if (index % 2 === 1) throw Object.assign(new Error("late revert"), { code: "CALL_EXCEPTION", data: "0xbeef" });
        return "0x00";
      };
      const runtime = createStrictCentralAdapterRuntime({
        provider: { call: async () => assert.fail("unexpected direct eth_call"),
          getCode: () => read(0), getStorage: () => read(2) },
        exactCallBackend: { call: (tx, actualControl) => scheduler.run("exact", actualControl!.signal!,
          () => read(tx.data === "0x1111" ? 1 : 3)) },
        transportScheduler: scheduler, executor: STETH,
        generationFence: { assertCurrent() { if (!current) throw new Error("source generation retired"); } },
      });
      const pending = runSchedulingProgram(runtime, control, () => { decoded++; });
      const settled = pending.then(value => { workSettled = true; return value; });
      try {
        await schedulingTurn();
        assert.equal(entered, 4, "both read groups must be in flight");
        if (interruption === "abort") controller.abort(Object.assign(new Error("owner cancelled"),
          { code: "CALL_EXCEPTION", data: "0xabcd" }));
        if (interruption === "generation") current = false;
        if (interruption === "deadline") context.mock.method(Date, "now", () => control.deadlineAtMs + 1);
        releases[firstGroup === "direct" ? 0 : 1]!.resolve();
        await schedulingTurn();
        assert.equal(workSettled, false, "a rejected group must drain its running siblings");
        assert.equal(decoded, 0);
        assert.equal(scheduler.snapshot().activeByLane.exact, firstGroup === "direct" ? 3 : 2,
          "the direct permit must remain held while storage is in flight");
        releases[0]!.resolve(); releases[2]!.resolve();
        await schedulingTurn();
        assert.equal(workSettled, false, "finishing direct reads must still drain pending batched calls");
        releases[1]!.resolve(); releases[3]!.resolve();
        const outcome = await settled;
        assert.equal(outcome.status, "unresolved");
        assert.equal(decoded, 0); assert.equal(finished, 4);
        assert.equal(scheduler.snapshot().activeTotal, 0);
        assert.equal(scheduler.snapshot().queuedByLane.exact, 0);
      } finally {
        for (const release of releases) release.resolve();
        await settled;
        context.mock.restoreAll();
      }
    });
  }
}

for (const synchronous of [false, true]) {
  test(`mixed reads: ${synchronous ? "synchronous" : "asynchronous"} permit rejection drains batched work`, async () => {
    const batch = deferred<string>();
    const error = new Error("direct permit rejected");
    let batchCalls = 0;
    let batchFinished = 0;
    let workSettled = false;
    const runtime = createStrictCentralAdapterRuntime({
      provider: { call: async () => assert.fail("unexpected direct eth_call"),
        getCode: async () => assert.fail("rejected permit cannot run code read"),
        getStorage: async () => assert.fail("rejected permit cannot run storage read") },
      generationFence: { assertCurrent() {} },
      transportScheduler: { run() { if (synchronous) throw error; return Promise.reject(error); } },
      exactCallBackend: { async call() { batchCalls++; const data = await batch.promise; batchFinished++; return data; } },
    });
    const pending = runtime.scheduler.issueExecutor({ source: SOURCE, generation: SOURCE.generation,
      callerAuthority: { executor: STETH } } as never).executor.execute({ source: SOURCE, requests: schedulingRequests } as never);
    const settled = pending.then(value => { workSettled = true; return { value }; },
      reason => { workSettled = true; return { reason }; });
    try {
      await schedulingTurn();
      assert.equal(batchCalls, 2);
      assert.equal(workSettled, false, "permit failure cannot orphan independent calls");
      batch.resolve("0x00");
      const outcome = await settled;
      assert("reason" in outcome); assert.equal(outcome.reason, error, "preserve the original rejection");
      assert.equal(batchFinished, 2);
    } finally { batch.resolve("0x00"); await settled; }
  });
}

for (const failedKind of ["get-code", "get-storage", "eth-call"] as const) {
  for (const required of [true, false]) {
    test(`mixed reads: ${failedKind} failure preserves required=${required}`, async () => {
      let attempts = 0;
      let decoded = 0;
      const read = async (kind: string) => {
        if (kind === failedKind) { attempts++; throw new Error("node unavailable"); }
        return "0x00";
      };
      const requests = schedulingRequests.slice(0, 3).map(request =>
        request.kind === failedKind ? { ...request, required } : request);
      const scheduler = new RethTransportScheduler({ capacity: 3, producerReserved: 1 });
      const runtime = createStrictCentralAdapterRuntime({
        provider: { call: async () => assert.fail("unexpected direct eth_call"),
          getCode: () => read("get-code"), getStorage: () => read("get-storage") },
        exactCallBackend: { call: (_tx, control) => scheduler.run("exact", control?.signal ?? new AbortController().signal,
          () => read("eth-call")) },
        transportScheduler: scheduler, executor: STETH, generationFence: { assertCurrent() {} },
      });
      const outcome = await runSchedulingProgram(runtime, undefined, results => {
        decoded++;
        assert.deepEqual(results.map(result => result.id), requests.map(request => request.id));
        const failure = results.find(result => result.id === requests.find(request => request.kind === failedKind)!.id);
        assert(failure && !failure.ok); assert.equal(failure.failure, "rpc");
      }, requests);
      assert.equal(outcome.status, required ? "unresolved" : "resolved");
      assert.equal(decoded, required ? 0 : 1);
      assert.equal(attempts, 2, "transport failure retains the bounded retry");
      assert.equal(scheduler.snapshot().activeTotal, 0);
    });
  }
}

for (const fence of ["authority", "abort", "deadline", "generation", "source"] as const) {
  test(`mixed reads: ${fence} rejects before dispatch`, async () => {
    let io = 0;
    let decoded = 0;
    const read = async () => { io++; return "0x00"; };
    const runtime = createStrictCentralAdapterRuntime({
      provider: { call: read, getCode: read, getStorage: read }, exactCallBackend: { call: read },
      ...(fence === "authority" ? {} : { executor: STETH }),
      generationFence: { assertCurrent() { if (fence === "generation") throw new Error("generation retired"); } },
    });
    if (fence === "source") {
      const issued = runtime.scheduler.issueExecutor({ source: SOURCE, generation: SOURCE.generation } as never);
      await assert.rejects(issued.executor.execute({
        source: { ...SOURCE, hash: `0x${"99".repeat(32)}` }, requests: schedulingRequests,
      } as never), /escaped its issued source/);
    } else {
      const outcome = await runSchedulingProgram(runtime, {
        signal: fence === "abort" ? AbortSignal.abort() : new AbortController().signal,
        deadlineAtMs: fence === "deadline" ? Date.now() - 1 : Date.now() + 60_000,
      }, () => { decoded++; });
      assert.equal(outcome.status, "unresolved");
      if (fence === "authority" && outcome.status === "unresolved") assert.equal(outcome.failure.stage, "caller-authority");
    }
    assert.equal(io, 0); assert.equal(decoded, 0);
  });
}

function bindingSimulation(kind: EffectRequest["kind"]): EffectRequest {
  return { id: "bound-simulation", kind,
    call: { caller: { kind: "executor" }, to: STETH, data: "0x1234" },
    overrideIntent: { caller: { kind: "executor" } },
    observe: ["return-data", "revert-data"],
  };
}

function runBindingSimulation(runtime: CentralAdapterRuntime, request: EffectRequest,
  control: AdapterWorkControl | undefined, decode: () => void) {
  return executeAdapterWork({ runtime, control, intent: {
    stage: "runtime-evidence", familyId: "test:simulation-binding" as never,
    source: SOURCE, generation: SOURCE.generation, programInput: undefined,
    program: {
      requirements: () => ({ transports: [request.kind], caller: "executor", effects: request.observe }),
      buildRequests: () => [request],
      decode: ({ results }) => { decode(); return results; },
    },
  } });
}

for (const kind of ["state-override-simulation", "effect-delta-simulation"] as const) {
  test(`${kind}: invocation authority/source/control reach simulation as detached snapshots`, async () => {
    const authority = { executor: `0x${"AB".repeat(20)}`,
      transactionOrigin: `0x${"BC".repeat(20)}`, observedSender: `0x${"CD".repeat(20)}`,
      verifiedActors: { observer: `0x${"DE".repeat(20)}` } };
    const expected = { executor: authority.executor.toLowerCase(),
      transactionOrigin: authority.transactionOrigin.toLowerCase(),
      observedSender: authority.observedSender.toLowerCase(),
      verifiedActors: { observer: authority.verifiedActors.observer.toLowerCase() } };
    const construction = { provider: mockProvider(), executor: `0x${"11".repeat(20)}`,
      transactionOrigin: `0x${"22".repeat(20)}`, observedSender: `0x${"33".repeat(20)}`,
      verifiedActors: { observer: `0x${"44".repeat(20)}` },
      generationFence: { assertCurrent() {} },
      simulator: { simulate: async (actual: Parameters<StrictSimulationTransport["simulate"]>[0]) => {
        captured = actual;
        entered.resolve();
        await release.promise;
        return { data: "0x1234" };
      } },
    };
    let captured: Parameters<StrictSimulationTransport["simulate"]>[0] | undefined;
    const entered = deferred<void>();
    const release = deferred<void>();
    const base = createStrictCentralAdapterRuntime(construction);
    const runtime = { ...base, callerAuthority: { bind: () => authority } };
    const controller = new AbortController();
    const control = { signal: controller.signal, deadlineAtMs: Date.now() + 60_000 };
    let decodes = 0;
    const pending = runBindingSimulation(runtime, bindingSimulation(kind), control, () => { decodes++; });
    await entered.promise;
    authority.executor = STETH;
    authority.transactionOrigin = STETH;
    authority.observedSender = STETH;
    authority.verifiedActors.observer = STETH;
    construction.executor = STETH;
    construction.verifiedActors.observer = STETH;
    release.resolve();
    assert.equal((await pending).status, "resolved");
    assert(captured);
    assert.deepEqual(captured.callerAuthority, expected);
    assert.notEqual(captured.callerAuthority, authority);
    assert.notEqual(captured.callerAuthority.verifiedActors, authority.verifiedActors);
    assert(Object.isFrozen(captured.callerAuthority));
    assert(Object.isFrozen(captured.callerAuthority.verifiedActors));
    assert.deepEqual(captured.source, SOURCE);
    assert(Object.isFrozen(captured.source));
    assert.equal(captured.control?.signal, controller.signal);
    assert.equal(captured.control?.deadlineAtMs, control.deadlineAtMs);
    assert.equal(decodes, 1);
  });

  for (const direct of [false, true]) {
    for (const reverted of [false, true]) {
      for (const interruption of ["none", "abort", "deadline", "generation"] as const) {
        test(`${kind}: ${direct ? "direct executor" : "work"} ${reverted ? "revert" : "return"} fences ${interruption}`, async () => {
          const entered = deferred<void>();
          const release = deferred<void>();
          let current = true;
          let calls = 0;
          let decodes = 0;
          const controller = new AbortController();
          const control = { signal: controller.signal,
            deadlineAtMs: Date.now() + (interruption === "deadline" ? 100 : 60_000) };
          const runtime = createStrictCentralAdapterRuntime({ provider: mockProvider(), executor: STETH,
            generationFence: { assertCurrent(generation, source) {
              assert.equal(generation, SOURCE.generation);
              assert.deepEqual(source, SOURCE);
              if (!current) throw new Error("test source generation retired");
            } },
            simulator: { simulate: async () => {
              calls++;
              entered.resolve();
              await release.promise;
              if (reverted) throw Object.assign(new Error("execution reverted"),
                { code: "CALL_EXCEPTION", data: "0x1234" });
              return { data: "0x1234" };
            } },
          });
          const request = bindingSimulation(kind);
          const pending = direct
            ? runtime.scheduler.issueExecutor({ source: SOURCE, generation: SOURCE.generation,
                callerAuthority: { executor: STETH }, control } as never).executor.execute({
                source: SOURCE, requests: [request] } as never)
            : runBindingSimulation(runtime, request, control, () => { decodes++; });
          // Attach both handlers before cancellation, including direct rejections.
          const settled = pending.then(value => ({ ok: true as const, value }),
            error => ({ ok: false as const, error }));
          await entered.promise;
          if (interruption === "abort") controller.abort(Object.assign(new Error("owner cancelled"),
            { code: "CALL_EXCEPTION", data: "0xbeef" }));
          if (interruption === "generation") current = false;
          if (interruption === "deadline") {
            await new Promise(resolve => setTimeout(resolve, Math.max(1, control.deadlineAtMs - Date.now() + 1)));
          }
          release.resolve();
          const outcome = await settled;
          assert.equal(calls, 1);
          if (interruption === "none") {
            assert(outcome.ok);
            const result = "status" in outcome.value
              ? outcome.value.status === "resolved" ? outcome.value.executed.evidence[0] : undefined
              : outcome.value[0];
            assert(result?.ok);
            assert.equal(result.completion, reverted ? "reverted-as-declared" : "returned");
            assert.equal(result.data, "0x1234");
            assert.equal(decodes, direct ? 0 : 1);
          } else {
            if (direct) assert.equal(outcome.ok, false, "direct executor must not issue stale evidence");
            else {
              assert(outcome.ok && "status" in outcome.value);
              assert.equal(outcome.value.status, "unresolved");
            }
            assert.equal(decodes, 0, "stale results never reach Family decode");
          }
        });
      }
    }
  }

  test(`${kind}: direct issuance detaches authority and control before queued work`, async () => {
    const entered = deferred<void>();
    const release = deferred<void>();
    const authority = { executor: STETH, transactionOrigin: `0x${"55".repeat(20)}`,
      verifiedActors: { observer: `0x${"66".repeat(20)}` } };
    const expectedAuthority = { ...authority, verifiedActors: { ...authority.verifiedActors } };
    const source = { ...SOURCE };
    const controller = new AbortController();
    const control = { signal: controller.signal, deadlineAtMs: Date.now() + 60_000 };
    const deadline = control.deadlineAtMs;
    let calls = 0;
    const runtime = createStrictCentralAdapterRuntime({
      provider: { ...mockProvider(), getCode: async () => {
        entered.resolve(); await release.promise; return "0x";
      } },
      generationFence: { assertCurrent(generation, actual) {
        assert.equal(generation, SOURCE.generation); assert.deepEqual(actual, SOURCE);
      } },
      simulator: { simulate: async actual => {
        calls++;
        assert.deepEqual(actual.callerAuthority, expectedAuthority);
        assert(Object.isFrozen(actual.callerAuthority.verifiedActors));
        assert.deepEqual(actual.source, SOURCE);
        assert.notEqual(actual.source, source);
        assert(Object.isFrozen(actual.source));
        assert.equal(actual.control?.signal, controller.signal);
        assert.equal(actual.control?.deadlineAtMs, deadline);
        return { data: "0x1234" };
      } },
    });
    const issueInput = { source: { ...SOURCE }, generation: SOURCE.generation, callerAuthority: authority, control };
    const issued = runtime.scheduler.issueExecutor(issueInput as never);
    authority.executor = WSTETH;
    authority.transactionOrigin = WSTETH;
    authority.verifiedActors.observer = WSTETH;
    const pending = issued.executor.execute({ source, requests: [
      { id: "first-read", kind: "get-code", address: STETH }, bindingSimulation(kind),
    ] } as never);
    await entered.promise;
    source.hash = `0x${"99".repeat(32)}`;
    issueInput.source.hash = source.hash;
    issueInput.generation++;
    control.signal = AbortSignal.abort();
    control.deadlineAtMs = 0;
    release.resolve();
    const results = await pending;
    assert(results.every(result => result.ok));
    assert.equal(calls, 1);
    assert(!Object.isFrozen(source), "do not freeze the caller's source in place");
  });

  for (const interruption of ["abort", "deadline", "generation", "source"] as const) {
    test(`${kind}: direct ${interruption} fence rejects before simulation`, async () => {
      let calls = 0;
      const runtime = createStrictCentralAdapterRuntime({ provider: mockProvider(),
        generationFence: { assertCurrent() {
          if (interruption === "generation") throw new Error("test source generation retired");
        } },
        simulator: { simulate: async () => { calls++; return { data: "0x" }; } },
      });
      const issued = runtime.scheduler.issueExecutor({ source: SOURCE, generation: SOURCE.generation,
        callerAuthority: { executor: STETH }, control: {
          signal: interruption === "abort" ? AbortSignal.abort() : new AbortController().signal,
          deadlineAtMs: interruption === "deadline" ? Date.now() - 1 : Date.now() + 60_000,
        } } as never);
      await assert.rejects(issued.executor.execute({
        source: interruption === "source" ? { ...SOURCE, hash: `0x${"99".repeat(32)}` } : SOURCE,
        requests: [bindingSimulation(kind)],
      } as never));
      assert.equal(calls, 0);
    });
  }
}

for (const kind of ["state-override-simulation", "effect-delta-simulation"] as const) {
  for (const callerRole of ["executor", "verified-actor"] as const) {
    for (const reverted of [false, true]) {
      test(`${kind}: ${callerRole} ${reverted ? "revert" : "return"} provenance binds only used inner origin`, async () => {
        const actor = `0x${"ab".repeat(20)}`;
        const originA = `0x${"bc".repeat(20)}`;
        const originB = `0x${"cd".repeat(20)}`;
        const target = `0x${"de".repeat(20)}`;
        const caller = callerRole === "executor"
          ? { kind: "executor" as const }
          : { kind: "verified-actor" as const, evidenceId: "actor" };
        const raw: EffectRequest = {
          id: "origin-provenance", kind,
          call: { caller, executionMode: "impersonated-call-frame", to: target, data: "0x1234" },
          overrideIntent: { caller },
          observe: ["return-data", "revert-data", "native-delta"],
        };
        const completion = reverted ? "reverted-as-declared" : "returned";
        const nativeDeltas = [{ account: actor, delta: 7n }];
        const run = async (request: EffectRequest, transactionOrigin: string | undefined,
          unusedActors: Readonly<Record<string, string>> = {}) => {
          const runtime = createStrictCentralAdapterRuntime({
            provider: {
              call: async () => assert.fail("unexpected provider call"),
              getCode: async () => assert.fail("unexpected code read"),
              getStorage: async () => assert.fail("unexpected storage read"),
            },
            executor: actor, transactionOrigin,
            verifiedActors: { actor, ...unusedActors },
            generationFence: { assertCurrent(generation, source) {
              assert.equal(generation, SOURCE.generation);
              assert.deepEqual(source, SOURCE);
            } },
            simulator: { simulate: async (input) => {
              assert.deepEqual(input.source, SOURCE);
              assert.deepEqual(input.request, request);
              assert.equal(physicalAdapterRequestFingerprint(input.request),
                physicalAdapterRequestFingerprint(request));
              assert.equal(input.callerAuthority.transactionOrigin, transactionOrigin?.toLowerCase());
              assert.equal(input.callerAuthority.executor, actor);
              assert.equal(input.callerAuthority.verifiedActors?.actor, actor);
              assert(Object.isFrozen(input.callerAuthority));
              if (reverted) throw Object.assign(new Error("execution reverted"),
                { code: "CALL_EXCEPTION", data: "0x1234" });
              return { data: "0x1234", effects: { nativeDeltas } };
            } },
          });
          const outcome = await executeAdapterWork({ runtime, intent: {
            stage: "runtime-evidence", familyId: "test:origin-provenance" as never,
            source: SOURCE, generation: SOURCE.generation, programInput: undefined,
            program: {
              requirements: () => ({ transports: [kind], caller: callerRole, effects: raw.observe }),
              buildRequests: () => [request], decode: ({ results }) => results,
            },
          } });
          assert(outcome.status === "resolved");
          const result = outcome.executed.evidence[0];
          assert(result?.ok);
          assert.equal(result.completion, completion);
          assert.equal(result.data, "0x1234");
          assert.deepEqual(result.source, SOURCE);
          assert.deepEqual(result.effects?.nativeDeltas, reverted ? [] : nativeDeltas);
          assert.equal(result.provenance.kind, "strict-simulation-transport");
          return result.provenance.fingerprint;
        };

        // Identical declaration/source/actor/output; only sealed origin differs.
        const a = await run(raw, originA);
        const b = await run(raw, originB);
        assert.notEqual(a, b, "inner-mode evidence must bind the sealed transaction origin");
        assert.equal(await run(raw, `0x${"BC".repeat(20)}`), a);
        assert.equal(await run(raw, originA, { unused: originB }), a,
          "unused verified actors must not perturb provenance");
        assert.equal(await run(raw, originA, { unused: target }), a);
        assert.notEqual(await run(raw, undefined), await run(raw, actor),
          "missing origin must not be inferred from the actor/executor");

        for (const executionMode of [undefined, "top-level"] as const) {
          const request: EffectRequest = { ...raw, call: { caller, to: target, data: "0x1234",
            ...(executionMode === undefined ? {} : { executionMode }) } };
          const originalFingerprint = hashCanonical({
            id: request.id, requestFingerprint: physicalAdapterRequestFingerprint(request),
            callerAddresses: [actor, actor], completion,
            source: { number: SOURCE.number, hash: SOURCE.hash.toLowerCase(), generation: SOURCE.generation },
          });
          for (const origin of [undefined, originA, originB]) {
            assert.equal(await run(request, origin), originalFingerprint,
              "top-level provenance must retain its original hash; authority origin is unused");
          }
        }
      });
    }
  }
  for (const reverted of [false, true]) {
    test(`${kind}: strict ${reverted ? "revert" : "success"} traversal binds effect metadata`, async () => {
      const token = `0x${"31".repeat(20)}`;
      const actor = `0x${"42".repeat(20)}`;
      const other = `0x${"53".repeat(20)}`;
      const captured: EffectRequest[] = [];
      const raw = { id: "scope", kind,
        call: { caller: { kind: "verified-actor" as const, evidenceId: "actor" },
          executionMode: "impersonated-call-frame" as const, to: token, data: "0x1234" },
        overrideIntent: { caller: { kind: "verified-actor" as const, evidenceId: "actor" } },
        observe: ["token-delta" as const, "return-data" as const, "revert-data" as const],
        observeTokenBalances: [{ token, account: { kind: "verified-actor" as const, evidenceId: "observer" } }],
      };
      const variants: EffectRequest[] = [raw,
        { ...raw, call: { ...raw.call, executionMode: "top-level" } },
        { ...raw, call: { caller: raw.call.caller, to: token, data: "0x1234" } },
        { ...raw, observeTokenBalances: [{ token: actor, account: raw.observeTokenBalances[0]!.account }] },
        { ...raw, observeTokenBalances: [{ token, account: actor }] },
        { ...raw, observeTokenBalances: [{ token, account: other }] },
        { ...raw, observeTokenBalances: [{ token, account: { kind: "verified-actor", evidenceId: "observer-2" } }] },
      ];
      const runtime = createStrictCentralAdapterRuntime({
        provider: { call: async () => assert.fail("simulation must not read provider"),
          getCode: async () => assert.fail("unexpected code read"),
          getStorage: async () => assert.fail("unexpected storage read") },
        generationFence: { assertCurrent() {} },
        verifiedActors: { actor, observer: other, "observer-2": other },
        simulator: { simulate: async ({ request }) => {
          captured.push(request);
          if (reverted) throw Object.assign(new Error("revert"), { code: "CALL_EXCEPTION", data: "0x1234" });
          return { data: "0x1234", effects: { tokenDeltas: [] } };
        } },
      });
      const outcomes = await Promise.all(variants.map(request => executeAdapterWork({ runtime,
        intent: { stage: "runtime-evidence", familyId: "test:effect-metadata" as never,
          source: SOURCE, generation: SOURCE.generation, programInput: undefined,
          program: { requirements: () => ({ transports: [kind], caller: "verified-actor", effects: raw.observe }),
            buildRequests: () => [request], decode: ({ results }) => results } },
      })));
      assert(outcomes.every(outcome => outcome.status === "resolved"));
      assert.deepEqual(captured, variants, "strict simulator receives the entire frozen declaration");
      const fingerprints = outcomes.map(outcome => {
        assert(outcome.status === "resolved");
        const result = outcome.executed.evidence[0];
        assert(result?.ok);
        assert.equal(result.completion, reverted ? "reverted-as-declared" : "returned");
        return result.provenance.fingerprint;
      });
      assert.equal(new Set(fingerprints).size, variants.length,
        "success and revert provenance must each bind mode, scope and symbolic evidence id");
      const rebound = await executeAdapterWork({
        runtime: { ...runtime, callerAuthority: { bind: () => ({
          verifiedActors: { actor, observer: token, "observer-2": other },
        }) } },
        intent: { stage: "runtime-evidence", familyId: "test:effect-metadata" as never,
          source: SOURCE, generation: SOURCE.generation, programInput: undefined,
          program: { requirements: () => ({ transports: [kind], caller: "verified-actor", effects: raw.observe }),
            buildRequests: () => [raw], decode: ({ results }) => results } },
      });
      assert(rebound.status === "resolved");
      const reboundResult = rebound.executed.evidence[0];
      assert(reboundResult?.ok);
      assert.notEqual(reboundResult.provenance.fingerprint, fingerprints[0],
        "the same symbolic observer bound to another concrete account has different provenance");
      raw.observeTokenBalances[0]!.account.evidenceId = "mutated";
      raw.observeTokenBalances[0]!.token = other;
      assert.deepEqual(captured[0]?.observeTokenBalances,
        [{ token, account: { kind: "verified-actor", evidenceId: "observer" } }]);
      assert(Object.isFrozen(captured[0]?.observeTokenBalances?.[0]?.account));
    });
  }
  test(`${kind}: invalid declarations and unbound observation refs reject with zero I/O`, async () => {
    let io = 0;
    let decodes = 0;
    const address = `0x${"64".repeat(20)}`;
    const runtime = createStrictCentralAdapterRuntime({
      provider: { call: async () => { io++; return "0x"; },
        getCode: async () => { io++; return "0x"; }, getStorage: async () => { io++; return "0x"; } },
      generationFence: { assertCurrent() {} }, verifiedActors: { actor: address }, executor: address,
      simulator: { simulate: async () => { io++; return { data: "0x", effects: { tokenDeltas: [] } }; } },
    });
    const base: EffectRequest = { id: "reject", kind,
      call: { caller: { kind: "verified-actor", evidenceId: "actor" }, to: address, data: "0x" },
      overrideIntent: { caller: { kind: "verified-actor", evidenceId: "actor" } },
      observe: ["token-delta"], observeTokenBalances: [{ token: address,
        account: { kind: "verified-actor", evidenceId: "missing" } }],
    };
    const cases: EffectRequest[] = [base,
      { ...base, call: { ...base.call, executionMode: "invalid" as never } },
      { ...base, observeTokenBalances: [{ token: address, account: { kind: "executor" } }] },
      { ...base, observeTokenBalances: [{ token: address, account: { kind: "unknown" } as never }] },
      { ...base, observeTokenBalances: [{ token: address, account: address, extra: true } as never] },
    ];
    for (const request of cases) {
      const outcome = await executeAdapterWork({ runtime, intent: {
        stage: "runtime-evidence", familyId: "test:effect-metadata" as never,
        source: SOURCE, generation: SOURCE.generation, programInput: undefined,
        program: { requirements: () => ({ transports: [kind], caller: "verified-actor", effects: ["token-delta"] }),
          buildRequests: () => [request], decode: () => { decodes++; return true; } },
      } });
      assert.equal(outcome.status, "unresolved");
      if (outcome.status === "unresolved") {
        assert.equal(outcome.failure.stage, request === base ? "caller-authority" : "request-build");
      }
    }
    assert.equal(io, 0);
    assert.equal(decodes, 0);
    const executorRequest: EffectRequest = { ...base,
      call: { ...base.call, caller: { kind: "executor" }, executionMode: "top-level" },
      overrideIntent: { caller: { kind: "executor" } },
      observeTokenBalances: [{ token: address, account: { kind: "executor" } }],
    };
    const executorOutcome = await executeAdapterWork({ runtime, intent: {
      stage: "runtime-evidence", familyId: "test:effect-metadata" as never,
      source: SOURCE, generation: SOURCE.generation, programInput: undefined,
      program: { requirements: () => ({ transports: [kind], caller: "executor", effects: ["token-delta"] }),
        buildRequests: () => [executorRequest], decode: () => { decodes++; return true; } },
    } });
    assert.equal(executorOutcome.status, "resolved");
    assert.equal(io, 1, "ordinary executor simulation remains supported");
    assert.equal(decodes, 1);
  });
}

// Diagnostics-only regressions: independent of the mixed-read scheduling tests.
for (const outcome of ["unset", "disabled", "returned", "revert", "rpc", "abort", "deadline", "generation", "logger-error", "logger-error-abort"] as const) {
  test(`eth-call diagnostics: submission and ${outcome} completion stay redacted and opt-in`, async context => {
    const previous = process.env.SEARCHER_STATE_LATENCY_DIAGNOSTICS;
    const enabled = outcome !== "disabled" && outcome !== "unset";
    if (outcome === "unset") delete process.env.SEARCHER_STATE_LATENCY_DIAGNOSTICS;
    else process.env.SEARCHER_STATE_LATENCY_DIAGNOSTICS = enabled ? "1" : "0";
    const logs: string[] = [];
    context.mock.method(console, "log", (line: string) => {
      if (line.startsWith("[strict-eth-call-timing] ")) logs.push(line);
      if (outcome.startsWith("logger-error")) throw new Error("diagnostic sink failed");
    });
    const entered = deferred<void>();
    const release = deferred<void>();
    const controller = new AbortController();
    const control = { signal: controller.signal, deadlineAtMs: Date.now() + 60_000 };
    const authority = { executor: `0x${"AB".repeat(20)}` };
    const source = { ...SOURCE };
    let current = true;
    let reads = 0;
    const runtime = createStrictCentralAdapterRuntime({
      provider: { ...mockProvider(), call: async (tx, block, actualControl) => {
        assert.equal(tx.to.toLowerCase(), WSTETH.toLowerCase());
        assert.equal(tx.from, `0x${"ab".repeat(20)}`); assert.equal(tx.data, "0x12345678");
        assert.equal(tx.blockTag, SOURCE.number); assert.equal(block, SOURCE.number);
        assert.equal(actualControl?.signal, control.signal); assert.equal(actualControl?.deadlineAtMs, control.deadlineAtMs);
        reads++; entered.resolve(); await release.promise;
        if (outcome === "revert") throw Object.assign(new Error("reverted"), { code: "CALL_EXCEPTION", data: "0xdeadbeef" });
        if (outcome === "rpc") throw new Error("node unavailable at https://private.invalid/rpc");
        return "0xcafebabe";
      } },
      generationFence: { assertCurrent() { if (!current) throw new Error("source generation retired"); } },
    });
    const pending = runtime.scheduler.issueExecutor({ source, generation: SOURCE.generation,
      control, callerAuthority: authority } as never).executor.execute({ familyId: "test:call-diagnostics", source,
      requests: [{ id: "diagnostic-call", kind: "eth-call", to: WSTETH, data: "0x12345678",
        caller: { kind: "executor" }, completion: "return-or-revert-data" }],
    } as never);
    const settled = pending.then(value => ({ value }), error => ({ error }));
    try {
      await entered.promise;
      assert.equal(logs.length, enabled ? 1 : 0, "submission must be recorded before the response");
      authority.executor = STETH; source.hash = `0x${"99".repeat(32)}`;
      const aborted = outcome === "abort" || outcome === "logger-error-abort";
      if (aborted) controller.abort(new Error("owner cancelled"));
      if (outcome === "generation") current = false;
      if (outcome === "deadline") context.mock.method(Date, "now", () => control.deadlineAtMs + 1);
      release.resolve();
      const result = await settled;
      const fenced = aborted || outcome === "deadline" || outcome === "generation";
      assert.equal("error" in result, fenced, "diagnostics cannot bypass or introduce a rejection");
      if ("value" in result) {
        assert.equal(result.value[0]!.ok, outcome !== "rpc");
        if (result.value[0]!.ok) assert.equal(result.value[0]!.completion,
          outcome === "revert" ? "reverted-as-declared" : "returned");
      }
      assert.equal(reads, outcome === "rpc" ? 2 : 1);
      if (!enabled) {
        assert.deepEqual(logs, []);
      } else {
        assert.equal(logs.length, 2, "one submission and one completion per logical request, including retries");
        const records = logs.map(line => JSON.parse(line.slice("[strict-eth-call-timing] ".length)));
        assert.deepEqual(records.map(record => record.phase), ["submitted", "completed"]);
        assert.deepEqual(records.map(record => record.outcome), ["pending",
          fenced ? "fenced" : outcome === "rpc" ? "rpc" : outcome === "revert" ? "reverted-as-declared" : "returned"]);
        for (const record of records) {
          assert.equal(record.familyId, "test:call-diagnostics"); assert.equal(record.requestId, "diagnostic-call");
          assert.equal(record.to, WSTETH.toLowerCase()); assert.equal(record.sourceBlockHash, SOURCE.hash);
          assert.equal(record.from, `0x${"ab".repeat(20)}`);
          assert.equal(record.sourceBlock, SOURCE.number); assert.equal(record.generation, SOURCE.generation);
          // SHA-256 vector for bytes 12 34 56 78, independent of hex casing.
          assert.equal(record.calldataSha256, "b2ed992186a5cb19f6668aade821f502c1d00970dfd0e35128d51bac4649916c");
          assert(Number.isSafeInteger(record.atMs)); assert(record.atMs >= record.startedAtMs);
          assert.equal(record.wallMs, record.atMs - record.startedAtMs);
        }
        assert.equal(records[0].startedAtMs, records[1].startedAtMs);
        assert.equal(records[1].aborted, aborted);
        assert(!logs.join("\n").match(/0x12345678|0xdeadbeef|0xcafebabe|https?:|private\.invalid/),
          "no calldata, return/revert payloads, URLs or raw errors in diagnostics");
      }
    } finally {
      release.resolve(); await settled;
      context.mock.restoreAll();
      if (previous === undefined) delete process.env.SEARCHER_STATE_LATENCY_DIAGNOSTICS;
      else process.env.SEARCHER_STATE_LATENCY_DIAGNOSTICS = previous;
    }
  });
}

test("eth-call diagnostics: caller roles and pinned sources match provider and backend submissions", async context => {
  const previous = process.env.SEARCHER_STATE_LATENCY_DIAGNOSTICS;
  process.env.SEARCHER_STATE_LATENCY_DIAGNOSTICS = "1";
  const records: Array<Record<string, unknown>> = [];
  context.mock.method(console, "log", (line: string) => {
    if (line.startsWith("[strict-eth-call-timing] ")) records.push(JSON.parse(line.slice("[strict-eth-call-timing] ".length)));
  });
  const authority = { executor: `0x${"ab".repeat(20)}`, transactionOrigin: `0x${"bc".repeat(20)}`,
    observedSender: `0x${"cd".repeat(20)}`, verifiedActors: { actor: `0x${"de".repeat(20)}` } };
  try {
    for (const batched of [false, true]) {
      for (const [index, [caller, expectedFrom]] of [
        [{ kind: "executor" }, authority.executor],
        [{ kind: "transaction-origin" }, authority.transactionOrigin],
        [{ kind: "observed-sender" }, authority.observedSender],
        [{ kind: "verified-actor", evidenceId: "actor" }, authority.verifiedActors.actor],
        [{ kind: "none" }, undefined],
      ].entries()) {
        records.length = 0;
        const source = { number: SOURCE.number + index, hash: `0x${String(index + 1).repeat(64)}`,
          generation: SOURCE.generation + index };
        const submitted: Array<{ to: string; data: string; from?: string }> = [];
        const runtime = createStrictCentralAdapterRuntime({
          provider: { ...mockProvider(), call: async (tx, block) => {
            assert(!batched); assert.equal(block, source.number); assert.equal(tx.blockTag, source.number);
            submitted.push(tx); return "0x00";
          } },
          ...(batched ? { exactCallBackend: { call: async (tx: { to: string; data: string; from?: string }) => {
            submitted.push(tx); return "0x00";
          } } } : {}),
          generationFence: { assertCurrent(generation, actual) {
            assert.equal(generation, source.generation); assert.deepEqual(actual, source);
          } },
        });
        const results = await runtime.scheduler.issueExecutor({ source, generation: source.generation,
          callerAuthority: authority } as never).executor.execute({ familyId: "test:caller-diagnostics", source,
          requests: [{ id: `caller-${index}`, kind: "eth-call", to: WSTETH, data: "0x12345678",
            caller, completion: "return-data" }],
        } as never);
        assert(results[0]!.ok); assert.equal(submitted.length, 1); assert.equal(records.length, 2);
        assert.equal(submitted[0]!.from, expectedFrom);
        for (const record of records) {
          assert.equal(record.requestId, `caller-${index}`);
          assert.equal(record.sourceBlock, source.number); assert.equal(record.sourceBlockHash, source.hash);
          assert.equal(record.generation, source.generation);
          assert.equal(record.to, submitted[0]!.to.toLowerCase());
          assert.equal(record.from, submitted[0]!.from ?? null);
        }
      }
    }
  } finally {
    context.mock.restoreAll();
    if (previous === undefined) delete process.env.SEARCHER_STATE_LATENCY_DIAGNOSTICS;
    else process.env.SEARCHER_STATE_LATENCY_DIAGNOSTICS = previous;
  }
});

test("eth-call diagnostics: subject attribution is detached and missing harness metadata stays optional", async context => {
  const previous = process.env.SEARCHER_STATE_LATENCY_DIAGNOSTICS;
  process.env.SEARCHER_STATE_LATENCY_DIAGNOSTICS = "1";
  const records: Array<Record<string, unknown>> = [];
  context.mock.method(console, "log", (line: string) => {
    if (!line.startsWith("[strict-eth-call-timing] ")) return;
    const record = JSON.parse(line.slice("[strict-eth-call-timing] ".length));
    if (record.requestId === "shared-diagnostic-request") records.push(record);
  });
  try {
    for (const withSubject of [true, false]) {
      records.length = 0;
      const entered = deferred<void>();
      const release = deferred<void>();
      const subject = { familyId: "test:subject-diagnostics", instanceKey: "instance:original", routeKey: "route:original" };
      const source = { ...SOURCE };
      const issueInput = { ...(withSubject ? { subject, subjectKey: "subject:original", source, generation: SOURCE.generation } : {}) };
      const runtime = createStrictCentralAdapterRuntime({
        provider: { ...mockProvider(), call: async (_tx, block) => {
          assert.equal(block, SOURCE.number);
          entered.resolve(); await release.promise; return "0x00";
        } },
        generationFence: { assertCurrent(generation, actual) {
          assert.equal(generation, SOURCE.generation); assert.deepEqual(actual, SOURCE);
        } },
      });
      const issued = runtime.scheduler.issueExecutor(issueInput as never);
      // Mutate both the original object and its replacement before execution.
      // An omitted harness subject must also stay absent if added after issue.
      subject.instanceKey = "instance:mutated"; subject.routeKey = "route:mutated";
      issueInput.subject = { ...subject }; issueInput.subjectKey = "subject:mutated";
      source.hash = `0x${"99".repeat(32)}`; source.generation++;
      const pending = issued.executor.execute({ familyId: "test:subject-diagnostics", source: SOURCE,
        requests: [{ id: "shared-diagnostic-request", kind: "eth-call", to: WSTETH, data: "0x12345678", completion: "return-data" }],
      } as never);
      const settled = pending.then(value => ({ value }), error => ({ error }));
      try {
        await entered.promise;
        assert.equal(records.length, 1, "the submission must already carry the issued subject");
        issueInput.subject.instanceKey = "instance:changed-after-submission";
        issueInput.subject.routeKey = "route:changed-after-submission";
        issueInput.subjectKey = "subject:changed-after-submission";
        release.resolve();
        const outcome = await settled;
        if ("error" in outcome) throw outcome.error;
        assert(outcome.value[0]!.ok);
        assert.deepEqual(records.map(record => record.phase), ["submitted", "completed"]);
        for (const record of records) {
          assert.equal(record.subjectKey, withSubject ? "subject:original" : null);
          assert.equal(record.instanceKey, withSubject ? "instance:original" : undefined);
          assert.equal(record.routeKey, withSubject ? "route:original" : undefined);
          assert.equal(Object.hasOwn(record, "instanceKey"), withSubject);
          assert.equal(Object.hasOwn(record, "routeKey"), withSubject);
          assert.equal(record.sourceBlock, SOURCE.number); assert.equal(record.sourceBlockHash, SOURCE.hash);
          assert.equal(record.generation, SOURCE.generation);
        }
        assert(!Object.isFrozen(subject), "snapshotting must not freeze caller-owned metadata");
      } finally { release.resolve(); await settled; }
    }
  } finally {
    context.mock.restoreAll();
    if (previous === undefined) delete process.env.SEARCHER_STATE_LATENCY_DIAGNOSTICS;
    else process.env.SEARCHER_STATE_LATENCY_DIAGNOSTICS = previous;
  }
});

function executeSharedRead(runtime: CentralAdapterRuntime, requests: readonly AdapterRequest[],
  control?: AdapterWorkControl, source = SOURCE, lane = "exact") {
  return runtime.scheduler.issueExecutor({ source, generation: source.generation,
    schedule: { rethLane: lane }, control } as never).executor.execute({
    familyId: "test:shared-code", source, requests,
  } as never);
}

function codeRequest(id: string, address = WSTETH): AdapterRequest {
  return { id, kind: "get-code", address };
}

test("shared code: duplicate queued reads and successful reuse own only one physical permit", async () => {
  const scheduler = new RethTransportScheduler({ capacity: 2, producerReserved: 1 });
  const blocker = deferred<void>();
  const read = deferred<string>();
  const occupied = scheduler.run("exact", new AbortController().signal, () => blocker.promise);
  await schedulingTurn();
  const control = { signal: new AbortController().signal, deadlineAtMs: Date.now() + 60_000 };
  let calls = 0;
  let permits = 0;
  const runtime = createStrictCentralAdapterRuntime({
    provider: { ...mockProvider(), getCode: async (_address, block, actual) => {
      calls++; assert.equal(block, SOURCE.number); assert.equal(actual?.signal, control.signal);
      return read.promise;
    } },
    generationFence: { assertCurrent() {} },
    transportScheduler: { run(lane, signal, work) { permits++; return scheduler.run(lane, signal, work); } },
  });
  const first = executeSharedRead(runtime, [codeRequest("first")], control);
  // Exact's per-invocation caller-context wrapper keeps this scheduler, even
  // though its runtime/control objects are different snapshots.
  const second = executeSharedRead(Object.freeze({ ...runtime }),
    [codeRequest("second", WSTETH.toLowerCase())], { ...control });
  const settled = Promise.allSettled([first, second]);
  try {
    await schedulingTurn();
    assert.equal(scheduler.snapshot().queuedByLane.exact, 1, "coalesce before either caller acquires a permit");
    assert.equal(permits, 1); assert.equal(calls, 0);
    blocker.resolve(); await occupied; await schedulingTurn();
    assert.equal(calls, 1);
    read.resolve("0x6000");
    const [a, b] = await Promise.all([first, second]);
    assert(a[0]!.ok && b[0]!.ok);
    assert.notEqual(a[0], b[0], "raw bytes may be shared, never issued result handles");
    assert.equal(a[0].id, "first"); assert.equal(b[0].id, "second");
    assert.notEqual(a[0].provenance.fingerprint, b[0].provenance.fingerprint);
    const cached = await executeSharedRead(runtime, [codeRequest("cached")], control);
    assert(cached[0]!.ok); assert.equal(cached[0].data, "0x6000");
    assert.notEqual(cached[0], a[0]); assert.equal(permits, 1); assert.equal(calls, 1);
    assert.equal(scheduler.snapshot().activeTotal, 0);
    assert.equal(scheduler.snapshot().queuedByLane.exact, 0);
  } finally { blocker.resolve(); read.resolve("0x6000"); await occupied; await settled; }
});

test("shared code: mixed owner and joiner releases its group permit before waiting on another owner", async () => {
  const scheduler = new RethTransportScheduler({ capacity: 2, producerReserved: 1 });
  const admission = deferred<void>();
  const control = { signal: new AbortController().signal, deadlineAtMs: Date.now() + 60_000 };
  let permits = 0;
  let codeCalls = 0;
  let storageCalls = 0;
  let secondSettled = false;
  const runtime = createStrictCentralAdapterRuntime({
    provider: { ...mockProvider(), getCode: async () => { codeCalls++; return "0x6000"; },
      getStorage: async () => { storageCalls++; return "0x00"; } },
    generationFence: { assertCurrent() {} },
    transportScheduler: { async run(lane, signal, work) {
      if (++permits === 1) await admission.promise;
      return scheduler.run(lane, signal, work);
    } },
  });
  const first = executeSharedRead(runtime, [codeRequest("owner")], control);
  const second = executeSharedRead(runtime, [
    { id: "storage", kind: "get-storage", address: STETH, slot: `0x${"00".repeat(32)}` }, codeRequest("joiner"),
  ], control).then(results => { secondSettled = true; return results; });
  const settled = Promise.allSettled([first, second]);
  try {
    await schedulingTurn();
    assert.equal(storageCalls, 1); assert.equal(codeCalls, 0);
    assert.equal(secondSettled, false, "the joiner still needs the first owner's code");
    assert.equal(scheduler.snapshot().activeTotal, 0, "never hold a permit while waiting on a joined read");
    admission.resolve();
    const [, results] = await Promise.all([first, second]);
    assert.deepEqual(results.map(result => result.id), ["storage", "joiner"]);
    assert(results.every(result => result.ok)); assert.equal(codeCalls, 1); assert.equal(permits, 2);
  } finally { admission.resolve(); await settled; }
});

for (const difference of ["number", "hash", "generation", "lane", "address", "signal", "deadline", "runtime"] as const) {
  test(`shared code: ${difference} isolates in-flight and completed reads`, async () => {
    const release = deferred<string>();
    const control = { signal: new AbortController().signal, deadlineAtMs: Date.now() + 60_000 };
    let calls = 0;
    const makeRuntime = () => createStrictCentralAdapterRuntime({
      provider: { ...mockProvider(), getCode: async () => { calls++; return release.promise; } },
      generationFence: { assertCurrent() {} },
    });
    const runtime = makeRuntime();
    const otherRuntime = difference === "runtime" ? makeRuntime() : runtime;
    const otherSource = { ...SOURCE,
      ...(difference === "number" ? { number: SOURCE.number + 1 } : {}),
      ...(difference === "hash" ? { hash: `0x${"52".repeat(32)}` } : {}),
      ...(difference === "generation" ? { generation: SOURCE.generation + 1 } : {}),
    };
    const otherControl = { ...control,
      ...(difference === "signal" ? { signal: new AbortController().signal } : {}),
      ...(difference === "deadline" ? { deadlineAtMs: control.deadlineAtMs + 1 } : {}),
    };
    const address = difference === "address" ? STETH : WSTETH;
    const lane = difference === "lane" ? "discovery" : "exact";
    const first = executeSharedRead(runtime, [codeRequest("first")], control);
    const second = executeSharedRead(otherRuntime, [codeRequest("second", address)], otherControl, otherSource, lane);
    const settled = Promise.allSettled([first, second]);
    try {
      await schedulingTurn();
      assert.equal(calls, 2, "different ownership or state must not join a pending read");
      release.resolve("0x6000");
      const results = await Promise.all([first, second]);
      assert(results.every(items => items[0]!.ok));
      assert.deepEqual(results[0]![0]!.source, SOURCE);
      assert.deepEqual(results[1]![0]!.source, otherSource);
      await executeSharedRead(runtime, [codeRequest("first-cache")], control);
      await executeSharedRead(otherRuntime, [codeRequest("second-cache", address)], otherControl, otherSource, lane);
      assert.equal(calls, 2, "each isolated entry is independently reusable");
    } finally { release.resolve("0x6000"); await settled; }
  });
}

for (const ownership of ["none", "signal-only", "deadline-only", "infinite-deadline"] as const) {
  test(`shared code: ${ownership} retains uncontrolled direct reads`, async () => {
    const release = deferred<string>();
    const control = ownership === "none" ? undefined : {
      ...(ownership === "deadline-only" ? {} : { signal: new AbortController().signal }),
      ...(ownership === "signal-only" ? {} : {
        deadlineAtMs: ownership === "infinite-deadline" ? Infinity : Date.now() + 60_000,
      }),
    };
    let calls = 0;
    const runtime = createStrictCentralAdapterRuntime({
      provider: { ...mockProvider(), getCode: async () => { calls++; return release.promise; } },
      generationFence: { assertCurrent() {} },
    });
    const first = executeSharedRead(runtime, [codeRequest("first")], control);
    const second = executeSharedRead(runtime, [codeRequest("second")], control);
    const settled = Promise.allSettled([first, second]);
    try {
      await schedulingTurn(); assert.equal(calls, 2);
      release.resolve("0x6000"); await Promise.all([first, second]);
      await executeSharedRead(runtime, [codeRequest("uncached")], control);
      assert.equal(calls, 3);
    } finally { release.resolve("0x6000"); await settled; }
  });
}

test("shared code: storage kind and slots stay unshared with existing direct-group accounting", async () => {
  const control = { signal: new AbortController().signal, deadlineAtMs: Date.now() + 60_000 };
  const scheduler = new RethTransportScheduler({ capacity: 3, producerReserved: 1 });
  let codeCalls = 0;
  let permits = 0;
  const slots: string[] = [];
  const runtime = createStrictCentralAdapterRuntime({
    provider: { ...mockProvider(), getCode: async () => { codeCalls++; return "0x6000"; },
      getStorage: async (_address, slot) => { slots.push(slot); return "0x00"; } },
    generationFence: { assertCurrent() {} },
    transportScheduler: { run(lane, signal, work) { permits++; return scheduler.run(lane, signal, work); } },
  });
  const requests: AdapterRequest[] = [codeRequest("code"),
    { id: "slot-zero", kind: "get-storage", address: WSTETH, slot: `0x${"00".repeat(32)}` },
    { id: "slot-one", kind: "get-storage", address: WSTETH, slot: `0x${"00".repeat(31)}01` },
  ];
  const results = await Promise.all([executeSharedRead(runtime, requests, control), executeSharedRead(runtime, requests, control)]);
  assert(results.every(items => items.every(result => result.ok)));
  assert.equal(codeCalls, 1); assert.equal(slots.length, 4);
  assert.equal(new Set(slots).size, 2); assert.equal(permits, 2, "one permit per physical direct group, not per read");
  assert.equal(scheduler.snapshot().activeTotal, 0);
});

test("shared code: required failed guards block each decoder and retry failures are not cached", async () => {
  const release = deferred<string>();
  const control = { signal: new AbortController().signal, deadlineAtMs: Date.now() + 60_000 };
  let calls = 0;
  let decoded = 0;
  let failing = true;
  const runtime = createStrictCentralAdapterRuntime({
    provider: { ...mockProvider(), getCode: async () => { calls++; return failing ? release.promise : "0x6000"; } },
    executor: STETH, generationFence: { assertCurrent() {} },
  });
  const run = (id: string) => runSchedulingProgram(runtime, control, () => { decoded++; }, [codeRequest(id)]);
  const first = run("first");
  const second = run("second");
  const settled = Promise.allSettled([first, second]);
  try {
    await schedulingTurn(); assert.equal(calls, 1);
    release.reject(new Error("node unavailable"));
    const results = await Promise.all([first, second]);
    assert(results.every(result => result.status === "unresolved"));
    assert.equal(calls, 2, "one bounded retry for the shared physical read, not per waiter");
    assert.equal(decoded, 0);
    failing = false;
    assert.equal((await run("new-owner")).status, "resolved");
    assert.equal((await run("cached")).status, "resolved");
    assert.equal(calls, 3); assert.equal(decoded, 2);
  } finally { release.resolve("0x6000"); await settled; }
});

test("shared code: successful cached bytes do not bypass per-program implementation guards", async () => {
  const control = { signal: new AbortController().signal, deadlineAtMs: Date.now() + 60_000 };
  let calls = 0;
  let decoded = 0;
  const runtime = createStrictCentralAdapterRuntime({
    provider: { ...mockProvider(), getCode: async () => { calls++; return "0x"; } },
    executor: STETH, generationFence: { assertCurrent() {} },
  });
  for (const id of ["owner", "cached"]) {
    const outcome = await runSchedulingProgram(runtime, control, results => {
      decoded++; assert(results[0]!.ok); assert.equal(results[0].data, "0x");
      throw new Error("required implementation guard rejected empty code");
    }, [codeRequest(id)]);
    assert.notEqual(outcome.status, "resolved");
  }
  assert.equal(calls, 1); assert.equal(decoded, 2);
});

for (const interruption of ["abort", "deadline", "generation"] as const) {
  test(`shared code: pending ${interruption} fences all waiters and retires reuse`, async context => {
    const release = deferred<string>();
    const controller = new AbortController();
    const control = { signal: controller.signal, deadlineAtMs: Date.now() + 60_000 };
    const scheduler = new RethTransportScheduler({ capacity: 2, producerReserved: 1 });
    let current = true;
    let calls = 0;
    let decoded = 0;
    const runtime = createStrictCentralAdapterRuntime({
      provider: { ...mockProvider(), getCode: async () => { calls++; return release.promise; } },
      executor: STETH, transportScheduler: scheduler,
      generationFence: { assertCurrent() { if (!current) throw new Error("generation retired"); } },
    });
    const first = runSchedulingProgram(runtime, control, () => { decoded++; }, [codeRequest("owner")]);
    const second = runSchedulingProgram(runtime, control, () => { decoded++; }, [codeRequest("joiner")]);
    const settled = Promise.allSettled([first, second]);
    try {
      await schedulingTurn(); assert.equal(calls, 1);
      if (interruption === "abort") controller.abort(new Error("owner cancelled"));
      if (interruption === "deadline") context.mock.method(Date, "now", () => control.deadlineAtMs + 1);
      if (interruption === "generation") current = false;
      release.resolve("0x6000");
      const results = await Promise.all([first, second]);
      assert(results.every(result => result.status === "unresolved"));
      assert.equal(decoded, 0); assert.equal(calls, 1);
      await assert.rejects(executeSharedRead(runtime, [codeRequest("still-fenced")], control));
      assert.equal(calls, 1); assert.equal(scheduler.snapshot().activeTotal, 0);
      context.mock.restoreAll(); current = true;
      // Reaccepting a generation/clock is harness-only: prove retired pending
      // completions never repopulated the old entry. An aborted signal is final.
      const nextControl = interruption === "abort" ? { ...control, signal: new AbortController().signal } : control;
      assert((await executeSharedRead(runtime, [codeRequest("fresh")], nextControl))[0]!.ok);
      assert.equal(calls, 2);
    } finally { release.resolve("0x6000"); await settled; context.mock.restoreAll(); }
  });

  test(`shared code: completed ${interruption} cannot revive cached output`, async context => {
    const controller = new AbortController();
    const control = { signal: controller.signal, deadlineAtMs: Date.now() + 60_000 };
    let current = true;
    let calls = 0;
    const runtime = createStrictCentralAdapterRuntime({
      provider: { ...mockProvider(), getCode: async () => { calls++; return "0x6000"; } },
      generationFence: { assertCurrent() { if (!current) throw new Error("generation retired"); } },
    });
    try {
      await executeSharedRead(runtime, [codeRequest("owner")], control);
      if (interruption === "abort") controller.abort(new Error("owner cancelled"));
      if (interruption === "deadline") context.mock.method(Date, "now", () => control.deadlineAtMs + 1);
      if (interruption === "generation") current = false;
      await assert.rejects(executeSharedRead(runtime, [codeRequest("fenced-hit")], control));
      assert.equal(calls, 1);
      context.mock.restoreAll(); current = true;
      const nextControl = interruption === "abort" ? { ...control, signal: new AbortController().signal } : control;
      await executeSharedRead(runtime, [codeRequest("fresh")], nextControl);
      assert.equal(calls, 2);
    } finally { context.mock.restoreAll(); }
  });
}

test("shared code: queued cancellation drains joiners without affecting another control domain", async () => {
  const scheduler = new RethTransportScheduler({ capacity: 2, producerReserved: 1 });
  const blocker = deferred<void>();
  const occupied = scheduler.run("exact", new AbortController().signal, () => blocker.promise);
  const cancelled = new AbortController();
  const control = { signal: cancelled.signal, deadlineAtMs: Date.now() + 60_000 };
  const unrelated = { ...control, signal: new AbortController().signal };
  let calls = 0;
  const runtime = createStrictCentralAdapterRuntime({
    provider: { ...mockProvider(), getCode: async (_address, _block, actual) => {
      calls++; assert.equal(actual?.signal, unrelated.signal); return "0x6000";
    } },
    generationFence: { assertCurrent() {} }, transportScheduler: scheduler,
  });
  const dead = ["owner", "joiner"].map(id => executeSharedRead(runtime, [codeRequest(id)], control));
  const alive = ["independent-owner", "independent-joiner"].map(id => executeSharedRead(runtime, [codeRequest(id)], unrelated));
  const settled = Promise.allSettled([...dead, ...alive]);
  const cancelledResults = Promise.allSettled(dead);
  try {
    await schedulingTurn(); assert.equal(scheduler.snapshot().queuedByLane.exact, 2);
    cancelled.abort(new Error("owner cancelled"));
    const failures = await cancelledResults;
    assert(failures.every(result => result.status === "rejected"));
    assert.equal(calls, 0); assert.equal(scheduler.snapshot().queuedByLane.exact, 1);
    blocker.resolve(); await occupied;
    const results = await Promise.all(alive);
    assert(results.every(items => items[0]!.ok)); assert.equal(calls, 1);
    assert((await executeSharedRead(runtime, [codeRequest("unrelated-cache")], unrelated))[0]!.ok);
    assert.equal(calls, 1); assert.equal(scheduler.snapshot().activeTotal, 0);
    assert.equal(scheduler.snapshot().queuedByLane.exact, 0);
  } finally { blocker.resolve(); await occupied; await settled; }
});

for (const synchronous of [false, true]) {
  test(`shared code: ${synchronous ? "synchronous" : "asynchronous"} permit failure drains reserved reads and independent calls`, async () => {
    const batch = deferred<string>();
    const control = { signal: new AbortController().signal, deadlineAtMs: Date.now() + 60_000 };
    const scheduler = new RethTransportScheduler({ capacity: 2, producerReserved: 1 });
    const error = new Error("permit rejected");
    let fail = true;
    let calls = 0;
    let enqueued = 0;
    let finished = false;
    const runtime = createStrictCentralAdapterRuntime({
      provider: { ...mockProvider(), getCode: async () => { calls++; return "0x6000"; } },
      generationFence: { assertCurrent() {} },
      transportScheduler: { run(lane, signal, work) {
        if (fail) { if (synchronous) throw error; return Promise.reject(error); }
        return scheduler.run(lane, signal, work);
      } },
      exactCallBackend: { async call() { enqueued++; return batch.promise; } },
    });
    const pending = executeSharedRead(runtime, [codeRequest("owner"), codeRequest("joiner"),
      { id: "call", kind: "eth-call", to: WSTETH, data: "0x1111", completion: "return-data" },
    ], control);
    const settled = pending.then(value => { finished = true; return { value }; },
      reason => { finished = true; return { reason }; });
    try {
      await schedulingTurn(); assert.equal(enqueued, 1); assert.equal(calls, 0); assert.equal(finished, false);
      batch.resolve("0x00");
      const result = await settled;
      assert("reason" in result); assert.equal(result.reason, error);
      fail = false;
      assert((await executeSharedRead(runtime, [codeRequest("new-owner")], control))[0]!.ok);
      assert.equal(calls, 1);
    } finally { batch.resolve("0x00"); await settled; }
  });
}

function cacheTestAddress(index: number): string {
  return `0x${(index + 1).toString(16).padStart(40, "0")}`;
}

test("shared code: 256-entry bound evicts settled LRU reads without changing grouped permits", async () => {
  const control = { signal: new AbortController().signal, deadlineAtMs: Date.now() + 60_000 };
  const scheduler = new RethTransportScheduler({ capacity: 2, producerReserved: 1 });
  let calls = 0;
  let permits = 0;
  const runtime = createStrictCentralAdapterRuntime({
    provider: { ...mockProvider(), getCode: async () => { calls++; return "0x6000"; } },
    generationFence: { assertCurrent() {} },
    transportScheduler: { run(lane, signal, work) { permits++; return scheduler.run(lane, signal, work); } },
  });
  const read = (index: number) => executeSharedRead(runtime, [codeRequest(`read-${index}`, cacheTestAddress(index))], control);
  await executeSharedRead(runtime, Array.from({ length: 256 }, (_, index) => codeRequest(`fill-${index}`, cacheTestAddress(index))), control);
  assert.equal(calls, 256); assert.equal(permits, 1);
  await read(0); await read(256); await read(0); await read(256);
  assert.equal(calls, 257); assert.equal(permits, 2);
  await read(1);
  assert.equal(calls, 258); assert.equal(permits, 3);
  assert.equal(scheduler.snapshot().activeTotal, 0);
});

test("shared code: all-pending overflow neither evicts active waiters nor repopulates after completion", async () => {
  const release = deferred<string>();
  const control = { signal: new AbortController().signal, deadlineAtMs: Date.now() + 60_000 };
  const scheduler = new RethTransportScheduler({ capacity: 2, producerReserved: 1 });
  let calls = 0;
  let permits = 0;
  const runtime = createStrictCentralAdapterRuntime({
    provider: { ...mockProvider(), getCode: async () => { calls++; return release.promise; } },
    generationFence: { assertCurrent() {} },
    transportScheduler: { run(lane, signal, work) { permits++; return scheduler.run(lane, signal, work); } },
  });
  const first = executeSharedRead(runtime, Array.from({ length: 257 }, (_, index) => codeRequest(`fill-${index}`, cacheTestAddress(index))), control);
  const joiner = executeSharedRead(runtime, [codeRequest("joiner", cacheTestAddress(0))], control);
  const overflow = executeSharedRead(runtime, [codeRequest("overflow", cacheTestAddress(256))], control);
  const settled = Promise.allSettled([first, joiner, overflow]);
  try {
    await schedulingTurn();
    assert.equal(calls, 257); assert.equal(permits, 2);
    assert.equal(scheduler.snapshot().queuedByLane.exact, 1, "the cached waiter must not queue another permit");
    release.resolve("0x6000");
    const results = await Promise.all([first, joiner, overflow]);
    assert(results.every(items => items.every(result => result.ok)));
    assert.equal(calls, 258); assert.equal(scheduler.snapshot().activeTotal, 0);
    await executeSharedRead(runtime, [codeRequest("uncached-overflow", cacheTestAddress(256))], control);
    assert.equal(calls, 259); assert.equal(permits, 3);
  } finally { release.resolve("0x6000"); await settled; }
});

for (const shape of ["empty", "max-size", "oversize", "odd-hex", "invalid-hex"] as const) {
  test(`shared code: ${shape} response obeys successful-byte retention bounds`, async () => {
    const data = shape === "empty" ? "0x" : shape === "max-size" ? `0x${"60".repeat(32_768)}`
      : shape === "oversize" ? `0x${"60".repeat(32_769)}` : shape === "odd-hex" ? "0x6" : "0xzz";
    const control = { signal: new AbortController().signal, deadlineAtMs: Date.now() + 60_000 };
    let calls = 0;
    const runtime = createStrictCentralAdapterRuntime({
      provider: { ...mockProvider(), getCode: async () => { calls++; return data; } },
      generationFence: { assertCurrent() {} },
    });
    await executeSharedRead(runtime, [codeRequest("first")], control);
    await executeSharedRead(runtime, [codeRequest("second")], control);
    assert.equal(calls, shape === "empty" || shape === "max-size" ? 1 : 2);
  });
}

for (const lane of ["producer-bulk", "producer-critical", "discovery"] as const) {
  test(`shared code: ${lane} preserves producer bypass`, async () => {
    const control = { signal: new AbortController().signal, deadlineAtMs: Date.now() + 60_000 };
    let calls = 0;
    const runtime = createStrictCentralAdapterRuntime({
      provider: { ...mockProvider(), getCode: async () => { calls++; return "0x6000"; } },
      generationFence: { assertCurrent() {} },
      transportScheduler: { run() { assert.fail("producer-internal work cannot consume a central permit"); } },
    });
    const results = await executeSharedRead(runtime, [codeRequest("owner"), codeRequest("joiner")], control, SOURCE, lane);
    assert.equal(results.length, 2); assert(results.every(result => result.ok));
    await executeSharedRead(runtime, [codeRequest("cached")], control, SOURCE, lane);
    assert.equal(calls, 1);
  });
}
