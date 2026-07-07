/**
 * tx-flow — receipt flow reconstruction for ANY tx hash (the F-010/011/012 flow-walk as a tool).
 *
 * Prints the ordered value movements (transfers, mint/burn, WETH wrap/unwrap) with resolved
 * symbols/decimals and role labels, the per-address nets, conserved intermediaries, and the
 * executor's net take. Receipt + a few symbol/decimals eth_calls — CU-cheap, no trace.
 *
 * Usage: npm run tx-flow -- --tx <hash>[,<hash>...] --rpc <url> [--max-steps <n=40>] [--json]
 */
import { buildFlowReport, formatTokenAmount, renderFlowWalk } from "../pnl/flow-walk.js";
import { lower } from "../registry/protocols.js";
import { RpcClient } from "../rpc/client.js";
import { parseArgs } from "../util.js";

function isAddressString(value: unknown): value is string {
  return typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const rpcUrl = typeof args.rpc === "string" ? args.rpc : process.env.MAINNET_RPC_URL;
  const txArg = typeof args.tx === "string" ? args.tx : "";
  const maxSteps = args["max-steps"] ? Number(args["max-steps"]) : 40;
  if (!rpcUrl || !txArg) {
    console.error("Usage: npm run tx-flow -- --tx <hash>[,<hash>...] --rpc <url> [--max-steps <n=40>] [--json]");
    process.exit(1);
  }
  const rpc = new RpcClient(rpcUrl);
  for (const hash of txArg.split(",").map((value) => value.trim()).filter(Boolean)) {
    const [tx, receipt] = await Promise.all([rpc.getTransaction(hash), rpc.getReceipt(hash)]);
    if (!tx || !receipt) {
      console.error(`[tx-flow] ${hash}: not found on-chain`);
      continue;
    }
    const executors = new Set([tx?.from, tx?.to].filter(isAddressString).map(lower));
    const report = await buildFlowReport(rpc, receipt, executors);
    if (args.json) {
      console.log(JSON.stringify({
        tx: lower(hash),
        executors: [...executors],
        steps: report.steps.map((step) => ({
          ...step,
          amount: step.amount.toString(),
          symbol: report.tokens.get(step.token)?.symbol,
          display: formatTokenAmount(step.amount, report.tokens.get(step.token)?.decimals ?? null),
        })),
        conserved_intermediaries: report.conservedIntermediaries,
        executor_net: [...report.executorNetByToken.entries()].map(([token, amount]) => ({
          token,
          symbol: report.tokens.get(token)?.symbol,
          net: amount.toString(),
          display: formatTokenAmount(amount, report.tokens.get(token)?.decimals ?? null),
        })),
      }, null, 2));
    } else {
      console.log(`tx-flow ${lower(hash)} (executors: ${[...executors].join(", ")})`);
      console.log(renderFlowWalk(report, maxSteps));
    }
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
