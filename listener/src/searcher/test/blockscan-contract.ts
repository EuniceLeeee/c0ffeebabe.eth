import { ethers } from "ethers";
import { deepEqual, rejects } from "node:assert/strict";
import { readBlockTouchedStateKeys,
  type BlockTouchedCanonicalAnchor, type BlockTouchedProvider } from "../blockscan-touched-state.js";
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
const anchoredTouchedKeys = [poolId, sender, callee, delegate, created, destroyed, beneficiary,
  miner, withdrawal, emitter, manager, transferFrom, transferTo];

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
tests.push({
  name: "anchored logs and complete ordered traces produce the shared touched union in two reads",
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
    deepEqual(touched, new Set(anchoredTouchedKeys),
      "singleton keys, trace participants, donation endpoints and passive addresses share one exact refresh set");
    assert(!touched.has(clean), "unobserved addresses are not introduced");
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
  name: "anchored touched output is detached from later anchor and response mutation",
  run: async () => {
    const anchor = activityAnchor(), logs = activityLogs(), traces = activityTraces();
    const read = readAnchored(logs, traces, anchor);
    anchor.hash = parentHash;
    anchor.parentHash = blockHash;
    anchor.transactionHashes[0] = parentHash;
    anchor.passiveTouchedAddresses.push(clean);
    const touched = await read;
    deepEqual(touched, new Set(anchoredTouchedKeys), "anchor hash, transaction order and passive addresses were captured before await");
    logs[0]!.address = clean;
    traces[0]!.result.from = clean;
    deepEqual(touched, new Set(anchoredTouchedKeys), "later response mutation cannot change returned keys");
    const uppercase = (value: string) => value.toUpperCase().replace("0X", "0x");
    const normalized = await readAnchored(activityLogs(), activityTraces(), {
      hash: uppercase(blockHash), parentHash: uppercase(parentHash),
      transactionHashes: txHashes.map(uppercase), passiveTouchedAddresses: [miner, withdrawal].map(uppercase),
    });
    deepEqual(normalized, touched, "canonical hash and address identity is case insensitive");
  },
});

tests.push({
  name: "legacy and optional passive inputs retain their shared touched semantics, including empty blocks",
  run: async () => {
    const legacy = await readBlockTouchedStateKeys({ getLogs: async () => activityLogs(), send: async () => activityTraces() },
      SOURCE_BLOCK, manager);
    deepEqual(legacy, new Set([poolId, emitter, transferFrom, transferTo, callee, delegate, created, beneficiary]),
      "legacy reads retain call targets and log keys without inventing anchored participants or passive addresses");
    const noPassive = await readAnchored(activityLogs(), activityTraces(), { ...activityAnchor(), passiveTouchedAddresses: undefined });
    deepEqual(noPassive, new Set(anchoredTouchedKeys.filter(key => key !== miner && key !== withdrawal)));
    const empty = await readAnchored([], [], { ...activityAnchor(), transactionHashes: [], passiveTouchedAddresses: [] });
    deepEqual(empty, new Set(), "an empty block with no passive addresses has no touched keys");
    const passiveOnly = await readAnchored([], [], { ...activityAnchor(), transactionHashes: [] });
    deepEqual(passiveOnly, new Set([miner, withdrawal]), "empty transactions do not erase header-only activity");
  },
});

const rangeStart = 25_948_083;
const rangeHash = (number: number) => `0x${number.toString(16).padStart(64, "0")}`;
const rangeMutationBlock = rangeStart + 7;
const rangeMutationAddress = addr(200);
function rangeAnchor(number: number): BlockTouchedCanonicalAnchor {
  return { hash: rangeHash(number), parentHash: rangeHash(number - 1),
    transactionHashes: [rangeHash(number + 1_000_000)], passiveTouchedAddresses: [miner] };
}
function rangeFixture(target = rangeStart + 119) {
  const reads: string[] = [];
  const provider: BlockTouchedProvider = {
    async getLogs(filter) {
      assert("blockHash" in filter, "range logs must be hash-pinned");
      const number = Number(BigInt(filter.blockHash));
      reads.push(`logs:${number}`);
      return number === rangeMutationBlock
        ? [{ address: rangeMutationAddress, blockHash: filter.blockHash, topics: [] },
          { address: manager, blockHash: filter.blockHash, topics: [rangeHash(123), poolId] }]
        : [];
    },
    async send(method, params) {
      const number = Number(BigInt(String(params[0])));
      reads.push(`trace:${number}`);
      deepEqual([method, params], ["debug_traceBlockByHash", [rangeHash(number),
        { tracer: "callTracer", tracerConfig: { onlyTopCall: false } }]]);
      return [{ txHash: rangeHash(number + 1_000_000), result: callFrame() }];
    },
  };
  const range = { previousSource: { number: rangeStart, hash: rangeHash(rangeStart) },
    async readHeader(number: number) { reads.push(`header:${number}`); return rangeAnchor(number); } };
  return { reads, provider, range, target, anchor: rangeAnchor(target),
    read() { return readBlockTouchedStateKeys(provider, target, manager, this.anchor, range); } };
}
tests.push({
  name: "joined activity preserves recognized throttle over concurrent cancellation or deadline, never revert text",
  run: async () => {
    const throttleErrors = [
      Object.assign(new Error("provider request failed"), { status: 429 }),
      Object.assign(new Error("provider request failed"), { statusCode: 429 }),
      { code: 429, message: "request rejected" },
      new Error("JSON-RPC HTTP 429"),
      new Error("account quota exhausted"),
      new Error("compute-unit depleted"),
      new Error("outer provider error", { cause: { code: 429, message: "throttled" } }),
    ];
    const reverts = [
      { code: 3, message: "execution reverted: HTTP 429", data: "0x" },
      { code: "CALL_EXCEPTION", message: "account quota exhausted" },
      { code: -32000, message: "HTTP 429", data: "0x1234" },
    ];
    for (const failed of ["logs", "trace"] as const) for (const expires of ["abort", "deadline"] as const) {
      for (const transportError of [...throttleErrors, ...reverts]) {
        const fixture = rangeFixture(rangeStart + 3);
        const control = new AbortController(), cancellation = new Error("concurrent activity cancellation");
        const originalNow = Date.now;
        let now = 100, started = 0, settled = false;
        let rejectLogs!: (error: unknown) => void, rejectTrace!: (error: unknown) => void;
        fixture.provider.getLogs = () => { started++; return new Promise((_, reject) => { rejectLogs = reject; }); };
        fixture.provider.send = () => { started++; return new Promise((_, reject) => { rejectTrace = reject; }); };
        Date.now = () => now;
        try {
          const pending = readBlockTouchedStateKeys(fixture.provider, fixture.target, manager, fixture.anchor,
            { ...fixture.range, signal: control.signal, deadlineAtMs: 150 });
          const observed = pending.then(() => { settled = true; }, error => { settled = true; return error; });
          await new Promise<void>(resolve => setImmediate(resolve));
          assert(started === 2, "both siblings were physically admitted before the control changed");
          if (expires === "abort") control.abort(cancellation);
          else now = 200;
          (failed === "logs" ? rejectLogs : rejectTrace)(transportError);
          await new Promise<void>(resolve => setImmediate(resolve));
          assert(!settled, "even a fatal response must join its already-dispatched sibling");
          (failed === "logs" ? rejectTrace : rejectLogs)(new Error("ordinary sibling failure"));
          const error = await observed;
          if (throttleErrors.some(error => error === transportError)) assert(error === transportError, "original recognized throttle outranks control and sibling error");
          else if (expires === "abort") assert(error === cancellation, "typed revert text does not gain throttle priority");
          else assert(error instanceof Error && /deadline/.test(error.message), "typed revert text does not override deadline");
          deepEqual(fixture.reads, [`header:${rangeStart + 1}`]);
        } finally { Date.now = originalNow; }
      }
    }
  },
});

tests.push({
  name: "119 canonical transitions retain earlier-only mutations in the shared touched union",
  run: async () => {
    const fixture = rangeFixture();
    const touched = await fixture.read();
    deepEqual(fixture.reads, Array.from({ length: 119 }, (_, index) => {
      const number = rangeStart + 1 + index;
      return [...(number === fixture.target ? [] : [`header:${number}`]), `logs:${number}`, `trace:${number}`];
    }).flat());
    assert(fixture.reads.length === 118 + 119 * 2, "119 transitions read only 118 missing headers plus existing logs/trace");
    deepEqual(touched, new Set([rangeMutationAddress, poolId, manager, sender, callee, miner]),
      "shared refresh retains earlier-only log mutations alongside all call and passive addresses");
    fixture.reads.length = 0;
    const suffix = await readBlockTouchedStateKeys(fixture.provider, fixture.target, manager, fixture.anchor,
      { ...fixture.range, previousSource: { number: rangeMutationBlock, hash: rangeHash(rangeMutationBlock) } });
    deepEqual(suffix, new Set([sender, callee, miner]), "a later published base excludes mutations before its requested range");
    deepEqual(fixture.reads, [], "a covered suffix uses the same completed observations");
  },
});

tests.push({
  name: "one-transition steady activity reuses the frozen target with zero header reads",
  run: async () => {
    const fixture = rangeFixture(rangeStart + 1);
    fixture.range.readHeader = async () => { throw new Error("duplicate target header read forbidden"); };
    const pending = fixture.read();
    (fixture.anchor as { hash: string }).hash = blockHash;
    const touched = await pending;
    deepEqual(fixture.reads, [`logs:${fixture.target}`, `trace:${fixture.target}`]);
    deepEqual(touched, new Set([sender, callee, miner]), "the frozen target validates the original reads despite later caller mutation");
  },
});

tests.push({
  name: "range rejects missing, skipped, duplicated, reorged and mismatched final headers without partial return",
  run: async () => {
    for (const malformed of [undefined, null,
      rangeAnchor(rangeStart + 1), rangeAnchor(rangeStart + 3),
      { ...rangeAnchor(rangeStart + 2), parentHash: blockHash },
      { ...rangeAnchor(rangeStart + 2), hash: rangeHash(rangeStart), parentHash: rangeHash(rangeStart + 1) },
    ]) {
      const fixture = rangeFixture(rangeStart + 3);
      fixture.range.readHeader = async number => {
        fixture.reads.push(`header:${number}`);
        return number === rangeStart + 2 ? malformed as BlockTouchedCanonicalAnchor : rangeAnchor(number);
      };
      await rejects(fixture.read(), /anchor|chain|duplicate/);
      assert(!fixture.reads.includes(`logs:${rangeStart + 2}`) && !fixture.reads.some(read => read.endsWith(`:${fixture.target}`)),
        "bad intermediate header admits neither its state reads nor another header");
    }
    for (const anchor of [
      { ...rangeAnchor(rangeStart + 3), hash: rangeHash(rangeStart) },
      { ...rangeAnchor(rangeStart + 3), parentHash: parentHash },
    ]) {
      const fixture = rangeFixture(rangeStart + 3);
      fixture.anchor = anchor;
      await rejects(fixture.read(), /chain|duplicate/);
      assert(!fixture.reads.some(read => read.endsWith(`:${fixture.target}`)), "frozen target chain mismatch rejects before target logs/trace");
    }
    for (const transactionHashes of [[], [blockHash]]) {
      const fixture = rangeFixture(rangeStart + 3);
      fixture.anchor = { ...fixture.anchor, transactionHashes };
      await rejects(fixture.read(), /anchored block trace/);
      assert(!fixture.reads.includes(`header:${fixture.target}`), "target trace coverage is validated against supplied anchor, not a second header");
    }
    const firstParent = rangeFixture();
    firstParent.range.previousSource.hash = blockHash;
    await rejects(firstParent.read(), /chain/);
    deepEqual(firstParent.reads, [`header:${rangeStart + 1}`]);
    for (const malformed of ["logs", "trace"] as const) {
      const fixture = rangeFixture(rangeStart + 3);
      const getLogs = fixture.provider.getLogs.bind(fixture.provider), send = fixture.provider.send.bind(fixture.provider);
      if (malformed === "logs") fixture.provider.getLogs = filter =>
        "blockHash" in filter && filter.blockHash === rangeHash(rangeStart + 2)
          ? Promise.resolve([{ address: emitter, topics: [], blockHash }]) : getLogs(filter);
      else fixture.provider.send = (method, params) => params[0] === rangeHash(rangeStart + 2)
        ? Promise.resolve([{ txHash: blockHash, result: callFrame() }]) : send(method, params);
      await rejects(fixture.read(), /anchored block/);
      assert(!fixture.reads.some(read => read.endsWith(`:${fixture.target}`)), "intermediate logs and traces use the existing anchored validators");
    }
  },
});

tests.push({
  name: "optional passive addresses contribute only supplied keys across every transition",
  run: async () => {
    for (const missingAt of [rangeStart + 1, rangeStart + 60, rangeStart + 119]) {
      const fixture = rangeFixture();
      const header = (number: number) => ({ ...rangeAnchor(number),
        passiveTouchedAddresses: number === missingAt ? undefined : [addr(number)] });
      fixture.range.readHeader = async number => { fixture.reads.push(`header:${number}`); return header(number); };
      fixture.anchor = header(fixture.target);
      const touched = await fixture.read();
      deepEqual(touched, new Set([rangeMutationAddress, poolId, manager, sender, callee,
        ...Array.from({ length: 119 }, (_, index) => rangeStart + 1 + index)
          .filter(number => number !== missingAt).map(addr)]),
      "missing optional addresses do not discard other transitions or invent passive activity");
      assert(fixture.reads.length === 118 + 119 * 2, "optional passive data never skips block reads");
    }
  },
});

tests.push({
  name: "range bounds, empty range, rollback and malformed inputs reject safely without history truncation",
  run: async () => {
    const empty = rangeFixture(rangeStart);
    const touched = await empty.read();
    assert(touched.size === 0 && empty.reads.length === 0, "same-height same-hash has no transitions or I/O");
    for (const target of [rangeStart - 1, rangeStart + 257, Number.MAX_SAFE_INTEGER, NaN, -1]) {
      const fixture = rangeFixture(target);
      await rejects(fixture.read(), /range|anchor/);
      assert(fixture.reads.length === 0, "invalid or over-bound range must not read a partial history");
    }
    const mismatch = rangeFixture(rangeStart);
    mismatch.range.previousSource.hash = parentHash;
    await rejects(mismatch.read(), /same.height|anchor|chain/);
    assert(mismatch.reads.length === 0, "same-height reorg cannot look like an empty range");
    const max = rangeFixture(rangeStart + 256);
    await max.read();
    assert(max.reads.length === 255 + 256 * 2, "exact bound reads all 256 transitions without rereading target header");
    const emptyBlocks = rangeFixture(rangeStart + 2);
    emptyBlocks.provider.getLogs = async filter => { emptyBlocks.reads.push(`logs:${"blockHash" in filter ? Number(BigInt(filter.blockHash)) : "unpinned"}`); return []; };
    emptyBlocks.provider.send = async (_method, params) => { emptyBlocks.reads.push(`trace:${Number(BigInt(String(params[0])))}`); return []; };
    emptyBlocks.range.readHeader = async number => {
      emptyBlocks.reads.push(`header:${number}`);
      return { ...rangeAnchor(number), transactionHashes: [], passiveTouchedAddresses: [] };
    };
    emptyBlocks.anchor = { ...emptyBlocks.anchor, transactionHashes: [], passiveTouchedAddresses: [] };
    const emptyActivity = await emptyBlocks.read();
    assert(emptyActivity.size === 0, "empty blocks contribute no keys");
    deepEqual(emptyBlocks.reads, [`header:${rangeStart + 1}`, `logs:${rangeStart + 1}`, `trace:${rangeStart + 1}`,
      `logs:${rangeStart + 2}`, `trace:${rangeStart + 2}`], "empty blocks are still read and validated, unlike an empty interval");
    for (const bad of [null, {}, { number: -1, hash: parentHash }, { number: 1.5, hash: parentHash },
      { number: rangeStart, hash: "bad" }]) {
      const fixture = rangeFixture();
      fixture.range.previousSource = bad as typeof fixture.range.previousSource;
      await rejects(fixture.read(), /range/);
      assert(fixture.reads.length === 0, "malformed predecessor fails before I/O");
    }
    const unanchored = rangeFixture();
    await rejects(readBlockTouchedStateKeys(unanchored.provider, unanchored.target, manager, undefined, unanchored.range), /anchor/);
    assert(unanchored.reads.length === 0, "range cannot use number-only target reads");
    for (const deadlineAtMs of [NaN, Infinity, -Infinity, "200"] as unknown[]) {
      const fixture = rangeFixture();
      await rejects(readBlockTouchedStateKeys(fixture.provider, fixture.target, manager, fixture.anchor,
        { ...fixture.range, deadlineAtMs: deadlineAtMs as number }), /range/);
      assert(fixture.reads.length === 0, "malformed deadline cannot remove the caller's bound");
    }
    const noHeaderReader = rangeFixture();
    await rejects(readBlockTouchedStateKeys(noHeaderReader.provider, noHeaderReader.target, manager, noHeaderReader.anchor,
      { ...noHeaderReader.range, readHeader: undefined as never }), /range/);
    assert(noHeaderReader.reads.length === 0, "no unanchored fallback when header reader is missing");
  },
});

tests.push({
  name: "range checks cancellation before each dispatch and joins outstanding header and sibling reads",
  run: async () => {
    const before = rangeFixture();
    const cancelled = new AbortController();
    cancelled.abort(new Error("cancel before range"));
    await rejects(readBlockTouchedStateKeys(before.provider, before.target, manager, before.anchor,
      { ...before.range, signal: cancelled.signal }), /cancel before range/);
    assert(before.reads.length === 0, "pre-cancelled range does zero I/O");
    for (const held of ["header", "logs", "trace"] as const) {
      const fixture = rangeFixture(rangeStart + 2);
      const control = new AbortController();
      let release!: () => void, started!: () => void, settled = false;
      const waiting = new Promise<void>(resolve => { release = resolve; });
      const entered = new Promise<void>(resolve => { started = resolve; });
      if (held === "header") {
        fixture.range.readHeader = async number => {
          fixture.reads.push(`header:${number}`); started(); await waiting; return rangeAnchor(number);
        };
      } else {
        const provider = fixture.provider;
        const getLogs = provider.getLogs.bind(provider), send = provider.send.bind(provider);
        if (held === "logs") provider.getLogs = async filter => { const result = await getLogs(filter); started(); await waiting; return result; };
        else provider.send = async (method, params) => { const result = await send(method, params); started(); await waiting; return result; };
      }
      const pending = readBlockTouchedStateKeys(fixture.provider, fixture.target, manager, fixture.anchor,
        { ...fixture.range, signal: control.signal });
      const observed = pending.then(() => { settled = true; }, error => { settled = true; return error; });
      await entered;
      control.abort(new Error(`cancel held ${held}`));
      await new Promise<void>(resolve => setImmediate(resolve));
      assert(!settled, "cancellation cannot detach already dispatched activity I/O");
      release();
      const error = await observed;
      assert(error instanceof Error && error.message === `cancel held ${held}`, "joined work still rejects on cancellation");
      assert(!fixture.reads.some(read => read.endsWith(`:${rangeStart + 2}`)), "no successor reads after cancellation");
      if (held === "header") assert(fixture.reads.length === 1, "header cancellation starts no logs or trace");
    }
    const between = rangeFixture(rangeStart + 1);
    const control = new AbortController();
    between.provider.getLogs = async () => { between.reads.push("cancel-in-logs"); control.abort(new Error("cancel before trace")); return []; };
    await rejects(readBlockTouchedStateKeys(between.provider, between.target, manager, between.anchor,
      { ...between.range, signal: control.signal }), /cancel before trace/);
    assert(!between.reads.some(read => read.startsWith("trace:")), "each sibling dispatch rechecks cancellation");
  },
});

tests.push({
  name: "range deadline gates each physical read and is rechecked after joined work",
  run: async () => {
    const originalNow = Date.now;
    let now = 100;
    Date.now = () => now;
    try {
      for (const expire of ["before", "header", "logs", "trace"] as const) {
        now = 100;
        const fixture = rangeFixture(rangeStart + 2);
        if (expire === "header") fixture.range.readHeader = async number => { fixture.reads.push(`header:${number}`); now = 200; return rangeAnchor(number); };
        const getLogs = fixture.provider.getLogs.bind(fixture.provider), send = fixture.provider.send.bind(fixture.provider);
        if (expire === "logs") fixture.provider.getLogs = filter => { now = 200; return getLogs(filter); };
        if (expire === "trace") fixture.provider.send = (method, params) => { now = 200; return send(method, params); };
        await rejects(readBlockTouchedStateKeys(fixture.provider, fixture.target, manager, fixture.anchor,
          { ...fixture.range, deadlineAtMs: expire === "before" ? 100 : 150 }), /deadline/);
        assert(!fixture.reads.some(read => read.endsWith(`:${rangeStart + 2}`)), "expiry never starts a successor transition");
        if (expire === "before") assert(fixture.reads.length === 0, "expired range does zero I/O");
        if (expire === "header") assert(fixture.reads.length === 1, "expiry after header starts no state reads");
        if (expire === "logs") assert(!fixture.reads.some(read => read.startsWith("trace:")), "trace dispatch has its own deadline check");
      }
    } finally { Date.now = originalNow; }
  },
});

tests.push({
  name: "range snapshots target and predecessor before await and never returns a failed partial range",
  run: async () => {
    const fixture = rangeFixture(rangeStart + 3);
    fixture.range.readHeader = async number => {
      fixture.reads.push(`header:${number}`);
      fixture.range.previousSource.hash = blockHash;
      fixture.range.previousSource.number = -1;
      (fixture.anchor as { hash: string }).hash = parentHash;
      return rangeAnchor(number);
    };
    const touched = await fixture.read();
    deepEqual(touched, new Set([sender, callee, miner]), "later caller mutation cannot re-anchor the range");
    deepEqual(fixture.reads, [
      `header:${rangeStart + 1}`, `logs:${rangeStart + 1}`, `trace:${rangeStart + 1}`,
      `header:${rangeStart + 2}`, `logs:${rangeStart + 2}`, `trace:${rangeStart + 2}`,
      `logs:${fixture.target}`, `trace:${fixture.target}`,
    ], "all reads stay bound to the captured predecessor and target");
    const once = rangeFixture(rangeStart + 1);
    let numberReads = 0, hashReads = 0;
    once.range.previousSource = {
      get number() { numberReads++; return numberReads === 1 ? rangeStart : NaN; },
      get hash() { hashReads++; return hashReads === 1 ? rangeHash(rangeStart) : "bad"; },
    };
    await once.read();
    assert(numberReads === 1 && hashReads === 1, "predecessor fields are captured once before validation and dispatch");
    for (const failed of ["logs", "trace"] as const) {
      const partial = rangeFixture(rangeStart + 3);
      let release!: () => void, entered!: () => void, settled = false;
      const waiting = new Promise<void>(resolve => { release = resolve; });
      const started = new Promise<void>(resolve => { entered = resolve; });
      const getLogs = partial.provider.getLogs.bind(partial.provider), send = partial.provider.send.bind(partial.provider);
      partial.provider.getLogs = async filter => {
        if ("blockHash" in filter && filter.blockHash === rangeHash(rangeStart + 2)) {
          if (failed === "logs") throw new Error("range logs failure");
          entered(); await waiting;
        }
        return getLogs(filter);
      };
      partial.provider.send = async (method, params) => {
        if (params[0] === rangeHash(rangeStart + 2)) {
          if (failed === "trace") throw new Error("range trace failure");
          entered(); await waiting;
        }
        return send(method, params);
      };
      const observed = partial.read().then(() => { settled = true; }, error => { settled = true; return error; });
      await started;
      await new Promise<void>(resolve => setImmediate(resolve));
      assert(!settled, "failed range waits for its already-dispatched sibling");
      release();
      const error = await observed;
      assert(error instanceof Error && error.message === `range ${failed} failure`, "original range transport failure preserved");
      assert(!partial.reads.some(read => read.endsWith(`:${partial.target}`)), "a failed range neither truncates nor retries");
    }
  },
});

tests.push({
  name: "completed range observations are provider-local immutable data reused with fresh Sets and no repeated historical I/O",
  run: async () => {
    const fixture = rangeFixture();
    const returnedHeaders: BlockTouchedCanonicalAnchor[] = [];
    const returnedLogs: Awaited<ReturnType<BlockTouchedProvider["getLogs"]>>[] = [];
    const readHeader = fixture.range.readHeader, getLogs = fixture.provider.getLogs.bind(fixture.provider);
    fixture.range.readHeader = async number => { const header = await readHeader(number); returnedHeaders.push(header); return header; };
    fixture.provider.getLogs = async filter => { const logs = await getLogs(filter); returnedLogs.push(logs); return logs; };
    const first = await fixture.read();
    assert(fixture.reads.length === 118 + 119 * 2, "first attempt collects the actual complete range once");
    for (const header of returnedHeaders) {
      (header as { hash: string }).hash = blockHash;
      (header.transactionHashes as string[]).fill(blockHash);
      (header.passiveTouchedAddresses as string[]).push(clean);
    }
    for (const logs of returnedLogs) for (const log of logs) (log as { address: string }).address = clean;
    (first as Set<string>).clear();
    (first as Set<string>).add(clean);
    fixture.reads.length = 0;
    const repeated = await fixture.read();
    assert(first !== repeated, "every public range gets a new Set");
    deepEqual(fixture.reads, []);
    assert(repeated.has(rangeMutationAddress) && repeated.has(poolId) && !repeated.has(clean), "cached raw observations are detached from all public mutation");
    deepEqual(repeated, new Set([rangeMutationAddress, poolId, manager, sender, callee, miner]),
      "memoized keys retain exactly the original touched union");
    const advanced = fixture.target + 1;
    const next = await readBlockTouchedStateKeys(fixture.provider, advanced, manager, rangeAnchor(advanced), fixture.range);
    deepEqual(fixture.reads, [`logs:${advanced}`, `trace:${advanced}`]);
    assert(next.has(rangeMutationAddress), "unchanged published base plus next head reuses all historical activity");
    const independent = rangeFixture(rangeStart + 1);
    await independent.read();
    deepEqual(independent.reads, [`logs:${independent.target}`, `trace:${independent.target}`]);
    const managerInput = rangeFixture(rangeMutationBlock);
    managerInput.range.previousSource = { number: rangeMutationBlock - 1, hash: rangeHash(rangeMutationBlock - 1) };
    const singleton = await managerInput.read();
    assert(singleton.has(poolId), "the original manager interpretation retains its singleton key");
    managerInput.reads.length = 0;
    await readBlockTouchedStateKeys(managerInput.provider, managerInput.target,
      manager.toUpperCase().replace("0X", "0x"), managerInput.anchor, managerInput.range);
    deepEqual(managerInput.reads, [], "equivalent address casing does not change cache context");
    const reinterpreted = await readBlockTouchedStateKeys(managerInput.provider, managerInput.target,
      addr(999), managerInput.anchor, managerInput.range);
    assert(!reinterpreted.has(poolId) && reinterpreted.has(manager), "changed parsing input cannot reuse the old raw singleton interpretation");
    deepEqual(managerInput.reads, [`logs:${managerInput.target}`, `trace:${managerInput.target}`]);
  },
});

tests.push({
  name: "retry retains only settled successful blocks after cancellation or either child failure",
  run: async () => {
    for (const completed of [12, 118]) for (const failure of ["abort", "logs", "trace"] as const) {
      const fixture = rangeFixture();
      const control = new AbortController(), injected = new Error(`interrupted ${failure}`);
      const interrupted = rangeStart + completed + 1;
      const getLogs = fixture.provider.getLogs.bind(fixture.provider), send = fixture.provider.send.bind(fixture.provider);
      let armed = true;
      fixture.provider.getLogs = async filter => {
        const logs = await getLogs(filter);
        if (armed && failure === "logs" && "blockHash" in filter && filter.blockHash === rangeHash(interrupted)) throw injected;
        return logs;
      };
      fixture.provider.send = async (method, params) => {
        const traces = await send(method, params);
        if (armed && params[0] === rangeHash(interrupted)) {
          if (failure === "trace") throw injected;
          if (failure === "abort") control.abort(injected);
        }
        return traces;
      };
      await rejects(readBlockTouchedStateKeys(fixture.provider, fixture.target, manager, fixture.anchor,
        { ...fixture.range, signal: control.signal }), error => error === injected);
      assert(!fixture.reads.some(read => read.endsWith(`:${interrupted + 1}`)), "interruption stops later activity immediately");
      armed = false;
      fixture.reads.length = 0;
      const resumed = await fixture.read();
      deepEqual(fixture.reads, Array.from({ length: 119 - completed }, (_, index) => {
        const number = interrupted + index;
        return [...(number === fixture.target ? [] : [`header:${number}`]), `logs:${number}`, `trace:${number}`];
      }).flat());
      deepEqual(resumed, new Set([rangeMutationAddress, poolId, manager, sender, callee, miner]),
        "completed retry returns the whole union, including earlier cached mutation, not just the newly read suffix");
    }
  },
});

tests.push({
  name: "cached target or ancestry mismatch invalidates observations and fails closed without relabeling or retry",
  run: async () => {
    for (const mismatch of ["target", "parent", "transactions", "passive", "predecessor", "advanced-parent"] as const) {
      const fixture = rangeFixture(rangeStart + 3);
      await fixture.read();
      fixture.reads.length = 0;
      let target = fixture.target;
      let anchor = fixture.anchor;
      let range = fixture.range;
      if (mismatch === "target") anchor = { ...anchor, hash: blockHash };
      if (mismatch === "parent") anchor = { ...anchor, parentHash: blockHash };
      if (mismatch === "transactions") anchor = { ...anchor, transactionHashes: [] };
      if (mismatch === "passive") anchor = { ...anchor, passiveTouchedAddresses: undefined };
      if (mismatch === "predecessor") range = { ...range, previousSource: { ...range.previousSource, hash: blockHash } };
      if (mismatch === "advanced-parent") { target++; anchor = { ...rangeAnchor(target), parentHash: blockHash }; }
      await rejects(readBlockTouchedStateKeys(fixture.provider, target, manager, anchor, range), /chain|cached.*anchor/);
      deepEqual(fixture.reads, [], "known contradictory evidence cannot cause replacement reads inside this invocation");
      await fixture.read();
      deepEqual(fixture.reads, [
        `header:${rangeStart + 1}`, `logs:${rangeStart + 1}`, `trace:${rangeStart + 1}`,
        `header:${rangeStart + 2}`, `logs:${rangeStart + 2}`, `trace:${rangeStart + 2}`,
        `logs:${rangeStart + 3}`, `trace:${rangeStart + 3}`,
      ], "a subsequent invocation must rebuild the invalidated observations rather than relabel hashes");
    }
  },
});

tests.push({
  name: "completed provider memo is bounded at 256 blocks and never shares in-flight reads",
  run: async () => {
    const fixture = rangeFixture();
    const readOne = (number: number) => readBlockTouchedStateKeys(fixture.provider, number, manager, rangeAnchor(number),
      { ...fixture.range, previousSource: { number: number - 1, hash: rangeHash(number - 1) } });
    for (let number = rangeStart + 1; number <= rangeStart + 257; number++) await readOne(number);
    fixture.reads.length = 0;
    await readOne(rangeStart + 2);
    deepEqual(fixture.reads, [], "the oldest of the retained 256 blocks is still reusable");
    await readOne(rangeStart + 1);
    deepEqual(fixture.reads, [`logs:${rangeStart + 1}`, `trace:${rangeStart + 1}`], "the 257th-oldest block has been evicted");
    const concurrent = rangeFixture(rangeStart + 1);
    const getLogs = concurrent.provider.getLogs.bind(concurrent.provider);
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    concurrent.provider.getLogs = async filter => { const logs = await getLogs(filter); await held; return logs; };
    const first = concurrent.read(), second = concurrent.read();
    await new Promise<void>(resolve => setImmediate(resolve));
    deepEqual(concurrent.reads, [
      `logs:${concurrent.target}`, `trace:${concurrent.target}`,
      `logs:${concurrent.target}`, `trace:${concurrent.target}`,
    ], "in-flight work is owned by each caller, never memoized as a promise");
    release();
    const [a, b] = await Promise.all([first, second]);
    assert(a !== b, "independent callers cannot mutate each other's result Set");
    concurrent.reads.length = 0;
    await concurrent.read();
    deepEqual(concurrent.reads, [], "completed observations become reusable only after both child reads settle");
    const retired = rangeFixture(rangeStart + 3);
    await retired.read();
    const pendingTarget = retired.target + 1;
    const originalLogs = retired.provider.getLogs.bind(retired.provider);
    let releaseOld!: () => void;
    const oldHeld = new Promise<void>(resolve => { releaseOld = resolve; });
    retired.provider.getLogs = async filter => {
      const logs = await originalLogs(filter);
      if ("blockHash" in filter && filter.blockHash === rangeHash(pendingTarget)) await oldHeld;
      return logs;
    };
    const oldPending = readBlockTouchedStateKeys(retired.provider, pendingTarget, manager, rangeAnchor(pendingTarget), retired.range);
    await new Promise<void>(resolve => setImmediate(resolve));
    await rejects(readBlockTouchedStateKeys(retired.provider, retired.target, manager,
      { ...retired.anchor, hash: blockHash }, retired.range), /cached.*anchor/);
    releaseOld();
    await oldPending;
    retired.reads.length = 0;
    await readBlockTouchedStateKeys(retired.provider, pendingTarget, manager, rangeAnchor(pendingTarget), retired.range);
    assert(retired.reads.length === 3 + 4 * 2 && retired.reads.includes(`logs:${pendingTarget}`),
      "late settlement cannot repopulate the retired provider memo after a source contradiction");
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
