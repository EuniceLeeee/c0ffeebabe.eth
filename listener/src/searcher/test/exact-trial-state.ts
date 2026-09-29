import assert from "node:assert/strict";
import { test } from "node:test";
import { applyExactTrialState, emptyExactTrialState } from "../exact-trial-state.js";

const ref = { key: "pool:one", schema: "test-state:v1", binding: "verified-one",
  dependencies: ["inventory:one", "oracle:one"] };

test("immutable copy-on-write snapshots share state across owners, not trials", () => {
  const empty = emptyExactTrialState();
  const original = { balance: 10n, ticks: new Map([[1, { liquidity: 2n }]]) };
  const a = applyExactTrialState(empty, [{ ref, value: original }], ["inventory:one"]);
  const value = a.view.get(ref) as typeof original;
  original.balance = 30n;
  original.ticks.get(1)!.liquidity = 3n;
  assert.equal(value.balance, 10n);
  assert.equal(value.ticks.get(1)!.liquidity, 2n);
  assert.throws(() => value.ticks.set(1, { liquidity: 50n }), /immutable/);
  assert.throws(() => value.ticks.forEach((_v, _k, map) => map.clear()), /immutable/);
  assert.throws(() => (value.ticks.valueOf() as Map<unknown, unknown>).clear(), /immutable/);
  assert.throws(() => { value.ticks.get(1)!.liquidity = 8n; }, TypeError);
  assert.equal(empty.view.get(ref), undefined);
  const b = applyExactTrialState(a, [{ ref, value: { ...value, balance: 9n } }]);
  assert.equal((a.view.get(ref) as typeof original).balance, 10n);
  assert.equal((b.view.get(ref) as typeof original).balance, 9n);
  assert.equal((b.view.get(ref) as typeof original).ticks, value.ticks,
    "unchanged immutable tick subtree is not copied per hop");
});

test("dependency changes invalidate existing AND not-yet-read state", () => {
  const a = applyExactTrialState(emptyExactTrialState(), [{ ref, value: 1n }]);
  const changed = applyExactTrialState(a, [], ["oracle:one"]);
  assert.throws(() => changed.view.get(ref), /invalidated dependency/);
  assert.throws(() => changed.view.get({ key: ref.key, schema: ref.schema, binding: ref.binding }), /invalidated dependency/,
    "omitting dynamic dependencies cannot bypass existing invalidation");
  assert.throws(() => changed.view.get({ ...ref, key: "not-read-before" }), /invalidated dependency/,
    "a baseline RPC read cannot silently erase an earlier dependency mutation");
  assert.equal(a.view.get(ref), 1n);
  const independent = { key: "pool:two", schema: ref.schema, binding: "verified-two" };
  assert.equal(changed.view.get(independent), undefined);
});

test("schema, binding and dependency closures must agree for the same object", () => {
  const a = applyExactTrialState(emptyExactTrialState(), [{ ref, value: 1n }]);
  for (const wrong of [{ ...ref, schema: "other" }, { ...ref, binding: "other" }, { ...ref, dependencies: [] }]) {
    assert.throws(() => a.view.get(wrong), /binding conflict/);
    assert.throws(() => applyExactTrialState(a, [{ ref: wrong, value: 2n }]), /binding conflict/);
  }
  assert.equal(a.view.get({ key: ref.key, schema: ref.schema, binding: ref.binding }), 1n);
});

test("failed commits cannot mutate earlier state or leak incomplete updates", () => {
  const a = applyExactTrialState(emptyExactTrialState(), [{ ref, value: 1n }]);
  assert.throws(() => applyExactTrialState(a, [{ ref, value: 2n }, { ref, value: 3n }]), /duplicate/);
  assert.throws(() => applyExactTrialState(a, [{ ref, value: { get amount() { return 4; } } }]), /accessors/);
  assert.throws(() => applyExactTrialState(a, [{ ref, value: undefined }]), /undefined/);
  assert.throws(() => applyExactTrialState(a, [{ ref, value: new Date() }]), /plain data/);
  assert.throws(() => applyExactTrialState({ view: a.view }, []), /unissued/);
  assert.equal(a.view.get(ref), 1n);
  const malicious: unknown[] = [];
  malicious.map = (() => [{ mutable: 1 }]) as typeof malicious.map;
  assert.throws(() => applyExactTrialState(a, [{ ref, value: malicious }]), /non-index/);
  const getter: unknown[] = [];
  Object.defineProperty(getter, "0", { get: () => ({ mutable: 1 }) });
  assert.throws(() => applyExactTrialState(a, [{ ref, value: getter }]), /plain data/);
});

test("effect-only updates preserve unrelated cells and invalidate dependent views", () => {
  const first = applyExactTrialState(emptyExactTrialState(), [{ ref, value: 7n }], ["inventory:one"]);
  const updated = applyExactTrialState(first, [], ["inventory:two"]);
  const dependent = { key: "different-family-cell", schema: "other:v1",
    binding: "verified-other", dependencies: ["inventory:two"] };
  assert.equal(updated.view.get(ref), 7n);
  assert.throws(() => updated.view.get(dependent), /invalidated dependency/,
    "a previously unread cell still observes another owner's shared write");
  assert.equal(first.view.get(dependent), undefined,
    "effect-only publication cannot mutate its parent snapshot");
  const carried = applyExactTrialState(updated, [], []);
  assert.equal(carried.view.get(ref), 7n);
  assert.throws(() => carried.view.get(dependent), /invalidated dependency/,
    "an empty update cannot erase an earlier invalidation");
});
