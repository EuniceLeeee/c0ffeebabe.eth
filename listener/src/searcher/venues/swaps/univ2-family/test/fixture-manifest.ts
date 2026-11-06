import definition from "../univ2.json" with { type: "json" };
import { familyId, lineageId } from "../../../adapter-family-identifiers.js";

export const UNIV2_FAMILY_ID = familyId(definition.manifest.familyId);
export const UNIV2_FACTORY_LINEAGE_ID = lineageId(definition.manifest.supportedLineages[0]!);
