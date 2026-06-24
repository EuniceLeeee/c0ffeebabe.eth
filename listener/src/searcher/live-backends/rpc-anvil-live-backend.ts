import type { StateBackend } from "../../shared/state/state-backend.js";
import type {
  LiveStateBackend,
  PrepareInput,
  PreparedState,
  QuoteRequest,
  QuoteResult,
} from "../live-state-backend.js";
import type { SimulationResult } from "../simulator/botvm-simulator.js";
import { BotVMSimulator } from "../simulator/botvm-simulator.js";
import { quote } from "../solver/quoter.js";
import type { ResolvedPlan } from "../solver/solver.js";

export class RpcAnvilLiveBackend implements LiveStateBackend {
  readonly kind = "rpc" as const;

  get executor(): string {
    return this.simulator.executor;
  }

  constructor(
    private readonly state: StateBackend,
    private readonly simulator: BotVMSimulator,
  ) {}

  async prepareVictimState(input: PrepareInput): Promise<PreparedState> {
    // The Anvil path applies the victim impact inline in main.ts (impersonateSwap
    // / applyRawTx) before this is called, so there is nothing extra to prepare.
    return {
      blockNumber: input.event.blockNumber,
      mode: input.event.rawTx === "0x" ? "hash-only" : "rawTx",
    };
  }

  async quote(req: QuoteRequest): Promise<QuoteResult> {
    const started = Date.now();
    const amountOut = await quote(
      req.adapterId,
      req.target,
      req.tokenIn,
      req.tokenOut,
      req.amountIn,
      this.state,
    );
    return { amountOut, latencyMs: Date.now() - started };
  }

  simulate(plan: ResolvedPlan): Promise<SimulationResult> {
    return this.simulator.simulate(plan);
  }

  finalVerify(plan: ResolvedPlan): Promise<SimulationResult> {
    return this.simulator.simulate(plan);
  }
}
