import type { InstanceSemantics } from "../../adapter-family-plugin.js";
import { instanceKey } from "../../adapter-family-identifiers.js";
import { EKUBO_CORE, EKUBO_ROUTER } from "../ekubo/abi.js";
import { vanillaKey } from "./codec.js";
import type { EkuboDescriptor, EkuboIdentity } from "./types.js";

export function staticBinding(descriptor: EkuboDescriptor) {
  return { core: EKUBO_CORE, router: EKUBO_ROUTER, poolId: descriptor.poolId, poolKey: { ...descriptor.poolKey },
    coreCodeHash: descriptor.coreCodeHash, routerCodeHash: descriptor.routerCodeHash, decimals: [...descriptor.decimals],
    semantics: "vanilla-erc20-full-exact-input-limit0-skip0" };
}
export const ekuboInstance = {
  instanceKey: identity => instanceKey(identity.subject),
  compileDraft(identity) {
    return { familyId: identity.familyId, lineageId: identity.lineageId, instanceKey: instanceKey(identity.subject),
      provenance: identity.provenance, ...identity.facts,
      runtimeRequirements: [{ kind: "source-state" as const, freshness: "pinned-block" as const },
        { kind: "quote-completion" as const, mode: "return-data" as const }] };
  },
  finalizeDescriptor: ({ draft }) => Object.freeze({ ...draft, poolKey: vanillaKey(draft.poolKey),
    decimals: Object.freeze([...draft.decimals]) as readonly [number, number] }),
  staticBindingProjection: staticBinding,
} satisfies InstanceSemantics<EkuboIdentity, EkuboDescriptor>;
