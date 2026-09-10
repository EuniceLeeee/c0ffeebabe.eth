import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createStrictCentralAdapterRuntime,
} from "../strict-central-adapter-runtime.js";
import {
  executeAdapterWork,
} from "../adapter-work-intent.js";
import {
  runStrictFamilyLifecycle,
} from "../strict-family-lifecycle-runner.js";
import type { AdapterRequest, CanonicalSource } from
  "../venues/adapter-request-program.js";
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
for (const kind of ["state-override-simulation", "effect-delta-simulation"] as const) {
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
