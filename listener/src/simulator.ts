import { execSync, spawn, ChildProcess } from "node:child_process";
import { ethers } from "ethers";
import type { FilterMatch, ListenerConfig, SimResult } from "./types.js";

// ─── Anvil Manager ───────────────────────────────────────────────

let anvilProcess: ChildProcess | null = null;
const ANVIL_PORT = 8545;
const ANVIL_RPC = `http://localhost:${ANVIL_PORT}`;

/**
 * Start a persistent anvil fork. Reuse across simulations.
 * Call resetAnvil() between runs to re-fork at latest block.
 */
export async function startAnvil(rpcUrl: string, forkTransactionHash?: string): Promise<void> {
  if (anvilProcess) return; // already running

  const args = [
    "--fork-url", rpcUrl,
    "--port", String(ANVIL_PORT),
    "--silent",
    "--no-mining",          // don't auto-mine; we mine manually after injection
    "--order", "fifo",      // preserve prefix replay transactionIndex order
  ];
  if (forkTransactionHash) {
    args.push("--fork-transaction-hash", forkTransactionHash);
  }

  anvilProcess = spawn("anvil", args, { stdio: "ignore" });

  anvilProcess.on("exit", () => { anvilProcess = null; });

  // Wait for anvil to be ready
  const anvilProvider = new ethers.JsonRpcProvider(ANVIL_RPC);
  for (let i = 0; i < 20; i++) {
    try {
      await anvilProvider.getBlockNumber();
      console.log(`[anvil] started on port ${ANVIL_PORT}`);
      return;
    } catch {
      await new Promise(r => setTimeout(r, 500));
    }
  }
  throw new Error("anvil failed to start within 10s");
}

/**
 * Reset anvil to re-fork at the latest mainnet block.
 * Much faster than restarting the process.
 */
export async function resetAnvil(rpcUrl: string): Promise<void> {
  const anvilProvider = new ethers.JsonRpcProvider(ANVIL_RPC);
  await anvilProvider.send("anvil_reset", [{
    forking: { jsonRpcUrl: rpcUrl },
  }]);
}

export function stopAnvil(): void {
  if (anvilProcess) {
    anvilProcess.kill();
    anvilProcess = null;
    console.log("[anvil] stopped");
  }
}

// ─── Raw Tx Reconstruction ──────────────────────────────────────

/**
 * Reconstruct the signed raw tx bytes from an ethers TransactionResponse.
 * This is what eth_sendRawTransaction needs.
 */
function reconstructRawTx(tx: ethers.TransactionResponse): string {
  // ethers v6: TransactionResponse has .signature and all fields
  // We can reconstruct via Transaction.from()
  const txObj = ethers.Transaction.from({
    type: tx.type,
    to: tx.to,
    nonce: tx.nonce,
    gasLimit: tx.gasLimit,
    gasPrice: tx.gasPrice,
    maxFeePerGas: tx.maxFeePerGas,
    maxPriorityFeePerGas: tx.maxPriorityFeePerGas,
    data: tx.data,
    value: tx.value,
    chainId: tx.chainId,
    accessList: tx.accessList,
    signature: tx.signature,
  });
  return txObj.serialized;
}

// ─── Simulate via Anvil ─────────────────────────────────────────

/**
 * Simulate an opportunity by injecting the victim tx into anvil
 * and running the AutoBackrun forge script in LIVE mode.
 *
 * Flow:
 *   1. Reset anvil to latest mainnet block
 *   2. Inject victim raw tx → mine block
 *   3. forge script AutoBackrun --fork-url anvil (REPLAY_MODE=live)
 *   4. Parse structured output
 */
export async function simulateOpportunity(
  match: FilterMatch,
  provider: ethers.JsonRpcProvider,
  config: ListenerConfig
): Promise<SimResult> {
  const ts = new Date().toISOString();

  try {
    // 1. Reset anvil to latest block
    await resetAnvil(config.rpcUrl);

    // 2. Get full tx and reconstruct raw signed bytes
    const tx = await provider.getTransaction(match.txHash);
    if (!tx) {
      console.log(`[${ts}] tx ${match.txHash} not found, skipping`);
      return emptyResult();
    }

    let rawTx: string;
    try {
      // Try eth_getRawTransactionByHash first (some providers support it)
      rawTx = await provider.send("eth_getRawTransactionByHash", [match.txHash]);
    } catch {
      // Fallback: reconstruct from tx fields
      rawTx = reconstructRawTx(tx);
    }

    // 3. Inject into anvil
    const anvilProvider = new ethers.JsonRpcProvider(ANVIL_RPC);
    await anvilProvider.send("eth_sendRawTransaction", [rawTx]);
    // Mine a block so the tx takes effect
    await anvilProvider.send("evm_mine", []);

    console.log(`[${ts}] injected ${match.txHash} into anvil`);

    // 4. Run forge script in LIVE mode against anvil
    const env = {
      ...process.env,
      REPLAY_MODE: "live",
    };

    const cmd = [
      "forge", "script",
      "script/AutoBackrun.s.sol:AutoBackrun",
      "--fork-url", ANVIL_RPC,
      "-vv",
    ].join(" ");

    const output = execSync(cmd, {
      cwd: config.projectRoot,
      env,
      timeout: 120_000,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });

    const result = parseForgeOutput(output);
    result.victimRawTx = rawTx;
    return result;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[${ts}] Simulation failed: ${message}`);
    return emptyResult();
  }
}

/**
 * Run the AutoBackrun script in backtest mode — replays a known historical
 * victim tx to validate the full pipeline end-to-end.
 */
export async function backtestVictimTx(
  victimTxHash: string,
  config: ListenerConfig
): Promise<SimResult> {
  const ts = new Date().toISOString();
  console.log(`[${ts}] Backtest: victim=${victimTxHash}`);

  try {
    const env = {
      ...process.env,
      REPLAY_MODE: "trigger",
      MAINNET_RPC_URL: config.rpcUrl,
    };

    const cmd = [
      "forge",
      "script",
      "script/AutoBackrun.s.sol:AutoBackrun",
      `--fork-url`,
      config.rpcUrl,
      "-vv",
    ].join(" ");

    const output = execSync(cmd, {
      cwd: config.projectRoot,
      env,
      timeout: 120_000,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });

    return parseForgeOutput(output);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[${ts}] Backtest failed: ${message}`);
    return emptyResult();
  }
}

// ─── Output Parsing ─────────────────────────────────────────────

/**
 * Parse structured console output from the AutoBackrun forge script.
 */
function parseForgeOutput(output: string): SimResult {
  const result: SimResult = emptyResult();
  const lines = output.split("\n");

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed.startsWith("wstUSR profit:")) {
      result.wstUsrProfit = extractNumber(trimmed);
      result.opportunity = BigInt(result.wstUsrProfit) > 0n;
    } else if (trimmed.startsWith("WETH profit:")) {
      result.wethProfit = extractNumber(trimmed);
    } else if (trimmed.startsWith("wstUSR->WETH:")) {
      result.wstUsrProfitWethValue = extractNumber(trimmed);
    } else if (trimmed.startsWith("netTotalWETH:")) {
      result.netTotalWethProfit = extractNumber(trimmed);
    } else if (trimmed.startsWith("gasUsed:")) {
      result.gasUsed = parseInt(extractNumber(trimmed), 10);
    } else if (trimmed.startsWith("gasCost:")) {
      result.gasCostWei = extractNumber(trimmed);
    } else if (trimmed.startsWith("scriptLen:")) {
      result.scriptLength = parseInt(extractNumber(trimmed), 10);
    } else if (trimmed.startsWith("calldataLen:")) {
      result.calldataLength = parseInt(extractNumber(trimmed), 10);
    } else if (trimmed.startsWith("ourOk:") && trimmed.includes("true")) {
      result.bundleValid = true;
    } else if (trimmed.startsWith("0x") && trimmed.length > 100) {
      result.calldataHex = trimmed;
    } else if (trimmed.startsWith("SKIP:")) {
      result.opportunity = false;
    }
  }

  return result;
}

export function emptyResult(): SimResult {
  return {
    opportunity: false,
    wstUsrProfit: "0",
    wethProfit: "0",
    wstUsrProfitWethValue: "0",
    netTotalWethProfit: "0",
    gasUsed: 0,
    gasCostWei: "0",
    calldataHex: "",
    victimRawTx: "",
    scriptLength: 0,
    calldataLength: 0,
    bundleValid: false,
  };
}

function extractNumber(line: string): string {
  const parts = line.split(/:\s+/);
  if (parts.length >= 2) {
    const numStr = parts[parts.length - 1].split(/\s+/)[0];
    return numStr.replace(/[^0-9]/g, "");
  }
  return "0";
}
