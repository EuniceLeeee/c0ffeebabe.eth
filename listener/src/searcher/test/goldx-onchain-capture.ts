import assert from "node:assert/strict";
import {
  captureGoldxOnchainCase,
  GOLDX_FIXTURE_TARGET,
  GOLDX_FIXTURE_UNIT,
  goldxFixtureRuntime,
  type OnchainUniv2Provider,
} from "../architecture-migration-fixture-replay.js";
import { GOLDX_INTERFACE } from
  "../venues/protocols/goldx-family/codec.js";
import { GOLDX_FAMILY_ID } from
  "../venues/protocols/goldx-family/manifest.js";
import type { CanonicalSource } from
  "../venues/adapter-request-program.js";

const SOURCE: CanonicalSource = Object.freeze({
  number: 20_000_000,
  hash: `0x${"ae".repeat(32)}`,
  generation: 1,
});
const TARGET = GOLDX_FIXTURE_TARGET.toLowerCase();

function provider(input: {
  readonly unit?: bigint;
  readonly fail?: boolean;
} = {}): OnchainUniv2Provider {
  return {
    async call() {
      if (input.fail === true) throw new Error("rpc down");
      return GOLDX_INTERFACE.encodeFunctionResult("unit", [
        input.unit ?? GOLDX_FIXTURE_UNIT,
      ]);
    },
  };
}

async function main(): Promise<void> {
  const capture = await captureGoldxOnchainCase({
    source: SOURCE,
    provider: provider(),
    target: TARGET,
    unit: GOLDX_FIXTURE_UNIT,
    runtime: goldxFixtureRuntime(),
  });
  assert.equal(capture.familyId, GOLDX_FAMILY_ID);
  for (const stage of Object.values(capture.stages)) {
    if (stage === undefined) continue;
    assert(
      stage.evidenceRefs.every((ref) =>
        ref === `onchain:1:${SOURCE.hash}:goldx:${TARGET}`
      ),
    );
    assert(stage.evidenceRefs.every((ref) => !ref.startsWith("fixture:")));
  }

  await assert.rejects(
    () => captureGoldxOnchainCase({
      source: SOURCE,
      provider: provider({ unit: GOLDX_FIXTURE_UNIT + 1n }),
      target: TARGET,
      unit: GOLDX_FIXTURE_UNIT,
      runtime: goldxFixtureRuntime(),
    }),
    /unit mismatch/,
  );
  await assert.rejects(
    () => captureGoldxOnchainCase({
      source: SOURCE,
      provider: provider({ unit: 0n }),
      target: TARGET,
      runtime: goldxFixtureRuntime(),
    }),
    /non-positive unit/,
  );
  await assert.rejects(
    () => captureGoldxOnchainCase({
      source: SOURCE,
      provider: provider({ fail: true }),
      target: TARGET,
      runtime: goldxFixtureRuntime(),
    }),
    /rpc down/,
  );

  console.log("goldx onchain capture PASS");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
