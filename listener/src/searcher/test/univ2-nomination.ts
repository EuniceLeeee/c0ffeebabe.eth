import assert from "node:assert/strict";
import { ethers } from "ethers";
import { nominateUniv2 } from
  "../venues/swaps/univ2-family/nomination.js";
import type {
  CaptureNominationProvider,
  UnifiedObservation,
} from "../venues/adapter-family-plugin.js";
import type { CanonicalSource } from
  "../venues/adapter-request-program.js";
import {
  UNIV2_FACTORY_INTERFACE,
  UNIV2_PAIR_CREATED_TOPIC,
  UNIV2_PAIR_INTERFACE,
} from "../venues/swaps/univ2-abi.js";

const SOURCE: CanonicalSource = Object.freeze({
  number: 20_000_000,
  hash: `0x${"a1".repeat(32)}`,
  generation: 1,
});
const POOL = `0x${"a2".repeat(20)}`;
const FACTORY = `0x${"b1".repeat(20)}`;
const TOKEN0 = `0x${"c1".repeat(20)}`;
const TOKEN1 = `0x${"c2".repeat(20)}`;
const TX = `0x${"d1".repeat(32)}`;

function addressWord(address: string): string {
  return ethers.zeroPadValue(address, 32).toLowerCase();
}

function pairCreatedLog(): {
  readonly address: string;
  readonly topics: readonly string[];
  readonly data: string;
  readonly transactionHash: string;
} {
  return {
    address: FACTORY.toLowerCase(),
    topics: [
      UNIV2_PAIR_CREATED_TOPIC.toLowerCase(),
      addressWord(TOKEN0),
      addressWord(TOKEN1),
    ],
    data: ethers.concat([
      addressWord(POOL),
      ethers.zeroPadValue("0x01", 32),
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
      const fn = UNIV2_PAIR_INTERFACE.getFunction(
        UNIV2_PAIR_INTERFACE.getFunctionName(selector),
      )!;
      const value = reads[fn.name];
      if (value === undefined) throw new Error(`unexpected read ${fn.name}`);
      return ethers.AbiCoder.defaultAbiCoder().encode(["address"], [value]);
    },
    getCode: async () => "0x01",
    getStorage: async () => `0x${"00".repeat(32)}`,
    getLogs: async () => Object.freeze([...(input.logs ?? [])]),
  };
}

async function main(): Promise<void> {
  // Positive: reads token0/token1/factory and re-materializes the real
  // PairCreated log via exact topics on the factory.
  const positive = await nominateUniv2({
    nominations: Object.freeze([Object.freeze({
      address: POOL,
      opaque: Object.freeze({ adapter: "univ2" }),
    })]),
    source: SOURCE,
    provider: mockProvider({
      reads: { factory: FACTORY, token0: TOKEN0, token1: TOKEN1 },
      logs: [pairCreatedLog()],
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
  assert.deepEqual(observation.topics[0], UNIV2_PAIR_CREATED_TOPIC.toLowerCase());

  // Foreign opaque label is ignored (framework stays family-blind).
  const foreign = await nominateUniv2({
    nominations: Object.freeze([Object.freeze({
      address: POOL,
      opaque: Object.freeze({ adapter: "other" }),
    })]),
    source: SOURCE,
    provider: mockProvider({}),
  });
  assert.equal(foreign.length, 0);

  // RPC failure on a nomination is isolated, not fatal.
  const failing = await nominateUniv2({
    nominations: Object.freeze([
      Object.freeze({ address: POOL, opaque: Object.freeze({ adapter: "univ2" }) }),
    ]),
    source: SOURCE,
    provider: mockProvider({ reads: {} }),
  });
  assert.equal(failing.length, 0);

  // No matching factory log (e.g. a fork pool whose creation tx is missing)
  // yields no observation; it must not fabricate one.
  const noLog = await nominateUniv2({
    nominations: Object.freeze([Object.freeze({
      address: POOL,
      opaque: Object.freeze({ adapter: "univ2" }),
    })]),
    source: SOURCE,
    provider: mockProvider({
      reads: { factory: FACTORY, token0: TOKEN0, token1: TOKEN1 },
      logs: [],
    }),
  });
  assert.equal(noLog.length, 0);

  // Decode round-trip: the PairCreated data carries the real pool identity
  // which the lifecycle identity stage re-verifies against the pair.
  const decoded = UNIV2_FACTORY_INTERFACE.decodeEventLog(
    "PairCreated",
    pairCreatedLog().data,
    pairCreatedLog().topics,
  );
  assert.equal(
    ethers.getAddress(String(decoded.pair)).toLowerCase(),
    POOL.toLowerCase(),
  );
  assert.equal(
    ethers.getAddress(String(decoded.token0)).toLowerCase(),
    TOKEN0.toLowerCase(),
  );

  console.log("univ2 nomination PASS");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
