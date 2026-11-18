import assert from "node:assert/strict";
import test from "node:test";
import { FunctionFragment, Interface, toBeHex } from "ethers";
import { readySelectorCensusFromTransaction } from "../ready-selector-census.js";
import { buildFamilyRouteGraphView } from "../adapter-family-graph-runtime.js";
import { createStrictCentralAdapterRuntime } from "../strict-central-adapter-runtime.js";
import { runStrictFamilyLifecycle } from "../strict-family-lifecycle-runner.js";
import { StrictProductionRuntimeRoot } from "../strict-production-runtime-session.js";
import { impactMatchesAdmittedEdge, createVictimSourceGeneration } from "../detector/pool-impact.js";
import { defineSwapFamily, definedFamilyPluginContractSummary } from "../venues/adapter-family-plugin.js";
import { FamilyCapabilityCatalog, FAMILY_CAPABILITY_NAMES, capabilityManifestHash } from "../venues/family-capability-catalog.js";
import { compileSelectorNativeExecutionFamily } from "../venues/selector-native-family.js";
import { hashCanonical } from "../venues/canonical-value.js";
import { blockScanEdgeMetadataFingerprint } from "../venues/blockscan-state-capability.js";
import { edgeObservationTarget, edgeObservationPoolIdEquals } from "../venues/route-observation-identity.js";
import { explicitStateResourceOverlap, normalizeStateResourceKeys } from "../venues/route-state-resources.js";

const a = (n: number) => toBeHex(n, 20), h = (n: number) => toBeHex(n, 32);
const routerA = a(101), routerB = a(102), pool = a(201), holder = a(202), curve = a(203), tokenIn = a(301), tokenOut = a(302), sender = a(401), executor = a(402), poolId = h(501);
const source = { number: 100, hash: h(100), generation: 1 };
const eventSignature = "event Swapped(address pool,address tokenIn,address tokenOut,uint256 amountIn,uint256 amountOut,bytes32 poolId)";
const eventAbi = new Interface([eventSignature]);
function definition(name: string, alternatives = false, composite = false) {
  const signature = `function ${name}(address,address,uint256,address) returns(uint256)`;
  const execution = { version: 1, requireCanonicalSource: true, settlement: { directOutput: true },
    call: { target: "$candidate.target", signature, args: ["$route.tokenIn", "$route.tokenOut", { runtime: "amountIn" }, "$recipient"] },
    protectedAddresses: ["$candidate.target", "$route.tokenIn", "$route.tokenOut"], effects: [
      { kind: "debit", token: "$route.tokenIn", account: "$executor", equals: { runtime: "amountIn" } },
      { kind: "credit", token: "$route.tokenOut", account: "$recipient", minimum: "$minAmountOut" }, { kind: "unchanged-native" }] };
  const program = { parameters: [{ path: [0], role: "tokenIn" }, { path: [1], role: "tokenOut" }, { path: [2], role: "amountIn" }, { path: [3], role: "recipient" }], execution,
    routes: { target: pool, resource: { target: holder, poolId, poolNamespace: "shared-vault" },
      ...(composite ? { resources: [{ target: curve }, { target: holder, poolId, poolNamespace: "shared-vault" }, { target: curve }] } : {}),
      directions: [{ id: "forward", enabled: true, tokenIn, tokenOut, taxonomy: { slotKind: "swap" } }] },
    observations: { version: 1, canonicalIntakeTargets: [], victimSupport: "detect-only", events: [{ id: "swapped", signature: eventSignature,
      classification: "swap", pool: "$args.pool", payload: "$args", requireReadyBinding: true,
      match: { op: "and", args: [{ op: "sameAddress", args: ["$args.tokenIn", "$edge.tokenIn"] }, { op: "sameAddress", args: ["$args.tokenOut", "$edge.tokenOut"] },
        { op: "eq", args: ["$args.poolId", "$edge.observationPoolId"] }] },
      impact: { pool: "$edge.observationTarget", poolId: "$edge.observationPoolId", tokenIn: "$edge.tokenIn", tokenOut: "$edge.tokenOut", amountIn: "$args.amountIn", amountOut: "$args.amountOut", matchedAdapterId: "$edge.adapterId" } }] } };
  return { format: "selector-family/v2", selector: FunctionFragment.from(signature).selector, signature, domain: "swap", programs: [program,
    ...(alternatives ? [{ ...program, execution: { ...execution, approval: { token: "$route.tokenIn", spender: "$candidate.target", mode: "exact-clear", verifyAllowance: true } } }] : [])] };
}
async function fixture(composite = false) {
  const definitions = [definition("convert", true, composite), definition("convertOther")];
  const plugins = definitions.map(raw => defineSwapFamily(compileSelectorNativeExecutionFamily<"swap">(raw)));
  const entries = plugins.flatMap(plugin => FAMILY_CAPABILITY_NAMES.map(capability => ({ familyId: plugin.manifest.familyId, capability,
    contractVersion: "native-resource-fixture/v1", contentHash: hashCanonical({ family: plugin.manifest.familyId, capability }), semanticDependencies: [`contract:${capability}`], provenanceCommit: null })));
  const catalog = new FamilyCapabilityCatalog({ modules: plugins.map((plugin, index) => ({ sourceFile: `fixture/resource-${index}.production.ts`, plugin,
    definitionBoundaryHash: definedFamilyPluginContractSummary(plugin).definitionBoundaryHash })),
    generatedManifest: { format: "adapter-family-capabilities-v1", entries, manifestHash: capabilityManifestHash(entries) } });
  const runtime = createStrictCentralAdapterRuntime({ executor, transactionOrigin: sender,
    generationFence: { assertCurrent(g, s) { assert.equal(g, source.generation); assert.deepEqual(s, source); } },
    provider: { async getCode() { assert.fail("parameter-only Ready needs no code RPC"); }, async getStorage() { assert.fail("no storage RPC"); }, async call() { assert.fail("no call RPC"); } } });
  const publications = await Promise.all(plugins.map((plugin, index) => {
    const raw = definitions[index]!, abi = new Interface([raw.signature]);
    // One selector and one recipe may be exposed by several routers that
    // ultimately consume the same physical pool. Their price bindings differ.
    const observations = (index === 0 ? [routerA, routerB] : [routerB]).map((target, callIndex) => {
      const transactionIndex = index * 2 + callIndex;
      const census = readySelectorCensusFromTransaction({ chainId: 1, blockNumber: source.number, blockHash: source.hash, transactionHash: h(700 + transactionIndex),
        transactionIndex, status: 1, from: sender, to: target, input: abi.encodeFunctionData(raw.selector, [tokenIn, tokenOut, 7n, sender]), logs: [], traces: [] });
      return { kind: "call" as const, source, target, sender, transactionHash: census.transactionHash!, data: census.calls[0]!.calldata!, traceAddress: [],
        opaque: { selectorCensus: census, callId: census.calls[0]!.id } as any };
    });
    return runStrictFamilyLifecycle({ catalog, familyId: plugin.manifest.familyId, source, runtime, observations });
  }));
  const instances = publications.flatMap(p => p.instances);
  assert.equal(instances.length, 5, JSON.stringify(publications.flatMap(p => p.outcomes)));
  const graph = buildFamilyRouteGraphView({ routes: instances.flatMap(instance => instance.routes.map((route, index) => ({ family: catalog.forFamily(instance.familyId),
    descriptor: instance.descriptor, route, handle: instance.routeHandles[index]! }))) });
  const root = new StrictProductionRuntimeRoot({ catalog, readySource: source, readyGraph: graph.edges, readyInstances: instances, readyFundingAssets: [] });
  return { plugins, instances, graph, root, runtime, catalog };
}

test("issued Graph keeps execution targets distinct and refreshes every selector/recipe on a shared physical touch", async () => {
  const f = await fixture();
  assert.equal(new Set(f.graph.edges.map(edge => edge.canonicalEdgeId)).size, 5);
  assert.deepEqual(new Set(f.graph.edges.map(edge => edge.target.toLowerCase())), new Set([routerA, routerB]));
  assert(f.graph.edges.every(edge => edge.observationTarget === pool && edge.observationPoolId === poolId));
  assert.equal(new Set(f.graph.edges.map(edge => edge.stateResourceKey)).size, 1);
  const keys = new Set(f.instances.flatMap(instance => instance.pricingInstances.map(pricing => String(pricing.stateKey))));
  assert.equal(keys.size, 5, "same selector and recipe on two entry routers must retain distinct price bindings");
  assert.deepEqual(new Set(f.root.pricingIndex().instanceIndexesByStateKey.keys()), keys,
    "historical full refresh uses every selector/recipe state key, not deduplicated pool or router addresses");
  const touched = f.root.resolveBlockTouchedStateKeys({ kind: "log", address: holder, topics: [], data: "0x" }, { number: 101, hash: h(101) });
  assert.deepEqual(new Set(touched), keys, "a physical holder update reaches every recipe, regardless of selector/entry router");
  assert.equal(new Set(touched).size, 5);
  const session = await f.root.createSession({ source, runtime: f.runtime, fundingAssets: [] });
  const edge = session.edges[0]!; assert(session.stateKeyForEdge(edge));
  assert.throws(() => session.stateKeyForEdge({ ...edge, observationTarget: routerB }), /edge shell diverged/);
  assert.throws(() => session.stateKeyForEdge({ ...edge, observationPoolId: h(999) }), /edge shell diverged/);
  assert.notEqual(blockScanEdgeMetadataFingerprint(edge), blockScanEdgeMetadataFingerprint({ ...edge, observationTarget: routerB }));
});

test("issued composite resources retain every physical touch and bind canonical resource sets against tampering", async () => {
  const f = await fixture(true), composite = f.graph.edges.filter(edge => edge.stateResourceKeys !== undefined);
  assert.equal(composite.length, 4);
  const single = f.graph.edges.find(edge => edge.stateResourceKeys === undefined)!;
  assert(composite.every(edge => edge.stateResourceKeys!.length === 2 && Object.isFrozen(edge.stateResourceKeys)));
  assert(composite.every(edge => explicitStateResourceOverlap(edge, single) === true));
  const touched = f.root.resolveBlockTouchedStateKeys({ kind: "log", address: curve, topics: [], data: "0x" }, { number: 101, hash: h(101) });
  assert.equal(new Set(touched).size, 4, "the additional inner curve refreshes all and only its composite price bindings");
  const session = await f.root.createSession({ source, runtime: f.runtime, fundingAssets: [] });
  const edge = session.edges.find(edge => edge.stateResourceKeys !== undefined)!;
  const reversed = [...edge.stateResourceKeys!].reverse();
  assert.equal(blockScanEdgeMetadataFingerprint(edge), blockScanEdgeMetadataFingerprint({ ...edge, stateResourceKeys: reversed }));
  assert.throws(() => session.stateKeyForEdge({ ...edge, stateResourceKeys: [edge.stateResourceKeys![0]!] }), /edge shell diverged/);
  assert.throws(() => session.stateKeyForEdge({ ...edge, stateResourceKeys: undefined }), /edge shell diverged/);
  assert.deepEqual(normalizeStateResourceKeys(["b", "a", "a"]), ["a", "b"]);
  for (const invalid of [[], [""], ["bad\nkey"], [, "a"], ["a".repeat(1025)]])
    assert.throws(() => normalizeStateResourceKeys(invalid));
});

test("native receipt wrapper and actual detector admission match the bound pool instead of the execution router", async () => {
  const f = await fixture(), plugin = f.plugins[0]!, edges = f.graph.edges.filter(edge => edge.adapterId === plugin.manifest.ownedActionAdapterIds[0]);
  const encoded = eventAbi.encodeEventLog(eventAbi.getEvent("Swapped")!, [pool, tokenIn, tokenOut, 7n, 11n, poolId]);
  const log = { address: holder, topics: encoded.topics, data: encoded.data, blockNumber: 101, blockHash: h(101), transactionHash: h(800) };
  const generation = createVictimSourceGeneration({ sourceBlock: 100, sourceBlockHash: source.hash, receiptId: h(800), receiptBlockNumber: 101,
    receiptBlockHash: h(101), receiptParentBlockHash: source.hash, receiptTransactionHash: h(800), logs: [log], logsCompleteness: "complete-receipt" });
  const rootObservation = plugin.swap.receiptObservation!;
  const result = await rootObservation.decodeReceiptImpacts({ logs: [log], graph: edges, edgesByTarget: new Map([[pool, edges]]), sourceGeneration: generation,
    resolveBinding: f.root.resolveSwapObservationBinding, matchedOwnedTriggers: [{ triggerId: "trigger:0", logIndex: 0, emitter: holder, topic0: log.topics[0]! }],
    control: { deadlineAtMs: Date.now() + 10_000, signal: new AbortController().signal } });
  assert.equal(result.status, "resolved", JSON.stringify(result, (_k, value) => typeof value === "bigint" ? String(value) : value));
  if (result.status !== "resolved") return;
  assert.equal(result.impacts.length, 1, "same selector execution alternatives do not duplicate one physical event");
  const impact = result.impacts[0]!.impact;
  assert.equal(impact.pool, pool); assert.equal(impact.poolId, poolId); assert.equal(impact.amountOut, 11n);
  assert(impactMatchesAdmittedEdge(impact, f.graph.edges));
  assert(!impactMatchesAdmittedEdge({ ...impact, pool: routerA }, f.graph.edges));
  assert(!impactMatchesAdmittedEdge({ ...impact, poolId: h(999) }, f.graph.edges));
  assert.equal(edgeObservationTarget(edges[0]!), pool);
  assert(edgeObservationPoolIdEquals({ ...edges[0]!, observationPoolId: "PoolA" }, "PoolA"));
  assert(!edgeObservationPoolIdEquals({ ...edges[0]!, observationPoolId: "PoolA" }, "poola"));
});
