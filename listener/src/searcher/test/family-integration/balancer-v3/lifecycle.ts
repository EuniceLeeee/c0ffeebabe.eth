import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { plugin } from "../../../venues/production-families/balancer-v3.production.js";
import { definedFamilyPluginContractSummary, type UnifiedObservation } from "../../../venues/adapter-family-plugin.js";
import { generateAbsentCapabilityIdentity, generateCapabilityClosure } from "../../../venues/capability-content-hash.js";
import { FamilyCapabilityCatalog, FAMILY_CAPABILITY_NAMES, capabilityManifestHash } from "../../../venues/family-capability-catalog.js";
import { executeAdapterFamilyLifecycleBatch } from "../../../venues/adapter-family-runtime.js";
import { buildFamilyRouteGraphView } from "../../../adapter-family-graph-runtime.js";
import { createStrictCentralAdapterRuntime } from "../../../strict-central-adapter-runtime.js";
import type { CanonicalSource } from "../../../venues/adapter-request-program.js";
import { assertSource } from "../../../venues/swaps/balancer-v3-family/codec.js";

// Compute the real source closure in memory; never edit the generated catalog
// and never manufacture capability hashes or process-local route handles.
export async function localCatalog(): Promise<FamilyCapabilityCatalog> {
  const directory = fileURLToPath(new URL("../../../venues/swaps/balancer-v3-family/", import.meta.url));
  const rootDirectory = fileURLToPath(new URL("../../../../../", import.meta.url));
  const familyId = plugin.manifest.familyId;
  const entries = [];
  for (const capability of FAMILY_CAPABILITY_NAMES) {
    if (capability === "funding" || capability === "credit") {
      entries.push(generateAbsentCapabilityIdentity({ familyId, capability, provenanceCommit: null }));
      continue;
    }
    const closure = await generateCapabilityClosure({ familyId, capability, rootDirectory,
      entryFile: resolve(directory, `${capability === "victim" ? "swap" : capability}.ts`),
      additionalEntryFiles: [resolve(directory, "manifest.ts"),
        ...(capability === "execution" ? [resolve(directory, "action.ts")] : [])], provenanceCommit: null });
    assert(closure.identity.semanticDependencies.every(path => !/registry|identity-resolver|swaps\/balancer-v3\.ts/.test(path)),
      `legacy authority leaked into ${capability}`);
    entries.push(closure.identity);
  }
  return new FamilyCapabilityCatalog({ requireCapture: true,
    modules: [{ sourceFile: "balancer-v3.production.ts", plugin,
      definitionBoundaryHash: definedFamilyPluginContractSummary(plugin).definitionBoundaryHash }],
    generatedManifest: { format: "adapter-family-capabilities-v1", entries, manifestHash: capabilityManifestHash(entries) } });
}

export async function admitToGraph(input: {
  catalog: FamilyCapabilityCatalog;
  observations: readonly UnifiedObservation[];
  source: CanonicalSource;
  executor: string;
  provider: Parameters<typeof createStrictCentralAdapterRuntime>[0]["provider"];
}) {
  const family = input.catalog.forFamily(plugin.manifest.familyId);
  const runtime = createStrictCentralAdapterRuntime({ provider: input.provider, executor: input.executor,
    generationFence: { assertCurrent(generation, source) {
      assert.equal(generation, input.source.generation); assertSource(source, input.source);
    } } });
  const matches = input.observations.flatMap(observation => input.catalog.matches(observation)
    .filter(match => match.familyId === family.plugin.manifest.familyId)
    .map(match => ({ observation, matchedPatternId: match.patternId })));
  const lifecycle = await executeAdapterFamilyLifecycleBatch({ family, matches, source: input.source,
    generation: input.source.generation, runtime, publisher: { publish() {} } });
  const graph = buildFamilyRouteGraphView({ routes: (lifecycle.publication?.instances ?? []).flatMap(instance =>
    instance.routes.map((route, i) => ({ family, descriptor: instance.descriptor, route, handle: instance.routeHandles[i] }))) });
  return { family, runtime, lifecycle, graph };
}
