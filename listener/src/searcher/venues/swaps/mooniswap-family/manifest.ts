import type { FamilyManifest } from "../../adapter-family-plugin.js";
import { MOONISWAP_ACTION, MOONISWAP_ID, MOONISWAP_LINEAGE } from "./codec.js";
export const mooniswapManifest = {
  familyId: MOONISWAP_ID, domain: "swap", ownedActionAdapterIds: [MOONISWAP_ACTION],
  requiredInfraActionAdapterIds: ["erc20-approve"], supportedLineages: [MOONISWAP_LINEAGE],
  allowedTaxonomy: [{ slotKind: "swap" }], poolAdapterIds: ["mooniswap"], edgeAdapterIds: [MOONISWAP_ACTION], requiresProtocolEdgesFlag: false,
} satisfies FamilyManifest<"swap">;
