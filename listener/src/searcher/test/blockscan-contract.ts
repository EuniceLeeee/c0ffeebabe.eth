import { ethers } from "ethers";
import { rejects } from "node:assert/strict";
import { readBlockTouchedStateKeys } from "../blockscan-touched-state.js";
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
  run: () => void | Promise<void>;
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
        searchSeed: { startToken: WETH, searchCenter: 1_000n, maxInput: 10_000n },
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
  {
    name: "block refresh set unions logs with nested call trace targets",
    run: async () => {
      const v4Manager = "0x00000000000000000000000000000000000000D4";
      const v4PoolId = `0x${"44".repeat(32)}`;
      const logOnly = "0x00000000000000000000000000000000000000A1";
      const duplicateRoot = "0x00000000000000000000000000000000000000B2";
      const nestedCall = "0x00000000000000000000000000000000000000C3";
      const deepCall = "0x00000000000000000000000000000000000000E5";
      let traceMethod = "";
      let traceParams: Array<unknown> = [];

      const touched = await readBlockTouchedStateKeys({
        async getLogs(filter) {
          assert(filter.fromBlock === SOURCE_BLOCK, "log fromBlock");
          assert(filter.toBlock === SOURCE_BLOCK, "log toBlock");
          return [
            { address: logOnly, topics: [] },
            { address: duplicateRoot, topics: [] },
            { address: v4Manager, topics: ["0xswap", v4PoolId] },
          ];
        },
        async send(method, params) {
          traceMethod = method;
          traceParams = params;
          return [{
            txHash: `0x${"11".repeat(32)}`,
            result: {
              type: "CALL",
              to: duplicateRoot,
              calls: [{
                type: "CALL",
                to: nestedCall,
                calls: [{ type: "DELEGATECALL", to: deepCall }],
              }],
            },
          }];
        },
      }, SOURCE_BLOCK, v4Manager);

      assert(traceMethod === "debug_traceBlockByNumber", "block callTracer method");
      assert(traceParams[0] === `0x${SOURCE_BLOCK.toString(16)}`, "hex block tag");
      assert(
        JSON.stringify(traceParams[1]) === JSON.stringify({
          tracer: "callTracer",
          tracerConfig: { onlyTopCall: false },
        }),
        "nested callTracer config",
      );
      assert(touched.has(logOnly.toLowerCase()), "log-only address retained");
      assert(touched.has(v4PoolId.toLowerCase()), "V4 poolId retained from log");
      assert(touched.has(duplicateRoot.toLowerCase()), "trace root target retained");
      assert(touched.has(nestedCall.toLowerCase()), "nested call target retained");
      assert(touched.has(deepCall.toLowerCase()), "deep call target retained");
      assert(touched.size === 5, "log and trace duplicate is emitted once");
    },
  },
];

tests.push({
  name: "malformed or failed trace never authorizes clean carry",
  run: async () => {
    for (const traces of [
      null,
      [{}],
      [{ result: null }],
      [{ result: {} }],
      [{ result: { to: "0xinvalid" } }],
      [{ result: { to: POOL_A, calls: null } }],
      [{ result: { to: POOL_A, calls: [null] } }],
      [{ result: { to: POOL_A }, error: "trace failed" }],
    ]) {
      await rejects(readBlockTouchedStateKeys({
        getLogs: async () => [{ address: POOL_B, topics: [] }],
        send: async () => traces,
      }, SOURCE_BLOCK, POOL_B), /block trace|debug_traceBlockByNumber/);
    }
    await rejects(readBlockTouchedStateKeys({
      getLogs: async () => [],
      send: async () => { throw new Error("trace transport failure"); },
    }, SOURCE_BLOCK, POOL_B), /trace transport failure/);
  },
});
tests.push({
  name: "empty block and failed creation remain valid trace shapes",
  run: async () => {
    const empty = await readBlockTouchedStateKeys({
      getLogs: async () => [],
      send: async () => [],
    }, SOURCE_BLOCK, POOL_B);
    assert(empty.size === 0, "empty successful trace is complete");
    const creation = await readBlockTouchedStateKeys({
      getLogs: async () => [],
      send: async () => [{
        result: {
          type: "CREATE",
          error: "execution reverted",
          calls: [{ type: "CALL", to: POOL_A }],
        },
      }],
    }, SOURCE_BLOCK, POOL_B);
    assert(creation.has(POOL_A.toLowerCase()), "creation nested activity retained");
  },
});

let passed = 0;
for (const test of tests) {
  try {
    await test.run();
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
