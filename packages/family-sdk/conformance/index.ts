import { asCapabilityId } from "../../capability-contracts/src/index.ts";
import { familyAuthoringDigest, normalizeFamilyDefinition, type FamilyAuthoringDefinitionV1 } from "../authoring/index.ts";
import type { Hash } from "../../canonical-codec/src/index.ts";

export interface CapabilityConformanceIndexEntryV1 {
  readonly capabilityId: string;
  readonly version: string;
  readonly schemaHash: Hash;
  readonly interpreterHash: Hash;
}

export interface FamilyConformanceResultV1 {
  readonly familyId: string;
  readonly familyDefinitionHash: Hash;
  readonly declaredCapabilityIds: readonly string[];
}

/**
 * Checks only generic authoring contracts.  It deliberately does not execute
 * a Family, inspect chain data, or mint a runtime authority.
 */
export function conformFamilyDefinition(
  definition: FamilyAuthoringDefinitionV1,
  capabilityIndex: readonly CapabilityConformanceIndexEntryV1[],
): FamilyConformanceResultV1 {
  const normalized = normalizeFamilyDefinition(definition);
  const byId = new Map(capabilityIndex.map(entry => [entry.capabilityId, entry] as const));
  if (byId.size !== capabilityIndex.length) throw new TypeError("duplicate capability index entry");
  const declarations = Object.values(normalized.extensions).flatMap((slot) =>
    slot.kind === "present" ? [slot.module] : []);
  const declared = new Set<string>();
  for (const declaration of declarations) {
    const id = asCapabilityId(declaration.capabilityId);
    if (declared.has(id)) throw new TypeError(`duplicate Family capability ${id}`);
    declared.add(id);
    const indexed = byId.get(id);
    if (indexed === undefined) throw new TypeError(`unknown capability ${id}`);
    if (indexed.version !== declaration.version || indexed.schemaHash !== declaration.schemaHash || indexed.interpreterHash !== declaration.interpreterHash) {
      throw new TypeError(`capability contract mismatch ${id}`);
    }
    for (const dependencyId of declaration.dependencyIds) if (!byId.has(dependencyId)) throw new TypeError(`unknown capability dependency ${dependencyId}`);
  }
  return Object.freeze({
    familyId: normalized.manifest.familyId,
    familyDefinitionHash: familyAuthoringDigest(normalized),
    declaredCapabilityIds: Object.freeze([...declared].sort()),
  });
}
