import {
  blockScanEdgeKey,
  type RegisteredBlockScanStateFamily,
  type VerifiedGraphView,
} from "../venues/blockscan-state-capability.js";
import type { RegisteredFundingFamily } from
  "../venues/funding/funding-capability.js";
import type {
  AdapterFamily,
} from "../venues/route-leg-adapter.js";
import type { RouteLegRegistry } from "../venues/route-leg-registry.js";
import { STRICT_PROJECTED_FAMILY_TEST_REGISTRY } from
  "./strict-family-test-compat.js";
import {
  blindHistoricalRpcCacheKey,
  buildBlindHistoricalPrewarmPlan,
  type BlindHistoricalAnchor,
  type BlindHistoricalDescriptorBinding,
  type BlindHistoricalDescriptorDomain,
  type BlindHistoricalPrewarmPlan,
  type BlindHistoricalRpcCall,
} from "./adapter-family-blind-content-addressed-rpc.js";
import { sha256Canonical } from "./adapter-family-blind-contract.js";

/**
 * Narrow projection used by tests. Production callers use
 * STRICT_PROJECTED_FAMILY_TEST_REGISTRY through exportProductionBlindRequirements.
 */
export interface BlindProductionDescriptorRegistry {
  list(): readonly AdapterFamily[];
  routes(): RouteLegRegistry;
  blockScanStateFamilies(): readonly RegisteredBlockScanStateFamily[];
  fundingStateFamilies(): readonly RegisteredFundingFamily[];
  isBlockScanPricedEdge(edge: VerifiedGraphView["edges"][number]): boolean;
}

export interface BlindProductionDescriptorRequirement {
  readonly id: string;
  readonly domain: BlindHistoricalDescriptorDomain;
  readonly familyId: string;
  /**
   * Unsupported is an explicit strict-run failure. It must never be converted
   * into a zero-read "covered" descriptor.
   */
  readonly support:
    | { readonly status: "materializable" }
    | { readonly status: "unsupported"; readonly reason: string };
}

export interface BlindProductionDescriptorExport {
  readonly graphViewSha256: string;
  readonly activeFamilySetSha256: string;
  readonly fundingAssetSetSha256: string;
  readonly requirements: readonly BlindProductionDescriptorRequirement[];
  readonly requirementSetSha256: string;
}

export interface BlindProductionDescriptorMaterialization {
  readonly descriptorId: string;
  readonly calls: readonly BlindHistoricalRpcCall[];
}

/**
 * Derive the complete semantic requirement set from the frozen production
 * graph, active registry and resolved funding-token domain. Nothing in this
 * function accepts a target route, transaction, pool subset or expected edge.
 */
export function exportProductionBlindRequirements(input: {
  readonly graph: VerifiedGraphView;
  readonly activeFamilyIds: readonly string[];
  readonly fundingAssets: readonly string[];
  readonly registry?: BlindProductionDescriptorRegistry;
}): BlindProductionDescriptorExport {
  const registry = input.registry ?? STRICT_PROJECTED_FAMILY_TEST_REGISTRY;
  assertVerifiedGraphShape(input.graph);
  const registryFamilies = [...registry.list()]
    .map((family) => family.id)
    .sort();
  const activeFamilyIds = canonicalUnique(
    input.activeFamilyIds,
    "active family",
  );
  if (
    activeFamilyIds.length !== registryFamilies.length ||
    activeFamilyIds.some((familyId, index) =>
      familyId !== registryFamilies[index]
    )
  ) {
    throw new Error(
      "blind descriptor exporter active-family set is not the full production registry",
    );
  }
  const active = new Set(activeFamilyIds);
  const requirements: BlindProductionDescriptorRequirement[] = [];
  const pricingOwners = registry.blockScanStateFamilies();
  const routeRegistry = registry.routes();

  for (const edge of input.graph.edges) {
    const routeOwner = routeRegistry.findForEdge(edge.adapterId);
    if (!routeOwner || !active.has(routeOwner.id)) {
      throw new Error(
        `blind descriptor exporter graph edge ${blockScanEdgeKey(edge)} has no active route owner`,
      );
    }
    requirements.push(
      materializableRequirement(
        "executionDependencies",
        routeOwner.id,
        {
          edgeId: blockScanEdgeKey(edge),
          executionVariant: edge.canonicalEdgeId ?? null,
        },
      ),
    );
    requirements.push({
      ...requirement(
        "finalSimulation",
        routeOwner.id,
        {
          edgeId: blockScanEdgeKey(edge),
          executionVariant: edge.canonicalEdgeId ?? null,
        },
      ),
      support: {
        status: "unsupported",
        reason:
          "route family has no production capability that exports the full transitive final-sim read set",
      },
    });

    if (!registry.isBlockScanPricedEdge(edge)) continue;
    const owners = pricingOwners.filter((family) => family.ownsEdge(edge));
    if (owners.length !== 1 || !active.has(owners[0]!.familyId)) {
      throw new Error(
        `blind descriptor exporter priced edge ${blockScanEdgeKey(edge)} has ` +
          `${owners.length} active pricing owners`,
      );
    }
  }

  for (const family of pricingOwners) {
    if (!active.has(family.familyId)) {
      throw new Error(
        `blind descriptor exporter pricing family ${family.familyId} is absent from active registry`,
      );
    }
    const ownedEdges = input.graph.edges.filter((edge) =>
      family.ownsEdge(edge)
    );
    const byStateKey = new Map<string, string[]>();
    for (const edge of ownedEdges) {
      const stateKey = family.stateKey(edge);
      if (!stateKey) {
        throw new Error(
          `blind descriptor exporter family ${family.familyId} emitted empty state key`,
        );
      }
      const edgeIds = byStateKey.get(stateKey) ?? [];
      edgeIds.push(blockScanEdgeKey(edge));
      byStateKey.set(stateKey, edgeIds);
    }
    for (const [stateKey, edgeIds] of byStateKey) {
      requirements.push(
        materializableRequirement("graphState", family.familyId, {
          stateKey,
          edgeIds: [...edgeIds].sort(),
        }),
      );
    }
  }

  const fundingAssets = canonicalUnique(
    input.fundingAssets.map(normalizeAddress),
    "funding asset",
  );
  for (const family of registry.fundingStateFamilies()) {
    if (!active.has(family.familyId)) {
      throw new Error(
        `blind descriptor exporter funding family ${family.familyId} is absent from active registry`,
      );
    }
    const sources = family.describeSources(fundingAssets);
    for (const source of sources) {
      requirements.push(
        materializableRequirement("funding", family.familyId, {
          fundingId: source.fundingId,
          instanceKey: source.instanceKey,
          provider: normalizeAddress(source.provider),
          stateKey: source.stateKey,
          asset: normalizeAddress(source.asset),
          requiredReadKeys: [...source.requiredReadKeys].sort(),
        }),
      );
    }
  }

  const canonical = canonicalRequirements(requirements);
  assertRequiredDomains(canonical);
  return Object.freeze({
    graphViewSha256: sha256Canonical({
      id: input.graph.id,
      generation: input.graph.generation,
      sourceBlock: input.graph.sourceBlock,
      sourceBlockHash: input.graph.sourceBlockHash,
      completenessWatermark: input.graph.completenessWatermark,
      orderedEdgeHash: input.graph.orderedEdgeHash,
      metadataHash: input.graph.metadataHash,
      ownershipHash: input.graph.ownershipHash,
      perSourceCoverage: input.graph.perSourceCoverage,
    }),
    activeFamilySetSha256: sha256Canonical(activeFamilyIds),
    fundingAssetSetSha256: sha256Canonical(fundingAssets),
    requirements: canonical,
    requirementSetSha256: sha256Canonical(canonical),
  });
}

/**
 * Strict production entry. A materialization is accepted only when it exactly
 * covers the independently derived requirement IDs. Current route-family
 * contracts cannot export transitive final-sim dependencies, so this function
 * deliberately fails closed until that capability exists.
 */
export function buildProductionBlindHistoricalPrewarmPlan(input: {
  readonly base: BlindHistoricalAnchor;
  readonly source: BlindHistoricalAnchor;
  readonly inputs: BlindHistoricalPrewarmPlan["inputs"];
  readonly exporter: BlindHistoricalPrewarmPlan["exporter"];
  readonly graph: VerifiedGraphView;
  readonly activeFamilyIds: readonly string[];
  readonly fundingAssets: readonly string[];
  readonly materializations: readonly BlindProductionDescriptorMaterialization[];
  readonly registry?: BlindProductionDescriptorRegistry;
}): BlindHistoricalPrewarmPlan {
  const exported = exportProductionBlindRequirements(input);
  if (
    input.graph.sourceBlock !== input.source.number ||
    input.graph.sourceBlockHash.toLowerCase() !==
      input.source.hash.toLowerCase()
  ) {
    throw new Error(
      "blind descriptor exporter GraphView is not pinned to the source anchor",
    );
  }
  if (
    input.exporter.requirementSetSha256 !== exported.requirementSetSha256
  ) {
    throw new Error(
      "blind descriptor exporter frozen requirement-set hash mismatch",
    );
  }
  const unsupported = exported.requirements.filter(
    (item) => item.support.status === "unsupported",
  );
  if (unsupported.length > 0) {
    throw new Error(
      "blind descriptor exporter unsupported production dependencies: " +
        unsupported.map((item) => `${item.domain}/${item.familyId}`).join(","),
    );
  }

  const expected = new Map(
    exported.requirements.map((requirement) => [requirement.id, requirement]),
  );
  const seen = new Set<string>();
  const calls = new Map<string, BlindHistoricalRpcCall>();
  const descriptors: BlindHistoricalDescriptorBinding[] = [];
  for (const materialization of input.materializations) {
    const requirement = expected.get(materialization.descriptorId);
    if (!requirement) {
      throw new Error(
        `blind descriptor materialization is unrelated to production requirement ${materialization.descriptorId}`,
      );
    }
    if (seen.has(materialization.descriptorId)) {
      throw new Error(
        `blind descriptor materialization duplicates ${materialization.descriptorId}`,
      );
    }
    if (materialization.calls.length === 0) {
      throw new Error(
        `blind descriptor materialization ${materialization.descriptorId} has no exact calls`,
      );
    }
    const rpcKeys: string[] = [];
    for (const call of materialization.calls) {
      const key = blindHistoricalRpcCacheKey(call);
      calls.set(key, call);
      rpcKeys.push(key);
    }
    seen.add(materialization.descriptorId);
    descriptors.push({
      id: materialization.descriptorId,
      domain: requirement.domain,
      rpcKeys,
    });
  }
  const missing = [...expected.keys()].filter((id) => !seen.has(id));
  if (missing.length > 0) {
    throw new Error(
      `blind descriptor materialization misses production requirement ${missing.join(",")}`,
    );
  }
  return buildBlindHistoricalPrewarmPlan({
    base: input.base,
    source: input.source,
    inputs: input.inputs,
    exporter: input.exporter,
    descriptors,
    calls: [...calls.values()],
  });
}

function requirement(
  domain: BlindHistoricalDescriptorDomain,
  familyId: string,
  subject: Readonly<Record<string, unknown>>,
): Omit<BlindProductionDescriptorRequirement, "support"> {
  return Object.freeze({
    id: `${domain}:${sha256Canonical({ domain, familyId, subject })}`,
    domain,
    familyId,
  });
}

function materializableRequirement(
  domain: BlindHistoricalDescriptorDomain,
  familyId: string,
  subject: Readonly<Record<string, unknown>>,
): BlindProductionDescriptorRequirement {
  return Object.freeze({
    ...requirement(domain, familyId, subject),
    support: Object.freeze({ status: "materializable" as const }),
  });
}

function canonicalRequirements(
  values: readonly BlindProductionDescriptorRequirement[],
): readonly BlindProductionDescriptorRequirement[] {
  const sorted = [...values].sort((left, right) =>
    left.domain.localeCompare(right.domain) ||
    left.familyId.localeCompare(right.familyId) ||
    left.id.localeCompare(right.id)
  );
  const ids = new Set<string>();
  for (const item of sorted) {
    if (ids.has(item.id)) {
      throw new Error(`blind descriptor exporter duplicate requirement ${item.id}`);
    }
    ids.add(item.id);
  }
  return Object.freeze(sorted);
}

function assertRequiredDomains(
  requirements: readonly BlindProductionDescriptorRequirement[],
): void {
  for (const domain of [
    "graphState",
    "funding",
    "executionDependencies",
    "finalSimulation",
  ] as const) {
    if (!requirements.some((requirement) => requirement.domain === domain)) {
      throw new Error(
        `blind descriptor exporter has no production requirement for domain ${domain}`,
      );
    }
  }
}

function assertVerifiedGraphShape(graph: VerifiedGraphView): void {
  if (
    !graph.id ||
    !Number.isSafeInteger(graph.generation) ||
    graph.generation < 0 ||
    !Number.isSafeInteger(graph.sourceBlock) ||
    graph.sourceBlock < 0 ||
    !/^(?:0x)?[0-9a-f]{64}$/i.test(graph.sourceBlockHash) ||
    graph.edges.length === 0 ||
    graph.perSourceCoverage.length === 0
  ) {
    throw new Error("blind descriptor exporter requires a full verified graph");
  }
}

function canonicalUnique(values: readonly string[], label: string): string[] {
  if (values.length === 0) throw new Error(`${label} set is empty`);
  const canonical = values.map((value) => {
    if (!value || value !== value.trim()) {
      throw new Error(`${label} contains empty/noncanonical value`);
    }
    return value;
  }).sort();
  if (new Set(canonical).size !== canonical.length) {
    throw new Error(`${label} set contains duplicates`);
  }
  return canonical;
}

function normalizeAddress(value: string): string {
  if (!/^0x[0-9a-f]{40}$/i.test(value)) {
    throw new Error(`invalid production address ${value}`);
  }
  return value.toLowerCase();
}
