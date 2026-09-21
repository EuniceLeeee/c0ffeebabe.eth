import assert from "node:assert/strict";
import { ethers } from "ethers";
import type { AdapterRequestResult, CanonicalSource } from "../../../adapter-request-program.js";
import { EXECUTION, META, POOL, selector } from "../codec.js";
import { curvePlainIdentity, PROBE_RECEIVER } from "../identity.js";

// Synthetic request/decision contract only: not on-chain execution evidence.
const pool = "0x1111111111111111111111111111111111111111";
const coins = ["0x2222222222222222222222222222222222222222", "0x3333333333333333333333333333333333333333"];
const executor = "0x4444444444444444444444444444444444444444";
const handler = "0x5555555555555555555555555555555555555555";
const source: CanonicalSource = { number: 123, hash: ethers.id("synthetic-source"), generation: 1 };
const variant = curvePlainIdentity.variants[0];
const candidate = { candidateKind: "curve-plain-pool" as const, pool, hintedI: null, hintedJ: null };
const word = (n: bigint) => ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [n]);
const pad = (values: string[], count: number) => [...values, ...Array(count - values.length).fill(ethers.ZeroAddress)];
const returned = (id: string, data: string): Extract<AdapterRequestResult, { ok: true }> => ({
  id, ok: true, data, source, completion: "returned", provenance: { kind: "fixture", fingerprint: "optional-mode-contract" },
});
let evidence: unknown;
for (let step = 0; step < 3; step++) {
  const input = { candidate, step, ...(evidence === undefined ? {} : { evidence }) };
  const results = variant.buildRequests(input).map(request => {
    if (/^(coin|balance)-int128:/.test(request.id)) {
      return { ...returned(request.id, "0x"), completion: "reverted-as-declared" as const };
    }
    let data: string;
    switch (request.id) {
      case "pool-code": data = "0x6000"; break;
      case "registry-handlers": data = META.encodeFunctionResult("get_registry_handlers_from_pool", [pad([handler], 10)]); break;
      case "registry-coins": data = META.encodeFunctionResult("get_coins", [pad(coins, 8)]); break;
      case "amplification": data = word(100n); break;
      case "fee": data = word(1_000_000n); break;
      default:
        if (request.id.startsWith("coin:")) data = POOL.encodeFunctionResult("coins", [coins[Number(request.id.split(":")[1])]]);
        else if (request.id.startsWith("decimals:")) data = word(18n);
        else if (request.id.startsWith("balance:")) data = word(10n ** 24n);
        else if (request.id.startsWith("quote:")) data = word(request.id.endsWith(":0") ? 999n : 9990n);
        else throw new Error(`unexpected ${request.id}`);
    }
    return returned(request.id, data);
  });
  evidence = variant.decode({ step: input, results });
}
const step = { candidate, step: 3, evidence };
const requests = variant.buildRequests(step);
assert.equal(requests.length, 6);
assert(requests.every(request => request.required === false), "alternatives must reach the decoder even when unavailable");
const successful = requests.map(request => {
  assert.equal(request.kind, "effect-delta-simulation");
  if (request.kind !== "effect-delta-simulation") throw new Error("unexpected request");
  const mode = request.call.data.startsWith(selector("received")) ? "received" :
    request.call.data.startsWith(selector("exchange")) ? "exchange" : "received-no-receiver";
  const args = EXECUTION[mode].decodeFunctionData(mode === "exchange" ? "exchange" : "exchange_received", request.call.data);
  const [i, j, dx, minDy] = [Number(args[0]), Number(args[1]), BigInt(args[2]), BigInt(args[3])];
  assert.equal(minDy, 999n, "minimum remains exactly the source-pinned quote");
  return { ...returned(request.id, word(minDy)), effects: { tokenDeltas: [
    { token: coins[i], account: executor, delta: -dx }, { token: coins[i], account: pool, delta: dx },
    { token: coins[j], account: mode === "received" ? PROBE_RECEIVER : executor, delta: minDy },
    { token: coins[j], account: pool, delta: -minDy },
  ] } };
});
const unavailable = (id: string): AdapterRequestResult => ({ id, ok: false, source, failure: "resource-limited" });
const reverted = (id: string): AdapterRequestResult => ({
  ...returned(id, "0x"), completion: "reverted-as-declared",
});
const decide = (results: readonly AdapterRequestResult[], observed = candidate) => variant.decide({
  candidate: observed, step: 4, evidence: variant.decode({ step, results }),
});

// Mirrors the existing transport's preCall-failure classification: optional
// approval failure cannot erase an independently successful received proof.
for (const mode of ["received", "received-no-receiver", "exchange"] as const) {
  const results = successful.map(result => result.id.endsWith(`:${mode}`) ? result : unavailable(result.id));
  const decision = decide(results);
  assert.equal(decision.status, "verified");
  if (decision.status !== "verified") throw new Error("missing verified direction");
  assert.deepEqual(decision.identity.facts.directions.map(d => [d.i, d.j, d.executionMode]), [[0, 1, mode], [1, 0, mode]]);
}
// A positive quote with no proved mode is unresolved if even one alternative
// timed out. A different direction's success must not publish a subset.
for (const unresolvedDirection of ["0:1", "1:0"]) {
  for (const onlyOneTimeout of [false, true]) {
    const results = successful.map(result => {
      if (!result.id.startsWith(`execution:${unresolvedDirection}:`)) return result;
      return !onlyOneTimeout || result.id.endsWith(":exchange")
        ? unavailable(result.id) : reverted(result.id);
    });
    assert.throws(() => decide(results), /unresolved execution proof/);
  }
}
// Actual EVM reverts are negative evidence, not unknown transport outcomes.
// A fully reverted reverse direction may be omitted without inventing support.
const reverseReverted = successful.map(result => result.id.startsWith("execution:1:0:") ? reverted(result.id) : result);
const oneDirection = decide(reverseReverted);
assert.equal(oneDirection.status, "verified");
if (oneDirection.status === "verified") {
  assert.deepEqual(oneDirection.identity.facts.directions.map(d => [d.i, d.j]), [[0, 1]]);
}
const alternativesFailed = successful.map(result => result.id.endsWith(":exchange") ? unavailable(result.id) : result);
const selected = decide(alternativesFailed);
assert.equal(selected.status, "verified");
if (selected.status === "verified") assert(selected.identity.facts.directions.every(d => d.executionMode === "received"));
assert.throws(() => decide(successful.map(result => unavailable(result.id))), /unresolved/);
assert.equal(decide(successful.map(result => reverted(result.id))).status, "retryable");
assert.throws(() => decide(successful.slice(1)), /missing/);
assert.throws(() => decide([...successful, successful[0]]), /duplicate/);
assert.throws(() => decide(successful.map(result => ({ ...unavailable(result.id), source: { ...source, hash: ethers.id("foreign") } }))), /foreign source/);

// Exact amounts/effects remain strict, including a one-wei mismatch. A failed
// alternative cannot justify keeping the otherwise wrong direction.
for (const corrupt of [
  (result: typeof successful[number]) => ({ ...result, data: word(998n) }),
  (result: typeof successful[number]) => ({ ...result, effects: { tokenDeltas: result.effects.tokenDeltas.map((d, i) => i === 2 ? { ...d, delta: 998n } : d) } }),
  (result: typeof successful[number]) => ({ ...result, effects: { tokenDeltas: result.effects.tokenDeltas.map((d, i) => i === 3 ? { ...d, delta: -998n } : d) } }),
]) {
  assert.throws(() => decide(successful.map(result => result.id.endsWith(":received") ? corrupt(result) : unavailable(result.id))), /unresolved/);
}
const hinted = { ...candidate, hintedI: 1, hintedJ: 0 };
const observedMissing = variant.decide({ candidate: hinted, step: 4, evidence: variant.decode({ step, results: reverseReverted }) });
assert.equal(observedMissing.status, "retryable", "never invent an unproved observed direction");
console.log("PASS per-direction execution proof: unknown modes cannot publish a subset; proved alternatives and actual reverts remain distinct; exact effects/source enforced");
