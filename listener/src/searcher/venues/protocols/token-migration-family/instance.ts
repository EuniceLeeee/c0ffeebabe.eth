import type { InstanceSemantics } from "../../adapter-family-plugin.js";
import { instanceKey } from "../../adapter-family-identifiers.js";
import { FAMILY, LINEAGE } from "./manifest.js";
import { bindingProjection } from "./binding.js";
import type { Identity, Descriptor } from "./types.js";
export const instance = {
  instanceKey: i => instanceKey(i.subject.toLowerCase()),
  compileDraft: i => Object.freeze({
    familyId: FAMILY, lineageId: LINEAGE, instanceKey: instanceKey(i.subject.toLowerCase()),
    provenance: i.provenance, runtimeRequirements: [{ kind: "source-state" as const, freshness: "pinned-block" as const }],
    target: i.subject, tokenIn: i.tokenIn, tokenOut: i.tokenOut, numerator: i.numerator, denominator: i.denominator,
    oneToken: i.oneToken, codeHash: i.codeHash,
  }),
  finalizeDescriptor: ({ draft }) => draft,
  staticBindingProjection: bindingProjection,
} satisfies InstanceSemantics<Identity, Descriptor>;
