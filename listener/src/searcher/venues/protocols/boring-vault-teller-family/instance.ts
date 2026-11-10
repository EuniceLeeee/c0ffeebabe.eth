import type { InstanceSemantics } from "../../adapter-family-plugin.js";
import { instanceKey } from "../../adapter-family-identifiers.js";
import { lowerAddress } from "../standard-family/common.js";
import { FAMILY, LINEAGE } from "./manifest.js";
import type { BoringDescriptor, BoringIdentity } from "./types.js";

export function boringStaticProjection(d: BoringDescriptor) {
  return {
    teller: lowerAddress(d.teller),
    vault: lowerAddress(d.vault),
    accountant: lowerAddress(d.accountant),
    asset: lowerAddress(d.asset),
    selector: "0x3e64ce99",
    shareLockPeriod: d.shareLockPeriod.toString(),
  };
}

export const boringInstance = {
  instanceKey: (identity: BoringIdentity) => instanceKey(lowerAddress(identity.subject)),
  compileDraft: (identity: BoringIdentity) => Object.freeze({
    teller: identity.teller,
    vault: identity.vault,
    accountant: identity.accountant,
    asset: identity.asset,
    shareDecimals: identity.shareDecimals,
    shareLockPeriod: identity.shareLockPeriod,
    tellerCodeHash: identity.tellerCodeHash,
    vaultCodeHash: identity.vaultCodeHash,
    accountantCodeHash: identity.accountantCodeHash,
    provenance: identity.provenance,
    familyId: FAMILY,
    lineageId: LINEAGE,
    instanceKey: instanceKey(lowerAddress(identity.subject)),
    runtimeRequirements: Object.freeze([
      { kind: "source-state" as const, freshness: "pinned-block" as const },
      { kind: "execution-actor" as const, role: "executor" as const },
      { kind: "effect-observation" as const, effects: Object.freeze(["token-delta" as const, "logs" as const]) },
    ]),
  }),
  finalizeDescriptor: ({ draft }: { readonly draft: BoringDescriptor }) => draft,
  staticBindingProjection: boringStaticProjection,
} satisfies InstanceSemantics<BoringIdentity, BoringDescriptor>;
