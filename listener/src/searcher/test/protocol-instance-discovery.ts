import {
  EMPTY_PROTOCOL_DISCOVERY_OWNERSHIP,
  prepareProtocolDiscoveryProjection,
  runProtocolDiscoveryShadow,
} from "../protocol-instance-discovery.js";
import { buildStrategyViews } from "../strategy-views.js";
import type { PoolEntry, TokenEdge } from "../planner/token-graph.js";
import { deriveEdgeTaxonomy } from "../strategy-taxonomy.js";
import type {
  ProtocolCandidate,
  ProtocolConversionAdapter,
  ProtocolDiscoveryCapability,
  ProtocolDiscoveryContext,
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
  candidateTokens: [TARGET_A, TARGET_B, TARGET_C, TARGET_D],
  graphTokens: [TARGET_A, TARGET_B, TARGET_C, TARGET_D],
  retainedInstances: [],
  backend: {
    async call() { throw new Error("unexpected call"); },
    async getCode() { throw new Error("unexpected getCode"); },
    async getStorageAt() { throw new Error("unexpected getStorageAt"); },
    async getCodeAt() { throw new Error("unexpected getCodeAt"); },
    async getStorageAtBlock() { throw new Error("unexpected getStorageAtBlock"); },
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
  adapterId: "shadow-wrap" | "shadow-redeem",
  tokenIn: string,
  tokenOut: string,
): TokenEdge {
  const protocolAction = adapterId === "shadow-wrap" ? "wrap" : "redeem";
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
    edgeAdapterIds: ["shadow-wrap", "shadow-redeem"],
    allowedTaxonomy: [
      { slotKind: "protocol", protocolAction: "wrap" },
      { slotKind: "protocol", protocolAction: "redeem" },
    ],
    actionAdapterIds: [],
    requiresProtocolEdgesFlag: true,
    readMid: null,
    warm: null,
    prepared: null,
    declaredVenues: [],
    undeclaredVenueReason: "test instances require discovery",
    discovery,
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

const calls = { discover: 0, identity: 0, probe: 0 };
const callCount = (name: keyof typeof calls): number => calls[name];
const successAdapter = adapter({
  async discoverCandidates() {
    calls.discover++;
    return [candidate(TARGET_A), candidate(TARGET_A)];
  },
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
});
assert(callCount("discover") === 0, "feature flag must stop candidate discovery");
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
});
assert(callCount("discover") === 1, "enabled shadow must discover once");
assert(callCount("identity") === 1, "duplicate candidate must attest once");
assert(callCount("probe") === 1, "duplicate candidate must probe once");
assert(success.wouldAdmit.length === 1, "verified instance must produce one shadow admission");
assert(success.wouldAdmit[0].edges.length === 4, "one instance must retain multiple token pairs/routes");
assert(success.events[0]?.verdict === "would_admit", "verified instance must emit would_admit");
assert(success.events[0]?.wouldAdmitEdges === 4, "event must count verified routes");
assert(JSON.stringify(originalGraph) === originalGraphSnapshot, "shadow discovery must not mutate graph");

const changedRoute = await runProtocolDiscoveryShadow({
  adapters: [adapter({
    async discoverCandidates() {
      return [{
        pool: { address: TARGET_A, adapter: "erc4626", fixedTokenIn: ASSET_B },
        source: "current-chain-source",
      }];
    },
    async probeCandidate(instance) {
      const asset = instance.pool.fixedTokenIn!;
      return [edge(instance.pool.address, "shadow-wrap", asset, instance.pool.address)];
    },
  })],
  context: { ...context, retainedInstances: [success.wouldAdmit[0].instance] },
  protocolEdgesEnabled: true,
  async attestIdentity(_adapter, item) { return { ...item.pool, identitySource: "seed" }; },
});
assert(changedRoute.wouldAdmit.length === 1, "current metadata must replace retained instance shape");
assert(
  changedRoute.wouldAdmit[0].edges[0].tokenIn.toLowerCase() === ASSET_B.toLowerCase(),
  "asset change must admit the new route in the same pass instead of losing the candidate",
);

let rejectedProbeCalls = 0;
const identityRejected = await runProtocolDiscoveryShadow({
  adapters: [adapter({
    async discoverCandidates() { return [candidate(TARGET_A), candidate(TARGET_B)]; },
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
});
assert(identityRejected.wouldAdmit.length === 0, "identity failure must admit zero edges");
assert(rejectedProbeCalls === 0, "identity failure must stop probing");
assert(
  identityRejected.events.every((item) => item.stage === "identity" && item.wouldAdmitEdges === 0),
  "identity null/revert must be fail-closed",
);

const probeRejected = await runProtocolDiscoveryShadow({
  adapters: [adapter({
    async discoverCandidates() { return [candidate(TARGET_A), candidate(TARGET_B)]; },
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
});
assert(probeRejected.wouldAdmit.length === 0, "probe revert/empty must admit zero edges");
assert(
  probeRejected.events.every((item) => item.stage === "probe" && item.wouldAdmitEdges === 0),
  "probe revert/empty must be fail-closed",
);

const malformedEdges = await runProtocolDiscoveryShadow({
  adapters: [adapter({
    async discoverCandidates() {
      return [candidate(TARGET_A), candidate(TARGET_B), candidate(TARGET_C), candidate(TARGET_D)];
    },
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
});
assert(malformedEdges.wouldAdmit.length === 0, "malformed/duplicate routes must admit zero edges");
assert(
  malformedEdges.events.every((item) => item.stage === "probe" && item.wouldAdmitEdges === 0),
  "foreign target/adapter, bad taxonomy, and duplicate routes must fail closed",
);
assert(ordinaryBuildEdgesCalls === 0, "shadow probe results must not be re-expanded by buildEdges");

const incomplete = await runProtocolDiscoveryShadow({
  adapters: [adapter({
    async discoverCandidates() { throw new Error("rpc range failed"); },
    async probeCandidate() { return []; },
  })],
  context,
  protocolEdgesEnabled: true,
  async attestIdentity() { return null; },
});
assert(!incomplete.sourceComplete, "candidate-source failure must prevent scan cursor advancement");

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

console.log("protocol-instance-discovery PASS");
