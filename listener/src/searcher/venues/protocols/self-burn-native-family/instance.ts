import { ADDR } from "../../../../shared/constants/addresses.js";
import type { InstanceSemantics } from "../../adapter-family-plugin.js";
import { instanceKey } from "../../adapter-family-identifiers.js";
import { canonicalAddress, lowerAddress } from "../standard-family/common.js";
import {
  SELF_BURN_NATIVE_FAMILY_ID,
  SELF_BURN_NATIVE_LINEAGE_ID,
} from "./manifest.js";
import { selfBurnNativeStaticProjection } from "./shared.js";
import type {
  SelfBurnNativeDescriptor,
  SelfBurnNativeIdentity,
} from "./types.js";

export const selfBurnNativeInstance = {
  instanceKey: (identity) => instanceKey(lowerAddress(identity.token)),
  compileDraft: (identity) => Object.freeze({
    familyId: SELF_BURN_NATIVE_FAMILY_ID,
    lineageId: SELF_BURN_NATIVE_LINEAGE_ID,
    instanceKey: instanceKey(lowerAddress(identity.token)),
    provenance: identity.provenance,
    runtimeRequirements: Object.freeze([
      { kind: "source-state" as const, freshness: "pinned-block" as const },
      { kind: "execution-actor" as const, role: "executor" as const },
      { kind: "quote-completion" as const, mode: "effect-delta" as const },
      {
        kind: "effect-observation" as const,
        effects: Object.freeze([
          "token-delta" as const,
          "native-delta" as const,
          "total-supply-delta" as const,
          "logs" as const,
        ]),
      },
    ]),
    token: canonicalAddress(identity.token),
    nativeAnchor: canonicalAddress(ADDR.WETH),
  }),
  finalizeDescriptor: ({ draft }) => draft,
  staticBindingProjection: selfBurnNativeStaticProjection,
} satisfies InstanceSemantics<
  SelfBurnNativeIdentity,
  SelfBurnNativeDescriptor
>;
