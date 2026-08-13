import assert from "node:assert/strict";
import {
  captureFluidDexOnchainCase,
  FLUID_DEX_FIXTURE_FACTORY,
  FLUID_DEX_FIXTURE_POOL,
  type OnchainUniv2Provider,
} from "../architecture-migration-fixture-replay.js";
import { FLUID_DEX_FACTORY_INTERFACE } from
  "../venues/swaps/fluid-dex-family/codec.js";
import { FLUID_DEX_FAMILY_ID } from
  "../venues/swaps/fluid-dex-family/manifest.js";
import type { CanonicalSource } from
  "../venues/adapter-request-program.js";

const SOURCE: CanonicalSource = Object.freeze({
  number: 20_000_000,
  hash: `0x${"de".repeat(32)}`,
  generation: 1,
});
const POOL = FLUID_DEX_FIXTURE_POOL.toLowerCase();
const FACTORY = FLUID_DEX_FIXTURE_FACTORY.toLowerCase();

function provider(input: {
  readonly dex?: string;
  readonly fail?: boolean;
} = {}): OnchainUniv2Provider {
  return {
    async call() {
      if (input.fail === true) throw new Error("rpc down");
      return FLUID_DEX_FACTORY_INTERFACE.encodeFunctionResult("getDexAddress", [
        input.dex ?? FLUID_DEX_FIXTURE_POOL,
      ]);
    },
  };
}

async function main(): Promise<void> {
  const capture = await captureFluidDexOnchainCase({
    source: SOURCE,
    provider: provider(),
    pool: POOL,
    factory: FACTORY,
  });
  assert.equal(capture.familyId, FLUID_DEX_FAMILY_ID);
  for (const stage of Object.values(capture.stages)) {
    if (stage === undefined) continue;
    assert(
      stage.evidenceRefs.every((ref) =>
        ref === `onchain:1:${SOURCE.hash}:fluid-dex:${POOL}`
      ),
    );
    assert(stage.evidenceRefs.every((ref) => !ref.startsWith("fixture:")));
  }

  await assert.rejects(
    () => captureFluidDexOnchainCase({
      source: SOURCE,
      provider: provider({ dex: `0x${"ee".repeat(20)}` }),
      pool: POOL,
      factory: FACTORY,
    }),
    /reverse-binding mismatch/,
  );
  await assert.rejects(
    () => captureFluidDexOnchainCase({
      source: SOURCE,
      provider: provider({ dex: `0x${"00".repeat(20)}` }),
      pool: POOL,
      factory: FACTORY,
    }),
    /zero dex/,
  );
  await assert.rejects(
    () => captureFluidDexOnchainCase({
      source: SOURCE,
      provider: provider({ fail: true }),
      pool: POOL,
      factory: FACTORY,
    }),
    /rpc down/,
  );

  console.log("fluid-dex onchain capture PASS");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
