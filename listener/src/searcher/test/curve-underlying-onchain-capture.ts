import assert from "node:assert/strict";
import {
  captureCurveUnderlyingOnchainCase,
  CURVE_UNDERLYING_FIXTURE_POOL,
  CURVE_UNDERLYING_FIXTURE_TOKEN_IN,
  CURVE_UNDERLYING_FIXTURE_TOKEN_OUT,
  curveUnderlyingFixtureRuntime,
  type OnchainUniv2Provider,
} from "../architecture-migration-fixture-replay.js";
import {
  CURVE_UNDERLYING_META_INTERFACE,
} from "../venues/swaps/curve-underlying-family/codec.js";
import { CURVE_UNDERLYING_FAMILY_ID } from
  "../venues/swaps/curve-underlying-family/manifest.js";
import type { CanonicalSource } from
  "../venues/adapter-request-program.js";

const SOURCE: CanonicalSource = Object.freeze({
  number: 20_000_000,
  hash: `0x${"bc".repeat(32)}`,
  generation: 1,
});
const POOL = CURVE_UNDERLYING_FIXTURE_POOL.toLowerCase();
const ZERO = `0x${"00".repeat(20)}`;

function provider(input: {
  readonly coin0?: string;
  readonly coin1?: string;
  readonly fail?: boolean;
} = {}): OnchainUniv2Provider {
  return {
    async call() {
      if (input.fail === true) throw new Error("rpc down");
      return CURVE_UNDERLYING_META_INTERFACE.encodeFunctionResult(
        "get_underlying_coins",
        [[
          input.coin0 ?? CURVE_UNDERLYING_FIXTURE_TOKEN_IN,
          input.coin1 ?? CURVE_UNDERLYING_FIXTURE_TOKEN_OUT,
          ...Array(6).fill(ZERO),
        ]],
      );
    },
  };
}

async function main(): Promise<void> {
  const capture = await captureCurveUnderlyingOnchainCase({
    source: SOURCE,
    provider: provider(),
    pool: POOL,
    tokenIn: CURVE_UNDERLYING_FIXTURE_TOKEN_IN,
    tokenOut: CURVE_UNDERLYING_FIXTURE_TOKEN_OUT,
    runtime: curveUnderlyingFixtureRuntime(),
  });
  assert.equal(capture.familyId, CURVE_UNDERLYING_FAMILY_ID);
  for (const stage of Object.values(capture.stages)) {
    if (stage === undefined) continue;
    assert(
      stage.evidenceRefs.every((ref) =>
        ref === `onchain:1:${SOURCE.hash}:curve-underlying:${POOL}`
      ),
    );
    assert(stage.evidenceRefs.every((ref) => !ref.startsWith("fixture:")));
  }

  await assert.rejects(
    () => captureCurveUnderlyingOnchainCase({
      source: SOURCE,
      provider: provider({ coin1: `0x${"ee".repeat(20)}` }),
      pool: POOL,
      tokenIn: CURVE_UNDERLYING_FIXTURE_TOKEN_IN,
      tokenOut: CURVE_UNDERLYING_FIXTURE_TOKEN_OUT,
      runtime: curveUnderlyingFixtureRuntime(),
    }),
    /coin mismatch/,
  );
  await assert.rejects(
    () => captureCurveUnderlyingOnchainCase({
      source: SOURCE,
      provider: provider({ coin0: ZERO }),
      pool: POOL,
      runtime: curveUnderlyingFixtureRuntime(),
    }),
    /zero coin/,
  );
  await assert.rejects(
    () => captureCurveUnderlyingOnchainCase({
      source: SOURCE,
      provider: provider({ fail: true }),
      pool: POOL,
      runtime: curveUnderlyingFixtureRuntime(),
    }),
    /rpc down/,
  );

  console.log("curve-underlying onchain capture PASS");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
