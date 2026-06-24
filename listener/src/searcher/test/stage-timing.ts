/**
 * One-off diagnostic: per-stage timing of the live Path A pre-solver pipeline.
 *
 * Replays the exact prep sequence handleHint runs before the first TTL check
 * (getBlockNumber → refreshFork/reset → impersonateSwap → prepareForkExecutor)
 * against the real CRV/WETH UniV3 pool from the observed live opportunity,
 * to attribute the 10-15s that killed every opportunity at oppTtlMs=5000.
 *
 * Uses port 8611 — safe to run while the live searcher (8555) is up.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { ethers } from "ethers";
import { AnvilStateBackend } from "../../shared/state/state-backend.js";

const POOL = "0x919Fa96e88d67499339577Fa202345436bcDaf79"; // CRV/WETH 0.3%
const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const CRV = "0xD533a949740bb3306d119CC777fa900bA034cd52";
const AMOUNT_IN = 101859718286728000n; // observed live hint amountIn
const WHALE = "0x000000000000000000000000000000000000dEaD";
const FORK_ETH_BALANCE = "0x56bc75e2d63100000";
const UNIV3_SWAP_ROUTER = "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45";
const BOTVM = "0x4aF9495C4aC24c5CD3b0C90611550a1996415BCe";

const ERC20_IFACE = new ethers.Interface([
  "function approve(address spender, uint256 amount)",
  "function balanceOf(address account) view returns (uint256)",
]);
const UNIV3_ROUTER_IFACE = new ethers.Interface([
  "function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) returns (uint256 amountOut)",
]);
const UNIV3_FEE_IFACE = new ethers.Interface(["function fee() view returns (uint24)"]);

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

async function dealToken(state: AnvilStateBackend, token: string, to: string, amount: bigint): Promise<void> {
  const BALANCE_SLOTS_TO_TRY = [0, 1, 2, 3, 4, 5, 9, 51];
  for (const slotIndex of BALANCE_SLOTS_TO_TRY) {
    const snap = await state.snapshot();
    const slot = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(["address", "uint256"], [to, slotIndex]),
    );
    const value = ethers.zeroPadValue(ethers.toBeHex(amount), 32);
    await state.provider.send("anvil_setStorageAt", [token, slot, value]);
    const bal = await state.getTokenBalance(token, to).catch(() => 0n);
    if (bal >= amount) return;
    await state.revert(snap);
  }
  throw new Error("dealToken: no slot found");
}

async function impersonateSwap(state: AnvilStateBackend, label: string): Promise<void> {
  const whale = ethers.getAddress(WHALE);
  const times: Array<[string, number]> = [];
  let t = performance.now();
  const mark = (name: string) => {
    times.push([name, performance.now() - t]);
    t = performance.now();
  };

  await state.provider.send("anvil_setBalance", [whale, FORK_ETH_BALANCE]);
  mark("setBalance");
  await dealToken(state, WETH, whale, AMOUNT_IN * 2n);
  mark("dealToken(WETH slot3, 4 tries)");
  await state.provider.send("anvil_impersonateAccount", [whale]);
  mark("impersonate");
  const approveData = ERC20_IFACE.encodeFunctionData("approve", [UNIV3_SWAP_ROUTER, AMOUNT_IN * 2n]);
  await state.send({ from: whale, to: WETH, data: approveData });
  mark("approve send+mine");
  const feeResult = await state.call({ to: POOL, data: UNIV3_FEE_IFACE.encodeFunctionData("fee", []) });
  mark("pool fee() call");
  const swapData = UNIV3_ROUTER_IFACE.encodeFunctionData("exactInputSingle", [{
    tokenIn: WETH,
    tokenOut: CRV,
    fee: Number(BigInt(feeResult)),
    recipient: whale,
    amountIn: AMOUNT_IN,
    amountOutMinimum: 0n,
    sqrtPriceLimitX96: 0n,
  }]);
  await state.send({ from: whale, to: UNIV3_SWAP_ROUTER, data: swapData, gas: "0x1000000" });
  mark("univ3 swap send+mine");
  await state.provider.send("anvil_stopImpersonatingAccount", [whale]);
  mark("stopImpersonate");

  const total = times.reduce((s, [, v]) => s + v, 0);
  console.log(`\n[stage-timing] impersonateSwap (${label}): total ${total.toFixed(0)}ms`);
  for (const [name, ms] of times) console.log(`  ${name.padEnd(32)} ${ms.toFixed(0)}ms`);
}

async function main(): Promise<void> {
  loadEnv();
  const rpcUrl = process.env.MAINNET_RPC_URL;
  if (!rpcUrl) throw new Error("MAINNET_RPC_URL required");
  const remote = new ethers.JsonRpcProvider(rpcUrl);

  const state = new AnvilStateBackend(rpcUrl, "http://127.0.0.1:8611", 8611);
  let t = performance.now();
  await state.start();
  console.log(`[stage-timing] anvil start: ${(performance.now() - t).toFixed(0)}ms`);

  try {
    t = performance.now();
    const latest = await remote.getBlockNumber();
    console.log(`[stage-timing] getBlockNumber (remote): ${(performance.now() - t).toFixed(0)}ms`);

    // ensureFreshFork "refresh" path — what fires every <=5 blocks (~60s mainnet)
    t = performance.now();
    await state.refreshFork(latest);
    console.log(`[stage-timing] refreshFork (anvil_reset + snapshot): ${(performance.now() - t).toFixed(0)}ms`);

    // Cold impersonate: fresh fork, anvil remote-state cache empty — the live
    // worst case right after a refresh.
    await impersonateSwap(state, "COLD fork");

    // ensureFreshFork "reset" path + warm cache: what a per-hint reset gives
    // when no refresh fired and slots were already fetched this fork.
    t = performance.now();
    await state.resetToBaseline();
    console.log(`\n[stage-timing] resetToBaseline: ${(performance.now() - t).toFixed(0)}ms`);
    await impersonateSwap(state, "WARM fork (post-reset, cached)");

    // prepareForkExecutor
    t = performance.now();
    const code = await state.provider.getCode(BOTVM);
    await state.provider.send("anvil_setBalance", [ethers.getAddress(WHALE), FORK_ETH_BALANCE]);
    await state.provider.send("anvil_impersonateAccount", [ethers.getAddress(WHALE)]);
    console.log(`\n[stage-timing] prepareForkExecutor (getCode ${code === "0x" ? "EMPTY" : "ok"} + fund): ${(performance.now() - t).toFixed(0)}ms`);
  } finally {
    state.stop();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack : String(err));
  process.exit(1);
});
