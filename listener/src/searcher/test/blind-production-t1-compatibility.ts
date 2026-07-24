import {
  blindCompatibilityActiveFamilyManifestPayload,
  blindCompatibilityCanonicalEdgeId,
  blindCompatibilityGraphArtifactPayload,
  blindCompatibilityPoolIdentity,
  blindCompatibilityPricingCoverage,
  blindCompatibilityRouteStep,
} from "../blind-production-compatibility.js";
import {
  blindProductionAuditHash,
  blindProductionCanonicalJson,
} from "../blind-production-audit.js";
import type {
  PoolEntry,
  TokenEdge,
} from "../planner/token-graph.js";
import { deriveEdgeTaxonomy } from "../strategy-taxonomy.js";
import {
  createVerifiedGraphView,
} from "../venues/blockscan-state-capability.js";
import {
  PRODUCTION_ADAPTER_FAMILIES,
} from "../venues/production-registry.js";

const HASH = `0x${"11".repeat(32)}`;
const TOKEN_A = "0x0000000000000000000000000000000000000001";
const TOKEN_B = "0x0000000000000000000000000000000000000002";
const POOL = "0x0000000000000000000000000000000000000010";
const T1_EDGE_ID =
  "edge:0100c1ef337990cd0d425a90ec6ceb3e49c0ea9fd5711a3901c0baa93bfe7567";
const T1_REGISTRY_FINGERPRINT =
  "bc4b8fa66d9d0cc66523a26e3f577a9b508dba818bba2749592ac195e0db4def";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`FAIL: ${message}`);
}

function main(): void {
  const edge: TokenEdge = {
    adapterId: "univ2-swap",
    target: POOL,
    tokenIn: TOKEN_A,
    tokenOut: TOKEN_B,
    slotKind: "swap",
    ...deriveEdgeTaxonomy("swap"),
    // This field exists only after T1. It must remain in production identity
    // while the frozen T1 evidence projection excludes it.
    v2FeeBps: 30n,
  };
  const graph = createVerifiedGraphView({
    id: "t1-compatibility",
    generation: 1,
    sourceBlock: 100,
    sourceBlockHash: HASH,
    completenessWatermark: 100,
    perSourceCoverage: [{
      familyId: "univ2-standard",
      sourceId: "new-family-source",
      sourceFingerprint: "new-family-source-v1",
      completeThroughBlock: 100,
      completeThroughHash: HASH,
    }],
    edges: [edge],
    familyIdForEdge: () => "univ2-standard",
  });
  const verifiedEdge = graph.edges[0]!;

  assert(
    blindCompatibilityCanonicalEdgeId(verifiedEdge) === T1_EDGE_ID,
    "challenger edge projects to the frozen T1 canonical ID",
  );
  const graphPayload = blindCompatibilityGraphArtifactPayload(graph);
  assert(
    graphPayload.orderedEdgeHash ===
      "851084b34245d7893fb56b536db70dd30fced7c0aa543220ac26bb4515e8d1da",
    "ordered graph hash matches frozen T1",
  );
  assert(
    graphPayload.metadataHash ===
      "a15df1787d65d38ead7becd0ed14f05ecb546556da67cdaebbb27d2713522b2e",
    "graph metadata hash matches frozen T1 despite richer production fields",
  );
  assert(
    graphPayload.ownershipHash ===
      "cd021530b1883b2e73696b146bde62dc8b249a06ebf5758b07e9ea68e6388111",
    "graph ownership hash matches frozen T1",
  );
  assert(
    graphPayload.perSourceCoverageSha256 ===
      "b5a1a4676e30c50b77a968ef3c854e6a54cd523520e7e8350255c96bca6f47fc",
    "graph source-coverage projection matches frozen T1",
  );

  const currentEdgeKey = verifiedEdge.canonicalEdgeId!;
  const coverage = blindCompatibilityPricingCoverage(graph, {
    expectedEdgeKeys: [currentEdgeKey],
    resolvedEdgeKeys: [currentEdgeKey],
  });
  assert(
    blindProductionCanonicalJson(coverage) ===
      blindProductionCanonicalJson({
        expectedStateKeys: [
          `univ2-standard:mutable-pool:${POOL}`,
        ],
        resolvedStateKeys: [
          `univ2-standard:mutable-pool:${POOL}`,
        ],
        expectedEdgeKeys: [T1_EDGE_ID],
        resolvedEdgeKeys: [T1_EDGE_ID],
      }),
    "current family coverage projects to the frozen T1 state vocabulary",
  );
  const route = blindCompatibilityRouteStep(verifiedEdge);
  assert(
    route.familyId === "univ2-standard" &&
      route.executionVariantKey === T1_EDGE_ID &&
      route.target === POOL,
    "opportunity route uses the frozen T1 family and execution key",
  );

  const manifest = blindCompatibilityActiveFamilyManifestPayload(
    PRODUCTION_ADAPTER_FAMILIES.list(),
  ) as {
    readonly familyCount: number;
    readonly registryFingerprint: string;
  };
  assert(manifest.familyCount === 17, "T1 family count remains frozen");
  assert(
    manifest.registryFingerprint === T1_REGISTRY_FINGERPRINT,
    "challenger family manifest is byte-semantic compatible with T1",
  );

  const richerPool = {
    address: POOL,
    adapter: "erc4626",
    fixedTokenIn: TOKEN_A,
    fixedTokenOut: TOKEN_B,
    discoveryOwnerAdapterId: "protocol:erc4626",
    topologyRetained: true,
    verifiedRoutes: [{
      edgeAdapterId: "erc4626-deposit",
      tokenIn: TOKEN_A,
      tokenOut: TOKEN_B,
      slotKind: "protocol",
      protocolAction: "convert",
      poolToken0: TOKEN_A,
      poolToken1: TOKEN_B,
    }],
  } satisfies PoolEntry & { readonly topologyRetained: true };
  const projectedPool = blindCompatibilityPoolIdentity(richerPool);
  assert(
    blindProductionCanonicalJson(projectedPool) ===
      blindProductionCanonicalJson({
        adapter: "erc4626",
        address: POOL,
        currency0: null,
        currency1: null,
        fixedTokenIn: TOKEN_A,
        fixedTokenOut: TOKEN_B,
        receiptEmitters: [],
        token0: null,
        token1: null,
        underlyingCoins: [],
        verifiedRoutes: [{
          edgeAdapterId: "erc4626-deposit",
          protocolAction: "convert",
          slotKind: "protocol",
          tokenIn: TOKEN_A,
          tokenOut: TOKEN_B,
        }],
      }),
    "post-T1 discovery and execution-order fields stay out of the frozen universe vocabulary",
  );
  assert(
    blindProductionAuditHash([projectedPool]) ===
      "e1a809f854e5d4a973c8765cf75052f65e87312f9571671f506ee0043ef22436",
    "challenger universe content hash matches the independently frozen T1 producer",
  );

  console.log("blind production T1 compatibility tests passed");
}

main();
