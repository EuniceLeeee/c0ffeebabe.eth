import assert from "node:assert/strict";
import {
  createStrictCentralAdapterRuntime,
} from "../strict-central-adapter-runtime.js";
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
  console.log("strict-central-adapter-runtime PASS");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
