import type { InstanceSemantics } from "../../adapter-family-plugin.js";
import { instanceKey } from "../../adapter-family-identifiers.js";
import type { Binding, Descriptor, Identity } from "./types.js";
export const binding = (d: Binding) => ({ target: d.target, implementation: d.implementation, proxyCodeHash: d.proxyCodeHash,
  implementationCodeHash: d.implementationCodeHash, gem: d.gem, stable: d.stable, gemDecimals: d.gemDecimals,
  stableDecimals: d.stableDecimals, gemCodeHash: d.gemCodeHash, stableCodeHash: d.stableCodeHash });
export const instance = { instanceKey: i => instanceKey(i.binding.target),
  compileDraft: i => ({ familyId: i.familyId, lineageId: i.lineageId, instanceKey: instanceKey(i.binding.target), ...i.binding,
    provenance: i.provenance, runtimeRequirements: [{ kind: "source-state", freshness: "pinned-block" }] }),
  finalizeDescriptor: ({ draft }) => draft, staticBindingProjection: (d: Descriptor) => binding(d),
} satisfies InstanceSemantics<Identity, Descriptor>;
