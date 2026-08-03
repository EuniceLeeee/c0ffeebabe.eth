import { ethers } from "ethers";
import { ADDR } from "../../../shared/constants/addresses.js";
import {
  isStateCallAbortedError,
  type StateBackend,
} from "../../../shared/state/state-backend.js";
import { discoverErc20BalanceStorageSlot } from "../../protocol-discovery-erc20-state.js";
import { deriveEdgeTaxonomy } from "../../strategy-taxonomy.js";
import type { PoolEntry, TokenEdge, TokenQueryBackend } from "../../planner/token-graph.js";
import type {
  ExactQuoteContext,
  AttestedProtocolInstance,
  PlanBuildContext,
  PlanFragment,
  PreparedRouteContext,
  PreparedRouteQuoteResult,
  ProtocolDiscoveryCapability,
  ProtocolDiscoveryContext,
  SwapAdapter,
} from "../route-leg-adapter.js";
import {
  isRetryablePoolIdentityFailure,
  type OnchainIdentityResolver,
} from "../identity.js";
import { createAddressLandedPoolMaterializer } from "../landed-pool-discovery.js";
import {
  createStrictSwapObservation,
  type SwapEventLog,
  type SwapObservationCapability,
} from "../swap-observation.js";
import {
  ADDRESS_LANDED_EVENT_EMITTER,
  defineSwapLandedEvents,
} from "../landed-event-registry.js";
import { currentBlockRead } from "./blockscan-state-shared.js";
import {
  createCurrentBlockViewQuoteCapability,
  quoteReadId,
} from "./view-quote-blockscan-state.js";

const FLUID_DEX_RESOLVER_ENV = "FLUID_DEX_RESOLVER";
export const FLUID_DEX_ADDRESS_DEAD =
  "0x000000000000000000000000000000000000dEaD";
export const FLUID_DEX_SWAP_TOPIC =
  "0xdc004dbca4ef9c966218431ee5d9133d337ad018dd5b5c5493722803f75c64f7";
const fluidDexLandedEvents = defineSwapLandedEvents({
  swaps: [{
    id: "fluid-dex-swap",
    topic: FLUID_DEX_SWAP_TOPIC,
    emitter: ADDRESS_LANDED_EVENT_EMITTER,
    materialization: "family",
    discovery: { poolAdapter: "fluid-dex", label: "fluid" },
    invalidatesWarmState: true,
  }],
  mutations: [],
});

export const fluidDexSwapIface = new ethers.Interface([
  "function swapIn(bool swap0to1_, uint256 amountIn_, uint256 amountOutMin_, address to_) payable returns (uint256 amountOut_)",
  "error FluidDexSwapResult(uint256 amountOut)",
]);

const fluidDexIdentityIface = new ethers.Interface([
  "function constantsView() view returns ((uint256 dexId,address liquidity,address factory,(address shift,address admin,address colOperations,address debtOperations,address perfectOperationsAndSwapOut) implementations,address deployerContract,address token0,address token1,bytes32 supplyToken0Slot,bytes32 borrowToken0Slot,bytes32 supplyToken1Slot,bytes32 borrowToken1Slot,bytes32 exchangePriceToken0Slot,bytes32 exchangePriceToken1Slot,uint256 oracleMapping) constantsView_)",
]);
const fluidDexFactoryIface = new ethers.Interface([
  "function getDexAddress(uint256 dexId) view returns (address)",
]);
const erc20ProbeIface = new ethers.Interface([
  "function approve(address spender,uint256 amount) returns (bool)",
  "function balanceOf(address owner) view returns (uint256)",
  "function decimals() view returns (uint8)",
]);
const IMPLEMENTATION_SLOT = BigInt(
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc",
);
const FLUID_DEX_PROBE_HOLDER = ethers.getAddress(`0x${"00".repeat(18)}f1d1`);

interface FluidDexConstants {
  readonly dexId: bigint;
  readonly factory: string;
  readonly token0: string;
  readonly token1: string;
}

const fluidDexPoolDiscovery = createAddressLandedPoolMaterializer({
  version: "fluid-dex-address-metadata-v1",
  eventIds: ["fluid-dex-swap"],
  async materializePool(candidate, context) {
    const constants = await readFluidDexConstants(
      context.backend,
      candidate.address,
    );
    if (!fluidDexConstantsAreSane(constants)) return null;
    const identity = await fluidDexIdentityResolver({
      backend: context.backend,
      pool: candidate.address,
      poolAdapter: "fluid-dex",
      candidate: {
        address: candidate.address,
        adapter: "fluid-dex",
        token0: constants.token0,
        token1: constants.token1,
      },
      admissionPolicy: context.admissionPolicy,
      isPoolAdapterSupported: (poolAdapter) => poolAdapter === "fluid-dex",
    });
    if (!identity.ok) {
      if (isRetryablePoolIdentityFailure(identity.reason)) {
        throw new Error(`Fluid DEX identity read incomplete: ${identity.reason}`);
      }
      return null;
    }
    return {
      address: candidate.address,
      adapter: identity.adapter,
      venueId: identity.venueId,
      identitySource: identity.identitySource,
      ...(identity.factory === undefined ? {} : { factory: identity.factory }),
      token0: constants.token0,
      token1: constants.token1,
    };
  },
});

export const fluidDexDiscovery: ProtocolDiscoveryCapability = Object.freeze({
  candidateSources: Object.freeze(["dex-token-domain"] as const),
  candidateAddressHints: Object.freeze([ADDR.FLUID_DEX_USDC_USDT]),
  eventTopics: Object.freeze([]),
  callSelectors: Object.freeze([]),
  addressMatcherVersion: "fluid-dex-constants-factory-v1",
  async candidateFromAddress(candidate, context) {
    try {
      const constants = await readFluidDexConstants(context.backend, candidate.target);
      if (!fluidDexConstantsAreSane(constants)) return null;
      return {
        pool: {
          address: ethers.getAddress(candidate.target),
          adapter: "fluid-dex",
          token0: constants.token0,
          token1: constants.token1,
        },
        source: "fluid-dex-address-hint",
        evidence: [{
          kind: "fluid-dex-constants",
          dexId: constants.dexId,
          factory: constants.factory,
          token0: constants.token0,
          token1: constants.token1,
        }],
      };
    } catch (error) {
      if (isPermanentFluidSurfaceFailure(error)) return null;
      throw error;
    }
  },
  async probeCandidate(instance, context) {
    return probeFluidDexCandidate(instance, context);
  },
} satisfies ProtocolDiscoveryCapability);

export const fluidDexIdentityResolver: OnchainIdentityResolver = async ({
  backend,
  pool,
  poolAdapter,
  candidate,
}) => {
  if (poolAdapter !== "fluid-dex") {
    throw new Error(`fluid-dex identity: unsupported pool adapter ${poolAdapter}`);
  }
  try {
    const constants = await readFluidDexConstants(backend, pool);
    if (!fluidDexConstantsAreSane(constants)) {
      return { ok: false, reason: "behavior_mismatch" };
    }
    if (
      candidate.token0?.toLowerCase() !== constants.token0.toLowerCase() ||
      candidate.token1?.toLowerCase() !== constants.token1.toLowerCase()
    ) {
      return { ok: false, reason: "behavior_mismatch" };
    }
    const registered = await backend.call({
      to: constants.factory,
      data: fluidDexFactoryIface.encodeFunctionData("getDexAddress", [constants.dexId]),
    });
    const registeredAddress = ethers.getAddress(String(
      fluidDexFactoryIface.decodeFunctionResult("getDexAddress", registered)[0],
    ));
    if (registeredAddress.toLowerCase() !== ethers.getAddress(pool).toLowerCase()) {
      return { ok: false, reason: "behavior_mismatch" };
    }
    if (!backend.getCode) return { ok: false, reason: "identity_call_failed" };
    const [token0Code, token1Code] = await Promise.all([
      backend.getCode(constants.token0),
      backend.getCode(constants.token1),
    ]);
    if (token0Code === "0x" || token1Code === "0x") {
      return { ok: false, reason: "behavior_mismatch" };
    }
    return {
      ok: true,
      adapter: "fluid-dex",
      venueId: "fluid",
      factory: constants.factory,
      identitySource: "fluid-dex-factory-behavior",
    };
  } catch (error) {
    return {
      ok: false,
      reason: isPermanentFluidSurfaceFailure(error)
        ? "behavior_mismatch"
        : "identity_call_failed",
    };
  }
};

export const fluidDexResolverIface = new ethers.Interface([
  "function estimateSwapIn(address dex_, bool swap0to1_, uint256 amountIn_, uint256 amountOutMin_) payable returns (uint256 amountOut_)",
]);

const fluidDexObservation: SwapObservationCapability =
  createStrictSwapObservation({
  topics: Object.freeze([FLUID_DEX_SWAP_TOPIC]),
  // This is a singleton deployment admission, not a claim that every contract
  // emitting the observed topic is a Fluid pool.
  canonicalIntakeTargets: Object.freeze([]),
  observedPoolIdentity(log: SwapEventLog) {
    return log.address.toLowerCase();
  },
  async decodeSwapImpacts() {
    // The public event ABI is unavailable. The receipt-level detector's
    // paired-transfer fallback remains the exact baseline behavior until a
    // fixture proves a dedicated decoder.
    return [];
  },
});

interface FluidDexStateSchema {
  readonly pool: string;
  readonly token0: string;
  readonly token1: string;
}

export const fluidDexBlockScanState = Object.freeze({
  ...createCurrentBlockViewQuoteCapability<FluidDexStateSchema>({
    kind: "external-swap",
    edgeAdapterIds: new Set(["fluid-dex-swap"]),
    compileGroup(edges) {
      const pool = ethers.getAddress(edges[0].target).toLowerCase();
      const first = edges[0];
      if (!first.poolToken0 || !first.poolToken1) {
        throw new Error(`fluid-dex block-scan pool ${pool} is missing token order`);
      }
      const token0 = ethers.getAddress(first.poolToken0);
      const token1 = ethers.getAddress(first.poolToken1);
      for (const edge of edges) {
        if (
          ethers.getAddress(edge.target).toLowerCase() !== pool ||
          edge.poolToken0?.toLowerCase() !== token0.toLowerCase() ||
          edge.poolToken1?.toLowerCase() !== token1.toLowerCase()
        ) {
          throw new Error(`fluid-dex block-scan pool ${pool} has inconsistent metadata`);
        }
        fluidDexSwap0To1(
          edge.tokenIn,
          edge.tokenOut,
          token0,
          token1,
        );
      }
      return Object.freeze({ pool, token0, token1 });
    },
    quoteRead(ctx) {
      const swap0to1 = fluidDexSwap0To1(
        ctx.edge.tokenIn,
        ctx.edge.tokenOut,
        ctx.static.token0,
        ctx.static.token1,
      );
      const resolver = configuredFluidDexResolver();
      return currentBlockRead({
        id: quoteReadId(ctx.stateKey, ctx.edge),
        sourceBlock: ctx.sourceBlock,
        sourceBlockHash: ctx.sourceBlockHash,
        to: resolver ?? ctx.static.pool,
        data: resolver
          ? fluidDexResolverIface.encodeFunctionData("estimateSwapIn", [
              ctx.static.pool,
              swap0to1,
              ctx.amountIn,
              0n,
            ])
          : fluidDexSwapIface.encodeFunctionData("swapIn", [
              swap0to1,
              ctx.amountIn,
              0n,
              FLUID_DEX_ADDRESS_DEAD,
            ]),
        transport: "rpc-batch",
        acceptRevertData: resolver === null,
      });
    },
    decodeQuote(_edge, data) {
      return decodeFluidDexQuoteResult(
        data,
        configuredFluidDexResolver() === null
          ? "address-dead-revert"
          : "resolver-return",
      );
    },
    dependencies(group) {
      const resolver = configuredFluidDexResolver();
      return Object.freeze([
        group.static.pool,
        ...(resolver ? [resolver.toLowerCase()] : []),
      ]);
    },
  }),
});

export const fluidDexAdapter = Object.freeze({
  id: "fluid-dex",
  kind: "swap",
  poolAdapters: ["fluid-dex"],
  routeIdentity: {
    instanceKey(pool: PoolEntry) {
      if (!pool.token0 || !pool.token1) {
        throw new Error("fluid-dex route identity requires token order");
      }
      return JSON.stringify([
        pool.address.toLowerCase(),
        pool.token0.toLowerCase(),
        pool.token1.toLowerCase(),
        pool.logicalInstanceId ?? null,
      ]);
    },
    executionVariantKey(edge: TokenEdge) {
      if (!edge.poolToken0 || !edge.poolToken1) {
        throw new Error("fluid-dex execution identity requires token order");
      }
      return JSON.stringify([
        edge.adapterId,
        edge.poolToken0.toLowerCase(),
        edge.poolToken1.toLowerCase(),
      ]);
    },
  },
  identityPolicies: [{ poolAdapter: "fluid-dex", policy: "trusted-singleton-seed" }],
  edgeAdapterIds: ["fluid-dex-swap"],
  allowedTaxonomy: [{ slotKind: "swap" }],
  requiresProtocolEdgesFlag: false,
  ownedActionAdapterIds: ["fluid-dex-swap"],
  requiredInfraActionAdapterIds: ["erc20-approve"],
  landedEvents: fluidDexLandedEvents,
  poolDiscovery: fluidDexPoolDiscovery,
  observation: fluidDexObservation,
  victimModel: {
    id: "pool-swap:fluid-dex-detect-only",
    mode: "detect-only",
  },
  pricingState: fluidDexBlockScanState,
  discovery: fluidDexDiscovery,
  discoveryIdentityResolver: fluidDexIdentityResolver,
  discoveryIdentityAuthority: { class: "canonical-onchain", strength: 300 },
  prepared: {
    quote: quoteFluidDexPrepared,
    quoteUnsupportedReason: null,
    encodeQuotePrewarm: async (ctx: PreparedRouteContext) => [{
      from: ethers.ZeroAddress,
      to: ctx.request.target,
      calldata: fluidDexSwapIface.encodeFunctionData("swapIn", [
        fluidDexSwap0To1(
          ctx.request.tokenIn,
          ctx.request.tokenOut,
          ctx.request.poolToken0 ?? ctx.edge?.poolToken0,
          ctx.request.poolToken1 ?? ctx.edge?.poolToken1,
        ),
        ctx.request.amountIn,
        0n,
        FLUID_DEX_ADDRESS_DEAD,
      ]),
      gasLimit: 3_000_000,
    }],
    allowanceSpender: (request) => ethers.getAddress(request.target),
    prewarmAddresses: (request) => [request.target, request.tokenIn],
  },
  buildEdges: buildFluidDexEdges,
  quoteExact: quoteFluidDexExact,
  buildPlanFragment: buildFluidDexPlanFragment,
} satisfies SwapAdapter);

async function buildFluidDexEdges(
  pool: PoolEntry,
  backend: TokenQueryBackend,
): Promise<TokenEdge[]> {
  if (!pool.token0 || !pool.token1) {
    throw new Error(`fluid-dex pool ${pool.address} missing token0/token1 metadata`);
  }
  if (!pool.verifiedRoutes || pool.verifiedRoutes.length !== 2) {
    throw new Error(`fluid-dex pool ${pool.address} lacks exact discovery routes`);
  }
  const current = await readFluidDexConstants(backend, pool.address);
  const token0 = ethers.getAddress(pool.token0);
  const token1 = ethers.getAddress(pool.token1);
  if (
    current.token0.toLowerCase() !== token0.toLowerCase() ||
    current.token1.toLowerCase() !== token1.toLowerCase()
  ) {
    throw new Error(`fluid-dex pool ${pool.address} token order changed`);
  }
  const edges = fluidDexEdges(pool.address, token0, token1, pool.score);
  assertExactFluidDexRoutes(pool, edges);
  return edges;
}

function fluidDexEdges(
  target: string,
  token0: string,
  token1: string,
  score?: number,
): TokenEdge[] {
  const taxonomy = deriveEdgeTaxonomy("swap");
  return [
    {
      adapterId: "fluid-dex-swap",
      target: ethers.getAddress(target),
      tokenIn: token0,
      tokenOut: token1,
      slotKind: "swap",
      poolToken0: token0,
      poolToken1: token1,
      score,
      ...taxonomy,
    },
    {
      adapterId: "fluid-dex-swap",
      target: ethers.getAddress(target),
      tokenIn: token1,
      tokenOut: token0,
      slotKind: "swap",
      poolToken0: token0,
      poolToken1: token1,
      score,
      ...taxonomy,
    },
  ];
}

export async function probeFluidDexCandidate(
  instance: AttestedProtocolInstance,
  context: ProtocolDiscoveryContext,
): Promise<readonly TokenEdge[]> {
  const target = ethers.getAddress(instance.pool.address);
  const constants = await readFluidDexConstants(context.backend, target);
  if (
    instance.pool.token0?.toLowerCase() !== constants.token0.toLowerCase() ||
    instance.pool.token1?.toLowerCase() !== constants.token1.toLowerCase()
  ) {
    throw new Error("fluid-dex token order changed after identity attestation");
  }
  const graphTokens = new Set(context.graphTokens.map((token) => token.toLowerCase()));
  if (
    !graphTokens.has(constants.token0.toLowerCase()) ||
    !graphTokens.has(constants.token1.toLowerCase())
  ) {
    throw new Error("fluid-dex pair is not loop-closable from the current DEX token domain");
  }
  if (!context.backend.simulateCalls) {
    throw new Error("fluid-dex active proof requires block-pinned simulation");
  }
  const [zeroToOne, oneToZero] = await Promise.all([
    proveFluidDexSwap(context, target, constants.token0, constants.token1, true),
    proveFluidDexSwap(context, target, constants.token1, constants.token0, false),
  ]);
  if (!zeroToOne || !oneToZero) {
    throw new Error("fluid-dex nonzero bidirectional swap proof failed");
  }
  return fluidDexEdges(target, constants.token0, constants.token1, instance.pool.score);
}

async function quoteFluidDexExact(ctx: ExactQuoteContext): Promise<bigint> {
  if (!ctx.tokenIn || !ctx.tokenOut) {
    throw new Error("fluid-dex quote requires tokenIn/tokenOut");
  }
  return quoteFluidDex(
    ctx.state,
    ctx.target,
    ctx.tokenIn,
    ctx.tokenOut,
    ctx.amountIn,
    ctx.poolToken0 ?? ctx.edge?.poolToken0,
    ctx.poolToken1 ?? ctx.edge?.poolToken1,
  );
}

async function quoteFluidDexPrepared(
  ctx: PreparedRouteContext,
): Promise<PreparedRouteQuoteResult> {
  const started = Date.now();
  const amountOut = await quoteFluidDex(
    {
      call: async ({ to, data, from }) =>
        (await ctx.callPrepared(to, data, { from })).output,
    },
    ctx.request.target,
    ctx.request.tokenIn,
    ctx.request.tokenOut,
    ctx.request.amountIn,
    ctx.request.poolToken0 ?? ctx.edge?.poolToken0,
    ctx.request.poolToken1 ?? ctx.edge?.poolToken1,
  );
  return { amountOut, latencyMs: Date.now() - started };
}

async function buildFluidDexPlanFragment(
  ctx: PlanBuildContext,
): Promise<PlanFragment> {
  const { edge, amountIn } = ctx;
  return {
    requirements: [{
      kind: "approve",
      token: edge.tokenIn,
      spender: edge.target,
      amount: (1n << 256n) - 1n,
    }],
    nodes: [{
      adapterId: "fluid-dex-swap",
      target: edge.target,
      tokenIn: edge.tokenIn,
      tokenOut: edge.tokenOut,
      amount: amountIn,
      params: {
        swap0to1: fluidDexSwap0To1(
          edge.tokenIn,
          edge.tokenOut,
          edge.poolToken0,
          edge.poolToken1,
        ),
        amountOutMin: 0n,
      },
      children: [],
    }],
  };
}

export function fluidDexSwap0To1(
  tokenIn: string,
  tokenOut: string,
  poolToken0: string | undefined,
  poolToken1: string | undefined,
): boolean {
  if (!poolToken0 || !poolToken1) {
    throw new Error(`fluid-dex quote missing pool token order for ${tokenIn} -> ${tokenOut}`);
  }
  const inLower = tokenIn.toLowerCase();
  const outLower = tokenOut.toLowerCase();
  const token0 = poolToken0.toLowerCase();
  const token1 = poolToken1.toLowerCase();
  if (inLower === token0 && outLower === token1) return true;
  if (inLower === token1 && outLower === token0) return false;
  throw new Error(
    `fluid-dex tokens ${tokenIn} -> ${tokenOut} do not match pool tokens ` +
      `${poolToken0} / ${poolToken1}`,
  );
}

export async function quoteFluidDex(
  state: Pick<StateBackend, "call">,
  pool: string,
  tokenIn: string,
  tokenOut: string,
  amountIn: bigint,
  poolToken0: string | undefined,
  poolToken1: string | undefined,
): Promise<bigint> {
  const swap0to1 = fluidDexSwap0To1(tokenIn, tokenOut, poolToken0, poolToken1);
  const resolver = configuredFluidDexResolver();
  if (resolver) {
    const result = await state.call({
      to: resolver,
      data: fluidDexResolverIface.encodeFunctionData("estimateSwapIn", [
        pool,
        swap0to1,
        amountIn,
        0n,
      ]),
    });
    return decodeFluidDexQuoteResult(result, "resolver-return");
  }
  return quoteFluidDexViaPoolEstimate(state, pool, swap0to1, amountIn);
}

function configuredFluidDexResolver(): string | null {
  const raw = process.env[FLUID_DEX_RESOLVER_ENV];
  if (!raw) return null;
  try {
    const address = ethers.getAddress(raw);
    return address === ethers.ZeroAddress ? null : address;
  } catch {
    return null;
  }
}

async function quoteFluidDexViaPoolEstimate(
  state: Pick<StateBackend, "call">,
  pool: string,
  swap0to1: boolean,
  amountIn: bigint,
): Promise<bigint> {
  const data = fluidDexSwapIface.encodeFunctionData("swapIn", [
    swap0to1,
    amountIn,
    0n,
    FLUID_DEX_ADDRESS_DEAD,
  ]);
  try {
    await state.call({ to: pool, data });
    throw new Error(
      "fluid-dex ADDRESS_DEAD estimate returned without FluidDexSwapResult",
    );
  } catch (error) {
    if (isStateCallAbortedError(error)) throw error;
    const decoded = decodeFluidDexEstimateRevert(extractRevertData(error));
    if (decoded !== null) return decoded;
    throw error;
  }
}

function extractRevertData(error: unknown): string | null {
  const seen = new Set<unknown>();
  const stack: unknown[] = [error];
  while (stack.length > 0) {
    const value = stack.pop();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    if (typeof value === "string" && /^0x[0-9a-fA-F]+$/.test(value)) return value;
    if (typeof value !== "object") continue;
    const object = value as Record<string, unknown>;
    for (const key of ["data", "error", "info", "body", "payload"]) {
      const next = object[key];
      if (typeof next === "string" && /^0x[0-9a-fA-F]+$/.test(next)) return next;
      if (next && typeof next === "object") stack.push(next);
    }
  }
  return null;
}

function decodeFluidDexEstimateRevert(data: string | null): bigint | null {
  if (!data) return null;
  try {
    return decodeFluidDexQuoteResult(data, "address-dead-revert");
  } catch {
    return null;
  }
}

type FluidDexQuoteResultEncoding =
  | "resolver-return"
  | "address-dead-revert";

/**
 * Decode only the two quote shapes owned by Fluid DEX:
 * - the resolver's ordinary ABI `uint256` return;
 * - the pool's exact `FluidDexSwapResult(uint256)` custom error when
 *   `swapIn(..., ADDRESS_DEAD)` is used.
 *
 * The exact lengths are deliberate. A generic revert payload (including a
 * different custom error with a trailing uint256) is not quote evidence.
 */
function decodeFluidDexQuoteResult(
  data: string,
  encoding: FluidDexQuoteResultEncoding,
): bigint {
  if (encoding === "resolver-return") {
    if (!/^0x[0-9a-fA-F]{64}$/.test(data)) {
      throw new Error("fluid-dex resolver quote returned malformed ABI data");
    }
    return BigInt(
      fluidDexResolverIface.decodeFunctionResult("estimateSwapIn", data)[0],
    );
  }

  if (!/^0x[0-9a-fA-F]{72}$/.test(data)) {
    throw new Error(
      "fluid-dex ADDRESS_DEAD estimate returned malformed revert data",
    );
  }
  const expectedSelector =
    fluidDexSwapIface.getError("FluidDexSwapResult")!.selector.toLowerCase();
  if (data.slice(0, 10).toLowerCase() !== expectedSelector) {
    throw new Error(
      "fluid-dex ADDRESS_DEAD estimate returned an unknown custom error",
    );
  }
  return BigInt(
    fluidDexSwapIface.decodeErrorResult("FluidDexSwapResult", data)[0],
  );
}

async function readFluidDexConstants(
  backend: { call(req: { to: string; data: string; from?: string }): Promise<string> },
  target: string,
): Promise<FluidDexConstants> {
  const raw = await backend.call({
    to: ethers.getAddress(target),
    data: fluidDexIdentityIface.encodeFunctionData("constantsView"),
  });
  const decoded = fluidDexIdentityIface.decodeFunctionResult("constantsView", raw)[0] as {
    readonly dexId: bigint;
    readonly factory: string;
    readonly token0: string;
    readonly token1: string;
  };
  return {
    dexId: BigInt(decoded.dexId),
    factory: ethers.getAddress(decoded.factory),
    token0: ethers.getAddress(decoded.token0),
    token1: ethers.getAddress(decoded.token1),
  };
}

function fluidDexConstantsAreSane(constants: FluidDexConstants): boolean {
  return constants.dexId > 0n &&
    constants.factory !== ethers.ZeroAddress &&
    constants.token0 !== ethers.ZeroAddress &&
    constants.token1 !== ethers.ZeroAddress &&
    constants.token0.toLowerCase() !== constants.token1.toLowerCase();
}

async function proveFluidDexSwap(
  context: ProtocolDiscoveryContext,
  target: string,
  tokenIn: string,
  tokenOut: string,
  swap0To1: boolean,
): Promise<boolean> {
  const simulate = context.backend.simulateCalls?.bind(context.backend);
  if (!simulate) return false;
  const decimalsRaw = await context.backend.call({
    to: tokenIn,
    data: erc20ProbeIface.encodeFunctionData("decimals"),
  });
  const decimals = Number(
    erc20ProbeIface.decodeFunctionResult("decimals", decimalsRaw)[0],
  );
  if (!Number.isSafeInteger(decimals) || decimals < 0 || decimals > 36) return false;
  const amountIn = 10n ** BigInt(decimals);
  const tokenCode = await context.backend.getCode(tokenIn);
  if (tokenCode === "0x") return false;
  const implementationWord = await context.backend.getStorageAt(tokenIn, IMPLEMENTATION_SLOT);
  const codeHash = ethers.keccak256(ethers.concat([
    ethers.getBytes(ethers.keccak256(tokenCode)),
    ethers.getBytes(implementationWord),
  ]));
  const slotKey = await discoverErc20BalanceStorageSlot({
    context,
    token: tokenIn,
    holder: FLUID_DEX_PROBE_HOLDER,
    codeHash,
    probeValue: amountIn,
  });
  if (!slotKey) return false;
  const calls = [
    {
      from: FLUID_DEX_PROBE_HOLDER,
      to: tokenIn,
      data: erc20ProbeIface.encodeFunctionData("balanceOf", [FLUID_DEX_PROBE_HOLDER]),
    },
    {
      from: FLUID_DEX_PROBE_HOLDER,
      to: tokenOut,
      data: erc20ProbeIface.encodeFunctionData("balanceOf", [FLUID_DEX_PROBE_HOLDER]),
    },
    {
      from: FLUID_DEX_PROBE_HOLDER,
      to: tokenIn,
      data: erc20ProbeIface.encodeFunctionData("approve", [target, amountIn]),
    },
    {
      from: FLUID_DEX_PROBE_HOLDER,
      to: target,
      data: fluidDexSwapIface.encodeFunctionData("swapIn", [
        swap0To1,
        amountIn,
        0n,
        FLUID_DEX_PROBE_HOLDER,
      ]),
    },
    {
      from: FLUID_DEX_PROBE_HOLDER,
      to: tokenIn,
      data: erc20ProbeIface.encodeFunctionData("balanceOf", [FLUID_DEX_PROBE_HOLDER]),
    },
    {
      from: FLUID_DEX_PROBE_HOLDER,
      to: tokenOut,
      data: erc20ProbeIface.encodeFunctionData("balanceOf", [FLUID_DEX_PROBE_HOLDER]),
    },
  ] as const;
  const results = await simulate({
    calls,
    stateOverrides: {
      [tokenIn]: { stateDiff: { [slotKey]: ethers.toBeHex(amountIn, 32) } },
    },
  });
  if (results.length !== calls.length || results.some((result) => result.status !== 1)) {
    return false;
  }
  try {
    const inputBefore = decodeErc20Uint(results[0].returnData);
    const outputBefore = decodeErc20Uint(results[1].returnData);
    const amountOut = BigInt(
      fluidDexSwapIface.decodeFunctionResult("swapIn", results[3].returnData)[0],
    );
    const inputAfter = decodeErc20Uint(results[4].returnData);
    const outputAfter = decodeErc20Uint(results[5].returnData);
    return inputBefore === amountIn &&
      inputAfter === 0n &&
      amountOut > 0n &&
      outputAfter > outputBefore &&
      outputAfter - outputBefore === amountOut;
  } catch {
    return false;
  }
}

function decodeErc20Uint(data: string): bigint {
  return BigInt(erc20ProbeIface.decodeFunctionResult("balanceOf", data)[0]);
}

function assertExactFluidDexRoutes(pool: PoolEntry, expected: readonly TokenEdge[]): void {
  const actual = pool.verifiedRoutes ?? [];
  const routeKey = (route: {
    edgeAdapterId: string;
    tokenIn: string;
    tokenOut: string;
    slotKind: string;
    poolToken0?: string;
    poolToken1?: string;
  }): string => [
    route.edgeAdapterId,
    route.tokenIn.toLowerCase(),
    route.tokenOut.toLowerCase(),
    route.slotKind,
    route.poolToken0?.toLowerCase() ?? "",
    route.poolToken1?.toLowerCase() ?? "",
  ].join("|");
  const expectedKeys = expected.map((edge) => routeKey({
    edgeAdapterId: edge.adapterId,
    tokenIn: edge.tokenIn,
    tokenOut: edge.tokenOut,
    slotKind: edge.slotKind,
    poolToken0: edge.poolToken0,
    poolToken1: edge.poolToken1,
  })).sort();
  const actualKeys = actual.map(routeKey).sort();
  if (
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some((key, index) => key !== expectedKeys[index])
  ) {
    throw new Error(`fluid-dex pool ${pool.address} verified route set changed`);
  }
}

function isPermanentFluidSurfaceFailure(error: unknown): boolean {
  const code = error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code).toUpperCase()
    : "";
  if (new Set(["CALL_EXCEPTION", "BAD_DATA", "INVALID_ARGUMENT"]).has(code)) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /execution reverted|could not decode|invalid (?:result|data|address)/i.test(message);
}
