import type { IdentitySemantics, IdentityVariant } from "../../adapter-family-plugin.js";
import type { FamilyId, LineageId } from "../../adapter-family-identifiers.js";
import { compileDeclarativeIdentity } from "../../declarative-identity.js";
import { expandConversionDefinition } from "../../declarative-definition.js";
import definition from "./erc4626.json";
import { ERC4626_FAMILY_ID, ERC4626_LINEAGE_ID } from "./manifest.js";
import type { Erc4626Candidate, Erc4626Identity } from "./types.js";
import { custodianIdentity } from "./custodian-identity.js";
import { infinifiIdentity } from "./infinifi-identity.js";

export const ERC4626_PROBE_ACTOR_EVIDENCE_ID = "erc4626-probe-actor";

// The standard variant is entirely data-driven. Non-standard variants retain
// their existing implementations until their declarations are reviewed.
export function createErc4626StandardIdentityVariant(profile: {
  readonly familyId: FamilyId;
  readonly lineageId: LineageId;
  readonly id: string;
  readonly excludeSpecialized?: boolean;
  readonly depositEventAssets?: (grossAssets: bigint) => bigint;
}): IdentityVariant<Erc4626Candidate, Erc4626Identity, unknown> {
  return compileDeclarativeIdentity<Erc4626Candidate, Erc4626Identity>(
    expandConversionDefinition(definition.identity.definition), { id: profile.id, familyId: profile.familyId, lineageId: profile.lineageId,
      parameters: { excludeSpecialized: profile.excludeSpecialized !== false, hasEventMath: !!profile.depositEventAssets } },
    profile.depositEventAssets ? { depositEventAssets: profile.depositEventAssets } : {},
  );
}

export const erc4626Identity: IdentitySemantics<Erc4626Candidate, Erc4626Identity> = {
  memoReuse: "recheck-identity",
  variants: [createErc4626StandardIdentityVariant({ familyId: ERC4626_FAMILY_ID,
    lineageId: ERC4626_LINEAGE_ID, id: "standalone-standard-behavior" }), custodianIdentity, infinifiIdentity],
  identityKey: identity => identity.subject.toLowerCase(),
};
