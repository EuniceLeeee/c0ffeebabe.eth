import assert from "node:assert/strict";
import { ethers } from "ethers";
import { nominateUniv3 } from
  "../venues/swaps/univ3-family/nomination.js";
import type {
  CaptureNominationProvider,
  UnifiedObservation,
} from "../venues/adapter-family-plugin.js";
import type { CanonicalSource } from
  "../venues/adapter-request-program.js";
import {
  UNIV3_FACTORY_INTERFACE,
  UNIV3_POOL_CREATED_TOPIC,
  UNIV3_POOL_INTERFACE,
} from "../venues/swaps/univ3-abi.js";

const SOURCE: CanonicalSource = Object.freeze({
  number: 20_000_000,
  hash: `0x${"a1".repeat(32)}`,
  generation: 1,
});
const POOL = `0x${"a2".repeat(20)}`;
const FACTORY = `0x${"b1".repeat(20)}`;
const TOKEN0 = `0x${"c1".repeat(20)}`;
const TOKEN1 = `0x${"c2".repeat(20)}`;
const FEE = 500;
const TX = `0x${"d1".repeat(32)}`;

function addressWord(address: string): string {
  return ethers.zeroPadValue(address, 32).toLowerCase();
}

function poolCreatedLog(): {
  readonly address: string;
  readonly topics: readonly string[];
  readonly data: string;
  readonly transactionHash: string;
} {
  return {
    address: FACTORY.toLowerCase(),
    topics: [
      UNIV3_POOL_CREATED_TOPIC.toLowerCase(),
      addressWord(TOKEN0),
      addressWord(TOKEN1),
      ethers.zeroPadValue(ethers.toBeHex(FEE), 32).toLowerCase(),
    ],
    data: ethers.concat([
      ethers.zeroPadValue(ethers.toBeHex(200), 32), // tickSpacing
      addressWord(POOL),
    ]),
    transactionHash: TX.toLowerCase(),
  };
}

function mockProvider(input: {
  readonly reads?: Readonly<Record<string, string>>;
  readonly logs?: readonly {
    readonly address: string;
    readonly topics: readonly string[];
    readonly data: string;
    readonly transactionHash: string;
  }[];
}): CaptureNominationProvider {
  const reads = input.reads ?? {};
  return {
    call: async (transaction) => {
      const selector = transaction.data.slice(0, 10).toLowerCase();
      const fn = UNIV3_POOL_INTERFACE.getFunction(
        UNIV3_POOL_INTERFACE.getFunctionName(selector),
      )!;
      const value = reads[fn.name];
      if (value === undefined) throw new Error(`unexpected read ${fn.name}`);
      return ethers.AbiCoder.defaultAbiCoder().encode(
        fn.outputs.map(() => "uint256"),
        [BigInt(value)],
      );
    },
    getCode: async () => "0x01",
    getStorage: async () => `0x${"00".repeat(32)}`,
    getLogs: async () => Object.freeze([...(input.logs ?? [])]),
  };
}

async function main(): Promise<void> {
  // Positive: reads token0/token1/fee/tickSpacing and re-materializes the
  // real PoolCreated log via exact topics [PoolCreated, token0, token1, fee].
  const positive = await nominateUniv3({
    nominations: Object.freeze([Object.freeze({
      address: POOL,
      opaque: Object.freeze({ adapter: "univ3" }),
    })]),
    source: SOURCE,
    provider: mockProvider({
      reads: {
        factory: FACTORY,
        token0: TOKEN0,
        token1: TOKEN1,
        fee: String(FEE),
        tickSpacing: "200",
      },
      logs: [poolCreatedLog()],
    }),
  });
  assert.equal(positive.length, 1);
  const observation = positive[0] as Extract<
    UnifiedObservation,
    { readonly kind: "log" }
  >;
  assert.equal(observation.kind, "log");
  assert.equal(observation.address, FACTORY.toLowerCase());
  assert.equal(observation.transactionHash, TX.toLowerCase());
  assert.deepEqual(observation.topics[0], UNIV3_POOL_CREATED_TOPIC.toLowerCase());

  // Foreign opaque label ignored.
  const foreign = await nominateUniv3({
    nominations: Object.freeze([Object.freeze({
      address: POOL,
      opaque: Object.freeze({ adapter: "other" }),
    })]),
    source: SOURCE,
    provider: mockProvider({}),
  });
  assert.equal(foreign.length, 0);

  // Fee zero or missing reads fail closed.
  const badFee = await nominateUniv3({
    nominations: Object.freeze([Object.freeze({
      address: POOL,
      opaque: Object.freeze({ adapter: "univ3" }),
    })]),
    source: SOURCE,
    provider: mockProvider({
      reads: {
        factory: FACTORY,
        token0: TOKEN0,
        token1: TOKEN1,
        fee: "0",
        tickSpacing: "200",
      },
      logs: [],
    }),
  });
  assert.equal(badFee.length, 0);

  // No matching PoolCreated log yields nothing (no fabrication).
  const noLog = await nominateUniv3({
    nominations: Object.freeze([Object.freeze({
      address: POOL,
      opaque: Object.freeze({ adapter: "univ3" }),
    })]),
    source: SOURCE,
    provider: mockProvider({
      reads: {
        factory: FACTORY,
        token0: TOKEN0,
        token1: TOKEN1,
        fee: String(FEE),
        tickSpacing: "200",
      },
      logs: [],
    }),
  });
  assert.equal(noLog.length, 0);

  // Decode round-trip: PoolCreated data carries the real pool address.
  const decoded = UNIV3_FACTORY_INTERFACE.decodeEventLog(
    "PoolCreated",
    poolCreatedLog().data,
    poolCreatedLog().topics,
  );
  assert.equal(
    ethers.getAddress(String(decoded.pool)).toLowerCase(),
    POOL.toLowerCase(),
  );

  console.log("univ3 nomination PASS");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
