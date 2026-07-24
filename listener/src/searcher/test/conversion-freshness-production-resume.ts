import assert from "node:assert/strict";
import {
  canonicalJson,
  type ConversionCandidate,
  type ConversionEligibilityPlan,
} from "./adapter-family-blind-contract.js";
import {
  revealConversionFreshness,
  type ConversionFreshnessPrivateEvidenceBundle,
  type ConversionFreshnessPrivatePredicate,
  type ConversionFreshnessReveal,
  type ConversionSecret,
} from "./conversion-freshness-oracle.js";

/**
 * Reconstruct the reveal from every frozen commitment input before a
 * production-full resume is allowed to consume it. The persisted reveal is a
 * cache, never an authority: changing the plan, predicate, candidate set,
 * private evidence or secret must make resume fail closed.
 */
export function replayPersistedConversionFreshness(input: {
  readonly plan: ConversionEligibilityPlan;
  readonly predicate: ConversionFreshnessPrivatePredicate;
  readonly candidates: readonly ConversionCandidate[];
  readonly privateEvidence: ConversionFreshnessPrivateEvidenceBundle;
  readonly secret: ConversionSecret;
  readonly persistedReveal: ConversionFreshnessReveal;
}): ConversionFreshnessReveal {
  const replayed = revealConversionFreshness({
    plan: input.plan,
    predicate: input.predicate,
    candidates: input.candidates,
    privateEvidence: input.privateEvidence,
    secret: input.secret,
  });
  assert.equal(
    canonicalJson(replayed),
    canonicalJson(input.persistedReveal),
    "persisted conversion reveal does not replay from the frozen commitment artifacts",
  );
  return replayed;
}
