import { ADDR } from "../../../../shared/constants/addresses.js";
import type { InstanceSemantics } from "../../adapter-family-plugin.js";
import { instanceKey } from "../../adapter-family-identifiers.js";
import {
  canonicalAddress,
  lowerAddress,
  sameAddress,
} from "../standard-family/common.js";
import { originOusdStaticBindingProjection } from "./binding.js";
import {
  ORIGIN_OUSD_DECIMAL_SCALE,
  ORIGIN_OUSD_TOKEN,
} from "./codec.js";
import {
  ORIGIN_OUSD_FAMILY_ID,
  ORIGIN_OUSD_LINEAGE_ID,
} from "./manifest.js";
import type { OriginOusdDescriptor, OriginOusdIdentity } from "./types.js";

export const originOusdInstance = {
  instanceKey: (identity) => instanceKey(lowerAddress(identity.subject)),
  compileDraft: (identity: OriginOusdIdentity) => {
    if (!sameAddress(identity.asset, ADDR.USDC)) {
      throw new Error("Origin OUSD identity asset is not USDC");
    }
    return Object.freeze({
      familyId: ORIGIN_OUSD_FAMILY_ID,
      lineageId: ORIGIN_OUSD_LINEAGE_ID,
      instanceKey: instanceKey(lowerAddress(identity.subject)),
      provenance: identity.provenance,
      runtimeRequirements: Object.freeze([{
        kind: "source-state" as const,
        freshness: "pinned-block" as const,
      }]),
      target: canonicalAddress(identity.subject),
      asset: canonicalAddress(identity.asset),
      token: canonicalAddress(ORIGIN_OUSD_TOKEN),
      decimalScale: ORIGIN_OUSD_DECIMAL_SCALE,
      implementation: canonicalAddress(identity.implementation),
      proxyCodeHash: identity.proxyCodeHash.toLowerCase(),
      implementationCodeHash: identity.implementationCodeHash.toLowerCase(),
      tokenCodeHash: identity.tokenCodeHash.toLowerCase(),
    });
  },
  finalizeDescriptor: ({ draft }) => draft,
  staticBindingProjection: originOusdStaticBindingProjection,
} satisfies InstanceSemantics<OriginOusdIdentity, OriginOusdDescriptor>;
