import {
  executeAdapterFamilyLifecycleBatch,
  type AdapterFamilyPublication,
  type FamilyLifecycleMatch,
} from "./venues/adapter-family-runtime.js";
import type {
  CentralAdapterRuntime,
} from "./adapter-work-intent.js";
import type { UnifiedObservation } from
  "./venues/adapter-family-plugin.js";
import type { CanonicalSource } from
  "./venues/adapter-request-program.js";
import type { FamilyId } from
  "./venues/adapter-family-identifiers.js";
import type { FamilyCapabilityCatalog } from
  "./venues/family-capability-catalog.js";

/**
 * Strict production publication pipeline step 1 contract: run one strict
 * Family lifecycle over the catalog-matched observations for a canonical
 * source and return the issued publication. Fail-closed on no match or no
 * publication; the caller supplies the central runtime (the production
 * scheduler/budgets/fences).
 */
export async function runStrictFamilyLifecycle(input: {
  readonly catalog: FamilyCapabilityCatalog;
  readonly familyId: FamilyId;
  readonly source: CanonicalSource;
  readonly observations: readonly UnifiedObservation[];
  readonly runtime: CentralAdapterRuntime;
}): Promise<AdapterFamilyPublication> {
  const family = input.catalog.forFamily(input.familyId);
  const matches: FamilyLifecycleMatch[] = [];
  for (const observation of input.observations) {
    for (const match of input.catalog.matches(observation)) {
      if (match.familyId !== input.familyId) continue;
      matches.push(Object.freeze({
        matchedPatternId: match.patternId,
        observation,
      }));
    }
  }
  if (matches.length === 0) {
    throw new Error(
      `strict Family lifecycle has no matched observation for ${input.familyId}`,
    );
  }
  let publication: AdapterFamilyPublication | null = null;
  const result = await executeAdapterFamilyLifecycleBatch({
    family,
    matches,
    source: input.source,
    generation: input.source.generation,
    runtime: input.runtime,
    publisher: { publish: (value) => { publication = value; } },
  });
  if (result.publication === null || publication === null) {
    const failed = result.outcomes.find((outcome) =>
      outcome.status === "unresolved" || outcome.status === "failed"
    );
    throw new Error(
      `strict Family lifecycle did not publish for ${input.familyId}: ` +
        `${failed?.stage ?? "unknown"} ${failed?.status ?? "unknown"} ` +
        `${failed?.reasonCode ?? ""}`,
    );
  }
  return publication;
}
