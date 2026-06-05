import { ADDR } from "../../shared/constants/addresses.js";
import type { StateBackend } from "../../shared/state/state-backend.js";
import type { OrderflowEvent } from "../orderflow/manual-source.js";
import { detectPoolImpact } from "./pool-impact.js";

export interface Opportunity {
  kind: "backrun-arb";
  victimTxHash: string;
  blockNumber: number;
  affectedPools: string[];
  affectedTokens: string[];
  startToken: string;
  profitToken: string;
  victimAmountIn: bigint;
  hints: Record<string, unknown>;
}

export interface Detector {
  detect(event: OrderflowEvent, state: StateBackend): Promise<Opportunity[]>;
}

export class BackrunDetector implements Detector {
  async detect(event: OrderflowEvent, _state: StateBackend): Promise<Opportunity[]> {
    const impacts = detectPoolImpact(event);
    return impacts
      .filter((impact) => impact.direction === "wstUSR-to-DOLA")
      .map((impact) => ({
        kind: "backrun-arb" as const,
        victimTxHash: event.txHash,
        blockNumber: event.blockNumber,
        affectedPools: [impact.pool],
        affectedTokens: [ADDR.WSTUSR, ADDR.DOLA],
        startToken: ADDR.WSTUSR,
        profitToken: ADDR.WSTUSR,
        victimAmountIn: impact.amountIn,
        hints: { impact },
      }));
  }
}

