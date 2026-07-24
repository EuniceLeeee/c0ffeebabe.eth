import type { StateBackend } from "../shared/state/state-backend.js";
import type { Detector } from "./detector/detector.js";
import type { ManualVictimSource } from "./orderflow/manual-source.js";
import type { Planner } from "./planner/planner.js";
import type { JsonRpcProvider } from "ethers";
import type { Solver, SolveOptions } from "./solver/solver.js";
import { PoolStateCache } from "./solver/pool-state-cache.js";
import type { BotVMSimulator } from "./simulator/botvm-simulator.js";
import type { BundleRouter } from "./execution/bundle-router.js";
import type { PathTemplate } from "./templates/path-template.js";

export interface FixtureResult {
  victimTxHash: string;
  candidatesEnumerated: number;
  candidatesProfitable: number;
  bestNetProfit: bigint;
  bestPath: string;
}

export class HotPathSearcher {
  constructor(
    private readonly orderflow: ManualVictimSource,
    private readonly state: StateBackend,
    private readonly detector: Detector,
    private readonly planner: Planner,
    private readonly solver: Solver,
    private readonly simulator: BotVMSimulator,
    private readonly bundleRouter: BundleRouter,
    private readonly templates: PathTemplate[],
    private readonly prepareExecutor?: () => Promise<void>,
    private readonly solveOptions?: SolveOptions,
    mainnetProvider?: JsonRpcProvider,
  ) {
    this.cache = new PoolStateCache(mainnetProvider);
  }

  private readonly cache: PoolStateCache;

  async run(): Promise<number> {
    const results = await this.runDetailed();
    return results.reduce((n, r) => n + r.candidatesProfitable, 0);
  }

  /**
   * Per-fixture detailed run. AC-3 uses this for fine-grained assertions:
   *   - candidatesEnumerated >= 2
   *   - bestNetProfit >= threshold
   */
  async runDetailed(): Promise<FixtureResult[]> {
    const results: FixtureResult[] = [];
    for await (const event of this.orderflow.next()) {
      console.log(`[searcher/ac3] prepare victim post-state ${event.txHash}`);
      const stateResult = await this.state.prepareVictimPostState({
        txHash: event.txHash,
        rawTx: event.rawTx,
        blockNumber: event.blockNumber,
        transactionIndex: event.transactionIndex ?? 0,
        previousTxHash: event.previousTxHash,
        from: event.from,
        nonce: event.nonce,
        preferSequentialPrefix: event.preferSequentialPrefix,
      });
      console.log(
        `[searcher/ac3] state: mode=${stateResult.mode} nonce ${stateResult.nonceBefore}->${stateResult.nonceAfter}`,
      );
      console.log("[searcher/ac3] install executor");
      await this.prepareExecutor?.();
      // Fork advanced to this fixture's victim post-state — drop stale warmed
      // pool state so local-math quotes reflect the new balances. v3 tick data
      // is read directly at the fixture's block.
      this.cache.clear();
      this.cache.setTickBlock(event.blockNumber);

      const opportunities = await this.detector.detect({
        ...event,
        victimState: "materialized",
      }, this.state);
      console.log(`[searcher/ac3] detector: ${opportunities.length} opportunities`);

      let candidatesEnumerated = 0;
      let candidatesProfitable = 0;
      let bestNetProfit = 0n;
      let bestPath = "";
      let reachedFixtureTarget = false;

      for (const opp of opportunities) {
        const plans = await this.planner.plan(opp, this.templates);
        candidatesEnumerated += plans.length;
        console.log(`[searcher/ac3] planner: ${plans.length} candidate plans enumerated`);

        for (const candidate of plans) {
          if (reachedFixtureTarget) break;
          try {
            const resolved = await this.solver.solve(candidate, this.state, this.simulator, {
              ...this.solveOptions,
              cache: this.cache,
            });
            const sim = await this.simulator.simulate(resolved);
            if (!sim.success || sim.netProfit <= 0n) {
              console.log(
                `[searcher/ac3] final simulate rejected: success=${sim.success} netProfit=${sim.netProfit} reason=${sim.revertReason ?? "no profit"}`,
              );
              continue;
            }
            candidatesProfitable++;
            if (sim.netProfit > bestNetProfit) {
              bestNetProfit = sim.netProfit;
              bestPath = candidate.tokenPath.edges
                .map((e) => `${e.adapterId}(${shortAddr(e.tokenIn)}->${shortAddr(e.tokenOut)})`)
                .join(" → ");
            }
            await this.bundleRouter.submit({
              victimTxHash: event.txHash,
              backrunCalldata: sim.calldata,
              targetBlock: event.blockNumber + 1,
              expectedProfit: sim.netProfit,
            });
            console.log(`[searcher/ac3] simulator: success netProfit=${sim.netProfit}`);
            if (event.minProfit !== undefined && bestNetProfit >= event.minProfit) {
              reachedFixtureTarget = true;
              console.log(
                `[searcher/ac3] fixture target reached: bestProfit=${bestNetProfit} ` +
                  `threshold=${event.minProfit}`,
              );
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.log(`[searcher/ac3] candidate failed: ${msg.slice(0, 180)}`);
          }
        }
        if (reachedFixtureTarget) break;
      }

      results.push({
        victimTxHash: event.txHash,
        candidatesEnumerated,
        candidatesProfitable,
        bestNetProfit,
        bestPath,
      });
    }
    return results;
  }
}

function shortAddr(addr: string): string {
  return addr.slice(0, 6);
}
