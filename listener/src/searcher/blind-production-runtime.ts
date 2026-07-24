import { createInterface } from "node:readline";
import type { PoolEntry } from "./planner/token-graph.js";
import type { VerifiedGraphView } from "./venues/blockscan-state-capability.js";
import type { AdapterFamily } from "./venues/route-leg-adapter.js";
import type { AdapterRuntimeSnapshot } from "./adapter-runtime-coordinator.js";
import type {
  BlockScanStageBoundary,
} from "./blockscan-pass-timeline.js";
import {
  blindProductionAuditHash,
  blindProductionDeepSeal,
  BLIND_PRODUCTION_CONTROL_PREFIX,
  BLIND_PRODUCTION_RAW_PROFILE,
  BLIND_PRODUCTION_STAGE_NAMES,
  sealBlindProductionStageArtifact,
  validateBlindProductionControl,
  type BlindProductionGraphEvidence,
  type BlindProductionOpportunityEvidence,
  type BlindProductionPassRecord,
  type BlindProductionPrepareControl,
  type BlindProductionPricingCoverageEvidence,
  type BlindProductionSourceHeadControl,
  type BlindProductionStageEvidence,
  type BlindProductionStageName,
  type BlindProductionStageSealInput,
} from "./blind-production-audit.js";
import {
  blindProductionArtifactPayloadHash,
  blindProductionArtifactReceipt,
  createBlindProductionArtifact,
  type BlindProductionArtifact,
  type BlindProductionArtifactReceipts,
} from "./blind-production-artifacts.js";
import {
  blindCompatibilityActiveFamilyManifestPayload,
  blindCompatibilityCanonicalEdgeId,
  blindCompatibilityGraphArtifactPayload,
  blindCompatibilityPricingCoverage,
} from "./blind-production-compatibility.js";

/**
 * Build the immutable graph evidence payload used by the blind production
 * harness. Keeping this outside main makes the harness contract reusable
 * without giving it access to mutable searcher runtime state.
 */
export function blindGraphArtifactPayload(
  graph: VerifiedGraphView,
  coverageAnchor?: {
    readonly number: number;
    readonly hash: string;
  },
): Readonly<Record<string, unknown>> {
  return blindCompatibilityGraphArtifactPayload(graph, coverageAnchor);
}

export function normalizeBlindPoolIdentity(pool: PoolEntry): unknown {
  return normalizeBlindArtifactValue({
    ...pool,
    address: pool.address.toLowerCase(),
    token0: pool.token0?.toLowerCase() ?? null,
    token1: pool.token1?.toLowerCase() ?? null,
    fixedTokenIn: pool.fixedTokenIn?.toLowerCase() ?? null,
    fixedTokenOut: pool.fixedTokenOut?.toLowerCase() ?? null,
    currency0: pool.currency0?.toLowerCase() ?? null,
    currency1: pool.currency1?.toLowerCase() ?? null,
    receiptEmitters: pool.receiptEmitters?.map((address) =>
      address.toLowerCase()
    ) ?? [],
    underlyingCoins: pool.underlyingCoins?.map((address) =>
      address.toLowerCase()
    ) ?? [],
  });
}

export function blindResolvedRuntimeEnvironment(
  env: NodeJS.ProcessEnv,
): Readonly<Record<string, unknown>> {
  const values: Record<string, string> = {};
  const redactedBindings: Array<{
    readonly nameSha256: string;
    readonly valueSha256: string;
  }> = [];
  for (const [name, value] of Object.entries(env).sort(([a], [b]) =>
    a.localeCompare(b)
  )) {
    if (
      !value ||
      (!name.startsWith("SEARCHER_") &&
        !name.startsWith("MEV_LIVE_") &&
        !name.startsWith("BLIND_"))
    ) continue;
    if (/(?:expected|target|winner|search_center)/i.test(name)) {
      throw new Error(
        `blind production audit rejects target-specific environment ${name}`,
      );
    }
    // These identify a binary or lease a local transport. They are recorded
    // by the manifest/module/backend bindings, but must not alter the shared
    // semantic config hash used to compare baseline and challenger.
    if (isBlindNonSemanticRuntimeBinding(name)) continue;
    if (
      /(?:private|secret|mnemonic|password|token|key|wallet|rpc|url|endpoint)/i
        .test(name) ||
      /^https?:\/\//i.test(value) ||
      /^0x[0-9a-f]{64}$/i.test(value)
    ) {
      redactedBindings.push({
        nameSha256: blindProductionAuditHash(name),
        valueSha256: blindProductionAuditHash(value),
      });
      continue;
    }
    values[name] = value;
  }
  return {
    values,
    redactedBindings,
  };
}

function isBlindNonSemanticRuntimeBinding(name: string): boolean {
  return name === "SEARCHER_RUNTIME_COMMIT" ||
    name === "SEARCHER_ANVIL_PORT" ||
    name === "SEARCHER_BLOCKSCAN_ANVIL_PORT" ||
    name === "SEARCHER_REVM_SIM_BIN" ||
    name === "BLIND_SOURCE_CONTROL_URL" ||
    /(?:_RPC)?_URL$/.test(name) ||
    /_ENDPOINT$/.test(name) ||
    /_PATH$/.test(name);
}

export function normalizeBlindArtifactValue(value: unknown): unknown {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("blind artifact rejects non-finite config values");
    }
    return value;
  }
  if (Array.isArray(value)) return value.map(normalizeBlindArtifactValue);
  if (value instanceof Set) {
    return [...value].map(normalizeBlindArtifactValue);
  }
  if (value instanceof Map) {
    const entries: Array<[string, unknown]> = [...value.entries()]
      .map(([key, item]): [string, unknown] => [
        String(key),
        normalizeBlindArtifactValue(item),
      ]);
    return Object.fromEntries(
      entries.sort(([a], [b]) => a.localeCompare(b)),
    );
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined && typeof item !== "function")
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, normalizeBlindArtifactValue(item)]),
    );
  }
  throw new Error(`blind artifact rejects ${typeof value} config values`);
}

export function createBlindProductionStaticArtifacts(input: {
  readonly effectiveConfig: Readonly<Record<string, unknown>>;
  readonly productionPools: readonly PoolEntry[];
  readonly configuredUniverseContentSha256: string;
  readonly universeGeneratedAt: string | null;
  readonly selectedUniverse: readonly PoolEntry[];
  readonly strategyViewVersion: string;
  readonly families: readonly AdapterFamily[];
}) {
  const resolvedConfig = createBlindProductionArtifact(
    "resolved-config",
    {
      configLoaderFingerprint: blindProductionAuditHash({
        loader: "main.buildConfig",
        phase: "post-load",
        schema: 1,
      }),
      effectiveConfig: input.effectiveConfig,
      effectiveConfigSha256:
        blindProductionArtifactPayloadHash(input.effectiveConfig),
    },
  );
  const universe = createBlindProductionArtifact(
    "production-universe",
    {
      builderFingerprint: blindProductionAuditHash({
        loader: "pool-universe.loadPoolUniverse+buildStrategyViews",
        schema: 1,
      }),
      contentSha256: blindProductionAuditHash(
        input.productionPools.map(normalizeBlindPoolIdentity),
      ),
      poolCount: input.productionPools.length,
      provenanceSha256: blindProductionAuditHash({
        configuredContent: input.configuredUniverseContentSha256,
        generatedAt: input.universeGeneratedAt,
        selectedUniverse:
          input.selectedUniverse.map(normalizeBlindPoolIdentity),
        strategyViewVersion: input.strategyViewVersion,
      }),
    },
  );
  const activeFamilyManifest = createBlindProductionArtifact(
    "active-family-manifest",
    blindCompatibilityActiveFamilyManifestPayload(input.families),
  );
  return Object.freeze({
    resolvedConfig,
    universe,
    activeFamilyManifest,
  });
}

export interface PreparedBlindProductionArtifacts {
  readonly baseAnchor: BlindProductionPrepareControl["base"];
  readonly baseGraph: BlindProductionArtifact<"base-graph-view">;
  readonly baseOrderedEdgeIds: readonly string[];
  readonly receipts: Omit<BlindProductionArtifactReceipts, "sourceDelta">;
  readonly documents: {
    readonly resolvedConfig: BlindProductionArtifact<"resolved-config">;
    readonly universe: BlindProductionArtifact<"production-universe">;
    readonly activeFamilyManifest:
      BlindProductionArtifact<"active-family-manifest">;
    readonly baseGraphView: BlindProductionArtifact<"base-graph-view">;
  };
}

export interface BlindProductionPricingCoverageSource {
  readonly expectedStateKeys: readonly string[];
  readonly resolvedStateKeys: readonly string[];
  readonly expectedEdgeKeys: readonly string[];
  readonly resolvedEdgeKeys: readonly string[];
}

/**
 * Capture the semantic payload at a real production boundary. The returned
 * value is detached and deeply sealed, so later refine/plan/sim/EV mutation
 * cannot rewrite an earlier stage.
 */
export function createBlindProductionSemanticEvidence(input: {
  readonly graph: VerifiedGraphView;
  readonly pricingCoverage: BlindProductionPricingCoverageSource;
  readonly opportunities: readonly BlindProductionOpportunityEvidence[];
}): BlindProductionStageSealInput {
  const compatibilityCoverage = blindCompatibilityPricingCoverage(
    input.graph,
    input.pricingCoverage,
  );
  const orderedEdgeIds = input.graph.edges.map(
    blindCompatibilityCanonicalEdgeId,
  );
  const expectedStateKeys = blindSortedUnique(
    compatibilityCoverage.expectedStateKeys,
  );
  const resolvedStateKeys = blindSortedUnique(
    compatibilityCoverage.resolvedStateKeys,
  );
  const expectedPricedEdgeIds = blindSortedUnique(
    compatibilityCoverage.expectedEdgeKeys,
  );
  const resolvedPricedEdgeIds = blindSortedUnique(
    compatibilityCoverage.resolvedEdgeKeys,
  );
  const graph: BlindProductionGraphEvidence = {
    orderedEdgeIds,
    orderedEdgeHash: blindProductionAuditHash(orderedEdgeIds),
  };
  const pricingCoverage: BlindProductionPricingCoverageEvidence = {
    expectedStateKeys,
    resolvedStateKeys,
    expectedStateKeyHash: blindProductionAuditHash(expectedStateKeys),
    resolvedStateKeyHash: blindProductionAuditHash(resolvedStateKeys),
    expectedPricedEdgeIds,
    resolvedPricedEdgeIds,
    expectedPricedEdgeHash: blindProductionAuditHash(expectedPricedEdgeIds),
    resolvedPricedEdgeHash: blindProductionAuditHash(resolvedPricedEdgeIds),
  };
  return blindProductionDeepSeal({
    graph,
    pricingCoverage,
    opportunities: [...input.opportunities].sort((a, b) => a.rank - b.rank),
  });
}

export function appendBlindProductionStageEvidence(input: {
  readonly stages: readonly BlindProductionStageEvidence[];
  readonly name: BlindProductionStageName;
  readonly boundary: BlockScanStageBoundary;
  readonly semanticEvidence: BlindProductionStageSealInput;
}): readonly BlindProductionStageEvidence[] {
  const expectedName = BLIND_PRODUCTION_STAGE_NAMES[input.stages.length];
  if (!expectedName || input.name !== expectedName) {
    throw new Error(
      `blind production stage order expected=${expectedName ?? "complete"} ` +
        `actual=${input.name}`,
    );
  }
  const previous = input.stages.at(-1);
  const priorCumulativeMs = previous?.cumulativeMs ?? 0;
  const stageMs = Math.max(0, input.boundary.stage_ms);
  const cumulativeMs = Math.max(
    priorCumulativeMs + stageMs,
    input.boundary.cumulative_ms ?? priorCumulativeMs,
  );
  const sealed = sealBlindProductionStageArtifact(
    input.name,
    previous?.artifactSha256 ?? null,
    input.semanticEvidence,
  );
  const stage: BlindProductionStageEvidence = Object.freeze({
    name: input.name,
    status: input.boundary.status === "ran"
      ? "pass"
      : input.boundary.status === "failed"
        ? "fail"
        : "not_run",
    artifact: sealed.artifact,
    artifactSha256: sealed.artifactSha256,
    stageMs,
    cumulativeMs,
  });
  return Object.freeze([...input.stages, stage]);
}

export function completeBlindProductionStageEvidence(input: {
  readonly stages: readonly BlindProductionStageEvidence[];
  readonly completionCumulativeMs: number;
  readonly semanticEvidence: BlindProductionStageSealInput;
}): readonly BlindProductionStageEvidence[] {
  let stages = input.stages;
  while (stages.length < BLIND_PRODUCTION_STAGE_NAMES.length) {
    stages = appendBlindProductionStageEvidence({
      stages,
      name: BLIND_PRODUCTION_STAGE_NAMES[stages.length]!,
      boundary: {
        status: "not-run",
        started_at_ms: null,
        finished_at_ms: null,
        stage_ms: 0,
        cumulative_ms: input.completionCumulativeMs,
      },
      semanticEvidence: input.semanticEvidence,
    });
  }
  return stages;
}

export function createBlindProductionPassRecord(input: {
  readonly source: BlindProductionSourceHeadControl;
  readonly base: BlindProductionPrepareControl;
  readonly preparedArtifacts: PreparedBlindProductionArtifacts;
  readonly sourceDeltaArtifact: BlindProductionArtifact<"source-delta">;
  readonly runtime: AdapterRuntimeSnapshot | null;
  readonly generationFallback: number;
  readonly dynamicResetNonce: string | null;
  readonly selectionMode: "production";
  readonly forcedSelectionCount: number;
  readonly stages: readonly BlindProductionStageEvidence[];
}): BlindProductionPassRecord {
  if (input.stages.length !== BLIND_PRODUCTION_STAGE_NAMES.length) {
    throw new Error("blind production pass requires six sealed stages");
  }
  for (let index = 0; index < input.stages.length; index += 1) {
    if (input.stages[index]!.name !== BLIND_PRODUCTION_STAGE_NAMES[index]) {
      throw new Error("blind production pass stage order");
    }
  }
  const stateArtifact = input.stages[0]!.artifact;
  const evArtifact = input.stages[5]!.artifact;
  if (
    stateArtifact.name !== "state_ready" ||
    evArtifact.name !== "ev_decision"
  ) {
    throw new Error("blind production pass stage projection");
  }
  const graph = stateArtifact.graph;
  const pricingCoverage = stateArtifact.pricingCoverage;
  const opportunities = evArtifact.opportunities;
  if (
    !Number.isSafeInteger(input.forcedSelectionCount) ||
    input.forcedSelectionCount < 0 ||
    input.forcedSelectionCount > opportunities.length
  ) {
    throw new Error("blind production forced selection count");
  }
  const pricing = input.runtime?.pricing;
  return Object.freeze({
    type: "pass",
    profile: BLIND_PRODUCTION_RAW_PROFILE,
    attemptNonce: input.source.attemptNonce,
    base: input.base.base,
    source: input.source.source,
    artifacts: {
      ...input.preparedArtifacts.receipts,
      sourceDelta:
        blindProductionArtifactReceipt(input.sourceDeltaArtifact),
    },
    artifactDocuments: {
      ...input.preparedArtifacts.documents,
      sourceDelta: input.sourceDeltaArtifact,
    },
    selectionMode: input.selectionMode,
    forcedSelectionCount: input.forcedSelectionCount,
    stages: Object.freeze([...input.stages]),
    graph,
    pricingCoverage,
    telemetry: {
      dynamicCacheGeneration: input.runtime?.generation ??
        input.generationFallback,
      dynamicCacheReset:
        input.dynamicResetNonce === input.source.attemptNonce,
      sourceDeltaApplied:
        input.runtime?.sourceBlock === input.source.source.number &&
        input.runtime.sourceBlockHash.toLowerCase() ===
          input.source.source.hash.toLowerCase(),
      freshReadCount: pricing?.laneTelemetry.reduce(
        (sum, lane) => sum + lane.reads,
        0,
      ) ?? 0,
      batchCount: pricing?.laneTelemetry.reduce(
        (sum, lane) => sum + lane.batches,
        0,
      ) ?? 0,
      incompleteFamilyIds: pricing?.incompleteFamilyIds ?? [],
    },
    opportunities,
  });
}

function blindSortedUnique(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort();
}

export function installBlindProductionControlInput(input: {
  readonly stream: NodeJS.ReadableStream;
  readonly prepare: (control: BlindProductionPrepareControl) => Promise<void>;
  readonly sourceHead: (
    control: BlindProductionSourceHeadControl,
  ) => Promise<void>;
}): void {
  let queue: Promise<void> = Promise.resolve();
  createInterface({ input: input.stream }).on("line", (line) => {
    if (!line.startsWith(BLIND_PRODUCTION_CONTROL_PREFIX)) return;
    queue = queue
      .then(async () => {
        const control = validateBlindProductionControl(JSON.parse(
          line.slice(BLIND_PRODUCTION_CONTROL_PREFIX.length),
        ));
        if (control.type === "prepare") {
          await input.prepare(control);
        } else {
          await input.sourceHead(control);
        }
      })
      .catch((error) => {
        console.error(
          `[searcher/blind-audit] control failed: ` +
            `${error instanceof Error ? error.message : String(error)}`,
        );
      });
  });
}
