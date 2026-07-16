import { ethers } from "ethers";
import type { OrderflowEvent } from "../orderflow/manual-source.js";
import type { TokenEdge, TokenQueryBackend } from "../planner/token-graph.js";
import { PRODUCTION_ROUTE_ADAPTERS } from "../venues/production-registry.js";
import {
  collectUniV2PostStates,
  computeUniV2PostStateFromPreReserves,
  decodeUniV2SwapData,
  decodeUniV3SwapData,
  UNIV2_SWAP_TOPIC,
  UNIV3_SWAP_TOPIC,
  withUniV2PostStates,
  type PoolImpact,
  type ObservedSwapImpact,
  type SwapEventLog,
} from "../venues/swap-observation.js";

export type { PoolImpact } from "../venues/swap-observation.js";

type EventLog = SwapEventLog;

// ─── Topic hashes (computed, not hand-written) ────────────────

const topic = (sig: string) => ethers.id(sig);

const UNIV2_SWAP = UNIV2_SWAP_TOPIC;
const UNIV3_SWAP = UNIV3_SWAP_TOPIC;
const ERC20_TRANSFER = topic("Transfer(address,address,uint256)");

// ─── Curve direct-call selectors ──────────────────────────────

const curveIface = new ethers.Interface([
  "function exchange(int128 i, int128 j, uint256 dx, uint256 min_dy)",
  "function exchange(int128 i, int128 j, uint256 dx, uint256 min_dy, address receiver)",
  "function exchange_received(int128 i, int128 j, uint256 dx, uint256 min_dy)",
  "function exchange_received(int128 i, int128 j, uint256 dx, uint256 min_dy, address receiver)",
  "function exchange_underlying(int128 i, int128 j, uint256 dx, uint256 min_dy)",
]);

const CURVE_SELECTORS = new Set([
  "0x3df02124",
  "0xddc1f59d",
  "0x7e3db030",
  "0xafb43012",
  "0xa6417ed6",
]);

function impactsFromCurveIds(
  pool: string,
  i: bigint,
  j: bigint,
  amountIn: bigint,
  edges: TokenEdge[],
): PoolImpact[] {
  const out: PoolImpact[] = [];

  for (const edge of edges) {
    if (edge.curveI === undefined || edge.curveJ === undefined) continue;
    if (BigInt(edge.curveI) === i && BigInt(edge.curveJ) === j) {
      out.push({
        pool: edge.target,
        tokenIn: edge.tokenIn,
        tokenOut: edge.tokenOut,
        amountIn,
        matchedAdapterId: edge.adapterId,
      });
    } else if (BigInt(edge.curveI) === j && BigInt(edge.curveJ) === i) {
      out.push({
        pool: edge.target,
        tokenIn: edge.tokenOut,
        tokenOut: edge.tokenIn,
        amountIn,
        matchedAdapterId: edge.adapterId,
      });
    }
  }

  if (out.length > 0) return out;
  // Fallback: single edge, direction unknown — return as-is
  if (edges.length === 1) {
    return [{
      pool: edges[0].target,
      tokenIn: edges[0].tokenIn,
      tokenOut: edges[0].tokenOut,
      amountIn,
      matchedAdapterId: edges[0].adapterId,
    }];
  }

  return [];
}

// ─── Transfer-based pool detection ───────────────────────────
// MEV-Share hints often only expose ERC-20 Transfer logs.
// Paired transfers (tokenA→pool + pool→tokenB in same hint) reliably
// indicate a swap. Single transfers are ambiguous (could be LP add,
// repay, settlement) and only logged, not acted on.

interface PoolTouch {
  pool: string;
  token: string;
  amount: bigint;
  direction: "in" | "out";
}

function collectPoolTouches(
  logs: EventLog[],
  edgesByTarget: Map<string, TokenEdge[]>,
  broadPoolAddrs?: Map<string, string> | null,
): PoolTouch[] {
  const touches: PoolTouch[] = [];
  // Use broad pool map (factory-indexed) if available, otherwise routing graph keys
  const poolSet: { has(k: string): boolean } = broadPoolAddrs ?? new Set(edgesByTarget.keys());

  for (const log of logs) {
    if (log.topics[0]?.toLowerCase() !== ERC20_TRANSFER) continue;
    if (log.topics.length < 3) continue;

    const token = log.address.toLowerCase();
    const from = ("0x" + log.topics[1].slice(26)).toLowerCase();
    const to = ("0x" + log.topics[2].slice(26)).toLowerCase();
    const value = parseUintLogData(log.data);
    if (value === null) continue;
    if (value === 0n) continue;

    if (poolSet.has(to)) {
      touches.push({ pool: to, token, amount: value, direction: "in" });
    }
    if (poolSet.has(from)) {
      touches.push({ pool: from, token, amount: value, direction: "out" });
    }
  }
  return touches;
}

/** Adapter ID suffix → full swap adapter ID */
const FACTORY_ADAPTER_MAP: Record<string, string> = {
  univ2: "univ2-swap",
  univ3: "univ3-swap",
  curve: "curve-exchange",
  "curve-nr": "curve-exchange-nr",
};

function pairedTransferImpacts(
  touches: PoolTouch[],
  edgesByTarget: Map<string, TokenEdge[]>,
  broadPoolAddrs?: Map<string, string> | null,
): PoolImpact[] {
  const byPool = new Map<string, PoolTouch[]>();
  for (const t of touches) {
    const arr = byPool.get(t.pool) ?? [];
    arr.push(t);
    byPool.set(t.pool, arr);
  }

  const impacts: PoolImpact[] = [];
  for (const [pool, poolTouches] of byPool) {
    const ins = poolTouches.filter(isInboundTouch);
    const outs = poolTouches.filter(isOutboundTouch);
    if (ins.length === 0 || outs.length === 0) continue;

    const edges = edgesByTarget.get(pool);

    for (const inT of ins) {
      for (const outT of outs) {
        if (inT.token === outT.token) continue;

        if (edges) {
          // Routing graph pool: match against known edges
          const edge = edges.find(
            (e) =>
              e.tokenIn.toLowerCase() === inT.token &&
              e.tokenOut.toLowerCase() === outT.token,
          );
          if (edge) {
            impacts.push({
              pool: edge.target,
              tokenIn: edge.tokenIn,
              tokenOut: edge.tokenOut,
              amountIn: inT.amount,
              matchedAdapterId: edge.adapterId,
              poolToken0: edge.poolToken0,
              poolToken1: edge.poolToken1,
            });
          }
        } else {
          // Factory-indexed pool without routing graph edges:
          // create impact from Transfer log tokens directly.
          // Look up adapter type from factory pool map.
          const factoryAdapter = broadPoolAddrs?.get(pool);
          const adapterId = factoryAdapter
            ? (FACTORY_ADAPTER_MAP[factoryAdapter] ?? "univ2-swap")
            : "univ2-swap";
          impacts.push({
            pool,
            tokenIn: inT.token,
            tokenOut: outT.token,
            amountIn: inT.amount,
            matchedAdapterId: adapterId,
          });
        }
      }
    }
  }
  return impacts;
}

/**
 * Detect pools by correlating Swap events with Transfer events.
 *
 * If a log address emits a UniV2 Swap (0xd78ad95f) or UniV3 Swap (0xc42079f9),
 * and the same address appears as from/to in Transfer events, it's a pool —
 * even if not in our factory set or routing graph.
 *
 * Skips pools already covered by standard decoders or Transfer fallback.
 */
function swapEventCorrelatedImpacts(
  logs: EventLog[],
  edgesByTarget: Map<string, TokenEdge[]>,
  broadPoolAddrs?: Map<string, string> | null,
): PoolImpact[] {
  // Step 1: Find addresses that emitted a Swap event
  const swapPools = new Map<string, { adapter: string; v3PostState?: NonNullable<PoolImpact["v3PostState"]> }>();
  for (const log of logs) {
    const t0 = log.topics[0]?.toLowerCase();
    const addr = log.address.toLowerCase();
    // Skip if already in routing graph or broadPoolAddrs (handled above)
    if (edgesByTarget.has(addr)) continue;
    if (broadPoolAddrs?.has(addr)) continue;

    if (t0 === UNIV2_SWAP) {
      swapPools.set(addr, { adapter: "univ2-swap" });
    } else if (t0 === UNIV3_SWAP) {
      try {
        swapPools.set(addr, { adapter: "univ3-swap", v3PostState: decodeUniV3SwapData(log.data).v3PostState });
      } catch {
        swapPools.set(addr, { adapter: "univ3-swap" });
      }
    }
  }
  if (swapPools.size === 0) return [];

  // Step 2: Find Transfer events involving these Swap-emitting addresses
  const transfers = new Map<string, { ins: PoolTouch[]; outs: PoolTouch[] }>();
  for (const log of logs) {
    if (log.topics[0]?.toLowerCase() !== ERC20_TRANSFER) continue;
    if (log.topics.length < 3) continue;
    const token = log.address.toLowerCase();
    const from = ("0x" + log.topics[1].slice(26)).toLowerCase();
    const to = ("0x" + log.topics[2].slice(26)).toLowerCase();
    const value = parseUintLogData(log.data);
    if (value === null) continue;
    if (value === 0n) continue;

    if (swapPools.has(to)) {
      const entry = transfers.get(to) ?? { ins: [], outs: [] };
      entry.ins.push({ pool: to, token, amount: value, direction: "in" });
      transfers.set(to, entry);
    }
    if (swapPools.has(from)) {
      const entry = transfers.get(from) ?? { ins: [], outs: [] };
      entry.outs.push({ pool: from, token, amount: value, direction: "out" });
      transfers.set(from, entry);
    }
  }

  // Step 3: Create impacts for pools with paired in+out transfers
  const impacts: PoolImpact[] = [];
  for (const [pool, { ins, outs }] of transfers) {
    if (ins.length === 0 || outs.length === 0) continue;
    const swapMeta = swapPools.get(pool)!;
    for (const inT of ins) {
      for (const outT of outs) {
        if (inT.token === outT.token) continue;
        impacts.push({
          pool,
          tokenIn: inT.token,
          tokenOut: outT.token,
          amountIn: inT.amount,
          matchedAdapterId: swapMeta.adapter,
          ...(swapMeta.v3PostState ? { v3PostState: swapMeta.v3PostState } : {}),
        });
      }
    }
  }
  return impacts;
}

// ─── Swap-only detection (async, queries token0/token1) ─────
// MEV-Share sometimes exposes ONLY the Swap event — no Transfer logs.
// Standard decoders handle this for pools in the routing graph.
// For unknown pools (not in edgesByTarget), we query token0/token1
// on-chain, then decode swap direction from the event data.

const TOKEN0_TOKEN1_IFACE = new ethers.Interface([
  "function token0() view returns (address)",
  "function token1() view returns (address)",
]);

// Module-level cache: pool address → [token0, token1].
// Survives across calls within the same process (avoids duplicate on-chain queries).
const poolTokenCache = new Map<string, [string, string]>();

async function swapOnlyImpacts(
  logs: EventLog[],
  edgesByTarget: Map<string, TokenEdge[]>,
  broadPoolAddrs: Map<string, string> | null | undefined,
  tokenQuery: TokenQueryBackend,
): Promise<PoolImpact[]> {
  const impacts: PoolImpact[] = [];

  // Collect Swap events at pools NOT already in routing graph
  const unknownSwaps: Array<{ log: EventLog; addr: string; swapType: "univ2" | "univ3" }> = [];
  for (const log of logs) {
    const addr = log.address.toLowerCase();
    if (edgesByTarget.has(addr)) continue; // standard decoder handles it
    const t0 = log.topics[0]?.toLowerCase();
    if (t0 === UNIV2_SWAP) unknownSwaps.push({ log, addr, swapType: "univ2" });
    else if (t0 === UNIV3_SWAP) unknownSwaps.push({ log, addr, swapType: "univ3" });
  }
  if (unknownSwaps.length === 0) return impacts;

  // Query token0/token1 for uncached pools (parallel, 2 eth_calls each)
  const uniquePools = [...new Set(unknownSwaps.map((s) => s.addr))];
  const uncached = uniquePools.filter((p) => !poolTokenCache.has(p));

  if (uncached.length > 0) {
    const t0Data = TOKEN0_TOKEN1_IFACE.encodeFunctionData("token0");
    const t1Data = TOKEN0_TOKEN1_IFACE.encodeFunctionData("token1");

    await Promise.allSettled(
      uncached.map(async (pool) => {
        try {
          const [r0, r1] = await Promise.all([
            tokenQuery.call({ to: pool, data: t0Data }),
            tokenQuery.call({ to: pool, data: t1Data }),
          ]);
          if (!r0 || r0 === "0x" || !r1 || r1 === "0x") return;
          const token0 = ethers.getAddress("0x" + r0.slice(-40));
          const token1 = ethers.getAddress("0x" + r1.slice(-40));
          if (token0 !== ethers.ZeroAddress && token1 !== ethers.ZeroAddress) {
            poolTokenCache.set(pool, [token0, token1]);
          }
        } catch {
          // Not a standard Uni pool, or RPC failure — skip silently
        }
      }),
    );
  }

  for (const { log, addr, swapType } of unknownSwaps) {
    const tokens = poolTokenCache.get(addr);
    if (!tokens) continue;
    const [token0, token1] = tokens;

    try {
      let tokenIn: string, tokenOut: string, amountIn: bigint;
      let v3PostState: PoolImpact["v3PostState"];
      let v2PostState: PoolImpact["v2PostState"];

      if (swapType === "univ2") {
        const swap = decodeUniV2SwapData(log.data);
        tokenIn = swap.amount0In > 0n ? token0 : token1;
        tokenOut = swap.amount0In > 0n ? token1 : token0;
        amountIn = swap.amount0In > 0n ? swap.amount0In : swap.amount1In;
        v2PostState = await computeUniV2PostStateFromPreReserves(addr, swap, tokenQuery) ?? undefined;
      } else {
        const { amount0: a0, amount1: a1, v3PostState: postState } = decodeUniV3SwapData(log.data);
        // UniV3: positive amount = tokens sent TO pool (input)
        tokenIn = a0 > 0n ? token0 : token1;
        tokenOut = a0 > 0n ? token1 : token0;
        amountIn = a0 > 0n ? a0 : a1;
        if (amountIn < 0n) amountIn = -amountIn;
        v3PostState = postState;
      }

      const factoryAdapter = broadPoolAddrs?.get(addr);
      const adapterId = factoryAdapter
        ? (FACTORY_ADAPTER_MAP[factoryAdapter] ?? (swapType === "univ2" ? "univ2-swap" : "univ3-swap"))
        : (swapType === "univ2" ? "univ2-swap" : "univ3-swap");

      impacts.push({
        pool: addr,
        tokenIn,
        tokenOut,
        amountIn,
        matchedAdapterId: adapterId,
        poolToken0: token0,
        poolToken1: token1,
        ...(v2PostState ? { v2PostState } : {}),
        ...(v3PostState ? { v3PostState } : {}),
      });
      console.log(
        `[pool-impact] swap-only decoded: pool=${addr.slice(0, 10)} ` +
          `${tokenIn.slice(0, 10)}→${tokenOut.slice(0, 10)} amt=${amountIn}`,
      );
    } catch {
      // Malformed Swap event data — skip
    }
  }

  return impacts;
}

function isInboundTouch(touch: PoolTouch): boolean {
  const { direction } = touch;
  return direction === "in";
}

function parseUintLogData(data: string): bigint | null {
  if (!data || data === "0x") return null;
  try {
    return BigInt(data);
  } catch {
    return null;
  }
}

function isOutboundTouch(touch: PoolTouch): boolean {
  const { direction } = touch;
  return direction === "out";
}

// ─── Public API ───────────────────────────────────────────────

export async function detectImpactFromLogs(
  logs: EventLog[],
  graph: TokenEdge[],
  broadPoolAddrs?: Map<string, string> | null,
  tokenQuery?: TokenQueryBackend | null,
): Promise<PoolImpact[]> {
  const impacts: PoolImpact[] = [];
  const observedImpacts: ObservedSwapImpact[] = [];
  const edgesByTarget = groupEdgesByTarget(graph);

  const receiptTopics = new Set(logs.map((log) => log.topics[0]?.toLowerCase()).filter(Boolean));
  const invokedObservations = new Set<object>();
  for (const adapter of PRODUCTION_ROUTE_ADAPTERS.swaps) {
    if (invokedObservations.has(adapter.observation)) continue;
    if (!adapter.observation.topics.some((candidate) => receiptTopics.has(candidate.toLowerCase()))) {
      continue;
    }
    invokedObservations.add(adapter.observation);
    try {
      observedImpacts.push(...await adapter.observation.decodeSwapImpacts({
        logs,
        graph,
        edgesByTarget,
        tokenQuery,
      }));
    } catch {
      // A malformed log for one execution family must not suppress the others.
    }
  }
  if (observedImpacts.length > 1) {
    observedImpacts.sort((left, right) => left.logIndex - right.logIndex);
  }
  for (const observed of observedImpacts) impacts.push(observed.impact);

  // The V2 observer already correlated Sync for successfully decoded graph
  // impacts. Only build the legacy fallback map for V2 pools that still lack an
  // exact impact, avoiding a second full receipt scan/Sync decode on the common path.
  const unresolvedV2Pools = new Set(
    logs
      .filter((log) => log.topics[0]?.toLowerCase() === UNIV2_SWAP)
      .map((log) => log.address.toLowerCase()),
  );
  for (const impact of impacts) {
    if (impact.matchedAdapterId === "univ2-swap" && impact.v2PostState) {
      unresolvedV2Pools.delete(impact.pool.toLowerCase());
    }
  }
  const v2PostStates = unresolvedV2Pools.size > 0
    ? await collectUniV2PostStates(logs)
    : new Map<string, NonNullable<PoolImpact["v2PostState"]>>();

  // Paired Transfer fallback: tokenA→pool + pool→tokenB = swap
  // Uses broadPoolAddrs (factory-indexed) for wider matching
  const touches = collectPoolTouches(logs, edgesByTarget, broadPoolAddrs);
  impacts.push(...withUniV2PostStates(pairedTransferImpacts(touches, edgesByTarget, broadPoolAddrs), v2PostStates));

  // Swap-event correlation: detect unknown pools by correlating Swap events
  // with Transfer events in the same log set. Works for any pool, even those
  // not in broadPoolAddrs (created before our factory scan window).
  impacts.push(...withUniV2PostStates(swapEventCorrelatedImpacts(logs, edgesByTarget, broadPoolAddrs), v2PostStates));

  // Swap-only hints: MEV-Share often exposes only the Swap event (no Transfer).
  // For pools in the routing graph, the standard decoder already handles this.
  // For unknown pools, query token0/token1 on-chain and decode from Swap data.
  if (tokenQuery) {
    impacts.push(...withUniV2PostStates(
      await swapOnlyImpacts(logs, edgesByTarget, broadPoolAddrs, tokenQuery),
      v2PostStates,
    ));
  }

  return dedupeImpacts(impacts);
}

export async function detectPoolImpact(
  event: OrderflowEvent,
  graph: TokenEdge[],
  broadPoolAddrs?: Map<string, string> | null,
  tokenQuery?: TokenQueryBackend | null,
): Promise<PoolImpact[]> {
  const directImpacts = detectDirectCalls(event, graph);
  const logImpacts = await detectImpactFromLogs(event.logs, graph, broadPoolAddrs, tokenQuery);
  return dedupeImpacts([...directImpacts, ...logImpacts]);
}

// ─── Direct calldata detection ────────────────────────────────

function detectDirectCalls(event: OrderflowEvent, graph: TokenEdge[]): PoolImpact[] {
  const target = event.to?.toLowerCase();
  if (!target) return [];

  const edges = graph.filter((edge) => edge.target.toLowerCase() === target);
  if (edges.length === 0) return [];

  const selector = event.input.slice(0, 10).toLowerCase();
  if (CURVE_SELECTORS.has(selector)) {
    const parsed = curveIface.parseTransaction({ data: event.input });
    if (!parsed) return [];
    return impactsFromCurveIds(
      event.to!,
      BigInt(parsed.args[0]),
      BigInt(parsed.args[1]),
      BigInt(parsed.args[2]),
      edges,
    );
  }

  return [];
}

// ─── Helpers ──────────────────────────────────────────────────

function groupEdgesByTarget(graph: TokenEdge[]): Map<string, TokenEdge[]> {
  const map = new Map<string, TokenEdge[]>();
  for (const edge of graph) {
    const key = edge.target.toLowerCase();
    const arr = map.get(key) ?? [];
    arr.push(edge);
    map.set(key, arr);
  }
  return map;
}

function dedupeImpacts(impacts: PoolImpact[]): PoolImpact[] {
  const order: string[] = [];
  const seen = new Map<string, PoolImpact>();
  for (const impact of impacts) {
    const key = [
      impact.pool.toLowerCase(),
      impact.poolId ?? "",
      impact.tokenIn.toLowerCase(),
      impact.tokenOut.toLowerCase(),
      impact.amountIn.toString(),
      impact.matchedAdapterId,
    ].join(":");
    const existing = seen.get(key);
    if (!existing) {
      seen.set(key, impact);
      order.push(key);
    } else if (!hasExactPostState(existing) && hasExactPostState(impact)) {
      seen.set(key, impact);
    }
  }
  return order.map((key) => seen.get(key)!);
}

function hasExactPostState(impact: PoolImpact): boolean {
  return Boolean(impact.v2PostState || impact.v3PostState || impact.v4PostState);
}
