import assert from "node:assert/strict";
import {
  captureEtherTokenOnchainCase,
  ETHERTOKEN_NATIVE_FIXTURE_TOKEN,
  etherTokenNativeFixtureRuntime,
  type OnchainUniv2Provider,
} from "../architecture-migration-fixture-replay.js";
import { ETHERTOKEN_NATIVE_INTERFACE } from
  "../venues/protocols/ethertoken-native-redeem-family/shared.js";
import { ETHERTOKEN_NATIVE_FAMILY_ID } from
  "../venues/protocols/ethertoken-native-redeem-family/manifest.js";
import type { CanonicalSource } from
  "../venues/adapter-request-program.js";

const SOURCE: CanonicalSource = Object.freeze({
  number: 20_000_000,
  hash: `0x${"f1".repeat(32)}`,
  generation: 1,
});
const TOKEN = ETHERTOKEN_NATIVE_FIXTURE_TOKEN.toLowerCase();

function provider(input: {
  readonly decimals?: number;
  readonly fail?: boolean;
} = {}): OnchainUniv2Provider {
  return {
    async call() {
      if (input.fail === true) throw new Error("rpc down");
      return ETHERTOKEN_NATIVE_INTERFACE.encodeFunctionResult("decimals", [
        input.decimals ?? 18,
      ]);
    },
  };
}

async function main(): Promise<void> {
  const capture = await captureEtherTokenOnchainCase({
    source: SOURCE,
    provider: provider(),
    token: TOKEN,
    decimals: 18,
    runtime: etherTokenNativeFixtureRuntime(),
  });
  assert.equal(capture.familyId, ETHERTOKEN_NATIVE_FAMILY_ID);
  for (const stage of Object.values(capture.stages)) {
    if (stage === undefined) continue;
    assert(
      stage.evidenceRefs.every((ref) =>
        ref === `onchain:1:${SOURCE.hash}:ethertoken:${TOKEN}`
      ),
    );
    assert(stage.evidenceRefs.every((ref) => !ref.startsWith("fixture:")));
  }

  await assert.rejects(
    () => captureEtherTokenOnchainCase({
      source: SOURCE,
      provider: provider({ decimals: 6 }),
      token: TOKEN,
      decimals: 18,
      runtime: etherTokenNativeFixtureRuntime(),
    }),
    /decimals mismatch/,
  );
  await assert.rejects(
    () => captureEtherTokenOnchainCase({
      source: SOURCE,
      provider: provider({ decimals: 0 }),
      token: TOKEN,
      runtime: etherTokenNativeFixtureRuntime(),
    }),
    /invalid decimals/,
  );
  await assert.rejects(
    () => captureEtherTokenOnchainCase({
      source: SOURCE,
      provider: provider({ fail: true }),
      token: TOKEN,
      runtime: etherTokenNativeFixtureRuntime(),
    }),
    /rpc down/,
  );

  console.log("ethertoken onchain capture PASS");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
