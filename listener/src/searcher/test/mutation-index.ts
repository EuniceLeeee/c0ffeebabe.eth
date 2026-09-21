import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { getAddress } from "ethers";
import ts from "typescript";
import { compileAddressMutations, createMutationLookup } from "../venues/mutation-index.js";
import type { MutationPricingEntry, UnifiedObservation } from "../venues/adapter-family-plugin.js";

const A = `0x${"ab".repeat(20)}`, B = `0x${"cd".repeat(20)}`, C = `0x${"ef".repeat(20)}`;
const source = { number: 1, hash: `0x${"01".repeat(32)}`, generation: 1 };
const log = (address = A): Extract<UnifiedObservation, { kind: "log" }> => ({ kind: "log", source, address, topics: [], data: "0x" });
const call = (target = A): Extract<UnifiedObservation, { kind: "call" }> => ({ kind: "call", source, target, data: "0x" });
type Entry = MutationPricingEntry<{ addresses: readonly string[] }, string>;
const entry = (stateKey: string, addresses: readonly string[], dependencies = addresses): Entry =>
  ({ descriptor: { addresses }, routes: [], stateKey, dependencies });
const select = (item: Entry) => ({ addresses: item.descriptor.addresses, keys: [item.stateKey] });

function instrumentedHelper(overrides: Record<string, unknown>) {
  const exports = {} as typeof import("../venues/mutation-index.js");
  const code = ts.transpileModule(readFileSync(new URL("../venues/mutation-index.ts", import.meta.url), "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  runInNewContext(code, { exports, require(name: string) {
    assert.equal(name, "ethers"); return { getAddress };
  }, ...overrides });
  return exports;
}

test("lookup deduplicates opaque keys and preserves immutable snapshots", () => {
  const lookup = createMutationLookup(), empty = lookup.get(A), initialAddresses = lookup.addresses();
  assert.equal(empty, initialAddresses);
  assert(Object.isFrozen(empty));
  lookup.add(A, []);
  assert.equal(lookup.addresses(), initialAddresses);
  const keys = ["Pool:Direction/ONE", "pool:direction/one", "Not-An-Address"];
  lookup.add(getAddress(A), keys);
  keys.push("must-not-leak");
  const first = lookup.get(A), addresses = lookup.addresses();
  assert.deepEqual(first, ["pool:direction/one", "not-an-address"]);
  assert.equal(lookup.get(getAddress(A)), first);
  lookup.add(A, ["POOL:DIRECTION/ONE"]);
  assert.equal(lookup.get(A), first);
  lookup.add(A, ["second"]);
  lookup.add(B, ["second"]);
  assert.deepEqual(first, ["pool:direction/one", "not-an-address"]);
  assert.deepEqual(lookup.get(A), [...first, "second"]);
  assert.deepEqual(addresses, [A]);
  assert.deepEqual(lookup.addresses(), [A, B]);
  assert.equal(lookup.get(C), empty);
  assert(Object.isFrozen(lookup));
  assert.throws(() => (first as string[]).push("bad"), TypeError);
  assert.throws(() => (addresses as string[]).push(C), TypeError);
  assert.throws(() => (empty as string[]).push("bad"), TypeError);
});

test("startup validates addresses and keys without partially changing the lookup", () => {
  const lookup = createMutationLookup();
  lookup.add(A, ["existing"]);
  const prior = lookup.get(A);
  assert.throws(() => lookup.add("not-an-address", ["valid"]));
  const checksum = getAddress(A);
  const badChecksum = checksum.replace(/[A-F]/, character => character.toLowerCase());
  assert.notEqual(checksum, badChecksum);
  assert.throws(() => lookup.add(badChecksum, ["valid"]));
  assert.throws(() => lookup.add(A, ["new", ""]));
  assert.throws(() => lookup.add(B, [null as unknown as string]));
  assert.equal(lookup.get(A), prior);
  assert.deepEqual(lookup.addresses(), [A]);
});

test("address snapshots are materialized lazily and remain stable after additions", () => {
  let enumerations = 0;
  class CountedMap<K, V> extends Map<K, V> {
    override keys() { enumerations++; return super.keys(); }
  }
  const lookup = instrumentedHelper({ Map: CountedMap }).createMutationLookup();
  const addresses = Array.from({ length: 32 }, (_, i) => `0x${(i + 1).toString(16).padStart(40, "0")}`);
  for (const address of addresses) lookup.add(address, ["key"]);
  assert.equal(enumerations, 0, "startup additions must not enumerate all prior addresses");
  const first = lookup.addresses();
  assert.deepEqual(Array.from(first), addresses);
  assert(Object.isFrozen(first));
  assert.equal(enumerations, 1);
  assert.equal(lookup.addresses(), first);
  lookup.add(addresses[0]!, ["second"]);
  assert.equal(lookup.addresses(), first, "adding keys does not invalidate address membership");
  lookup.add(A, ["key"]);
  assert.equal(enumerations, 1);
  assert.deepEqual(Array.from(first), addresses);
  const next = lookup.addresses();
  assert.deepEqual(Array.from(next), [...addresses, A]);
  assert(Object.isFrozen(next));
  assert.equal(enumerations, 2);
  assert.equal(lookup.addresses(), next);
});

test("compilation intersects dependencies per entry and unions shared-address keys", () => {
  const first = entry("Opaque/FIRST", [getAddress(A), B, C], [A, B]);
  const index = compileAddressMutations([
    first, first, entry("OPAQUE/SECOND", [A, B], [getAddress(B)]),
  ], select, { kinds: ["log", "call"] });
  assert.deepEqual(index.dependencies, [A, B]);
  assert.deepEqual(index.affectedStateKeys({ observation: log(A) }), ["opaque/first"]);
  const shared = index.affectedStateKeys({ observation: log(getAddress(B)) });
  assert.deepEqual(shared, ["opaque/first", "opaque/second"]);
  assert.equal(index.affectedStateKeys({ observation: call(B) }), shared);
  assert.deepEqual(index.affectedStateKeys({ observation: log(C) }), []);
  assert(Object.isFrozen(index));
  assert(Object.isFrozen(index.dependencies));
  assert(Object.isFrozen(shared));
});

test("opaque dependencies are allowed while selected addresses are validated", () => {
  const index = compileAddressMutations([
    entry("first", [A, B], ["STATE:Pool/ONE", getAddress(A)]),
    entry("second", [B], ["0x01", "Opaque/Dependency"]),
  ], select, { kinds: ["log", "call"] });
  assert.deepEqual(index.dependencies, [A]);
  assert.deepEqual(index.affectedStateKeys({ observation: log(A) }), ["first"]);
  assert.deepEqual(index.affectedStateKeys({ observation: call(B) }), []);
  assert.throws(() => compileAddressMutations([
    entry("bad", ["not-an-address"], ["not-an-address"]),
  ], select, { kinds: ["log"] }));
});

test("kind filtering and acceptance run once per eligible event", () => {
  let accepted = 0;
  const index = compileAddressMutations([entry("one", [A]), entry("two", [A])], select, {
    kinds: ["log"], accept: observation => { accepted++; return observation.kind === "log" && observation.data === "0x"; },
  });
  const empty = index.affectedStateKeys({ observation: call(A) });
  const unknown = { kind: "future-event" } as unknown as UnifiedObservation;
  assert.equal(index.affectedStateKeys({ observation: unknown }), empty);
  assert.equal(accepted, 0);
  assert.deepEqual(index.affectedStateKeys({ observation: log(A) }), ["one", "two"]);
  assert.equal(accepted, 1);
  assert.equal(index.affectedStateKeys({ observation: { ...log(A), data: "0x01" } }), empty);
  assert.equal(accepted, 2);
  assert.equal(index.affectedStateKeys({ observation: log(C) }), empty);
  assert.equal(accepted, 3);
  const calls = compileAddressMutations([entry("one", [A])], select, { kinds: ["call"] });
  assert.equal(calls.affectedStateKeys({ observation: log(A) }), empty);
  assert.deepEqual(calls.affectedStateKeys({ observation: call(A) }), ["one"]);
  const disabled = compileAddressMutations([entry("one", [A])], select, { kinds: [] });
  assert.equal(disabled.affectedStateKeys({ observation: log(A) }), empty);
  assert.equal(disabled.affectedStateKeys({ observation: call(A) }), empty);
});

test("compiled roots are isolated and do not retain mutable configuration", () => {
  const selectedAddresses = [A], dependencies = [A], kinds: ("log" | "call")[] = ["log"];
  const first = compileAddressMutations([entry("first", selectedAddresses, dependencies)], select, { kinds });
  const second = compileAddressMutations([entry("second", [A])], select, { kinds: ["call"] });
  selectedAddresses.push(B); dependencies.push(B); kinds.push("call");
  assert.deepEqual(first.dependencies, [A]);
  assert.deepEqual(first.affectedStateKeys({ observation: log(A) }), ["first"]);
  assert.deepEqual(first.affectedStateKeys({ observation: log(B) }), []);
  assert.deepEqual(first.affectedStateKeys({ observation: call(A) }), []);
  assert.deepEqual(second.affectedStateKeys({ observation: call(A) }), ["second"]);
  assert.deepEqual(second.affectedStateKeys({ observation: log(A) }), []);
  const empty = compileAddressMutations([], select, { kinds: ["log", "call"] });
  assert.equal(empty.dependencies, empty.affectedStateKeys({ observation: log(A) }));
});

test("actual helper does no descriptor reads or address validation during event lookup", () => {
  let hot = false, validations = 0, selections = 0;
  const helper = instrumentedHelper({ require(name: string) {
    assert.equal(name, "ethers");
    return { getAddress(address: string) { assert(!hot, "hot-path address validation"); validations++; return getAddress(address); } };
  } });
  const item: Entry = {
    get descriptor() { assert(!hot, "hot-path descriptor read"); return { addresses: [A] }; },
    routes: [], stateKey: "key", dependencies: [A],
  };
  const index = helper.compileAddressMutations([item], value => { selections++; return select(value); }, { kinds: ["log", "call"] });
  assert(validations > 0);
  const startupValidations = validations;
  hot = true;
  const result = index.affectedStateKeys({ observation: log(A) });
  assert.deepEqual(Array.from(result), ["key"]);
  for (let i = 0; i < 100; i++) {
    assert.equal(index.affectedStateKeys({ observation: call(A) }), result);
  }
  assert.equal(validations, startupValidations);
  assert.equal(selections, 1);
});
