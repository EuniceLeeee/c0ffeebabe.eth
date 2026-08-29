import { defineFamily, familyAuthoringDigest } from "../../../packages/family-sdk/authoring/index.ts";
import {
  ANGSTROM_V4_AUTHORING_HASH,
  ANGSTROM_V4_DEFINITION_INPUT,
} from "./metadata.ts";
import { ANGSTROM_V4_OWNER_REF } from "./manifest.ts";
import type { Hash } from "../../../packages/canonical-codec/src/index.ts";

export const ANGSTROM_V4_DEFINITION = defineFamily(ANGSTROM_V4_DEFINITION_INPUT);
export const ANGSTROM_V4_FAMILY_AUTHORING_HASH: Hash = familyAuthoringDigest(ANGSTROM_V4_DEFINITION);
export const ANGSTROM_V4_FAMILY_DEFINITION_HASH: Hash = ANGSTROM_V4_AUTHORING_HASH;
export { ANGSTROM_V4_OWNER_REF };
