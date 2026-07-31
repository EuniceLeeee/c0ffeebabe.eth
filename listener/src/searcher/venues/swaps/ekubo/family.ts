import { ethers } from "ethers";
import { ADDR } from "../../../../shared/constants/addresses.js";
import type { PoolEntry, TokenEdge } from "../../../planner/token-graph.js";
import { deriveEdgeTaxonomy } from "../../../strategy-taxonomy.js";
import type {
  PlanBuildContext,
  PlanFragment,
  PreparedRouteContext,
  SwapAdapter,
} from "../../route-leg-adapter.js";
import { EKUBO_CORE, EKUBO_ROUTER } from "./abi.js";
import { ekuboPoolDiscovery } from "./discovery.js";
import {
  EKUBO_EDGE_ADAPTER_ID,
  EKUBO_FAMILY_ID,
  EKUBO_IDENTITY_SOURCE,
  EKUBO_POOL_ADAPTER_ID,
  EKUBO_VENUE_ID,
} from "./ids.js";
import {
  ekuboLandedEvents,
  ekuboSwapObservation,
} from "./observation.js";
import {
  createEkuboPoolKeyBinding,
  decodeEkuboPoolKeyBinding,
  ekuboDirection,
  ekuboGraphToken,
  ekuboPoolId,
  normalizeEkuboPoolKey,
} from "./pool-key.js";
import {
  ekuboBlockScanState,
  encodeEkuboPreparedQuote,
  quoteEkuboExact,
  quoteEkuboPrepared,
} from "./state.js";

const MAX_UINT256 = (1n << 256n) - 1n;

export const ekuboAdapter = Object.freeze({
  id: EKUBO_FAMILY_ID,
  kind: "swap",
  poolAdapters: Object.freeze([EKUBO_POOL_ADAPTER_ID]),
  routeIdentity: {
    instanceKey(pool: PoolEntry) {
      const identity = poolIdentity(pool);
      return JSON.stringify([
        identity.router,
        identity.poolId,
        identity.bindingHash,
      ]);
    },
    executionVariantKey(edge: TokenEdge) {
      const identity = edgeIdentity(edge);
      return JSON.stringify([
        edge.adapterId,
        identity.poolId,
        identity.bindingHash,
        edge.tokenIn.toLowerCase(),
        edge.tokenOut.toLowerCase(),
      ]);
    },
  },
  planExecutionIdentity: {
    resolve(node) {
      if (
        node.adapterId !== EKUBO_EDGE_ADAPTER_ID ||
        ethers.getAddress(node.target).toLowerCase() !== EKUBO_ROUTER.toLowerCase()
      ) {
        throw new Error("Ekubo resolved plan has a foreign execution node");
      }
      const poolKey = normalizeEkuboPoolKey({
        token0: resolvedString(node.params.token0, "token0"),
        token1: resolvedString(node.params.token1, "token1"),
        config: resolvedString(node.params.config, "config"),
      });
      const poolId = ekuboPoolId(poolKey);
      const declaredPoolId = resolvedString(
        node.params.poolId,
        "poolId",
      ).toLowerCase();
      const bindingHash = createEkuboPoolKeyBinding(poolKey).hash;
      const declaredBindingHash = resolvedString(
        node.params.bindingHash,
        "bindingHash",
      ).toLowerCase();
      if (
        declaredPoolId !== poolId ||
        declaredBindingHash !== bindingHash
      ) {
        throw new Error(
          "Ekubo resolved plan PoolKey does not match its declared identity",
        );
      }
      const isToken1 = resolvedBoolean(node.params.isToken1, "isToken1");
      if (ekuboDirection(node.tokenIn, node.tokenOut, poolKey) !== isToken1) {
        throw new Error(
          "Ekubo resolved plan direction does not match its PoolKey",
        );
      }
      const rawInput = isToken1 ? poolKey.token1 : poolKey.token0;
      const expectedNativeValue =
        rawInput === ethers.ZeroAddress ? node.amount : 0n;
      if (
        node.amount <= 0n ||
        resolvedBigInt(node.params.nativeValue, "nativeValue") !==
          expectedNativeValue ||
        resolvedBigInt(node.params.amountOutMin, "amountOutMin") <= 0n
      ) {
        throw new Error(
          "Ekubo resolved plan amount or native settlement is inconsistent",
        );
      }
      return Object.freeze({
        routeTarget: ethers.getAddress(node.target),
        poolId,
      });
    },
  },
  identityPolicies: Object.freeze([{
    poolAdapter: EKUBO_POOL_ADAPTER_ID,
    policy: "trusted-singleton-seed",
    canonicalAddress: ethers.getAddress(EKUBO_ROUTER),
    canonicalVenueId: EKUBO_VENUE_ID,
    canonicalIdentitySource: EKUBO_IDENTITY_SOURCE,
    registeredVenueIds: Object.freeze([EKUBO_VENUE_ID]),
    registeredIdentitySources: Object.freeze([EKUBO_IDENTITY_SOURCE]),
  }]),
  edgeAdapterIds: Object.freeze([EKUBO_EDGE_ADAPTER_ID]),
  allowedTaxonomy: Object.freeze([{ slotKind: "swap" }]),
  requiresProtocolEdgesFlag: false,
  ownedActionAdapterIds: Object.freeze([EKUBO_EDGE_ADAPTER_ID]),
  requiredInfraActionAdapterIds: Object.freeze([
    "erc20-approve",
    "weth-withdraw-amount",
    "weth-deposit-value",
  ]),
  landedEvents: ekuboLandedEvents,
  poolDiscovery: ekuboPoolDiscovery,
  observation: ekuboSwapObservation,
  victimModel: {
    id: "pool-swap:ekubo-detect-only",
    mode: "detect-only",
  },
  pricingState: ekuboBlockScanState,
  prepared: {
    quote: quoteEkuboPrepared,
    quoteUnsupportedReason: null,
    encodeQuotePrewarm: async (ctx: PreparedRouteContext) => {
      const quote = encodeEkuboPreparedQuote(
        ctx.edge,
        ctx.request.amountIn,
      );
      return Object.freeze([Object.freeze({
        from: ethers.ZeroAddress,
        to: quote.to,
        calldata: quote.data,
        gasLimit: 3_000_000,
      })]);
    },
    allowanceSpender: () => ethers.getAddress(EKUBO_CORE),
    prewarmAddresses: (request) => Object.freeze([
      ethers.getAddress(EKUBO_ROUTER),
      ethers.getAddress(EKUBO_CORE),
      ethers.getAddress(request.tokenIn),
      ethers.getAddress(request.tokenOut),
    ]),
  },
  buildEdges: buildEkuboEdges,
  quoteExact: quoteEkuboExact,
  buildPlanFragment: buildEkuboPlanFragment,
} satisfies SwapAdapter);

async function buildEkuboEdges(
  pool: PoolEntry,
): Promise<TokenEdge[]> {
  const identity = poolIdentity(pool);
  const poolKey = decodeEkuboPoolKeyBinding(pool.routeBinding!);
  const token0 = ekuboGraphToken(poolKey.token0);
  const token1 = ekuboGraphToken(poolKey.token1);
  if (
    pool.token0 !== undefined &&
    ethers.getAddress(pool.token0).toLowerCase() !== token0.toLowerCase()
  ) {
    throw new Error(`Ekubo pool ${identity.poolId} token0 metadata changed`);
  }
  if (
    pool.token1 !== undefined &&
    ethers.getAddress(pool.token1).toLowerCase() !== token1.toLowerCase()
  ) {
    throw new Error(`Ekubo pool ${identity.poolId} token1 metadata changed`);
  }
  const taxonomy = deriveEdgeTaxonomy("swap");
  const common = Object.freeze({
    adapterId: EKUBO_EDGE_ADAPTER_ID,
    target: ethers.getAddress(EKUBO_ROUTER),
    slotKind: "swap" as const,
    poolId: identity.poolId,
    routeBinding: pool.routeBinding!,
    poolToken0: token0,
    poolToken1: token1,
    nativeCurrency0: poolKey.token0 === ethers.ZeroAddress,
    nativeCurrency1: poolKey.token1 === ethers.ZeroAddress,
    score: pool.score,
    ...taxonomy,
  });
  return [
    Object.freeze({ ...common, tokenIn: token0, tokenOut: token1 }),
    Object.freeze({ ...common, tokenIn: token1, tokenOut: token0 }),
  ];
}

async function buildEkuboPlanFragment(
  ctx: PlanBuildContext,
): Promise<PlanFragment> {
  const { edge, amountIn, amountOut, rawOut } = ctx;
  if (amountIn <= 0n || amountOut <= 0n) {
    throw new Error("Ekubo plan requires positive input and output");
  }
  const identity = edgeIdentity(edge);
  const poolKey = decodeEkuboPoolKeyBinding(edge.routeBinding!);
  const isToken1 = ekuboDirection(edge.tokenIn, edge.tokenOut, poolKey);
  const rawInput = isToken1 ? poolKey.token1 : poolKey.token0;
  const rawOutput = isToken1 ? poolKey.token0 : poolKey.token1;
  const inputIsNative = rawInput === ethers.ZeroAddress;
  const outputIsNative = rawOutput === ethers.ZeroAddress;
  const nodes: PlanFragment["nodes"][number][] = [];
  const requirements: PlanFragment["requirements"][number][] = [];

  if (inputIsNative) {
    nodes.push({
      adapterId: "weth-withdraw-amount",
      target: ADDR.WETH,
      tokenIn: ADDR.WETH,
      tokenOut: ethers.ZeroAddress,
      amount: amountIn,
      params: {},
      children: [],
    });
  } else {
    requirements.push({
      kind: "approve",
      token: rawInput,
      spender: ethers.getAddress(EKUBO_CORE),
      amount: MAX_UINT256,
    });
  }

  nodes.push({
    adapterId: EKUBO_EDGE_ADAPTER_ID,
    target: ethers.getAddress(EKUBO_ROUTER),
    tokenIn: edge.tokenIn,
    tokenOut: edge.tokenOut,
    amount: amountIn,
    params: {
      token0: poolKey.token0,
      token1: poolKey.token1,
      config: poolKey.config,
      isToken1,
      amountOutMin: amountOut,
      nativeValue: inputIsNative ? amountIn : 0n,
      poolId: identity.poolId,
      bindingHash: identity.bindingHash,
    },
    children: [],
  });

  if (outputIsNative) {
    nodes.push({
      adapterId: "weth-deposit-value",
      target: ADDR.WETH,
      tokenIn: ethers.ZeroAddress,
      tokenOut: ADDR.WETH,
      amount: rawOut ?? amountOut,
      params: {},
      children: [],
    });
  }
  return Object.freeze({
    requirements: Object.freeze(requirements),
    nodes: Object.freeze(nodes),
  });
}

function poolIdentity(pool: PoolEntry): {
  readonly router: string;
  readonly poolId: string;
  readonly bindingHash: string;
} {
  if (
    pool.adapter !== EKUBO_POOL_ADAPTER_ID ||
    !pool.poolId ||
    !pool.routeBinding
  ) {
    throw new Error("Ekubo pool entry is missing PoolKey identity");
  }
  const router = ethers.getAddress(pool.address).toLowerCase();
  if (router !== EKUBO_ROUTER.toLowerCase()) {
    throw new Error(`Ekubo pool entry has foreign router ${pool.address}`);
  }
  const poolKey = decodeEkuboPoolKeyBinding(pool.routeBinding);
  const poolId = ekuboPoolId(poolKey);
  if (pool.poolId.toLowerCase() !== poolId) {
    throw new Error(`Ekubo pool entry PoolKey hash mismatch ${pool.poolId}`);
  }
  return Object.freeze({
    router,
    poolId,
    bindingHash: pool.routeBinding.hash.toLowerCase(),
  });
}

function edgeIdentity(edge: TokenEdge): {
  readonly poolId: string;
  readonly bindingHash: string;
} {
  if (
    edge.adapterId !== EKUBO_EDGE_ADAPTER_ID ||
    !edge.poolId ||
    !edge.routeBinding
  ) {
    throw new Error("Ekubo edge is missing PoolKey identity");
  }
  if (
    ethers.getAddress(edge.target).toLowerCase() !== EKUBO_ROUTER.toLowerCase()
  ) {
    throw new Error(`Ekubo edge has foreign router ${edge.target}`);
  }
  const poolKey = decodeEkuboPoolKeyBinding(edge.routeBinding);
  const poolId = ekuboPoolId(poolKey);
  if (edge.poolId.toLowerCase() !== poolId) {
    throw new Error(`Ekubo edge PoolKey hash mismatch ${edge.poolId}`);
  }
  ekuboDirection(edge.tokenIn, edge.tokenOut, poolKey);
  return Object.freeze({
    poolId,
    bindingHash: edge.routeBinding.hash.toLowerCase(),
  });
}

function resolvedString(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`Ekubo resolved plan ${label} must be a string`);
  }
  return value;
}

function resolvedBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`Ekubo resolved plan ${label} must be a boolean`);
  }
  return value;
}

function resolvedBigInt(value: unknown, label: string): bigint {
  if (typeof value !== "bigint") {
    throw new Error(`Ekubo resolved plan ${label} must be an integer`);
  }
  return value;
}
