import assert from "node:assert/strict";
import { isLocalBalanceProbeRevert } from "../../../../test/family-integration/kyber-yb-compound/evidence.js";
/** Only used while testing arbitrary balance-storage candidates. A proxy
 * implementation slot can redirect a read to empty code. Empty return rejects
 * that candidate; it is never a zero balance and never execution evidence.
 * Transport/RPC failures propagate unchanged. */
export async function probeBalance(read: () => Promise<string>): Promise<bigint | null> {
  let value: string;
  try { value = await read(); } catch (e) { if (isLocalBalanceProbeRevert(e)) return null; throw e; }
  if (value === "0x") return null;
  assert(/^0x[0-9a-fA-F]{64}$/.test(value), "balance probe returned malformed uint256");
  return BigInt(value);
}

export function splitWrappedCalls(calls: readonly any[], wrapped: string, executor: string) {
  const all = calls.filter(t => t.to?.toLowerCase() === wrapped.toLowerCase() &&
    (t.input === "0xd0e30db0" || t.input?.startsWith("0x2e1a7d4d")));
  return { boundary: all.filter(t => t.from?.toLowerCase() === executor.toLowerCase()),
    internal: all.filter(t => t.from?.toLowerCase() !== executor.toLowerCase()) };
}

/** Compare only execution modes that deliver to the same executor account.
 * A retry can contain a strict subset; direct-external has its own receipt gates. */
export function assertExecutionModeParity(executions: readonly any[]) {
  const known = ["quoted", "runtime", "direct-self", "direct-external"];
  assert(executions.length > 0);
  assert.equal(new Set(executions.map(e => e.encoding)).size, executions.length);
  for (const e of executions) { assert(known.includes(e.encoding)); assert.equal(e.status, "pass"); }
  const self = executions.filter(e => e.encoding !== "direct-external");
  for (const e of self.slice(1)) assert.deepEqual(e.balances, self[0].balances);
}
