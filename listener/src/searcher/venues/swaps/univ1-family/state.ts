import type { AdapterRequestResult, CanonicalSource } from "../../adapter-request-program.js";
import { BALANCE, call, checked, MAX_VALUE, MODEL, STANDARD_MODEL, MULTICALL, returned, TOKEN, uint, validateResults, type Model } from "./codec.js";
import type { Descriptor, State } from "./types.js";
export function stateRequests(d: Descriptor) {
  return [call("native-reserve", MULTICALL, BALANCE.encodeFunctionData("getEthBalance", [d.pool])),
    call("token-reserve", d.token, TOKEN.encodeFunctionData("balanceOf", [d.pool]))];
}
export function decodeState(results: readonly AdapterRequestResult[], expected?: CanonicalSource): State {
  const source = validateResults(results, ["native-reserve", "token-reserve"], expected);
  return Object.freeze({ source, nativeReserve: uint(returned(results, "native-reserve")), tokenReserve: uint(returned(results, "token-reserve")) });
}
export function quoteAmount(s: State, buy: boolean, amountIn: bigint, model: Model = MODEL): bigint {
  if (model !== MODEL && model !== STANDARD_MODEL) throw new Error("univ1 unsupported quote model");
  checked(amountIn);
  if (amountIn === 0n) return 0n;
  if (buy && amountIn > MAX_VALUE) throw new Error("univ1 native input exceeds executor uint96");
  checked(s.nativeReserve); checked(s.tokenReserve);
  if (s.nativeReserve === 0n || s.tokenReserve === 0n) throw new Error("univ1 empty reserves");
  const fee = model === MODEL ? checked(amountIn + 999n) / 1000n : 0n;
  const sold = checked(amountIn - fee);
  // Anyswap ethToTokenInput executes after msg.value arrives and subtracts sold (not
  // msg.value) from self.balance before sending the issuer fee. Consequently
  // the pricing denominator includes that fee. The public view omits both
  // this reserve adjustment and the issuer fee, so it is NOT an exact quote.
  // Standard V1 has no issuer fee and subtracts the entire msg.value.
  if (buy) checked(s.nativeReserve + amountIn);
  const reserveIn = buy ? checked(s.nativeReserve + fee) : s.tokenReserve;
  const reserveOut = buy ? s.tokenReserve : s.nativeReserve;
  const adjusted = checked(sold * 997n);
  const numerator = checked(adjusted * reserveOut);
  const denominator = checked(checked(reserveIn * 1000n) + adjusted);
  const out = numerator / denominator;
  if (!buy && out > MAX_VALUE) throw new Error("univ1 native output exceeds executor uint96");
  return out;
}

/** Reserve transition for the verified model. Only the Anyswap variant pays
 * ceil(input / 1000) to its issuer; standard V1 retains the full input.
 * Neither model describes unknown token-transfer side effects. */
export function quoteTransition(s: State, buy: boolean, amountIn: bigint, model: Model = MODEL): { readonly amountOut: bigint; readonly state: State } {
  const amountOut = quoteAmount(s, buy, amountIn, model);
  const received = checked(amountIn - (model === MODEL ? checked(amountIn + 999n) / 1000n : 0n));
  const state = Object.freeze({
    source: s.source,
    nativeReserve: checked(s.nativeReserve + (buy ? received : -amountOut)),
    tokenReserve: checked(s.tokenReserve + (buy ? -amountOut : received)),
  });
  return Object.freeze({ amountOut, state });
}
