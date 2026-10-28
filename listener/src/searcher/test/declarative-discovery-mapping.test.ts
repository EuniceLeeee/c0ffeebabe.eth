import assert from "node:assert/strict";
import test from "node:test";
import { Interface, getAddress, toBeHex, id } from "ethers";
import { compileDeclarativeDiscovery, type DeclarativeMappedDiscovery } from "../venues/declarative-discovery.js";
import { createTxEvidenceNomination } from "../venues/tx-evidence-nomination.js";
import type { CaptureNominationProvider, UnifiedObservation } from "../venues/adapter-family-plugin.js";

const address = (n: number) => getAddress(toBeHex(n, 20));
const source = { number: 101, hash: toBeHex(101, 32), generation: 2 };
const subject = address(1), account = address(2), tokenA = toBeHex(7, 32), tokenB = toBeHex(8, 32), tx = toBeHex(300, 32);
const abi = new Interface([
  "function convert(bytes32 tokenId,uint256 amount,address receiver)",
  "event Converted(bytes32 indexed tokenId,uint256 amount,address receiver)",
]);
const amountPositive = { op: "gt", args: ["$args.1", { op: "uint", args: ["0"] }] };
const definition: DeclarativeMappedDiscovery = {
  version: 2, sources: ["observed-call", "landed-log"], candidateSources: ["observed-interaction"],
  candidate: { kind: "fixture-conversion", addressField: "subject", fields: { subject: "address", tokenId: "bytes32" }, key: ["subject", "tokenId"] },
  labels: ["fixture-conversion"], nomination: "tx-evidence",
  calls: [{ id: "convert-call", signature: "function convert(bytes32 tokenId,uint256 amount,address receiver)",
    fields: { subject: { from: "target" }, tokenId: { from: "argument", index: 0 } }, predicates: [amountPositive] }],
  events: [{ id: "converted-log", signature: "event Converted(bytes32 indexed tokenId,uint256 amount,address receiver)",
    fields: { subject: { from: "emitter" }, tokenId: { from: "argument", index: 0 } }, predicates: [amountPositive] }],
};
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const call = (tokenId = tokenA, amount = 9n): Extract<UnifiedObservation, { kind: "call" }> => ({ kind: "call", source, target: subject, sender: account,
  data: abi.encodeFunctionData("convert", [tokenId, amount, account]), transactionHash: tx });
function log(tokenId = tokenA, amount = 9n): Extract<UnifiedObservation, { kind: "log" }> {
  const encoded = abi.encodeEventLog(abi.getEvent("Converted")!, [tokenId, amount, account]);
  return { kind: "log", source, address: subject, ...encoded, transactionHash: tx };
}

test("call and indexed log mapping produce the same subject, while composite IDs stay distinct", () => {
  const discovery = compileDeclarativeDiscovery<any>(definition);
  const a = discovery.decodeCandidate({ observation: call(), matchedPatternId: "convert-call" });
  const b = discovery.decodeCandidate({ observation: call(tokenB), matchedPatternId: "convert-call" });
  const l = discovery.decodeCandidate({ observation: log(), matchedPatternId: "converted-log" });
  assert.deepEqual(a, { candidateKind: "fixture-conversion", subject, tokenId: tokenA });
  assert.deepEqual(l, a); assert(b);
  assert.notEqual(discovery.candidateKey(a), discovery.candidateKey(b));
  assert.equal(discovery.candidateKey(a), JSON.stringify([subject.toLowerCase(), tokenA]));
  assert.equal(discovery.callPatterns![0]!.selector, abi.getFunction("convert")!.selector);
  assert.equal(discovery.logPatterns![0]!.topic, abi.getEvent("Converted")!.topicHash);
  assert.equal(discovery.reverseBinding?.kind, "explicitly-unsupported");
});

test("selectors, ABI shape, indexed topic and JSON predicates are checked before nomination becomes a candidate", () => {
  const d = compileDeclarativeDiscovery<any>(definition);
  for (const observation of [call(tokenA, 0n), { ...call(), data: "0x12345678" }, { ...call(), data: abi.getFunction("convert")!.selector }])
    assert.equal(d.decodeCandidate({ observation, matchedPatternId: "convert-call" }), null);
  assert.equal(d.decodeCandidate({ observation: call(), matchedPatternId: "wrong" }), null);
  assert.equal(d.decodeCandidate({ observation: log(tokenA, 0n), matchedPatternId: "converted-log" }), null);
  assert.equal(d.decodeCandidate({ observation: { ...log(), topics: [toBeHex(0, 32), tokenA] }, matchedPatternId: "converted-log" }), null);
});

test("argument-address candidates and typed uint fields preserve actual calldata rather than call target", () => {
  const spec: any = clone(definition);
  spec.candidate.fields.tokenId = "uint";
  spec.calls = [{ id: "child-call", signature: "function touch(address child,uint256 tokenId)",
    fields: { subject: { from: "argument", index: 0 }, tokenId: { from: "argument", index: 1 } } }];
  spec.events = [];
  const d = compileDeclarativeDiscovery<any>(spec), iface = new Interface([spec.calls[0].signature]);
  const candidate = d.decodeCandidate({ observation: { ...call(), data: iface.encodeFunctionData("touch", [account, 17n]) }, matchedPatternId: "child-call" });
  assert.deepEqual(candidate, { candidateKind: "fixture-conversion", subject: account, tokenId: 17n });
  assert.deepEqual(d.callPatterns![0]!.candidateAddress, { from: "argument", index: 0 });
});

test("unknown mapping fields, predicates, duplicate patterns and bad argument indices reject at registration", () => {
  const mutations = [
    (d: any) => { d.handler = "specific"; },
    (d: any) => { d.candidate.fields.candidateKind = "string"; },
    (d: any) => { d.candidate.key = ["subject", "absent"]; },
    (d: any) => { d.calls[0].fields.tokenId.index = 5; },
    (d: any) => { d.calls[0].fields.tokenId.from = "storage"; },
    (d: any) => { d.calls[0].predicates = ["$bad.value"]; },
    (d: any) => { d.calls[0].predicates = [{ op: "handler", args: [] }]; },
    (d: any) => { d.events[0].id = d.calls[0].id; },
    (d: any) => { d.events[0].signature += " anonymous"; },
    (d: any) => { d.nomination = "address-surface"; },
    (d: any) => { d.calls[0].fields.subject = { from: "argument", index: 0 }; },
  ];
  for (const mutate of mutations) { const spec: any = clone(definition); mutate(spec); assert.throws(() => compileDeclarativeDiscovery(spec)); }
});

function provider(logs: readonly ReturnType<typeof log>[], frames: readonly UnifiedObservation[]): CaptureNominationProvider {
  return {
    async getTransactionReceipt() { return { blockNumber: source.number, logs }; },
    async traceTransaction() { return { calls: frames.map(frame => frame.kind === "call" ? { to: frame.target, from: frame.sender, input: frame.data } : {}) }; },
    async call() { throw new Error("no identity RPC in discovery fixture"); },
    async getCode() { throw new Error("not an address-surface test"); },
    async getStorage() { throw new Error("not an address-surface test"); },
    async getLogs() { throw new Error("must reuse supplied transaction"); },
  };
}
const nominations = [{ address: subject, opaque: { familyId: "fixture-conversion", txHash: tx } }];

test("production nomination retains two composite subjects and later valid log/call after predicate failures", async () => {
  const d = compileDeclarativeDiscovery<any>(definition);
  const observations = await d.nominate!.nominate({ nominations, source,
    provider: provider([log(tokenA, 0n), log(tokenA), log(tokenB)], [call(tokenA, 0n), call(tokenA), call(tokenB)]) });
  assert.equal(observations.length, 4);
  const keys = observations.map(observation => d.candidateKey(d.decodeCandidate({ observation,
    matchedPatternId: observation.kind === "call" ? "convert-call" : "converted-log" })!));
  assert.equal(new Set(keys).size, 2);
  assert.deepEqual(keys.slice(0, 2), keys.slice(2));
});

test("legacy transaction nomination keeps first-match semantics unless allMatches is explicitly enabled", async () => {
  const d = compileDeclarativeDiscovery<any>(definition);
  const old = createTxEvidenceNomination({ opaqueLabels: definition.labels, callPatterns: d.callPatterns, logPatterns: d.logPatterns });
  const observations = await old.nominate({ nominations, source, provider: provider([log(tokenA), log(tokenB)], [call(tokenB)]) });
  assert.equal(observations.length, 1); assert.equal(observations[0]!.kind, "log");
  assert.throws(() => createTxEvidenceNomination({ opaqueLabels: [], acceptObservation: () => true }), /requires allMatches/);
});

test("legacy address-only declaration retains its patterns, candidate and key", () => {
  const definition = { sources: ["observed-call", "address-surface"], candidateSources: ["observed-interaction"],
    candidate: { kind: "fixture-address", addressField: "vault" }, calls: [{ id: "deposit", signature: "deposit(uint256,address)" }],
    events: [], surface: { id: "surface", fingerprint: "fixture-surface" }, labels: ["fixture-address"] };
  const d = compileDeclarativeDiscovery<any>(definition);
  assert.deepEqual(d.callPatterns, [{ id: "deposit", signature: "deposit(uint256,address)", selector: id("deposit(uint256,address)").slice(0, 10), candidateAddress: { from: "call-target" } }]);
  const c = d.decodeCandidate({ observation: call(), matchedPatternId: "deposit" });
  assert.deepEqual(c, { candidateKind: "fixture-address", vault: subject });
  assert.equal(d.candidateKey(c), subject.toLowerCase());
});


test("mapped address surfaces retain one-address key and require their declared fingerprint", async () => {
  const spec: DeclarativeMappedDiscovery = { version: 2, sources: ["address-surface"], candidateSources: ["dex-token-domain"],
    candidate: { kind: "fixture-address", addressField: "vault", fields: { vault: "address" }, key: ["vault"] },
    calls: [], events: [], labels: ["fixture-address"], nomination: "address-surface",
    surface: { id: "surface", fingerprint: "fixture-interface", fields: { vault: { from: "emitter" } } } };
  const d = compileDeclarativeDiscovery<any>(spec);
  const observation: UnifiedObservation = { kind: "address-surface", source, address: subject,
    codeHash: toBeHex(1, 32), implementationWord: toBeHex(0, 32), interfaceFingerprints: ["fixture-interface"] };
  const candidate = d.decodeCandidate({ observation, matchedPatternId: "surface" });
  assert.deepEqual(candidate, { candidateKind: "fixture-address", vault: subject });
  assert.equal(d.candidateKey(candidate), subject.toLowerCase());
  assert.equal(d.decodeCandidate({ observation: { ...observation, interfaceFingerprints: [] }, matchedPatternId: "surface" }), null);
  assert.equal(d.txSeedNominations, undefined);
});
