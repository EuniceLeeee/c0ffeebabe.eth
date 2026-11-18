import assert from "node:assert/strict";
import test from "node:test";
import { toBeHex } from "ethers";
import { createObservedExecutionMutation } from "../venues/observed-execution-mutation.js";
import { sealCompiledMutationIndex, type MutationPricingEntry, type MutationSemantics, type UnifiedObservation } from "../venues/adapter-family-plugin.js";

const a = (n: number) => toBeHex(n, 20);
const source = { number: 1, hash: toBeHex(1, 32), generation: 0 };
const call = (target: string, data = "0x12345678"): UnifiedObservation => ({ kind: "call", source, target, data });
const log = (address: string): UnifiedObservation => ({ kind: "log", source, address, data: "0x", topics: [] });
type Route = { key: string; learned: boolean };
type Descriptor = { target: string; dependencies: readonly string[] };
type Entry = MutationPricingEntry<Descriptor, Route>;
const entry = (target: string, key: string, learned: boolean, dependencies = [target]): Entry => ({
  descriptor: { target, dependencies }, routes: [{ key, learned }], stateKey: key, dependencies,
});
const owner: MutationSemantics<Descriptor, Route> = {
  compile({ entries }) {
    const index = new Map(entries.map(e => [e.descriptor.target.toLowerCase(), e.stateKey]));
    return { dependencies: [...index.keys()], affectedStateKeys({ observation }) {
      const key = observation.kind === "log" ? index.get(observation.address.toLowerCase()) : undefined;
      return key ? [key] : [];
    } };
  },
  affectedStateKeys({ descriptor, routes, observation }) {
    return observation.kind === "log" && observation.address.toLowerCase() === descriptor.target.toLowerCase()
      ? [...new Set(routes.map(r => r.key))] : [];
  },
};
const make = (base: MutationSemantics<Descriptor, Route> | undefined = owner) => createObservedExecutionMutation({
  base, isLearned: (r: Route) => r.learned, stateKey: (r: Route) => r.key,
  dependencies: ({ descriptor }: { descriptor: Descriptor }) => descriptor.dependencies,
});

test("learned pricing groups conservatively touch existing state keys on every declared dependency", () => {
  const entries = [entry(a(1), "Opaque/Case-Sensitive", true, [a(1), a(3), a(4), a(5)]), entry(a(2), "Native/Other", false, [a(2), a(3)])];
  const mutation = make(), index = sealCompiledMutationIndex(mutation.compile!({ entries }));
  assert.deepEqual(new Set(index.dependencies), new Set([a(1), a(2), a(3), a(4), a(5)]));
  for (const observation of [call(a(1)), call(a(1), "0xdeadbeef"), log(a(1)), call(a(3)), log(a(3)), call(a(4)), log(a(5))]) {
    assert.deepEqual(index.affectedStateKeys({ observation }), ["Opaque/Case-Sensitive"]);
    assert.deepEqual(entries.flatMap(e => mutation.affectedStateKeys({ ...e, observation })), ["Opaque/Case-Sensitive"]);
  }
  assert.deepEqual(index.affectedStateKeys({ observation: call(a(2)) }), []);
  assert.deepEqual(index.affectedStateKeys({ observation: log(a(2)) }), ["Native/Other"]);
  for (const observation of [call(a(9)), log(a(9)), { kind: "address-surface" as const, source, address: a(1),
    codeHash: toBeHex(1, 32), implementationWord: toBeHex(0, 32) }])
    assert.deepEqual(index.affectedStateKeys({ observation }), []);
});
test("mixed directions retain their shared state key and never promote unlearned state groups", () => {
  const e = entry(a(1), "shared:key", true, [a(1), a(3)]);
  const mixed: Entry = { ...e, routes: [...e.routes, { key: e.stateKey, learned: false }] };
  const mutation = make(), index = mutation.compile!({ entries: [mixed] });
  assert.deepEqual(index.affectedStateKeys({ observation: call(a(3)) }), ["shared:key"]);
  assert.deepEqual(mutation.affectedStateKeys({ ...mixed, observation: call(a(3)) }), ["shared:key"]);
  assert.throws(() => mutation.compile!({ entries: [{ ...mixed, stateKey: "invented" }] }), /existing pricing state group/);
  assert.throws(() => mutation.compile!({ entries: [{ ...mixed, routes: [...mixed.routes, { key: "foreign", learned: true }] }] }), /existing pricing state group/);
});
test("compiled learned lookup snapshots dependencies and never revisits descriptor or route evaluators on events", () => {
  let learnedReads = 0, stateReads = 0, legacyReads = 0;
  const mutation = createObservedExecutionMutation<Descriptor, Route>({
    base: { ...owner, affectedStateKeys() { legacyReads++; throw new Error("legacy event scan"); } },
    isLearned: r => { learnedReads++; return r.learned; },
    stateKey: r => { stateReads++; return r.key; }, dependencies: () => { throw new Error("event dependency reevaluation"); },
  });
  const dependencies = [a(1), a(9000)], entries = Array.from({ length: 2048 }, (_, n) => entry(a(n + 1), `Group/${n}`, true,
    n === 0 ? dependencies : [a(n + 1)]));
  const index = mutation.compile!({ entries });
  learnedReads = 0; stateReads = 0; dependencies.push(a(9001));
  for (let n = 0; n < 5; n++) {
    assert.deepEqual(index.affectedStateKeys({ observation: call(a(9000)) }), ["Group/0"]);
    assert.deepEqual(index.affectedStateKeys({ observation: call(a(9001)) }), []);
  }
  assert.equal(learnedReads, 0); assert.equal(stateReads, 0); assert.equal(legacyReads, 0);
});
test("native-only compiled groups return the owner index and preserve its event filter", () => {
  const entries = [entry(a(1), "Native", false, [a(1), a(3)])], expected = owner.compile!({ entries });
  const mutation = make({ ...owner, compile: () => expected });
  assert.equal(mutation.compile!({ entries }), expected);
  assert.deepEqual(mutation.affectedStateKeys({ ...entries[0]!, observation: call(a(1)) }), []);
});
test("owners without a compiled index retain dependency-scoped fallback parity", () => {
  const { compile: _compile, ...uncompiled } = owner;
  const entries = [entry(a(1), "Learned", true, [a(1), a(3)]), entry(a(2), "Native", false, [a(2), a(3)])];
  for (const base of [uncompiled, undefined]) {
    const mutation = createObservedExecutionMutation<Descriptor, Route>({ base,
      isLearned: r => r.learned, stateKey: r => r.key, dependencies: ({ descriptor }) => descriptor.dependencies });
    const index = mutation.compile!({ entries });
    for (const observation of [call(a(1)), log(a(1)), call(a(2)), log(a(2)), call(a(3)), log(a(3)), call(a(9))])
      assert.deepEqual(index.affectedStateKeys({ observation }), [...new Set(entries.flatMap(e => mutation.affectedStateKeys({ ...e, observation })))]);
  }
});
