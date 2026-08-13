import assert from "node:assert/strict";
import {
  ANGSTROM_FIXTURE_CONTROLLER,
  ANGSTROM_FIXTURE_CURRENCY0,
  ANGSTROM_FIXTURE_CURRENCY1,
  ANGSTROM_FIXTURE_FEE,
  ANGSTROM_FIXTURE_TICK_SPACING,
  captureAngstromV4OnchainCase,
  type OnchainUniv2Provider,
} from "../architecture-migration-fixture-replay.js";
import { ANGSTROM_CONTROLLER_INTERFACE } from
  "../venues/swaps/univ4-abi.js";
import { ANGSTROM_MAINNET_HOOK } from
  "../venues/swaps/angstrom-attestation.js";
import { ANGSTROM_V4_FAMILY_ID } from
  "../venues/swaps/angstrom-v4-family/manifest.js";
import type { CanonicalSource } from
  "../venues/adapter-request-program.js";

const SOURCE: CanonicalSource = Object.freeze({
  number: 20_000_000,
  hash: `0x${"bc".repeat(32)}`,
  generation: 1,
});
const CONTROLLER = ANGSTROM_FIXTURE_CONTROLLER.toLowerCase();

function provider(input: {
  readonly hook?: string;
  readonly fail?: boolean;
} = {}): OnchainUniv2Provider {
  return {
    async call() {
      if (input.fail === true) throw new Error("rpc down");
      return ANGSTROM_CONTROLLER_INTERFACE.encodeFunctionResult("ANGSTROM", [
        input.hook ?? ANGSTROM_MAINNET_HOOK,
      ]);
    },
  };
}

async function main(): Promise<void> {
  const capture = await captureAngstromV4OnchainCase({
    source: SOURCE,
    provider: provider(),
    controller: CONTROLLER,
    currency0: ANGSTROM_FIXTURE_CURRENCY0,
    currency1: ANGSTROM_FIXTURE_CURRENCY1,
    fee: ANGSTROM_FIXTURE_FEE,
    tickSpacing: ANGSTROM_FIXTURE_TICK_SPACING,
  });
  assert.equal(capture.familyId, ANGSTROM_V4_FAMILY_ID);
  for (const stage of Object.values(capture.stages)) {
    if (stage === undefined) continue;
    assert(
      stage.evidenceRefs.every((ref) =>
        ref === `onchain:1:${SOURCE.hash}:angstrom-v4:${CONTROLLER}`
      ),
    );
    assert(stage.evidenceRefs.every((ref) => !ref.startsWith("fixture:")));
  }

  await assert.rejects(
    () => captureAngstromV4OnchainCase({
      source: SOURCE,
      provider: provider({ hook: `0x${"ee".repeat(20)}` }),
      controller: CONTROLLER,
      currency0: ANGSTROM_FIXTURE_CURRENCY0,
      currency1: ANGSTROM_FIXTURE_CURRENCY1,
      fee: ANGSTROM_FIXTURE_FEE,
      tickSpacing: ANGSTROM_FIXTURE_TICK_SPACING,
    }),
    /hook mismatch/,
  );
  await assert.rejects(
    () => captureAngstromV4OnchainCase({
      source: SOURCE,
      provider: provider({ hook: `0x${"00".repeat(20)}` }),
      controller: CONTROLLER,
      currency0: ANGSTROM_FIXTURE_CURRENCY0,
      currency1: ANGSTROM_FIXTURE_CURRENCY1,
      fee: ANGSTROM_FIXTURE_FEE,
      tickSpacing: ANGSTROM_FIXTURE_TICK_SPACING,
    }),
    /zero hook/,
  );
  await assert.rejects(
    () => captureAngstromV4OnchainCase({
      source: SOURCE,
      provider: provider({ fail: true }),
      controller: CONTROLLER,
      currency0: ANGSTROM_FIXTURE_CURRENCY0,
      currency1: ANGSTROM_FIXTURE_CURRENCY1,
      fee: ANGSTROM_FIXTURE_FEE,
      tickSpacing: ANGSTROM_FIXTURE_TICK_SPACING,
    }),
    /rpc down/,
  );

  console.log("angstrom-v4 onchain capture PASS");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
