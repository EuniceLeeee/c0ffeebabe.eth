import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ethers } from "ethers";
import { renderDeclarativeProductionEntry } from "../src/searcher/build-declarative-production.js";
import { createDeclarativeProtocolRuntime } from "../src/searcher/venues/declarative-protocol.js";
import { declarativeMathRegistry } from "../src/searcher/venues/declarative-math-models.js";
import { declarativeRuntimeMathRegistry } from "../src/searcher/venues/declarative-runtime-math-models.js";
import { defineProtocolFamily, definedFamilyPluginContractSummary } from "../src/searcher/venues/adapter-family-plugin.js";
import { inspectRuntime } from "../src/searcher/test/runtime-program-testkit.js";
import {
  DEFAULT_COLLATERAL_ASSET, DEFAULT_COLLATERAL_ASSET_CODE_HASH, DEFAULT_COLLATERAL_INTERFACE,
  DEFAULT_COLLATERAL_IMPLEMENTATION, DEFAULT_COLLATERAL_IMPLEMENTATION_CODE_HASH,
  DEFAULT_COLLATERAL_PROBE_RECEIVER, DEFAULT_COLLATERAL_SHARE_CODE_HASH, DEFAULT_COLLATERAL_SHARE_VAULT,
  DEFAULT_COLLATERAL_TRANSFER_TOPIC, DEFAULT_COLLATERAL_WITHDRAW_TOPIC, defaultCollateralCloneCode,
  eip1167Implementation,
} from "../src/searcher/venues/protocols/default-collateral-family/codec.js";
import { IMPLEMENTATION_CODE, ASSET_CODE } from "../src/searcher/venues/protocols/default-collateral-family/test/bytecode.js";
import { plugin as handwritten } from "../src/searcher/venues/production-families/default-collateral.production.js";

const ROOT = new URL("..", import.meta.url).pathname;
const definitionFile = `${ROOT}src/searcher/venues/protocols/default-collateral-family/default-collateral.json`;
const document = JSON.parse(readFileSync(definitionFile, "utf8"));

// 1. Production entry rendering (in memory; never written).
const rendered = renderDeclarativeProductionEntry({ rootDirectory: ROOT, definitionFile, document });
assert.equal(rendered.format, "protocol-json-v2");
assert.equal(rendered.familyId, "protocol:default-collateral");
assert.deepEqual([...rendered.ownedActionAdapterIds], ["default-collateral-withdraw"]);
assert.match(rendered.source, /SEARCHER_FAMILY_DEFAULT_COLLATERAL_ENABLED/);

// 2. Strict runtime compilation; activation stays disabled by default.
const runtime = createDeclarativeProtocolRuntime(document, [], {
  math: declarativeMathRegistry, executionMath: declarativeRuntimeMathRegistry,
});
const plugin = defineProtocolFamily(runtime.definition as never);
const summary = definedFamilyPluginContractSummary(plugin);
assert.equal(String(summary.familyId), "protocol:default-collateral");
assert.equal(plugin.protocol.activeBehaviorProof, "required");
for (const row of runtime.moduleCoverage[0]!.modules) {
  if (["math", "quoteFlow", "pricingFlow"].includes(row.key)) assert.equal(row.state, "compiled", row.key);
}
assert.deepEqual(plugin.manifest.allowedTaxonomy, handwritten.manifest.allowedTaxonomy);
assert.deepEqual([...plugin.manifest.ownedActionAdapterIds], [...handwritten.manifest.ownedActionAdapterIds]);
assert.deepEqual([...plugin.manifest.requiredInfraActionAdapterIds], [...handwritten.manifest.requiredInfraActionAdapterIds]);
assert.deepEqual([...plugin.manifest.supportedLineages], [...handwritten.manifest.supportedLineages]);
const activation = JSON.parse(readFileSync(definitionFile, "utf8")).production.activation;
assert.equal(activation.enabled, false);

// 3. Fixtures: verified deployment runtimes at N=26244778.
const SOURCE = Object.freeze({ number: 26_244_778, hash: "0x4d8e7ee76e1d7ce145a752ae4185056d13c83f3b1de57fffe0a1282ef8c39646", generation: 26_244_778 });
const PROVENANCE = Object.freeze({ kind: "test-transport", fingerprint: `0x${"11".repeat(32)}` });
const SUPPLY = 59_297_263_277_881_699_980n;
const PROBE_ACTOR = "0x000000000000000000000000000000000000bee2";
const EXECUTOR = ethers.getAddress("0x10000000000000000000000000000000000000ee");
const CLONE_CODE = defaultCollateralCloneCode(DEFAULT_COLLATERAL_IMPLEMENTATION);
assert.equal(ethers.keccak256(CLONE_CODE), DEFAULT_COLLATERAL_SHARE_CODE_HASH);
assert.equal(ethers.keccak256(IMPLEMENTATION_CODE), DEFAULT_COLLATERAL_IMPLEMENTATION_CODE_HASH);
assert.equal(ethers.keccak256(ASSET_CODE), DEFAULT_COLLATERAL_ASSET_CODE_HASH);
assert.equal(eip1167Implementation(CLONE_CODE), DEFAULT_COLLATERAL_IMPLEMENTATION);
const CANDIDATE = Object.freeze({ candidateKind: "default-collateral-share-vault", vault: DEFAULT_COLLATERAL_SHARE_VAULT });

function returned(id: string, data: string, effects?: unknown) {
  return Object.freeze({ id, ok: true as const, source: SOURCE, provenance: PROVENANCE, completion: "returned" as const, data,
    ...(effects === undefined ? {} : { effects }) });
}
function reverted(id: string, data = "0x") {
  return Object.freeze({ id, ok: true as const, source: SOURCE, provenance: PROVENANCE, completion: "reverted-as-declared" as const, data });
}
const word = (value: bigint) => `0x${value.toString(16).padStart(64, "0")}`;
const padded = (address: string) => `0x${"0".repeat(24)}${ethers.getAddress(address).slice(2)}`.toLowerCase();
const ZERO_TOPIC = `0x${"0".repeat(64)}`;

function baseResults(options: { code?: string; asset?: string; decimals?: bigint; supply?: bigint; revert?: "asset" | "decimals" | "supply" } = {}) {
  return Object.freeze([
    returned("base-share-code", options.code ?? CLONE_CODE),
    options.revert === "asset" ? reverted("base-asset")
      : returned("base-asset", DEFAULT_COLLATERAL_INTERFACE.encodeFunctionResult("asset", [options.asset ?? DEFAULT_COLLATERAL_ASSET])),
    options.revert === "decimals" ? reverted("base-decimals")
      : returned("base-decimals", DEFAULT_COLLATERAL_INTERFACE.encodeFunctionResult("decimals", [options.decimals ?? 18n])),
    options.revert === "supply" ? reverted("base-total-supply")
      : returned("base-total-supply", DEFAULT_COLLATERAL_INTERFACE.encodeFunctionResult("totalSupply", [options.supply ?? SUPPLY])),
  ]);
}
function surfaceResults(options: { implementationCode?: string; assetCode?: string; backing?: bigint; revertBacking?: boolean } = {}) {
  return Object.freeze([
    returned("surface-implementation-code", options.implementationCode ?? IMPLEMENTATION_CODE),
    returned("surface-asset-code", options.assetCode ?? ASSET_CODE),
    options.revertBacking ? reverted("surface-backing")
      : returned("surface-backing", DEFAULT_COLLATERAL_INTERFACE.encodeFunctionResult("balanceOf", [options.backing ?? SUPPLY])),
  ]);
}
function behaviorSample(evidence: { readonly totalSupply: bigint }) {
  const sample = 10n ** 18n < evidence.totalSupply ? 10n ** 18n : evidence.totalSupply / 1000n;
  return sample > 0n ? sample : 0n;
}
function burnEffects(sample: bigint, receipt: bigint) {
  return {
    tokenDeltas: [{ token: DEFAULT_COLLATERAL_ASSET, account: DEFAULT_COLLATERAL_PROBE_RECEIVER, delta: receipt }],
    totalSupplyDeltas: [{ token: DEFAULT_COLLATERAL_SHARE_VAULT, delta: -sample }],
    logs: [
      { address: DEFAULT_COLLATERAL_SHARE_VAULT,
        topics: [DEFAULT_COLLATERAL_TRANSFER_TOPIC, padded(PROBE_ACTOR), ZERO_TOPIC],
        data: word(sample) },
      { address: DEFAULT_COLLATERAL_SHARE_VAULT,
        topics: [DEFAULT_COLLATERAL_WITHDRAW_TOPIC, padded(DEFAULT_COLLATERAL_PROBE_RECEIVER), padded(PROBE_ACTOR)],
        data: word(sample) },
    ],
  };
}
function activeResults(evidence: { readonly totalSupply: bigint }, receipt?: bigint) {
  const sample = behaviorSample(evidence);
  return Object.freeze([returned("active-withdraw", "0x", burnEffects(sample, receipt ?? sample))]);
}

// 4. Identity parity across base, surface and active phases.
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
assert.equal(baseRequests.length, 4);
assert.equal(baseRequests[1]!.completion, "return-or-revert-data");
const baseEvidence = bothDecode(0, undefined, baseResults());
assert.equal(baseEvidence.phase, "base");
assert.equal(baseEvidence.shareIsClone, true);
assert.equal(baseEvidence.baseValid, true);
assert.deepEqual(bothDecide(0, baseEvidence), { status: "continue" });

// negative base evidence: non-clone runtime, reverted views, wrong facts.
const nonClone = bothDecode(0, undefined, baseResults({ code: ASSET_CODE }));
assert.equal(nonClone.shareIsClone, false);
assert.equal(bothDecide(0, nonClone).status, "chain-proven-rejected");
assert.equal(bothDecide(0, nonClone).reasonCode, "default_collateral_not_eip1167_clone");
for (const [options, reason] of [
  [{ revert: "asset" }, "default_collateral_asset_unavailable"],
  [{ revert: "decimals" }, "default_collateral_asset_unavailable"],
  [{ revert: "supply" }, "default_collateral_asset_unavailable"],
  [{ asset: ethers.ZeroAddress }, "default_collateral_asset_unavailable"],
  [{ asset: DEFAULT_COLLATERAL_SHARE_VAULT }, "default_collateral_asset_aliases_vault"],
  [{ decimals: 17n }, "default_collateral_decimals_mismatch"],
  [{ supply: 0n }, "default_collateral_supply_empty"],
] as const) {
  const evidence = bothDecode(0, undefined, baseResults(options as never));
  const decision = bothDecide(0, evidence);
  assert.equal(decision.status, "chain-proven-rejected", JSON.stringify(options, (_key, value) => typeof value === "bigint" ? value.toString() : value));
  assert.equal(decision.reasonCode, reason, JSON.stringify(options, (_key, value) => typeof value === "bigint" ? value.toString() : value));
}

const surfaceRequests = bothRequests(1, baseEvidence);
assert.equal(surfaceRequests.length, 3);
const surfaceEvidence = bothDecode(1, baseEvidence, surfaceResults());
assert.equal(surfaceEvidence.phase, "surface");
assert.equal(surfaceEvidence.invariantProven, true);
assert.deepEqual(bothDecide(1, surfaceEvidence), { status: "continue" });
for (const [options, expected] of [
  [{ implementationCode: ASSET_CODE }, { status: "chain-proven-rejected", reasonCode: "default_collateral_implementation_code_mismatch" }],
  [{ assetCode: IMPLEMENTATION_CODE }, { status: "chain-proven-rejected", reasonCode: "default_collateral_asset_code_mismatch" }],
  [{ revertBacking: true }, { status: "retryable", reasonCode: "default_collateral_backing_unavailable" }],
  [{ backing: 0n }, { status: "retryable", reasonCode: "default_collateral_backing_unavailable" }],
  [{ backing: SUPPLY + 1n }, { status: "retryable", reasonCode: "default_collateral_backing_not_one_to_one" }],
] as const) {
  const evidence = bothDecode(1, baseEvidence, surfaceResults(options as never));
  const decision = bothDecide(1, evidence);
  assert.equal(decision.status, expected.status, JSON.stringify(options, (_key, value) => typeof value === "bigint" ? value.toString() : value));
  assert.equal(decision.reasonCode, expected.reasonCode, JSON.stringify(options, (_key, value) => typeof value === "bigint" ? value.toString() : value));
}
// a changed clone hash is a chain-proven rejection at the surface decision.
const changedClone = bothDecode(0, undefined, baseResults({ code: `0x${"6001600055".repeat(9)}` }));
assert.equal(bothDecide(0, changedClone).status, "chain-proven-rejected");

const activeRequests = bothRequests(2, surfaceEvidence);
assert.equal(activeRequests.length, 1);
assert.equal(activeRequests[0]!.kind, "effect-delta-simulation");
assert.equal(activeRequests[0]!.required, false);
const activeEvidence = bothDecode(2, surfaceEvidence, activeResults(surfaceEvidence));
assert.equal(activeEvidence.phase, "active");
assert.equal(activeEvidence.sampleShares, 10n ** 18n);
assert.equal(activeEvidence.assetReceipt, 10n ** 18n);
assert.equal(activeEvidence.supplyBurn, 10n ** 18n);
assert.equal(activeEvidence.behaviorValid, true);
const verified = bothDecide(2, activeEvidence);
assert.equal(verified.status, "verified");
const identity = verified.identity as Record<string, any>;
assert.equal(identity.vault, DEFAULT_COLLATERAL_SHARE_VAULT);
assert.equal(identity.share, DEFAULT_COLLATERAL_SHARE_VAULT);
assert.equal(identity.asset, DEFAULT_COLLATERAL_ASSET);
assert.equal(identity.implementation, DEFAULT_COLLATERAL_IMPLEMENTATION);
assert.equal(identity.oneToOne, true);
assert.equal(identity.decimals, 18n);
// an under-delivering receipt fails the effect proof and is retryable.
const shortEvidence = bothDecode(2, surfaceEvidence, activeResults(surfaceEvidence, 10n ** 18n - 1n));
assert.equal(shortEvidence.behaviorValid, false);
assert.deepEqual(bothDecide(2, shortEvidence), { status: "retryable", reasonCode: "default_collateral_withdraw_behavior_not_proven" });
// a missing simulation result throws in both implementations.
assert.throws(() => bothDecode(2, surfaceEvidence, []), /missing/);

// 5. Instance + route projection parity.
const descriptor = plugin.instance.compileDraft(identity as never);
const originalDescriptor = handwritten.instance.compileDraft(identity as never);
assert.deepEqual(descriptor, originalDescriptor);
const routes = plugin.routes.project({ descriptor });
const originalRoutes = handwritten.routes.project({ descriptor: originalDescriptor });
assert.equal(routes.length, 1);
assert.deepEqual({ ...routes[0]!, direction: undefined }, { ...originalRoutes[0]!, direction: undefined });
assert.equal(routes[0]!.routeKey, originalRoutes[0]!.routeKey);
assert.equal(plugin.instance.instanceKey(identity as never), handwritten.instance.instanceKey(identity as never));
assert.deepEqual(plugin.instance.staticBindingProjection(descriptor), handwritten.instance.staticBindingProjection(originalDescriptor));
assert.deepEqual(plugin.routes.projectGraph({ descriptor, route: routes[0] }),
  handwritten.routes.projectGraph({ descriptor: originalDescriptor, route: originalRoutes[0]! }));
assert.deepEqual(plugin.execution.expectedEffects({ descriptor, route: routes[0] }),
  handwritten.execution.expectedEffects({ descriptor: originalDescriptor, route: originalRoutes[0]! }));
// the verified descriptor assertions fail closed for a foreign asset.
assert.throws(() => plugin.routes.projectGraph({ descriptor: { ...descriptor, asset: DEFAULT_COLLATERAL_SHARE_VAULT }, route: routes[0] }));

// 6. Pricing parity: supply/backing snapshot, unavailable reasons, mids.
const declaredPricing = plugin.pricing;
const originalPricing = handwritten.pricing;
assert.equal(declaredPricing.refreshPolicyForInstance!({ descriptor }), "each-block");
assert.deepEqual(declaredPricing.staticBindingProjection({ descriptor }), originalPricing.staticBindingProjection({ descriptor: originalDescriptor }));
assert.deepEqual(declaredPricing.snapshotCompatibilityProjection({ descriptor }), originalPricing.snapshotCompatibilityProjection({ descriptor: originalDescriptor }));
const originalDraft = originalPricing.compileDraft({ descriptor: originalDescriptor, stateKey: originalDescriptor.instanceKey, routes: originalRoutes });
const draft = declaredPricing.compileDraft({ descriptor, stateKey: descriptor.instanceKey, routes });
assert.deepEqual({ ...(draft as Record<string, any>), routes: (draft as any).routes.map(({ direction: _direction, ...route }: Record<string, any>) => route) }, originalDraft);
const staticEvidence = declaredPricing.staticEvidence.decode({ programInput: draft, results: [] as never });
assert.deepEqual(staticEvidence, {});
const pricingDescriptor = declaredPricing.finalizePricingDescriptor({ draft, staticEvidence } as never);
const originalPricingDescriptor = originalPricing.finalizePricingDescriptor({ draft: originalDraft, staticEvidence } as never);
assert.deepEqual({ ...(pricingDescriptor as Record<string, any>), routes: (pricingDescriptor as any).routes.map(({ direction: _direction, ...route }: Record<string, any>) => route) }, originalPricingDescriptor);
const pricingInput = { descriptor: pricingDescriptor, routes, source: SOURCE };
const currentRequests = declaredPricing.current.buildRequests(pricingInput as never);
assert.deepEqual(currentRequests, originalPricing.current.buildRequests({ descriptor: originalPricingDescriptor, routes: originalRoutes, source: SOURCE } as never));
assert.deepEqual(declaredPricing.current.requirements(pricingInput as never), originalPricing.current.requirements({ descriptor: originalPricingDescriptor, routes: originalRoutes, source: SOURCE } as never));

function currentResults(options: { asset?: string; supply?: bigint; backing?: bigint; revertAsset?: boolean; revertSupply?: boolean; revertBacking?: boolean } = {}) {
  return Object.freeze([
    options.revertAsset ? reverted("current-asset")
      : returned("current-asset", DEFAULT_COLLATERAL_INTERFACE.encodeFunctionResult("asset", [options.asset ?? DEFAULT_COLLATERAL_ASSET])),
    options.revertSupply ? reverted("current-total-supply")
      : returned("current-total-supply", DEFAULT_COLLATERAL_INTERFACE.encodeFunctionResult("totalSupply", [options.supply ?? SUPPLY])),
    options.revertBacking ? reverted("current-backing")
      : returned("current-backing", DEFAULT_COLLATERAL_INTERFACE.encodeFunctionResult("balanceOf", [options.backing ?? SUPPLY])),
  ]);
}
for (const options of [
  {},
  { asset: DEFAULT_COLLATERAL_SHARE_VAULT },
  { revertAsset: true },
  { revertSupply: true },
  { revertBacking: true },
  { supply: 0n, backing: 0n },
  { backing: 0n },
  { backing: SUPPLY + 1n },
  { supply: 10n ** 18n - 1n, backing: 10n ** 18n - 1n },
] as const) {
  const results = currentResults(options as never);
  const snapshot = declaredPricing.current.decodeSnapshot({ descriptor: pricingDescriptor, initialResults: results as never, dependentEvidence: [] } as never);
  const originalSnapshot = originalPricing.current.decodeSnapshot({ descriptor: originalPricingDescriptor, initialResults: results as never });
  assert.deepEqual(snapshot, originalSnapshot, JSON.stringify(options, (_key, value) => typeof value === "bigint" ? value.toString() : value));
  const unavailable = [...declaredPricing.current.classifyUnavailable!({ descriptor: pricingDescriptor, snapshot, routes })];
  assert.deepEqual(unavailable, [...originalPricing.current.classifyUnavailable!({ descriptor: originalPricingDescriptor, snapshot: originalSnapshot, routes: originalRoutes })]);
  const mids = [...declaredPricing.current.deriveMids({ descriptor: pricingDescriptor, snapshot, routes })];
  const originalMids = [...originalPricing.current.deriveMids({ descriptor: originalPricingDescriptor, snapshot: originalSnapshot, routes: originalRoutes })];
  assert.deepEqual(mids.map(([key, mid]) => [key, mid.mid]), originalMids.map(([key, mid]) => [key, mid.mid]), JSON.stringify(options, (_key, value) => typeof value === "bigint" ? value.toString() : value));
  if (Object.keys((snapshot as any).quotes).length === 0) assert.equal(mids.length, 0);
}
assert.deepEqual([...declaredPricing.dependencies({ descriptor: pricingDescriptor })].sort(),
  [...originalPricing.dependencies({ descriptor: originalDescriptor })].sort());
const mutationEntries = [{ descriptor: pricingDescriptor, routes, dependencies: declaredPricing.dependencies({ descriptor: pricingDescriptor }), stateKey: descriptor.instanceKey }];
const declaredMutation = declaredPricing.mutation!.compile!({ entries: mutationEntries as never });
const originalMutation = originalPricing.mutation!.compile!({ entries: [{ descriptor: originalDescriptor, routes: originalRoutes,
  dependencies: originalPricing.dependencies({ descriptor: originalDescriptor }), stateKey: originalDescriptor.instanceKey }] as never });
for (const observation of [
  { kind: "log", address: DEFAULT_COLLATERAL_SHARE_VAULT },
  { kind: "log", address: DEFAULT_COLLATERAL_ASSET },
  { kind: "call", target: DEFAULT_COLLATERAL_SHARE_VAULT, selector: "0xf3fef3a3" },
  { kind: "call", target: DEFAULT_COLLATERAL_ASSET, selector: "0x12345678" },
  { kind: "log", address: EXECUTOR },
] as const) {
  assert.deepEqual(declaredMutation.affectedStateKeys({ observation: observation as never }),
    originalMutation.affectedStateKeys({ observation: observation as never }), JSON.stringify(observation));
  assert.deepEqual(declaredPricing.mutation!.affectedStateKeys!({ descriptor: pricingDescriptor, routes, observation: observation as never }),
    declaredMutation.affectedStateKeys({ observation: observation as never }));
}

// 7. Exact parity: same-state supply/backing reads and retained read proof.
const exactInput = { descriptor, route: routes[0], amountIn: 5_000_000_000_000_000n, source: SOURCE, executor: EXECUTOR };
const declaredMethods = plugin.exact.methods(exactInput as never);
const declaredMethod = declaredMethods.find(method => method.id === "default-collateral-backing-quote") as any;
const originalMethod = handwritten.exact.methods(exactInput as never).find(method => method.id === "default-collateral-backing-quote") as any;
assert(declaredMethod && originalMethod);
assert.equal(declaredMethod.chainAmountQuote, undefined);
assert.equal(declaredMethod.trialState.unsupportedReason,
  "default-collateral quotes read the vault supply/backing pair per quote; no sequential trial overlay is modeled");
assert.deepEqual(declaredMethod.program.buildRequests(exactInput), originalMethod.program.buildRequests(exactInput));
const exactResults = [
  returned("exact-asset", DEFAULT_COLLATERAL_INTERFACE.encodeFunctionResult("asset", [DEFAULT_COLLATERAL_ASSET])),
  returned("exact-total-supply", DEFAULT_COLLATERAL_INTERFACE.encodeFunctionResult("totalSupply", [SUPPLY])),
  returned("exact-backing", DEFAULT_COLLATERAL_INTERFACE.encodeFunctionResult("balanceOf", [SUPPLY])),
];
const exactQuote = declaredMethod.program.decode({ programInput: exactInput, initialResults: exactResults as never, dependentEvidence: [] });
const originalQuote = originalMethod.program.decode({ programInput: exactInput, initialResults: exactResults as never });
assert.equal(exactQuote.amountOut, exactInput.amountIn);
assert.equal(originalQuote.amountOut, exactInput.amountIn);
const { readProof, ...exactEvidence } = exactQuote.evidence as Record<string, any>;
assert.deepEqual(readProof, { initialResults: exactResults, dependentEvidence: [] });
assert.deepEqual(exactEvidence, originalQuote.evidence);
for (const [mutate, message] of [
  [{ asset: DEFAULT_COLLATERAL_SHARE_VAULT }, "default-collateral exact asset() does not match the verified descriptor"],
  [{ supply: 0n, backing: 0n }, "default-collateral supply/backing is empty: rate not proven"],
  [{ backing: SUPPLY + 1n }, "default-collateral backing differs from totalSupply: 1:1 rate not proven"],
  [{ amountIn: SUPPLY + 1n }, "default-collateral amount exceeds the proven share supply"],
] as const) {
  const input = { ...exactInput, ...(("amountIn" in mutate) ? { amountIn: mutate.amountIn } : {}) };
  const results = [
    returned("exact-asset", DEFAULT_COLLATERAL_INTERFACE.encodeFunctionResult("asset", [("asset" in mutate) ? mutate.asset : DEFAULT_COLLATERAL_ASSET])),
    returned("exact-total-supply", DEFAULT_COLLATERAL_INTERFACE.encodeFunctionResult("totalSupply", [("supply" in mutate) ? mutate.supply : SUPPLY])),
    returned("exact-backing", DEFAULT_COLLATERAL_INTERFACE.encodeFunctionResult("balanceOf", [("backing" in mutate) ? mutate.backing : SUPPLY])),
  ];
  assert.throws(() => declaredMethod.program.decode({ programInput: input, initialResults: results as never, dependentEvidence: [] }), new RegExp(message.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.throws(() => originalMethod.program.decode({ programInput: input, initialResults: results as never }), new RegExp(message.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
}
// zero amount stays the Family's local-zero quote with explicit zero state.
const localZero = declaredMethods.find(method => method.id === "local-zero") as any;
const originalZero = handwritten.exact.methods(exactInput as never).find(method => method.id === "local-zero") as any;
const zeroQuote = localZero.quote({ ...exactInput, amountIn: 0n });
const originalZeroQuote = originalZero.quote({ ...exactInput, amountIn: 0n });
assert.deepEqual(zeroQuote, originalZeroQuote);
assert.equal(zeroQuote.result.amountOut, 0n);
assert.equal(zeroQuote.result.evidence.totalSupply, 0n);

// 8. Execution parity: default self-receipt, preflight asset binding, full burn.
const fragment = plugin.execution.buildFragment({ ...exactInput, minAmountOut: 0n, quotedAmountOut: exactQuote.amountOut, exactEvidence: exactQuote.evidence } as never);
assert.deepEqual(fragment.requirements, []);
assert.equal(fragment.nodes[0]!.target, DEFAULT_COLLATERAL_SHARE_VAULT);
assert.equal(fragment.nodes[0]!.tokenIn, DEFAULT_COLLATERAL_SHARE_VAULT);
assert.equal(fragment.nodes[0]!.tokenOut, DEFAULT_COLLATERAL_ASSET);
assert.equal(fragment.nodes[0]!.amount, exactInput.amountIn);
assert.throws(() => plugin.execution.buildFragment({ ...exactInput, minAmountOut: 0n, quotedAmountOut: exactQuote.amountOut,
  exactEvidence: { ...exactQuote.evidence, backing: SUPPLY + 1n } } as never));
const declaredLeg = plugin.execution.buildRuntimeLeg({ ...exactInput, transactionOrigin: EXECUTOR, runtimeEvidence: [] } as never)!;
const originalLeg = handwritten.execution.buildRuntimeLeg({ ...exactInput, transactionOrigin: EXECUTOR, runtimeEvidence: [] } as never)!;
assert.equal(declaredLeg.actionAdapterId, originalLeg.actionAdapterId);
assert.deepEqual(declaredLeg.settlement, originalLeg.settlement);
function withdrawTrace(program: string, amount: bigint, recipient: string, options: { receipt?: bigint; assetReturn?: string; shareBurn?: bigint } = {}) {
  let phase = 0;
  const receipt = options.receipt ?? amount;
  const shareBurn = options.shareBurn ?? amount;
  return inspectRuntime(program, amount, {
    nativeBalance: () => 0n,
    call(call) {
      const selector = call.data.slice(0, 10);
      if (selector === "0x01e1d114") return word(0n); // totalSupply placeholder
      if (selector === DEFAULT_COLLATERAL_INTERFACE.getFunction("asset")!.selector) {
        return DEFAULT_COLLATERAL_INTERFACE.encodeFunctionResult("asset", [options.assetReturn ?? DEFAULT_COLLATERAL_ASSET]);
      }
      if (selector === "0x70a08231") {
        const token = call.target.toLowerCase();
        if (token === DEFAULT_COLLATERAL_ASSET.toLowerCase()) return word(phase === 0 ? 0n : receipt);
        return word(phase === 0 ? amount : amount - shareBurn);
      }
      if (selector === DEFAULT_COLLATERAL_INTERFACE.getFunction("withdraw")!.selector) {
        phase = 1;
        return "0x";
      }
      throw new Error(`unexpected call ${selector}`);
    },
  });
}
const declaredTrace = withdrawTrace(declaredLeg.program, exactInput.amountIn, EXECUTOR);
const withdrawCalls = declaredTrace.calls.filter(call => call.data.slice(0, 10) === DEFAULT_COLLATERAL_INTERFACE.getFunction("withdraw")!.selector);
assert.equal(withdrawCalls.length, 1);
const withdrawArgs = DEFAULT_COLLATERAL_INTERFACE.decodeFunctionData("withdraw", withdrawCalls[0]!.data);
assert.equal(withdrawArgs[0], EXECUTOR);
assert.equal(withdrawArgs[1], exactInput.amountIn);
const assetCalls = declaredTrace.calls.filter(call => call.data.slice(0, 10) === DEFAULT_COLLATERAL_INTERFACE.getFunction("asset")!.selector);
assert.equal(assetCalls.length, 1);
assert.equal(assetCalls[0]!.static, true);
// a foreign asset() answer, a short receipt, or a short share burn fails closed.
assert.throws(() => withdrawTrace(declaredLeg.program, exactInput.amountIn, EXECUTOR, { assetReturn: DEFAULT_COLLATERAL_SHARE_VAULT }), /runtime amount mismatch/);
assert.throws(() => withdrawTrace(declaredLeg.program, exactInput.amountIn, EXECUTOR, { receipt: exactInput.amountIn - 1n }), /checked uint256 math|runtime amount mismatch/);
assert.throws(() => withdrawTrace(declaredLeg.program, exactInput.amountIn, EXECUTOR, { shareBurn: exactInput.amountIn - 1n }), /runtime amount mismatch/);
// quoted fragment program enforces the plan minimum.
const minFragment = plugin.execution.buildFragment({ ...exactInput, minAmountOut: exactQuote.amountOut, quotedAmountOut: exactQuote.amountOut, exactEvidence: exactQuote.evidence } as never);
const minProgram = (minFragment.nodes[0]!.params as { runtimeAmountProgram: string }).runtimeAmountProgram;
assert.doesNotThrow(() => withdrawTrace(minProgram, exactInput.amountIn, EXECUTOR));
assert.throws(() => withdrawTrace(minProgram, exactInput.amountIn, EXECUTOR, { receipt: exactInput.amountIn - 1n }), /checked uint256 math|runtime amount mismatch/);
// direct-output settlement pays an external recipient; deferred input is unsupported.
const recipient = ethers.getAddress("0x10000000000000000000000000000000000000ff");
const settledLeg = plugin.execution.buildRuntimeLeg({ ...exactInput, transactionOrigin: EXECUTOR, runtimeEvidence: [],
  settlement: { kind: "direct-output", recipient } } as never)!;
const settledTrace = withdrawTrace(settledLeg.program, exactInput.amountIn, recipient);
const settledCalls = settledTrace.calls.filter(call => call.data.slice(0, 10) === DEFAULT_COLLATERAL_INTERFACE.getFunction("withdraw")!.selector);
assert.equal(DEFAULT_COLLATERAL_INTERFACE.decodeFunctionData("withdraw", settledCalls[0]!.data)[0], recipient);
assert.equal(plugin.execution.buildRuntimeLeg({ ...exactInput, transactionOrigin: EXECUTOR, runtimeEvidence: [],
  settlement: { kind: "deferred-input", recipient: EXECUTOR } } as never), null);

console.log("default-collateral declarative validation PASS");
