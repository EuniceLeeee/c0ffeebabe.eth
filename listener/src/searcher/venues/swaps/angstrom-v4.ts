import { ethers } from "ethers";
import { ADDR } from "../../../shared/constants/addresses.js";
import type { ResolvedPlanNode } from "../../../shared/types/plan.js";
import { deriveEdgeTaxonomy } from "../../strategy-taxonomy.js";
import type {
  PoolEntry,
  TokenEdge,
  TokenQueryBackend,
  V4PoolKey,
} from "../../planner/token-graph.js";
import type { V4PostImpactSeed } from "../../solver/pool-state-cache.js";
import {
  blockScanEdgeKey,
  type BlockScanStateCapability,
} from "../blockscan-state-capability.js";
import {
  poolAdapterId,
  venueId,
  venueIdentitySource,
} from "../registry-ids.js";
import type {
  ExactQuoteContext,
  PendingExecutionEvidence,
  PendingTransactionEvidenceContext,
  PlanBuildContext,
  PlanFragment,
  PreparedRouteContext,
  PreparedRouteQuoteResult,
  SwapAdapter,
} from "../route-leg-adapter.js";
import { RouteInstanceNotApplicableError } from "../route-instance-availability.js";
import { createUniV4SwapObservation } from "../swap-observation.js";
import type { PoolImpact } from "../swap-observation.js";
import {
  defineSwapLandedEvents,
  singletonIndexedBytes32Emitter,
  UNIV4_SWAP_TOPIC,
} from "../landed-event-registry.js";
import type {
  LandedPoolMaterializationCapability,
  LandedPoolMaterializationContext,
  LandedPoolSharedIdentityCapability,
  LandedPoolSharedIdentityProjection,
} from "../landed-pool-discovery.js";
import {
  materializeSharedLandedPoolIdentity,
} from "../landed-pool-shared-identity.js";
import {
  ANGSTROM_MAINNET_ADAPTER,
  ANGSTROM_MAINNET_HOOK,
  decodeAngstromExecutionEvidence,
  encodeAngstromExecutionEvidence,
  extractAngstromAttestationCandidates,
  hasAngstromSwapCandidate,
  MAX_ANGSTROM_ATTESTATIONS_PER_EVIDENCE,
  type AngstromAttestationCandidate,
  type VerifiedAngstromAttestation,
} from "./angstrom-attestation.js";
import {
  BLOCKSCAN_MULTICALL3,
  decodeMulticall,
  directedPoolMid,
  encodeMulticall,
  q96DirectedReserves,
  q96PrecisionProbeAmount,
  type MulticallItem,
} from "./blockscan-state-shared.js";
import {
  normalizeV4PoolKey,
  v4PoolId,
} from "./univ4-common.js";
import {
  univ4BlockScanState,
  uniV4QuoterIface,
} from "./univ4.js";
import {
  univ4PoolIdentityMaterializer,
} from "./univ4-pool-discovery.js";

const ANGSTROM_POOL_ADAPTER = poolAdapterId("angstrom-v4");
const ANGSTROM_VENUE_ID = venueId("angstrom-v4");
const ANGSTROM_IDENTITY_SOURCE =
  venueIdentitySource("angstrom-v4-hook-poolkey");
const ANGSTROM_EDGE_ADAPTER_ID = "angstrom-v4-swap";
const UINT128_MAX = (1n << 128n) - 1n;
const UINT256_MAX = (1n << 256n) - 1n;
const ANGSTROM_CONTROLLER_SLOT = 0n;
const ANGSTROM_NODE_MAPPING_SLOT = 1n;

const angstromHookStateIface = new ethers.Interface([
  // The deployed Angstrom hook defines this custom single-slot ABI. It does
  // not inherit V4's sparse extsload(bytes32[]) overload.
  "function extsload(uint256 slot) view returns (uint256 value)",
]);
const angstromControllerIface = new ethers.Interface([
  "function ANGSTROM() view returns (address)",
]);

const angstromEmitter = singletonIndexedBytes32Emitter(
  ADDR.UNISWAP_V4_POOL_MANAGER,
  1,
);
const angstromLandedEvents = defineSwapLandedEvents({
  swaps: [{
    id: "angstrom-v4-swap",
    topic: UNIV4_SWAP_TOPIC,
    emitter: angstromEmitter,
    materialization: "family",
    discovery: {
      poolAdapter: ANGSTROM_POOL_ADAPTER,
      label: "angstrom-v4",
    },
    invalidatesWarmState: true,
  }],
  mutations: [],
});

function asUniV4IdentityPool(pool: PoolEntry): PoolEntry {
  return {
    ...pool,
    adapter: "univ4",
    venueId: "univ4",
    identitySource: "v4-manager",
    discoveryOwnerAdapterId: undefined,
  };
}

function fromUniV4IdentityPool(pool: PoolEntry): PoolEntry {
  return {
    ...pool,
    adapter: ANGSTROM_POOL_ADAPTER,
    venueId: ANGSTROM_VENUE_ID,
    identitySource: ANGSTROM_IDENTITY_SOURCE,
    logicalInstanceId: pool.poolId,
    discoveryOwnerAdapterId: undefined,
  };
}

const angstromPoolIdentityProjection = Object.freeze({
  version: "angstrom-v4-poolkey-projection-v1",
  toIdentityPool(pool: PoolEntry): PoolEntry | null {
    return pool.adapter === ANGSTROM_POOL_ADAPTER
      ? asUniV4IdentityPool(pool)
      : null;
  },
  projectPool(pool: PoolEntry): PoolEntry | null {
    return sameAddress(pool.hooks, ANGSTROM_MAINNET_HOOK)
      ? fromUniV4IdentityPool(pool)
      : null;
  },
  projectRetry(pool: PoolEntry): PoolEntry {
    return {
      ...fromUniV4IdentityPool(pool),
      source: "landed-event-retry:angstrom-v4-swap",
    } as PoolEntry;
  },
} satisfies LandedPoolSharedIdentityProjection);

const angstromSharedPoolIdentity = Object.freeze({
  materializer: univ4PoolIdentityMaterializer,
  projection: angstromPoolIdentityProjection,
} satisfies LandedPoolSharedIdentityCapability);

const angstromPoolDiscovery = Object.freeze({
  version: "angstrom-v4-poolkey-materializer-v1",
  eventIds: ["angstrom-v4-swap"],
  consumesOpaqueRetries: true,
  sharedIdentity: angstromSharedPoolIdentity,
  materialize(context: LandedPoolMaterializationContext) {
    return materializeSharedLandedPoolIdentity(
      angstromSharedPoolIdentity,
      context,
    );
  },
} satisfies LandedPoolMaterializationCapability);

type AngstromSpotSchema = ReturnType<
  typeof univ4BlockScanState.compileStaticSchema
>;
type AngstromSpotSnapshot = ReturnType<
  typeof univ4BlockScanState.decodeState
>;

/**
 * Coarse enumeration needs current-N pool state, not pending hook proof. Reuse
 * the standard V4 slot0/liquidity reads and derive a conservative spot mid;
 * exact quote and execution remain fail-closed on per-hint Angstrom evidence.
 */
const angstromSpotBlockScanState = Object.freeze({
  stateKey(edge: TokenEdge): string {
    return univ4BlockScanState.stateKey(asStandardV4Edge(edge));
  },
  compileStaticSchema(input): AngstromSpotSchema {
    return univ4BlockScanState.compileStaticSchema({
      ...input,
      edges: input.edges.map(asStandardV4Edge),
    });
  },
  buildCurrentBlockReads(input) {
    return univ4BlockScanState.buildCurrentBlockReads({
      ...input,
      edges: input.edges.map(asStandardV4Edge),
    });
  },
  buildDependentBlockReads() {
    return Object.freeze([]);
  },
  decodeState(
    schema: AngstromSpotSchema,
    results,
  ): AngstromSpotSnapshot {
    return univ4BlockScanState.decodeState(schema, results);
  },
  deriveMids(
    snapshot: AngstromSpotSnapshot,
    edges: readonly TokenEdge[],
  ) {
    const mids = new Map();
    if (snapshot.inactiveReason) return mids;
    for (const edge of edges) {
      assertAngstromSpotSnapshot(snapshot, edge);
      if (angstromSpotNeedsPrecision(snapshot, edge)) continue;
      const directed = angstromSpotReserves(snapshot, edge);
      if (!directed) continue;
      mids.set(blockScanEdgeKey(edge), directedPoolMid({
        kind: "v4",
        edge,
        reserveIn: directed.reserveIn,
        reserveOut: directed.reserveOut,
        mid: directed.mid,
        sqrtPriceX96: directed.sqrtPriceInOutX96,
        liquidity: snapshot.liquidity,
        feeBps: Number(snapshot.lpFee) / 100,
      }));
    }
    return mids;
  },
  behaviorProvenUnavailableEdges(
    snapshot: AngstromSpotSnapshot,
    edges: readonly TokenEdge[],
  ) {
    const unavailable = new Map<string, string>();
    for (const edge of edges) {
      assertAngstromSpotSnapshot(snapshot, edge);
      const reason = snapshot.inactiveReason ??
        (angstromSpotNeedsPrecision(snapshot, edge)
          ? `angstrom-v4 direction ${edge.tokenIn}->${edge.tokenOut} ` +
            "requires tx-bound evidence for a current-source precision quote"
          : null);
      if (reason) unavailable.set(blockScanEdgeKey(edge), reason);
    }
    return unavailable;
  },
  dependencies(edges: readonly TokenEdge[]) {
    return univ4BlockScanState.dependencies(edges.map(asStandardV4Edge));
  },
} satisfies BlockScanStateCapability<
  AngstromSpotSchema,
  AngstromSpotSnapshot
>);

function asStandardV4Edge(edge: TokenEdge): TokenEdge {
  if (edge.adapterId !== ANGSTROM_EDGE_ADAPTER_ID) {
    throw new Error(`angstrom-v4 does not own edge ${edge.adapterId}`);
  }
  return { ...edge, adapterId: "univ4-unlock" };
}

function angstromSpotReserves(
  snapshot: AngstromSpotSnapshot,
  edge: TokenEdge,
): {
  readonly reserveIn: bigint;
  readonly reserveOut: bigint;
  readonly sqrtPriceInOutX96: bigint;
  readonly mid: number;
} | null {
  return q96DirectedReserves({
    sqrtPriceX96: snapshot.sqrtPriceX96,
    liquidity: snapshot.liquidity,
    token0: snapshot.currency0,
    token1: snapshot.currency1,
    edge,
  });
}

function assertAngstromSpotSnapshot(
  snapshot: AngstromSpotSnapshot,
  edge: TokenEdge,
): void {
  const key = requireAngstromPoolKey(edge);
  if (v4PoolId(key) !== snapshot.poolId) {
    throw new Error(
      `angstrom-v4 snapshot ${snapshot.poolId} used for ${v4PoolId(key)}`,
    );
  }
}

function angstromSpotNeedsPrecision(
  snapshot: AngstromSpotSnapshot,
  edge: TokenEdge,
): boolean {
  if (snapshot.inactiveReason) return false;
  return q96PrecisionProbeAmount({
    sqrtPriceX96: snapshot.sqrtPriceX96,
    liquidity: snapshot.liquidity,
    token0: snapshot.currency0,
    token1: snapshot.currency1,
    edge,
    maxAmountIn: UINT128_MAX,
  }) !== null;
}

export const angstromV4Adapter = Object.freeze({
  id: "custom-swap:angstrom-v4",
  kind: "swap",
  poolAdapters: [ANGSTROM_POOL_ADAPTER],
  routeIdentity: {
    instanceKey(pool: PoolEntry) {
      if (!pool.poolId) {
        throw new Error("angstrom-v4 route identity requires poolId");
      }
      return JSON.stringify([
        "angstrom-v4",
        pool.address.toLowerCase(),
        pool.poolId.toLowerCase(),
      ]);
    },
    executionVariantKey(edge: TokenEdge) {
      if (!edge.poolId) {
        throw new Error("angstrom-v4 execution identity requires poolId");
      }
      return JSON.stringify([
        edge.adapterId,
        edge.poolId.toLowerCase(),
      ]);
    },
  },
  planExecutionIdentity: {
    resolve(node: ResolvedPlanNode) {
      if (
        node.adapterId !== ANGSTROM_EDGE_ADAPTER_ID ||
        typeof node.params.currency0 !== "string" ||
        typeof node.params.currency1 !== "string" ||
        typeof node.params.fee !== "bigint" ||
        typeof node.params.tickSpacing !== "bigint" ||
        typeof node.params.hooks !== "string"
      ) {
        throw new Error(
          "angstrom-v4 resolved plan is missing its PoolKey",
        );
      }
      const key = normalizeV4PoolKey({
        currency0: node.params.currency0,
        currency1: node.params.currency1,
        fee: Number(node.params.fee),
        tickSpacing: Number(node.params.tickSpacing),
        hooks: node.params.hooks,
      }, "angstrom-v4 plan identity");
      return {
        routeTarget: ADDR.UNISWAP_V4_POOL_MANAGER,
        poolId: v4PoolId(key),
      };
    },
  },
  identityPolicies: [{
    poolAdapter: ANGSTROM_POOL_ADAPTER,
    policy: "trusted-singleton-seed",
    canonicalAddress: ADDR.UNISWAP_V4_POOL_MANAGER,
    canonicalVenueId: ANGSTROM_VENUE_ID,
    canonicalIdentitySource: ANGSTROM_IDENTITY_SOURCE,
    registeredVenueIds: [ANGSTROM_VENUE_ID],
    registeredIdentitySources: [ANGSTROM_IDENTITY_SOURCE],
  }],
  edgeAdapterIds: [ANGSTROM_EDGE_ADAPTER_ID],
  allowedTaxonomy: [{ slotKind: "swap" }],
  requiresProtocolEdgesFlag: false,
  ownedActionAdapterIds: [ANGSTROM_EDGE_ADAPTER_ID],
  requiredInfraActionAdapterIds: ["erc20-approve"],
  pendingTransactionEvidence: {
    routeActivation: "current-head-block-scan",
    routeActivationScope: { kind: "family" },
    mightMatch(tx) {
      return hasAngstromSwapCandidate(tx);
    },
    async observe(tx, context) {
      const extraction = extractAngstromAttestationCandidates(tx);
      const unique = new Map<string, AngstromAttestationCandidate>();
      for (const attestation of extraction.calls.flatMap(
        (call) => call.attestations,
      )) {
        unique.set(attestation.evidenceHash, attestation);
      }
      if (unique.size === 0) return null;
      if (unique.size > MAX_ANGSTROM_ATTESTATIONS_PER_EVIDENCE) {
        throw new Error(
          `angstrom-v4 pending evidence exceeds ` +
            `${MAX_ANGSTROM_ATTESTATIONS_PER_EVIDENCE} unique attestations`,
        );
      }
      const attestations = await verifyCurrentAngstromAttestations(
        context,
        [...unique.values()],
      );
      if (attestations.length === 0) return null;
      return Object.freeze({
        canonicalPayload: encodeAngstromExecutionEvidence(attestations),
      });
    },
  },
  landedEvents: angstromLandedEvents,
  poolDiscovery: angstromPoolDiscovery,
  observation: createUniV4SwapObservation({
    adapterIds: [ANGSTROM_EDGE_ADAPTER_ID],
    canonicalIntakeTargets: [
      ANGSTROM_MAINNET_ADAPTER,
      ANGSTROM_MAINNET_HOOK,
      ADDR.UNISWAP_V4_POOL_MANAGER,
    ],
    landedEvents: angstromLandedEvents.swaps,
    includeAmountOut: false,
  }),
  victimModel: {
    id: "pool-swap:angstrom-v4",
    mode: "replay",
    runtime: {
      localApply: null,
      exactPostImpact: angstromExactPostImpact,
      buildOverlay: null,
    },
  },
  pricingState: angstromSpotBlockScanState,
  prepared: {
    quote: quoteAngstromPrepared,
    quoteUnsupportedReason: null,
    encodeQuotePrewarm: async (ctx: PreparedRouteContext) => {
      const items = angstromAllEvidenceQuoteItems(
        ctx.request.tokenIn,
        ctx.request.tokenOut,
        ctx.request.amountIn,
        ctx.request.v4PoolKey ?? ctx.edge?.v4PoolKey,
        requireAngstromExecutionEvidence(ctx.request.executionEvidence),
      );
      return [{
        from: ethers.ZeroAddress,
        to: BLOCKSCAN_MULTICALL3,
        calldata: encodeMulticall(items),
        gasLimit: 5_000_000,
      }];
    },
    allowanceSpender: () => ANGSTROM_MAINNET_ADAPTER,
    prewarmAddresses: (request) => [
      ANGSTROM_MAINNET_ADAPTER,
      ANGSTROM_MAINNET_HOOK,
      ADDR.UNISWAP_V4_POOL_MANAGER,
      ADDR.UNISWAP_V4_QUOTER,
      request.tokenIn,
      request.tokenOut,
    ],
  },
  buildEdges: buildAngstromEdges,
  quoteExact: quoteAngstromExact,
  buildPlanFragment: buildAngstromPlanFragment,
} satisfies SwapAdapter);

async function buildAngstromEdges(
  pool: PoolEntry,
  _backend: TokenQueryBackend,
): Promise<TokenEdge[]> {
  if (
    !pool.poolId ||
    !pool.currency0 ||
    !pool.currency1 ||
    pool.fee === undefined ||
    pool.tickSpacing === undefined ||
    !pool.hooks
  ) {
    throw new Error(
      `angstrom-v4 pool ${pool.address} is missing its materialized PoolKey`,
    );
  }
  const key = normalizeV4PoolKey({
    currency0: pool.currency0,
    currency1: pool.currency1,
    fee: pool.fee,
    tickSpacing: pool.tickSpacing,
    hooks: pool.hooks,
  }, "angstrom-v4 PoolKey");
  if (!sameAddress(key.hooks, ANGSTROM_MAINNET_HOOK)) {
    throw new RouteInstanceNotApplicableError(
      `angstrom-v4 excludes foreign hook ${key.hooks}`,
    );
  }
  if (
    key.currency0 === ethers.ZeroAddress ||
    key.currency1 === ethers.ZeroAddress
  ) {
    throw new RouteInstanceNotApplicableError(
      "angstrom-v4 official adapter does not support native-currency input",
    );
  }
  const poolId = v4PoolId(key);
  if (pool.poolId.toLowerCase() !== poolId) {
    throw new Error(
      `angstrom-v4 PoolKey does not match registered poolId ${pool.poolId}`,
    );
  }
  const taxonomy = deriveEdgeTaxonomy("swap");
  const common = {
    adapterId: ANGSTROM_EDGE_ADAPTER_ID,
    target: ethers.getAddress(ADDR.UNISWAP_V4_POOL_MANAGER),
    slotKind: "swap" as const,
    v4PoolKey: key,
    poolId,
    score: pool.score,
    ...taxonomy,
  };
  return [
    {
      ...common,
      tokenIn: key.currency0,
      tokenOut: key.currency1,
    },
    {
      ...common,
      tokenIn: key.currency1,
      tokenOut: key.currency0,
    },
  ];
}

async function quoteAngstromExact(
  ctx: ExactQuoteContext,
): Promise<bigint> {
  if (!ctx.tokenIn || !ctx.tokenOut) {
    throw new Error("angstrom-v4 quote requires tokenIn/tokenOut");
  }
  if (ctx.amountIn <= 0n) return 0n;
  const items = angstromAllEvidenceQuoteItems(
    ctx.tokenIn,
    ctx.tokenOut,
    ctx.amountIn,
    ctx.v4PoolKey,
    requireAngstromExecutionEvidence(ctx.executionEvidence),
  );
  const raw = await ctx.state.call({
    to: BLOCKSCAN_MULTICALL3,
    data: encodeMulticall(items),
  });
  return decodeFirstSuccessfulAngstromQuote(raw, items);
}

async function quoteAngstromPrepared(
  ctx: PreparedRouteContext,
): Promise<PreparedRouteQuoteResult> {
  const items = angstromAllEvidenceQuoteItems(
    ctx.request.tokenIn,
    ctx.request.tokenOut,
    ctx.request.amountIn,
    ctx.request.v4PoolKey ?? ctx.edge?.v4PoolKey,
    requireAngstromExecutionEvidence(ctx.request.executionEvidence),
  );
  const quoted = await ctx.callPrepared(
    BLOCKSCAN_MULTICALL3,
    encodeMulticall(items),
    { gasLimit: 5_000_000 },
  );
  return {
    amountOut: decodeFirstSuccessfulAngstromQuote(
      quoted.output,
      items,
    ),
    latencyMs: quoted.latencyMs,
    cacheStats: quoted.cacheStats,
  };
}

async function buildAngstromPlanFragment(
  ctx: PlanBuildContext,
): Promise<PlanFragment> {
  const key = requireAngstromPoolKey(ctx.edge);
  const zeroForOne = angstromZeroForOne(
    key,
    ctx.edge.tokenIn,
    ctx.edge.tokenOut,
  );
  if (ctx.amountIn <= 0n || ctx.amountIn > UINT128_MAX) {
    throw new Error(
      `angstrom-v4 exact input does not fit uint128: ${ctx.amountIn}`,
    );
  }
  if (ctx.amountOut <= 0n || ctx.amountOut > UINT128_MAX) {
    throw new Error(
      `angstrom-v4 minimum output does not fit uint128: ${ctx.amountOut}`,
    );
  }
  const bundle = requireAngstromExecutionEvidence(ctx.executionEvidence)
    .map((evidence) => ({
      blockNumber: evidence.blockNumber,
      unlockData: evidence.unlockData,
    }));
  return {
    requirements: [{
      kind: "approve",
      token: ctx.edge.tokenIn,
      spender: ANGSTROM_MAINNET_ADAPTER,
      amount: UINT256_MAX,
    }],
    nodes: [{
      adapterId: ANGSTROM_EDGE_ADAPTER_ID,
      target: ANGSTROM_MAINNET_ADAPTER,
      tokenIn: ctx.edge.tokenIn,
      tokenOut: ctx.edge.tokenOut,
      amount: ctx.amountIn,
      params: {
        currency0: key.currency0,
        currency1: key.currency1,
        fee: BigInt(key.fee),
        tickSpacing: BigInt(key.tickSpacing),
        hooks: key.hooks,
        zeroForOne,
        amountSpecified: ctx.amountIn,
        minAmountOut: ctx.amountOut,
        attestationBlockNumbers: bundle.map((item) => item.blockNumber),
        attestationUnlockData: bundle.map((item) => item.unlockData),
        recipient: ctx.executor,
        deadline: UINT256_MAX,
      },
      children: [],
    }],
  };
}

function angstromExactPostImpact(
  impact: PoolImpact,
  blockNumber: number,
): V4PostImpactSeed | null {
  if (!impact.v4PostState) return null;
  return {
    kind: "v4",
    poolManager: impact.pool,
    poolId: impact.v4PostState.poolId,
    sqrtPriceX96: impact.v4PostState.sqrtPriceX96,
    tick: impact.v4PostState.tick,
    liquidity: impact.v4PostState.liquidity,
    lpFee: impact.v4PostState.lpFee,
    blockNumber,
  };
}

function angstromAllEvidenceQuoteItems(
  tokenIn: string,
  tokenOut: string,
  amountIn: bigint,
  poolKey: V4PoolKey | undefined,
  evidence: readonly VerifiedAngstromAttestation[],
): readonly MulticallItem[] {
  if (evidence.length === 0) {
    throw new Error("angstrom-v4 quote has no verified execution evidence");
  }
  return evidence.map((attestation) => ({
    label: `angstrom-v4-exact:${attestation.blockNumber}:` +
      `${attestation.evidenceHash}`,
    target: ADDR.UNISWAP_V4_QUOTER,
    callData: encodeAngstromQuote(
      tokenIn,
      tokenOut,
      amountIn,
      poolKey,
      attestation.unlockData,
    ),
    allowFailure: true,
  }));
}

function requireAngstromExecutionEvidence(
  evidence: PendingExecutionEvidence | undefined,
): readonly VerifiedAngstromAttestation[] {
  if (!evidence || evidence.familyId !== "custom-swap:angstrom-v4") {
    throw new Error("angstrom-v4 requires tx-bound family execution evidence");
  }
  if (
    ethers.keccak256(evidence.canonicalPayload).toLowerCase() !==
      evidence.payloadHash.toLowerCase()
  ) {
    throw new Error("angstrom-v4 execution evidence payload hash mismatch");
  }
  return decodeAngstromExecutionEvidence(evidence.canonicalPayload);
}

function encodeAngstromQuote(
  tokenIn: string,
  tokenOut: string,
  amountIn: bigint,
  poolKey: V4PoolKey | undefined,
  hookData: string,
): string {
  if (amountIn <= 0n || amountIn > UINT128_MAX) {
    throw new Error(
      `angstrom-v4 exact input does not fit uint128: ${amountIn}`,
    );
  }
  if (!poolKey) {
    throw new Error("angstrom-v4 quote requires PoolKey");
  }
  const key = normalizeV4PoolKey(poolKey, "angstrom-v4 quote PoolKey");
  if (!sameAddress(key.hooks, ANGSTROM_MAINNET_HOOK)) {
    throw new Error(`angstrom-v4 quote received foreign hook ${key.hooks}`);
  }
  return uniV4QuoterIface.encodeFunctionData(
    "quoteExactInputSingle",
    [{
      poolKey: key,
      zeroForOne: angstromZeroForOne(key, tokenIn, tokenOut),
      exactAmount: amountIn,
      hookData,
    }],
  );
}

function decodeFirstSuccessfulAngstromQuote(
  raw: string,
  items: readonly MulticallItem[],
): bigint {
  const read = {
    id: "angstrom-v4-exact",
    ok: true as const,
    sourceBlock: 0,
    sourceBlockHash: ethers.ZeroHash,
    provenance: {
      kind: "immutable-fork" as const,
      source: { number: 0, hash: ethers.ZeroHash, generation: 0 },
      forkId: "angstrom-v4-exact",
    },
    data: raw,
  };
  const decoded = decodeMulticall(read, items);
  for (const item of items) {
    const result = decoded.get(item.label);
    if (!result?.success || result.returnData === "0x") continue;
    try {
      const amountOut = BigInt(
        uniV4QuoterIface.decodeFunctionResult(
          "quoteExactInputSingle",
          result.returnData,
        )[0],
      );
      if (amountOut > 0n) return amountOut;
    } catch {
      // Continue to the proof signed for the fork's exact block.
    }
  }
  throw new Error(
    "angstrom-v4 no verified attestation matched the current fork block",
  );
}

function requireAngstromPoolKey(edge: TokenEdge): V4PoolKey {
  if (!edge.v4PoolKey) {
    throw new Error(
      `angstrom-v4 edge ${edge.tokenIn}->${edge.tokenOut} has no PoolKey`,
    );
  }
  const key = normalizeV4PoolKey(
    edge.v4PoolKey,
    "angstrom-v4 edge PoolKey",
  );
  if (!sameAddress(key.hooks, ANGSTROM_MAINNET_HOOK)) {
    throw new Error(`angstrom-v4 edge has foreign hook ${key.hooks}`);
  }
  return key;
}

async function verifyCurrentAngstromAttestations(
  context: PendingTransactionEvidenceContext,
  candidates: readonly AngstromAttestationCandidate[],
): Promise<readonly VerifiedAngstromAttestation[]> {
  const head = context.head;
  if (
    !Number.isSafeInteger(head.number) ||
    head.number < 0 ||
    !ethers.isHexString(head.hash, 32)
  ) {
    throw new Error("angstrom-v4 validator snapshot received an invalid head");
  }
  if (
    !candidates.some(
      (candidate) => candidate.blockNumber === BigInt(head.number),
    )
  ) {
    return Object.freeze([]);
  }
  const controllerWord = await context.call({
    to: ANGSTROM_MAINNET_HOOK,
    data: angstromHookStateIface.encodeFunctionData(
      "extsload",
      [ANGSTROM_CONTROLLER_SLOT],
    ),
  });
  const controllerSlot = ethers.toBeHex(
    BigInt(
      angstromHookStateIface.decodeFunctionResult(
        "extsload",
        controllerWord,
      )[0],
    ),
    32,
  );
  const controller = ethers.getAddress(ethers.dataSlice(controllerSlot, 12));
  if (controller === ethers.ZeroAddress) {
    throw new Error("angstrom-v4 hook has no controller");
  }

  const canonicalHookResult = await context.call({
    to: controller,
    data: angstromControllerIface.encodeFunctionData("ANGSTROM"),
  });
  const canonicalHook = ethers.getAddress(
    String(
      angstromControllerIface.decodeFunctionResult(
        "ANGSTROM",
        canonicalHookResult,
      )[0],
    ),
  );
  if (!sameAddress(canonicalHook, ANGSTROM_MAINNET_HOOK)) {
    throw new Error(
      `angstrom-v4 controller ${controller} does not govern canonical hook`,
    );
  }

  const validators = [...new Set(
    candidates.map((candidate) => candidate.validator.toLowerCase()),
  )];
  const items: MulticallItem[] = validators.map((validator) => ({
    label: angstromNodeProofLabel(validator),
    target: ANGSTROM_MAINNET_HOOK,
    callData: angstromHookStateIface.encodeFunctionData(
      "extsload",
      [angstromNodeMappingStorageSlot(validator)],
    ),
    allowFailure: true,
  }));
  const proofRaw = await context.call({
    to: BLOCKSCAN_MULTICALL3,
    data: encodeMulticall(items),
  });
  const proofs = decodeMulticall({
    id: "angstrom-v4-current-authority",
    ok: true,
    sourceBlock: head.number,
    sourceBlockHash: head.hash,
    provenance: {
      kind: "immutable-fork",
      source: { number: head.number, hash: head.hash, generation: 0 },
      forkId: `pending-evidence:${head.hash}`,
    },
    data: proofRaw,
  }, items);

  const authorized = new Set(validators.filter((validator) => {
    const result = proofs.get(angstromNodeProofLabel(validator));
    if (!result?.success || result.returnData === "0x") return false;
    try {
      return BigInt(
        angstromHookStateIface.decodeFunctionResult(
          "extsload",
          result.returnData,
        )[0],
      ) === 1n;
    } catch {
      return false;
    }
  }));
  const verified: VerifiedAngstromAttestation[] = [];
  for (const candidate of candidates) {
    if (!authorized.has(candidate.validator.toLowerCase())) continue;
    // SignatureChecker invokes ERC-1271 from the canonical Hook. A generic
    // eth_call or Multicall changes msg.sender and is therefore not equivalent
    // for caller-sensitive contract validators. Until the evidence transport
    // can simulate the Hook caller exactly, contract nodes fail closed.
    if (!candidate.eoaSignatureValid) continue;
    verified.push(Object.freeze({
      ...candidate,
      verification: "eoa",
    }));
  }
  return Object.freeze(verified);
}

function angstromNodeMappingStorageSlot(validator: string): bigint {
  return BigInt(ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["address", "uint256"],
      [validator, ANGSTROM_NODE_MAPPING_SLOT],
    ),
  ));
}

function angstromNodeProofLabel(validator: string): string {
  return `angstrom-v4-node:${validator.toLowerCase()}`;
}

function angstromZeroForOne(
  key: V4PoolKey,
  tokenIn: string,
  tokenOut: string,
): boolean {
  const input = ethers.getAddress(tokenIn);
  const output = ethers.getAddress(tokenOut);
  if (input === key.currency0 && output === key.currency1) return true;
  if (input === key.currency1 && output === key.currency0) return false;
  throw new Error(
    `angstrom-v4 route ${tokenIn}->${tokenOut} does not match PoolKey`,
  );
}

function sameAddress(
  left: string | null | undefined,
  right: string | null | undefined,
): boolean {
  if (!left || !right) return false;
  try {
    return ethers.getAddress(left) === ethers.getAddress(right);
  } catch {
    return false;
  }
}
