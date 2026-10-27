import type { IdentityVariant } from "../../adapter-family-plugin.js";
import { compileDeclarativeIdentity } from "../../declarative-identity.js";
import { familyId, lineageId } from "../../adapter-family-identifiers.js";
import rawDefinition from "./infinifi.json";
import { normalizeDeclarativeVariant } from "../../declarative-variant.js";
const definition = normalizeDeclarativeVariant(rawDefinition);
import type { Erc4626Candidate, Erc4626Identity } from "./types.js";

// Compatibility export; production compiles this variant directly from JSON.
export const infinifiIdentity: IdentityVariant<Erc4626Candidate, Erc4626Identity, unknown> =
  compileDeclarativeIdentity({ version: 1, inputs: definition.inputs, abi: definition.abi,
    constants: definition.constants, expressions: definition.expressions, programs: definition.programs,
    identity: definition.identity }, { id: definition.id, familyId: familyId("protocol:erc4626"),
    lineageId: lineageId(definition.lineageId) });
