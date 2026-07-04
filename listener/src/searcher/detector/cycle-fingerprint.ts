import { ethers } from "ethers";

/**
 * Ring = cycle token sequence without the repeated start, e.g. [A,B,C] for A->B->C->A.
 * Rotation-invariant + direction-invariant identity; size/venue/route are not part of identity.
 * Temporal rule: a competitor tx executing in block B joins at cycleFingerprint(B - 1, ring).
 */
export function canonicalTokenRing(ring: readonly string[]): string[] {
  const t = ring.map((x) => x.toLowerCase());
  const minIdx = t.indexOf([...t].sort()[0]);                 // 1. rotate: lowest-address first
  const rot = [...t.slice(minIdx), ...t.slice(0, minIdx)];
  const rev = [rot[0], ...rot.slice(1).reverse()];            // 2. orient: smaller 2nd element wins
  return (rev[1] ?? "") < (rot[1] ?? "") ? rev : rot;
}

/**
 * Shared cycle identity join key: rotation-invariant + direction-invariant.
 * Size/venue/route are comparison attributes only, not part of identity.
 * Temporal rule: a competitor tx executing in block B joins at cycleFingerprint(B - 1, ring).
 */
export function cycleFingerprint(sourceBlock: number, ring: readonly string[]): string {
  return ethers.keccak256(ethers.toUtf8Bytes(`${sourceBlock}|${canonicalTokenRing(ring).join(",")}`));
}
