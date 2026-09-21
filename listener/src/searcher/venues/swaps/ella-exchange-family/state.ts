import type { AdapterRequest, AdapterRequestResult } from "../../adapter-request-program.js";
import { BALANCE, FEES, MAX_UINT, MULTICALL, ORACLE, POOL, TOKEN, UNIT, address, call, mul, resultSource, returned, same, storage, uint } from "./codec.js";
import type { EllaDescriptor, EllaDirection, EllaState } from "./types.js";

// One amount-independent program, shared by raw pricing and Exact (therefore
// effective and Solver). Source-pinned transport memoization owns all reuse.
export function stateRequests(d: EllaDescriptor): readonly AdapterRequest[] {
  return [call("price", d.pool, POOL.encodeFunctionData("tokenPrice")),
    call("fee", d.factory, FEES.encodeFunctionData("getFees")),
    call("cut", d.factory, FEES.encodeFunctionData("getSystemCut")),
    call("fees-address", d.factory, FEES.encodeFunctionData("getFeesAddress")),
    call("token-balance", d.token, TOKEN.encodeFunctionData("balanceOf", [d.pool])),
    call("native-balance", MULTICALL, BALANCE.encodeFunctionData("getEthBalance", [d.pool])),
    storage("base-fees-generated", d.pool, 11), storage("fees-generated", d.pool, 12),
    storage("current-oracle", d.pool, 15),
    call("current-aggregator", d.oracle, ORACLE.encodeFunctionData("aggregator"))];
}
export function decodeState(d: EllaDescriptor, results: readonly AdapterRequestResult[]): EllaState {
  const source = resultSource(results);
  const ids = stateRequests(d).map(r => r.id);
  if (results.length !== ids.length || results.some(r => !ids.includes(r.id))) throw new Error("ella unexpected state results");
  const read = (id: string) => uint(returned(results, id).data);
  if (!same(address(returned(results, "current-oracle").data), d.oracle) ||
      !same(address(returned(results, "current-aggregator").data), d.aggregator)) {
    throw new Error("ella changed oracle binding requires instance revalidation");
  }
  const price = read("price"), fee = read("fee"), systemCut = read("cut");
  if (price <= 0n || fee >= UNIT || systemCut > UNIT) throw new Error("ella unusable current oracle/fee state");
  return { source, price, fee, systemCut, feesAddress: address(returned(results, "fees-address").data),
    tokenBalance: read("token-balance"), nativeBalance: read("native-balance"),
    baseFeesGenerated: read("base-fees-generated"), feesGenerated: read("fees-generated") };
}
export function quoteAmount(state: EllaState, direction: EllaDirection, amountIn: bigint) {
  if (typeof amountIn !== "bigint" || amountIn < 0n || amountIn > MAX_UINT) throw new Error("ella invalid amountIn");
  if (amountIn === 0n) return { amountOut: 0n, grossOut: 0n, fee: 0n, systemFee: 0n };
  if (state.price <= 0n || state.fee < 0n || state.fee >= UNIT || state.systemCut < 0n || state.systemCut > UNIT) throw new Error("ella invalid quote state");
  // Preserve both SafeDecimalMath operations, including the intermediate
  // overflow checks even where the second *UNIT/UNIT is algebraically redundant.
  const due = direction === "buy-token" ? mul(amountIn, UNIT) / state.price : mul(state.price, amountIn) / UNIT;
  const grossOut = mul(due, UNIT) / UNIT;
  const fee = mul(state.fee, grossOut) / UNIT, systemFee = mul(state.systemCut, fee) / UNIT;
  const feesGenerated = direction === "buy-token" ? state.feesGenerated : state.baseFeesGenerated;
  const balance = direction === "buy-token" ? state.tokenBalance : state.nativeBalance;
  const unavailableReason = grossOut > balance ? "gross-output-exceeds-inventory" :
    feesGenerated + fee - systemFee > MAX_UINT ? "fee-counter-overflow" :
    grossOut - fee <= 0n ? "zero-output" : undefined;
  return { amountOut: unavailableReason ? 0n : grossOut - fee, grossOut, fee, systemFee,
    ...(unavailableReason ? { unavailableReason } : {}) };
}
