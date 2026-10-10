import type { InstanceSemantics } from "../../adapter-family-plugin.js";
import { instanceKey } from "../../adapter-family-identifiers.js";
import { address } from "./codec.js";
import type { Binding, Descriptor, Identity } from "./types.js";
export const binding = (d: Binding) => ({ pod: address(d.pod), asset: address(d.asset), codeHash: d.codeHash,
  assetCodeHash: d.assetCodeHash, staking: address(d.staking), stakingCodeHash: d.stakingCodeHash,
  decimals: d.decimals, feeBps: d.feeBps });
export const instance = {
  instanceKey: i => instanceKey(i.binding.pod),
  compileDraft: i => ({ familyId: i.familyId, lineageId: i.lineageId, instanceKey: instanceKey(i.binding.pod), ...i.binding,
    provenance: i.provenance, runtimeRequirements: [{ kind: "source-state", freshness: "pinned-block" }] }),
  finalizeDescriptor: ({ draft }) => draft, staticBindingProjection: (d: Descriptor) => binding(d),
} satisfies InstanceSemantics<Identity, Descriptor>;
