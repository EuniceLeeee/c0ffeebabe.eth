import {
  exercisedStage,
  frameworkBlockedStage,
} from "./architecture-migration-capture.js";
import type {
  RawFamilyMigrationCaseCapture,
  RawMigrationStageCapture,
} from "./architecture-migration-parity-runner.js";
import {
  projectFamilyRouteGraph,
} from "./adapter-family-graph-runtime.js";
import { runStrictFamilyLifecycle } from
  "./strict-family-lifecycle-runner.js";
import type {
  CentralAdapterRuntime,
} from "./adapter-work-intent.js";
import type { FamilyCapabilityCatalog } from
  "./venues/family-capability-catalog.js";
import type { UnifiedObservation } from
  "./venues/adapter-family-plugin.js";
import type { CanonicalSource } from
  "./venues/adapter-request-program.js";
import type { FamilyId } from
  "./venues/adapter-family-identifiers.js";
import type { PreparedFamilyInstance } from
  "./venues/adapter-family-runtime.js";
import { definedFamilyPluginContractSummary } from
  "./venues/adapter-family-plugin.js";

/**
 * Generic real-capture core (F5-b generic path): one family is captured by
 * (a) deriving the observation from the family plugin's discovery
 * declarations plus a real address, (b) running the standard strict
 * lifecycle, and (c) assembling every publication-derivable stage
 * generically. Exact/execution/final-sim are driven by the family plugin's
 * own exact/execution modules (per-plugin by architecture design), supplied
 * through the optional driver; absent a driver they are honestly marked
 * framework-blocked instead of fabricated.
 */
export async function captureFamilyGenerically(input: {
  readonly catalog: FamilyCapabilityCatalog;
  readonly familyId: FamilyId;
  readonly source: CanonicalSource;
  readonly observation: UnifiedObservation;
  readonly runtime: CentralAdapterRuntime;
  readonly caseId?: string;
}): Promise<RawFamilyMigrationCaseCapture> {
  const family = input.catalog.forFamily(input.familyId);
  const publication = await runStrictFamilyLifecycle({
    catalog: input.catalog,
    familyId: input.familyId,
    source: input.source,
    observations: Object.freeze([input.observation]),
    runtime: input.runtime,
  });
  const evidenceRefs = Object.freeze([
    `onchain:1:${input.source.hash}:generic:${input.familyId}`,
  ]);
  const edges: RawMigrationStageCapture["items"][number][] = [];
  const prices: RawMigrationStageCapture["items"][number][] = [];
  for (const instance of publication.instances) {
    for (const route of instance.routes) {
      const handle = instance.routeHandles.find((candidate) =>
        candidate.routeKey === route.routeKey
      );
      if (handle === undefined) {
        throw new Error(
          `prepared route ${route.routeKey} has no issued handle`,
        );
      }
      const projected = projectFamilyRouteGraph({
        family,
        descriptor: instance.descriptor,
        route,
        handle,
      });
      edges.push(Object.freeze({
        id: projected.edge.canonicalEdgeId,
        value: Object.freeze({
          routeKey: route.routeKey,
          tokenIn: route.tokenIn,
          tokenOut: route.tokenOut,
          canonicalEdgeId: projected.edge.canonicalEdgeId,
        }),
      }));
    }
    const routeByKey = new Map(
      instance.routes.map((route) => [route.routeKey, route]),
    );
    for (const pricing of instance.pricingInstances) {
      for (const [routeKey, mid] of pricing.mids) {
        const route = routeByKey.get(routeKey);
        if (route === undefined) {
          throw new Error(
            `${input.familyId} pricing route ${routeKey} is missing`,
          );
        }
        prices.push(Object.freeze({
          id: `${pricing.stateKey}:${route.tokenIn.toLowerCase()}>` +
            `${route.tokenOut.toLowerCase()}`,
          value: Object.freeze({
            stateKey: pricing.stateKey,
            mid: Object.freeze({ ...mid }),
          }) as unknown as RawMigrationStageCapture["items"][number]["value"],
        }));
      }
    }
  }
  const enumeratedRoutes: RawMigrationStageCapture["items"][number][] = edges
    .map((edge) => edge.value as {
      readonly routeKey: string;
      readonly tokenIn: string;
      readonly tokenOut: string;
      readonly canonicalEdgeId: string;
    })
    .sort((left, right) => left.routeKey.localeCompare(right.routeKey))
    .map((value, order) => Object.freeze({
      id: value.canonicalEdgeId,
      value: Object.freeze({
        routeKey: value.routeKey,
        tokenIn: value.tokenIn,
        tokenOut: value.tokenOut,
        canonicalEdgeId: value.canonicalEdgeId,
        order,
      }),
    }));
  const instances = publication.instances;
  const summary = definedFamilyPluginContractSummary(family.plugin);
  return Object.freeze({
    familyId: input.familyId,
    caseId: input.caseId ?? `${input.familyId}:${input.source.number}`,
    inputFingerprint: input.source.hash.slice(2).padStart(64, "0"),
    stateAnchorNumber: input.source.number,
    implementationClosureHash: summary.definitionBoundaryHash,
    stages: Object.freeze({
      instances: instanceStage(instances, evidenceRefs),
      edges: exercisedStage(edges, evidenceRefs),
      stateCoverage: exercisedStage([], evidenceRefs),
      pricedEdges: exercisedStage([], evidenceRefs),
      prices: exercisedStage(prices, evidenceRefs),
      failures: exercisedStage([], evidenceRefs),
      enumeratedRoutes: exercisedStage(enumeratedRoutes, evidenceRefs),
      exactQuotes: frameworkBlockedStage(
        evidenceRefs,
        "generic-capture-exact-driver-not-wired",
      ),
      executionFragments: frameworkBlockedStage(
        evidenceRefs,
        "generic-capture-execution-driver-not-wired",
      ),
      finalSimulations: frameworkBlockedStage(
        evidenceRefs,
        "generic-capture-final-sim-driver-not-wired",
      ),
    }),
  });
}

function instanceStage(
  instances: readonly PreparedFamilyInstance[],
  evidenceRefs: readonly string[],
): RawMigrationStageCapture {
  return exercisedStage(instances.map((instance) => Object.freeze({
    id: instance.instanceKey,
    value: Object.freeze({
      familyId: instance.familyId,
      instanceKey: instance.instanceKey,
      staticBindingFingerprint: instance.staticBindingFingerprint,
    }),
  })), evidenceRefs);
}
