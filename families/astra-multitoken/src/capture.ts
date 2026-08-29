import { ASTRA_SOURCE_PLAN } from "./source-plan.ts";
import type { SourceAnchorV1 } from "./types.ts";

export function astraSourcePlans() {
  return Object.freeze([ASTRA_SOURCE_PLAN]);
}

export function astraCutoffSource(source: SourceAnchorV1): SourceAnchorV1 {
  return Object.freeze({ ...source });
}
