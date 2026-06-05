/**
 * Replicate Pipeline — AC-1 and AC-2 entry point.
 *
 * Input: txHash (only human input)
 * Output: compiled BotVM script + profit validation
 *
 * Flow:
 *   txHash → read block/index → prefix replay on Anvil
 *   → callTracer classify → shape match → solve from trace
 *   → compile plan → stateful Anvil simulate → report profit
 *
 * No hardcoded plans. No manual module selection. No manual amounts.
 */

import { ethers } from "ethers";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import "./adapters/index.js"; // register all adapters
import { classifyTrace } from "./classifier.js";
import { matchShape } from "./shape-matcher.js";
import { solveFromTrace } from "./solver.js";
import { compilePlan } from "./compiler.js";
import { startAnvil, stopAnvil } from "./simulator.js";

const ORIGINAL_BOT = "0xE08D97e151473A848C3d9CA3f323Cb720472D015";
const BOTVM_EXECUTE_SELECTOR = "0x09c5eabe"; // execute(bytes)
const DEFAULT_OWNER = "0x1000000000000000000000000000000000000001";
const DEFAULT_EXECUTOR = "0x00000000000000000000000000000000b07c0de5";
const REPLAY_TIMEOUT_MS = Number(process.env.REPLICATE_TIMEOUT_MS ?? 120_000);

const TRACKED_BALANCES = [
  { name: "wstUSR", addr: "0x1202F5C7b4B9E47a1A484E8B270be34dbbC75055" },
  { name: "WETH", addr: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2" },
  { name: "USDC", addr: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" },
  { name: "USDT", addr: "0xdAC17F958D2ee523a2206206994597C13D831ec7" },
  { name: "DAI", addr: "0x6B175474E89094C44Da98b954EedeAC495271d0F" },
  { name: "DOLA", addr: "0x865377367054516e17014CcdED1e7d814EDC9ce4" },
];

interface ReplicateResult {
  success: boolean;
  txHash: string;
  blockNumber: number;
  txIndex: number;
  executor?: string;
  prefixReplayed?: number;
  shapeName?: string;
  scriptLength?: number;
  profit?: Record<string, string>;
  skipReason?: string;
  error?: string;
}

export async function replicate(
  txHash: string,
  rpcUrl: string,
  executor = "",
  owner = DEFAULT_OWNER,
): Promise<ReplicateResult> {
  const mainProvider = new ethers.JsonRpcProvider(rpcUrl);
  const ts = () => new Date().toISOString();
  let blockNumber = 0;
  let txIndex = 0;

  try {
    // 1. Read blockNumber and transactionIndex
    console.log(`[${ts()}] Replicating ${txHash}`);
    const receipt = await mainProvider.getTransactionReceipt(txHash);
    if (!receipt) throw new Error("tx receipt not found");

    blockNumber = receipt.blockNumber;
    txIndex = Number(receipt.index);
    if (!Number.isInteger(txIndex) || txIndex < 0) {
      throw new Error(`transactionIndex unavailable for ${txHash}`);
    }
    console.log(`[${ts()}] Block ${blockNumber}, txIndex ${txIndex}`);

    // 2. Fork Anvil at blockNumber - 1
    await startAnvil(rpcUrl);
    const anvilRpc = "http://localhost:8545";
    let anvil = new ethers.JsonRpcProvider(anvilRpc);

    await anvil.send("anvil_reset", [{
      forking: { jsonRpcUrl: rpcUrl, blockNumber: blockNumber - 1 },
    }]);
    console.log(`[${ts()}] Anvil forked at block ${blockNumber - 1}`);

    // 3. Prefix replay tx[0..txIndex-1]
    const block = await mainProvider.send("eth_getBlockByNumber", [
      "0x" + blockNumber.toString(16), true,
    ]);
    if (!block?.transactions) throw new Error("block transactions not found");

    const txs = block.transactions
      .filter((t: any) => t.transactionIndex !== undefined)
      .sort((a: any, b: any) => {
        const ai = typeof a.transactionIndex === "string"
          ? parseInt(a.transactionIndex, 16) : a.transactionIndex;
        const bi = typeof b.transactionIndex === "string"
          ? parseInt(b.transactionIndex, 16) : b.transactionIndex;
        return ai - bi;
      });

    const prefixCount = txIndex;
    const targetTx = txs[txIndex];
    if (!targetTx || targetTx.hash?.toLowerCase() !== txHash.toLowerCase()) {
      throw new Error(`target tx not found at block index ${txIndex}`);
    }
    console.log(`[${ts()}] Replaying ${prefixCount} prefix txs...`);

    // Prefix replay mode selection:
    //   sequential (default) — eth_sendRawTransaction one by one, mine each
    //     - works for short prefix (AC-1: 8 txs)
    //     - fails for long prefix (AC-2: 30-140 txs) due to nonce/gas/socket
    //   fork-tx — Anvil --fork-transaction-hash, native pre-state fork
    //     - requires archive RPC (Alchemy paid)
    //     - bypasses local prefix replay entirely
    //     - REQUIRED for AC-2 batch runs
    //   batch — all txs in one block (debug only)
    // Default is sequential to preserve AC-1 single-tx behavior.
    // replicate-batch.ts sets REPLICATE_PREFIX_MODE=fork-tx for AC-2.
    const prefixMode = process.env.REPLICATE_PREFIX_MODE ?? "sequential";

    if (prefixMode === "fork-tx" && prefixCount > 0) {
      const prefixAnchor = txs[prefixCount - 1].hash;
      stopAnvil();
      await startAnvil(rpcUrl, prefixAnchor);
      anvil = new ethers.JsonRpcProvider(anvilRpc);
      console.log(`[${ts()}] Native fork pre-state after prefix tx ${prefixAnchor}`);
    } else if (prefixMode === "fork-tx" && prefixCount === 0) {
      // First tx in block — no prefix needed, already forked at blockNumber - 1
      console.log(`[${ts()}] No prefix txs (target is block index 0)`);
    } else if (prefixMode === "batch") {
      await replayPrefixBlock(anvil, mainProvider, block, txs, prefixCount, ts);
    } else if (prefixMode === "sequential") {
      await replayPrefixSequential(anvil, mainProvider, block, txs, prefixCount, ts);
    } else {
      throw new Error(`unknown REPLICATE_PREFIX_MODE: ${prefixMode} (valid: fork-tx | sequential | batch)`);
    }
    console.log(`[${ts()}] Prefix replay complete, state at txIndex ${txIndex}`);

    const effectiveExecutor = executor
      ? await validateDeployedExecutor(anvil, executor)
      : await installForkBotVm(anvil, owner, process.env.REPLICATE_EXECUTOR_ADDRESS ?? DEFAULT_EXECUTOR);
    await fundAndImpersonateOwner(anvil, owner);
    console.log(`[${ts()}] Executor: ${effectiveExecutor} (${executor ? "deployed" : "fork-installed"})`);

    // Mode A complement: original bot may rely on existing token balances accumulated
    // from prior arbs. Copy these to our executor so trace-literal amounts are valid.
    // diffBalances uses pre/post — the funded amounts cancel out in profit calculation.
    //
    // Only mirror in fork-tx mode (long-prefix AC-2 batch path). Sequential mode
    // already replays the exact prefix and shouldn't need extra funding; mirror
    // would advance the chain timestamp and disturb time-sensitive contract state.
    if (
      !executor
      && process.env.REPLICATE_SKIP_FUND !== "1"
      && (process.env.REPLICATE_PREFIX_MODE ?? "sequential") === "fork-tx"
    ) {
      await mirrorOriginalBotBalances(anvil, ORIGINAL_BOT, effectiveExecutor, ts);
    }

    // 4. Classify target tx via callTracer (on mainnet, not anvil)
    console.log(`[${ts()}] Classifying with callTracer...`);
    const tree = await classifyTrace(txHash, mainProvider);

    // 5. Match shape
    const match = matchShape(tree, ORIGINAL_BOT);
    if (!match) {
      return { success: false, txHash, blockNumber, txIndex, skipReason: "no shape match" };
    }
    if (match.skipReason) {
      return {
        success: false, txHash, blockNumber, txIndex,
        shapeName: match.shapeName,
        skipReason: match.skipReason,
      };
    }
    console.log(`[${ts()}] Shape: ${match.shapeName} (${match.lends.length} lends, ${match.swaps.length} swaps)`);

    // 6. Solve from trace (Mode A: literal amounts from calldata)
    // The trace root is BotVM.execute — we want the flash loan (first real action)
    const flashNode = match.flash;
    let resolved;
    try {
      resolved = solveFromTrace(flashNode, effectiveExecutor, ORIGINAL_BOT);
    } catch (e: any) {
      return {
        success: false, txHash, blockNumber, txIndex,
        executor: effectiveExecutor,
        prefixReplayed: prefixCount,
        shapeName: match.shapeName,
        skipReason: e.message?.startsWith("unsupported") ? e.message : undefined,
        error: e.message?.startsWith("unsupported") ? undefined : e.message?.slice(0, 300),
      };
    }

    // 7. Compile plan
    // Debug: log resolved tree structure
    function logTree(n: any, indent = 0) {
      const pad = "  ".repeat(indent);
      console.log(`${pad}${n.adapterId} target=${(n.target||"null").slice(0,10)} amount=${n.amount} children=${n.children?.length??0}`);
      for (const c of n.children ?? []) logTree(c, indent + 1);
    }
    console.log(`[${ts()}] Resolved plan tree:`);
    logTree(resolved);

    let script;
    try {
      script = compilePlan(resolved, effectiveExecutor);
    } catch (e: any) {
      return {
        success: false, txHash, blockNumber, txIndex,
        executor: effectiveExecutor,
        prefixReplayed: prefixCount,
        shapeName: match.shapeName,
        skipReason: `unsupported: compile failed: ${e.message?.slice(0, 240)}`,
      };
    }
    console.log(`[${ts()}] Compiled script: ${script.length} bytes`);

    // 8. Execute on Anvil — stateful simulation
    let profit: Record<string, string> = {};
    let executed = false;
    let lastExecutionError = "";
    // Multi-round shortfall adjustment: trace literal amounts can cascade,
    // so adjusting one transfer may surface another shortfall downstream.
    // In fork-tx mode we allow up to 6 rounds; in sequential (AC-1) the prefix
    // is exact so 2 rounds (original behavior) is enough — more rounds can
    // chain-adjust in ways that break the working AC-1 path.
    // Multi-round shortfall adjustment for cascading literal-amount drift.
    // Cap higher in fork-tx (state divergence can chain deeper) but allow 4
    // rounds in sequential too — added Curve router / wrap adapters created
    // more potential chain points than the 2-round legacy cap.
    const isForkTx = (process.env.REPLICATE_PREFIX_MODE ?? "sequential") === "fork-tx";
    const MAX_ATTEMPTS = isForkTx ? 6 : 4;
    for (let attempt = 0; attempt < MAX_ATTEMPTS && !executed; attempt++) {
      const executeCalldata = buildExecuteCalldata(script);
      const snap = await anvil.send("evm_snapshot", []);
      const preBalances = await readBalances(anvil, effectiveExecutor);

      try {
        await configureNextBlock(anvil, block, prefixCount);
        const execTxHash = await anvil.send("eth_sendTransaction", [{
          from: owner,
          to: effectiveExecutor,
          data: executeCalldata,
          gas: "0x1000000", // 16M gas limit
        }]);
        await mineOneBlock(anvil, "BotVM execution");
        const execReceipt = await waitForMinedReceipt(anvil, execTxHash, "BotVM execution");
        if (!execReceipt || execReceipt.status !== 1) {
          const failure = await traceFailureInfo(anvil, execTxHash, effectiveExecutor);
          if (attempt < MAX_ATTEMPTS - 1 && applyTransferShortfallAdjustment(resolved, failure)) {
            await anvil.send("evm_revert", [snap]);
            script = compilePlan(resolved, effectiveExecutor);
            console.log(`[${ts()}] Recompiled after dynamic transfer adjustment (attempt ${attempt + 1}/${MAX_ATTEMPTS}): ${script.length} bytes`);
            continue;
          }
          throw new Error(`execute tx failed: ${failure.description}`);
        }

        const postBalances = await readBalances(anvil, effectiveExecutor);
        profit = diffBalances(preBalances, postBalances);
        await anvil.send("evm_revert", [snap]);
        executed = true;
      } catch (e: any) {
        await anvil.send("evm_revert", [snap]);
        lastExecutionError = e.message?.slice(0, 260);
        break;
      }
    }

    if (!executed) {
      return {
        success: false, txHash, blockNumber, txIndex,
        executor: effectiveExecutor,
        prefixReplayed: prefixCount,
        shapeName: match.shapeName,
        scriptLength: script.length,
        error: `execution reverted: ${lastExecutionError}`,
      };
    }

    const hasProfit = Object.keys(profit).length > 0;
    console.log(`[${ts()}] Profit:`, hasProfit ? profit : "none");

    return {
      success: hasProfit,
      txHash,
      blockNumber,
      txIndex,
      executor: effectiveExecutor,
      prefixReplayed: prefixCount,
      shapeName: match.shapeName,
      scriptLength: script.length,
      profit,
    };
  } catch (e: any) {
    return {
      success: false,
      txHash,
      blockNumber,
      txIndex,
      error: e.message?.slice(0, 300),
    };
  }
}

function buildExecuteCalldata(script: Uint8Array): string {
  const abiCoder = ethers.AbiCoder.defaultAbiCoder();
  const encoded = abiCoder.encode(["bytes"], [script]);
  return BOTVM_EXECUTE_SELECTOR + encoded.slice(2);
}

async function configureNextBlock(
  anvil: ethers.JsonRpcProvider,
  block: any,
  offsetSeconds = 0,
): Promise<void> {
  const timestamp = typeof block.timestamp === "string"
    ? parseInt(block.timestamp, 16)
    : Number(block.timestamp);
  if (Number.isFinite(timestamp) && timestamp > 0) {
    try {
      await anvil.send("evm_setNextBlockTimestamp", [timestamp + offsetSeconds]);
    } catch {
      // Mirror/funding may have advanced past target — try current+1 as fallback.
      try {
        const cur: any = await anvil.send("eth_getBlockByNumber", ["latest", false]);
        const curTs = typeof cur?.timestamp === "string"
          ? parseInt(cur.timestamp, 16)
          : Number(cur?.timestamp);
        if (Number.isFinite(curTs)) {
          await anvil.send("evm_setNextBlockTimestamp", [curTs + 1]);
        }
      } catch {
        // give up — execute may still work
      }
    }
  }
  if (block.baseFeePerGas) {
    try {
      await anvil.send("anvil_setNextBlockBaseFeePerGas", [block.baseFeePerGas]);
    } catch {
      // ignore
    }
  }
}

async function replayPrefixBlock(
  anvil: ethers.JsonRpcProvider,
  mainProvider: ethers.JsonRpcProvider,
  block: any,
  txs: any[],
  prefixCount: number,
  ts: () => string,
): Promise<void> {
  const replayed: string[] = [];
  await configureNextBlock(anvil, block, 0);

  for (let i = 0; i < prefixCount; i++) {
    const prefixTx = txs[i];
    if (!prefixTx) throw new Error(`missing prefix tx at index ${i}`);
    const prefixHash = prefixTx.hash;
    try {
      console.log(`[${ts()}]   prefix ${i + 1}/${prefixCount}: ${prefixHash}`);
      const rawTx = await getRawTx(mainProvider, prefixTx);
      const replayedHash = await withTimeout(
        anvil.send("eth_sendRawTransaction", [rawTx]),
        REPLAY_TIMEOUT_MS,
        `eth_sendRawTransaction timeout for prefix index ${i} hash ${prefixHash}`,
      );
      replayed.push(replayedHash);
    } catch (e: any) {
      throw new Error(
        `prefix replay failed at index ${i} hash ${prefixHash}: ${e.message?.slice(0, 200)}`,
      );
    }
  }

  await mineOneBlock(anvil, "prefix block");

  for (let i = 0; i < replayed.length; i++) {
    const receipt = await waitForReceipt(anvil, replayed[i], `prefix index ${i} hash ${txs[i].hash}`);
    const replayedIndex = Number(receipt.index);
    if (replayedIndex !== i) {
      throw new Error(
        `prefix replay order mismatch for ${txs[i].hash}: expected index ${i}, got ${replayedIndex}`,
      );
    }
  }
}

async function replayPrefixSequential(
  anvil: ethers.JsonRpcProvider,
  mainProvider: ethers.JsonRpcProvider,
  block: any,
  txs: any[],
  prefixCount: number,
  ts: () => string,
): Promise<void> {
  for (let i = 0; i < prefixCount; i++) {
    const prefixTx = txs[i];
    if (!prefixTx) throw new Error(`missing prefix tx at index ${i}`);
    const prefixHash = prefixTx.hash;
    try {
      console.log(`[${ts()}]   prefix ${i + 1}/${prefixCount}: ${prefixHash}`);
      await configureNextBlock(anvil, block, i);
      const rawTx = await getRawTx(mainProvider, prefixTx);
      const replayedHash = await withTimeout(
        anvil.send("eth_sendRawTransaction", [rawTx]),
        REPLAY_TIMEOUT_MS,
        `eth_sendRawTransaction timeout for prefix index ${i} hash ${prefixHash}`,
      );
      await mineOneBlock(anvil, `prefix index ${i} hash ${prefixHash}`);
      await waitForReceipt(anvil, replayedHash, `prefix index ${i} hash ${prefixHash}`);
    } catch (e: any) {
      throw new Error(
        `prefix replay failed at index ${i} hash ${prefixHash}: ${e.message?.slice(0, 200)}`,
      );
    }
  }
}

async function getRawTx(provider: ethers.JsonRpcProvider, tx: any): Promise<string> {
  const hash = tx.hash;
  try {
    const raw = await withTimeout(
      provider.send("eth_getRawTransactionByHash", [hash]),
      5_000,
      `eth_getRawTransactionByHash timeout for ${hash}`,
    );
    if (typeof raw === "string" && raw !== "0x") return raw;
  } catch {
    // Fall through to reconstruction.
  }
  return reconstructRawTx(tx);
}

async function mineOneBlock(
  provider: ethers.JsonRpcProvider,
  label: string,
): Promise<void> {
  try {
    await withTimeout(
      provider.send("anvil_mine", ["0x1"]),
      REPLAY_TIMEOUT_MS,
      `anvil_mine timeout for ${label}`,
    );
  } catch {
    await withTimeout(
      provider.send("evm_mine", []),
      REPLAY_TIMEOUT_MS,
      `evm_mine timeout for ${label}`,
    );
  }
}

async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(label)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function waitForReceipt(
  provider: ethers.JsonRpcProvider,
  txHash: string,
  label: string,
): Promise<ethers.TransactionReceipt> {
  const receipt = await waitForMinedReceipt(provider, txHash, label);
  if (receipt.status !== 1) {
    throw new Error(`${label} reverted in local replay`);
  }
  return receipt;
}

async function waitForMinedReceipt(
  provider: ethers.JsonRpcProvider,
  txHash: string,
  label: string,
): Promise<ethers.TransactionReceipt> {
  const deadline = Date.now() + REPLAY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const receipt = await provider.getTransactionReceipt(txHash);
    if (receipt) return receipt;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`receipt timeout for ${label}`);
}

interface TransferShortfallInfo {
  description: string;
  token?: string;
  failedAmount?: bigint;
  incomingAmount?: bigint;
  // Distinguish: plain transfer goes directly to the token (no proxy issue).
  // transferFrom and unwrap typically hit token.proxy → impl, where failed call's
  // `to` is the impl but plan nodes reference the proxy → use `from` for token id.
  kind?: "transfer" | "transferFrom" | "unwrap";
}

async function traceFailureInfo(
  provider: ethers.JsonRpcProvider,
  txHash: string,
  executor: string,
): Promise<TransferShortfallInfo> {
  try {
    const trace = await provider.send("debug_traceTransaction", [
      txHash,
      { tracer: "callTracer", tracerConfig: { onlyTopCall: false } },
    ]);
    const info = describeFailedCall(trace, executor);

    // For unwrap / transferFrom shortfalls, read the executor's actual balance
    // on the token. Pre-revert (snapshot will be reverted by caller anyway).
    if (
      (info.kind === "unwrap" || info.kind === "transfer")
      && info.token
      && info.incomingAmount === undefined
    ) {
      try {
        const balIface = new ethers.Interface([
          "function balanceOf(address) view returns (uint256)",
        ]);
        const result = await provider.call({
          to: info.token,
          data: balIface.encodeFunctionData("balanceOf", [executor]),
        });
        const bal = BigInt(result);
        if (bal > 0n) info.incomingAmount = bal;
      } catch {
        // ignore balance probe failures
      }
    }
    return info;
  } catch (err: any) {
    return {
      description: `${txHash}; trace unavailable: ${err.message?.slice(0, 160)}`,
    };
  }
}

function describeFailedCall(trace: any, executor: string): TransferShortfallInfo {
  const failed: any[] = [];
  function walk(call: any): void {
    if (call?.error || call?.revertReason) failed.push(call);
    for (const child of call?.calls ?? []) walk(child);
  }
  walk(trace);
  const call = failed.at(-1) ?? trace;
  const selector = typeof call?.input === "string" ? call.input.slice(0, 10) : "";
  const target = call?.to ?? "";
  const from = call?.from ?? "";
  const reason = call?.revertReason || call?.error || "status=0";
  const description =
    `target=${target} selector=${selector} from=${from} reason=${String(reason).slice(0, 220)}`;

  if (!target) return { description };

  const erc20 = new ethers.Interface(["function transfer(address to, uint256 amount)"]);
  const unwrap = new ethers.Interface(["function unwrap(uint256 wstETHAmount)"]);
  let failedAmount: bigint | undefined;
  let kind: "transfer" | "transferFrom" | "unwrap" | undefined;

  if (selector === "0xa9059cbb") {
    try {
      failedAmount = erc20.decodeFunctionData("transfer", call.input)[1];
      kind = "transfer";
    } catch {
      return { description };
    }
  } else if (selector === "0x23b872dd") {
    // transferFrom(address from, address to, uint256 amount) — TRANSFER_AMOUNT_EXCEEDS_BALANCE.
    // If the `from` is our executor, we need to reduce the upstream amount that determines this.
    const transferFromIface = new ethers.Interface([
      "function transferFrom(address from, address to, uint256 amount)",
    ]);
    try {
      const decoded = transferFromIface.decodeFunctionData("transferFrom", call.input);
      // Only fix if the source of the transferFrom is our executor.
      if (String(decoded[0]).toLowerCase() !== executor.toLowerCase()) {
        return { description };
      }
      failedAmount = decoded[2];
      kind = "transferFrom";
    } catch {
      return { description };
    }
  } else if (selector === "0xde0e9a3e") {
    // wstETH.unwrap(uint256) — burn amount exceeds balance.
    // The failed call's .to is often the implementation contract (delegatecall target)
    // while plan nodes reference the proxy. Use .from when it differs and looks like a proxy.
    try {
      failedAmount = unwrap.decodeFunctionData("unwrap", call.input)[0];
      kind = "unwrap";
    } catch {
      return { description };
    }
  } else {
    return { description };
  }

  let incomingAmount: bigint | undefined;
  const executorLower = executor.toLowerCase();
  function scanIncoming(node: any): void {
    const nodeSelector = typeof node?.input === "string" ? node.input.slice(0, 10) : "";
    if (
      nodeSelector === "0xa9059cbb"
      && typeof node?.to === "string"
      && node.to.toLowerCase() === target.toLowerCase()
      && !node.error
    ) {
      try {
        const decoded = erc20.decodeFunctionData("transfer", node.input);
        if (String(decoded[0]).toLowerCase() === executorLower) {
          incomingAmount = decoded[1];
        }
      } catch {
        // ignore non-standard transfer payloads
      }
    }
    for (const child of node?.calls ?? []) scanIncoming(child);
  }
  scanIncoming(trace);

  // For unwrap and transferFrom-on-implementation, the failed call's `to` is the
  // impl contract while plan nodes reference the proxy. We prefer `from` only
  // when the failure looks like a proxy→impl delegation:
  //   - unwrap (selector 0xde0e9a3e): wstETH proxy delegatecalls to impl
  //   - transferFrom (selector 0x23b872dd): token proxy delegatecalls to impl
  // A direct erc20.transfer (selector 0xa9059cbb) is BotVM → token; `from` is
  // the EOA/contract caller, NOT a token address. Never override there.
  const isProxyImplFailure =
    (selector === "0xde0e9a3e" || selector === "0x23b872dd")
    && from
    && from.toLowerCase() !== target.toLowerCase();
  const reportToken = isProxyImplFailure ? from : target;

  return { description, token: reportToken, failedAmount, incomingAmount, kind };
}

function applyTransferShortfallAdjustment(
  root: any,
  failure: TransferShortfallInfo,
): boolean {
  if (
    !failure.token
    || failure.failedAmount === undefined
    || failure.incomingAmount === undefined
    || failure.incomingAmount <= 0n
    || failure.incomingAmount >= failure.failedAmount
  ) {
    return false;
  }

  let changed = false;
  function walk(node: any): void {
    if (
      node.adapterId === "erc20-transfer"
      && typeof node.target === "string"
      && node.target.toLowerCase() === failure.token!.toLowerCase()
      && node.amount === failure.failedAmount
    ) {
      node.amount = failure.incomingAmount;
      node.params.amount = failure.incomingAmount;
      changed = true;
    }

    if (
      (node.adapterId === "curve-exchange-nr" || node.adapterId === "curve-exchange-plain")
      && node.amount === failure.failedAmount
    ) {
      node.amount = failure.incomingAmount;
      changed = true;
    }

    // wstETH.unwrap shortfall — adjust the unwrap amount to actual holdings
    if (
      node.adapterId === "wsteth-unwrap"
      && typeof node.target === "string"
      && node.target.toLowerCase() === failure.token!.toLowerCase()
      && node.amount === failure.failedAmount
    ) {
      node.amount = failure.incomingAmount;
      changed = true;
    }

    // UniV2 router (alt) transferFrom shortfall — adjust amountIn to actual holdings.
    // The router uses tokenIn (params.tokenIn / node.tokenIn) for transferFrom from BotVM.
    if (
      node.adapterId === "univ2-router-swap-exact-in-alt"
      && typeof node.tokenIn === "string"
      && node.tokenIn.toLowerCase() === failure.token!.toLowerCase()
      && node.amount === failure.failedAmount
    ) {
      node.amount = failure.incomingAmount;
      node.params.amountIn = failure.incomingAmount;
      changed = true;
    }

    // UniV2 router (standard path[]) — first path token is the input
    if (
      node.adapterId === "univ2-router-swap-exact-in"
      && Array.isArray(node.params.path)
      && node.params.path.length > 0
      && (node.params.path[0] as string).toLowerCase() === failure.token!.toLowerCase()
      && node.amount === failure.failedAmount
    ) {
      node.amount = failure.incomingAmount;
      node.params.amountIn = failure.incomingAmount;
      changed = true;
    }

    for (const child of node.children ?? []) walk(child);
  }
  walk(root);
  return changed;
}

async function validateDeployedExecutor(
  anvil: ethers.JsonRpcProvider,
  executor: string,
): Promise<string> {
  const addr = ethers.getAddress(executor);
  const code = await anvil.getCode(addr);
  if (code === "0x") {
    throw new Error(`deployed executor has no code at historical pre-state: ${addr}`);
  }
  return addr;
}

async function installForkBotVm(
  anvil: ethers.JsonRpcProvider,
  owner: string,
  executor: string,
): Promise<string> {
  const addr = ethers.getAddress(executor);
  const runtime = patchedBotVmRuntime(owner);
  await anvil.send("anvil_setCode", [addr, runtime]);
  const code = await anvil.getCode(addr);
  if (code === "0x") throw new Error(`failed to install BotVM runtime at ${addr}`);
  return addr;
}

function patchedBotVmRuntime(owner: string): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const artifactPath = resolve(here, "../../out/BotVM.sol/BotVM.json");
  const artifact = JSON.parse(readFileSync(artifactPath, "utf8"));
  let runtime: string | undefined = artifact.deployedBytecode?.object;
  const refs = artifact.deployedBytecode?.immutableReferences ?? {};
  if (!runtime || runtime === "0x") {
    throw new Error(`BotVM artifact missing deployed bytecode; run forge build`);
  }

  for (const refList of Object.values(refs) as Array<Array<{ start: number; length: number }>>) {
    for (const ref of refList) {
      const encoded = ethers.zeroPadValue(owner, ref.length).slice(2);
      const start = 2 + ref.start * 2;
      const end = start + ref.length * 2;
      runtime = runtime.slice(0, start) + encoded + runtime.slice(end);
    }
  }
  return runtime;
}

async function fundAndImpersonateOwner(
  anvil: ethers.JsonRpcProvider,
  owner: string,
): Promise<void> {
  await anvil.send("anvil_setBalance", [
    ethers.getAddress(owner),
    "0x56bc75e2d63100000", // 100 ETH
  ]);
  await anvil.send("anvil_impersonateAccount", [ethers.getAddress(owner)]);
}

/**
 * Tokens we proactively mirror from original bot → our executor.
 * Covers wrapper/middle tokens that the original bot may have accumulated.
 * If the original bot has 0 balance, nothing happens (no harm).
 */
// Lowercase to bypass checksum validation. We getAddress() before use anyway.
const MIRROR_TOKENS = [
  "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2", // WETH
  "0x35fa164735182de50811e8e2e824cfb9b6118ac2", // weETH
  "0xcd5fe23c85820f7b72d0926fc9b05b43e359b7ee", // wstETH / weETH wrapper
  "0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0", // wstETH (Lido)
  "0xae7ab96520de3a18e5e111b5eaab095312d7fe84", // stETH (Lido)
  "0x1202f5c7b4b9e47a1a484e8b270be34dbbc75055", // wstUSR
  "0x40d16fc0246ad3160ccc09b8d0d3a2cd28ae6c2f", // GHO
  "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", // USDC
  "0xdac17f958d2ee523a2206206994597c13d831ec7", // USDT
  "0x6b175474e89094c44da98b954eedeac495271d0f", // DAI
];

/**
 * Impersonate the original bot and transfer its current token balances to our executor.
 * This mirrors the bot's "existing position" so trace-literal amounts are reachable.
 * Funded amounts cancel out in diffBalances (pre/post diff).
 */
async function mirrorOriginalBotBalances(
  anvil: ethers.JsonRpcProvider,
  originalBot: string,
  executor: string,
  ts: () => string,
): Promise<void> {
  const balIface = new ethers.Interface([
    "function balanceOf(address) view returns (uint256)",
    "function transfer(address to, uint256 amount)",
  ]);

  // Ensure original bot can submit txs.
  await anvil.send("anvil_impersonateAccount", [ethers.getAddress(originalBot)]);
  await anvil.send("anvil_setBalance", [
    ethers.getAddress(originalBot),
    "0x56bc75e2d63100000", // 100 ETH
  ]);

  const mirrored: string[] = [];
  const failed: string[] = [];
  for (const tokenRaw of MIRROR_TOKENS) {
    const token = ethers.getAddress(tokenRaw);
    try {
      const balResult = await anvil.call({
        to: token,
        data: balIface.encodeFunctionData("balanceOf", [originalBot]),
      });
      const bal = BigInt(balResult);
      if (bal === 0n) continue;

      const txData = balIface.encodeFunctionData("transfer", [executor, bal]);
      const txHash = await anvil.send("eth_sendTransaction", [{
        from: originalBot,
        to: token,
        data: txData,
        gas: "0x100000",
      }]);
      await anvil.send("anvil_mine", ["0x1"]);
      const receipt = await anvil.getTransactionReceipt(txHash);
      if (receipt?.status === 1) {
        mirrored.push(`${token.slice(0, 10)}=${bal}`);
      } else {
        failed.push(`${token.slice(0, 10)} status=${receipt?.status}`);
      }
    } catch (e: any) {
      failed.push(`${token.slice(0, 10)} err=${e.message?.slice(0, 80)}`);
    }
  }
  console.log(`[${ts()}] Mirror: ${mirrored.length} ok [${mirrored.join(", ")}], ${failed.length} fail [${failed.join(", ")}]`);
}

async function readBalances(
  provider: ethers.JsonRpcProvider,
  account: string,
): Promise<Record<string, bigint>> {
  const balances: Record<string, bigint> = {};
  const balIface = new ethers.Interface(["function balanceOf(address) view returns (uint256)"]);
  for (const { name, addr } of TRACKED_BALANCES) {
    try {
      const result = await provider.call({
        to: addr,
        data: balIface.encodeFunctionData("balanceOf", [account]),
      });
      balances[name] = BigInt(result);
    } catch {
      balances[name] = 0n;
    }
  }
  balances.ETH = await provider.getBalance(account);
  return balances;
}

function diffBalances(
  pre: Record<string, bigint>,
  post: Record<string, bigint>,
): Record<string, string> {
  const profit: Record<string, string> = {};
  for (const [name, postBal] of Object.entries(post)) {
    const delta = postBal - (pre[name] ?? 0n);
    if (delta > 0n) profit[name] = delta.toString();
  }
  return profit;
}

function reconstructRawTx(tx: any): string {
  const txObj = ethers.Transaction.from({
    type: tx.type ? parseInt(tx.type, 16) : 2,
    to: tx.to,
    nonce: parseInt(tx.nonce, 16),
    gasLimit: BigInt(tx.gas),
    gasPrice: tx.gasPrice ? BigInt(tx.gasPrice) : undefined,
    maxFeePerGas: tx.maxFeePerGas ? BigInt(tx.maxFeePerGas) : undefined,
    maxPriorityFeePerGas: tx.maxPriorityFeePerGas ? BigInt(tx.maxPriorityFeePerGas) : undefined,
    data: tx.input,
    value: BigInt(tx.value),
    chainId: tx.chainId ? BigInt(tx.chainId) : 1n,
    accessList: tx.accessList,
    signature: {
      r: tx.r,
      s: tx.s,
      v: parseInt(tx.v, 16),
    },
  });
  return txObj.serialized;
}

// ─── CLI Entry ─────────────────────────────────────────────────

async function main() {
  const txHash = process.argv[2];
  if (!txHash) {
    console.error("Usage: npx tsx src/replicate.ts <txHash>");
    process.exit(1);
  }

  const rpcUrl = process.env.MAINNET_RPC_URL;
  if (!rpcUrl) {
    console.error("Error: MAINNET_RPC_URL env var required");
    process.exit(1);
  }

  const useDeployed = process.env.REPLICATE_USE_DEPLOYED === "1";
  const executor = useDeployed ? (process.env.BOTVM_ADDRESS ?? "") : "";
  const owner = process.env.BOTVM_OWNER ?? DEFAULT_OWNER;
  if (useDeployed && !executor) {
    console.error("Error: REPLICATE_USE_DEPLOYED=1 requires BOTVM_ADDRESS");
    process.exit(1);
  }

  const result = await replicate(txHash, rpcUrl, executor, owner);

  console.log("\n=== RESULT ===");
  console.log(JSON.stringify(result, null, 2));

  stopAnvil();
  process.exit(result.success ? 0 : 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error("Fatal:", err);
    stopAnvil();
    process.exit(1);
  });
}
