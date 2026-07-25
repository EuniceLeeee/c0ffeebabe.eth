import { ethers } from "ethers";
import { resolve } from "node:path";
import { matchTargetSwap, decodePendingTx } from "./filter.js";
import {
  simulateOpportunity,
  backtestVictimTx,
  startAnvil,
  stopAnvil,
} from "./simulator.js";
import type { ListenerConfig } from "./types.js";

// Default known victim tx for backtest mode
const KNOWN_VICTIM_TX =
  "0xc52bc6f4d29a96bc18efa09708636e9d37109918d28c52d585a5f3df1609bb22";

function parseArgs(): {
  mode: "dry-run" | "live" | "backtest";
  duration: number;
  victimTx: string;
} {
  const args = process.argv.slice(2);
  let mode: "dry-run" | "live" | "backtest" = "dry-run";
  let duration = 0; // 0 = indefinite
  let victimTx = KNOWN_VICTIM_TX;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--backtest") mode = "backtest";
    if (args[i] === "--dry-run") mode = "dry-run";
    if (args[i] === "--live") mode = "live";
    if (args[i] === "--duration" && args[i + 1]) {
      duration = parseInt(args[i + 1], 10);
      i++;
    }
    if (args[i] === "--victim-tx" && args[i + 1]) {
      victimTx = args[i + 1];
      i++;
    }
  }

  return { mode, duration, victimTx };
}

function buildConfig(): ListenerConfig {
  const rpcUrl = process.env.MAINNET_RPC_URL;
  if (!rpcUrl) {
    console.error("Error: MAINNET_RPC_URL env var required");
    process.exit(1);
  }

  // Derive WebSocket URL from HTTP URL
  let wsUrl = process.env.MAINNET_WS_URL || "";
  if (!wsUrl) {
    wsUrl = rpcUrl.replace(/^https?:\/\//, "wss://");
  }

  return {
    rpcUrl,
    wsUrl,
    dryRun: true,
    duration: 0,
    minSwapSize: ethers.parseEther("100"), // 100 wstUSR minimum
    projectRoot: resolve(import.meta.dirname, "../.."), // MEV project root
  };
}

async function runBacktest(config: ListenerConfig, victimTx: string) {
  const ts = new Date().toISOString();
  console.log(`\n[${ts}] === BACKTEST MODE ===`);
  console.log(`[${ts}] Victim tx: ${victimTx}`);
  console.log(`[${ts}] Project root: ${config.projectRoot}`);
  console.log();

  const result = await backtestVictimTx(victimTx, config);

  console.log(`\n[${new Date().toISOString()}] === Backtest Result ===`);
  console.log(`  opportunity: ${result.opportunity}`);
  console.log(`  wstUSR profit: ${result.wstUsrProfit}`);
  console.log(`  WETH profit: ${result.wethProfit}`);
  console.log(`  wstUSR->WETH: ${result.wstUsrProfitWethValue}`);
  console.log(`  netTotalWETH: ${result.netTotalWethProfit}`);
  console.log(`  gasUsed: ${result.gasUsed}`);
  console.log(`  bundleValid: ${result.bundleValid}`);
  console.log(`  calldataLen: ${result.calldataLength}`);

  if (result.opportunity) {
    console.log(`\n  DRY RUN — would submit bundle but skipping`);
  }
}

async function runListener(
  config: ListenerConfig,
  duration: number,
) {
  const ts = new Date().toISOString();
  console.log(`\n[${ts}] === DRY-RUN LISTENER MODE ===`);
  console.log(`[${ts}] RPC: ${config.rpcUrl.slice(0, 30)}...`);
  console.log(`[${ts}] WS:  ${config.wsUrl.slice(0, 30)}...`);
  console.log(
    `[${ts}] Min swap size: ${ethers.formatEther(config.minSwapSize)} wstUSR`
  );
  console.log(
    `[${ts}] Duration: ${duration > 0 ? `${duration}s` : "indefinite"}`
  );

  console.log();

  // Start anvil for local simulation
  await startAnvil(config.rpcUrl);

  // Connect via HTTP for tx lookups
  const httpProvider = new ethers.JsonRpcProvider(config.rpcUrl);

  // Connect via WebSocket for pending tx subscription
  let wsProvider: ethers.WebSocketProvider;
  try {
    wsProvider = new ethers.WebSocketProvider(config.wsUrl);
    console.log(`[${new Date().toISOString()}] WebSocket connected`);
  } catch (err) {
    console.error(`Failed to connect WebSocket: ${err}`);
    stopAnvil();
    process.exit(1);
  }

  let detected = 0;
  let simulated = 0;
  let opportunities = 0;
  let submitted = 0;
  let simulating = false; // guard against concurrent simulations

  // Subscribe to pending transactions
  wsProvider.on("pending", async (txHash: string) => {
    try {
      const tx = await httpProvider.getTransaction(txHash);
      if (!tx || !tx.to) return;

      const pending = decodePendingTx(txHash, tx);
      const match = matchTargetSwap(pending, config.minSwapSize);
      if (!match) return;

      detected++;
      const now = new Date().toISOString();
      console.log(
        `[${now}] Detected: ${match.txHash} (${match.direction}, ${ethers.formatEther(match.amount)} wstUSR)`
      );

      if (simulating) {
        console.log(`[${now}] Skipping -- simulation in progress`);
        return;
      }

      // Simulate via anvil injection
      simulating = true;
      simulated++;
      const result = await simulateOpportunity(match, httpProvider, config);
      simulating = false;

      const nowSim = new Date().toISOString();
      if (result.opportunity) {
        opportunities++;
        console.log(`[${nowSim}] OPPORTUNITY FOUND:`);
        console.log(`  wstUSR profit: ${result.wstUsrProfit}`);
        console.log(`  WETH profit:   ${result.wethProfit}`);
        console.log(`  netTotalWETH:  ${result.netTotalWethProfit}`);
        console.log(`  gasUsed:       ${result.gasUsed}`);
        console.log(`  calldataLen:   ${result.calldataLength}`);

        console.log(`  DRY RUN -- would submit bundle but skipping`);
      } else {
        console.log(
          `[${nowSim}] No opportunity (sim: ${result.wstUsrProfit} wstUSR)`
        );
      }
    } catch {
      // Silently skip failed tx lookups (common for pending txs)
    }
  });

  // Shutdown handler
  const shutdown = () => {
    const endTs = new Date().toISOString();
    console.log(`\n[${endTs}] === Session Summary ===`);
    console.log(`  detected:      ${detected}`);
    console.log(`  simulated:     ${simulated}`);
    console.log(`  opportunities: ${opportunities}`);
    console.log(`  submitted:     ${submitted}`);
    stopAnvil();
    wsProvider.destroy();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  if (duration > 0) {
    setTimeout(shutdown, duration * 1000);
  }

  // Keep alive
  await new Promise(() => {});
}

async function main() {
  const { mode, duration, victimTx } = parseArgs();
  if (mode === "live") {
    throw new Error(
      "legacy --live is disabled; use the production searcher entrypoint with its EV envelope",
    );
  }
  const config = buildConfig();

  if (mode === "backtest") {
    await runBacktest(config, victimTx);
  } else {
    await runListener(config, duration);
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  stopAnvil();
  process.exit(1);
});
