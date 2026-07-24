import {
  blindProductionAuditHash,
  blindProductionCanonicalJson,
  blindProductionStageArtifactSha256,
  BLIND_PRODUCTION_RAW_PROFILE,
  type BlindProductionOpportunityEvidence,
  type BlindProductionStageEvidence,
} from "../blind-production-audit.js";
import {
  blindProductionArtifactPayloadHash,
  blindProductionArtifactReceipt,
  createBlindProductionArtifact,
} from "../blind-production-artifacts.js";
import {
  appendBlindProductionStageEvidence,
  blindGraphArtifactPayload,
  completeBlindProductionStageEvidence,
  createBlindProductionPassRecord,
  createBlindProductionSemanticEvidence,
} from "../blind-production-runtime.js";
import {
  blindCompatibilityCanonicalEdgeId,
} from "../blind-production-compatibility.js";
import type { TokenEdge } from "../planner/token-graph.js";
import { deriveEdgeTaxonomy } from "../strategy-taxonomy.js";
import {
  createVerifiedGraphView,
} from "../venues/blockscan-state-capability.js";
import {
  validateProductionPassRecordForFreeze,
} from "./adapter-family-blind-production-raw.js";

const HASH_A = `0x${"11".repeat(32)}`;
const HASH_B = `0x${"22".repeat(32)}`;
const TOKEN_A = "0x0000000000000000000000000000000000000001";
const TOKEN_B = "0x0000000000000000000000000000000000000002";
const POOL = "0x0000000000000000000000000000000000000010";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`FAIL: ${message}`);
}

function boundary(
  status: "ran" | "failed" | "not-run",
  stageMs: number,
  cumulativeMs: number | null,
) {
  return {
    status,
    started_at_ms: status === "not-run" ? null : 1,
    finished_at_ms: status === "not-run" ? null : 1 + stageMs,
    stage_ms: stageMs,
    cumulative_ms: cumulativeMs,
  } as const;
}

function main(): void {
  const edge: TokenEdge = {
    adapterId: "univ2-swap",
    target: POOL,
    tokenIn: TOKEN_A,
    tokenOut: TOKEN_B,
    slotKind: "swap",
    ...deriveEdgeTaxonomy("swap"),
  };
  const graph = createVerifiedGraphView({
    id: "challenger-test",
    generation: 1,
    sourceBlock: 101,
    sourceBlockHash: HASH_B,
    completenessWatermark: 101,
    perSourceCoverage: [{
      familyId: "univ2-standard",
      sourceId: "test",
      sourceFingerprint: blindProductionAuditHash("test-source"),
      completeThroughBlock: 101,
      completeThroughHash: HASH_B,
    }],
    edges: [edge],
    familyIdForEdge: () => "univ2-standard",
  });
  const baseGraphView = createVerifiedGraphView({
    id: "challenger-test-base",
    generation: 0,
    sourceBlock: 100,
    sourceBlockHash: HASH_A,
    completenessWatermark: 100,
    perSourceCoverage: [{
      familyId: "univ2-standard",
      sourceId: "test",
      sourceFingerprint: blindProductionAuditHash("test-source"),
      completeThroughBlock: 100,
      completeThroughHash: HASH_A,
    }],
    edges: [edge],
    familyIdForEdge: () => "univ2-standard",
  });
  const canonicalEdgeId = graph.edges[0]!.canonicalEdgeId!;
  const opportunity: BlindProductionOpportunityEvidence = {
    rank: 1,
    route: [{
      familyId: "univ2-standard",
      adapterId: edge.adapterId,
      target: edge.target,
      tokenIn: edge.tokenIn,
      tokenOut: edge.tokenOut,
      executionVariantKey: "v2",
    }],
    refined: false,
    planCount: 0,
    simulation: {
      executed: false,
      success: false,
      profitRaw: "0",
      gasUsed: "0",
      calldataSha256: blindProductionAuditHash(Buffer.alloc(0).toString()),
      standingPosition: false,
    },
    ev: {
      executionStatus: "not_run",
      decision: "reject",
      reason: "not_refined",
    },
  };
  const pricingCoverage = {
    expectedStateKeys: ["univ2-standard:pool"],
    resolvedStateKeys: ["univ2-standard:pool"],
    expectedEdgeKeys: [canonicalEdgeId],
    resolvedEdgeKeys: [canonicalEdgeId],
  };
  const semantic = () =>
    createBlindProductionSemanticEvidence({
      graph,
      pricingCoverage,
      opportunities: [opportunity],
    });

  let stages: readonly BlindProductionStageEvidence[] = [];
  stages = appendBlindProductionStageEvidence({
    stages,
    name: "state_ready",
    boundary: boundary("ran", 1, 1),
    semanticEvidence: semantic(),
  });
  stages = appendBlindProductionStageEvidence({
    stages,
    name: "enumeration_done",
    boundary: boundary("ran", 1, 2),
    semanticEvidence: semantic(),
  });
  const frozenEnumeration =
    blindProductionCanonicalJson(stages[1]!.artifact);
  const frozenEnumerationHash = stages[1]!.artifactSha256;

  (opportunity as { refined: boolean }).refined = true;
  stages = appendBlindProductionStageEvidence({
    stages,
    name: "exact_refine_done",
    boundary: boundary("ran", 1, 3),
    semanticEvidence: semantic(),
  });
  (opportunity as { planCount: number }).planCount = 2;
  stages = appendBlindProductionStageEvidence({
    stages,
    name: "planner_solver_done",
    boundary: boundary("ran", 1, 4),
    semanticEvidence: semantic(),
  });
  (opportunity as {
    simulation: BlindProductionOpportunityEvidence["simulation"];
  }).simulation = {
    executed: true,
    success: true,
    profitRaw: "7",
    gasUsed: "21000",
    calldataSha256: blindProductionAuditHash("calldata"),
    standingPosition: false,
  };
  (opportunity as { ev: BlindProductionOpportunityEvidence["ev"] }).ev = {
    executionStatus: "pass",
    decision: "allow",
    reason: "positive_ev",
  };
  stages = appendBlindProductionStageEvidence({
    stages,
    name: "final_sim_done",
    boundary: boundary("ran", 2, 6),
    semanticEvidence: semantic(),
  });
  stages = appendBlindProductionStageEvidence({
    stages,
    name: "ev_decision",
    boundary: boundary("ran", 1, 6),
    semanticEvidence: semantic(),
  });

  assert(
    blindProductionCanonicalJson(stages[1]!.artifact) ===
        frozenEnumeration &&
      stages[1]!.artifactSha256 === frozenEnumerationHash,
    "late mutation cannot rewrite enumeration evidence",
  );
  for (let index = 0; index < stages.length; index += 1) {
    const stage = stages[index]!;
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
  const finalSim = stages[4]!.artifact;
  const ev = stages[5]!.artifact;
  assert(
    finalSim.name === "final_sim_done" &&
      !("ev" in finalSim.opportunities[0]!),
    "interleaved execution seals a final-sim-only projection",
  );
  assert(
    ev.name === "ev_decision" &&
      ev.opportunities[0]!.ev.decision === "allow",
    "interleaved execution seals a separate EV projection",
  );

  let failed: readonly BlindProductionStageEvidence[] = [];
  const stableState = semantic();
  failed = appendBlindProductionStageEvidence({
    stages: failed,
    name: "state_ready",
    boundary: boundary("ran", 1, 1),
    semanticEvidence: stableState,
  });
  failed = appendBlindProductionStageEvidence({
    stages: failed,
    name: "enumeration_done",
    boundary: boundary("failed", 2, 3),
    semanticEvidence: stableState,
  });
  failed = completeBlindProductionStageEvidence({
    stages: failed,
    completionCumulativeMs: 9,
    semanticEvidence: stableState,
  });
  assert(
    failed.map((stage) => stage.status).join(",") ===
      "pass,fail,not_run,not_run,not_run,not_run",
    "failed active stage has an unexecuted suffix",
  );
  assert(
    failed.slice(2).every((stage) => stage.cumulativeMs === 9),
    "not-run suffix retains the terminal completion boundary",
  );

  const effectiveConfig = {};
  const resolvedConfig = createBlindProductionArtifact(
    "resolved-config",
    {
      configLoaderFingerprint: blindProductionAuditHash("loader"),
      effectiveConfig,
      effectiveConfigSha256:
        blindProductionArtifactPayloadHash(effectiveConfig),
    },
  );
  const universe = createBlindProductionArtifact("production-universe", {
    builderFingerprint: blindProductionAuditHash("builder"),
    contentSha256: blindProductionAuditHash([]),
    poolCount: 0,
    provenanceSha256: blindProductionAuditHash("provenance"),
  });
  const activeFamilyManifest = createBlindProductionArtifact(
    "active-family-manifest",
    {
      families: [],
      familyCount: 0,
      registryFingerprint: blindProductionAuditHash([]),
    },
  );
  const baseGraph = createBlindProductionArtifact(
    "base-graph-view",
    blindGraphArtifactPayload(baseGraphView),
  );
  const sourceDelta = createBlindProductionArtifact("source-delta", {
    ...blindGraphArtifactPayload(graph, {
      number: 100,
      hash: HASH_A,
    }),
    baseGraphViewSha256: blindProductionArtifactReceipt(baseGraph).sha256,
    addedEdgeCount: 0,
    addedEdgeHash: blindProductionAuditHash([]),
    removedEdgeCount: 0,
    removedEdgeHash: blindProductionAuditHash([]),
  });
  const preparedArtifacts = {
    baseAnchor: {
      number: 100,
      hash: HASH_A,
      stateRoot: HASH_B,
    },
    baseGraph,
    baseOrderedEdgeIds: [
      blindCompatibilityCanonicalEdgeId(baseGraphView.edges[0]!),
    ],
    receipts: {
      resolvedConfig: blindProductionArtifactReceipt(resolvedConfig),
      universe: blindProductionArtifactReceipt(universe),
      activeFamilyManifest:
        blindProductionArtifactReceipt(activeFamilyManifest),
      baseGraphView: blindProductionArtifactReceipt(baseGraph),
    },
    documents: {
      resolvedConfig,
      universe,
      activeFamilyManifest,
      baseGraphView: baseGraph,
    },
  };
  const sourceControl = {
    type: "source_head",
    profile: BLIND_PRODUCTION_RAW_PROFILE,
    attemptNonce: "33".repeat(32),
    source: { number: 101, hash: HASH_B, stateRoot: HASH_A },
  } as const;
  const baseControl = {
    type: "prepare",
    profile: BLIND_PRODUCTION_RAW_PROFILE,
    attemptNonce: "33".repeat(32),
    base: { number: 100, hash: HASH_A, stateRoot: HASH_B },
  } as const;
  const record = createBlindProductionPassRecord({
    source: sourceControl,
    base: baseControl,
    preparedArtifacts,
    sourceDeltaArtifact: sourceDelta,
    runtime: null,
    generationFallback: 1,
    dynamicResetNonce: null,
    selectionMode: "production",
    forcedSelectionCount: 0,
    stages,
  });
  validateProductionPassRecordForFreeze(
    record,
    {
      type: "ready",
      profile: BLIND_PRODUCTION_RAW_PROFILE,
      attemptNonce: baseControl.attemptNonce,
      base: baseControl.base,
      artifacts: preparedArtifacts.receipts,
      artifactDocuments: preparedArtifacts.documents,
    },
    sourceControl,
  );
  const recordedState = stages[0]!.artifact;
  const recordedEv = stages[5]!.artifact;
  assert(
    recordedState.name === "state_ready" &&
      recordedEv.name === "ev_decision",
    "test stages retain their typed projections",
  );
  assert(
    record.graph === recordedState.graph,
    "pass record references the sealed state projection",
  );
  assert(
    record.opportunities === recordedEv.opportunities,
    "pass record references the sealed EV projection",
  );
  console.log("blind production challenger runtime: PASS");
}

main();
