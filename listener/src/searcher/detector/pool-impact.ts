import { ethers } from "ethers";
import type { OrderflowEvent } from "../orderflow/manual-source.js";
import type { TokenEdge } from "../planner/token-graph.js";

export interface PoolImpact {
  pool: string;
  tokenIn: string;
  tokenOut: string;
  amountIn: bigint;
  matchedAdapterId: string;
}

interface EventLog {
  address: string;
  topics: string[];
  data: string;
}

interface ImpactDecoder {
  adapterIds: string[];
  decodeLog(log: EventLog, edges: TokenEdge[]): PoolImpact[];
}

// ─── Topic hashes (computed, not hand-written) ────────────────

const topic = (sig: string) => ethers.id(sig);

const CURVE_TOKEN_EXCHANGE = topic("TokenExchange(address,int128,uint256,int128,uint256)");
const UNIV3_SWAP = topic("Swap(address,address,int256,int256,uint160,uint128,int24)");
const UNIV2_SWAP = topic("Swap(address,uint256,uint256,uint256,uint256,address)");
const ERC20_TRANSFER = topic("Transfer(address,address,uint256)");

// ─── Curve direct-call selectors ──────────────────────────────

const curveIface = new ethers.Interface([
  "function exchange(int128 i, int128 j, uint256 dx, uint256 min_dy)",
  "function exchange(int128 i, int128 j, uint256 dx, uint256 min_dy, address receiver)",
  "function exchange_received(int128 i, int128 j, uint256 dx, uint256 min_dy)",
  "function exchange_received(int128 i, int128 j, uint256 dx, uint256 min_dy, address receiver)",
]);

const CURVE_SELECTORS = new Set([
  "0x3df02124",
  "0xddc1f59d",
  "0x7e3db030",
  "0xafb43012",
]);

// ─── Curve decoder ────────────────────────────────────────────

const curveDecoder: ImpactDecoder = {
  adapterIds: [
    "curve-exchange-plain",
    "curve-exchange-nr",
    "curve-exchange",
    "curve-exchange-received-uint",
  ],

  decodeLog(log, edges) {
    if (log.topics[0]?.toLowerCase() !== CURVE_TOKEN_EXCHANGE) return [];

    const [soldId, tokensSold, boughtId] = ethers.AbiCoder.defaultAbiCoder().decode(
      ["uint256", "uint256", "uint256", "uint256"],
      log.data,
    );

    return impactsFromCurveIds(log.address, BigInt(soldId), BigInt(boughtId), BigInt(tokensSold), edges);
  },
};

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

// ─── UniV3 decoder ────────────────────────────────────────────

const uniV3Decoder: ImpactDecoder = {
  adapterIds: ["univ3-swap"],

  decodeLog(log, edges) {
    if (log.topics[0]?.toLowerCase() !== UNIV3_SWAP) return [];

    const [amount0, amount1] = ethers.AbiCoder.defaultAbiCoder().decode(
      ["int256", "int256", "uint160", "uint128", "int24"],
      log.data,
    );

    const a0 = BigInt(amount0);
    const a1 = BigInt(amount1);

    const sample = edges.find((e) => e.poolToken0 && e.poolToken1);
    if (!sample?.poolToken0 || !sample?.poolToken1) return [];

    const tokenIn = a0 > 0n ? sample.poolToken0 : sample.poolToken1;
    const tokenOut = a0 > 0n ? sample.poolToken1 : sample.poolToken0;
    const amountIn = a0 > 0n ? a0 : a1;

    const edge = edges.find(
      (e) =>
        e.adapterId === "univ3-swap" &&
        e.tokenIn.toLowerCase() === tokenIn.toLowerCase() &&
        e.tokenOut.toLowerCase() === tokenOut.toLowerCase(),
    );
    if (!edge) return [];

    return [{
      pool: edge.target,
      tokenIn: edge.tokenIn,
      tokenOut: edge.tokenOut,
      amountIn,
      matchedAdapterId: edge.adapterId,
    }];
  },
};

// ─── UniV2 decoder ────────────────────────────────────────────

const uniV2Decoder: ImpactDecoder = {
  adapterIds: ["univ2-swap"],

  decodeLog(log, edges) {
    if (log.topics[0]?.toLowerCase() !== UNIV2_SWAP) return [];

    const [amount0In, amount1In] = ethers.AbiCoder.defaultAbiCoder().decode(
      ["uint256", "uint256", "uint256", "uint256"],
      log.data,
    );

    const sample = edges.find((e) => e.poolToken0 && e.poolToken1);
    if (!sample?.poolToken0 || !sample?.poolToken1) return [];

    const tokenIn = BigInt(amount0In) > 0n ? sample.poolToken0 : sample.poolToken1;
    const tokenOut = BigInt(amount0In) > 0n ? sample.poolToken1 : sample.poolToken0;
    const amountIn = BigInt(amount0In) > 0n ? BigInt(amount0In) : BigInt(amount1In);

    const edge = edges.find(
      (e) =>
        e.adapterId === "univ2-swap" &&
        e.tokenIn.toLowerCase() === tokenIn.toLowerCase() &&
        e.tokenOut.toLowerCase() === tokenOut.toLowerCase(),
    );
    if (!edge) return [];

    return [{
      pool: edge.target,
      tokenIn: edge.tokenIn,
      tokenOut: edge.tokenOut,
      amountIn,
      matchedAdapterId: edge.adapterId,
    }];
  },
};

// ─── Decoder registry ─────────────────────────────────────────

const IMPACT_DECODERS: ImpactDecoder[] = [
  curveDecoder,
  uniV3Decoder,
  uniV2Decoder,
];

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
): PoolTouch[] {
  const touches: PoolTouch[] = [];
  for (const log of logs) {
    if (log.topics[0]?.toLowerCase() !== ERC20_TRANSFER) continue;
    if (log.topics.length < 3) continue;

    const token = log.address.toLowerCase();
    const from = ("0x" + log.topics[1].slice(26)).toLowerCase();
    const to = ("0x" + log.topics[2].slice(26)).toLowerCase();
    const value = BigInt(log.data || "0");
    if (value === 0n) continue;

    if (edgesByTarget.has(to)) {
      touches.push({ pool: to, token, amount: value, direction: "in" });
    }
    if (edgesByTarget.has(from)) {
      touches.push({ pool: from, token, amount: value, direction: "out" });
    }
  }
  return touches;
}

function pairedTransferImpacts(
  touches: PoolTouch[],
  edgesByTarget: Map<string, TokenEdge[]>,
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
    if (!edges) continue;

    for (const inT of ins) {
      for (const outT of outs) {
        if (inT.token === outT.token) continue;
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
          });
        }
      }
    }
  }
  return impacts;
}

function isInboundTouch(touch: PoolTouch): boolean {
  const { direction } = touch;
  return direction === "in";
}

function isOutboundTouch(touch: PoolTouch): boolean {
  const { direction } = touch;
  return direction === "out";
}

// ─── Public API ───────────────────────────────────────────────

export function detectImpactFromLogs(logs: EventLog[], graph: TokenEdge[]): PoolImpact[] {
  const impacts: PoolImpact[] = [];
  const edgesByTarget = groupEdgesByTarget(graph);

  for (const log of logs) {
    // Standard decoders: log.address is a known pool
    const edges = edgesByTarget.get(log.address.toLowerCase());
    if (!edges || edges.length === 0) continue;

    for (const decoder of IMPACT_DECODERS) {
      if (!edges.some((edge) => decoder.adapterIds.includes(edge.adapterId))) continue;
      try {
        impacts.push(...decoder.decodeLog(log, edges));
      } catch {
        continue;
      }
    }
  }

  // Paired Transfer fallback: tokenA→pool + pool→tokenB = swap
  const touches = collectPoolTouches(logs, edgesByTarget);
  impacts.push(...pairedTransferImpacts(touches, edgesByTarget));

  return dedupeImpacts(impacts);
}

export function detectPoolImpact(event: OrderflowEvent, graph: TokenEdge[]): PoolImpact[] {
  const directImpacts = detectDirectCalls(event, graph);
  const logImpacts = detectImpactFromLogs(event.logs, graph);
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
  const seen = new Set<string>();
  return impacts.filter((impact) => {
    const key = [
      impact.pool.toLowerCase(),
      impact.tokenIn.toLowerCase(),
      impact.tokenOut.toLowerCase(),
      impact.amountIn.toString(),
      impact.matchedAdapterId,
    ].join(":");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
