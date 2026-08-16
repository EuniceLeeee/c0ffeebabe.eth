import type { FamilyManifest } from "../../adapter-family-plugin.js";
import { familyId, lineageId } from "../../adapter-family-identifiers.js";

export const ERC4626_SILO_REDEEM_FAMILY_ID = familyId(
  "protocol:erc4626-silo-redeem",
);
export const ERC4626_SILO_REDEEM_LINEAGE_ID = lineageId(
  "erc4626-silo:observed-payout-active-proof",
);

export const erc4626SiloRedeemFamilyManifest = {
  familyId: ERC4626_SILO_REDEEM_FAMILY_ID,
  domain: "protocol",
  ownedActionAdapterIds: ["erc4626-redeem-silo"],
  requiredInfraActionAdapterIds: [],
  allowedTaxonomy: [{ slotKind: "protocol", protocolAction: "redeem" }],
  supportedLineages: [ERC4626_SILO_REDEEM_LINEAGE_ID],
  poolAdapterIds: ["erc4626-silo-redeem"],
  edgeAdapterIds: ["erc4626-redeem-silo"],
  requiresProtocolEdgesFlag: true,
} satisfies FamilyManifest<"protocol">;
