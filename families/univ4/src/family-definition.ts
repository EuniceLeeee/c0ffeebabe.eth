import { defineFamily, familyAuthoringDigest } from "../../../packages/family-sdk/authoring/index.ts";
import {
  UNIV4_AUTHORING_HASH,
  UNIV4_DEFINITION_INPUT,
} from "./metadata.ts";
import { UNIV4_OWNER_REF } from "./manifest.ts";
import type { Hash } from "../../../packages/canonical-codec/src/index.ts";

export const UNIV4_DEFINITION = defineFamily(UNIV4_DEFINITION_INPUT);
export const UNIV4_FAMILY_AUTHORING_HASH: Hash = familyAuthoringDigest(UNIV4_DEFINITION);
export const UNIV4_FAMILY_DEFINITION_HASH: Hash = UNIV4_AUTHORING_HASH;
export { UNIV4_OWNER_REF };
