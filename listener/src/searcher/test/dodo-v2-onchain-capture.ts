import assert from "node:assert/strict";
import {
  captureDodoV2OnchainCase,
  DODO_V2_FIXTURE_BASE_TOKEN,
  DODO_V2_FIXTURE_POOL,
  DODO_V2_FIXTURE_QUOTE_TOKEN,
  dodoV2FixtureRuntime,
  type OnchainUniv2Provider,
} from "../architecture-migration-fixture-replay.js";
import { DODO_V2_POOL_INTERFACE } from
  "../venues/swaps/dodo-v2-abi.js";
import { DODO_V2_FAMILY_ID } from
  "../venues/swaps/dodo-v2-family/manifest.js";
import type { CanonicalSource } from
  "../venues/adapter-request-program.js";

const SOURCE: CanonicalSource = Object.freeze({
  number: 20_000_000,
  hash: `0x${"cd".repeat(32)}`,
  generation: 1,
});
const POOL = DODO_V2_FIXTURE_POOL.toLowerCase();

function provider(input: {
  readonly base?: string;
  readonly quote?: string;
  readonly fail?: boolean;
} = {}): OnchainUniv2Provider {
  return {
    async call(tx) {
      if (input.fail === true) throw new Error("rpc down");
      const isBase = tx.data.startsWith(
        DODO_V2_POOL_INTERFACE.getFunction("_BASE_TOKEN_")!.selector,
      );
      return DODO_V2_POOL_INTERFACE.encodeFunctionResult(
        isBase ? "_BASE_TOKEN_" : "_QUOTE_TOKEN_",
        [isBase
          ? input.base ?? DODO_V2_FIXTURE_BASE_TOKEN
          : input.quote ?? DODO_V2_FIXTURE_QUOTE_TOKEN],
      );
    },
  };
}

async function main(): Promise<void> {
  const capture = await captureDodoV2OnchainCase({
    source: SOURCE,
    provider: provider(),
    pool: POOL,
    baseToken: DODO_V2_FIXTURE_BASE_TOKEN,
    quoteToken: DODO_V2_FIXTURE_QUOTE_TOKEN,
    runtime: dodoV2FixtureRuntime(),
  });
  assert.equal(capture.familyId, DODO_V2_FAMILY_ID);
  for (const stage of Object.values(capture.stages)) {
    if (stage === undefined) continue;
    assert(
      stage.evidenceRefs.every((ref) =>
        ref === `onchain:1:${SOURCE.hash}:dodo-v2:${POOL}`
      ),
    );
    assert(stage.evidenceRefs.every((ref) => !ref.startsWith("fixture:")));
  }

  await assert.rejects(
    () => captureDodoV2OnchainCase({
      source: SOURCE,
      provider: provider({ quote: `0x${"ee".repeat(20)}` }),
      pool: POOL,
      baseToken: DODO_V2_FIXTURE_BASE_TOKEN,
      quoteToken: DODO_V2_FIXTURE_QUOTE_TOKEN,
      runtime: dodoV2FixtureRuntime(),
    }),
    /token mismatch/,
  );
  await assert.rejects(
    () => captureDodoV2OnchainCase({
      source: SOURCE,
      provider: provider({ base: `0x${"00".repeat(20)}` }),
      pool: POOL,
      runtime: dodoV2FixtureRuntime(),
    }),
    /zero token/,
  );
  await assert.rejects(
    () => captureDodoV2OnchainCase({
      source: SOURCE,
      provider: provider({ fail: true }),
      pool: POOL,
      runtime: dodoV2FixtureRuntime(),
    }),
    /rpc down/,
  );

  console.log("dodo-v2 onchain capture PASS");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
