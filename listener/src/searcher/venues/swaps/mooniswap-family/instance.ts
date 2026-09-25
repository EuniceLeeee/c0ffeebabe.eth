import type { InstanceSemantics } from "../../adapter-family-plugin.js";
import { instanceKey } from "../../adapter-family-identifiers.js";
import { MOONISWAP_ID, MOONISWAP_LINEAGE, binding, lower } from "./codec.js";
import type { MooniswapDescriptor, MooniswapIdentity } from "./types.js";
export const mooniswapInstance = {
  instanceKey: identity => instanceKey(lower(identity.pool)),
  compileDraft: identity => ({ ...binding(identity), familyId: MOONISWAP_ID, lineageId: MOONISWAP_LINEAGE,
    instanceKey: instanceKey(lower(identity.pool)), provenance: identity.provenance,
    runtimeRequirements: [{ kind: "source-state" as const, freshness: "pinned-block" as const }] }),
  finalizeDescriptor: ({ draft }) => draft,
  staticBindingProjection: binding,
} satisfies InstanceSemantics<MooniswapIdentity, MooniswapDescriptor>;
