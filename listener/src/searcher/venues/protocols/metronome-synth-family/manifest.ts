import type { FamilyManifest } from "../../adapter-family-plugin.js";
import { familyId, lineageId } from "../../adapter-family-identifiers.js";

export const METRONOME_SYNTH_FAMILY_ID = familyId(
  "protocol:metronome-synth",
);
export const METRONOME_SYNTH_LINEAGE_ID = lineageId(
  "metronome-synth:active-membership",
);

export const metronomeSynthFamilyManifest = {
  familyId: METRONOME_SYNTH_FAMILY_ID,
  domain: "protocol",
  ownedActionAdapterIds: ["metronome-synth-swap"],
  requiredInfraActionAdapterIds: ["erc20-approve"],
  allowedTaxonomy: [{ slotKind: "protocol", protocolAction: "convert" }],
  supportedLineages: [METRONOME_SYNTH_LINEAGE_ID],
  poolAdapterIds: ["metronome-synth"],
  edgeAdapterIds: ["metronome-synth-swap"],
  requiresProtocolEdgesFlag: true,
} satisfies FamilyManifest<"protocol">;
