import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { AbiCoder, Interface, getAddress, keccak256, toBeHex } from "ethers";
import { compileDeclarativeDiscovery, type DeclarativeMappedDiscovery } from "../venues/declarative-discovery.js";
import { createDeclarativeProtocolRuntime } from "../venues/declarative-protocol.js";
import { defineProtocolFamily, definedFamilyPluginContractSummary, type CaptureNominationProvider, type UnifiedObservation } from "../venues/adapter-family-plugin.js";
import { FamilyCapabilityCatalog, FAMILY_CAPABILITY_NAMES, capabilityManifestHash } from "../venues/family-capability-catalog.js";
import root from "../venues/protocols/erc4626-family/erc4626.json";
import custodian from "../venues/protocols/erc4626-family/custodian.json";
import infinifi from "../venues/protocols/erc4626-family/infinifi.json";

// Synthetic shared-engine fixtures; discovery produces candidates, not identity
// admission or historical execution evidence.
const op = (op: string, ...args: unknown[]) => ({ op, args });
const address = (n: number) => getAddress(toBeHex(n, 20));
const target = address(11), actor = address(12), token0 = address(13), token1 = address(14), token2 = address(15);
const config = toBeHex(17, 32), tx = toBeHex(18, 32);
const source = { number: 100, hash: toBeHex(100, 32), generation: 3 };
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const signature = "function trade((address token0,(address token1,bytes32 config) extra) key,uint256 amount)";
const abi = new Interface([signature]);
const poolId = (a: string, b: string, c = config) => keccak256(AbiCoder.defaultAbiCoder().encode(["address", "address", "bytes32"], [a, b, c]));
const hashKey = (args: unknown[]) => op("codeHash", op("abiEncode", ["address", "address", "bytes32"], args));
function definition(): DeclarativeMappedDiscovery {
  return {
    version: 2, sources: ["observed-call", "landed-log"], candidateSources: [], labels: ["fixture-tuples"], nomination: "tx-evidence",
    candidate: { kind: "fixture-tuple", addressField: "subject", fields: {
      subject: "address", token0: "address", token1: "address", config: "bytes32", poolId: "bytes32", tx: "bytes32", block: "number",
    }, key: ["subject", "poolId"] },
    calls: [{ id: "trade", signature, fields: {
      subject: { from: "target" }, token0: { from: "argument", index: 0, path: [0] },
      token1: { from: "argument", index: 0, path: [1, 0] }, config: { from: "argument", index: 0, path: [1, 1] },
      poolId: { from: "expression", value: hashKey(["$args.0.0", "$args.0.1.0", "$args.0.1.1"]) },
      tx: { from: "observation", path: "transactionHash" }, block: { from: "observation", path: "source.number" },
    }, predicates: [op("gt", "$args.1", op("uint", "0"))] }], events: [],
  };
}
function call(data = abi.encodeFunctionData("trade", [[token0, [token1, config]], 9n])): Extract<UnifiedObservation, { kind: "call" }> {
  return { kind: "call", source, target, sender: actor, data, transactionHash: tx };
}
const decoded = (d: ReturnType<typeof compileDeclarativeDiscovery<any>>, observation: UnifiedObservation, id = "trade") =>
  d.decodeCandidate({ observation, matchedPatternId: id });

test("nested tuple paths and derived keys preserve the real target and observation provenance", () => {
  const d = compileDeclarativeDiscovery<any>(definition());
  assert.deepEqual(decoded(d, call()), { candidateKind: "fixture-tuple", subject: target, token0, token1, config,
    poolId: poolId(token0, token1), tx, block: source.number });
  assert.deepEqual(d.callPatterns![0]!.candidateAddress, { from: "call-target" });
  assert.deepEqual(d.callPatterns![0]!.argumentProjection, [], "nested leaves are not mislabelled as top-level scalar arguments");
  const second = decoded(d, call(abi.encodeFunctionData("trade", [[token0, [token2, config]], 9n])));
  assert.notEqual(d.candidateKey(decoded(d, call())), d.candidateKey(second));
  assert.equal(d.reverseBinding?.kind, "explicitly-unsupported");
});

test("tuple mapping still rejects wrong selector, truncated/trailing bytes and failed predicates", () => {
  const d = compileDeclarativeDiscovery<any>(definition()), data = call().data;
  for (const invalid of [data.slice(0, -2), data + "00", "0x12345678" + data.slice(10), abi.encodeFunctionData("trade", [[token0, [token1, config]], 0n])])
    assert.equal(decoded(d, call(invalid)), null);
});

test("ABI paths are checked at registration and missing dynamic-array leaves reject at decoding", () => {
  const invalid = [[-1], [0.5], [3], [1, 5], [0, 0], "1", Array(17).fill(0)];
  for (const path of invalid) {
    const spec: any = definition(); spec.calls[0].fields.token1.path = path;
    assert.throws(() => compileDeclarativeDiscovery(spec), /ABI path|unsafe JSON number/);
  }
  const spec: any = definition(); spec.calls[0].signature = "function trade((address,address[],bytes32) key,uint256 amount)";
  spec.calls[0].fields.token1.path = [1, 1]; spec.calls[0].fields.config.path = [2];
  spec.calls[0].fields.poolId.value = hashKey(["$args.0.0", "$args.0.1.1", "$args.0.2"]);
  const own = new Interface([spec.calls[0].signature]), d = compileDeclarativeDiscovery<any>(spec);
  assert.equal(decoded(d, call(own.encodeFunctionData("trade", [[token0, [token1], config], 9n]))), null);
  assert.equal(decoded(d, call(own.encodeFunctionData("trade", [[token0, [token1, token2], config], 9n])))!.token1, token2);
});

const routeSignature = "function route(((address token0,address token1,bytes32 config) key,uint128 guard)[] hops,address receiver)";
const router = new Interface([routeSignature]);
function fanOutDefinition(): DeclarativeMappedDiscovery {
  const spec: any = definition();
  spec.calls = [{ id: "route", signature: routeSignature, fanOut: { argument: 0, maxItems: 3 }, fields: {
    subject: { from: "target" }, token0: { from: "item", path: [0, 0] }, token1: { from: "item", path: [0, 1] },
    config: { from: "item", path: [0, 2] }, poolId: { from: "expression", value: hashKey(["$item.0.0", "$item.0.1", "$item.0.2"]) },
    tx: { from: "observation", path: "transactionHash" }, block: { from: "observation", path: "source.number" },
  }, predicates: [op("every", "$args.0", "hop", op("eq", "$hop.1", op("uint", "0")))] }];
  return spec;
}
const hops = [[[token0, token1, config], 0n], [[token1, token2, config], 0n]];
const routeCall = (rows: unknown[] = hops) => call(router.encodeFunctionData("route", [rows, actor]));

function catalog(spec: DeclarativeMappedDiscovery) {
  const doc: any = clone(root); doc.discovery.definition = spec; doc.protocol.candidateKinds = ["observed-call", "standalone-contract"];
  const runtime = createDeclarativeProtocolRuntime(doc, [clone(custodian), clone(infinifi)]);
  const plugin = defineProtocolFamily(runtime.definition);
  const entries = FAMILY_CAPABILITY_NAMES.map(capability => ({ familyId: plugin.manifest.familyId, capability,
    contractVersion: "discovery-fixture", contentHash: createHash("sha256").update(`fixture:${capability}`).digest("hex"),
    semanticDependencies: [`contract:${capability}`], provenanceCommit: null }));
  return { plugin, catalog: new FamilyCapabilityCatalog({ modules: [{ plugin, sourceFile: "fixture/tuples.production.ts",
    definitionBoundaryHash: definedFamilyPluginContractSummary(plugin).definitionBoundaryHash }],
    generatedManifest: { format: "adapter-family-capabilities-v1", entries, manifestHash: capabilityManifestHash(entries) } }) };
}

test("bounded expansion uses real production catalog matching and singular candidate decoding", () => {
  const { plugin, catalog: c } = catalog(fanOutDefinition()), observation = routeCall();
  const matches = c.matches(observation);
  assert.deepEqual(matches.map(match => match.patternId), ["route", "route-1", "route-2"]);
  const candidates = matches.map(match => plugin.discovery.decodeCandidate({ observation, matchedPatternId: match.patternId }));
  assert.equal(candidates[2], null);
  assert.deepEqual(candidates.slice(0, 2).map(row => (row as any).poolId), [poolId(token0, token1), poolId(token1, token2)]);
  assert.equal(new Set(candidates.filter(Boolean).map(row => plugin.discovery.candidateKey(row!))).size, 2);
});

test("fan-out rejects empty/oversized arrays atomically and checks every declared guard", () => {
  const d = compileDeclarativeDiscovery<any>(fanOutDefinition());
  for (const rows of [[], [...hops, ...hops], [hops[0], [hops[1]![0], 1n]]])
    for (const id of ["route", "route-1", "route-2"]) assert.equal(decoded(d, routeCall(rows), id), null);
  assert.equal(decoded(d, { ...routeCall(), data: "0x" + "00".repeat(65537) }, "route"), null);
});

test("fan-out validates array type, path, bounds, names and generated pattern collisions", () => {
  const mutations: ((spec: any) => void)[] = [
    d => { d.calls[0].fanOut.maxItems = 0; }, d => { d.calls[0].fanOut.maxItems = 129; },
    d => { d.calls[0].fanOut.argument = 1; }, d => { d.calls[0].fanOut.path = [-1]; },
    d => { d.calls[0].fields.token0.path = [0, 8]; }, d => { delete d.calls[0].fanOut; },
    d => { d.calls.push({ ...d.calls[0], id: "route-1" }); },
    d => { d.calls[0].fields.subject = { from: "expression", value: "$observation.target" }; },
    d => { d.calls[0].fields.poolId.value = "$candidate.poolId"; },
    d => { d.calls[0].predicates = [op("every", "$args.0", "observation", true)]; },
  ];
  for (const mutate of mutations) { const spec = clone(fanOutDefinition()); mutate(spec); assert.throws(() => compileDeclarativeDiscovery(spec)); }
});

test("cached tuple decoding cannot reuse data after observation bytes change", () => {
  const d = compileDeclarativeDiscovery<any>(fanOutDefinition()), observation: any = routeCall();
  assert(decoded(d, observation, "route"));
  observation.data = router.encodeFunctionData("route", [[[hops[0]![0], 1n]], actor]);
  assert.equal(decoded(d, observation, "route"), null);
});

test("tx nomination reads one real observation and catalog fan-out retains all subjects", async () => {
  const { plugin, catalog: c } = catalog(fanOutDefinition());
  let receipts = 0, traces = 0;
  const provider: CaptureNominationProvider = {
    async getTransactionReceipt() { receipts++; return { blockNumber: source.number, logs: [] }; },
    async traceTransaction() { traces++; return { to: target, from: actor, input: routeCall().data }; },
    async call() { throw new Error("no discovery identity calls"); }, async getCode() { throw new Error("no discovery code reads"); },
    async getStorage() { throw new Error("no discovery storage reads"); }, async getLogs() { throw new Error("no extra log scan"); },
  };
  const observations = await plugin.discovery.nominate!.nominate({ nominations: [{ address: target, opaque: { familyId: "fixture-tuples", txHash: tx } }], source, provider });
  assert.equal(observations.length, 1); assert.equal(receipts, 1); assert.equal(traces, 1);
  const keys = observations.flatMap(observation => c.matches(observation).map(match =>
    plugin.discovery.decodeCandidate({ observation, matchedPatternId: match.patternId }))).filter(Boolean).map(candidate => plugin.discovery.candidateKey(candidate!));
  assert.equal(new Set(keys).size, 2);
});

test("ABI log tuple arrays expand with canonical topics and event bytes", () => {
  const spec: any = fanOutDefinition(), pattern = spec.calls[0]; spec.calls = [];
  spec.events = [{ ...pattern, signature: "event Routed(((address,address,bytes32),uint128)[] hops,address receiver)", fields: { ...pattern.fields, subject: { from: "emitter" } } }];
  const event = new Interface([spec.events[0].signature]), d = compileDeclarativeDiscovery<any>(spec);
  const encoded = event.encodeEventLog(event.getEvent("Routed")!, [hops, actor]);
  const observation: Extract<UnifiedObservation, { kind: "log" }> = { kind: "log", source, address: target, ...encoded, transactionHash: tx };
  assert.equal(decoded(d, observation, "route-1")!.poolId, poolId(token1, token2));
  assert.equal(decoded(d, { ...observation, data: encoded.data + "00" }, "route-1"), null);
  assert.equal(decoded(d, { ...observation, topics: [config] }, "route-1"), null);
});

function topicDefinition(): DeclarativeMappedDiscovery {
  return { version: 2, sources: ["landed-log"], candidateSources: [], labels: ["fixture-topic"], nomination: "tx-evidence",
    candidate: { kind: "fixture-topic", addressField: "subject", fields: { subject: "address", tx: "bytes32" }, key: ["subject"] }, calls: [],
    events: [{ id: "raw-trigger", topic: config, fields: { subject: { from: "emitter" }, tx: { from: "observation", path: "transactionHash" } } }],
  };
}
test("topic-only discovery nominates an observed emitter without inventing ABI arguments or effects", () => {
  const d = compileDeclarativeDiscovery<any>(topicDefinition());
  const observation: Extract<UnifiedObservation, { kind: "log" }> = { kind: "log", source, address: target, topics: [config], data: "0x12abcd", transactionHash: tx };
  assert.deepEqual(decoded(d, observation, "raw-trigger"), { candidateKind: "fixture-topic", subject: target, tx });
  assert.equal(d.logPatterns![0]!.signature, `topic:${config}`);
  assert.equal(d.reverseBinding?.kind, "explicitly-unsupported");
  for (const invalid of [{ ...observation, topics: [tx] }, { ...observation, topics: [config, "0x12"] },
    { ...observation, data: "0x123" }, { ...observation, data: "0xgg" }, { ...observation, topics: Array(5).fill(config) }])
    assert.equal(decoded(d, invalid, "raw-trigger"), null);
  for (const mutate of [(p: any) => { p.signature = "event Trigger()"; }, (p: any) => { p.topic = "0x12"; },
    (p: any) => { p.fields.tx = { from: "argument", index: 0 }; }, (p: any) => { p.fields.tx = { from: "expression", value: "$observation.data" }; },
    (p: any) => { p.fanOut = { argument: 0, maxItems: 2 }; }]) {
    const spec: any = topicDefinition(); mutate(spec.events[0]); assert.throws(() => compileDeclarativeDiscovery(spec));
  }
});
