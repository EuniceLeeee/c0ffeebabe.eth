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
import type {
  BlockScanStateCapability,
  BuildCurrentBlockReadsInput,
  BuildDependentBlockReadsInput,
  CompileStaticSchemaInput,
  StateRead,
  StateReadResult,
} from "../blockscan-state-capability.js";
import { blockScanEdgeKey } from "../blockscan-state-capability.js";
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
  BLOCKSCAN_MULTICALL3,
  blockScanErc20Iface,
  blockScanMulticallIface,
  canonicalPoolStateKey,
  currentBlockRead,
  decodeMulticall,
  encodeMulticall,
  midsForDirectedEdges,
  optionalMulticallData,
  quotedPoolMid,
  requireMulticallData,
  requireRead,
  type MulticallItem,
} from "./blockscan-state-shared.js";
import {
  behaviorProvenUnavailableViewQuote,
  type BehaviorProvenUnavailableViewQuote,
} from "./view-quote-blockscan-state.js";
import {
  checkedDodoInput,
  type DodoPmmState,
  quoteDodoPmmExactInput,
} from "./dodo-pmm-math.js";

const DODO_V2_PROXY = "0xa356867fDCEa8e71AEaF87805808803806231FdC";

export const dodoV2PoolIface = new ethers.Interface([
  "function _BASE_TOKEN_() view returns (address)",
  "function _QUOTE_TOKEN_() view returns (address)",
  "function _BASE_RESERVE_() view returns (uint256)",
  "function _QUOTE_RESERVE_() view returns (uint256)",
  "function getPMMStateForCall() view returns (uint256 i,uint256 K,uint256 B,uint256 Q,uint256 B0,uint256 Q0,uint256 R)",
  "function getUserFeeRate(address user) view returns (uint256 lpFeeRate,uint256 mtFeeRate)",
  "function getBaseInput() view returns (uint256 input)",
  "function getQuoteInput() view returns (uint256 input)",
  "function getMtFeeTotal() view returns (uint256 mtFeeBase,uint256 mtFeeQuote)",
  "function querySellBase(address trader,uint256 payBaseAmount) view returns (uint256 receiveQuoteAmount)",
  "function querySellQuote(address trader,uint256 payQuoteAmount) view returns (uint256 receiveBaseAmount)",
]);
const dodoErc20Iface = new ethers.Interface([
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

interface DodoV2StateGroup {
  readonly stateKey: string;
  readonly pool: string;
  readonly baseToken: string;
  readonly quoteToken: string;
  readonly edges: readonly TokenEdge[];
  readonly amountInByToken: ReadonlyMap<string, bigint>;
}

interface DodoV2StateSchema {
  readonly groups: ReadonlyMap<string, DodoV2StateGroup>;
}

interface DodoV2Snapshot {
  readonly stateKey: string;
  readonly pmm: DodoPmmState;
  readonly quotes: ReadonlyMap<string, {
    readonly amountIn: bigint;
    readonly amountOut: bigint;
  }>;
  readonly unavailable: ReadonlyMap<string, string>;
}

interface DodoDecodedCurrentState {
  readonly pmm: DodoPmmState;
  readonly lpFeeRate: bigint;
  readonly mtFeeRate: bigint;
  readonly baseInput: DodoInputPosition;
  readonly quoteInput: DodoInputPosition;
}

interface DodoInputPosition {
  readonly surplus: bigint;
  readonly deficit: bigint;
}

export const dodoV2BlockScanState = Object.freeze({
  stateKey: canonicalPoolStateKey,

  compileStaticSchema({ edges }: CompileStaticSchemaInput): DodoV2StateSchema {
    const grouped = new Map<string, TokenEdge[]>();
    for (const edge of edges) {
      if (edge.adapterId !== "dodo-v2-swap") {
        throw new Error(`dodo-v2 block-scan family does not own ${edge.adapterId}`);
      }
      const key = canonicalPoolStateKey(edge);
      const group = grouped.get(key) ?? [];
      group.push(edge);
      grouped.set(key, group);
    }

    const groups = new Map<string, DodoV2StateGroup>();
    for (const [stateKey, unorderedEdges] of grouped) {
      const orderedEdges = Object.freeze(
        [...unorderedEdges].sort((a, b) =>
          dodoRouteKey(a).localeCompare(dodoRouteKey(b))
        ),
      );
      const first = orderedEdges[0];
      if (!first.poolToken0 || !first.poolToken1) {
        throw new Error(
          `dodo-v2 block-scan pool ${stateKey} is missing token order`,
        );
      }
      const baseToken = ethers.getAddress(first.poolToken0);
      const quoteToken = ethers.getAddress(first.poolToken1);
      for (const edge of orderedEdges) {
        if (
          canonicalPoolStateKey(edge) !== stateKey ||
          !edge.poolToken0 ||
          !edge.poolToken1 ||
          ethers.getAddress(edge.poolToken0) !== baseToken ||
          ethers.getAddress(edge.poolToken1) !== quoteToken
        ) {
          throw new Error(
            `dodo-v2 block-scan pool ${stateKey} has inconsistent metadata`,
          );
        }
        assertEdgeTokens(edge.tokenIn, edge.tokenOut, baseToken, quoteToken);
      }
      groups.set(stateKey, Object.freeze({
        stateKey,
        pool: ethers.getAddress(first.target),
        baseToken,
        quoteToken,
        edges: orderedEdges,
        amountInByToken: new Map<string, bigint>(),
      }));
    }
    return Object.freeze({ groups });
  },

  buildStaticSchemaReads(
    input: BuildCurrentBlockReadsInput<DodoV2StateSchema>,
  ): readonly StateRead[] {
    const tokens = uniqueDodoInputTokens(input.edges);
    return Object.freeze(tokens.map((token) =>
      currentBlockRead({
        id: dodoStaticDecimalsReadId(token),
        sourceBlock: input.sourceBlock,
        sourceBlockHash: input.sourceBlockHash,
        to: token,
        data: blockScanErc20Iface.encodeFunctionData("decimals"),
      })
    ));
  },

  hydrateStaticSchema(
    schema: DodoV2StateSchema,
    results: readonly StateReadResult[],
  ): DodoV2StateSchema {
    const oneTokenByAddress = new Map<string, bigint>();
    for (const result of results) {
      if (!result.ok || !result.id.startsWith("dodo-static-decimals:")) {
        throw new Error(`unresolved dodo-v2 static decimals read ${result.id}`);
      }
      const token = result.id.slice("dodo-static-decimals:".length);
      const decimals = Number(
        blockScanErc20Iface.decodeFunctionResult("decimals", result.data)[0],
      );
      if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
        throw new Error(`dodo-v2 token ${token} returned invalid decimals ${decimals}`);
      }
      oneTokenByAddress.set(token, 10n ** BigInt(decimals));
    }

    const groups = new Map<string, DodoV2StateGroup>();
    for (const [stateKey, group] of schema.groups) {
      const amountInByToken = new Map<string, bigint>();
      for (const edge of group.edges) {
        const token = ethers.getAddress(edge.tokenIn).toLowerCase();
        const oneToken = oneTokenByAddress.get(token);
        if (!oneToken) {
          throw new Error(`dodo-v2 static decimals missing ${edge.tokenIn}`);
        }
        amountInByToken.set(token, oneToken);
      }
      groups.set(stateKey, Object.freeze({ ...group, amountInByToken }));
    }
    return Object.freeze({ groups });
  },

  buildCurrentBlockReads(
    input: BuildCurrentBlockReadsInput<DodoV2StateSchema>,
  ): readonly StateRead[] {
    const group = requireDodoGroup(input.schema, input.edges);
    return Object.freeze([
      dodoCurrentRead(input, group, "base-token", "_BASE_TOKEN_"),
      dodoCurrentRead(input, group, "quote-token", "_QUOTE_TOKEN_"),
      dodoCurrentRead(input, group, "pmm-state", "getPMMStateForCall"),
      currentBlockRead({
        id: dodoStateReadId(group.stateKey, "user-fee-rate"),
        sourceBlock: input.sourceBlock,
        sourceBlockHash: input.sourceBlockHash,
        to: group.pool,
        data: dodoV2PoolIface.encodeFunctionData("getUserFeeRate", [
          dodoQuoteActor(),
        ]),
      }),
      currentBlockRead({
        id: dodoStateReadId(group.stateKey, "input-semantics"),
        sourceBlock: input.sourceBlock,
        sourceBlockHash: input.sourceBlockHash,
        to: BLOCKSCAN_MULTICALL3,
        data: encodeMulticall(dodoInputSemanticsItems(group)),
      }),
    ]);
  },

  buildDependentBlockReads(
    input: BuildDependentBlockReadsInput<DodoV2StateSchema>,
  ): readonly StateRead[] {
    if (input.completedRound > 0) return Object.freeze([]);
    const group = requireDodoGroup(input.schema, input.edges);
    const current = decodeDodoCurrentState(group, input.priorResults);
    const fallbackReads: StateRead[] = [];
    for (const edge of group.edges) {
      const selection = selectDodoCurrentQuote(
        group,
        current,
        edge,
      );
      if (typeof selection !== "bigint") continue;
      const sellBase = sameAddress(edge.tokenIn, group.baseToken);
      const inputPosition = sellBase ? current.baseInput : current.quoteInput;
      const effectiveInput = applyDodoTransferToInput(
        inputPosition,
        selection,
        group.pool,
      );
      const local = quoteDodoPmmExactInput({
        state: current.pmm,
        sellBase,
        payAmount: effectiveInput,
        lpFeeRate: current.lpFeeRate,
        mtFeeRate: current.mtFeeRate,
      });
      if (local.status === "quote") continue;
      const queryFunction = sellBase ? "querySellBase" : "querySellQuote";
      fallbackReads.push(currentBlockRead({
        id: dodoFallbackReadId(group.stateKey, edge, effectiveInput),
        sourceBlock: input.sourceBlock,
        sourceBlockHash: input.sourceBlockHash,
        to: group.pool,
        data: dodoV2PoolIface.encodeFunctionData(queryFunction, [
          dodoQuoteActor(),
          effectiveInput,
        ]),
      }));
    }
    return Object.freeze(fallbackReads);
  },

  decodeState(
    schema: DodoV2StateSchema,
    results: readonly StateReadResult[],
  ): DodoV2Snapshot {
    const group = findDodoResultGroup(schema, results);
    const current = decodeDodoCurrentState(group, results);
    const quotes = new Map<string, {
      readonly amountIn: bigint;
      readonly amountOut: bigint;
    }>();
    const unavailable = new Map<string, string>();
    for (const edge of group.edges) {
      const selection = selectDodoCurrentQuote(group, current, edge);
      if (typeof selection !== "bigint") {
        unavailable.set(dodoRouteKey(edge), selection.reason);
        continue;
      }
      const sellBase = sameAddress(edge.tokenIn, group.baseToken);
      const inputPosition = sellBase ? current.baseInput : current.quoteInput;
      const effectiveInput = applyDodoTransferToInput(
        inputPosition,
        selection,
        group.pool,
      );
      const local = quoteDodoPmmExactInput({
        state: current.pmm,
        sellBase,
        payAmount: effectiveInput,
        lpFeeRate: current.lpFeeRate,
        mtFeeRate: current.mtFeeRate,
      });
      let amountOut: bigint;
      if (local.status === "quote") {
        amountOut = local.amountOut;
      } else {
        const fallback = requireRead(
          results,
          dodoFallbackReadId(group.stateKey, edge, effectiveInput),
        );
        const queryFunction = sellBase ? "querySellBase" : "querySellQuote";
        amountOut = decodeFirstWord(
          fallback.data,
          `${queryFunction} ${group.pool}`,
        );
      }
      if (amountOut <= 0n) {
        throw new Error(
          `dodo-v2 current-N quote returned zero for ` +
            `${edge.tokenIn}->${edge.tokenOut}`,
        );
      }
      quotes.set(dodoRouteKey(edge), Object.freeze({
        amountIn: selection,
        amountOut,
      }));
    }
    return Object.freeze({
      stateKey: group.stateKey,
      pmm: current.pmm,
      quotes,
      unavailable,
    });
  },

  deriveMids(
    snapshot: DodoV2Snapshot,
    edges: readonly TokenEdge[],
  ) {
    const availableEdges = edges.filter(
      (edge) => !snapshot.unavailable.has(dodoRouteKey(edge)),
    );
    return midsForDirectedEdges(availableEdges, (edge) => {
      if (canonicalPoolStateKey(edge) !== snapshot.stateKey) {
        throw new Error(
          `dodo-v2 snapshot ${snapshot.stateKey} used for ` +
            `${canonicalPoolStateKey(edge)}`,
        );
      }
      const quote = snapshot.quotes.get(dodoRouteKey(edge));
      if (!quote) {
        throw new Error(`missing dodo-v2 current-N quote for ${dodoRouteKey(edge)}`);
      }
      return quotedPoolMid({
        kind: "external-swap",
        edge,
        amountIn: quote.amountIn,
        amountOut: quote.amountOut,
        depthIn: quote.amountIn * 10_000n,
        depthOut: quote.amountOut * 10_000n,
      });
    });
  },

  behaviorProvenUnavailableEdges(
    snapshot: DodoV2Snapshot,
    edges: readonly TokenEdge[],
  ) {
    const out = new Map<string, string>();
    for (const edge of edges) {
      if (canonicalPoolStateKey(edge) !== snapshot.stateKey) {
        throw new Error(
          `dodo-v2 snapshot ${snapshot.stateKey} used for ` +
            `${canonicalPoolStateKey(edge)}`,
        );
      }
      const reason = snapshot.unavailable.get(dodoRouteKey(edge));
      if (reason) out.set(blockScanEdgeKey(edge), reason);
    }
    return out;
  },

  dependencies(edges: readonly TokenEdge[]): readonly string[] {
    return Object.freeze([
      ...new Set(
        edges.flatMap((edge) => [
          ethers.getAddress(edge.target),
          ethers.getAddress(edge.tokenIn),
          ethers.getAddress(edge.tokenOut),
        ]),
      ),
    ].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase())));
  },
} satisfies BlockScanStateCapability<DodoV2StateSchema, DodoV2Snapshot>);

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
    encodeQuotePrewarm: async (ctx: PreparedRouteContext) => {
      const baseToken = ctx.request.poolToken0 ?? ctx.request.tokenIn;
      const quoteToken = ctx.request.poolToken1 ?? ctx.request.tokenOut;
      return [
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
          to: BLOCKSCAN_MULTICALL3,
          calldata: encodeMulticall(dodoInputSemanticsItemsFor(
            ctx.request.target,
            baseToken,
            quoteToken,
          )),
        },
      ];
    },
    allowanceSpender: () => null,
    prewarmAddresses: (request) => [
      request.target,
      request.tokenIn,
      request.tokenOut,
      BLOCKSCAN_MULTICALL3,
    ],
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
  const queryFunction = sellBase ? "querySellBase" : "querySellQuote";
  const inputRaw = await ctx.state.call({
    to: BLOCKSCAN_MULTICALL3,
    data: encodeMulticall(
      dodoInputSemanticsItemsFor(ctx.target, baseToken, quoteToken),
    ),
  });
  const inputState = decodeDodoInputSemantics(
    inputRaw,
    ctx.target,
    baseToken,
    quoteToken,
  );
  const effectiveInput = applyDodoTransferToInput(
    sellBase ? inputState.baseInput : inputState.quoteInput,
    ctx.amountIn,
    ctx.target,
  );
  const result = await ctx.state.call({
    to: ctx.target,
    data: dodoV2PoolIface.encodeFunctionData(queryFunction, [
      dodoQuoteActor(),
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
  const queryFunction = sellBase ? "querySellBase" : "querySellQuote";
  const inputCall = await ctx.callPrepared(
    BLOCKSCAN_MULTICALL3,
    encodeMulticall(
      dodoInputSemanticsItemsFor(request.target, baseToken, quoteToken),
    ),
  );
  const inputState = decodeDodoInputSemantics(
    inputCall.output,
    request.target,
    baseToken,
    quoteToken,
  );
  const effectiveInput = applyDodoTransferToInput(
    sellBase ? inputState.baseInput : inputState.quoteInput,
    request.amountIn,
    request.target,
  );
  const quoteCall = await ctx.callPrepared(
    request.target,
    dodoV2PoolIface.encodeFunctionData(queryFunction, [
      dodoQuoteActor(),
      effectiveInput,
    ]),
  );
  return {
    amountOut: decodeFirstWord(quoteCall.output, `${queryFunction} ${request.target}`),
    latencyMs: calls[0].latencyMs + calls[1].latencyMs +
      inputCall.latencyMs + quoteCall.latencyMs,
    cacheStats: quoteCall.cacheStats ?? inputCall.cacheStats,
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
    i: BigInt(decoded[0]),
    K: BigInt(decoded[1]),
    B: BigInt(decoded[2]),
    Q: BigInt(decoded[3]),
    B0: BigInt(decoded[4]),
    Q0: BigInt(decoded[5]),
    R: R as DodoPmmState["R"],
  });
}

export function selectDodoBlockScanProbeInput(input: {
  readonly oneToken: bigint;
  readonly currentInput: bigint;
  readonly inputDeficit?: bigint;
  readonly reserve: bigint;
  readonly pmm: DodoPmmState;
  readonly sellBase: boolean;
  readonly pool: string;
}): bigint | BehaviorProvenUnavailableViewQuote {
  const {
    oneToken,
    currentInput,
    inputDeficit = 0n,
    reserve,
    pmm,
    sellBase,
    pool,
  } = input;
  if (currentInput < 0n || inputDeficit < 0n) {
    throw new Error(`dodo-v2 pool ${pool} returned a negative input position`);
  }
  if (currentInput > 0n && inputDeficit > 0n) {
    throw new Error(`dodo-v2 pool ${pool} returned both input surplus and deficit`);
  }
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
  if (crossingCap !== null) {
    if (crossingCap <= 0n || currentInput >= crossingCap) {
      return behaviorProvenUnavailableViewQuote(
        `dodo-v2 pool ${pool} has no positive input before its zero-target branch`,
      );
    }
    const remaining = crossingCap - currentInput;
    const branchProbe = remaining > 1n ? remaining / 2n : remaining;
    if (branchProbe < effectiveProbe) effectiveProbe = branchProbe;
  }
  if (effectiveProbe <= 0n) {
    return behaviorProvenUnavailableViewQuote(
      `dodo-v2 pool ${pool} selected no positive behavior-safe probe`,
    );
  }
  return checkedDodoInput(inputDeficit, effectiveProbe, pool);
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

function dodoQuoteActor(): string {
  const configured = process.env.BOTVM_OWNER?.trim();
  return ethers.getAddress(configured || DEFAULT_SEARCHER_OWNER);
}

function dodoInputSemanticsItems(
  group: DodoV2StateGroup,
): readonly MulticallItem[] {
  return dodoInputSemanticsItemsFor(
    group.pool,
    group.baseToken,
    group.quoteToken,
  );
}

function dodoInputSemanticsItemsFor(
  pool: string,
  baseToken: string,
  quoteToken: string,
): readonly MulticallItem[] {
  const target = ethers.getAddress(pool);
  const base = ethers.getAddress(baseToken);
  const quote = ethers.getAddress(quoteToken);
  return Object.freeze([
    {
      label: "base-balance",
      target: base,
      callData: dodoErc20Iface.encodeFunctionData("balanceOf", [target]),
      allowFailure: false,
    },
    {
      label: "quote-balance",
      target: quote,
      callData: dodoErc20Iface.encodeFunctionData("balanceOf", [target]),
      allowFailure: false,
    },
    {
      label: "base-reserve",
      target,
      callData: dodoV2PoolIface.encodeFunctionData("_BASE_RESERVE_"),
      allowFailure: false,
    },
    {
      label: "quote-reserve",
      target,
      callData: dodoV2PoolIface.encodeFunctionData("_QUOTE_RESERVE_"),
      allowFailure: false,
    },
    {
      label: "base-input",
      target,
      callData: dodoV2PoolIface.encodeFunctionData("getBaseInput"),
      allowFailure: true,
    },
    {
      label: "quote-input",
      target,
      callData: dodoV2PoolIface.encodeFunctionData("getQuoteInput"),
      allowFailure: true,
    },
    {
      label: "mt-fee-total",
      target,
      callData: dodoV2PoolIface.encodeFunctionData("getMtFeeTotal"),
      allowFailure: true,
    },
  ]);
}

function decodeDodoInputSemanticsRead(
  read: Extract<StateReadResult, { readonly ok: true }>,
  pool: string,
  baseToken: string,
  quoteToken: string,
): {
  readonly baseInput: DodoInputPosition;
  readonly quoteInput: DodoInputPosition;
} {
  const items = dodoInputSemanticsItemsFor(pool, baseToken, quoteToken);
  return resolveDodoInputSemantics(decodeMulticall(read, items), pool);
}

function decodeDodoInputSemantics(
  data: string,
  pool: string,
  baseToken: string,
  quoteToken: string,
): {
  readonly baseInput: DodoInputPosition;
  readonly quoteInput: DodoInputPosition;
} {
  const items = dodoInputSemanticsItemsFor(pool, baseToken, quoteToken);
  const decoded = blockScanMulticallIface.decodeFunctionResult(
    "aggregate3",
    data,
  )[0] as readonly { readonly success: boolean; readonly returnData: string }[];
  if (decoded.length !== items.length) {
    throw new Error(
      `dodo-v2 input semantics ${pool} returned ${decoded.length}/${items.length} results`,
    );
  }
  const results = new Map<string, {
    readonly success: boolean;
    readonly returnData: string;
  }>();
  for (let index = 0; index < items.length; index++) {
    results.set(items[index].label, Object.freeze({
      success: Boolean(decoded[index].success),
      returnData: String(decoded[index].returnData),
    }));
  }
  return resolveDodoInputSemantics(results, pool);
}

function resolveDodoInputSemantics(
  results: ReadonlyMap<string, {
    readonly success: boolean;
    readonly returnData: string;
  }>,
  pool: string,
): {
  readonly baseInput: DodoInputPosition;
  readonly quoteInput: DodoInputPosition;
} {
  const baseBalance = decodeFirstWord(
    requireMulticallData(results, "base-balance"),
    `base balance ${pool}`,
  );
  const quoteBalance = decodeFirstWord(
    requireMulticallData(results, "quote-balance"),
    `quote balance ${pool}`,
  );
  const baseReserve = decodeFirstWord(
    requireMulticallData(results, "base-reserve"),
    `base reserve ${pool}`,
  );
  const quoteReserve = decodeFirstWord(
    requireMulticallData(results, "quote-reserve"),
    `quote reserve ${pool}`,
  );
  const mtFeeRaw = optionalMulticallData(results, "mt-fee-total");
  const mtFees = mtFeeRaw === null
    ? null
    : dodoV2PoolIface.decodeFunctionResult("getMtFeeTotal", mtFeeRaw);
  return Object.freeze({
    baseInput: resolveDodoInputPosition({
      pool,
      side: "base",
      balance: baseBalance,
      reserve: baseReserve,
      accumulatedMtFee: mtFees === null ? 0n : BigInt(mtFees[0]),
      getterData: optionalMulticallData(results, "base-input"),
      hasMtFeeLedger: mtFees !== null,
    }),
    quoteInput: resolveDodoInputPosition({
      pool,
      side: "quote",
      balance: quoteBalance,
      reserve: quoteReserve,
      accumulatedMtFee: mtFees === null ? 0n : BigInt(mtFees[1]),
      getterData: optionalMulticallData(results, "quote-input"),
      hasMtFeeLedger: mtFees !== null,
    }),
  });
}

function resolveDodoInputPosition(input: {
  readonly pool: string;
  readonly side: "base" | "quote";
  readonly balance: bigint;
  readonly reserve: bigint;
  readonly accumulatedMtFee: bigint;
  readonly getterData: string | null;
  readonly hasMtFeeLedger: boolean;
}): DodoInputPosition {
  const liability = checkedDodoInput(
    input.reserve,
    input.accumulatedMtFee,
    input.pool,
  );
  if (input.getterData !== null) {
    if (input.balance < liability) {
      throw new Error(
        `dodo-v2 ${input.side} input getter succeeded below its proven liability for pool ${input.pool}`,
      );
    }
    const expected = input.balance - liability;
    const getter = decodeFirstWord(
      input.getterData,
      `${input.side} input ${input.pool}`,
    );
    if (getter !== expected) {
      throw new Error(
        `dodo-v2 ${input.side} input semantics mismatch for pool ${input.pool}: ` +
          `getter=${getter} balance=${input.balance} reserve=${input.reserve} ` +
          `mtFee=${input.accumulatedMtFee}`,
      );
    }
    return Object.freeze({ surplus: getter, deficit: 0n });
  }
  if (input.balance >= liability) {
    throw new Error(
      `dodo-v2 ${input.side} input getter reverted without a proven deficit ` +
        `for ${input.hasMtFeeLedger ? "GSP" : "legacy"} pool ${input.pool}`,
    );
  }
  return Object.freeze({
    surplus: 0n,
    deficit: liability - input.balance,
  });
}

function applyDodoTransferToInput(
  position: DodoInputPosition,
  transferAmount: bigint,
  pool: string,
): bigint {
  if (transferAmount <= position.deficit) {
    throw new Error(
      `dodo-v2 transfer does not clear input deficit for pool ${pool}`,
    );
  }
  return checkedDodoInput(
    position.surplus,
    transferAmount - position.deficit,
    pool,
  );
}

function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function dodoStateReadId(stateKey: string, field: string): string {
  return `dodo:${stateKey}:${field}`;
}

function dodoStaticDecimalsReadId(token: string): string {
  return `dodo-static-decimals:${ethers.getAddress(token).toLowerCase()}`;
}

function dodoFallbackReadId(
  stateKey: string,
  edge: TokenEdge,
  effectiveInput: bigint,
): string {
  return `dodo:${stateKey}:fallback:${dodoRouteKey(edge)}:amount=${effectiveInput}`;
}

function dodoRouteKey(edge: TokenEdge): string {
  return [
    edge.adapterId,
    ethers.getAddress(edge.tokenIn).toLowerCase(),
    ethers.getAddress(edge.tokenOut).toLowerCase(),
  ].join(":");
}

function uniqueDodoInputTokens(edges: readonly TokenEdge[]): string[] {
  return [
    ...new Map(edges.map((edge) => [
      ethers.getAddress(edge.tokenIn).toLowerCase(),
      ethers.getAddress(edge.tokenIn),
    ])).values(),
  ].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
}

function requireDodoGroup(
  schema: DodoV2StateSchema,
  edges: readonly TokenEdge[],
): DodoV2StateGroup {
  if (edges.length === 0) throw new Error("dodo-v2 state group has no edges");
  const stateKey = canonicalPoolStateKey(edges[0]);
  if (edges.some((edge) => canonicalPoolStateKey(edge) !== stateKey)) {
    throw new Error(`dodo-v2 state group ${stateKey} mixes pool targets`);
  }
  const group = schema.groups.get(stateKey);
  if (!group) throw new Error(`missing dodo-v2 state schema ${stateKey}`);
  return group;
}

function findDodoResultGroup(
  schema: DodoV2StateSchema,
  results: readonly StateReadResult[],
): DodoV2StateGroup {
  const matches = [...schema.groups.values()].filter((group) =>
    results.some(
      (result) =>
        result.id === dodoStateReadId(group.stateKey, "pmm-state"),
    )
  );
  if (matches.length !== 1) {
    throw new Error(
      `expected one dodo-v2 result group, found ${matches.length}`,
    );
  }
  return matches[0];
}

function dodoCurrentRead(
  input: {
    readonly sourceBlock: number;
    readonly sourceBlockHash: string;
  },
  group: DodoV2StateGroup,
  field: string,
  functionName:
    | "_BASE_TOKEN_"
    | "_QUOTE_TOKEN_"
    | "getPMMStateForCall"
    | "getBaseInput"
    | "getQuoteInput",
): StateRead {
  return currentBlockRead({
    id: dodoStateReadId(group.stateKey, field),
    sourceBlock: input.sourceBlock,
    sourceBlockHash: input.sourceBlockHash,
    to: group.pool,
    data: dodoV2PoolIface.encodeFunctionData(functionName),
  });
}

function decodeDodoCurrentState(
  group: DodoV2StateGroup,
  results: readonly StateReadResult[],
): DodoDecodedCurrentState {
  const onchainBase = ethers.getAddress(String(
    dodoV2PoolIface.decodeFunctionResult(
      "_BASE_TOKEN_",
      requireRead(
        results,
        dodoStateReadId(group.stateKey, "base-token"),
      ).data,
    )[0],
  ));
  const onchainQuote = ethers.getAddress(String(
    dodoV2PoolIface.decodeFunctionResult(
      "_QUOTE_TOKEN_",
      requireRead(
        results,
        dodoStateReadId(group.stateKey, "quote-token"),
      ).data,
    )[0],
  ));
  if (
    onchainBase !== group.baseToken ||
    onchainQuote !== group.quoteToken
  ) {
    throw new Error(`dodo-v2 pool ${group.pool} token identity changed`);
  }
  const fee = dodoV2PoolIface.decodeFunctionResult(
    "getUserFeeRate",
    requireRead(
      results,
      dodoStateReadId(group.stateKey, "user-fee-rate"),
    ).data,
  );
  const inputSemantics = decodeDodoInputSemanticsRead(
    requireRead(
      results,
      dodoStateReadId(group.stateKey, "input-semantics"),
    ),
    group.pool,
    group.baseToken,
    group.quoteToken,
  );
  return Object.freeze({
    pmm: decodeDodoPmmState(
      requireRead(
        results,
        dodoStateReadId(group.stateKey, "pmm-state"),
      ).data,
    ),
    lpFeeRate: BigInt(fee[0]),
    mtFeeRate: BigInt(fee[1]),
    baseInput: inputSemantics.baseInput,
    quoteInput: inputSemantics.quoteInput,
  });
}

function selectDodoCurrentQuote(
  group: DodoV2StateGroup,
  current: DodoDecodedCurrentState,
  edge: TokenEdge,
): bigint | BehaviorProvenUnavailableViewQuote {
  const sellBase = sameAddress(edge.tokenIn, group.baseToken);
  const oneToken = group.amountInByToken.get(
    ethers.getAddress(edge.tokenIn).toLowerCase(),
  );
  if (!oneToken) {
    throw new Error(`dodo-v2 static amount missing ${edge.tokenIn}`);
  }
  return selectDodoBlockScanProbeInput({
    oneToken,
    currentInput: sellBase
      ? current.baseInput.surplus
      : current.quoteInput.surplus,
    inputDeficit: sellBase
      ? current.baseInput.deficit
      : current.quoteInput.deficit,
    reserve: sellBase ? current.pmm.B : current.pmm.Q,
    pmm: current.pmm,
    sellBase,
    pool: group.pool,
  });
}
