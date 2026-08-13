import assert from "node:assert/strict";
import {
  captureMetronomeSynthOnchainCase,
  METRONOME_SYNTH_FIXTURE_POOL,
  metronomeSynthFixtureRuntime,
  type OnchainUniv2Provider,
} from "../architecture-migration-fixture-replay.js";
import {
  METRONOME_SYNTH_POOL_INTERFACE,
  METRONOME_SYNTH_SUPPORTED_TOKENS,
} from "../venues/protocols/metronome-synth-family/shared.js";
import { METRONOME_SYNTH_FAMILY_ID } from
  "../venues/protocols/metronome-synth-family/manifest.js";
import type { CanonicalSource } from
  "../venues/adapter-request-program.js";

const SOURCE: CanonicalSource = Object.freeze({
  number: 20_000_000,
  hash: `0x${"ba".repeat(32)}`,
  generation: 1,
});
const POOL = METRONOME_SYNTH_FIXTURE_POOL.toLowerCase();
const TOKEN_IN = METRONOME_SYNTH_SUPPORTED_TOKENS[0];
const TOKEN_OUT = METRONOME_SYNTH_SUPPORTED_TOKENS[1];

function provider(input: {
  readonly amountOut?: bigint;
  readonly fail?: boolean;
} = {}): OnchainUniv2Provider {
  return {
    async call() {
      if (input.fail === true) throw new Error("rpc down");
      return METRONOME_SYNTH_POOL_INTERFACE.encodeFunctionResult(
        "quoteSwapOut",
        [input.amountOut ?? 1_000_000n, 0n],
      );
    },
  };
}

async function main(): Promise<void> {
  const capture = await captureMetronomeSynthOnchainCase({
    source: SOURCE,
    provider: provider(),
    pool: POOL,
    tokenIn: TOKEN_IN,
    tokenOut: TOKEN_OUT,
    runtime: metronomeSynthFixtureRuntime(),
  });
  assert.equal(capture.familyId, METRONOME_SYNTH_FAMILY_ID);
  for (const stage of Object.values(capture.stages)) {
    if (stage === undefined) continue;
    assert(
      stage.evidenceRefs.every((ref) =>
        ref === `onchain:1:${SOURCE.hash}:metronome-synth:${POOL}`
      ),
    );
    assert(stage.evidenceRefs.every((ref) => !ref.startsWith("fixture:")));
  }

  await assert.rejects(
    () => captureMetronomeSynthOnchainCase({
      source: SOURCE,
      provider: provider({ amountOut: 0n }),
      pool: POOL,
      tokenIn: TOKEN_IN,
      tokenOut: TOKEN_OUT,
      runtime: metronomeSynthFixtureRuntime(),
    }),
    /non-positive quote/,
  );
  await assert.rejects(
    () => captureMetronomeSynthOnchainCase({
      source: SOURCE,
      provider: provider({ fail: true }),
      pool: POOL,
      tokenIn: TOKEN_IN,
      tokenOut: TOKEN_OUT,
      runtime: metronomeSynthFixtureRuntime(),
    }),
    /rpc down/,
  );

  console.log("metronome-synth onchain capture PASS");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
