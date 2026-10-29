import assert from "node:assert/strict";
import { ethers } from "ethers";
import { loadFamily, sourceAt } from "./helper.js";
import { originStethArmDiscovery } from "../src/searcher/venues/protocols/origin-steth-arm-family/discovery.js";
import { originStethArmRoutes } from "../src/searcher/venues/protocols/origin-steth-arm-family/routes.js";
import { originStethArmInstance } from "../src/searcher/venues/protocols/origin-steth-arm-family/instance.js";
import { originStethArmPricing } from "../src/searcher/venues/protocols/origin-steth-arm-family/pricing.js";
import { originStethArmExact } from "../src/searcher/venues/protocols/origin-steth-arm-family/exact.js";
import { originStethArmExecution } from "../src/searcher/venues/protocols/origin-steth-arm-family/execution.js";
import { originStethArmIdentity } from "../src/searcher/venues/protocols/origin-steth-arm-family/identity.js";
import { originStethArmFamilyManifest } from "../src/searcher/venues/protocols/origin-steth-arm-family/manifest.js";
import {
  ORIGIN_STETH_ARM, ORIGIN_STETH_ARM_IMPLEMENTATION, ORIGIN_STETH_ARM_INTERFACE,
  ORIGIN_STETH_ARM_PROBE_RECIPIENT, ORIGIN_STETH_ARM_STETH, ORIGIN_STETH_ARM_TRADERATE0_SLOT,
  ORIGIN_STETH_ARM_TRADERATE1_SLOT, ORIGIN_STETH_ARM_WETH, originStethArmQuote,
} from "../src/searcher/venues/protocols/origin-steth-arm-family/codec.js";
import { inspectRuntime } from "../src/searcher/test/runtime-program-testkit.js";

const SOURCE = sourceAt(26244681);
const EXECUTOR = "0xE08D97e151473A848C3d9CA3f323Cb720472D015";
const OTHER = "0x1000000000000000000000000000000000000002";
const TRADERATE0 = 1000020000400008000160003200064001280n;
const TRADERATE1 = 999863865309614123000000000000000000n;
const SAMPLE_AMOUNT_IN = 8589306883606n;
const SAMPLE_AMOUNT_OUT = 8588137580972n;
const result = (id: string, data: string, effects?: any) => Object.freeze({
  id, ok: true as const, source: SOURCE, provenance: { kind: "fixture", fingerprint: "fixture" },
  completion: "returned" as const, data, ...(effects === undefined ? {} : { effects }),
});
const check = (name: string, fn: () => void) => { try { fn(); out.push(`PASS ${name}`); } catch (e) { out.push(`FAIL ${name}: ${(e as Error).message}`); throw e; } };
const out: string[] = [];

const { plugin, runtime } = await loadFamily("origin-steth-arm");
check("manifest", () => assert.deepEqual(plugin.manifest, originStethArmFamilyManifest));
check("protocol", () => assert.deepEqual(plugin.protocol, { candidateKinds: ["observed-call", "address-surface"], activeBehaviorProof: "required" }));
check("action ids", () => assert.deepEqual(plugin.actionAdapters.map((a: any) => a.id), ["origin-steth-arm-swap"]));
check("action trace", () => {
  assert.equal(plugin.actionAdapters[0].matchTrace(ORIGIN_STETH_ARM, "0x6c08c57e"), true);
  assert.equal(plugin.actionAdapters[0].matchTrace(ORIGIN_STETH_ARM, "0xa0712d68"), false);
});
check("discovery call candidate", () => {
  const observation = { kind: "call", source: SOURCE, target: ORIGIN_STETH_ARM, data: ORIGIN_STETH_ARM_INTERFACE.encodeFunctionData("swapExactTokensForTokens", [ORIGIN_STETH_ARM_STETH, ORIGIN_STETH_ARM_WETH, SAMPLE_AMOUNT_IN, 0n, EXECUTOR]) };
  const a = originStethArmDiscovery.decodeCandidate({ observation, matchedPatternId: "origin-steth-arm-swap-call" } as any);
  const b = plugin.discovery.decodeCandidate({ observation, matchedPatternId: "origin-steth-arm-swap-call" } as any);
  assert.deepEqual(b, a);
  const zero = { ...observation, data: ORIGIN_STETH_ARM_INTERFACE.encodeFunctionData("swapExactTokensForTokens", [ORIGIN_STETH_ARM_STETH, ORIGIN_STETH_ARM_WETH, 0n, 0n, EXECUTOR]) };
  assert.equal(originStethArmDiscovery.decodeCandidate({ observation: zero, matchedPatternId: "origin-steth-arm-swap-call" } as any), null);
  assert.equal(plugin.discovery.decodeCandidate({ observation: zero, matchedPatternId: "origin-steth-arm-swap-call" } as any), null);
});
check("discovery surface candidate", () => {
  const observation = { kind: "address-surface", source: SOURCE, address: ORIGIN_STETH_ARM, codeHash: `0x${"11".repeat(32)}`, implementationWord: `0x${"00".repeat(32)}`, interfaceFingerprints: ["origin-steth-arm-swap-v1"] };
  assert.deepEqual(plugin.discovery.decodeCandidate({ observation, matchedPatternId: "origin-steth-arm-surface" } as any), originStethArmDiscovery.decodeCandidate({ observation, matchedPatternId: "origin-steth-arm-surface" } as any));
});
const candidate = { candidateKind: "origin-steth-arm", target: ORIGIN_STETH_ARM } as any;
check("candidate key", () => assert.equal(plugin.discovery.candidateKey(candidate), originStethArmDiscovery.candidateKey(candidate)));

const word = (n: bigint) => ethers.zeroPadValue(ethers.toBeHex(n), 32);
function proxyResults() {
  return [
    result("identity-proxy-code", "0x6001600055"),
    result("identity-implementation-slot", ethers.zeroPadValue(ORIGIN_STETH_ARM_IMPLEMENTATION, 32)),
    result("identity-steth-code", "0x6002600055"),
    result("identity-weth-code", "0x6003600055"),
  ];
}
function bindingResults() {
  return [
    result("identity-implementation-code", "0x6004600055"),
    result("identity-traderate0", word(TRADERATE0)),
    result("identity-traderate1", word(TRADERATE1)),
  ];
}
function effectRow(direction: "steth-to-weth" | "weth-to-steth", amount: bigint) {
  const forward = direction === "steth-to-weth";
  const tokenIn = forward ? ORIGIN_STETH_ARM_STETH : ORIGIN_STETH_ARM_WETH;
  const tokenOut = forward ? ORIGIN_STETH_ARM_WETH : ORIGIN_STETH_ARM_STETH;
  const rate = forward ? TRADERATE1 : TRADERATE0;
  const amountOut = originStethArmQuote(amount, rate);
  return {
    tokenDeltas: [
      { token: tokenIn, account: EXECUTOR, delta: -amount },
      { token: tokenIn, account: ORIGIN_STETH_ARM, delta: amount },
      { token: tokenOut, account: ORIGIN_STETH_ARM_PROBE_RECIPIENT, delta: amountOut },
      { token: tokenOut, account: ORIGIN_STETH_ARM, delta: -amountOut },
    ],
    nativeDeltas: [],
    totalSupplyDeltas: [],
    logs: [],
  };
}
function probeResults() {
  const rows: any[] = [];
  for (const direction of ["steth-to-weth", "weth-to-steth"] as const) {
    for (const amount of [10n ** 12n, 10n ** 15n]) {
      rows.push(result(`identity-swap:${direction}:${amount}`, "0x", effectRow(direction, amount)));
    }
  }
  return rows;
}
const tsVariant = originStethArmIdentity.variants[0]!;
const jsonVariant = plugin.identity.variants[0]!;
let tsStep: any = { candidate, step: 0 };
let jsonStep: any = { candidate, step: 0 };
let bindingEvidence: any;
for (const [name, rows] of [["proxy", proxyResults()], ["binding", bindingResults()], ["behavior", probeResults()]] as const) {
  check(`identity ${name} requests`, () => assert.deepEqual(jsonVariant.buildRequests(jsonStep), tsVariant.buildRequests(tsStep)));
  check(`identity ${name} decode`, () => {
    const a = tsVariant.decode({ step: tsStep, results: [...rows] as any });
    const b = jsonVariant.decode({ step: jsonStep, results: [...rows] as any });
    assert.deepEqual(b, a);
    assert.deepEqual(jsonVariant.decide({ ...jsonStep, evidence: b }), tsVariant.decide({ ...tsStep, evidence: a }));
    tsStep = { ...tsStep, step: tsStep.step + 1, evidence: a };
    jsonStep = { ...jsonStep, step: jsonStep.step + 1, evidence: b };
    if (name === "binding") bindingEvidence = b;
  });
}
const verified = Object.freeze({
  phase: "verified",
  source: SOURCE,
  proxyCodeHash: "0x2f2547c03a7df08ab5b52c16c83ce594279bd2f79b39d43008bbf9dee11c7510",
  implementation: ORIGIN_STETH_ARM_IMPLEMENTATION,
  stethCodeHash: "0xb9c1c929064cd21734c102a698e68bf617feefcfa5a9f62407c45401546736bf",
  wethCodeHash: "0xd0a06b12ac47863b5c7be4185c2deaad1c61557033f56c7d4ea74429cbb25e23",
  implementationCodeHash: "0x12828de7a5e8dd262821cf306d4f6d3c12d494816316cad5d72cea22f4c5d63d",
  traderate0: TRADERATE0,
  traderate1: TRADERATE1,
  behaviorValid: true,
  behaviorProofHash: `0x${"44".repeat(32)}`,
});
check("identity verified decision", () => {
  const a = tsVariant.decide({ candidate, step: 3, evidence: verified }) as any;
  const b = jsonVariant.decide({ candidate, step: 3, evidence: verified }) as any;
  assert.equal(a.status, "verified");
  assert.deepEqual(b, a);
});
check("identity decide parity on rejections", () => {
  const cases = [
    { ...verified, proxyCodeHash: `0x${"00".repeat(32)}` },
    { ...verified, implementation: ethers.ZeroAddress },
    { ...verified, stethCodeHash: `0x${"22".repeat(32)}` },
    { ...verified, wethCodeHash: `0x${"22".repeat(32)}` },
    { ...verified, implementationCodeHash: `0x${"33".repeat(32)}` },
    { ...verified, traderate0: 0n },
    { ...verified, traderate1: 3n * 10n ** 36n },
    { ...verified, behaviorValid: false },
  ];
  for (const evidence of cases) assert.deepEqual(jsonVariant.decide({ candidate, step: 3, evidence }), tsVariant.decide({ candidate, step: 3, evidence }));
});
check("identity rejects tampered behavior", () => {
  const rows = probeResults();
  (rows[0].effects.tokenDeltas[0] as any).delta = -(10n ** 12n) + 3n;
  const decoded = jsonVariant.decode({ step: { candidate, step: 2, evidence: bindingEvidence }, results: rows as any });
  assert.equal(decoded.behaviorValid, false);
});
check("identity rejects foreign source", () => {
  const rows = bindingResults().map(r => ({ ...r, source: sourceAt(26244682) }));
  assert.throws(() => jsonVariant.decode({ step: { candidate, step: 1, evidence: bindingEvidence }, results: rows as any }));
});
const identity = (tsVariant.decide({ candidate, step: 3, evidence: verified }) as any).identity;
check("instance draft", () => {
  const a = originStethArmInstance.compileDraft(identity);
  const b = plugin.instance.compileDraft(identity);
  assert.deepEqual(b, a);
  assert.deepEqual(plugin.instance.staticBindingProjection(b), originStethArmInstance.staticBindingProjection(a));
});
const descriptor = plugin.instance.compileDraft(identity);
const tsDescriptor = originStethArmInstance.compileDraft(identity);
check("routes", () => {
  const a = originStethArmRoutes.project({ descriptor: tsDescriptor } as any);
  const b = plugin.routes.project({ descriptor } as any);
  assert.deepEqual(b, a);
  for (const [index, route] of b.entries()) assert.deepEqual(plugin.routes.projectGraph({ descriptor, route }), originStethArmRoutes.projectGraph({ descriptor: tsDescriptor, route: a[index] } as any));
});
const routes = plugin.routes.project({ descriptor } as any);
const tsRoutes = originStethArmRoutes.project({ descriptor: tsDescriptor } as any);
check("pricing draft + finalize", () => {
  const a = originStethArmPricing.compileDraft({ descriptor: tsDescriptor, stateKey: tsDescriptor.instanceKey, routes: tsRoutes } as any);
  const b = plugin.pricing.compileDraft({ descriptor, stateKey: descriptor.instanceKey, routes } as any);
  assert.deepEqual(b, a);
  const pb = plugin.pricing.finalizePricingDescriptor({ draft: b, staticEvidence: {} } as any);
  const pa = originStethArmPricing.finalizePricingDescriptor({ draft: a, staticEvidence: undefined } as any);
  assert.deepEqual(pb, pa);
  const normalize = (list: readonly string[]) => [...new Set(list.map(x => x.toLowerCase()))].sort();
  assert.deepEqual(normalize(plugin.pricing.dependencies({ descriptor: pb })), normalize(originStethArmPricing.dependencies({ descriptor: pa })));
});
const pricingDraft = plugin.pricing.compileDraft({ descriptor, stateKey: descriptor.instanceKey, routes } as any);
const pricingDescriptor = plugin.pricing.finalizePricingDescriptor({ draft: pricingDraft, staticEvidence: {} } as any);
const tsPricingDescriptor = originStethArmPricing.finalizePricingDescriptor({ draft: originStethArmPricing.compileDraft({ descriptor: tsDescriptor, stateKey: tsDescriptor.instanceKey, routes: tsRoutes } as any), staticEvidence: undefined } as any);
const storageResult = (id: string, n: bigint, source = SOURCE) => Object.freeze({
  id, ok: true as const, source, provenance: { kind: "fixture", fingerprint: "fixture" },
  completion: "returned" as const, data: word(n),
});
check("pricing current", () => {
  assert.deepEqual(plugin.pricing.current.buildRequests({ descriptor: pricingDescriptor, routes, source: SOURCE } as any), originStethArmPricing.current.buildRequests({ descriptor: tsPricingDescriptor, routes: tsRoutes } as any));
  const rows = [storageResult("current-traderate0", TRADERATE0), storageResult("current-traderate1", TRADERATE1)];
  const a = originStethArmPricing.current.decodeSnapshot({ descriptor: tsPricingDescriptor, initialResults: rows, dependentEvidence: [] } as any);
  const b = plugin.pricing.current.decodeSnapshot({ descriptor: pricingDescriptor, initialResults: rows, dependentEvidence: [] } as any);
  assert.deepEqual(b, a);
  assert.deepEqual(plugin.pricing.current.deriveMids({ descriptor: pricingDescriptor, snapshot: b, routes } as any), originStethArmPricing.current.deriveMids({ descriptor: tsPricingDescriptor, snapshot: a, routes: tsRoutes } as any));
  const badRows = [storageResult("current-traderate0", TRADERATE0), storageResult("current-traderate1", 0n)];
  const xa = originStethArmPricing.current.decodeSnapshot({ descriptor: tsPricingDescriptor, initialResults: badRows, dependentEvidence: [] } as any);
  const xb = plugin.pricing.current.decodeSnapshot({ descriptor: pricingDescriptor, initialResults: badRows, dependentEvidence: [] } as any);
  assert.deepEqual(xb, xa);
  assert.deepEqual([...plugin.pricing.current.classifyUnavailable!({ descriptor: pricingDescriptor, snapshot: xb, routes } as any)], [...originStethArmPricing.current.classifyUnavailable!({ descriptor: tsPricingDescriptor, snapshot: xa, routes: tsRoutes } as any)]);
  assert.equal(plugin.pricing.current.deriveMids({ descriptor: pricingDescriptor, snapshot: xb, routes } as any).size, 1);
});
check("pricing mutation", () => {
  const entries = [{ descriptor: pricingDescriptor, routes, stateKey: descriptor.instanceKey, dependencies: [descriptor.target] }];
  const index = plugin.pricing.mutation!.compile!({ entries } as any);
  assert.deepEqual(index.affectedStateKeys({ observation: { kind: "call", target: descriptor.target } as any }), [descriptor.instanceKey]);
  assert.deepEqual(index.affectedStateKeys({ observation: { kind: "call", target: descriptor.steth } as any }), []);
});
check("expected effects", () => {
  assert.deepEqual(plugin.execution.expectedEffects({ descriptor, route: routes[0] } as any), originStethArmExecution.expectedEffects({ descriptor: tsDescriptor, route: tsRoutes[0] } as any));
});
check("compatibility projections", () => {
  assert.deepEqual(plugin.pricing.snapshotCompatibilityProjection({ descriptor: pricingDescriptor } as any), originStethArmPricing.snapshotCompatibilityProjection({ descriptor: tsPricingDescriptor } as any));
  for (const direction of ["steth-to-weth", "weth-to-steth"] as const) {
    assert.deepEqual(
      plugin.exact.cacheCompatibilityProjection({ descriptor, route: routes.find((r: any) => r.direction === direction) } as any),
      originStethArmExact.cacheCompatibilityProjection({ descriptor: tsDescriptor, route: tsRoutes.find((r: any) => r.direction === direction) } as any),
    );
  }
});
const exactInput = (direction: "steth-to-weth" | "weth-to-steth", amountIn: bigint) => ({ descriptor, route: routes.find((r: any) => r.direction === direction), amountIn, executor: EXECUTOR, source: SOURCE, runtimeEvidence: [] });
const tsExactInput = (direction: "steth-to-weth" | "weth-to-steth", amountIn: bigint) => ({ descriptor: tsDescriptor, route: tsRoutes.find((r: any) => r.direction === direction), amountIn, executor: EXECUTOR, source: SOURCE, runtimeEvidence: [] });
check("exact methods + zero", () => {
  const a = originStethArmExact.methods(tsExactInput("steth-to-weth", 7n) as any);
  const b = plugin.exact.methods(exactInput("steth-to-weth", 7n) as any);
  assert.deepEqual(b.map((m: any) => [m.id, m.kind]), a.map((m: any) => [m.id, m.kind]));
  const za: any = a.find((m: any) => m.id === "local-zero");
  const zb: any = b.find((m: any) => m.id === "local-zero");
  assert.deepEqual(zb.quote(tsExactInput("steth-to-weth", 0n) as any), za.quote(tsExactInput("steth-to-weth", 0n) as any));
});
for (const direction of ["steth-to-weth", "weth-to-steth"] as const) {
  check(`exact quote ${direction}`, () => {
    const amount = direction === "steth-to-weth" ? SAMPLE_AMOUNT_IN : 1234567890123456789n;
    const rate = direction === "steth-to-weth" ? TRADERATE1 : TRADERATE0;
    const slot = direction === "steth-to-weth" ? ORIGIN_STETH_ARM_TRADERATE1_SLOT : ORIGIN_STETH_ARM_TRADERATE0_SLOT;
    const a: any = originStethArmExact.methods(tsExactInput(direction, amount) as any).find((m: any) => m.kind === "request-program");
    const b: any = plugin.exact.methods(exactInput(direction, amount) as any).find((m: any) => m.kind === "request-program");
    assert.deepEqual(b.program.requirements(exactInput(direction, amount) as any), a.program.requirements(tsExactInput(direction, amount) as any));
    const aRequests = a.program.buildRequests(tsExactInput(direction, amount) as any);
    const bRequests = b.program.buildRequests(exactInput(direction, amount) as any);
    assert.deepEqual(bRequests, aRequests);
    assert.equal(bRequests[0].slot, slot);
    const qa = a.program.decode({ programInput: tsExactInput(direction, amount) as any, initialResults: [storageResult("exact-traderate", rate)], dependentEvidence: [] });
    const qb = b.program.decode({ programInput: exactInput(direction, amount) as any, initialResults: [storageResult("exact-traderate", rate)], dependentEvidence: [] });
    assert.equal(qb.amountOut, qa.amountOut);
    const { readProof, ...qbEvidence } = qb.evidence as any;
    assert.deepEqual(qbEvidence, qa.evidence);
    assert.deepEqual(readProof.initialResults.map((r: any) => r.id), ["exact-traderate"]);
    assert.deepEqual(readProof.dependentEvidence, []);
    const zeroRequirements = b.program.requirements(exactInput(direction, 0n) as any);
    assert.deepEqual(zeroRequirements, a.program.requirements(tsExactInput(direction, 0n) as any));
    assert.deepEqual(b.program.buildRequests(exactInput(direction, 0n) as any), []);
    const zero = b.program.decode({ programInput: exactInput(direction, 0n) as any, initialResults: [], dependentEvidence: [] });
    const zeroA = a.program.decode({ programInput: tsExactInput(direction, 0n) as any, initialResults: [], dependentEvidence: [] });
    assert.deepEqual(zero, zeroA);
  });
}
check("exact rejects foreign source and missing result", () => {
  const b: any = plugin.exact.methods(exactInput("steth-to-weth", SAMPLE_AMOUNT_IN) as any).find((m: any) => m.kind === "request-program");
  assert.throws(() => b.program.decode({ programInput: exactInput("steth-to-weth", SAMPLE_AMOUNT_IN) as any, initialResults: [storageResult("exact-traderate", TRADERATE1, sourceAt(26244682))], dependentEvidence: [] }));
  assert.throws(() => b.program.decode({ programInput: exactInput("steth-to-weth", SAMPLE_AMOUNT_IN) as any, initialResults: [], dependentEvidence: [] }));
});
const forwardQuote: any = (() => {
  const method: any = plugin.exact.methods(exactInput("steth-to-weth", SAMPLE_AMOUNT_IN) as any).find((m: any) => m.kind === "request-program");
  return method.program.decode({ programInput: exactInput("steth-to-weth", SAMPLE_AMOUNT_IN) as any, initialResults: [storageResult("exact-traderate", TRADERATE1)], dependentEvidence: [] });
})();
check("execution fragment + read proof", () => {
  const input = { descriptor, route: routes.find((r: any) => r.direction === "steth-to-weth"), amountIn: SAMPLE_AMOUNT_IN, quotedAmountOut: forwardQuote.amountOut, minAmountOut: 0n, exactEvidence: forwardQuote.evidence, executor: EXECUTOR, runtimeEvidence: [] };
  const tsInput = { ...input, descriptor: tsDescriptor, route: tsRoutes.find((r: any) => r.direction === "steth-to-weth") };
  const a = originStethArmExecution.buildFragment(tsInput as any);
  const b = plugin.execution.buildFragment(input as any);
  assert.equal(b.nodes[0].adapterId, a.nodes[0].adapterId);
  assert.equal(b.nodes[0].target, a.nodes[0].target);
  assert.equal(b.nodes[0].amount, a.nodes[0].amount);
  assert.throws(() => plugin.execution.buildFragment({ ...input, quotedAmountOut: forwardQuote.amountOut + 1n } as any), /read proof|incompatible/);
  const tampered = { ...input, exactEvidence: { ...input.exactEvidence, readProof: { ...input.exactEvidence.readProof, initialResults: [storageResult("exact-traderate", TRADERATE1 + 1n)] } } };
  assert.throws(() => plugin.execution.buildFragment(tampered as any), /read proof|incompatible/);
});
check("execution runtime leg semantics", () => {
  const route = routes.find((r: any) => r.direction === "steth-to-weth");
  const leg = plugin.execution.buildRuntimeLeg({ descriptor, route, executor: EXECUTOR, runtimeEvidence: [], source: SOURCE } as any);
  assert.equal(leg.actionAdapterId, "origin-steth-arm-swap");
  assert.deepEqual(leg.settlement, { directOutput: true });
  const minOut = originStethArmQuote(SAMPLE_AMOUNT_IN, TRADERATE1);
  const calls: any[] = [];
  const balanceCalls = new Map<string, number>();
  const rateSelector = ORIGIN_STETH_ARM_INTERFACE.getFunction("traderate1")!.selector;
  const swapSelector = ORIGIN_STETH_ARM_INTERFACE.getFunction("swapExactTokensForTokens")!.selector;
  const inspected = inspectRuntime(leg.program, SAMPLE_AMOUNT_IN, {
    call: (call: any) => {
      calls.push(call);
      if (call.data.startsWith(swapSelector)) return ethers.AbiCoder.defaultAbiCoder().encode(["uint256[]"], [[minOut]]);
      if (call.data.startsWith(rateSelector)) return word(TRADERATE1);
      if (call.static && call.data.startsWith("0x70a08231")) {
        const account = ethers.getAddress(`0x${call.data.slice(34)}`).toLowerCase();
        const key = call.target.toLowerCase() + ":" + account;
        const nth = balanceCalls.get(key) ?? 0;
        balanceCalls.set(key, nth + 1);
        const inputToken = call.target.toLowerCase() === ORIGIN_STETH_ARM_STETH.toLowerCase();
        return word(inputToken ? (nth === 0 ? SAMPLE_AMOUNT_IN : 0n) : (nth === 0 ? 0n : minOut));
      }
      return "0x";
    },
    allowance: () => undefined,
    nativeBalance: () => 0n,
  });
  const armCalls = calls.filter(c => c.target.toLowerCase() === ORIGIN_STETH_ARM.toLowerCase());
  const rateCall = armCalls.find(c => c.data.startsWith(ORIGIN_STETH_ARM_INTERFACE.getFunction("traderate1")!.selector));
  assert.ok(rateCall && rateCall.static);
  const swap = armCalls.find(c => c.data.startsWith(ORIGIN_STETH_ARM_INTERFACE.getFunction("swapExactTokensForTokens")!.selector))!;
  const decoded = ORIGIN_STETH_ARM_INTERFACE.decodeFunctionData("swapExactTokensForTokens", swap.data);
  assert.equal(ethers.getAddress(decoded[0]), ORIGIN_STETH_ARM_STETH);
  assert.equal(ethers.getAddress(decoded[1]), ORIGIN_STETH_ARM_WETH);
  assert.equal(decoded[2], SAMPLE_AMOUNT_IN);
  assert.equal(decoded[3], minOut);
  assert.equal(ethers.getAddress(decoded[4]), EXECUTOR);
  const erc20 = new ethers.Interface(["function approve(address,uint256) returns (bool)"]);
  const approvals = calls.filter(c => c.target.toLowerCase() === ORIGIN_STETH_ARM_STETH.toLowerCase() && c.data.startsWith(erc20.getFunction("approve")!.selector));
  assert.deepEqual(approvals.map(c => erc20.decodeFunctionData("approve", c.data)[1]), [0n, SAMPLE_AMOUNT_IN, 0n]);
  const withRecipient = plugin.execution.buildRuntimeLeg({ descriptor, route, executor: EXECUTOR, runtimeEvidence: [], source: SOURCE, settlement: { kind: "direct-output", recipient: OTHER } } as any);
  assert.ok(withRecipient);
  const calls2: any[] = [];
  const balanceCalls2 = new Map<string, number>();
  inspectRuntime(withRecipient.program, SAMPLE_AMOUNT_IN, {
    call: (call: any) => {
      calls2.push(call);
      if (call.data.startsWith(swapSelector)) return ethers.AbiCoder.defaultAbiCoder().encode(["uint256[]"], [[minOut]]);
      if (call.data.startsWith(rateSelector)) return word(TRADERATE1);
      if (call.static && call.data.startsWith("0x70a08231")) {
        const account = ethers.getAddress(`0x${call.data.slice(34)}`).toLowerCase();
        const key = call.target.toLowerCase() + ":" + account;
        const nth = balanceCalls2.get(key) ?? 0;
        balanceCalls2.set(key, nth + 1);
        const inputToken = call.target.toLowerCase() === ORIGIN_STETH_ARM_STETH.toLowerCase();
        const outputToken = call.target.toLowerCase() === ORIGIN_STETH_ARM_WETH.toLowerCase();
        if (inputToken) return word(nth === 0 ? SAMPLE_AMOUNT_IN : 0n);
        if (outputToken) return word(nth === 0 ? 0n : minOut);
        return word(0n);
      }
      return "0x";
    },
    allowance: () => undefined,
    nativeBalance: () => 0n,
  });
  const swap2 = calls2.find(c => c.data.startsWith(ORIGIN_STETH_ARM_INTERFACE.getFunction("swapExactTokensForTokens")!.selector))!;
  assert.equal(ethers.getAddress(ORIGIN_STETH_ARM_INTERFACE.decodeFunctionData("swapExactTokensForTokens", swap2.data)[4]), OTHER);
  assert.equal(plugin.execution.buildRuntimeLeg({ descriptor, route, executor: EXECUTOR, runtimeEvidence: [], source: SOURCE, settlement: { kind: "deferred-input", paymentProgram: "0x01", paymentAmount: 1n } } as any), null);
});
check("module pipeline", () => {
  assert.deepEqual(runtime.moduleCoverage[0]!.modules.map(m => [m.key, m.state]), [["math", "compiled"], ["executionMath", "compiled"], ["quoteFlow", "compiled"], ["pricingFlow", "compiled"], ["trialState", "undefined"]]);
});
console.log(out.join("\n"));
console.log(`\n${out.filter(x => x.startsWith("PASS")).length} passed, ${out.filter(x => x.startsWith("FAIL")).length} failed`);
