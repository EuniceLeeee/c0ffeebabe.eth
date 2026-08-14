import type { FamilyManifest } from "../../adapter-family-plugin.js";
import { familyId, lineageId } from "../../adapter-family-identifiers.js";

export const ETHERTOKEN_NATIVE_FAMILY_ID = familyId(
  "protocol:ethertoken-native-redeem",
);
export const ETHERTOKEN_NATIVE_LINEAGE_ID = lineageId(
  "ethertoken-native:active-effect-delta-v1",
);

export const etherTokenNativeRedeemFamilyManifest = {
  familyId: ETHERTOKEN_NATIVE_FAMILY_ID,
  domain: "protocol",
  ownedActionAdapterIds: ["ethertoken-native-redeem"],
  requiredInfraActionAdapterIds: ["weth-deposit-value"],
  allowedTaxonomy: [{ slotKind: "protocol", protocolAction: "redeem" }],
  supportedLineages: [ETHERTOKEN_NATIVE_LINEAGE_ID],
  poolAdapterIds: ["ethertoken-native-redeem-token"],
} satisfies FamilyManifest<"protocol">;
