import type { FamilyManifest } from "../../adapter-family-plugin.js";
import { familyId, lineageId } from "../../adapter-family-identifiers.js";

export const DEFAULT_COLLATERAL_FAMILY_ID = familyId("protocol:default-collateral");
export const DEFAULT_COLLATERAL_LINEAGE_ID = lineageId(
  "default-collateral:share-vault-v1",
);
export const DEFAULT_COLLATERAL_ACTION_ID = "default-collateral-withdraw";

export const defaultCollateralFamilyManifest = {
  familyId: DEFAULT_COLLATERAL_FAMILY_ID,
  domain: "protocol",
  ownedActionAdapterIds: [DEFAULT_COLLATERAL_ACTION_ID],
  // `withdraw(receiver, shares)` burns msg.sender shares; the protocol never
  // pulls an input token, so this action needs no ERC20 approval.
  requiredInfraActionAdapterIds: [],
  allowedTaxonomy: [{ slotKind: "protocol", protocolAction: "convert" }],
  supportedLineages: [DEFAULT_COLLATERAL_LINEAGE_ID],
  // Provenance label only: admission is the EIP-1167 clone + pinned
  // implementation/asset runtime-code proof and the observed withdraw
  // behavior in identity.ts, never a file-backed venue entry.
  poolAdapterIds: ["default-collateral"],
  edgeAdapterIds: [DEFAULT_COLLATERAL_ACTION_ID],
  requiresProtocolEdgesFlag: true,
} satisfies FamilyManifest<"protocol">;
