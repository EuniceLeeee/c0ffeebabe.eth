import {
  EMPTY_PROTOCOL_DISCOVERY_OWNERSHIP,
  prepareProtocolDiscoveryProjection,
  protocolEdgeKey,
  protocolInstanceKey,
  protocolDiscoveryProjectionChangesRouting,
  runProtocolDiscoveryShadow,
} from "../protocol-instance-discovery.js";
import { canonicalEdgeId } from "../venues/blockscan-state-capability.js";
import { buildStrategyViews, hashTokenGraph } from "../strategy-views.js";
import type { PoolEntry, TokenEdge } from "../planner/token-graph.js";
import { deriveEdgeTaxonomy } from "../strategy-taxonomy.js";
import type {
  ProtocolCandidate,
  ProtocolConversionAdapter,
  ProtocolDiscoveryCapability,
  ProtocolDiscoveryContext,
  ProtocolDiscoveryReadControl,
} from "../venues/route-leg-adapter.js";

const TARGET_A = "0x1111111111111111111111111111111111111111";
const TARGET_B = "0x2222222222222222222222222222222222222222";
const TARGET_C = "0x3333333333333333333333333333333333333333";
const TARGET_D = "0x4444444444444444444444444444444444444444";
const ASSET_A = "0x5555555555555555555555555555555555555555";
const ASSET_B = "0x6666666666666666666666666666666666666666";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`FAIL: ${message}`);
}

const context: ProtocolDiscoveryContext = {
  blockNumber: 123,
  fromBlock: 100,
  toBlock: 123,
  graphTokens: [TARGET_A, TARGET_B, TARGET_C, TARGET_D],
  retainedInstances: [],
  backend: {
    async call() { throw new Error("unexpected call"); },
    async getCode() { throw new Error("unexpected getCode"); },
    async getStorageAt() { throw new Error("unexpected getStorageAt"); },
    async getLogs() { return []; },
    async getTransactionReceipt() { return null; },
    async traceTransaction() { throw new Error("unexpected traceTransaction"); },
  },
};

function candidate(target: string, selector?: string): ProtocolCandidate {
  return {
    pool: { address: target, adapter: "erc4626", fixedTokenIn: ASSET_A },
    source: "test-active-source",
    ...(selector === undefined ? {} : { selector }),
  };
}

function edge(
  target: string,
  adapterId: "shadow-wrap" | "shadow-redeem" | "rival-wrap" | "rival-redeem",
  tokenIn: string,
  tokenOut: string,
): TokenEdge {
  const protocolAction = adapterId.endsWith("wrap") ? "wrap" : "redeem";
  return {
    adapterId,
    target,
    tokenIn,
    tokenOut,
    slotKind: "protocol",
    protocolAction,
    ...deriveEdgeTaxonomy("protocol", protocolAction),
  };
}

let ordinaryBuildEdgesCalls = 0;
function adapter(discovery: ProtocolDiscoveryCapability): ProtocolConversionAdapter {
  return {
    id: "protocol:shadow-test",
    kind: "protocol-conversion",
    poolAdapters: ["erc4626"],
    identityPolicies: [{ poolAdapter: "erc4626", policy: "trusted-singleton-seed" }],
    edgeAdapterIds: ["shadow-wrap", "shadow-redeem"],
    allowedTaxonomy: [
      { slotKind: "protocol", protocolAction: "wrap" },
      { slotKind: "protocol", protocolAction: "redeem" },
    ],
    ownedActionAdapterIds: [],
    requiredInfraActionAdapterIds: [],
    requiresProtocolEdgesFlag: true,
    pricingState: {
      stateKey: (edge) => edge.target.toLowerCase(),
      compileStaticSchema: () => null,
      buildCurrentBlockReads: () => [],
      decodeState: () => null,
      deriveMids: () => new Map(),
      dependencies: () => [],
    },
    prepared: null,
    declaredVenues: [],
    undeclaredVenueReason: "test instances require discovery",
    discovery,
    discoveryIdentityAuthority: { class: "trusted-seed", strength: 0 },
    async buildEdges() {
      ordinaryBuildEdgesCalls++;
      return [];
    },
    async quoteExact() { return 0n; },
    async buildPlanFragment() { return { requirements: [], nodes: [] }; },
  };
}

const originalGraph = [edge(TARGET_B, "shadow-wrap", ASSET_B, TARGET_B)];
const originalGraphSnapshot = JSON.stringify(originalGraph);

const calls = { identity: 0, probe: 0 };
const callCount = (name: keyof typeof calls): number => calls[name];
const successAdapter = adapter({
  candidateSources: ["dex-token-domain"],
  eventTopics: [],
  callSelectors: [],
  async probeCandidate(instance) {
    calls.probe++;
    return [
      edge(instance.pool.address, "shadow-wrap", ASSET_A, instance.pool.address),
      edge(instance.pool.address, "shadow-redeem", instance.pool.address, ASSET_A),
      edge(instance.pool.address, "shadow-wrap", ASSET_B, instance.pool.address),
      edge(instance.pool.address, "shadow-redeem", instance.pool.address, ASSET_B),
    ];
  },
});

const disabled = await runProtocolDiscoveryShadow({
  adapters: [successAdapter],
  context,
  protocolEdgesEnabled: false,
  async attestIdentity() {
    calls.identity++;
    return null;
  },
  candidatesByAdapter: new Map([[successAdapter.id, [candidate(TARGET_A), candidate(TARGET_A)]]]),
});
assert(callCount("identity") === 0, "feature flag must stop identity attestation");
assert(callCount("probe") === 0, "feature flag must stop route probing");
assert(disabled.wouldAdmit.length === 0, "feature flag off must admit zero edges");
assert(disabled.events[0]?.stage === "feature_flag", "feature flag rejection must be explicit");

const success = await runProtocolDiscoveryShadow({
  adapters: [successAdapter],
  context,
  protocolEdgesEnabled: true,
  async attestIdentity(_adapter, item) {
    calls.identity++;
    return { ...item.pool, identitySource: "seed" };
  },
  candidatesByAdapter: new Map([[successAdapter.id, [candidate(TARGET_A), candidate(TARGET_A)]]]),
});
assert(callCount("identity") === 1, "duplicate candidate must attest once");
assert(callCount("probe") === 1, "duplicate candidate must probe once");
assert(success.wouldAdmit.length === 1, "verified instance must produce one shadow admission");
assert(success.wouldAdmit[0].edges.length === 4, "one instance must retain multiple token pairs/routes");
assert(success.events[0]?.verdict === "would_admit", "verified instance must emit would_admit");
assert(success.events[0]?.wouldAdmitEdges === 4, "event must count verified routes");
assert(JSON.stringify(originalGraph) === originalGraphSnapshot, "shadow discovery must not mutate graph");

const sameDirectionLogicalAdapter = adapter({
  candidateSources: ["dex-token-domain"],
  eventTopics: [],
  callSelectors: [],
  async probeCandidate(instance) {
    return [
      edge(instance.pool.address, "shadow-wrap", ASSET_A, instance.pool.address),
    ];
  },
});
const sameDirectionLogical = await runProtocolDiscoveryShadow({
  adapters: [sameDirectionLogicalAdapter],
  context,
  protocolEdgesEnabled: true,
  async attestIdentity(_adapter, item) {
    return { ...item.pool, identitySource: "seed" };
  },
  candidatesByAdapter: new Map([[sameDirectionLogicalAdapter.id, [
    {
      pool: {
        address: TARGET_D,
        adapter: "erc4626",
        fixedTokenIn: ASSET_A,
        logicalInstanceId: "logical-a",
      },
      source: "logical-a",
    },
    {
      pool: {
        address: TARGET_D,
        adapter: "erc4626",
        fixedTokenIn: ASSET_A,
        logicalInstanceId: "logical-b",
      },
      source: "logical-b",
    },
  ]]]),
});
assert(
  sameDirectionLogical.wouldAdmit.length === 2,
  "same target/direction logical instances must both pass discovery",
);
const logicalEdges = sameDirectionLogical.wouldAdmit.map((item) => item.edges[0]);
assert(
  logicalEdges[0].instanceKey !== logicalEdges[1].instanceKey &&
    protocolEdgeKey(logicalEdges[0]) !== protocolEdgeKey(logicalEdges[1]),
  "family instance identity must prevent protocol edge-key collision",
);
assert(
  canonicalEdgeId(sameDirectionLogicalAdapter.id, logicalEdges[0]) !==
    canonicalEdgeId(sameDirectionLogicalAdapter.id, logicalEdges[1]),
  "logical instances must receive distinct canonical edge ids",
);
const logicalProjection = prepareProtocolDiscoveryProjection({
  currentOwnership: EMPTY_PROTOCOL_DISCOVERY_OWNERSHIP,
  result: sameDirectionLogical,
  currentBackrunPools: [],
  currentBackrunGraph: [],
  buildStrategyViews: (pools) => buildStrategyViews(pools, [], [], {
    blockscanMaxPools: 0,
    poolUniverseGeneratedAt: "logical-instance-test",
  }),
});
assert(
  logicalProjection.backrunGraph.length === 2 &&
    logicalProjection.strategyViews.backrun.length === 2,
  "same-address same-direction logical instances must coexist after graph merge",
);

const witness = { kind: "test-observation", txHash: `0x${"12".repeat(32)}`, blockNumber: 123 };
const evidenceOnce = await runProtocolDiscoveryShadow({
  adapters: [successAdapter],
  context,
  protocolEdgesEnabled: true,
  async attestIdentity(_adapter, item) { return { ...item.pool, identitySource: "seed" }; },
  candidatesByAdapter: new Map([[successAdapter.id, [{
    ...candidate(TARGET_D),
    evidence: [witness],
  }]]]),
});
const evidenceRepeat = await runProtocolDiscoveryShadow({
  adapters: [successAdapter],
  context: { ...context, retainedInstances: [evidenceOnce.wouldAdmit[0].instance] },
  protocolEdgesEnabled: true,
  async attestIdentity(_adapter, item) { return { ...item.pool, identitySource: "seed" }; },
  candidatesByAdapter: new Map([[successAdapter.id, [{
    ...candidate(TARGET_D),
    evidence: [witness],
  }]]]),
});
assert(
  evidenceRepeat.wouldAdmit[0].instance.evidence.length === 1,
  "repeated retained/current witnesses must not grow discovery evidence",
);
const boundedEvidence = await runProtocolDiscoveryShadow({
  adapters: [successAdapter],
  context,
  protocolEdgesEnabled: true,
  async attestIdentity(_adapter, item) { return { ...item.pool, identitySource: "seed" }; },
  candidatesByAdapter: new Map([[successAdapter.id, [{
    ...candidate(TARGET_D),
    evidence: Array.from({ length: 70 }, (_, blockNumber) => ({
      kind: "test-observation",
      blockNumber,
    })),
  }]]]),
});
assert(
  boundedEvidence.wouldAdmit[0].instance.evidence.length === 64,
  "per-instance discovery evidence must remain bounded",
);

const changedRoute = await runProtocolDiscoveryShadow({
  adapters: [adapter({
    candidateSources: ["dex-token-domain"],
    eventTopics: [],
    callSelectors: [],
    async probeCandidate(instance) {
      const asset = instance.pool.fixedTokenIn!;
      return [edge(instance.pool.address, "shadow-wrap", asset, instance.pool.address)];
    },
  })],
  context: { ...context, retainedInstances: [success.wouldAdmit[0].instance] },
  protocolEdgesEnabled: true,
  async attestIdentity(_adapter, item) { return { ...item.pool, identitySource: "seed" }; },
  candidatesByAdapter: new Map([["protocol:shadow-test", [{
    pool: { address: TARGET_A, adapter: "erc4626", fixedTokenIn: ASSET_B },
    source: "current-chain-source",
  }]]]),
});
assert(changedRoute.wouldAdmit.length === 1, "current metadata must replace retained instance shape");
assert(
  changedRoute.wouldAdmit[0].edges[0].tokenIn.toLowerCase() === ASSET_B.toLowerCase(),
  "asset change must admit the new route in the same pass instead of losing the candidate",
);

let rejectedProbeCalls = 0;
const identityRejected = await runProtocolDiscoveryShadow({
  adapters: [adapter({
    candidateSources: ["dex-token-domain"],
    eventTopics: [],
    callSelectors: [],
    async probeCandidate() {
      rejectedProbeCalls++;
      return [edge(TARGET_A, "shadow-wrap", ASSET_A, TARGET_A)];
    },
  })],
  context,
  protocolEdgesEnabled: true,
  async attestIdentity(_adapter, item) {
    if (item.pool.address.toLowerCase() === TARGET_A.toLowerCase()) return null;
    throw new Error("identity rpc reverted");
  },
  candidatesByAdapter: new Map([["protocol:shadow-test", [candidate(TARGET_A), candidate(TARGET_B)]]]),
});
assert(identityRejected.wouldAdmit.length === 0, "identity failure must admit zero edges");
assert(rejectedProbeCalls === 0, "identity failure must stop probing");
assert(
  identityRejected.events.every((item) => item.stage === "identity" && item.wouldAdmitEdges === 0),
  "identity null/revert must be fail-closed",
);

const probeRejected = await runProtocolDiscoveryShadow({
  adapters: [adapter({
    candidateSources: ["dex-token-domain"],
    eventTopics: [],
    callSelectors: [],
    async probeCandidate(instance) {
      if (instance.pool.address.toLowerCase() === TARGET_A.toLowerCase()) {
        throw new Error("probe reverted");
      }
      return [];
    },
  })],
  context,
  protocolEdgesEnabled: true,
  async attestIdentity(_adapter, item) { return { ...item.pool, identitySource: "seed" }; },
  candidatesByAdapter: new Map([["protocol:shadow-test", [candidate(TARGET_A), candidate(TARGET_B)]]]),
});
assert(probeRejected.wouldAdmit.length === 0, "probe revert/empty must admit zero edges");
assert(
  probeRejected.events.every((item) => item.stage === "probe" && item.wouldAdmitEdges === 0),
  "probe revert/empty must be fail-closed",
);

const malformedEdges = await runProtocolDiscoveryShadow({
  adapters: [adapter({
    candidateSources: ["dex-token-domain"],
    eventTopics: [],
    callSelectors: [],
    async probeCandidate(instance) {
      const target = instance.pool.address.toLowerCase();
      const valid = edge(instance.pool.address, "shadow-wrap", ASSET_A, instance.pool.address);
      if (target === TARGET_A.toLowerCase()) return [{ ...valid, target: TARGET_B }];
      if (target === TARGET_B.toLowerCase()) return [{ ...valid, adapterId: "foreign-edge" }];
      if (target === TARGET_C.toLowerCase()) return [{ ...valid, edgeKind: "swap" }];
      return [valid, { ...valid }];
    },
  })],
  context,
  protocolEdgesEnabled: true,
  async attestIdentity(_adapter, item) { return { ...item.pool, identitySource: "seed" }; },
  candidatesByAdapter: new Map([[
    "protocol:shadow-test",
    [candidate(TARGET_A), candidate(TARGET_B), candidate(TARGET_C), candidate(TARGET_D)],
  ]]),
});
assert(malformedEdges.wouldAdmit.length === 0, "malformed/duplicate routes must admit zero edges");
assert(
  malformedEdges.events.every((item) => item.stage === "probe" && item.wouldAdmitEdges === 0),
  "foreign target/adapter, bad taxonomy, and duplicate routes must fail closed",
);
assert(ordinaryBuildEdgesCalls === 0, "shadow probe results must not be re-expanded by buildEdges");

const incomplete = await runProtocolDiscoveryShadow({
  adapters: [adapter({
    candidateSources: ["dex-token-domain"],
    eventTopics: [],
    callSelectors: [],
    async probeCandidate() { return []; },
  })],
  context,
  protocolEdgesEnabled: true,
  async attestIdentity() { return null; },
  sourceComplete: false,
  sourceErrors: [{
    adapterId: null,
    sourceKind: "observed-interaction",
    impactedFamilyIds: ["protocol:shadow-test"],
    target: null,
    reason: "rpc range failed",
    retryable: true,
  }],
});
assert(!incomplete.sourceComplete, "candidate-source failure must prevent scan cursor advancement");

// Post-probe arbitration replaces the old pre-probe target quarantine: each
// candidate is verified first, then adjudicated per semantic route. Identical
// cross-adapter claims (same execution fingerprint) are equivalent and both
// stay verified, deduplicating at the edge merge.
const competingAdapter: ProtocolConversionAdapter = {
  ...successAdapter,
  id: "protocol:shadow-test-competing",
};
const equivalentAcrossSources = await runProtocolDiscoveryShadow({
  adapters: [successAdapter, competingAdapter],
  context,
  protocolEdgesEnabled: true,
  async attestIdentity(_adapter, item) { return { ...item.pool, identitySource: "seed" }; },
  candidatesByAdapter: new Map([
    [successAdapter.id, [candidate(TARGET_C)]],
    [competingAdapter.id, [{ ...candidate(TARGET_C), source: "second-source" }]],
  ]),
});
assert(
  equivalentAcrossSources.wouldAdmit.length === 2,
  "identical cross-adapter claims on one target must both stay verified",
);
assert(
  equivalentAcrossSources.events.some((item) =>
    item.stage === "arbitration" && item.verdict === "would_admit" &&
    /equivalent_route_claims/.test(item.reason ?? "")),
  "equivalent cross-source claims must be reported as an explicit arbitration outcome",
);

// A genuinely different execution of the SAME semantic route (different edge
// adapter) is non-equivalent: at least one adapter admitted a contract it
// should not have, so the contested route is isolated for every claimant and
// alerted rather than tie-broken.
const rivalAdapter: ProtocolConversionAdapter = {
  ...successAdapter,
  id: "protocol:shadow-test-rival",
  edgeAdapterIds: ["rival-wrap", "rival-redeem"],
  discovery: {
    candidateSources: ["dex-token-domain"],
    eventTopics: [],
    callSelectors: [],
    async probeCandidate(instance) {
      return [
        edge(instance.pool.address, "rival-wrap", ASSET_A, instance.pool.address),
        edge(instance.pool.address, "rival-redeem", instance.pool.address, ASSET_A),
        edge(instance.pool.address, "rival-wrap", ASSET_B, instance.pool.address),
        edge(instance.pool.address, "rival-redeem", instance.pool.address, ASSET_B),
      ];
    },
  },
};
const nonEquivalentAcrossSources = await runProtocolDiscoveryShadow({
  adapters: [successAdapter, rivalAdapter],
  context,
  protocolEdgesEnabled: true,
  async attestIdentity(_adapter, item) { return { ...item.pool, identitySource: "seed" }; },
  candidatesByAdapter: new Map([
    [successAdapter.id, [candidate(TARGET_C)]],
    [rivalAdapter.id, [{ ...candidate(TARGET_C), source: "second-source" }]],
  ]),
});
assert(
  nonEquivalentAcrossSources.wouldAdmit.length === 0,
  "non-equivalent execution of one semantic route must isolate the route for every claimant",
);
{
  const alertedAdapters = new Set(
    nonEquivalentAcrossSources.events
      .filter((item) =>
        item.stage === "arbitration" && item.verdict === "rejected" &&
        /non_equivalent_execution_fingerprints/.test(item.reason ?? ""))
      .map((item) => item.adapterId),
  );
  assert(
    alertedAdapters.has(successAdapter.id) && alertedAdapters.has(rivalAdapter.id),
    "non-equivalent cross-source claims must alert for both adapters",
  );
}

const projection = prepareProtocolDiscoveryProjection({
  currentOwnership: EMPTY_PROTOCOL_DISCOVERY_OWNERSHIP,
  result: success,
  currentBackrunPools: [],
  currentBackrunGraph: [],
  currentBlockscanGraph: [],
  currentKnownPoolKeys: new Set(),
  buildStrategyViews: (pools) => buildStrategyViews(pools, [], [], {
    blockscanMaxPools: 100,
    poolUniverseGeneratedAt: "test",
  }),
});
assert(projection.baseOwnershipVersion === 0, "projection must carry its ownership CAS base");
assert(projection.ownership.version === 1, "evaluated admission must advance ownership version");

const incumbentConflict = await runProtocolDiscoveryShadow({
  adapters: [successAdapter, rivalAdapter],
  context: {
    ...context,
    retainedInstances: [success.wouldAdmit[0].instance],
  },
  protocolEdgesEnabled: true,
  async attestIdentity(_adapter, item) { return { ...item.pool, identitySource: "seed" }; },
  candidatesByAdapter: new Map([
    [rivalAdapter.id, [{ ...candidate(TARGET_A), source: "new-rival-source" }]],
  ]),
});
assert(
  incumbentConflict.wouldAdmit.length === 1 &&
    incumbentConflict.wouldAdmit[0].adapterId === successAdapter.id,
  "non-equivalent newcomer must be quarantined without displacing the incumbent",
);
assert(
  incumbentConflict.events.some((item) =>
    item.adapterId === successAdapter.id &&
    item.stage === "arbitration" &&
    item.verdict === "would_admit" &&
    /incumbent_route_preserved/.test(item.reason ?? "")
  ) &&
    incumbentConflict.events.some((item) =>
      item.adapterId === rivalAdapter.id &&
      item.stage === "arbitration" &&
      item.verdict === "rejected" &&
      /non_equivalent_execution_fingerprints/.test(item.reason ?? "")
    ),
  "ownership conflict must report incumbent preservation and newcomer quarantine",
);
const incumbentConflictProjection = prepareProtocolDiscoveryProjection({
  currentOwnership: projection.ownership,
  result: incumbentConflict,
  currentBackrunPools: projection.strategyViews.backrun,
  currentBackrunGraph: projection.backrunGraph,
  currentBlockscanGraph: projection.blockscanGraph,
  currentKnownPoolKeys: projection.knownPoolKeys,
  buildStrategyViews: (pools) => buildStrategyViews(pools, [], [], {
    blockscanMaxPools: 100,
    poolUniverseGeneratedAt: "test",
  }),
});
assert(
  incumbentConflictProjection.ownership.admissions.has(
    protocolInstanceKey(successAdapter.id, success.wouldAdmit[0].instance.pool),
  ) &&
    !incumbentConflictProjection.ownership.admissions.has(
      protocolInstanceKey(rivalAdapter.id, success.wouldAdmit[0].instance.pool),
    ),
  "ownership replacement must retain only the incumbent claim",
);
assert(
  hashTokenGraph(incumbentConflictProjection.backrunGraph) ===
    hashTokenGraph(projection.backrunGraph),
  "quarantined newcomer must leave incumbent graph routes unchanged",
);

assert(
  protocolDiscoveryProjectionChangesRouting({
    strategyViews: buildStrategyViews([], [], [], {
      blockscanMaxPools: 100,
      poolUniverseGeneratedAt: "test",
    }),
    backrunGraph: [],
    blockscanGraph: [],
  }, projection),
  "first verified admission must report a routing change",
);
const repeatProjection = prepareProtocolDiscoveryProjection({
  currentOwnership: projection.ownership,
  result: success,
  currentBackrunPools: projection.strategyViews.backrun,
  currentBackrunGraph: projection.backrunGraph,
  currentBlockscanGraph: projection.blockscanGraph,
  currentKnownPoolKeys: projection.knownPoolKeys,
  buildStrategyViews: (pools) => buildStrategyViews(pools, [], [], {
    blockscanMaxPools: 100,
    poolUniverseGeneratedAt: "test",
  }),
});
assert(
  repeatProjection.ownership.version === 2,
  "repeat verification must still advance the ownership evidence version",
);
assert(
  !protocolDiscoveryProjectionChangesRouting({
    strategyViews: projection.strategyViews,
    backrunGraph: projection.backrunGraph,
    blockscanGraph: projection.blockscanGraph,
  }, repeatProjection),
  "repeat verification of identical routes must be a routing no-op",
);

const retainedContext: ProtocolDiscoveryContext = {
  ...context,
  retainedInstances: [success.wouldAdmit[0].instance],
};
const identityTimeout = await runProtocolDiscoveryShadow({
  adapters: [successAdapter],
  context: retainedContext,
  protocolEdgesEnabled: true,
  async attestIdentity() {
    throw Object.assign(new Error("local reth request timed out"), { code: "TIMEOUT" });
  },
});
assert(!identityTimeout.evaluationComplete, "identity timeout must leave evaluation retryable");
assert(identityTimeout.evaluatedInstanceKeys.size === 0, "identity timeout must not mark ownership evaluated");
assert(
  identityTimeout.familySourceCoverage.some(
    (coverage) =>
      coverage.familyId === successAdapter.id &&
      !coverage.complete &&
      coverage.issues.length > 0,
  ),
  "a retryable identity failure must degrade its owning family source",
);
const familyLocalSourceGap = await runProtocolDiscoveryShadow({
  adapters: [successAdapter, rivalAdapter],
  context: { ...context, retainedInstances: [] },
  protocolEdgesEnabled: true,
  async attestIdentity(_adapter, item) {
    return { ...item.pool, identitySource: "seed" };
  },
  sourceComplete: false,
  sourceErrors: [{
    adapterId: successAdapter.id,
    sourceKind: "dex-token-domain",
    impactedFamilyIds: [successAdapter.id],
    target: TARGET_A,
    reason: "owner matcher timed out",
    retryable: true,
  }],
  includeRetained: false,
});
const familyCoverage = new Map(
  familyLocalSourceGap.familySourceCoverage.map((coverage) => [
    coverage.familyId,
    coverage,
  ]),
);
assert(
  familyCoverage.get(successAdapter.id)?.complete === false,
  "an owner-tagged source failure must degrade its family",
);
assert(
  familyCoverage.get(rivalAdapter.id)?.complete === true,
  "an unrelated family source must remain complete",
);
const multiSourceAdapter: ProtocolConversionAdapter = {
  ...successAdapter,
  id: "protocol:shadow-test-multi-source",
  discovery: {
    ...successAdapter.discovery!,
    candidateSources: ["dex-token-domain", "observed-interaction"],
  },
};
const multiSourceGap = await runProtocolDiscoveryShadow({
  adapters: [multiSourceAdapter],
  context: { ...context, retainedInstances: [] },
  protocolEdgesEnabled: true,
  async attestIdentity(_adapter, item) {
    return { ...item.pool, identitySource: "seed" };
  },
  sourceComplete: false,
  sourceErrors: [{
    adapterId: multiSourceAdapter.id,
    sourceKind: "dex-token-domain",
    impactedFamilyIds: [multiSourceAdapter.id],
    target: TARGET_A,
    reason: "address matcher timed out",
    retryable: true,
  }],
  includeRetained: false,
});
const multiCoverage = new Map(
  multiSourceGap.familySourceCoverage.map((coverage) => [
    coverage.sourceId,
    coverage,
  ]),
);
assert(
  multiCoverage.get("dex-token-domain")?.complete === false &&
    multiCoverage.get("observed-interaction")?.complete === true,
  "one candidate-source failure must not erase a sibling source cursor",
);
const observedRivalAdapter: ProtocolConversionAdapter = {
  ...rivalAdapter,
  id: "protocol:shadow-test-observed-rival",
  discovery: {
    ...rivalAdapter.discovery!,
    candidateSources: ["observed-interaction"],
  },
};
const observedFamilySourceGap = await runProtocolDiscoveryShadow({
  adapters: [successAdapter, observedRivalAdapter],
  context: { ...context, retainedInstances: [] },
  protocolEdgesEnabled: true,
  async attestIdentity(_adapter, item) {
    return { ...item.pool, identitySource: "seed" };
  },
  sourceComplete: false,
  sourceErrors: [{
    adapterId: null,
    sourceKind: "observed-interaction",
    impactedFamilyIds: [observedRivalAdapter.id],
    target: null,
    reason: "event trace timed out",
    retryable: true,
  }],
  includeRetained: false,
});
const observedFamilyCoverage = new Map(
  observedFamilySourceGap.familySourceCoverage.map((coverage) => [
    coverage.familyId,
    coverage,
  ]),
);
assert(
  observedFamilyCoverage.get(observedRivalAdapter.id)?.complete === false,
  "an observed-interaction failure must degrade its declared owner",
);
assert(
  observedFamilyCoverage.get(successAdapter.id)?.complete === true,
  "an observed-interaction failure must not degrade an address-source sibling",
);
const retainedAfterIdentityTimeout = prepareProtocolDiscoveryProjection({
  currentOwnership: projection.ownership,
  result: identityTimeout,
  currentBackrunPools: projection.strategyViews.backrun,
  currentBackrunGraph: projection.backrunGraph,
  currentBlockscanGraph: projection.blockscanGraph,
  currentKnownPoolKeys: projection.knownPoolKeys,
  buildStrategyViews: (pools) => buildStrategyViews(pools, [], [], {
    blockscanMaxPools: 100,
    poolUniverseGeneratedAt: "test",
  }),
});
assert(
  retainedAfterIdentityTimeout.ownership.admissions.size === 1 &&
    retainedAfterIdentityTimeout.backrunGraph.length === 4,
  "transient identity failure must retain the last verified graph routes",
);

const probeTimeout = await runProtocolDiscoveryShadow({
  adapters: [adapter({
    candidateSources: ["dex-token-domain"],
    eventTopics: [],
    callSelectors: [],
    async probeCandidate() {
      throw Object.assign(new Error("local reth socket reset"), { code: "ECONNRESET" });
    },
  })],
  context: retainedContext,
  protocolEdgesEnabled: true,
  async attestIdentity(_adapter, item) { return { ...item.pool, identitySource: "seed" }; },
});
assert(!probeTimeout.evaluationComplete, "probe transport failure must leave evaluation retryable");
assert(probeTimeout.evaluatedInstanceKeys.size === 0, "probe transport failure must preserve ownership");

let semanticProbeCalls = 0;
const semanticNegativeAdapter = adapter({
  candidateSources: ["dex-token-domain"],
  eventTopics: [],
  callSelectors: [],
  async probeCandidate(instance) {
    semanticProbeCalls++;
    if (instance.pool.address !== TARGET_C) {
      throw new Error("behavior_mismatch");
    }
    return [
      edge(instance.pool.address, "shadow-wrap", ASSET_A, instance.pool.address),
    ];
  },
});
const semanticNegatives = await runProtocolDiscoveryShadow({
  adapters: [semanticNegativeAdapter],
  context,
  protocolEdgesEnabled: true,
  async attestIdentity(_adapter, item) {
    return { ...item.pool, identitySource: "seed" };
  },
  candidatesByAdapter: new Map([[
    semanticNegativeAdapter.id,
    [candidate(TARGET_A), candidate(TARGET_B), candidate(TARGET_C)],
  ]]),
  familyGuardOptions: { failureThreshold: 1 },
});
assert(
  semanticProbeCalls === 3,
  "deterministic probe negatives must not open the family circuit",
);
assert(
  semanticNegatives.evaluationComplete &&
    semanticNegatives.wouldAdmit.length === 1 &&
    semanticNegatives.wouldAdmit[0].instance.pool.address === TARGET_C,
  "a later valid instance must survive earlier semantic probe negatives",
);

let hangingIdentityCalls = 0;
const hangingIdentityAdapter: ProtocolConversionAdapter = {
  ...successAdapter,
  id: "protocol:shadow-test-hanging-identity",
};
const identityFamilySettled = await runProtocolDiscoveryShadow({
  adapters: [hangingIdentityAdapter, successAdapter],
  context,
  protocolEdgesEnabled: true,
  async attestIdentity(adapter, item) {
    if (adapter.id === hangingIdentityAdapter.id) {
      hangingIdentityCalls++;
      return new Promise<never>(() => {});
    }
    return { ...item.pool, identitySource: "seed" };
  },
  candidatesByAdapter: new Map([
    [hangingIdentityAdapter.id, [candidate(TARGET_A), candidate(TARGET_C)]],
    [successAdapter.id, [candidate(TARGET_B)]],
  ]),
  familyGuardOptions: { timeoutMs: 5, failureThreshold: 1 },
});
assert(
  hangingIdentityCalls === 1,
  "identity circuit must stop invoking a family after its failure budget is exhausted",
);
assert(
  identityFamilySettled.wouldAdmit.length === 1 &&
    identityFamilySettled.wouldAdmit[0].adapterId === successAdapter.id,
  "timed-out identity family must not suppress a healthy sibling admission",
);
assert(
  !identityFamilySettled.evaluationComplete &&
    identityFamilySettled.events.filter((item) =>
      item.adapterId === hangingIdentityAdapter.id && item.stage === "identity"
    ).length === 2,
  "identity timeout and open circuit must leave only the failed family retryable",
);

let hangingProbeCalls = 0;
let hangingProbeSignal: AbortSignal | undefined;
let markHangingProbeStarted!: () => void;
const hangingProbeStarted = new Promise<void>((resolve) => {
  markHangingProbeStarted = resolve;
});
let healthyProbeStartedBeforeBadAbort = false;
const hangingProbeAdapter: ProtocolConversionAdapter = {
  ...successAdapter,
  id: "protocol:shadow-test-hanging-probe",
  discovery: {
    ...successAdapter.discovery!,
    async probeCandidate(_instance, familyContext) {
      hangingProbeCalls++;
      await familyContext.backend.call({
        to: TARGET_A,
        data: "0xfeed0002",
      });
      return [];
    },
  },
};
const parallelHealthyProbeAdapter: ProtocolConversionAdapter = {
  ...successAdapter,
  id: "protocol:shadow-test-parallel-healthy-probe",
  discovery: {
    ...successAdapter.discovery!,
    async probeCandidate(instance) {
      await hangingProbeStarted;
      healthyProbeStartedBeforeBadAbort =
        hangingProbeSignal?.aborted === false;
      return [
        edge(instance.pool.address, "shadow-wrap", ASSET_A, instance.pool.address),
        edge(instance.pool.address, "shadow-redeem", instance.pool.address, ASSET_A),
        edge(instance.pool.address, "shadow-wrap", ASSET_B, instance.pool.address),
        edge(instance.pool.address, "shadow-redeem", instance.pool.address, ASSET_B),
      ];
    },
  },
};
const probeParent = new AbortController();
const controlledProbeContext: ProtocolDiscoveryContext = {
  ...context,
  backend: {
    ...context.backend,
    call(req, control) {
      if (req.data !== "0xfeed0002") {
        return context.backend.call(req, control);
      }
      hangingProbeSignal = control?.signal;
      markHangingProbeStarted();
      return new Promise<string>(() => {});
    },
  },
};
const probeFamilySettled = await runProtocolDiscoveryShadow({
  adapters: [hangingProbeAdapter, parallelHealthyProbeAdapter],
  context: controlledProbeContext,
  protocolEdgesEnabled: true,
  async attestIdentity(_adapter, item) { return { ...item.pool, identitySource: "seed" }; },
  candidatesByAdapter: new Map([
    [hangingProbeAdapter.id, [candidate(TARGET_A), candidate(TARGET_C)]],
    [parallelHealthyProbeAdapter.id, [candidate(TARGET_B)]],
  ]),
  familyGuardOptions: {
    timeoutMs: 20,
    failureThreshold: 1,
    deadlineAtMs: Date.now() + 1_000,
    signal: probeParent.signal,
    maxConcurrentPerFamily: 1,
  },
});
assert(
  hangingProbeCalls === 1,
  "probe circuit must stop invoking a family after its failure budget is exhausted",
);
assert(
  probeFamilySettled.wouldAdmit.length === 1 &&
    probeFamilySettled.wouldAdmit[0].adapterId ===
      parallelHealthyProbeAdapter.id,
  "timed-out probe family must not suppress a healthy sibling admission",
);
assert(
  healthyProbeStartedBeforeBadAbort,
  "candidate probing must run sibling families concurrently",
);
assert(
  hangingProbeSignal?.aborted === true && !probeParent.signal.aborted,
  "probe timeout must abort only the child backend signal",
);
assert(
  probeFamilySettled.events
    .filter((item) => item.stage === "probe")
    .map((item) => item.adapterId)
    .join(",") ===
      [
        hangingProbeAdapter.id,
        hangingProbeAdapter.id,
        parallelHealthyProbeAdapter.id,
      ].join(","),
  "parallel family completion must merge events in deterministic registration/candidate order",
);
assert(
  !probeFamilySettled.evaluationComplete &&
    probeFamilySettled.events.filter((item) =>
      item.adapterId === hangingProbeAdapter.id && item.stage === "probe"
    ).length === 2,
  "probe timeout and open circuit must leave only the failed family retryable",
);

{
  const parent = new AbortController();
  const deadlineAtMs = Date.now() + 1_000;
  let identityReadControl: ProtocolDiscoveryReadControl | undefined;
  const controlledContext: ProtocolDiscoveryContext = {
    ...context,
    backend: {
      ...context.backend,
      call(_req, control) {
        identityReadControl = control;
        return new Promise<string>((_resolve, reject) => {
          if (!control?.signal) {
            reject(new Error("fixture expected identity parent control"));
            return;
          }
          const stop = (): void =>
            reject(control.signal!.reason ?? new Error("identity parent stopped"));
          if (control.signal.aborted) {
            stop();
            return;
          }
          control.signal.addEventListener("abort", stop, { once: true });
        });
      },
    },
  };
  const pending = runProtocolDiscoveryShadow({
    adapters: [successAdapter],
    context: controlledContext,
    protocolEdgesEnabled: true,
    async attestIdentity(_adapter, item, identityContext) {
      await identityContext.backend.call({
        to: item.pool.address,
        data: "0xfeed0003",
      });
      return { ...item.pool, identitySource: "seed" };
    },
    candidatesByAdapter: new Map([[
      successAdapter.id,
      [candidate(TARGET_A)],
    ]]),
    control: { deadlineAtMs, signal: parent.signal },
  });
  const controlReadyAt = Date.now() + 250;
  while (identityReadControl === undefined && Date.now() < controlReadyAt) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert(
    identityReadControl !== undefined &&
      identityReadControl.deadlineAtMs === deadlineAtMs,
    "runProtocolDiscovery must merge the pass deadline into identity reads",
  );
  parent.abort(new Error("fixture discovery coordinator cancelled"));
  let cancellation: unknown = null;
  try {
    await pending;
  } catch (error) {
    cancellation = error;
  }
  assert(
    cancellation instanceof Error &&
      /fixture discovery coordinator cancelled/.test(cancellation.message),
    "coordinator cancellation must reject instead of publishing a partial result",
  );
  assert(
    identityReadControl.signal?.aborted === true,
    "coordinator parent cancellation must abort the identity transport signal",
  );
}

// Acceptance 12: flag OFF must leave the graph bit-identical even when the
// candidate source would otherwise admit a verified instance.
const flagOffBaseGraph = [edge(TARGET_B, "shadow-wrap", ASSET_B, TARGET_B)];
const flagOffPools: PoolEntry[] = [{
  address: TARGET_B, adapter: "erc4626", fixedTokenIn: ASSET_B,
}];
const flagOffResult = await runProtocolDiscoveryShadow({
  adapters: [successAdapter],
  context,
  protocolEdgesEnabled: false,
  async attestIdentity(_adapter, item) { return { ...item.pool, identitySource: "seed" }; },
  candidatesByAdapter: new Map([[successAdapter.id, [candidate(TARGET_A)]]]),
});
const flagOffProjection = prepareProtocolDiscoveryProjection({
  currentOwnership: EMPTY_PROTOCOL_DISCOVERY_OWNERSHIP,
  result: flagOffResult,
  currentBackrunPools: flagOffPools,
  currentBackrunGraph: flagOffBaseGraph,
  currentKnownPoolKeys: new Set(flagOffPools.map((pool) => pool.address.toLowerCase())),
  buildStrategyViews: (pools) => buildStrategyViews(pools, [], [], {
    blockscanMaxPools: 100,
    poolUniverseGeneratedAt: "test",
  }),
});
assert(
  flagOffResult.wouldAdmit.length === 0,
  "flag off must admit zero discovery instances",
);
assert(
  hashTokenGraph(flagOffProjection.backrunGraph) === hashTokenGraph(flagOffBaseGraph),
  "flag off + valid discovery must leave the graph hash unchanged",
);
assert(
  !protocolDiscoveryProjectionChangesRouting(
    { strategyViews: flagOffProjection.strategyViews, backrunGraph: flagOffBaseGraph },
    flagOffProjection,
  ),
  "flag off projection must not signal a routing change",
);

console.log("protocol-instance-discovery PASS");
