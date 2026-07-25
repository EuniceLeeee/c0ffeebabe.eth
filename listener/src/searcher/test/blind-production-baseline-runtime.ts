import {
  blindProductionAuditHash,
  blindProductionCanonicalJson,
  blindProductionDeepSeal,
  blindProductionStageArtifactSha256,
  BLIND_PRODUCTION_RAW_PROFILE,
  BLIND_PRODUCTION_STAGE_NAMES,
  type BlindProductionStageEvidence,
  type BlindProductionStageSealInput,
} from "../blind-production-audit.js";
import {
  appendBlindBaselineStageEvidence,
  collectBlindBaselinePricingCoverage,
  completeBlindBaselineStageEvidence,
  createBlindBaselinePassRecord,
  createBlindBaselinePreparedArtifacts,
  createBlindBaselineSemanticEvidence,
  createBlindBaselineSourceDelta,
  createBlindBaselineStaticArtifacts,
  createMutableBlindOpportunityEvidence,
  evaluateBlindAuditOnly,
  resolveBlindProductionAuditMode,
} from "../blind-production-baseline-runtime.js";
import {
  naturalBlockScanSelectionProvenance,
} from "../detector/blockscan-scanner.js";
import type { BlockScanOpportunity } from "../detector/detector.js";
import type {
  PoolEntry,
  TokenEdge,
} from "../planner/token-graph.js";
import { PoolStateCache } from "../solver/pool-state-cache.js";
import { deriveEdgeTaxonomy } from "../strategy-taxonomy.js";
import { PRODUCTION_ROUTE_ADAPTERS } from "../venues/production-registry.js";

const TOKEN_A = "0x0000000000000000000000000000000000000001";
const TOKEN_B = "0x0000000000000000000000000000000000000002";
const POOL = "0x0000000000000000000000000000000000000010";
const BASE = {
  number: 100,
  hash: `0x${"11".repeat(32)}`,
  stateRoot: `0x${"22".repeat(32)}`,
};
const SOURCE = {
  number: 101,
  hash: `0x${"33".repeat(32)}`,
  stateRoot: `0x${"44".repeat(32)}`,
};
const PREPARE = {
  type: "prepare",
  profile: BLIND_PRODUCTION_RAW_PROFILE,
  attemptNonce: "55".repeat(32),
  base: BASE,
} as const;
const SOURCE_CONTROL = {
  type: "source_head",
  profile: BLIND_PRODUCTION_RAW_PROFILE,
  attemptNonce: PREPARE.attemptNonce,
  source: SOURCE,
} as const;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`FAIL: ${message}`);
}

function main(): void {
  auditModeResolutionIsFailClosedAndLazy();
  const edge = (
    tokenIn: string,
    tokenOut: string,
  ): TokenEdge => ({
    adapterId: "univ2-swap",
    target: POOL,
    tokenIn,
    tokenOut,
    slotKind: "swap",
    ...deriveEdgeTaxonomy("swap"),
  });
  const edges = [edge(TOKEN_A, TOKEN_B), edge(TOKEN_B, TOKEN_A)];
  const pools: PoolEntry[] = [{
    address: POOL,
    adapter: "univ2",
    token0: TOKEN_A,
    token1: TOKEN_B,
  }];
  const staticArtifacts = createBlindBaselineStaticArtifacts({
    effectiveConfig: { blockscan: true, dryRun: true },
    productionPools: pools,
    configuredUniverseContentSha256: blindProductionAuditHash(pools),
    universeGeneratedAt: null,
    selectedUniverse: pools,
    strategyViewVersion: blindProductionAuditHash(edges),
    registry: PRODUCTION_ROUTE_ADAPTERS,
    legacyRouteEdges: [{
      edgeAdapterId: "fluid-dex-swap",
      poolAdapters: ["fluid-dex"],
      slotKind: "swap",
      reason: "test legacy ownership",
    }],
  });
  const manifestFamilies =
    staticArtifacts.activeFamilyManifest.payload.families as Array<{
      familyId: string;
    }>;
  assert(
    manifestFamilies.some(
      (family) => family.familyId === "legacy:fluid-dex-swap",
    ),
    "active manifest preserves legacy production ownership",
  );
  const prepared = createBlindBaselinePreparedArtifacts({
    base: BASE,
    edges,
    ...staticArtifacts,
    registry: PRODUCTION_ROUTE_ADAPTERS,
  });
  const sourceDelta = createBlindBaselineSourceDelta({
    source: SOURCE,
    edges,
    base: prepared,
    registry: PRODUCTION_ROUTE_ADAPTERS,
  });
  assert(
    sourceDelta.payload.anchorNumber === SOURCE.number,
    "source delta is anchored at source N",
  );
  assert(
    sourceDelta.payload.completenessWatermark === BASE.number,
    "legacy source delta remains honestly complete only through N-1",
  );
  assert(
    sourceDelta.payload.addedEdgeCount === 0 &&
      sourceDelta.payload.removedEdgeCount === 0,
    "unchanged legacy graph emits an empty delta",
  );

  const cache = new PoolStateCache();
  cache.seedV2({
    pool: POOL,
    token0: TOKEN_A,
    token1: TOKEN_B,
    reserve0: 1_000_000n,
    reserve1: 2_000_000n,
    feeBps: 30n,
    blockNumber: SOURCE.number,
  });
  const coverage = collectBlindBaselinePricingCoverage({
    edges,
    blockNumber: SOURCE.number,
    cache,
    protocolMids: new Map(),
    registry: PRODUCTION_ROUTE_ADAPTERS,
  });
  assert(
    coverage.expectedStateKeys.length === 1 &&
      coverage.resolvedStateKeys.length === 1,
    "two V2 directions share one resolved state key",
  );
  assert(
    coverage.expectedPricedEdgeIds.length === 2 &&
      coverage.resolvedPricedEdgeIds.length === 2,
    "both V2 edge directions are priced",
  );
  assert(
    coverage.incompleteFamilyIds.length === 0,
    "resolved V2 state has no incomplete family",
  );
  const legacyEdge: TokenEdge = {
    ...edge(TOKEN_A, TOKEN_B),
    adapterId: "fluid-dex-swap",
  };
  const legacyMidKey = [
    legacyEdge.target.toLowerCase(),
    legacyEdge.tokenIn.toLowerCase(),
    legacyEdge.tokenOut.toLowerCase(),
  ].join(":");
  const legacyCoverage = collectBlindBaselinePricingCoverage({
    edges: [legacyEdge],
    blockNumber: SOURCE.number,
    cache,
    protocolMids: new Map([[
      legacyMidKey,
      { mid: 2, feeBps: 0, depthIn: 1_000n },
    ]]),
    registry: PRODUCTION_ROUTE_ADAPTERS,
  });
  assert(
    legacyCoverage.expectedStateKeys.length === 1 &&
      legacyCoverage.resolvedStateKeys.length === 1 &&
      legacyCoverage.incompleteFamilyIds.length === 0,
    "legacy external-mid edges cannot disappear from coverage",
  );
  const compatibilityCoverage = collectBlindBaselinePricingCoverage({
    edges: [{
      ...legacyEdge,
      adapterId: "fluid-vault",
      slotKind: "lend",
      ...deriveEdgeTaxonomy("lend"),
    }],
    blockNumber: SOURCE.number,
    cache,
    protocolMids: new Map(),
    registry: PRODUCTION_ROUTE_ADAPTERS,
  });
  assert(
    compatibilityCoverage.expectedStateKeys.length === 0,
    "registered no-mid compatibility edges stay outside coarse pricing",
  );

  const opportunity: BlockScanOpportunity = {
    kind: "block-scan-arb",
    sourceBlock: SOURCE.number,
    stateBlock: SOURCE.number,
    cycleId: "cycle",
    cycleFingerprint: blindProductionAuditHash(edges),
    seedEdges: edges,
    flashToken: TOKEN_A,
    searchSeed: {
      startToken: TOKEN_A,
      searchCenter: 1n,
      maxInput: 2n,
    },
    leavesStandingPosition: false,
  };
  const evidence = createMutableBlindOpportunityEvidence(
    opportunity,
    1,
    PRODUCTION_ROUTE_ADAPTERS,
    false,
  );
  assert(
    evidence.simulation.calldataSha256 ===
      "e3b0c44298fc1c149afbf4c8996fb924" +
        "27ae41e4649b934ca495991b7852b855",
    "not-run simulation hashes empty calldata bytes",
  );
  const stableSemanticEvidence = ():
    BlindProductionStageSealInput =>
    blindProductionDeepSeal(
      createBlindBaselineSemanticEvidence({
        graph: edges,
        pricingCoverage: coverage,
        opportunities: [evidence],
      }),
    );
  let stages: readonly BlindProductionStageEvidence[] = [];
  const stateSemantic = stableSemanticEvidence();
  stages = appendBlindBaselineStageEvidence({
    stages,
    name: "state_ready",
    status: "pass",
    cumulativeMs: 1,
    semanticEvidence: stateSemantic,
  });
  const enumerationSemantic = stableSemanticEvidence();
  stages = appendBlindBaselineStageEvidence({
    stages,
    name: "enumeration_done",
    status: "pass",
    cumulativeMs: 2,
    semanticEvidence: enumerationSemantic,
  });
  const enumerationArtifactJson =
    blindProductionCanonicalJson(stages[1]!.artifact);
  const enumerationArtifactSha256 = stages[1]!.artifactSha256;

  evidence.refined = true;
  stages = appendBlindBaselineStageEvidence({
    stages,
    name: "exact_refine_done",
    status: "pass",
    cumulativeMs: 3,
    semanticEvidence: stableSemanticEvidence(),
  });
  evidence.planCount = 1;
  stages = appendBlindBaselineStageEvidence({
    stages,
    name: "planner_solver_done",
    status: "pass",
    cumulativeMs: 4,
    semanticEvidence: stableSemanticEvidence(),
  });
  evidence.simulation = {
    executed: true,
    success: false,
    profitRaw: "0",
    gasUsed: "21000",
    calldataSha256: blindProductionAuditHash("final-calldata"),
    standingPosition: false,
  };
  stages = appendBlindBaselineStageEvidence({
    stages,
    name: "final_sim_done",
    status: "fail",
    cumulativeMs: 4,
    semanticEvidence: stableSemanticEvidence(),
  });
  evidence.ev = {
    executionStatus: "pass",
    decision: "reject",
    reason: "below_ev_gate",
  };
  const finalSemantic = stableSemanticEvidence();
  stages = appendBlindBaselineStageEvidence({
    stages,
    name: "ev_decision",
    status: "fail",
    cumulativeMs: 4,
    semanticEvidence: finalSemantic,
  });
  assert(
    blindProductionCanonicalJson(stages[1]!.artifact) ===
      enumerationArtifactJson &&
      stages[1]!.artifactSha256 === enumerationArtifactSha256,
    "late refine/plan/sim/EV mutation cannot rewrite enumeration artifact",
  );
  assert(
    Object.isFrozen(stages[1]!.artifact),
    "boundary artifact is deeply sealed",
  );
  for (let index = 0; index < stages.length; index += 1) {
    const stage = stages[index]!;
    assert(
      stage.name === BLIND_PRODUCTION_STAGE_NAMES[index],
      `stage ${index} uses the common ordered name`,
    );
    assert(
      stage.artifactSha256 ===
        blindProductionStageArtifactSha256(stage.artifact),
      `stage ${index} hash is reproducible`,
    );
    assert(
      stage.artifact.previousArtifactSha256 ===
        (stages[index - 1]?.artifactSha256 ?? null),
      `stage ${index} links its predecessor`,
    );
  }

  let prefix: readonly BlindProductionStageEvidence[] = [];
  prefix = appendBlindBaselineStageEvidence({
    stages: prefix,
    name: "state_ready",
    status: "pass",
    cumulativeMs: 1,
    semanticEvidence: stateSemantic,
  });
  prefix = appendBlindBaselineStageEvidence({
    stages: prefix,
    name: "enumeration_done",
    status: "pass",
    cumulativeMs: 2,
    semanticEvidence: enumerationSemantic,
  });
  const completed = completeBlindBaselineStageEvidence({
    stages: prefix,
    cumulativeMs: 9,
    semanticEvidence: enumerationSemantic,
  });
  assert(
    completed.map((stage) => stage.status).join(",") ===
      "pass,pass,not_run,not_run,not_run,not_run",
    "only an unexecuted suffix is sealed at pass completion",
  );
  assert(
    completed.map((stage) => stage.cumulativeMs).join(",") ===
      "1,2,9,9,9,9",
    "not-run suffixes share the honest completion boundary",
  );
  const completedRefine = completed[2]!.artifact;
  assert(
    completedRefine.name === "exact_refine_done" &&
      completedRefine.opportunities[0]!.refined === false,
    "not-run suffix uses the last stable boundary, not later mutations",
  );
  for (let index = 1; index < completed.length; index += 1) {
    assert(
      completed[index]!.artifact.previousArtifactSha256 ===
        completed[index - 1]!.artifactSha256,
      `not-run stage ${index} keeps the hash chain`,
    );
  }

  const naturalEntry = Object.freeze({ id: "natural" });
  const injectedEntry = Object.freeze({ id: "injected" });
  const selectionProvenance = naturalBlockScanSelectionProvenance({
    naturallyEnumerated: [naturalEntry],
    selected: [naturalEntry],
    maxCandidates: 20,
  });
  const injectedSelectionProvenance =
    naturalBlockScanSelectionProvenance({
      naturallyEnumerated: [naturalEntry],
      selected: [naturalEntry, injectedEntry],
      maxCandidates: 20,
    });
  assert(
    injectedSelectionProvenance.forcedSelectionCount === 1,
    "selection provenance counts a selected non-natural entry",
  );
  const record = createBlindBaselinePassRecord({
    source: SOURCE_CONTROL,
    base: PREPARE,
    preparedArtifacts: prepared,
    sourceDeltaArtifact: sourceDelta,
    semanticEvidence: finalSemantic,
    stages,
    selectionProvenance,
    dynamicCacheGeneration: 1,
    dynamicCacheReset: true,
    sourceDeltaApplied: false,
    freshReadCount: 1,
    batchCount: 1,
    incompleteFamilyIds: coverage.incompleteFamilyIds,
  });
  assert(
    record.selectionMode === selectionProvenance.selectionMode,
    "selection mode is copied from coarse selection provenance",
  );
  assert(
    record.forcedSelectionCount ===
      selectionProvenance.forcedSelectionCount,
    "forced selection count is copied from coarse selection provenance",
  );
  assert(
    record.telemetry.sourceDeltaApplied === false,
    "legacy source-N topology limitation remains explicit",
  );
  assert(
    record.stages.map((stage) => stage.cumulativeMs).join(",") ===
      "1,2,3,4,4,4",
    "stage timing is monotonic without inventing sequential old-main stages",
  );
  console.log("[blind-production-baseline-runtime] PASS");
}

function auditModeResolutionIsFailClosedAndLazy(): void {
  const evidence = { calls: 0 };
  const evidenceCallCount = (): number => evidence.calls;
  const disabledEvidence = evaluateBlindAuditOnly(false, () => {
    evidence.calls++;
    throw new Error("audit-off evidence producer must not run");
  });
  assert(disabledEvidence === null, "audit-off evidence is absent");
  assert(evidenceCallCount() === 0, "audit-off evidence producer remains lazy");
  assert(
    evaluateBlindAuditOnly(true, () => {
      evidence.calls++;
      return "sealed";
    }) === "sealed" && evidenceCallCount() === 1,
    "audit-on evidence producer runs exactly once",
  );

  let loaded = false;
  const disabled = resolveBlindProductionAuditMode({
    initialValue: undefined,
    loadEnvironment: () => {
      loaded = true;
    },
    effectiveValue: () => undefined,
  });
  assert(loaded && !disabled, "normal mode loads .env exactly once");

  let dotenvValue: string | undefined;
  let dotenvRejected = false;
  try {
    resolveBlindProductionAuditMode({
      initialValue: undefined,
      loadEnvironment: () => {
        dotenvValue = "1";
      },
      effectiveValue: () => dotenvValue,
    });
  } catch (error) {
    dotenvRejected =
      error instanceof Error &&
      error.message.includes("process environment, not .env");
  }
  assert(
    dotenvRejected,
    "a .env-only audit flag is rejected before a hybrid runtime can start",
  );

  let auditLoadAttempted = false;
  const enabled = resolveBlindProductionAuditMode({
    initialValue: "1",
    loadEnvironment: () => {
      auditLoadAttempted = true;
    },
    effectiveValue: () => "1",
  });
  assert(
    enabled && !auditLoadAttempted,
    "explicit audit mode never loads production .env secrets",
  );
}

main();
