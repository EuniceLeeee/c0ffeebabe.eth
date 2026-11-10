import type { InstanceSemantics } from "../../adapter-family-plugin.js";
import { instanceKey } from "../../adapter-family-identifiers.js";
import { canonicalAddress, lowerAddress } from "../standard-family/common.js";
import { FAMILY, LINEAGE } from "./manifest.js";
import { arcanaStaticProjection } from "./shared.js";
import type { ArcanaDescriptor, ArcanaIdentity } from "./types.js";

export const arcanaMigrationInstance = {
  instanceKey: (identity) => instanceKey(`${lowerAddress(identity.source)}:${identity.tokenId}`),
  compileDraft: (identity) => Object.freeze({
    familyId: FAMILY,
    lineageId: LINEAGE,
    instanceKey: instanceKey(`${lowerAddress(identity.source)}:${identity.tokenId}`),
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
    source: canonicalAddress(identity.source),
    destination: canonicalAddress(identity.destination),
    oldToken: canonicalAddress(identity.oldToken),
    arcToken: canonicalAddress(identity.arcToken),
    tokenId: identity.tokenId.toLowerCase(),
    tokenDecimals: identity.tokenDecimals,
    tokenTwapValue: identity.tokenTwapValue,
    tokenMultiplier: identity.tokenMultiplier,
    multiplierScale: identity.multiplierScale,
    proxyCodeHash: identity.proxyCodeHash,
  }),
  finalizeDescriptor: ({ draft }) => draft,
  staticBindingProjection: arcanaStaticProjection,
} satisfies InstanceSemantics<ArcanaIdentity, ArcanaDescriptor>;
