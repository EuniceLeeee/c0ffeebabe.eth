import type { InstanceSemantics } from "../../adapter-family-plugin.js";
import { instanceKey } from "../../adapter-family-identifiers.js";
import { eigenpieStaticBindingProjection } from "./binding.js";
import {
  EIGENPIE_FAMILY_ID,
  EIGENPIE_LINEAGE_ID,
} from "./manifest.js";
import type { EigenpieDescriptor, EigenpieIdentity } from "./types.js";

export const eigenpieInstance = {
  instanceKey: (identity) => instanceKey(identity.subject),
  compileDraft: (identity) => Object.freeze({
    familyId: EIGENPIE_FAMILY_ID,
    lineageId: EIGENPIE_LINEAGE_ID,
    instanceKey: instanceKey(identity.subject),
    provenance: identity.provenance,
    runtimeRequirements: Object.freeze([Object.freeze({
      kind: "source-state" as const,
      freshness: "pinned-block" as const,
    })]),
    target: identity.target,
    asset: identity.tokenIn,
    receipt: identity.tokenOut,
    sampleAmountIn: identity.sampleAmountIn,
  }),
  finalizeDescriptor: ({ draft }) => draft,
  staticBindingProjection: eigenpieStaticBindingProjection,
} satisfies InstanceSemantics<EigenpieIdentity, EigenpieDescriptor>;
