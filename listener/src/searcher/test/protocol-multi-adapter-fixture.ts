import { ethers } from "ethers";
import {
  EMPTY_PROTOCOL_DISCOVERY_OWNERSHIP,
  prepareProtocolDiscoveryProjection,
  protocolInstanceKey,
  replaceProtocolDiscoveryOwnership,
  runProtocolDiscovery,
  type VerifiedProtocolAdmission,
} from "../protocol-instance-discovery.js";
import { buildStrategyViews } from "../strategy-views.js";
import { deriveEdgeTaxonomy } from "../strategy-taxonomy.js";
import { poolRegistryKey } from "../pool-universe.js";
import type { PoolEntry, TokenEdge } from "../planner/token-graph.js";
import type {
  AttestedProtocolInstance,
  ProtocolConversionAdapter,
  ProtocolDiscoveryContext,
  RouteLegAdapter,
} from "../venues/route-leg-adapter.js";

/**
 * Second dynamic adapter fixture (impl spec §三.4 hard acceptance). C1 ships a
 * single dynamic family (erc4626), so multi-adapter arbitration, cross-pass A/B
 * conflict, same-address multi-pair coexistence, and fingerprint dedup/isolation
 * have no natural trigger. This fixture stands up TWO independent test-only
 * ProtocolDiscoveryCapability adapters to drive cores 5/6/7 end-to-end.
 */

const TARGET = "0x1111111111111111111111111111111111111111";
const TARGET_2 = "0x2222222222222222222222222222222222222222";
const ASSET_A = "0x3333333333333333333333333333333333333333";
const ASSET_B = "0x4444444444444444444444444444444444444444";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`FAIL: ${message}`);
}

function edge(
  edgeAdapterId: string,
  target: string,
  tokenIn: string,
  tokenOut: string,
  action: "wrap" | "redeem",
): TokenEdge {
  return {
    adapterId: edgeAdapterId,
    target,
    tokenIn,
    tokenOut,
    slotKind: "protocol",
    protocolAction: action,
    ...deriveEdgeTaxonomy("protocol", action),
  };
}

/**
 * A test-only dynamic adapter. `edgePrefix` sets the execution family so two
 * fixtures can produce the SAME semantic route with EITHER equivalent or
 * non-equivalent execution fingerprints. `routes` is a pure function of the
 * probed instance, so the same adapter can serve multiple targets.
 */
function fixtureAdapter(input: {
  id: `protocol:${string}`;
  edgePrefix: string;
  routes: (instance: AttestedProtocolInstance) => TokenEdge[];
}): ProtocolConversionAdapter {
  return {
    id: input.id,
    kind: "protocol-conversion",
    poolAdapters: ["erc4626"],
    identityPolicies: [{ poolAdapter: "erc4626", policy: "trusted-singleton-seed" }],
    edgeAdapterIds: [`${input.edgePrefix}-wrap`, `${input.edgePrefix}-redeem`],
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
    undeclaredVenueReason: "fixture instances require discovery",
    discoveryIdentityAuthority: { class: "canonical-onchain", strength: 300 },
    discovery: {
      candidateSources: [],
      eventTopics: [],
      callSelectors: [],
      async probeCandidate(instance) {
        return input.routes(instance);
      },
    },
    async buildEdges() { return []; },
    async quoteExact() { return 0n; },
    async buildPlanFragment() { return { requirements: [], nodes: [] }; },
  };
}

const context: ProtocolDiscoveryContext = {
  blockNumber: 100,
  fromBlock: 100,
  toBlock: 100,
  chainId: "1",
  graphTokens: [TARGET, TARGET_2, ASSET_A, ASSET_B],
  retainedInstances: [],
  backend: {
    async call() { throw new Error("fixture backend should not be called"); },
    async getCode() { return "0x60006000"; },
    async getStorageAt() { return `0x${"0".repeat(64)}`; },
    async getLogs() { return []; },
    async getTransactionReceipt() { return null; },
    async traceTransaction() { throw new Error("no trace in fixture"); },
  },
};

const attest = async (
  _adapter: RouteLegAdapter,
  candidate: { pool: PoolEntry },
): Promise<PoolEntry & { identitySource: "erc4626-standard" }> => ({
  ...candidate.pool,
  identitySource: "erc4626-standard",
});

function candidate(target: string, asset: string, logicalInstanceId?: string) {
  return {
    pool: {
      address: target,
      adapter: "erc4626" as const,
      fixedTokenIn: asset,
      ...(logicalInstanceId === undefined ? {} : { logicalInstanceId }),
    },
    source: "fixture-source",
  };
}

const buildViews = (pools: PoolEntry[]) => buildStrategyViews(pools, [], [], {
  blockscanMaxPools: 100,
  poolUniverseGeneratedAt: "test",
});

// ── Scenario 1: same-address multi-pair coexistence (core 7) ────────────────
const multiPairAdapter = fixtureAdapter({
  id: "protocol:fixture-multipair",
  edgePrefix: "alpha",
  routes: (instance) => [
    edge("alpha-wrap", instance.pool.address, ASSET_A, instance.pool.address, "wrap"),
    edge("alpha-redeem", instance.pool.address, instance.pool.address, ASSET_A, "redeem"),
    edge("alpha-wrap", instance.pool.address, ASSET_B, instance.pool.address, "wrap"),
    edge("alpha-redeem", instance.pool.address, instance.pool.address, ASSET_B, "redeem"),
  ],
});
const multiPair = await runProtocolDiscovery({
  adapters: [multiPairAdapter],
  context,
  protocolEdgesEnabled: true,
  attestIdentity: attest,
  candidatesByAdapter: new Map([[multiPairAdapter.id, [candidate(TARGET, ASSET_A)]]]),
});
assert(multiPair.wouldAdmit.length === 1, "one instance admitted");
assert(multiPair.wouldAdmit[0].edges.length === 4, "same target must keep both token pairs");
assert(
  new Set(multiPair.wouldAdmit[0].claims.map((claim) => claim.semanticRouteKey)).size === 4,
  "each token pair/direction is a distinct semantic route that coexists",
);

// ── Scenario 2: two adapters, equivalent execution → dedup (core 6) ─────────
const equivalentBeta = fixtureAdapter({
  id: "protocol:fixture-equivalent-beta",
  edgePrefix: "alpha", // SAME execution family as multiPairAdapter
  routes: (instance) => [
    edge("alpha-wrap", instance.pool.address, ASSET_A, instance.pool.address, "wrap"),
    edge("alpha-redeem", instance.pool.address, instance.pool.address, ASSET_A, "redeem"),
  ],
});
const equivalentAlpha = fixtureAdapter({
  id: "protocol:fixture-equivalent-alpha",
  edgePrefix: "alpha",
  routes: (instance) => [
    edge("alpha-wrap", instance.pool.address, ASSET_A, instance.pool.address, "wrap"),
    edge("alpha-redeem", instance.pool.address, instance.pool.address, ASSET_A, "redeem"),
  ],
});
const equivalent = await runProtocolDiscovery({
  adapters: [equivalentAlpha, equivalentBeta],
  context,
  protocolEdgesEnabled: true,
  attestIdentity: attest,
  candidatesByAdapter: new Map([
    [equivalentAlpha.id, [candidate(TARGET, ASSET_A)]],
    [equivalentBeta.id, [candidate(TARGET, ASSET_A)]],
  ]),
});
assert(equivalent.wouldAdmit.length === 2, "equivalent claims both stay verified");
{
  const projection = prepareProtocolDiscoveryProjection({
    currentOwnership: EMPTY_PROTOCOL_DISCOVERY_OWNERSHIP,
    result: equivalent,
    currentBackrunPools: [],
    currentBackrunGraph: [],
    currentKnownPoolKeys: new Set(),
    buildStrategyViews: buildViews,
  });
  assert(
    projection.backrunGraph.length === 2,
    "equivalent claims must deduplicate to one edge pair at the merge",
  );
}
assert(
  equivalent.events.some((event) =>
    event.stage === "arbitration" && event.verdict === "would_admit" &&
    /equivalent_route_claims/.test(event.reason ?? "")),
  "equivalent multi-adapter claims report an explicit co-ownership outcome",
);

// ── Scenario 3: two adapters, non-equivalent execution → isolate+alert ──────
const rivalBeta = fixtureAdapter({
  id: "protocol:fixture-rival-beta",
  edgePrefix: "beta", // DIFFERENT execution family, same semantic route
  routes: (instance) => [
    edge("beta-wrap", instance.pool.address, ASSET_A, instance.pool.address, "wrap"),
    edge("beta-redeem", instance.pool.address, instance.pool.address, ASSET_A, "redeem"),
  ],
});
const nonEquivalent = await runProtocolDiscovery({
  adapters: [equivalentAlpha, rivalBeta],
  context,
  protocolEdgesEnabled: true,
  attestIdentity: attest,
  candidatesByAdapter: new Map([
    [equivalentAlpha.id, [candidate(TARGET, ASSET_A)]],
    [rivalBeta.id, [candidate(TARGET, ASSET_A)]],
  ]),
});
assert(nonEquivalent.wouldAdmit.length === 0, "non-equivalent execution isolates the route for all");
{
  const alerted = new Set(
    nonEquivalent.events
      .filter((event) =>
        event.stage === "arbitration" && event.verdict === "rejected" &&
        /non_equivalent_execution_fingerprints/.test(event.reason ?? ""))
      .map((event) => event.adapterId),
  );
  assert(
    alerted.has(equivalentAlpha.id) && alerted.has(rivalBeta.id),
    "non-equivalent multi-adapter claims alert every claimant",
  );
}

// ── Scenario 4: cross-pass A/B adjudicated together (core 5) ────────────────
// Pass 1: adapter A admits TARGET. Pass 2: A's TARGET returns as a retained
// (owner-scoped) candidate while adapter B first-time discovers TARGET_2. Both
// must be visible to one adjudication and neither may shadow the other.
const passAAdapter = fixtureAdapter({
  id: "protocol:fixture-pass-a",
  edgePrefix: "alpha",
  routes: (instance) => [
    edge("alpha-wrap", instance.pool.address, ASSET_A, instance.pool.address, "wrap"),
  ],
});
const passBAdapter = fixtureAdapter({
  id: "protocol:fixture-pass-b",
  edgePrefix: "beta",
  routes: (instance) => [
    edge("beta-wrap", instance.pool.address, ASSET_B, instance.pool.address, "wrap"),
  ],
});
const pass1 = await runProtocolDiscovery({
  adapters: [passAAdapter, passBAdapter],
  context,
  protocolEdgesEnabled: true,
  attestIdentity: attest,
  candidatesByAdapter: new Map([[passAAdapter.id, [candidate(TARGET, ASSET_A)]]]),
});
assert(pass1.wouldAdmit.length === 1, "pass 1 admits adapter A only");
const ownershipAfterPass1 = replaceProtocolDiscoveryOwnership(
  EMPTY_PROTOCOL_DISCOVERY_OWNERSHIP,
  pass1,
);
const retained = [...ownershipAfterPass1.admissions.values()].map(
  (item): AttestedProtocolInstance => ({ ...item.instance, ownerAdapterId: item.adapterId }),
);
const pass2 = await runProtocolDiscovery({
  adapters: [passAAdapter, passBAdapter],
  context: { ...context, retainedInstances: retained },
  protocolEdgesEnabled: true,
  attestIdentity: attest,
  candidatesByAdapter: new Map([[passBAdapter.id, [candidate(TARGET_2, ASSET_B)]]]),
});
{
  const byAdapter = new Map(pass2.wouldAdmit.map((a) => [a.adapterId, a] as const));
  assert(
    byAdapter.has(passAAdapter.id) && byAdapter.has(passBAdapter.id),
    "cross-pass adjudication sees the retained A route and the new B route together",
  );
  assert(
    byAdapter.get(passAAdapter.id)!.instance.pool.address.toLowerCase() === TARGET.toLowerCase() &&
      byAdapter.get(passBAdapter.id)!.instance.pool.address.toLowerCase() === TARGET_2.toLowerCase(),
    "retained and freshly discovered routes must not shadow each other",
  );
}

// ── Scenario 5: same-address logical instances → distinct ownership (core 7) ─
const logicalInstances = await runProtocolDiscovery({
  adapters: [multiPairAdapter],
  context,
  protocolEdgesEnabled: true,
  attestIdentity: attest,
  candidatesByAdapter: new Map([[multiPairAdapter.id, [
    candidate(TARGET, ASSET_A, "pair-a"),
    candidate(TARGET, ASSET_B, "pair-b"),
  ]]]),
});
{
  const ownership = replaceProtocolDiscoveryOwnership(
    EMPTY_PROTOCOL_DISCOVERY_OWNERSHIP,
    logicalInstances,
  );
  assert(
    ownership.admissions.size === 2,
    "two logical instances at one address must own two distinct ownership keys",
  );
  assert(
    ownership.admissions.has(protocolInstanceKey(multiPairAdapter.id, { address: TARGET, logicalInstanceId: "pair-a" })) &&
      ownership.admissions.has(protocolInstanceKey(multiPairAdapter.id, { address: TARGET, logicalInstanceId: "pair-b" })),
    "logical-instance ownership keys must separate same-address instances",
  );
  const projection = prepareProtocolDiscoveryProjection({
    currentOwnership: EMPTY_PROTOCOL_DISCOVERY_OWNERSHIP,
    result: logicalInstances,
    currentBackrunPools: [],
    currentBackrunGraph: [],
    currentKnownPoolKeys: new Set(),
    buildStrategyViews: buildViews,
  });
  const sameAddressPools = projection.strategyViews.backrun.filter(
    (pool: PoolEntry) => pool.address.toLowerCase() === TARGET.toLowerCase(),
  );
  assert(
    sameAddressPools.length === 2 &&
      new Set(sameAddressPools.map(poolRegistryKey)).size === 2,
    "same-address logical instances must project two distinct registry rows",
  );
}

// Sanity: none of the fixture admissions leaked an observed selector into the
// semantic key (execution-only concern), guarding core 6's key discipline.
for (const result of [multiPair, equivalent, logicalInstances] as const) {
  for (const admission of result.wouldAdmit as VerifiedProtocolAdmission[]) {
    for (const claim of admission.claims) {
      assert(
        !claim.semanticRouteKey.includes(claim.edgeAdapterId),
        "semantic route key must never embed an execution edge adapter id",
      );
    }
  }
}

console.log("protocol-multi-adapter-fixture PASS");
export {};
