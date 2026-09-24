import type { JsonRpcProvider } from "ethers";
import type { CanonicalSource } from "./venues/adapter-request-program.js";
import type { OrderflowEvent } from "./orderflow/manual-source.js";
import type { EvFeeEnvironment } from "./ev-evaluator.js";
import type { SimulationResult } from "./simulator/botvm-simulator.js";
import type { SourceBlockSimulationResult } from "./simulator/source-block.js";

export type HistoricalBackrunMode = "materialized-source";

/** State/fee selection only. Both modes use the same live backrun pipeline. */
export async function resolveBackrunExecutionSource(input: {
  historicalMode?: HistoricalBackrunMode;
  dryRun: boolean;
  path: string;
  event: OrderflowEvent;
  latestBlock: number;
  generation: number;
  provider: Pick<JsonRpcProvider, "getBlock">;
  materializedProvider: Pick<JsonRpcProvider, "getBlock">;
}): Promise<{
  source: CanonicalSource;
  feeEnvironment?: EvFeeEnvironment;
}> {
  const historical = input.historicalMode !== undefined;
  if (historical && (input.historicalMode !== "materialized-source" || !input.dryRun ||
      input.path !== "rawTx" || input.event.victimState !== "materialized" ||
      input.event.logsCompleteness !== "complete-receipt")) {
    throw new Error("historical backrun requires dry-run and a materialized complete raw transaction");
  }
  const number = historical || input.path === "mined" ? input.event.blockNumber : input.latestBlock;
  const provider = historical ? input.materializedProvider : input.provider;
  const header = await provider.getBlock(number);
  if (!header?.hash || header.number !== number) throw new Error("backrun execution source unavailable");
  if (historical && (number !== input.latestBlock + 1 ||
      header.hash.toLowerCase() !== input.event.receiptBlockHash?.toLowerCase() ||
      header.parentHash.toLowerCase() !== input.event.sourceBlockHash?.toLowerCase() ||
      header.parentHash.toLowerCase() !== input.event.receiptParentBlockHash?.toLowerCase() ||
      input.event.receiptBlockNumber !== number)) {
    throw new Error("historical backrun materialized source does not match trigger receipt");
  }
  const source = Object.freeze({ number, hash: header.hash.toLowerCase(), generation: input.generation });
  return { source, ...(historical ? { feeEnvironment: { mode: "source-block" as const,
    sourceBlockHash: source.hash } } : {}) };
}

export function assertBackrunSourceSimulation(sim: SimulationResult, source: CanonicalSource): SourceBlockSimulationResult["sourceBlockEvidence"] {
  const proof = (sim as SourceBlockSimulationResult).sourceBlockEvidence;
  if (!proof || proof.executionMode !== "source-block" || proof.source.number !== source.number ||
      proof.source.hash !== source.hash || proof.source.generation !== source.generation ||
      !/^(0|[1-9][0-9]*)$/.test(proof.baseFeePerGas) ||
      (sim.success && (!proof.repaymentVerified || !proof.conservationVerified))) {
    throw new Error("historical backrun final simulation is not bound to the materialized source");
  }
  return proof;
}
