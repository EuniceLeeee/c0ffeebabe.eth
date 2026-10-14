import type { InstanceSemantics } from "../../adapter-family-plugin.js";
import { instanceKey } from "../../adapter-family-identifiers.js";
import { key } from "./codec.js";
import type { Descriptor, Identity } from "./types.js";
export const binding = (d: Descriptor) => ({ vault: d.vault, tokens: [...d.tokens], codeHash: d.codeHash });
export const instance = {
  instanceKey: i => instanceKey(key(i.facts)),
  compileDraft: i => ({ ...i.facts, familyId: i.familyId, lineageId: i.lineageId, instanceKey: instanceKey(key(i.facts)),
    provenance: i.provenance, runtimeRequirements: [{ kind: "source-state", freshness: "pinned-block" }] }),
  finalizeDescriptor: ({ draft }) => Object.freeze({ ...draft }), staticBindingProjection: binding,
} satisfies InstanceSemantics<Identity, Descriptor>;
