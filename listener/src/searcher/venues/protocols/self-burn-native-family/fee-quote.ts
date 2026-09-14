import { ethers } from "ethers";
import type { AdapterRequestResult } from "../../adapter-request-program.js";
import { assertSameSource, callRequest, returnedResult } from "../standard-family/common.js";
import type { SelfBurnNativeFeeParameters } from "./types.js";

const GETTERS = ["wrapFeeParts", "wrapFeeRate", "wrapFeeMin", "wrapFeeMax"] as const;
const ABI = new ethers.Interface(GETTERS.map(name => `function ${name}() view returns (uint256)`));
const MAX = (1n << 256n) - 1n;

export function selfBurnFeeRequests(token: string, prefix: string) {
  return Object.freeze(GETTERS.map(name => callRequest(`${prefix}-${name}`, token, ABI.encodeFunctionData(name))));
}

export function decodeSelfBurnFees(results: readonly AdapterRequestResult[], prefix: string) {
  if (results.length !== GETTERS.length || GETTERS.some(name =>
    results.filter(result => result.id === `${prefix}-${name}`).length !== 1)) {
    throw new Error("self-burn native fee results are missing or ambiguous");
  }
  const returned = GETTERS.map(name => returnedResult(results, `${prefix}-${name}`));
  const source = assertSameSource(returned);
  const values = returned.map((result, i) => {
    if (!/^0x[0-9a-fA-F]{64}$/.test(result.data)) throw new Error("self-burn native malformed fee uint256");
    return BigInt(ABI.decodeFunctionResult(GETTERS[i], result.data)[0]);
  });
  return Object.freeze({ source, fees: Object.freeze({ parts: values[0], rate: values[1], min: values[2], max: values[3] }) });
}

// Source-faithful WrapFee._calcWrapFee: checked multiply before caps;
// min and max are mutually exclusive, zero rate bypasses both.
export function calculateSelfBurnFee(amount: bigint, fees: SelfBurnNativeFeeParameters): bigint {
  if (amount < 0n || amount > MAX) throw new Error("self-burn native amount outside uint256 range");
  if (fees.parts === 0n || fees.rate > fees.parts) throw new Error("self-burn native fee parts or rate are invalid");
  if (fees.rate === 0n) return 0n;
  const product = amount * fees.rate;
  if (product > MAX) throw new Error("self-burn native fee multiplication overflow");
  let fee = product / fees.parts;
  if (fee < fees.min) fee = fees.min;
  else if (fee > fees.max) fee = fees.max;
  return fee > amount ? amount : fee;
}
