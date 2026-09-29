// Explicit cached runtime/Ready inputs; no chain calls and no new admission.
// Runtime bytes are real evidence. Ramp/quote/control cases below are fixtures.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { AbiCoder, id, keccak256 } from "ethers";
import { curvePlainPricing } from "../pricing.js";
import { curvePlainExact } from "../exact.js";
import { curvePlainRoutes } from "../routes.js";
import { curveRefreshAddresses, curveRefreshGuardRequests, validateCurveRefreshScope } from "../refresh-scope.js";
import type { CurvePlainDescriptor, CurvePlainPricingDescriptor, CurvePlainRoute } from "../types.js";
import type { AdapterRequestResult, CanonicalSource } from "../../../adapter-request-program.js";
import type { MutationPricingEntry, UnifiedObservation } from "../../../adapter-family-plugin.js";

const [codePath, readyPath] = process.argv.slice(2);
assert(codePath && readyPath, "pass cached pool-code.json and Ready checkpoint paths");
const decode = (text: string) => JSON.parse(text, (_key, v) => v?.$durableType === "bigint" ? BigInt(v.value) : v);
const code = decode(readFileSync(codePath, "utf8"));
const ready = decode(readFileSync(readyPath, "utf8")).readyGeneration;
const instances = ready.catalogSnapshot.instances.filter((v: any) => v.familyId === "curve-plain");
const source: CanonicalSource = { number: 26080328, hash: code.pin.blockHash, generation: 1 };
const entries: MutationPricingEntry<CurvePlainPricingDescriptor, CurvePlainRoute>[] = instances.flatMap((v: any) =>
  v.staticProjection.pricingInstances.map((p: any) => ({ ...p,
    descriptor: p.pricingDescriptor, dependencies: curvePlainPricing.dependencies({ descriptor: p.pricingDescriptor }),
  })));
const index = curvePlainPricing.mutation.compile({ entries });
const known = instances.filter((v: any) => curveRefreshGuardRequests(v.compiledDescriptor).length > 0);
assert(known.length > 0 && known.length < instances.length);
// Expected dependency sets come from the independently pinned runtime fixture,
// not from the classifier under test. This catches accidentally broadening the
// scoped models or narrowing any unknown model, without fixing a Ready size.
const expectedAddresses = (d: CurvePlainDescriptor): readonly string[] => {
  const proof = code.records.find((r: any) => r.codeHash === d.binding.codeHash);
  return proof ? [d.pool, proof.implementation] : [d.pool, ...d.binding.coins];
};
assert.equal(known.length, instances.filter((v: any) => code.records.some((r: any) =>
  r.codeHash === v.compiledDescriptor.binding.codeHash)).length);
const event = (kind: "log" | "call", address: string): UnifiedObservation => kind === "log"
  ? { kind, source, address, topics: [id("Approval(address,address,uint256)")], data: "0x" }
  : { kind, source, target: address, sender: "0x0000000000000000000000000000000000000001", data: "0xdeadbeef" };
const eq = (a: readonly string[], b: readonly string[]) => assert.deepEqual(new Set(a), new Set(b));
for (const entry of entries) for (const kind of ["log", "call"] as const) {
  const addresses = expectedAddresses(entry.descriptor.instance);
  eq(curveRefreshAddresses(entry.descriptor.instance), addresses);
  for (const address of [...addresses, ...entry.descriptor.instance.binding.coins]) {
    const observation = event(kind, address);
    const expected = entries.filter(e => expectedAddresses(e.descriptor.instance).some(a => a.toLowerCase() === address.toLowerCase()))
      .flatMap(e => e.routes.map(r => r.routeKey));
    eq(index.affectedStateKeys({ observation }), expected);
    const affected = curvePlainPricing.mutation.affectedStateKeys({ ...entry, observation });
    eq(affected, addresses.some(a => a.toLowerCase() === address.toLowerCase()) ? entry.routes.map(r => r.routeKey) : []);
  }
}
const word = (n: bigint) => AbiCoder.defaultAbiCoder().encode(["uint256"], [n]);
const returned = (id: string, data: string): AdapterRequestResult => ({ id, source, ok: true, data,
  completion: "returned", provenance: { kind: "fixture", fingerprint: "curve-refresh-scope-control" } });
let controls = 0;
for (const record of code.records) {
  assert.equal(keccak256(record.code), record.codeHash);
  assert.equal(keccak256(record.implementationCode), record.implementationHash);
  const d: CurvePlainDescriptor = known.find((v: any) => v.compiledDescriptor.binding.codeHash === record.codeHash).compiledDescriptor;
  const requests = curveRefreshGuardRequests(d);
  const crypto = requests.some(r => r.id === "refresh-ramp-current-gamma");
  const a = 12000n, gamma = 170n;
  const answers = requests.map(r => returned(r.id, r.kind === "get-code" ? record.implementationCode :
    word(r.id === "refresh-ramp-future" ? crypto ? (a << 128n) + gamma : a : r.id === "refresh-ramp-current-gamma" ? gamma : a)));
  validateCurveRefreshScope(d, source, answers); controls++;
  // A_precise equality, not rounded stable A, is what makes future carry safe.
  const aRead = requests.find(r => r.id === "refresh-ramp-current-A")!;
  assert(aRead.kind === "eth-call");
  assert.equal(aRead.data.slice(0, 10), id(crypto ? "A()" : "A_precise()").slice(0, 10));
  for (const offset of [-1n, 1n]) {
    const changed = answers.map(r => r.id === "refresh-ramp-current-A" ? { ...r, data: word(a + offset) } : r);
    assert.throws(() => validateCurveRefreshScope(d, source, changed), /active parameter ramp/); controls++;
  }
  if (crypto) {
    assert.throws(() => validateCurveRefreshScope(d, source,
      answers.map(r => r.id === "refresh-ramp-current-gamma" ? { ...r, data: word(gamma + 1n) } : r)), /active parameter ramp/); controls++;
  }
  for (const request of requests) {
    for (const broken of [
      answers.filter(r => r.id !== request.id),
      [...answers, answers.find(r => r.id === request.id)!],
      answers.map(r => r.id === request.id ? { ...r, source: { ...source, generation: source.generation + 1 } } : r),
      answers.map(r => r.id === request.id ? returned(r.id, "0x") : r),
      answers.map(r => r.id === request.id ? { ...returned(r.id, "0x"), completion: "reverted-as-declared" as const } : r),
    ]) { assert.throws(() => validateCurveRefreshScope(d, source, broken)); controls++; }
  }
  assert.throws(() => validateCurveRefreshScope(d, source,
    answers.map(r => r.id === "refresh-implementation" ? returned(r.id, record.implementationCode + "00") : r)), /implementation changed/); controls++;
  const route = curvePlainRoutes.project({ descriptor: d })[0]!;
  const input = { descriptor: d, route, source, amountIn: 123456789n,
    executor: "0x0000000000000000000000000000000000000001", runtimeEvidence: [] };
  const method = curvePlainExact.methods(input).find(m => m.kind === "request-program")!;
  assert(method.kind === "request-program");
  const quoted = [...answers, returned("exact-get-dy", word(7654321n))];
  assert.equal(method.program.decode({ programInput: input, initialResults: quoted, dependentEvidence: [] }).amountOut, 7654321n);
  assert.throws(() => method.program.decode({ programInput: input,
    initialResults: quoted.map(r => r.id === "refresh-ramp-current-A" ? returned(r.id, word(a - 1n)) : r), dependentEvidence: [] }), /active parameter ramp/);
  controls += 2;
  const arbitraryPool = { ...d, pool: "0x0000000000000000000000000000000000000009" };
  assert.equal(curveRefreshGuardRequests(arbitraryPool).length, requests.length, "proof is not a pool allowlist");
  const unknown = { ...d, binding: { ...d.binding, codeHash: keccak256("0x6000") } };
  eq(curveRefreshAddresses(unknown), [unknown.pool, ...unknown.binding.coins]);
  assert.equal(curveRefreshGuardRequests(unknown).length, 0, "unknown models retain original behavior");
}
const tokens = ["0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", "0xdac17f958d2ee523a2206206994597c13d831ec7", "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2"];
console.log(JSON.stringify({ kind: "cached-ready-refresh-contract", pools: instances.length, scopedPools: known.length,
  scopedDirections: entries.filter(e => curveRefreshGuardRequests(e.descriptor.instance).length > 0).length, controls,
  unrelatedTokenFanout: tokens.map(token => ({ token,
    before: entries.filter(e => e.descriptor.instance.binding.coins.some(c => c.toLowerCase() === token)).length,
    after: index.affectedStateKeys({ observation: event("log", token) }).length,
  })), quoteAmountsAreFixtures: true, broadcast: false }, null, 2));
