import { ethers } from "ethers";
import { DEFAULT_SEARCHER_OWNER } from "../../../shared/executor/botvm-executor.js";
import { deriveEdgeTaxonomy } from "../../strategy-taxonomy.js";
import type { PoolEntry, TokenEdge, TokenQueryBackend } from "../../planner/token-graph.js";
import { readExternalSwapMid } from "../mid-readers.js";
import type {
  ExactQuoteContext,
  PlanBuildContext,
  PlanFragment,
  PreparedRouteContext,
  PreparedRouteQuoteResult,
  SwapAdapter,
} from "../route-leg-adapter.js";
import { createDodoV2SwapObservation } from "../swap-observation.js";

const DODO_V2_PROXY = "0xa356867fDCEa8e71AEaF87805808803806231FdC";

export const dodoV2PoolIface = new ethers.Interface([
  "function _BASE_TOKEN_() view returns (address)",
  "function _QUOTE_TOKEN_() view returns (address)",
  "function _BASE_RESERVE_() view returns (uint256)",
  "function _QUOTE_RESERVE_() view returns (uint256)",
  "function querySellBase(address trader,uint256 payBaseAmount) view returns (uint256 receiveQuoteAmount)",
  "function querySellQuote(address trader,uint256 payQuoteAmount) view returns (uint256 receiveBaseAmount)",
]);
const erc20Iface = new ethers.Interface([
  "function balanceOf(address account) view returns (uint256)",
]);

export const dodoV2Adapter = Object.freeze({
  id: "custom-swap:dodo-v2",
  kind: "swap",
  poolAdapters: ["dodo-v2"],
  edgeAdapterIds: ["dodo-v2-swap"],
  allowedTaxonomy: [{ slotKind: "swap" }],
  requiresProtocolEdgesFlag: false,
  actionAdapterIds: ["dodo-v2-swap", "erc20-transfer"],
  observation: createDodoV2SwapObservation({
    adapterIds: ["dodo-v2-swap"],
    canonicalIntakeTargets: [DODO_V2_PROXY],
  }),
  readMid: readExternalSwapMid,
  warm: { kind: "external-mid" },
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

function decodeFirstWord(result: string, label: string): bigint {
  if (!/^0x[0-9a-fA-F]{64,}$/.test(result)) {
    throw new Error(`dodo-v2 ${label} returned malformed data`);
  }
  return BigInt(`0x${result.slice(2, 66)}`);
}

function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}
