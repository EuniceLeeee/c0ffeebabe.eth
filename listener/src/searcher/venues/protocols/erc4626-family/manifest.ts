import type { FamilyManifest } from "../../adapter-family-plugin.js";
import { familyId, lineageId } from "../../adapter-family-identifiers.js";

export const ERC4626_FAMILY_ID = familyId("protocol:erc4626");
export const ERC4626_LINEAGE_ID = lineageId(
  "erc4626:standalone-standard-behavior",
);

export const erc4626FamilyManifest: FamilyManifest<"protocol"> = Object.freeze({
  familyId: ERC4626_FAMILY_ID,
  domain: "protocol",
  ownedActionAdapterIds: Object.freeze([
    "erc4626-deposit",
    "erc4626-redeem",
  ]),
  requiredInfraActionAdapterIds: Object.freeze(["erc20-approve"]),
  allowedTaxonomy: Object.freeze([
    Object.freeze({ slotKind: "protocol" as const, protocolAction: "wrap" as const }),
    Object.freeze({ slotKind: "protocol" as const, protocolAction: "redeem" as const }),
  ]),
  supportedLineages: Object.freeze([ERC4626_LINEAGE_ID]),
  poolAdapterIds: Object.freeze(["erc4626"]),
});
