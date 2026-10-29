import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ethers } from "ethers";
import { renderDeclarativeProductionEntry } from "../src/searcher/build-declarative-production.js";
import { createDeclarativeProtocolRuntime } from "../src/searcher/venues/declarative-protocol.js";
import { declarativeMathRegistry } from "../src/searcher/venues/declarative-math-models.js";
import { declarativeRuntimeMathRegistry } from "../src/searcher/venues/declarative-runtime-math-models.js";
import { defineProtocolFamily, definedFamilyPluginContractSummary } from "../src/searcher/venues/adapter-family-plugin.js";
import { hashCanonical } from "../src/searcher/venues/canonical-value.js";
import { inspectRuntime } from "../src/searcher/test/runtime-program-testkit.js";
import { ARCANA_DESTINATION_INTERFACE, ARCANA_SOURCE_INTERFACE } from "../src/searcher/venues/protocols/arcana-migration-family/abi.js";
import { arcAmount } from "../src/searcher/venues/protocols/arcana-migration-family/math.js";
import { plugin as handwritten } from "../src/searcher/venues/production-families/arcana-migration.production.js";

const ROOT = new URL("..", import.meta.url).pathname;
const definitionFile = `${ROOT}src/searcher/venues/protocols/arcana-migration-family/arcana-migration.json`;
const document = JSON.parse(readFileSync(definitionFile, "utf8"));

// ---------------------------------------------------------------------------
// 1. Production entry rendering (in memory; never written).
// ---------------------------------------------------------------------------
const rendered = renderDeclarativeProductionEntry({ rootDirectory: ROOT, definitionFile, document });
assert.equal(rendered.format, "protocol-json-v2");
assert.equal(rendered.familyId, "protocol:arcana-migration");
assert.deepEqual([...rendered.ownedActionAdapterIds], ["arcana-migration"]);
assert.match(rendered.source, /compileDeclarativeProtocol<FamilyTypes>\(definition, \[\]\)/);
assert.match(rendered.source, /SEARCHER_FAMILY_ARCANA_MIGRATION_ENABLED/);
assert.equal(rendered.childFiles.length, 0);

// ---------------------------------------------------------------------------
// 2. Strict runtime compilation.
// ---------------------------------------------------------------------------
const runtime = createDeclarativeProtocolRuntime(document, [], {
  math: declarativeMathRegistry, executionMath: declarativeRuntimeMathRegistry,
});
const plugin = defineProtocolFamily(runtime.definition as never);
const summary = definedFamilyPluginContractSummary(plugin);
assert.equal(String(summary.familyId), "protocol:arcana-migration");
assert.equal(plugin.protocol.activeBehaviorProof, "required");
for (const row of runtime.moduleCoverage[0]!.modules) {
  if (row.key === "math" || row.key === "quoteFlow") assert.equal(row.state, "compiled", row.key);
}
assert.equal(String(handwritten.manifest.familyId), "protocol:arcana-migration");
assert.deepEqual(plugin.manifest.allowedTaxonomy, handwritten.manifest.allowedTaxonomy);
assert.deepEqual([...plugin.manifest.ownedActionAdapterIds], [...handwritten.manifest.ownedActionAdapterIds]);
assert.deepEqual([...plugin.manifest.requiredInfraActionAdapterIds], [...handwritten.manifest.requiredInfraActionAdapterIds]);
assert.deepEqual([...plugin.manifest.supportedLineages], [...handwritten.manifest.supportedLineages]);
assert.deepEqual([...plugin.manifest.poolAdapterIds!], [...handwritten.manifest.poolAdapterIds!]);
assert.deepEqual([...plugin.manifest.edgeAdapterIds!], [...handwritten.manifest.edgeAdapterIds!]);

// ---------------------------------------------------------------------------
// Fixtures: real-shaped Arcana call/log observations and identity rounds.
// ---------------------------------------------------------------------------
const SOURCE = Object.freeze({ number: 26_184_922, hash: `0x${"11".repeat(32)}`, generation: 26_184_922 });
const PROVENANCE = Object.freeze({ kind: "test-transport", fingerprint: `0x${"22".repeat(32)}` });
const MIGRATION = ethers.getAddress("0x1000000000000000000000000000000000000021");
const OLD_TOKEN = ethers.getAddress("0x1000000000000000000000000000000000000022");
const ARC_TOKEN = ethers.getAddress("0x1000000000000000000000000000000000000023");
const DESTINATION = ethers.getAddress("0x1000000000000000000000000000000000000024");
const EXECUTOR = ethers.getAddress("0x10000000000000000000000000000000000000ee");
const TOKEN_ID = `0x${"ab".repeat(32)}`;
const SAMPLE = 1_000_000_000_000_000_000n;
const TWAP = 1_900_000_000_000_000_000_000n;
const MULTIPLIER = 1_000_000_000_000_000_000n;
const MULTIPLIER_SCALE = 1_000_000_000_000_000_000n;
const SOURCE_CODE = `0x${"6001600055".repeat(12)}`;
const EXPECTED_SAMPLE_OUT = arcAmount({ amount: SAMPLE, tokenDecimals: 18,
  tokenTwapValue: TWAP, tokenMultiplier: MULTIPLIER, multiplierScale: MULTIPLIER_SCALE });
const CANDIDATE = Object.freeze({ candidateKind: "arcana-migration", source: MIGRATION, tokenId: TOKEN_ID });

function returned(id: string, data: string) {
  return Object.freeze({ id, ok: true as const, source: SOURCE, provenance: PROVENANCE,
    completion: "returned" as const, data });
}
const word = (value: bigint) => `0x${value.toString(16).padStart(64, "0")}`;

function baseResults(options: { publicEnabled?: boolean; bridgeEnabled?: boolean; enabled?: boolean; code?: string } = {}) {
  return Object.freeze([
    returned("identity-source-code", options.code ?? SOURCE_CODE),
    returned("identity-token-config", ARCANA_SOURCE_INTERFACE.encodeFunctionResult("tokenConfigs", [
      OLD_TOKEN, 18n, TWAP, MULTIPLIER, 10n ** 24n, 0n, false, options.enabled ?? true,
    ])),
    returned("identity-multiplier-scale", ARCANA_SOURCE_INTERFACE.encodeFunctionResult("MULTIPLIER_SCALE", [MULTIPLIER_SCALE])),
    returned("identity-destination", ARCANA_SOURCE_INTERFACE.encodeFunctionResult("destinationReceiver", [DESTINATION])),
    returned("identity-public-enabled", ARCANA_SOURCE_INTERFACE.encodeFunctionResult("publicMigrationEnabled", [options.publicEnabled ?? true])),
    returned("identity-bridge-enabled", ARCANA_SOURCE_INTERFACE.encodeFunctionResult("bridgeEnabled", [options.bridgeEnabled ?? true])),
  ]);
}
function surfaceResults(arcToken = ARC_TOKEN) {
  return Object.freeze([
    returned("identity-arc-token", ARCANA_DESTINATION_INTERFACE.encodeFunctionResult("arc", [arcToken])),
  ]);
}
function activeResults(amountOut: bigint) {
  return Object.freeze([
    returned("identity-preview-arc", ARCANA_SOURCE_INTERFACE.encodeFunctionResult("previewArcAmount", [amountOut])),
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
  // Deliberate fail-closed widening: the declarative active proof observes a
  // declared revert of previewArcAmount (completion return-or-revert-data) so a
  // reverting preview is a chain-proven rejection instead of a transport error.
  // Every other request field is identical to the Family.
  const normalized = declared.map(request => request.id === "identity-preview-arc" && request.kind === "eth-call"
    ? { ...request, completion: "return-data" as const } : request);
  assert.deepEqual(normalized, original, `identity requests step ${step} differs`);
  assert.deepEqual(declaredVariant.requirements(input as never), handwrittenVariant.requirements(input as never));
  return declared;
}
function bothDecide(step: number, evidence: unknown) {
  const declared = declaredVariant.decide({ candidate: CANDIDATE, evidence, step } as never);
  const original = handwrittenVariant.decide({ candidate: CANDIDATE, evidence, step } as never);
  assert.deepEqual(declared, original, `identity decision step ${step} differs`);
  return declared as Record<string, any>;
}

// ---------------------------------------------------------------------------
// 3. Discovery decode parity (call, landed log, and rejected shapes).
// ---------------------------------------------------------------------------
const lockData = ARCANA_SOURCE_INTERFACE.encodeFunctionData("lockAndBridge", [TOKEN_ID, 10n ** 18n, EXECUTOR]);
const callObservation = { kind: "call" as const, source: SOURCE, target: MIGRATION.toLowerCase(), sender: EXECUTOR.toLowerCase(), data: lockData.toLowerCase() };
assert.deepEqual(
  plugin.discovery.decodeCandidate({ observation: callObservation as never, matchedPatternId: "arcana-lock-and-bridge" }),
  handwritten.discovery.decodeCandidate({ observation: callObservation as never, matchedPatternId: "arcana-lock-and-bridge" }),
);
assert.equal(plugin.discovery.decodeCandidate({ observation: callObservation as never, matchedPatternId: "other" }), null);
assert.equal(plugin.discovery.decodeCandidate({ observation: { ...callObservation, data: "0x12345678" } as never, matchedPatternId: "arcana-lock-and-bridge" }), null);
const logObservation = {
  kind: "log" as const, source: SOURCE, address: MIGRATION.toLowerCase(),
  topics: [
    "0x22b996b24698ab9933ac009880779ea80bd5700d5294b2913b21ff6bd8be1d93",
    TOKEN_ID,
    `0x${"0".repeat(24)}${EXECUTOR.slice(2).toLowerCase()}`,
    `0x${"0".repeat(24)}${EXECUTOR.slice(2).toLowerCase()}`,
  ],
  data: ARCANA_SOURCE_INTERFACE.encodeEventLog(ARCANA_SOURCE_INTERFACE.getEvent("MigrationLocked")!, [
    TOKEN_ID, EXECUTOR, EXECUTOR, OLD_TOKEN, 10n ** 18n, 2_890_698_889_174_165_912_800n, 0n, `0x${"cd".repeat(32)}`,
  ]).data,
};
assert.deepEqual(
  plugin.discovery.decodeCandidate({ observation: logObservation as never, matchedPatternId: "arcana-migration-locked-log" }),
  handwritten.discovery.decodeCandidate({ observation: logObservation as never, matchedPatternId: "arcana-migration-locked-log" }),
);
assert.deepEqual([...plugin.discovery.sources], [...handwritten.discovery.sources]);
assert.deepEqual([...plugin.discovery.candidateSources!], [...handwritten.discovery.candidateSources!]);
assert.equal(typeof plugin.discovery.nominate!.nominate, "function");
assert.equal(plugin.discovery.txSeedNominations, true);
assert.equal(plugin.discovery.callPatterns!.length, 1);
assert.equal(plugin.discovery.logPatterns!.length, 1);
assert.equal(plugin.discovery.callPatterns![0]!.selector, handwritten.discovery.callPatterns![0]!.selector);
assert.equal(plugin.discovery.logPatterns![0]!.topic, handwritten.discovery.logPatterns![0]!.topic);

// ---------------------------------------------------------------------------
// 4. Identity phases: base -> surface -> active -> verified.
// ---------------------------------------------------------------------------
const baseRequests = bothRequests(0, undefined);
assert.equal(baseRequests.length, 6);
const baseEvidence = bothDecode(0, undefined, baseResults());
assert.equal(baseEvidence.phase, "base");
assert.equal(baseEvidence.arcToken, "");
assert.deepEqual(bothDecide(0, baseEvidence), { status: "continue" });

const surfaceRequests = bothRequests(1, baseEvidence);
assert.equal(surfaceRequests.length, 1);
const surfaceEvidence = bothDecode(1, baseEvidence, surfaceResults());
assert.equal(surfaceEvidence.arcToken, ARC_TOKEN);
assert.deepEqual(bothDecide(1, surfaceEvidence), { status: "continue" });

const activeRequests = bothRequests(2, surfaceEvidence);
assert.equal(activeRequests.length, 1);
const activeEvidence = bothDecode(2, surfaceEvidence, activeResults(EXPECTED_SAMPLE_OUT));
assert.equal(activeEvidence.phase, "active");
assert.equal(activeEvidence.behaviorValid, true);
const verified = bothDecide(2, activeEvidence);
assert.equal(verified.status, "verified");
const identity = verified.identity as Record<string, any>;
assert.equal(identity.source, MIGRATION);
assert.equal(identity.oldToken, OLD_TOKEN);
assert.equal(identity.arcToken, ARC_TOKEN);
assert.equal(identity.proxyCodeHash, ethers.keccak256(SOURCE_CODE));
assert.equal(identity.tokenTwapValue, TWAP);
assert.equal(identity.multiplierScale, MULTIPLIER_SCALE);

// disabled source is rejected at the base decode exactly like the Family.
assert.throws(() => bothDecode(0, undefined, baseResults({ publicEnabled: false })), /not enabled/);
assert.throws(() => bothDecode(0, undefined, baseResults({ bridgeEnabled: false })), /not enabled/);
assert.throws(() => bothDecode(0, undefined, baseResults({ enabled: false })), /not enabled/);
// identical old/arc token is rejected at the surface decode.
assert.throws(() => bothDecode(1, baseEvidence, surfaceResults(OLD_TOKEN)), /identical/);
// a wrong preview output is a chain-proven rejection, never admitted.
const wrongEvidence = bothDecode(2, surfaceEvidence, activeResults(EXPECTED_SAMPLE_OUT + 1n));
assert.equal(wrongEvidence.behaviorValid, false);
assert.deepEqual(bothDecide(2, wrongEvidence), {
  status: "chain-proven-rejected",
  reasonCode: "arcana_migration_behavior_failed",
  evidenceRequestIds: ["identity-active-migration"],
});
// a remainder in the family formula is a behavior failure too.
const remainderResults = Object.freeze([
  returned("identity-preview-arc", ARCANA_SOURCE_INTERFACE.encodeFunctionResult("previewArcAmount", [EXPECTED_SAMPLE_OUT])),
]);
const remainderSurface = Object.freeze({ ...surfaceEvidence, tokenTwapValue: TWAP + 1n });
const remainderDeclared = declaredVariant.decode({ step: { candidate: CANDIDATE, evidence: remainderSurface, step: 2 } as never, results: remainderResults as never }) as Record<string, any>;
const remainderOriginal = handwrittenVariant.decode({ step: { candidate: CANDIDATE, evidence: remainderSurface, step: 2 } as never, results: remainderResults as never }) as Record<string, any>;
assert.deepEqual(remainderDeclared, remainderOriginal);
assert.equal(remainderDeclared.behaviorValid, false);

// ---------------------------------------------------------------------------
// 5. Instance + route projection parity.
// ---------------------------------------------------------------------------
const descriptor = plugin.instance.compileDraft(identity as never);
const originalDescriptor = handwritten.instance.compileDraft(identity as never);
assert.deepEqual(descriptor, originalDescriptor);
const routes = plugin.routes.project({ descriptor });
const originalRoutes = handwritten.routes.project({ descriptor: originalDescriptor });
assert.deepEqual(routes, originalRoutes);
assert.equal(plugin.instance.instanceKey(identity as never), handwritten.instance.instanceKey(identity as never));
const _staticProjection = plugin.instance.staticBindingProjection(descriptor);
assert.deepEqual(_staticProjection, handwritten.instance.staticBindingProjection(originalDescriptor));
assert.deepEqual(plugin.routes.projectGraph({ descriptor, route: routes[0] }),
  handwritten.routes.projectGraph({ descriptor: originalDescriptor, route: originalRoutes[0] }));
assert.deepEqual(plugin.execution.expectedEffects({ descriptor, route: routes[0] }),
  handwritten.execution.expectedEffects({ descriptor: originalDescriptor, route: originalRoutes[0] }));

// ---------------------------------------------------------------------------
// 6. Pricing parity: static evidence, current quote, mids, unavailable.
// ---------------------------------------------------------------------------
const declaredPricing = plugin.pricing;
const originalPricing = handwritten.pricing;
assert.equal(declaredPricing.refreshPolicyForInstance!({ descriptor }), "on-touch");
assert.deepEqual(declaredPricing.staticBindingProjection({ descriptor }),
  originalPricing.staticBindingProjection({ descriptor: originalDescriptor }));
assert.deepEqual(declaredPricing.snapshotCompatibilityProjection({ descriptor }),
  originalPricing.snapshotCompatibilityProjection({ descriptor: originalDescriptor }));
const draft = declaredPricing.compileDraft({ descriptor, stateKey: descriptor.instanceKey, routes });
// The engine requires the finalized pricing descriptor to carry this group's
// routes; the Family draft itself is identical.
const { routes: draftRoutes, ...draftCore } = draft as Record<string, any>;
assert.deepEqual(draftRoutes, routes);
assert.deepEqual(draftCore, originalPricing.compileDraft({ descriptor: originalDescriptor, stateKey: originalDescriptor.instanceKey, routes: originalRoutes }));

const staticRequests = declaredPricing.staticEvidence.buildRequests(draft);
assert.deepEqual(staticRequests, originalPricing.staticEvidence.buildRequests(draft));
const staticResults = [
  returned("static-old-decimals", word(18n)),
  returned("static-arc-decimals", word(18n)),
];
const staticEvidence = declaredPricing.staticEvidence.decode({ programInput: draft, results: staticResults as never });
assert.deepEqual(staticEvidence, originalPricing.staticEvidence.decode({ programInput: draft, results: staticResults as never }));
const pricingDescriptor = declaredPricing.finalizePricingDescriptor({ draft, staticEvidence } as never);
const originalPricingDescriptor = originalPricing.finalizePricingDescriptor({ draft: originalPricing.compileDraft({ descriptor: originalDescriptor, stateKey: originalDescriptor.instanceKey, routes: originalRoutes }), staticEvidence } as never);
assert.deepEqual({ ...pricingDescriptor, routes: undefined }, { ...originalPricingDescriptor, routes: undefined });

const pricingInput = { descriptor: pricingDescriptor, routes, stateKey: descriptor.instanceKey };
const currentRequests = declaredPricing.current.buildRequests(pricingInput as never);
const originalCurrentRequests = originalPricing.current.buildRequests(pricingInput as never);
// The declarative legacy-pricing path names the per-direction quote request by
// its declared direction (current:<direction>); the Family used a fixed id.
assert.deepEqual(currentRequests.map(request => ({ ...request, id: undefined })),
  originalCurrentRequests.map(request => ({ ...request, id: undefined })));
assert.deepEqual(declaredPricing.current.requirements(pricingInput as never), originalPricing.current.requirements(pricingInput as never));

const previewResults = [
  ...staticResults,
  returned("current:migrate-to-arc", ARCANA_SOURCE_INTERFACE.encodeFunctionResult("previewArcAmount", [EXPECTED_SAMPLE_OUT])),
];
const originalPreviewResults = [
  ...staticResults,
  returned("current-preview-arc", ARCANA_SOURCE_INTERFACE.encodeFunctionResult("previewArcAmount", [EXPECTED_SAMPLE_OUT])),
];
const snapshot = declaredPricing.current.decodeSnapshot({ descriptor: pricingDescriptor, initialResults: previewResults as never });
const originalSnapshot = originalPricing.current.decodeSnapshot({ descriptor: originalPricingDescriptor, initialResults: originalPreviewResults as never });
assert.deepEqual(snapshot, originalSnapshot);
assert.equal(snapshot.quotes[routes[0]!.routeKey]!.amountIn, SAMPLE);
assert.deepEqual([...declaredPricing.current.deriveMids({ descriptor: pricingDescriptor, snapshot, routes })],
  [...originalPricing.current.deriveMids({ descriptor: originalPricingDescriptor, snapshot: originalSnapshot, routes: originalRoutes })]);
assert.deepEqual([...declaredPricing.current.classifyUnavailable!({ descriptor: pricingDescriptor, snapshot, routes })],
  [...originalPricing.current.classifyUnavailable!({ descriptor: originalPricingDescriptor, snapshot: originalSnapshot, routes: originalRoutes })]);
// The engine canonicalizes dependency addresses (unique + sorted).
assert.deepEqual([...declaredPricing.dependencies({ descriptor: pricingDescriptor })].sort(),
  [...originalPricing.dependencies({ descriptor: originalPricingDescriptor })].sort());

const zeroSnapshot = declaredPricing.current.decodeSnapshot({
  descriptor: pricingDescriptor,
  initialResults: [...staticResults, returned("current:migrate-to-arc", ARCANA_SOURCE_INTERFACE.encodeFunctionResult("previewArcAmount", [0n]))] as never,
});
const originalZeroSnapshot = originalPricing.current.decodeSnapshot({
  descriptor: originalPricingDescriptor,
  initialResults: [...staticResults, returned("current-preview-arc", ARCANA_SOURCE_INTERFACE.encodeFunctionResult("previewArcAmount", [0n]))] as never,
});
// The declarative legacy pricing path always emits the per-direction quote
// entry; a zero preview is classified unavailable below, so mids are unchanged.
assert.deepEqual(Object.keys(originalZeroSnapshot.quotes), []);
assert.equal(zeroSnapshot.quotes[routes[0]!.routeKey]!.amountOut, 0n);
assert.equal(zeroSnapshot.quotes[routes[0]!.routeKey]!.amountIn, originalZeroSnapshot.source.number === SOURCE.number ? SAMPLE : SAMPLE);
assert.deepEqual([...declaredPricing.current.classifyUnavailable!({ descriptor: pricingDescriptor, snapshot: zeroSnapshot, routes })],
  [...originalPricing.current.classifyUnavailable!({ descriptor: originalPricingDescriptor, snapshot: originalZeroSnapshot, routes: originalRoutes })]);
assert.equal([...declaredPricing.current.deriveMids({ descriptor: pricingDescriptor, snapshot: zeroSnapshot, routes })].length, 0);

// mutation refresh parity for the compiled index and its fallback.
const mutationEntries = [{ descriptor: pricingDescriptor, routes, dependencies: declaredPricing.dependencies({ descriptor: pricingDescriptor }), stateKey: descriptor.instanceKey }];
const declaredMutation = declaredPricing.mutation!.compile!({ entries: mutationEntries as never });
const originalMutation = originalPricing.mutation!.compile!({ entries: [{ descriptor: originalPricingDescriptor, routes: originalRoutes, dependencies: originalPricing.dependencies({ descriptor: originalPricingDescriptor }), stateKey: originalDescriptor.instanceKey }] as never });
for (const observation of [
  { kind: "log", address: MIGRATION.toLowerCase() },
  { kind: "log", address: ARC_TOKEN.toLowerCase() },
  { kind: "log", address: OLD_TOKEN.toLowerCase() },
  { kind: "log", address: EXECUTOR.toLowerCase() },
] as const) {
  assert.deepEqual(declaredMutation.affectedStateKeys({ observation: observation as never }),
    originalMutation.affectedStateKeys({ observation: observation as never }), JSON.stringify(observation));
  // The declarative fallback uses the same dependency/mutation address pair as
  // the compiled index; the handwritten callback was narrower for oldToken.
  assert.deepEqual(declaredPricing.mutation!.affectedStateKeys!({ descriptor: pricingDescriptor, routes, observation: observation as never }),
    declaredMutation.affectedStateKeys({ observation: observation as never }));
}

// ---------------------------------------------------------------------------
// 7. Exact quote parity (view preview + chain quote proof).
// ---------------------------------------------------------------------------
// Production exact runs against the admitted instance descriptor, not the
// pricing descriptor (which carries only pricing state + its route group).
const exactInput = { descriptor, route: routes[0], amountIn: 1_521_420_467_986_403_112n, source: SOURCE, executor: EXECUTOR };
const declaredMethods = plugin.exact.methods(exactInput as never);
const declaredMethod = declaredMethods.find(method => method.id === "arcana-migration-preview") as any;
const originalMethod = handwritten.exact.methods(exactInput as never).find(method => method.id === "arcana-migration-preview") as any;
assert(declaredMethod && originalMethod);
assert.equal(declaredMethod.chainAmountQuote, true);
assert.deepEqual(declaredMethod.program.requirements(exactInput), originalMethod.program.requirements(exactInput));
assert.deepEqual(declaredMethod.program.buildRequests(exactInput), originalMethod.program.buildRequests(exactInput));
const exactOut = arcAmount({ amount: exactInput.amountIn, tokenDecimals: 18, tokenTwapValue: TWAP, tokenMultiplier: MULTIPLIER, multiplierScale: MULTIPLIER_SCALE });
const exactResults = [returned("exact-preview-arc", ARCANA_SOURCE_INTERFACE.encodeFunctionResult("previewArcAmount", [exactOut]))];
const declaredQuote = declaredMethod.program.decode({ programInput: exactInput, initialResults: exactResults as never, dependentEvidence: [] });
const originalQuote = originalMethod.program.decode({ programInput: exactInput, initialResults: exactResults as never, dependentEvidence: [] });
assert.deepEqual(declaredQuote, originalQuote);
assert.equal(declaredQuote.amountOut, exactOut);
assert.equal(declaredQuote.evidence.executor, EXECUTOR);
// a zero preview is never quoted.
assert.throws(() => declaredMethod.program.decode({ programInput: exactInput,
  initialResults: [returned("exact-preview-arc", ARCANA_SOURCE_INTERFACE.encodeFunctionResult("previewArcAmount", [0n]))] as never,
  dependentEvidence: [] }));
// zero input is rejected by the declared exact check on the local-zero method.
const localZero = declaredMethods.find(method => method.id === "local-zero") as any;
assert(localZero);
assert.throws(() => localZero.quote({ ...exactInput, amountIn: 0n }), /positive uint256 range/);
assert.equal(localZero.quote({ ...exactInput }).status, "not-applicable");

// ---------------------------------------------------------------------------
// 8. Execution parity: approval + lockAndBridge calldata and full evidence.
// ---------------------------------------------------------------------------
const fragment = plugin.execution.buildFragment({ ...exactInput, minAmountOut: 0n, quotedAmountOut: exactOut, exactEvidence: declaredQuote.evidence } as never);
assert.equal(fragment.nodes.length, 1);
assert.equal(fragment.nodes[0]!.target, MIGRATION);
assert.equal(fragment.nodes[0]!.tokenIn, OLD_TOKEN);
assert.equal(fragment.nodes[0]!.tokenOut, ARC_TOKEN);
assert.equal(fragment.nodes[0]!.amount, exactInput.amountIn);
assert.deepEqual(fragment.requirements, []);
// evidence substitution is rejected.
assert.throws(() => plugin.execution.buildFragment({ ...exactInput, minAmountOut: 0n, quotedAmountOut: exactOut,
  exactEvidence: { ...declaredQuote.evidence, amountOut: exactOut + 1n } } as never));

const declaredLeg = plugin.execution.buildRuntimeLeg({ ...exactInput, transactionOrigin: EXECUTOR, runtimeEvidence: [] } as never)!;
const originalLeg = handwritten.execution.buildRuntimeLeg({ ...exactInput, transactionOrigin: EXECUTOR, runtimeEvidence: [] } as never)!;
assert.equal(declaredLeg.actionAdapterId, originalLeg.actionAdapterId);
function trace(program: string, balances: Map<string, bigint>) {
  const calls: { target: string; data: string }[] = [];
  const result = inspectRuntime(program, exactInput.amountIn, {
    call(call) {
      calls.push(call);
      const selector = call.data.slice(0, 10);
      if (selector === "0x70a08231") {
        const token = call.target.toLowerCase();
        return word(balances.get(token) ?? 0n);
      }
      if (selector === "0x095ea7b3") return word(1n);
      return ARCANA_SOURCE_INTERFACE.encodeFunctionResult("lockAndBridge", [`0x${"ef".repeat(32)}`, exactOut]);
    },
  });
  const meaningful = result.calls.filter(call => ["0x095ea7b3", ARCANA_SOURCE_INTERFACE.getFunction("lockAndBridge")!.selector]
    .includes(call.data.slice(0, 10)))
    .map(call => ({ target: call.target, data: call.data, static: call.static }));
  return { result, meaningful, calls };
}
const before = new Map([[OLD_TOKEN.toLowerCase(), exactInput.amountIn], [ARC_TOKEN.toLowerCase(), 0n]]);
const after = new Map([[OLD_TOKEN.toLowerCase(), 0n], [ARC_TOKEN.toLowerCase(), exactOut]]);
let phase = 0;
const declaredTrace = inspectRuntime(declaredLeg.program, exactInput.amountIn, {
  call(call) {
    const selector = call.data.slice(0, 10);
    if (selector === "0x70a08231") {
      const token = call.target.toLowerCase();
      return word(phase === 0 ? (before.get(token) ?? 0n) : (after.get(token) ?? 0n));
    }
    if (selector === "0x095ea7b3") return word(1n);
    if (selector === ARCANA_SOURCE_INTERFACE.getFunction("lockAndBridge")!.selector) {
      phase = 1;
      return ARCANA_SOURCE_INTERFACE.encodeFunctionResult("lockAndBridge", [`0x${"ef".repeat(32)}`, exactOut]);
    }
    throw new Error(`unexpected declared call ${selector}`);
  },
});
const declaredMeaningful = declaredTrace.calls
  .filter(call => ["0x095ea7b3", ARCANA_SOURCE_INTERFACE.getFunction("lockAndBridge")!.selector].includes(call.data.slice(0, 10)))
  .map(call => ({ target: call.target, data: call.data, static: call.static }));
const originalTrace = trace(originalLeg.program, new Map());
assert.deepEqual(declaredMeaningful, originalTrace.meaningful);
const lockCalls = declaredTrace.calls.filter(call => call.data.slice(0, 10) === ARCANA_SOURCE_INTERFACE.getFunction("lockAndBridge")!.selector);
assert.equal(lockCalls.length, 1);
const lockArgs = ARCANA_SOURCE_INTERFACE.decodeFunctionData("lockAndBridge", lockCalls[0]!.data);
assert.equal(lockArgs[0], TOKEN_ID);
assert.equal(lockArgs[1], exactInput.amountIn);
assert.equal(lockArgs[2], EXECUTOR);
// an under-debiting receipt fails the declared full-debit check.
function underDelivered(token: string, beforeValue: bigint, afterValue: bigint) {
  let swapped = false;
  return {
    call(call: { target: string; data: string }) {
      const selector = call.data.slice(0, 10);
      if (selector === "0x70a08231") {
        const target = call.target.toLowerCase();
        if (target === token.toLowerCase()) return word(swapped ? afterValue : beforeValue);
        return word(swapped ? (after.get(target) ?? 0n) : (before.get(target) ?? 0n));
      }
      if (selector === "0x095ea7b3") return word(1n);
      swapped = true;
      return ARCANA_SOURCE_INTERFACE.encodeFunctionResult("lockAndBridge", [`0x${"ef".repeat(32)}`, exactOut]);
    },
  };
}
assert.throws(() => inspectRuntime(declaredLeg.program, exactInput.amountIn,
  underDelivered(OLD_TOKEN, exactInput.amountIn, exactInput.amountIn)));
assert.throws(() => inspectRuntime(declaredLeg.program, exactInput.amountIn,
  underDelivered(OLD_TOKEN, exactInput.amountIn, exactInput.amountIn - 1n)));
// the quoted fragment program enforces the plan's minimum output.
const minFragment = plugin.execution.buildFragment({ ...exactInput, minAmountOut: exactOut, quotedAmountOut: exactOut, exactEvidence: declaredQuote.evidence } as never);
const fragmentProgram = (minFragment.nodes[0]!.params as { runtimeAmountProgram: string }).runtimeAmountProgram;
const minAmountOut = exactOut;
assert.throws(() => inspectRuntime(fragmentProgram, exactInput.amountIn,
  underDelivered(ARC_TOKEN, 0n, minAmountOut - 1n)));
assert.doesNotThrow(() => inspectRuntime(fragmentProgram, exactInput.amountIn,
  underDelivered(ARC_TOKEN, 0n, minAmountOut)));

console.log("arcana-migration declarative validation PASS");
