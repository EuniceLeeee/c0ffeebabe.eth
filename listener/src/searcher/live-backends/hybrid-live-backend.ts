import type {
  LiveStateBackend,
  PrepareInput,
  PreparedState,
  QuoteRequest,
  QuoteResult,
} from "../live-state-backend.js";
import type { SimulationResult } from "../simulator/botvm-simulator.js";
import type { ResolvedPlan } from "../solver/solver.js";

export class HybridLiveBackend implements LiveStateBackend {
  readonly kind = "hybrid" as const;

  get executor(): string {
    return this.fast.executor;
  }

  constructor(
    private readonly fast: LiveStateBackend,
    private readonly verifier: LiveStateBackend,
  ) {}

  supportsPath(input: PrepareInput): boolean {
    return this.fast.supportsPath ? this.fast.supportsPath(input) : true;
  }

  async prepareVictimState(input: PrepareInput): Promise<PreparedState> {
    return this.fast.prepareVictimState(input);
  }

  async quote(req: QuoteRequest): Promise<QuoteResult> {
    return this.fast.quote(req);
  }

  async call(req: { to: string; data: string; from?: string }): Promise<string> {
    if (!this.fast.call) throw new Error("hybrid fast backend exposes no call");
    return this.fast.call(req);
  }

  async simulate(plan: ResolvedPlan): Promise<SimulationResult> {
    const fastResult = await this.fast.simulate(plan);
    if (!fastResult.success || fastResult.netProfit <= 0n) return fastResult;

    const verifyResult = this.verifier.finalVerify
      ? await this.verifier.finalVerify(plan)
      : await this.verifier.simulate(plan);

    if (!verifyResult.success || verifyResult.netProfit <= 0n) {
      return {
        ...verifyResult,
        success: false,
        revertReason: verifyResult.revertReason ?? "rejected-by-rpc-final-verify",
      };
    }
    return verifyResult;
  }
}
