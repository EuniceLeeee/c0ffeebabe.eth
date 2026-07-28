/**
 * Classify one landed swap transaction as victim-driven or block-scan.
 *
 * Usage: npm run tx-source-shape -- --tx <hash>
 */
import { pathToFileURL } from "node:url";
import { classifyTransactionSource } from "../pnl/tx-source-shape.js";
import { RpcClient } from "../rpc/client.js";
import { parseArgs, resolveRpcUrl } from "../util.js";

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const txHash = typeof args.tx === "string" ? args.tx.trim() : "";
  const rpcUrl = resolveRpcUrl(args);
  if (!txHash || !rpcUrl) {
    throw new Error("Usage: npm run tx-source-shape -- --tx <hash> [--rpc <url>]");
  }

  console.log(await classifyTransactionSource(new RpcClient(rpcUrl), txHash));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
}
