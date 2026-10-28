import { ethers } from "ethers";
import { hashCanonical } from "../../canonical-value.js";
import {
  lowerAddress,
  sameAddress,
} from "../../protocols/standard-family/common.js";
import {
  KYSWAP_POOL_INTERFACE,
  KYSWAP_SWAP_TOPIC,
} from "./abi.js";
import { KYSWAP_SWAP_ACTION } from "./manifest.js";
import type {
  KyberSwapDescriptor,
  KyberSwapDirection,
  KyberSwapRoute,
} from "./types.js";

export function lower(value: string): string {
  return lowerAddress(value);
}

export function same(left: string, right: string): boolean {
  return sameAddress(left, right);
}

export function isZeroAddress(value: string): boolean {
  return sameAddress(value, ethers.ZeroAddress);
}

export function isToken0For(direction: KyberSwapDirection): boolean {
  return direction === "token0-in";
}

export function directionForTokenIn(
  descriptor: KyberSwapDescriptor,
  tokenIn: string,
): KyberSwapDirection | null {
  if (same(tokenIn, descriptor.token0)) return "token0-in";
  if (same(tokenIn, descriptor.token1)) return "token1-in";
  return null;
}

export function tokenInFor(
  descriptor: KyberSwapDescriptor,
  direction: KyberSwapDirection,
): string {
  return isToken0For(direction) ? descriptor.token0 : descriptor.token1;
}

export function tokenOutFor(
  descriptor: KyberSwapDescriptor,
  direction: KyberSwapDirection,
): string {
  return isToken0For(direction) ? descriptor.token1 : descriptor.token0;
}

export function assertPositiveAmount(amount: bigint, what: string): void {
  if (typeof amount !== "bigint" || amount <= 0n) {
    throw new Error(`kyberswap elastic ${what} must be a positive bigint`);
  }
}

/**
 * Static binding projection. The factory reverse binding, the token pair, the
 * fee units and the tick spacing are all part of the projection, so a
 * re-deployed clone or a changed pool parameter invalidates every previously
 * issued route fingerprint.
 */
export function kyberSwapStaticProjection(descriptor: KyberSwapDescriptor) {
  return Object.freeze({
    pool: lower(descriptor.pool),
    token0: lower(descriptor.token0),
    token1: lower(descriptor.token1),
    feeUnits: descriptor.feeUnits,
    tickDistance: descriptor.tickDistance,
    factoryBinding: Object.freeze({
      factory: lower(descriptor.factoryBinding.factory),
      reversePool: lower(descriptor.factoryBinding.reversePool),
    }),
    swapSemantics: "elastic-exact-input-isToken0" as const,
  });
}

export function kyberSwapBindingFingerprint(
  descriptor: KyberSwapDescriptor,
): string {
  return hashCanonical(kyberSwapStaticProjection(descriptor));
}

export function assertKyberSwapInvocation(
  descriptor: KyberSwapDescriptor,
  route: KyberSwapRoute,
): void {
  const expectedDirection = directionForTokenIn(descriptor, route.tokenIn);
  if (
    (route.direction !== "token0-in" && route.direction !== "token1-in") ||
    expectedDirection === null ||
    expectedDirection !== route.direction ||
    route.isToken0 !== isToken0For(route.direction) ||
    !same(route.tokenOut, tokenOutFor(descriptor, route.direction)) ||
    !same(route.pool, descriptor.pool) ||
    route.instanceKey !== descriptor.instanceKey ||
    route.feeUnits !== descriptor.feeUnits ||
    route.tickDistance !== descriptor.tickDistance ||
    route.taxonomy.slotKind !== "swap" ||
    route.taxonomy.protocolAction !== undefined ||
    lower(route.bindingRef.bindingKey) !== lower(descriptor.pool) ||
    route.bindingRef.fingerprint !== kyberSwapBindingFingerprint(descriptor) ||
    same(descriptor.token0, descriptor.token1) ||
    isZeroAddress(descriptor.token0) ||
    isZeroAddress(descriptor.token1)
  ) {
    throw new Error("KyberSwap Elastic route was not behavior-proven");
  }
}

export interface DecodedSwapLog {
  readonly pool: string;
  readonly sender: string;
  readonly recipient: string;
  readonly deltaQty0: bigint;
  readonly deltaQty1: bigint;
  readonly isToken0: boolean;
  readonly amountIn: bigint;
  readonly amountOut: bigint;
  readonly sqrtP: bigint;
  readonly liquidity: bigint;
  readonly tick: number;
}

/**
 * Decodes a landed `Swap` log. The sign convention is observed and pinned:
 * a positive delta is collected by the pool, a negative delta is paid out, so
 * the input token is the positive leg and `isToken0` follows from which leg is
 * positive for an exact-input swap.
 */
export function decodeSwapLog(log: {
  readonly address: string;
  readonly topics: readonly string[];
  readonly data: string;
}): DecodedSwapLog | null {
  if (log.topics[0]?.toLowerCase() !== KYSWAP_SWAP_TOPIC) return null;
  try {
    const decoded = KYSWAP_POOL_INTERFACE.decodeEventLog(
      "Swap",
      log.data,
      [...log.topics],
    );
    const deltaQty0 = BigInt(decoded.amount0);
    const deltaQty1 = BigInt(decoded.amount1);
    const token0In = deltaQty0 > 0n && deltaQty1 < 0n;
    const token1In = deltaQty1 > 0n && deltaQty0 < 0n;
    if (!token0In && !token1In) return null;
    return Object.freeze({
      pool: ethers.getAddress(log.address),
      sender: ethers.getAddress(String(decoded.sender)),
      recipient: ethers.getAddress(String(decoded.recipient)),
      deltaQty0,
      deltaQty1,
      isToken0: token0In,
      amountIn: token0In ? deltaQty0 : deltaQty1,
      amountOut: token0In ? -deltaQty1 : -deltaQty0,
      sqrtP: BigInt(decoded.sqrtP),
      liquidity: BigInt(decoded.liquidity),
      tick: Number(decoded.tick),
    });
  } catch {
    return null;
  }
}
