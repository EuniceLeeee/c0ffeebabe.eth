import assert from "node:assert/strict";
import {
  captureUniv4OnchainCase,
  UNIV4_FIXTURE_CURRENCY0,
  UNIV4_FIXTURE_CURRENCY1,
  UNIV4_FIXTURE_FEE,
  UNIV4_FIXTURE_LIQUIDITY,
  UNIV4_FIXTURE_LP_FEE,
  UNIV4_FIXTURE_SQRT_PRICE_X96,
  UNIV4_FIXTURE_TICK_SPACING,
  type OnchainUniv2Provider,
} from "../architecture-migration-fixture-replay.js";
import { UNIV4_STATE_VIEW_INTERFACE } from
  "../venues/swaps/univ4-abi.js";
import { UNIV4_FAMILY_ID } from
  "../venues/swaps/univ4-family/manifest.js";
import type { CanonicalSource } from
  "../venues/adapter-request-program.js";

const SOURCE: CanonicalSource = Object.freeze({
  number: 20_000_000,
  hash: `0x${"be".repeat(32)}`,
  generation: 1,
});

function provider(input: {
  readonly sqrtPriceX96?: bigint;
  readonly lpFee?: bigint;
  readonly liquidity?: bigint;
  readonly fail?: boolean;
} = {}): OnchainUniv2Provider {
  return {
    async call(tx) {
      if (input.fail === true) throw new Error("rpc down");
      const isSlot0 = tx.data.startsWith(
        UNIV4_STATE_VIEW_INTERFACE.getFunction("getSlot0")!.selector,
      );
      return isSlot0
        ? UNIV4_STATE_VIEW_INTERFACE.encodeFunctionResult("getSlot0", [
            input.sqrtPriceX96 ?? UNIV4_FIXTURE_SQRT_PRICE_X96,
            0,
            0,
            input.lpFee ?? UNIV4_FIXTURE_LP_FEE,
          ])
        : UNIV4_STATE_VIEW_INTERFACE.encodeFunctionResult("getLiquidity", [
            input.liquidity ?? UNIV4_FIXTURE_LIQUIDITY,
          ]);
    },
  };
}

async function main(): Promise<void> {
  const capture = await captureUniv4OnchainCase({
    source: SOURCE,
    provider: provider(),
    currency0: UNIV4_FIXTURE_CURRENCY0,
    currency1: UNIV4_FIXTURE_CURRENCY1,
    fee: Number(UNIV4_FIXTURE_FEE),
    tickSpacing: UNIV4_FIXTURE_TICK_SPACING,
    liquidity: UNIV4_FIXTURE_LIQUIDITY,
    sqrtPriceX96: UNIV4_FIXTURE_SQRT_PRICE_X96,
    lpFee: UNIV4_FIXTURE_LP_FEE,
  });
  assert.equal(capture.familyId, UNIV4_FAMILY_ID);
  for (const stage of Object.values(capture.stages)) {
    if (stage === undefined) continue;
    assert(
      stage.evidenceRefs.every((ref) =>
        ref.startsWith(`onchain:1:${SOURCE.hash}:univ4:`)
      ),
    );
    assert(stage.evidenceRefs.every((ref) => !ref.startsWith("fixture:")));
  }

  await assert.rejects(
    () => captureUniv4OnchainCase({
      source: SOURCE,
      provider: provider({ lpFee: 100n }),
      currency0: UNIV4_FIXTURE_CURRENCY0,
      currency1: UNIV4_FIXTURE_CURRENCY1,
      fee: Number(UNIV4_FIXTURE_FEE),
      tickSpacing: UNIV4_FIXTURE_TICK_SPACING,
      lpFee: UNIV4_FIXTURE_LP_FEE,
    }),
    /lpFee mismatch/,
  );
  await assert.rejects(
    () => captureUniv4OnchainCase({
      source: SOURCE,
      provider: provider({ liquidity: 0n }),
      currency0: UNIV4_FIXTURE_CURRENCY0,
      currency1: UNIV4_FIXTURE_CURRENCY1,
      fee: Number(UNIV4_FIXTURE_FEE),
      tickSpacing: UNIV4_FIXTURE_TICK_SPACING,
      liquidity: UNIV4_FIXTURE_LIQUIDITY,
    }),
    /liquidity mismatch/,
  );
  await assert.rejects(
    () => captureUniv4OnchainCase({
      source: SOURCE,
      provider: provider({ fail: true }),
      currency0: UNIV4_FIXTURE_CURRENCY0,
      currency1: UNIV4_FIXTURE_CURRENCY1,
      fee: Number(UNIV4_FIXTURE_FEE),
      tickSpacing: UNIV4_FIXTURE_TICK_SPACING,
    }),
    /rpc down/,
  );

  console.log("univ4 onchain capture PASS");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
