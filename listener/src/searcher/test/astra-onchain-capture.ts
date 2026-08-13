import assert from "node:assert/strict";
import {
  ASTRA_MULTITOKEN_FIXTURE_TARGET,
  ASTRA_MULTITOKEN_FIXTURE_TOKEN_IN,
  ASTRA_MULTITOKEN_FIXTURE_TOKEN_OUT,
  astraFixtureRuntime,
  captureAstraOnchainCase,
  type OnchainUniv2Provider,
} from "../architecture-migration-fixture-replay.js";
import { ASTRA_MULTITOKEN_INTERFACE } from
  "../venues/protocols/astra-multitoken-family/codec.js";
import { ASTRA_MULTITOKEN_FAMILY_ID } from
  "../venues/protocols/astra-multitoken-family/manifest.js";
import type { CanonicalSource } from
  "../venues/adapter-request-program.js";

const SOURCE: CanonicalSource = Object.freeze({
  number: 20_000_000,
  hash: `0x${"d1".repeat(32)}`,
  generation: 1,
});
const TARGET = ASTRA_MULTITOKEN_FIXTURE_TARGET.toLowerCase();

function provider(input: {
  readonly token0?: string;
  readonly token1?: string;
  readonly fail?: boolean;
} = {}): OnchainUniv2Provider {
  return {
    async call(tx) {
      if (input.fail === true) throw new Error("rpc down");
      const index = Number(
        ASTRA_MULTITOKEN_INTERFACE.decodeFunctionData(
          "tokens",
          tx.data,
        )[0],
      );
      const token = index === 0
        ? input.token0 ?? ASTRA_MULTITOKEN_FIXTURE_TOKEN_IN
        : input.token1 ?? ASTRA_MULTITOKEN_FIXTURE_TOKEN_OUT;
      return ASTRA_MULTITOKEN_INTERFACE.encodeFunctionResult("tokens", [token]);
    },
  };
}

async function main(): Promise<void> {
  const capture = await captureAstraOnchainCase({
    source: SOURCE,
    provider: provider(),
    target: TARGET,
    tokenIn: ASTRA_MULTITOKEN_FIXTURE_TOKEN_IN,
    tokenOut: ASTRA_MULTITOKEN_FIXTURE_TOKEN_OUT,
    runtime: astraFixtureRuntime(),
  });
  assert.equal(capture.familyId, ASTRA_MULTITOKEN_FAMILY_ID);
  for (const stage of Object.values(capture.stages)) {
    if (stage === undefined) continue;
    assert(
      stage.evidenceRefs.every((ref) =>
        ref === `onchain:1:${SOURCE.hash}:astra-multitoken:${TARGET}`
      ),
    );
    assert(stage.evidenceRefs.every((ref) => !ref.startsWith("fixture:")));
  }

  await assert.rejects(
    () => captureAstraOnchainCase({
      source: SOURCE,
      provider: provider({ token1: `0x${"ee".repeat(20)}` }),
      target: TARGET,
      tokenIn: ASTRA_MULTITOKEN_FIXTURE_TOKEN_IN,
      tokenOut: ASTRA_MULTITOKEN_FIXTURE_TOKEN_OUT,
      runtime: astraFixtureRuntime(),
    }),
    /token mismatch/,
  );
  await assert.rejects(
    () => captureAstraOnchainCase({
      source: SOURCE,
      provider: provider({ token0: `0x${"00".repeat(20)}` }),
      target: TARGET,
      tokenIn: ASTRA_MULTITOKEN_FIXTURE_TOKEN_IN,
      tokenOut: ASTRA_MULTITOKEN_FIXTURE_TOKEN_OUT,
      runtime: astraFixtureRuntime(),
    }),
    /zero token/,
  );
  await assert.rejects(
    () => captureAstraOnchainCase({
      source: SOURCE,
      provider: provider({ fail: true }),
      target: TARGET,
      tokenIn: ASTRA_MULTITOKEN_FIXTURE_TOKEN_IN,
      tokenOut: ASTRA_MULTITOKEN_FIXTURE_TOKEN_OUT,
      runtime: astraFixtureRuntime(),
    }),
    /rpc down/,
  );

  console.log("astra onchain capture PASS");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
