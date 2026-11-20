/** Historical Ready-rebuild regression fixture. Never imported by the live entry point. */
import { ethers } from "ethers";
import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { readyRuleCompatibilityFor, createRebuildWiring } from "../universe-rebuild-production.js";
import { liveReadySubsetPriceMode } from "../blockscan-live-continuation.js";
import { activeReadyMemos as sealedReadyMemos, canonicalJson, UniverseRebuildCheckpointStore, type StartupCheckpointEnvelope } from "../universe-rebuild-checkpoint.js";
import { UniverseRunIncomplete, assertReadyFamilyActivation, rebuildUniverse, type RebuildUniverseInput } from "../universe-rebuild-runner.js";
import { resolveStrictReadyRuntime } from "../strict-ready-runtime.js";
import { StrictProductionRuntimeRoot } from "../strict-production-runtime-session.js";
import { StrictReadyGraphViewCoordinator } from "../strict-ready-graph-view.js";
import { resolveProducerBaseline } from "../startup-universe-rebuild.js";
import { PRODUCTION_FAMILY_ACTIVATIONS, PRODUCTION_STRICT_SHADOW_FAMILY_LOAD, PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG } from "../venues/production-family-composition.js";
import type { TokenEdge } from "../planner/token-graph.js";
import type { PreparedFamilyInstance } from "../venues/adapter-family-runtime.js";

/** Ready reuse reviews the complete current inputs at the sealed parent's
 * historical source. Progress changes neither that input nor its time range. */
export function readyStartupReviewPlan(
  checkpoint: Pick<StartupCheckpointEnvelope, "readyGeneration" | "inProgressRun"> | null,
  requestedRunId?: string,
) {
  const ready = checkpoint?.readyGeneration;
  if (!ready) throw new Error("Ready reuse requires one complete Ready checkpoint");
  const pending = checkpoint!.inProgressRun;
  if (ready.universeRange.toBlock !== ready.cutoff.number ||
      (pending && (pending.fromBlock !== ready.universeRange.fromBlock ||
        canonicalJson(pending.cutoff) !== canonicalJson(ready.cutoff)))) {
    throw new Error("Ready reuse must resume the sealed parent source and range");
  }
  return Object.freeze({
    runId: pending?.runId ?? requestedRunId ?? "strict-startup-ready-review",
    cutoff: Object.freeze({ ...ready.cutoff }),
    observationRange: Object.freeze({ ...ready.universeRange }),
    resumeCompletedOutcomes: pending !== null,
  });
}

/** The launcher seals its activation preflight output; ordinary Ready updates have no seal. */
export function readPreparedReadySeal(env: NodeJS.ProcessEnv) {
  const generation = env.SEARCHER_PREPARED_READY_GENERATION;
  const sha256 = env.SEARCHER_PREPARED_READY_SHA256;
  if (generation === undefined && sha256 === undefined) return undefined;
  if (!generation || !/^[1-9][0-9]*$/.test(generation) ||
      !Number.isSafeInteger(Number(generation)) || !sha256 || !/^[a-f0-9]{64}$/.test(sha256)) {
    throw new Error("prepared Ready requires a generation and checkpoint SHA256");
  }
  return Object.freeze({ generation: Number(generation), sha256 });
}

/** Keep checkpoint ownership inside startup; producers retain only runtime projections. */
export async function initializeReadyProducer({
  universeRebuildCheckpointPath, rpcUrl, startupCandidates, executionIdentity,
  onSimulationFatal, blindUseIncumbentReady, useReadyGeneration, currentHead,
  boundedLiveReadyResume = false, preparedReady,
}: {
  readonly universeRebuildCheckpointPath: string;
  readonly rpcUrl: string;
  readonly startupCandidates: NonNullable<Parameters<typeof createRebuildWiring>[0]>["startupCandidates"];
  readonly executionIdentity: NonNullable<Parameters<typeof createRebuildWiring>[0]>["executionIdentity"];
  readonly onSimulationFatal: NonNullable<Parameters<typeof createRebuildWiring>[0]>["onSimulationFatal"];
  readonly blindUseIncumbentReady: boolean;
  readonly useReadyGeneration: boolean;
  readonly currentHead: number;
  readonly boundedLiveReadyResume?: boolean;
  readonly preparedReady?: ReturnType<typeof readPreparedReadySeal>;
}) {
  const subsetPriceMode = liveReadySubsetPriceMode(process.env);
  const liveSubset = subsetPriceMode !== undefined;
  const drySubset = process.env.SEARCHER_DRY_RUN === "1" && process.env.SEARCHER_BLOCKSCAN_SUBMIT === "0";
  const liveResume = boundedLiveReadyResume && subsetPriceMode === "resume" &&
    process.env.SEARCHER_DRY_RUN === "0" && process.env.SEARCHER_BLOCKSCAN_SUBMIT === "1";
  if (liveSubset && (!useReadyGeneration || blindUseIncumbentReady ||
      (!drySubset && !liveResume) ||
      process.env.SEARCHER_ENABLE_BACKRUN !== "0" || process.env.SEARCHER_ENABLE_MEMPOOL !== "0")) {
    throw new Error("Ready subset requires a sealed dry-run or a bounded live resume");
  }
  if (preparedReady) {
    if (!useReadyGeneration || blindUseIncumbentReady) {
      throw new Error("prepared Ready requires explicit Ready consumption");
    }
    if (existsSync(universeRebuildCheckpointPath + ".attestation-journal")) {
      throw new Error("prepared Ready cannot consume an unsealed attestation journal");
    }
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(universeRebuildCheckpointPath)) hash.update(chunk);
    if (hash.digest("hex") !== preparedReady.sha256) throw new Error("prepared Ready checkpoint hash changed");
  }
  const rebuildStore = new UniverseRebuildCheckpointStore({
    path: universeRebuildCheckpointPath,
  });
  let rebuildEnvelope = await rebuildStore.load();
  const selectorCensus = rebuildEnvelope?.inProgressRun?.selectorCensus ?? rebuildEnvelope?.readyGeneration?.selectorCoverage?.transactions;
  const rebuildWiring = createRebuildWiring({
    ruleCompatibility: await readyRuleCompatibilityFor(rebuildEnvelope?.readyGeneration?.ruleBindings),
    rpcUrl,
    ...(selectorCensus === undefined ? { startupCandidates } : { selectorCensus }),
    executionIdentity,
    onSimulationFatal,
  });
  let readyUniverse;
  if (blindUseIncumbentReady || liveSubset || preparedReady) {
    if (
      rebuildEnvelope === null ||
      rebuildEnvelope.readyGeneration === null ||
      rebuildEnvelope.inProgressRun !== null
    ) {
      throw new Error(
        (blindUseIncumbentReady ? "blind replay" : "Ready reuse") +
          " requires one complete Ready checkpoint",
      );
    }
    readyUniverse = rebuildEnvelope.readyGeneration;
  } else {
    let options: Pick<RebuildUniverseInput, "runId" | "observationRange" | "observationWindowBlocks" |
      "resumeCompletedOutcomes"> & Partial<Pick<RebuildUniverseInput, "freezeCanonicalHead">>;
    if (useReadyGeneration || selectorCensus !== undefined) {
      const { cutoff, ...reviewPlan } = readyStartupReviewPlan(rebuildEnvelope,
        process.env.SEARCHER_UNIVERSE_REBUILD_RUN_ID);
      options = { ...reviewPlan, freezeCanonicalHead: async (requestedBlock) => {
        if (requestedBlock !== cutoff.number) throw new Error("Ready reuse cannot move its sealed cutoff");
        await rebuildWiring.assertCanonicalHead(cutoff);
        return cutoff;
      } };
    } else {
      options = {
        runId: process.env.SEARCHER_UNIVERSE_REBUILD_RUN_ID ?? "strict-startup-rebuild",
        ...(process.env.SEARCHER_UNIVERSE_REBUILD_WINDOW_BLOCKS === undefined ? {} : {
          observationWindowBlocks: Number(process.env.SEARCHER_UNIVERSE_REBUILD_WINDOW_BLOCKS),
        }),
      };
    }
    try {
      readyUniverse = await rebuildUniverse({
        ...rebuildWiring,
        store: rebuildStore,
        ...options,
        log: (message) => console.log("[searcher/startup] " + message),
      });
    } catch (error) {
      if (error instanceof UniverseRunIncomplete) {
        throw new Error(
          "strict startup rebuild incomplete: run=" + error.runId +
            " remainingUnaccounted=" + error.remainingUnaccounted +
            " (resume the durable run before producer start)",
        );
      }
      throw error;
    }
    rebuildEnvelope = await rebuildStore.load();
  }
  if (
    rebuildEnvelope === null ||
    rebuildEnvelope.readyGeneration === null ||
    rebuildEnvelope.readyGeneration.generation !== readyUniverse.generation
  ) {
    throw new Error("strict startup readyGeneration failed root verification");
  }
  if (preparedReady) {
    if (readyUniverse.generation !== preparedReady.generation) throw new Error("prepared Ready generation changed");
    await rebuildWiring.assertCanonicalHead(readyUniverse.cutoff);
    const coverage = new Set(readyUniverse.sourceCoverage.map(row => row.familyId + "|" + row.sourceId));
    if (!rebuildWiring.requiredSourceCoverageKeys().every(key => coverage.has(key))) {
      throw new Error("prepared Ready lacks active Family source coverage; update Ready first");
    }
  }
  if (blindUseIncumbentReady || useReadyGeneration) {
    console.log(
      "[searcher/startup] " +
        (blindUseIncumbentReady ? "blind replay" : liveSubset ? "Ready subset" : preparedReady ? "Prepared Ready" : "Ready input review") +
        " uses readyGeneration=" +
        readyUniverse.generation + " cutoff=" + readyUniverse.cutoff.number +
        " activeInstances=" + readyUniverse.activeInstanceKeys.length +
        " retryableQueue=" +
        Object.keys(rebuildEnvelope.retryableAttemptsByCandidateKey).length,
    );
  }
  const strictReadyRuntime = resolveStrictReadyRuntime(readyUniverse);
  const liveFamilyIds = liveSubset
    ? PRODUCTION_FAMILY_ACTIVATIONS.filter(row => row.enabled && rebuildWiring.isFamilyEnabled?.(String(row.familyId)) !== false).map(row => String(row.familyId)).sort()
    : undefined;
  const liveIds = liveFamilyIds && new Set(liveFamilyIds);
  if (liveFamilyIds) {
    if (!readyUniverse.familyPartitions || liveFamilyIds.some(id => !readyUniverse.familyPartitions![id]?.enabled)) {
      throw new Error("live Family selection lacks a sealed Ready partition; update Ready first");
    }
    await rebuildWiring.assertCanonicalHead(readyUniverse.cutoff);
  }
  // The sealed catalog identifies the exact verified memo for each instance.
  // Historical aliases in the checkpoint cache can share that instance key.
  const sealedMemos = sealedReadyMemos(rebuildEnvelope);
  const activeReadyMemos = liveIds
    ? sealedMemos.filter(memo => liveIds.has(memo.familyId))
    : sealedMemos;
  if ((liveIds || preparedReady) && activeReadyMemos.some(memo => !rebuildWiring.isReadyMemoDefinitionCurrent!(memo))) {
    throw new Error("retained live Family proof changed; update Ready before resuming");
  }
  assertReadyFamilyActivation(activeReadyMemos, rebuildWiring.isFamilyEnabled);
  const routeReadyMemos = activeReadyMemos.filter((memo) =>
    PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG
      .forStrictFamily(memo.familyId as never).plugin.manifest.domain !==
        "funding"
  );
  const fundingReadyMemos = activeReadyMemos.filter((memo) =>
    PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG
      .forStrictFamily(memo.familyId as never).plugin.manifest.domain ===
        "funding"
  );
  const readyInstances = routeReadyMemos
    .map((memo) => rebuildWiring.rehydrateVerifiedInstance({
      memo,
      cutoff: readyUniverse.cutoff,
    }) as PreparedFamilyInstance);
  const fundingReadyEntries = fundingReadyMemos.map((memo) =>
    rebuildWiring.rehydrateVerifiedInstance({
      memo,
      cutoff: readyUniverse.cutoff,
    }) as {
      readonly domain: "funding";
      readonly familyId: string;
      readonly instanceKey: string;
      readonly asset: string;
      readonly bindings: readonly import("../venues/adapter-family-plugin.js").FundingExecutionBinding[];
    }
  );
  if (
    readyInstances.length + fundingReadyEntries.length !==
      activeReadyMemos.length
  ) {
    throw new Error(
      "strict startup readyGeneration lost an active memo/instance",
    );
  }
  if (preparedReady && !liveIds) {
    const publications = rebuildWiring.aggregateOnceByFamily([...readyInstances, ...fundingReadyEntries]);
    rebuildWiring.assertReadyGraphSnapshot!({ publications, graphSnapshot: readyUniverse.graphSnapshot,
      cutoff: readyUniverse.cutoff });
  }
  const flashTokens = Object.freeze([...new Set(fundingReadyEntries.flatMap(
    entry => entry.bindings.map(binding => ethers.getAddress(binding.asset).toLowerCase()),
  ))].sort());
  if (flashTokens.length === 0) {
    throw new Error(
      "strict startup rebuild produced no observed/retained funding token",
    );
  }
  let graph = strictReadyRuntime.graph as TokenEdge[];
  if (liveIds) {
    const excludedActions = new Set(PRODUCTION_STRICT_SHADOW_FAMILY_LOAD.disabledPlugins.flatMap(
      module => [...module.plugin.manifest.ownedActionAdapterIds] as string[],
    ));
    graph = graph.filter(edge => !excludedActions.has(edge.adapterId));
    const publications = rebuildWiring.aggregateOnceByFamily([...readyInstances, ...fundingReadyEntries]);
    const projected = rebuildWiring.buildGraphSnapshot(publications, readyUniverse.cutoff) as { edges: TokenEdge[] };
    const byId = new Map(projected.edges.map(edge => [edge.canonicalEdgeId, edge]));
    if (graph.length !== projected.edges.length || byId.size !== graph.length || graph.some(edge => {
      const verified = byId.get(edge.canonicalEdgeId);
      return !verified || canonicalJson(verified) !== canonicalJson(edge);
    })) throw new Error("live subset edges differ from the sealed Ready and retained bindings");
    console.log("[searcher/live-ready-scope] " + JSON.stringify({ parentGeneration: readyUniverse.generation,
      parentGraphEdges: strictReadyRuntime.graph.length, liveGraphEdges: graph.length, liveFamilyIds }));
  }
  const strictRuntimeRoot = new StrictProductionRuntimeRoot({
    catalog: PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG,
    readySource: readyUniverse.cutoff,
    readyGraph: graph,
    readyInstances,
    readyFundingAssets: fundingReadyEntries.flatMap(entry => entry.bindings.map(binding => Object.freeze({
      familyId: entry.familyId as never, asset: binding.asset, binding,
    }))),
  });
  const graphViewCoordinator = new StrictReadyGraphViewCoordinator({
    catalog: PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG,
    ready: readyUniverse,
    edges: graph,
  });
  const baseline = resolveProducerBaseline({ ready: readyUniverse, currentHead });
  return {
    runtimeRoot: strictRuntimeRoot,
    selectorMode: readyUniverse.selectorCoverage !== undefined,
    liveFamilyIds,
    readyFingerprint: rebuildEnvelope.checkpointFingerprint,
    parentFamilyIds: liveFamilyIds ? Object.keys(readyUniverse.familyPartitions!).filter(id => readyUniverse.familyPartitions![id]!.enabled).sort() : undefined,
    graph,
    graphViewCoordinator,
    flashTokens,
    instanceCount: readyInstances.length,
    lineage: Object.freeze({
      generation: readyUniverse.generation,
      graphHash: readyUniverse.graphHash,
      catalogHash: readyUniverse.catalogHash,
      cutoffNumber: readyUniverse.cutoff.number,
      appliedThroughNumber: readyUniverse.appliedThrough.number,
      appliedThroughHash: readyUniverse.appliedThrough.hash,
      sourceCount: readyUniverse.sourceCoverage.length,
    }),
    baselineSummary: Object.freeze({
      generation: baseline.ready.generation,
      cutoffNumber: baseline.ready.cutoff.number,
      activeInstanceCount: baseline.activeInstanceKeys.size,
      observationScanFrom: baseline.observationScanFrom,
    }),
  };
}
