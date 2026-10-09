import assert from "node:assert/strict";
import { ethers } from "ethers";
import { matchesBalanceSlotProbe, isLocalBalanceProbeRevert } from "../../../../test/family-integration/kyber-yb-compound/evidence.js";

const abi = new ethers.Interface(["function balanceOf(address) view returns(uint256)", "function totalSupply() view returns(uint256)"]);
type Overrides = Record<string, { stateDiff: Record<string, string> }>;
/** Observation-only fallback for namespaces/custom mapping indices. Candidates
 * come from the actor's actual access list, not a guessed storage layout.
 * Fault-injected proxy/control slots may revert; all transport errors propagate.
 */
export async function proveActorBalanceSlot(input: {
  token: string; actor: string; protectedAccount: string; candidates: readonly string[];
  call: (to: string, data: string, overrides?: Overrides) => Promise<string>;
}) {
  assert(input.actor.toLowerCase() !== input.protectedAccount.toLowerCase());
  const keys = [...new Set(input.candidates.map(k => ethers.toBeHex(BigInt(k), 32)))];
  assert(keys.length > 0 && keys.length <= 16, "bounded actor slot candidate set required");
  const balanceData = abi.encodeFunctionData("balanceOf", [input.actor]);
  const protectedData = abi.encodeFunctionData("balanceOf", [input.protectedAccount]);
  const supplyData = abi.encodeFunctionData("totalSupply");
  const initial = await input.call(input.token, balanceData), protectedBalance = await input.call(input.token, protectedData);
  const supply = await input.call(input.token, supplyData);
  assert([initial, protectedBalance, supply].every(value => ethers.isHexString(value, 32)));
  const matches: string[] = [], checks: Record<string, unknown>[] = [];
  for (const key of keys) {
    let valid = true;
    for (const amount of [717171717171n, 919191919193n]) {
      const overrides = { [input.token.toLowerCase()]: { stateDiff: { [key]: ethers.toBeHex(amount, 32) } } };
      let returned: string;
      try { returned = await input.call(input.token, balanceData, overrides); }
      catch (error) {
        if (!isLocalBalanceProbeRevert(error)) throw error;
        checks.push({ key, amount: String(amount), completion: "local-revert", matched: false }); valid = false; break;
      }
      const matched = matchesBalanceSlotProbe(returned, amount);
      checks.push({ key, amount: String(amount), returned, matched });
      if (!matched || await input.call(input.token, protectedData, overrides) !== protectedBalance ||
          await input.call(input.token, supplyData, overrides) !== supply) { valid = false; break; }
    }
    if (valid) matches.push(key);
  }
  assert.equal(matches.length, 1, "actor balance slot not uniquely proven");
  return { slot: matches[0]!, initial, protectedBalance, supply, checks };
}
