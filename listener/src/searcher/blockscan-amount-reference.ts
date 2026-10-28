import type { BlockScanOpportunity } from "./detector/detector.js";
import type { BlockScanStateSnapshot } from "./blockscan-state-coordinator.js";
import { nextBlockBaseFee } from "./ev-evaluator.js";
import { blockScanEdgeKey, type BlockSource } from "./venues/blockscan-state-capability.js";
import { edgeInstanceKey } from "./venues/route-instance-identity.js";
import type { StrictPricingPublication } from "./strict-current-runtime-coordinator.js";
import type { RouteVenueMid } from "./venues/mid-readers.js";
import type { TokenEdge } from "./planner/token-graph.js";

export interface RawTokenRate {
  /** WETH wei per input-token raw unit; token decimals must NOT be applied again. */
  readonly num: bigint;
  readonly den: bigint;
}

interface ReferenceHeader {
  readonly number: number;
  readonly hash: string | null;
  readonly parentHash: string;
  readonly baseFeePerGas?: bigint | null;
  readonly gasUsed?: bigint;
  readonly gasLimit?: bigint;
}

type PricingReference = Pick<BlockScanStateSnapshot,
  "sourceBlock" | "sourceBlockHash" | "generation" | "graph" | "mids" | "coverage">;

/** Converts the decimal representation of a finite Number without fixed-scale underflow. */
function ratio(value: number): RawTokenRate | null {
  if (!Number.isFinite(value) || value <= 0) return null;
  const [mantissa, exponent = "0"] = value.toString().toLowerCase().split("e");
  const [whole, fraction = ""] = mantissa!.split(".");
  const digits = BigInt(whole! + fraction);
  const scale = fraction.length - Number(exponent);
  return scale >= 0
    ? { num: digits, den: 10n ** BigInt(scale) }
    : { num: digits * 10n ** BigInt(-scale), den: 1n };
}

const compareRates = (a: RawTokenRate, b: RawTokenRate): number => {
  const delta = a.num * b.den - b.num * a.den;
  return delta < 0n ? -1 : delta > 0n ? 1 : 0;
};
const multiply = (a: RawTokenRate, b: RawTokenRate): RawTokenRate =>
  ({ num: a.num * b.num, den: a.den * b.den });
/** Highest available directed conversion value; not a final-EV oracle. */
const bestRate = (rates: readonly RawTokenRate[]): RawTokenRate =>
  rates.reduce((best, rate) => compareRates(rate, best) > 0 ? rate : best);

/** Approximate marks for sizing only, never trusted final-EV valuation. No RPC. */
export function tokenToWethReferences(
  pricing: { graph: { edges: readonly TokenEdge[] };
    mids: ReadonlyMap<string, { mid: number; feeBps: number }>;
    coverage: { resolvedEdgeKeys: readonly string[] } },
  weth: string,
): ReadonlyMap<string, RawTokenRate> {
  const resolved = new Set(pricing.coverage.resolvedEdgeKeys);
  return tokenToWethReferencesFromRates(pricing.graph.edges, key => {
    if (!resolved.has(key)) return null;
    const mid = pricing.mids.get(key);
    if (!mid || !Number.isFinite(mid.feeBps) || mid.feeBps < 0 || mid.feeBps >= 10_000) return null;
    const rate = ratio(mid.mid);
    const residualFee = ratio(10_000 - mid.feeBps);
    return rate && residualFee ? multiply(rate, { num: residualFee.num, den: residualFee.den * 10_000n }) : null;
  }, weth);
}

/** Shared directed valuation policy. The caller supplies validated positive raw-unit ratios;
 * exact amount quotes never need a Number conversion or a second fee adjustment. */
export function tokenToWethReferencesFromRates(
  edges: readonly TokenEdge[],
  rateFor: (edgeKey: string) => RawTokenRate | null | undefined,
  weth: string,
): ReadonlyMap<string, RawTokenRate> {
  const pairs = new Map<string, { from: string; to: string; instances: Map<string, RawTokenRate> }>();
  for (const edge of edges) {
    if (edge.leavesStandingPosition) continue;
    const rate = rateFor(blockScanEdgeKey(edge));
    if (!rate) continue;
    const from = edge.tokenIn.toLowerCase();
    const to = edge.tokenOut.toLowerCase();
    if (from === to) continue;
    const pairKey = `${from}|${to}`;
    let pair = pairs.get(pairKey);
    if (!pair) {
      pair = { from, to, instances: new Map() };
      pairs.set(pairKey, pair);
    }
    const instance = edgeInstanceKey(edge);
    const previous = pair.instances.get(instance);
    // Keep the best available execution variant of each logical venue.
    if (!previous || compareRates(rate, previous) > 0) pair.instances.set(instance, rate);
  }
  const directed = [...pairs.values()].map(pair => ({
    from: pair.from, to: pair.to, rate: bestRate([...pair.instances.values()]),
  }));
  const marks = new Map<string, RawTokenRate>([[weth.toLowerCase(), { num: 1n, den: 1n }]]);
  // Shortest directed paths only. Each layer reads the completed prior layer,
  // so cycles cannot amplify marks and no reverse edge is invented.
  for (let hop = 0; hop < 3; hop++) {
    const candidates = new Map<string, RawTokenRate[]>();
    for (const pair of directed) {
      if (marks.has(pair.from)) continue;
      const tail = marks.get(pair.to);
      if (!tail) continue;
      const values = candidates.get(pair.from) ?? [];
      values.push(multiply(pair.rate, tail));
      candidates.set(pair.from, values);
    }
    for (const [token, values] of candidates) marks.set(token, bestRate(values));
    if (candidates.size === 0) break;
  }
  return marks;
}

/** Consumer-owned index of validated amount ratios. No raw mids, fees or RPC.
 * Topology is fixed for this index; callers rebuild it when topology changes. */
export class DirectedRateReferenceIndex {
  private readonly pairs = new Map<string, {
    from: string; to: string; keys: { key: string; instance: string; order: number }[];
    rate?: RawTokenRate; order: number;
  }>();
  private readonly pairByEdge = new Map<string, string>();
  private readonly outgoing = new Map<string, string[]>();
  private readonly incoming = new Map<string, Set<string>>();
  private readonly rates = new Map<string, RawTokenRate>();
  private readonly layers: Map<string, RawTokenRate>[];
  private view: ReadonlyMap<string, RawTokenRate>;
  private readonly weth: string;

  constructor(edges: readonly TokenEdge[], rateFor: (key: string) => RawTokenRate | undefined, weth: string) {
    this.weth = weth.toLowerCase();
    this.layers = Array.from({ length: 4 }, () => new Map([[this.weth, { num: 1n, den: 1n }]]));
    for (const [order, edge] of edges.entries()) {
      const from = edge.tokenIn.toLowerCase(), to = edge.tokenOut.toLowerCase(), key = blockScanEdgeKey(edge);
      if (edge.leavesStandingPosition || from === to || this.pairByEdge.has(key)) continue;
      const id = `${from}|${to}`;
      let pair = this.pairs.get(id);
      if (!pair) {
        pair = { from, to, keys: [], order };
        this.pairs.set(id, pair);
        const outgoing = this.outgoing.get(from) ?? [];
        outgoing.push(id); this.outgoing.set(from, outgoing);
        const incoming = this.incoming.get(to) ?? new Set<string>();
        incoming.add(from); this.incoming.set(to, incoming);
      }
      pair.keys.push({ key, instance: edgeInstanceKey(edge), order });
      this.pairByEdge.set(key, id);
      const rate = rateFor(key);
      if (rate) this.rates.set(key, rate);
    }
    for (const id of this.pairs.keys()) this.reprice(id);
    for (let hop = 1; hop <= 3; hop++) for (const token of this.outgoing.keys()) {
      const value = this.mark(token, hop);
      if (value) this.layers[hop]!.set(token, value);
    }
    this.view = new Map(this.layers[3]);
  }

  get marks(): ReadonlyMap<string, RawTokenRate> { return this.view; }

  update(changes: ReadonlyMap<string, RawTokenRate | undefined>, mode: "direct" | "dependencies") {
    const pairs = new Set<string>(), removedSources = new Set<string>();
    for (const [key, rate] of changes) {
      const id = this.pairByEdge.get(key);
      if (!id) continue;
      if (!rate && this.rates.has(key)) removedSources.add(this.pairs.get(id)!.from);
      if (rate) this.rates.set(key, rate); else this.rates.delete(key);
      pairs.add(id);
    }
    const sources = new Set<string>();
    for (const id of pairs) {
      const pair = this.pairs.get(id)!;
      const prior = pair.rate, order = pair.order;
      this.reprice(id);
      if (!sameExactRate(prior, pair.rate) || order !== pair.order) sources.add(pair.from);
    }
    // Even direct mode propagates loss of a usable edge. A cached conversion
    // path must not survive a run exclusion / failed quote / removal.
    const forced = new Set(removedSources);
    let frontier = removedSources;
    for (let hop = 1; hop < 3; hop++) {
      const next = new Set<string>();
      for (const token of frontier) for (const parent of this.incoming.get(token) ?? []) {
        forced.add(parent); next.add(parent);
      }
      frontier = next;
    }
    let changed = new Set<string>(), recomputedTokens = 0;
    for (let hop = 1; hop <= 3; hop++) {
      const affected = new Set([...sources, ...forced]);
      if (mode === "dependencies") for (const token of changed) {
        affected.add(token);
        for (const parent of this.incoming.get(token) ?? []) affected.add(parent);
      }
      const nextChanged = new Set<string>();
      for (const token of affected) {
        recomputedTokens++;
        const layer = this.layers[hop]!, value = this.mark(token, hop);
        if (sameExactRate(layer.get(token), value)) continue;
        if (value) layer.set(token, value); else layer.delete(token);
        nextChanged.add(token);
      }
      changed = nextChanged;
    }
    if (changed.size) this.view = new Map(this.layers[3]);
    return { marks: this.view, changedTokens: changed, recomputedPairs: pairs.size, recomputedTokens };
  }

  private reprice(id: string): void {
    const pair = this.pairs.get(id)!, instances = new Map<string, RawTokenRate>();
    pair.order = Infinity;
    for (const { key, instance, order } of pair.keys) {
      const rate = this.rates.get(key);
      if (!rate) continue;
      pair.order = Math.min(pair.order, order);
      const prior = instances.get(instance);
      if (!prior || compareRates(rate, prior) > 0) instances.set(instance, rate);
    }
    pair.rate = instances.size ? bestRate([...instances.values()]) : undefined;
  }

  private mark(token: string, hop: number): RawTokenRate | undefined {
    const previous = this.layers[hop - 1]!, shorter = previous.get(token);
    if (shorter) return shorter;
    let best: RawTokenRate | undefined;
    // Graph-order ties match the full builder, including newly available pairs.
    const pairs = (this.outgoing.get(token) ?? []).map(id => this.pairs.get(id)!)
      .sort((a, b) => a.order - b.order);
    for (const pair of pairs) {
      const tail = previous.get(pair.to);
      if (!pair.rate || !tail) continue;
      const value = multiply(pair.rate, tail);
      if (!best || compareRates(value, best) > 0) best = value;
    }
    return best;
  }
}

const sameExactRate = (a: RawTokenRate | undefined, b: RawTokenRate | undefined) =>
  a === b || (a !== undefined && b !== undefined && a.num === b.num && a.den === b.den);

interface ValuationPair {
  readonly from: string;
  readonly to: string;
  readonly contributions: Map<string, { instance: string; rate: RawTokenRate }>;
  rate?: RawTokenRate;
}

interface ValuationIndex {
  pricing: PricingReference;
  fingerprint?: string;
  readonly edges: Map<string, PricingReference["graph"]["edges"][number]>;
  readonly pairByEdge: Map<string, ValuationPair>;
  readonly outgoing: Map<string, Map<string, ValuationPair>>;
  readonly incoming: Map<string, Set<string>>;
  readonly layers: Map<string, RawTokenRate>[];
  view: ReadonlyMap<string, RawTokenRate>;
}

const equalRate = (a: RawTokenRate | undefined, b: RawTokenRate | undefined): boolean =>
  a === b || (a !== undefined && b !== undefined && compareRates(a, b) === 0);
const samePricingReference = (a: PricingReference, b: PricingReference): boolean =>
  a.generation === b.generation && a.sourceBlock === b.sourceBlock &&
  a.sourceBlockHash.toLowerCase() === b.sourceBlockHash.toLowerCase() &&
  a.graph === b.graph && a.mids === b.mids &&
  a.coverage.resolvedEdgeKeys === b.coverage.resolvedEdgeKeys;

/** One consumer of the EXISTING raw baseline/delta, not another producer.
 * Keeps a current working index and four immutable-by-ownership output views.
 * Old/overlapping callers cannot mutate the index or see a newer source's rates. */
export class TokenToWethReferenceCache {
  private readonly weth: string;
  private current?: ValuationIndex;
  private readonly recent: { pricing: PricingReference; marks: ReadonlyMap<string, RawTokenRate> }[] = [];
  private readonly work = { fullBuilds: 0, updatedEdges: 0, recomputedPairs: 0, recomputedTokens: 0, hits: 0 };

  constructor(weth: string) { this.weth = weth.toLowerCase(); }

  get stats(): Readonly<typeof this.work> { return Object.freeze({ ...this.work }); }

  get(pricing: PricingReference): ReadonlyMap<string, RawTokenRate> {
    if (this.current && samePricingReference(this.current.pricing, pricing)) {
      this.work.hits++;
      return this.remember(pricing, this.current.view);
    }
    const cached = this.recent.find(entry => samePricingReference(entry.pricing, pricing));
    if (cached) { this.work.hits++; return cached.marks; }
    const index = this.build(pricing);
    // Bootstrap can ask for its raw view before the first baseline is published.
    // A late standalone read must never replace a newer publication's working index.
    this.current ??= index;
    return this.remember(pricing, index.view);
  }

  observe(publication: StrictPricingPublication): void {
    const pricing = publication.snapshot;
    const index = this.current;
    if (index && samePricingReference(index.pricing, pricing)) {
      // Adopt the first baseline after bootstrap, without a second full build.
      if (index.fingerprint === undefined || index.fingerprint === publication.graphFingerprint) {
        index.fingerprint = publication.graphFingerprint;
        this.remember(pricing, index.view);
        return;
      }
    }
    if (!index || publication.kind !== "delta" ||
        index.fingerprint !== publication.graphFingerprint ||
        index.pricing.generation !== publication.previousGeneration ||
        index.pricing.sourceBlock !== publication.previousSourceBlock ||
        index.pricing.sourceBlockHash.toLowerCase() !== publication.previousSourceBlockHash.toLowerCase() ||
        pricing.generation < index.pricing.generation || pricing.sourceBlock < index.pricing.sourceBlock ||
        (pricing.sourceBlock === index.pricing.sourceBlock &&
          pricing.sourceBlockHash.toLowerCase() !== index.pricing.sourceBlockHash.toLowerCase()) ||
        publication.updates.some(([key]) => !index.edges.has(key)) ||
        publication.removals.some(key => !index.edges.has(key))) {
      const rebuilt = this.build(pricing);
      rebuilt.fingerprint = publication.graphFingerprint;
      this.current = rebuilt;
      this.remember(pricing, rebuilt.view);
      return;
    }

    const changedPairs = new Set<ValuationPair>();
    for (const [key, mid] of publication.updates) {
      this.work.updatedEdges++;
      const pair = index.pairByEdge.get(key);
      if (!pair) continue;
      this.setContribution(index, key, mid);
      changedPairs.add(pair);
    }
    for (const key of publication.removals) {
      this.work.updatedEdges++;
      const pair = index.pairByEdge.get(key);
      if (!pair) continue;
      pair.contributions.delete(key);
      changedPairs.add(pair);
    }
    const sources = new Set<string>();
    for (const pair of changedPairs) {
      const before = pair.rate;
      this.repricePair(pair);
      if (!equalRate(before, pair.rate)) sources.add(pair.from);
    }
    let changed = new Set<string>();
    for (let hop = 1; hop <= 3; hop++) {
      const affected = new Set(sources);
      for (const token of changed) {
        affected.add(token);
        for (const parent of index.incoming.get(token) ?? []) affected.add(parent);
      }
      const nextChanged = new Set<string>();
      for (const token of affected) {
        const layer = index.layers[hop]!;
        const next = this.mark(index, token, hop);
        if (equalRate(layer.get(token), next)) continue;
        if (next === undefined) layer.delete(token); else layer.set(token, next);
        nextChanged.add(token);
      }
      changed = nextChanged;
    }
    // Working layers stay private; never mutate a Map handed to an in-flight caller.
    if (changed.size > 0) index.view = new Map(index.layers[3]);
    index.pricing = pricing;
    this.remember(pricing, index.view);
  }

  private remember(pricing: PricingReference, marks: ReadonlyMap<string, RawTokenRate>): ReadonlyMap<string, RawTokenRate> {
    const old = this.recent.findIndex(entry => samePricingReference(entry.pricing, pricing));
    if (old >= 0) this.recent.splice(old, 1);
    this.recent.unshift({ pricing, marks });
    if (this.recent.length > 4) this.recent.pop();
    return marks;
  }

  private setContribution(index: ValuationIndex, key: string, mid: RouteVenueMid): void {
    const pair = index.pairByEdge.get(key)!;
    pair.contributions.delete(key);
    if (!Number.isFinite(mid.feeBps) || mid.feeBps < 0 || mid.feeBps >= 10_000) return;
    const rate = ratio(mid.mid), fee = ratio(10_000 - mid.feeBps);
    if (!rate || !fee) return;
    pair.contributions.set(key, { instance: edgeInstanceKey(index.edges.get(key)!),
      rate: multiply(rate, { num: fee.num, den: fee.den * 10_000n }) });
  }

  private repricePair(pair: ValuationPair): void {
    this.work.recomputedPairs++;
    const instances = new Map<string, RawTokenRate>();
    for (const { instance, rate } of pair.contributions.values()) {
      const prior = instances.get(instance);
      if (!prior || compareRates(rate, prior) > 0) instances.set(instance, rate);
    }
    pair.rate = instances.size === 0 ? undefined : bestRate([...instances.values()]);
  }

  private mark(index: ValuationIndex, token: string, hop: number): RawTokenRate | undefined {
    this.work.recomputedTokens++;
    const previous = index.layers[hop - 1]!;
    const shorter = previous.get(token);
    if (shorter) return shorter;
    const candidates: RawTokenRate[] = [];
    for (const pair of index.outgoing.get(token)?.values() ?? []) {
      const tail = previous.get(pair.to);
      if (pair.rate && tail) candidates.push(multiply(pair.rate, tail));
    }
    return candidates.length === 0 ? undefined : bestRate(candidates);
  }

  private build(pricing: PricingReference): ValuationIndex {
    this.work.fullBuilds++;
    const index: ValuationIndex = { pricing, edges: new Map(), pairByEdge: new Map(),
      outgoing: new Map(), incoming: new Map(),
      layers: Array.from({ length: 4 }, () => new Map([[this.weth, { num: 1n, den: 1n }]])), view: new Map() };
    const resolved = new Set(pricing.coverage.resolvedEdgeKeys);
    for (const edge of pricing.graph.edges) {
      const key = blockScanEdgeKey(edge);
      index.edges.set(key, edge);
      const from = edge.tokenIn.toLowerCase(), to = edge.tokenOut.toLowerCase();
      if (edge.leavesStandingPosition || from === to) continue;
      let outgoing = index.outgoing.get(from);
      if (!outgoing) { outgoing = new Map(); index.outgoing.set(from, outgoing); }
      let pair = outgoing.get(to);
      if (!pair) { pair = { from, to, contributions: new Map() }; outgoing.set(to, pair); }
      index.pairByEdge.set(key, pair);
      let incoming = index.incoming.get(to);
      if (!incoming) { incoming = new Set(); index.incoming.set(to, incoming); }
      incoming.add(from);
      const mid = pricing.mids.get(key);
      if (resolved.has(key) && mid) this.setContribution(index, key, mid);
    }
    for (const outgoing of index.outgoing.values()) for (const pair of outgoing.values()) this.repricePair(pair);
    for (let hop = 1; hop <= 3; hop++) for (const token of index.outgoing.keys()) {
      const value = this.mark(index, token, hop);
      if (value) index.layers[hop]!.set(token, value);
    }
    index.view = new Map(index.layers[3]);
    return index;
  }
}

export function gasReferenceInput(
  gasWei: bigint,
  rate: RawTokenRate,
  enumerationSpreadBps: number,
): bigint | null {
  const spread = ratio(enumerationSpreadBps);
  if (gasWei <= 0n || rate.num <= 0n || rate.den <= 0n || !spread) return null;
  // Strictly above estimated gas at the CURRENT enumeration floor. This is a
  // reference point, not a guarantee of realizable spread or positive net EV.
  return gasWei * 10_000n * rate.den * spread.den / (spread.num * rate.num) + 1n;
}

/** One instance per configured live process; never persists across execution-config changes. */
export class BlockScanAmountReference {
  private readonly headers = new Map<number, ReferenceHeader>();
  private readonly samples = new Map<number, { source: BlockSource; gasUsed: bigint }>();
  private trackingContinuation = false;
  private changes = this.emptyChanges();
  private emptyChanges() {
    return { reset: false, headers: new Map<number, ReferenceHeader>(),
      samples: new Map<number, { source: BlockSource; gasUsed: bigint }>(),
      removedHeaders: new Set<number>(), removedSamples: new Set<number>() };
  }
  startContinuationTracking() { this.trackingContinuation = true; }
  takeContinuationDelta() {
    this.startContinuationTracking();
    const value = this.changes;
    this.changes = this.emptyChanges();
    return { reset: value.reset, headers: [...value.headers.values()], samples: [...value.samples.values()],
      removedHeaders: [...value.removedHeaders], removedSamples: [...value.removedSamples] };
  }
  stopContinuationTracking() { this.trackingContinuation = false; this.changes = this.emptyChanges(); }

  constructor(private readonly capacity = 2048) {
    if (!Number.isSafeInteger(capacity) || capacity <= 0) throw new Error("invalid amount reference capacity");
  }

  exportHistoricalBaseline() {
    return { version: 1 as const, headers: [...this.headers.values()], samples: [...this.samples.values()] };
  }

  restoreHistoricalBaseline(input: ReturnType<BlockScanAmountReference["exportHistoricalBaseline"]>): void {
    if (input.version !== 1 || this.headers.size || this.samples.size ||
        input.headers.length > this.capacity || input.samples.length > this.capacity) {
      throw new Error("invalid historical amount-reference baseline");
    }
    for (const header of input.headers) this.observeHeader(header);
    for (const sample of input.samples) {
      if (this.headers.get(sample.source.number)?.hash !== sample.source.hash.toLowerCase() ||
          typeof sample.gasUsed !== "bigint" || sample.gasUsed <= 0n) throw new Error("invalid historical gas observation");
      this.samples.set(sample.source.number, { source: Object.freeze({ ...sample.source }), gasUsed: sample.gasUsed });
    }
    this.changes = this.emptyChanges(); // Restored baseline entries are not new writes.
  }

  private ancestorHashes(number: number): ReadonlyMap<number, string> {
    const ancestors = new Map<number, string>();
    let header = this.headers.get(number);
    while (header?.hash) {
      ancestors.set(header.number, header.hash);
      const parent = this.headers.get(header.number - 1);
      if (!parent || parent.hash !== header.parentHash) break;
      header = parent;
    }
    return ancestors;
  }

  observeHeader(header: ReferenceHeader): void {
    if (!header.hash || !Number.isSafeInteger(header.number) || header.number < 0) return;
    const previous = this.headers.get(header.number);
    const parent = this.headers.get(header.number - 1);
    if ((previous && previous.hash !== header.hash.toLowerCase()) ||
        (parent && parent.hash !== header.parentHash.toLowerCase())) {
      this.samples.clear();
      this.headers.clear();
      this.changes = this.emptyChanges(); this.changes.reset = this.trackingContinuation;
    }
    this.headers.delete(header.number);
    this.headers.set(header.number, Object.freeze({
      number: header.number, hash: header.hash.toLowerCase(), parentHash: header.parentHash.toLowerCase(),
      baseFeePerGas: header.baseFeePerGas, gasUsed: header.gasUsed, gasLimit: header.gasLimit,
    }));
    if (this.trackingContinuation) {
      this.changes.headers.delete(header.number);
      this.changes.headers.set(header.number, this.headers.get(header.number)!);
      this.changes.removedHeaders.delete(header.number);
    }
    while (this.headers.size > this.capacity) {
      const key = this.headers.keys().next().value!;
      this.headers.delete(key);
      if (this.trackingContinuation) { this.changes.headers.delete(key); this.changes.removedHeaders.add(key); }
    }
  }

  /** Caller supplies only successful final sims after its existing source/hash check. */
  recordSimulation(input: {
    opportunity: BlockScanOpportunity; source: BlockSource; gasUsed: bigint; success: boolean;
  }): void {
    if (!input.success || input.gasUsed <= 0n ||
        this.headers.get(input.source.number)?.hash !== input.source.hash.toLowerCase()) return;
    // One maximum per observed block, shared across routes. The observation
    // contract still accepts opportunity, but route identity does not gate reuse.
    const key = input.source.number;
    const previous = this.samples.get(key);
    // This is an observed sizing estimate, not a bound on future execution gas.
    if (previous && previous.gasUsed >= input.gasUsed &&
        previous.source.hash.toLowerCase() === input.source.hash.toLowerCase()) return;
    this.samples.delete(key);
    this.samples.set(key, { source: { ...input.source }, gasUsed: input.gasUsed });
    if (this.trackingContinuation) {
      this.changes.samples.delete(key);
      this.changes.samples.set(key, this.samples.get(key)!); this.changes.removedSamples.delete(key);
    }
    while (this.samples.size > this.capacity) {
      const removed = this.samples.keys().next().value!;
      this.samples.delete(removed);
      if (this.trackingContinuation) { this.changes.samples.delete(removed); this.changes.removedSamples.add(removed); }
    }
  }

  /** Freeze the latest ancestral gas-units sample at the current header price. */
  estimateGasCost(source: BlockSource): bigint | null {
    const header = this.headers.get(source.number);
    if (!header || header.hash !== source.hash.toLowerCase()) return null;
    const fee = nextBlockBaseFee(header);
    if (fee === null) return null;
    const ancestors = this.ancestorHashes(source.number);
    let gasUsed = 0n;
    let gasSourceBlock = -1;
    // Prefer N-1, otherwise the nearest earlier successful block. An older,
    // higher-gas execution must not displace a newer observation. Only units
    // are reused: the current header above supplies the target gas price.
    for (const sample of this.samples.values()) {
      if (sample.source.number < source.number && sample.source.number > gasSourceBlock &&
          ancestors.get(sample.source.number) === sample.source.hash.toLowerCase()) {
        gasSourceBlock = sample.source.number;
        gasUsed = sample.gasUsed;
      }
    }
    return gasUsed > 0n && fee > 0n ? gasUsed * fee : null;
  }

  prepare(input: {
    pricing: Pick<BlockScanStateSnapshot,
      "sourceBlock" | "sourceBlockHash" | "generation" | "effectiveMids"> | null;
    opportunities: readonly BlockScanOpportunity[];
  }): ReadonlyMap<BlockScanOpportunity, bigint> {
    const result = new Map<BlockScanOpportunity, bigint>();
    const { pricing } = input;
    const effective = pricing?.effectiveMids;
    if (!pricing || !effective?.complete ||
        effective.source.number !== pricing.sourceBlock ||
        effective.source.hash.toLowerCase() !== pricing.sourceBlockHash.toLowerCase() ||
        effective.source.generation !== pricing.generation) return result;
    // Read the first directed edge used by enumeration, not a token-wide new
    // valuation. Clean carried rows retain their recorded amount. This only
    // supplies sizing; Exact still quotes every leg at its own current source.
    for (const opportunity of input.opportunities) {
      const first = opportunity.seedEdges[0];
      if (!first) continue;
      const key = blockScanEdgeKey(first);
      const row = effective.rows.get(key);
      if (row?.status !== "quoted" || row.edgeId !== key || row.amountIn == null || row.amountIn <= 0n ||
          row.tokenIn.toLowerCase() !== first.tokenIn.toLowerCase() ||
          row.tokenIn.toLowerCase() !== opportunity.flashToken.toLowerCase() ||
          row.tokenOut.toLowerCase() !== first.tokenOut.toLowerCase()) continue;
      result.set(opportunity, row.amountIn);
    }
    return result;
  }
}
