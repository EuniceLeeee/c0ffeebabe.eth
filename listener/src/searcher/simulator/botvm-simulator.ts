import type { StateBackend } from "../../shared/state/state-backend.js";
import { compilePlan } from "../../shared/compiler/compiler.js";
import { bytesToHex } from "../../shared/compiler/encoder.js";
import {
  buildExecuteCalldata,
  DEFAULT_SEARCHER_EXECUTOR,
  DEFAULT_SEARCHER_OWNER,
} from "../../shared/executor/botvm-executor.js";
import type { ResolvedPlan } from "../solver/solver.js";

export interface SimulationResult {
  success: boolean;
  profitToken: string;
  grossProfit: bigint;
  gasUsed: bigint;
  netProfit: bigint;
  revertReason?: string;
  calldata: string;
  scriptHex?: string;
}

export class BotVMSimulator {
  constructor(
    private readonly state: StateBackend,
    private readonly executor = DEFAULT_SEARCHER_EXECUTOR,
    private readonly owner = DEFAULT_SEARCHER_OWNER,
  ) {}

  async simulate(plan: ResolvedPlan): Promise<SimulationResult> {
    const snap = await this.state.snapshot();
    const pre = await this.state.getTokenBalance(plan.profitToken, this.executor);
    let calldata = "0x";
    try {
      const script = compilePlan(plan.root, this.executor);
      calldata = buildExecuteCalldata(script);
      const txHash = await this.state.send({
        from: this.owner,
        to: this.executor,
        data: calldata,
        gas: "0x1000000",
      });
      const post = await this.state.getTokenBalance(plan.profitToken, this.executor);
      await this.state.revert(snap);
      const grossProfit = post - pre;
      return {
        success: grossProfit > 0n,
        profitToken: plan.profitToken,
        grossProfit,
        gasUsed: 0n,
        netProfit: grossProfit,
        calldata,
        scriptHex: bytesToHex(script),
      };
    } catch (err) {
      await this.state.revert(snap);
      return {
        success: false,
        profitToken: plan.profitToken,
        grossProfit: 0n,
        gasUsed: 0n,
        netProfit: 0n,
        calldata,
        revertReason: err instanceof Error ? err.message : String(err),
      };
    }
  }
}

