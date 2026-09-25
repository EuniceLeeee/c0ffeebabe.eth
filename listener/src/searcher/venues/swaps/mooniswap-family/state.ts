import { bindRequestResultRound, collectRequestProgramResults } from "../../adapter-family-plugin.js";
import type { AdapterRequestResult, CanonicalSource } from "../../adapter-request-program.js";
import { GOVERNANCE, POOL, TOKEN, addressWord, call, lower, resultSet, returned, uint } from "./codec.js";
import type { MooniswapDescriptor } from "./types.js";

export function bindingRequests(d: MooniswapDescriptor) {
  return [call("governance", d.pool, POOL.encodeFunctionData("mooniswapFactoryGovernance")),
    call("token0", d.pool, POOL.encodeFunctionData("token0")), call("token1", d.pool, POOL.encodeFunctionData("token1"))];
}
export function currentGovernance(d: MooniswapDescriptor, results: readonly AdapterRequestResult[], source: CanonicalSource) {
  if (addressWord(returned(results, "token0", source).data) !== lower(d.token0) ||
      addressWord(returned(results, "token1", source).data) !== lower(d.token1)) throw new Error("mooniswap current binding changed");
  return addressWord(returned(results, "governance", source).data);
}
export function governanceRound(d: MooniswapDescriptor, results: readonly AdapterRequestResult[], source: CanonicalSource) {
  const governance = currentGovernance(d, results, source);
  // This address is mutable. Read it first, then bind the next round to the
  // same canonical source. Do not pin the initial address inside Ready.
  return bindRequestResultRound({ transports: ["eth-call"], caller: "executor" },
    [call("active", governance, GOVERNANCE.encodeFunctionData("isActive"))]);
}
export function decodeActive(dependentEvidence: readonly unknown[], source: CanonicalSource): boolean {
  if (dependentEvidence.length !== 1) throw new Error("mooniswap missing/unexpected governance round");
  const results = collectRequestProgramResults([], dependentEvidence);
  resultSet(results, ["active"], source);
  const active = uint(returned(results, "active", source).data);
  if (active > 1n) throw new Error("mooniswap invalid governance response");
  return active === 1n;
}
export const balanceRequest = (id: string, token: string, pool: string) => call(id, token, TOKEN.encodeFunctionData("balanceOf", [pool]));
