import { ethers } from "ethers";
import type { TokenEdge } from "../../planner/token-graph.js";
import type { RouteVenueMid, RouteVenueMidKind } from "../mid-readers.js";
import {
  blockScanEdgeKey,
  type StateRead,
  type StateReadResult,
  type StateReadSuccess,
} from "../blockscan-state-capability.js";
export {
  BLOCKSCAN_MULTICALL3,
  blockScanMulticallIface,
} from "../../blockscan-multicall.js";
import {
  blockScanMulticallIface,
} from "../../blockscan-multicall.js";

export const blockScanErc20Iface = new ethers.Interface([
  "function decimals() view returns (uint8)",
]);

export interface MulticallItem {
  readonly label: string;
  readonly target: string;
  readonly callData: string;
  readonly allowFailure: boolean;
}

export interface MulticallItemResult {
  readonly success: boolean;
  readonly returnData: string;
}

export function currentBlockRead(input: {
  readonly id: string;
  readonly sourceBlock: number;
  readonly sourceBlockHash: string;
  readonly to: string;
  readonly data: string;
  readonly from?: string;
  readonly transport?: StateRead["transport"];
  readonly acceptRevertData?: boolean;
}): StateRead {
  return Object.freeze({
    id: input.id,
    sourceBlock: input.sourceBlock,
    sourceBlockHash: input.sourceBlockHash,
    to: ethers.getAddress(input.to),
    data: input.data,
    from: input.from,
    transport: input.transport ?? "multicall-safe",
    acceptRevertData: input.acceptRevertData,
  });
}

export function encodeMulticall(items: readonly MulticallItem[]): string {
  if (items.length === 0) throw new Error("block-scan multicall requires at least one item");
  const labels = new Set<string>();
  for (const item of items) {
    if (!item.label || labels.has(item.label)) {
      throw new Error(`duplicate or empty block-scan multicall label ${item.label}`);
    }
    labels.add(item.label);
  }
  return blockScanMulticallIface.encodeFunctionData("aggregate3", [
    items.map((item) => ({
      target: ethers.getAddress(item.target),
      allowFailure: item.allowFailure,
      callData: item.callData,
    })),
  ]);
}

export function decodeMulticall(
  read: StateReadSuccess,
  items: readonly MulticallItem[],
): ReadonlyMap<string, MulticallItemResult> {
  const decoded = blockScanMulticallIface.decodeFunctionResult(
    "aggregate3",
    read.data,
  )[0] as readonly { success: boolean; returnData: string }[];
  if (decoded.length !== items.length) {
    throw new Error(
      `block-scan multicall ${read.id} returned ${decoded.length}/${items.length} items`,
    );
  }
  const out = new Map<string, MulticallItemResult>();
  for (let index = 0; index < items.length; index++) {
    const result = decoded[index];
    out.set(items[index].label, Object.freeze({
      success: Boolean(result.success),
      returnData: String(result.returnData),
    }));
  }
  return out;
}

export function requireRead(
  results: readonly StateReadResult[],
  id: string,
): StateReadSuccess {
  const result = results.find((candidate) => candidate.id === id);
  if (!result) throw new Error(`missing block-scan state read ${id}`);
  if (!result.ok) {
    throw new Error(`block-scan state read ${id} failed: ${result.kind}: ${result.error}`);
  }
  return result;
}

export function requireMulticallData(
  results: ReadonlyMap<string, MulticallItemResult>,
  label: string,
): string {
  const result = results.get(label);
  if (!result?.success || !result.returnData || result.returnData === "0x") {
    throw new Error(`missing block-scan multicall result ${label}`);
  }
  return result.returnData;
}

export function optionalMulticallData(
  results: ReadonlyMap<string, MulticallItemResult>,
  label: string,
): string | null {
  const result = results.get(label);
  return result?.success && result.returnData && result.returnData !== "0x"
    ? result.returnData
    : null;
}

export function canonicalPoolStateKey(edge: TokenEdge): string {
  return ethers.getAddress(edge.target).toLowerCase();
}

export function assertPoolGroup(
  edges: readonly TokenEdge[],
  expectedAdapterIds: ReadonlySet<string>,
): string {
  if (edges.length === 0) throw new Error("block-scan state group has no edges");
  const pool = canonicalPoolStateKey(edges[0]);
  for (const edge of edges) {
    if (!expectedAdapterIds.has(edge.adapterId)) {
      throw new Error(`unexpected edge adapter ${edge.adapterId} in state group ${pool}`);
    }
    if (canonicalPoolStateKey(edge) !== pool) {
      throw new Error(`mixed pool targets in state group ${pool}`);
    }
  }
  return pool;
}

export function directedPoolMid(input: {
  readonly kind: RouteVenueMidKind;
  readonly edge: TokenEdge;
  readonly reserveIn: bigint;
  readonly reserveOut: bigint;
  readonly feeBps: number;
  readonly sqrtPriceX96?: bigint;
  readonly liquidity?: bigint;
}): RouteVenueMid {
  if (input.reserveIn <= 0n || input.reserveOut <= 0n) {
    throw new Error(
      `non-positive ${input.kind} reserves for ${input.edge.target}: ` +
        `${input.reserveIn}/${input.reserveOut}`,
    );
  }
  const mid = bigintRatio(input.reserveOut, input.reserveIn);
  if (!Number.isFinite(mid) || mid <= 0) {
    throw new Error(`invalid ${input.kind} mid for ${input.edge.target}: ${mid}`);
  }
  const depth = input.reserveIn < input.reserveOut
    ? input.reserveIn
    : input.reserveOut;
  return Object.freeze({
    kind: input.kind,
    pool: input.edge.target,
    edges: Object.freeze([input.edge]) as unknown as TokenEdge[],
    mid,
    feeBps: input.feeBps,
    reserveA: input.reserveIn,
    reserveB: input.reserveOut,
    sqrtABX96: input.sqrtPriceX96,
    liquidity: input.liquidity,
    depthProxy: finiteBigintNumber(depth),
  });
}

export function quotedPoolMid(input: {
  readonly kind: RouteVenueMidKind;
  readonly edge: TokenEdge;
  readonly amountIn: bigint;
  readonly amountOut: bigint;
  readonly depthIn: bigint;
  readonly depthOut: bigint;
  readonly feeBps?: number;
}): RouteVenueMid {
  if (
    input.amountIn <= 0n ||
    input.amountOut <= 0n ||
    input.depthIn <= 0n ||
    input.depthOut <= 0n
  ) {
    throw new Error(`non-positive quoted ${input.kind} state for ${input.edge.target}`);
  }
  const mid = bigintRatio(input.amountOut, input.amountIn);
  if (!Number.isFinite(mid) || mid <= 0) {
    throw new Error(`invalid quoted ${input.kind} mid for ${input.edge.target}: ${mid}`);
  }
  const depth = input.depthIn < input.depthOut ? input.depthIn : input.depthOut;
  return Object.freeze({
    kind: input.kind,
    pool: input.edge.target,
    edges: Object.freeze([input.edge]) as unknown as TokenEdge[],
    mid,
    feeBps: input.feeBps ?? 0,
    reserveA: input.depthIn,
    reserveB: input.depthOut,
    depthProxy: finiteBigintNumber(depth),
  });
}

export function midsForDirectedEdges(
  edges: readonly TokenEdge[],
  derive: (edge: TokenEdge) => RouteVenueMid,
): ReadonlyMap<string, RouteVenueMid> {
  const out = new Map<string, RouteVenueMid>();
  for (const edge of edges) {
    const key = blockScanEdgeKey(edge);
    if (out.has(key)) throw new Error(`duplicate block-scan edge ${key}`);
    out.set(key, derive(edge));
  }
  return out;
}

export function q96DirectedReserves(input: {
  readonly sqrtPriceX96: bigint;
  readonly liquidity: bigint;
  readonly token0: string;
  readonly token1: string;
  readonly edge: TokenEdge;
}): {
  readonly reserveIn: bigint;
  readonly reserveOut: bigint;
  readonly sqrtPriceInOutX96: bigint;
} {
  const Q96 = 1n << 96n;
  const Q192 = Q96 * Q96;
  const tokenIn = input.edge.tokenIn.toLowerCase();
  const tokenOut = input.edge.tokenOut.toLowerCase();
  const token0 = input.token0.toLowerCase();
  const token1 = input.token1.toLowerCase();
  let sqrtPriceInOutX96: bigint;
  if (tokenIn === token0 && tokenOut === token1) {
    sqrtPriceInOutX96 = input.sqrtPriceX96;
  } else if (tokenIn === token1 && tokenOut === token0) {
    if (input.sqrtPriceX96 <= 0n) {
      throw new Error(`cannot invert zero sqrt price for ${input.edge.target}`);
    }
    sqrtPriceInOutX96 = Q192 / input.sqrtPriceX96;
  } else {
    throw new Error(
      `edge ${input.edge.tokenIn}->${input.edge.tokenOut} does not match ` +
        `${input.token0}/${input.token1}`,
    );
  }
  if (sqrtPriceInOutX96 <= 0n || input.liquidity <= 0n) {
    throw new Error(`non-positive concentrated-liquidity state for ${input.edge.target}`);
  }
  const reserveIn = input.liquidity * Q96 / sqrtPriceInOutX96;
  const reserveOut = input.liquidity * sqrtPriceInOutX96 / Q96;
  return { reserveIn, reserveOut, sqrtPriceInOutX96 };
}

export function decodeAddressWord(data: string, label: string): string {
  if (!/^0x[0-9a-fA-F]{64,}$/.test(data)) {
    throw new Error(`${label} returned malformed address data`);
  }
  return ethers.getAddress(`0x${data.slice(-40)}`);
}

export function bigintRatio(numerator: bigint, denominator: bigint): number {
  if (numerator <= 0n || denominator <= 0n) return 0;
  const directNumerator = Number(numerator);
  const directDenominator = Number(denominator);
  if (Number.isFinite(directNumerator) && Number.isFinite(directDenominator)) {
    return directNumerator / directDenominator;
  }
  const numeratorDigits = numerator.toString();
  const denominatorDigits = denominator.toString();
  const numeratorHead = Number(numeratorDigits.slice(0, 16));
  const denominatorHead = Number(denominatorDigits.slice(0, 16));
  return (numeratorHead / denominatorHead) *
    10 ** (numeratorDigits.length - denominatorDigits.length);
}

function finiteBigintNumber(value: bigint): number {
  const direct = Number(value);
  if (Number.isFinite(direct)) return direct;
  return Number.MAX_VALUE;
}
