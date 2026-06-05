/**
 * Step 2 Critical Gate: Byte-for-byte equivalence test.
 *
 * Builds the wstUSR ResolvedPlanNode tree with known parameters,
 * compiles via TS compiler, and compares raw script bytes against
 * the reference output from Solidity BotVMScriptBuilder.
 *
 * Run: npx tsx src/test-equivalence.ts
 */

import "../src/adapters/index.js"; // register all adapters
import { compilePlan } from "./compiler.js";
import { bytesToHex } from "./encoder.js";
import type { ResolvedPlanNode } from "./types.js";
import { readFileSync } from "fs";

// ─── Known Parameters (from Solidity reference run) ────────────

const EXECUTOR = "0x5aAdFB43eF8dAF45DD80F4676345b7676f1D70e3";

const WSTUSER = "0x1202F5C7b4B9E47a1A484E8B270be34dbbC75055";
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const DAI = "0x6B175474E89094C44Da98b954EedeAC495271d0F";
const USDT = "0xdAC17F958D2ee523a2206206994597C13D831ec7";
const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const DOLA = "0x865377367054516e17014CcdED1e7d814EDC9ce4";

const MORPHO = "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb";
const FLUID_VAULT = "0xee327311D8640156E87eC33ea55FcbF2309e0ce6";
const PSM = "0xf6e72Db5454dd049d0788e411b06CfAF16853042";
const V4_PM = "0x000000000004444c5dc75cB358380D2e3dE08A90";
const V3_POOL = "0xc7bBeC68d12a0d1830360F8Ec58fA599bA1b0e9b";
const CURVE_SUSDS_USDT = "0x00836Fe54625BE242BcFA286207795405ca4fD10"; // already correct
const CURVE_DOLA_SUSDS = "0x8b83c4aA949254895507D09365229BC3a8c7f710";
const CURVE_DOLA_WSTUSR = "0x64273624eb57c5cA961d366CBF3968e760Bf0452";

const flashAmount = 3533486761808775726594n;
const half = 1766743380904387863297n;
const otherHalf = flashAmount - half;
const debtAmount1 = 1839929197n;
const debtAmount2 = 1839929197n;
const totalUsdc = debtAmount1 + debtAmount2;
const daiAmount = 3679858394000000000000n;
const v4TakeAmount = 3679935364n;
const v3ExactOutput = 3513427987n;
const usdtReceived = 3513427987n;
const susdsOut = 3221098469352203668493n;
const dolaAmount = 3537263165811565906992n;
const wethOwed = 1658326072155662131n;
const minProfit = 50000000000000000000n;

const MIN_SQRT_PRICE = 4295128740n;
const MAX_SQRT_PRICE = 1461446703485210103287273052203988822378723970341n;

// ─── Build the Plan Tree ───────────────────────────────────────

// V3 Phase 1 sub-script: pay USDT to V3 pool
const v3Phase1Sub: ResolvedPlanNode = {
  adapterId: "erc20-transfer",
  target: USDT, tokenIn: USDT, tokenOut: USDT,
  amount: v4TakeAmount,
  params: { to: V3_POOL, amount: v4TakeAmount },
  children: [],
};

// Curve chain (V3 phase 2 callback)
const curveChain: ResolvedPlanNode[] = [
  // 1. Transfer USDT to Curve sUSDS/USDT pool
  {
    adapterId: "erc20-transfer",
    target: USDT, tokenIn: USDT, tokenOut: USDT,
    amount: usdtReceived,
    params: { to: CURVE_SUSDS_USDT, amount: usdtReceived },
    children: [],
  },
  // 2. USDT → sUSDS
  {
    adapterId: "curve-exchange",
    target: CURVE_SUSDS_USDT, tokenIn: USDT, tokenOut: "",
    amount: usdtReceived,
    params: { i: 1n, j: 0n, minDy: 0n, receiver: CURVE_DOLA_SUSDS },
    children: [],
  },
  // 3. sUSDS → DOLA
  {
    adapterId: "curve-exchange",
    target: CURVE_DOLA_SUSDS, tokenIn: "", tokenOut: DOLA,
    amount: susdsOut,
    params: { i: 1n, j: 0n, minDy: 0n, receiver: EXECUTOR },
    children: [],
  },
  // 4. Transfer DOLA to Curve DOLA/wstUSR pool
  {
    adapterId: "erc20-transfer",
    target: DOLA, tokenIn: DOLA, tokenOut: DOLA,
    amount: dolaAmount,
    params: { to: CURVE_DOLA_WSTUSR, amount: dolaAmount },
    children: [],
  },
  // 5. DOLA → wstUSR (no receiver variant)
  {
    adapterId: "curve-exchange-nr",
    target: CURVE_DOLA_WSTUSR, tokenIn: DOLA, tokenOut: WSTUSER,
    amount: dolaAmount,
    params: { i: 0n, j: 1n, minDy: 0n },
    children: [],
  },
  // 6. Pay WETH to V3 pool
  {
    adapterId: "erc20-transfer",
    target: WETH, tokenIn: WETH, tokenOut: WETH,
    amount: wethOwed,
    params: { to: V3_POOL, amount: wethOwed },
    children: [],
  },
];

// V3 swap inside V4 (USDT→WETH, exactInput)
const v3InsideV4: ResolvedPlanNode = {
  adapterId: "univ3-swap",
  target: V3_POOL, tokenIn: USDT, tokenOut: WETH,
  amount: v4TakeAmount,
  params: {
    zeroForOne: false,
    amountSpecified: BigInt(v4TakeAmount),
    sqrtPriceLimit: MAX_SQRT_PRICE,
  },
  children: [v3Phase1Sub],
};

// V4 sub-script
const v4Children: ResolvedPlanNode[] = [
  // 1. V4 swap: DAI→USDT
  {
    adapterId: "univ4-swap",
    target: V4_PM, tokenIn: DAI, tokenOut: USDT,
    amount: daiAmount,
    params: {
      currency0: DAI,
      currency1: USDT,
      fee: 68n,
      tickSpacing: 1n,
      hooks: "0x0000000000000000000000000000000000000000",
      zeroForOne: true,
      amountSpecified: -daiAmount,
      sqrtPriceLimit: MIN_SQRT_PRICE,
    },
    children: [],
  },
  // 2. V4 take USDT
  {
    adapterId: "univ4-take",
    target: V4_PM, tokenIn: "", tokenOut: USDT,
    amount: v4TakeAmount,
    params: {},
    children: [],
  },
  // 3. V3 swap (USDT→WETH) inside V4
  v3InsideV4,
  // 4. V4 sync DAI
  {
    adapterId: "univ4-sync",
    target: V4_PM, tokenIn: DAI, tokenOut: "",
    amount: 0n,
    params: {},
    children: [],
  },
  // 5. Transfer DAI to V4 PM
  {
    adapterId: "erc20-transfer",
    target: DAI, tokenIn: DAI, tokenOut: DAI,
    amount: daiAmount,
    params: { to: V4_PM, amount: daiAmount },
    children: [],
  },
  // 6. V4 settle
  {
    adapterId: "univ4-settle",
    target: V4_PM, tokenIn: "", tokenOut: "",
    amount: 0n,
    params: {},
    children: [],
  },
];

// V4 unlock wrapper
const v4Unlock: ResolvedPlanNode = {
  adapterId: "univ4-unlock",
  target: V4_PM, tokenIn: DAI, tokenOut: USDT,
  amount: 0n,
  params: {},
  children: v4Children,
};

// V3 swap (WETH→USDT, exactOutput) — outside V4, inside Morpho callback
const v3Phase2: ResolvedPlanNode = {
  adapterId: "univ3-swap",
  target: V3_POOL, tokenIn: WETH, tokenOut: USDT,
  amount: v3ExactOutput,
  params: {
    zeroForOne: true,
    amountSpecified: -BigInt(v3ExactOutput),
    sqrtPriceLimit: MIN_SQRT_PRICE,
  },
  children: curveChain,
};

// Morpho callback children
const morphoChildren: ResolvedPlanNode[] = [
  // 1. Approve wstUSR for Fluid
  {
    adapterId: "erc20-approve",
    target: WSTUSER, tokenIn: WSTUSER, tokenOut: WSTUSER,
    amount: flashAmount,
    params: { spender: FLUID_VAULT, amount: flashAmount },
    children: [],
  },
  // 2. Approve USDC for PSM
  {
    adapterId: "erc20-approve",
    target: USDC, tokenIn: USDC, tokenOut: USDC,
    amount: BigInt("0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"),
    params: { spender: PSM, amount: BigInt("0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff") },
    children: [],
  },
  // 3. Fluid position #1
  {
    adapterId: "fluid-vault",
    target: FLUID_VAULT, tokenIn: WSTUSER, tokenOut: USDC,
    amount: half,
    params: { nftId: 0n, collateralDelta: half, debtDelta: debtAmount1 },
    children: [],
  },
  // 4. Fluid position #2
  {
    adapterId: "fluid-vault",
    target: FLUID_VAULT, tokenIn: WSTUSER, tokenOut: USDC,
    amount: otherHalf,
    params: { nftId: 0n, collateralDelta: otherHalf, debtDelta: debtAmount2 },
    children: [],
  },
  // 5. PSM sellGem
  {
    adapterId: "psm",
    target: PSM, tokenIn: USDC, tokenOut: DAI,
    amount: totalUsdc,
    params: {},
    children: [],
  },
  // 6. V4 unlock
  v4Unlock,
  // 7. V3 swap phase 2
  v3Phase2,
  // 8. Assert balance (pre-repay guard)
  {
    adapterId: "assert-balance",
    target: WSTUSER, tokenIn: WSTUSER, tokenOut: WSTUSER,
    amount: flashAmount + minProfit,
    params: {},
    children: [],
  },
  // 9. Approve Morpho for repay
  {
    adapterId: "erc20-approve",
    target: WSTUSER, tokenIn: WSTUSER, tokenOut: WSTUSER,
    amount: flashAmount,
    params: { spender: MORPHO, amount: flashAmount },
    children: [],
  },
];

// Root: Morpho flash loan
const root: ResolvedPlanNode = {
  adapterId: "morpho-flash",
  target: MORPHO, tokenIn: WSTUSER, tokenOut: WSTUSER,
  amount: flashAmount,
  params: {},
  children: morphoChildren,
};

// ─── Compile and Compare ───────────────────────────────────────

const compiled = compilePlan(root, EXECUTOR);
const compiledHex = bytesToHex(compiled);

// Load reference from file
const refCalldata = readFileSync("/tmp/ref_clean.txt", "utf8").trim();
// Extract raw script: skip selector(4) + offset(32) + length(32) = 68 bytes = 136 hex chars after 0x
const refScriptHex = "0x" + refCalldata.slice(2 + 8 + 64 + 64, 2 + 8 + 64 + 64 + 3105 * 2);

console.log("Compiled length:", compiled.length, "bytes");
console.log("Reference length:", (refScriptHex.length - 2) / 2, "bytes");

if (compiledHex === refScriptHex.toLowerCase()) {
  console.log("\n=== BYTE-FOR-BYTE MATCH ===");
  console.log("TS compiler output matches Solidity BotVMScriptBuilder.");
} else {
  console.log("\n=== MISMATCH ===");
  // Find first difference
  const a = compiledHex.slice(2);
  const b = refScriptHex.slice(2).toLowerCase();
  const minLen = Math.min(a.length, b.length);
  for (let i = 0; i < minLen; i += 2) {
    if (a.slice(i, i + 2) !== b.slice(i, i + 2)) {
      console.log(`First diff at byte ${i / 2}:`);
      console.log(`  compiled: ...${a.slice(Math.max(0, i - 20), i + 20)}...`);
      console.log(`  reference: ...${b.slice(Math.max(0, i - 20), i + 20)}...`);
      break;
    }
  }
  if (a.length !== b.length) {
    console.log(`Length diff: compiled=${a.length / 2} ref=${b.length / 2}`);
  }
}
