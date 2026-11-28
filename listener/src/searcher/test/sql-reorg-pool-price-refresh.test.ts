import assert from "node:assert/strict";
import { test } from "node:test";
import { AbiCoder, Interface, ZeroAddress, keccak256, toBeHex } from "ethers";
import { prepareSqlSourceStartupInputs } from "../sql-startup-price-input.js";
import { buildSqlEdgeLiveProducer } from "../sql-edge-live-producer.js";
import { sqlDirectionId, type SqlPriceEdge } from "../sql-edge-price-index.js";
import {
  readBlockTouchedStateKeys,
  readRetainedBlockTouchedStateKeys,
  sqlPoolPriceActivityScope,
  type BlockTouchedCanonicalAnchor,
  type BlockTouchedProvider,
} from "../blockscan-touched-state.js";
import { collectReorgActivity } from "../blockscan-reorg-activity.js";
import {
  buildEffectiveMids,
  effectiveHistoricalRankingHint,
  exportEffectiveMidReplayState,
  type EffectiveMidSnapshot,
} from "../blockscan-effective-mid.js";
import { createBlockScanStartupExecutionPreflight } from "../blockscan-startup-execution-preflight.js";
import { BlockScanSimRejectCache } from "../blockscan-sim-reject-cache.js";
import type { StartupNodeInvocation, StartupNodeSimulation } from "../blockscan-startup-node-simulation.js";
import type { StrictProductionRuntimeSession } from "../strict-production-runtime-session.js";
import type { TokenEdge } from "../planner/token-graph.js";
import { PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG as catalog } from "../venues/production-family-composition.js";

const a = (n: number) => toBeHex(n, 20);
const h = (n: number) => toBeHex(n, 32);
const manager = "0x000000000004444c5dc75cb358380d2e3de08a90";
const positionManager = "0xbd216513d74c8cf14cf4747e6aaa6420ff64ee9e";
const stateView = "0x7ffe42c4a5deea5b0fec41c94c136cf115597227";
const keyTypes = ["address", "address", "uint24", "int24", "address"];
const abi = new Interface([
  "function poolKeys(bytes25) view returns(address,address,uint24,int24,address)",
  "function getSlot0(bytes32) view returns(uint160,int24,uint24,uint24)",
  "event Swap(bytes32 indexed id,address indexed sender,int128 amount0,int128 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick,uint24 fee)",
]);

type Log = { address: string; topics: readonly string[]; data: string };

test("two-branch reorg recovery scopes SQL pool price refresh to oldBranch union newBranch and preserves untouched prices without full-table rebuild", async () => {
  const startupSource = { number: 10, hash: h(10), generation: 1 };
  const weth = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
  const actor = a(2000);
  const origin = a(2001);
  const count = 120;
  const rows: SqlPriceEdge[] = [];
  const tupleByPrefix = new Map<string, readonly [string, string, number, number, string]>();
  const validIds = new Set<string>();

  for (let i = 0; i < count; i++) {
    const tokenOut = a(10000 + i);
    const [t0, t1] = weth.toLowerCase() < tokenOut.toLowerCase() ? [weth, tokenOut] : [tokenOut, weth];
    const tuple = [t0, t1, 3000, 60, ZeroAddress] as const;
    const poolId = keccak256(AbiCoder.defaultAbiCoder().encode(keyTypes, tuple));
    tupleByPrefix.set(poolId.slice(0, 52).toLowerCase(), tuple);
    validIds.add(poolId.toLowerCase());
    const row: SqlPriceEdge = {
      candidateInstanceKey: "",
      chainId: 1,
      selector: "0x48c89491",
      poolAddress: manager,
      poolNamespace: "contract-pool-id",
      poolId,
      tokenIn: weth,
      tokenOut,
      tokenInId: null,
      tokenOutId: null,
    };
    row.candidateInstanceKey = sqlDirectionId(row);
    rows.push(row);
  }

  const ready = await prepareSqlSourceStartupInputs({
    edges: rows,
    source: startupSource,
    executor: actor,
    transactionOrigin: origin,
    concurrency: 16,
    readCode: async () => "0x6000",
    read: async (to, data) => {
      const parsed = abi.parseTransaction({ data })!;
      if (to.toLowerCase() === positionManager && parsed.name === "poolKeys") {
        const found = tupleByPrefix.get(String(parsed.args[0]).toLowerCase());
        assert(found);
        return abi.encodeFunctionResult(parsed.fragment, [...found]);
      }
      if (to.toLowerCase() === stateView && parsed.name === "getSlot0") {
        assert(validIds.has(String(parsed.args[0]).toLowerCase()));
        return abi.encodeFunctionResult(parsed.fragment, [1n << 96n, 0, 0, 3000]);
      }
      throw new Error(`unexpected startup read to=${to} fn=${parsed.name}`);
    },
  });
  assert.deepEqual(ready.unavailable, []);
  assert.equal(ready.materialized.length, count);

  const fund = catalog.listAll().find((f) => f.plugin.manifest.domain === "funding")!.plugin.manifest;
  const { runtimeRoot: root, graph: rawGraph } = buildSqlEdgeLiveProducer({
    edges: rows,
    source: startupSource,
    currentHead: 10,
    swapTableSha256: "a".repeat(64),
    fundingTableSha256: "b".repeat(64),
    fundingAssets: [
      {
        familyId: fund.familyId,
        asset: weth,
        binding: { chainId: 1, provider: a(5001), asset: weth, selector: "0x12345678", signature: "offline()" },
      },
    ],
    materialized: ready.materialized,
    unavailable: [],
  });
  const graph = Object.freeze(
    rawGraph.map((e) =>
      Object.freeze({
        ...e,
        ...(e.routeBinding === undefined ? {} : { routeBinding: Object.freeze(e.routeBinding) }),
      }),
    ),
  );
  assert.equal(graph.length, count);

  // Chain topology:
  // ancestor = block 10 (hash 10)
  // oldTip = block 11 (hash 111, parent 10) -> touches rows[7]
  // replacement11 = block 11 (hash 211, parent 10) -> touches rows[42]
  // target12 = block 12 (hash 212, parent 211) -> touches rows[99]
  const ancestor = { number: 10, hash: h(10), parentHash: h(9), transactionHashes: [], passiveTouchedAddresses: [] };
  const oldTip = { number: 11, hash: h(111), parentHash: h(10), transactionHashes: [], passiveTouchedAddresses: [] };
  const replacement11 = { number: 11, hash: h(211), parentHash: h(10), transactionHashes: [], passiveTouchedAddresses: [] };
  const target12 = { number: 12, hash: h(212), parentHash: h(211), transactionHashes: [], passiveTouchedAddresses: [] };

  const swapLog = (poolId: string): Log => ({
    address: manager,
    ...abi.encodeEventLog("Swap", [poolId, actor, -5, 4, 1n << 96n, 5, 0, 3000]),
  });

  const logsByBlockHash = new Map<string, Log[]>([
    [oldTip.hash, [swapLog(rows[7]!.poolId!)]],
    [replacement11.hash, [swapLog(rows[42]!.poolId!)]],
    [target12.hash, [swapLog(rows[99]!.poolId!)]],
  ]);

  const orphanedUnavailable = new Set<string>();
  const provider: BlockTouchedProvider = {
    async getLogs(filter) {
      assert("blockHash" in filter);
      if (orphanedUnavailable.has(filter.blockHash)) throw new Error("orphan logs evicted from RPC");
      return (logsByBlockHash.get(filter.blockHash) ?? []).map((l) => ({ ...l, blockHash: filter.blockHash }));
    },
    async send() {
      throw new Error("logs mode does not call trace RPC");
    },
  };

  let simCount = 0;
  const sim = Object.assign(
    async (q: StartupNodeInvocation) => {
      simCount++;
      let amt = q.amount;
      const receipts = [{ hop: -1, amountIn: amt, amountSpent: amt, amountOut: amt }];
      q.legs.forEach((_leg, idx) => {
        const nextAmt = amt * BigInt(100 + q.source.number);
        receipts.push({ hop: idx, amountIn: amt, amountSpent: amt, amountOut: nextAmt });
        amt = nextAmt;
      });
      return {
        kind: "success" as const,
        receipts,
        returnData: "0x",
        gasUsed: 1n,
        targetBlock: q.source.number + 1,
        scriptHash: h(q.source.number * 1000 + simCount),
        inputFundingMode: "native-prefix" as const,
        simulationMs: 1,
        nodeQueueMs: 0,
      };
    },
    { stats: () => ({ requests: simCount, retries: 0, simulations: simCount, headers: 1, maxCuIn1000Ms: 1 }) },
  ) as StartupNodeSimulation;

  const preflight = createBlockScanStartupExecutionPreflight({
    executor: actor,
    transactionOrigin: origin,
    simRejects: new BlockScanSimRejectCache(),
    concurrency: 16,
    simulateStandalone: sim,
  });

  const sessionFor = () =>
    ({
      executionVariantIds: (e: TokenEdge) => [...ready.markets.get(e.canonicalEdgeId!)!.variants.keys()],
      confirmExecutionVariant() {},
      buildRuntimeAmountLeg: ({ edge: e }: { edge: TokenEdge }) => ({
        program: "0x" + Buffer.from(e.canonicalEdgeId!).toString("hex").slice(0, 16),
      }),
    }) as unknown as StrictProductionRuntimeSession;

  const pricingIndex = root.pricingIndex();
  const makePricingSnap = (src: { number: number; hash: string; generation: number }) =>
    ({
      generation: src.generation,
      sourceBlock: src.number,
      sourceBlockHash: src.hash,
      graph: { generation: src.generation, sourceBlock: src.number, sourceBlockHash: src.hash, edges: graph },
      mids: new Map(),
      coverage: { resolvedEdgeKeys: [] },
      pricingStateKeyByEdgeKey: pricingIndex.stateKeyByEdgeKey,
      pricingFamilyIdByEdgeKey: pricingIndex.familyIdByEdgeKey,
      perBlockRefreshStateKeys: [...pricingIndex.perBlockRefreshStateKeys],
    }) as any;

  let quoteCalls = 0;
  const runBuild = async (
    src: { number: number; hash: string; generation: number },
    previous?: EffectiveMidSnapshot,
    touchedStateKeys?: ReadonlySet<string>,
    plan?: ReturnType<typeof root.sqlPoolPriceRefreshPlan>,
    reorgCommonAncestorNumber?: number,
  ) => {
    quoteCalls = 0;
    return buildEffectiveMids({
      pricing: makePricingSnap(src),
      weth,
      maxInputPathHops: 4,
      fixedWethInput: 2_000_000_000_000_000n,
      cascadeAmountChanges: false,
      previous,
      touchedStateKeys,
      ...(plan ? { poolPriceRefreshPlan: plan } : {}),
      ...(reorgCommonAncestorNumber === undefined ? {} : { reorgCommonAncestorNumber }),
      gasCostWei: 1_000n,
      enumerationSpreadBps: 10,
      concurrency: 16,
      control: {},
      quote: async (req) => {
        quoteCalls++;
        const r = await preflight.quoteEffective({ ...req, edges: graph, prepareQuote: async () => {}, sessionFor });
        assert(r);
        return r;
      },
    });
  };

  const snap10 = await runBuild(startupSource);
  assert.equal(quoteCalls, count, "cold start quotes all 120 edges");

  // Step 1: Normal pass at oldTip (11@111) touches only rows[7]
  const touched11Old = await readBlockTouchedStateKeys(
    provider,
    11,
    manager,
    oldTip,
    { previousSource: ancestor, readHeader: async () => ancestor },
    root.resolveBlockTouchedStateKeys,
    { mode: "logs" },
  );
  const plan11Old = root.sqlPoolPriceRefreshPlan(touched11Old, startupSource, { number: 11, hash: oldTip.hash });
  assert(plan11Old);
  const snap11Old = await runBuild(
    { number: 11, hash: oldTip.hash, generation: 2 },
    snap10,
    new Set([...touched11Old, ...pricingIndex.perBlockRefreshStateKeys]),
    plan11Old,
  );
  assert.equal(quoteCalls, 1, "normal block 11 refreshes only the 1 touched pool");

  // Step 2: Simulate RPC evicting orphan block 11@111 and canonical reorg to 11@211 -> 12@212
  orphanedUnavailable.add(oldTip.hash);
  await assert.rejects(
    readBlockTouchedStateKeys(
      provider,
      12,
      manager,
      target12,
      { previousSource: oldTip, readHeader: async () => replacement11 },
      root.resolveBlockTouchedStateKeys,
      { mode: "logs" },
    ),
    /canonical hash chain/,
  );

  const canonicalByNum = new Map([
    [10, ancestor],
    [11, replacement11],
    [12, target12],
  ]);
  const byHash = new Map([
    [ancestor.hash, ancestor],
    [oldTip.hash, oldTip],
    [replacement11.hash, replacement11],
    [target12.hash, target12],
  ]);

  const proof = await collectReorgActivity({
    previousSource: { number: oldTip.number, hash: oldTip.hash },
    target: target12,
    deadlineAtMs: Date.now() + 10_000,
    readCanonicalHeader: async (n) => canonicalByNum.get(n),
    readHeaderByHash: async (hash) => byHash.get(hash),
    readTouched: (n, anchor: BlockTouchedCanonicalAnchor, control) =>
      readRetainedBlockTouchedStateKeys(
        provider,
        n,
        manager,
        anchor,
        root.resolveBlockTouchedStateKeys,
        control,
        { mode: "logs" },
      ),
  });

  assert.equal(proof.oldDepth, 1);
  assert.equal(proof.commonAncestor.number, 10);

  // Step 3: Verify sqlPoolPriceRefreshPlan refreshes ONLY the 3 pools from oldBranch U newBranch (not all 120!)
  const reorgPlan = root.sqlPoolPriceRefreshPlan(
    proof.touchedStateKeys,
    { number: oldTip.number, hash: oldTip.hash },
    { number: target12.number, hash: target12.hash },
  );
  assert(reorgPlan, "expected verified SQL pool-price refresh plan across two-branch reorg");

  const refreshed = graph.filter((e) => reorgPlan.shouldRefresh(e)).map((e) => e.canonicalEdgeId!).sort();
  const expected = [rows[7]!.candidateInstanceKey, rows[42]!.candidateInstanceKey, rows[99]!.candidateInstanceKey].sort();
  assert.deepEqual(refreshed, expected);

  // Step 4: Run buildEffectiveMids across the reorg and verify ONLY 3 quotes run while all 117 untouched prices survive!
  const snap12 = await runBuild(
    { number: 12, hash: target12.hash, generation: 3 },
    snap11Old,
    new Set([...proof.touchedStateKeys, ...pricingIndex.perBlockRefreshStateKeys]),
    reorgPlan,
    proof.commonAncestor.number,
  );
  assert.equal(quoteCalls, 3, "reorg pass quotes ONLY the 3 pools touched in oldBranch U newBranch (zero full-table rebuild)");

  let quotedCount = 0;
  let rankedCount = 0;
  for (const edge of graph) {
    const row = snap12.rows.get(edge.canonicalEdgeId!);
    const hint = effectiveHistoricalRankingHint(snap12, edge);
    if (row?.status === "quoted") quotedCount++;
    if (hint) rankedCount++;
  }
  assert.equal(quotedCount, 3, "3 dirty pools freshly quoted at canonical target 12");
  assert.equal(rankedCount, count - 3, "all 117 untouched pools retain active historical ranking prices");

  // Verify no orphaned block-11 origin leaked into exported poolOrigins
  const exported = exportEffectiveMidReplayState(snap12);
  for (const [, originRow] of exported.poolOrigins ?? []) {
    assert(
      originRow.quotedAt!.number <= proof.commonAncestor.number || originRow.quotedAt!.hash === target12.hash,
      "orphaned branch quote must not remain in poolOrigins",
    );
  }

  // Step 5: Verify copied key sets or mismatched base/target anchors fail closed
  assert.equal(
    sqlPoolPriceActivityScope(
      new Set(proof.touchedStateKeys),
      root.resolveBlockTouchedStateKeys,
      { number: oldTip.number, hash: oldTip.hash },
      { number: target12.number, hash: target12.hash },
    ),
    undefined,
  );
  assert.equal(
    root.sqlPoolPriceRefreshPlan(
      proof.touchedStateKeys,
      { number: oldTip.number, hash: h(999) },
      { number: target12.number, hash: target12.hash },
    ),
    undefined,
  );
});
