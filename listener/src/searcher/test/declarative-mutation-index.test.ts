import definition from "../venues/swaps/univ4-family/univ4.json";
import { compileDeclarativeSwap } from "../venues/declarative-swap.js";
import assert from "node:assert/strict";
import test from "node:test";
import { ethers } from "ethers";
import { compileKeyedAddressMutations, declarativeMutationEquality } from "../venues/declarative-mutation-key.js";
import { plugin } from "../venues/production-families/univ4.production.js";
import { UNIV4_SWAP_TOPIC, UNIV4_MODIFY_LIQUIDITY_TOPIC, UNIV4_INITIALIZE_TOPIC } from "../venues/swaps/univ4-abi.js";
import type { UnifiedObservation } from "../venues/adapter-family-plugin.js";

const equality = { op: "eq", args: ["$observation.topics.1", "$descriptor.poolId"] };
test("only necessary pure path equalities may narrow a mutation predicate", () => {
  assert.deepEqual(declarativeMutationEquality(equality), {
    observation: "$observation.topics.1", entry: "$descriptor.poolId",
  });
  assert.deepEqual(declarativeMutationEquality({ op: "and", args: [
    { op: "eq", args: ["$observation.kind", "log"] },
    { op: "and", args: [{ op: "eq", args: [...equality.args].reverse() }] },
  ] }), {
    ...declarativeMutationEquality(equality),
    prefix: [{ op: "eq", args: ["$observation.kind", "log"] }],
  });
  for (const predicate of [
    { op: "or", args: [equality, true] },
    { op: "not", args: [equality] },
    { op: "and", args: [{ op: "eq", args: [
      { op: "uint", args: ["$observation.data"] }, 0,
    ] }, equality] },
    { op: "if", args: [equality, true, true] },
    { op: "eq", args: ["$observation.address", "$binding.pool"] },
    { op: "eq", args: ["$observation.address", "$source.hash"] },
    { op: "and", args: [false, { op: "eq", args: [
      { op: "get", args: ["$observation", "constructor"] }, "$descriptor.poolId",
    ] }] },
    { op: "eq", args: ["$observation.__proto__.topic", "$descriptor.poolId"] },
    { op: "eq", args: [{ op: "get", args: ["$observation", "$observation.key"] }, "$descriptor.poolId"] },
    { op: "eq", args: [{ op: "expression", args: ["unknown", {}] }, "$descriptor.poolId"] },
    { op: "eq", args: ["$observation.topics.1", { op: "model", args: ["math", "$descriptor"] }] },
  ]) assert.equal(declarativeMutationEquality(predicate), undefined);
});

const address = (n: number) => ethers.toBeHex(n, 20);
const hash = (n: number) => ethers.toBeHex(n, 32);
const manager = address(100001);
const source = { number: 100, hash: hash(100), generation: 1 };
const log = (emitter: string, topics: string[]): UnifiedObservation => ({
  kind: "log", source, address: emitter, topics, data: "0x",
});

test("[family=univ4] installed JSON mutation compiler looks up a shared manager's pool before evaluating predicates", () => {
  let reads = 0;
  const entries = Array.from({ length: 2048 }, (_, i) => {
    const poolId = hash(i + 1);
    return {
      descriptor: {
        familyId: plugin.manifest.familyId, lineageId: plugin.manifest.supportedLineages[0],
        instanceKey: poolId, get poolId() { reads++; return poolId; },
        poolKey: { currency0: address(1), currency1: address(2), fee: 3000,
          tickSpacing: 60, hooks: ethers.ZeroAddress },
        graphToken0: address(1), graphToken1: address(2), hookPolicy: "no-hook" as const,
        managerBinding: { manager, stateView: address(100002), quoter: address(100003) },
      },
      dependencies: [manager, address(1), address(2)], routes: [{ poolId }], stateKey: poolId,
    };
  });
  type Entry = Parameters<NonNullable<typeof plugin.pricing.mutation.compile>>[0]["entries"][number];
  const bound = entries as unknown as Entry[];
  const index = plugin.pricing.mutation.compile!({ entries: bound });
  const topics = [UNIV4_SWAP_TOPIC, UNIV4_MODIFY_LIQUIDITY_TOPIC, UNIV4_INITIALIZE_TOPIC, hash(0)];
  for (const emitter of [manager, address(999)]) for (const topic of topics) {
    for (const poolId of [hash(1), hash(2048), hash(9999)]) {
      const observation = log(emitter, [topic, poolId]);
      const expected = bound.flatMap(entry => plugin.pricing.mutation.affectedStateKeys({ ...entry, observation }));
      reads = 0;
      assert.deepEqual(index.affectedStateKeys({ observation }), expected);
      assert(reads <= 1, "one event must not inspect unrelated pools behind a shared address");
    }
  }
  const altered = structuredClone(definition) as any;
  // This field is used only in the predicate, so compiling dependencies does not read it.
  altered.standard.pricing.mutationPredicate.args[2].args[1] = {
    op: "lower", args: ["$descriptor.mutationKeyFixture"],
  };
  const malformedDescriptor = { ...bound[0], descriptor: {
    ...bound[0].descriptor, mutationKeyFixture: Object.create(null),
  } };
  const fallback = compileDeclarativeSwap(altered).pricing.mutation!.compile!({ entries: [malformedDescriptor] });
  assert.deepEqual(fallback.affectedStateKeys({ observation: log(manager, [hash(0), hash(1)]) }), []);
  assert.throws(() => fallback.affectedStateKeys({ observation: log(manager, [UNIV4_SWAP_TOPIC, hash(1)]) }), TypeError);
  const malformedTopic = Object.create(null) as string;
  const malformedPrefix = log(manager, [malformedTopic, hash(9999)]);
  assert.throws(() => index.affectedStateKeys({ observation: malformedPrefix }), TypeError);
  const malformedKey = log(manager, [hash(0), malformedTopic]);
  assert.deepEqual(index.affectedStateKeys({ observation: malformedKey }), []);
  assert.throws(() => index.affectedStateKeys({ observation: log(manager, [UNIV4_SWAP_TOPIC, malformedTopic]) }), TypeError);
  for (const observation of [log(manager, []), log(manager, [UNIV4_SWAP_TOPIC]),
    { kind: "call" as const, source, target: manager, data: "0x" }]) {
    reads = 0;
    assert.deepEqual(index.affectedStateKeys({ observation }), []);
    assert.equal(reads, 0);
  }
});

test("partitioned address lookup keeps dependencies, key identity and collisions independent", () => {
  const descriptor = (value: unknown) => ({ value });
  const entries = [
    { descriptor: descriptor("A"), routes: [], dependencies: [manager], stateKey: "x" },
    { descriptor: descriptor("A"), routes: [], dependencies: [manager], stateKey: "y" },
    { descriptor: descriptor("a"), routes: [], dependencies: [manager], stateKey: "z" },
    { descriptor: descriptor("A"), routes: [], dependencies: [address(8)], stateKey: "excluded" },
  ];
  const index = compileKeyedAddressMutations(entries, entry => ({ addresses: [manager], keys: [entry.stateKey!] }), {
    kinds: ["log"],
    entryKey: entry => entry.descriptor.value,
    observationKey: observation => observation.kind === "log" ? [observation.topics[0]] : undefined,
  });
  assert.deepEqual(index.dependencies, [manager]);
  assert.deepEqual(index.affectedStateKeys({ observation: log(manager, ["A"]) }), ["x", "y"]);
  assert.deepEqual(index.affectedStateKeys({ observation: log(manager, ["a"]) }), ["z"]);
  assert.deepEqual(index.affectedStateKeys({ observation: log(address(8), ["A"]) }), []);
  assert.deepEqual(index.affectedStateKeys({ observation: log(manager, []) }), []);
});

test("context-shadowed observation uses the original mutation evaluation environment", () => {
  const altered = structuredClone(definition) as any;
  altered.standard.context = { ...altered.standard.context,
    observation: { kind: "log", address: manager, topics: [UNIV4_SWAP_TOPIC, hash(1)], data: "0x" },
  };
  const pricing = compileDeclarativeSwap(altered).pricing;
  const entries = [1, 2].map(n => {
    const poolId = hash(n);
    return {
      descriptor: {
        familyId: plugin.manifest.familyId, lineageId: plugin.manifest.supportedLineages[0],
        instanceKey: poolId, poolId,
        poolKey: { currency0: address(1), currency1: address(2), fee: 3000, tickSpacing: 60, hooks: ethers.ZeroAddress },
        graphToken0: address(1), graphToken1: address(2), hookPolicy: "no-hook",
        managerBinding: { manager, stateView: address(100002), quoter: address(100003) },
      },
      routes: [{ poolId }], dependencies: [manager], stateKey: poolId,
    };
  }) as any;
  const observation = log(manager, [UNIV4_SWAP_TOPIC, hash(2)]);
  const expected = entries.flatMap((entry: any) => pricing.mutation!.affectedStateKeys({ ...entry, observation }));
  assert.deepEqual(expected, [hash(1)]);
  assert.deepEqual(pricing.mutation!.compile!({ entries }).affectedStateKeys({ observation }), expected);
});
