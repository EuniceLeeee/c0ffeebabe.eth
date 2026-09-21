import type { InstanceSemantics } from "../../adapter-family-plugin.js";
import { instanceKey } from "../../adapter-family-identifiers.js";
import { lower } from "./codec.js";
import type { EllaDescriptor, EllaIdentity } from "./types.js";
export function staticBinding(d: EllaDescriptor) {
  return { pool: lower(d.pool), token: lower(d.token), factory: lower(d.factory), oracle: lower(d.oracle),
    aggregator: lower(d.aggregator), decimals: d.decimals, codeHash: d.codeHash, factoryCodeHash: d.factoryCodeHash };
}
export const ellaInstance = {
  instanceKey: i => instanceKey(lower(i.subject)),
  compileDraft(i) {
    return { familyId: i.familyId, lineageId: i.lineageId, instanceKey: instanceKey(lower(i.subject)), provenance: i.provenance,
      runtimeRequirements: [{ kind: "source-state", freshness: "pinned-block" }], ...i.facts };
  },
  finalizeDescriptor: ({ draft }) => Object.freeze({ ...draft }),
  staticBindingProjection: staticBinding,
} satisfies InstanceSemantics<EllaIdentity, EllaDescriptor>;
