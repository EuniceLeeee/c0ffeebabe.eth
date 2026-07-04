import { ethers } from "ethers";
import type { BlockScanOpportunity } from "../detector/detector.js";
import { emitEvent, makeBlockScanOpportunityId } from "../events.js";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error(`FAIL: ${msg}`);
}

function assertEqual(actual: string, expected: string, msg: string): void {
  assert(actual === expected, `${msg}: expected ${expected}, got ${actual}`);
}

function assertNotEqual(actual: string, expected: string, msg: string): void {
  assert(actual !== expected, `${msg}: both were ${actual}`);
}

function assertNoThrow(run: () => void, msg: string): void {
  try {
    run();
  } catch (err) {
    throw new Error(`FAIL: ${msg}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

type TestCase = {
  name: string;
  run: () => void;
};

const SOURCE_BLOCK = 25455296;
const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const POOL_A = "0x00000000000000000000000000000000000000Aa";
const POOL_B = "0x00000000000000000000000000000000000000bB";

function blockScanId(input: {
  sourceBlock?: number;
  cycleId?: string;
  startToken?: string;
  seedPools?: string[];
} = {}): string {
  return makeBlockScanOpportunityId({
    sourceBlock: input.sourceBlock ?? SOURCE_BLOCK,
    cycleId: input.cycleId ?? "weth-usdc-loop-a",
    startToken: input.startToken ?? WETH,
    seedPools: input.seedPools ?? [POOL_B, POOL_A],
  });
}

const tests: TestCase[] = [
  {
    name: "deterministic preimage and same-source distinct cycles",
    run: () => {
      const id = blockScanId();
      assertEqual(blockScanId(), id, "same input should produce the same id");

      const sortedPools = [POOL_B, POOL_A].map((pool) => pool.toLowerCase()).sort();
      const expectedPreimage = [
        "blockscan",
        String(SOURCE_BLOCK),
        "weth-usdc-loop-a",
        WETH.toLowerCase(),
        sortedPools.join(","),
      ].join("|");
      const expected = ethers.keccak256(ethers.toUtf8Bytes(expectedPreimage));
      assertEqual(id, expected, "block-scan id preimage");

      const secondCycle = blockScanId({ cycleId: "weth-usdc-loop-b" });
      assertNotEqual(secondCycle, id, "two anchors in one source_block should be distinct opportunity_ids");
    },
  },
  {
    name: "address normalization and seed-pool sorting",
    run: () => {
      const mixed = blockScanId({ startToken: WETH, seedPools: [POOL_B, POOL_A] });
      const normalized = blockScanId({
        startToken: WETH.toLowerCase(),
        seedPools: [POOL_A.toLowerCase(), POOL_B.toLowerCase()],
      });
      assertEqual(normalized, mixed, "mixed-case and sorted lowercase inputs");
    },
  },
  {
    name: "sourceBlock identity",
    run: () => {
      assertNotEqual(blockScanId({ sourceBlock: SOURCE_BLOCK + 1 }), blockScanId(), "different sourceBlock");
    },
  },
  {
    name: "block scan opportunity and result event",
    run: () => {
      const opportunity: BlockScanOpportunity = {
        kind: "block-scan-arb",
        sourceBlock: SOURCE_BLOCK,
        stateBlock: SOURCE_BLOCK + 1,
        cycleId: "weth-usdc-loop-a",
        cycleFingerprint: "0x1111111111111111111111111111111111111111111111111111111111111111",
        seedEdges: [{
          adapterId: "univ3-swap",
          target: POOL_A,
          tokenIn: WETH,
          tokenOut: USDC,
          slotKind: "swap",
          edgeKind: "swap",
          leavesStandingPosition: false,
        }],
        flashToken: WETH,
        searchSeed: WETH,
        leavesStandingPosition: false,
        affectedPools: [POOL_A],
        affectedTokens: [WETH, USDC],
      };
      assert(opportunity.kind === "block-scan-arb", "BlockScanOpportunity literal");

      const event: Parameters<typeof emitEvent>[0] = {
        type: "block_scan_result",
        source_block: SOURCE_BLOCK,
        state_block: SOURCE_BLOCK + 1,
        outcome: "ran",
        scanned_pairs: 2,
        swap_touched_pools: 2,
        candidates: 1,
        scan_ms: 12,
      };
      assertNoThrow(() => emitEvent(event), "block_scan_result emit");
    },
  },
  {
    name: "pipeline dropped without victim hash",
    run: () => {
      const event: Parameters<typeof emitEvent>[0] = {
        type: "pipeline_dropped",
        opportunity_id: blockScanId(),
        target_block: SOURCE_BLOCK + 1,
        opportunity_kind: "block-scan-arb",
        source_block: SOURCE_BLOCK,
        stage: "block-scan",
        reason: "blockscan_stale_state",
      };
      assertNoThrow(() => emitEvent(event), "pipeline_dropped without victim_hash emit");
    },
  },
];

let passed = 0;
for (const test of tests) {
  try {
    test.run();
    passed++;
    console.log(`[blockscan-contract] ${test.name}: PASS`);
  } catch (err) {
    console.error(`[blockscan-contract] ${test.name}: FAIL`);
    console.error(err instanceof Error ? err.message : String(err));
    console.error(`blockscan-contract FAIL (${passed}/${tests.length})`);
    process.exit(1);
  }
}

console.log(`blockscan-contract PASS (${passed}/${tests.length})`);
