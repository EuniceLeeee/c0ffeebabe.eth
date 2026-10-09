import { ethers } from "ethers";
import { hashCanonical } from "../../canonical-value.js";
import {
  assertRouteBound,
  lowerAddress,
  sameAddress,
} from "../standard-family/common.js";
import { CTOKEN_REDEEM_ACTION } from "./manifest.js";
import type {
  CompoundCTokenCandidate,
  CompoundCTokenDescriptor,
  CompoundCTokenIdentity,
  CompoundCTokenRoute,
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
    throw new Error("compound cToken share amount must be a non-negative bigint");
  }
}

/**
 * Static binding projection. `decimals` and the registry anchors are part of the
 * projection so a market re-registration or a decimals change invalidates every
 * previously issued route fingerprint.
 */
export function compoundCTokenStaticProjection(
  descriptor: CompoundCTokenDescriptor,
) {
  return Object.freeze({
    market: lower(descriptor.market),
    comptroller: lower(descriptor.comptroller),
    underlying: lower(descriptor.underlying),
    share: lower(descriptor.share),
    decimals: descriptor.decimals,
    redemptionPath: "comptroller-registered-redeem" as const,
  });
}

export function compoundCTokenBindingFingerprint(
  descriptor: CompoundCTokenDescriptor,
): string {
  return hashCanonical(compoundCTokenStaticProjection(descriptor));
}

export function assertCompoundCTokenInvocation(
  descriptor: CompoundCTokenDescriptor,
  route: CompoundCTokenRoute,
): void {
  assertRouteBound({
    descriptorInstanceKey: descriptor.instanceKey,
    descriptorTarget: descriptor.market,
    route,
    bindingFingerprint: compoundCTokenBindingFingerprint(descriptor),
  });
  if (
    descriptor.redemptionPathVerified !== true ||
    route.direction !== "redeem" ||
    route.adapterId !== CTOKEN_REDEEM_ACTION ||
    !same(route.tokenIn, descriptor.share) ||
    !same(route.tokenOut, descriptor.underlying) ||
    same(descriptor.underlying, ethers.ZeroAddress) ||
    same(descriptor.share, descriptor.underlying)
  ) {
    throw new Error("Compound cToken route was not behavior-proven");
  }
}

export function candidateMarket(candidate: CompoundCTokenCandidate): string {
  if (candidate.candidateKind !== "compound-ctoken-market") {
    throw new Error("foreign compound cToken candidate kind");
  }
  return lower(candidate.market);
}

export function identityKey(identity: CompoundCTokenIdentity): string {
  return lower(identity.underlying);
}
