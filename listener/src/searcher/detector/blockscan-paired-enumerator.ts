import { BLOCKSCAN_ENUMERATION_DEFAULTS } from "../blockscan-enumeration-config.js";
import { enumeratePairedDfs, enumeratePairedLayered, type PairedEnumerationInput, type PairedEnumerationMethod } from "./blockscan-paired-dfs.js";
import { enumerateRustPaired } from "./blockscan-paired-rust.js";

export type PairedEnumerationBackend = "rust" | "typescript";
export function resolvePairedEnumerationBackend(raw?: string): PairedEnumerationBackend {
  if (raw === undefined) return BLOCKSCAN_ENUMERATION_DEFAULTS.backend;
  if (raw === "rust" || raw === "typescript") return raw;
  throw new Error("SEARCHER_BLOCKSCAN_ENUMERATION_BACKEND must be rust or typescript");
}

export function enumeratePaired(input: PairedEnumerationInput, method: PairedEnumerationMethod,
  backend: PairedEnumerationBackend) {
  if (backend === "rust") return enumerateRustPaired(input, method);
  if (backend === "typescript") return (method === "layered" ? enumeratePairedLayered : enumeratePairedDfs)(input);
  throw new Error("unsupported enumeration backend");
}
