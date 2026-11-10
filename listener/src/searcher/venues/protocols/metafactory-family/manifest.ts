import type { FamilyManifest } from "../../adapter-family-plugin.js";
import { familyId, lineageId } from "../../adapter-family-identifiers.js";

export const METAFACTORY_FAMILY_ID = familyId("protocol:metafactory");
export const METAFACTORY_LINEAGE_ID = lineageId(
  "metafactory:v1-composter-pro-rata-eth-v1",
);
export const METAFACTORY_ACTION_ID = "metafactory-compost-redeem";

export const metafactoryFamilyManifest = {
  familyId: METAFACTORY_FAMILY_ID,
  domain: "protocol",
  ownedActionAdapterIds: [METAFACTORY_ACTION_ID],
  // The redeem action carries its own temporary ERC20 approval (approve 0 ->
  // approve amount -> compost -> approve 0), so no shared infra adapter is
  // required. The protocol pulls ROBOT with transferFrom.
  requiredInfraActionAdapterIds: [],
  allowedTaxonomy: [{ slotKind: "protocol", protocolAction: "convert" }],
  supportedLineages: [METAFACTORY_LINEAGE_ID],
  // Provenance label only. Admission is the runtime/state/token proof in
  // identity.ts; there is no file-backed pool universe entry for the composter.
  poolAdapterIds: ["metafactory"],
  edgeAdapterIds: [METAFACTORY_ACTION_ID],
  // The composter is a standalone, code-identified protocol conversion; it is
  // not a mature-DEX-universe edge and needs no separate protocol-edges flag.
  requiresProtocolEdgesFlag: false,
} satisfies FamilyManifest<"protocol">;
