import { BLOCKSCAN_ENUMERATION_DEFAULTS } from "../blockscan-enumeration-config.js";
import { enumeratePairedDfs, enumeratePairedLayered, type PairedEnumerationInput, type PairedEnumerationMethod } from "./blockscan-paired-dfs.js";
import { enumerateRustPaired } from "./blockscan-paired-rust.js";
import { enumerateJointDfs } from "./blockscan-joint-dfs.js";
import { selectTopHopQuotes } from "./blockscan-hop-quotes.js";

export type PairedEnumerationBackend = "rust" | "typescript";
export function resolvePairedEnumerationBackend(raw?: string): PairedEnumerationBackend {
  const backend = raw ?? BLOCKSCAN_ENUMERATION_DEFAULTS.backend;
  if (backend !== "rust" && backend !== "typescript")
    throw new Error("SEARCHER_BLOCKSCAN_ENUMERATION_BACKEND must be rust or typescript");
  if (backend === "rust" && !BLOCKSCAN_ENUMERATION_DEFAULTS.rustEnabled)
    throw new Error("Rust enumeration is disabled in the production pipeline; use typescript");
  return backend;
}

function resourceOption(raw: string | undefined, fallback: number, maximum: number, name: string): number {
  const value = raw === undefined ? fallback : Number(raw);
  if ((raw !== undefined && !/^\d+$/.test(raw)) || !Number.isSafeInteger(value) || value < 1 || value > maximum)
    throw new Error(`${name} must be an integer from 1 to ${maximum}`);
  return value;
}
export const resolveRustEnumerationThreads = (raw?: string) =>
  resourceOption(raw, BLOCKSCAN_ENUMERATION_DEFAULTS.rustThreads, 8, "SEARCHER_BLOCKSCAN_RUST_THREADS");
export const resolveRustEnumerationScratchMb = (raw?: string) =>
  resourceOption(raw, BLOCKSCAN_ENUMERATION_DEFAULTS.rustScratchMb, 2048, "SEARCHER_BLOCKSCAN_RUST_SCRATCH_MB");

export function enumeratePaired(input: PairedEnumerationInput, method: PairedEnumerationMethod,
  backend: PairedEnumerationBackend) {
  // Validate at dispatch too: a deserialized/explicit config cannot bypass the switch.
  resolvePairedEnumerationBackend(backend);
  const hopQuotesPerPair = input.hopQuotesPerPair ?? BLOCKSCAN_ENUMERATION_DEFAULTS.hopQuotesPerPair;
  const quotes = selectTopHopQuotes(input.quotes, hopQuotesPerPair);
  const kept = new Set(quotes.map(quote => quote.id));
  // Anchor buy/sell legs obey the same per-hop pool cap as both frontiers.
  // Other signal policy (including its own top-K) remains unchanged.
  const signals = input.signals.filter(signal => kept.has(signal.buy) && kept.has(signal.sell));
  const selected = { ...input, quotes, signals };
  const stats = backend === "rust" ? enumerateRustPaired(selected, method)
    : method === "joint-dfs" ? enumerateJointDfs(selected)
    : method === "dfs" ? enumeratePairedDfs(selected)
    : method === "layered" ? enumeratePairedLayered(selected)
    : (() => { throw new Error("unsupported enumeration method"); })();
  return { ...stats, hopQuotesPerPair, hopQuotesBefore: input.quotes.length,
    hopQuotesSelected: quotes.length, hopQuotesPruned: input.quotes.length - quotes.length,
    hopSignalPairsSelected: signals.length };
}
