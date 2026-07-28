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
  /**
   * The original structured failure is retained for in-process policy.
   * `revertReason` is diagnostic prose only and must never be used to decide
   * whether a failed simulation is a deterministic domain failure or an
   * infrastructure failure.
   */
  failure?: SimulationFailure;
  calldata: string;
  scriptHex?: string;
}

export interface SimulationFailure {
  readonly cause: unknown;
  readonly kind: string | null;
  readonly code: string | number | null;
}

export class BotVMSimulator {
  readonly executor: string;
  readonly owner: string;

  constructor(
    private readonly state: StateBackend,
    executor = DEFAULT_SEARCHER_EXECUTOR,
    owner = DEFAULT_SEARCHER_OWNER,
  ) {
    this.executor = executor;
    this.owner = owner;
  }

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
      const gasUsed = await this.state.getGasUsed(txHash);
      const post = await this.state.getTokenBalance(plan.profitToken, this.executor);
      await this.state.revert(snap);
      const grossProfit = post - pre;
      const success = grossProfit > 0n;
      return {
        success,
        profitToken: plan.profitToken,
        grossProfit,
        gasUsed: success ? gasUsed : 0n,
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
        failure: simulationFailure(err),
      };
    }
  }
}

function simulationFailure(error: unknown): SimulationFailure {
  const value = error !== null && typeof error === "object"
    ? error as { readonly kind?: unknown; readonly code?: unknown }
    : {};
  return {
    cause: error,
    kind: typeof value.kind === "string" && value.kind.length > 0
      ? value.kind
      : null,
    code: typeof value.code === "string" || typeof value.code === "number"
      ? value.code
      : null,
  };
}
