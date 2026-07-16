import { deriveEdgeTaxonomy, type ProtocolAction, type SlotKind } from "../strategy-taxonomy.js";
import type { AllowedTaxonomy } from "../venues/route-leg-adapter.js";
import {
  LEGACY_PRODUCTION_ROUTE_EDGES,
  PRODUCTION_ROUTE_ADAPTERS,
  type LegacyRouteEdgeDescriptor,
} from "../venues/production-registry.js";

export type TemplateSlotKind = "flash" | "lend" | "swap" | "repay" | "guard";

export interface TemplateConstraint {
  type: "token-continuity" | "final-token-equals-start-token";
}

export interface TemplateSlot {
  id: string;
  kind: TemplateSlotKind;
  adapters: string[];
  min?: number;
  max?: number;
}

export interface PathTemplate {
  name: string;
  slots: TemplateSlot[];
  constraints: TemplateConstraint[];
}

export interface TemplateTradeRouteDescriptor {
  readonly edgeAdapterIds: readonly string[];
  readonly allowedTaxonomy: readonly AllowedTaxonomy[];
}

/**
 * Derive closed-loop trade legs from the execution registry. Protocol conversions
 * are intentionally admitted alongside swaps when their taxonomy closes without
 * leaving a standing position. Credit/lend legs remain in the dedicated lend slot.
 */
export function deriveTemplateTradeAdapterIds(
  adapters: readonly TemplateTradeRouteDescriptor[],
  legacy: readonly LegacyRouteEdgeDescriptor[] = [],
): string[] {
  const ids: string[] = [];
  for (const adapter of adapters) {
    if (!adapter.allowedTaxonomy.some(isTemplateTradeTaxonomy)) continue;
    ids.push(...adapter.edgeAdapterIds);
  }
  for (const descriptor of legacy) {
    if (descriptor.slotKind === "swap" || descriptor.slotKind === "protocol") {
      ids.push(descriptor.edgeAdapterId);
    }
  }
  return [...new Set(ids)];
}

function isTemplateTradeTaxonomy(input: {
  slotKind: SlotKind;
  protocolAction?: ProtocolAction;
}): boolean {
  if (input.slotKind !== "swap" && input.slotKind !== "protocol") return false;
  return !deriveEdgeTaxonomy(input.slotKind, input.protocolAction).leavesStandingPosition;
}

const TRADE_LEG_ADAPTERS = deriveTemplateTradeAdapterIds(
  PRODUCTION_ROUTE_ADAPTERS.routeLegs.list(),
  LEGACY_PRODUCTION_ROUTE_EDGES,
);

export const FLASH_LEND_SWAP_REPAY: PathTemplate = {
  name: "flash-lend-swap-repay",
  slots: [
    { id: "flash", kind: "flash", adapters: ["morpho-flash", "balancer-flash"] },
    { id: "lend", kind: "lend", adapters: ["fluid-vault", "fluid-dex-liquidate"], min: 1, max: 4 },
    { id: "swap", kind: "swap", adapters: TRADE_LEG_ADAPTERS, min: 1, max: 8 },
    { id: "repay", kind: "repay", adapters: ["erc20-approve", "erc20-transfer"] },
    { id: "guard", kind: "guard", adapters: ["assert-balance"] },
  ],
  constraints: [
    { type: "token-continuity" },
    { type: "final-token-equals-start-token" },
  ],
};

export const FLASH_SWAP_REPAY: PathTemplate = {
  name: "flash-swap-repay",
  slots: [
    { id: "flash", kind: "flash", adapters: ["morpho-flash", "balancer-flash"] },
    { id: "swap", kind: "swap", adapters: TRADE_LEG_ADAPTERS, min: 1, max: 8 },
    { id: "repay", kind: "repay", adapters: ["erc20-approve", "erc20-transfer"] },
    { id: "guard", kind: "guard", adapters: ["assert-balance"] },
  ],
  constraints: [
    { type: "token-continuity" },
    { type: "final-token-equals-start-token" },
  ],
};
