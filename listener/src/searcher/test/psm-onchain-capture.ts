import assert from "node:assert/strict";
import {
  capturePsmOnchainCase,
  PSM_FIXTURE_DAI,
  PSM_FIXTURE_GEM,
  PSM_FIXTURE_TARGET,
  psmFixtureRuntime,
  type OnchainUniv2Provider,
} from "../architecture-migration-fixture-replay.js";
import { PSM_INTERFACE } from
  "../venues/protocols/psm-family/codec.js";
import { PSM_FAMILY_ID } from
  "../venues/protocols/psm-family/manifest.js";
import type { CanonicalSource } from
  "../venues/adapter-request-program.js";

const SOURCE: CanonicalSource = Object.freeze({
  number: 20_000_000,
  hash: `0x${"ac".repeat(32)}`,
  generation: 1,
});
const TARGET = PSM_FIXTURE_TARGET.toLowerCase();

function provider(input: {
  readonly gem?: string;
  readonly dai?: string;
  readonly fail?: boolean;
} = {}): OnchainUniv2Provider {
  return {
    async call(tx) {
      if (input.fail === true) throw new Error("rpc down");
      const isGem = tx.data.startsWith(
        PSM_INTERFACE.getFunction("gem")!.selector,
      );
      return PSM_INTERFACE.encodeFunctionResult(isGem ? "gem" : "dai", [
        isGem
          ? input.gem ?? PSM_FIXTURE_GEM
          : input.dai ?? PSM_FIXTURE_DAI,
      ]);
    },
  };
}

async function main(): Promise<void> {
  const capture = await capturePsmOnchainCase({
    source: SOURCE,
    provider: provider(),
    target: TARGET,
    gem: PSM_FIXTURE_GEM,
    dai: PSM_FIXTURE_DAI,
    runtime: psmFixtureRuntime(),
  });
  assert.equal(capture.familyId, PSM_FAMILY_ID);
  for (const stage of Object.values(capture.stages)) {
    if (stage === undefined) continue;
    assert(
      stage.evidenceRefs.every((ref) =>
        ref === `onchain:1:${SOURCE.hash}:psm:${TARGET}`
      ),
    );
    assert(stage.evidenceRefs.every((ref) => !ref.startsWith("fixture:")));
  }

  await assert.rejects(
    () => capturePsmOnchainCase({
      source: SOURCE,
      provider: provider({ dai: `0x${"ee".repeat(20)}` }),
      target: TARGET,
      gem: PSM_FIXTURE_GEM,
      dai: PSM_FIXTURE_DAI,
      runtime: psmFixtureRuntime(),
    }),
    /token mismatch/,
  );
  await assert.rejects(
    () => capturePsmOnchainCase({
      source: SOURCE,
      provider: provider({ gem: `0x${"00".repeat(20)}` }),
      target: TARGET,
      runtime: psmFixtureRuntime(),
    }),
    /zero token/,
  );
  await assert.rejects(
    () => capturePsmOnchainCase({
      source: SOURCE,
      provider: provider({ fail: true }),
      target: TARGET,
      runtime: psmFixtureRuntime(),
    }),
    /rpc down/,
  );

  console.log("psm onchain capture PASS");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
