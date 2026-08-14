import type { FamilyManifest } from "../../adapter-family-plugin.js";
import { familyId, lineageId } from "../../adapter-family-identifiers.js";

export const SELF_BURN_NATIVE_FAMILY_ID = familyId(
  "protocol:self-burn-native",
);
export const SELF_BURN_NATIVE_LINEAGE_ID = lineageId(
  "self-burn-native:active-effect-delta-v1",
);

export const selfBurnNativeFamilyManifest = {
  familyId: SELF_BURN_NATIVE_FAMILY_ID,
  domain: "protocol",
  ownedActionAdapterIds: ["self-burn-native-redeem"],
  requiredInfraActionAdapterIds: ["weth-deposit-value"],
  allowedTaxonomy: [{ slotKind: "protocol", protocolAction: "redeem" }],
  supportedLineages: [SELF_BURN_NATIVE_LINEAGE_ID],
  poolAdapterIds: ["self-burn-native-token"],
  requiresProtocolEdgesFlag: true,
} satisfies FamilyManifest<"protocol">;
