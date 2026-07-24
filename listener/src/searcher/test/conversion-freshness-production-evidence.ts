import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { AdapterRuntimeSnapshot } from "../adapter-runtime-coordinator.js";
import type { TokenEdge } from "../planner/token-graph.js";
import {
  detectProductionBlockScanOpportunities,
} from "../detector/blockscan-scanner-production.js";
import type { BlockScanCoreConfig } from "../detector/blockscan-scanner-core.js";
import {
  blockScanEdgeKey,
} from "../venues/blockscan-state-capability.js";
import {
  BLIND_SCHEMA_VERSION,
  canonicalJson,
  sha256Canonical,
} from "./adapter-family-blind-contract.js";
import type {
  ConversionFreshnessReveal,
} from "./conversion-freshness-oracle.js";

export const CONVERSION_PRODUCTION_PROFILE =
  "conversion-freshness-production-v1" as const;
export const CONVERSION_PRODUCTION_COMPARISON_PROFILE =
  "conversion-freshness-production-comparison-v1" as const;

export type ConversionProductionGraphScope =
  | "production-full"
  | "component-fixture";

export interface ConversionProductionDelivery {
  readonly attemptNonce: string;
  readonly baseDeliveryId: string;
  readonly sourceDeliveryId: string;
  readonly graphScope: ConversionProductionGraphScope;
  readonly graphArtifactSha256: string;
}

export interface ConversionProductionStateEvidence {
  readonly stateId: string;
  readonly familyId: string;
  readonly baseSnapshotFingerprint: string;
  readonly sourceSnapshotFingerprint: string;
  readonly baseReadIds: readonly string[];
  readonly sourceReadIds: readonly string[];
  readonly sourceDirectReadIds: readonly string[];
}

export interface ConversionProductionMidEvidence {
  readonly edgeId: string;
  readonly baseMidBinary64: string;
  readonly sourceMidBinary64: string;
  readonly changed: boolean;
}

export interface ConversionProductionCandidateEvidence {
  readonly routeId: string;
  readonly rank: number;
  readonly edgeIds: readonly string[];
}

export interface ConversionProductionRawEvidence {
  readonly schemaVersion: typeof BLIND_SCHEMA_VERSION;
  readonly profile: typeof CONVERSION_PRODUCTION_PROFILE;
  readonly attemptNonce: string;
  readonly delivery: {
    readonly baseDeliveryId: string;
    readonly sourceDeliveryId: string;
  };
  readonly graph: {
    readonly scope: ConversionProductionGraphScope;
    readonly artifactSha256: string;
    readonly edgeCount: number;
    readonly orderedEdgeHash: string;
    readonly metadataHash: string;
    readonly ownershipHash: string;
    readonly sourceCoverageHash: string;
    readonly topologyUnchanged: true;
  };
  readonly selectionMode: "production";
  readonly forcedSelectionCount: 0;
  readonly states: readonly ConversionProductionStateEvidence[];
  readonly mids: readonly ConversionProductionMidEvidence[];
  readonly scanner: {
    readonly configSha256: string;
    readonly baseOutcome: "ran" | "budget_exceeded";
    readonly sourceOutcome: "ran" | "budget_exceeded";
    readonly baseCandidates: readonly ConversionProductionCandidateEvidence[];
    readonly sourceCandidates: readonly ConversionProductionCandidateEvidence[];
  };
}

export interface SealedConversionProductionEvidence {
  readonly raw: ConversionProductionRawEvidence;
  readonly rawSha256: string;
}

export interface ConversionCandidateRankOracleEntry {
  readonly rank: number;
  readonly edgeKeys: readonly string[];
}

export interface ConversionMidRateBinding {
  readonly edgeKey: string;
  readonly rateReadId: string;
  readonly amountInRaw: string;
}

export interface ConversionProductionExpectation {
  readonly selectedCandidateId: string;
  readonly selectedEvidenceSha256: string;
  readonly graphArtifactSha256: string;
  readonly scannerConfigSha256: string;
  readonly sourceWithoutTargetUpdateOutcome: "ran" | "budget_exceeded";
  readonly targetStateKey: string;
  readonly edgeRateBindings: readonly ConversionMidRateBinding[];
  readonly candidateOracle: {
    readonly base: readonly ConversionCandidateRankOracleEntry[];
    readonly source: readonly ConversionCandidateRankOracleEntry[];
    /**
     * Trusted source-N counterfactual: every non-target mid is from N while
     * the selected conversion family's mids are restored to N-1.
     */
    readonly sourceWithoutTargetUpdate:
      readonly ConversionCandidateRankOracleEntry[];
  };
}

export type ConversionProductionMissingReason =
  | "graph_scope_not_production_full"
  | "source_state_not_direct_read"
  | "source_state_unchanged"
  | "current_mid_mismatch"
  | "scanner_outcome_not_ran"
  | "candidate_oracle_mismatch"
  | "no_natural_candidate_or_rank_change";

export interface ConversionProductionComparison {
  readonly schemaVersion: typeof BLIND_SCHEMA_VERSION;
  readonly profile: typeof CONVERSION_PRODUCTION_COMPARISON_PROFILE;
  readonly freshnessEvidence: "selected" | "missing";
  readonly reasons: readonly ConversionProductionMissingReason[];
  readonly checks: {
    readonly selectedOracleBound: boolean;
    readonly topologyUnchanged: boolean;
    readonly sourceStateDirectRead: boolean;
    readonly sourceStateChanged: boolean;
    readonly currentMidsMatchOracle: boolean;
    readonly scannerOutcomesRan: boolean;
    readonly candidateOracleMatches: boolean;
    readonly naturalCandidateOrRankChanged: boolean;
  };
  readonly rawSha256: string;
}

export interface ConversionProductionProducerCapture {
  readonly sealed: SealedConversionProductionEvidence;
  /**
   * Target-neutral private sidecar from the exact scanner invocations used to
   * create `sealed.raw`. It is consumed only after the raw seal boundary.
   */
  readonly scanner: {
    readonly baseOutcome: "ran" | "budget_exceeded";
    readonly sourceOutcome: "ran" | "budget_exceeded";
    readonly baseCandidates: readonly ConversionCandidateRankOracleEntry[];
    readonly sourceCandidates: readonly ConversionCandidateRankOracleEntry[];
  };
}

interface CaptureConversionProductionEvidenceInput {
  readonly delivery: ConversionProductionDelivery;
  readonly base: AdapterRuntimeSnapshot;
  readonly source: AdapterRuntimeSnapshot;
  readonly scannerConfig: BlockScanCoreConfig;
}

/**
 * Capture the complete production runtime without receiving selected family,
 * state-key, edge, route, rate or protocol metadata. Target matching happens
 * only in compareConversionProductionEvidence after the raw record is sealed.
 */
export function captureConversionProductionEvidence(input: {
  readonly delivery: ConversionProductionDelivery;
  readonly base: AdapterRuntimeSnapshot;
  readonly source: AdapterRuntimeSnapshot;
  readonly scannerConfig: BlockScanCoreConfig;
}): SealedConversionProductionEvidence {
  return captureConversionProductionEvidenceWithProducer(input).sealed;
}

export function captureConversionProductionEvidenceWithProducer(
  input: CaptureConversionProductionEvidenceInput,
): ConversionProductionProducerCapture {
  validateDelivery(input.delivery);
  assert.equal(
    input.delivery.baseDeliveryId,
    conversionProductionDeliveryId({
      attemptNonce: input.delivery.attemptNonce,
      phase: "base",
      blockHash: input.base.sourceBlockHash,
    }),
    "conversion base delivery is not bound to the delivered runtime",
  );
  assert.equal(
    input.delivery.sourceDeliveryId,
    conversionProductionDeliveryId({
      attemptNonce: input.delivery.attemptNonce,
      phase: "source",
      blockHash: input.source.sourceBlockHash,
    }),
    "conversion source delivery is not bound to the delivered runtime",
  );
  assertSameTopology(input.base, input.source);
  if (input.delivery.graphScope === "production-full") {
    assert.equal(
      input.base.completeness,
      "complete",
      "production-full conversion base runtime is degraded",
    );
    assert.equal(
      input.source.completeness,
      "complete",
      "production-full conversion source runtime is degraded",
    );
  }
  assert.equal(
    input.delivery.graphArtifactSha256,
    conversionProductionGraphArtifactSha256(input.base),
    "conversion graph artifact does not bind the production graph",
  );
  const baseScan = detectProductionBlockScanOpportunities({
    runtime: input.base,
    swapTouched: null,
    cfg: input.scannerConfig,
  });
  const sourceScan = detectProductionBlockScanOpportunities({
    runtime: input.source,
    swapTouched: null,
    cfg: input.scannerConfig,
  });
  const stateKeys = exactUnion(
    input.base.pricing.stateByStateKey.keys(),
    input.source.pricing.stateByStateKey.keys(),
  );
  const edgeKeys = exactUnion(
    input.base.pricing.mids.keys(),
    input.source.pricing.mids.keys(),
  );
  const raw: ConversionProductionRawEvidence = Object.freeze({
    schemaVersion: BLIND_SCHEMA_VERSION,
    profile: CONVERSION_PRODUCTION_PROFILE,
    attemptNonce: input.delivery.attemptNonce,
    delivery: Object.freeze({
      baseDeliveryId: input.delivery.baseDeliveryId,
      sourceDeliveryId: input.delivery.sourceDeliveryId,
    }),
    graph: Object.freeze({
      scope: input.delivery.graphScope,
      artifactSha256: input.delivery.graphArtifactSha256,
      edgeCount: input.base.graph.edges.length,
      orderedEdgeHash: input.base.graph.orderedEdgeHash,
      metadataHash: input.base.graph.metadataHash,
      ownershipHash: input.base.graph.ownershipHash,
      sourceCoverageHash: conversionProductionSourceCoverageSha256(
        input.base,
      ),
      topologyUnchanged: true as const,
    }),
    selectionMode: "production" as const,
    forcedSelectionCount: 0 as const,
    states: Object.freeze(stateKeys.map((stateKey) =>
      stateEvidence(
        input.delivery.attemptNonce,
        stateKey,
        input.base,
        input.source,
      )
    )),
    mids: Object.freeze(edgeKeys.map((edgeKey) =>
      midEvidence(
        input.delivery.attemptNonce,
        edgeKey,
        input.base,
        input.source,
      )
    )),
    scanner: Object.freeze({
      configSha256: conversionProductionScannerConfigSha256(
        input.scannerConfig,
      ),
      baseOutcome: baseScan.outcome,
      sourceOutcome: sourceScan.outcome,
      baseCandidates: candidateEvidence(
        input.delivery.attemptNonce,
        baseScan.opportunities,
      ),
      sourceCandidates: candidateEvidence(
        input.delivery.attemptNonce,
        sourceScan.opportunities,
      ),
    }),
  });
  validateRawEvidence(raw);
  const sealed = Object.freeze({
    raw,
    rawSha256: sha256Canonical(raw),
  });
  return Object.freeze({
    sealed,
    scanner: Object.freeze({
      baseOutcome: baseScan.outcome,
      sourceOutcome: sourceScan.outcome,
      baseCandidates: candidateRankOracle(baseScan.opportunities),
      sourceCandidates: candidateRankOracle(sourceScan.opportunities),
    }),
  });
}

export function scanConversionProductionCandidateOracle(
  runtime: AdapterRuntimeSnapshot,
  config: BlockScanCoreConfig,
): {
  readonly outcome: "ran" | "budget_exceeded";
  readonly candidates: readonly ConversionCandidateRankOracleEntry[];
} {
  const observed = detectProductionBlockScanOpportunities({
    runtime,
    swapTouched: null,
    cfg: config,
  });
  return Object.freeze({
    outcome: observed.outcome,
    candidates: candidateRankOracle(observed.opportunities),
  });
}

export function conversionProductionGraphArtifactSha256(
  runtime: AdapterRuntimeSnapshot,
): string {
  return sha256Canonical({
    edgeCount: runtime.graph.edges.length,
    orderedEdgeHash: runtime.graph.orderedEdgeHash,
    metadataHash: runtime.graph.metadataHash,
    ownershipHash: runtime.graph.ownershipHash,
    sourceCoverageHash: conversionProductionSourceCoverageSha256(runtime),
  });
}

export function conversionProductionSourceCoverageSha256(
  runtime: AdapterRuntimeSnapshot,
): string {
  return sha256Canonical(
    runtime.graph.perSourceCoverage
      .map((coverage) => ({
        familyId: coverage.familyId,
        sourceId: coverage.sourceId,
        sourceFingerprint: coverage.sourceFingerprint,
        completeThroughBlock: coverage.completeThroughBlock,
        completeThroughHash: coverage.completeThroughHash.toLowerCase(),
      }))
      .sort((left, right) =>
        left.familyId.localeCompare(right.familyId) ||
        left.sourceId.localeCompare(right.sourceId)
      ),
  );
}

export function conversionProductionScannerConfigSha256(
  config: BlockScanCoreConfig,
): string {
  return sha256Canonical({
    maxHops: config.maxHops,
    minSpreadBps: config.minSpreadBps,
    maxCandidates: config.maxCandidates,
    budgetMs: config.budgetMs,
    pinnedOutsideBudget: config.pinnedOutsideBudget === true,
    pricedTokens: [...config.pricedTokens.entries()]
      .map(([token, value]) => ({
        token: token.toLowerCase(),
        maxBorrow: value.maxBorrow.toString(),
      }))
      .sort((left, right) => left.token.localeCompare(right.token)),
  });
}

/**
 * Source-N counterfactual used by the trusted post-reveal comparator. Every
 * non-target value remains from N; only target-family pricing payloads are
 * restored to N-1. Source graph edge references remain canonical at N.
 */
export function conversionRuntimeWithTargetMidsRestored(input: {
  readonly source: AdapterRuntimeSnapshot;
  readonly base: AdapterRuntimeSnapshot;
  readonly targetEdges: readonly TokenEdge[];
}): AdapterRuntimeSnapshot {
  assertSameTopology(input.base, input.source);
  assert(input.targetEdges.length > 0, "conversion counterfactual has no target edges");
  const mids = new Map(input.source.pricing.mids);
  for (const edge of input.targetEdges) {
    const edgeKey = blockScanEdgeKey(edge);
    const baseMid = input.base.pricing.mids.get(edgeKey);
    const sourceMid = input.source.pricing.mids.get(edgeKey);
    assert(
      baseMid,
      `conversion counterfactual lacks base target mid ${edgeKey}`,
    );
    assert(
      sourceMid,
      `conversion counterfactual lacks source target mid ${edgeKey}`,
    );
    mids.set(edgeKey, Object.freeze({
      ...baseMid,
      // Do not smuggle N-1 TokenEdge object identity into the N runtime.
      edges: sourceMid.edges,
    }));
  }
  return Object.freeze({
    ...input.source,
    pricing: Object.freeze({
      ...input.source.pricing,
      mids,
    }),
  });
}

/**
 * Trusted post-seal comparator. A changed rate/mid alone is insufficient:
 * the selected result requires a production-full graph and at least one
 * naturally enumerated target route whose membership or ordinal rank changed.
 */
export function compareConversionProductionEvidence(input: {
  readonly reveal: ConversionFreshnessReveal;
  readonly sealed: SealedConversionProductionEvidence;
  readonly expectation: ConversionProductionExpectation;
}): ConversionProductionComparison {
  validateSealed(input.sealed);
  const { raw } = input.sealed;
  const selected = input.reveal.selected;
  const selectedEvidence = input.reveal.selectedEvidence;
  const selectedOracleBound = Boolean(
    input.reveal.freshnessEvidence === "selected" &&
      selected &&
      selectedEvidence &&
      selected.id === input.expectation.selectedCandidateId &&
      selected.evidenceSha256 === input.expectation.selectedEvidenceSha256 &&
      selected.evidenceSha256 === sha256Canonical(selectedEvidence),
  );
  assert(selectedOracleBound, "conversion production expectation is not bound");
  assert(selected && selectedEvidence);
  assert.equal(
    raw.delivery.baseDeliveryId,
    conversionProductionDeliveryId({
      attemptNonce: raw.attemptNonce,
      phase: "base",
      blockHash: selectedEvidence.base.hash,
    }),
    "conversion raw base delivery is not bound to the selected evidence",
  );
  assert.equal(
    raw.delivery.sourceDeliveryId,
    conversionProductionDeliveryId({
      attemptNonce: raw.attemptNonce,
      phase: "source",
      blockHash: selectedEvidence.source.hash,
    }),
    "conversion raw source delivery is not bound to the selected evidence",
  );
  assert(
    input.expectation.graphArtifactSha256 === raw.graph.artifactSha256,
    "conversion production graph artifact mismatch",
  );
  assert.equal(
    input.expectation.scannerConfigSha256,
    raw.scanner.configSha256,
    "conversion production scanner config mismatch",
  );

  const targetStateId = opaqueId(
    raw.attemptNonce,
    "state",
    input.expectation.targetStateKey,
  );
  const state = raw.states.find((entry) => entry.stateId === targetStateId);
  const sourceStateDirectRead = Boolean(
    state &&
      state.sourceReadIds.length > 0 &&
      canonicalJson(state.sourceReadIds) ===
        canonicalJson(state.sourceDirectReadIds),
  );
  const sourceStateChanged = Boolean(
    state &&
      state.baseSnapshotFingerprint !== state.sourceSnapshotFingerprint,
  );

  const currentMidsMatchOracle = input.expectation.edgeRateBindings.length > 0 &&
    input.expectation.edgeRateBindings.every((binding) => {
      const rate = selectedEvidence.rates.find(
        (candidate) => candidate.id === binding.rateReadId,
      );
      const mid = raw.mids.find(
        (candidate) =>
          candidate.edgeId === opaqueId(raw.attemptNonce, "edge", binding.edgeKey),
      );
      if (!rate || !mid || !rate.changed || !mid.changed) return false;
      const amountIn = BigInt(binding.amountInRaw);
      if (amountIn <= 0n) return false;
      return mid.baseMidBinary64 ===
          numberToBinary64(Number(BigInt(rate.before)) / Number(amountIn)) &&
        mid.sourceMidBinary64 ===
          numberToBinary64(Number(BigInt(rate.after)) / Number(amountIn));
    });

  const expectedBase = oracleCandidateEvidence(
    raw.attemptNonce,
    input.expectation.candidateOracle.base,
  );
  const expectedSource = oracleCandidateEvidence(
    raw.attemptNonce,
    input.expectation.candidateOracle.source,
  );
  const expectedSourceWithoutTargetUpdate = oracleCandidateEvidence(
    raw.attemptNonce,
    input.expectation.candidateOracle.sourceWithoutTargetUpdate,
  );
  const candidateOracleMatches =
    canonicalJson(raw.scanner.baseCandidates) === canonicalJson(expectedBase) &&
    canonicalJson(raw.scanner.sourceCandidates) === canonicalJson(expectedSource);
  const scannerOutcomesRan =
    raw.scanner.baseOutcome === "ran" &&
    raw.scanner.sourceOutcome === "ran" &&
    input.expectation.sourceWithoutTargetUpdateOutcome === "ran";

  const targetEdgeIds = new Set(
    input.expectation.edgeRateBindings.map((binding) =>
      opaqueId(raw.attemptNonce, "edge", binding.edgeKey)
    ),
  );
  const naturalCandidateOrRankChanged = candidateDeltaTouchesTarget(
    expectedSourceWithoutTargetUpdate,
    expectedSource,
    targetEdgeIds,
  );
  const reasons: ConversionProductionMissingReason[] = [];
  if (raw.graph.scope !== "production-full") {
    reasons.push("graph_scope_not_production_full");
  }
  if (!sourceStateDirectRead) reasons.push("source_state_not_direct_read");
  if (!sourceStateChanged) reasons.push("source_state_unchanged");
  if (!currentMidsMatchOracle) reasons.push("current_mid_mismatch");
  if (!scannerOutcomesRan) reasons.push("scanner_outcome_not_ran");
  if (!candidateOracleMatches) reasons.push("candidate_oracle_mismatch");
  if (!naturalCandidateOrRankChanged) {
    reasons.push("no_natural_candidate_or_rank_change");
  }
  return Object.freeze({
    schemaVersion: BLIND_SCHEMA_VERSION,
    profile: CONVERSION_PRODUCTION_COMPARISON_PROFILE,
    freshnessEvidence: reasons.length === 0 ? "selected" : "missing",
    reasons: Object.freeze(reasons),
    checks: Object.freeze({
      selectedOracleBound,
      topologyUnchanged: raw.graph.topologyUnchanged,
      sourceStateDirectRead,
      sourceStateChanged,
      currentMidsMatchOracle,
      scannerOutcomesRan,
      candidateOracleMatches,
      naturalCandidateOrRankChanged,
    }),
    rawSha256: input.sealed.rawSha256,
  });
}

export function conversionProductionDeliveryId(input: {
  readonly attemptNonce: string;
  readonly phase: "base" | "source";
  readonly blockHash: string;
}): string {
  assertNonce(input.attemptNonce);
  assertHash(input.blockHash, "conversion delivery block hash");
  return sha256Canonical({
    attemptNonce: input.attemptNonce,
    phase: input.phase,
    blockHash: input.blockHash.toLowerCase(),
  });
}

function stateEvidence(
  attemptNonce: string,
  stateKey: string,
  base: AdapterRuntimeSnapshot,
  source: AdapterRuntimeSnapshot,
): ConversionProductionStateEvidence {
  const baseState = base.pricing.stateByStateKey.get(stateKey);
  const sourceState = source.pricing.stateByStateKey.get(stateKey);
  assert(baseState && sourceState, `conversion state coverage changed for ${stateKey}`);
  assert(baseState.familyId === sourceState.familyId, "conversion state owner changed");
  const baseReadIds = opaqueReadIds(
    attemptNonce,
    stateKey,
    baseState.freshnessByReadKey.keys(),
  );
  const sourceReadIds = opaqueReadIds(
    attemptNonce,
    stateKey,
    sourceState.freshnessByReadKey.keys(),
  );
  const sourceDirectReadIds = opaqueReadIds(
    attemptNonce,
    stateKey,
    [...sourceState.freshnessByReadKey.entries()]
      .filter(([, proof]) =>
        proof.kind === "direct-read" &&
        proof.source.number === source.sourceBlock &&
        proof.source.hash.toLowerCase() === source.sourceBlockHash.toLowerCase() &&
        proof.provenance.kind === "eip1898" &&
        proof.provenance.requireCanonical === true &&
        proof.provenance.source.number === source.sourceBlock &&
        proof.provenance.source.hash.toLowerCase() ===
          source.sourceBlockHash.toLowerCase() &&
        proof.provenance.source.generation === source.generation
      )
      .map(([readKey]) => readKey),
  );
  return Object.freeze({
    stateId: opaqueId(attemptNonce, "state", stateKey),
    familyId: opaqueId(attemptNonce, "family", sourceState.familyId),
    baseSnapshotFingerprint: baseState.snapshot.snapshotFingerprint,
    sourceSnapshotFingerprint: sourceState.snapshot.snapshotFingerprint,
    baseReadIds,
    sourceReadIds,
    sourceDirectReadIds,
  });
}

function midEvidence(
  attemptNonce: string,
  edgeKey: string,
  base: AdapterRuntimeSnapshot,
  source: AdapterRuntimeSnapshot,
): ConversionProductionMidEvidence {
  const baseMid = base.pricing.mids.get(edgeKey)?.mid;
  const sourceMid = source.pricing.mids.get(edgeKey)?.mid;
  assert(
    baseMid !== undefined && sourceMid !== undefined,
    `conversion mid coverage changed for ${edgeKey}`,
  );
  const before = numberToBinary64(baseMid);
  const after = numberToBinary64(sourceMid);
  return Object.freeze({
    edgeId: opaqueId(attemptNonce, "edge", edgeKey),
    baseMidBinary64: before,
    sourceMidBinary64: after,
    changed: before !== after,
  });
}

function candidateEvidence(
  attemptNonce: string,
  opportunities: readonly {
    readonly seedEdges: readonly {
      readonly canonicalEdgeId?: string;
      readonly adapterId: string;
      readonly target: string;
      readonly tokenIn: string;
      readonly tokenOut: string;
      readonly slotKind: string;
      readonly protocolAction?: string;
      readonly executionVariantKey?: string;
      readonly instanceKey?: string;
    }[];
  }[],
): readonly ConversionProductionCandidateEvidence[] {
  return Object.freeze(opportunities.map((opportunity, index) => {
    const edgeKeys = opportunity.seedEdges.map((edge) =>
      blockScanEdgeKey(edge as Parameters<typeof blockScanEdgeKey>[0])
    );
    const edgeIds = Object.freeze(
      edgeKeys.map((edgeKey) => opaqueId(attemptNonce, "edge", edgeKey)),
    );
    return Object.freeze({
      routeId: opaqueId(attemptNonce, "route", canonicalJson(edgeKeys)),
      rank: index + 1,
      edgeIds,
    });
  }));
}

function candidateRankOracle(
  opportunities: readonly {
    readonly seedEdges: readonly Parameters<typeof blockScanEdgeKey>[0][];
  }[],
): readonly ConversionCandidateRankOracleEntry[] {
  return Object.freeze(opportunities.map((opportunity, index) =>
    Object.freeze({
      rank: index + 1,
      edgeKeys: Object.freeze(
        opportunity.seedEdges.map(blockScanEdgeKey),
      ),
    })
  ));
}

function oracleCandidateEvidence(
  attemptNonce: string,
  entries: readonly ConversionCandidateRankOracleEntry[],
): readonly ConversionProductionCandidateEvidence[] {
  return Object.freeze(entries.map((entry) => {
    assert(
      Number.isSafeInteger(entry.rank) && entry.rank > 0,
      "conversion candidate oracle rank",
    );
    assert(entry.edgeKeys.length > 0, "conversion candidate oracle route");
    return Object.freeze({
      routeId: opaqueId(
        attemptNonce,
        "route",
        canonicalJson(entry.edgeKeys),
      ),
      rank: entry.rank,
      edgeIds: Object.freeze(entry.edgeKeys.map((edgeKey) =>
        opaqueId(attemptNonce, "edge", edgeKey)
      )),
    });
  }));
}

function candidateDeltaTouchesTarget(
  base: readonly ConversionProductionCandidateEvidence[],
  source: readonly ConversionProductionCandidateEvidence[],
  targetEdgeIds: ReadonlySet<string>,
): boolean {
  const before = new Map(base.map((entry) => [entry.routeId, entry]));
  const after = new Map(source.map((entry) => [entry.routeId, entry]));
  for (const routeId of exactUnion(before.keys(), after.keys())) {
    const left = before.get(routeId);
    const right = after.get(routeId);
    const touches = [...(left?.edgeIds ?? []), ...(right?.edgeIds ?? [])]
      .some((edgeId) => targetEdgeIds.has(edgeId));
    if (!touches) continue;
    if (!left || !right || left.rank !== right.rank) return true;
  }
  return false;
}

function assertSameTopology(
  base: AdapterRuntimeSnapshot,
  source: AdapterRuntimeSnapshot,
): void {
  assert(source.generation > base.generation, "conversion generation did not advance");
  assert(source.sourceBlock > base.sourceBlock, "conversion source did not advance");
  assert.equal(base.graph.orderedEdgeHash, source.graph.orderedEdgeHash);
  assert.equal(base.graph.metadataHash, source.graph.metadataHash);
  assert.equal(base.graph.ownershipHash, source.graph.ownershipHash);
  assert.equal(base.graph.edges.length, source.graph.edges.length);
}

function validateDelivery(delivery: ConversionProductionDelivery): void {
  assertNonce(delivery.attemptNonce);
  assertHash(delivery.baseDeliveryId, "conversion base delivery");
  assertHash(delivery.sourceDeliveryId, "conversion source delivery");
  assertHash(delivery.graphArtifactSha256, "conversion graph artifact");
  assert(
    delivery.graphScope === "production-full" ||
      delivery.graphScope === "component-fixture",
    "conversion graph scope",
  );
}

function validateSealed(sealed: SealedConversionProductionEvidence): void {
  validateRawEvidence(sealed.raw);
  assertHash(sealed.rawSha256, "conversion production raw hash");
  assert.equal(
    sealed.rawSha256,
    sha256Canonical(sealed.raw),
    "conversion production raw hash mismatch",
  );
}

function validateRawEvidence(raw: ConversionProductionRawEvidence): void {
  assert.equal(raw.schemaVersion, BLIND_SCHEMA_VERSION);
  assert.equal(raw.profile, CONVERSION_PRODUCTION_PROFILE);
  assertNonce(raw.attemptNonce);
  assert.equal(raw.selectionMode, "production");
  assert.equal(raw.forcedSelectionCount, 0);
  assert.equal(raw.graph.topologyUnchanged, true);
  assertHash(raw.scanner.configSha256, "conversion scanner config");
  assert(
    raw.scanner.baseOutcome === "ran" ||
      raw.scanner.baseOutcome === "budget_exceeded",
    "conversion base scanner outcome",
  );
  assert(
    raw.scanner.sourceOutcome === "ran" ||
      raw.scanner.sourceOutcome === "budget_exceeded",
    "conversion source scanner outcome",
  );
  assert(raw.graph.edgeCount > 0, "conversion production graph is empty");
  assertHash(raw.graph.artifactSha256, "conversion graph artifact");
  assertHash(raw.graph.orderedEdgeHash, "conversion ordered edge hash");
  assertHash(raw.graph.metadataHash, "conversion metadata hash");
  assertHash(raw.graph.ownershipHash, "conversion ownership hash");
  assertHash(raw.graph.sourceCoverageHash, "conversion source coverage hash");
  assert.equal(
    raw.graph.artifactSha256,
    sha256Canonical({
      edgeCount: raw.graph.edgeCount,
      orderedEdgeHash: raw.graph.orderedEdgeHash,
      metadataHash: raw.graph.metadataHash,
      ownershipHash: raw.graph.ownershipHash,
      sourceCoverageHash: raw.graph.sourceCoverageHash,
    }),
    "conversion raw graph artifact",
  );
  for (const state of raw.states) {
    assertHash(state.stateId, "conversion state id");
    assertHash(state.familyId, "conversion family id");
    assertHash(state.baseSnapshotFingerprint, "conversion base snapshot");
    assertHash(state.sourceSnapshotFingerprint, "conversion source snapshot");
  }
  for (const mid of raw.mids) {
    assertHash(mid.edgeId, "conversion edge id");
    assertBinary64(mid.baseMidBinary64);
    assertBinary64(mid.sourceMidBinary64);
  }
}

function opaqueReadIds(
  attemptNonce: string,
  stateKey: string,
  readKeys: Iterable<string>,
): readonly string[] {
  return Object.freeze(
    [...readKeys]
      .map((readKey) =>
        opaqueId(attemptNonce, "read", `${stateKey}\u001f${readKey}`)
      )
      .sort(),
  );
}

function opaqueId(
  attemptNonce: string,
  kind: "state" | "family" | "read" | "edge" | "route",
  value: string,
): string {
  assertNonce(attemptNonce);
  assert(value.length > 0, `conversion ${kind} identity`);
  return createHash("sha256")
    .update(CONVERSION_PRODUCTION_PROFILE)
    .update("\0")
    .update(attemptNonce)
    .update("\0")
    .update(kind)
    .update("\0")
    .update(value)
    .digest("hex");
}

function numberToBinary64(value: number): string {
  assert(Number.isFinite(value) && value > 0, "conversion mid must be positive");
  const bytes = Buffer.allocUnsafe(8);
  bytes.writeDoubleBE(value);
  return bytes.toString("hex");
}

function exactUnion(
  left: Iterable<string>,
  right: Iterable<string>,
): string[] {
  return [...new Set([...left, ...right])].sort();
}

function assertNonce(value: string): void {
  assert(/^[0-9a-f]{64}$/i.test(value), "conversion attempt nonce");
}

function assertHash(value: string, label: string): void {
  assert(/^(?:0x)?[0-9a-f]{64}$/i.test(value), label);
}

function assertBinary64(value: string): void {
  assert(/^[0-9a-f]{16}$/i.test(value), "conversion binary64");
}
