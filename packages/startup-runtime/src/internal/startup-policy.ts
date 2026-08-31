import type { CanonicalCutoffV1 } from "../../../discovery/src/index.ts";
import type { CanonicalSource } from "../../../canonical-source/src/index.ts";
import type { BuilderCanonicalPort } from "../../../generation-builder/src/index.ts";
import type { GenerationRefreshPolicyV1 } from "../../../ready-generation/src/index.ts";

/** The only recent-observation window admitted by the startup authority. */
export const STARTUP_OBSERVATION_WINDOW_BLOCKS = 50 as const;

export function startupDecimal(value: string, context: string): bigint {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new TypeError(`${context} is not a canonical decimal`);
  return BigInt(value);
}

/**
 * Enforces the production startup contract at the builder boundary.  The
 * lower-level discovery package deliberately accepts a shorter range at
 * chain genesis; production startup does not, because its edge evidence
 * contract is exactly cutoff-49..cutoff.
 */
export function assertStartupObservationWindow(
  cutoff: { readonly number: string },
  range: { readonly from: string; readonly to: string },
): void {
  const cutoffNumber = startupDecimal(cutoff.number, "startup.cutoff.number");
  const from = startupDecimal(range.from, "startup.observationRange.from");
  const to = startupDecimal(range.to, "startup.observationRange.to");
  if (
    to !== cutoffNumber
    || cutoffNumber < BigInt(STARTUP_OBSERVATION_WINDOW_BLOCKS - 1)
    || from !== cutoffNumber - BigInt(STARTUP_OBSERVATION_WINDOW_BLOCKS - 1)
    || to - from + 1n !== BigInt(STARTUP_OBSERVATION_WINDOW_BLOCKS)
  ) {
    throw new Error("startup-observation-window-not-50");
  }
}

export function assertStartupPolicy(policy: GenerationRefreshPolicyV1): void {
  if (policy.observationWindowBlocks !== "50" || policy.maxInProgressRuns !== "1") {
    throw new Error("unsupported-startup-generation-policy");
  }
  startupDecimal(policy.targetRefreshAgeBlocks, "startup.policy.targetRefreshAgeBlocks");
  startupDecimal(policy.maxServingAgeBlocks, "startup.policy.maxServingAgeBlocks");
  startupDecimal(policy.minPromotionMarginBlocks, "startup.policy.minPromotionMarginBlocks");
}

export function fixedWindowCanonical(canonical: CanonicalSource): BuilderCanonicalPort {
  return Object.freeze({
    async freezeView(signal: AbortSignal) {
      const cutoff = await canonical.freezeView(signal);
      assertStartupObservationWindow(cutoff, canonical.recentObservationRange(cutoff));
      return cutoff;
    },
    async assertStillCanonical(cutoff: CanonicalCutoffV1) {
      assertStartupObservationWindow(cutoff, canonical.recentObservationRange(cutoff));
      return canonical.assertStillCanonical(cutoff);
    },
    async ageInBlocks(cutoff: CanonicalCutoffV1) {
      return canonical.ageInBlocks(cutoff);
    },
    recentObservationRange(cutoff: CanonicalCutoffV1) {
      const range = canonical.recentObservationRange(cutoff);
      assertStartupObservationWindow(cutoff, range);
      return range;
    },
  });
}
