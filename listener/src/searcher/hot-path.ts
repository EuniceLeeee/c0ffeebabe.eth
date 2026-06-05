import type { StateBackend } from "../shared/state/state-backend.js";
import type { Detector } from "./detector/detector.js";
import type { ManualVictimSource } from "./orderflow/manual-source.js";
import type { Planner } from "./planner/planner.js";
import type { Solver } from "./solver/solver.js";
import type { BotVMSimulator } from "./simulator/botvm-simulator.js";
import type { BundleRouter } from "./execution/bundle-router.js";
import type { PathTemplate } from "./templates/path-template.js";

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
  ) {}

  async run(): Promise<number> {
    let successCount = 0;
    for await (const event of this.orderflow.next()) {
      console.log(`[searcher/ac3] fork at block ${event.blockNumber - 1}`);
      await this.state.forkAt(event.blockNumber - 1);
      console.log(`[searcher/ac3] apply victim ${event.txHash}`);
      await this.state.applyRawTx(event.rawTx);
      console.log("[searcher/ac3] install executor");
      await this.prepareExecutor?.();

      const opportunities = await this.detector.detect(event, this.state);
      console.log(`[searcher/ac3] detector: ${opportunities.length} opportunities`);

      for (const opp of opportunities) {
        const plans = await this.planner.plan(opp, this.templates);
        console.log(`[searcher/ac3] planner: ${plans.length} candidate plans enumerated`);

        for (const candidate of plans) {
          try {
            const resolved = await this.solver.solve(candidate, this.state, this.simulator);
            const sim = await this.simulator.simulate(resolved);
            if (!sim.success || sim.netProfit <= 0n) {
              console.log(
                `[searcher/ac3] final simulate rejected: success=${sim.success} netProfit=${sim.netProfit} reason=${sim.revertReason ?? "no profit"}`,
              );
              continue;
            }
            await this.bundleRouter.submit({
              victimTxHash: event.txHash,
              backrunCalldata: sim.calldata,
              targetBlock: event.blockNumber + 1,
              expectedProfit: sim.netProfit,
            });
            console.log(`[searcher/ac3] simulator: success netProfit=${sim.netProfit}`);
            successCount++;
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.log(`[searcher/ac3] candidate failed: ${msg.slice(0, 180)}`);
          }
        }
      }
    }
    return successCount;
  }
}
