import { defineFamily, familyAuthoringDigest } from "../../../packages/family-sdk/authoring/index.ts";
import {
  FLUID_DEX_AUTHORING_HASH,
  FLUID_DEX_DEFINITION_INPUT,
} from "./metadata.ts";
import { FLUID_DEX_OWNER_REF } from "./manifest.ts";
import type { Hash } from "../../../packages/canonical-codec/src/index.ts";

export const FLUID_DEX_DEFINITION = defineFamily(FLUID_DEX_DEFINITION_INPUT);
export const FLUID_DEX_FAMILY_AUTHORING_HASH: Hash = familyAuthoringDigest(FLUID_DEX_DEFINITION);
export const FLUID_DEX_FAMILY_DEFINITION_HASH: Hash = FLUID_DEX_AUTHORING_HASH;
export { FLUID_DEX_OWNER_REF };
