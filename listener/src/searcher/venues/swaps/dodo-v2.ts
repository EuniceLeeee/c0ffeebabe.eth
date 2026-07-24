import { ethers } from "ethers";
import { DEFAULT_SEARCHER_OWNER } from "../../../shared/executor/botvm-executor.js";
import { deriveEdgeTaxonomy } from "../../strategy-taxonomy.js";
import type { PoolEntry, TokenEdge, TokenQueryBackend } from "../../planner/token-graph.js";
import type {
  ExactQuoteContext,
  PlanBuildContext,
  PlanFragment,
  PreparedRouteContext,
  PreparedRouteQuoteResult,
  SwapAdapter,
} from "../route-leg-adapter.js";
import {
  dodoV2IdentityResolver,
  isRetryablePoolIdentityFailure,
} from "../identity.js";
import { createDodoV2SwapObservation } from "../swap-observation.js";
import {
  ADDRESS_LANDED_EVENT_EMITTER,
  defineSwapLandedEvents,
  DODO_V2_SWAP_TOPIC,
} from "../landed-event-registry.js";
import { createAddressLandedPoolMaterializer } from "../landed-pool-discovery.js";
import {
  currentBlockRead,
  requireRead,
} from "./blockscan-state-shared.js";
import {
  behaviorProvenUnavailableViewQuote,
  type BehaviorProvenUnavailableViewQuote,
  createCurrentBlockViewQuoteCapability,
  quoteReadId,
} from "./view-quote-blockscan-state.js";

const DODO_V2_PROXY = "0xa356867fDCEa8e71AEaF87805808803806231FdC";

export const dodoV2PoolIface = new ethers.Interface([
  "function _BASE_TOKEN_() view returns (address)",
  "function _QUOTE_TOKEN_() view returns (address)",
  "function _BASE_RESERVE_() view returns (uint256)",
  "function _QUOTE_RESERVE_() view returns (uint256)",
  "function getPMMStateForCall() view returns (uint256 i,uint256 K,uint256 B,uint256 Q,uint256 B0,uint256 Q0,uint256 R)",
  "function querySellBase(address trader,uint256 payBaseAmount) view returns (uint256 receiveQuoteAmount)",
  "function querySellQuote(address trader,uint256 payQuoteAmount) view returns (uint256 receiveBaseAmount)",
]);
const erc20Iface = new ethers.Interface([
  "function balanceOf(address account) view returns (uint256)",
]);
const dodoV2LandedEvents = defineSwapLandedEvents({
  swaps: [{
    id: "dodo-v2-swap",
    topic: DODO_V2_SWAP_TOPIC,
    emitter: ADDRESS_LANDED_EVENT_EMITTER,
    materialization: "family",
    discovery: { poolAdapter: "dodo-v2", label: "dodo-v2" },
    invalidatesWarmState: true,
  }],
  mutations: [],
});

const dodoV2PoolDiscovery = createAddressLandedPoolMaterializer({
  version: "dodo-v2-address-metadata-v1",
  eventIds: ["dodo-v2-swap"],
  async materializePool(candidate, context) {
    const identity = await dodoV2IdentityResolver({
      backend: context.backend,
      pool: candidate.address,
      poolAdapter: "dodo-v2",
      candidate: {
        address: candidate.address,
        adapter: "dodo-v2",
      },
      admissionPolicy: context.admissionPolicy,
      isPoolAdapterSupported: (poolAdapter) => poolAdapter === "dodo-v2",
    });
    if (!identity.ok) {
      if (isRetryablePoolIdentityFailure(identity.reason)) {
        throw new Error(`DODO identity read incomplete: ${identity.reason}`);
      }
      return null;
    }
    const [baseRaw, quoteRaw] = await Promise.all([
      context.backend.call(
        {
          to: candidate.address,
          data: dodoV2PoolIface.encodeFunctionData("_BASE_TOKEN_"),
        },
        context.signal === undefined ? undefined : { signal: context.signal },
      ),
      context.backend.call(
        {
          to: candidate.address,
          data: dodoV2PoolIface.encodeFunctionData("_QUOTE_TOKEN_"),
        },
        context.signal === undefined ? undefined : { signal: context.signal },
      ),
    ]);
    const token0 = ethers.getAddress(String(
      dodoV2PoolIface.decodeFunctionResult("_BASE_TOKEN_", baseRaw)[0],
    ));
    const token1 = ethers.getAddress(String(
      dodoV2PoolIface.decodeFunctionResult("_QUOTE_TOKEN_", quoteRaw)[0],
    ));
    return {
      address: candidate.address,
      adapter: identity.adapter,
      venueId: identity.venueId,
      identitySource: identity.identitySource,
      ...(identity.factory === undefined ? {} : { factory: identity.factory }),
      token0,
      token1,
    };
  },
});

interface DodoV2StateSchema {
  readonly pool: string;
  readonly baseToken: string;
  readonly quoteToken: string;
}

export const dodoV2BlockScanState =
  createCurrentBlockViewQuoteCapability<DodoV2StateSchema>({
    kind: "external-swap",
    edgeAdapterIds: new Set(["dodo-v2-swap"]),
    compileGroup(edges) {
      const pool = ethers.getAddress(edges[0].target).toLowerCase();
      const first = edges[0];
      if (!first.poolToken0 || !first.poolToken1) {
        throw new Error(`dodo-v2 block-scan pool ${pool} is missing token order`);
      }
      const baseToken = ethers.getAddress(first.poolToken0);
      const quoteToken = ethers.getAddress(first.poolToken1);
      for (const edge of edges) {
        if (
          ethers.getAddress(edge.target).toLowerCase() !== pool ||
          !edge.poolToken0 ||
          !edge.poolToken1 ||
          ethers.getAddress(edge.poolToken0) !== baseToken ||
          ethers.getAddress(edge.poolToken1) !== quoteToken
        ) {
          throw new Error(`dodo-v2 block-scan pool ${pool} has inconsistent metadata`);
        }
        assertEdgeTokens(edge.tokenIn, edge.tokenOut, baseToken, quoteToken);
      }
      return Object.freeze({ pool, baseToken, quoteToken });
    },
    initialReads(ctx) {
      const tokens = [ctx.static.baseToken, ctx.static.quoteToken];
      return Object.freeze([
        currentBlockRead({
          id: dodoStateReadId(ctx.stateKey, "base-token"),
          sourceBlock: ctx.sourceBlock,
          sourceBlockHash: ctx.sourceBlockHash,
          to: ctx.static.pool,
          data: dodoV2PoolIface.encodeFunctionData("_BASE_TOKEN_"),
        }),
        currentBlockRead({
          id: dodoStateReadId(ctx.stateKey, "quote-token"),
          sourceBlock: ctx.sourceBlock,
          sourceBlockHash: ctx.sourceBlockHash,
          to: ctx.static.pool,
          data: dodoV2PoolIface.encodeFunctionData("_QUOTE_TOKEN_"),
        }),
        currentBlockRead({
          id: dodoStateReadId(ctx.stateKey, "pmm-state"),
          sourceBlock: ctx.sourceBlock,
          sourceBlockHash: ctx.sourceBlockHash,
          to: ctx.static.pool,
          data: dodoV2PoolIface.encodeFunctionData("getPMMStateForCall"),
        }),
        ...tokens.map((token) =>
          currentBlockRead({
            id: dodoBalanceReadId(ctx.stateKey, token),
            sourceBlock: ctx.sourceBlock,
            sourceBlockHash: ctx.sourceBlockHash,
            to: token,
            data: erc20Iface.encodeFunctionData("balanceOf", [ctx.static.pool]),
          })
        ),
      ]);
    },
    quoteAmountIn(ctx) {
      const sellBase = sameAddress(ctx.edge.tokenIn, ctx.static.baseToken);
      const balance = BigInt(
        erc20Iface.decodeFunctionResult(
          "balanceOf",
          requireRead(
            ctx.priorResults,
            dodoBalanceReadId(ctx.stateKey, ctx.edge.tokenIn),
          ).data,
        )[0],
      );
      const pmm = decodeDodoPmmState(
        requireRead(
          ctx.priorResults,
          dodoStateReadId(ctx.stateKey, "pmm-state"),
        ).data,
      );
      const reserve = sellBase ? pmm.B : pmm.Q;
      return selectDodoProbeInput({
        oneToken: ctx.amountIn,
        balance,
        reserve,
        pmm,
        sellBase,
        pool: ctx.static.pool,
      });
    },
    quoteRead(ctx) {
      const onchainBase = ethers.getAddress(String(
        dodoV2PoolIface.decodeFunctionResult(
          "_BASE_TOKEN_",
          requireRead(
            ctx.priorResults,
            dodoStateReadId(ctx.stateKey, "base-token"),
          ).data,
        )[0],
      ));
      const onchainQuote = ethers.getAddress(String(
        dodoV2PoolIface.decodeFunctionResult(
          "_QUOTE_TOKEN_",
          requireRead(
            ctx.priorResults,
            dodoStateReadId(ctx.stateKey, "quote-token"),
          ).data,
        )[0],
      ));
      if (
        onchainBase !== ctx.static.baseToken ||
        onchainQuote !== ctx.static.quoteToken
      ) {
        throw new Error(`dodo-v2 pool ${ctx.static.pool} token identity changed`);
      }
      const sellBase = sameAddress(ctx.edge.tokenIn, ctx.static.baseToken);
      const queryFunction = sellBase ? "querySellBase" : "querySellQuote";
      const balance = BigInt(
        erc20Iface.decodeFunctionResult(
          "balanceOf",
          requireRead(
            ctx.priorResults,
            dodoBalanceReadId(ctx.stateKey, ctx.edge.tokenIn),
          ).data,
        )[0],
      );
      const pmm = decodeDodoPmmState(
        requireRead(
          ctx.priorResults,
          dodoStateReadId(ctx.stateKey, "pmm-state"),
        ).data,
      );
      const reserve = sellBase ? pmm.B : pmm.Q;
      const effectiveInput = effectiveDodoInput(
        balance,
        reserve,
        ctx.amountIn,
        ctx.static.pool,
      );
      return currentBlockRead({
        id: quoteReadId(ctx.stateKey, ctx.edge),
        sourceBlock: ctx.sourceBlock,
        sourceBlockHash: ctx.sourceBlockHash,
        to: ctx.static.pool,
        data: dodoV2PoolIface.encodeFunctionData(queryFunction, [
          DEFAULT_SEARCHER_OWNER,
          effectiveInput,
        ]),
      });
    },
    decodeQuote(edge, data) {
      const sellBase = sameAddress(edge.tokenIn, edge.poolToken0!);
      const queryFunction = sellBase ? "querySellBase" : "querySellQuote";
      return BigInt(
        dodoV2PoolIface.decodeFunctionResult(queryFunction, data)[0],
      );
    },
  });

export const dodoV2Adapter = Object.freeze({
  id: "custom-swap:dodo-v2",
  kind: "swap",
  poolAdapters: ["dodo-v2"],
  identityPolicies: [{
    poolAdapter: "dodo-v2",
    policy: "onchain-resolver",
    resolve: dodoV2IdentityResolver,
  }],
  edgeAdapterIds: ["dodo-v2-swap"],
  allowedTaxonomy: [{ slotKind: "swap" }],
  requiresProtocolEdgesFlag: false,
  ownedActionAdapterIds: ["dodo-v2-swap"],
  requiredInfraActionAdapterIds: ["erc20-transfer"],
  landedEvents: dodoV2LandedEvents,
  poolDiscovery: dodoV2PoolDiscovery,
  observation: createDodoV2SwapObservation({
    adapterIds: ["dodo-v2-swap"],
    canonicalIntakeTargets: [DODO_V2_PROXY],
    landedEvents: dodoV2LandedEvents.swaps,
  }),
  victimModel: {
    id: "pool-swap:dodo-v2-detect-only",
    mode: "detect-only",
  },
  pricingState: dodoV2BlockScanState,
  prepared: {
    quote: quoteDodoV2Prepared,
    quoteUnsupportedReason: null,
    encodeQuotePrewarm: async (ctx: PreparedRouteContext) => [
      {
        from: ethers.ZeroAddress,
        to: ctx.request.target,
        calldata: dodoV2PoolIface.encodeFunctionData("_BASE_TOKEN_"),
      },
      {
        from: ethers.ZeroAddress,
        to: ctx.request.target,
        calldata: dodoV2PoolIface.encodeFunctionData("_QUOTE_TOKEN_"),
      },
      {
        from: ethers.ZeroAddress,
        to: ctx.request.target,
        calldata: dodoV2PoolIface.encodeFunctionData("_BASE_RESERVE_"),
      },
      {
        from: ethers.ZeroAddress,
        to: ctx.request.target,
        calldata: dodoV2PoolIface.encodeFunctionData("_QUOTE_RESERVE_"),
      },
      {
        from: ethers.ZeroAddress,
        to: ctx.request.tokenIn,
        calldata: erc20Iface.encodeFunctionData("balanceOf", [ctx.request.target]),
      },
    ],
    allowanceSpender: () => null,
    prewarmAddresses: (request) => [request.target, request.tokenIn],
  },
  buildEdges: buildDodoV2Edges,
  quoteExact: quoteDodoV2Exact,
  buildPlanFragment: buildDodoV2PlanFragment,
} satisfies SwapAdapter);

async function buildDodoV2Edges(
  pool: PoolEntry,
  backend: TokenQueryBackend,
): Promise<TokenEdge[]> {
  const [baseToken, quoteToken] = await readDodoV2Tokens(backend, pool.address);
  if (
    pool.token0 && pool.token1 &&
    (
      ethers.getAddress(pool.token0) !== baseToken ||
      ethers.getAddress(pool.token1) !== quoteToken
    )
  ) {
    throw new Error(`dodo-v2 pool ${pool.address} token metadata does not match on-chain pair`);
  }
  const taxonomy = deriveEdgeTaxonomy("swap");
  return [
    {
      adapterId: "dodo-v2-swap",
      target: pool.address,
      tokenIn: baseToken,
      tokenOut: quoteToken,
      slotKind: "swap",
      poolToken0: baseToken,
      poolToken1: quoteToken,
      score: pool.score,
      ...taxonomy,
    },
    {
      adapterId: "dodo-v2-swap",
      target: pool.address,
      tokenIn: quoteToken,
      tokenOut: baseToken,
      slotKind: "swap",
      poolToken0: baseToken,
      poolToken1: quoteToken,
      score: pool.score,
      ...taxonomy,
    },
  ];
}

async function quoteDodoV2Exact(ctx: ExactQuoteContext): Promise<bigint> {
  if (!ctx.tokenIn || !ctx.tokenOut) throw new Error("dodo-v2 quote requires tokenIn/tokenOut");
  if (ctx.amountIn <= 0n) return 0n;
  const [baseToken, quoteToken] = await readDodoV2Tokens(ctx.state, ctx.target);
  assertEdgeTokens(ctx.tokenIn, ctx.tokenOut, baseToken, quoteToken);
  if (
    ctx.edge?.poolToken0 && ctx.edge.poolToken1 &&
    (
      ethers.getAddress(ctx.edge.poolToken0) !== baseToken ||
      ethers.getAddress(ctx.edge.poolToken1) !== quoteToken
    )
  ) {
    throw new Error(`dodo-v2 pool ${ctx.target} token metadata does not match on-chain pair`);
  }
  const sellBase = sameAddress(ctx.tokenIn, baseToken);
  const reserveFunction = sellBase ? "_BASE_RESERVE_" : "_QUOTE_RESERVE_";
  const queryFunction = sellBase ? "querySellBase" : "querySellQuote";
  const [balanceRaw, reserveRaw] = await Promise.all([
    ctx.state.call({
      to: ctx.tokenIn,
      data: erc20Iface.encodeFunctionData("balanceOf", [ctx.target]),
    }),
    ctx.state.call({
      to: ctx.target,
      data: dodoV2PoolIface.encodeFunctionData(reserveFunction),
    }),
  ]);
  const effectiveInput = effectiveDodoInput(
    BigInt(erc20Iface.decodeFunctionResult("balanceOf", balanceRaw)[0]),
    BigInt(dodoV2PoolIface.decodeFunctionResult(reserveFunction, reserveRaw)[0]),
    ctx.amountIn,
    ctx.target,
  );
  const result = await ctx.state.call({
    to: ctx.target,
    data: dodoV2PoolIface.encodeFunctionData(queryFunction, [
      DEFAULT_SEARCHER_OWNER,
      effectiveInput,
    ]),
  });
  return decodeFirstWord(result, `${queryFunction} ${ctx.target}`);
}

async function quoteDodoV2Prepared(
  ctx: PreparedRouteContext,
): Promise<PreparedRouteQuoteResult> {
  const { request } = ctx;
  const calls = await Promise.all([
    ctx.callPrepared(request.target, dodoV2PoolIface.encodeFunctionData("_BASE_TOKEN_")),
    ctx.callPrepared(request.target, dodoV2PoolIface.encodeFunctionData("_QUOTE_TOKEN_")),
  ]);
  const baseToken = ethers.getAddress(String(
    dodoV2PoolIface.decodeFunctionResult("_BASE_TOKEN_", calls[0].output)[0],
  ));
  const quoteToken = ethers.getAddress(String(
    dodoV2PoolIface.decodeFunctionResult("_QUOTE_TOKEN_", calls[1].output)[0],
  ));
  assertEdgeTokens(request.tokenIn, request.tokenOut, baseToken, quoteToken);
  const sellBase = sameAddress(request.tokenIn, baseToken);
  const reserveFunction = sellBase ? "_BASE_RESERVE_" : "_QUOTE_RESERVE_";
  const queryFunction = sellBase ? "querySellBase" : "querySellQuote";
  const [balanceCall, reserveCall] = await Promise.all([
    ctx.callPrepared(
      request.tokenIn,
      erc20Iface.encodeFunctionData("balanceOf", [request.target]),
    ),
    ctx.callPrepared(
      request.target,
      dodoV2PoolIface.encodeFunctionData(reserveFunction),
    ),
  ]);
  const effectiveInput = effectiveDodoInput(
    BigInt(erc20Iface.decodeFunctionResult("balanceOf", balanceCall.output)[0]),
    BigInt(dodoV2PoolIface.decodeFunctionResult(reserveFunction, reserveCall.output)[0]),
    request.amountIn,
    request.target,
  );
  const quoteCall = await ctx.callPrepared(
    request.target,
    dodoV2PoolIface.encodeFunctionData(queryFunction, [DEFAULT_SEARCHER_OWNER, effectiveInput]),
  );
  return {
    amountOut: decodeFirstWord(quoteCall.output, `${queryFunction} ${request.target}`),
    latencyMs: calls[0].latencyMs + calls[1].latencyMs +
      balanceCall.latencyMs + reserveCall.latencyMs + quoteCall.latencyMs,
    cacheStats: quoteCall.cacheStats ?? reserveCall.cacheStats ?? balanceCall.cacheStats,
  };
}

async function buildDodoV2PlanFragment(ctx: PlanBuildContext): Promise<PlanFragment> {
  const { edge, amountIn } = ctx;
  if (!edge.poolToken0 || !edge.poolToken1) {
    throw new Error(`dodo-v2 edge missing base/quote order: ${edge.tokenIn} -> ${edge.tokenOut}`);
  }
  assertEdgeTokens(edge.tokenIn, edge.tokenOut, edge.poolToken0, edge.poolToken1);
  return {
    requirements: [{
      kind: "transfer-to-pool",
      token: edge.tokenIn,
      pool: edge.target,
      amount: amountIn,
    }],
    nodes: [{
      adapterId: "dodo-v2-swap",
      target: edge.target,
      tokenIn: edge.tokenIn,
      tokenOut: edge.tokenOut,
      amount: amountIn,
      params: { sellBase: sameAddress(edge.tokenIn, edge.poolToken0) },
      children: [],
    }],
  };
}

async function readDodoV2Tokens(
  backend: Pick<TokenQueryBackend, "call">,
  pool: string,
): Promise<[string, string]> {
  const [baseRaw, quoteRaw] = await Promise.all([
    backend.call({ to: pool, data: dodoV2PoolIface.encodeFunctionData("_BASE_TOKEN_") }),
    backend.call({ to: pool, data: dodoV2PoolIface.encodeFunctionData("_QUOTE_TOKEN_") }),
  ]);
  const baseToken = ethers.getAddress(String(
    dodoV2PoolIface.decodeFunctionResult("_BASE_TOKEN_", baseRaw)[0],
  ));
  const quoteToken = ethers.getAddress(String(
    dodoV2PoolIface.decodeFunctionResult("_QUOTE_TOKEN_", quoteRaw)[0],
  ));
  if (
    baseToken === ethers.ZeroAddress ||
    quoteToken === ethers.ZeroAddress ||
    baseToken === quoteToken
  ) {
    throw new Error(`dodo-v2 pool ${pool} returned an invalid base/quote pair`);
  }
  return [baseToken, quoteToken];
}

function assertEdgeTokens(
  tokenIn: string,
  tokenOut: string,
  baseToken: string,
  quoteToken: string,
): void {
  const sellsBase = sameAddress(tokenIn, baseToken) && sameAddress(tokenOut, quoteToken);
  const sellsQuote = sameAddress(tokenIn, quoteToken) && sameAddress(tokenOut, baseToken);
  if (!sellsBase && !sellsQuote) {
    throw new Error(
      `dodo-v2 tokens ${tokenIn} -> ${tokenOut} do not match ` +
      `${baseToken} / ${quoteToken}`,
    );
  }
}

function effectiveDodoInput(
  balance: bigint,
  reserve: bigint,
  amountIn: bigint,
  pool: string,
): bigint {
  const postTransferBalance = balance + amountIn;
  if (postTransferBalance <= reserve) {
    throw new Error(`dodo-v2 input balance does not clear stored reserve for pool ${pool}`);
  }
  return postTransferBalance - reserve;
}

interface DodoPmmState {
  readonly B: bigint;
  readonly Q: bigint;
  readonly B0: bigint;
  readonly Q0: bigint;
  readonly R: number;
}

function decodeDodoPmmState(data: string): DodoPmmState {
  const decoded = dodoV2PoolIface.decodeFunctionResult(
    "getPMMStateForCall",
    data,
  );
  const R = Number(decoded[6]);
  if (!Number.isInteger(R) || R < 0 || R > 2) {
    throw new Error(`dodo-v2 returned invalid PMM R state ${R}`);
  }
  return Object.freeze({
    B: BigInt(decoded[2]),
    Q: BigInt(decoded[3]),
    B0: BigInt(decoded[4]),
    Q0: BigInt(decoded[5]),
    R,
  });
}

function selectDodoProbeInput(input: {
  readonly oneToken: bigint;
  readonly balance: bigint;
  readonly reserve: bigint;
  readonly pmm: DodoPmmState;
  readonly sellBase: boolean;
  readonly pool: string;
}): bigint | BehaviorProvenUnavailableViewQuote {
  const {
    oneToken,
    balance,
    reserve,
    pmm,
    sellBase,
    pool,
  } = input;
  if (reserve <= 0n) {
    return behaviorProvenUnavailableViewQuote(
      `dodo-v2 pool ${pool} has no behavior-safe input reserve at the pinned source`,
    );
  }
  const unavailableTarget = dodoActiveMathTargetUnavailable(
    pmm,
    sellBase,
    pool,
  );
  if (unavailableTarget) return unavailableTarget;

  const liquidityProbe = reserve >= 100n
    ? reserve / 100n
    : reserve / 4n;
  if (liquidityProbe <= 0n) {
    return behaviorProvenUnavailableViewQuote(
      `dodo-v2 pool ${pool} has no behavior-safe atomic probe at the pinned source`,
    );
  }
  const precisionFloor = reserve / 1_000_000n > 0n
    ? reserve / 1_000_000n
    : 1n;
  const desiredProbe = oneToken > precisionFloor
    ? oneToken
    : precisionFloor;
  let effectiveProbe = liquidityProbe < desiredProbe
    ? liquidityProbe
    : desiredProbe;
  const crossingCap = dodoZeroTargetCrossingCap(pmm, sellBase);
  const surplus = balance > reserve ? balance - reserve : 0n;
  if (crossingCap !== null) {
    if (crossingCap <= 0n || surplus >= crossingCap) {
      return behaviorProvenUnavailableViewQuote(
        `dodo-v2 pool ${pool} has no positive input before its zero-target branch`,
      );
    }
    const remaining = crossingCap - surplus;
    const branchProbe = remaining > 1n ? remaining / 2n : remaining;
    if (branchProbe < effectiveProbe) effectiveProbe = branchProbe;
  }
  if (effectiveProbe <= 0n) {
    return behaviorProvenUnavailableViewQuote(
      `dodo-v2 pool ${pool} selected no positive behavior-safe probe`,
    );
  }
  if (balance >= reserve) return effectiveProbe;
  return reserve - balance + effectiveProbe;
}

function dodoActiveMathTargetUnavailable(
  pmm: DodoPmmState,
  sellBase: boolean,
  pool: string,
): BehaviorProvenUnavailableViewQuote | null {
  const activeTarget = sellBase
    ? (pmm.R === 1 ? pmm.B0 : pmm.Q0)
    : (pmm.R === 2 ? pmm.Q0 : pmm.B0);
  if (activeTarget <= 0n) {
    return behaviorProvenUnavailableViewQuote(
      `dodo-v2 pool ${pool} has a zero active PMM target at the pinned source`,
    );
  }
  return null;
}

function dodoZeroTargetCrossingCap(
  pmm: DodoPmmState,
  sellBase: boolean,
): bigint | null {
  if (sellBase && pmm.R === 1 && pmm.Q0 === 0n) {
    return pmm.B0 > pmm.B ? pmm.B0 - pmm.B : 0n;
  }
  if (!sellBase && pmm.R === 2 && pmm.B0 === 0n) {
    return pmm.Q0 > pmm.Q ? pmm.Q0 - pmm.Q : 0n;
  }
  return null;
}

function decodeFirstWord(result: string, label: string): bigint {
  if (!/^0x[0-9a-fA-F]{64,}$/.test(result)) {
    throw new Error(`dodo-v2 ${label} returned malformed data`);
  }
  return BigInt(`0x${result.slice(2, 66)}`);
}

function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function dodoStateReadId(stateKey: string, field: string): string {
  return `dodo:${stateKey}:${field}`;
}

function dodoBalanceReadId(stateKey: string, token: string): string {
  return `dodo:${stateKey}:balance:${ethers.getAddress(token).toLowerCase()}`;
}
