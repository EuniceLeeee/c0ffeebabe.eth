import type { InstanceSemantics } from "../../adapter-family-plugin.js";
import { instanceKey } from "../../adapter-family-identifiers.js";
import { canonicalAddress, lowerAddress } from "../standard-family/common.js";
import {
  ERC4626_SILO_REDEEM_FAMILY_ID,
  ERC4626_SILO_REDEEM_LINEAGE_ID,
} from "./manifest.js";
import { erc4626SiloStaticProjection } from "./shared.js";
import type {
  Erc4626SiloRedeemDescriptor,
  Erc4626SiloRedeemIdentity,
} from "./types.js";

export const erc4626SiloRedeemInstance = {
  instanceKey: (identity) => instanceKey(
    `${lowerAddress(identity.vault)}:${lowerAddress(identity.payoutToken)}`,
  ),
  compileDraft: (identity) => Object.freeze({
    familyId: ERC4626_SILO_REDEEM_FAMILY_ID,
    lineageId: ERC4626_SILO_REDEEM_LINEAGE_ID,
    instanceKey: instanceKey(
      `${lowerAddress(identity.vault)}:${lowerAddress(identity.payoutToken)}`,
    ),
    provenance: identity.provenance,
    runtimeRequirements: Object.freeze([
      { kind: "source-state" as const, freshness: "pinned-block" as const },
      { kind: "execution-actor" as const, role: "executor" as const },
      { kind: "quote-completion" as const, mode: "effect-delta" as const },
      {
        kind: "effect-observation" as const,
        effects: Object.freeze([
          "token-delta" as const,
          "total-supply-delta" as const,
          "logs" as const,
        ]),
      },
    ]),
    vault: canonicalAddress(identity.vault),
    payoutToken: canonicalAddress(identity.payoutToken),
    underlyingAsset: canonicalAddress(identity.underlyingAsset),
  }),
  finalizeDescriptor: ({ draft }) => draft,
  staticBindingProjection: erc4626SiloStaticProjection,
} satisfies InstanceSemantics<
  Erc4626SiloRedeemIdentity,
  Erc4626SiloRedeemDescriptor
>;
