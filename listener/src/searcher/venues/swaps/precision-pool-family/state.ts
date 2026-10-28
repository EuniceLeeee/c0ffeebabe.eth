import { ethers } from "ethers";
import type { AdapterRequestResult, CanonicalSource } from "../../adapter-request-program.js";
import { call, checked, code, MULTICALL, NATIVE, POOL, resultsSource, returned, TOKEN, uint } from "./codec.js";
import type { Descriptor, State } from "./types.js";
const GETTERS = ["reserve0", "reserve1", "totalSupply", "hookOwed0", "hookOwed1", "creatorOwed0", "creatorOwed1"];
export const STATE_IDS = ["pool-code", ...GETTERS, "balance0", "balance1"];
export function balanceRequest(id: string, token: string, account: string) {
  return token === ethers.ZeroAddress ? call(id, MULTICALL, NATIVE.encodeFunctionData("getEthBalance", [account]))
    : call(id, token, TOKEN.encodeFunctionData("balanceOf", [account]));
}
export function stateRequests(d: Descriptor) {
  return [code("pool-code", d.pool), ...GETTERS.map(k => call(k, d.pool, POOL.encodeFunctionData(k))),
    balanceRequest("balance0", d.token0, d.pool), balanceRequest("balance1", d.token1, d.pool)];
}
export function decodeState(d: Descriptor, results: readonly AdapterRequestResult[], expected?: CanonicalSource): State {
  const source = resultsSource(results, STATE_IDS, expected), read = (id: string) => uint(returned(results, id));
  if (ethers.keccak256(returned(results, "pool-code")) !== d.codeHash) throw new Error("precision-pool runtime changed; reattestation required");
  const reserve0 = checked(read("reserve0"), 1n << 128n), reserve1 = checked(read("reserve1"), 1n << 128n);
  const balance0 = read("balance0"), balance1 = read("balance1"), supply = read("totalSupply");
  if (d.hook !== ethers.ZeroAddress || d.creatorFeeBps !== 0n ||
      ["hookOwed0", "hookOwed1", "creatorOwed0", "creatorOwed1"].some(k => read(k) !== 0n) ||
      balance0 < reserve0 || balance1 < reserve1) throw new Error("precision-pool unsupported fees or balance deficit");
  return { source, reserve0, reserve1, supply, balance0, balance1 };
}
