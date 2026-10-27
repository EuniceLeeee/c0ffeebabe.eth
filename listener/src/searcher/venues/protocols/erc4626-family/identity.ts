import type { IdentitySemantics, IdentityVariant } from "../../adapter-family-plugin.js";
import type { FamilyId, LineageId } from "../../adapter-family-identifiers.js";
import { plugin } from "../../production-families/erc4626.production.js";
import { compileDeclarativeIdentity } from "../../declarative-identity.js";
import { expandConversionDefinition } from "../../declarative-definition.js";
import definition from "./erc4626.json";
import type { Erc4626Candidate, Erc4626Identity } from "./types.js";
export const ERC4626_PROBE_ACTOR_EVIDENCE_ID = definition.identity.definition.parameters.constants.caller.evidenceId;
export const erc4626Identity = plugin.identity as unknown as IdentitySemantics<Erc4626Candidate, Erc4626Identity>;
/** Compatibility for the separately owned rate-bearing Family's math profile. */
export function createErc4626StandardIdentityVariant(profile: {
  readonly familyId: FamilyId; readonly lineageId: LineageId; readonly id: string;
  readonly excludeSpecialized?: boolean; readonly depositEventAssets?: (grossAssets: bigint) => bigint;
}): IdentityVariant<Erc4626Candidate, Erc4626Identity, unknown> {
  return compileDeclarativeIdentity(expandConversionDefinition(definition.identity.definition), {
    id: profile.id, familyId: profile.familyId, lineageId: profile.lineageId,
    parameters: { excludeSpecialized: profile.excludeSpecialized !== false, hasEventMath: !!profile.depositEventAssets },
  }, profile.depositEventAssets ? { depositEventAssets: profile.depositEventAssets } : {});
}
