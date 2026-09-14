import type { BlockScanObservedHeader } from "./blockscan-observed-header.js";
import type { CanonicalSource } from "./venues/adapter-request-program.js";
import type { ResolvedPlan } from "./solver/solver.js";
import type { SimulationResult } from "./simulator/botvm-simulator.js";

export type BlockScanFinalSimulationMethod = "anvil" | "eth_simulateV1";

/** Explicit selection, independent of the upstream provider. Never auto-fallback. */
export function resolveBlockScanFinalSimulationMethod(
  value = process.env.SEARCHER_BLOCKSCAN_FINAL_SIM_METHOD,
): BlockScanFinalSimulationMethod {
  if (value === undefined) return "eth_simulateV1";
  if (value === "anvil" || value === "eth_simulateV1") return value;
  throw new Error("SEARCHER_BLOCKSCAN_FINAL_SIM_METHOD must be anvil or eth_simulateV1");
}

/** A stateless execution capability; the existing S5 runtime owns its slots. */
export interface BlockScanDirectFinalSimulation {
  readonly concurrency: number;
  simulate(plan: ResolvedPlan, context: {
    readonly source: CanonicalSource;
    readonly header: BlockScanObservedHeader;
    readonly signal: AbortSignal;
    readonly deadlineAtMs: number;
  }): Promise<SimulationResult>;
}

/** Older test/replay header readers may omit execution context: do not invent it. */
export function requireFinalSimulationHeader(
  header: Pick<BlockScanObservedHeader, "number" | "hash" | "parentHash"> &
    Partial<BlockScanObservedHeader>,
): BlockScanObservedHeader {
  if (!Number.isSafeInteger(header.timestamp) ||
      typeof header.baseFeePerGas !== "bigint" || header.baseFeePerGas < 0n ||
      typeof header.gasUsed !== "bigint" || header.gasUsed < 0n ||
      typeof header.gasLimit !== "bigint" || header.gasLimit <= 0n ||
      !Array.isArray(header.transactionHashes)) {
    throw new Error("direct final simulation requires the complete observed source header");
  }
  return header as BlockScanObservedHeader;
}
