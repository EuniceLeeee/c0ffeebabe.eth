import type { InstanceSemantics } from "../../adapter-family-plugin.js";
import { instanceKey } from "../../adapter-family-identifiers.js";
import { canonicalAddress, lowerAddress } from
  "../../protocols/standard-family/common.js";
import { kyberSwapStaticProjection } from "./codec.js";
import { KYSWAP_FAMILY_ID, KYSWAP_LINEAGE_ID } from "./manifest.js";
import type {
  KyberSwapDescriptor,
  KyberSwapIdentity,
} from "./types.js";

export const kyberswapElasticInstance = {
  instanceKey: (identity: KyberSwapIdentity) =>
    instanceKey(lowerAddress(identity.subject)),
  compileDraft(identity: KyberSwapIdentity) {
    return {
      familyId: KYSWAP_FAMILY_ID,
      lineageId: KYSWAP_LINEAGE_ID,
      instanceKey: instanceKey(lowerAddress(identity.subject)),
      provenance: identity.provenance,
      runtimeRequirements: [],
      pool: canonicalAddress(identity.facts.pool),
      token0: canonicalAddress(identity.facts.token0),
      token1: canonicalAddress(identity.facts.token1),
      feeUnits: identity.facts.feeUnits,
      tickDistance: identity.facts.tickDistance,
      factoryBinding: identity.facts.factoryBinding,
    };
  },
  finalizeDescriptor({ draft }: { readonly draft: KyberSwapDescriptor }) {
    return Object.freeze({
      ...draft,
      provenance: Object.freeze([...draft.provenance]),
      runtimeRequirements: Object.freeze([...draft.runtimeRequirements]),
      factoryBinding: Object.freeze({ ...draft.factoryBinding }),
    });
  },
  staticBindingProjection: kyberSwapStaticProjection,
} satisfies InstanceSemantics<KyberSwapIdentity, KyberSwapDescriptor>;
