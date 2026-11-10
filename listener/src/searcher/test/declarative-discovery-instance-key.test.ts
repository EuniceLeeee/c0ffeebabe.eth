import { plugin as astraMultiTokenProductionPlugin } from "../venues/production-families/astra-multitoken.production.js";
import assert from "node:assert/strict";
import test from "node:test";
import { hashCanonical } from "../venues/canonical-value.js";
import { Interface, MaxUint256, getAddress, toBeHex } from "ethers";
import { compileDeclarativeDiscovery, type DeclarativeMappedDiscovery } from "../venues/declarative-discovery.js";

import { hashFamilyCandidateKey, rebuildFamilyCandidateKey, rebuildFamilyInstanceDedupeKey } from "../universe-rebuild-production.js";

const astraMultiTokenDiscovery = astraMultiTokenProductionPlugin.discovery;

const source = { number: 101, hash: toBeHex(101, 32), generation: 1 };
const target = getAddress("0x" + "ab".repeat(20)), other = getAddress("0x" + "cd".repeat(20));
const actor = toBeHex(2, 20), abi = new Interface(["function convert(uint256 amount)"]);
function definition(): DeclarativeMappedDiscovery {
  return {
    version: 2, sources: ["observed-call"], candidateSources: [],
    candidate: { kind: "fixture-instance-evidence", addressField: "target",
      fields: { target: "address", actor: "address", amount: "uint" }, key: ["target", "actor", "amount"], instanceKey: ["target"] },
    calls: [{ id: "convert", signature: "convert(uint256)", fields: {
      target: { from: "target" }, actor: { from: "sender" }, amount: { from: "argument", index: 0 },
    } }], events: [], labels: ["fixture-instance-evidence"], nomination: "tx-evidence",
  };
}
function decoded(discovery: ReturnType<typeof compileDeclarativeDiscovery>, address = target, amount = 7n, sender = actor) {
  return discovery.decodeCandidate({ matchedPatternId: "convert", observation: {
    kind: "call", source, target: address, sender, data: abi.encodeFunctionData("convert", [amount]),
  } })!;
}

test("instance grouping preserves distinct observed evidence keys and does not combine different targets", () => {
  const d = compileDeclarativeDiscovery(definition());
  const rows = [decoded(d), decoded(d, target, 8n), decoded(d, target, 9n, toBeHex(3, 20)), decoded(d, other)];
  assert.equal(new Set(rows.map(c => d.candidateKey(c))).size, 4);
  assert.equal(new Set(rows.map(c => d.instanceNominationKey!(c))).size, 2);
  assert.equal(d.instanceNominationKey!(rows[0]), target.toLowerCase());
  assert.equal(d.instanceNominationKey!({ target: target.toLowerCase() }), target.toLowerCase());
  assert.equal(d.reverseBinding?.kind, "explicitly-unsupported", "grouping cannot create binding authority");
  const omitted = definition(); delete (omitted.candidate as any).instanceKey;
  const old = compileDeclarativeDiscovery(omitted);
  assert.equal(Object.hasOwn(old, "instanceNominationKey"), false);
  assert.deepEqual(rows.map(c => d.candidateKey(c)), rows.map(c => old.candidateKey(c)));
});

test("production dedupe uses the same target grouping as the active legacy capability", () => {
  const d = compileDeclarativeDiscovery(definition());
  const rows = [decoded(d), decoded(d, target, 8n), decoded(d, target, 9n, toBeHex(3, 20)), decoded(d, other)];
  const retained = rows.map(candidate => ({ ...candidate, familyId: "protocol:astra-multitoken", pluginCandidateKey: d.candidateKey(candidate) }));
  assert.equal(new Set(retained.map(rebuildFamilyCandidateKey)).size, 4, "durable evidence candidates stay separate");
  const before = retained.map(rebuildFamilyInstanceDedupeKey);
  const projected = retained.map(candidate => {
    const instance = d.instanceNominationKey!(candidate);
    assert.equal(instance, astraMultiTokenDiscovery.instanceNominationKey(candidate));
    return hashFamilyCandidateKey(candidate.familyId, instance);
  });
  assert.deepEqual(projected, before, "new declaration preserves the actual production grouping, including address case");
  assert.equal(new Set(projected).size, 2, "four evidence rows still enter two instance work groups");
});

test("instance key declaration requires unique existing required non-null fields and the candidate address", () => {
  for (const invalid of [null, "target", [], ["target", "target"], ["missing", "target"], ["actor"]]) {
    const spec: any = definition(); spec.candidate.instanceKey = invalid;
    assert.throws(() => compileDeclarativeDiscovery(spec), /instance key/);
  }
  for (const option of ["optionalFields", "nullableFields"]) {
    const spec: any = definition(); spec.candidate.key = ["target"];
    spec.candidate[option] = ["amount"]; spec.candidate.instanceKey = ["target", "amount"];
    assert.throws(() => compileDeclarativeDiscovery(spec), /instance key/);
  }
});

test("instance key values reuse address and uint validation and unambiguous composite encoding", () => {
  const spec = definition(); (spec.candidate as any).instanceKey = ["target", "amount"];
  const d = compileDeclarativeDiscovery(spec);
  assert.equal(d.instanceNominationKey!({ target, amount: 7n }), JSON.stringify([target.toLowerCase(), "7"]));
  assert.equal(d.instanceNominationKey!({ target, amount: "7" }), d.instanceNominationKey!({ target: target.toLowerCase(), amount: 7n }));
  for (const value of [null, [], {}, { target: "bad", amount: 7n }, { target, amount: -1n }, { target, amount: MaxUint256 + 1n }, { target, amount: 7 }])
    assert.throws(() => d.instanceNominationKey!(value));
});

test("optional durable address and evidence encoding preserves old verified evidence identities", () => {
  const raw = definition();
  const make = (durableKey: { addresses: string[]; evidence?: string[] }) =>
    compileDeclarativeDiscovery({ ...raw, candidate: { ...raw.candidate, durableKey } });
  const d = make({ addresses: ["target"], evidence: ["actor", "amount"] });
  const row = decoded(d);
  const expected = target.toLowerCase() + ":" + hashCanonical({ actor: actor.toLowerCase(), amount: 7n });
  assert.equal(d.candidateKey(row), expected);
  assert.notEqual(d.candidateKey(decoded(d, target, 8n)), expected);
  assert.notEqual(d.candidateKey(decoded(d, other)), expected);
  assert.throws(() => make({ addresses: ["target"], evidence: ["actor"] }), /durable candidate key/);
  assert.throws(() => make({ addresses: ["target", "amount"], evidence: ["actor"] }), /durable candidate key/);
});


test("retained address envelopes group with current declared instances without granting candidate identity", () => {
  const spec = definition(); (spec.candidate as any).instanceKey = ["target", "amount"];
  const d = compileDeclarativeDiscovery(spec);
  const retained = {address: target, amount: "7"};
  assert.equal(d.instanceNominationKey!(retained),d.instanceNominationKey!({target,amount:7n}));
  assert.notEqual(d.instanceNominationKey!({...retained,address:other}),d.instanceNominationKey!(retained));
  assert.notEqual(d.instanceNominationKey!({...retained,amount:"8"}),d.instanceNominationKey!(retained));
  assert.equal(d.instanceNominationKey!({...retained,target:other}),d.instanceNominationKey!({target:other,amount:7n}), "explicit declared address remains authoritative");
  for (const value of [{address:"bad",amount:"7"},{address:target},{address:target,amount:-1n}])
    assert.throws(()=>d.instanceNominationKey!(value));
  assert.throws(()=>d.candidateKey(retained as any),/candidate kind/);
});


test("opaque emitter declarations reject malformed optional values and invalid topic positions", () => {
  for (const emitter of [null, false, 0, {}, {mode:"singleton-indexed-bytes32",address:target,topicIndex:0,fromBlock:0},
    {mode:"singleton-indexed-bytes32",address:target,topicIndex:1,fromBlock:-1}]) {
    const spec:any=definition();
    spec.events=[{id:"pool",signature:"Pool(bytes32 indexed poolId)",fields:{},nominationOnly:true,emitter}];
    assert.throws(()=>compileDeclarativeDiscovery(spec));
  }
  const spec:any=definition();
  spec.events=[{id:"pool",signature:"Pool(bytes32 indexed poolId)",fields:{},nominationOnly:true,
    emitter:{mode:"singleton-indexed-bytes32",address:target,topicIndex:1,fromBlock:0}}];
  assert.equal(compileDeclarativeDiscovery(spec).logPatterns![0]!.emitter!.address,target);
});
