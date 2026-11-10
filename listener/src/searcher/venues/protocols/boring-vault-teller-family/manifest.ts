import type { FamilyManifest } from "../../adapter-family-plugin.js";
import { familyId, lineageId } from "../../adapter-family-identifiers.js";

export const FAMILY = familyId("protocol:boring-vault-teller");
export const LINEAGE = lineageId("boring-vault-teller:v1");
export const ACTION = "boring-vault-withdraw";

/** Teller.bulkWithdraw burns BoringVault shares held by the caller and pays one
 * supported asset to the receiver. No ERC20 allowance is involved: the vault's
 * authority gates `exit` to its Teller hook and the Teller burns from the
 * caller, so the Family declares no approve requirement. */
export const manifest = {
  familyId: FAMILY,
  domain: "protocol",
  ownedActionAdapterIds: [ACTION],
  requiredInfraActionAdapterIds: [],
  allowedTaxonomy: [{ slotKind: "protocol", protocolAction: "redeem" }],
  supportedLineages: [LINEAGE],
  poolAdapterIds: [ACTION],
  edgeAdapterIds: [ACTION],
  requiresProtocolEdgesFlag: true,
} satisfies FamilyManifest<"protocol">;
