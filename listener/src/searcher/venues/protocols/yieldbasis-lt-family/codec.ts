import { ethers } from "ethers";
import { hashCanonical } from "../../canonical-value.js";
import {
  assertRouteBound,
  lowerAddress,
  sameAddress,
} from "../standard-family/common.js";
import { YIELDBASIS_WITHDRAW_ACTION } from "./manifest.js";
import type {
  YieldBasisLtCandidate,
  YieldBasisLtDescriptor,
  YieldBasisLtRoute,
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

export function assertShares(amount: bigint): void {
  if (typeof amount !== "bigint" || amount < 0n) {
    throw new Error("yield basis LT share amount must be a non-negative bigint");
  }
}

/**
 * Static binding projection. It carries the reverse-proven LevAMM/pool anchors
 * and the chain-derived crypto coin index, so a re-pointed `amm()`/`CRYPTOPOOL()`
 * (or a flipped coin order) invalidates every previously issued route
 * fingerprint. Block-varying numbers are deliberately excluded.
 */
export function yieldBasisLtStaticProjection(descriptor: YieldBasisLtDescriptor) {
  return Object.freeze({
    lt: lower(descriptor.lt),
    share: lower(descriptor.share),
    asset: lower(descriptor.asset),
    stablecoin: lower(descriptor.stablecoin),
    cryptopool: lower(descriptor.cryptopool),
    amm: lower(descriptor.amm),
    assetCoinIndex: descriptor.assetCoinIndex,
    assetDecimals: descriptor.assetDecimals,
    redemptionPath: "levamm-bound-single-asset-withdraw" as const,
  });
}

export function yieldBasisLtBindingFingerprint(
  descriptor: YieldBasisLtDescriptor,
): string {
  return hashCanonical(yieldBasisLtStaticProjection(descriptor));
}

export function assertYieldBasisLtInvocation(
  descriptor: YieldBasisLtDescriptor,
  route: YieldBasisLtRoute,
): void {
  assertRouteBound({
    descriptorInstanceKey: descriptor.instanceKey,
    descriptorTarget: descriptor.lt,
    route,
    bindingFingerprint: yieldBasisLtBindingFingerprint(descriptor),
  });
  if (
    descriptor.redemptionPathVerified !== true ||
    route.direction !== "withdraw" ||
    route.adapterId !== YIELDBASIS_WITHDRAW_ACTION ||
    !same(route.tokenIn, descriptor.share) ||
    !same(route.tokenOut, descriptor.asset) ||
    same(descriptor.asset, ethers.ZeroAddress) ||
    same(descriptor.share, descriptor.asset) ||
    !same(descriptor.share, descriptor.lt) ||
    !Number.isSafeInteger(descriptor.assetCoinIndex) ||
    descriptor.assetCoinIndex < 0 ||
    descriptor.assetCoinIndex > 1
  ) {
    throw new Error(
      "Yield Basis LT route was not reverse-binding-proven for withdraw(shares,min_assets)",
    );
  }
}

export function candidateLt(candidate: YieldBasisLtCandidate): string {
  if (candidate.candidateKind !== "yieldbasis-lt") {
    throw new Error("foreign yield basis LT candidate kind");
  }
  return lower(candidate.lt);
}

export function identityKey(identity: { readonly asset: string }): string {
  return lower(identity.asset);
}
