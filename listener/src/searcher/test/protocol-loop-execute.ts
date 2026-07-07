/**
 * Protocol atomic closed-loop VERIFICATION (clean, fully-quotable).
 *
 * Loop: USDC --(PSM, protocol leg)--> DAI --(Curve 3pool, DEX leg)--> USDC.
 * Both legs quote through the same buildTokenGraph / quote() path as any DEX swap; the loop closes
 * back to the start token (USDC). We fork mainnet, quote the loop at a fixed flash size, and — if the
 * loop is +EV at this state — build the flash+PSM+Curve+repay plan and run it through the SAME BotVM
 * simulator the live searcher uses, asserting an atomic status=1 execution that repays the flash.
 *
 * Fork-only / dry-run. Not a live opportunity finder — a machinery gate: "a PROTOCOL leg executes in
 * an atomic closed loop, sized + built + simulated by our own pipeline."
 */
import { ethers } from "ethers";
import { ADDR } from "../../shared/constants/addresses.js";
import { AnvilStateBackend } from "../../shared/state/state-backend.js";
import "../../shared/adapters/index.js";
import { buildTokenGraph, type TokenEdge, type TokenPath } from "../planner/token-graph.js";
import { quote } from "../solver/quoter.js";
import { buildResolvedPlanFromPath } from "../solver/plan-builder.js";
import { BotVMSimulator } from "../simulator/botvm-simulator.js";
import { DEFAULT_SEARCHER_EXECUTOR, DEFAULT_SEARCHER_OWNER, installForkBotVm } from "../../shared/executor/botvm-executor.js";

const ANVIL_PORT = Number(process.env.PROTOCOL_LOOP_ANVIL_PORT ?? "8577");
const ANVIL_URL = `http://127.0.0.1:${ANVIL_PORT}`;
const FLASH_SIZES = [10_000_000000n, 100_000_000000n, 1_000_000_000000n]; // 10k / 100k / 1M USDC

const PSM_ENTRY = {
  address: ADDR.SKY_PSM_LITE,
  adapter: "psm" as const,
  fixedTokenIn: ADDR.USDC,
  fixedTokenOut: ADDR.DAI,
  fixedSlotKind: "protocol" as const,
  fixedProtocolAction: "convert" as const,
};
const CURVE_3POOL_ENTRY = { address: ADDR.CURVE_3POOL, adapter: "curve" as const };

function usd6(x: bigint): string { return (Number(x) / 1e6).toFixed(6); }

// Fund an ERC20 balance on the fork by brute-forcing the balanceOf storage slot (USDC = slot 9).
const COMMON_ERC20_BALANCE_SLOTS = [9, 2, 0, 1, 3, 51];
async function dealToken(state: AnvilStateBackend, token: string, to: string, amount: bigint): Promise<void> {
  const erc20 = new ethers.Interface(["function balanceOf(address) view returns (uint256)"]);
  const value = ethers.toBeHex(amount, 32);
  for (const slotIndex of COMMON_ERC20_BALANCE_SLOTS) {
    const slot = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["address", "uint256"], [to, slotIndex]));
    await state.provider.send("anvil_setStorageAt", [token, slot, value]);
    const raw = await state.provider.call({ to: token, data: erc20.encodeFunctionData("balanceOf", [to]) });
    if (BigInt(raw) === amount) return;
  }
  throw new Error(`dealToken: no balance slot found for ${token}`);
}

async function main(): Promise<void> {
  const rpcUrl = process.env.MAINNET_RPC_URL;
  if (!rpcUrl) throw new Error("MAINNET_RPC_URL required");
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const block = process.env.PROTOCOL_LOOP_BLOCK ? Number(process.env.PROTOCOL_LOOP_BLOCK) : await provider.getBlockNumber();
  const state = new AnvilStateBackend(rpcUrl, ANVIL_URL, ANVIL_PORT);
  await state.forkAt(block);
  await installForkBotVm(state.provider, DEFAULT_SEARCHER_OWNER, DEFAULT_SEARCHER_EXECUTOR);
  await state.provider.send("anvil_setBalance", [DEFAULT_SEARCHER_EXECUTOR, "0x56bc75e2d63100000"]); // executor gas
  console.log(`[protocol-loop] forked ${ANVIL_URL} @ block ${block} + BotVM executor installed`);

  const edges = await buildTokenGraph(state, [PSM_ENTRY, CURVE_3POOL_ENTRY]);
  const lc = (s: string) => s.toLowerCase();
  const psmEdge = edges.find((e: TokenEdge) => e.adapterId === "psm" && lc(e.tokenIn) === lc(ADDR.USDC) && lc(e.tokenOut) === lc(ADDR.DAI));
  const curveEdge = edges.find((e: TokenEdge) => e.adapterId.startsWith("curve") && lc(e.tokenIn) === lc(ADDR.DAI) && lc(e.tokenOut) === lc(ADDR.USDC) && lc(e.target) === lc(ADDR.CURVE_3POOL));
  if (!psmEdge) throw new Error("PSM USDC->DAI edge not found");
  if (!curveEdge) throw new Error("Curve 3pool DAI->USDC edge not found");
  console.log(`[protocol-loop] legs: PSM(${psmEdge.adapterId}) USDC->DAI  +  Curve(${curveEdge.adapterId}) DAI->USDC`);

  const path: TokenPath = { edges: [psmEdge, curveEdge] } as TokenPath;

  const FLASH = 100_000_000000n; // 100k USDC
  const daiOut = await quote(psmEdge.adapterId, psmEdge.target, ADDR.USDC, ADDR.DAI, FLASH, state, undefined, undefined, psmEdge.poolToken0, psmEdge.poolToken1);
  const usdcBack = await quote(curveEdge.adapterId, curveEdge.target, ADDR.DAI, ADDR.USDC, daiOut, state, undefined, undefined, curveEdge.poolToken0, curveEdge.poolToken1);
  const gross = usdcBack - FLASH;
  console.log(`[protocol-loop] quote: ${usd6(FLASH)} USDC -> DAI -> ${usd6(usdcBack)} USDC  gross=${gross >= 0n ? "+" : ""}${usd6(gross)} USDC (Curve fee, no dislocation)`);

  // Atomic-execution verification: flash+PSM+Curve+repay via the SAME BotVM the searcher uses. With no
  // peg dislocation the round-trip loses the Curve fee, so the flash cannot repay from the loop alone —
  // we pre-fund the executor a small USDC buffer (> the fee) so the flash REPAYS and the full sequence
  // executes atomically. This is a MACHINERY gate (a protocol leg closes an atomic loop), not a live
  // +EV finder; grossProfit = -Curve-fee is the delta (buffer cancels out).
  //
  // Run BOTH flash adapters. This pins the flash-repay path per adapter: morpho PULLS the repay
  // (approve), balancer VERIFIES its restored balance (transfer-back). The plan-builder emits the right
  // repay per adapter — a balancer plan that only approved would silently revert (the bug this discovered).
  const executor = DEFAULT_SEARCHER_EXECUTOR;
  const maxFee = FLASH - usdcBack + 10_000n; // quoted Curve fee + tiny sim rounding

  async function runLoop(flashAdapterId: string): Promise<boolean> {
    const buffer = (FLASH - usdcBack) * 4n + 1_000000n; // > the fee loss, so the flash repays
    await dealToken(state, ADDR.USDC, executor, buffer);
    const root = await buildResolvedPlanFromPath(path, ADDR.USDC, FLASH, [FLASH, daiOut, usdcBack], executor, state, 1n, flashAdapterId);
    const plan = { root, profitToken: ADDR.USDC, flashAmount: FLASH, netProfit: gross, templateName: "protocol-loop" } as unknown as Parameters<BotVMSimulator["simulate"]>[0];
    const result = await new BotVMSimulator(state, executor, DEFAULT_SEARCHER_OWNER).simulate(plan);
    // status=1 = the atomic tx did not revert (flash borrowed, PSM converted, Curve swapped, guard
    // passed, flash REPAID — the loop closed back to USDC). grossProfit ~ -Curve-fee = value-preserving.
    const ok = result.revertReason === undefined && result.grossProfit >= -maxFee && result.grossProfit <= gross + 10_000n;
    console.log(`[protocol-loop] ${flashAdapterId.padEnd(14)} revert=${result.revertReason ? result.revertReason.slice(0, 60) : "NONE (status=1)"} grossProfit=${usd6(result.grossProfit)} USDC -> ${ok ? "PASS" : "FAIL"}`);
    return ok;
  }

  console.log(`[protocol-loop] pre-fund buffer per run = ${usd6((FLASH - usdcBack) * 4n + 1_000000n)} USDC (covers the ${usd6(FLASH - usdcBack)} Curve fee so the flash repays)\n`);
  const results: boolean[] = [];
  for (const adapterId of ["morpho-flash", "balancer-flash"]) {
    results.push(await runLoop(adapterId));
  }

  if (!results.every(Boolean)) {
    console.log("\nPROTOCOL LOOP: FAIL");
    process.exit(1);
  }
  console.log(`\n[protocol-loop] PASS — protocol(PSM) + DEX(Curve) atomic closed loop (flash->USDC->DAI->USDC->repay) executed status=1 + closed to USDC under BOTH morpho-flash and balancer-flash.`);
  console.log("\nPROTOCOL LOOP: PASS");
  process.exit(0);
}

main().catch((e) => { console.error(`[protocol-loop] ERROR: ${e?.message ?? e}`); process.exit(1); });
