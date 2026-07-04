export type StrategyKind = "backrun" | "block-scan";
export type EdgeKind = "swap" | "credit" | "lp" | "flash";

/** Analysis-vocabulary bridge (D1): backrun->"backrun"; atomic_state_arb->"block-scan"; unknown->"unknown". */
export function strategyKindFromTxShape(
  shape: "backrun" | "atomic_state_arb" | "unknown",
): StrategyKind | "unknown" {
  if (shape === "atomic_state_arb") return "block-scan";
  return shape;
}

/** Single-derivation law (D2): lend->"credit"; flash->"flash"; swap->"swap". "lp" reserved, never derived today. */
export function edgeKindFromSlotKind(slotKind: "flash" | "lend" | "swap"): EdgeKind {
  if (slotKind === "lend") return "credit";
  return slotKind;
}

/** Derived edge fields in ONE place. */
export function deriveEdgeTaxonomy(
  slotKind: "flash" | "lend" | "swap",
): { edgeKind: EdgeKind; leavesStandingPosition: boolean } {
  const edgeKind = edgeKindFromSlotKind(slotKind);
  return { edgeKind, leavesStandingPosition: edgeKind === "credit" };
}

export function pathLeavesStandingPosition(
  edges: ReadonlyArray<{ leavesStandingPosition: boolean }>,
): boolean {
  return edges.some((edge) => edge.leavesStandingPosition);
}
