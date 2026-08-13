import assert from "node:assert/strict";
import {
  captureFamilyGenerically,
  deriveFamilyObservationFromNodeData,
  resolveGenericCaptureDriver,
  type GenericCaptureDriver,
} from "../generic-family-capture.js";
import { exercisedStage } from "../architecture-migration-capture.js";
import {
  UNIV4_FIXTURE_CURRENCY0,
  UNIV4_FIXTURE_CURRENCY1,
  UNIV4_FIXTURE_FEE,
  UNIV4_FIXTURE_LIQUIDITY,
  UNIV4_FIXTURE_LP_FEE,
  UNIV4_FIXTURE_MANAGER,
  UNIV4_FIXTURE_QUOTER,
  UNIV4_FIXTURE_SQRT_PRICE_X96,
  UNIV4_FIXTURE_STATE_VIEW,
  UNIV4_FIXTURE_TICK_SPACING,
  univ4FixtureRuntime,
  WSTETH_FIXTURE_TARGET,
  wstethFixtureRuntime,
} from "../architecture-migration-fixture-replay.js";
import { canonicalPoolKey } from
  "../venues/swaps/angstrom-v4-family/codec.js";
import { v4PoolId } from "../venues/swaps/univ4-common.js";
import { UNIV4_FAMILY_ID } from
  "../venues/swaps/univ4-family/manifest.js";
import {
  PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG,
} from "../venues/production-family-composition.js";
import { WSTETH_INTERFACE } from
  "../venues/protocols/wsteth-family/codec.js";
import { WSTETH_FAMILY_ID } from
  "../venues/protocols/wsteth-family/manifest.js";
import type { CanonicalSource } from
  "../venues/adapter-request-program.js";

const SOURCE: CanonicalSource = Object.freeze({
  number: 20_000_000,
  hash: `0x${"c1".repeat(32)}`,
  generation: 1,
});

async function main(): Promise<void> {
  const capture = await captureFamilyGenerically({
    catalog: PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG,
    familyId: WSTETH_FAMILY_ID,
    source: SOURCE,
    runtime: wstethFixtureRuntime(),
    observation: Object.freeze({
      kind: "call",
      source: SOURCE,
      target: WSTETH_FIXTURE_TARGET.toLowerCase(),
      data: WSTETH_INTERFACE.encodeFunctionData("wrap", [1_000_000n]),
    }),
  });
  assert.equal(capture.familyId, WSTETH_FAMILY_ID);
  assert((capture.stages.instances?.items.length ?? 0) >= 1);
  assert((capture.stages.edges?.items.length ?? 0) >= 1);
  assert((capture.stages.prices?.items.length ?? 0) >= 1);
  for (const stage of Object.values(capture.stages)) {
    if (stage === undefined) continue;
    assert(
      stage.evidenceRefs.every((ref) =>
        ref === `onchain:1:${SOURCE.hash}:generic:${WSTETH_FAMILY_ID}`
      ),
      "generic capture must carry onchain evidence refs only",
    );
    assert(
      stage.evidenceRefs.every((ref) => !ref.startsWith("fixture:")),
    );
  }
  assert.equal(
    capture.stages.exactQuotes?.status,
    "framework-blocked",
    "exact stage must be honestly blocked until a per-plugin driver is wired",
  );

  assert.equal(resolveGenericCaptureDriver(WSTETH_FAMILY_ID), null);
  const driver: GenericCaptureDriver = {
    familyId: WSTETH_FAMILY_ID,
    buildExactQuotes: ({ evidenceRefs }) => exercisedStage([Object.freeze({
      id: "exact:1",
      value: Object.freeze({ amountOut: "1000000" }),
    })], evidenceRefs),
    buildExecutionAndFinalSim: ({ evidenceRefs }) => ({
      executionFragments: exercisedStage([Object.freeze({
        id: "exec:1",
        value: Object.freeze({ target: `0x${"11".repeat(20)}` }),
      })], evidenceRefs),
      finalSimulations: exercisedStage([Object.freeze({
        id: "sim:1",
        value: Object.freeze({ conservation: "conserved" }),
      })], evidenceRefs),
    }),
  };
  const driven = await captureFamilyGenerically({
    catalog: PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG,
    familyId: WSTETH_FAMILY_ID,
    source: SOURCE,
    runtime: wstethFixtureRuntime(),
    driver,
    observation: Object.freeze({
      kind: "call",
      source: SOURCE,
      target: WSTETH_FIXTURE_TARGET.toLowerCase(),
      data: WSTETH_INTERFACE.encodeFunctionData("wrap", [1_000_000n]),
    }),
  });
  assert.equal(driven.stages.exactQuotes?.status, "exercised");
  assert.equal(driven.stages.executionFragments?.status, "exercised");
  assert.equal(driven.stages.finalSimulations?.status, "exercised");

  // Generic V4 observation: until the univ4 plugin declares its emitter,
  // the derivation falls back to the call pattern (swap selector); the
  // emitter-driven log path is exercised when the plugin declares it.
  const poolKey = canonicalPoolKey({
    currency0: UNIV4_FIXTURE_CURRENCY0,
    currency1: UNIV4_FIXTURE_CURRENCY1,
    fee: Number(UNIV4_FIXTURE_FEE),
    tickSpacing: UNIV4_FIXTURE_TICK_SPACING,
    hooks: `0x${"00".repeat(20)}`,
  });
  const poolId = v4PoolId(poolKey);
  const v4Observation = await deriveFamilyObservationFromNodeData({
    catalog: PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG,
    familyId: UNIV4_FAMILY_ID,
    source: SOURCE,
    address: poolId,
    provider: {
      call: async () => { throw new Error("log pattern must not call"); },
      getCode: async () => { throw new Error("log pattern must not getCode"); },
      getStorage: async () => {
        throw new Error("log pattern must not getStorage");
      },
    },
  });
  assert.equal(v4Observation.kind, "call");
  if (v4Observation.kind === "call") {
    assert.equal(v4Observation.target, poolId.toLowerCase());
  }
  console.log("generic family capture PASS");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
