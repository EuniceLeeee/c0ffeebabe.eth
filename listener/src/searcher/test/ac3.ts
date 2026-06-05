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
import { AnvilSolver } from "../solver/solver.js";
import { BotVMSimulator } from "../simulator/botvm-simulator.js";
import { FLASH_LEND_SWAP_REPAY } from "../templates/path-template.js";

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
    const detector = new BackrunDetector();
    const planner = new TemplatePlanner();
    const solver = new AnvilSolver();
    const simulator = new BotVMSimulator(state, DEFAULT_SEARCHER_EXECUTOR, DEFAULT_SEARCHER_OWNER);
    const router = new DryRunBundleRouter();

    const searcher = new HotPathSearcher(
      source,
      state,
      detector,
      planner,
      solver,
      simulator,
      router,
      [FLASH_LEND_SWAP_REPAY],
      async () => {
        await installForkBotVm(state.provider, DEFAULT_SEARCHER_OWNER, DEFAULT_SEARCHER_EXECUTOR);
      },
    );

    console.log(`[searcher/ac3] fixture: ${VICTIM_FIXTURES[0].victimTxHash} (non-arb swap)`);
    const successes = await searcher.run();
    if (successes < 1) {
      throw new Error("AC-3 failed: no profitable self-composed plan");
    }
    console.log("AC-3 PASS");
  } finally {
    state.stop();
  }
}

main().catch((err) => {
  console.error(`[searcher/ac3] FAIL: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
