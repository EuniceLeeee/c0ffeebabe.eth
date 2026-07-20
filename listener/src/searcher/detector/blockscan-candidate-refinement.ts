import type { StateBackend } from "../../shared/state/state-backend.js";
import { quote } from "../solver/quoter.js";
import type { BlockScanOpportunity } from "./detector.js";

const DEFAULT_CONCURRENCY = 24;

export interface BlockScanRefinementResult {
  opportunities: BlockScanOpportunity[];
  attempted: number;
  positive: number;
  negative: number;
  failed: number;
  deadlineHit: boolean;
}

export interface BlockScanProbeDiagnostic {
  index: number;
  status: "positive" | "negative" | "failed" | "unprobed";
  marginBps: number | null;
}

interface RankedProbe {
  opportunity: BlockScanOpportunity;
  marginBps: number;
  priority: number;
  index: number;
}

class ProbeDeadlineError extends Error {}

/**
 * Cheap exact route probe before GSS/final-sim. Quotes every leg through the
 * production dispatcher without the approximate pool cache, then keeps the
 * highest normalized expected returns. Failed/unprobed routes remain fallback
 * entries; routes proven non-positive at the probe are removed.
 */
export async function refineBlockScanCandidates(
  state: StateBackend,
  opportunities: readonly BlockScanOpportunity[],
  maxCandidates: number,
  deadlineAtMs: number,
  pricedTokens: ReadonlyMap<string, { maxBorrow: bigint }>,
  onProbe?: (diagnostic: BlockScanProbeDiagnostic) => void,
  concurrency = DEFAULT_CONCURRENCY,
): Promise<BlockScanRefinementResult> {
  const ranked: RankedProbe[] = [];
  const fallback: Array<{ opportunity: BlockScanOpportunity; index: number }> = [];
  let attempted = 0;
  let negative = 0;
  let failed = 0;
  let next = 0;
  let deadlineHit = false;

  const workers = Array.from(
    { length: Math.max(1, Math.min(concurrency, opportunities.length)) },
    async () => {
      for (;;) {
        const index = next++;
        if (index >= opportunities.length) return;
        const opportunity = opportunities[index];
        if (Date.now() >= deadlineAtMs) {
          deadlineHit = true;
          fallback.push({ opportunity, index });
          onProbe?.({ index, status: "unprobed", marginBps: null });
          continue;
        }
        attempted++;
        try {
          const marginBps = await exactProbeMarginBps(state, opportunity, deadlineAtMs);
          if (marginBps > 0) {
            ranked.push({
              opportunity,
              marginBps,
              priority: exactProbePriority(opportunity, marginBps, pricedTokens),
              index,
            });
            onProbe?.({ index, status: "positive", marginBps });
          }
          else {
            negative++;
            onProbe?.({ index, status: "negative", marginBps });
          }
        } catch (error) {
          fallback.push({ opportunity, index });
          if (error instanceof ProbeDeadlineError) {
            deadlineHit = true;
            onProbe?.({ index, status: "unprobed", marginBps: null });
          } else {
            failed++;
            onProbe?.({ index, status: "failed", marginBps: null });
          }
        }
      }
    },
  );
  await Promise.all(workers);

  ranked.sort((a, b) =>
    b.priority - a.priority || b.marginBps - a.marginBps || a.index - b.index
  );
  fallback.sort((a, b) => a.index - b.index);
  const selected = [
    ...ranked.map((entry) => entry.opportunity),
    ...fallback.map((entry) => entry.opportunity),
  ].slice(0, maxCandidates);
  return {
    opportunities: selected,
    attempted,
    positive: ranked.length,
    negative,
    failed,
    deadlineHit: deadlineHit || attempted < opportunities.length,
  };
}

/** Compare exact probe returns across flash assets without comparing raw units. */
export function exactProbePriority(
  opportunity: BlockScanOpportunity,
  marginBps: number,
  pricedTokens: ReadonlyMap<string, { maxBorrow: bigint }>,
): number {
  const maxBorrow = pricedTokens.get(opportunity.flashToken.toLowerCase())?.maxBorrow ?? 0n;
  if (maxBorrow <= 0n) return 0;
  const ceiling = minBigint(opportunity.searchSeed.searchCenter, opportunity.searchSeed.maxInput);
  const capacityShare = Number(ceiling) / Number(maxBorrow);
  const priority = marginBps * capacityShare;
  return Number.isFinite(priority) && priority > 0 ? priority : 0;
}

async function exactProbeMarginBps(
  state: StateBackend,
  opportunity: BlockScanOpportunity,
  deadlineAtMs: number,
): Promise<number> {
  const ceiling = minBigint(opportunity.searchSeed.searchCenter, opportunity.searchSeed.maxInput);
  const amountIn = maxBigint(9n, ceiling / 1024n);
  if (amountIn > ceiling || amountIn <= 0n) return 0;
  let amount = amountIn;
  for (const edge of opportunity.seedEdges) {
    amount = await beforeProbeDeadline(
      deadlineAtMs,
      () => quote(
        edge.adapterId,
        edge.target,
        edge.tokenIn,
        edge.tokenOut,
        amount,
        state,
        undefined,
        edge.v4PoolKey,
        edge.poolToken0,
        edge.poolToken1,
      ),
    );
    if (amount <= 0n) return 0;
  }
  const profit = amount - amountIn;
  if (profit <= 0n) return 0;
  const marginBps = Number(profit) * 10_000 / Number(amountIn);
  return Number.isFinite(marginBps) && marginBps > 0 ? marginBps : 0;
}

async function beforeProbeDeadline<T>(
  deadlineAtMs: number,
  operation: () => Promise<T>,
): Promise<T> {
  const remainingMs = deadlineAtMs - Date.now();
  if (remainingMs <= 0) throw new ProbeDeadlineError("exact probe deadline reached");

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new ProbeDeadlineError("exact probe deadline reached")),
          remainingMs,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function minBigint(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

function maxBigint(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}
