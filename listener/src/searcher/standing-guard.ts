import { existsSync } from "node:fs";
import { pathLeavesStandingPosition } from "./strategy-taxonomy.js";

export const DEFAULT_CREDIT_LIVE_MARKER_PATH = "/opt/MEV/.credit-live";
export type StandingGuardReason = "standing_position_unauthorized";
export type StandingGuardResult =
  | { allowed: true; reason?: undefined }
  | { allowed: false; reason: StandingGuardReason };

export function evaluateStandingGuard(
  edges: ReadonlyArray<{ leavesStandingPosition: boolean }>,
  markerPath: string,
  containsStandingPosition = pathLeavesStandingPosition(edges),
): StandingGuardResult {
  if (!containsStandingPosition) return { allowed: true };
  if (existsSync(markerPath)) return { allowed: true };
  return { allowed: false, reason: "standing_position_unauthorized" };
}
