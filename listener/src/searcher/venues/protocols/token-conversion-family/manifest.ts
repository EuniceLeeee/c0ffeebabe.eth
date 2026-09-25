import type { FamilyManifest } from "../../adapter-family-plugin.js";
import { familyId, lineageId } from "../../adapter-family-identifiers.js";
export const FAMILY = familyId("protocol:token-conversion");
export const LINEAGE = lineageId("token-conversion:btb-bear-v1");
export const XWIN_LINEAGE = lineageId("token-conversion:xwin-allocations-v1");
export const manifest = {
  familyId: FAMILY, domain: "protocol",
  ownedActionAdapterIds: ["token-conversion-mint", "token-conversion-redeem"],
  requiredInfraActionAdapterIds: ["erc20-approve"],
  // BTBB mint deposits assets and creates no debt: the shared taxonomy is wrap.
  allowedTaxonomy: [{ slotKind: "protocol", protocolAction: "wrap" }, { slotKind: "protocol", protocolAction: "redeem" }],
  supportedLineages: [LINEAGE, XWIN_LINEAGE], poolAdapterIds: ["token-conversion"],
  edgeAdapterIds: ["token-conversion-mint", "token-conversion-redeem"], requiresProtocolEdgesFlag: true,
} satisfies FamilyManifest<"protocol">;
