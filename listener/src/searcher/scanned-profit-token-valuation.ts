import { ADDR } from "../shared/constants/addresses.js";
import type { ProfitTokenValuation } from "./profit-token-valuation.js";
import type { BlockScanStateSnapshot } from "./blockscan-state-coordinator.js";
import type { EffectivePricingInput } from "./blockscan-effective-mid.js";
import type { CanonicalSource } from "./venues/adapter-request-program.js";
import { blockScanEdgeKey } from "./venues/blockscan-state-capability.js";
import { edgeInstanceKey } from "./venues/route-instance-identity.js";

type Mark = { num: bigint; den: bigint; maxInput: bigint | null; path: readonly Quote[] };
type Quote = { id: string; from: string; to: string; amountIn: bigint; amountOut: bigint };
const MAX_REFERENCE_HOPS = 3;
const HASH = /^0x[0-9a-fA-F]{64}$/;

/** Frozen, source-bound market marks from the EXISTING effective publication.
 * No token whitelist, USD peg, protocol math, raw-mid fallback or network I/O.
 * These are reference valuations, not proof of liquidation at that price.
 * As with sizing, shortest directed paths win, then the best quoted rate.
 * Unlike sizing, use integer net amounts and do not extrapolate beyond the
 * smallest sampled amount along the selected path. */
export function createScannedProfitTokenValuation(
  pricing: (EffectivePricingInput & Pick<BlockScanStateSnapshot, "effectiveMids">) | null,
  source: CanonicalSource,
  weth = ADDR.WETH,
): ProfitTokenValuation {
  if (!Number.isSafeInteger(source.number) || source.number < 0 || !HASH.test(source.hash)) {
    throw new Error("scanned profit valuation requires a canonical source");
  }
  const anchor = Object.freeze({ number: source.number, hash: source.hash.toLowerCase() });
  const marks = new Map<string, Mark>([[weth.toLowerCase(), { num: 1n, den: 1n, maxInput: null, path: [] }]]);
  const effective = pricing?.effectiveMids;
  const compatible = pricing !== null && effective !== undefined && effective.complete &&
    pricing.sourceBlock === source.number && pricing.sourceBlockHash.toLowerCase() === anchor.hash &&
    pricing.generation === source.generation && effective.source.number === source.number &&
    effective.source.hash.toLowerCase() === anchor.hash && effective.source.generation === source.generation;
  if (compatible) {
    const resolved = new Set(pricing.coverage.resolvedEdgeKeys);
    const quotes: Quote[] = [];
    for (const edge of pricing.graph.edges) {
      if (edge.leavesStandingPosition || (edge.slotKind !== "swap" && edge.slotKind !== "protocol")) continue;
      const id = blockScanEdgeKey(edge), row = effective.rows.get(id);
      if (!resolved.has(id) || !row || row.status !== "quoted" || row.edgeId !== id ||
          row.instanceKey !== edgeInstanceKey(edge) ||
          row.tokenIn.toLowerCase() !== edge.tokenIn.toLowerCase() || row.tokenOut.toLowerCase() !== edge.tokenOut.toLowerCase() ||
          row.amountIn === null || row.amountOut === null || row.amountIn <= 0n || row.amountOut <= 0n) continue;
      // Older rows are valid only as members of this complete publication:
      // the producer already proved their state untouched. Never re-label a
      // future observation or another hash at this height as a carry.
      const at = row.quotedAt;
      if (!at || !Number.isSafeInteger(at.number) || at.number < 0 || !HASH.test(at.hash) ||
          !Number.isSafeInteger(at.generation) || at.generation < 0 ||
          at.number > source.number || at.generation > source.generation ||
          (at.number === source.number && at.hash.toLowerCase() !== anchor.hash)) continue;
      quotes.push({ id, from: row.tokenIn.toLowerCase(), to: row.tokenOut.toLowerCase(),
        amountIn: row.amountIn, amountOut: row.amountOut });
    }
    quotes.sort((a, b) => a.id.localeCompare(b.id));
    for (let hop = 0; hop < MAX_REFERENCE_HOPS; hop++) {
      const layer = new Map<string, Mark>();
      for (const q of quotes) {
        if (marks.has(q.from)) continue;
        const tail = marks.get(q.to); if (!tail) continue;
        const propagatedCap = tail.maxInput === null ? q.amountIn : tail.maxInput * q.amountIn / q.amountOut;
        const maxInput = propagatedCap < q.amountIn ? propagatedCap : q.amountIn;
        if (maxInput <= 0n) continue;
        const mark: Mark = { num: q.amountOut * tail.num, den: q.amountIn * tail.den,
          maxInput, path: Object.freeze([q, ...tail.path]) };
        const previous = layer.get(q.from);
        if (!previous || mark.num * previous.den > previous.num * mark.den ||
            (mark.num * previous.den === previous.num * mark.den && mark.maxInput! > previous.maxInput!)) {
          layer.set(q.from, mark);
        }
      }
      if (layer.size === 0) break;
      for (const [token, mark] of layer) marks.set(token, mark);
    }
  }
  return Object.freeze({
    source: anchor,
    canValue: (token: string) => marks.has(token.toLowerCase()),
    valueInEth(token: string, amount: bigint): bigint | null {
      const mark = marks.get(token.toLowerCase());
      if (!mark || (mark.maxInput !== null && (amount < 0n ? -amount : amount) > mark.maxInput)) return null;
      // Round each raw-token conversion, not just the final rational product.
      // Positive profit rounds down; losses round away from zero.
      let value = amount < 0n ? -amount : amount;
      for (const q of mark.path) {
        if (value > q.amountIn) return null;
        value = amount >= 0n ? value * q.amountOut / q.amountIn
          : (value * q.amountOut + q.amountIn - 1n) / q.amountIn;
      }
      return amount < 0n ? -value : value;
    },
  });
}
