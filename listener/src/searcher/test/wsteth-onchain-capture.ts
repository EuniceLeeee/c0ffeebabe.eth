import assert from "node:assert/strict";
import {
  captureWstethOnchainCase,
  WSTETH_FIXTURE_STETH,
  WSTETH_FIXTURE_TARGET,
  type OnchainUniv2Provider,
} from "../architecture-migration-fixture-replay.js";
import { WSTETH_INTERFACE } from
  "../venues/protocols/wsteth-family/codec.js";
import { WSTETH_FAMILY_ID } from
  "../venues/protocols/wsteth-family/manifest.js";
import type { CanonicalSource } from
  "../venues/adapter-request-program.js";

const SOURCE: CanonicalSource = Object.freeze({
  number: 20_000_000,
  hash: `0x${"ad".repeat(32)}`,
  generation: 1,
});
const TARGET = WSTETH_FIXTURE_TARGET.toLowerCase();

function provider(input: {
  readonly stEth?: string;
  readonly fail?: boolean;
} = {}): OnchainUniv2Provider {
  return {
    async call() {
      if (input.fail === true) throw new Error("rpc down");
      return WSTETH_INTERFACE.encodeFunctionResult("stETH", [
        input.stEth ?? WSTETH_FIXTURE_STETH,
      ]);
    },
  };
}

async function main(): Promise<void> {
  const capture = await captureWstethOnchainCase({
    source: SOURCE,
    provider: provider(),
    target: TARGET,
    stEth: WSTETH_FIXTURE_STETH,
  });
  assert.equal(capture.familyId, WSTETH_FAMILY_ID);
  for (const stage of Object.values(capture.stages)) {
    if (stage === undefined) continue;
    assert(
      stage.evidenceRefs.every((ref) =>
        ref === `onchain:1:${SOURCE.hash}:wsteth:${TARGET}`
      ),
    );
    assert(stage.evidenceRefs.every((ref) => !ref.startsWith("fixture:")));
  }

  await assert.rejects(
    () => captureWstethOnchainCase({
      source: SOURCE,
      provider: provider({ stEth: `0x${"ee".repeat(20)}` }),
      target: TARGET,
      stEth: WSTETH_FIXTURE_STETH,
    }),
    /stETH mismatch/,
  );
  await assert.rejects(
    () => captureWstethOnchainCase({
      source: SOURCE,
      provider: provider({ stEth: `0x${"00".repeat(20)}` }),
      target: TARGET,
    }),
    /zero stETH/,
  );
  await assert.rejects(
    () => captureWstethOnchainCase({
      source: SOURCE,
      provider: provider({ fail: true }),
      target: TARGET,
    }),
    /rpc down/,
  );

  console.log("wsteth onchain capture PASS");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
