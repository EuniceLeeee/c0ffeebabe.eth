import { defineFamily, familyAuthoringDigest } from "../../../packages/family-sdk/authoring/index.ts";
import type { Hash } from "../../../packages/canonical-codec/src/index.ts";
import { MORPHO_FLASH_AUTHORING_HASH, MORPHO_FLASH_DEFINITION_INPUT } from "./metadata.ts";
import { MORPHO_FLASH_OWNER_REF } from "./manifest.ts";
export const MORPHO_FLASH_DEFINITION = defineFamily(MORPHO_FLASH_DEFINITION_INPUT);
export const MORPHO_FLASH_FAMILY_AUTHORING_HASH: Hash = familyAuthoringDigest(MORPHO_FLASH_DEFINITION);
export const MORPHO_FLASH_FAMILY_DEFINITION_HASH: Hash = MORPHO_FLASH_AUTHORING_HASH;
export { MORPHO_FLASH_OWNER_REF };
