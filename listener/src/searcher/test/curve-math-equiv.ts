/**
 * Curve local-math equivalence test (path B correctness gate).
 *
 * Warms 3pool state from mainnet at a pinned block, then asserts our local
 * curvePlainGetDy() equals the pool's on-chain get_dy() to within rounding —
 * for several (i, j, dx). If this passes, the off-chain math is a faithful
 * replacement for the per-quote eth_call. Read-only; no anvil.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ethers } from "ethers";
import {
  curvePlainGetDy,
  curveNgGetDy,
  type CurvePlainState,
  type CurveNgState,
} from "../solver/curve-math.js";

function loadEnv(): void {
  try {
    const text = readFileSync(resolve("..", ".env"), "utf8");
    for (const line of text.split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith("#") || !t.includes("=")) continue;
      const [rawKey, ...rest] = t.split("=");
      const key = rawKey.replace(/^export\s+/, "");
      if (!process.env[key]) process.env[key] = rest.join("=").replace(/^["']|["']$/g, "");
    }
  } catch {
    /* no .env — rely on ambient env */
  }
}

const CURVE_3POOL = "0xbEbc44782C7dB0a1A60Cb6fe97d0b483032FF1C7";
// 3pool RATES = PRECISION_MUL * 1e18 = [1, 1e12, 1e12] * 1e18 (DAI 18, USDC/USDT 6).
const RATES_3POOL = [10n ** 18n, 10n ** 30n, 10n ** 30n];

// stableswap-ng pools (2 coins each). rates come live from stored_rates().
const CURVE_SUSDS_USDT = "0x00836Fe54625BE242BcFA286207795405ca4fD10"; // [sUSDS, USDT]
const CURVE_DOLA_SUSDS = "0x8b83c4aA949254895507D09365229BC3a8c7f710"; // [USDS?, sUSDS]
const CURVE_DOLA_WSTUSR = "0x64273624eb57c5cA961d366CBF3968e760Bf0452"; // [USDS?, wstUSR]

const iface = new ethers.Interface([
  "function A() view returns (uint256)",
  "function fee() view returns (uint256)",
  "function offpeg_fee_multiplier() view returns (uint256)",
  "function balances(uint256) view returns (uint256)",
  "function stored_rates() view returns (uint256[])",
  "function get_dy(int128,int128,uint256) view returns (uint256)",
]);

async function call(
  provider: ethers.JsonRpcProvider,
  pool: string,
  data: string,
  blockTag: number,
): Promise<bigint> {
  const res = await provider.call({ to: pool, data, blockTag });
  return BigInt(res);
}

async function callRates(
  provider: ethers.JsonRpcProvider,
  pool: string,
  blockTag: number,
): Promise<bigint[]> {
  const res = await provider.call({
    to: pool,
    data: iface.encodeFunctionData("stored_rates"),
    blockTag,
  });
  return (iface.decodeFunctionResult("stored_rates", res)[0] as bigint[]).map((r) => BigInt(r));
}

let passCount = 0;
let total = 0;

async function check(
  provider: ethers.JsonRpcProvider,
  pool: string,
  local: bigint,
  i: number,
  j: number,
  dx: bigint,
  label: string,
  blockTag: number,
): Promise<void> {
  total++;
  const onchain = await call(provider, pool, iface.encodeFunctionData("get_dy", [i, j, dx]), blockTag);
  const diff = local > onchain ? local - onchain : onchain - local;
  const ok = diff <= 2n; // ≤2 wei rounding tolerance
  if (ok) passCount++;
  console.log(
    `[curvemath] ${ok ? "PASS" : "FAIL"} ${label}: local=${local} onchain=${onchain} diff=${diff}`,
  );
}

async function testNgPool(
  provider: ethers.JsonRpcProvider,
  pool: string,
  name: string,
  cases: Array<[number, number, bigint, string]>,
  block: number,
): Promise<void> {
  const A = await call(provider, pool, iface.encodeFunctionData("A"), block);
  const fee = await call(provider, pool, iface.encodeFunctionData("fee"), block);
  const offpegFeeMultiplier = await call(
    provider,
    pool,
    iface.encodeFunctionData("offpeg_fee_multiplier"),
    block,
  );
  const rates = await callRates(provider, pool, block);
  const balances: bigint[] = [];
  for (let k = 0; k < rates.length; k++) {
    balances.push(await call(provider, pool, iface.encodeFunctionData("balances", [k]), block));
  }
  const state: CurveNgState = { A, fee, offpegFeeMultiplier, balances, rates };
  console.log(
    `[curvemath] ${name}: A=${A} fee=${fee} offpeg=${offpegFeeMultiplier} rates=[${rates.join(", ")}]`,
  );
  for (const [i, j, dx, label] of cases) {
    await check(provider, pool, curveNgGetDy(state, i, j, dx), i, j, dx, `${name} ${label}`, block);
  }
}

async function main(): Promise<void> {
  loadEnv();
  const rpc = process.env.MAINNET_RPC_URL;
  if (!rpc) throw new Error("MAINNET_RPC_URL required");
  const provider = new ethers.JsonRpcProvider(rpc);
  const block = await provider.getBlockNumber();
  console.log(`[curvemath] pinned block ${block}`);

  // ── 3pool: old-style plain ──
  const A = await call(provider, CURVE_3POOL, iface.encodeFunctionData("A"), block);
  const fee = await call(provider, CURVE_3POOL, iface.encodeFunctionData("fee"), block);
  const balances: bigint[] = [];
  for (let k = 0; k < 3; k++) {
    balances.push(await call(provider, CURVE_3POOL, iface.encodeFunctionData("balances", [k]), block));
  }
  const state: CurvePlainState = { A, fee, balances, rates: RATES_3POOL };
  console.log(`[curvemath] 3pool: A=${A} fee=${fee} balances=[${balances.join(", ")}]`);
  const plainCases: Array<[number, number, bigint, string]> = [
    [1, 2, 10n ** 6n, "1 USDC→USDT"],
    [1, 2, 1_000_000n * 10n ** 6n, "1M USDC→USDT"],
    [0, 1, 10n ** 18n, "1 DAI→USDC"],
    [2, 0, 500_000n * 10n ** 6n, "500k USDT→DAI"],
    [0, 2, 123_456n * 10n ** 18n, "123456 DAI→USDT"],
  ];
  for (const [i, j, dx, label] of plainCases) {
    await check(provider, CURVE_3POOL, curvePlainGetDy(state, i, j, dx), i, j, dx, `3pool ${label}`, block);
  }

  // ── stableswap-ng pools (dynamic fee + stored_rates) ──
  await testNgPool(provider, CURVE_SUSDS_USDT, "sUSDS/USDT", [
    [1, 0, 1_000n * 10n ** 6n, "1k USDT→sUSDS"],
    [0, 1, 1_000n * 10n ** 18n, "1k sUSDS→USDT"],
    [1, 0, 250_000n * 10n ** 6n, "250k USDT→sUSDS"],
  ], block);
  await testNgPool(provider, CURVE_DOLA_SUSDS, "DOLA/sUSDS", [
    [0, 1, 1_000n * 10n ** 18n, "1k c0→sUSDS"],
    [1, 0, 1_000n * 10n ** 18n, "1k sUSDS→c0"],
    [0, 1, 200_000n * 10n ** 18n, "200k c0→sUSDS"],
  ], block);
  await testNgPool(provider, CURVE_DOLA_WSTUSR, "DOLA/wstUSR", [
    [0, 1, 1_000n * 10n ** 18n, "1k c0→wstUSR"],
    [1, 0, 1_000n * 10n ** 18n, "1k wstUSR→c0"],
    [0, 1, 500_000n * 10n ** 18n, "500k c0→wstUSR"],
  ], block);

  console.log(`[curvemath] ${passCount}/${total} equivalence checks passed`);
  if (passCount !== total) throw new Error("curve math mismatch — see FAIL rows above");
  console.log("curve-math PASS (plain + ng)");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
