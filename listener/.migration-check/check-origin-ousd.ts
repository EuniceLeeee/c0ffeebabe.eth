import assert from "node:assert/strict";
import { ethers } from "ethers";
import { loadFamily, sourceAt } from "./helper.js";
import { ADDR } from "../src/shared/constants/addresses.js";
import { originOusdDiscovery } from "../src/searcher/venues/protocols/origin-ousd-family/discovery.js";
import { originOusdRoutes } from "../src/searcher/venues/protocols/origin-ousd-family/routes.js";
import { originOusdInstance } from "../src/searcher/venues/protocols/origin-ousd-family/instance.js";
import { originOusdPricing } from "../src/searcher/venues/protocols/origin-ousd-family/pricing.js";
import { originOusdExact } from "../src/searcher/venues/protocols/origin-ousd-family/exact.js";
import { originOusdExecution } from "../src/searcher/venues/protocols/origin-ousd-family/execution.js";
import { originOusdIdentity } from "../src/searcher/venues/protocols/origin-ousd-family/identity.js";
import { originOusdFamilyOwnedAction } from "../src/searcher/venues/protocols/origin-ousd-family/action.js";
import { originOusdFamilyManifest } from "../src/searcher/venues/protocols/origin-ousd-family/manifest.js";
import { ORIGIN_OUSD_ASSET, ORIGIN_OUSD_IMPLEMENTATION, ORIGIN_OUSD_TOKEN, ORIGIN_OUSD_VAULT, ORIGIN_OUSD_VAULT_INTERFACE, originOusdMintQuote } from "../src/searcher/venues/protocols/origin-ousd-family/codec.js";
import { inspectRuntime } from "../src/searcher/test/runtime-program-testkit.js";

const SOURCE = sourceAt(26185253);
const EXECUTOR = "0xE08D97e151473A848C3d9CA3f323Cb720472D015";
const OTHER = "0x1000000000000000000000000000000000000002";
const result = (id: string, data: string, effects?: any, completion = "returned") => Object.freeze({
  id, ok: true as const, source: SOURCE, provenance: { kind: "fixture", fingerprint: "fixture" },
  completion: completion as any, data, ...(effects === undefined ? {} : { effects }),
});
const declined = (id: string) => Object.freeze({ id, ok: false as const, source: SOURCE, failure: "fixture-rpc" } as any);

const { plugin, runtime } = await loadFamily("origin-ousd");
const out: string[] = [];
const check = (name: string, fn: () => void) => { try { fn(); out.push(`PASS ${name}`); } catch (e) { out.push(`FAIL ${name}: ${(e as Error).message}`); throw e; } };

check("manifest", () => assert.deepEqual(plugin.manifest, originOusdFamilyManifest));
check("protocol" , () => assert.deepEqual(plugin.protocol, { candidateKinds: ["observed-call", "address-surface"], activeBehaviorProof: "required" }));
check("action ids", () => assert.deepEqual(plugin.actionAdapters.map((a: any) => a.id), ["origin-ousd-mint"]));
check("action trace", () => {
  assert.equal(plugin.actionAdapters[0].matchTrace(ORIGIN_OUSD_VAULT, ORIGIN_OUSD_VAULT_INTERFACE.getFunction("mint")!.selector), true);
  assert.equal(plugin.actionAdapters[0].matchTrace(ORIGIN_OUSD_VAULT, ORIGIN_OUSD_VAULT_INTERFACE.getFunction("redeem")!.selector), false);
  assert.equal(originOusdFamilyOwnedAction.matchTrace(ORIGIN_OUSD_VAULT, ORIGIN_OUSD_VAULT_INTERFACE.getFunction("mint")!.selector), true);
});
check("discovery call candidate", () => {
  const observation = { kind: "call", source: SOURCE, target: ORIGIN_OUSD_VAULT, data: ORIGIN_OUSD_VAULT_INTERFACE.encodeFunctionData("mint", [1_000_000n]) };
  const a = originOusdDiscovery.decodeCandidate({ observation, matchedPatternId: "origin-ousd-mint-call" } as any);
  const b = plugin.discovery.decodeCandidate({ observation, matchedPatternId: "origin-ousd-mint-call" } as any);
  assert.deepEqual(b, a);
  const zero = { ...observation, data: ORIGIN_OUSD_VAULT_INTERFACE.encodeFunctionData("mint", [0n]) };
  assert.equal(originOusdDiscovery.decodeCandidate({ observation: zero, matchedPatternId: "origin-ousd-mint-call" } as any), null);
  assert.equal(plugin.discovery.decodeCandidate({ observation: zero, matchedPatternId: "origin-ousd-mint-call" } as any), null);
});
check("discovery surface candidate", () => {
  const observation = { kind: "address-surface", source: SOURCE, address: ORIGIN_OUSD_VAULT, codeHash: `0x${"11".repeat(32)}`, implementationWord: `0x${"00".repeat(32)}`, interfaceFingerprints: ["origin-ousd-vault-mint-v1"] };
  const a = originOusdDiscovery.decodeCandidate({ observation, matchedPatternId: "origin-ousd-vault-surface" } as any);
  const b = plugin.discovery.decodeCandidate({ observation, matchedPatternId: "origin-ousd-vault-surface" } as any);
  assert.deepEqual(b, a);
});
const candidate = { candidateKind: "origin-ousd-vault", target: ORIGIN_OUSD_VAULT } as any;
check("discovery candidate key", () => assert.equal(plugin.discovery.candidateKey(candidate as any), originOusdDiscovery.candidateKey(candidate as any)));

function proxyResults() {
  return [
    result("identity-proxy-code", "0x6001600055"),
    result("identity-implementation-slot", ethers.zeroPadValue(ORIGIN_OUSD_IMPLEMENTATION, 32)),
    result("identity-token-code", "0x6002600055"),
  ];
}
function bindingResults() {
  return [
    result("identity-implementation-code", "0x6003600055"),
    result("identity-asset", ORIGIN_OUSD_VAULT_INTERFACE.encodeFunctionResult("asset", [ADDR.USDC])),
  ];
}
function mintEffects(target: string, amount: bigint) {
  const amountOut = originOusdMintQuote(amount);
  return {
    tokenDeltas: [
      { token: ORIGIN_OUSD_ASSET, account: target, delta: amount },
      { token: ORIGIN_OUSD_ASSET, account: EXECUTOR, delta: -amount },
      { token: ORIGIN_OUSD_TOKEN, account: EXECUTOR, delta: amountOut },
    ],
    nativeDeltas: [],
    totalSupplyDeltas: [{ token: ORIGIN_OUSD_TOKEN, delta: amountOut }],
    logs: [],
  };
}
function probeResults() {
  return [
    result("identity-mint:1000000", "0x", mintEffects(ORIGIN_OUSD_VAULT, 1_000_000n)),
    result("identity-mint:10000000", "0x", mintEffects(ORIGIN_OUSD_VAULT, 10_000_000n)),
  ];
}
function runIdentity(variant: any, step: any, results: any[]) {
  const requests = variant.buildRequests(step);
  const evidence = variant.decode({ step, results });
  return { requests, evidence, decision: variant.decide({ ...step, evidence }) };
}
const tsVariant = originOusdIdentity.variants[0]!;
const jsonVariant = plugin.identity.variants[0]!;
let tsStep: any = { candidate, step: 0 };
let jsonStep: any = { candidate, step: 0 };
let bindingEvidence: any;
for (const [name, rows] of [["proxy", proxyResults()], ["binding", bindingResults()], ["behavior", probeResults()]] as const) {
  check(`identity ${name} requests`, () => {
    const a = tsVariant.buildRequests(tsStep);
    const b = jsonVariant.buildRequests(jsonStep);
    assert.deepEqual(b, a);
  });
  check(`identity ${name} decode`, () => {
    const a = runIdentity(tsVariant, tsStep, [...rows] as any);
    const b = runIdentity(jsonVariant, jsonStep, [...rows] as any);
    assert.deepEqual(b.evidence, a.evidence);
    assert.deepEqual(b.decision, a.decision);
    tsStep = { ...tsStep, step: tsStep.step + 1, evidence: a.evidence };
    jsonStep = { ...jsonStep, step: jsonStep.step + 1, evidence: b.evidence };
    if (name === "binding") bindingEvidence = b.evidence;
  });
}
const verified = Object.freeze({
  phase: "verified",
  source: SOURCE,
  proxyCodeHash: "0x42459e351d7ee0ec70d78ff7a8fab408810e97ca87324ba416acfe7708ce456e",
  implementation: ORIGIN_OUSD_IMPLEMENTATION,
  tokenCodeHash: "0xd39af98f18b3c72b2e30db499f1b8cab8dc7deffe9db5a7db6f5a260af34e7a6",
  implementationCodeHash: "0xedf6048420eebf78f63106d125288365723ca61843ce3df62c35e5106766cc40",
  asset: ADDR.USDC,
  behaviorValid: true,
  behaviorProofHash: `0x${"44".repeat(32)}`,
});
check("identity verified decision", () => {
  const a = tsVariant.decide({ candidate, step: 3, evidence: verified }) as any;
  const b = jsonVariant.decide({ candidate, step: 3, evidence: verified }) as any;
  assert.equal(a.status, "verified");
  assert.deepEqual(b, a);
});
const identity = (tsVariant.decide({ candidate, step: 3, evidence: verified }) as any).identity;

check("identity rejects foreign source", () => {
  const rows = bindingResults().map(r => ({ ...r, source: sourceAt(26185254) }));
  assert.throws(() => jsonVariant.decode({ step: { candidate, step: 1, evidence: bindingEvidence }, results: rows }));
});
check("identity decide parity on rejections", () => {
  const cases = [
    { ...verified, proxyCodeHash: `0x${"00".repeat(32)}` },
    { ...verified, implementation: ethers.ZeroAddress },
    { ...verified, tokenCodeHash: `0x${"22".repeat(32)}` },
    { ...verified, implementationCodeHash: `0x${"33".repeat(32)}` },
    { ...verified, asset: "0x6B175474E89094C44Da98b954EedeAC495271d0F" },
    { ...verified, behaviorValid: false },
  ];
  for (const evidence of cases) {
    assert.deepEqual(jsonVariant.decide({ candidate, step: 3, evidence }), tsVariant.decide({ candidate, step: 3, evidence }));
  }
  const badBehavior = mintEffects(ORIGIN_OUSD_VAULT, 1_000_000n) as any;
  badBehavior.tokenDeltas[0].delta = 999_999n;
  const tampered = result("identity-mint:1000000", "0x", badBehavior);
  const decoded = jsonVariant.decode({ step: { candidate, step: 2, evidence: bindingEvidence }, results: [tampered, probeResults()[1]] } as any);
  assert.equal(decoded.behaviorValid, false);
});

check("instance draft", () => {
  const a = originOusdInstance.compileDraft(identity);
  const b = plugin.instance.compileDraft(identity);
  assert.deepEqual(b, a);
  assert.deepEqual(plugin.instance.staticBindingProjection(b), originOusdInstance.staticBindingProjection(a));
});
const descriptor = plugin.instance.compileDraft(identity);
const tsDescriptor = originOusdInstance.compileDraft(identity);
check("instance key", () => assert.equal(plugin.instance.instanceKey(identity), originOusdInstance.instanceKey(identity)));
check("routes", () => {
  const a = originOusdRoutes.project({ descriptor: tsDescriptor } as any);
  const b = plugin.routes.project({ descriptor } as any);
  assert.deepEqual(b, a);
  assert.deepEqual(plugin.routes.projectGraph({ descriptor, route: b[0] }), originOusdRoutes.projectGraph({ descriptor: tsDescriptor, route: a[0] } as any));
});
const routes = plugin.routes.project({ descriptor } as any);
const tsRoutes = originOusdRoutes.project({ descriptor: tsDescriptor } as any);
check("pricing draft + static", () => {
  const a = originOusdPricing.compileDraft({ descriptor: tsDescriptor, stateKey: tsDescriptor.instanceKey, routes: tsRoutes } as any);
  const b = plugin.pricing.compileDraft({ descriptor, stateKey: descriptor.instanceKey, routes } as any);
  const { routes: draftRoutes, ...bRest } = b as any;
  assert.deepEqual(bRest, a);
  assert.deepEqual(draftRoutes, routes);
  const staticRequests = plugin.pricing.staticEvidence!.buildRequests(b);
  assert.deepEqual(staticRequests, []);
  const staticEvidence = plugin.pricing.staticEvidence!.decode({ programInput: b, initialResults: [], dependentEvidence: [] } as any);
  const pa = originOusdPricing.finalizePricingDescriptor({ draft: a, staticEvidence: undefined } as any);
  const pb = plugin.pricing.finalizePricingDescriptor({ draft: b, staticEvidence } as any);
  const { routes: _finalRoutes, ...pbRest } = pb as any;
  assert.deepEqual(pbRest, pa);
  const normalize = (list: readonly string[]) => [...new Set(list.map(a => a.toLowerCase()))].sort();
  assert.deepEqual(normalize(plugin.pricing.dependencies({ descriptor: pb, routes } as any)), normalize(originOusdPricing.dependencies({ descriptor: pa } as any)));
});
const pricingDraft = plugin.pricing.compileDraft({ descriptor, stateKey: descriptor.instanceKey, routes } as any);
const staticEvidence = plugin.pricing.staticEvidence!.decode({ programInput: pricingDraft, initialResults: [], dependentEvidence: [] } as any);
const pricingDescriptor = plugin.pricing.finalizePricingDescriptor({ draft: pricingDraft, staticEvidence } as any);
const tsPricingDescriptor = originOusdPricing.finalizePricingDescriptor({ draft: originOusdPricing.compileDraft({ descriptor: tsDescriptor, stateKey: tsDescriptor.instanceKey, routes: tsRoutes } as any), staticEvidence: undefined } as any);
check("pricing current", () => {
  assert.deepEqual(plugin.pricing.current.buildRequests({ descriptor: pricingDescriptor, routes, source: SOURCE } as any), originOusdPricing.current.buildRequests({ descriptor: tsPricingDescriptor, routes: tsRoutes } as any));
  const rows = [result("current-asset", ORIGIN_OUSD_VAULT_INTERFACE.encodeFunctionResult("asset", [ADDR.USDC]))];
  const a = originOusdPricing.current.decodeSnapshot({ descriptor: tsPricingDescriptor, initialResults: rows, dependentEvidence: [] } as any);
  const b = plugin.pricing.current.decodeSnapshot({ descriptor: pricingDescriptor, initialResults: rows, dependentEvidence: [] } as any);
  assert.deepEqual(b, a);
  assert.deepEqual(plugin.pricing.current.deriveMids({ descriptor: pricingDescriptor, snapshot: b, routes } as any), originOusdPricing.current.deriveMids({ descriptor: tsPricingDescriptor, snapshot: a, routes: tsRoutes } as any));
  const bad = [result("current-asset", ORIGIN_OUSD_VAULT_INTERFACE.encodeFunctionResult("asset", ["0x6B175474E89094C44Da98b954EedeAC495271d0F"]))];
  const xa = originOusdPricing.current.decodeSnapshot({ descriptor: tsPricingDescriptor, initialResults: bad, dependentEvidence: [] } as any);
  const xb = plugin.pricing.current.decodeSnapshot({ descriptor: pricingDescriptor, initialResults: bad, dependentEvidence: [] } as any);
  assert.deepEqual(xb, xa);
  assert.deepEqual([...plugin.pricing.current.classifyUnavailable!({ descriptor: pricingDescriptor, snapshot: xb, routes } as any)], [...originOusdPricing.current.classifyUnavailable!({ descriptor: tsPricingDescriptor, snapshot: xa, routes: tsRoutes } as any)]);
  assert.equal(plugin.pricing.current.deriveMids({ descriptor: pricingDescriptor, snapshot: xb, routes } as any).size, 0);
});
check("expected effects", () => {
  assert.deepEqual(plugin.execution.expectedEffects({ descriptor, route: routes[0] } as any), originOusdExecution.expectedEffects({ descriptor: tsDescriptor, route: tsRoutes[0] } as any));
});
check("compatibility projections", () => {
  assert.deepEqual(plugin.pricing.snapshotCompatibilityProjection({ descriptor: pricingDescriptor } as any), originOusdPricing.snapshotCompatibilityProjection({ descriptor: tsPricingDescriptor } as any));
  assert.deepEqual(plugin.exact.cacheCompatibilityProjection({ descriptor, route: routes[0] } as any), originOusdExact.cacheCompatibilityProjection({ descriptor: tsDescriptor, route: tsRoutes[0] } as any));
});
check("pricing mutation", () => {
  const entries = [{ descriptor: pricingDescriptor, routes, stateKey: descriptor.instanceKey, dependencies: [descriptor.target] }];
  const index = plugin.pricing.mutation!.compile!({ entries } as any);
  assert.deepEqual(index.affectedStateKeys({ observation: { kind: "call", target: descriptor.target } as any }), [descriptor.instanceKey]);
  assert.deepEqual(index.affectedStateKeys({ observation: { kind: "call", target: descriptor.asset } as any }), []);
});

const exactInput = (amountIn: bigint) => ({ descriptor, route: routes[0], amountIn, executor: EXECUTOR, source: SOURCE, runtimeEvidence: [] });
const tsExactInput = (amountIn: bigint) => ({ descriptor: tsDescriptor, route: tsRoutes[0], amountIn, executor: EXECUTOR, source: SOURCE, runtimeEvidence: [] });
check("exact methods + zero", () => {
  const a = originOusdExact.methods(tsExactInput(7n) as any);
  const b = plugin.exact.methods(exactInput(7n) as any);
  assert.deepEqual(b.map((m: any) => [m.id, m.kind]), a.map((m: any) => [m.id, m.kind]));
  const za: any = a.find((m: any) => m.id === "local-zero");
  const zb: any = b.find((m: any) => m.id === "local-zero");
  assert.deepEqual(zb.quote(tsExactInput(0n) as any), za.quote(tsExactInput(0n) as any));
});
for (const amount of [1n, 1_234_567n, 394_088_756n]) {
  check(`exact quote ${amount}`, () => {
    const a: any = originOusdExact.methods(tsExactInput(amount) as any).find((m: any) => m.kind === "request-program");
    const b: any = plugin.exact.methods(exactInput(amount) as any).find((m: any) => m.kind === "request-program");
    assert.deepEqual(b.program.requirements(tsExactInput(amount) as any), a.program.requirements(tsExactInput(amount) as any));
    assert.deepEqual(b.program.buildRequests(exactInput(amount) as any), a.program.buildRequests(tsExactInput(amount) as any));
    const qa = a.program.decode({ programInput: tsExactInput(amount) as any, initialResults: [], dependentEvidence: [] });
    const qb = b.program.decode({ programInput: exactInput(amount) as any, initialResults: [], dependentEvidence: [] });
    assert.deepEqual(qb, qa);
    // Documented deviation: the original local trial quote is not declared;
    // the declarative method refuses prefixed sequential trials fail-closed.
    assert.equal(typeof a.trialState.quote, "function");
    assert.equal(typeof b.trialState.unsupportedReason, "string");
  });
}
check("exact overflow fails closed", () => {
  const b: any = plugin.exact.methods(exactInput(1n) as any).find((m: any) => m.kind === "request-program");
  assert.throws(() => b.program.decode({ programInput: exactInput(ethers.MaxUint256) as any, initialResults: [], dependentEvidence: [] }));
});

const quote: any = (() => {
  const b: any = plugin.exact.methods(exactInput(5_000_000n) as any).find((m: any) => m.kind === "request-program");
  return b.program.decode({ programInput: exactInput(5_000_000n) as any, initialResults: [], dependentEvidence: [] });
})();
check("execution fragment", () => {
  const input = { descriptor, route: routes[0], amountIn: 5_000_000n, quotedAmountOut: quote.amountOut, minAmountOut: 0n, exactEvidence: quote.evidence, executor: EXECUTOR, runtimeEvidence: [] };
  const tsInput = { ...input, descriptor: tsDescriptor, route: tsRoutes[0] };
  const a = originOusdExecution.buildFragment(tsInput as any);
  const b = plugin.execution.buildFragment(input as any);
  assert.equal(b.nodes[0].adapterId, a.nodes[0].adapterId);
  assert.equal(b.nodes[0].target, a.nodes[0].target);
  assert.equal(b.nodes[0].amount, a.nodes[0].amount);
  assert.throws(() => plugin.execution.buildFragment({ ...input, quotedAmountOut: quote.amountOut + 1n } as any), /incompatible exact evidence/);
  // Declarative actions encode the node's declared runtime program, not the
  // hand-written direct calldata; the program's semantics are inspected below.
  const encoded = plugin.actionAdapters[0].encode(b.nodes[0], EXECUTOR, new Uint8Array());
  assert(encoded instanceof Uint8Array && encoded.length > 0);
});
check("execution runtime leg", () => {
  const a = originOusdExecution.buildRuntimeLeg({ descriptor: tsDescriptor, route: tsRoutes[0], executor: EXECUTOR, runtimeEvidence: [], source: SOURCE } as any);
  const b = plugin.execution.buildRuntimeLeg({ descriptor, route: routes[0], executor: EXECUTOR, runtimeEvidence: [], source: SOURCE } as any);
  assert.equal(b.actionAdapterId, a.actionAdapterId);
  assert.deepEqual(b.settlement, a.settlement);
  const calls: any[] = [];
  const balanceCalls = new Map<string, number>();
  const inspected = inspectRuntime(b.program, 5_000_000n, {
    call: (call) => {
      calls.push(call);
      if (call.static && call.data.startsWith("0x70a08231")) {
        const account = ethers.getAddress(`0x${call.data.slice(34)}`).toLowerCase();
        const key = call.target.toLowerCase() + ":" + account;
        const nth = balanceCalls.get(key) ?? 0;
        balanceCalls.set(key, nth + 1);
        const below = call.target.toLowerCase() === ORIGIN_OUSD_ASSET.toLowerCase();
        const value = below ? (nth === 0 ? 5_000_000n : 0n) : (nth === 0 ? 0n : 5_000_000n * 10n ** 12n);
        return ethers.toBeHex(value, 32);
      }
      return "0x";
    },
    nativeBalance: () => 0n,
  });
  const erc20 = new ethers.Interface(["function approve(address,uint256) returns (bool)"]);
  const approvals = calls.filter(c => c.target.toLowerCase() === ORIGIN_OUSD_ASSET.toLowerCase() &&
    c.data.startsWith(erc20.getFunction("approve")!.selector));
  assert.deepEqual(approvals.map(c => {
    const [spender, amount] = erc20.decodeFunctionData("approve", c.data);
    assert.equal(ethers.getAddress(spender), ORIGIN_OUSD_VAULT);
    return amount;
  }), [0n, 5_000_000n, 0n]);
  const mint = calls.find(c => c.target.toLowerCase() === ORIGIN_OUSD_VAULT.toLowerCase())!;
  assert.equal(mint.data, ORIGIN_OUSD_VAULT_INTERFACE.encodeFunctionData("mint", [5_000_000n]));
  // Documented deviation: the original leg returned null for a foreign direct
  // recipient; the declaration throws from its settlement context check
  // (fail-closed) because JSON cannot return null from the shared compiler.
  assert.throws(() => plugin.execution.buildRuntimeLeg({ descriptor, route: routes[0], executor: EXECUTOR, runtimeEvidence: [], source: SOURCE, settlement: { kind: "direct-output", recipient: OTHER } } as any), /credits the executor only/);
  assert.equal(originOusdExecution.buildRuntimeLeg({ descriptor: tsDescriptor, route: tsRoutes[0], executor: EXECUTOR, runtimeEvidence: [], source: SOURCE, settlement: { kind: "direct-output", recipient: OTHER } } as any), null);
});
check("declined request surfaces", () => {
  assert.throws(() => jsonVariant.decode({ step: { candidate, step: 0 }, results: [declined("identity-proxy-code")] } as any));
});
check("module pipeline", () => {
  assert.deepEqual(runtime.moduleCoverage[0]!.modules.map(m => [m.key, m.state]), [["math", "compiled"], ["executionMath", "undefined"], ["quoteFlow", "compiled"], ["pricingFlow", "compiled"], ["trialState", "undefined"]]);
});
console.log(out.join("\n"));
console.log(`\n${out.filter(x => x.startsWith("PASS")).length} passed, ${out.filter(x => x.startsWith("FAIL")).length} failed`);
