import type { FamilyManifest } from "../../adapter-family-plugin.js";
import { familyId, lineageId } from "../../adapter-family-identifiers.js";
import { ALGEBRA_INTEGRAL_ADAPTER_ID } from "./abi.js";

export const ALGEBRA_INTEGRAL_FAMILY_ID = familyId("swap:algebra-integral");
export const ALGEBRA_INTEGRAL_FACTORY_LINEAGE_ID = lineageId(
  "algebra-integral:factory-child",
);

export const algebraIntegralManifest = {
  familyId: ALGEBRA_INTEGRAL_FAMILY_ID,
  domain: "swap",
  ownedActionAdapterIds: [ALGEBRA_INTEGRAL_ADAPTER_ID],
  requiredInfraActionAdapterIds: ["erc20-transfer"],
  allowedTaxonomy: [{ slotKind: "swap" }],
  supportedLineages: [ALGEBRA_INTEGRAL_FACTORY_LINEAGE_ID],
  poolAdapterIds: ["algebra-integral"],
  edgeAdapterIds: [ALGEBRA_INTEGRAL_ADAPTER_ID],
  requiresProtocolEdgesFlag: false,
  // No `livePoolStateKind`: Algebra's `globalState` carries no observation ring,
  // so the central concentrated-liquidity live seed (v3-live) cannot be
  // populated without inventing fields. This family declines to publish a
  // mutable seed rather than fabricate one.
} satisfies FamilyManifest<"swap">;
