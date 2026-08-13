import assert from "node:assert/strict";
import {
  captureEigenpieOnchainCase,
  EIGENPIE_FIXTURE_ASSET,
  EIGENPIE_FIXTURE_RECEIPT,
  EIGENPIE_FIXTURE_TARGET,
  eigenpieFixtureRuntime,
  type OnchainUniv2Provider,
} from "../architecture-migration-fixture-replay.js";
import { EIGENPIE_INTERFACE } from
  "../venues/protocols/eigenpie-family/codec.js";
import { EIGENPIE_FAMILY_ID } from
  "../venues/protocols/eigenpie-family/manifest.js";
import type { CanonicalSource } from
  "../venues/adapter-request-program.js";

const SOURCE: CanonicalSource = Object.freeze({
  number: 20_000_000,
  hash: `0x${"e1".repeat(32)}`,
  generation: 1,
});
const TARGET = EIGENPIE_FIXTURE_TARGET.toLowerCase();

function provider(input: {
  readonly receipt?: string;
  readonly fail?: boolean;
} = {}): OnchainUniv2Provider {
  return {
    async call() {
      if (input.fail === true) throw new Error("rpc down");
      return EIGENPIE_INTERFACE.encodeFunctionResult("getMLRTAmountToMint", [
        1_000_000n,
        input.receipt ?? EIGENPIE_FIXTURE_RECEIPT,
      ]);
    },
  };
}

async function main(): Promise<void> {
  const capture = await captureEigenpieOnchainCase({
    source: SOURCE,
    provider: provider(),
    target: TARGET,
    asset: EIGENPIE_FIXTURE_ASSET,
    receipt: EIGENPIE_FIXTURE_RECEIPT,
    runtime: eigenpieFixtureRuntime(),
  });
  assert.equal(capture.familyId, EIGENPIE_FAMILY_ID);
  for (const stage of Object.values(capture.stages)) {
    if (stage === undefined) continue;
    assert(
      stage.evidenceRefs.every((ref) =>
        ref === `onchain:1:${SOURCE.hash}:eigenpie:${TARGET}`
      ),
    );
    assert(stage.evidenceRefs.every((ref) => !ref.startsWith("fixture:")));
  }

  await assert.rejects(
    () => captureEigenpieOnchainCase({
      source: SOURCE,
      provider: provider({ receipt: `0x${"ee".repeat(20)}` }),
      target: TARGET,
      asset: EIGENPIE_FIXTURE_ASSET,
      receipt: EIGENPIE_FIXTURE_RECEIPT,
      runtime: eigenpieFixtureRuntime(),
    }),
    /receipt mismatch/,
  );
  await assert.rejects(
    () => captureEigenpieOnchainCase({
      source: SOURCE,
      provider: provider({ receipt: `0x${"00".repeat(20)}` }),
      target: TARGET,
      asset: EIGENPIE_FIXTURE_ASSET,
      runtime: eigenpieFixtureRuntime(),
    }),
    /zero receipt/,
  );
  await assert.rejects(
    () => captureEigenpieOnchainCase({
      source: SOURCE,
      provider: provider({ fail: true }),
      target: TARGET,
      asset: EIGENPIE_FIXTURE_ASSET,
      runtime: eigenpieFixtureRuntime(),
    }),
    /rpc down/,
  );

  console.log("eigenpie onchain capture PASS");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
