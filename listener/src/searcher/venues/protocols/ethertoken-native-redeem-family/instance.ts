import { ADDR } from "../../../../shared/constants/addresses.js";
import type { InstanceSemantics } from "../../adapter-family-plugin.js";
import { instanceKey } from "../../adapter-family-identifiers.js";
import { canonicalAddress, lowerAddress } from "../standard-family/common.js";
import {
  ETHERTOKEN_NATIVE_FAMILY_ID,
  ETHERTOKEN_NATIVE_LINEAGE_ID,
} from "./manifest.js";
import { etherTokenNativeStaticProjection } from "./shared.js";
import type {
  EtherTokenNativeRedeemDescriptor,
  EtherTokenNativeRedeemIdentity,
} from "./types.js";

export const etherTokenNativeRedeemInstance = {
  instanceKey: (identity) => instanceKey(lowerAddress(identity.token)),
  compileDraft: (identity) => Object.freeze({
    familyId: ETHERTOKEN_NATIVE_FAMILY_ID,
    lineageId: ETHERTOKEN_NATIVE_LINEAGE_ID,
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
  staticBindingProjection: etherTokenNativeStaticProjection,
} satisfies InstanceSemantics<
  EtherTokenNativeRedeemIdentity,
  EtherTokenNativeRedeemDescriptor
>;
