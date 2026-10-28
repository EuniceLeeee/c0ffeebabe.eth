import type { InstanceSemantics } from "../../adapter-family-plugin.js";
import { instanceKey } from "../../adapter-family-identifiers.js";
import { address } from "./codec.js";
import type { Binding, Descriptor, Identity } from "./types.js";
export const key = (d: Pick<Binding, "set" | "module">) => `${address(d.set)}:${address(d.module)}`;
export const binding = (d: Binding) => ({ set: address(d.set), module: address(d.module), controller: address(d.controller), controllerCodeHash: d.controllerCodeHash, components: [...d.components],
  ...(d.legacy ? { legacy: { ...d.legacy, factory: address(d.legacy.factory), vault: address(d.legacy.vault) } } : {}) });
export const instance = {
  instanceKey: i => instanceKey(key(i.binding)),
  compileDraft: i => ({ familyId: i.familyId, lineageId: i.lineageId, instanceKey: instanceKey(key(i.binding)), ...i.binding,
    provenance: i.provenance, runtimeRequirements: [{ kind: "source-state", freshness: "pinned-block" }] }),
  finalizeDescriptor: ({ draft }) => draft, staticBindingProjection: (d: Descriptor) => binding(d),
} satisfies InstanceSemantics<Identity, Descriptor>;
