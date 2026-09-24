import assert from "node:assert/strict";
import { ethers } from "ethers";
import { ADDR } from "../../../../../shared/constants/addresses.js";
import { psmIdentity } from "../identity.js";
import { PSM_INTERFACE, psmBuyCost } from "../codec.js";
import type { AdapterRequestResult } from "../../../adapter-request-program.js";
import { createStrictCentralAdapterRuntime } from "../../../../strict-central-adapter-runtime.js";
import { executeAdapterFamilyLifecycleBatch, recheckFamilyInstanceMemoBinding } from "../../../adapter-family-runtime.js";
import { PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG as catalog } from "../../../production-family-composition.js";
import { PSM_FAMILY_ID } from "../manifest.js";

const target = "0x2222222222222222222222222222222222222222", pocket = "0x3333333333333333333333333333333333333333";
const executor = "0x4444444444444444444444444444444444444444";
const source = { number: 123, hash: ethers.id("psm-proof-fixture"), generation: 1 };
const variant = psmIdentity.variants[0], candidate = { candidateKind: "lite-psm" as const, target };
const response = (id: string, data: string): Extract<AdapterRequestResult, { ok: true }> => ({ id, data, source,
  ok: true, completion: "returned", provenance: { kind: "fixture", fingerprint: "not-chain-evidence" } });
const getterInput = { candidate, step: 0 };
const getterResults = variant.buildRequests(getterInput).map(r => {
  if (r.id === "identity-code") return response(r.id, "0x6000");
  const fn = r.id.replace("identity-", "");
  const name = fn === "scale" ? "to18ConversionFactor" : fn;
  const value = fn === "gem" ? ADDR.USDC : fn === "dai" ? ADDR.DAI : fn === "pocket" ? pocket : fn === "scale" ? 10n ** 12n : 10n ** 15n;
  return response(r.id, PSM_INTERFACE.encodeFunctionResult(name, [value]));
});
const evidence = variant.decode({ step: getterInput, results: getterResults });
const step = { candidate, evidence, step: 1 };
assert.equal(variant.decide(step).status, "continue", "getter-only arbitrary runtime cannot grant routes");
const requests = variant.buildRequests(step);
assert.equal(requests.length, 4);
const results = requests.map(r => {
  assert(r.kind === "effect-delta-simulation");
  const parsed = PSM_INTERFACE.parseTransaction({ data: r.call.data })!;
  const sell = parsed.name === "sellGem", output = sell ? BigInt(parsed.args[1]) * 10n ** 12n * 999n / 1000n : BigInt(parsed.args[1]);
  const spent = sell ? BigInt(parsed.args[1]) : psmBuyCost(output, 10n ** 15n, 10n ** 12n);
  const ti = sell ? ADDR.USDC : ADDR.DAI, to = sell ? ADDR.DAI : ADDR.USDC;
  return { ...response(r.id, "0x"), effects: { tokenDeltas: [
    { token: ti, account: executor, delta: -spent }, { token: ti, account: sell ? pocket : target, delta: spent },
    { token: to, account: String(parsed.args[0]), delta: output }, { token: to, account: sell ? target : pocket, delta: -output },
  ] } };
});
const decide = (results: readonly AdapterRequestResult[]) => variant.decide({ candidate, step: 2,
  evidence: variant.decode({ step, results }) });
assert.equal(decide(results).status, "verified");
assert.equal(decide(results.map(r => ({ ...r, effects: undefined }))).status, "retryable");
assert.equal(decide(results.map(r => r.id.includes(":buy:") ? { ...r,
  effects: { tokenDeltas: r.effects.tokenDeltas.map((d, i) => i === 2 ? { ...d, delta: d.delta - 1n } : d) } } : r)).status, "retryable");
assert.throws(() => decide(results.map(r => ({ ...r, source: { ...source, number: 124 } }))), /foreign/);
assert.throws(() => decide([...results, results[0]]), /duplicate/);
console.log("PSM getter-only denial and exact directional execution proof PASS (synthetic)");

// New-cutoff memo checks deliberately fail closed when their read-only runtime
// cannot repeat behavioral identity. The caller must use full attestation;
// removing memoReuse would incorrectly cache mutable getter-only bindings.
const family = catalog.forFamily(PSM_FAMILY_ID);
for (const number of [124, 125, 126]) {
  const at = { number, generation: number, hash: ethers.toBeHex(number, 32) };
  const failExecution = number === 125;
  let simulations = 0;
  function runtime(withExecution: boolean) {
    return createStrictCentralAdapterRuntime({
      generationFence: { assertCurrent(generation, actual) {
        assert.equal(generation, at.generation); assert.deepEqual(actual, at);
      } },
      provider: {
        async getCode(_address, block) { assert.equal(block, at.number); return "0x6000"; },
        async getStorage() { throw new Error("unexpected storage read"); },
        async call(request, block) {
          assert.equal(block, at.number);
          const fn = PSM_INTERFACE.parseTransaction({ data: request.data })!.name;
          const key = fn === "to18ConversionFactor" ? "scale" : fn;
          const result = getterResults.find(item => item.id === "identity-" + key);
          assert(result); return result.data;
        },
      },
      ...(withExecution ? { executor, simulator: {
        async simulate(input: { request: { id: string } }) {
          simulations++;
          if (failExecution) throw new Error("fixture behavioral proof unavailable");
          const result = results.find(item => item.id === input.request.id);
          assert(result); return { data: result.data, effects: result.effects };
        },
      } } : {}),
    });
  }
  assert.equal(await recheckFamilyInstanceMemoBinding({
    family, candidate, source: at, generation: at.generation, runtime: runtime(false),
  }), null, "read-only recheck cannot silently reuse executable identity");
  assert.equal(simulations, 0);
  const lifecycle = await executeAdapterFamilyLifecycleBatch({
    family, source: at, generation: at.generation, runtime: runtime(true),
    publisher: { publish() {} },
    matches: [{ matchedPatternId: "psm-buygem-call", observation: {
      kind: "call", source: at, target,
      data: PSM_INTERFACE.encodeFunctionData("buyGem", [executor, 1_000_000n]),
    } }],
  });
  assert.equal(simulations, 4, "full attestation repeats both sizes in both directions");
  assert.equal(lifecycle.publication?.instances.length ?? 0, failExecution ? 0 : 1,
    "execution failure cannot retain old admission; recovery issues a new instance");
}
console.log("PSM new-cutoff memo safe miss -> full behavioral attestation -> failure/recovery PASS (synthetic)");
