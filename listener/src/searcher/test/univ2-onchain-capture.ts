import assert from "node:assert/strict";
import {
  captureUniv2OnchainCase,
  type OnchainUniv2Provider,
} from "../architecture-migration-fixture-replay.js";
import {
  UNIV2_PAIR_INTERFACE,
} from "../venues/swaps/univ2-family/codec.js";
import { UNIV2_FAMILY_ID } from
  "../venues/swaps/univ2-family/manifest.js";
import type { CanonicalSource } from
  "../venues/adapter-request-program.js";

const SOURCE: CanonicalSource = Object.freeze({
  number: 20_000_000,
  hash: `0x${"a1".repeat(32)}`,
  generation: 1,
});
const POOL = `0x${"a2".repeat(20)}`;
const FACTORY = `0x${"b1".repeat(20)}`;
const TOKEN0 = `0x${"c1".repeat(20)}`;
const TOKEN1 = `0x${"c2".repeat(20)}`;
const RESERVE0 = 1_000n;
const RESERVE1 = 2_000n;

function selector(name: string): string {
  return UNIV2_PAIR_INTERFACE.getFunction(name)!.selector;
}

function mockProvider(input: {
  readonly factory?: string;
  readonly token0?: string;
  readonly token1?: string;
  readonly reserve0?: bigint;
  readonly reserve1?: bigint;
  readonly failRead?: boolean;
  readonly seenBlocks?: number[];
} = {}): OnchainUniv2Provider {
  return {
    async call(tx, blockTag) {
      input.seenBlocks?.push(blockTag ?? -1);
      if (input.failRead === true) {
        throw new Error("rpc down");
      }
      const data = tx.data;
      if (data.startsWith(selector("factory"))) {
        return UNIV2_PAIR_INTERFACE.encodeFunctionResult("factory", [
          input.factory ?? FACTORY,
        ]);
      }
      if (data.startsWith(selector("token0"))) {
        return UNIV2_PAIR_INTERFACE.encodeFunctionResult("token0", [
          input.token0 ?? TOKEN0,
        ]);
      }
      if (data.startsWith(selector("token1"))) {
        return UNIV2_PAIR_INTERFACE.encodeFunctionResult("token1", [
          input.token1 ?? TOKEN1,
        ]);
      }
      if (data.startsWith(selector("getReserves"))) {
        return UNIV2_PAIR_INTERFACE.encodeFunctionResult("getReserves", [
          input.reserve0 ?? RESERVE0,
          input.reserve1 ?? RESERVE1,
          123n,
        ]);
      }
      throw new Error("unexpected call data");
    },
  };
}

async function main(): Promise<void> {
  const seenBlocks: number[] = [];
  const capture = await captureUniv2OnchainCase({
    source: SOURCE,
    provider: mockProvider({ seenBlocks }),
    pool: POOL,
    tokenA: TOKEN0,
    tokenB: TOKEN1,
    reserves: {
      reserve0: RESERVE0,
      reserve1: RESERVE1,
    },
  });
  assert.equal(capture.familyId, UNIV2_FAMILY_ID);
  assert.equal(capture.stateAnchorNumber, SOURCE.number);
  assert(
    seenBlocks.every((block) => block === SOURCE.number),
    "onchain reads must be pinned to the canonical source block",
  );
  for (const stage of Object.values(capture.stages)) {
    if (stage === undefined) continue;
    assert(
      stage.evidenceRefs.every((ref) =>
        ref === `onchain:1:${SOURCE.hash}:univ2:${POOL}`
      ),
      "onchain capture must carry onchain evidence refs only",
    );
    assert(
      stage.evidenceRefs.every((ref) => !ref.startsWith("fixture:")),
      "onchain capture must not carry fixture provenance",
    );
  }

  await assert.rejects(
    () => captureUniv2OnchainCase({
      source: SOURCE,
      provider: mockProvider(),
      pool: POOL,
      tokenA: `0x${"dd".repeat(20)}`,
    }),
    /tokenA mismatch/,
  );
  await assert.rejects(
    () => captureUniv2OnchainCase({
      source: SOURCE,
      provider: mockProvider({ factory: `0x${"00".repeat(20)}` }),
      pool: POOL,
    }),
    /zero factory/,
  );
  await assert.rejects(
    () => captureUniv2OnchainCase({
      source: SOURCE,
      provider: mockProvider({ failRead: true }),
      pool: POOL,
    }),
    /rpc down/,
  );
  await assert.rejects(
    () => captureUniv2OnchainCase({
      source: SOURCE,
      provider: mockProvider(),
      pool: POOL,
      reserves: { reserve0: RESERVE0 + 1n, reserve1: RESERVE1 },
    }),
    /reserves mismatch/,
  );

  console.log("univ2 onchain capture PASS");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
