import type { InstanceSemantics } from "../../adapter-family-plugin.js";
import { instanceKey } from "../../adapter-family-identifiers.js";
import { canonicalAddress, lowerAddress } from "../standard-family/common.js";
import { FAMILY, LINEAGE } from "./manifest.js";
import { mellowQueueStaticProjection } from "./shared.js";
import type {
  MellowQueueDescriptor,
  MellowQueueIdentity,
} from "./types.js";

export const mellowQueueInstance = {
  instanceKey: (identity) => instanceKey(lowerAddress(identity.queue)),
  compileDraft: (identity) => Object.freeze({
    familyId: FAMILY,
    lineageId: LINEAGE,
    instanceKey: instanceKey(lowerAddress(identity.queue)),
    provenance: identity.provenance,
    runtimeRequirements: Object.freeze([
      { kind: "source-state" as const, freshness: "pinned-block" as const },
      { kind: "execution-actor" as const, role: "executor" as const },
      {
        kind: "effect-observation" as const,
        effects: Object.freeze([
          "token-delta" as const,
          "total-supply-delta" as const,
          "logs" as const,
        ]),
      },
    ]),
    queue: canonicalAddress(identity.queue),
    vault: canonicalAddress(identity.vault),
    asset: canonicalAddress(identity.asset),
    share: canonicalAddress(identity.share),
    oracle: canonicalAddress(identity.oracle),
    feeManager: canonicalAddress(identity.feeManager),
    kind: identity.kind,
    penaltyD6: identity.penaltyD6,
    maxAge: identity.maxAge,
    proxyCodeHash: identity.proxyCodeHash,
    implementation: canonicalAddress(identity.implementation),
    implementationCodeHash: identity.implementationCodeHash,
  }),
  finalizeDescriptor: ({ draft }) => draft,
  staticBindingProjection: mellowQueueStaticProjection,
} satisfies InstanceSemantics<MellowQueueIdentity, MellowQueueDescriptor>;
