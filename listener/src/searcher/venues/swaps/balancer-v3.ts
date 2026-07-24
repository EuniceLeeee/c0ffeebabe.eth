import { ethers } from "ethers";
import { ADDR } from "../../../shared/constants/addresses.js";
import { deriveEdgeTaxonomy } from "../../strategy-taxonomy.js";
import type { PoolEntry, TokenEdge, TokenQueryBackend } from "../../planner/token-graph.js";
import type { PoolUniverseEntry } from "../../pool-universe.js";
import type { ExactQuoteContext, PlanBuildContext, PlanFragment, SwapAdapter } from "../route-leg-adapter.js";
import { balancerV3IdentityResolver } from "../identity.js";
import { createBalancerV3SwapObservation } from "../swap-observation.js";
import {
  BALANCER_V3_SWAP_TOPIC,
  defineSwapLandedEvents,
  singletonIndexedAddressEmitter,
} from "../landed-event-registry.js";
import {
  currentBlockRead,
  requireRead,
} from "./blockscan-state-shared.js";
import {
  behaviorProvenUnavailableViewQuote,
  createCurrentBlockViewQuoteCapability,
  quoteReadId,
} from "./view-quote-blockscan-state.js";
import type {
  LandedPoolDiscoveryLog,
  LandedPoolMaterializationCapability,
} from "../landed-pool-discovery.js";

const vaultIface = new ethers.Interface([
  "function getPoolTokens(address pool) view returns (address[] tokens)",
  "function getPoolTokenInfo(address pool) view returns (address[] tokens,tuple(uint8 tokenType,address rateProvider,bool paysYieldFees)[] tokenInfo,uint256[] balancesRaw,uint256[] lastBalancesLiveScaled18)",
]);
const routerIface = new ethers.Interface([
  "function querySwapSingleTokenExactIn(address pool,address tokenIn,address tokenOut,uint256 exactAmountIn,address sender,bytes userData) returns (uint256 amountOut)",
]);
const balancerV3LandedEvents = defineSwapLandedEvents({
  swaps: [{
    id: "balancer-v3-swap",
    topic: BALANCER_V3_SWAP_TOPIC,
    emitter: singletonIndexedAddressEmitter(ADDR.BALANCER_V3_VAULT, 1),
    materialization: "family",
    discovery: { poolAdapter: "balancer-v3", label: "balancer-v3" },
    invalidatesWarmState: true,
  }],
  mutations: [],
});

const balancerV3PoolDiscovery = Object.freeze({
  version: "balancer-v3-indexed-pool-v1",
  eventIds: ["balancer-v3-swap"],
  async materialize(context) {
    const malformed = context.logs.filter((log) =>
      !isBalancerV3DiscoveryLogMaterializable(log)
    ).length;
    return {
      pools: buildBalancerV3PoolEntries(context.logs, context.minSwaps),
      complete: malformed === 0,
      ...(malformed === 0
        ? {}
        : { issues: [`${malformed} malformed indexed pool/token events`] }),
    };
  },
} satisfies LandedPoolMaterializationCapability);

export function buildBalancerV3PoolEntries(
  logs: readonly LandedPoolDiscoveryLog[],
  minSwaps: number,
): PoolUniverseEntry[] {
  const pools = new Map<string, PoolUniverseEntry>();
  for (const log of logs) {
    const poolTopic = log.topics[1];
    const tokenInTopic = log.topics[2];
    const tokenOutTopic = log.topics[3];
    if (!poolTopic || !tokenInTopic || !tokenOutTopic) continue;
    try {
      const address = indexedAddress(poolTopic);
      const tokenIn = indexedAddress(tokenInTopic);
      const tokenOut = indexedAddress(tokenOutTopic);
      const key = address.toLowerCase();
      const existing = pools.get(key);
      if (existing) {
        existing.score = (existing.score ?? 0) + 1;
        existing.swapCount30d = (existing.swapCount30d ?? 0) + 1;
        existing.lastSwapBlock = Math.max(
          existing.lastSwapBlock ?? 0,
          logBlockNumber(log.blockNumber),
        );
      } else {
        pools.set(key, {
          address,
          adapter: "balancer-v3",
          venueId: "balancer-v3",
          identitySource: "balancer-v3-vault",
          token0: tokenIn,
          token1: tokenOut,
          score: 1,
          swapCount30d: 1,
          lastSwapBlock: logBlockNumber(log.blockNumber),
          source: "balancer-v3-vault-swap",
        });
      }
    } catch {
      // Malformed events do not nominate an executable instance.
    }
  }
  return [...pools.values()]
    .filter((pool) => (pool.swapCount30d ?? 0) >= minSwaps)
    .sort((left, right) =>
      (right.swapCount30d ?? 0) - (left.swapCount30d ?? 0)
    );
}

interface BalancerV3StateSchema {
  readonly pool: string;
}

export const balancerV3BlockScanState =
  createCurrentBlockViewQuoteCapability<BalancerV3StateSchema>({
    kind: "external-swap",
    edgeAdapterIds: new Set(["balancer-v3-unlock"]),
    compileGroup(edges) {
      const pool = ethers.getAddress(edges[0].target).toLowerCase();
      if (
        edges.some((edge) =>
          ethers.getAddress(edge.target).toLowerCase() !== pool
        )
      ) {
        throw new Error(`balancer-v3 block-scan group mixed pool ${pool}`);
      }
      return Object.freeze({ pool });
    },
    initialReads(ctx) {
      return Object.freeze([
        currentBlockRead({
          id: balancerPoolInfoReadId(ctx.stateKey),
          sourceBlock: ctx.sourceBlock,
          sourceBlockHash: ctx.sourceBlockHash,
          to: ADDR.BALANCER_V3_VAULT,
          data: vaultIface.encodeFunctionData("getPoolTokenInfo", [
            ctx.static.pool,
          ]),
        }),
      ]);
    },
    quoteAmountIn(ctx) {
      const poolInfo = requireRead(
        ctx.priorResults,
        balancerPoolInfoReadId(ctx.stateKey),
      );
      const decoded = vaultIface.decodeFunctionResult(
        "getPoolTokenInfo",
        poolInfo.data,
      );
      const tokens = (decoded[0] as string[]).map((token) =>
        ethers.getAddress(token)
      );
      const balancesRaw = (decoded[2] as bigint[]).map((balance) =>
        BigInt(balance)
      );
      if (tokens.length !== balancesRaw.length) {
        throw new Error(
          `balancer-v3 pool ${ctx.static.pool} returned inconsistent token balances`,
        );
      }
      const tokenIndex = tokens.findIndex((token) =>
        token.toLowerCase() === ctx.edge.tokenIn.toLowerCase()
      );
      if (tokenIndex < 0) {
        throw new Error(
          `balancer-v3 pool ${ctx.static.pool} omitted input token ${ctx.edge.tokenIn}`,
        );
      }
      const balance = balancesRaw[tokenIndex];
      // Probe at most one percent of raw pool liquidity. For balances below
      // 100 atomic units, one quarter is the largest integer probe that
      // remains below WeightedMath's 30% max-in bound.
      const liquidityProbe = balance >= 100n
        ? balance / 100n
        : balance / 4n;
      if (liquidityProbe <= 0n) {
        return behaviorProvenUnavailableViewQuote(
          `balancer-v3 pool ${ctx.static.pool} has no behavior-safe input ` +
            `for ${ctx.edge.tokenIn} at the pinned source`,
        );
      }
      return liquidityProbe < ctx.amountIn
        ? liquidityProbe
        : ctx.amountIn;
    },
    quoteRead(ctx) {
      return currentBlockRead({
        id: quoteReadId(ctx.stateKey, ctx.edge),
        sourceBlock: ctx.sourceBlock,
        sourceBlockHash: ctx.sourceBlockHash,
        to: ADDR.BALANCER_V3_ROUTER,
        data: routerIface.encodeFunctionData("querySwapSingleTokenExactIn", [
          ctx.edge.target,
          ctx.edge.tokenIn,
          ctx.edge.tokenOut,
          ctx.amountIn,
          ethers.ZeroAddress,
          "0x",
        ]),
        transport: "rpc-batch",
      });
    },
    decodeQuote(_edge, data) {
      return BigInt(
        routerIface.decodeFunctionResult("querySwapSingleTokenExactIn", data)[0],
      );
    },
    dependencies() {
      return Object.freeze([
        ADDR.BALANCER_V3_ROUTER.toLowerCase(),
        ADDR.BALANCER_V3_VAULT.toLowerCase(),
      ]);
    },
  });

export const balancerV3Adapter = Object.freeze({
  id: "balancer-v3",
  kind: "swap",
  poolAdapters: ["balancer-v3"],
  identityPolicies: [{
    poolAdapter: "balancer-v3",
    policy: "onchain-resolver",
    resolve: balancerV3IdentityResolver,
  }],
  edgeAdapterIds: ["balancer-v3-unlock"],
  allowedTaxonomy: [{ slotKind: "swap" }],
  requiresProtocolEdgesFlag: false,
  ownedActionAdapterIds: [
    "balancer-v3-unlock",
    "balancer-v3-settle",
    "balancer-v3-swap",
    "balancer-v3-send-to",
  ],
  requiredInfraActionAdapterIds: ["erc20-transfer"],
  landedEvents: balancerV3LandedEvents,
  poolDiscovery: balancerV3PoolDiscovery,
  observation: createBalancerV3SwapObservation({
    adapterIds: ["balancer-v3-unlock"],
    canonicalIntakeTargets: [ADDR.BALANCER_V3_ROUTER, ADDR.BALANCER_V3_VAULT],
    landedEvents: balancerV3LandedEvents.swaps,
  }),
  victimModel: {
    id: "pool-swap:balancer-v3-detect-only",
    mode: "detect-only",
  },
  pricingState: balancerV3BlockScanState,
  prepared: null,

  buildEdges: buildBalancerV3Edges,
  quoteExact: quoteBalancerV3Exact,
  buildPlanFragment: buildBalancerV3PlanFragment,
} satisfies SwapAdapter);

function indexedAddress(topic: string): string {
  if (!/^0x[0-9a-fA-F]{64}$/.test(topic)) {
    throw new Error("invalid indexed address");
  }
  return ethers.getAddress(`0x${topic.slice(-40)}`);
}

function isBalancerV3DiscoveryLogMaterializable(
  log: LandedPoolDiscoveryLog,
): boolean {
  try {
    indexedAddress(log.topics[1] ?? "");
    indexedAddress(log.topics[2] ?? "");
    indexedAddress(log.topics[3] ?? "");
    return true;
  } catch {
    return false;
  }
}

function logBlockNumber(value: string | number): number {
  const parsed = typeof value === "number"
    ? value
    : value.startsWith("0x")
    ? parseInt(value, 16)
    : Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function balancerPoolInfoReadId(stateKey: string): string {
  return `balancer-v3:${stateKey}:pool-token-info`;
}

export async function quoteBalancerV3(
  state: { call(req: { to: string; data: string }): Promise<string> },
  pool: string,
  tokenIn: string,
  tokenOut: string,
  amountIn: bigint,
): Promise<bigint> {
  const data = routerIface.encodeFunctionData("querySwapSingleTokenExactIn", [
    pool,
    tokenIn,
    tokenOut,
    amountIn,
    ethers.ZeroAddress,
    "0x",
  ]);
  const result = await state.call({ to: ADDR.BALANCER_V3_ROUTER, data });
  return BigInt(routerIface.decodeFunctionResult("querySwapSingleTokenExactIn", result)[0]);
}

async function buildBalancerV3Edges(
  pool: PoolEntry,
  backend: TokenQueryBackend,
): Promise<TokenEdge[]> {
  const data = vaultIface.encodeFunctionData("getPoolTokens", [pool.address]);
  const result = await backend.call({ to: ADDR.BALANCER_V3_VAULT, data });
  const tokens = (vaultIface.decodeFunctionResult("getPoolTokens", result)[0] as string[])
    .map((token) => ethers.getAddress(token));
  if (tokens.length < 2) {
    throw new Error(`balancer-v3 pool ${pool.address} returned fewer than two tokens`);
  }
  const taxonomy = deriveEdgeTaxonomy("swap");
  const edges: TokenEdge[] = [];
  for (let i = 0; i < tokens.length; i++) {
    for (let j = 0; j < tokens.length; j++) {
      if (i === j) continue;
      edges.push({
        adapterId: "balancer-v3-unlock",
        target: ethers.getAddress(pool.address),
        tokenIn: tokens[i],
        tokenOut: tokens[j],
        slotKind: "swap",
        score: pool.score,
        ...taxonomy,
      });
    }
  }
  return edges;
}

async function quoteBalancerV3Exact(ctx: ExactQuoteContext): Promise<bigint> {
  const { state, target, tokenIn, tokenOut, amountIn } = ctx;
  if (!tokenIn || !tokenOut) throw new Error("balancer-v3 quote requires tokenIn/tokenOut");
  if (amountIn <= 0n) return 0n;
  return quoteBalancerV3(state, target, tokenIn, tokenOut, amountIn);
}

async function buildBalancerV3PlanFragment(ctx: PlanBuildContext): Promise<PlanFragment> {
  const { edge, amountIn, amountOut, rawOut } = ctx;
  const outputAmount = rawOut ?? amountOut;
  const vault = ADDR.BALANCER_V3_VAULT;
  return {
    requirements: [],
    nodes: [{
      adapterId: "balancer-v3-unlock",
      target: vault,
      tokenIn: edge.tokenIn,
      tokenOut: edge.tokenOut,
      amount: 0n,
      params: {},
      children: [
        {
          adapterId: "erc20-transfer",
          target: edge.tokenIn,
          tokenIn: edge.tokenIn,
          tokenOut: edge.tokenIn,
          amount: amountIn,
          params: { to: vault, amount: amountIn },
          children: [],
        },
        {
          adapterId: "balancer-v3-settle",
          target: vault,
          tokenIn: edge.tokenIn,
          tokenOut: edge.tokenIn,
          amount: amountIn,
          params: { token: edge.tokenIn },
          children: [],
        },
        {
          adapterId: "balancer-v3-swap",
          target: vault,
          tokenIn: edge.tokenIn,
          tokenOut: edge.tokenOut,
          amount: amountIn,
          params: { kind: 0n, pool: edge.target, limitRaw: 0n, userData: "0x" },
          children: [],
        },
        {
          adapterId: "balancer-v3-send-to",
          target: vault,
          tokenIn: edge.tokenOut,
          tokenOut: edge.tokenOut,
          amount: outputAmount,
          params: { token: edge.tokenOut },
          children: [],
        },
      ],
    }],
  };
}
