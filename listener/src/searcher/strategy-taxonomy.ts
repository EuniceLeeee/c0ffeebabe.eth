export type StrategyKind = "backrun" | "block-scan";
export type EdgeKind = "swap" | "credit" | "lp" | "flash" | "protocol";

/**
 * Sub-axis for "protocol" edges: the protocol's OWN asset-conversion rule (not an AMM swap, not LP,
 * not flash, not a lending borrow). Examples: Liquity mint/redeem BOLD, PSM USDC->DAI convert,
 * WETH/wstETH wrap/unwrap, CDP-style stablecoin mint. Distinct from "credit", whose risk model is
 * collateral/debt/HF/LTV; a protocol edge's risk is the protocol's fixed conversion rule.
 */
export type ProtocolAction =
  | "mint"
  | "redeem"
  | "wrap"
  | "unwrap"
  | "convert"
  | "stake"
  | "unstake";

/** Analysis-vocabulary bridge (D1): backrun->"backrun"; atomic_state_arb->"block-scan"; unknown->"unknown". */
export function strategyKindFromTxShape(
  shape: "backrun" | "atomic_state_arb" | "unknown",
): StrategyKind | "unknown" {
  if (shape === "atomic_state_arb") return "block-scan";
  return shape;
}

/**
 * Single-derivation law (D2): lend->"credit"; flash->"flash"; swap->"swap".
 * "lp" and "protocol" are reserved analysis vocabulary — never derived from runtime slots today
 * (analysis classifies competitor legs with them; planner/quoter/plan-builder do not route them,
 * capability = { analysis: true, liveRouting: false, submit: false }). When a protocol edge is
 * eventually derived, its leavesStandingPosition is per-action (a CDP mint leaves a position, a
 * wrap does not) — decided at that slice, not here.
 */
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
