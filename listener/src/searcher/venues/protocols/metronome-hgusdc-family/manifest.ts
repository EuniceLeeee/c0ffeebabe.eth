import type { FamilyManifest } from "../../adapter-family-plugin.js";
import { familyId, lineageId } from "../../adapter-family-identifiers.js";

export const METRONOME_HGUSDC_FAMILY_ID = familyId(
  "protocol:metronome-hgusdc",
);
export const METRONOME_HGUSDC_LINEAGE_ID = lineageId(
  "metronome-hgusdc:observed-path-active-quote-v1",
);

export const metronomeHgUsdcFamilyManifest = {
  familyId: METRONOME_HGUSDC_FAMILY_ID,
  domain: "protocol",
  ownedActionAdapterIds: ["metronome-hgusdc-exit"],
  requiredInfraActionAdapterIds: ["erc20-transfer"],
  allowedTaxonomy: [{ slotKind: "protocol", protocolAction: "redeem" }],
  supportedLineages: [METRONOME_HGUSDC_LINEAGE_ID],
} satisfies FamilyManifest<"protocol">;
