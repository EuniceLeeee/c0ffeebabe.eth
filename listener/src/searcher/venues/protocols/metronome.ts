import { ethers } from "ethers";
import { ADDR } from "../../../shared/constants/addresses.js";
import { isStateCallAbortedError } from "../../../shared/state/state-backend.js";
import { deriveEdgeTaxonomy } from "../../strategy-taxonomy.js";
import type { PoolEntry, TokenEdge, TokenQueryBackend } from "../../planner/token-graph.js";
import type {
  ExactQuoteContext,
  PlanBuildContext,
  PlanFragment,
  PreparedRouteContext,
  ProtocolConversionAdapter,
} from "../route-leg-adapter.js";
import type { BlockScanStateCapability } from "../blockscan-state-capability.js";
import { blockScanEdgeKey } from "../blockscan-state-capability.js";
import { quoteCurvePlain } from "../swaps/curve-shared.js";
import { buildDescriptorProtocolPlan } from "./protocol-plan.js";
import {
  metronomeSynthPoolIface,
  quoteMetronomeSynthSwap,
  quoteProtocolLeg,
} from "./protocol-quote.js";
import {
  createProtocolQuoteStateCapability,
  decodeUintResult,
  oneTokenAmount,
  protocolMid,
  quoteReadId,
  requiredResult,
  stateRead,
  successfulResultMap,
  tokenDecimalsStateRead,
  type ProtocolQuoteSnapshot,
} from "./protocol-state-framework.js";

const SYNTH_TOKENS = [ADDR.MSETH, ADDR.MSBTC, ADDR.MSUSD] as const;
const synthPoolDiscoveryIface = new ethers.Interface([
  "function doesSyntheticTokenExist(address syntheticToken) view returns (bool)",
]);
const hgusdcVaultIface = new ethers.Interface([
  "function asset() view returns (address)",
  "function previewRedeem(uint256 shares) view returns (uint256 assets)",
]);
const metronomeCurvePricingIface = new ethers.Interface([
  "function get_dy(int128 i, int128 j, uint256 dx) view returns (uint256)",
]);

const metronomeSynthPricingState = createProtocolQuoteStateCapability({
  familyId: "protocol:metronome-synth",
  edgeAdapterIds: ["metronome-synth-swap"],
  buildQuoteReads(edge, amountIn) {
    return [{
      suffix: "swap",
      to: edge.target,
      data: metronomeSynthPoolIface.encodeFunctionData("quoteSwapOut", [
        edge.tokenIn,
        edge.tokenOut,
        amountIn,
      ]),
    }];
  },
  deriveAmountOut(_edge, _amountIn, result) {
    return decodeUintResult(
      metronomeSynthPoolIface,
      "quoteSwapOut",
      result("swap"),
    );
  },
});

interface MetronomeHgusdcSchema {
  readonly familyId: "protocol:metronome-hgusdc";
  readonly amountInByToken: ReadonlyMap<string, bigint>;
}

const metronomeHgusdcPricingStateDefinition: BlockScanStateCapability<
  MetronomeHgusdcSchema,
  ProtocolQuoteSnapshot
> = {
  stateKey(edge) {
    requireHgusdcEdge(edge);
    return edge.target.toLowerCase();
  },
  compileStaticSchema({ edges, deadlineAtMs, signal }) {
    if (signal.aborted) {
      throw signal.reason instanceof Error ? signal.reason : new Error("Metronome pricing aborted");
    }
    if (Date.now() >= deadlineAtMs) throw new Error("Metronome pricing schema deadline expired");
    for (const edge of edges) requireHgusdcEdge(edge);
    return Object.freeze({
      familyId: "protocol:metronome-hgusdc" as const,
      amountInByToken: new Map<string, bigint>(),
    });
  },
  buildStaticSchemaReads(input) {
    requireHgusdcSchema(input.schema);
    const [edge] = input.edges;
    requireHgusdcEdge(edge);
    return Object.freeze([tokenDecimalsStateRead(input, edge.tokenIn)]);
  },
  hydrateStaticSchema(schema, results) {
    const [result] = results;
    if (!result?.ok) throw new Error("Metronome hgUSDC decimals unresolved");
    const resultMap = successfulResultMap(results);
    const token = result.id.slice("decimals:".length);
    return Object.freeze({
      ...schema,
      amountInByToken: new Map([[token, oneTokenAmount(resultMap, token)]]),
    });
  },
  buildCurrentBlockReads(input) {
    requireHgusdcSchema(input.schema);
    const [edge] = input.edges;
    requireHgusdcEdge(edge);
    const amountIn = requireStaticAmount(input.schema, edge.tokenIn);
    return Object.freeze([stateRead(
      input,
      quoteReadId(edge, "curve"),
      ADDR.CURVE_MSUSD_FRXUSD,
      // This pool's immutable coin order is frxUSD(0), msUSD(1); the
      // deployed pool uses the int128 get_dy selector.
      metronomeCurvePricingIface.encodeFunctionData("get_dy", [1n, 0n, amountIn]),
    )]);
  },
  buildDependentBlockReads(input) {
    requireHgusdcSchema(input.schema);
    const [edge] = input.edges;
    requireHgusdcEdge(edge);
    const results = successfulResultMap(input.priorResults);
    if (input.completedRound === 0) {
      const curveOut = decodeUintResult(
        metronomeCurvePricingIface,
        "get_dy",
        requiredResult(results, quoteReadId(edge, "curve")),
      );
      return Object.freeze([stateRead(
        input,
        quoteReadId(edge, "redeem"),
        ADDR.HGUSDC,
        hgusdcVaultIface.encodeFunctionData("previewRedeem", [curveOut]),
      )]);
    }
    return Object.freeze([]);
  },
  decodeState(schema, results) {
    return Object.freeze({
      results: successfulResultMap(results),
      amountInByToken: schema.amountInByToken,
    });
  },
  deriveMids(snapshot, edges) {
    const mids = new Map();
    for (const edge of edges) {
      requireHgusdcEdge(edge);
      const amountIn = snapshot.amountInByToken.get(edge.tokenIn.toLowerCase());
      if (!amountIn) throw new Error(`Metronome static amount missing ${edge.tokenIn}`);
      const amountOut = decodeUintResult(
        hgusdcVaultIface,
        "previewRedeem",
        requiredResult(snapshot.results, quoteReadId(edge, "redeem")),
      );
      mids.set(blockScanEdgeKey(edge), protocolMid(edge, amountIn, amountOut));
    }
    return mids;
  },
  dependencies(edges) {
    for (const edge of edges) requireHgusdcEdge(edge);
    return Object.freeze([
      ADDR.METRONOME_HGUSDC_ROUTER.toLowerCase(),
      ADDR.CURVE_MSUSD_FRXUSD.toLowerCase(),
      ADDR.HGUSDC.toLowerCase(),
      ADDR.MSUSD.toLowerCase(),
      ADDR.USDC.toLowerCase(),
    ]);
  },
};
const metronomeHgusdcPricingState = Object.freeze(
  metronomeHgusdcPricingStateDefinition,
);

export const metronomeSynthAdapter = Object.freeze({
  id: "protocol:metronome-synth",
  kind: "protocol-conversion",
  oracleVictim: {
    id: "metronome-eth-usd",
    modelId: "oracle-rawtx:metronome",
    matcher: {
      kind: "forwarded",
      forwarder: ADDR.METRONOME_ORACLE_FORWARDER,
      signature: "forward(address target, bytes data)",
      targetArg: 0,
      dataArg: 1,
      target: ADDR.METRONOME_ORACLE,
      selectors: ["0xb1dc65a4"],
    },
    affectedEdges: [{
      adapterId: "metronome-synth-swap",
      target: ADDR.METRONOME_SYNTH_POOL,
    }],
    priceProbe: {
      signature:
        "quoteSwapOut(address syntheticTokenIn, address syntheticTokenOut, uint256 amountIn) " +
        "view returns (uint256 amountOut, uint256 fee)",
      functionName: "quoteSwapOut",
      amountIn: 10n ** 18n,
      outputIndex: 0,
    },
    maxSearchHops: 8,
  },
  poolAdapters: ["metronome-synth"],
  identityPolicies: [{
    poolAdapter: "metronome-synth",
    policy: "trusted-singleton-seed",
  }],
  declaredVenues: [{
    address: ADDR.METRONOME_SYNTH_POOL,
    adapter: "metronome-synth",
  }],
  undeclaredVenueReason: null,
  edgeAdapterIds: ["metronome-synth-swap"],
  allowedTaxonomy: [{ slotKind: "protocol", protocolAction: "convert" }],
  requiresProtocolEdgesFlag: true,
  ownedActionAdapterIds: ["metronome-synth-swap"],
  requiredInfraActionAdapterIds: ["erc20-approve"],
  pricingState: metronomeSynthPricingState,
  prepared: {
    quote: async (ctx: PreparedRouteContext) => {
      const quoted = await ctx.callPrepared(
        ctx.request.target,
        metronomeSynthPoolIface.encodeFunctionData("quoteSwapOut", [
          ctx.request.tokenIn,
          ctx.request.tokenOut,
          ctx.request.amountIn,
        ]),
        { gasLimit: 1_000_000 },
      );
      return {
        amountOut: BigInt(
          metronomeSynthPoolIface.decodeFunctionResult("quoteSwapOut", quoted.output)[0],
        ),
        latencyMs: quoted.latencyMs,
        cacheStats: quoted.cacheStats,
      };
    },
    quoteUnsupportedReason: null,
    encodeQuotePrewarm: async (ctx: PreparedRouteContext) => [{
      from: ethers.ZeroAddress,
      to: ctx.request.target,
      calldata: metronomeSynthPoolIface.encodeFunctionData("quoteSwapOut", [
        ctx.request.tokenIn,
        ctx.request.tokenOut,
        ctx.request.amountIn,
      ]),
      gasLimit: 1_000_000,
    }],
    allowanceSpender: (request) => ethers.getAddress(request.target),
    prewarmAddresses: () => [],
  },
  async buildEdges(pool: PoolEntry, backend: TokenQueryBackend): Promise<TokenEdge[]> {
    const synths = await queryMetronomeSynths(backend, pool.address);
    const edges: TokenEdge[] = [];
    for (let i = 0; i < synths.length; i++) {
      for (let j = 0; j < synths.length; j++) {
        if (i === j) continue;
        edges.push({
          adapterId: "metronome-synth-swap", target: pool.address,
          tokenIn: synths[i], tokenOut: synths[j],
          slotKind: "protocol", protocolAction: "convert", score: pool.score,
          ...deriveEdgeTaxonomy("protocol", "convert"),
        });
      }
    }
    return edges;
  },
  async quoteExact(ctx: ExactQuoteContext): Promise<bigint> {
    if (!ctx.tokenIn || !ctx.tokenOut) throw new Error("metronome quote requires tokenIn/tokenOut");
    return quoteMetronomeSynthSwap(ctx.state, ctx.target, ctx.tokenIn, ctx.tokenOut, ctx.amountIn);
  },
  buildPlanFragment: buildDescriptorProtocolPlan,
} satisfies ProtocolConversionAdapter);

export const metronomeHgusdcAdapter = Object.freeze({
  id: "protocol:metronome-hgusdc",
  kind: "protocol-conversion",
  poolAdapters: ["metronome-hgusdc"],
  identityPolicies: [{
    poolAdapter: "metronome-hgusdc",
    policy: "trusted-singleton-seed",
  }],
  declaredVenues: [{
    address: ADDR.METRONOME_HGUSDC_ROUTER,
    adapter: "metronome-hgusdc",
    receiptEmitters: [ADDR.HGUSDC],
    fixedTokenIn: ADDR.MSUSD,
    fixedTokenOut: ADDR.USDC,
    fixedSlotKind: "protocol",
    fixedProtocolAction: "redeem",
  }],
  undeclaredVenueReason: null,
  edgeAdapterIds: ["metronome-hgusdc-exit"],
  allowedTaxonomy: [{ slotKind: "protocol", protocolAction: "redeem" }],
  requiresProtocolEdgesFlag: true,
  ownedActionAdapterIds: ["metronome-hgusdc-exit"],
  requiredInfraActionAdapterIds: ["erc20-transfer"],
  pricingState: metronomeHgusdcPricingState,
  prepared: null,
  async buildEdges(pool: PoolEntry, backend: TokenQueryBackend): Promise<TokenEdge[]> {
    if (!pool.fixedTokenIn || !pool.fixedTokenOut) {
      throw new Error(`metronome-hgusdc pool ${pool.address} missing fixed token metadata`);
    }
    // The exit quote treats hgUSDC previewRedeem output as the edge's tokenOut
    // amount, which is only sound while the vault's asset is that token.
    const raw = await backend.call({
      to: ADDR.HGUSDC,
      data: hgusdcVaultIface.encodeFunctionData("asset"),
    });
    const reported = String(hgusdcVaultIface.decodeFunctionResult("asset", raw)[0]);
    if (reported.toLowerCase() !== pool.fixedTokenOut.toLowerCase()) {
      throw new Error(`metronome-hgusdc identity attestation failed: hgUSDC reports asset ${reported}`);
    }
    return [{
      adapterId: "metronome-hgusdc-exit", target: pool.address,
      tokenIn: ethers.getAddress(pool.fixedTokenIn), tokenOut: ethers.getAddress(pool.fixedTokenOut),
      slotKind: "protocol", protocolAction: "redeem", score: pool.score,
      ...deriveEdgeTaxonomy("protocol", "redeem"),
    }];
  },
  async quoteExact(ctx: ExactQuoteContext): Promise<bigint> {
    let frxUsdOut: bigint;
    if (ctx.cache) {
      try {
        frxUsdOut = await ctx.cache.quoteCurve(
          ctx.state, ADDR.CURVE_MSUSD_FRXUSD, ADDR.MSUSD, ADDR.FRXUSD, ctx.amountIn,
        );
      } catch (error) {
        if (isStateCallAbortedError(error)) throw error;
        frxUsdOut = await quoteCurvePlain(
          ctx.state, ADDR.CURVE_MSUSD_FRXUSD, ADDR.MSUSD, ADDR.FRXUSD, ctx.amountIn,
        );
      }
    } else {
      frxUsdOut = await quoteCurvePlain(
        ctx.state, ADDR.CURVE_MSUSD_FRXUSD, ADDR.MSUSD, ADDR.FRXUSD, ctx.amountIn,
      );
    }
    return quoteProtocolLeg(ctx.state, ADDR.HGUSDC, "erc4626-redeem", frxUsdOut);
  },
  async buildPlanFragment(ctx: PlanBuildContext): Promise<PlanFragment> {
    return {
      requirements: [{
        kind: "transfer-to-pool",
        token: ctx.edge.tokenIn,
        pool: ADDR.CURVE_MSUSD_FRXUSD,
        amount: ctx.amountIn,
      }],
      nodes: [{
        adapterId: "metronome-hgusdc-exit", target: ctx.edge.target,
        tokenIn: ctx.edge.tokenIn, tokenOut: ctx.edge.tokenOut,
        amount: ctx.amountIn, params: {}, children: [],
      }],
    };
  },
} satisfies ProtocolConversionAdapter);

async function queryMetronomeSynths(
  backend: TokenQueryBackend,
  pool: string,
): Promise<string[]> {
  const out: string[] = [];
  for (const synth of SYNTH_TOKENS) {
    const result = await backend.call({
      to: pool,
      data: synthPoolDiscoveryIface.encodeFunctionData("doesSyntheticTokenExist", [synth]),
    });
    if (Boolean(synthPoolDiscoveryIface.decodeFunctionResult("doesSyntheticTokenExist", result)[0])) {
      out.push(ethers.getAddress(synth));
    }
  }
  if (out.length < 2) throw new Error(`metronome synth pool ${pool} has fewer than two known synths`);
  return out;
}

function requireHgusdcEdge(edge: TokenEdge | undefined): asserts edge is TokenEdge {
  if (
    !edge ||
    edge.adapterId !== "metronome-hgusdc-exit" ||
    edge.target.toLowerCase() !== ADDR.METRONOME_HGUSDC_ROUTER.toLowerCase() ||
    edge.tokenIn.toLowerCase() !== ADDR.MSUSD.toLowerCase() ||
    edge.tokenOut.toLowerCase() !== ADDR.USDC.toLowerCase()
  ) {
    throw new Error("invalid Metronome hgUSDC pricing edge");
  }
}

function requireHgusdcSchema(schema: MetronomeHgusdcSchema): void {
  if (schema.familyId !== "protocol:metronome-hgusdc") {
    throw new Error("Metronome hgUSDC pricing schema mismatch");
  }
}

function requireStaticAmount(
  schema: MetronomeHgusdcSchema,
  token: string,
): bigint {
  const amount = schema.amountInByToken.get(token.toLowerCase());
  if (!amount || amount <= 0n) {
    throw new Error(`Metronome hgUSDC schema lacks decimals for ${token}`);
  }
  return amount;
}
