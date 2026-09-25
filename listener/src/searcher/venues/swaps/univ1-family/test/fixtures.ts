import assert from "node:assert/strict";
import { ethers } from "ethers";
import { plugin } from "../../../production-families/uniswap-v1.production.js";
import type { AdapterRequest, AdapterRequestResult } from "../../../adapter-request-program.js";
import { IMPLEMENTATION } from "../codec.js";
import type { Candidate, Identity } from "../types.js";
export const SOURCE = { number: 26029476, hash: "0x74997e992f9feddb1b373da2eb41e7cd3abe189c537b4fc79e7d15896c092c35", generation: 1 };
export const POOL_ADDRESS = "0x1000000000000000000000000000000000000001";
export const TOKEN_ADDRESS = "0x1000000000000000000000000000000000000002";
export const FACTORY_ADDRESS = "0x1000000000000000000000000000000000000003";
export const ISSUER = "0x1000000000000000000000000000000000000004";
export const EXECUTOR = "0x1000000000000000000000000000000000000005";
// Shape observed via eth_getCode at N=26029476, not a handwritten proxy model.
export const CLONE = `0x366000600037611000600036600073${IMPLEMENTATION.slice(2)}5af41558576110006000f3`;
export const word = (n: bigint | string) => ethers.toBeHex(n, 32);
export const CANDIDATE: Candidate = { candidateKind: "univ1-exchange", pool: POOL_ADDRESS };
export function result(id: string, data: string, source = SOURCE): AdapterRequestResult {
  return { id, data, source, ok: true, completion: "returned", provenance: { kind: "synthetic-univ1-contract", fingerprint: "fixture" } };
}
export function answer(r: AdapterRequest): AdapterRequestResult {
  const values: Record<string, string> = { code: CLONE, token: word(TOKEN_ADDRESS), factory: word(FACTORY_ADDRESS), issuer: word(ISSUER),
    "implementation-code": "0x60006000f3", "factory-code": "0x60016000f3", "token-code": "0x60026000f3",
    exchange: word(POOL_ADDRESS), "reverse-token": word(TOKEN_ADDRESS), decimals: word(18n),
    "native-reserve": word(100n * 10n ** 18n), "token-reserve": word(50_000n * 10n ** 18n) };
  assert(r.id in values, r.id);
  const data = ["token", "factory", "issuer"].includes(r.id) ? values[r.id] + "ff".repeat(4096 - 32) : values[r.id];
  return result(r.id, data);
}
export function descriptor(reply = answer, candidate = CANDIDATE) {
  const variant = plugin.identity.variants[0];
  let evidence: unknown;
  let verified: Identity | undefined;
  for (let step = 0; step < 3; step++) {
    const input = { candidate, evidence, step };
    const decision = variant.decide(input);
    if (decision.status === "verified") { verified = decision.identity as Identity; break; }
    assert.equal(decision.status, "continue", JSON.stringify(decision));
    evidence = variant.decode({ step: input, results: variant.buildRequests(input).map(reply) });
  }
  assert(verified);
  return plugin.instance.finalizeDescriptor({ identity: verified, draft: plugin.instance.compileDraft(verified), sharedBindings: [] });
}
export function quote(amountIn: bigint, buy = true) {
  const d = descriptor(), route = plugin.routes.project({ descriptor: d }).find(r => r.buy === buy)!;
  const input = { descriptor: d, route, amountIn, source: SOURCE, executor: EXECUTOR, runtimeEvidence: [] };
  const method = plugin.exact.methods(input)[1];
  assert.equal(method.kind, "request-program");
  if (method.kind !== "request-program") throw new Error("univ1 missing amount program");
  const quoted = method.program.decode({ programInput: input, initialResults: method.program.buildRequests(input).map(answer), dependentEvidence: [] });
  return { input, method, quoted };
}
