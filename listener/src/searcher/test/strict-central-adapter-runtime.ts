import assert from "node:assert/strict";
import {
  createStrictCentralAdapterRuntime,
} from "../strict-central-adapter-runtime.js";
import {
  executeAdapterWork,
} from "../adapter-work-intent.js";
import {
  runStrictFamilyLifecycle,
} from "../strict-family-lifecycle-runner.js";
import type { CanonicalSource } from
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
      caller: Object.freeze({ address: `0x${"11".repeat(20)}` }) as never,
      to: WSTETH,
      data: "0x",
    }),
    overrideIntent: Object.freeze({}) as never,
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
  console.log("strict-central-adapter-runtime PASS");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
