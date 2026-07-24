import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import {
  type AdapterRuntimeSnapshot,
  FlashFundingSnapshot,
} from "../adapter-runtime-coordinator.js";
import {
  BlockScanStateCoordinator,
  type BlockScanStateSnapshot,
} from "../blockscan-state-coordinator.js";
import { JsonRpcBlockScanStateReadBackend } from
  "../blockscan-state-read-backend.js";
import {
  detectProductionBlockScanOpportunities,
} from "../detector/blockscan-scanner-production.js";
import type { BlockScanCoreConfig } from
  "../detector/blockscan-scanner-core.js";
import type {
  PoolEntry,
  TokenEdge,
  TokenQueryBackend,
} from "../planner/token-graph.js";
import {
  blockScanEdgeKey,
  createVerifiedGraphView,
  exactSetHash,
  registerBlockScanStateFamily,
} from "../venues/blockscan-state-capability.js";
import { bindRouteInstanceIdentity } from
  "../venues/route-instance-identity.js";
import { wstethAdapter } from "../venues/protocols/wsteth.js";
import type {
  ConversionFreshnessPrivatePredicate,
  ConversionFreshnessReveal,
} from "./conversion-freshness-oracle.js";
import {
  captureConversionProductionEvidence,
  compareConversionProductionEvidence,
  conversionProductionDeliveryId,
  conversionProductionGraphArtifactSha256,
  conversionProductionScannerConfigSha256,
  type ConversionCandidateRankOracleEntry,
  type ConversionProductionComparison,
} from "./conversion-freshness-production-evidence.js";

export async function verifySelectedConversionProductionLive(input: {
  readonly rpcUrl: string;
  readonly predicate: ConversionFreshnessPrivatePredicate;
  readonly reveal: ConversionFreshnessReveal;
}): Promise<ConversionProductionComparison> {
  assert.equal(input.reveal.freshnessEvidence, "selected");
  const selected = input.reveal.selected;
  const evidence = input.reveal.selectedEvidence;
  assert(selected && evidence, "conversion production live needs selected evidence");
  assert.equal(selected.sourceBlock, evidence.source.number);
  const tokenBackend = historicalTokenBackend(
    input.rpcUrl,
    evidence.base.hash,
  );
  const pool: PoolEntry = {
    address: input.predicate.instanceAddress,
    adapter: "wsteth",
  };
  const built = await wstethAdapter.buildEdges(pool, tokenBackend);
  const edges = bindRouteInstanceIdentity(wstethAdapter, pool, built);
  assert(edges.length > 0, "conversion production live graph has no edges");

  const backend = new JsonRpcBlockScanStateReadBackend(input.rpcUrl, {
    maxBatchSize: 50,
    maxConcurrentBatches: 1,
  });
  const coordinator = new BlockScanStateCoordinator(backend, {
    // Archive-backed historical evidence is materialized outside the strict
    // production timer. Do not let the live 5s family budget turn a valid
    // direct N/N-1 read into a transport-dependent missing sample.
    familyTimeoutMs: 60_000,
  });
  const family = registerBlockScanStateFamily({
    familyId: wstethAdapter.id,
    lane: "protocol",
    capability: wstethAdapter.pricingState,
    ownsEdge: (edge) => wstethAdapter.edgeAdapterIds.includes(edge.adapterId),
  });
  const baseGraph = graphFor(
    edges,
    1,
    evidence.base.number,
    evidence.base.hash,
  );
  const sourceGraph = graphFor(
    edges,
    2,
    evidence.source.number,
    evidence.source.hash,
  );
  const baseResult = await coordinator.prepare({
    graph: baseGraph,
    families: [family],
    deadlineAtMs: Date.now() + 60_000,
  });
  assert.notEqual(baseResult.status, "incomplete", "base conversion state incomplete");
  assert(baseResult.snapshot);
  const sourceResult = await coordinator.prepare({
    graph: sourceGraph,
    families: [family],
    deadlineAtMs: Date.now() + 60_000,
  });
  assert.notEqual(
    sourceResult.status,
    "incomplete",
    "source conversion state incomplete",
  );
  assert(sourceResult.snapshot);
  const base = conversionRuntimeFromPricing(
    baseResult.snapshot,
    baseResult.status === "degraded" ? "degraded" : "complete",
  );
  const source = conversionRuntimeFromPricing(
    sourceResult.snapshot,
    sourceResult.status === "degraded" ? "degraded" : "complete",
  );
  const scannerConfig = componentScannerConfig(edges);
  const baseCandidateOracle = conversionCandidateOracle(base, scannerConfig);
  const sourceCandidateOracle = conversionCandidateOracle(source, scannerConfig);
  const graphArtifactSha256 = conversionProductionGraphArtifactSha256(base);
  const attemptNonce = randomBytes(32).toString("hex");
  const sealed = captureConversionProductionEvidence({
    delivery: {
      attemptNonce,
      baseDeliveryId: conversionProductionDeliveryId({
        attemptNonce,
        phase: "base",
        blockHash: evidence.base.hash,
      }),
      sourceDeliveryId: conversionProductionDeliveryId({
        attemptNonce,
        phase: "source",
        blockHash: evidence.source.hash,
      }),
      graphScope: "component-fixture",
      graphArtifactSha256,
    },
    base,
    source,
    scannerConfig,
  });
  const rawText = JSON.stringify(sealed.raw).toLowerCase();
  for (const privateValue of [
    input.predicate.protocol,
    input.predicate.instanceAddress,
    input.predicate.event.address,
    input.predicate.event.topic0,
  ]) {
    assert.equal(
      rawText.includes(privateValue.toLowerCase()),
      false,
      "conversion producer raw evidence leaked selected metadata",
    );
  }
  const targetStateKeys = [...source.pricing.stateByStateKey.entries()]
    .filter(([, state]) => state.familyId === wstethAdapter.id)
    .map(([stateKey]) => stateKey);
  assert.equal(targetStateKeys.length, 1, "wstETH state-key partition");
  const comparison = compareConversionProductionEvidence({
    reveal: input.reveal,
    sealed,
    expectation: {
      selectedCandidateId: selected.id,
      selectedEvidenceSha256: selected.evidenceSha256,
      graphArtifactSha256,
      scannerConfigSha256:
        conversionProductionScannerConfigSha256(scannerConfig),
      sourceWithoutTargetUpdateOutcome: "ran",
      targetStateKey: targetStateKeys[0],
      edgeRateBindings: edges.map((edge) => {
        const rateReadId = edge.adapterId === "wsteth-wrap"
          ? "get-wsteth-by-steth"
          : "get-steth-by-wsteth";
        const descriptor = input.predicate.rateReads.find(
          (read) => read.id === rateReadId,
        );
        assert(descriptor, `conversion predicate lacks ${rateReadId}`);
        return {
          edgeKey: blockScanEdgeKey(source.graph.edges.find(
            (candidate) => candidate.adapterId === edge.adapterId,
          )!),
          rateReadId,
          amountInRaw: BigInt(`0x${descriptor.data.slice(-64)}`).toString(),
        };
      }),
      candidateOracle: {
        base: baseCandidateOracle,
        source: sourceCandidateOracle,
        sourceWithoutTargetUpdate: baseCandidateOracle,
      },
    },
  });
  assert.equal(comparison.freshnessEvidence, "missing");
  assert(comparison.reasons.includes("graph_scope_not_production_full"));
  assert.equal(comparison.checks.sourceStateDirectRead, true);
  assert.equal(comparison.checks.sourceStateChanged, true);
  assert.equal(comparison.checks.currentMidsMatchOracle, true);
  assert.equal(comparison.checks.candidateOracleMatches, true);
  // A component graph may or may not move the target route's natural rank.
  // It remains non-production evidence solely because its graph scope is not
  // the frozen full production graph.
  return comparison;
}

function graphFor(
  edges: readonly TokenEdge[],
  generation: number,
  block: number,
  hash: string,
) {
  return createVerifiedGraphView({
    id: "conversion-freshness-component",
    generation,
    sourceBlock: block,
    sourceBlockHash: hash,
    completenessWatermark: block,
    perSourceCoverage: [{
      familyId: wstethAdapter.id,
      sourceId: "trusted-component-fixture",
      sourceFingerprint: "trusted-component-fixture-v1",
      completeThroughBlock: block,
      completeThroughHash: hash,
    }],
    edges,
    familyIdForEdge: () => wstethAdapter.id,
  });
}

export function conversionRuntimeFromPricing(
  pricing: BlockScanStateSnapshot,
  completeness: AdapterRuntimeSnapshot["completeness"] = "complete",
): AdapterRuntimeSnapshot {
  const emptyHash = exactSetHash([]);
  const funding = new FlashFundingSnapshot(
    pricing.generation,
    pricing.sourceBlock,
    pricing.sourceBlockHash,
    {
      expectedKeys: [],
      resolvedKeys: [],
      unresolvedKeys: [],
      expectedHash: emptyHash,
      resolvedHash: emptyHash,
      unresolvedHash: emptyHash,
    },
    new Map(),
    new Map(),
    new Map(),
  );
  return Object.freeze({
    completeness,
    generation: pricing.generation,
    sourceBlock: pricing.sourceBlock,
    sourceBlockHash: pricing.sourceBlockHash,
    graph: pricing.graph,
    pricing,
    funding,
  });
}

function componentScannerConfig(
  edges: readonly TokenEdge[],
): BlockScanCoreConfig {
  const tokens = new Map<string, { maxBorrow: bigint }>();
  for (const edge of edges) {
    tokens.set(edge.tokenIn.toLowerCase(), {
      maxBorrow: 1_000n * 10n ** 18n,
    });
  }
  return {
    maxHops: 4,
    minSpreadBps: 0,
    maxCandidates: 200,
    budgetMs: 10_000,
    pricedTokens: tokens,
    pinnedOutsideBudget: true,
  };
}

export function conversionCandidateOracle(
  runtime: AdapterRuntimeSnapshot,
  config: BlockScanCoreConfig,
): readonly ConversionCandidateRankOracleEntry[] {
  const observed = detectProductionBlockScanOpportunities({
    runtime,
    swapTouched: null,
    cfg: config,
  });
  assert.equal(observed.outcome, "ran");
  return Object.freeze(observed.opportunities.map((opportunity, index) => ({
    rank: index + 1,
    edgeKeys: Object.freeze(
      opportunity.seedEdges.map(blockScanEdgeKey),
    ),
  })));
}

function historicalTokenBackend(
  rpcUrl: string,
  blockHash: string,
): TokenQueryBackend {
  let id = 0;
  return {
    async call(request): Promise<string> {
      const response = await fetch(rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: ++id,
          method: "eth_call",
          params: [
            { to: request.to, data: request.data },
            { blockHash, requireCanonical: true },
          ],
        }),
        signal: AbortSignal.timeout(30_000),
      });
      assert(response.ok, `conversion token graph RPC HTTP ${response.status}`);
      const payload = await response.json() as {
        readonly result?: string;
        readonly error?: { readonly message?: string };
      };
      assert(!payload.error, payload.error?.message ?? "conversion token graph RPC");
      assert(
        typeof payload.result === "string",
        "conversion token graph RPC result",
      );
      return payload.result;
    },
  };
}
