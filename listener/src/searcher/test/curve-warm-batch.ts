import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ethers } from "ethers";
import { ADDR } from "../../shared/constants/addresses.js";
import type { StateBackend } from "../../shared/state/state-backend.js";
import { PoolStateCache, type CurveSnapshot } from "../solver/pool-state-cache.js";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`FAIL: ${msg}`);
}

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
    /* no .env - rely on ambient env */
  }
}

const curveIface = new ethers.Interface(["function coins(uint256) view returns (address)"]);
const erc20Iface = new ethers.Interface(["function decimals() view returns (uint8)"]);

interface CaseDef {
  name: string;
  pool: string;
}

const CASES: CaseDef[] = [
  { name: "3pool plain", pool: ADDR.CURVE_3POOL },
  { name: "sUSDS/USDT ng", pool: ADDR.CURVE_SUSDS_USDT },
  { name: "DOLA/sUSDS ng", pool: ADDR.CURVE_DOLA_SUSDS },
];

function fixedBlockState(provider: ethers.JsonRpcProvider, block: number): StateBackend {
  return {
    async call(req: { to: string; data: string; from?: string }): Promise<string> {
      return provider.call({ to: req.to, data: req.data, from: req.from, blockTag: block });
    },
  } as unknown as StateBackend;
}

function noState(): StateBackend {
  return {
    async call(): Promise<string> {
      throw new Error("state.call should not be reached after curve cache warm");
    },
  } as unknown as StateBackend;
}

async function readCoin(
  provider: ethers.JsonRpcProvider,
  pool: string,
  index: number,
  block: number,
): Promise<string> {
  const res = await provider.call({
    to: pool,
    data: curveIface.encodeFunctionData("coins", [index]),
    blockTag: block,
  });
  return ethers.getAddress("0x" + res.slice(-40)).toLowerCase();
}

async function sampleAmount(
  provider: ethers.JsonRpcProvider,
  token: string,
  block: number,
): Promise<bigint> {
  const res = await provider.call({
    to: token,
    data: erc20Iface.encodeFunctionData("decimals"),
    blockTag: block,
  });
  const decimals = Number(BigInt(res));
  return 10n ** BigInt(decimals);
}

async function runCase(
  provider: ethers.JsonRpcProvider,
  state: StateBackend,
  block: number,
  c: CaseDef,
): Promise<void> {
  const tokenIn = await readCoin(provider, c.pool, 0, block);
  const tokenOut = await readCoin(provider, c.pool, 1, block);
  const amountIn = await sampleAmount(provider, tokenIn, block);

  const perPool = new PoolStateCache(provider);
  perPool.setTickBlock(block);
  await perPool.quoteCurve(state, c.pool, tokenIn, tokenOut, amountIn);
  const perPoolSnap = perPool.snapshotCurve(c.pool, block);
  if (!perPoolSnap) throw new Error(`FAIL: ${c.name}: per-pool warm snapshot missing`);

  const batch = new PoolStateCache(provider);
  batch.setTickBlock(block);
  await batch.warmCurvesBatch(state, [c.pool]);
  const batchSnap = batch.snapshotCurve(c.pool, block);
  if (!batchSnap) throw new Error(`FAIL: ${c.name}: batch warm snapshot missing`);

  assertSameSnapshot(c.name, perPoolSnap, batchSnap);

  const quoteState = noState();
  const perPoolOut = await perPool.quoteCurve(quoteState, c.pool, tokenIn, tokenOut, amountIn);
  const batchOut = await batch.quoteCurve(quoteState, c.pool, tokenIn, tokenOut, amountIn);
  assert(
    perPoolOut === batchOut,
    `${c.name}: cached quote mismatch perPool=${perPoolOut} batch=${batchOut}`,
  );
  assert(batchOut > 0n, `${c.name}: cached quote should be positive`);
  console.log(
    `[curve-warm-batch] ${c.name} PASS kind=${batchSnap.kind} coins=${batchSnap.coins.length} ` +
      `quote=${batchOut}`,
  );
}

function assertSameSnapshot(name: string, a: CurveSnapshot, b: CurveSnapshot): void {
  assert(a.kind === b.kind, `${name}: kind mismatch ${a.kind} vs ${b.kind}`);
  assert(a.blockNumber === b.blockNumber, `${name}: block mismatch ${a.blockNumber} vs ${b.blockNumber}`);
  assertStringsEqual(a.coins, b.coins, `${name}: coins`);
  if (a.kind === "plain") {
    const plainA = a.plain;
    const plainB = b.plain;
    if (!plainA || !plainB) throw new Error(`FAIL: ${name}: missing plain state`);
    assert(plainA.A === plainB.A, `${name}: A mismatch`);
    assert(plainA.fee === plainB.fee, `${name}: fee mismatch`);
    assertBigintsEqual(plainA.balances, plainB.balances, `${name}: balances`);
    assertBigintsEqual(plainA.rates, plainB.rates, `${name}: rates`);
    return;
  }
  const ngA = a.ng;
  const ngB = b.ng;
  if (!ngA || !ngB) throw new Error(`FAIL: ${name}: missing ng state`);
  assert(ngA.A === ngB.A, `${name}: A mismatch`);
  assert(ngA.fee === ngB.fee, `${name}: fee mismatch`);
  assert(
    ngA.offpegFeeMultiplier === ngB.offpegFeeMultiplier,
    `${name}: offpeg mismatch ${ngA.offpegFeeMultiplier} vs ${ngB.offpegFeeMultiplier}`,
  );
  assertBigintsEqual(ngA.balances, ngB.balances, `${name}: balances`);
  assertBigintsEqual(ngA.rates, ngB.rates, `${name}: rates`);
}

function assertStringsEqual(a: string[], b: string[], label: string): void {
  assert(a.length === b.length, `${label}: length mismatch ${a.length} vs ${b.length}`);
  for (let i = 0; i < a.length; i++) {
    assert(a[i] === b[i], `${label}[${i}] mismatch ${a[i]} vs ${b[i]}`);
  }
}

function assertBigintsEqual(a: bigint[], b: bigint[], label: string): void {
  assert(a.length === b.length, `${label}: length mismatch ${a.length} vs ${b.length}`);
  for (let i = 0; i < a.length; i++) {
    assert(a[i] === b[i], `${label}[${i}] mismatch ${a[i]} vs ${b[i]}`);
  }
}

async function main(): Promise<void> {
  loadEnv();
  const rpc = process.env.MAINNET_RPC_URL;
  if (!rpc) throw new Error("MAINNET_RPC_URL required");
  const provider = new ethers.JsonRpcProvider(rpc);
  try {
    const block = await provider.getBlockNumber();
    const state = fixedBlockState(provider, block);
    console.log(`[curve-warm-batch] pinned block ${block}`);
    for (const c of CASES) {
      await runCase(provider, state, block, c);
    }
    console.log(`curve-warm-batch PASS (${CASES.length}/${CASES.length})`);
  } finally {
    provider.destroy();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
