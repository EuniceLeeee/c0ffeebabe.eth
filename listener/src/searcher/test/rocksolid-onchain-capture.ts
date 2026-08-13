import assert from "node:assert/strict";
import {
  captureRocksolidOnchainCase,
  ROCKSOLID_FIXTURE_TARGET,
  rocksolidFixtureRuntime,
  type OnchainUniv2Provider,
} from "../architecture-migration-fixture-replay.js";
import { ROCKSOLID_INTERFACE } from
  "../venues/protocols/rocksolid-family/codec.js";
import { ROCKSOLID_FAMILY_ID } from
  "../venues/protocols/rocksolid-family/manifest.js";
import type { CanonicalSource } from
  "../venues/adapter-request-program.js";

const SOURCE: CanonicalSource = Object.freeze({
  number: 20_000_000,
  hash: `0x${"af".repeat(32)}`,
  generation: 1,
});
const TARGET = ROCKSOLID_FIXTURE_TARGET.toLowerCase();

function provider(input: {
  readonly shares?: bigint;
  readonly fail?: boolean;
} = {}): OnchainUniv2Provider {
  return {
    async call() {
      if (input.fail === true) throw new Error("rpc down");
      return ROCKSOLID_INTERFACE.encodeFunctionResult("convertToShares", [
        input.shares ?? 10n ** 18n,
      ]);
    },
  };
}

async function main(): Promise<void> {
  const capture = await captureRocksolidOnchainCase({
    source: SOURCE,
    provider: provider(),
    target: TARGET,
    runtime: rocksolidFixtureRuntime(),
  });
  assert.equal(capture.familyId, ROCKSOLID_FAMILY_ID);
  for (const stage of Object.values(capture.stages)) {
    if (stage === undefined) continue;
    assert(
      stage.evidenceRefs.every((ref) =>
        ref === `onchain:1:${SOURCE.hash}:rocksolid:${TARGET}`
      ),
    );
    assert(stage.evidenceRefs.every((ref) => !ref.startsWith("fixture:")));
  }

  await assert.rejects(
    () => captureRocksolidOnchainCase({
      source: SOURCE,
      provider: provider({ shares: 0n }),
      target: TARGET,
      runtime: rocksolidFixtureRuntime(),
    }),
    /non-positive conversion/,
  );
  await assert.rejects(
    () => captureRocksolidOnchainCase({
      source: SOURCE,
      provider: provider({ fail: true }),
      target: TARGET,
      runtime: rocksolidFixtureRuntime(),
    }),
    /rpc down/,
  );

  console.log("rocksolid onchain capture PASS");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
