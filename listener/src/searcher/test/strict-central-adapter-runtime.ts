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
  type CanonicalSource,
} from "../venues/adapter-request-program.js";
import { hashCanonical } from "../venues/canonical-value.js";
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
