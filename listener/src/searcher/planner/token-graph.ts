import { ethers } from "ethers";
import { ADDR } from "../../shared/constants/addresses.js";
import { deriveEdgeTaxonomy, type EdgeKind, type ProtocolAction, type SlotKind } from "../strategy-taxonomy.js";
import type { VenueId } from "../venues/capability.js";
import type { VenueIdentitySource } from "../venues/identity.js";
import { PRODUCTION_ROUTE_ADAPTERS } from "../venues/production-registry.js";
import type { DeclaredProtocolVenue } from "../venues/route-leg-adapter.js";
export { v4HooksAffectSwap, v4PoolId } from "../venues/swaps/univ4-common.js";

/** Minimal interface for on-chain read queries. StateBackend and ethers Provider both satisfy this. */
export interface TokenQueryBackend {
  call(req: { to: string; data: string; blockTag?: ethers.BlockTag }): Promise<string>;
  getLogs?(req: {
    address: string;
    topics: string[];
    fromBlock: string;
    toBlock: string;
  }): Promise<Array<{ data: string; topics: string[] }>>;
}

export interface TokenEdge {
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
  adapter: "curve" | "curve-nr" | "curve-underlying" | "univ3" | "univ2" | "univ4"
    | "balancer-v3" | "dodo-v2" | "psm" | "fluid-vault" | "fluid-dex" | "wsteth" | "erc4626"
    | "goldx" | "rocksolid" | "metronome-synth" | "metronome-hgusdc";
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
   * NON-STANDARD ERC4626: redeem/withdraw pays a DIFFERENT token than `asset()`, in a
   * DIFFERENT quantity than `previewRedeem` returns (previewRedeem is the asset()-denominated
   * VALUE, not the amount of the token actually transferred). Our erc4626 adapter models the
   * redeem edge as share -> asset() with quantity previewRedeem, which is wrong on BOTH the
   * output token and the routed amount, so the leg after it reverts on-chain. We cannot quote
   * these with the single-call previewRedeem descriptor (correct output needs a second call on
   * a different contract). Flagged vaults are EXCLUDED from the graph entirely — a wrong edge
   * is worse than no edge (deposit alone can never close a loop anyway). Verified per-vault via
   * a fork redeem receipt-decode; see docs. */
  nonStandardRedeem?: boolean;
  /**
   * Receipt-verified out-token for a nonStandardRedeem vault (the token the silo actually pays,
   * != asset()). Declaring it opts the flagged vault into the `erc4626-redeem-silo` edge (quoted
   * via vault.previewRedeem -> outToken.previewWithdraw). A nonStandardRedeem vault WITHOUT this
   * still emits ZERO edges (fail-closed — a wrong edge is worse than no edge).
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
}

// DEX pools are discovered via scanActivePools / factory events. Static protocol
// singletons come from their registered adapters; externally discovered families
// and legacy compat venues stay here until they have a derived admission source.
const EXTERNAL_AND_LEGACY_POOL_REGISTRY: PoolEntry[] = [
  // Compatibility fallbacks remain until every address passes a real
  // source-derived Production Replay. Discovery never receives these rows as
  // candidate or identity evidence, so the dynamic path still has to prove
  // itself independently. The family buildEdges path re-attests asset().
  { address: ADDR.SUSDS, adapter: "erc4626", fixedTokenIn: ADDR.USDS },
  { address: ADDR.WSTUSR, adapter: "erc4626", fixedTokenIn: ADDR.USR },
  { address: "0xBEEF01735c132Ada46AA9aA4c54623cAA92A64CB", adapter: "erc4626", fixedTokenIn: ADDR.USDC },
  { address: "0xbEef047a543E45807105E51A8BBEFCc5950fcfBa", adapter: "erc4626", fixedTokenIn: ADDR.USDT },
  // Non-standard Strata srUSDe remains an explicit safety exception: Withdraw
  // pays sUSDe rather than asset() and execution needs the four-argument exact-in
  // selector plus a two-contract quote. Generic EIP-4626 discovery intentionally
  // rejects it until those semantics are derivable from code-owned evidence.
  {
    address: "0x3d7d6fdf07EE548B939A80edbc9B2256d0cdc003",
    adapter: "erc4626",
    fixedTokenIn: ADDR.USDE,
    nonStandardRedeem: true,
    redeemTokenOut: "0x9D39A5DE30e57443BfF2A8307A4256c8797A3497",
  },
  { address: "0xac3E018457B222d93114458476f3E3416Abbe38F", adapter: "erc4626", fixedTokenIn: ADDR.FRXETH },
  { address: "0x7Bc3485026Ac48b6cf9BaF0A377477Fff5703Af8", adapter: "erc4626", fixedTokenIn: ADDR.USDT },
  { address: "0xD4fa2D31b7968E448877f69A96DE69f5de8cD23E", adapter: "erc4626", fixedTokenIn: ADDR.USDC },
  { address: "0xc441d0Bd70DBcF711f4BbA19AeA3deff47ce1C48", adapter: "erc4626", fixedTokenIn: ADDR.USDC },
  { address: "0x395dA89bDb9431621A75DF4e2E3B993Acc2CaB3D", adapter: "erc4626", fixedTokenIn: ADDR.WETH },
  { address: "0x056B269Eb1f75477a8666ae8C7fE01b64dD55eCc", adapter: "erc4626", fixedTokenIn: ADDR.USDC },
  { address: "0xe3DA4B83C9dd4c4D185ecE42077462b3F35c454a", adapter: "erc4626", fixedTokenIn: ADDR.USDC },
  { address: "0x0655977FEb2f289A4aB78af67BAB0d17aAb84367", adapter: "erc4626", fixedTokenIn: ADDR.CRVUSD },
  { address: "0x6aD038cA6C04e885630851278ca0a856Ad9a66Cc", adapter: "erc4626", fixedTokenIn: ADDR.USDC },
  { address: "0x6d134cAAD0CA29Cd6ea145f6C0DC766076690547", adapter: "erc4626", fixedTokenIn: ADDR.USDT },
  { address: "0xD166337499E176bbC38a1FBd113Ab144e5bd2Df7", adapter: "erc4626", fixedTokenIn: "0x23238f20b894f29041f48D88eE91131C395Aaa71" },
  { address: "0xC255910618158F48FA461874471Aa24AEfbDC23A", adapter: "erc4626", fixedTokenIn: "0x64aa3364F17a4D01c6f1751Fd97C2BD3D7e7f1D5" },
  { address: "0xC71Ea051a5F82c67ADcF634c36FFE6334793D24C", adapter: "erc4626", fixedTokenIn: "0x40D16FC0246aD3160Ccc09B8D0D3A2cD28aE6C2f" },
  { address: "0x43680aBF18cf54898Be84C6eF78237CFBD441883", adapter: "erc4626", fixedTokenIn: "0x8aD3c73F833d3F9A523aB01476625F269aEB7Cf0" },
  { address: "0x4825eFF24F9B7b76EEAFA2ecc6A1D5dFCb3c1c3f", adapter: "erc4626", fixedTokenIn: ADDR.USDC },
  { address: "0xB8280955aE7b5207AF4CDbdCd775135Bd38157fE", adapter: "erc4626", fixedTokenIn: ADDR.USDT },
  {
    // Fluid deployment registry: "Fluid Dex Pool - USDC-USDT-CONCENTRATED".
    // Plain swapIn token order is USDC(token0) -> USDT(token1).
    address: ADDR.FLUID_DEX_USDC_USDT,
    adapter: "fluid-dex",
    token0: ADDR.USDC,
    token1: ADDR.USDT,
  },
  {
    address: ADDR.FLUID_VAULT_WSTUSR_USDC,
    adapter: "fluid-vault",
    fixedTokenIn: ADDR.WSTUSR,
    fixedTokenOut: ADDR.USDC,
    fixedSlotKind: "lend",
  },
];

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
  const addresses = new Set<string>();
  for (const pool of result) {
    const address = pool.address.toLowerCase();
    if (addresses.has(address)) throw new Error(`duplicate protocol registry venue ${address}`);
    addresses.add(address);
  }
  return result;
}

export const POOL_REGISTRY: PoolEntry[] = mergeDeclaredProtocolVenues(
  EXTERNAL_AND_LEGACY_POOL_REGISTRY,
  PRODUCTION_ROUTE_ADAPTERS.protocols.flatMap((adapter) => adapter.declaredVenues),
);

// ─── Auto-build graph from pool registry via eth_call ─────────


const ADAPTER_MAP: Record<string, string> = {
  "curve": "curve-exchange-plain",
  "curve-nr": "curve-exchange-nr",
  "curve-underlying": "curve-exchange-underlying",
  "univ3": "univ3-swap",
  "univ2": "univ2-swap",
  "univ4": "univ4-unlock",
  "balancer-v3": "balancer-v3-unlock",
  "psm": "psm",
  "fluid-vault": "fluid-vault",
  "fluid-dex": "fluid-dex-swap",
  "metronome-synth": "metronome-synth-swap",
};

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
): Promise<TokenGraphBuildResult> {
  const edges: TokenEdge[] = [];
  const successful: PoolGraphBuildSuccess[] = [];
  const failed: PoolGraphBuildFailure[] = [];

  const BATCH = 50;
  for (let i = 0; i < pools.length; i += BATCH) {
    const batch = pools.slice(i, i + BATCH);
    const results = await Promise.allSettled(
      batch.map((pool) => queryPoolEdges(pool, backend)),
    );
    for (let j = 0; j < results.length; j++) {
      const pool = batch[j];
      const result = results[j];
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
    if (pools.length > 200 && i % 500 === 0 && i > 0) {
      console.log(`[token-graph] progress: ${i}/${pools.length} pools, ${edges.length} edges, ${failed.length} skipped`);
    }
  }

  console.log(
    `[token-graph] built ${edges.length} edges from ${pools.length} pools` +
      (failed.length > 0 ? ` (${failed.length} skipped)` : ""),
  );
  return { edges, successful, failed };
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
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

async function queryPoolEdges(pool: PoolEntry, backend: TokenQueryBackend): Promise<TokenEdge[]> {
  if (PRODUCTION_ROUTE_ADAPTERS.routeLegs.findForPool(pool.adapter)) {
    return PRODUCTION_ROUTE_ADAPTERS.routeLegs.buildEdges(pool, backend);
  }
  const adapterId = ADAPTER_MAP[pool.adapter];
  const edges: TokenEdge[] = [];

  switch (pool.adapter) {
    case "fluid-dex": {
      if (!pool.token0 || !pool.token1) {
        throw new Error(`fluid-dex pool ${pool.address} missing pinned token0/token1 metadata`);
      }
      const [t0, t1] = [ethers.getAddress(pool.token0), ethers.getAddress(pool.token1)];
      edges.push(
        { adapterId, target: pool.address, tokenIn: t0, tokenOut: t1, slotKind: "swap", poolToken0: t0, poolToken1: t1, ...deriveEdgeTaxonomy("swap") },
        { adapterId, target: pool.address, tokenIn: t1, tokenOut: t0, slotKind: "swap", poolToken0: t0, poolToken1: t1, ...deriveEdgeTaxonomy("swap") },
      );
      break;
    }
  }

  // Propagate the discovery activity score onto every edge of this pool.
  // undefined (curated POOL_REGISTRY / protocol pools) stays undefined → pinned.
  for (const edge of edges) edge.score = pool.score;
  return edges;
}

// ─── On-chain queries ─────────────────────────────────────────

// ─── Sync fallback (used by AC-3 tests that don't want async init) ──

/**
 * Hardcoded fallback — same pools, manually written edges.
 * Kept for AC-3 tests that run without a live Anvil for graph init.
 * Production should use buildTokenGraph(state) instead.
 */
export function defaultTokenGraph(): TokenEdge[] {
  return [
    {
      adapterId: "fluid-vault",
      target: ADDR.FLUID_VAULT_WSTUSR_USDC,
      tokenIn: ADDR.WSTUSR,
      tokenOut: ADDR.USDC,
      slotKind: "lend",
      ...deriveEdgeTaxonomy("lend"),
    },
    {
      adapterId: "psm",
      target: ADDR.SKY_PSM_LITE,
      tokenIn: ADDR.USDC,
      tokenOut: ADDR.DAI,
      slotKind: "protocol",
      protocolAction: "convert",
      ...deriveEdgeTaxonomy("protocol", "convert"),
    },
    {
      adapterId: "univ4-unlock",
      target: ADDR.UNISWAP_V4_POOL_MANAGER,
      tokenIn: ADDR.DAI,
      tokenOut: ADDR.USDT,
      slotKind: "swap",
      ...deriveEdgeTaxonomy("swap"),
      v4PoolKey: {
        currency0: ADDR.DAI,
        currency1: ADDR.USDT,
        fee: 68,
        tickSpacing: 1,
        hooks: ADDR.ZERO,
      },
    },
    {
      adapterId: "fluid-dex-swap",
      target: ADDR.FLUID_DEX_USDC_USDT,
      tokenIn: ADDR.USDC,
      tokenOut: ADDR.USDT,
      slotKind: "swap",
      ...deriveEdgeTaxonomy("swap"),
      poolToken0: ADDR.USDC,
      poolToken1: ADDR.USDT,
    },
    {
      adapterId: "fluid-dex-swap",
      target: ADDR.FLUID_DEX_USDC_USDT,
      tokenIn: ADDR.USDT,
      tokenOut: ADDR.USDC,
      slotKind: "swap",
      ...deriveEdgeTaxonomy("swap"),
      poolToken0: ADDR.USDC,
      poolToken1: ADDR.USDT,
    },
    {
      adapterId: "curve-exchange-plain",
      target: ADDR.CURVE_3POOL,
      tokenIn: ADDR.USDC,
      tokenOut: ADDR.USDT,
      slotKind: "swap",
      ...deriveEdgeTaxonomy("swap"),
      curveI: 1,
      curveJ: 2,
    },
    {
      adapterId: "curve-exchange-plain",
      target: ADDR.CURVE_3POOL,
      tokenIn: ADDR.USDC,
      tokenOut: ADDR.DAI,
      slotKind: "swap",
      ...deriveEdgeTaxonomy("swap"),
      curveI: 1,
      curveJ: 0,
    },
    {
      adapterId: "curve-exchange-plain",
      target: ADDR.CURVE_3POOL,
      tokenIn: ADDR.DAI,
      tokenOut: ADDR.USDT,
      slotKind: "swap",
      ...deriveEdgeTaxonomy("swap"),
      curveI: 0,
      curveJ: 2,
    },
    {
      adapterId: "univ3-swap",
      target: ADDR.UNISWAP_V3_USDT_WETH,
      tokenIn: ADDR.USDT,
      tokenOut: ADDR.WETH,
      slotKind: "swap",
      ...deriveEdgeTaxonomy("swap"),
      poolToken0: ADDR.WETH,
      poolToken1: ADDR.USDT,
    },
    {
      adapterId: "univ3-swap",
      target: ADDR.UNISWAP_V3_USDT_WETH,
      tokenIn: ADDR.WETH,
      tokenOut: ADDR.USDT,
      slotKind: "swap",
      ...deriveEdgeTaxonomy("swap"),
      poolToken0: ADDR.WETH,
      poolToken1: ADDR.USDT,
    },
    {
      adapterId: "curve-exchange",
      target: ADDR.CURVE_SUSDS_USDT,
      tokenIn: ADDR.USDT,
      tokenOut: ADDR.SUSDS,
      slotKind: "swap",
      ...deriveEdgeTaxonomy("swap"),
    },
    {
      adapterId: "curve-exchange",
      target: ADDR.CURVE_DOLA_SUSDS,
      tokenIn: ADDR.SUSDS,
      tokenOut: ADDR.DOLA,
      slotKind: "swap",
      ...deriveEdgeTaxonomy("swap"),
    },
    {
      adapterId: "curve-exchange-nr",
      target: ADDR.CURVE_DOLA_WSTUSR,
      tokenIn: ADDR.DOLA,
      tokenOut: ADDR.WSTUSR,
      slotKind: "swap",
      ...deriveEdgeTaxonomy("swap"),
      curveI: 0,
      curveJ: 1,
    },
  ];
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
  return a.adapterId === b.adapterId &&
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
