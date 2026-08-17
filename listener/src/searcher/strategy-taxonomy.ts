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

/**
 * Protocol actions that are full-value conversions leaving NO standing liability
 * (a wrap/unwrap/convert/redeem/stake/unstake returns the whole value in-tx).
 * Everything NOT in this set — notably a debt-creating "mint" (CDP/stablecoin issuance)
 * or an undeclared action — leaves a standing position and is S2-guarded (fail-closed).
 */
const STANDING_SAFE_PROTOCOL_ACTIONS: ReadonlySet<ProtocolAction> = new Set<ProtocolAction>([
  "wrap",
  "unwrap",
  "convert",
  "redeem",
  "stake",
  "unstake",
]);

/** Analysis-vocabulary bridge (D1): backrun->"backrun"; atomic_state_arb->"block-scan"; unknown->"unknown". */
export function strategyKindFromTxShape(
  shape: "backrun" | "atomic_state_arb" | "unknown",
): StrategyKind | "unknown" {
  if (shape === "atomic_state_arb") return "block-scan";
  return shape;
}

export type SlotKind = "flash" | "lend" | "swap" | "protocol";

/**
 * Single-derivation law (D2): lend->"credit"; flash->"flash"; swap->"swap"; protocol->"protocol".
 * "lp" stays reserved analysis vocabulary (never derived from a runtime slot). "protocol" is now a
 * routable runtime slot (Track A: PSM convert, wstETH wrap/unwrap, ERC4626 deposit/redeem); its
 * leavesStandingPosition is per-action (see deriveEdgeTaxonomy), a debt mint leaves a position, a
 * wrap does not.
 */
export function edgeKindFromSlotKind(slotKind: SlotKind): EdgeKind {
  if (slotKind === "lend") return "credit";
  return slotKind;
}

/** PoolEntry → EdgeKind, BEFORE edges exist (view projection). MUST agree with deriveEdgeTaxonomy:
 *  a lend-fixed pool → "credit"; a protocol-fixed pool → "protocol"; everything else →
 *  "swap". ("lp" is analysis-only, never derived here.) */
export function edgeKindFromPoolEntry(p: { adapter: string; fixedSlotKind?: "lend" | "swap" | "protocol" }): EdgeKind {
  if (p.fixedSlotKind === "lend") return "credit";
  if (p.fixedSlotKind === "protocol") return "protocol";
  return "swap";
}

/** Derived edge fields in ONE place. protocolAction is consulted ONLY for protocol slots. */
export function deriveEdgeTaxonomy(
  slotKind: SlotKind,
  protocolAction?: ProtocolAction,
): { edgeKind: EdgeKind; leavesStandingPosition: boolean } {
  const edgeKind = edgeKindFromSlotKind(slotKind);
  if (edgeKind === "credit") return { edgeKind, leavesStandingPosition: true };
  if (edgeKind === "protocol") {
    // Fail-closed: a protocol edge routes UNGUARDED only when it declares an explicitly-safe
    // full-value conversion action. "mint" and any undeclared action leave a standing position.
    const safe = protocolAction !== undefined && STANDING_SAFE_PROTOCOL_ACTIONS.has(protocolAction);
    return { edgeKind, leavesStandingPosition: !safe };
  }
  return { edgeKind, leavesStandingPosition: false };
}

export function pathLeavesStandingPosition(
  edges: ReadonlyArray<{ leavesStandingPosition: boolean }>,
): boolean {
  return edges.some((edge) => edge.leavesStandingPosition);
}
