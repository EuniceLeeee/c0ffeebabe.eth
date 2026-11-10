import type { InstanceSemantics } from "../../adapter-family-plugin.js";
import { instanceKey } from "../../adapter-family-identifiers.js";
import {
  canonicalAddress,
  lowerAddress,
  sameAddress,
} from "../standard-family/common.js";
import { originStethArmStaticBindingProjection } from "./binding.js";
import {
  ORIGIN_STETH_ARM_STETH,
  ORIGIN_STETH_ARM_WETH,
} from "./codec.js";
import {
  ORIGIN_STETH_ARM_FAMILY_ID,
  ORIGIN_STETH_ARM_LINEAGE_ID,
} from "./manifest.js";
import type {
  OriginStethArmDescriptor,
  OriginStethArmIdentity,
} from "./types.js";

export const originStethArmInstance = {
  instanceKey: (identity) => instanceKey(lowerAddress(identity.subject)),
  compileDraft: (identity: OriginStethArmIdentity) => {
    if (
      !sameAddress(identity.steth, ORIGIN_STETH_ARM_STETH) ||
      !sameAddress(identity.weth, ORIGIN_STETH_ARM_WETH)
    ) {
      throw new Error("Origin stETH ARM identity tokens are not stETH/WETH");
    }
    return Object.freeze({
      familyId: ORIGIN_STETH_ARM_FAMILY_ID,
      lineageId: ORIGIN_STETH_ARM_LINEAGE_ID,
      instanceKey: instanceKey(lowerAddress(identity.subject)),
      provenance: identity.provenance,
      runtimeRequirements: Object.freeze([{
        kind: "source-state" as const,
        freshness: "pinned-block" as const,
      }]),
      target: canonicalAddress(identity.subject),
      weth: canonicalAddress(identity.weth),
      steth: canonicalAddress(identity.steth),
      implementation: canonicalAddress(identity.implementation),
      proxyCodeHash: identity.proxyCodeHash.toLowerCase(),
      implementationCodeHash: identity.implementationCodeHash.toLowerCase(),
      stethCodeHash: identity.stethCodeHash.toLowerCase(),
      wethCodeHash: identity.wethCodeHash.toLowerCase(),
    });
  },
  finalizeDescriptor: ({ draft }) => draft,
  staticBindingProjection: originStethArmStaticBindingProjection,
} satisfies InstanceSemantics<OriginStethArmIdentity, OriginStethArmDescriptor>;
