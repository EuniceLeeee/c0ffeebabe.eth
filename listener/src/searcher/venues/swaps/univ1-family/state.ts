import type { AdapterRequestResult, CanonicalSource } from "../../adapter-request-program.js";
import { BALANCE, call, checked, MAX_VALUE, MULTICALL, returned, TOKEN, uint, validateResults } from "./codec.js";
import type { Descriptor, State } from "./types.js";
export function stateRequests(d: Descriptor) {
  return [call("native-reserve", MULTICALL, BALANCE.encodeFunctionData("getEthBalance", [d.pool])),
    call("token-reserve", d.token, TOKEN.encodeFunctionData("balanceOf", [d.pool]))];
}
export function decodeState(results: readonly AdapterRequestResult[], expected?: CanonicalSource): State {
  const source = validateResults(results, ["native-reserve", "token-reserve"], expected);
  return Object.freeze({ source, nativeReserve: uint(returned(results, "native-reserve")), tokenReserve: uint(returned(results, "token-reserve")) });
}
export function quoteAmount(s: State, buy: boolean, amountIn: bigint): bigint {
  checked(amountIn);
  if (amountIn === 0n) return 0n;
  if (buy && amountIn > MAX_VALUE) throw new Error("univ1 native input exceeds executor uint96");
  checked(s.nativeReserve); checked(s.tokenReserve);
  if (s.nativeReserve === 0n || s.tokenReserve === 0n) throw new Error("univ1 empty reserves");
  const fee = checked(amountIn + 999n) / 1000n;
  const sold = checked(amountIn - fee);
  // ethToTokenInput executes after msg.value arrives and subtracts sold (not
  // msg.value) from self.balance before sending the issuer fee. Consequently
  // the pricing denominator includes that fee. The public view omits both
  // this reserve adjustment and the issuer fee, so it is NOT an exact quote.
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
