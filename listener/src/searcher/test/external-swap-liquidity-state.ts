import assert from "node:assert/strict";
import { ethers } from "ethers";
import {
  BlockScanStateCoordinator,
  type BlockScanStateReadBackend,
} from "../blockscan-state-coordinator.js";
import type { TokenEdge } from "../planner/token-graph.js";
import { deriveEdgeTaxonomy } from "../strategy-taxonomy.js";
import {
  blockScanEdgeKey,
  createVerifiedGraphView,
  registerBlockScanStateFamily,
  type StateRead,
  type StateReadResult,
  type StateReadSuccess,
} from "../venues/blockscan-state-capability.js";
import { balancerV3BlockScanState } from "../venues/swaps/balancer-v3.js";
import {
  blockScanErc20Iface,
} from "../venues/swaps/blockscan-state-shared.js";
import {
  dodoV2BlockScanState,
  dodoV2PoolIface,
} from "../venues/swaps/dodo-v2.js";

const SOURCE_BLOCK = 25_585_380;
const SOURCE_HASH =
  "0x6cf953cd24df65a1d0505aa661b8361b69178dbc74eb73085e3531df284c8f22";
const BALANCER_POOL = "0x8523bcadcda4bd329435940dcc49a7c4c0a14d94";
const INACTIVE_BALANCER_POOL =
  "0x4444444444444444444444444444444444444444";
const DODO_POOL = "0xeef85bc18b8cd15452ec787ffc26b9b5a9e220c1";
const WBTC = "0x2260fac5e5542a773aa44fbcfedf7c193bc2c599";
const LINK = "0x514910771af9ca656af840dff83e8264ecf986ca";
const DODO_BASE = "0xa62cc35625b0c8dc1faea39d33625bb4c15bd71c";
const WETH = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
const taxonomy = deriveEdgeTaxonomy("swap");

const balancerIface = new ethers.Interface([
  "function getPoolTokenInfo(address pool) view returns (address[] tokens,tuple(uint8 tokenType,address rateProvider,bool paysYieldFees)[] tokenInfo,uint256[] balancesRaw,uint256[] lastBalancesLiveScaled18)",
  "function querySwapSingleTokenExactIn(address pool,address tokenIn,address tokenOut,uint256 exactAmountIn,address sender,bytes userData) returns (uint256 amountOut)",
]);
const erc20BalanceIface = new ethers.Interface([
  "function balanceOf(address account) view returns (uint256)",
]);

const balancerTokens = Object.freeze([
  WBTC,
  LINK,
  "0x775f661b0bd1739349b9a2a3ef60be277c5d2d29",
  "0x7fc66500c84a76ad7e9c93437bfc5ac33e2ddae9",
  "0xd31a59c85ae9d8edefec411d448f90841571b89c",
  "0xd4fa1460f537bb9085d22c7bccb5dd450ef28e3a",
]);
const balancerBalances = Object.freeze([
  665_993n,
  20_374_628_195_996_068_193n,
  74_251_598_519_279_844n,
  1_843_039_443_745_474_923n,
  2_241_901_442n,
  523_827_529n,
]);
const dodoPmm = Object.freeze({
  i: 35_553_152_933n,
  K: 50_000_000_000_000_000n,
  B: 21_365_085_618_110_287_912_010n,
  Q: 180_845_715_745_555n,
  B0: 0n,
  Q0: 825_531_746_531_016n,
  R: 2,
});

assert.throws(
  () => balancerAmountOut(WBTC, 10n ** 8n),
  /MaxInRatio/,
  "the old one-WBTC probe reproduces Balancer's source-block failure",
);
assert.throws(
  () => dodoAmountOut("querySellQuote", 10n ** 18n),
  /TARGET_IS_ZERO/,
  "the old one-WETH probe reproduces DODO's source-block failure",
);

async function representativePoolsResolve(): Promise<void> {
  const edges = Object.freeze([
    ...poolEdges("balancer-v3-unlock", BALANCER_POOL, WBTC, LINK),
    ...poolEdges("dodo-v2-swap", DODO_POOL, DODO_BASE, WETH),
  ]);
  const result = await new BlockScanStateCoordinator(
    new SourceBlockBackend(),
  ).prepare({
    graph: graph("representative", 1, edges),
    families: families(),
    deadlineAtMs: Date.now() + 2_000,
  });

  assert.equal(result.status, "complete", JSON.stringify(result.issues));
  assert.equal(result.snapshot.mids.size, 4);
  assert.equal(result.coverage.unresolvedEdgeKeys.length, 0);
  assert.equal(result.coverage.unavailableEdgeKeys.length, 0);
  const wbtcEdge = result.snapshot.graph.edges.find((edge) =>
    same(edge.target, BALANCER_POOL) && same(edge.tokenIn, WBTC)
  );
  const dodoQuoteEdge = result.snapshot.graph.edges.find((edge) =>
    same(edge.target, DODO_POOL) && same(edge.tokenIn, WETH)
  );
  assert(wbtcEdge && dodoQuoteEdge);
  assert.equal(
    result.snapshot.mids.get(blockScanEdgeKey(wbtcEdge))?.reserveA,
    6_659n * 10_000n,
    "mid depth must retain the actual Balancer probe, not one whole WBTC",
  );
  assert.equal(
    result.snapshot.mids.get(blockScanEdgeKey(dodoQuoteEdge))?.reserveA,
    1_808_457_157_455n * 10_000n,
    "mid depth must retain the actual DODO probe, not one whole WETH",
  );
  assert.deepEqual(
    result.snapshot.resolvedFamilyIds,
    ["balancer-v3", "custom-swap:dodo-v2"],
  );
}

async function behaviorProvenInactivePoolDoesNotPoisonFamily(): Promise<void> {
  const healthyBalancer = poolEdges(
    "balancer-v3-unlock",
    BALANCER_POOL,
    WBTC,
    LINK,
  );
  const inactiveBalancer = poolEdges(
    "balancer-v3-unlock",
    INACTIVE_BALANCER_POOL,
    WBTC,
    LINK,
  );
  const dodo = poolEdges("dodo-v2-swap", DODO_POOL, DODO_BASE, WETH);
  const edges = Object.freeze([
    ...healthyBalancer,
    ...inactiveBalancer,
    ...dodo,
  ]);
  const result = await new BlockScanStateCoordinator(
    new SourceBlockBackend(),
  ).prepare({
    graph: graph("inactive-isolation", 2, edges),
    families: families(),
    deadlineAtMs: Date.now() + 2_000,
  });

  assert.equal(
    result.status,
    "complete",
    `behavior-proven unavailability is complete coverage, not degradation: ${
      JSON.stringify(result.issues)
    }`,
  );
  assert.equal(result.snapshot.graph.edges.length, 6, "graph remains unchanged");
  assert.equal(result.coverage.expectedEdgeKeys.length, 6);
  assert.equal(result.coverage.resolvedEdgeKeys.length, 4);
  assert.equal(result.coverage.unavailableEdgeKeys.length, 2);
  assert.equal(result.coverage.unresolvedEdgeKeys.length, 0);
  assert.equal(result.snapshot.mids.size, 4);
  assert.deepEqual(result.snapshot.incompleteFamilyIds, []);
  assert.deepEqual(
    result.snapshot.resolvedFamilyIds,
    ["balancer-v3", "custom-swap:dodo-v2"],
  );

  const inactiveGraphEdges = result.snapshot.graph.edges.filter((edge) =>
    same(edge.target, INACTIVE_BALANCER_POOL)
  );
  const inactiveKeys = inactiveGraphEdges.map(blockScanEdgeKey).sort();
  assert.deepEqual([...result.coverage.unavailableEdgeKeys].sort(), inactiveKeys);
  for (const edgeKey of inactiveKeys) {
    const coverage = result.snapshot.coverageByEdgeKey.get(edgeKey);
    assert.equal(coverage?.status, "rejected");
    if (coverage?.status !== "rejected") {
      throw new Error(`missing unavailable reason for ${edgeKey}`);
    }
    assert.match(coverage.reason, /no behavior-safe input/);
    assert.equal(result.snapshot.mids.has(edgeKey), false);
  }
  for (const edge of result.snapshot.graph.edges.filter((edge) =>
    !same(edge.target, INACTIVE_BALANCER_POOL)
  )) {
    const edgeKey = blockScanEdgeKey(edge);
    assert.equal(result.snapshot.coverageByEdgeKey.get(edgeKey)?.status, "resolved");
    assert.equal(result.snapshot.mids.has(edgeKey), true);
  }
}

async function quoteFailureRemainsUnresolved(): Promise<void> {
  const balancer = poolEdges(
    "balancer-v3-unlock",
    BALANCER_POOL,
    WBTC,
    LINK,
  );
  const dodo = poolEdges("dodo-v2-swap", DODO_POOL, DODO_BASE, WETH);
  const result = await new BlockScanStateCoordinator(
    new SourceBlockBackend(true),
  ).prepare({
    graph: graph("quote-failure", 3, [...balancer, ...dodo]),
    families: families(),
    deadlineAtMs: Date.now() + 2_000,
  });

  assert.equal(result.status, "degraded");
  assert.deepEqual(result.snapshot.incompleteFamilyIds, ["balancer-v3"]);
  assert.deepEqual(
    result.snapshot.resolvedFamilyIds,
    ["custom-swap:dodo-v2"],
  );
  assert.equal(result.coverage.unavailableEdgeKeys.length, 0);
  assert.equal(result.coverage.unresolvedEdgeKeys.length, 2);
  assert.equal(result.snapshot.mids.size, 2);
  assert(
    result.issues.some((issue) =>
      issue.familyId === "balancer-v3" &&
      issue.message.includes("injected unknown quote failure")
    ),
    "a quote failure must remain explicit unresolved coverage",
  );
}

class SourceBlockBackend implements BlockScanStateReadBackend {
  constructor(private readonly failBalancerQuotes = false) {}

  async readBatch(
    _lane: "swap" | "protocol",
    reads: readonly StateRead[],
    control: {
      readonly sourceBlock: number;
      readonly sourceBlockHash: string;
      readonly sourceGeneration: number;
    },
  ): Promise<readonly StateReadResult[]> {
    assert.equal(control.sourceBlock, SOURCE_BLOCK);
    assert.equal(control.sourceBlockHash, SOURCE_HASH);
    return reads.map((read): StateReadResult => {
      try {
        if (
          this.failBalancerQuotes &&
          read.data.slice(0, 10) ===
            balancerIface.getFunction("querySwapSingleTokenExactIn")!.selector
        ) {
          throw new Error("injected unknown quote failure");
        }
        return success(read, control.sourceGeneration, respond(read));
      } catch (error) {
        return Object.freeze({
          id: read.id,
          ok: false as const,
          sourceBlock: read.sourceBlock,
          sourceBlockHash: read.sourceBlockHash,
          kind: "rpc" as const,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });
  }

  async verifyCanonicalSource(source: {
    readonly number: number;
    readonly hash: string;
  }): Promise<void> {
    assert.equal(source.number, SOURCE_BLOCK);
    assert.equal(source.hash, SOURCE_HASH);
  }
}

function respond(read: StateRead): string {
  const selector = read.data.slice(0, 10);
  if (selector === blockScanErc20Iface.getFunction("decimals")!.selector) {
    const decimals = same(read.to, WBTC) ? 8 : 18;
    return blockScanErc20Iface.encodeFunctionResult("decimals", [decimals]);
  }
  if (
    selector === balancerIface.getFunction("getPoolTokenInfo")!.selector
  ) {
    const pool = String(
      balancerIface.decodeFunctionData("getPoolTokenInfo", read.data)[0],
    );
    const balances = same(pool, INACTIVE_BALANCER_POOL)
      ? balancerBalances.map(() => 0n)
      : balancerBalances;
    return balancerIface.encodeFunctionResult("getPoolTokenInfo", [
      balancerTokens,
      balancerTokens.map(() => [0, ethers.ZeroAddress, false]),
      balances,
      balances,
    ]);
  }
  if (
    selector ===
      balancerIface.getFunction("querySwapSingleTokenExactIn")!.selector
  ) {
    const decoded = balancerIface.decodeFunctionData(
      "querySwapSingleTokenExactIn",
      read.data,
    );
    const pool = String(decoded[0]);
    const tokenIn = String(decoded[1]);
    const amountIn = BigInt(decoded[3]);
    assert.equal(same(pool, BALANCER_POOL), true);
    return balancerIface.encodeFunctionResult(
      "querySwapSingleTokenExactIn",
      [balancerAmountOut(tokenIn, amountIn)],
    );
  }
  if (selector === erc20BalanceIface.getFunction("balanceOf")!.selector) {
    const account = String(
      erc20BalanceIface.decodeFunctionData("balanceOf", read.data)[0],
    );
    assert.equal(same(account, DODO_POOL), true);
    const balance = same(read.to, DODO_BASE) ? dodoPmm.B : dodoPmm.Q;
    return erc20BalanceIface.encodeFunctionResult("balanceOf", [balance]);
  }
  for (const fn of ["_BASE_TOKEN_", "_QUOTE_TOKEN_"] as const) {
    if (selector === dodoV2PoolIface.getFunction(fn)!.selector) {
      return dodoV2PoolIface.encodeFunctionResult(fn, [
        fn === "_BASE_TOKEN_" ? DODO_BASE : WETH,
      ]);
    }
  }
  for (const fn of ["_BASE_RESERVE_", "_QUOTE_RESERVE_"] as const) {
    if (selector === dodoV2PoolIface.getFunction(fn)!.selector) {
      return dodoV2PoolIface.encodeFunctionResult(fn, [
        fn === "_BASE_RESERVE_" ? dodoPmm.B : dodoPmm.Q,
      ]);
    }
  }
  if (
    selector ===
      dodoV2PoolIface.getFunction("getPMMStateForCall")!.selector
  ) {
    return dodoV2PoolIface.encodeFunctionResult("getPMMStateForCall", [
      dodoPmm.i,
      dodoPmm.K,
      dodoPmm.B,
      dodoPmm.Q,
      dodoPmm.B0,
      dodoPmm.Q0,
      dodoPmm.R,
    ]);
  }
  for (const fn of ["querySellBase", "querySellQuote"] as const) {
    if (selector === dodoV2PoolIface.getFunction(fn)!.selector) {
      const amountIn = BigInt(
        dodoV2PoolIface.decodeFunctionData(fn, read.data)[1],
      );
      return dodoV2PoolIface.encodeFunctionResult(fn, [
        dodoAmountOut(fn, amountIn),
      ]);
    }
  }
  throw new Error(`unexpected source-block read ${read.id}`);
}

function balancerAmountOut(tokenIn: string, amountIn: bigint): bigint {
  const index = balancerTokens.findIndex((token) => same(token, tokenIn));
  if (index < 0) throw new Error("Balancer input token absent");
  const balance = balancerBalances[index];
  if (amountIn * 100n > balance * 30n) {
    throw new Error("MaxInRatio");
  }
  const expectedProbe = balance / 100n;
  assert.equal(
    amountIn,
    expectedProbe,
    "Balancer probe must use one percent of pinned raw liquidity",
  );
  // Archive eth_call result at SOURCE_BLOCK for the selected amount.
  return same(tokenIn, WBTC)
    ? 498_061_830_617_718_329n
    : 2_642n;
}

function dodoAmountOut(
  fn: "querySellBase" | "querySellQuote",
  amountIn: bigint,
): bigint {
  if (fn === "querySellQuote") {
    const beforeZeroTargetBranch = dodoPmm.Q0 - dodoPmm.Q;
    if (amountIn > beforeZeroTargetBranch) {
      throw new Error("TARGET_IS_ZERO");
    }
    assert.equal(
      amountIn,
      dodoPmm.Q / 100n,
      "DODO quote-side probe must use one percent of pinned reserve",
    );
  } else {
    assert.equal(
      amountIn,
      10n ** 18n,
      "DODO base-side probe must cap one percent of reserve at one token",
    );
  }
  // Archive eth_call result at SOURCE_BLOCK for the selected amount.
  return fn === "querySellQuote"
    ? 90_715_723_995_015_914_014n
    : 16_063_243_913n;
}

function graph(
  id: string,
  generation: number,
  edges: readonly TokenEdge[],
) {
  return createVerifiedGraphView({
    id,
    generation,
    sourceBlock: SOURCE_BLOCK,
    sourceBlockHash: SOURCE_HASH,
    completenessWatermark: SOURCE_BLOCK,
    perSourceCoverage: [
      {
        familyId: "balancer-v3",
        sourceId: "tx055-balancer-source",
        sourceFingerprint: "tx055-balancer-source-v1",
        completeThroughBlock: SOURCE_BLOCK,
        completeThroughHash: SOURCE_HASH,
      },
      {
        familyId: "custom-swap:dodo-v2",
        sourceId: "tx055-dodo-source",
        sourceFingerprint: "tx055-dodo-source-v1",
        completeThroughBlock: SOURCE_BLOCK,
        completeThroughHash: SOURCE_HASH,
      },
    ],
    edges,
    familyIdForEdge: (edge) =>
      edge.adapterId === "balancer-v3-unlock"
        ? "balancer-v3"
        : "custom-swap:dodo-v2",
  });
}

function families() {
  return Object.freeze([
    registerBlockScanStateFamily({
      familyId: "balancer-v3",
      lane: "swap",
      capability: balancerV3BlockScanState,
      ownsEdge: (edge) => edge.adapterId === "balancer-v3-unlock",
    }),
    registerBlockScanStateFamily({
      familyId: "custom-swap:dodo-v2",
      lane: "swap",
      capability: dodoV2BlockScanState,
      ownsEdge: (edge) => edge.adapterId === "dodo-v2-swap",
    }),
  ]);
}

function poolEdges(
  adapterId: string,
  pool: string,
  token0: string,
  token1: string,
): TokenEdge[] {
  return [
    {
      adapterId,
      target: pool,
      tokenIn: token0,
      tokenOut: token1,
      poolToken0: token0,
      poolToken1: token1,
      slotKind: "swap",
      ...taxonomy,
    },
    {
      adapterId,
      target: pool,
      tokenIn: token1,
      tokenOut: token0,
      poolToken0: token0,
      poolToken1: token1,
      slotKind: "swap",
      ...taxonomy,
    },
  ];
}

function success(
  read: StateRead,
  generation: number,
  data: string,
): StateReadSuccess {
  return Object.freeze({
    id: read.id,
    ok: true,
    sourceBlock: read.sourceBlock,
    sourceBlockHash: read.sourceBlockHash,
    provenance: Object.freeze({
      kind: "eip1898" as const,
      source: Object.freeze({
        number: read.sourceBlock,
        hash: read.sourceBlockHash,
        generation,
      }),
      requireCanonical: true as const,
    }),
    data,
  });
}

function same(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

await representativePoolsResolve();
await quoteFailureRemainsUnresolved();
await behaviorProvenInactivePoolDoesNotPoisonFamily();

console.log(
  "[external-swap-liquidity-state] source-sized probes + unavailable isolation: PASS",
);
