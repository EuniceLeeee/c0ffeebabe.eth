import { createUniv4Discovery, decodeUniv4Candidate } from "../univ4-family/discovery.js";
import { sameAddress } from "../univ4-family/codec.js";
import {
  UNIV4_FEE_HOOK_ADDRESS,
  UNIV4_FEE_HOOK_PATTERN_IDS,
} from "./manifest.js";
import type { FeeHookCandidate } from "./types.js";

/**
 * The fee-hook Family shares the manager nomination surface (same
 * Initialize/Swap events regardless of hook), but owns its pattern ids so the
 * landed-event registry sees a distinct declaration for this Family, and its
 * decodeCandidate only admits pools whose poolKey names the audited hook
 * (chain truth from the manager's real PoolKey state / Initialize log;
 * identity still proves the hook code hash on-chain as the fail-closed gate).
 * Fresh factory output is a distinct mutable object graph; the standard univ4
 * Family object stays untouched.
 */
export const univ4FeeHookDiscovery = {
  ...createUniv4Discovery(UNIV4_FEE_HOOK_PATTERN_IDS),
  decodeCandidate({
    observation,
    matchedPatternId,
  }: {
    readonly observation: Parameters<typeof decodeUniv4Candidate>[0];
    readonly matchedPatternId: string;
  }): FeeHookCandidate | null {
    try {
      const candidate = decodeUniv4Candidate(
        observation,
        matchedPatternId,
        UNIV4_FEE_HOOK_PATTERN_IDS,
      );
      if (candidate === null) return null;
      if (!sameAddress(candidate.poolKey.hooks, UNIV4_FEE_HOOK_ADDRESS)) {
        return null;
      }
      return candidate;
    } catch {
      return null;
    }
  },
};
