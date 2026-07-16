import { existsSync } from "node:fs";
import {
  deriveEdgeTaxonomy,
  type ProtocolAction,
  type SlotKind,
} from "./strategy-taxonomy.js";

export const DEFAULT_CREDIT_LIVE_MARKER_PATH = "/opt/MEV/.credit-live";
export type StandingGuardReason = "standing_position_unauthorized" | "edge_taxonomy_inconsistent";
export type StandingGuardResult =
  | { allowed: true; reason?: undefined; containsStandingPosition: boolean }
  | { allowed: false; reason: StandingGuardReason; containsStandingPosition: boolean };

interface StandingGuardEdge {
  leavesStandingPosition: boolean;
  slotKind?: SlotKind;
  protocolAction?: ProtocolAction;
}

export function evaluateStandingGuard(
  edges: ReadonlyArray<StandingGuardEdge>,
  markerPath: string,
): StandingGuardResult {
  let containsStandingPosition = false;
  for (const edge of edges) {
    // Production TokenEdges always carry slotKind. The legacy fallback keeps the
    // small isolated guard API usable while final submit paths re-derive taxonomy.
    const derived = edge.slotKind === undefined
      ? edge.leavesStandingPosition
      : deriveEdgeTaxonomy(edge.slotKind, edge.protocolAction).leavesStandingPosition;
    if (edge.slotKind !== undefined && derived !== edge.leavesStandingPosition) {
      return {
        allowed: false,
        reason: "edge_taxonomy_inconsistent",
        containsStandingPosition: derived || edge.leavesStandingPosition,
      };
    }
    containsStandingPosition ||= derived;
  }

  if (!containsStandingPosition) return { allowed: true, containsStandingPosition: false };
  if (existsSync(markerPath)) return { allowed: true, containsStandingPosition: true };
  return {
    allowed: false,
    reason: "standing_position_unauthorized",
    containsStandingPosition: true,
  };
}
