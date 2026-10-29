import type { InstanceSemantics } from "../../adapter-family-plugin.js";
import { instanceKey } from "../../adapter-family-identifiers.js";
import type { Descriptor, Identity } from "./types.js";

export const binding = (descriptor: Descriptor) => ({
  pair: descriptor.pair,
  beacon: descriptor.beacon,
  implementation: descriptor.implementation,
  proxyCodeHash: descriptor.proxyCodeHash,
  implementationCodeHash: descriptor.implementationCodeHash,
  tokenX: descriptor.tokenX,
  tokenY: descriptor.tokenY,
  decimalsX: descriptor.decimalsX,
  decimalsY: descriptor.decimalsY,
});

export const instance = {
  instanceKey: (identity: Identity) => instanceKey(identity.facts.pair),
  compileDraft: (identity: Identity) => ({
    ...identity.facts,
    familyId: identity.familyId,
    lineageId: identity.lineageId,
    instanceKey: instanceKey(identity.facts.pair),
    provenance: identity.provenance,
    runtimeRequirements: [{ kind: "source-state" as const, freshness: "pinned-block" as const }],
  }),
  finalizeDescriptor: ({ draft }: { readonly draft: Descriptor }) => Object.freeze({ ...draft }),
  staticBindingProjection: binding,
} satisfies InstanceSemantics<Identity, Descriptor>;
