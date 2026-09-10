import { gasReferenceInput, tokenToWethReferences } from "./blockscan-amount-reference.js";
import type { StrictProductionRuntimeSession } from "./strict-production-runtime-session.js";
import type { CanonicalSource } from "./venues/adapter-request-program.js";
import { blockScanEdgeKey } from "./venues/blockscan-state-capability.js";
import { edgeInstanceKey } from "./venues/route-instance-identity.js";
import type { AdapterWorkControl } from "./adapter-work-intent.js";
import type { BlockScanStateSnapshot } from "./blockscan-state-coordinator.js";
import type { RouteVenueMid } from "./venues/mid-readers.js";
import { carryAmountQuote, type CompletedAmountQuote,
  type PreparedAmountQuoteActivity } from "./amount-quote-continuity.js";
import type { FamilyAmountQuoteReuseContext } from "./venues/adapter-family-runtime.js";

export type EffectivePricingInput = Parameters<typeof tokenToWethReferences>[0];
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
  /** Data, not an Exact handle. Original quote anchor is never rewritten. */
  readonly quoteProvenance?: CompletedAmountQuote;
  readonly carried?: true;
}

export interface EffectiveMidSnapshot {
  readonly source: CanonicalSource;
  readonly reference: "gas" | "default";
  readonly referenceWethInput: bigint;
  readonly rows: ReadonlyMap<string, EffectiveMidRow>;
  readonly complete: boolean;
  readonly wallMs: number;
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
    "edge" | "amountIn" | "control" | "requireChainAmountQuote">,
) => Promise<Pick<RouteExactResult, "source" | "amountIn" | "amountOut"> &
  Partial<Pick<RouteExactResult, "methodId" | "methodIndex" |
    "methodOrderFingerprint" | "cacheCompatibilityFingerprint" | "reusePolicy" | "amountQuoteReuse">>>;

/** A sizing mark is used ONLY for amountIn, never to derive amountOut.
 * All input tokens share one immutable, at-most-three-hop valuation pass. */
export async function buildEffectiveMids(input: {
  readonly pricing: EffectivePricingInput;
  readonly weth: string;
  readonly gasCostWei: bigint | null;
  readonly enumerationSpreadBps: number;
  readonly quote: EffectiveMidQuote;
  readonly control: AdapterWorkControl;
  readonly concurrency: number;
  readonly previous?: EffectiveMidSnapshot;
  readonly activity?: PreparedAmountQuoteActivity | null;
  /** Current declaration only; fresh output still exclusively uses quote. */
  readonly describeReuse?: (input: Pick<Parameters<EffectiveMidQuote>[0],
    "edge" | "amountIn" | "control">) => FamilyAmountQuoteReuseContext | null;
}): Promise<EffectiveMidSnapshot> {
  const started = Date.now();
  const { pricing, control } = input;
  if (!Number.isSafeInteger(input.concurrency) || input.concurrency < 1 ||
      !Number.isFinite(input.enumerationSpreadBps) || input.enumerationSpreadBps <= 0) {
    throw new Error("invalid effective-mid work or spread policy");
  }
  if (input.gasCostWei !== null && input.gasCostWei <= 0n) throw new Error("invalid gas cost");
  const source = Object.freeze({
    number: pricing.sourceBlock, hash: pricing.sourceBlockHash.toLowerCase(), generation: pricing.generation,
  });
  const marks = tokenToWethReferences(pricing, input.weth);
  const referenceWethInput = input.gasCostWei === null ? DEFAULT_EFFECTIVE_WETH_INPUT :
    gasReferenceInput(input.gasCostWei, { num: 1n, den: 1n }, input.enumerationSpreadBps)!;
  const amounts = new Map<string, bigint | null>();
  const edges = new Map(pricing.graph.edges.map(e => [blockScanEdgeKey(e), e]));
  const work = [...pricing.mids.keys()].map(edgeId => {
    const edge = edges.get(edgeId);
    if (!edge) throw new Error("effective mid is outside the Ready Graph");
    const token = edge.tokenIn.toLowerCase();
    if (!amounts.has(token)) {
      const mark = marks.get(token);
      amounts.set(token, !mark ? null : input.gasCostWei === null
        ? (DEFAULT_EFFECTIVE_WETH_INPUT * mark.den + mark.num - 1n) / mark.num
        : gasReferenceInput(input.gasCostWei, mark, input.enumerationSpreadBps));
    }
    return { edgeId, edge, amountIn: amounts.get(token)! };
  });
  const rows = new Array<EffectiveMidRow>(work.length);
  const closed = () => control.signal?.aborted === true ||
    (control.deadlineAtMs !== undefined && Date.now() >= control.deadlineAtMs);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const index = next++;
      const item = work[index];
      if (!item) return;
      const { edgeId, edge, amountIn } = item;
      let amountOut: bigint | null = null;
      let effectiveMid: number | null = null;
      let quoteProvenance: CompletedAmountQuote | undefined;
      let carried = false;
      let status: EffectiveMidRow["status"];
      if (amountIn === null) status = "missing-valuation";
      else if (edge.leavesStandingPosition) status = "unsupported";
      else if (closed()) status = "cancelled";
      else {
        try {
          const previous = input.previous?.rows.get(edgeId);
          const priorQuote = previous?.status === "quoted" &&
            previous.amountIn === amountIn && previous.quoteProvenance?.validAt.number === input.previous?.source.number &&
            previous.quoteProvenance?.validAt.hash === input.previous?.source.hash &&
            previous.quoteProvenance?.validAt.generation === input.previous?.source.generation
              ? previous.quoteProvenance : undefined;
          let context = priorQuote === undefined ? null :
            input.describeReuse?.({ edge, amountIn, control }) ?? null;
          const reused = context === null ? null : carryAmountQuote({
            previous: priorQuote, current: source, amountIn,
            contextFingerprint: context.contextFingerprint, policy: context.policy,
            activity: input.activity,
          });
          if (closed()) throw new Error("effective quote work retired during declaration");
          const result = reused === null
            ? await input.quote({ edge, amountIn, control, requireChainAmountQuote: true })
            : { source, amountIn, amountOut: reused.amountOut };
          if (closed()) status = "cancelled";
          else {
            if (result.source.number !== source.number || result.source.hash.toLowerCase() !== source.hash ||
                result.source.generation !== source.generation || result.amountIn !== amountIn) {
              throw new Error("effective quote changed source or amount");
            }
            amountOut = result.amountOut;
            const rate = Number(amountOut) / Number(amountIn);
            if (amountOut < 0n || !Number.isFinite(rate) || (amountOut > 0n && rate <= 0)) {
              throw new Error("invalid quote output");
            }
            status = amountOut > 0n ? "quoted" : "no-output";
            effectiveMid = amountOut > 0n ? rate : null;
            if (reused !== null) {
              quoteProvenance = reused;
              carried = true;
            } else if (status === "quoted" && "amountQuoteReuse" in result && result.amountQuoteReuse !== undefined) {
              context = result.amountQuoteReuse;
              // Only the method actually used may supply the cached pricing data.
              if (context !== null && result.methodId === context.methodId &&
                  result.methodIndex === context.methodIndex &&
                  result.methodOrderFingerprint === context.methodOrderFingerprint &&
                  result.cacheCompatibilityFingerprint === context.cacheCompatibilityFingerprint) {
                quoteProvenance = Object.freeze({ complete: true, chainAmountQuote: true,
                  quotedAt: source, validAt: source, amountIn, amountOut,
                  contextFingerprint: context.contextFingerprint, reusePolicy: context.policy });
              }
            }
          }
        } catch (error) {
          amountOut = null;
          effectiveMid = null;
          quoteProvenance = undefined;
          carried = false;
          status = closed() ? "cancelled" :
            (error as { code?: unknown })?.code === "CHAIN_AMOUNT_QUOTE_UNAVAILABLE"
              ? "unsupported" : "quote-failed";
        }
      }
      rows[index] = Object.freeze({ edgeId, instanceKey: edgeInstanceKey(edge),
        tokenIn: edge.tokenIn.toLowerCase(), tokenOut: edge.tokenOut.toLowerCase(),
        amountIn, amountOut, effectiveMid, status,
        ...(quoteProvenance === undefined ? {} : { quoteProvenance }),
        ...(carried ? { carried: true as const } : {}) });
    }
  };
  await Promise.all(Array.from({ length: Math.min(input.concurrency, work.length) }, worker));
  return Object.freeze({ source, reference: input.gasCostWei === null ? "default" : "gas",
    referenceWethInput, rows: new Map(rows.map(row => [row.edgeId, row])),
    complete: !closed() && rows.every(row => row.status !== "cancelled"), wallMs: Date.now() - started });
}

/** Best two-venue pair indication at equal reference NOTIONALS, not a
 * matched-quantity closed-loop quote, and never a sim/EV verdict. */
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
