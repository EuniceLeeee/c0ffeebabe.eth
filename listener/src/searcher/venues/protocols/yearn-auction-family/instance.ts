import type { InstanceSemantics } from "../../adapter-family-plugin.js";
import { instanceKey } from "../../adapter-family-identifiers.js";
import type { Binding, Descriptor, Identity } from "./types.js";
export const key = (d: Pick<Binding, "target" | "sold">) => `${d.target}:${d.sold}`;
export const binding = (d: Binding) => ({ target: d.target, sold: d.sold, want: d.want, implementation: d.implementation,
  implementationCodeHash: d.implementationCodeHash, cloneCodeHash: d.cloneCodeHash, wantDecimals: d.wantDecimals,
  soldDecimals: d.soldDecimals, wantCodeHash: d.wantCodeHash, soldCodeHash: d.soldCodeHash });
export const instance = { instanceKey: i => instanceKey(key(i.binding)),
  compileDraft: i => ({ familyId: i.familyId, lineageId: i.lineageId, instanceKey: instanceKey(key(i.binding)), ...i.binding,
    provenance: i.provenance, runtimeRequirements: [{ kind: "source-state", freshness: "pinned-block" }] }),
  finalizeDescriptor: ({ draft }) => draft, staticBindingProjection: (d: Descriptor) => binding(d),
} satisfies InstanceSemantics<Identity, Descriptor>;
