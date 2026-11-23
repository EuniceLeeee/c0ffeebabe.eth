import type { BlockScanObservedHeader } from "./blockscan-observed-header.js";
import type { CanonicalSource } from "./venues/adapter-request-program.js";
import type { ResolvedPlan } from "./solver/solver.js";
import type { SimulationResult } from "./simulator/botvm-simulator.js";
import { selectedBlockScanAmountSimulation } from "./simulator/blockscan-sim-amount-selector.js";
import { StateCallAbortedError } from "../shared/state/state-backend.js";

export type BlockScanFinalSimulationMethod = "anvil" | "eth_simulateV1";

/** Explicit selection, independent of the upstream provider. Never auto-fallback. */
export function resolveBlockScanFinalSimulationMethod(
  value = process.env.SEARCHER_BLOCKSCAN_FINAL_SIM_METHOD,
): BlockScanFinalSimulationMethod {
  if (value === undefined) return "eth_simulateV1";
  if (value === "anvil" || value === "eth_simulateV1") return value;
  throw new Error("SEARCHER_BLOCKSCAN_FINAL_SIM_METHOD must be anvil or eth_simulateV1");
}

interface DirectSimulationContext {
  readonly source: CanonicalSource;
  readonly header: BlockScanObservedHeader;
  readonly signal: AbortSignal;
  readonly deadlineAtMs: number;
  readonly captureAmountEvidence?: boolean;
}

/** A stateless execution capability; the existing S5 runtime owns its slots. */
export interface BlockScanDirectFinalSimulation {
  readonly concurrency: number;
  simulate(plan: ResolvedPlan, context: DirectSimulationContext): Promise<SimulationResult>;
  /** Only the issuer can validate the measured result against a freshly prepared request. */
  reuseAmountSimulation?(plan: ResolvedPlan, context: DirectSimulationContext, measured: SimulationResult): SimulationResult | null;
}

/** Called inside the ordinary S5 runner: entry/exit generation, plan commitment,
 * canonical-head, EV and submission gates are shared by reuse and fresh execution. */
export async function runBlockScanFinalWithAmountEvidence({ simulator, plan, context, onDisposition }: {
  simulator: BlockScanDirectFinalSimulation;
  plan: ResolvedPlan;
  context: DirectSimulationContext;
  onDisposition?: (value: "reused" | "fresh") => void;
}): Promise<SimulationResult> {
  const checkActive = () => {
    context.signal.throwIfAborted();
    if (!Number.isSafeInteger(context.deadlineAtMs) || Date.now() >= context.deadlineAtMs)
      throw new StateCallAbortedError("final simulation deadline aborted", "deadline");
  };
  checkActive();
  const measured = selectedBlockScanAmountSimulation(plan);
  const verified = measured && simulator.reuseAmountSimulation?.(plan, context, measured);
  checkActive();
  try { onDisposition?.(verified ? "reused" : "fresh"); } catch { /* Timing only. */ }
  return verified ?? simulator.simulate(plan, context);
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
