import type { InstanceSemantics } from "../../adapter-family-plugin.js";
import { instanceKey } from "../../adapter-family-identifiers.js";
import { hashCanonical } from "../../canonical-value.js";
import { address, CODE } from "./codec.js";
import type { Binding, Descriptor, Identity } from "./types.js";
export const binding = (d: Binding) => ({
  vault: address(d.vault), vaultImplementation: address(d.vaultImplementation), vaultAdmin: address(d.vaultAdmin),
  strategy: address(d.strategy), strategyImplementation: address(d.strategyImplementation), strategyAdmin: address(d.strategyAdmin),
  asset: address(d.asset), locker: address(d.locker), code: CODE,
});
export function assertBinding(d: Binding, current: Binding): void {
  if (hashCanonical(binding(d)) !== hashCanonical(binding(current)))
    throw new Error("badger-sett current binding changed; normal re-admission required");
}
export const instance = {
  instanceKey: i => instanceKey(i.binding.vault),
  compileDraft: i => ({ familyId: i.familyId, lineageId: i.lineageId, instanceKey: instanceKey(i.binding.vault), ...i.binding,
    provenance: i.provenance, runtimeRequirements: [{ kind: "source-state", freshness: "pinned-block" }] }),
  finalizeDescriptor: ({ draft }) => draft, staticBindingProjection: (d: Descriptor) => binding(d),
} satisfies InstanceSemantics<Identity, Descriptor>;
