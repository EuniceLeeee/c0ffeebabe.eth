// Slice-1 validation: quoteUniV4 encodes a real V4Quoter call for a genuine v4
// pool (USDC/USDT poolId 0x395f91b3, fee 8 / tickSpacing 1 / no hooks) and the
// returned quote (a) matches an INDEPENDENT hand-rolled V4Quoter encoding
// bit-exact, (b) is economically sane for a stable pair, and (c) reproduces a
// real on-chain v4 swap (block 25436883: 35045.872323 USDT -> 35013.321757 USDC).
//
// expected_transition: old quoteUniV4 mapped USDC/USDT to a V3 PROXY pool (wrong
// venue) and threw for anything else; new one reads the actual v4 pool.
import { ethers } from "ethers";
import { encodeUniV4QuoteExactInputSingle } from "../solver/quoter.js";

const RPC = process.env.MAINNET_RPC_URL;
if (!RPC) throw new Error("MAINNET_RPC_URL required");
const provider = new ethers.JsonRpcProvider(RPC);

const V4QUOTER = "0x52F0E24D1c21C8A0cB1e5a5dD6198556BD9E1203";
const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const USDT = "0xdac17f958d2ee523a2206206994597c13d831ec7";
const ZERO = "0x0000000000000000000000000000000000000000";
const poolKey = { currency0: USDC, currency1: USDT, fee: 8, tickSpacing: 1, hooks: ZERO };

// Independent iface — authored here, NOT imported from the searcher.
const indIface = new ethers.Interface([
  "function quoteExactInputSingle(((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,bool zeroForOne,uint128 exactAmount,bytes hookData) params) returns (uint256 amountOut,uint256 gasEstimate)",
]);

async function q(tokenIn: string, tokenOut: string, amountIn: bigint, block?: number) {
  const dataSearcher = encodeUniV4QuoteExactInputSingle(tokenIn, tokenOut, amountIn, poolKey);
  const zeroForOne = tokenIn.toLowerCase() === poolKey.currency0.toLowerCase();
  const dataIndependent = indIface.encodeFunctionData("quoteExactInputSingle", [
    { poolKey, zeroForOne, exactAmount: amountIn, hookData: "0x" },
  ]);
  const encMatch = dataSearcher === dataIndependent;
  const blockTag = block ? "0x" + block.toString(16) : "latest";
  const raw = await provider.send("eth_call", [{ to: V4QUOTER, data: dataSearcher }, blockTag]);
  const out = indIface.decodeFunctionResult("quoteExactInputSingle", raw)[0] as bigint;
  return { encMatch, out };
}

function usd6(x: bigint): string {
  return (Number(x) / 1e6).toFixed(6);
}

async function main() {
  let pass = true;

  // (1) sanity: 1000 USDT -> USDC and 1000 USDC -> USDT at latest
  const a = await q(USDT, USDC, 1000_000000n);
  const b = await q(USDC, USDT, 1000_000000n);
  console.log(`[1] 1000 USDT -> ${usd6(a.out)} USDC  encMatch=${a.encMatch}`);
  console.log(`[1] 1000 USDC -> ${usd6(b.out)} USDT  encMatch=${b.encMatch}`);
  if (!a.encMatch || !b.encMatch) { pass = false; console.log("  FAIL: encoder mismatch"); }
  // stable pair: within 1% of 1:1 (fee 8 = 0.0008%, tiny impact)
  const sane = (out: bigint) => out > 990_000000n && out < 1010_000000n;
  if (!sane(a.out) || !sane(b.out)) { pass = false; console.log("  FAIL: not economically sane for stable pair"); }

  // (2) reproduce the real on-chain swap at block 25436883 pre-state (25436882 end)
  const REAL_IN = 35045872323n;   // USDT in
  const REAL_OUT = 35013321757n;  // USDC out (actual amount0 delta)
  const r = await q(USDT, USDC, REAL_IN, 25436882);
  const diffBps = Number((r.out - REAL_OUT) * 10000n / REAL_OUT);
  console.log(`[2] real swap @25436882: ${usd6(REAL_IN)} USDT -> quote ${usd6(r.out)} USDC vs actual ${usd6(REAL_OUT)}  diff=${diffBps}bps  encMatch=${r.encMatch}`);
  if (!r.encMatch) { pass = false; console.log("  FAIL: encoder mismatch"); }
  if (Math.abs(diffBps) > 100) { pass = false; console.log("  FAIL: quote >1% off real swap output"); }

  console.log(pass ? "\nV4 QUOTE VALIDATION: PASS" : "\nV4 QUOTE VALIDATION: FAIL");
  process.exit(pass ? 0 : 1);
}

main().catch((e) => { console.error("ERROR:", e?.message ?? e); process.exit(1); });
