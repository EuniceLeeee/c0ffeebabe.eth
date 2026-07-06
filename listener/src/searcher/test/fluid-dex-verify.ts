/**
 * Fluid DEX USDC->USDT coffee verifier.
 *
 * Archive fork only. Replays the local quote against the pre-coffee state and
 * checks the adapter emits the plain non-callback swapIn selector.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ethers } from "ethers";
import "../../shared/adapters/index.js";
import { fluidDexSwapAdapter } from "../../adapters/fluid-dex.js";
import { bytesToHex } from "../../encoder.js";
import { ADDR } from "../../shared/constants/addresses.js";
import { AnvilStateBackend } from "../../shared/state/state-backend.js";
import type { ResolvedPlanNode } from "../../shared/types/plan.js";
import { buildResolvedPlanFromPath } from "../solver/plan-builder.js";
import { fluidDexSwapIface, quote, FLUID_DEX_ADDRESS_DEAD } from "../solver/quoter.js";
import type { TokenEdge } from "../planner/token-graph.js";
import { deriveEdgeTaxonomy } from "../strategy-taxonomy.js";
import { DEFAULT_SEARCHER_EXECUTOR } from "../../shared/executor/botvm-executor.js";

const TX = "0x9be73297e0fd8b0ff9760356480b372e3f78b12ce6bc6dc9bb83888d1314b862";
const BLOCK = 24_568_129;
const AMOUNT_IN = 326_058_650000n; // 326,058.65 USDC
const EXPECTED_OUT = BigInt(process.env.FLUID_DEX_EXPECTED_OUT ?? "326061670000"); // ~326,061.67 USDT
const TOLERANCE = BigInt(process.env.FLUID_DEX_VERIFY_TOLERANCE_RAW ?? "2000000"); // 2 USDT

function loadEnv(): void {
  let text = "";
  try {
    text = readFileSync(resolve("..", ".env"), "utf8");
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
  const rpcUrl = process.env.MAINNET_RPC_URL;
  if (!rpcUrl) throw new Error("MAINNET_RPC_URL archive endpoint required");

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const latest = await provider.getBlockNumber();
  if (latest < BLOCK) throw new Error(`archive RPC latest ${latest} is before block ${BLOCK}`);

  const state = new AnvilStateBackend(
    rpcUrl,
    `http://127.0.0.1:${Number(process.env.SEARCHER_FLUID_DEX_VERIFY_ANVIL_PORT ?? "8576")}`,
    Number(process.env.SEARCHER_FLUID_DEX_VERIFY_ANVIL_PORT ?? "8576"),
  );

  try {
    const tx = await provider.getTransaction(TX);
    if (!tx) throw new Error(`missing transaction ${TX}`);
    const previousTxHash = await previousHash(provider, BLOCK, tx.index ?? -1);
    if (previousTxHash) {
      await state.forkAfterTx(previousTxHash);
    } else {
      await state.forkAt(BLOCK - 1);
    }

    const edge = fluidDexEdge(ADDR.USDC, ADDR.USDT);
    const plan = await buildResolvedPlanFromPath(
      { edges: [edge] },
      ADDR.USDC,
      AMOUNT_IN,
      [AMOUNT_IN, EXPECTED_OUT],
      DEFAULT_SEARCHER_EXECUTOR,
      state,
      1n,
    );
    const approve = plan.children[0];
    const swap = plan.children[1];
    assert(approve.adapterId === "erc20-approve", "Fluid DEX plan missing approve-first child");
    assert(swap.adapterId === "fluid-dex-swap", `unexpected swap adapter ${swap.adapterId}`);

    const encoded = bytesToHex(fluidDexSwapAdapter.encode(swap, DEFAULT_SEARCHER_EXECUTOR, new Uint8Array()));
    const payload = encodedPayload(encoded);
    assert(payload.startsWith("0x2668dfaa"), `plain swapIn selector mismatch: ${payload.slice(0, 10)}`);
    const decoded = fluidDexSwapIface.decodeFunctionData("swapIn", payload);
    assert(decoded[0] === true, "USDC->USDT must be swap0to1=true");
    assert(BigInt(decoded[1]) === AMOUNT_IN, `amountIn mismatch ${decoded[1]}`);
    assert(BigInt(decoded[2]) === 0n, `amountOutMin mismatch ${decoded[2]}`);
    assert(
      String(decoded[3]).toLowerCase() === DEFAULT_SEARCHER_EXECUTOR.toLowerCase(),
      `recipient mismatch ${decoded[3]}`,
    );
    assert(!payload.startsWith("0xbe17c79c"), "callback selector must not be emitted");

    const quoted = await quote(
      "fluid-dex-swap",
      ADDR.FLUID_DEX_USDC_USDT,
      ADDR.USDC,
      ADDR.USDT,
      AMOUNT_IN,
      state,
      undefined,
      undefined,
      ADDR.USDC,
      ADDR.USDT,
    );
    const diff = abs(quoted - EXPECTED_OUT);
    assert(
      diff <= TOLERANCE,
      `quote ${quoted} differs from expected ${EXPECTED_OUT} by ${diff} (tol ${TOLERANCE})`,
    );

    const deadCalldata = fluidDexSwapIface.encodeFunctionData("swapIn", [
      true,
      AMOUNT_IN,
      0n,
      FLUID_DEX_ADDRESS_DEAD,
    ]);
    assert(deadCalldata.startsWith("0x2668dfaa"), "ADDRESS_DEAD estimate must use plain swapIn");

    console.log(
      `[fluid-dex-verify] PASS tx=${TX.slice(0, 10)} block=${BLOCK} ` +
        `amountIn=${AMOUNT_IN} quote=${quoted} diff=${diff}`,
    );
  } finally {
    state.stop();
  }
}

function fluidDexEdge(tokenIn: string, tokenOut: string): TokenEdge {
  return {
    adapterId: "fluid-dex-swap",
    target: ADDR.FLUID_DEX_USDC_USDT,
    tokenIn,
    tokenOut,
    slotKind: "swap",
    poolToken0: ADDR.USDC,
    poolToken1: ADDR.USDT,
    ...deriveEdgeTaxonomy("swap"),
  };
}

async function previousHash(
  provider: ethers.JsonRpcProvider,
  blockNumber: number,
  txIndex: number,
): Promise<string | null> {
  if (txIndex < 0) throw new Error(`transaction index unavailable for ${TX}`);
  if (txIndex === 0) return null;
  const block = await provider.send("eth_getBlockByNumber", [
    `0x${blockNumber.toString(16)}`,
    false,
  ]);
  const txs = Array.isArray(block?.transactions) ? block.transactions : [];
  const previous = txs[txIndex - 1];
  if (typeof previous !== "string") {
    throw new Error(`missing previous tx for block ${blockNumber} index ${txIndex}`);
  }
  return previous;
}

function encodedPayload(scriptHex: string): string {
  const hex = scriptHex.startsWith("0x") ? scriptHex.slice(2) : scriptHex;
  const opcode = hex.slice(0, 2);
  if (opcode !== "00") throw new Error(`expected CALL opcode 0x00, got 0x${opcode}`);
  const payloadLen = Number.parseInt(hex.slice(42, 48), 16);
  const payload = hex.slice(48);
  assert(payload.length === payloadLen * 2, `payload length mismatch ${payload.length / 2} != ${payloadLen}`);
  return `0x${payload}`;
}

function abs(value: bigint): bigint {
  return value < 0n ? -value : value;
}

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

main().catch((err) => {
  console.error(`[fluid-dex-verify] FAIL: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
