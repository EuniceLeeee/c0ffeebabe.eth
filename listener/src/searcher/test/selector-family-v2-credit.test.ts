import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { Interface, id, keccak256, toBeHex } from "ethers";
import { normalizeSelectorNativeCreditDefinition, compileSelectorNativeCreditDiscovery } from "../venues/selector-native-credit-definition.js";
import { compileSelectorNativeCreditFamily } from "../venues/selector-native-credit.js";
import { bindSelectorNativeMath } from "../venues/selector-native-math.js";
import { defineCreditFamily, definedFamilyPluginContractSummary } from "../venues/adapter-family-plugin.js";
import { FamilyCapabilityCatalog, FAMILY_CAPABILITY_NAMES, capabilityManifestHash, asPricedFamily } from "../venues/family-capability-catalog.js";
import { hashCanonical } from "../venues/canonical-value.js";
import { readySelectorCensusFromTransaction } from "../ready-selector-census.js";
import { createStrictCentralAdapterRuntime } from "../strict-central-adapter-runtime.js";
import { executeAdapterFamilyLifecycleBatch } from "../venues/adapter-family-runtime.js";
import { prepareCreditFamilyRoutes, executeCreditRiskQuote, issueCreditExecutionHandle, buildCreditExecutionFragment, projectCreditRouteGraph } from "../adapter-credit-runtime.js";
import { buildReadyCatalogSnapshot, durableVerifiedMemoFingerprint } from "../universe-rebuild-checkpoint.js";
import { hashReadyCatalogSnapshot, hashReadyGraphSnapshot, hashReadyPublicationSet } from "../universe-rebuild-runner.js";
import { transactionReadyRoutes, assertAcceptanceReadyTarget } from "./family-json-ready.js";
import { resolveTransactionCaseBinding } from "./family-transaction-matching.js";
import { transactionSimulationCase } from "./protocol-json-sample-registration.js";

const a = (n: number) => toBeHex(n, 20), h = (n: number) => toBeHex(n, 32);
const target = a(100), executor = a(101), sender = a(102), collateral = a(103), debt = a(104), oracle = a(105);
const source = { number: 123, hash: h(123), generation: 1 };
const raw = () => JSON.parse(readFileSync(new URL("../venues/selector-native/selector-032d2276-family/selector-032d2276.json", import.meta.url), "utf8"));
const clean = (value: any): any => typeof value === "bigint" ? value.toString() : Array.isArray(value) ? value.map(clean)
  : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clean(item)])) : value;
function fixture(options: { badReady?: boolean; badRisk?: boolean; definition?: any; catalog?: FamilyCapabilityCatalog } = {}) {
  const definition = options.definition ?? raw(), compiled = compileSelectorNativeCreditFamily(definition), plugin = defineCreditFamily(compiled) as any;
  const entries = FAMILY_CAPABILITY_NAMES.map(capability => ({ familyId: plugin.manifest.familyId, capability, contractVersion: "selector-credit-v2-test",
    contentHash: hashCanonical({ definition: normalizeSelectorNativeCreditDefinition(definition), capability } as any), semanticDependencies: [`contract:${capability}`], provenanceCommit: null }));
  const catalog = options.catalog ?? new FamilyCapabilityCatalog({ modules: [{ sourceFile: "fixture/credit.production.ts", plugin, definitionBoundaryHash: definedFamilyPluginContractSummary(plugin).definitionBoundaryHash }],
    generatedManifest: { format: "adapter-family-capabilities-v1", entries, manifestHash: capabilityManifestHash(entries) } });
  const vault = new Interface(definition.values.abi.vault), state = new Interface(definition.values.abi.state), reads: any[] = [], sims: any[] = [];
  const packed = (BigInt(oracle) << 96n) | (800n << 32n) | (20n << 82n);
  const runtime = createStrictCentralAdapterRuntime({ executor, transactionOrigin: sender,
    generationFence: { assertCurrent(g, s) { assert.equal(g, source.generation); assert.deepEqual(s, source); } },
    provider: {
      async getCode() { throw new Error("Credit v2 has no code identity gate"); }, async getStorage() { throw new Error("Credit v2 uses only declared state ABI"); },
      async call(tx) {
        reads.push(tx);
        if (tx.data === vault.encodeFunctionData("constantsView")) return vault.encodeFunctionResult("constantsView", [[a(200), a(201), a(202), a(203), collateral, debt, 6, 6, 1n, h(1), h(2), h(3), h(4)]]);
        if (tx.data.startsWith(state.getFunction("readFromStorage")!.selector)) return state.encodeFunctionResult("readFromStorage", [packed]);
        if (tx.data === state.encodeFunctionData("getExchangeRateOperate")) { assert.equal(tx.to?.toLowerCase(), oracle); return state.encodeFunctionResult("getExchangeRateOperate", [10n ** 27n]); }
        assert.equal(tx.data, state.encodeFunctionData("updateExchangePrices", [packed])); return state.encodeFunctionResult("updateExchangePrices", [0n, 0n, 10n ** 12n, 10n ** 12n]);
      },
    }, simulator: { executorProgramCodeHash: keccak256("0x6001600055"), async simulate({ request }: any) {
      sims.push(request); const args = vault.decodeFunctionData("operate", request.call.data), amountIn = args[1], amountOut = args[2];
      assert.equal(request.call.to.toLowerCase(), target); assert.equal(args[0], 0n); assert.equal(args[3].toLowerCase(), executor);
      const incorrect = options.badReady && request.id === "active-operate-effect-proof" || options.badRisk && request.id === "credit-exact-operate";
      return { data: vault.encodeFunctionResult("operate", [7n, amountIn, amountOut]), effects: { tokenDeltas: [
        { token: collateral, account: executor, delta: -amountIn }, { token: debt, account: executor, delta: amountOut + (incorrect ? 1n : 0n) },
      ] } };
    } },
  });
  const data = vault.encodeFunctionData("operate", [0n, 1000000n, 500000n, sender]);
  const census = readySelectorCensusFromTransaction({ chainId: 1, transactionHash: h(500), blockNumber: source.number, blockHash: source.hash, status: 1,
    from: sender, to: target, input: data, traces: [], logs: [
      { address: collateral, topics: [id("Transfer(address,address,uint256)"), h(102), h(100)], data: h(1000000), logIndex: 0 },
      { address: debt, topics: [id("Transfer(address,address,uint256)"), h(100), h(102)], data: h(500000), logIndex: 1 },
    ] });
  const observation = { kind: "call" as const, source, sender, target, data, transactionHash: census.transactionHash!, traceAddress: [], opaque: { selectorCensus: census, callId: census.calls[0]!.id } as any };
  const family = catalog.forStrictFamily(plugin.manifest.familyId);
  const publish = async () => {
    const result = await executeAdapterFamilyLifecycleBatch({ family: asPricedFamily(family), source, generation: source.generation, runtime,
      matches: catalog.matches(observation).filter(row => row.familyId === plugin.manifest.familyId).map(row => ({ matchedPatternId: row.patternId, observation })), publisher: { publish() {} } });
    if (!result.publication) throw new Error(`did not publish: ${JSON.stringify(result.outcomes)}`); return result.publication;
  };
  return { definition, plugin, catalog, runtime, publish, reads, sims, observation, family };
}

test("v2 credit pure models preserve the base integer ceiling and packed-config results on 131 boundary vectors", () => {
  const models = bindSelectorNativeMath(raw().math), fixture = JSON.parse(readFileSync(new URL("fixtures/selector-credit-v2-math.json", import.meta.url), "utf8"));
  assert.equal(fixture.rows.length, 131);
  for (const row of fixture.rows) {
    const call = () => models[row.model]!(row.input.map(BigInt));
    if (row.rejected) assert.throws(call, `${row.model}:${row.input}`); else assert.deepEqual(clean(call()), row.result);
  }
});

test("v2 credit metadata is inert but position/risk semantics bind candidates and module contracts", () => {
  const original = raw(), annotated = { ...original, meta: { label: "Renamed", identity: { label: "Optional" }, arbitrary: ["display"] } };
  assert.deepEqual(normalizeSelectorNativeCreditDefinition(original), normalizeSelectorNativeCreditDefinition(annotated));
  assert.deepEqual(definedFamilyPluginContractSummary(defineCreditFamily(compileSelectorNativeCreditFamily(original))), definedFamilyPluginContractSummary(defineCreditFamily(compileSelectorNativeCreditFamily(annotated))));
  const f = fixture(), nominate = (definition: any) => { const p = compileSelectorNativeCreditDiscovery(definition); return p.discovery.decodeCandidate({ observation: f.observation, matchedPatternId: p.discovery.callPatterns![0]!.id }); };
  assert.deepEqual(nominate(original), nominate(annotated));
  const changed = structuredClone(original); changed.credit.risk.debtBpsCandidates = ["9000", "9500", "10000"];
  assert.notEqual(nominate(original)!.programKey, nominate(changed)!.programKey);
  assert.throws(() => normalizeSelectorNativeCreditDefinition({ ...original, format: "selector-native-execution/v1" }), /v2/);
  assert.throws(() => normalizeSelectorNativeCreditDefinition({ ...original, identity: { label: "old" } }), /fields/);
});

test("v2 credit Ready uses current executor effects, publishes credit price and issues standing-position risk/execution handles", async () => {
  const f = fixture(), publication = await f.publish();
  assert.equal(publication.instances.length, 1); assert.equal(f.sims.length, 1); assert.equal(f.reads.length, 4);
  const instance = publication.instances[0]!;
  const mid = [...instance.pricingInstances[0]!.mids.values()][0]!;
  assert.equal(mid.mid, 0.8); assert.equal(mid.feeBps, 20); assert.equal(mid.edges?.[0]!.edgeKind, "credit"); assert.equal(mid.edges?.[0]!.leavesStandingPosition, true);
  const prepared = prepareCreditFamilyRoutes({ family: f.family, instance, source, generation: source.generation }), route = prepared.routes[0]!;
  const graph = projectCreditRouteGraph({ family: f.family, route });
  assert.equal(graph.edge.edgeKind, "credit"); assert.equal(graph.edge.leavesStandingPosition, true); assert.equal(graph.graph.executionVerification, undefined);
  assert.equal(f.plugin.credit.position.finalSafety, "position-and-repayment-required"); assert.equal(f.plugin.execution.buildRuntimeLeg, undefined);
  const risk = await executeCreditRiskQuote({ family: f.family, route, collateralAmount: 1000000n, debtBps: 10000n, executor,
    runtimeEvidence: [], source, generation: source.generation, runtime: f.runtime });
  assert.equal(risk.status, "resolved", "reasonCode" in risk ? risk.reasonCode : ""); if (risk.status !== "resolved") return;
  assert.equal(risk.amountOut, 798250n); assert.equal(risk.blocksPrefixInversion, true); assert.equal(f.sims.length, 2);
  const handle = issueCreditExecutionHandle({ family: f.family, route, risk, minAmountOut: risk.amountOut, executor, runtimeEvidence: [], source, generation: source.generation });
  const result = buildCreditExecutionFragment({ family: f.family, actionOwnership: f.catalog, handle });
  assert.equal(result.status, "resolved", "reasonCode" in result ? result.reasonCode : ""); if (result.status !== "resolved") return;
  assert.equal(result.fragment.nodes[0]!.target, target);
  assert(String(result.fragment.nodes[0]!.params.runtimeAmountProgram).includes("032d2276"));
  assert.equal(buildCreditExecutionFragment({ family: f.family, actionOwnership: f.catalog, handle: { ...handle } }).status, "failed");
  assert.throws(() => issueCreditExecutionHandle({ family: f.family, route, risk, minAmountOut: risk.amountOut, executor: a(999), runtimeEvidence: [], source, generation: source.generation }));
});

test("credit Ready and risk remain unverified when actual token effects disagree with a successful ABI return", async () => {
  await assert.rejects(fixture({ badReady: true }).publish(), /did not publish/);
  const f = fixture({ badRisk: true }), publication = await f.publish();
  const route = prepareCreditFamilyRoutes({ family: f.family, instance: publication.instances[0]!, source, generation: source.generation }).routes[0]!;
  const result = await executeCreditRiskQuote({ family: f.family, route, collateralAmount: 1000000n, debtBps: 10000n, executor,
    runtimeEvidence: [], source, generation: source.generation, runtime: f.runtime });
  assert.notEqual(result.status, "resolved");
  const withoutActive = raw(); withoutActive.binding.flow.steps.pop(); withoutActive.binding.flow.result = "$steps.assets";
  await assert.rejects(fixture({ definition: withoutActive }).publish(), /active position proof/);
});

test("historical Credit harness resolves selector ownership and the full credit Graph from issued Ready evidence", async () => {
  const [{ PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG: catalog }, { familyMemoDefinitionHash }] = await Promise.all([
    import("../venues/production-family-composition.js"), import("../universe-rebuild-production.js"),
  ]);
  const f = fixture({ catalog }), publication = await f.publish(), instance = publication.instances[0]!;
  const encode = (value: unknown) => JSON.parse(JSON.stringify(value, (_key, item) => typeof item === "bigint" ? { $durableType: "bigint", value: String(item) }
    : item && typeof item.entries === "function" && typeof item.get === "function" ? { $durableType: "map", entries: [...item.entries()] } : item));
  const memo: any = { familyCandidateKey: "offline-credit-candidate", familyInstanceKey: "offline-credit-instance", familyId: publication.familyId,
    candidateKey: instance.candidateKey, instanceKey: instance.instanceKey, candidateFingerprint: "offline-fixture", familyDefinitionHash: familyMemoDefinitionHash(publication.familyId),
    validity: { policy: "immutable-code", authorityFingerprint: "offline-fixture", proofSource: { number: source.number, hash: source.hash } },
    verifiedIdentity: { lineageId: instance.lineageId }, compiledDescriptor: encode(instance.descriptor),
    staticProjection: encode({ routes: instance.routes, pricingInstances: instance.pricingInstances, staticBindingFingerprint: instance.staticBindingFingerprint,
      staticEvidenceFingerprint: instance.staticEvidenceFingerprint, evidenceRefs: instance.evidenceRefs }), evidenceFingerprint: instance.staticEvidenceFingerprint,
    candidateSnapshot: { ...(instance.descriptor as any).candidate, familyId: publication.familyId, address: target }, memoFingerprint: "" };
  memo.memoFingerprint = durableVerifiedMemoFingerprint(memo);
  const credit = prepareCreditFamilyRoutes({ family: f.family, instance, source, generation: source.generation });
  const edges = credit.routes.map(route => projectCreditRouteGraph({ family: f.family, route }).edge), catalogSnapshot = buildReadyCatalogSnapshot([memo]);
  const graphSnapshot = { format: "strict-rebuild-graph-v1", edges };
  const envelope: any = { revision: 1, verifiedMemos: { [memo.familyCandidateKey]: memo }, inProgressRun: null, retryableAttemptsByCandidateKey: {}, checkpointFingerprint: "offline-fixture",
    readyGeneration: { generation: source.generation, cutoff: source, universeRange: { fromBlock: source.number, toBlock: source.number }, universeHash: "offline-fixture",
      catalogSnapshot, catalogHash: hashReadyCatalogSnapshot(catalogSnapshot), publicationSetHash: hashReadyPublicationSet(catalogSnapshot), activeInstanceKeys: [memo.familyInstanceKey],
      graphSnapshot, graphHash: hashReadyGraphSnapshot(graphSnapshot), candidateAccounting: { total: 1, verified: 1, terminalRejected: 0, retryable: 0, remainingUnaccounted: 0 },
      observedThrough: source, appliedThrough: source, sourceCoverage: [{ familyId: publication.familyId, sourceId: "offline-fixture", completeThroughBlock: source.number, completeThroughHash: source.hash }] } };
  const routes = await transactionReadyRoutes(envelope, { source, executor, owner: sender });
  assert.equal(routes.length, 1); assert.equal(routes[0]!.execution?.domain, "credit");
  const expected = { id: "credit-selector-reference", familyId: "retired:credit-label", domain: "credit" as const, source: { number: source.number, hash: source.hash }, instanceKey: target,
    tokenIn: collateral, tokenOut: debt, amountIn: "1000000", amountScope: "test", credit: { debtBps: 10000 }, actors: { executor, owner: sender } };
  const transaction = { version: 1 as const, chainId: 1 as const, transactionHash: h(500), legs: [expected] };
  const evidence: any = { method: "debug_traceTransaction", receipt: { transactionHash: h(500), blockNumber: source.number, blockHash: source.hash, transactionIndex: 0, status: 1, logs: [] },
    rawTrace: { type: "CALL", from: sender, to: target, input: f.observation.data, gas: "0xffff", value: "0x0", output: "0x", gasUsed: "0x1" } };
  const binding = resolveTransactionCaseBinding({ transactionHash: h(500), evidence, routes, expected, familyBinding: "selector" });
  assert.equal(binding.selection, "selector-call"); assert.equal(binding.resolved.familyId, publication.familyId); assert.equal(binding.resolved.domain, "credit");
  const sample = transactionSimulationCase(transaction, expected, undefined, binding.resolved), selected = await assertAcceptanceReadyTarget(envelope, sample);
  assert.equal(selected.edges.length, 1); assert.equal(selected.edges[0]!.edgeKind, "credit"); assert.equal(sample.trials[0]!.credit?.debtBps, 10000);
  assert.throws(() => resolveTransactionCaseBinding({ transactionHash: h(500), evidence, routes, expected: { ...expected, domain: "protocol", credit: undefined }, familyBinding: "selector" }), /absent or unsupported/);
});
