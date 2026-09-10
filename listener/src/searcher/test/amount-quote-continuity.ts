import assert from "node:assert/strict";
import {
  carryAmountQuote,
  prepareAmountQuoteActivity,
  snapshotAmountQuoteReusePolicy,
  type AmountQuoteReusePolicy,
  type CanonicalAmountQuoteActivity,
  type CompletedAmountQuote,
  type PreparedAmountQuoteActivity,
} from "../amount-quote-continuity.js";
import type { CanonicalSource } from "../venues/adapter-request-program.js";

const address = (byte: string) => "0x" + byte.repeat(40);
const DIRECT = address("a"), INDIRECT = address("b"), UNRELATED = address("c");
const source = (number: number, generation = number): CanonicalSource => ({
  number, generation, hash: "0x" + number.toString(16).padStart(64, "a"),
});
const a = source(100), b = source(101), c = source(102);
const policy: AmountQuoteReusePolicy = {
  kind: "state-only",
  dependencies: [DIRECT, INDIRECT],
  blockEnvironment: "independent",
};
const previous: CompletedAmountQuote = {
  complete: true, chainAmountQuote: true,
  validAt: a, quotedAt: a, amountIn: 13n, amountOut: 17n,
  contextFingerprint: "immutable-context-v1", reusePolicy: policy,
};
type Input = Omit<Parameters<typeof carryAmountQuote>[0], "activity"> & {
  readonly activity?: CanonicalAmountQuoteActivity;
};
// Retain all existing raw-activity fixtures through the explicit preparation boundary.
function carryWithRawActivity(value: Input): CompletedAmountQuote | null {
  return carryAmountQuote({ ...value, activity: prepareAmountQuoteActivity(value.activity) });
}
const input: Input = {
  previous, current: b, amountIn: previous.amountIn,
  contextFingerprint: previous.contextFingerprint, policy,
  activity: { source: b, parentHash: a.hash, touchedAddresses: new Set([UNRELATED]), complete: true },
};
let checks = 0;
function rejects(name: string, overrides: Partial<Input>): void {
  assert.equal(carryWithRawActivity({ ...input, ...overrides }), null, name);
  checks++;
}

const first = carryWithRawActivity(input);
assert(first);
assert.deepEqual(first.validAt, b);
assert.deepEqual(first.quotedAt, a);
assert.equal(first.amountIn, 13n);
assert.equal(first.amountOut, 17n);
const second = carryWithRawActivity({ ...input, previous: first, current: c,
  activity: { ...input.activity!, source: c, parentHash: b.hash } });
assert(second, "the next parent links to validAt, not original quotedAt");
assert.deepEqual(second.validAt, c);
assert.deepEqual(second.quotedAt, a);
rejects("original quotedAt cannot replace the immediately preceding validAt", {
  previous: first, current: c, activity: { ...input.activity!, source: c, parentHash: a.hash },
});

// A clean pool/mid does not establish a clean transitive quote dependency set.
for (const dirty of [DIRECT, INDIRECT, INDIRECT.toUpperCase().replace("0X", "0x")]) {
  rejects(`dirty dependency ${dirty}`, { activity: { ...input.activity!, touchedAddresses: new Set([dirty]) } });
}
rejects("missing quote", { previous: undefined });
rejects("incomplete quote", { previous: { ...previous, complete: false } });
rejects("local result is not a chain quote", { previous: { ...previous, chainAmountQuote: false } });
for (const amountOut of [0n, -1n]) rejects("nonpositive output", { previous: { ...previous, amountOut } });
for (const amountIn of [0n, -1n]) rejects("nonpositive input", { previous: { ...previous, amountIn }, amountIn });
rejects("changed amount cannot rescale a quote", { amountIn: 14n });
rejects("changed context", { contextFingerprint: "immutable-context-v2" });
rejects("missing context binding", { contextFingerprint: "", previous: { ...previous, contextFingerprint: "" } });
rejects("missing current policy", { policy: undefined });
rejects("missing original policy", { previous: { ...previous, reusePolicy: undefined } });
for (const changed of [
  { ...policy, dependencies: [] },
  { ...policy, dependencies: [DIRECT] },
  { ...policy, dependencies: [DIRECT, INDIRECT, UNRELATED] },
  { ...policy, dependencies: [DIRECT, "invalid-address"] },
]) rejects("changed/incomplete policy", { policy: changed });
rejects("original declaration was incomplete", { previous: { ...previous, reusePolicy: {
  dependencies: [DIRECT, INDIRECT], blockEnvironment: "independent",
} as unknown as AmountQuoteReusePolicy } });
rejects("original method depended on block environment", { previous: { ...previous, reusePolicy: {
  ...policy, blockEnvironment: "dependent",
} as unknown as AmountQuoteReusePolicy } });
assert(carryWithRawActivity({ ...input, policy: { ...policy,
  dependencies: [INDIRECT.toUpperCase().replace("0X", "0x"), DIRECT, DIRECT] } }),
"dependency ordering, duplicate entries and address case do not change the set");

const declaration = { ...policy, dependencies: [INDIRECT, DIRECT.toUpperCase().replace("0X", "0x"), DIRECT] };
const declarationBefore = structuredClone(declaration);
const snapshot = snapshotAmountQuoteReusePolicy(declaration);
assert.deepEqual(snapshot, { kind: "state-only", dependencies: [DIRECT, INDIRECT], blockEnvironment: "independent" });
assert.deepEqual(declaration, declarationBefore);
assert(Object.isFrozen(snapshot) && Object.isFrozen(snapshot.dependencies));
declaration.dependencies.push(UNRELATED);
assert.deepEqual(snapshot.dependencies, [DIRECT, INDIRECT], "snapshot must detach its dependency list");
for (const invalid of [undefined, null, "", [], {}, { ...policy, extra: true },
  { ...policy, [Symbol("extra")]: true }, { ...policy, kind: "other" },
  { ...policy, blockEnvironment: "dependent" }, { kind: "state-only", dependencies: [DIRECT] },
  { ...policy, dependencies: [] }, { ...policy, dependencies: "" },
  { ...policy, dependencies: new Set([DIRECT]) }, { ...policy, dependencies: Array(1) },
  ...["", "0x1", DIRECT + "0", " " + DIRECT, DIRECT.replace("0x", "0X"), address("g"), 1]
    .map(dependency => ({ ...policy, dependencies: [dependency] })),
]) {
  assert.throws(() => snapshotAmountQuoteReusePolicy(invalid), TypeError);
  rejects("invalid current policy", { policy: invalid as AmountQuoteReusePolicy });
}

rejects("missing activity", { activity: undefined });
rejects("incomplete activity", { activity: { ...input.activity!, complete: false } });
rejects("missing touched-address proof", { activity: { ...input.activity!,
  touchedAddresses: undefined as unknown as ReadonlySet<string> } });
rejects("wrong parent/reorg", { activity: { ...input.activity!, parentHash: source(99).hash } });
rejects("malformed touched address", { activity: { ...input.activity!, touchedAddresses: new Set(["invalid"]) } });
for (const proofSource of [a, { ...b, hash: c.hash }, { ...b, generation: b.generation + 1 }]) {
  rejects("activity source differs from current", { activity: { ...input.activity!, source: proofSource } });
}
for (const current of [source(99), c, { ...b, generation: a.generation },
  { ...b, generation: a.generation - 1 }, { ...b, hash: a.hash },
  { ...a, hash: b.hash }, { ...b, hash: "invalid" }, { ...b, number: 101.5 },
  { ...b, generation: Number.NaN }]) rejects("invalid source transition", {
    current, activity: { ...input.activity!, source: current },
  });
rejects("original observation cannot be newer than validity", { previous: { ...previous, quotedAt: b } });
rejects("same-height original observation cannot name another hash", {
  previous: { ...previous, quotedAt: { ...a, hash: b.hash } },
});
rejects("invalid original source", { previous: { ...previous, quotedAt: { ...a, hash: "invalid" } } });
rejects("invalid preceding validity", { previous: { ...previous, validAt: { ...a, generation: -1 } } });

const undeclared = { ...previous, reusePolicy: undefined };
for (const generation of [a.generation, a.generation + 1]) {
  const reused = carryWithRawActivity({ ...input, previous: undeclared, current: { ...a, generation },
    activity: undefined, policy: undefined });
  assert(reused, "same physical block permits nondecreasing generation without policy/activity");
  assert.deepEqual(reused.quotedAt, a);
  assert.equal(reused.reusePolicy, undefined);
}
assert(carryWithRawActivity({ ...input, current: { ...a, hash: a.hash.toUpperCase().replace("0X", "0x") },
  policy: undefined, activity: undefined }), "hash identity is case insensitive");
rejects("same-hash generation cannot regress", { current: { ...a, generation: a.generation - 1 } });
const notUpgraded = carryWithRawActivity({ ...input, previous: undeclared, current: a, activity: undefined });
assert(notUpgraded);
assert.equal(notUpgraded.reusePolicy, undefined, "same-hash reuse cannot retroactively attach policy");
rejects("same-hash reuse did not authorize later carry", { previous: notUpgraded });

// Repeated steps have no TTL, but every consecutive link still needs its proof.
let carried = previous;
for (let number = 101; number <= 120; number++) {
  const current = source(number, number + 5);
  const next = carryWithRawActivity({ ...input, previous: carried, current,
    activity: { ...input.activity!, source: current, parentHash: carried.validAt.hash } });
  assert(next);
  assert.deepEqual(next.quotedAt, a);
  carried = next;
}

const mutable = structuredClone(input);
const before = structuredClone(mutable);
Object.freeze(mutable.previous!.validAt);
Object.freeze(mutable.previous!.quotedAt);
Object.freeze(mutable.previous!.reusePolicy!.dependencies);
Object.freeze(mutable.previous!.reusePolicy);
Object.freeze(mutable.previous);
Object.freeze(mutable.activity);
Object.freeze(mutable);
const isolated = carryWithRawActivity(mutable);
assert(isolated);
assert.deepEqual(mutable, before, "helper must not mutate any input");
assert(Object.isFrozen(isolated) && Object.isFrozen(isolated.validAt) && Object.isFrozen(isolated.quotedAt));
assert(Object.isFrozen(isolated.reusePolicy) && Object.isFrozen(isolated.reusePolicy!.dependencies));
assert.notEqual(isolated.validAt, mutable.current);
assert.notEqual(isolated.quotedAt, mutable.previous!.quotedAt);
assert.notEqual(isolated.reusePolicy!.dependencies, mutable.previous!.reusePolicy!.dependencies);
assert.deepEqual(previous.validAt, a);

const prepared = prepareAmountQuoteActivity(input.activity);
assert(prepared);
assert(Object.isFrozen(prepared));
assert.deepEqual(Reflect.ownKeys(prepared), [], "opaque token exposes neither mutable Set nor snapshot internals");
assert.deepEqual(carryAmountQuote({ ...input, activity: prepared }), first);
for (const forged of [{}, Object.freeze({}), { ...prepared }, Object.create(prepared),
  structuredClone(prepared), new Proxy(prepared, {}), input.activity, null, 1, ""]) {
  assert.equal(carryAmountQuote({ ...input, activity: forged as PreparedAmountQuoteActivity }), null,
    "only a module-issued token can supply a forward activity proof");
}

const changing = { ...input.activity!, source: { ...b }, touchedAddresses: new Set([UNRELATED]) };
const changingBefore = structuredClone(changing);
const detached = prepareAmountQuoteActivity(changing);
assert(detached);
assert.deepEqual(changing, changingBefore, "preparation must not mutate input");
changing.touchedAddresses.add(INDIRECT.toUpperCase().replace("0X", "0x"));
assert(carryAmountQuote({ ...input, activity: detached }), "source Set mutation cannot change its issued snapshot");
const dirtySnapshot = prepareAmountQuoteActivity(changing);
assert(dirtySnapshot);
assert.equal(carryAmountQuote({ ...input, activity: dirtySnapshot }), null, "raw identity must never cache validation");
changing.touchedAddresses.clear();
assert.equal(carryAmountQuote({ ...input, activity: dirtySnapshot }), null, "clearing raw Set cannot erase a prepared dirty dependency");
changing.source.number++;
changing.source.generation++;
changing.source.hash = c.hash;
changing.parentHash = c.hash;
changing.complete = false;
assert.deepEqual(carryAmountQuote({ ...input, activity: detached }), first, "source and parent are detached too");
assert.equal(prepareAmountQuoteActivity(changing), null);

const mutableCurrent = { ...b };
assert(carryAmountQuote({ ...input, current: mutableCurrent, activity: prepared }));
for (const change of [{ number: b.number + 1 }, { hash: c.hash }, { generation: b.generation + 1 }]) {
  Object.assign(mutableCurrent, b, change);
  assert.equal(carryAmountQuote({ ...input, current: mutableCurrent, activity: prepared }), null,
    "every row checks current values even when object identity is unchanged");
}
assert(carryAmountQuote({ ...input, current: { ...b }, activity: prepared }), "equal source values need no shared identity");

const throwingIterator = { has: () => false, *[Symbol.iterator]() { yield UNRELATED; throw new Error("bad iterator"); } };
for (const malformed of [undefined, null, true, "", [], {},
  { ...input.activity, complete: false }, { ...input.activity, source: undefined },
  { ...input.activity, source: { ...b, generation: -1 } },
  { ...input.activity, source: { ...b, hash: "invalid" } },
  { ...input.activity, parentHash: "invalid" },
  ...[undefined, null, {}, [], "", new Set([UNRELATED, "invalid"]), throwingIterator]
    .map(touchedAddresses => ({ ...input.activity, touchedAddresses })),
  Object.defineProperty({}, "source", { get() { throw new Error("bad getter"); } }),
]) {
  const activity = prepareAmountQuoteActivity(malformed);
  assert.equal(activity, null, "malformed/incomplete activity must not throw or issue a partial token");
  assert.equal(carryAmountQuote({ ...input, activity }), null);
}
assert(carryWithRawActivity({ ...input, activity: { ...input.activity!, touchedAddresses: new Set() } }),
  "complete empty activity is valid");

const rows = 30_000;
const makeTouched = (count: number) => new Set(Array.from({ length: count }, (_,i) =>
  "0x" + i.toString(16).padStart(40, "0")));
const largeTouched = makeTouched(1_000);
const originalIterator = largeTouched[Symbol.iterator].bind(largeTouched);
let iterations = 0, visits = 0;
Object.defineProperty(largeTouched, Symbol.iterator, { value: function* () {
  iterations++;
  for (const address of originalIterator()) { visits++; yield address; }
} });
const largeProof = prepareAmountQuoteActivity({ ...input.activity, touchedAddresses: largeTouched });
assert(largeProof);
let lookups = 0;
const originalHas = Set.prototype.has;
try {
  Set.prototype.has = function(value: unknown) { lookups++; return originalHas.call(this, value); };
  for (let row = 0; row < rows; row++) assert(carryAmountQuote({ ...input, activity: largeProof }));
} finally {
  Set.prototype.has = originalHas;
}
assert.equal(iterations, 1, "touched addresses are normalized exactly once");
assert.equal(visits, 1_000);
assert.equal(lookups, rows * policy.dependencies.length, "per-row work probes only declared dependencies");
console.log(`amount-quote-continuity PASS (${checks} original rejection controls; prepared-token safety, immutable provenance; ${visits} preparation visits + ${lookups} dependency lookups for ${rows} rows)`);

// Optional local microbenchmark; no timing threshold or RPC. Preparation is inside each measured sample.
if (process.argv.includes("--benchmark")) {
  for (const count of [0, 1_000, 10_000]) {
    const activity = { ...input.activity!, touchedAddresses: makeTouched(count) };
    const warmInput = { ...input, activity: prepareAmountQuoteActivity(activity) };
    for (let row = 0; row < 1_000; row++) assert(carryAmountQuote(warmInput));
    const samples = [];
    for (let run = 0; run < 3; run++) {
      const start = performance.now();
      const preparedInput = { ...input, activity: prepareAmountQuoteActivity(activity) };
      const prepareMs = performance.now() - start;
      let carried = 0;
      for (let row = 0; row < rows; row++) if (carryAmountQuote(preparedInput)) carried++;
      const elapsedMs = performance.now() - start;
      assert.equal(carried, rows);
      samples.push({ prepareMs: +prepareMs.toFixed(3), elapsedMs: +elapsedMs.toFixed(2), carried });
    }
    console.log(JSON.stringify({ mode: "prepared", rows, touched: count, dependencies: policy.dependencies.length, samples }));
  }
}
