import { ethers } from "ethers";
import type { EdgeKind, ProtocolAction, SlotKind } from "../strategy-taxonomy.js";
import type { VenueId } from "../venues/capability.js";
import type { VenueIdentitySource } from "../venues/identity.js";
import type { PoolAdapterId } from "../venues/registry-ids.js";
import type { CanonicalEdgeId } from "../venues/blockscan-state-capability.js";
import { PRODUCTION_ADAPTER_FAMILIES } from "../venues/production-registry.js";
import type { DeclaredProtocolVenue } from "../venues/route-leg-adapter.js";
import type { RouteEdgeBuildControl } from "../venues/route-leg-adapter.js";
import {
  edgeExecutionVariantKey,
  edgeInstanceKey,
  routeGraphCollectionKey,
  routeInstanceKey,
} from "../venues/route-instance-identity.js";
export { v4HooksAffectSwap, v4PoolId } from "../venues/swaps/univ4-common.js";

/** Minimal interface for on-chain read queries. StateBackend and ethers Provider both satisfy this. */
export interface TokenQueryBackend {
  call(
    req: { to: string; data: string; blockTag?: ethers.BlockTag },
    control?: { readonly deadlineAtMs?: number; readonly signal?: AbortSignal },
  ): Promise<string>;
  getLogs?(req: {
    address: string;
    topics: string[];
    fromBlock: string;
    toBlock: string;
  }, control?: {
    readonly deadlineAtMs?: number;
    readonly signal?: AbortSignal;
  }): Promise<Array<{ data: string; topics: string[] }>>;
}

export interface TokenEdge {
  /**
   * Assigned once by the verified graph builder. State, replay and A/B
   * consumers reuse this ID instead of inventing local edge keys.
   */
  canonicalEdgeId?: CanonicalEdgeId;
  /** Family-owned stable instance identity, bound by the route registry. */
  instanceKey?: string;
  /** Family-owned execution discriminator within one instance/direction. */
  executionVariantKey?: string;
  adapterId: string;
  target: string;
  tokenIn: string;
  tokenOut: string;
  slotKind: SlotKind;
  /** For protocol slots: the protocol's asset-conversion action (drives leavesStandingPosition). */
  protocolAction?: ProtocolAction;
  /** Derived at construction via deriveEdgeTaxonomy(slotKind, protocolAction). Never set independently. */
  edgeKind: EdgeKind;
  /** true ⇔ executing this edge leaves an open position after the tx (credit abandon-exit). */
  leavesStandingPosition: boolean;
  curveI?: number;
  curveJ?: number;
  poolToken0?: string;
  poolToken1?: string;
  /** Identity-attested V2 fee rule; absent for non-V2 edges. */
  v2FeeBps?: bigint;
  /** Identity-attested V3 fee tier; immutable for one pool instance. */
  v3Fee?: number;
  /** Identity-attested immutable V3 tick spacing. */
  v3TickSpacing?: number;
  /** Activity/liquidity proxy (swap-event count from discovery). undefined = curated backbone (pinned, never pruned). */
  score?: number;
  /** Uniswap v4 PoolKey. Required for univ4-unlock quotes. */
  v4PoolKey?: V4PoolKey;
  /** Uniswap v4 poolId = keccak256(abi.encode(PoolKey)). Disambiguates v4 pools
   *  that share the singleton PoolManager target (same address, different pool). */
  poolId?: string;
  /** v4 PoolKey currencyN is native ETH (0x0); the graph node is aliased to WETH, execution (slice 2b) wraps/unwraps. */
  nativeCurrency0?: boolean;
  nativeCurrency1?: boolean;
}

export interface TokenPath {
  edges: TokenEdge[];
}

// ─── Pool Registry (only pool addresses + adapter type) ───────

export interface PoolEntry {
  address: string;
  adapter: PoolAdapterId;
  /** Contracts that emit the protocol action when execution goes through a different target. */
  receiptEmitters?: string[];
  /** Dynamic venue identity/provenance recorded before admission; may be explicitly provisional. */
  venueId?: VenueId;
  /** Factory returned by the pool, for factory-backed venues. */
  factory?: string;
  /** Mechanism that established venueId. */
  identitySource?: VenueIdentitySource;
  /** Optional file-backed metadata for standard two-token pools. */
  token0?: string;
  token1?: string;
  /** Complete token domain for Curve exchange_underlying pools. */
  underlyingCoins?: string[];
  /** Optional v4 pool id from Initialize/Swap logs. address remains the PoolManager target. */
  poolId?: string;
  /** Uniswap v4 PoolKey fields. Required for univ4 entries. */
  currency0?: string;
  currency1?: string;
  fee?: number;
  tickSpacing?: number;
  hooks?: string;
  /** For PSM/fluid where direction is protocol-fixed */
  fixedTokenIn?: string;
  fixedTokenOut?: string;
  fixedSlotKind?: "lend" | "swap" | "protocol";
  /** For protocol-fixed pools: the conversion action (e.g. PSM convert). */
  fixedProtocolAction?: ProtocolAction;
  /**
   * @deprecated Replay-artifact compatibility only. Production discovery must
   * classify non-standard redeem semantics through an independent family and
   * active behavior proof; this flag can never admit an edge.
   */
  nonStandardRedeem?: boolean;
  /**
   * @deprecated Replay-artifact compatibility only. A declared payout token is
   * candidate evidence at most; production graph admission ignores this field.
   */
  redeemTokenOut?: string;
  /** Activity proxy from discovery (swap-event count). undefined = curated backbone (pinned). */
  score?: number;
  /**
   * Distinguishes multiple logical protocol instances living at ONE address
   * (e.g. a multi-pair wrapper). Enters poolRegistryKey and the discovery
   * instance key so a second logical instance is never swallowed by
   * address-level dedup. Absent for ordinary one-instance-per-address pools.
   */
  logicalInstanceId?: string;
  /**
   * Runtime-only provenance for rows projected by protocol discovery. It is
   * never an admission credential and never enters pool identity; projection
   * uses it only to remove its own prior row without deleting an incumbent
   * static row that happens to share the same address/key.
   */
  discoveryOwnerAdapterId?: string;
  /**
   * Discovery-verified routes. Present ⇒ buildEdges emits exactly these and
   * never regrows a leg the probe rejected. Absent ⇒ the legacy compat path
   * (only reachable by non-discovery seeds/harnesses).
   */
  verifiedRoutes?: readonly VerifiedRouteSpec[];
}

export interface V4PoolKey {
  currency0: string;
  currency1: string;
  fee: number;
  tickSpacing: number;
  hooks: string;
}

/**
 * A single route a discovery probe actually verified. When a PoolEntry carries
 * verifiedRoutes, buildEdges emits ONLY these — the generic builder can no
 * longer regrow a probe-rejected leg (e.g. a redeem) from fixedTokenIn alone.
 */
export interface VerifiedRouteSpec {
  edgeAdapterId: string;
  tokenIn: string;
  tokenOut: string;
  slotKind: SlotKind;
  protocolAction?: ProtocolAction;
  /** Execution-critical pool order retained by exact discovery projection. */
  poolToken0?: string;
  poolToken1?: string;
}

// DEX pools are discovered via scanActivePools / factory events. Static protocol
// singletons come from their registered adapters; externally discovered families
// and legacy compat venues stay here until they have a derived admission source.
const EXTERNAL_AND_LEGACY_POOL_REGISTRY: PoolEntry[] = [];

/**
 * Merge adapter-owned static venues into the legacy registry without changing
 * the pre-migration edge order. New declarations omit graphOrder and append.
 */
export function mergeDeclaredProtocolVenues(
  externalAndLegacy: readonly PoolEntry[],
  declared: readonly DeclaredProtocolVenue[],
): PoolEntry[] {
  const ordered = new Map<number, PoolEntry>();
  const appended: PoolEntry[] = [];
  for (const venue of declared) {
    const { graphOrder, ...pool } = venue;
    if (graphOrder === undefined) {
      appended.push(pool);
      continue;
    }
    if (!Number.isSafeInteger(graphOrder) || graphOrder < 0) {
      throw new Error(`invalid declared graph order ${graphOrder}`);
    }
    if (ordered.has(graphOrder)) throw new Error(`duplicate declared graph order ${graphOrder}`);
    ordered.set(graphOrder, pool);
  }
  const preservedLength = externalAndLegacy.length + ordered.size;
  for (const order of ordered.keys()) {
    if (order >= preservedLength) throw new Error(`declared graph order ${order} exceeds registry`);
  }
  const merged: PoolEntry[] = [];
  let externalIndex = 0;
  for (let index = 0; index < preservedLength; index++) {
    const declaredPool = ordered.get(index);
    if (declaredPool) merged.push(declaredPool);
    else merged.push(externalAndLegacy[externalIndex++]);
  }
  if (externalIndex !== externalAndLegacy.length) {
    throw new Error("declared graph ordering did not consume the external registry");
  }
  const result = [...merged, ...appended];
  const instanceKeys = new Set<string>();
  for (const pool of result) {
    const instanceKey = registeredRouteInstanceKey(pool);
    if (instanceKeys.has(instanceKey)) {
      throw new Error(`duplicate protocol registry route instance ${instanceKey}`);
    }
    instanceKeys.add(instanceKey);
  }
  return result;
}

export const POOL_REGISTRY: PoolEntry[] = mergeDeclaredProtocolVenues(
  EXTERNAL_AND_LEGACY_POOL_REGISTRY,
  PRODUCTION_ADAPTER_FAMILIES.protocols().flatMap((adapter) => adapter.declaredVenues),
);

// ─── Auto-build graph from pool registry via eth_call ─────────

/**
 * Build the token graph by querying each pool's tokens on-chain.
 * Queries run in parallel batches for speed.
 */
export async function buildTokenGraph(
  backend: TokenQueryBackend,
  pools: PoolEntry[] = POOL_REGISTRY,
): Promise<TokenEdge[]> {
  return (await buildTokenGraphWithResults(backend, pools)).edges;
}

export interface PoolGraphBuildSuccess {
  pool: PoolEntry;
  edges: TokenEdge[];
}

export interface PoolGraphBuildFailure {
  pool: PoolEntry;
  reason: string;
}

export interface TokenGraphBuildResult {
  edges: TokenEdge[];
  successful: PoolGraphBuildSuccess[];
  failed: PoolGraphBuildFailure[];
}

/**
 * Result-bearing graph build used by incremental discovery. A caller may only
 * mark pools in `successful` as known; failed pools remain eligible for the
 * next refresh instead of being permanently poisoned by a transient RPC read.
 */
export async function buildTokenGraphWithResults(
  backend: TokenQueryBackend,
  pools: PoolEntry[] = POOL_REGISTRY,
  options: {
    readonly quiet?: boolean;
    readonly deadlineAtMs?: number;
    /**
     * Compatibility name retained for callers. The deadline is applied to one
     * pool instance, not shared by every instance owned by the family.
     */
    readonly familyTimeoutMs?: number;
    readonly signal?: AbortSignal;
  } = {},
): Promise<TokenGraphBuildResult> {
  const edges: TokenEdge[] = [];
  const successful: PoolGraphBuildSuccess[] = [];
  const failed: PoolGraphBuildFailure[] = [];
  const familyTimeoutMs = options.familyTimeoutMs ?? 30_000;
  if (!Number.isFinite(familyTimeoutMs) || familyTimeoutMs <= 0) {
    throw new Error("token-graph familyTimeoutMs must be positive");
  }
  const routeRegistry = PRODUCTION_ADAPTER_FAMILIES.routes();
  const seenInstances = new Set<string>();
  const described = pools.map((pool) => {
    const family = routeRegistry.findForPool(pool.adapter);
    let registrationFailure = family
      ? null
      : `route-leg registry: unsupported pool adapter ${pool.adapter}`;
    if (family) {
      try {
        const instanceKey = routeGraphCollectionKey(family, pool);
        if (seenInstances.has(instanceKey)) {
          registrationFailure =
            `token-graph: duplicate route instance ${instanceKey}`;
        } else {
          seenInstances.add(instanceKey);
        }
      } catch (error) {
        registrationFailure = errorMessage(error);
      }
    }
    return Object.freeze({
      pool,
      familyId: family?.id ?? null,
      registrationFailure,
    });
  });
  const familyFailures = new Map<string, string>();
  const outcomes: Array<{
    readonly pool: PoolEntry;
    readonly familyId: string | null;
    readonly result: PromiseSettledResult<TokenEdge[]>;
  }> = [];
  let provisionalEdges = 0;
  let provisionalFailures = 0;

  const BATCH = 50;
  for (let i = 0; i < described.length; i += BATCH) {
    const batch = described.slice(i, i + BATCH);
    const controls = batch.map((item) =>
      item.familyId === null || familyFailures.has(item.familyId)
        ? null
        : createPoolBuildControl(
            item.pool,
            item.familyId,
            familyTimeoutMs,
            options,
          )
    );
    const results = await Promise.allSettled(batch.map((item, index) => {
      if (item.registrationFailure) {
        return Promise.reject(new Error(item.registrationFailure));
      }
      const familyFailure = familyFailures.get(item.familyId!);
      if (familyFailure) {
        return Promise.reject(
          new Error(`route family ${item.familyId} unavailable: ${familyFailure}`),
        );
      }
      return queryPoolEdges(item.pool, backend, controls[index]!.control);
    }));

    for (let resultIndex = 0; resultIndex < results.length; resultIndex++) {
      const result = results[resultIndex];
      const item = batch[resultIndex];
      const control = controls[resultIndex];
      if (
        result.status === "rejected" &&
        isInstanceDeadlineFailure(result.reason) &&
        control &&
        !control.controller.signal.aborted
      ) {
        // The RouteLegRegistry deadline fence may win the race by a millisecond.
        // Abort only this instance's transport; a sibling in the same family
        // retains its independent controller and may still publish.
        control.controller.abort(result.reason);
      }
      if (
        result.status === "rejected" &&
        item.familyId !== null &&
        isFamilyRegistrationOrContractFailure(result.reason)
      ) {
        familyFailures.set(item.familyId, errorMessage(result.reason));
      }
      control?.dispose();
      outcomes.push({
        pool: item.pool,
        familyId: item.familyId,
        result,
      });
      if (result.status === "fulfilled" && result.value.length > 0) {
        provisionalEdges += result.value.length;
      } else {
        provisionalFailures++;
      }
    }
    if (!options.quiet && pools.length > 200 && i % 500 === 0 && i > 0) {
      console.log(
        `[token-graph] progress: ${i}/${pools.length} pools, ` +
          `${provisionalEdges} provisional edges, ${provisionalFailures} skipped`,
      );
    }
  }

  for (const outcome of outcomes) {
    const familyFailure = outcome.familyId === null
      ? null
      : familyFailures.get(outcome.familyId);
    if (familyFailure) {
      failed.push({
        pool: outcome.pool,
        reason: `route family ${outcome.familyId} unavailable: ${familyFailure}`,
      });
      continue;
    }
    const { pool, result } = outcome;
    if (result.status === "fulfilled" && result.value.length > 0) {
      edges.push(...result.value);
      successful.push({ pool, edges: result.value });
      continue;
    }
    failed.push({
      pool,
      reason: result.status === "rejected"
        ? errorMessage(result.reason)
        : "pool produced no route edges",
    });
  }

  if (!options.quiet) {
    console.log(
      `[token-graph] built ${edges.length} edges from ${pools.length} pools` +
        (failed.length > 0 ? ` (${failed.length} skipped)` : ""),
    );
  }
  return { edges, successful, failed };
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

function isInstanceDeadlineFailure(value: unknown): boolean {
  return /deadline exceeded|exceeded \d+ms/i.test(errorMessage(value));
}

/**
 * Runtime call failures belong to one pool instance. Only registry/conformance
 * failures describe a broken family contract and quarantine all of its
 * instances for this graph generation.
 */
function isFamilyRegistrationOrContractFailure(value: unknown): boolean {
  const message = errorMessage(value);
  return message.startsWith("route-leg registry:") &&
    (
      message.includes("emitted undeclared edge adapter") ||
      message.includes("emitted disallowed taxonomy") ||
      message.includes("emitted inconsistent edge taxonomy")
    );
}

/**
 * Build a token→pools index from edges.
 * Given a token address, returns all pool addresses that trade it.
 */
export function buildTokenIndex(edges: TokenEdge[]): Map<string, Set<string>> {
  const index = new Map<string, Set<string>>();
  for (const edge of edges) {
    for (const token of [edge.tokenIn, edge.tokenOut]) {
      const key = token.toLowerCase();
      let pools = index.get(key);
      if (!pools) {
        pools = new Set();
        index.set(key, pools);
      }
      pools.add(edge.target.toLowerCase());
    }
  }
  return index;
}

async function queryPoolEdges(
  pool: PoolEntry,
  backend: TokenQueryBackend,
  control?: RouteEdgeBuildControl,
): Promise<TokenEdge[]> {
  return PRODUCTION_ADAPTER_FAMILIES.routes().buildEdges(
    pool,
    backend,
    control,
  );
}

function registeredRouteInstanceKey(pool: PoolEntry): string {
  const family = PRODUCTION_ADAPTER_FAMILIES.routes().findForPool(pool.adapter);
  return routeInstanceKey(
    family ?? { id: `unregistered:${pool.adapter}` },
    pool,
  );
}

function createPoolBuildControl(
  pool: PoolEntry,
  familyId: string,
  familyTimeoutMs: number,
  options: {
    readonly deadlineAtMs?: number;
    readonly signal?: AbortSignal;
  },
): {
  readonly controller: AbortController;
  readonly control: RouteEdgeBuildControl;
  readonly dispose: () => void;
} {
  const controller = new AbortController();
  const localDeadlineAtMs = Date.now() + familyTimeoutMs;
  const deadlineAtMs = Math.min(
    options.deadlineAtMs ?? Number.POSITIVE_INFINITY,
    localDeadlineAtMs,
  );
  const instanceLabel =
    `${familyId}:${pool.address.toLowerCase()}` +
    `${pool.logicalInstanceId ? `:${pool.logicalInstanceId}` : ""}` +
    `${pool.poolId ? `:${pool.poolId.toLowerCase()}` : ""}`;
  const abortFromParent = () =>
    controller.abort(options.signal?.reason ?? new Error("token-graph aborted"));
  options.signal?.addEventListener("abort", abortFromParent, { once: true });
  if (options.signal?.aborted) abortFromParent();
  const timer = setTimeout(() => {
    const globalDeadlineWon =
      options.deadlineAtMs !== undefined &&
      options.deadlineAtMs < localDeadlineAtMs;
    controller.abort(
      globalDeadlineWon
        ? new Error("token-graph deadline exceeded")
        : new Error(
            `route instance ${instanceLabel} exceeded ${familyTimeoutMs}ms`,
          ),
    );
  }, Math.max(0, deadlineAtMs - Date.now() - 1));
  return {
    controller,
    control: Object.freeze({ deadlineAtMs, signal: controller.signal }),
    dispose() {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abortFromParent);
    },
  };
}

// ─── DFS path enumeration ─────────────────────────────────────

export interface PathOpts {
  /** Max number of hops (edges) in a path. */
  maxHops?: number;
  /** Per-token cap on outgoing edges explored, ranked by score desc. Pinned edges are exempt. */
  maxPoolsPerToken?: number;
  /** Pool addresses (lowercase) exempt from top-N truncation (e.g. the victim/affected pool). */
  pinnedPools?: Set<string>;
  /** Treat pinned/code-owned edges as admission guarantees outside the scored pool budget. */
  pinnedOutsideBudget?: boolean;
  /** Rank direct edges to the requested profit token before unrelated high-score exits. */
  preferDirectClosure?: boolean;
  /** Hard safety cap on total enumerated paths (prevents DFS blow-up / OOM). */
  maxPaths?: number;
  deadlineAtMs?: number;
}

/**
 * Enumerate token paths from startToken to profitToken via DFS.
 *
 * sui-mev-style "fewer paths": at each token we only expand the top-N outgoing
 * edges by score (activity/liquidity proxy), keeping pinned edges (curated
 * backbone with score===undefined, plus the victim pool) regardless of rank.
 * maxHops caps depth; maxPaths is a hard OOM guard. Defaults are unbounded
 * (maxPoolsPerToken=Infinity, maxHops=8) so existing callers/tests are unchanged.
 */
export function buildTokenPaths(
  edges: TokenEdge[],
  startToken: string,
  profitToken: string,
  opts: PathOpts = {},
): TokenPath[] {
  const maxHops = opts.maxHops ?? 8;
  const maxPoolsPerToken = opts.maxPoolsPerToken ?? Infinity;
  const pinnedPools = opts.pinnedPools;
  const pinnedOutsideBudget = opts.pinnedOutsideBudget === true;
  const preferDirectClosure = opts.preferDirectClosure === true;
  const maxPaths = opts.maxPaths ?? 20000;
  const deadlineAtMs = opts.deadlineAtMs;

  const isPinned = (e: TokenEdge): boolean =>
    e.score === undefined || (pinnedPools?.has(e.target.toLowerCase()) ?? false);

  // Group outgoing edges by tokenIn, then truncate each token to its top-N by
  // score (pinned edges always kept). This is the core path-count limiter.
  const outByToken = new Map<string, TokenEdge[]>();
  for (const e of edges) {
    const k = e.tokenIn.toLowerCase();
    const arr = outByToken.get(k);
    if (arr) arr.push(e);
    else outByToken.set(k, [e]);
  }
  if (maxPoolsPerToken !== Infinity) {
    for (const [k, arr] of outByToken) {
      if (arr.length <= maxPoolsPerToken) continue;
      const pinned = arr.filter(isPinned);
      const rest = arr
        .filter((e) => !isPinned(e))
        .sort((a, b) =>
          Number(preferDirectClosure && b.tokenOut.toLowerCase() === profitToken.toLowerCase()) -
            Number(preferDirectClosure && a.tokenOut.toLowerCase() === profitToken.toLowerCase()) ||
          (b.score ?? 0) - (a.score ?? 0)
        )
        .slice(
          0,
          pinnedOutsideBudget
            ? maxPoolsPerToken
            : Math.max(0, maxPoolsPerToken - pinned.length),
        );
      outByToken.set(k, [...pinned, ...rest]);
    }
  }

  const paths: TokenPath[] = [];
  let nodeExpansions = 0;

  function walk(token: string, path: TokenEdge[]): void {
    if (paths.length >= maxPaths) return;
    nodeExpansions++;
    if (nodeExpansions % 64 === 0 && deadlineAtMs !== undefined && Date.now() >= deadlineAtMs) return;
    if (path.length > 0 && token.toLowerCase() === profitToken.toLowerCase()) {
      paths.push({ edges: path });
      return;
    }
    if (path.length >= maxHops) return;

    const outs = outByToken.get(token.toLowerCase());
    if (!outs) return;
    for (const edge of outs) {
      if (path.some((used) => sameDirectedEdge(used, edge))) continue;
      walk(edge.tokenOut, [...path, edge]);
      if (paths.length >= maxPaths) return;
    }
  }

  walk(startToken, []);
  return paths;
}

function sameDirectedEdge(a: TokenEdge, b: TokenEdge): boolean {
  return edgeInstanceKey(a) === edgeInstanceKey(b) &&
    edgeExecutionVariantKey(a) === edgeExecutionVariantKey(b) &&
    a.adapterId === b.adapterId &&
    a.target.toLowerCase() === b.target.toLowerCase() &&
    a.tokenIn.toLowerCase() === b.tokenIn.toLowerCase() &&
    a.tokenOut.toLowerCase() === b.tokenOut.toLowerCase() &&
    v4PoolKeyIdentity(a.v4PoolKey) === v4PoolKeyIdentity(b.v4PoolKey);
}

function v4PoolKeyIdentity(key: V4PoolKey | undefined): string {
  if (!key) return "";
  return [
    key.currency0.toLowerCase(),
    key.currency1.toLowerCase(),
    String(key.fee),
    String(key.tickSpacing),
    key.hooks.toLowerCase(),
  ].join(":");
}
