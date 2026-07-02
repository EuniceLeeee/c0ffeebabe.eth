import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ethers } from "ethers";
import "../../shared/adapters/index.js";
import { AnvilStateBackend } from "../../shared/state/state-backend.js";
import {
  DEFAULT_SEARCHER_EXECUTOR,
  DEFAULT_SEARCHER_OWNER,
  installForkBotVm,
} from "../../shared/executor/botvm-executor.js";
import { BackrunDetector } from "../detector/detector.js";
import { VICTIM_FIXTURES, assertVictimFixturesAreNotArbs } from "../fixtures/victims.js";
import { DryRunBundleRouter } from "../execution/bundle-router.js";
import { HotPathSearcher } from "../hot-path.js";
import { ManualVictimSource } from "../orderflow/manual-source.js";
import { TemplatePlanner } from "../planner/planner.js";
import { defaultTokenGraph } from "../planner/token-graph.js";
import { AnvilSolver, type ResolvedPlan } from "../solver/solver.js";
import { BotVMSimulator, type SimulationResult } from "../simulator/botvm-simulator.js";
import { FLASH_LEND_SWAP_REPAY, FLASH_SWAP_REPAY } from "../templates/path-template.js";

function loadEnv(): void {
  const envPath = resolve("..", ".env");
  let text = "";
  try {
    text = readFileSync(envPath, "utf8");
  } catch {
    return;
  }
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const [rawKey, ...rest] = trimmed.split("=");
    const key = rawKey.replace(/^export\s+/, "");
    if (!process.env[key]) process.env[key] = rest.join("=").replace(/^["']|["']$/g, "");
  }
}

class Ac3GasAssertingSimulator extends BotVMSimulator {
  async simulate(plan: ResolvedPlan): Promise<SimulationResult> {
    const result = await super.simulate(plan);
    if (result.success) {
      console.log(`[searcher/ac3] simulator gasUsed=${result.gasUsed}`);
      if (result.gasUsed <= 0n) {
        throw new Error(`AC-3 gasUsed invariant failed: gasUsed=${result.gasUsed}`);
      }
    }
    return result;
  }
}

async function main(): Promise<void> {
  loadEnv();
  assertVictimFixturesAreNotArbs();

  const rpcUrl = process.env.MAINNET_RPC_URL;
  if (!rpcUrl) throw new Error("MAINNET_RPC_URL required");

  const mainProvider = new ethers.JsonRpcProvider(rpcUrl);
  const state = new AnvilStateBackend(rpcUrl);
  await state.start();

  try {
    const source = new ManualVictimSource(mainProvider, VICTIM_FIXTURES);
    // AC-3 runs offline on the small hand-written graph. Inject it explicitly
    // into BOTH detector and planner so the test never relies on hidden fallbacks
    // (the production main.ts injects a discovered graph the same way).
    const graph = defaultTokenGraph();
    const detector = new BackrunDetector();
    detector.setGraph(graph);
    const planner = new TemplatePlanner();
    planner.setGraph(graph);
    const solver = new AnvilSolver();
    const simulator = new Ac3GasAssertingSimulator(
      state,
      DEFAULT_SEARCHER_EXECUTOR,
      DEFAULT_SEARCHER_OWNER,
    );
    const router = new DryRunBundleRouter();

    // Optional per-candidate solve budget (v7 AC-3a.3 [fork] verification): when
    // SEARCHER_SOLVER_DEADLINE_MS is set, each candidate solve is hard-capped so
    // the search can't burn through every grid×bps trial on a no-arb path. Unset
    // ⇒ unbounded (default) so the profit regression stays apples-to-apples.
    const deadlineEnv = process.env.SEARCHER_SOLVER_DEADLINE_MS;
    const finalSimTopN = Number(process.env.SEARCHER_FINAL_SIM_TOP_N ?? "3");
    const solveOptions = deadlineEnv
      ? {
          deadlineMs: Number(deadlineEnv),
          gssMaxTries: Number(process.env.SEARCHER_GSS_MAX_TRIES ?? "12"),
          finalSimTopN,
        }
      : { finalSimTopN };
    console.log(
      `[searcher/ac3] solve budget: deadlineMs=${solveOptions.deadlineMs ?? "∞"} ` +
        `gssMaxTries=${process.env.SEARCHER_GSS_MAX_TRIES ?? "12"} finalSimTopN=${finalSimTopN}`,
    );

    const searcher = new HotPathSearcher(
      source,
      state,
      detector,
      planner,
      solver,
      simulator,
      router,
      [FLASH_LEND_SWAP_REPAY, FLASH_SWAP_REPAY],
      async () => {
        await installForkBotVm(state.provider, DEFAULT_SEARCHER_OWNER, DEFAULT_SEARCHER_EXECUTOR);
      },
      solveOptions,
      mainProvider, // direct RPC for v3 tick data (anvil-over-RPC is slow + wrong for TickLens)
    );

    console.log(`[searcher/ac3] running ${VICTIM_FIXTURES.length} fixture(s)`);
    if (VICTIM_FIXTURES.length < 2) {
      throw new Error(`AC-3 requires >= 2 victim fixtures, got ${VICTIM_FIXTURES.length}`);
    }
    const results = await searcher.runDetailed();

    // AC-3 Phase 2 acceptance:
    //   - every fixture enumerates ≥ 2 candidate paths (planner truly explores)
    //   - every fixture finds ≥ 1 profitable plan (solver self-composes)
    //   - every fixture's best netProfit reaches its configured raw profit-token threshold
    const MIN_CANDIDATES = 2;
    const fixtureByHash = new Map(VICTIM_FIXTURES.map((f) => [f.victimTxHash.toLowerCase(), f]));
    let allPass = true;
    for (const r of results) {
      const fixture = fixtureByHash.get(r.victimTxHash.toLowerCase());
      if (!fixture) throw new Error(`missing fixture config for ${r.victimTxHash}`);
      const okCandidates = r.candidatesEnumerated >= MIN_CANDIDATES;
      const okProfit = r.bestNetProfit >= fixture.minProfit;
      const status = okCandidates && okProfit ? "PASS" : "FAIL";
      console.log(
        `[searcher/ac3][${status}] ${r.victimTxHash.slice(0, 10)}... ` +
          `candidates=${r.candidatesEnumerated} (need >=${MIN_CANDIDATES}), ` +
          `profitable=${r.candidatesProfitable}, ` +
          `bestProfit=${r.bestNetProfit} (need >=${fixture.minProfit})`,
      );
      if (r.bestPath) console.log(`              best path: ${r.bestPath}`);
      if (!okCandidates || !okProfit) allPass = false;
    }

    if (!allPass) throw new Error("AC-3 Phase 2 failed: see per-fixture details above");
    console.log(`AC-3 PASS (${results.length}/${results.length} fixtures)`);
  } finally {
    state.stop();
  }
}

main().catch((err) => {
  console.error(`[searcher/ac3] FAIL: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
