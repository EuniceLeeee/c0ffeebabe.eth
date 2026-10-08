import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ethers } from "ethers";
import { plugin } from "../../../production-families/balancer-v1.production.js";
import type { AdapterRequest, AdapterRequestResult } from "../../../adapter-request-program.js";
import { POOL } from "../codec.js";
import type { Candidate, Identity } from "../types.js";
export const PUBLIC = JSON.parse(readFileSync(new URL("./public-state.json", import.meta.url), "utf8"));
export const PINNED = JSON.parse(readFileSync(new URL("./pinned-amounts.json", import.meta.url), "utf8"));
export const SOURCE = Object.freeze({ ...PUBLIC.source, generation: 1 });
export const EXECUTOR = "0x1000000000000000000000000000000000000001";
export const CANDIDATE: Candidate = { candidateKind: "balancer-v1-pool", pool: PUBLIC.pool };
export const word = (n: bigint) => ethers.toBeHex(n, 32);
export function result(id: string, data: string, source = SOURCE): AdapterRequestResult {
  return { id, data, source, ok: true, completion: "returned", provenance: { kind: "synthetic-binding-of-saved-public-inputs", fingerprint: "fixture-not-admission" } };
}
export function answer(r: AdapterRequest): AdapterRequestResult {
  if (r.id === "pool-code") return result(r.id, PUBLIC.poolCode);
  if (r.id === "factory-code") return result(r.id, PUBLIC.factoryCode);
  if (r.kind !== "eth-call") throw Error("unexpected fixture request " + r.id);
  // Match full calldata, not merely an id. These are saved view returns, not
  // invented quotes or fixture transfers asserted to be historical execution.
  const read = [...PUBLIC.reads, ...PINNED.reads].find(x => x.params[0].to.toLowerCase() === r.to.toLowerCase() && x.params[0].data === r.data);
  assert(read, r.id + ": no saved public request"); return result(r.id, read.result);
}
export function descriptor(reply = answer, candidate = CANDIDATE) {
  const v = plugin.identity.variants[0]; let evidence: unknown, verified: Identity | undefined;
  for (let step = 0; step < 5; step++) {
    const input = { candidate, evidence, step }, decision = v.decide(input);
    if (decision.status === "verified") { verified = decision.identity as Identity; break; }
    assert.equal(decision.status, "continue", JSON.stringify(decision));
    evidence = v.decode({ step: input, results: v.buildRequests(input).map(reply) });
  }
  assert(verified);
  return plugin.instance.finalizeDescriptor({ identity: verified, draft: plugin.instance.compileDraft(verified), sharedBindings: [] });
}
export function quote(amountIn: bigint, i = 1, d = descriptor()) {
  const route = plugin.routes.project({ descriptor: d }).find(r => r.i === i)!;
  const input = { descriptor: d, route, amountIn, source: SOURCE, executor: EXECUTOR, runtimeEvidence: [] };
  const method = plugin.exact.methods(input)[1]; assert.equal(method.kind, "request-program");
  if (method.kind !== "request-program") throw Error("missing exact program");
  const initialResults = method.program.buildRequests(input).map(answer);
  const round = method.program.buildDependentProgram?.({ programInput: input, completedRound: 0, initialResults, priorEvidence: [] });
  const dependentEvidence = round ? [round.decode(round.requests.map(answer))] : [];
  const quoted = method.program.decode({ programInput: input, initialResults, dependentEvidence });
  return { input, method, quoted, initialResults, dependentEvidence, round };
}
export function syntheticDescriptor(tokens: readonly string[], weights: readonly bigint[]) {
  const d = descriptor(); return { ...d, tokens, weights };
}
export const emptyTokensReturn = POOL.encodeFunctionResult("getFinalTokens", [[]]);
