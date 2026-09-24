import { BLOCKSCAN_ENUMERATION_DEFAULTS } from "../blockscan-enumeration-config.js";
import { enumeratePairedDfs, enumeratePairedLayered, type PairedEnumerationInput, type PairedEnumerationMethod } from "./blockscan-paired-dfs.js";
import { enumerateRustPaired } from "./blockscan-paired-rust.js";

export type PairedEnumerationBackend = "rust" | "typescript";
export function resolvePairedEnumerationBackend(raw?: string): PairedEnumerationBackend {
  if (raw === undefined) return BLOCKSCAN_ENUMERATION_DEFAULTS.backend;
  if (raw === "rust" || raw === "typescript") return raw;
  throw new Error("SEARCHER_BLOCKSCAN_ENUMERATION_BACKEND must be rust or typescript");
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
  if (backend === "rust") return enumerateRustPaired(input, method);
  if (backend === "typescript") return (method === "layered" ? enumeratePairedLayered : enumeratePairedDfs)(input);
  throw new Error("unsupported enumeration backend");
}
