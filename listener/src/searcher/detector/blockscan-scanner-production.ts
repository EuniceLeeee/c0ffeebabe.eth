import type { AdapterRuntimeSnapshot } from "../adapter-runtime-coordinator.js";
import { createIncrementalBlockScanEthViewBuilder, effectiveEthPricing } from "../blockscan-eth-view.js";
import { effectiveAmountReferences, effectiveEnumerationMids, effectiveHistoricalRankingHint, type EffectiveMidSnapshot } from "../blockscan-effective-mid.js";
import type { BlockScanStateSnapshot } from "../blockscan-state-coordinator.js";
import type { TokenEdge } from "../planner/token-graph.js";
import {
  blockScanEdgeKey,
  deterministicHash,
  exactSetHash,
  type VerifiedGraphView,
} from "../venues/blockscan-state-capability.js";
import {
  blockScanSelectionProvenance,
  scanBlockStateFromResolvedMids,
  type BlockScanCoreConfig,
  type BlockScanOutcome,
  type BlockScanScanTiming,
  type ResolvedBlockScanQuote,
  type NaturalBlockScanSelectionProvenance,
} from "./blockscan-scanner-core.js";

export interface ProductionBlockScanInput {
  /** Current-block blockscan lane with funded amount trials and independent final simulation only. */
  readonly allowHistoricalRankingHints?: boolean;
  /**
   * The only production state input. Graph, prices and funding were published
   * together by AdapterRuntimeCoordinator for one canonical generation.
   */
  readonly runtime: AdapterRuntimeSnapshot;
  readonly swapTouched: Set<string> | null;
  readonly cfg: BlockScanCoreConfig;
  readonly routeEligible?: (edges: readonly TokenEdge[]) => boolean;
  readonly rankedRouteEligible?: Parameters<typeof scanBlockStateFromResolvedMids>[0]["rankedRouteEligible"];
  readonly edgeEligible?: (edge: TokenEdge) => boolean;
  readonly poolRevertExcludedEdge?: (edge: TokenEdge) => boolean;
  readonly captureCoarseEnumeration?: boolean;
  readonly onTiming?: (timing: ProductionBlockScanTiming) => void;
}

export interface ProductionBlockScanTiming {
  readonly sourceBlock: number;
  readonly validationMs: number;
  readonly pricingValidation: AtomicBlockScanPricingValidationTiming | null;
  readonly viewMs: number;
  readonly edgeSelectionMs: number;
  readonly scan: BlockScanScanTiming | null;
  readonly resultMs: number;
  readonly totalMs: number;
}

export interface ProductionBlockScanOutcome extends BlockScanOutcome {
  readonly historicalRankingEdgeIds?: ReadonlySet<string>;
  /** Current independently acquired input references, never ranking-hint amounts. */
  readonly historicalStartTrialAmounts?: ReadonlyMap<string,bigint>;
  readonly completeness: "complete" | "degraded";
  readonly incompleteFamilyIds: readonly string[];
  readonly selectionMode: "production";
  readonly forcedSelectionCount: number;
  readonly selectionProvenance: NaturalBlockScanSelectionProvenance;
}

export interface AtomicBlockScanPricingValidationTiming {
  readonly identity: number;
  readonly coverage: number;
  readonly indexes: number;
  readonly mids: number;
  readonly graphDigest: number;
  readonly total: number;
}

const screenQuoteCache = new WeakMap<object, WeakMap<TokenEdge, ResolvedBlockScanQuote>>();
const buildIncrementalScreenEthView = createIncrementalBlockScanEthViewBuilder();
const scannerEdgeMetaCache = new WeakMap<readonly TokenEdge[], readonly {
  readonly edge: TokenEdge;
  readonly id: string;
  readonly tokenIn: string;
  readonly startupSim: boolean;
  readonly scannerConsumes: boolean;
}[]>();

function getScannerEdgeMeta(edges: readonly TokenEdge[]) {
  const frozen = Object.isFrozen(edges);
  if (frozen) {
    const hit = scannerEdgeMetaCache.get(edges);
    if (hit) return hit;
  }
  const built = edges.map(edge => ({
    edge,
    id: blockScanEdgeKey(edge),
    tokenIn: edge.tokenIn.toLowerCase(),
    startupSim: edge.executionVerification === "startup-simulation",
    scannerConsumes: scannerConsumesEdge(edge),
  }));
  if (frozen && edges.every(e => Object.isFrozen(e))) scannerEdgeMetaCache.set(edges, built);
  return built;
}

/** Private to opportunity screening: never write into the shared current quote map. */
export function createBlockScanHistoricalScreen(effective:EffectiveMidSnapshot|undefined,
  edges:readonly TokenEdge[],current:ReadonlyMap<string,ResolvedBlockScanQuote>){
  let mids:Map<string,ResolvedBlockScanQuote>|undefined;
  const hinted=new Set<string>();
  const startAmounts=new Map<string,bigint>();
  const references=effective&&effectiveAmountReferences(effective);
  if(effective?.complete) {
    const meta = getScannerEdgeMeta(edges);
    const validRefTokens = new Map<string, bigint | null>();
    const resolveRefStart = (tokenIn: string): bigint | null => {
      const cached = validRefTokens.get(tokenIn);
      if (cached !== undefined) return cached;
      const ref = references?.get(tokenIn);
      let out: bigint | null = null;
      if (ref && ref.amountIn > 0n && (ref.path.length
          ? ref.path.at(-1)!.tokenOut === tokenIn && ref.path.at(-1)!.amountOut === ref.amountIn &&
            ref.path.every(row => {
              const q = current.get(row.edgeId), live = effective.rows.get(row.edgeId);
              return live && q && live.tokenIn === row.tokenIn && live.tokenOut === row.tokenOut &&
                live.quotedAt?.number === effective.source.number && live.quotedAt.generation === effective.source.generation &&
                live.quotedAt.hash.toLowerCase() === effective.source.hash.toLowerCase() &&
                row.quotedAt?.number === effective.source.number && row.quotedAt.generation === effective.source.generation &&
                row.quotedAt.hash.toLowerCase() === effective.source.hash.toLowerCase() &&
                q.quoteAmountIn === row.amountIn && q.quoteAmountOut === row.amountOut;
            })
          : ref.amountIn === effective.referenceWethInput)) {
        out = ref.amountIn;
      }
      validRefTokens.set(tokenIn, out);
      return out;
    };
    for (let i = 0; i < meta.length; i++) {
      const { edge, id, tokenIn, startupSim } = meta[i]!;
      if(!startupSim || current.has(id))continue;
      const hint=effectiveHistoricalRankingHint(effective,edge);if(!hint)continue;
      let quote:ResolvedBlockScanQuote|undefined;
      if(Object.isFrozen(hint)&&Object.isFrozen(edge)){
        let byEdge=screenQuoteCache.get(hint);
        quote=byEdge?.get(edge);
        if(!quote){
          quote=Object.freeze({kind:"external-swap",pool:hint.instanceKey,
            edges:Object.freeze([edge]),mid:hint.effectiveMid,feeBps:0,depthProxy:0,
            quoteAmountIn:hint.amountIn,quoteAmountOut:hint.amountOut});
          if(!byEdge){byEdge=new WeakMap();screenQuoteCache.set(hint,byEdge);}
          byEdge.set(edge,quote);
        }
      } else {
        quote=Object.freeze({kind:"external-swap",pool:hint.instanceKey,
          edges:Object.freeze([edge]),mid:hint.effectiveMid,feeBps:0,depthProxy:0,
          quoteAmountIn:hint.amountIn,quoteAmountOut:hint.amountOut});
      }
      (mids??=new Map(current)).set(id,quote);
      hinted.add(id);
      const refStart = resolveRefStart(tokenIn);
      if (refStart !== null) startAmounts.set(id, refStart);
    }
  }
  return mids?{mids,hinted,startAmounts}:undefined;
}

/**
 * Strict production boundary: callers cannot independently supply a graph,
 * cache, block number or partial mid map.
 */
export function detectProductionBlockScanOpportunities(
  input: ProductionBlockScanInput,
): ProductionBlockScanOutcome {
  const started = performance.now();
  let pricingValidation: AtomicBlockScanPricingValidationTiming | null = null;
  let scanTiming: BlockScanScanTiming | null = null;
  assertAtomicRuntime(input.runtime, timing => { pricingValidation = timing; });
  const validated = performance.now();
  const current = effectiveEthPricing(input.runtime.pricing, input.cfg.ethSignalPairsPerToken, input.cfg.allowRepeatedPools);
  const screen=input.allowHistoricalRankingHints
    ?createBlockScanHistoricalScreen(input.runtime.pricing.effectiveMids,input.runtime.graph.edges,current.mids):undefined;
  // Never publish this working view into effective pricing/valuation caches.
  const eth=screen?{mids:screen.mids,view:buildIncrementalScreenEthView(
    {number:input.runtime.sourceBlock,hash:input.runtime.sourceBlockHash,generation:input.runtime.generation},
    input.runtime.graph.edges,screen.mids,
    input.cfg.ethSignalPairsPerToken,input.cfg.allowRepeatedPools,current.view)}:current;
  const viewed = performance.now();
  const resolvedEdgeKeys = new Set(
    input.runtime.pricing.coverage.resolvedEdgeKeys,
  );
  const edgeMeta = getScannerEdgeMeta(input.runtime.graph.edges);
  const edges: TokenEdge[] = [];
  for (let i = 0; i < edgeMeta.length; i++) {
    const m = edgeMeta[i]!;
    if (!m.scannerConsumes || resolvedEdgeKeys.has(m.id) || screen?.hinted.has(m.id)) {
      edges.push(m.edge);
    }
  }
  const selected = performance.now();
  const outcome = scanBlockStateFromResolvedMids({
    edges,
    sourceBlock: input.runtime.sourceBlock,
    swapTouched: input.swapTouched,
    cfg: input.cfg,
    mids: eth.mids,
    ethView: eth.view,
    ...(screen?{firstEdgeTrialAmount:(edge:TokenEdge,quoted:bigint)=>{
      const id=blockScanEdgeKey(edge);
      return screen.hinted.has(id)?(screen.startAmounts.get(id)??null):quoted;
    }}:{}),
    routeEligible: input.routeEligible,
    rankedRouteEligible: input.rankedRouteEligible,
    edgeEligible: input.edgeEligible,
    poolRevertExcludedEdge: input.poolRevertExcludedEdge,
    captureCoarseEnumeration: input.captureCoarseEnumeration,
    onTiming: timing => { scanTiming = timing; },
  });
  const scanned = performance.now();
  const result = Object.freeze({
    ...outcome,
    ...(screen?{historicalRankingEdgeIds:screen.hinted,historicalStartTrialAmounts:screen.startAmounts}:{}),
    completeness: input.runtime.completeness,
    incompleteFamilyIds: input.runtime.pricing.incompleteFamilyIds,
    selectionMode: "production" as const,
    forcedSelectionCount: outcome.selection.forcedSelectionCount,
    selectionProvenance: blockScanSelectionProvenance(
      outcome,
      input.cfg.maxCandidates,
    ),
  });
  const finished = performance.now();
  const timing: ProductionBlockScanTiming = {
    sourceBlock: input.runtime.sourceBlock,
    validationMs: validated - started, pricingValidation,
    viewMs: viewed - validated, edgeSelectionMs: selected - viewed,
    scan: scanTiming, resultMs: finished - scanned, totalMs: finished - started,
  };
  try {
    input.onTiming?.(timing);
    if (process.env.SEARCHER_STATE_LATENCY_DIAGNOSTICS === "1") {
      console.log(`[searcher/blockscan-enumeration-timing] ${JSON.stringify(timing)}`);
    }
  } catch { /* Observability must not affect candidate selection. */ }
  return result;
}

export function assertAtomicBlockScanRuntime(
  runtime: AdapterRuntimeSnapshot,
): void {
  assertAtomicRuntime(runtime);
}

function assertAtomicRuntime(runtime: AdapterRuntimeSnapshot,
  onPricingTiming?: (timing: AtomicBlockScanPricingValidationTiming) => void): void {
  const { graph, pricing, funding } = runtime;
  assertAtomicBlockScanPricingView(graph, pricing, onPricingTiming);
  assertEqualNumber("generation", [
    runtime.generation,
    graph.generation,
    funding.generation,
  ]);
  assertEqualNumber("source block", [
    runtime.sourceBlock,
    graph.sourceBlock,
    funding.sourceBlock,
  ]);
  assertEqualString("source block hash", [
    runtime.sourceBlockHash,
    graph.sourceBlockHash,
    funding.sourceBlockHash,
  ]);
  if (runtime.completeness === "complete") {
    assertCompleteCoverage("state keys", pricing.coverage.unresolvedStateKeys);
    assertCompleteCoverage("read keys", pricing.coverage.unresolvedReadKeys);
    assertCompleteCoverage("edge keys", pricing.coverage.unresolvedEdgeKeys);
    if (pricing.incompleteFamilyIds.length > 0) {
      throw new Error("complete runtime contains incomplete pricing families");
    }
  } else if (
    pricing.incompleteFamilyIds.length === 0 &&
    funding.coverage.unresolvedKeys.length === 0
  ) {
    throw new Error("degraded runtime has no incomplete pricing family");
  }

  const fundingCoverage = funding.coverage;
  assertCoverageIntegrity(
    "funding keys",
    fundingCoverage.expectedKeys,
    fundingCoverage.resolvedKeys,
    fundingCoverage.unresolvedKeys,
    fundingCoverage.expectedHash,
    fundingCoverage.resolvedHash,
    fundingCoverage.unresolvedHash,
  );
  if (
    funding.coverageByFundingId.size !== fundingCoverage.expectedKeys.length ||
    funding.freshnessByFundingId.size !== fundingCoverage.resolvedKeys.length ||
    fundingCoverage.expectedKeys.some((fundingId) => {
      const expectedStatus = fundingCoverage.resolvedKeys.includes(fundingId)
        ? "resolved"
        : "unresolved";
      return funding.coverageByFundingId.get(fundingId)?.status !== expectedStatus;
    }) ||
    fundingCoverage.resolvedKeys.some(
      (fundingId) => !funding.freshnessByFundingId.has(fundingId),
    )
  ) {
    throw new Error("production scanner rejected funding coverage/freshness");
  }
  for (const source of funding.sources.values()) {
    if (
      !source.fundingId ||
      !fundingCoverage.resolvedKeys.includes(source.fundingId)
    ) {
      throw new Error("production scanner rejected unresolved funding source");
    }
  }
  if (runtime.completeness === "complete") {
    assertCompleteCoverage("funding keys", fundingCoverage.unresolvedKeys);
  }
}

/**
 * Shared strict boundary for normal source-N production and the branded
 * N-1 coarse-only lane. It validates graph/pricing atomicity without
 * accepting or constructing a mixed-source funding snapshot.
 */
export function assertAtomicBlockScanPricingView(
  graph: VerifiedGraphView,
  pricing: BlockScanStateSnapshot,
  onTiming?: (timing: AtomicBlockScanPricingValidationTiming) => void,
): void {
  const startedAtMs = Date.now();
  assertEqualNumber("generation", [
    graph.generation,
    pricing.generation,
    pricing.graph.generation,
  ]);
  assertEqualNumber("source block", [
    graph.sourceBlock,
    pricing.sourceBlock,
    pricing.graph.sourceBlock,
  ]);
  assertEqualString("source block hash", [
    graph.sourceBlockHash,
    pricing.sourceBlockHash,
    pricing.graph.sourceBlockHash,
  ]);
  assertEqualString("graph id", [graph.id, pricing.graph.id]);
  assertEqualString("graph edge hash", [
    graph.orderedEdgeHash,
    pricing.graph.orderedEdgeHash,
  ]);
  assertEqualString("graph metadata hash", [
    graph.metadataHash,
    pricing.graph.metadataHash,
  ]);
  assertEqualString("graph ownership hash", [
    graph.ownershipHash,
    pricing.graph.ownershipHash,
  ]);
  const identityFinishedAtMs = Date.now();

  const coverage = pricing.coverage;
  const cachedCoverage = getVerifiedFrozenCoverage(coverage);
  let readSets: { resolved: Set<string> };
  let edgeSets: { expected: Set<string>; resolved: Set<string>; unavailable: Set<string> };
  if (cachedCoverage) {
    readSets = { resolved: cachedCoverage.readResolved };
    edgeSets = {
      expected: new Set(coverage.expectedEdgeKeys),
      resolved: cachedCoverage.edgeResolved,
      unavailable: cachedCoverage.edgeUnavailable,
    };
  } else {
    assertCoverageIntegrity(
      "state keys",
      coverage.expectedStateKeys,
      coverage.resolvedStateKeys,
      coverage.unresolvedStateKeys,
      coverage.expectedStateKeyHash,
      coverage.resolvedStateKeyHash,
      coverage.unresolvedStateKeyHash,
    );
    const computedReads = assertCoverageIntegrity(
      "read keys",
      coverage.expectedReadKeys,
      coverage.resolvedReadKeys,
      coverage.unresolvedReadKeys,
      coverage.expectedReadKeyHash,
      coverage.resolvedReadKeyHash,
      coverage.unresolvedReadKeyHash,
    );
    const computedEdges = assertCoverageIntegrity(
      "edge keys",
      coverage.expectedEdgeKeys,
      coverage.resolvedEdgeKeys,
      coverage.unresolvedEdgeKeys,
      coverage.expectedEdgeKeyHash,
      coverage.resolvedEdgeKeyHash,
      coverage.unresolvedEdgeKeyHash,
      coverage.unavailableEdgeKeys,
      coverage.unavailableEdgeKeyHash,
    );
    rememberVerifiedFrozenCoverage(coverage, computedReads.resolved, computedEdges.resolved, computedEdges.unavailable);
    readSets = computedReads;
    edgeSets = computedEdges;
  }
  const coverageFinishedAtMs = Date.now();

  const expectedEdgeSet = getFrozenArraySet(coverage.expectedEdgeKeys);
  const resolvedReadSet = readSets.resolved;
  const resolvedEdgeSet = edgeSets.resolved;
  const unavailableEdgeSet = edgeSets.unavailable;
  if (
    pricing.coverageByReadKey.size !== coverage.expectedReadKeys.length ||
    pricing.freshnessByReadKey.size !== coverage.resolvedReadKeys.length ||
    coverage.expectedReadKeys.some((readKey) => {
      const expectedStatus = resolvedReadSet.has(readKey)
        ? "resolved"
        : "unresolved";
      return pricing.coverageByReadKey.get(readKey)?.status !== expectedStatus;
    }) ||
    coverage.resolvedReadKeys.some(
      (readKey) => !pricing.freshnessByReadKey.has(readKey),
    )
  ) {
    throw new Error(
      "production scanner rejected incomplete read-key coverage/freshness",
    );
  }
  if (
    pricing.coverageByEdgeKey.size !== coverage.expectedEdgeKeys.length ||
    coverage.expectedEdgeKeys.some((edgeKey) => {
      const expectedStatus = resolvedEdgeSet.has(edgeKey)
        ? "resolved"
        : unavailableEdgeSet.has(edgeKey)
        ? "rejected"
        : "unresolved";
      const actual = pricing.coverageByEdgeKey.get(edgeKey);
      return actual?.status !== expectedStatus ||
        expectedStatus === "rejected" &&
          (actual?.status !== "rejected" || actual.reason.trim().length === 0);
    })
  ) {
    throw new Error(
      "production scanner rejected incomplete edge availability coverage",
    );
  }
  const indexesFinishedAtMs = Date.now();
  const rawSource = pricing.rawMidSource;
  if (rawSource !== undefined && (
    !Number.isSafeInteger(rawSource.number) || rawSource.number < 0 ||
    !Number.isSafeInteger(rawSource.generation) || rawSource.generation < 0 ||
    !/^0x[0-9a-f]{64}$/i.test(rawSource.hash) ||
    rawSource.number > pricing.sourceBlock || rawSource.generation > pricing.generation ||
    (rawSource.number === pricing.sourceBlock &&
      rawSource.hash.toLowerCase() !== pricing.sourceBlockHash.toLowerCase())
  )) throw new Error("production scanner rejected invalid startup raw reference source");
  // New publications explicitly separate old sizing marks from current amounts.
  // Validate current coverage against effective quotes, never the startup map.
  const midKeys = [...(rawSource === undefined ? pricing.mids : effectiveEnumerationMids(pricing)).keys()];
  if (
    midKeys.length !== resolvedEdgeSet.size ||
    midKeys.some((edgeKey) => !resolvedEdgeSet.has(edgeKey))
  ) {
    throw new Error(
      "production scanner rejected non-exact atomic mid coverage",
    );
  }
  const midsFinishedAtMs = Date.now();
  const cachedDigest = Object.isFrozen(graph.edges) ? verifiedGraphDigestCache.get(graph.edges) : undefined;
  if (
    cachedDigest &&
    cachedDigest.stateKeyMap === pricing.pricingStateKeyByEdgeKey &&
    cachedDigest.expectedEdgeKeyHash === coverage.expectedEdgeKeyHash &&
    cachedDigest.scannerEdgeCount === graph.scannerEdgeCount &&
    cachedDigest.scannerEdgeKeyHash === graph.scannerEdgeKeyHash
  ) {
    // Static frozen graph topology & pricing state key index already proved exact set equality.
  } else {
    // Coverage's expected hash has already been verified above. Prove exact set
    // equality against the actual graph, including duplicate rejection, instead
    // of sorting/hashing that same set again. Never trust the graph header alone.
    const mutableExpected = new Set(coverage.expectedEdgeKeys);
    let pricingEdgeCount = 0;
    const scannerEdgeKeys: string[] = [];
    let invalidPricingEdge = false;
    for (const edge of graph.edges) {
      const scanner = scannerConsumesEdge(edge);
      const key = blockScanEdgeKey(edge);
      if (scanner) scannerEdgeKeys.push(key);
      if (!scanner && !pricing.pricingStateKeyByEdgeKey?.has(key)) continue;
      // Consume only this invocation's validation set, never snapshot data.
      // Missing membership also detects a duplicate after its first occurrence.
      if (!mutableExpected.delete(key)) invalidPricingEdge = true;
      pricingEdgeCount++;
    }
    const exactPricingGraph = !invalidPricingEdge && mutableExpected.size === 0;
    // Scanner keys are a subset of pricing keys. Equal cardinality after exact
    // set validation proves equality; mixed graphs retain their own scanner hash.
    const scannerHash = exactPricingGraph && scannerEdgeKeys.length === pricingEdgeCount
      ? coverage.expectedEdgeKeyHash : exactSetHash(scannerEdgeKeys);
    if (
      !exactPricingGraph ||
      scannerEdgeKeys.length !== graph.scannerEdgeCount ||
      scannerHash !== graph.scannerEdgeKeyHash
    ) {
      throw new Error(
        "production scanner missing current-N mid or pricing coverage does not exactly match its graph",
      );
    }
    if (Object.isFrozen(graph.edges)) {
      verifiedGraphDigestCache.set(graph.edges, {
        stateKeyMap: pricing.pricingStateKeyByEdgeKey,
        expectedEdgeKeyHash: coverage.expectedEdgeKeyHash,
        scannerEdgeCount: graph.scannerEdgeCount,
        scannerEdgeKeyHash: graph.scannerEdgeKeyHash,
      });
    }
  }
  const finishedAtMs = Date.now();
  onTiming?.(Object.freeze({
    identity: Math.max(0, identityFinishedAtMs - startedAtMs),
    coverage: Math.max(0, coverageFinishedAtMs - identityFinishedAtMs),
    indexes: Math.max(0, indexesFinishedAtMs - coverageFinishedAtMs),
    mids: Math.max(0, midsFinishedAtMs - indexesFinishedAtMs),
    graphDigest: Math.max(0, finishedAtMs - midsFinishedAtMs),
    total: Math.max(0, finishedAtMs - startedAtMs),
  }));
}

function scannerConsumesEdge(edge: {
  readonly slotKind: string;
  readonly leavesStandingPosition: boolean;
}): boolean {
  return edge.slotKind === "swap" ||
    (edge.slotKind === "protocol" && !edge.leavesStandingPosition);
}

function assertCoverageIntegrity(
  label: string,
  expected: readonly string[],
  resolved: readonly string[],
  unresolved: readonly string[],
  expectedHash: string,
  resolvedHash: string,
  unresolvedHash: string,
  unavailable: readonly string[] = [],
  unavailableHash: string = exactSetHash([]),
): { expected: Set<string>; resolved: Set<string>; unavailable: Set<string> } {
  if (
    canonicalSetHash(label, expected) !== expectedHash ||
    canonicalSetHash(label, resolved) !== resolvedHash ||
    canonicalSetHash(label, unresolved) !== unresolvedHash ||
    canonicalSetHash(label, unavailable) !== unavailableHash
  ) {
    throw new Error(`production scanner rejected invalid ${label} coverage hash`);
  }
  const expectedSet = getFrozenArraySet(expected);
  const resolvedSet = new Set(resolved);
  const unresolvedSet = new Set(unresolved);
  const unavailableSet = getFrozenArraySet(unavailable);
  if (
    resolved.some(
      (key) => unresolvedSet.has(key) || unavailableSet.has(key),
    ) ||
    unresolved.some((key) => unavailableSet.has(key)) ||
    (resolvedSet.size + unresolvedSet.size + unavailableSet.size !== expectedSet.size &&
      expected.some(
        (key) =>
          !resolvedSet.has(key) &&
          !unresolvedSet.has(key) &&
          !unavailableSet.has(key),
      )) ||
    resolved.some((key) => !expectedSet.has(key)) ||
    unresolved.some((key) => !expectedSet.has(key)) ||
    unavailable.some((key) => !expectedSet.has(key))
  ) {
    throw new Error(`production scanner rejected non-partitioned ${label} coverage`);
  }
  return { expected: expectedSet as Set<string>, resolved: resolvedSet, unavailable: unavailableSet as Set<string> };
}

const frozenArraySetCache = new WeakMap<readonly string[], ReadonlySet<string>>();
function getFrozenArraySet(values: readonly string[]): ReadonlySet<string> {
  if (!Object.isFrozen(values)) return new Set(values);
  let cached = frozenArraySetCache.get(values);
  if (!cached) {
    cached = new Set(values);
    frozenArraySetCache.set(values, cached);
  }
  return cached;
}

const verifiedGraphDigestCache = new WeakMap<readonly TokenEdge[], {
  readonly stateKeyMap: BlockScanStateSnapshot["pricingStateKeyByEdgeKey"];
  readonly expectedEdgeKeyHash: string;
  readonly scannerEdgeCount: number;
  readonly scannerEdgeKeyHash: string;
}>();
const frozenSetHashCache = new WeakMap<readonly string[], string>();
const verifiedCoverageCache = new WeakMap<object, {
  seal: string;
  readResolved: Set<string>;
  edgeResolved: Set<string>;
  edgeUnavailable: Set<string>;
}>();

function coverageSeal(c: BlockScanStateSnapshot["coverage"]): string | undefined {
  if (
    !Object.isFrozen(c) ||
    !Object.isFrozen(c.expectedStateKeys) || !Object.isFrozen(c.resolvedStateKeys) || !Object.isFrozen(c.unresolvedStateKeys) ||
    !Object.isFrozen(c.expectedReadKeys) || !Object.isFrozen(c.resolvedReadKeys) || !Object.isFrozen(c.unresolvedReadKeys) ||
    !Object.isFrozen(c.expectedEdgeKeys) || !Object.isFrozen(c.resolvedEdgeKeys) || !Object.isFrozen(c.unresolvedEdgeKeys) ||
    !Object.isFrozen(c.unavailableEdgeKeys)
  ) {
    return undefined;
  }
  return `${c.expectedStateKeyHash}:${c.resolvedStateKeyHash}:${c.unresolvedStateKeyHash}:` +
    `${c.expectedReadKeyHash}:${c.resolvedReadKeyHash}:${c.unresolvedReadKeyHash}:` +
    `${c.expectedEdgeKeyHash}:${c.resolvedEdgeKeyHash}:${c.unresolvedEdgeKeyHash}:${c.unavailableEdgeKeyHash}`;
}

function getVerifiedFrozenCoverage(c: BlockScanStateSnapshot["coverage"]) {
  const seal = coverageSeal(c);
  if (!seal) return undefined;
  const hit = verifiedCoverageCache.get(c);
  return hit?.seal === seal ? hit : undefined;
}

function rememberVerifiedFrozenCoverage(
  c: BlockScanStateSnapshot["coverage"],
  readResolved: Set<string>,
  edgeResolved: Set<string>,
  edgeUnavailable: Set<string>,
): void {
  const seal = coverageSeal(c);
  if (!seal) return;
  verifiedCoverageCache.set(c, { seal, readResolved, edgeResolved, edgeUnavailable });
}

/**
 * Coordinator coverage is already frozen in canonical sort order. Hash it in
 * one pass after proving that order. Legacy/fixture inputs retain exact set
 * semantics through the original sort/dedupe hash path.
 */
function canonicalSetHash(label: string, values: readonly string[]): string {
  const frozen = Object.isFrozen(values);
  if (frozen) {
    const cached = frozenSetHashCache.get(values);
    if (cached !== undefined) return cached;
  }
  let canonical = true;
  for (let index = 1; index < values.length; index++) {
    const previous = values[index - 1];
    const current = values[index];
    if (previous === current) {
      throw new Error(`production scanner rejected duplicate ${label} coverage`);
    }
    if (previous > current) canonical = false;
  }
  if (canonical) {
    const digest = deterministicHash(values);
    if (frozen) frozenSetHashCache.set(values, digest);
    return digest;
  }
  if (values.length !== new Set(values).size) {
    throw new Error(`production scanner rejected duplicate ${label} coverage`);
  }
  const digest = exactSetHash(values);
  if (frozen) frozenSetHashCache.set(values, digest);
  return digest;
}

function assertCompleteCoverage(
  label: string,
  unresolved: readonly string[],
): void {
  if (unresolved.length > 0) {
    throw new Error(`production scanner rejected incomplete ${label} coverage`);
  }
}

function assertEqualNumber(label: string, values: readonly number[]): void {
  if (values.some((value) => value !== values[0])) {
    throw new Error(`production scanner ${label} mismatch: ${values.join(",")}`);
  }
}

function assertEqualString(label: string, values: readonly string[]): void {
  const normalized = values.map((value) => value.toLowerCase());
  if (normalized.some((value) => value !== normalized[0])) {
    throw new Error(`production scanner ${label} mismatch: ${values.join(",")}`);
  }
}
