#!/usr/bin/env npx tsx
/**
 * Debug script: reproduce the live-run revert scenario.
 *
 * Forks at a recent block, runs one solver iteration with the same
 * path the live run tried, then uses debug_traceTransaction to find
 * where exactly the revert happens.
 */

import { ethers } from "ethers";
import "../adapters/index.js"; // register all adapters
import { ADDR } from "../shared/constants/addresses.js";
import { AnvilStateBackend } from "../shared/state/state-backend.js";
import { compilePlan } from "../shared/compiler/compiler.js";
import { bytesToHex } from "../shared/compiler/encoder.js";
import { buildExecuteCalldata, installForkBotVm } from "../shared/executor/botvm-executor.js";
import { buildResolvedPlanFromPath } from "../searcher/solver/plan-builder.js";
import { propagateAmounts } from "../searcher/solver/amount-propagation.js";
import type { TokenEdge } from "../searcher/planner/token-graph.js";
import { defaultTokenGraphFixture } from "../searcher/fixtures/default-token-graph.js";
import { deriveEdgeTaxonomy } from "../searcher/strategy-taxonomy.js";

const RPC = process.env.MAINNET_RPC_URL!;
if (!RPC) throw new Error("MAINNET_RPC_URL required");

const ANVIL_PORT = 8557;

async function main() {
  const state = new AnvilStateBackend(RPC, `http://127.0.0.1:${ANVIL_PORT}`, ANVIL_PORT);
  const provider = state.provider;

  try {
    // Fork at latest
    console.log("[debug] starting anvil fork...");
    await state.start();
    const block = await provider.getBlockNumber();
    console.log(`[debug] forked at block ${block}`);

    // Install BotVM
    const executor = await installForkBotVm(provider);
    console.log(`[debug] BotVM installed at ${executor}`);

    // Build the same path from the log:
    // wstUSR->USDC@fluid-vault → USDC->WETH@univ3-swap → WETH->USDT@univ3-swap
    // → USDT->sUSDS@curve-exchange → sUSDS->DOLA@curve-exchange → DOLA->wstUSR@curve-exchange-nr
    const graph = defaultTokenGraphFixture();
    const path = {
      edges: [
        findEdge(graph, "fluid-vault", ADDR.WSTUSR, ADDR.USDC),
        // USDC->WETH: use a discovered pool or the graph doesn't have this
        // The live run had this from the discovered 0x88e6A0c2 pool.
        // Let's add it manually for the repro.
        {
          adapterId: "univ3-swap",
          target: "0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640", // USDC/WETH 500
          tokenIn: ADDR.USDC,
          tokenOut: ADDR.WETH,
          slotKind: "swap" as const,
          ...deriveEdgeTaxonomy("swap"),
          poolToken0: ADDR.WETH,
          poolToken1: ADDR.USDC,
        },
        findEdge(graph, "univ3-swap", ADDR.WETH, ADDR.USDT),
        findEdge(graph, "curve-exchange", ADDR.USDT, ADDR.SUSDS),
        findEdge(graph, "curve-exchange", ADDR.SUSDS, ADDR.DOLA),
        findEdge(graph, "curve-exchange-nr", ADDR.DOLA, ADDR.WSTUSR),
      ],
    };

    console.log("[debug] path edges:");
    for (const e of path.edges) {
      console.log(`  ${e.tokenIn.slice(0, 10)}→${e.tokenOut.slice(0, 10)} @${e.adapterId} target=${e.target.slice(0, 10)}`);
    }

    // Use a small flash amount (same order as the live run)
    const flashAmount = 580457685158941568n; // ~0.58 wstUSR (from log)
    const flashToken = ADDR.WSTUSR;
    const fluidDebtBps = 10000n;

    console.log(`[debug] propagating amounts... flashAmount=${flashAmount}`);
    let amounts: bigint[];
    try {
      amounts = await propagateAmounts(path, flashAmount, state, { fluidDebtBps });
      console.log("[debug] amounts:", amounts.map(String));
    } catch (err) {
      console.log(`[debug] propagation failed: ${err}`);
      // Use dummy amounts to still test compilation
      amounts = Array(path.edges.length + 1).fill(flashAmount);
      console.log("[debug] using dummy amounts to test compilation path");
    }

    // Test both flash sources
    for (const flashId of ["morpho-flash", "balancer-flash"] as const) {
      console.log(`\n[debug] ════ Testing ${flashId} ════`);
      await testFlashSource(flashId, path, flashToken, flashAmount, amounts, executor, state, provider);
    }
  } finally {
    state.stop();
  }
}

async function testFlashSource(
  flashId: string,
  path: any,
  flashToken: string,
  flashAmount: bigint,
  amounts: bigint[],
  executor: string,
  state: AnvilStateBackend,
  provider: ethers.JsonRpcProvider,
) {
  const snap = await state.snapshot();
  try {
    console.log("[debug] building resolved plan...");
    const resolvedNode = await buildResolvedPlanFromPath(
      path,
      flashToken,
      flashAmount,
      amounts,
      executor,
      state,
      1n,
      flashId,
    );

    console.log("[debug] compiling plan...");
    const script = compilePlan(resolvedNode, executor);
    const calldata = buildExecuteCalldata(script);
    console.log(`[debug] script length=${script.length} calldata length=${calldata.length}`);

    // Dump plan tree top-level only
    console.log("\n[debug] ──── Plan Tree (top-level) ────");
    dumpNode(resolvedNode, 0);

    // Execute and trace
    console.log("\n[debug] ──── Executing on Anvil ────");
    const owner = "0x1000000000000000000000000000000000000001";

    try {
      const txHash = await provider.send("eth_sendTransaction", [{
        from: owner,
        to: executor,
        data: calldata,
        gas: "0x1000000",
      }]);
      await provider.send("evm_mine", []);
      console.log(`[debug] txHash=${txHash}`);

      const receipt = await provider.getTransactionReceipt(txHash);
      console.log(`[debug] status=${receipt?.status} gasUsed=${receipt?.gasUsed}`);

      if (receipt?.status === 0) {
        console.log("\n[debug] ──── REVERTED. Tracing... ────");
        const trace = await provider.send("debug_traceTransaction", [
          txHash,
          { tracer: "callTracer", tracerConfig: { withLog: false } },
        ]);
        printTrace(trace, 0);
      } else {
        console.log("[debug] ✅ SUCCESS — no revert");
      }
    } catch (err: any) {
      console.log(`[debug] send failed: ${err.message?.slice(0, 200)}`);
    }
  } finally {
    await state.revert(snap);
  }
}

function findEdge(graph: TokenEdge[], adapterId: string, tokenIn: string, tokenOut: string): TokenEdge {
  const edge = graph.find(
    (e) =>
      e.adapterId === adapterId &&
      e.tokenIn.toLowerCase() === tokenIn.toLowerCase() &&
      e.tokenOut.toLowerCase() === tokenOut.toLowerCase(),
  );
  if (!edge) throw new Error(`edge not found: ${adapterId} ${tokenIn.slice(0, 10)}→${tokenOut.slice(0, 10)}`);
  return edge;
}

function dumpNode(node: any, depth: number): void {
  const indent = "  ".repeat(depth);
  const amt = typeof node.amount === "bigint" ? node.amount.toString() : node.amount;
  console.log(`${indent}${node.adapterId} target=${node.target?.slice(0, 12)} amount=${amt}`);
  if (node.params) {
    const keys = Object.keys(node.params).filter((k) => node.params[k] !== undefined);
    if (keys.length > 0) {
      const summary = keys.map((k) => {
        const v = node.params[k];
        return `${k}=${typeof v === "bigint" ? v.toString() : typeof v === "string" ? v.slice(0, 12) : v}`;
      }).join(" ");
      console.log(`${indent}  params: ${summary}`);
    }
  }
  for (const child of node.children ?? []) {
    dumpNode(child, depth + 1);
  }
}

function printTrace(trace: any, depth: number): void {
  if (!trace) return;
  const indent = "  ".repeat(depth);
  const to = trace.to ?? "???";
  const err = trace.error ?? "";
  const input = trace.input?.slice(0, 10) ?? "";
  const revertReason = trace.output && trace.output !== "0x" ? trace.output.slice(0, 20) : "";
  console.log(
    `${indent}${trace.type ?? "CALL"} → ${to} sel=${input} ` +
      (err ? `ERROR=${err} ` : "") +
      (revertReason ? `out=${revertReason}` : ""),
  );
  for (const call of trace.calls ?? []) {
    printTrace(call, depth + 1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
