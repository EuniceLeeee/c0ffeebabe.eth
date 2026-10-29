import assert from "node:assert/strict";
import test from "node:test";
import { Interface, getAddress, toBeHex, keccak256 } from "ethers";
import { compileDeclarativeDiscovery, type DeclarativeMappedDiscovery } from "../venues/declarative-discovery.js";
import { compileDeclarativeNominationReadFlow } from "../venues/declarative-nomination.js";
import { compileDeclarativeValues } from "../venues/declarative-values.js";
import { createAddressSurfaceNomination } from "../venues/address-surface-nomination.js";
import { defineProtocolFamily, type CaptureNominationProvider, type UnifiedObservation } from "../venues/adapter-family-plugin.js";
import { compileDeclarativeProtocol } from "../venues/declarative-protocol.js";
import existingDefinition from "../venues/protocols/erc4626-family/erc4626.json";
import custodianDefinition from "../venues/protocols/erc4626-family/custodian.json";
import infinifiDefinition from "../venues/protocols/erc4626-family/infinifi.json";
import type { DeclarativeReadFlow } from "../venues/declarative-read-flow.js";

const a = (n: number) => getAddress(toBeHex(n, 20)), vault = a(1), asset = a(2), other = a(3);
const source = Object.freeze({ number: 101, hash: toBeHex(101, 32), generation: 3 });
const tx = toBeHex(201, 32), clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const op = (name: string, ...args: any[]) => ({ op: name, args });
const uint = (value: any) => op("uint", value);
const abi = new Interface(["function underlying() view returns(address)", "function preview(uint256) view returns(uint256)",
  "function convert(address,uint256)", "event Converted(address indexed actor,uint256 amount)"]);
const values = compileDeclarativeValues({ abi: { view: abi.fragments.map(f => f.format("full")) }, constants: {}, expressions: {} });
function mapped(): DeclarativeMappedDiscovery {
  return { version: 2, sources: ["address-surface", "observed-call"], candidateSources: [],
    candidate: { kind: "fixture-conversion", addressField: "vault", fields: {
      vault: "address", payout: "address", mode: "string", amount: "uint", transactionHash: "bytes32", blockNumber: "number",
    }, optionalFields: ["transactionHash", "blockNumber"], key: ["vault", "payout"] },
    calls: [{ id: "convert", signature: "function convert(address,uint256)", fields: {
      vault: { from: "target" }, payout: { from: "argument", index: 0 }, mode: { from: "literal", value: "redeem" },
      amount: { from: "argument", index: 1 }, transactionHash: { from: "observation", path: "transactionHash" },
    } }], events: [], labels: ["fixture-conversion"], nomination: "address-surface", surface: {
      id: "surface", fingerprint: "fixture:surface", fields: { vault: { from: "emitter" }, payout: { from: "opaque", path: "payout" },
        mode: { from: "opaque", path: "mode" }, amount: { from: "opaque", path: "amount" },
        transactionHash: { from: "opaque", path: "transactionHash" }, blockNumber: { from: "opaque", path: "blockNumber" } },
      predicates: [op("gt", "$candidate.amount", uint("0")), op("or", op("eq", "$candidate.mode", "redeem"), op("eq", "$candidate.mode", "withdraw")),
        op("not", op("sameAddress", "$candidate.vault", "$candidate.payout")),
        op("not", op("sameAddress", "$candidate.payout", a(0)))],
    } };
}
const opaque = () => ({ familyId: "fixture-conversion", payout: asset, mode: "redeem", amount: "17", transactionHash: tx, blockNumber: 99 });
const observation = (payload: any = opaque()): UnifiedObservation => ({ kind: "address-surface", source, address: vault,
  codeHash: toBeHex(5, 32), implementationWord: toBeHex(0, 32), interfaceFingerprints: ["fixture:surface"], opaque: payload });
function provider(options: { failAddress?: string; fail?: Error; expectedSample?: bigint } = {}) {
  const calls: { kind: string; address: string; block: number | undefined }[] = [];
  const p: CaptureNominationProvider = {
    async getCode(address, block) { calls.push({ kind: "code", address, block }); return "0x6000"; },
    async getStorage(address, _slot, block) { calls.push({ kind: "storage", address, block }); return toBeHex(0, 32); },
    async call(request, block) {
      calls.push({ kind: "call", address: request.to, block });
      if (request.to.toLowerCase() === options.failAddress?.toLowerCase()) throw options.fail!;
      const parsed = abi.parseTransaction({ data: request.data })!;
      if (parsed.name === "underlying") return abi.encodeFunctionResult("underlying", [asset]);
      assert.equal(parsed.name, "preview"); assert.equal(parsed.args[0], options.expectedSample ?? 17n);
      return abi.encodeFunctionResult("preview", [34n]);
    },
    async getLogs() { throw new Error("no history scan"); },
    async getTransactionReceipt() { throw new Error("not a tx test"); },
  };
  return { p, calls };
}
const candidate = (d: ReturnType<typeof compileDeclarativeDiscovery<any>>, o: UnifiedObservation) => d.decodeCandidate({ observation: o, matchedPatternId: "surface" });

test("empty JSON candidateSources omits the plugin property without relaxing explicit plugin validation", () => {
  const legacy = { candidate: { kind: "fixture", addressField: "vault" }, candidateSources: [], sources: ["address-surface", "observed-call"],
    calls: [{ id: "convert", signature: "convert(address,uint256)" }], events: [], labels: ["fixture"], surface: { id: "surface", fingerprint: "fixture" } };
  for (const spec of [legacy, mapped()]) {
    const d = compileDeclarativeDiscovery<any>(spec);
    assert.equal(Object.hasOwn(d, "candidateSources"), false);
    const plugin = () => compileDeclarativeProtocol(existingDefinition, [custodianDefinition, infinifiDefinition]);
    assert.doesNotThrow(() => defineProtocolFamily({ ...plugin(), discovery: d } as any));
    assert.throws(() => defineProtocolFamily({ ...plugin(), discovery: { ...d, candidateSources: [] } } as any), /non-empty/);
    assert.throws(() => defineProtocolFamily({ ...plugin(), discovery: { ...d, candidateSources: ["unknown"] } } as any), /unsupported discovery candidateSource/);
  }
  for (const invalid of [null, {}, "", ["unknown"], ["observed-interaction", "observed-interaction"]]) {
    const d = compileDeclarativeDiscovery<any>({ ...legacy, candidateSources: invalid } as any);
    assert.throws(() => defineProtocolFamily({ ...compileDeclarativeProtocol(existingDefinition, [custodianDefinition, infinifiDefinition]), discovery: d } as any), /candidateSource/);
  }
});

test("opaque mappings preserve typed observations and optional provenance without inventing missing fields", () => {
  const d = compileDeclarativeDiscovery<any>(mapped());
  assert.deepEqual(candidate(d, observation()), { candidateKind: "fixture-conversion", vault, payout: asset, mode: "redeem", amount: 17n, transactionHash: tx, blockNumber: 99 });
  const payload: any = opaque(); delete payload.transactionHash; delete payload.blockNumber;
  const c = candidate(d, observation(payload))!;
  assert.equal(Object.hasOwn(c, "transactionHash"), false); assert.equal(Object.hasOwn(c, "blockNumber"), false);
  assert.equal(d.candidateKey(c), JSON.stringify([vault.toLowerCase(), asset.toLowerCase()]));
  const call: UnifiedObservation = { kind: "call", source, target: vault, data: abi.encodeFunctionData("convert", [asset, 7n]) };
  assert.equal((d.decodeCandidate({ observation: call, matchedPatternId: "convert" }) as any).amount, 7n);
});

test("missing, malformed and counterfeit opaque fields reject without legacy sample fallback", () => {
  const d = compileDeclarativeDiscovery<any>(mapped());
  for (const payload of [null, {}, { ...opaque(), amount: undefined, sampleShares: "17" }, { ...opaque(), amount: "-1" },
    { ...opaque(), amount: "0" }, { ...opaque(), payout: vault }, { ...opaque(), payout: a(0) }, { ...opaque(), mode: "other" },
    { ...opaque(), transactionHash: "bad" }, { ...opaque(), blockNumber: -1 }, { ...opaque(), blockNumber: "99" }])
    assert.equal(candidate(d, observation(payload)), null);
  let read = false; const payload: any = opaque(); Object.defineProperty(payload, "amount", { get() { read = true; return "17"; } });
  assert.equal(candidate(d, observation(payload)), null); assert.equal(read, false);
});

test("nullable provenance preserves explicit null only where declared and does not imply optional", () => {
  const spec: any = mapped(); spec.candidate.nullableFields = ["transactionHash"];
  const d = compileDeclarativeDiscovery<any>(spec);
  const c = candidate(d, observation({ ...opaque(), transactionHash: null })) as any;
  assert(c); assert.equal(Object.hasOwn(c, "transactionHash"), true); assert.equal(c.transactionHash, null);
  assert.equal(c.blockNumber, 99);
  assert.equal(candidate(d, observation({ ...opaque(), transactionHash: 17 })), null);
  assert.equal(candidate(d, observation({ ...opaque(), transactionHash: "bad" })), null);
  assert.equal(candidate(d, observation({ ...opaque(), blockNumber: null })), null);
  assert.equal(candidate(compileDeclarativeDiscovery<any>(mapped()), observation({ ...opaque(), transactionHash: null })), null);
  const missing: any = opaque(); delete missing.transactionHash;
  assert.equal(Object.hasOwn(candidate(d, observation(missing))!, "transactionHash"), false);
  spec.candidate.optionalFields = ["blockNumber"];
  const required = compileDeclarativeDiscovery<any>(spec);
  assert.equal(candidate(required, observation(missing)), null);
  assert.equal((candidate(required, observation({ ...opaque(), transactionHash: null })) as any).transactionHash, null);
  spec.surface.fields.transactionHash = { from: "literal", value: null };
  assert.equal((candidate(compileDeclarativeDiscovery<any>(spec), observation(missing)) as any).transactionHash, null);
  delete spec.candidate.nullableFields;
  assert.throws(() => compileDeclarativeDiscovery(spec));
});

test("nullable declarations reject unknown/duplicate fields and cannot weaken candidate keys", () => {
  for (const fields of [["absent"], ["transactionHash", "transactionHash"], ["vault"], ["payout"], "transactionHash", {}]) {
    const spec: any = mapped(); spec.candidate.nullableFields = fields;
    assert.throws(() => compileDeclarativeDiscovery(spec));
  }
});

test("mapped nomination preserves opaque evidence while the legacy helper remains unchanged", async () => {
  const f = provider(), nominations = [{ address: vault, opaque: opaque() }];
  const d = compileDeclarativeDiscovery<any>(mapped());
  const observations = await d.nominate!.nominate({ nominations, source, provider: f.p });
  assert.equal(observations.length, 1); assert.equal(candidate(d, observations[0]!)!.candidateKind, "fixture-conversion");
  const first = observations[0] as Extract<UnifiedObservation, { kind: "address-surface" }>;
  assert.deepEqual(first.opaque, nominations[0]!.opaque); assert.equal(first.codeHash, keccak256("0x6000"));
  const old = createAddressSurfaceNomination({ opaqueLabels: ["fixture-conversion"], interfaceFingerprints: ["fixture:surface"] });
  const before = await old.nominate({ nominations, source, provider: f.p });
  assert.equal(Object.hasOwn(before[0]!, "opaque"), false); assert(f.calls.every(call => call.block === source.number));
});

function flow(): DeclarativeReadFlow {
  return { version: 1, steps: [
    { id: "asset", requirements: { transports: ["eth-call"], completions: ["return-data"] }, requests: [
      { id: "asset", kind: "eth-call", to: "$address", data: op("encode", "view", "underlying", []), completion: "return-data" },
    ], decode: [
      { let: "underlying", value: op("decode", "view", "underlying", op("get", op("returned", "asset"), "data"), 0) },
      { let: "record", value: op("at", op("filter", op("coalesce", "$nomination.opaque.evidence", []), "entry", op("and",
        op("eq", "$entry.kind", "fixture-probe"), op("sameAddress", "$entry.asset", "$underlying"),
        op("matches", "$entry.shares", "^[1-9][0-9]*$"), op("matches", "$entry.assets", "^[1-9][0-9]*$"))), 0) },
      { return: { asset: "$underlying", record: "$record" } },
    ] },
    { id: "sample", requirements: { transports: ["eth-call"] }, requests: op("if", op("defined", "$steps.asset.record"), [
      { id: "preview", kind: "eth-call", to: "$address", data: op("encode", "view", "preview", [uint("$steps.asset.record.shares")]), completion: "return-data" },
    ], []), decode: [
      { assert: op("eq", op("decode", "view", "preview", op("get", op("returned", "preview"), "data"), 0), uint("$steps.asset.record.assets")),
        when: op("defined", "$steps.asset.record"), error: "nomination sample disagrees with source read" },
      { return: op("if", op("defined", "$steps.asset.record"), { payout: "$steps.asset.asset", mode: "redeem", amount: "$steps.asset.record.shares" }, null) },
    ] },
  ], result: "$steps.sample" };
}
const retained = (address = vault, records: any[] = [{ kind: "fixture-probe", asset, shares: "17", assets: "34" }]) =>
  ({ address, opaque: { familyId: "fixture-conversion", evidence: records } });

test("JSON nomination read flow uses real retained evidence and dependent reads at the pinned source", async () => {
  const d = compileDeclarativeDiscovery<any>({ ...mapped(), nominationReadFlow: flow() }, values), f = provider();
  const rows = await d.nominate!.nominate({ source, provider: f.p, nominations: [retained(vault, [
    { kind: "irrelevant", asset, shares: "17", assets: "34" }, { kind: "fixture-probe", asset: other, shares: "9", assets: "18" },
    { kind: "fixture-probe", asset, shares: "17", assets: "34" },
  ])] });
  assert.equal(rows.length, 1); assert.equal((candidate(d, rows[0]!) as any).amount, 17n);
  assert.equal(f.calls.filter(call => call.kind === "call").length, 2);
  assert(f.calls.every(call => call.block === source.number));
  assert.equal(d.reverseBinding?.kind, "explicitly-unsupported");
});

test("absent or inconsistent retained evidence cannot be upgraded into a candidate", async () => {
  const d = compileDeclarativeDiscovery<any>({ ...mapped(), nominationReadFlow: flow() }, values);
  for (const records of [[], [{ kind: "fixture-probe", asset: other, shares: "17", assets: "34" }],
    [{ kind: "fixture-probe", asset, shares: "17", assets: "35" }], [{ kind: "fixture-probe", asset, shares: "0", assets: "0" }]]) {
    const f = provider(), rows = await d.nominate!.nominate({ source, provider: f.p, nominations: [retained(vault, records)] });
    assert.deepEqual(rows, []);
  }
});

test("provider failures are not fabricated as return/revert evidence and do not block later nominations", async () => {
  const failure = new Error("provider capacity exceeded"), f = provider({ failAddress: vault, fail: failure });
  const resolve = compileDeclarativeNominationReadFlow(flow(), values);
  await assert.rejects(resolve({ nomination: retained(), source, provider: f.p }), error => error === failure);
  const d = compileDeclarativeDiscovery<any>({ ...mapped(), nominationReadFlow: flow() }, values);
  const rows = await d.nominate!.nominate({ source, provider: f.p, nominations: [retained(), retained(other)] });
  assert.equal(rows.length, 1); assert.equal((rows[0] as any).address.toLowerCase(), other.toLowerCase());
});

test("nomination read flows reject authority/source overrides and unsupported transport before calls", async () => {
  const mutations = [
    (d: any) => { d.steps[0].requests[0].caller = { kind: "executor" }; },
    (d: any) => { d.steps[0].requests[0].completion = "return-or-revert-data"; },
    (d: any) => { d.steps[0].requests[0].blockTag = 999; },
    (d: any) => { d.steps[0].requests[0].kind = "effect-delta-simulation"; },
    (d: any) => { d.steps[0].requirements.effects = ["token-delta"]; },
  ];
  for (const mutate of mutations) {
    const d: any = flow(); mutate(d); const f = provider();
    await assert.rejects(compileDeclarativeNominationReadFlow(d, values)({ nomination: retained(), source, provider: f.p }));
    assert.equal(f.calls.length, 0);
  }
  const f = provider();
  await assert.rejects(compileDeclarativeNominationReadFlow(flow(), values)({ nomination: retained(), source: { ...source, hash: "bad" }, provider: f.p }));
  assert.equal(f.calls.length, 0);
});

test("incomplete log is a nomination clue, never a fabricated payout candidate", async () => {
  const spec: any = mapped(); spec.nomination = "tx-evidence"; spec.sources = ["observed-call", "landed-log"];
  spec.events = [{ id: "clue", signature: "event Converted(address indexed actor,uint256 amount)", fields: {}, nominationOnly: true }];
  const d = compileDeclarativeDiscovery<any>(spec), f = provider();
  const encoded = abi.encodeEventLog(abi.getEvent("Converted")!, [other, 17n]);
  const log: UnifiedObservation = { kind: "log", source, address: vault, transactionHash: tx, ...encoded };
  assert.equal(d.decodeCandidate({ observation: log, matchedPatternId: "clue" }), null);
  f.p.getTransactionReceipt = async () => ({ blockNumber: source.number, logs: [log as any] });
  f.p.traceTransaction = async () => ({ to: vault, from: other, input: abi.encodeFunctionData("convert", [asset, 17n]) });
  const rows = await d.nominate!.nominate({ source, provider: f.p, nominations: [{ address: vault, opaque: { familyId: "fixture-conversion", txHash: tx } }] });
  assert.equal(rows.length, 1); assert.equal(rows[0]!.kind, "call");
  assert.equal((d.decodeCandidate({ observation: rows[0]!, matchedPatternId: "convert" }) as any).payout, asset);
});

test("optional schema cannot weaken required keys or accept executable/arbitrary paths", () => {
  const mutations = [
    (d: any) => { d.candidate.optionalFields.push("vault"); }, (d: any) => { d.candidate.optionalFields.push("absent"); },
    (d: any) => { delete d.surface.fields.payout; }, (d: any) => { d.surface.fields.payout.path = "constructor.value"; },
    (d: any) => { d.calls[0].fields.payout = { from: "opaque", path: "payout" }; },
    (d: any) => { d.nominationReadFlow = flow(); },
  ];
  for (const mutate of mutations) { const d: any = clone(mapped()); mutate(d); assert.throws(() => compileDeclarativeDiscovery(d)); }
});
