import type { DfsQuote } from "./blockscan-paired-dfs.js";

/** Best rate first, with ordinary lexical IDs breaking exact ties. */
function compareQuotes(a: DfsQuote, b: DfsQuote): number {
  const left = a.num * b.den, right = b.num * a.den;
  if (left !== right) return left > right ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Heuristic projection of the immutable effective table, not an exact amount
 * quote or a certified return bound. Tokens follow DfsQuote's normalized contract.
 * Positive limits retain one best eligible variant per instance, then the top N
 * instances per ordered token pair. Survivors keep their input traversal order.
 * Zero preserves the original array and all legacy variants, after validation.
 */
export function selectTopHopQuotes(quotes: readonly DfsQuote[], limit: number): readonly DfsQuote[] {
  if (!Number.isSafeInteger(limit) || limit < 0)
    throw new Error("hop quote limit must be a nonnegative safe integer");

  const ids = new Set<string>();
  for (const quote of quotes) {
    if (ids.has(quote.id)) throw new Error("duplicate directed quote id");
    ids.add(quote.id);
    if (quote.num <= 0n || quote.den <= 0n) throw new Error("invalid directed quote amount");
    if (quote.value !== null && (quote.value.num <= 0n || quote.value.den <= 0n))
      throw new Error("invalid quote value");
  }
  if (limit === 0) return quotes;

  const pairs = new Map<string, Map<string, Map<string, DfsQuote>>>();
  for (const quote of quotes) {
    if (quote.value === null) continue;
    let outputs = pairs.get(quote.tokenIn);
    if (!outputs) { outputs = new Map(); pairs.set(quote.tokenIn, outputs); }
    let instances = outputs.get(quote.tokenOut);
    if (!instances) { instances = new Map(); outputs.set(quote.tokenOut, instances); }
    const best = instances.get(quote.instance);
    if (!best || compareQuotes(quote, best) < 0) instances.set(quote.instance, quote);
  }

  const selected = new Set<string>();
  for (const outputs of pairs.values()) {
    for (const instances of outputs.values()) {
      const ranked = [...instances.values()].sort(compareQuotes);
      for (let i = 0; i < Math.min(limit, ranked.length); i++) selected.add(ranked[i]!.id);
    }
  }
  return quotes.filter(quote => selected.has(quote.id));
}
