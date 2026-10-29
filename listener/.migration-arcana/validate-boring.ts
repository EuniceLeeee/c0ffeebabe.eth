import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ethers } from "ethers";
import { renderDeclarativeProductionEntry } from "../src/searcher/build-declarative-production.js";
import { createDeclarativeProtocolRuntime } from "../src/searcher/venues/declarative-protocol.js";
import { declarativeMathRegistry } from "../src/searcher/venues/declarative-math-models.js";
import { declarativeRuntimeMathRegistry } from "../src/searcher/venues/declarative-runtime-math-models.js";
import { defineProtocolFamily, definedFamilyPluginContractSummary } from "../src/searcher/venues/adapter-family-plugin.js";
import { inspectRuntime } from "../src/searcher/test/runtime-program-testkit.js";
import { ACCOUNTANT_INTERFACE, ERC20_INTERFACE, TELLER_INTERFACE, VAULT_INTERFACE } from "../src/searcher/venues/protocols/boring-vault-teller-family/abi.js";
import { withdrawOut } from "../src/searcher/venues/protocols/boring-vault-teller-family/pricing.js";
import { plugin as handwritten } from "../src/searcher/venues/production-families/boring-vault-teller.production.js";

const ROOT = new URL("..", import.meta.url).pathname;
const definitionFile = `${ROOT}src/searcher/venues/protocols/boring-vault-teller-family/boring-vault-teller.json`;
const document = JSON.parse(readFileSync(definitionFile, "utf8"));

// 1. Production entry rendering (in memory; never written).
const rendered = renderDeclarativeProductionEntry({ rootDirectory: ROOT, definitionFile, document });
assert.equal(rendered.format, "protocol-json-v2");
assert.equal(rendered.familyId, "protocol:boring-vault-teller");
assert.deepEqual([...rendered.ownedActionAdapterIds], ["boring-vault-withdraw"]);
assert.match(rendered.source, /compileDeclarativeProtocol<FamilyTypes>\(definition, \[\]\)/);
assert.match(rendered.source, /SEARCHER_FAMILY_BORING_VAULT_TELLER_ENABLED/);

// 2. Strict runtime compilation.
const runtime = createDeclarativeProtocolRuntime(document, [], {
  math: declarativeMathRegistry, executionMath: declarativeRuntimeMathRegistry,
});
const plugin = defineProtocolFamily(runtime.definition as never);
const summary = definedFamilyPluginContractSummary(plugin);
assert.equal(String(summary.familyId), "protocol:boring-vault-teller");
assert.equal(plugin.protocol.activeBehaviorProof, "required");
for (const row of runtime.moduleCoverage[0]!.modules) {
  if (["math", "quoteFlow", "pricingFlow"].includes(row.key)) assert.equal(row.state, "compiled", row.key);
}
assert.deepEqual(plugin.manifest.allowedTaxonomy, handwritten.manifest.allowedTaxonomy);
assert.deepEqual([...plugin.manifest.ownedActionAdapterIds], [...handwritten.manifest.ownedActionAdapterIds]);
assert.deepEqual([...plugin.manifest.requiredInfraActionAdapterIds], [...handwritten.manifest.requiredInfraActionAdapterIds]);
assert.deepEqual([...plugin.manifest.supportedLineages], [...handwritten.manifest.supportedLineages]);

// 3. Discovery parity (including the positive-share predicate).
const SOURCE = Object.freeze({ number: 26_184_075, hash: `0x${"33".repeat(32)}`, generation: 26_184_075 });
const PROVENANCE = Object.freeze({ kind: "test-transport", fingerprint: `0x${"44".repeat(32)}` });
const TELLER = ethers.getAddress("0x1000000000000000000000000000000000000031");
const VAULT = ethers.getAddress("0x1000000000000000000000000000000000000032");
const ACCOUNTANT = ethers.getAddress("0x1000000000000000000000000000000000000033");
const ASSET = ethers.getAddress("0x1000000000000000000000000000000000000034");
const EXECUTOR = ethers.getAddress("0x10000000000000000000000000000000000000ee");
const TELLER_CODE = `0x${"6001600055".repeat(10)}`;
const VAULT_CODE = `0x${"6002600555".repeat(10)}`;
const ACCOUNTANT_CODE = `0x${"6003600555".repeat(10)}`;
const RATE = 0x0eb0101fd136e06an;
const SHARES = 1_247_507_673_610_103_657_860n;
const OUT = withdrawOut({ shares: SHARES, rate: RATE, shareDecimals: 18 });
const CANDIDATE = Object.freeze({ candidateKind: "boring-vault-withdraw", teller: TELLER });

function returned(id: string, data: string) {
  return Object.freeze({ id, ok: true as const, source: SOURCE, provenance: PROVENANCE, completion: "returned" as const, data });
}
const word = (value: bigint) => `0x${value.toString(16).padStart(64, "0")}`;
const bulkData = TELLER_INTERFACE.encodeFunctionData("bulkWithdraw", [ASSET, 10n ** 18n, 0n, EXECUTOR]).toLowerCase();
const callObservation = { kind: "call" as const, source: SOURCE, target: TELLER.toLowerCase(), sender: EXECUTOR.toLowerCase(), data: bulkData };
assert.deepEqual(
  plugin.discovery.decodeCandidate({ observation: callObservation as never, matchedPatternId: "boring-vault-withdraw-call" }),
  handwritten.discovery.decodeCandidate({ observation: callObservation as never, matchedPatternId: "boring-vault-withdraw-call" }),
);
assert.deepEqual(
  plugin.discovery.decodeCandidate({ observation: { ...callObservation, data: TELLER_INTERFACE.encodeFunctionData("bulkWithdraw", [ASSET, 0n, 0n, EXECUTOR]).toLowerCase() } as never, matchedPatternId: "boring-vault-withdraw-call" }),
  handwritten.discovery.decodeCandidate({ observation: { ...callObservation, data: TELLER_INTERFACE.encodeFunctionData("bulkWithdraw", [ASSET, 0n, 0n, EXECUTOR]).toLowerCase() } as never, matchedPatternId: "boring-vault-withdraw-call" }),
);
assert.equal(plugin.discovery.decodeCandidate({ observation: callObservation as never, matchedPatternId: "other" }), null);
assert.deepEqual([...plugin.discovery.sources], [...handwritten.discovery.sources]);
assert.deepEqual([...plugin.discovery.candidateSources!], [...handwritten.discovery.candidateSources!]);
assert.equal(plugin.discovery.callPatterns![0]!.selector, handwritten.discovery.callPatterns![0]!.selector);
assert.equal(plugin.discovery.txSeedNominations, true);
assert.equal(typeof plugin.discovery.nominate!.nominate, "function");

// 4. Identity phases: base -> complete -> verified.
function baseResults(options: { paused?: boolean; code?: string } = {}) {
  return Object.freeze([
    returned("boring-teller-code", options.code ?? TELLER_CODE),
    returned("boring-vault", TELLER_INTERFACE.encodeFunctionResult("vault", [VAULT])),
    returned("boring-accountant", TELLER_INTERFACE.encodeFunctionResult("accountant", [ACCOUNTANT])),
    returned("boring-paused", TELLER_INTERFACE.encodeFunctionResult("isPaused", [options.paused ?? false])),
    returned("boring-lock", TELLER_INTERFACE.encodeFunctionResult("shareLockPeriod", [0n])),
  ]);
}
function completeResults(options: { hook?: string; accountantVault?: string; asset?: string; shareDecimals?: bigint } = {}) {
  return Object.freeze([
    returned("boring-vault-code", VAULT_CODE),
    returned("boring-accountant-code", ACCOUNTANT_CODE),
    returned("boring-authority", VAULT_INTERFACE.encodeFunctionResult("authority", [EXECUTOR])),
    returned("boring-hook", VAULT_INTERFACE.encodeFunctionResult("hook", [options.hook ?? TELLER])),
    returned("boring-accountant-vault", ACCOUNTANT_INTERFACE.encodeFunctionResult("vault", [options.accountantVault ?? VAULT])),
    returned("boring-base", ACCOUNTANT_INTERFACE.encodeFunctionResult("base", [options.asset ?? ASSET])),
    returned("boring-share-decimals", ERC20_INTERFACE.encodeFunctionResult("decimals", [options.shareDecimals ?? 18n])),
  ]);
}
const handwrittenVariant = handwritten.identity.variants[0]!;
const declaredVariant = plugin.identity.variants[0]!;
function bothDecode(step: number, evidence: unknown, results: readonly unknown[]) {
  const input = { candidate: CANDIDATE, ...(evidence === undefined ? {} : { evidence }), step };
  const declared = declaredVariant.decode({ step: input as never, results: results as never });
  const original = handwrittenVariant.decode({ step: input as never, results: results as never });
  assert.deepEqual(declared, original, `identity decode step ${step} differs`);
  return declared as Record<string, any>;
}
function bothRequests(step: number, evidence: unknown) {
  const input = { candidate: CANDIDATE, ...(evidence === undefined ? {} : { evidence }), step };
  const declared = declaredVariant.buildRequests(input as never);
  const original = handwrittenVariant.buildRequests(input as never);
  assert.deepEqual(declared, original, `identity requests step ${step} differs`);
  assert.deepEqual(declaredVariant.requirements(input as never), handwrittenVariant.requirements(input as never));
  return declared;
}
function bothDecide(step: number, evidence: unknown) {
  const declared = declaredVariant.decide({ candidate: CANDIDATE, evidence, step } as never);
  const original = handwrittenVariant.decide({ candidate: CANDIDATE, evidence, step } as never);
  assert.deepEqual(declared, original, `identity decision step ${step} differs`);
  return declared as Record<string, any>;
}

const baseRequests = bothRequests(0, undefined);
assert.equal(baseRequests.length, 5);
const baseEvidence = bothDecode(0, undefined, baseResults());
assert.equal(baseEvidence.phase, "base");
assert.deepEqual(bothDecide(0, baseEvidence), { status: "continue" });
assert.throws(() => bothDecode(0, undefined, baseResults({ paused: true })), /paused/);
const completeRequests = bothRequests(1, baseEvidence);
assert.equal(completeRequests.length, 7);
const completeEvidence = bothDecode(1, baseEvidence, completeResults());
assert.equal(completeEvidence.phase, "complete");
assert.equal(completeEvidence.asset, ASSET);
assert.equal(completeEvidence.shareDecimals, 18);
const verified = bothDecide(1, completeEvidence);
assert.equal(verified.status, "verified");
const identity = verified.identity as Record<string, any>;
assert.equal(identity.teller, TELLER);
assert.equal(identity.vault, VAULT);
assert.equal(identity.accountant, ACCOUNTANT);
assert.equal(identity.asset, ASSET);
assert.equal(identity.shareLockPeriod, 0n);
assert.equal(identity.tellerCodeHash, ethers.keccak256(TELLER_CODE));
assert.throws(() => bothDecode(1, baseEvidence, completeResults({ hook: VAULT })), /hook is not the Teller/);
assert.throws(() => bothDecode(1, baseEvidence, completeResults({ accountantVault: TELLER })), /accountant vault mismatch/);
assert.throws(() => bothDecode(1, baseEvidence, completeResults({ shareDecimals: 37n })), /share decimals out of range/);
// a false behavior flag is a chain-proven rejection.
assert.deepEqual(bothDecide(1, { ...completeEvidence, behaviorValid: false }), {
  status: "chain-proven-rejected",
  reasonCode: "boring_vault_withdraw_unavailable",
  evidenceRequestIds: ["boring-complete"],
});

// 5. Instance + route parity.
const descriptor = plugin.instance.compileDraft(identity as never);
const originalDescriptor = handwritten.instance.compileDraft(identity as never);
assert.deepEqual(descriptor, originalDescriptor);
const routes = plugin.routes.project({ descriptor });
const originalRoutes = handwritten.routes.project({ descriptor: originalDescriptor });
assert.deepEqual(routes, originalRoutes);
assert.equal(plugin.instance.instanceKey(identity as never), handwritten.instance.instanceKey(identity as never));
assert.deepEqual(plugin.instance.staticBindingProjection(descriptor), handwritten.instance.staticBindingProjection(originalDescriptor));
assert.deepEqual(plugin.routes.projectGraph({ descriptor, route: routes[0] }),
  handwritten.routes.projectGraph({ descriptor: originalDescriptor, route: originalRoutes[0] }));
assert.deepEqual(plugin.execution.expectedEffects({ descriptor, route: routes[0] }),
  handwritten.execution.expectedEffects({ descriptor: originalDescriptor, route: originalRoutes[0] }));

// 6. Pricing parity (rate read + declared conversion, per-route state group).
const declaredPricing = plugin.pricing;
const originalPricing = handwritten.pricing;
assert.equal(declaredPricing.refreshPolicyForInstance!({ descriptor }), "on-touch");
assert.deepEqual(declaredPricing.staticBindingProjection({ descriptor }), originalPricing.staticBindingProjection({ descriptor: originalDescriptor }));
assert.deepEqual(declaredPricing.snapshotCompatibilityProjection({ descriptor }), originalPricing.snapshotCompatibilityProjection({ descriptor: originalDescriptor }));
const originalDraft = originalPricing.compileDraft({ descriptor: originalDescriptor, stateKey: originalDescriptor.instanceKey, routes: originalRoutes });
const draft = declaredPricing.compileDraft({ descriptor, stateKey: descriptor.instanceKey, routes });
const { routes: draftRoutes, ...draftCore } = draft as Record<string, any>;
assert.deepEqual(draftRoutes, routes);
assert.deepEqual(draftCore, originalDraft);
const staticEvidence = declaredPricing.staticEvidence.decode({ programInput: draft, results: [] as never });
assert.deepEqual(staticEvidence, {});
const pricingDescriptor = declaredPricing.finalizePricingDescriptor({ draft, staticEvidence } as never);
const originalPricingDescriptor = originalPricing.finalizePricingDescriptor({ draft: originalDraft, staticEvidence } as never);
assert.deepEqual({ ...pricingDescriptor, routes: undefined }, { ...originalPricingDescriptor, routes: undefined });

const pricingInput = { descriptor: pricingDescriptor, routes, source: SOURCE };
const currentRequests = declaredPricing.current.buildRequests(pricingInput as never);
assert.deepEqual(currentRequests, originalPricing.current.buildRequests({ descriptor: originalPricingDescriptor, routes, source: SOURCE } as never));
assert.deepEqual(declaredPricing.current.requirements(pricingInput as never), originalPricing.current.requirements({ descriptor: originalPricingDescriptor, routes, source: SOURCE } as never));
const rateResults = [returned("boring-rate", ACCOUNTANT_INTERFACE.encodeFunctionResult("getRateInQuoteSafe", [RATE]))];
const snapshot = declaredPricing.current.decodeSnapshot({ descriptor: pricingDescriptor, initialResults: rateResults as never, dependentEvidence: [] } as never);
const originalSnapshot = originalPricing.current.decodeSnapshot({ descriptor: originalPricingDescriptor, initialResults: rateResults as never });
assert.deepEqual(snapshot, originalSnapshot);
assert.equal((snapshot as any).rate, RATE);
assert.equal((snapshot as any).quotes[routes[0]!.routeKey]!.amountOut, withdrawOut({ shares: 10n ** 18n, rate: RATE, shareDecimals: 18 }));
assert.equal((snapshot as any).quotes[routes[0]!.routeKey]!.amountIn, 10n ** 18n);
assert.deepEqual([...declaredPricing.current.deriveMids({ descriptor: pricingDescriptor, snapshot, routes })],
  [...originalPricing.current.deriveMids({ descriptor: originalPricingDescriptor, snapshot: originalSnapshot, routes: originalRoutes })]);
assert.deepEqual([...declaredPricing.current.classifyUnavailable!({ descriptor: pricingDescriptor, snapshot, routes })],
  [...originalPricing.current.classifyUnavailable!({ descriptor: originalPricingDescriptor, snapshot: originalSnapshot, routes: originalRoutes })]);
// zero rate: no quote, route classified unavailable, no mid.
const zeroRateSnapshot = declaredPricing.current.decodeSnapshot({
  descriptor: pricingDescriptor,
  initialResults: [returned("boring-rate", ACCOUNTANT_INTERFACE.encodeFunctionResult("getRateInQuoteSafe", [0n]))] as never,
  dependentEvidence: [],
} as never);
const originalZeroSnapshot = originalPricing.current.decodeSnapshot({ descriptor: originalPricingDescriptor,
  initialResults: [returned("boring-rate", ACCOUNTANT_INTERFACE.encodeFunctionResult("getRateInQuoteSafe", [0n]))] as never });
assert.deepEqual(zeroRateSnapshot, originalZeroSnapshot);
assert.deepEqual([...declaredPricing.current.classifyUnavailable!({ descriptor: pricingDescriptor, snapshot: zeroRateSnapshot, routes })],
  [...originalPricing.current.classifyUnavailable!({ descriptor: originalPricingDescriptor, snapshot: originalZeroSnapshot, routes: originalRoutes })]);
assert.equal([...declaredPricing.current.deriveMids({ descriptor: pricingDescriptor, snapshot: zeroRateSnapshot, routes })].length, 0);
// the sample equals ONE_SHARE, so a positive rate always quotes the rate
// itself; a zero rate is the only unavailable direction.
assert.equal([...declaredPricing.current.classifyUnavailable!({ descriptor: pricingDescriptor, snapshot, routes })].length, 0);
assert.deepEqual([...declaredPricing.dependencies({ descriptor: pricingDescriptor })].sort(),
  [...originalPricing.dependencies({ descriptor: originalDescriptor })].sort());
const mutationEntries = [{ descriptor: pricingDescriptor, routes, dependencies: declaredPricing.dependencies({ descriptor: pricingDescriptor }), stateKey: descriptor.instanceKey }];
const declaredMutation = declaredPricing.mutation!.compile!({ entries: mutationEntries as never });
const originalMutation = originalPricing.mutation!.compile!({ entries: [{ descriptor: originalDescriptor, routes: originalRoutes,
  dependencies: originalPricing.dependencies({ descriptor: originalDescriptor }), stateKey: originalDescriptor.instanceKey }] as never });
for (const observation of [
  { kind: "log", address: TELLER.toLowerCase() },
  { kind: "log", address: VAULT.toLowerCase() },
  { kind: "log", address: ACCOUNTANT.toLowerCase() },
  { kind: "log", address: ASSET.toLowerCase() },
  { kind: "log", address: EXECUTOR.toLowerCase() },
] as const) {
  assert.deepEqual(declaredMutation.affectedStateKeys({ observation: observation as never }),
    originalMutation.affectedStateKeys({ observation: observation as never }), JSON.stringify(observation));
  assert.deepEqual(declaredPricing.mutation!.affectedStateKeys!({ descriptor: pricingDescriptor, routes, observation: observation as never }),
    declaredMutation.affectedStateKeys({ observation: observation as never }));
}

// 7. Exact parity (accountant rate + declared conversion).
const exactInput = { descriptor, route: routes[0], amountIn: SHARES, source: SOURCE, executor: EXECUTOR };
const declaredMethods = plugin.exact.methods(exactInput as never);
const declaredMethod = declaredMethods.find(method => method.id === "boring-vault-withdraw") as any;
const originalMethod = handwritten.exact.methods(exactInput as never).find(method => method.id === "boring-vault-withdraw") as any;
assert(declaredMethod && originalMethod);
assert.equal(declaredMethod.chainAmountQuote, undefined);
assert.equal(declaredMethod.trialState.unsupportedReason,
  "boring vault quotes read the accountant rate per quote; no sequential trial overlay is modeled");
assert.deepEqual(declaredMethod.program.requirements(exactInput), originalMethod.program.requirements(exactInput));
assert.deepEqual(declaredMethod.program.buildRequests(exactInput), originalMethod.program.buildRequests(exactInput));
const exactQuote = declaredMethod.program.decode({ programInput: exactInput, initialResults: rateResults as never, dependentEvidence: [] });
const originalQuote = originalMethod.program.decode({ programInput: exactInput, initialResults: rateResults as never });
assert.deepEqual(exactQuote, originalQuote);
assert.equal(exactQuote.amountOut, OUT);
assert.equal(exactQuote.evidence.executor, EXECUTOR);
assert.throws(() => declaredMethod.program.decode({ programInput: exactInput,
  initialResults: [returned("boring-rate", ACCOUNTANT_INTERFACE.encodeFunctionResult("getRateInQuoteSafe", [0n]))] as never,
  dependentEvidence: [] }), /amounts out of range/);
const localZero = declaredMethods.find(method => method.id === "local-zero") as any;
assert.throws(() => localZero.quote({ ...exactInput, amountIn: 0n }), /out of range/);

// 8. Execution parity: no approval, exact share amount, receiver, min receipt.
const fragment = plugin.execution.buildFragment({ ...exactInput, minAmountOut: 0n, quotedAmountOut: OUT, exactEvidence: exactQuote.evidence } as never);
assert.deepEqual(fragment.requirements, []);
assert.equal(fragment.nodes[0]!.target, TELLER);
assert.equal(fragment.nodes[0]!.tokenIn, VAULT);
assert.equal(fragment.nodes[0]!.tokenOut, ASSET);
assert.equal(fragment.nodes[0]!.amount, SHARES);
assert.throws(() => plugin.execution.buildFragment({ ...exactInput, minAmountOut: 0n, quotedAmountOut: OUT,
  exactEvidence: { ...exactQuote.evidence, amountOut: OUT + 1n } } as never));
const declaredLeg = plugin.execution.buildRuntimeLeg({ ...exactInput, transactionOrigin: EXECUTOR, runtimeEvidence: [] } as never)!;
const originalLeg = handwritten.execution.buildRuntimeLeg({ ...exactInput, transactionOrigin: EXECUTOR, runtimeEvidence: [] } as never)!;
assert.equal(declaredLeg.actionAdapterId, originalLeg.actionAdapterId);
assert.deepEqual(declaredLeg.settlement, originalLeg.settlement);
function sharesAfter(program: string, amount: bigint, receiver: string, receipt: bigint) {
  let swapped = false;
  return inspectRuntime(program, amount, {
    nativeBalance: () => 0n,
    call(call) {
      const selector = call.data.slice(0, 10);
      if (selector === "0x70a08231") {
        const token = call.target.toLowerCase();
        return word(swapped ? (token === ASSET.toLowerCase() ? receipt : 0n) : (token === VAULT.toLowerCase() ? amount : 0n));
      }
      if (selector === "0x095ea7b3") throw new Error("boring vault execution must not approve");
      if (selector === TELLER_INTERFACE.getFunction("bulkWithdraw")!.selector) {
        swapped = true;
        return TELLER_INTERFACE.encodeFunctionResult("bulkWithdraw", []);
      }
      throw new Error(`unexpected call ${selector}`);
    },
  });
}
const noApproval = sharesAfter(declaredLeg.program, SHARES, EXECUTOR, SHARES);
assert.equal(noApproval.allowances.length, 0);
const bulkCalls = noApproval.calls.filter(call => call.data.slice(0, 10) === TELLER_INTERFACE.getFunction("bulkWithdraw")!.selector);
assert.equal(bulkCalls.length, 1);
const decoded = TELLER_INTERFACE.decodeFunctionData("bulkWithdraw", bulkCalls[0]!.data);
assert.equal(decoded[0], ASSET);
assert.equal(decoded[1], SHARES);
assert.equal(decoded[2], 0n);
assert.equal(decoded[3], EXECUTOR);
// direct-output settlement pays the settlement recipient.
const recipient = ethers.getAddress("0x10000000000000000000000000000000000000ff");
const settledLeg = plugin.execution.buildRuntimeLeg({ ...exactInput, transactionOrigin: EXECUTOR,
  runtimeEvidence: [], settlement: { kind: "direct-output", recipient } } as never)!;
const settledCalls = sharesAfter(settledLeg.program, SHARES, recipient, SHARES).calls
  .filter(call => call.data.slice(0, 10) === TELLER_INTERFACE.getFunction("bulkWithdraw")!.selector);
assert.equal(TELLER_INTERFACE.decodeFunctionData("bulkWithdraw", settledCalls[0]!.data)[3], recipient);
// deferred-input settlement is unsupported (the Family only declares direct output).
assert.equal(plugin.execution.buildRuntimeLeg({ ...exactInput, transactionOrigin: EXECUTOR, runtimeEvidence: [],
  settlement: { kind: "deferred-input", recipient: EXECUTOR } } as never), null);

console.log("boring-vault-teller declarative validation PASS");
