import { familyAuthoringDigest } from "../../../packages/family-sdk/authoring/index.ts";
import type { Hash } from "../../../packages/canonical-codec/src/index.ts";
import { defineFamily } from "../../../packages/family-sdk/authoring/index.ts";
import { FLUID_CREDIT_AUTHORING_HASH, FLUID_CREDIT_DEFINITION_INPUT } from "./metadata.ts";
import { FLUID_CREDIT_OWNER_REF } from "./manifest.ts";
export const FLUID_CREDIT_DEFINITION = defineFamily(FLUID_CREDIT_DEFINITION_INPUT);
export const FLUID_CREDIT_FAMILY_AUTHORING_HASH: Hash = familyAuthoringDigest(FLUID_CREDIT_DEFINITION);
export const FLUID_CREDIT_FAMILY_DEFINITION_HASH: Hash = FLUID_CREDIT_AUTHORING_HASH;
export { FLUID_CREDIT_OWNER_REF };
