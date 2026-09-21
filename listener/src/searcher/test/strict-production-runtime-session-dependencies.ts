import assert from "node:assert/strict";
import { ethers } from "ethers";
import { runUniv2Lifecycle, UNIV2_FIXTURE_FACTORY, UNIV2_FIXTURE_TOKEN0, UNIV2_FIXTURE_TOKEN1 } from
  "../architecture-migration-fixture-replay.js";
import { buildFamilyRouteGraphView } from "../adapter-family-graph-runtime.js";
import { readBlockTouchedStateKeys } from "../blockscan-touched-state.js";
import { createStrictCentralAdapterRuntime } from "../strict-central-adapter-runtime.js";
import { StrictProductionRuntimeRoot } from "../strict-production-runtime-session.js";
import { defineSwapFamily, definedFamilyPluginContractSummary } from "../venues/adapter-family-plugin.js";
import type { CompiledMutationIndex, MutationSemantics } from "../venues/adapter-family-plugin.js";
import { capabilityManifestHash, FAMILY_CAPABILITY_NAMES, FamilyCapabilityCatalog } from "../venues/family-capability-catalog.js";
import { PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG as productionCatalog } from "../venues/production-family-composition.js";
import { plugin as v2Plugin } from "../venues/production-families/univ2-standard.production.js";
import { UNIV2_PAIR_INTERFACE, UNIV2_SYNC_TOPIC, UNIV2_TOKEN_INTERFACE } from "../venues/swaps/univ2-family/codec.js";

const address = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const ready = { number: 100, hash: `0x${"11".repeat(32)}`, generation: 1 };
const current = { number: 101, hash: `0x${"22".repeat(32)}`, generation: 2 };
const txHash = `0x${"33".repeat(32)}`;
const pools = [address(1001), address(1002)];
const anchor = { hash: current.hash, parentHash: ready.hash, transactionHashes: [txHash] };

async function makeRoot(catalog = productionCatalog) {
  const publications = await Promise.all(pools.map(pool => runUniv2Lifecycle(ready, {
    pool, factory: UNIV2_FIXTURE_FACTORY, token0: UNIV2_FIXTURE_TOKEN0, token1: UNIV2_FIXTURE_TOKEN1,
  }, catalog)));
  const instances = publications.flatMap(publication => publication.instances);
  const graph = buildFamilyRouteGraphView({ routes: instances.flatMap(instance => instance.routes.map((route, index) => ({
    family: catalog.forFamily(instance.familyId), descriptor: instance.descriptor, route, handle: instance.routeHandles[index],
  }))) });
  return new StrictProductionRuntimeRoot({ catalog, readySource: ready, readyGraph: graph.edges,
    readyInstances: instances, readyFundingAssets: [] });
}

const root = await makeRoot();
const resolver = root.resolveBlockTouchedStateKeys;
assert.strictEqual(root.resolveBlockTouchedStateKeys, resolver, "one stable interpreter per root");
assert.notStrictEqual((await makeRoot()).resolveBlockTouchedStateKeys, resolver, "different roots cannot share derived-cache authority");
assert.deepEqual(resolver({ kind: "call", target: UNIV2_FIXTURE_TOKEN0, data: "0x" }, current), []);
assert.deepEqual(resolver({ kind: "log", address: UNIV2_FIXTURE_TOKEN0, topics: [UNIV2_SYNC_TOPIC], data: "0x" }, current), [],
  "shared token dependency cannot bypass the Family's emitter filter");
assert.deepEqual(resolver({ kind: "log", address: pools[0]!, topics: [UNIV2_SYNC_TOPIC], data: "0x" }, current), [pools[0]],
  "only the owning state is returned for a Family-approved mutation");
assert.deepEqual(resolver({ kind: "log", address: pools[0]!, topics: [], data: "0x" }, current), [],
  "Family topic filtering remains authoritative for dependency-derived keys");

const tokenTouched = await readBlockTouchedStateKeys({
  getLogs: async () => [],
  send: async () => [{ txHash, result: { type: "CALL", from: address(2001), to: UNIV2_FIXTURE_TOKEN0,
    input: "0x12345678", gas: "0x100", gasUsed: "0x80" } }],
}, current.number, ethers.ZeroAddress, anchor, undefined, resolver);
assert(pools.every(pool => !tokenTouched.has(pool)), "shared token call does not dirty every dependent pool");
const rawReads: string[] = [];
let failPricing = false;
const runtime = createStrictCentralAdapterRuntime({
  provider: {
    async call(request) {
      if (request.data.startsWith(UNIV2_PAIR_INTERFACE.getFunction("getReserves")!.selector)) {
        rawReads.push(request.to.toLowerCase());
        if (failPricing) throw new Error("incomplete current state");
        return UNIV2_PAIR_INTERFACE.encodeFunctionResult("getReserves", [1_000_000n, 3_000_000n, 2]);
      }
      return UNIV2_TOKEN_INTERFACE.encodeFunctionResult("balanceOf", [10n ** 24n]);
    },
    getCode: async () => "0x01", getStorage: async () => `0x${"00".repeat(32)}`,
  },
  generationFence: { assertCurrent(generation, source) { assert.equal(generation, current.generation); assert.deepEqual(source, current); } },
});
const clean = await root.createSession({ source: current, runtime, fundingAssets: [], touchedPools: tokenTouched });
assert.equal(clean.creationTiming.selectedInstanceCount, 0);
assert.deepEqual(rawReads, [], "unrelated dependency activity performs no current pool reads");
const affected = new Set(resolver({ kind: "log", address: pools[0]!, topics: [UNIV2_SYNC_TOPIC], data: "0x" }, current));
const refreshed = await root.createSession({ source: current, runtime, fundingAssets: [], touchedPools: affected });
assert.deepEqual(rawReads, [pools[0]], "only the mutation-selected pool is read");
assert.equal(refreshed.creationTiming.refreshedInstanceCount, 1);
assert(refreshed.edges.every(edge => refreshed.currentPricingForEdge(edge)?.status === "priced"));
failPricing = true;
const failed = await root.createSession({ source: current, runtime, fundingAssets: [], touchedPools: affected });
assert(failed.edges.every(edge => failed.currentPricingForEdge(edge)?.status === "unresolved"),
  "incomplete dirty state cannot republish Ready prices");

// Exercise the optional-mutation fallback with real lifecycle-issued instances.
function mutable<T>(value: T): T {
  if (Array.isArray(value)) return value.map(mutable) as T;
  if (value !== null && typeof value === "object") return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, mutable(entry)])) as T;
  return value;
}
const { mutation: _mutation, ...pricingWithoutMutation } = v2Plugin.pricing;
const fallbackPlugin = defineSwapFamily({ ...mutable({ ...v2Plugin, pricing: {
  ...pricingWithoutMutation,
  dependencies: (input: Parameters<typeof v2Plugin.pricing.dependencies>[0]) => [
    ...v2Plugin.pricing.dependencies(input), "opaque:dependency",
  ],
} }),
  actionAdapters: v2Plugin.actionAdapters });
function fixtureCatalog(plugin: typeof fallbackPlugin) {
const entries = FAMILY_CAPABILITY_NAMES.map(capability => ({ familyId: plugin.manifest.familyId,
  capability, contractVersion: "dependency-fallback-fixture-v1", contentHash: ethers.sha256(ethers.toUtf8Bytes(capability)).slice(2),
  semanticDependencies: [`contract:${capability}`], provenanceCommit: null }));
return new FamilyCapabilityCatalog({
  modules: [{ sourceFile: "fixture/dependency-fallback.production.ts", plugin,
    definitionBoundaryHash: definedFamilyPluginContractSummary(plugin).definitionBoundaryHash }],
  generatedManifest: { format: "adapter-family-capabilities-v1", entries, manifestHash: capabilityManifestHash(entries) },
});
}
const fallbackCatalog = fixtureCatalog(fallbackPlugin);
const fallbackRoot = await makeRoot(fallbackCatalog); // An issued opaque dependency must not prevent startup.
assert.deepEqual(new Set(fallbackRoot.resolveBlockTouchedStateKeys({ kind: "call", target: UNIV2_FIXTURE_TOKEN0, data: "0x" }, current)),
  new Set(pools), "only Families lacking mutation conservatively invalidate dependency owners");
assert.deepEqual(fallbackRoot.resolveBlockTouchedStateKeys({ kind: "call", target: address(9999), data: "0x" }, current), [],
  "conservative fallback is still limited to declared dependency owners");
// The producer must invoke a startup-compiled Family index, never iterate its
// pricing directions. The compiler is per root, not a cross-generation cache.
let compileCount = 0, eventCount = 0;
type Input = Parameters<NonNullable<typeof v2Plugin.pricing.mutation>["affectedStateKeys"]>[0];
function compiledCatalog(compile: NonNullable<MutationSemantics<Input["descriptor"], Input["routes"][number]>["compile"]>) {
  return fixtureCatalog(defineSwapFamily({ ...mutable(v2Plugin), pricing: {
    ...mutable(v2Plugin.pricing), mutation: {
      compile,
      affectedStateKeys() { throw new Error("legacy per-entry dispatch used"); },
    },
  }, actionAdapters: v2Plugin.actionAdapters }));
}
const compiled = compiledCatalog(({ entries }) => {
  compileCount++;
  assert.equal(entries.length, 2);
  const keys = entries.map(entry => entry.stateKey);
  return {
    dependencies: [UNIV2_FIXTURE_TOKEN0, UNIV2_FIXTURE_TOKEN0.toLowerCase()],
    affectedStateKeys({ observation }) {
      eventCount++;
      assert.equal(observation.source.generation, ready.generation);
      return observation.kind === "call" ? keys : [];
    },
  };
});
const compiledRoot = await makeRoot(compiled);
for (let i = 0; i < 3; i++) {
  assert.deepEqual(new Set(compiledRoot.resolveBlockTouchedStateKeys({ kind: "call", target: UNIV2_FIXTURE_TOKEN0, data: "0x" }, current)), new Set(pools));
}
assert.equal(compileCount, 1);
assert.equal(eventCount, 3, "one dispatch per Family/event, even for shared dependencies and directions");
await makeRoot(compiled);
assert.equal(compileCount, 2, "each Ready root compiles a fresh isolated index");
await assert.rejects(makeRoot(compiledCatalog(() => ({ dependencies: [address(9999)], affectedStateKeys: () => [] }))),
  /exceeds declared dependencies/);
await assert.rejects(makeRoot(compiledCatalog(() => Promise.resolve({}) as unknown as CompiledMutationIndex)),
  /synchronous|invalid compiled mutation index/);
const invalidRoot = await makeRoot(compiledCatalog(() => ({ dependencies: [UNIV2_FIXTURE_TOKEN0],
  affectedStateKeys: () => Promise.resolve([]) as unknown as readonly string[] })));
assert.throws(() => invalidRoot.resolveBlockTouchedStateKeys({ kind: "call", target: UNIV2_FIXTURE_TOKEN0, data: "0x" }, current),
  /thenable.*synchronous/);
let asyncEntered = false;
await assert.rejects(makeRoot(compiledCatalog(() => ({ dependencies: [UNIV2_FIXTURE_TOKEN0],
  affectedStateKeys: (async () => { asyncEntered = true; return []; }) as unknown as CompiledMutationIndex["affectedStateKeys"] }))),
  /must be synchronous/);
assert.equal(asyncEntered, false, "reject an async callback at startup, before it can execute");
const thenableRoot = await makeRoot(compiledCatalog(() => ({ dependencies: [UNIV2_FIXTURE_TOKEN0],
  affectedStateKeys: () => Object.assign([pools[0]!], { then() {} }) })));
assert.throws(() => thenableRoot.resolveBlockTouchedStateKeys({ kind: "call", target: UNIV2_FIXTURE_TOKEN0, data: "0x" }, current),
  /thenable.*synchronous/, "an array is not exempt from the non-thenable result contract");
const returnedIndex = { dependencies: [UNIV2_FIXTURE_TOKEN0], affectedStateKeys: () => [pools[0]!] };
const sealedRoot = await makeRoot(compiledCatalog(() => returnedIndex));
const provider = {
  getLogs: async () => [],
  send: async () => [{ txHash, result: { type: "CALL", from: address(2001), to: UNIV2_FIXTURE_TOKEN0,
    input: "0x12345678", gas: "0x100", gasUsed: "0x80" } }],
};
const cachedBefore = await readBlockTouchedStateKeys(provider, current.number, ethers.ZeroAddress, anchor, undefined, sealedRoot.resolveBlockTouchedStateKeys);
returnedIndex.affectedStateKeys = () => [pools[1]!];
returnedIndex.dependencies.push(address(9999));
assert.deepEqual(sealedRoot.resolveBlockTouchedStateKeys({ kind: "call", target: UNIV2_FIXTURE_TOKEN0, data: "0x" }, current), [pools[0]],
  "the root captures the callback rather than retaining the Family's mutable object");
const cachedAfter = await readBlockTouchedStateKeys(provider, current.number, ethers.ZeroAddress, anchor, undefined, sealedRoot.resolveBlockTouchedStateKeys);
assert.deepEqual(cachedAfter, cachedBefore);
assert(cachedAfter.has(pools[0]!) && !cachedAfter.has(pools[1]!));
console.log("strict-production-runtime-session-dependencies PASS (sparse reads, failure, root isolation, optional mutation, opaque dependency, compiled dispatch + guards)");
