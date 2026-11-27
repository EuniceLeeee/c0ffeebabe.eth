import assert from "node:assert/strict";
import test from "node:test";
import { EventFragment, FunctionFragment, Interface, toBeHex } from "ethers";
import { readySelectorCensusFromTransaction } from "../ready-selector-census.js";
import type { UnifiedObservation } from "../venues/adapter-family-plugin.js";
import { compileSelectorNativeDiscovery, selectorNativeCandidateFromCensus, assertSelectorNativeCandidate,
  selectorNativeCandidateKey, type SelectorNativeCandidate } from "../venues/selector-native-discovery.js";
import { normalizeSelectorNativeExecutionDefinition, selectorNativeProgramKey } from "../venues/selector-native-definition.js";
import { selectorExecutionInstanceKey, selectorExecutionResourceKey, selectorFamilyIdentity } from "../venues/selector-execution-keys.js";

const a = (n: number) => toBeHex(n, 20), h = (n: number) => toBeHex(n, 32);
const sender = a(101), target = a(201), tokenIn = a(301), tokenOut = a(302), recipient = a(401);
const signature = "function convert(string pool,address input,address output,uint256 amount,address recipient) returns (uint256)";
const fn = FunctionFragment.from(signature), abi = new Interface([fn]);
const source = { number: 50, hash: h(50), generation: 50 };
function definition(multiple = false) {
  const base = { parameters: [{ path: [0], role: "bound" }, { path: [1], role: "tokenIn" },
      { path: [2], role: "tokenOut" }, { path: [3], role: "amountIn" }, { path: [4], role: "recipient" }],
    binding: { nomination: { poolIdPath: [0], poolNamespace: "PoolDomain", tokenInPath: [1], tokenOutPath: [2], parameterPaths: [[0]] },
      facts: {}, descriptor: { target: "$candidate.target" } } };
  return normalizeSelectorNativeExecutionDefinition({ format: "selector-family/v2", selector: fn.selector,
    signature, domain: "protocol", programs: [{ ...base, meta: { label: "first source" }, payment: { kind: "none" } },
      ...(multiple ? [{ ...base, meta: { label: "other source" }, payment: { kind: "approval" } }] : [])] });
}
function census(amount = 7n, block = source.number, pool = "PoolA") {
  return readySelectorCensusFromTransaction({ chainId: 1, transactionHash: h(block + 100), blockNumber: block, blockHash: h(block),
    transactionIndex: 0, status: 1, from: sender, to: target,
    input: abi.encodeFunctionData(fn, [pool, tokenIn, tokenOut, amount, recipient]), logs: [], traces: [] });
}
function observation(tx = census()): Extract<UnifiedObservation, { kind: "call" }> {
  const call = tx.calls[0]!;
  return { kind: "call", source: { number: tx.blockNumber!, hash: tx.blockHash!, generation: tx.blockNumber! },
    target: call.target!, data: call.calldata!, sender: call.sender!, transactionHash: tx.transactionHash!, traceAddress: call.traceAddress!,
    opaque: { selectorCensus: tx, callId: call.id } as any };
}
function decode(raw = definition(), obs: UnifiedObservation = observation(), pattern?: string) {
  const compiled = compileSelectorNativeDiscovery(raw);
  return compiled.discovery.decodeCandidate({ observation: obs, matchedPatternId: pattern ?? compiled.discovery.callPatterns![0]!.id });
}

test("native SQL nomination validates the complete call envelope without identity or state reads", () => {
  const def = definition(), obs = observation(), candidate = decode(def, obs);
  assert(candidate && candidate.candidateKind === "selector-native-execution"); assert.equal(candidate.target, target); assert.equal(candidate.scope.poolId, "PoolA");
  assert.deepEqual(candidate.arguments, ["PoolA", tokenIn, tokenOut, "7", recipient]);
  assert.equal(candidate.programKeys.length, 1); assertSelectorNativeCandidate(candidate, def);
  for (const patch of [{ target: a(202) }, { sender: a(102) }, { transactionHash: h(999) }, { data: obs.data + "00" },
    { source: { ...source, hash: h(999) } }, { source: { ...source, number: 51 } }, { source: { ...source, generation: -1 } },
    { traceAddress: [0] }, { traceAddress: [Number.NaN] }, { sender: undefined }, { transactionHash: undefined }]) {
    assert.equal(decode(def, { ...obs, ...patch } as any), null, JSON.stringify(patch));
  }
  assert.equal(decode(def, obs, "another-family:call"), null);
  assert.equal(decode(def, { ...obs, opaque: { ...(obs.opaque as any), callId: "trace:missing" } }), null);
  assert.equal(decode(def, { ...obs, source: null } as any), null, "malformed source rejects without throwing");
});

test("a later admission source retains the historical census anchor explicitly", () => {
  const def = definition(), obs = observation(), current = { number: 60, hash: h(60), generation: 99 };
  assert.equal(decode(def, { ...obs, source: current }), null);
  assert(decode(def, { ...obs, source: current, evidenceSource: source }));
  assert.equal(decode(def, { ...obs, source: current, evidenceSource: { ...source, hash: h(90) } }), null);
});

test("every program gets a distinct candidate while family and physical resource stay shared", () => {
  const def = definition(true), compiled = compileSelectorNativeDiscovery(def), tx = census(), obs = observation(tx);
  const candidates = compiled.discovery.callPatterns!.map(pattern => compiled.discovery.decodeCandidate({ observation: obs, matchedPatternId: pattern.id }));
  assert.equal(candidates.length, 2); assert(candidates.every(Boolean));
  const [first, second] = candidates as SelectorNativeCandidate[];
  assert.notEqual(compiled.discovery.candidateKey(first!), compiled.discovery.candidateKey(second!));
  assert.notEqual(compiled.discovery.instanceNominationKey!(first!), compiled.discovery.instanceNominationKey!(second!));
  assert.equal(selectorExecutionResourceKey(first!.scope), selectorExecutionResourceKey(second!.scope));
  const familyId = selectorFamilyIdentity(signature).familyId;
  assert.equal(selectorExecutionInstanceKey({ ...first!.scope, familyId, immutableParameters: first!.immutableParameters }),
    selectorExecutionInstanceKey({ ...second!.scope, familyId, immutableParameters: second!.immutableParameters }));
  assert.equal(selectorNativeCandidateFromCensus(def, tx, tx.calls[0]!.id), null, "multiple recipes require an explicit program binding");
  assert.equal(selectorNativeCandidateFromCensus(def, tx, tx.calls[0]!.id, "missing"), null);
  assert.throws(() => assertSelectorNativeCandidate({ ...first!, programKey: second!.programKey }, def), /binding changed/);
  assert.throws(() => selectorNativeCandidateKey({ ...first!, scope: { ...first!.scope, target: a(900) } }, def), /binding changed/);
});

test("candidate identity excludes mutable amount/source and includes typed pool and route assets", () => {
  const def = definition(), first = decode(def)!;
  const later = decode(def, observation(census(999n, 80)))!;
  assert.equal(selectorNativeCandidateKey(first, def), selectorNativeCandidateKey(later, def));
  assert.notEqual(selectorNativeCandidateKey(first, def), selectorNativeCandidateKey(decode(def, observation(census(7n, 50, "poola")))!, def));
  const labelOnly = normalizeSelectorNativeExecutionDefinition({ ...def, meta: { identity: "optional label" },
    programs: [{ ...def.programs[0]!, meta: { label: "renamed analysis tag" } }] });
  assert.equal(selectorNativeProgramKey(def.programs[0]!), selectorNativeProgramKey(labelOnly.programs[0]!));
  assert.equal(first.declarationFingerprint, decode(labelOnly)!.declarationFingerprint);
  assert.equal(selectorNativeCandidateKey(first, def), selectorNativeCandidateKey(decode(labelOnly)!, labelOnly));
  const mutableCensus = JSON.parse(JSON.stringify(census()));
  const result = selectorNativeCandidateFromCensus(def, mutableCensus, mutableCensus.calls[0].id);
  assert(result); assert(!Object.isFrozen(mutableCensus)); assert(!Object.isFrozen(mutableCensus.calls));
  mutableCensus.calls[0].calldata = "0x";
  assert.notEqual(result.census.calls[0]!.calldata, "0x", "retained witness is copied, not a mutable external reference");
});

test("minimal role declarations retain pool and token IDs without a separate nomination object", () => {
  const signature = "function exchange(bytes32 pool,address input,uint256 inputId,address output,uint256 outputId,uint256 amount,address receiver) returns(uint256)";
  const fn = FunctionFragment.from(signature), abi = new Interface([fn]);
  const def = normalizeSelectorNativeExecutionDefinition({ selector: fn.selector, signature, domain: "protocol",
    parameters: [{ path: [0], role: "poolId" }, { path: [1], role: "tokenIn" }, { path: [2], role: "tokenInId" },
      { path: [3], role: "tokenOut" }, { path: [4], role: "tokenOutId" }, { path: [5], role: "amountIn" }, { path: [6], role: "recipient" }],
    payment: { kind: "none" } });
  const tx = readySelectorCensusFromTransaction({ chainId: 1, transactionHash: h(101), blockNumber: 50, blockHash: h(50),
    status: 1, from: sender, to: target, input: abi.encodeFunctionData(fn, [h(99), tokenIn, 2n ** 200n, tokenOut, 123n, 7n, recipient]), logs: [] });
  const candidate = selectorNativeCandidateFromCensus(def, tx, "transaction")!;
  assert(candidate); assert.equal(candidate.scope.poolId, h(99));
  assert.equal(candidate.scope.poolNamespace, "contract-pool-id");
  assert.equal(candidate.scope.tokenInId, String(2n ** 200n)); assert.equal(candidate.scope.tokenOutId, "123");
  assert.deepEqual(candidate.immutableParameters.map(parameter => parameter.path), [[0], [2], [4]]);
  const conflicting = normalizeSelectorNativeExecutionDefinition({ ...def, programs: [{ ...def.programs[0],
    binding: { nomination: { poolIdPath: [4] } } }] });
  assert.equal(selectorNativeCandidateFromCensus(conflicting, tx, "transaction"), null,
    "explicit nomination cannot silently override a different declared pool role");
});

test("unknown or non-entry declarations retain census candidates without invented programs", () => {
  const def = normalizeSelectorNativeExecutionDefinition({ ...definition(), programs: [], unsupportedReason: "callback selector, no direct route execution" });
  const compiled = compileSelectorNativeDiscovery(def), tx = census(), candidate = decode(def)!;
  assert(candidate && candidate.candidateKind === "selector-native-execution"); assert.equal(candidate.programKey, "observed"); assert.deepEqual(candidate.programKeys, ["observed"]);
  assert.equal(compiled.discovery.callPatterns!.length, 1); assertSelectorNativeCandidate(candidate, def);
  assert.equal(selectorNativeCandidateFromCensus(def, tx, tx.calls[0]!.id, "forged"), null);
  assert.throws(() => assertSelectorNativeCandidate({ ...candidate, programKey: "forged" }, def), /binding changed/);
});

test("simple parameters retain bound resources and token roles without a separate nomination block", () => {
  const original = definition();
  const { binding: _binding, ...simple } = original.programs[0]!;
  const def = normalizeSelectorNativeExecutionDefinition({ ...original, programs: [simple] });
  const first = decode(def)!;
  assert(first); assert.equal(first.scope.tokenIn, tokenIn); assert.equal(first.scope.tokenOut, tokenOut);
  assert.deepEqual(first.immutableParameters, [{ path: [0], type: "string", value: "PoolA" }]);
  assert.notEqual(selectorNativeCandidateKey(first, def), selectorNativeCandidateKey(decode(def, observation(census(7n, 50, "PoolB")))!, def));
  assert.equal(selectorNativeCandidateKey(first, def), selectorNativeCandidateKey(decode(def, observation(census(70n, 70)))!, def));
});

test("program-local repeated event labels do not erase distinct touched topics", () => {
  const def = definition(true), eventA = "event Converted(address indexed sender,uint256 amount)", eventB = "event Changed(bytes32 indexed pool)";
  const changed = normalizeSelectorNativeExecutionDefinition({ ...def, programs: def.programs.map((program, index) => ({ ...program,
    observations: { events: [{ id: "change", signature: index === 0 ? eventA : eventB }] } })) });
  const compiled = compileSelectorNativeDiscovery(changed), logs = compiled.discovery.logPatterns!;
  assert.equal(logs.length, 2); assert.equal(new Set(logs.map(row => row.id)).size, 2);
  assert.deepEqual(new Set(logs.map(row => row.topic)), new Set([EventFragment.from(eventA).topicHash, EventFragment.from(eventB).topicHash]));
  assert.throws(() => compileSelectorNativeDiscovery({ ...def, programs: [{ ...def.programs[0]!, observations: {
    events: [{ id: "change", signature: eventA, topic: EventFragment.from(eventB).topicHash }] } }] }), /topic differs/);
});
