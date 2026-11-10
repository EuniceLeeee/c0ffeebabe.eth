import type { FamilyManifest } from "../../adapter-family-plugin.js";
import { familyId, lineageId } from "../../adapter-family-identifiers.js";

export const CURVE_PLAIN_FAMILY_ID = familyId("curve-plain");
export const CURVE_PLAIN_LINEAGE = lineageId("curve-plain:registry-direct-coin-behavior");
// Registry-independent Curve factory clones (noteUSD): the pool is absent from
// the MetaRegistry, so the delegated implementation class is pinned by code
// hash at the source block and the direct-coin exchange is proved by simulation.
export const CURVE_PLAIN_CLONE_LINEAGE = lineageId("curve-plain:registry-independent-clone-direct-coin");
export const curvePlainManifest = {
  familyId: CURVE_PLAIN_FAMILY_ID,
  domain: "swap",
  ownedActionAdapterIds: ["curve-exchange", "curve-exchange-nr", "curve-exchange-plain", "curve-exchange-received-uint", "curve-exchange-uint", "curve-native-exchange", "curve-native-exchange-uint"],
  requiredInfraActionAdapterIds: ["erc20-transfer", "erc20-approve"],
  allowedTaxonomy: [{ slotKind: "swap" }],
  supportedLineages: [CURVE_PLAIN_LINEAGE, CURVE_PLAIN_CLONE_LINEAGE],
  poolAdapterIds: ["curve", "curve-nr", "curve-plain"],
  edgeAdapterIds: ["curve-exchange", "curve-exchange-nr", "curve-exchange-plain", "curve-exchange-received-uint", "curve-exchange-uint", "curve-native-exchange", "curve-native-exchange-uint"],
  requiresProtocolEdgesFlag: false,
} satisfies FamilyManifest<"swap">;
