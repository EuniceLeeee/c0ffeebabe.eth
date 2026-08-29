import { defineFamily, familyAuthoringDigest } from "../../../packages/family-sdk/authoring/index.ts";
import {
  BALANCER_FLASH_AUTHORING_HASH,
  BALANCER_FLASH_DEFINITION_INPUT,
} from "./metadata.ts";
import { BALANCER_FLASH_OWNER_REF } from "./manifest.ts";
import type { Hash } from "../../../packages/canonical-codec/src/index.ts";

export const BALANCER_FLASH_DEFINITION = defineFamily(BALANCER_FLASH_DEFINITION_INPUT);
export const BALANCER_FLASH_FAMILY_AUTHORING_HASH: Hash = familyAuthoringDigest(BALANCER_FLASH_DEFINITION);
export const BALANCER_FLASH_FAMILY_DEFINITION_HASH: Hash = BALANCER_FLASH_AUTHORING_HASH;
export { BALANCER_FLASH_OWNER_REF };
