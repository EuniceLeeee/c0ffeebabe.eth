/**
 * tx-profit — price the realized profit + builder payment of ANY tx hash.
 *
 * Thin CLI reusing the mature PnL core (`priceArb`, `arb-profit.ts`) that
 * bundle-postmortem uses — so a one-off "what did this competitor tx net?"
 * is a tool call, not a hand-rolled decode. Needs an archive RPC (past-block
 * tx/receipt/prestate). CU-cheap (tx + receipt + block + a trace).
 *
 * Usage: npm run tx-profit -- --tx <hash>[,<hash>...] --rpc <archive-url> [--json]
 */
import { priceArb, fetchEthUsd } from "../pnl/arb-profit.js";
import { hexToBigInt, RpcClient } from "../rpc/client.js";
import { lower } from "../registry/protocols.js";
import { parseArgs } from "../util.js";

interface TxProfit {
  tx: string;
  block: number | null;
  status: number | null;
  realizedProfitUsd: number | null;
  builderPaymentEth: number | null;
  builderPaymentUsd: number | null;
  netProfitUsd: number | null;   // realized − total gas (what the searcher keeps; see arb-profit.ts)
  gasCostUsd: number | null;
  unpricedDeltas: unknown[];
  gasUsed: number | null;
  ethUsd: number | null;
}

async function priceOne(rpc: RpcClient, hash: string): Promise<TxProfit> {
  const [tx, receipt] = await Promise.all([rpc.getTransaction(hash), rpc.getReceipt(hash)]);
  const blockNumber = receipt?.blockNumber != null ? Number(hexToBigInt(receipt.blockNumber)) : null;
  const block = blockNumber != null ? await rpc.getBlockByNumber(blockNumber, false) : null;
  const ethUsd = blockNumber != null
    ? await fetchEthUsd(rpc, receipt.blockNumber)
    : await fetchEthUsd(rpc);
  const coinbase = lower(block?.miner ?? "");
  const baseFeePerGas = block?.baseFeePerGas != null ? hexToBigInt(block.baseFeePerGas) : 0n;
  const profit = await priceArb(rpc, hash, tx, receipt, ethUsd, {
    entityActors: [tx?.to, tx?.from].filter((a): a is string => typeof a === "string" && a.length > 0),
    allowTrace: true,
    coinbase,
    baseFeePerGas,
  });
  const realized = profit.realizedProfitUsd;
  return {
    tx: hash,
    block: blockNumber,
    status: receipt?.status != null ? Number(hexToBigInt(receipt.status)) : null,
    realizedProfitUsd: realized,
    builderPaymentEth: profit.builderPaymentEth,
    builderPaymentUsd: profit.builderPaymentUsd,
    netProfitUsd: profit.netProfitUsd,
    gasCostUsd: profit.gasCostUsd,
    unpricedDeltas: profit.unpricedDeltas,
    gasUsed: receipt?.gasUsed != null ? Number(hexToBigInt(receipt.gasUsed)) : null,
    ethUsd,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const rpcUrl = typeof args.rpc === "string" ? args.rpc : process.env.MAINNET_RPC_URL;
  const txArg = typeof args.tx === "string" ? args.tx : "";
  if (!rpcUrl || !txArg) {
    console.error("Usage: npm run tx-profit -- --tx <hash>[,<hash>...] --rpc <archive-url> [--json]");
    process.exit(1);
  }
  const hashes = txArg.split(",").map((h) => h.trim()).filter(Boolean);
  const rpc = new RpcClient(rpcUrl);
  const results: TxProfit[] = [];
  for (const hash of hashes) {
    try {
      results.push(await priceOne(rpc, hash));
    } catch (err) {
      console.error(`[tx-profit] ${hash}: FAILED ${err instanceof Error ? err.message : String(err)}`);
      results.push({ tx: hash, block: null, status: null, realizedProfitUsd: null, builderPaymentEth: null,
        builderPaymentUsd: null, netProfitUsd: null, gasCostUsd: null, unpricedDeltas: [], gasUsed: null,
        ethUsd: null });
    }
  }
  if (args.json) {
    console.log(JSON.stringify(results, null, 2));
  } else {
    const marks = [...new Set(results.map((result) => result.ethUsd).filter((mark): mark is number => mark !== null))];
    console.log(`ethUsd=${marks.length === 1 ? marks[0] : "per-tx historical"}`);
    console.log("tx".padEnd(12), "block".padEnd(10), "realized$".padEnd(11), "builder$".padEnd(10),
      "net$".padEnd(9), "unpriced");
    for (const r of results) {
      const f = (n: number | null) => (n == null ? "—" : n.toFixed(2));
      console.log(
        r.tx.slice(0, 10).padEnd(12), String(r.block ?? "—").padEnd(10),
        f(r.realizedProfitUsd).padEnd(11), f(r.builderPaymentUsd).padEnd(10),
        f(r.netProfitUsd).padEnd(9), r.unpricedDeltas.length > 0 ? `${r.unpricedDeltas.length} tokens` : "",
      );
    }
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
