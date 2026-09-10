import { ethers } from "ethers";
import { deepEqual, rejects } from "node:assert/strict";
import { amountQuoteActivityForTouched, readBlockTouchedStateKeys,
  type BlockTouchedCanonicalAnchor, type BlockTouchedProvider } from "../blockscan-touched-state.js";
import { carryAmountQuote } from "../amount-quote-continuity.js";
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
          assert("fromBlock" in filter, "legacy log range filter");
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
  name: "ERC20 balance transfers touch participants without a pool call or Sync",
  run: async () => {
    const token = "0x00000000000000000000000000000000000000C3";
    const transfer = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
    const topic = (address: string) => `0x${address.slice(2).padStart(64, "0")}`;
    for (const [from, to] of [[POOL_A, POOL_B], [POOL_B, POOL_A]]) {
      let reads = 0;
      const touched = await readBlockTouchedStateKeys({
        getLogs: async () => {
          reads++;
          return [{ address: token, topics: [transfer, topic(from!), topic(to!)] }];
        },
        send: async () => {
          reads++;
          return [{ result: { type: "CALL", to: token } }];
        },
      }, SOURCE_BLOCK, "0x00000000000000000000000000000000000000D4");
      assert(touched.has(POOL_A.toLowerCase()), "transfer participant A touched");
      assert(touched.has(POOL_B.toLowerCase()), "transfer participant B touched");
      assert(reads === 2, "no additional RPC beyond existing logs and trace");
    }
    for (const topics of [
      [transfer, topic(POOL_A), topic(POOL_B), topic(POOL_A)], // ERC721
      [transfer, "0x01", "0x02"],
      [transfer, `0x01${"00".repeat(11)}${POOL_A.slice(2)}`, "0x02"],
      ["0xunknown", topic(POOL_A), topic(POOL_B)],
    ]) {
      const touched = await readBlockTouchedStateKeys({
        getLogs: async () => [{ address: token, topics }],
        send: async () => [],
      }, SOURCE_BLOCK, "0x00000000000000000000000000000000000000D4");
      assert(!touched.has(POOL_A.toLowerCase()) && !touched.has(POOL_B.toLowerCase()),
        "non-ERC20 or malformed participant topics are not pool addresses");
    }
  },
});

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

tests.push({
  name: "activity failure joins both reads before rejecting the pass",
  run: async () => {
    for (const anchor of [undefined, activityAnchor()]) for (const failed of ["logs", "trace"] as const) {
      let release!: () => void;
      const held = new Promise<void>((resolve) => { release = resolve; });
      let finished = false;
      let reads = 0;
      const activity = readBlockTouchedStateKeys({
        getLogs: () => {
          reads++;
          if (failed === "logs") throw new Error("injected logs failure");
          return held.then(() => []);
        },
        send: () => {
          reads++;
          if (failed === "trace") throw new Error("injected trace failure");
          return held.then(() => []);
        },
      }, SOURCE_BLOCK, POOL_B, anchor);
      const observed = activity.then(
        () => { finished = true; },
        (error: unknown) => { finished = true; return error; },
      );
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert(reads === 2, "both reads start despite synchronous sibling failure");
      assert(!finished, "failed activity must wait for outstanding sibling");
      release();
      const error = await observed;
      assert(error instanceof Error && error.message === `injected ${failed} failure`,
        "original failure is preserved after sibling settlement");
    }
  },
});

const blockHash = `0x${"a1".repeat(32)}`, parentHash = `0x${"b2".repeat(32)}`;
const txHashes = [`0x${"c3".repeat(32)}`, `0x${"d4".repeat(32)}`];
const addr = (value: number) => `0x${value.toString(16).padStart(40, "0")}`;
const sender = addr(1), callee = addr(2), delegate = addr(3), created = addr(4);
const destroyed = addr(5), beneficiary = addr(6), miner = addr(7), withdrawal = addr(8);
const emitter = addr(9), manager = addr(10), transferFrom = addr(11), transferTo = addr(12), clean = addr(99);
const poolId = `0x${"e5".repeat(32)}`;
const currentSource = { number: SOURCE_BLOCK, hash: blockHash, generation: 20 };
const originalSource = { number: SOURCE_BLOCK - 1, hash: parentHash, generation: 19 };

function activityAnchor() {
  return { hash: blockHash, parentHash, transactionHashes: [...txHashes], passiveTouchedAddresses: [miner, withdrawal] };
}
function callFrame(extra: Record<string, unknown> = {}) {
  return { type: "CALL", from: sender, to: callee, gas: "0x10000", gasUsed: "0x100", input: "0x", ...extra };
}
function activityTraces() {
  return [
    { txHash: txHashes[0], result: callFrame({ calls: [
      callFrame({ type: "DELEGATECALL", from: callee, to: delegate }),
      callFrame({ type: "CREATE", from: callee, to: created }),
      callFrame({ type: "SELFDESTRUCT", from: destroyed, to: beneficiary }),
    ] }) },
    { txHash: txHashes[1], result: callFrame({ type: "CREATE2", to: undefined, error: "execution reverted",
      calls: [callFrame({ type: "STATICCALL", from: callee, to: delegate })] }) },
  ];
}
function activityLogs() {
  const topic = (address: string) => `0x${address.slice(2).padStart(64, "0")}`;
  return [
    { blockHash, address: manager, topics: [`0x${"11".repeat(32)}`, poolId] },
    { blockHash, address: emitter, topics: [
      "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef", topic(transferFrom), topic(transferTo),
    ] },
  ];
}
function readAnchored(logs: unknown = activityLogs(), traces: unknown = activityTraces(),
  anchor: BlockTouchedCanonicalAnchor = activityAnchor()) {
  return readBlockTouchedStateKeys({
    getLogs: async () => logs as Awaited<ReturnType<BlockTouchedProvider["getLogs"]>>,
    send: async () => traces,
  }, SOURCE_BLOCK, manager, anchor);
}
function carriedAt(touched: ReadonlySet<string>, dependency: string) {
  const policy = { kind: "state-only" as const, dependencies: [dependency], blockEnvironment: "independent" as const };
  return carryAmountQuote({
    previous: { complete: true, chainAmountQuote: true, validAt: originalSource, quotedAt: originalSource,
      amountIn: 13n, amountOut: 17n, contextFingerprint: "test-context", reusePolicy: policy },
    current: currentSource, amountIn: 13n, contextFingerprint: "test-context", policy,
    activity: amountQuoteActivityForTouched(touched, currentSource),
  });
}

tests.push({
  name: "anchored logs and complete ordered traces produce address-only carry proof in two reads",
  run: async () => {
    let reads = 0;
    const touched = await readBlockTouchedStateKeys({
      getLogs: async filter => { reads++; deepEqual(filter, { blockHash }); return activityLogs(); },
      send: async (method, params) => {
        reads++;
        deepEqual([method, params], ["debug_traceBlockByHash", [blockHash, { tracer: "callTracer", tracerConfig: { onlyTopCall: false } }]]);
        return activityTraces();
      },
    }, SOURCE_BLOCK, manager, activityAnchor());
    assert(reads === 2, "hash anchoring adds no RPC");
    assert(touched.has(poolId), "legacy singleton state key is retained");
    assert(amountQuoteActivityForTouched(touched, currentSource) !== null, "complete anchored proof exists");
    for (const dependency of [sender, callee, delegate, created, destroyed, beneficiary,
      miner, withdrawal, emitter, manager, transferFrom, transferTo]) {
      assert(touched.has(dependency), "all trace, log and passive addresses enter the refresh set");
      assert(carriedAt(touched, dependency) === null, "every touched address prevents amount-quote carry");
    }
    const carried = carriedAt(touched, clean);
    assert(carried !== null, "poolIds must not contaminate the address-only proof");
    deepEqual(carried.quotedAt, originalSource);
    deepEqual(carried.validAt, currentSource);
    assert(carried.amountIn === 13n && carried.amountOut === 17n, "exact amounts preserved");
  },
});

tests.push({
  name: "anchored activity rejects mismatched, missing, duplicate and incomplete transaction traces",
  run: async () => {
    const traces = activityTraces();
    for (const malformed of [null, [], [traces[0]], [...traces, traces[1]], [traces[1], traces[0]],
      [traces[0], traces[0]], [{ result: callFrame() }, traces[1]],
      [{ ...traces[0], txHash: parentHash }, traces[1]],
      [{ ...traces[0], error: "tracer failure" }, traces[1]],
      [{ ...traces[0], truncated: true }, traces[1]],
      [{ ...traces[0], incomplete: true }, traces[1]],
    ]) await rejects(readAnchored(activityLogs(), malformed), /anchored block|block trace|debug_traceBlockByHash/);
    const cycle = callFrame() as Record<string, unknown>;
    cycle.calls = [cycle];
    for (const malformed of [null, {}, { type: "CALL", from: sender, to: callee },
      callFrame({ type: "UNKNOWN" }), callFrame({ from: undefined }), callFrame({ from: "bad" }),
      callFrame({ to: undefined }), callFrame({ to: "bad" }),
      callFrame({ gas: undefined }), callFrame({ gasUsed: undefined }), callFrame({ input: undefined }),
      callFrame({ input: "0x1" }), callFrame({ output: "bad" }), callFrame({ error: true }),
      callFrame({ calls: null }), callFrame({ calls: [null] }), callFrame({ calls: Array(1) }),
      callFrame({ truncated: true }), callFrame({ incomplete: true }),
      callFrame({ type: "CREATE", to: undefined }), callFrame({ type: "SELFDESTRUCT", to: undefined }), cycle,
    ]) await rejects(readAnchored(activityLogs(), [{ txHash: txHashes[0], result: malformed }, traces[1]]), /anchored block trace/);
  },
});

tests.push({
  name: "anchored logs and input anchors fail closed on malformed or mismatched evidence",
  run: async () => {
    const log = activityLogs()[0]!;
    for (const malformed of [null, [null], [{ ...log, blockHash: undefined }], [{ ...log, blockHash: parentHash }],
      [{ ...log, address: "bad" }], [{ ...log, topics: undefined }], [{ ...log, topics: ["bad"] }],
      [{ ...log, topics: Array(1) }], [{ ...log, removed: true }],
    ]) await rejects(readAnchored(malformed), /anchored block/);
    for (const malformed of [null, {}, { ...activityAnchor(), hash: "bad" }, { ...activityAnchor(), parentHash: "bad" },
      { ...activityAnchor(), transactionHashes: undefined }, { ...activityAnchor(), transactionHashes: ["bad"] },
      { ...activityAnchor(), transactionHashes: Array(1) },
      { ...activityAnchor(), transactionHashes: [txHashes[0], txHashes[0]!.toUpperCase().replace("0X", "0x")] },
      { ...activityAnchor(), passiveTouchedAddresses: null }, { ...activityAnchor(), passiveTouchedAddresses: ["bad"] },
      { ...activityAnchor(), passiveTouchedAddresses: Array(1) },
    ]) {
      let reads = 0;
      await rejects(readBlockTouchedStateKeys({ getLogs: async () => { reads++; return []; },
        send: async () => { reads++; return []; } }, SOURCE_BLOCK, manager, malformed as BlockTouchedCanonicalAnchor),
      /anchor|passive block/);
      assert(reads === 0, "invalid anchors are rejected before reads start");
    }
  },
});

tests.push({
  name: "activity proof is hash-bound, detached from input and returned Set mutation, and not copyable",
  run: async () => {
    const anchor = activityAnchor(), logs = activityLogs(), traces = activityTraces();
    const read = readAnchored(logs, traces, anchor);
    anchor.hash = parentHash;
    anchor.parentHash = blockHash;
    anchor.transactionHashes[0] = parentHash;
    anchor.passiveTouchedAddresses.push(clean);
    const touched = await read;
    const copy = new Set(touched);
    assert(amountQuoteActivityForTouched(copy, currentSource) === null, "copied keys do not copy authority");
    assert(amountQuoteActivityForTouched(Object.freeze(copy), currentSource) === null, "freezing a copy does not mint proof");
    logs[0]!.address = clean;
    traces[0]!.result.from = clean;
    (touched as Set<string>).clear();
    (touched as Set<string>).add(clean);
    assert(carriedAt(touched, manager) === null && carriedAt(touched, sender) === null && carriedAt(touched, miner) === null,
      "original dirty addresses survive mutation of every public input");
    assert(carriedAt(touched, clean) !== null, "later public mutations cannot change the anchored snapshot");
    const source = { ...currentSource };
    for (const change of [{ hash: parentHash }, { number: SOURCE_BLOCK + 1 }, { generation: -1 }]) {
      Object.assign(source, currentSource, change);
      assert(amountQuoteActivityForTouched(touched, source) === null, "source values are checked on every preparation");
    }
    assert(amountQuoteActivityForTouched(touched, { ...currentSource, hash: blockHash.toUpperCase().replace("0X", "0x") }) !== null,
      "physical hash identity is case insensitive");
  },
});

tests.push({
  name: "legacy or missing passive evidence cannot mint proof; complete empty anchored block can",
  run: async () => {
    const legacy = await readBlockTouchedStateKeys({ getLogs: async () => activityLogs(), send: async () => activityTraces() },
      SOURCE_BLOCK, manager);
    assert(amountQuoteActivityForTouched(legacy, currentSource) === null, "never invent proof from unanchored reads");
    const noPassive = await readAnchored(activityLogs(), activityTraces(), { ...activityAnchor(), passiveTouchedAddresses: undefined });
    assert(amountQuoteActivityForTouched(noPassive, currentSource) === null, "missing passive activity is not empty proof");
    const empty = await readAnchored([], [], { ...activityAnchor(), transactionHashes: [], passiveTouchedAddresses: [] });
    assert(carriedAt(empty, clean) !== null, "explicit empty complete activity permits clean carry");
    const passiveOnly = await readAnchored([], [], { ...activityAnchor(), transactionHashes: [] });
    assert(carriedAt(passiveOnly, miner) === null && carriedAt(passiveOnly, withdrawal) === null,
      "empty transaction list does not erase header-only state activity");
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
