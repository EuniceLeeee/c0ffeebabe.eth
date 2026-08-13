import assert from "node:assert/strict";
import {
  captureSelfBurnOnchainCase,
  SELF_BURN_NATIVE_FIXTURE_TOKEN,
  selfBurnNativeFixtureRuntime,
  type OnchainUniv2Provider,
} from "../architecture-migration-fixture-replay.js";
import { SELF_BURN_NATIVE_TOKEN_INTERFACE } from
  "../venues/protocols/self-burn-native-family/shared.js";
import { SELF_BURN_NATIVE_FAMILY_ID } from
  "../venues/protocols/self-burn-native-family/manifest.js";
import type { CanonicalSource } from
  "../venues/adapter-request-program.js";

const SOURCE: CanonicalSource = Object.freeze({
  number: 20_000_000,
  hash: `0x${"bb".repeat(32)}`,
  generation: 1,
});
const TOKEN = SELF_BURN_NATIVE_FIXTURE_TOKEN.toLowerCase();

function provider(input: {
  readonly decimals?: number;
  readonly fail?: boolean;
} = {}): OnchainUniv2Provider {
  return {
    async call() {
      if (input.fail === true) throw new Error("rpc down");
      return SELF_BURN_NATIVE_TOKEN_INTERFACE.encodeFunctionResult("decimals", [
        input.decimals ?? 18,
      ]);
    },
  };
}

async function main(): Promise<void> {
  const capture = await captureSelfBurnOnchainCase({
    source: SOURCE,
    provider: provider(),
    token: TOKEN,
    decimals: 18,
    runtime: selfBurnNativeFixtureRuntime(),
  });
  assert.equal(capture.familyId, SELF_BURN_NATIVE_FAMILY_ID);
  for (const stage of Object.values(capture.stages)) {
    if (stage === undefined) continue;
    assert(
      stage.evidenceRefs.every((ref) =>
        ref === `onchain:1:${SOURCE.hash}:self-burn:${TOKEN}`
      ),
    );
    assert(stage.evidenceRefs.every((ref) => !ref.startsWith("fixture:")));
  }

  await assert.rejects(
    () => captureSelfBurnOnchainCase({
      source: SOURCE,
      provider: provider({ decimals: 6 }),
      token: TOKEN,
      decimals: 18,
      runtime: selfBurnNativeFixtureRuntime(),
    }),
    /decimals mismatch/,
  );
  await assert.rejects(
    () => captureSelfBurnOnchainCase({
      source: SOURCE,
      provider: provider({ decimals: 0 }),
      token: TOKEN,
      runtime: selfBurnNativeFixtureRuntime(),
    }),
    /invalid decimals/,
  );
  await assert.rejects(
    () => captureSelfBurnOnchainCase({
      source: SOURCE,
      provider: provider({ fail: true }),
      token: TOKEN,
      runtime: selfBurnNativeFixtureRuntime(),
    }),
    /rpc down/,
  );

  console.log("self-burn onchain capture PASS");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
