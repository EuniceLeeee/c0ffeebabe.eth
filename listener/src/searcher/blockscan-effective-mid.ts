import { gasReferenceInput, tokenToWethReferences } from "./blockscan-amount-reference.js";
import type { StrictProductionRuntimeSession } from "./strict-production-runtime-session.js";
import type { CanonicalSource } from "./venues/adapter-request-program.js";
import { blockScanEdgeKey, type VerifiedGraphView } from "./venues/blockscan-state-capability.js";
import { edgeInstanceKey } from "./venues/route-instance-identity.js";
import type { AdapterWorkControl } from "./adapter-work-intent.js";
import type { BlockScanStateSnapshot } from "./blockscan-state-coordinator.js";
import type { RouteVenueMid } from "./venues/mid-readers.js";
import { deltaMap, scannerConsumesEdge } from "./blockscan-pricing-delta.js";

export type EffectivePricingInput = Parameters<typeof tokenToWethReferences>[0] &
  Pick<BlockScanStateSnapshot, "pricingStateKeyByEdgeKey">;
export const DEFAULT_EFFECTIVE_WETH_INPUT = 1_000_000_000_000_000n;

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
    "quote-failed" | "no-output" | "cancelled";
  /** Original chain observation, not a current-block Exact handle. */
  readonly quotedAt?: CanonicalSource;
  /** Legacy serialized flag; current carry is derived from quotedAt + snapshot.source. */
  readonly carried?: true;
}

export interface EffectiveMidSnapshot {
  readonly source: CanonicalSource;
  readonly reference: "gas" | "default";
  /** Reference for newly quoted rows. Carried rows retain their original amounts. */
  readonly referenceWethInput: bigint;
  readonly rows: ReadonlyMap<string, EffectiveMidRow>;
  readonly complete: boolean;
  readonly wallMs: number;
}

export function effectiveMidRowCarried(snapshot: EffectiveMidSnapshot, row: EffectiveMidRow): boolean {
  const at = row.quotedAt;
  return at === undefined ? row.carried === true : at.number !== snapshot.source.number ||
    at.hash.toLowerCase() !== snapshot.source.hash.toLowerCase() || at.generation !== snapshot.source.generation;
}

/** Consumer-only projection; never mutate the original mid or its carry proof.
 * Existing snapshots without the companion retain their legacy contract. */
export function effectiveEnumerationMids(pricing: BlockScanStateSnapshot): ReadonlyMap<string, RouteVenueMid> {
  const effective = pricing.effectiveMids;
  if (effective === undefined) return pricing.mids;
  if (!effective.complete || effective.source.number !== pricing.sourceBlock ||
      effective.source.hash.toLowerCase() !== pricing.sourceBlockHash.toLowerCase() ||
      effective.source.generation !== pricing.generation) {
    throw new Error("enumeration effective pricing incomplete or mismatched source");
  }
  const mids = new Map<string, RouteVenueMid>();
  for (const [key, row] of effective.rows) {
    const original = pricing.mids.get(key);
    if (row.status !== "quoted") continue;
    if (!original || row.edgeId !== key || row.effectiveMid === null ||
        !Number.isFinite(row.effectiveMid) || row.effectiveMid <= 0) {
      throw new Error("invalid effective enumeration row");
    }
    mids.set(key, { ...original, mid: row.effectiveMid, feeBps: 0 });
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

/** A sizing mark is used ONLY for amountIn, never to derive amountOut.
 * All input tokens share one immutable, at-most-three-hop valuation pass. */
export async function buildEffectiveMids(input: {
  /** Only an amountIn valuation reference; it need not be the quote block. */
  readonly pricing: EffectivePricingInput;
  readonly quoteGraph?: VerifiedGraphView;
  readonly weth: string;
  readonly gasCostWei: bigint | null;
  readonly enumerationSpreadBps: number;
  readonly quote: EffectiveMidQuote;
  /** Bind this source's existing quote session only after carry/missing rows
   * have been classified. Called once for the actual work, never for clean
   * references; this does not carry old Exact authority across blocks. */
  readonly prepareQuote?: (requiredEdgeIds: ReadonlySet<string>) => Promise<void>;
  readonly control: AdapterWorkControl;
  readonly concurrency: number;
  readonly previous?: EffectiveMidSnapshot;
  /** The SAME complete touched set used by raw-mid preparation. Undefined is
   * bootstrap/full refresh, not an empty block. Pricing references only: no
   * per-method reuse declaration and no amount-change invalidation. */
  readonly touchedStateKeys?: ReadonlySet<string>;
}): Promise<EffectiveMidSnapshot> {
  const started = Date.now();
  const { pricing, control } = input;
  if (!Number.isSafeInteger(input.concurrency) || input.concurrency < 1 ||
      !Number.isFinite(input.enumerationSpreadBps) || input.enumerationSpreadBps <= 0) {
    throw new Error("invalid effective-mid work or spread policy");
  }
  if (input.gasCostWei !== null && input.gasCostWei <= 0n) throw new Error("invalid gas cost");
  const target = input.quoteGraph ?? pricing;
  const source = Object.freeze({
    number: target.sourceBlock, hash: target.sourceBlockHash.toLowerCase(), generation: target.generation,
  });
  let marks: ReturnType<typeof tokenToWethReferences> | undefined;
  const referenceWethInput = input.gasCostWei === null ? DEFAULT_EFFECTIVE_WETH_INPUT :
    gasReferenceInput(input.gasCostWei, { num: 1n, den: 1n }, input.enumerationSpreadBps)!;
  const amounts = new Map<string, bigint | null>();
  const edges = new Map((input.quoteGraph ?? pricing.graph).edges.map(e => [blockScanEdgeKey(e), e]));
  const stateKeyFor = (edgeId: string, edge: (typeof pricing.graph.edges)[number]) =>
    (pricing.pricingStateKeyByEdgeKey?.get(edgeId) ?? edgeInstanceKey(edge)).toLowerCase();
  // Keep the published mid membership. A direction missing from that table
  // may recover only in the SAME touched subset raw is refreshing, not by
  // expanding every steady pass to all unpriced Ready graph directions.
  const keys = input.quoteGraph === undefined ? [...pricing.mids.keys()] :
    input.quoteGraph.edges.filter(edge => scannerConsumesEdge(edge) && (
      pricing.mids.has(blockScanEdgeKey(edge)) || input.touchedStateKeys === undefined ||
      input.touchedStateKeys.has(stateKeyFor(blockScanEdgeKey(edge), edge))
    )).map(blockScanEdgeKey);
  const work = keys.map(edgeId => {
    const edge = edges.get(edgeId);
    if (!edge) throw new Error("effective mid is outside the Ready Graph");
    return { edgeId, edge, amountIn: null as bigint | null };
  });
  const amountFor = (index: number): bigint | null => {
    const item = work[index]!;
    const token = item.edge.tokenIn.toLowerCase();
    if (!amounts.has(token)) {
      marks ??= tokenToWethReferences(pricing, input.weth);
      const mark = marks.get(token);
      amounts.set(token, !mark ? null : input.gasCostWei === null
        ? (DEFAULT_EFFECTIVE_WETH_INPUT * mark.den + mark.num - 1n) / mark.num
        : gasReferenceInput(input.gasCostWei, mark, input.enumerationSpreadBps));
    }
    return item.amountIn = amounts.get(token)!;
  };
  const rows = new Array<EffectiveMidRow>(work.length);
  const closed = () => control.signal?.aborted === true ||
    (control.deadlineAtMs !== undefined && Date.now() >= control.deadlineAtMs);
  const writeRow = (index: number, result: Pick<EffectiveMidRow,
    "status" | "amountOut" | "effectiveMid" | "quotedAt" | "carried">) => {
    const { edgeId, edge, amountIn } = work[index]!;
    rows[index] = Object.freeze({ edgeId, instanceKey: edgeInstanceKey(edge),
      tokenIn: edge.tokenIn.toLowerCase(), tokenOut: edge.tokenOut.toLowerCase(), amountIn, ...result });
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

  // Classify the existing mid table before any quote can yield. A blocked dirty
  // row must not delay validation of reusable data later in that same table.
  const previous = input.previous;
  const canReuse = previous !== undefined && input.touchedStateKeys !== undefined &&
    ((source.number > previous.source.number && source.generation > previous.source.generation) ||
      (source.number === previous.source.number && source.generation >= previous.source.generation &&
        source.hash === previous.source.hash.toLowerCase()));
  const fresh: number[] = [];
  for (const [index, { edgeId, edge }] of work.entries()) {
    if (edge.leavesStandingPosition) { amountFor(index); unavailable(index, "unsupported"); }
    else if (closed()) { amountFor(index); unavailable(index, "cancelled"); }
    else {
      const prior = canReuse ? previous.rows.get(edgeId) : undefined;
      const stateKey = stateKeyFor(edgeId, edge);
      if (prior && (prior.status === "quoted" || (previous!.complete && prior.status !== "cancelled")) && prior.edgeId === edgeId &&
          prior.instanceKey === edgeInstanceKey(edge) &&
          prior.tokenIn === edge.tokenIn.toLowerCase() && prior.tokenOut === edge.tokenOut.toLowerCase() &&
          !input.touchedStateKeys!.has(stateKey)) {
        // This is an approximate pricing reference, not proof that a new
        // amount would receive the old output. Keep the ORIGINAL pair of
        // amounts and observation block even if this pass's gas/mark changed.
        // A complete table's unavailable clean rows also stay unavailable
        // until touched, just like raw mid. They are never priced fallbacks.
        rows[index] = prior.status === "quoted" && prior.quotedAt === undefined
          ? Object.freeze({ ...prior, quotedAt: previous!.source }) : prior;
      } else if (amountFor(index) === null) unavailable(index, "missing-valuation");
      else fresh.push(index);
    }
  }
  if (input.prepareQuote && fresh.length > 0 && !closed()) {
    await input.prepareQuote(new Set(fresh.map(index => work[index]!.edgeId)));
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
  const previousRows = canReuse ? previous.rows : new Map<string, EffectiveMidRow>();
  const updates = rows.filter(row => previousRows.get(row.edgeId) !== row)
    .map(row => [row.edgeId, row] as const);
  const present = new Set(keys);
  const removals = [...previousRows.keys()].filter(key => !present.has(key));
  return Object.freeze({ source, reference: input.gasCostWei === null ? "default" : "gas",
    referenceWethInput, rows: deltaMap(previousRows, updates, removals),
    complete: !closed() && rows.every(row => row.status !== "cancelled"), wallMs: Date.now() - started });
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
