import type { InstanceSemantics } from "../../adapter-family-plugin.js";
import { instanceKey } from "../../adapter-family-identifiers.js";
import { staticProjection } from "./binding.js";
import type { ConversionIdentity, ConversionDescriptor } from "./types.js";
export const instance = {
  instanceKey: id => instanceKey(id.subject.toLowerCase()),
  compileDraft: id => Object.freeze({
    familyId: id.familyId, lineageId: id.lineageId, instanceKey: instanceKey(id.subject.toLowerCase()),
    provenance: id.provenance, target: id.subject, asset: id.asset, codeHash: id.codeHash,
    ...(id.variant === "btb-bear-v1" ? { variant: id.variant, assetCodeHash: id.assetCodeHash } : { variant: id.variant, proxyAdmin: id.proxyAdmin }),
    runtimeRequirements: [{ kind: "source-state" as const, freshness: "pinned-block" as const }],
  }),
  finalizeDescriptor: ({ draft }) => draft,
  staticBindingProjection: staticProjection,
} satisfies InstanceSemantics<ConversionIdentity, ConversionDescriptor>;
