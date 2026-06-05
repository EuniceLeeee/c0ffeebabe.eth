/**
 * Batch runner for AC-2.
 *
 * Runs the V3 replicate pipeline against the four target bot transactions and
 * exits successfully only when at least two complete replications succeed.
 */

import { replicate } from "./replicate.js";
import { stopAnvil } from "./simulator.js";

const TARGET_TXS = [
  "0xb44ae26c1324abd752a201f27a98780f9b0dcd47e86e4777b5b0e67e4be7216e",
  "0xf89919583fe87eaa8632a1af52cb4037d402e230a39546404f1e595c77f5b2ef",
  "0x7f335bae8b60b6ad7868fa799e94a0d0f301a6023a7e58cfd5c914e37c230952",
  "0xf025660b830054030e1ee4838c007c783cebe8c56c8e45c09b577e8d7196d823",
];

const DEFAULT_OWNER = "0x1000000000000000000000000000000000000001";
const TX_TIMEOUT_MS = Number(process.env.REPLICATE_TX_TIMEOUT_MS ?? 360_000);

async function main() {
  const rpcUrl = process.env.MAINNET_RPC_URL;
  if (!rpcUrl) {
    console.error("Error: MAINNET_RPC_URL env var required");
    process.exit(1);
  }

  // Force fork-tx mode for AC-2 — long prefixes can't be replayed sequentially.
  // Requires archive RPC (Alchemy paid plan).
  if (!process.env.REPLICATE_PREFIX_MODE) {
    process.env.REPLICATE_PREFIX_MODE = "fork-tx";
  }
  console.log(`[batch] REPLICATE_PREFIX_MODE=${process.env.REPLICATE_PREFIX_MODE}`);

  const useDeployed = process.env.REPLICATE_USE_DEPLOYED === "1";
  const executor = useDeployed ? (process.env.BOTVM_ADDRESS ?? "") : "";
  if (useDeployed && !executor) {
    console.error("Error: REPLICATE_USE_DEPLOYED=1 requires BOTVM_ADDRESS");
    process.exit(1);
  }
  const owner = process.env.BOTVM_OWNER ?? DEFAULT_OWNER;
  const txs = process.argv.slice(2).length > 0 ? process.argv.slice(2) : TARGET_TXS;

  const results = [];
  for (const txHash of txs) {
    console.log(`\n=== Replicate ${txHash} ===`);
    const result = await withTimeout(
      replicate(txHash, rpcUrl, executor, owner),
      TX_TIMEOUT_MS,
      {
        success: false,
        txHash,
        blockNumber: 0,
        txIndex: 0,
        error: `replicate timeout after ${TX_TIMEOUT_MS}ms`,
      },
    );
    if (!result.success) stopAnvil();
    results.push(result);
    console.log(JSON.stringify(result, null, 2));
  }

  const successCount = results.filter((r) => r.success).length;
  console.log("\n=== AC-2 Summary ===");
  for (const r of results) {
    const status = r.success ? "SUCCESS" : "SKIP/FAIL";
    console.log(`${status} ${r.txHash} ${r.shapeName ?? ""} ${r.skipReason ?? r.error ?? ""}`);
  }
  console.log(`successCount=${successCount}/${results.length}`);

  stopAnvil();
  process.exit(successCount >= 2 ? 0 : 1);
}

main().catch((err) => {
  console.error("Fatal:", err);
  stopAnvil();
  process.exit(1);
});

async function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallback), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
