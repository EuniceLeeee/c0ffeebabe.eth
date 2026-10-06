import { gasReferenceInput } from "./blockscan-amount-reference.js";
import type { StrictProductionRuntimeSession } from "./strict-production-runtime-session.js";
import type { CanonicalSource } from "./venues/adapter-request-program.js";
import { blockScanEdgeKey, type VerifiedGraphView } from "./venues/blockscan-state-capability.js";
import { edgeInstanceKey } from "./venues/route-instance-identity.js";
import type { AdapterWorkControl } from "./adapter-work-intent.js";
import type { BlockScanStateSnapshot } from "./blockscan-state-coordinator.js";
import type { ResolvedBlockScanQuote } from "./detector/blockscan-scanner-core.js";
import { deltaMap, scannerConsumesEdge } from "./blockscan-pricing-delta.js";

export type EffectivePricingInput = Pick<BlockScanStateSnapshot,
  "sourceBlock" | "sourceBlockHash" | "generation" | "pricingStateKeyByEdgeKey"> & {
  readonly graph: { readonly edges: BlockScanStateSnapshot["graph"]["edges"] };
  /** Structural compatibility only; neither field participates in sampling. */
  readonly mids: ReadonlyMap<string, { mid: number; feeBps: number }>;
  readonly coverage: { readonly resolvedEdgeKeys: readonly string[] };
};
/** Single global default P (0.002 WETH); a positive spread floor and available gas select G instead.
 * Exact reuses the resulting row amount and hands that same input to Solver. */
export const DEFAULT_EFFECTIVE_WETH_INPUT = 2_000_000_000_000_000n;

export interface EffectiveMidRow {
  readonly edgeId: string;
  readonly instanceKey: string;
  readonly tokenIn: string;
  readonly tokenOut: string;
  readonly amountIn: bigint | null;
  readonly amountOut: bigint | null;
  /** Output raw units / input raw units. Fee already included in amountOut. */
  readonly effectiveMid: number | null;
  readonly status: "quoted" | "missing-valuation" | "unsupported" |
    "quote-failed" | "no-output" | "cancelled" | "disabled-for-run";
  /** Original chain observation, not a current-block Exact handle. */
  readonly quotedAt?: CanonicalSource;
  /** Legacy serialized flag; current carry is derived from quotedAt + snapshot.source. */
  readonly carried?: true;
}

export interface EffectiveMidSnapshot {
  readonly source: CanonicalSource;
  readonly reference: "gas" | "default" | "fixed";
  /** Reference for newly quoted rows. Carried rows retain their original amounts. */
  readonly referenceWethInput: bigint;
  readonly rows: ReadonlyMap<string, EffectiveMidRow>;
  readonly complete: boolean;
  readonly wallMs: number;
}

export interface EffectiveAmountReference {
  readonly amountIn: bigint;
  /** Successful forward quotes from WETH, retaining their original observations.
   * With cascading off, the path may originate at an older WETH notional. */
  readonly path: readonly EffectiveMidRow[];
}

// Process-local policy identity and dependencies. Serialized legacy snapshots
// cannot prove that their inputs were derived without raw mids, so cannot carry.
const amountReferenceState = new WeakMap<EffectiveMidSnapshot, {
  readonly weth: string;
  readonly references: ReadonlyMap<string, EffectiveAmountReference>;
}>();
const rowAmountReferences = new WeakMap<EffectiveMidRow, EffectiveAmountReference>();

export function effectiveAmountReferences(snapshot: EffectiveMidSnapshot):
ReadonlyMap<string, EffectiveAmountReference> | undefined {
  return amountReferenceState.get(snapshot)?.references;
}

/** A carried row keeps the path that actually supplied its recorded amountIn. */
export function effectiveRowAmountReference(row: EffectiveMidRow): EffectiveAmountReference | undefined {
  return rowAmountReferences.get(row);
}

export function resolveEffectiveAmountCascade(raw?: string): boolean {
  if (raw === undefined || raw === "0") return false;
  if (raw === "1") return true;
  throw new Error("SEARCHER_BLOCKSCAN_EFFECTIVE_AMOUNT_CASCADE_ENABLED must be 0 or 1");
}

export function effectiveMidRowCarried(snapshot: EffectiveMidSnapshot, row: EffectiveMidRow): boolean {
  const at = row.quotedAt;
  return at === undefined ? row.carried === true : at.number !== snapshot.source.number ||
    at.hash.toLowerCase() !== snapshot.source.hash.toLowerCase() || at.generation !== snapshot.source.generation;
}

/** Consumer-only projection of current effective amounts and graph identity.
 * Raw mids provide neither amount sizing nor enumeration fallback. */
export function effectiveEnumerationMids(pricing: BlockScanStateSnapshot): ReadonlyMap<string, ResolvedBlockScanQuote> {
  const effective = pricing.effectiveMids;
  if (effective === undefined) throw new Error("enumeration effective pricing missing");
  if (!effective.complete || effective.source.number !== pricing.sourceBlock ||
      effective.source.hash.toLowerCase() !== pricing.sourceBlockHash.toLowerCase() ||
      effective.source.generation !== pricing.generation) {
    throw new Error("enumeration effective pricing incomplete or mismatched source");
  }
  const edges = new Map(pricing.graph.edges.map(edge => [blockScanEdgeKey(edge), edge]));
  const mids = new Map<string, ResolvedBlockScanQuote>();
  for (const [key, row] of effective.rows) {
    if (row.status !== "quoted") continue;
    const edge = edges.get(key);
    if (!edge || row.edgeId !== key || row.instanceKey !== edgeInstanceKey(edge) ||
        row.tokenIn.toLowerCase() !== edge.tokenIn.toLowerCase() ||
        row.tokenOut.toLowerCase() !== edge.tokenOut.toLowerCase() || row.effectiveMid === null ||
        !Number.isFinite(row.effectiveMid) || row.effectiveMid <= 0 ||
        typeof row.amountIn !== "bigint" || typeof row.amountOut !== "bigint" || row.amountIn <= 0n || row.amountOut <= 0n) {
      throw new Error("invalid effective enumeration row");
    }
    mids.set(key, { kind: "external-swap", pool: edgeInstanceKey(edge), edges: [edge],
      mid: row.effectiveMid, feeBps: 0, depthProxy: 0,
      quoteAmountIn: row.amountIn, quoteAmountOut: row.amountOut });
  }
  return mids;
}

// A bound use of the existing quote entry, not a second Family/central API.
// The caller supplies executor/evidence through its source-bound session closure.
type ExactCall = StrictProductionRuntimeSession["issueExact"];
type RouteExactResult = Extract<Awaited<ReturnType<ExactCall>>, { readonly amountIn: bigint }>;
type EffectiveMidQuote = (
  input: Pick<Parameters<ExactCall>[0],
    "edge" | "amountIn" | "control">,
) => Promise<Pick<RouteExactResult, "source" | "amountIn" | "amountOut">>;

/** Forward effective sampling: shortest successful WETH paths first, then the
 * greatest output at that depth. Depth-three tokens still quote their outgoing
 * edges, but those outputs cannot seed a fourth-hop sampling reference. */
export async function buildEffectiveMids(input: {
  /** Verified pricing-state identity; raw mids are deliberately not consumed. */
  readonly pricing: EffectivePricingInput;
  readonly quoteGraph?: VerifiedGraphView;
  readonly weth: string;
  readonly gasCostWei: bigint | null;
  /** Explicit diagnostic notional. Omitted by live callers. */
  readonly fixedWethInput?: bigint;
  readonly enumerationSpreadBps: number;
  /** Requote clean rows only when their forward input quantity changes.
   * Off preserves each clean row's original amount pair and input lineage. */
  readonly cascadeAmountChanges?: boolean;
  readonly quote: EffectiveMidQuote;
  /** Called once with potentially needed, structurally reachable edges before
   * layered quotes begin. Exact uses one source-bound session for every layer;
   * unreachable amounts may eliminate some of this authority-only superset. */
  readonly prepareQuote?: (requiredEdgeIds: ReadonlySet<string>) => Promise<void>;
  readonly control: AdapterWorkControl;
  readonly concurrency: number;
  readonly previous?: EffectiveMidSnapshot;
  /** Run-local policy exclusions, not Ready/admission rejections. Apply before
   * carry and quote preparation, including each-block and full refreshes. */
  readonly disabledEdgeIds?: ReadonlySet<string>;
  /** The complete pricing-state touched set. Undefined is
   * bootstrap/full refresh, not an empty block. Pricing references only: no
   * per-method reuse declaration. Amount-change invalidation is opt-in above. */
  readonly touchedStateKeys?: ReadonlySet<string>;
}): Promise<EffectiveMidSnapshot> {
  const started = Date.now();
  const { pricing, control } = input;
  if (!Number.isSafeInteger(input.concurrency) || input.concurrency < 1 ||
      !Number.isFinite(input.enumerationSpreadBps) || input.enumerationSpreadBps < 0) {
    throw new Error("invalid effective-mid work or spread policy");
  }
  if (input.gasCostWei !== null && input.gasCostWei <= 0n) throw new Error("invalid gas cost");
  if (input.fixedWethInput !== undefined && input.fixedWethInput <= 0n) throw new Error("invalid fixed effective input");
  const target = input.quoteGraph ?? pricing;
  const source = Object.freeze({
    number: target.sourceBlock, hash: target.sourceBlockHash.toLowerCase(), generation: target.generation,
  });
  // A strictly-positive opportunity filter may have a zero threshold. There
  // is no finite gas-cover notional at 0%; use the same global fallback P,
  // without changing the enumeration threshold or pretending this covers gas.
  const gasCostWei = input.fixedWethInput !== undefined || input.enumerationSpreadBps === 0 ? null : input.gasCostWei;
  const defaultInput = input.fixedWethInput ?? DEFAULT_EFFECTIVE_WETH_INPUT;
  const referenceWethInput = gasCostWei === null ? defaultInput :
    gasReferenceInput(gasCostWei, { num: 1n, den: 1n }, input.enumerationSpreadBps)!;
  const weth = input.weth.toLowerCase();
  const edges = new Map((input.quoteGraph ?? pricing.graph).edges.map(e => [blockScanEdgeKey(e), e]));
  const stateKeyFor = (edgeId: string, edge: (typeof pricing.graph.edges)[number]) =>
    (pricing.pricingStateKeyByEdgeKey?.get(edgeId) ?? edgeInstanceKey(edge)).toLowerCase();
  // Membership comes from the verified graph, never the availability of a raw
  // mid. In particular, a successful Exact can recover an unpriced direction.
  const keys = [...edges].filter(([key, edge]) => scannerConsumesEdge(edge) ||
    pricing.pricingStateKeyByEdgeKey?.has(key)).map(([key]) => key);
  const work = keys.map(edgeId => {
    const edge = edges.get(edgeId)!;
    return { edgeId, edge, amountIn: null as bigint | null,
      reference: undefined as EffectiveAmountReference | undefined };
  });
  const rows = new Array<EffectiveMidRow>(work.length);
  const closed = () => control.signal?.aborted === true ||
    (control.deadlineAtMs !== undefined && Date.now() >= control.deadlineAtMs);
  const writeRow = (index: number, result: Pick<EffectiveMidRow,
    "status" | "amountOut" | "effectiveMid" | "quotedAt" | "carried">) => {
    const { edgeId, edge, amountIn } = work[index]!;
    rows[index] = Object.freeze({ edgeId, instanceKey: edgeInstanceKey(edge),
      tokenIn: edge.tokenIn.toLowerCase(), tokenOut: edge.tokenOut.toLowerCase(), amountIn, ...result });
    const reference = work[index]!.reference;
    if (reference) rowAmountReferences.set(rows[index]!, reference);
  };
  const unavailable = (index: number, status: EffectiveMidRow["status"]) =>
    writeRow(index, { status, amountOut: null, effectiveMid: null });
  const failed = (index: number, error: unknown) => unavailable(index, closed() ? "cancelled" :
    (error as { code?: unknown })?.code === "CHAIN_AMOUNT_QUOTE_UNAVAILABLE" ? "unsupported" : "quote-failed");
  const accept = (index: number, result: Awaited<ReturnType<EffectiveMidQuote>>) => {
    if (closed()) { unavailable(index, "cancelled"); return; }
    const { amountIn } = work[index]!;
    if (amountIn === null || result.source.number !== source.number || result.source.hash.toLowerCase() !== source.hash ||
        result.source.generation !== source.generation || result.amountIn !== amountIn) {
      throw new Error("effective quote changed source or amount");
    }
    const amountOut = result.amountOut;
    const rate = Number(amountOut) / Number(amountIn);
    if (amountOut < 0n || !Number.isFinite(rate) || (amountOut > 0n && rate <= 0)) {
      throw new Error("invalid quote output");
    }
    const status = amountOut > 0n ? "quoted" : "no-output";
    if (closed()) { unavailable(index, "cancelled"); return; }
    writeRow(index, { status, amountOut, effectiveMid: amountOut > 0n ? rate : null,
      ...(status === "quoted" ? { quotedAt: source } : {}) });
  };

  // Classify carry before any quote can yield. Only snapshots built with this
  // policy in this process may carry; deserialized raw-mid-era amounts cannot.
  const previous = input.previous;
  const previousState = previous && amountReferenceState.get(previous);
  const canReuse = previous !== undefined && previousState?.weth === weth && input.touchedStateKeys !== undefined &&
    ((input.fixedWethInput === undefined && previous.reference !== "fixed") ||
      (previous.reference === "fixed" && previous.referenceWethInput === input.fixedWethInput)) &&
    ((source.number > previous.source.number && source.generation > previous.source.generation) ||
      (source.number === previous.source.number && source.generation >= previous.source.generation &&
        source.hash === previous.source.hash.toLowerCase()));
  const reusable = new Map<number, EffectiveMidRow>();
  const enabled = (index: number) => {
    const { edgeId, edge } = work[index]!;
    return !input.disabledEdgeIds?.has(edgeId) &&
      (!edge.leavesStandingPosition || pricing.pricingStateKeyByEdgeKey?.has(edgeId));
  };
  for (const [index, { edgeId, edge }] of work.entries()) {
    if (input.disabledEdgeIds?.has(edgeId)) {
      unavailable(index, "disabled-for-run");
    } else if (edge.leavesStandingPosition && !pricing.pricingStateKeyByEdgeKey?.has(edgeId)) {
      unavailable(index, "unsupported");
    }
    else if (closed()) unavailable(index, "cancelled");
    else {
      const prior = canReuse ? previous.rows.get(edgeId) : undefined;
      const stateKey = stateKeyFor(edgeId, edge);
      if (prior && (prior.status === "quoted" || (previous!.complete && prior.status !== "cancelled")) && prior.edgeId === edgeId &&
          prior.instanceKey === edgeInstanceKey(edge) &&
          prior.tokenIn === edge.tokenIn.toLowerCase() && prior.tokenOut === edge.tokenOut.toLowerCase() &&
          !input.touchedStateKeys!.has(stateKey)) {
        reusable.set(index, prior);
        if (!input.cascadeAmountChanges) rows[index] = prior;
      }
    }
  }

  const references = new Map<string, EffectiveAmountReference>([[weth,
    Object.freeze({ amountIn: referenceWethInput, path: Object.freeze([]) })]]);
  const pending = Array.from({ length: 4 }, () => new Map<string, EffectiveAmountReference>());
  const offer = (token: string, reference: EffectiveAmountReference) => {
    if (references.has(token) || reference.path.length === 0 || reference.path.length > 3) return;
    const candidates = pending[reference.path.length]!;
    const prior = candidates.get(token);
    // Equal outputs use the complete edge path, independent of graph ordering
    // and asynchronous quote completion.
    if (!prior || reference.amountIn > prior.amountIn || (reference.amountIn === prior.amountIn &&
        reference.path.map(row => row.edgeId).join("\n") < prior.path.map(row => row.edgeId).join("\n"))) {
      candidates.set(token, reference);
    }
  };
  const offerOutput = (row: EffectiveMidRow, reference: EffectiveAmountReference) => {
    if (row.status !== "quoted" || edges.get(row.edgeId)!.leavesStandingPosition ||
        reference.path.length >= 3 || row.tokenOut === weth ||
        row.tokenOut === row.tokenIn || reference.path.some(step => step.tokenIn === row.tokenOut)) return;
    offer(row.tokenOut, Object.freeze({ amountIn: row.amountOut!,
      path: Object.freeze([...reference.path, row]) }));
  };
  if (!input.cascadeAmountChanges) {
    // With cascading off, clean tuples remain historical samples. Their
    // ORIGINAL lineage can seed quantities even if an upstream pool changed;
    // never attach a new prefix to an old, differently sized output. All such
    // candidates are seeded before layers run, so their actual path depth,
    // rather than the current frontier depth, determines shortest-path rank.
    for (const [index, row] of reusable) {
      const reference = rowAmountReferences.get(row);
      if (!reference || !reference.path.every(step => {
        const edge = edges.get(step.edgeId);
        return edge && !edge.leavesStandingPosition && !input.disabledEdgeIds?.has(step.edgeId) &&
          step.instanceKey === edgeInstanceKey(edge) &&
          step.tokenIn === edge.tokenIn.toLowerCase() && step.tokenOut === edge.tokenOut.toLowerCase();
      })) continue;
      offer(work[index]!.edge.tokenIn.toLowerCase(), reference);
      offerOutput(row, reference);
    }
  }

  // Bind one existing source-bound session for a structural superset. Quote
  // failures prune the actual layered work; no second quote pipeline/session.
  const reachable = new Set([weth]);
  for (let depth = 0; depth < 3; depth++) {
    const additions = work.filter((item, index) => enabled(index) && !item.edge.leavesStandingPosition &&
      reachable.has(item.edge.tokenIn.toLowerCase())).map(item => item.edge.tokenOut.toLowerCase());
    for (const token of additions) reachable.add(token);
  }
  const required = new Set(work.filter((item, index) => enabled(index) &&
    reachable.has(item.edge.tokenIn.toLowerCase()) &&
    (input.cascadeAmountChanges || !reusable.has(index) || reusable.get(index)!.amountIn === null)).map(item => item.edgeId));
  if (input.prepareQuote && required.size > 0 && !closed()) await input.prepareQuote(required);

  for (let depth = 0; depth <= 3; depth++) {
    for (const [token, reference] of pending[depth]!) {
      if (!references.has(token)) references.set(token, reference);
    }
    const layer = work.flatMap((item, index) => {
      const reference = references.get(item.edge.tokenIn.toLowerCase());
      return reference?.path.length === depth && enabled(index) ? [index] : [];
    });
    const fresh: number[] = [];
    for (const index of layer) {
      const item = work[index]!;
      item.reference = references.get(item.edge.tokenIn.toLowerCase())!;
      item.amountIn = item.reference.amountIn;
      const prior = reusable.get(index);
      if (prior && prior.amountIn !== null &&
          (!input.cascadeAmountChanges || prior.amountIn === item.amountIn)) rows[index] = prior;
      else if (closed()) unavailable(index, "cancelled");
      else fresh.push(index);
    }
    let next = 0;
    const worker = async () => {
      for (;;) {
        const index = fresh[next++];
        if (index === undefined) return;
        if (closed()) { unavailable(index, "cancelled"); continue; }
        const { edge, amountIn } = work[index]!;
        try {
          accept(index, await input.quote({ edge, amountIn: amountIn!, control }));
        } catch (error) { failed(index, error); }
      }
    };
    await Promise.all(Array.from({ length: Math.min(input.concurrency, fresh.length) }, worker));
    for (const index of layer) {
      const row = rows[index]!;
      const reference = input.cascadeAmountChanges ? work[index]!.reference : rowAmountReferences.get(row);
      if (reference) offerOutput(row, reference);
    }
  }
  for (let index = 0; index < work.length; index++) {
    if (rows[index] === undefined) unavailable(index, closed() ? "cancelled" : "missing-valuation");
  }
  const previousRows = canReuse ? previous.rows : new Map<string, EffectiveMidRow>();
  const updates = rows.filter(row => previousRows.get(row.edgeId) !== row)
    .map(row => [row.edgeId, row] as const);
  const present = new Set(keys);
  const removals = [...previousRows.keys()].filter(key => !present.has(key));
  const snapshot: EffectiveMidSnapshot = Object.freeze({ source,
    reference: input.fixedWethInput !== undefined ? "fixed" : gasCostWei === null ? "default" : "gas",
    referenceWethInput, rows: deltaMap(previousRows, updates, removals),
    complete: !closed() && rows.every(row => row.status !== "cancelled"), wallMs: Date.now() - started });
  amountReferenceState.set(snapshot, { weth, references });
  return snapshot;
}

/** Best two-venue indication at each row's recorded reference amount. Carried
 * rows may use older notionals; this is not a matched-quantity loop or sim/EV. */
export function effectiveMidPairStatistics(snapshot: EffectiveMidSnapshot, thresholdBps = 100): {
  directions: number; quoted: number; byStatus: Record<string, number>;
  comparablePairs: number; pairsAboveThreshold: number; thresholdBps: number;
} {
  if (!Number.isSafeInteger(thresholdBps) || thresholdBps < 0) throw new Error("invalid pair threshold");
  const pairs = new Map<string, [EffectiveMidRow[], EffectiveMidRow[]]>();
  const byStatus: Record<string, number> = {};
  for (const row of snapshot.rows.values()) {
    byStatus[row.status] = (byStatus[row.status] ?? 0) + 1;
    if (row.status !== "quoted" || row.tokenIn === row.tokenOut) continue;
    const forward = row.tokenIn < row.tokenOut;
    const key = forward ? row.tokenIn + "|" + row.tokenOut : row.tokenOut + "|" + row.tokenIn;
    const sides = pairs.get(key) ?? [[], []];
    sides[forward ? 0 : 1].push(row);
    pairs.set(key, sides);
  }
  let comparablePairs = 0, pairsAboveThreshold = 0;
  for (const sides of pairs.values()) {
    const best = sides.map(side => {
      side.sort((a, b) => {
        const d = a.amountOut! * b.amountIn! - b.amountOut! * a.amountIn!;
        return d > 0n ? -1 : d < 0n ? 1 : 0;
      });
      const seen = new Set<string>();
      return side.filter(row => {
        if (seen.has(row.instanceKey)) return false;
        seen.add(row.instanceKey);
        return true;
      }).slice(0, 2);
    });
    let comparable = false, above = false;
    for (const a of best[0]!) for (const b of best[1]!) {
      if (a.instanceKey === b.instanceKey) continue;
      comparable = true;
      if (a.amountOut! * b.amountOut! * 10_000n >
          a.amountIn! * b.amountIn! * BigInt(10_000 + thresholdBps)) above = true;
    }
    if (comparable) comparablePairs++;
    if (above) pairsAboveThreshold++;
  }
  return { directions: snapshot.rows.size, quoted: byStatus.quoted ?? 0, byStatus,
    comparablePairs, pairsAboveThreshold, thresholdBps };
}
