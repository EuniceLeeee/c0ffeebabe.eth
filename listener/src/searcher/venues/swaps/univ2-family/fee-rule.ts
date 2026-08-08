import { canonicalAddress } from "./codec.js";
import type { UniV2FeeRule } from "./types.js";

const PANCAKE_V2_FACTORY = canonicalAddress(
  "0x1097053fd2ea711dad45caccc45eff7548fcb362",
);

/**
 * Fee provenance is pricing metadata, never an admission list. Unknown
 * reverse-verified factories use the standard 30 bps rule and remain subject
 * to exact/final simulation. The measured 25 bps fork is the sole non-default
 * rule in the frozen implementation baseline.
 */
export function uniV2FeeRuleForFactory(factory: string): UniV2FeeRule {
  if (canonicalAddress(factory) === PANCAKE_V2_FACTORY) {
    return Object.freeze({
      kind: "constant-bps" as const,
      feeBps: 25n,
      evidence: "measured-factory" as const,
    });
  }
  return Object.freeze({
    kind: "constant-bps" as const,
    feeBps: 30n,
    evidence: "standard-v2-default" as const,
  });
}
