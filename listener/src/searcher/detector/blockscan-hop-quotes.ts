import type { DfsQuote } from "./blockscan-paired-dfs.js";

/** Best rate first, with ordinary lexical IDs breaking exact ties. */
function compareQuotes(a: DfsQuote, b: DfsQuote): number {
  const left = a.num * b.den, right = b.num * a.den;
  if (left !== right) return left > right ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function validateQuotes(quotes: readonly DfsQuote[]): void {
  const ids = new Set<string>();
  for (const quote of quotes) {
    if (ids.has(quote.id)) throw new Error("duplicate directed quote id");
    ids.add(quote.id);
    if (quote.num <= 0n || quote.den <= 0n) throw new Error("invalid directed quote amount");
    if (quote.value !== null && (quote.value.num <= 0n || quote.value.den <= 0n))
      throw new Error("invalid quote value");
  }
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

  validateQuotes(quotes);
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

/**
 * Directional neighbor eligibility for every hop, including seed legs. Production
 * calls this after selectTopHopQuotes(quotes, 1), so zero disables only the token
 * cap. This selector retains all eligible quotes of each chosen neighbor.
 *
 * Rank by the best reference-value ratio, never raw token units. Higher execution
 * value wins in both directions: in reverse it costs less input for fixed output.
 * Forward and reverse sets are independent, not their intersection. This is a
 * heuristic projection, not an exact amount quote or a certified return bound.
 */
export function selectTopHopTokens(quotes: readonly DfsQuote[], limit: number): {
  forward: Set<string>;
  reverse: Set<string>;
} {
  if (!Number.isSafeInteger(limit) || limit < 0)
    throw new Error("hop token limit must be a nonnegative safe integer");
  validateQuotes(quotes);
  if (limit === 0) {
    const ids = quotes.filter(quote => quote.value !== null).map(quote => quote.id);
    return { forward: new Set(ids), reverse: new Set(ids) };
  }

  type Neighbor = { value: NonNullable<DfsQuote["value"]>; ids: string[] };
  const select = (reverse: boolean): Set<string> => {
    const roots = new Map<string, Map<string, Neighbor>>();
    for (const quote of quotes) {
      if (quote.value === null) continue;
      const root = reverse ? quote.tokenOut : quote.tokenIn;
      const neighbor = reverse ? quote.tokenIn : quote.tokenOut;
      let neighbors = roots.get(root);
      if (!neighbors) { neighbors = new Map(); roots.set(root, neighbors); }
      const group = neighbors.get(neighbor);
      if (!group) neighbors.set(neighbor, { value: quote.value, ids: [quote.id] });
      else {
        group.ids.push(quote.id);
        if (quote.value.num * group.value.den > group.value.num * quote.value.den)
          group.value = quote.value;
      }
    }
    const selected = new Set<string>();
    for (const neighbors of roots.values()) {
      const ranked = [...neighbors].sort(([a, left], [b, right]) => {
        const l = left.value.num * right.value.den, r = right.value.num * left.value.den;
        if (l !== r) return l > r ? -1 : 1;
        return a < b ? -1 : a > b ? 1 : 0;
      });
      for (let i = 0; i < Math.min(limit, ranked.length); i++) {
        for (const id of ranked[i]![1].ids) selected.add(id);
      }
    }
    return selected;
  };
  return { forward: select(false), reverse: select(true) };
}
