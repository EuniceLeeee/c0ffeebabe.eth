// Quote-fidelity harness for the V4Quoter path (quoteUniV4 / encodeUniV4QuoteExactInputSingle).
//
// (A) FIDELITY: our quoter's encoding matches an independent encoding bit-exact, is economically
//     sane, and reproduces a real on-chain v4 swap (USDC/USDT fee-8 pool, block 25436882 pre-state).
// (B) DIVERGENCE DETECTION (F-014): the harness also PROBES pools where our V4Quoter diverges from
//     the real core swap. For 0xf391d0's entry pool 0xc069abea (USDC/srUSDe fee 100) at the
//     execution state, quoteExactInputSingle reverts NotEnoughLiquidity for USDC->srUSDe at every
//     size while the reverse quotes fine and the real swap filled 949.49 USDC. This case PINS that
//     one-sided-liquidity divergence: if the forward direction ever stops reverting, F-014 is fixed
//     — update the expectation (see decision-log F-014).
//
// expected_transition: old quoteUniV4 mapped USDC/USDT to a V3 PROXY pool (wrong venue) and threw
// for anything else; this harness reads the actual v4 pool AND classifies quote-vs-real divergence.
import { ethers } from "ethers";
import { encodeUniV4QuoteExactInputSingle } from "../venues/swaps/univ4.js";

const RPC = process.env.MAINNET_RPC_URL;
if (!RPC) throw new Error("MAINNET_RPC_URL required");
const provider = new ethers.JsonRpcProvider(RPC);

const V4QUOTER = "0x52F0E24D1c21C8A0cB1e5a5dD6198556BD9E1203";
const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const USDT = "0xdac17f958d2ee523a2206206994597c13d831ec7";
const SRUSDE = "0x3d7d6fdf07ee548b939a80edbc9b2256d0cdc003";
const ZERO = "0x0000000000000000000000000000000000000000";
// NotEnoughLiquidity(bytes32) — thrown by the v4 quoter, wrapped in WrappedError (0x6190b2b0).
const NOT_ENOUGH_LIQUIDITY = "7a5ed734";

interface V4PoolKey {
  currency0: string;
  currency1: string;
  fee: number;
  tickSpacing: number;
  hooks: string;
}
const poolUSDCUSDT8: V4PoolKey = { currency0: USDC, currency1: USDT, fee: 8, tickSpacing: 1, hooks: ZERO };
// c069abea… : currency0 = srUSDe (0x3d < 0xa0), currency1 = USDC, fee 100, tickSpacing 1, no hooks.
const poolSrUSDeUSDC: V4PoolKey = { currency0: SRUSDE, currency1: USDC, fee: 100, tickSpacing: 1, hooks: ZERO };

// Independent iface — authored here, NOT imported from the searcher.
const indIface = new ethers.Interface([
  "function quoteExactInputSingle(((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,bool zeroForOne,uint128 exactAmount,bytes hookData) params) returns (uint256 amountOut,uint256 gasEstimate)",
]);

type QuoteStatus = "ok" | "reverted";
interface QuoteResult {
  status: QuoteStatus;
  out?: bigint;
  encMatch: boolean;
  revert?: string; // wrapped custom-error selector (or message) when reverted
}

function extractRevertSelector(err: unknown): string {
  // ethers surfaces the raw revert data in a few places depending on the provider.
  const e = err as { data?: string; info?: { error?: { data?: string } }; message?: string };
  const data = e?.data ?? e?.info?.error?.data ?? "";
  const hex = typeof data === "string" ? data.toLowerCase().replace(/^0x/, "") : "";
  if (hex.includes(NOT_ENOUGH_LIQUIDITY)) return "NotEnoughLiquidity";
  if (hex.length >= 8) return "0x" + hex.slice(0, 8);
  return e?.message ?? "revert";
}

/** Quote via our encoding; classify a revert instead of throwing (the F-014 detection primitive). */
async function quoteAt(
  pk: V4PoolKey,
  tokenIn: string,
  tokenOut: string,
  amountIn: bigint,
  block?: number,
): Promise<QuoteResult> {
  const dataSearcher = encodeUniV4QuoteExactInputSingle(tokenIn, tokenOut, amountIn, pk);
  const zeroForOne = tokenIn.toLowerCase() === pk.currency0.toLowerCase();
  const dataIndependent = indIface.encodeFunctionData("quoteExactInputSingle", [
    { poolKey: pk, zeroForOne, exactAmount: amountIn, hookData: "0x" },
  ]);
  const encMatch = dataSearcher === dataIndependent;
  const blockTag = block ? "0x" + block.toString(16) : "latest";
  try {
    const raw = await provider.send("eth_call", [{ to: V4QUOTER, data: dataSearcher }, blockTag]);
    const out = indIface.decodeFunctionResult("quoteExactInputSingle", raw)[0] as bigint;
    return { status: "ok", out, encMatch };
  } catch (err) {
    return { status: "reverted", encMatch, revert: extractRevertSelector(err) };
  }
}

/** Reconcile a quote against a known real on-chain fill: ok within tolerance, diverged, or reverted. */
function fidelityVerdict(q: QuoteResult, realOut: bigint, tolBps: number): {
  verdict: "reproduced" | "diverged" | "reverted";
  diffBps?: number;
} {
  if (q.status === "reverted") return { verdict: "reverted" };
  const diffBps = Number(((q.out! - realOut) * 10000n) / realOut);
  return { verdict: Math.abs(diffBps) <= tolBps ? "reproduced" : "diverged", diffBps };
}

function usd6(x: bigint): string {
  return (Number(x) / 1e6).toFixed(6);
}

async function main() {
  let pass = true;
  const fail = (msg: string) => { pass = false; console.log(`  FAIL: ${msg}`); };

  // (A1) sanity: 1000 USDT <-> USDC at latest, encoder bit-exact + economically sane.
  const a = await quoteAt(poolUSDCUSDT8, USDT, USDC, 1000_000000n);
  const b = await quoteAt(poolUSDCUSDT8, USDC, USDT, 1000_000000n);
  console.log(`[A1] 1000 USDT -> ${a.status === "ok" ? usd6(a.out!) : a.revert} USDC  encMatch=${a.encMatch}`);
  console.log(`[A1] 1000 USDC -> ${b.status === "ok" ? usd6(b.out!) : b.revert} USDT  encMatch=${b.encMatch}`);
  if (!a.encMatch || !b.encMatch) fail("encoder mismatch");
  const sane = (r: QuoteResult) => r.status === "ok" && r.out! > 990_000000n && r.out! < 1010_000000n;
  if (!sane(a) || !sane(b)) fail("not economically sane for stable pair");

  // (A2) reproduce the real on-chain swap at block 25436883 pre-state (25436882 end): 35045.87 USDT -> USDC.
  const realFill = await quoteAt(poolUSDCUSDT8, USDT, USDC, 35045872323n, 25436882);
  const fillVerdict = fidelityVerdict(realFill, 35013321757n, 100);
  console.log(`[A2] real swap @25436882: 35045.87 USDT -> quote ${realFill.status === "ok" ? usd6(realFill.out!) : realFill.revert} USDC vs actual 35013.32  verdict=${fillVerdict.verdict} diff=${fillVerdict.diffBps ?? "-"}bps`);
  if (!realFill.encMatch) fail("encoder mismatch on real-swap case");
  if (fillVerdict.verdict !== "reproduced") fail(`quote did not reproduce the real swap (${fillVerdict.verdict})`);

  // (B) F-014 divergence detection: c069abea (USDC/srUSDe) at 0xf391d0's pre-competitor state (blk
  //     25462189). Forward USDC->srUSDe reverts NotEnoughLiquidity (our quoter's tick traversal sees no
  //     upward liquidity) while the real swap filled 949.49 USDC; reverse srUSDe->USDC quotes fine.
  const fwd = await quoteAt(poolSrUSDeUSDC, USDC, SRUSDE, 949488853n, 25462189);
  const rev = await quoteAt(poolSrUSDeUSDC, SRUSDE, USDC, 1_000000000000000000n, 25462189);
  console.log(`[B] c069abea @25462189 USDC->srUSDe: ${fwd.status}${fwd.revert ? " (" + fwd.revert + ")" : ""}`);
  console.log(`[B] c069abea @25462189 srUSDe->USDC: ${rev.status}${rev.status === "ok" ? " -> " + usd6(rev.out!) + " USDC" : ""}`);
  // Divergence is DETECTED when forward reverts NotEnoughLiquidity but reverse quotes fine — a
  // one-sided-liquidity quoter gap our loss-attribution must flag (NOT a pool/path gap). If the
  // forward direction ever stops reverting, F-014 is fixed: flip this expectation.
  const f014Detected = fwd.status === "reverted" && fwd.revert === "NotEnoughLiquidity" && rev.status === "ok";
  if (!f014Detected) {
    if (fwd.status === "ok") {
      console.log("  NOTE: c069abea forward now quotes — F-014 (v4 entry-leg quoter gap) appears FIXED; update this pin + decision-log F-014.");
    } else {
      fail(`F-014 divergence not detected as expected (fwd=${fwd.status}/${fwd.revert}, rev=${rev.status})`);
    }
  } else {
    console.log("  [B] F-014 quote-fidelity divergence DETECTED (forward NotEnoughLiquidity, reverse ok) — pinned.");
  }

  console.log(pass ? "\nV4 QUOTE FIDELITY: PASS" : "\nV4 QUOTE FIDELITY: FAIL");
  process.exit(pass ? 0 : 1);
}

main().catch((e) => { console.error("ERROR:", e?.message ?? e); process.exit(1); });
