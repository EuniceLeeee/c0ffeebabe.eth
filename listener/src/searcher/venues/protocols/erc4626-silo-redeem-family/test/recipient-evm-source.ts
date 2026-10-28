import assert from "node:assert/strict";

// Silo imports this standalone token only; later Curve test contracts are not
// executable dependencies. Keep the full file separately in the audit record.
export function siloEvmDependencySource(name: string, source: string): string {
  if (name !== "test/CurvePlainRecipient.t.sol") return source;
  const token = "\ncontract CurveRecipientToken {";
  const boundary = "\ncontract CurveRecipientPool {";
  assert.equal(source.split(token).length, 2, "standalone token declaration changed");
  assert.equal(source.split(boundary).length, 2, "Curve dependency boundary changed");
  const prefix = source.slice(0, source.indexOf(boundary));
  assert(prefix.includes(token) && prefix.trimEnd().endsWith("}"), "invalid token dependency scope");
  return prefix;
}
