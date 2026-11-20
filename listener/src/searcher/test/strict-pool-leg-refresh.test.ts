import assert from "node:assert/strict";
import test from "node:test";
import { FunctionFragment, Interface, toBeHex } from "ethers";
import { buildFamilyRouteGraphView } from "../adapter-family-graph-runtime.js";
import { readySelectorCensusFromTransaction } from "../ready-selector-census.js";
import { createStrictCentralAdapterRuntime } from "../strict-central-adapter-runtime.js";
import { runStrictFamilyLifecycle } from "../strict-family-lifecycle-runner.js";
import { StrictProductionRuntimeRoot } from "../strict-production-runtime-session.js";
import { defineSwapFamily, definedFamilyPluginContractSummary } from "../venues/adapter-family-plugin.js";
import { FamilyCapabilityCatalog, FAMILY_CAPABILITY_NAMES, capabilityManifestHash } from "../venues/family-capability-catalog.js";
import { hashCanonical } from "../venues/canonical-value.js";
import { compileSelectorNativeExecutionFamily } from "../venues/selector-native-family.js";
import { normalizeSelectorNativeExecutionDefinition } from "../venues/selector-native-definition.js";
import { createSqlEdgePriceLogScopes } from "../venues/sql-edge-price-log-scopes.js";

// This is a synthetic registered-Family contract test. Every handle is issued
// by the real lifecycle; no historical receipt or production admission is claimed.
type Data = Record<string, any>;
const address = (n: number) => toBeHex(n, 20), hash = (n: number) => toBeHex(n, 32);
const poolA = address(101), poolB = address(102), manager = address(103), foreignManager = address(104);
const tokenIn = address(201), tokenOut = address(202), oracle = address(203), executor = address(301), owner = address(302);
const id1 = hash(401), id2 = hash(402), source = { number: 100, hash: hash(100), generation: 1 };
const block = { number: 101, hash: hash(101) };
const managerEvent = "event PoolChanged(bytes32 indexed poolId,uint256 amountIn,uint256 amountOut)";
const managerAbi = new Interface([managerEvent]);
const transferAbi = new Interface(["event Transfer(address indexed from,address indexed to,uint256 value)"]);

function definition(name: string, physical: string, managed = false, independent = false) {
  const signature = `function ${name}(${managed ? "bytes32," : ""}address,address,uint256,address) returns(uint256)`;
  const selector = FunctionFragment.from(signature).selector;
  const roles = [...(managed ? ["poolId"] : []), "tokenIn", "tokenOut", "amountIn", "recipient"];
  const target = managed ? "$descriptor.manager" : physical;
  const eventTopic = managerAbi.getEvent("PoolChanged")!.topicHash;
  const program: Data = {
    parameters: roles.map((role, i) => ({ path: [i], role })),
    ...(managed ? { binding: { nomination: { poolNamespace: "fixture-manager", poolIdLogs: [{ emitter: "call-target", topic: eventTopic, topicIndex: 1 }] },
      descriptor: { manager: physical, poolId: "$scope.poolId" } } } : {}),
    ...(independent ? { dependencies: [oracle] } : {}),
    refreshPolicy: independent ? "each-block" : "on-touch",
    routes: { target,
      resource: { target, ...(managed ? { poolId: "$descriptor.poolId", poolNamespace: "fixture-manager" } : {}) },
      ...(managed ? { venue: { kind: "manager-pool-id", manager: target, poolId: "$descriptor.poolId" },
        checks: [{ assert: { op: "sameAddress", args: [target, physical] } }] } : {}),
      directions: [
        { id: "forward", enabled: true, tokenIn, tokenOut, taxonomy: { slotKind: "swap" } },
        { id: "reverse", enabled: true, tokenIn: tokenOut, tokenOut: tokenIn, taxonomy: { slotKind: "swap" } },
      ] },
    execution: { version: 1, requireCanonicalSource: true, settlement: { directOutput: true },
      call: { target: "$candidate.target", signature, args: [...(managed ? ["$descriptor.poolId"] : []), "$route.tokenIn", "$route.tokenOut", { runtime: "amountIn" }, "$recipient"] },
      protectedAddresses: ["$candidate.target", "$route.tokenIn", "$route.tokenOut"], effects: [
        { kind: "debit", token: "$route.tokenIn", account: "$executor", equals: { runtime: "amountIn" } },
        { kind: "credit", token: "$route.tokenOut", account: "$recipient", minimum: "$minAmountOut" }, { kind: "unchanged-native" },
      ] },
    ...(managed ? { observations: { version: 1, canonicalIntakeTargets: [], victimSupport: "detect-only", events: [{ id: "changed", signature: managerEvent,
      classification: "swap", pool: "$args.poolId", payload: { poolId: "$args.poolId" },
      valid: { op: "sameAddress", args: ["$log.address", physical] },
      match: { op: "eq", args: ["$args.poolId", "$edge.observationPoolId"] },
      impact: { pool: "$edge.observationTarget", poolId: "$args.poolId", tokenIn: "$edge.tokenIn", tokenOut: "$edge.tokenOut",
        amountIn: "$args.amountIn", amountOut: "$args.amountOut", matchedAdapterId: "$edge.adapterId" } }] } } : {}),
  };
  return normalizeSelectorNativeExecutionDefinition({ format: "selector-family/v2", selector, signature, domain: "swap", programs: [program] });
}

async function createFixture() {
  const definitions = [definition("sharedAlpha", poolA), definition("sharedBeta", poolA), definition("unrelated", poolB, false, true),
    definition("managed", manager, true), definition("foreignManaged", foreignManager, true)];
  const plugins = definitions.map((raw, i) => {
    const compiled = compileSelectorNativeExecutionFamily<"swap">(raw);
    // Isolate the new pool hook: the fixture's ordinary Family mutation owns
    // only the independent oracle, not physical pool events or balance owners.
    const mutation: any = {
      compile({ entries }: Data) {
        const keys = Object.freeze(entries.map((e: Data) => String(e.stateKey)));
        return { dependencies: i === 2 ? [oracle] : [], affectedStateKeys({ observation }: Data) {
          const a = observation.kind === "log" ? observation.address : observation.target;
          return i === 2 && a?.toLowerCase() === oracle ? keys : [];
        } };
      },
      affectedStateKeys(input: Data) {
        const a = input.observation.kind === "log" ? input.observation.address : input.observation.target;
        return i === 2 && a?.toLowerCase() === oracle ? input.routes.map((r: Data) => r.pricingStateKey) : [];
      },
    };
    return defineSwapFamily({ ...compiled, pricing: { ...compiled.pricing, mutation } });
  });
  const entries = plugins.flatMap(plugin => FAMILY_CAPABILITY_NAMES.map(capability => ({ familyId: plugin.manifest.familyId, capability,
    contractVersion: "strict-pool-refresh-fixture/v1", contentHash: hashCanonical({ family: plugin.manifest.familyId, capability }),
    semanticDependencies: [`contract:${capability}`], provenanceCommit: null })));
  const catalog = new FamilyCapabilityCatalog({ modules: plugins.map((plugin, i) => ({ sourceFile: `fixture/pool-refresh-${i}.production.ts`, plugin,
    definitionBoundaryHash: definedFamilyPluginContractSummary(plugin).definitionBoundaryHash })),
    generatedManifest: { format: "adapter-family-capabilities-v1", entries, manifestHash: capabilityManifestHash(entries) } });
  let providerReads = 0;
  const noRead = async (): Promise<never> => { providerReads++; throw Error("synthetic parameter-only Ready must not read a provider"); };
  const runtime = createStrictCentralAdapterRuntime({ executor, transactionOrigin: owner,
    generationFence: { assertCurrent(g, s) { assert.equal(g, source.generation); assert.deepEqual(s, source); } },
    provider: { getCode: noRead, getStorage: noRead, call: noRead } });
  const publications = await Promise.all(definitions.map(async (raw, i) => {
    const abi = new Interface([raw.signature]), ids = i === 3 ? [id1, id2] : i === 4 ? [id1] : [undefined];
    const observations = ids.flatMap((poolId, j) => [[tokenIn, tokenOut], [tokenOut, tokenIn]].map(([inputToken, outputToken], direction) => {
      const target = address(500 + i), tx = readySelectorCensusFromTransaction({ chainId: 1, blockNumber: source.number, blockHash: source.hash,
        transactionHash: hash(600 + i * 4 + j * 2 + direction), transactionIndex: i * 4 + j * 2 + direction, status: 1, from: owner, to: target,
        input: abi.encodeFunctionData(raw.selector, [...(poolId === undefined ? [] : [poolId]), inputToken, outputToken, 7n, owner]), logs: [], traces: [] });
      return { kind: "call" as const, source, target, sender: owner, transactionHash: tx.transactionHash!, data: tx.calls[0]!.calldata!, traceAddress: [],
        opaque: { selectorCensus: tx, callId: tx.calls[0]!.id } as any };
    }));
    return runStrictFamilyLifecycle({ catalog, familyId: plugins[i]!.manifest.familyId, source, runtime, observations });
  }));
  const instances = publications.flatMap(p => p.instances);
  assert.equal(instances.length, 12, JSON.stringify(publications.flatMap(p => p.outcomes)));
  const graph = buildFamilyRouteGraphView({ routes: instances.flatMap(instance => instance.routes.map((route, i) => ({
    family: catalog.forFamily(instance.familyId), descriptor: instance.descriptor, route, handle: instance.routeHandles[i]!,
  }))) });
  assert.equal(graph.edges.length, 12);
  const scopes = createSqlEdgePriceLogScopes(definitions);
  const root = new StrictProductionRuntimeRoot({ catalog, readySource: source, readyGraph: graph.edges, readyInstances: instances,
    readyFundingAssets: [], poolLogScopes: scopes });
  assert.equal(providerReads, 0);
  const keysFor = (physical: string, poolId?: string) => new Set(graph.edges.filter(e => e.observationTarget === physical &&
    (poolId === undefined || e.observationPoolId === poolId)).map(e => root.pricingIndex().stateKeyByEdgeKey.get(e.canonicalEdgeId!)!));
  const resolve = (obs: any) => new Set(root.resolveBlockTouchedStateKeys(obs, block));
  return { root, graph, instances, keysFor, resolve, scopes, providerReads };
}
let pending: ReturnType<typeof createFixture> | undefined;
const fixture = () => pending ??= createFixture();

test("real strict Root refreshes all shared selector/direction legs, not an unrelated same-token pool", async () => {
  const f = await fixture(), expected = f.keysFor(poolA);
  assert.equal(f.graph.edges.filter(e => e.observationTarget === poolA).length, 4);
  assert.equal(expected.size, 2, "two selectors retain owners; opposite directions share each selector's pricing state");
  for (const edge of f.graph.edges.filter(e => e.observationTarget === poolA))
    assert(expected.has(f.root.pricingIndex().stateKeyByEdgeKey.get(edge.canonicalEdgeId!)!), "every shared-pool leg has a selected pricing owner");
  assert.deepEqual(f.resolve({ kind: "log", address: poolA, topics: [], data: "0x" }), expected);
  assert.deepEqual(f.resolve({ kind: "call", target: poolA, data: "0x12345678" }), expected);
  assert.deepEqual(f.resolve({ kind: "log", address: poolB, topics: [], data: "0x" }), f.keysFor(poolB));
  assert.deepEqual(f.resolve({ kind: "log", address: tokenIn, topics: [], data: "0x" }), new Set());
  assert(![...expected].some(k => f.keysFor(poolB).has(k)));
});

test("real strict Root narrows decoded manager ID while unknown and passive manager writes remain local fallbacks", async () => {
  const f = await fixture(), encoded = managerAbi.encodeEventLog("PoolChanged", [id1, 1n, 2n]);
  assert.deepEqual(f.scopes({ address: manager, ...encoded }), [id1]);
  assert.deepEqual(f.resolve({ kind: "log", address: manager, ...encoded }), f.keysFor(manager, id1));
  assert.notDeepEqual(f.keysFor(manager, id1), f.keysFor(manager, id2));
  assert.deepEqual(f.resolve({ kind: "log", address: manager, topics: [hash(999)], data: "0x" }), f.keysFor(manager));
  assert.deepEqual(f.resolve({ kind: "call", target: manager, data: "0x" }), f.keysFor(manager));
  assert.deepEqual(new Set(f.root.resolveBlockTouchedStateKeys.passiveStateKeys!([manager], block)), f.keysFor(manager));
  assert(![...f.keysFor(manager)].some(k => f.keysFor(foreignManager).has(k)));
});

test("real strict Root preserves pool donation endpoints plus independent oracle and each-block owners", async () => {
  const f = await fixture(), encoded = transferAbi.encodeEventLog("Transfer", [address(700), poolA, 13n]);
  assert.deepEqual(f.resolve({ kind: "log", address: tokenIn, ...encoded }), f.keysFor(poolA));
  const managerDonation = transferAbi.encodeEventLog("Transfer", [address(700), manager, 13n]);
  assert.deepEqual(f.resolve({ kind: "log", address: tokenIn, ...managerDonation }), f.keysFor(manager));
  assert.deepEqual(new Set(f.root.resolveBlockTouchedStateKeys.passiveStateKeys!([poolA], block)), f.keysFor(poolA));
  assert.deepEqual(f.resolve({ kind: "log", address: oracle, topics: [], data: "0x" }), f.keysFor(poolB));
  assert.deepEqual(new Set(f.root.resolveBlockTouchedStateKeys.passiveStateKeys!([oracle], block)), f.keysFor(poolB));
  assert.deepEqual(new Set(f.root.pricingIndex().perBlockRefreshStateKeys), f.keysFor(poolB));
  assert.equal(f.providerReads, 0);
});
