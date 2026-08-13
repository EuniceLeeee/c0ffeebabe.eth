import assert from "node:assert/strict";
import {
  captureUniv3OnchainCase,
  UNIV3_FIXTURE_FACTORY,
  UNIV3_FIXTURE_FEE,
  UNIV3_FIXTURE_LIQUIDITY,
  UNIV3_FIXTURE_POOL,
  UNIV3_FIXTURE_SQRT_PRICE_X96,
  UNIV3_FIXTURE_TICK_SPACING,
  UNIV3_FIXTURE_TOKEN0,
  UNIV3_FIXTURE_TOKEN1,
  type OnchainUniv2Provider,
} from "../architecture-migration-fixture-replay.js";
import { UNIV3_POOL_INTERFACE } from
  "../venues/swaps/univ3-abi.js";
import { UNIV3_FAMILY_ID } from
  "../venues/swaps/univ3-family/manifest.js";
import type { CanonicalSource } from
  "../venues/adapter-request-program.js";

const SOURCE: CanonicalSource = Object.freeze({
  number: 20_000_000,
  hash: `0x${"bd".repeat(32)}`,
  generation: 1,
});
const POOL = UNIV3_FIXTURE_POOL.toLowerCase();

function provider(input: {
  readonly token0?: string;
  readonly token1?: string;
  readonly fee?: bigint;
  readonly fail?: boolean;
} = {}): OnchainUniv2Provider {
  return {
    async call(tx) {
      if (input.fail === true) throw new Error("rpc down");
      const sel = tx.data.slice(0, 10).toLowerCase();
      const name = [
        "factory",
        "token0",
        "token1",
        "fee",
        "tickSpacing",
        "slot0",
        "liquidity",
      ].find((candidate) =>
        sel === UNIV3_POOL_INTERFACE.getFunction(candidate)!.selector
      )!;
      if (name === "factory") {
        return UNIV3_POOL_INTERFACE.encodeFunctionResult(name, [
          UNIV3_FIXTURE_FACTORY,
        ]);
      }
      if (name === "token0") {
        return UNIV3_POOL_INTERFACE.encodeFunctionResult(name, [
          input.token0 ?? UNIV3_FIXTURE_TOKEN0,
        ]);
      }
      if (name === "token1") {
        return UNIV3_POOL_INTERFACE.encodeFunctionResult(name, [
          input.token1 ?? UNIV3_FIXTURE_TOKEN1,
        ]);
      }
      if (name === "fee") {
        return UNIV3_POOL_INTERFACE.encodeFunctionResult(name, [
          input.fee ?? UNIV3_FIXTURE_FEE,
        ]);
      }
      if (name === "tickSpacing") {
        return UNIV3_POOL_INTERFACE.encodeFunctionResult(name, [
          UNIV3_FIXTURE_TICK_SPACING,
        ]);
      }
      if (name === "slot0") {
        return UNIV3_POOL_INTERFACE.encodeFunctionResult(name, [
          UNIV3_FIXTURE_SQRT_PRICE_X96,
          0,
          0,
          0,
          0,
          0,
          true,
        ]);
      }
      return UNIV3_POOL_INTERFACE.encodeFunctionResult("liquidity", [
        UNIV3_FIXTURE_LIQUIDITY,
      ]);
    },
  };
}

async function main(): Promise<void> {
  const capture = await captureUniv3OnchainCase({
    source: SOURCE,
    provider: provider(),
    pool: POOL,
    tokenA: UNIV3_FIXTURE_TOKEN0,
    tokenB: UNIV3_FIXTURE_TOKEN1,
    fee: UNIV3_FIXTURE_FEE,
    tickSpacing: UNIV3_FIXTURE_TICK_SPACING,
    liquidity: UNIV3_FIXTURE_LIQUIDITY,
    sqrtPriceX96: UNIV3_FIXTURE_SQRT_PRICE_X96,
  });
  assert.equal(capture.familyId, UNIV3_FAMILY_ID);
  for (const stage of Object.values(capture.stages)) {
    if (stage === undefined) continue;
    assert(
      stage.evidenceRefs.every((ref) =>
        ref === `onchain:1:${SOURCE.hash}:univ3:${POOL}`
      ),
    );
    assert(stage.evidenceRefs.every((ref) => !ref.startsWith("fixture:")));
  }

  await assert.rejects(
    () => captureUniv3OnchainCase({
      source: SOURCE,
      provider: provider({ token1: `0x${"ee".repeat(20)}` }),
      pool: POOL,
      tokenA: UNIV3_FIXTURE_TOKEN0,
      tokenB: UNIV3_FIXTURE_TOKEN1,
    }),
    /tokenB mismatch/,
  );
  await assert.rejects(
    () => captureUniv3OnchainCase({
      source: SOURCE,
      provider: provider({ fee: 3000n }),
      pool: POOL,
      fee: UNIV3_FIXTURE_FEE,
    }),
    /fee mismatch/,
  );
  await assert.rejects(
    () => captureUniv3OnchainCase({
      source: SOURCE,
      provider: provider({ fail: true }),
      pool: POOL,
    }),
    /rpc down/,
  );

  console.log("univ3 onchain capture PASS");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
