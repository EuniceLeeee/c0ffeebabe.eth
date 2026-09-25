import assert from "node:assert/strict";
import { test } from "node:test";
import type { TokenEdge } from "../planner/token-graph.js";
import { strictReadyGraphContractFingerprint } from "../strict-production-runtime-session.js";
import { blockScanEdgeMetadataFingerprint, deterministicHash } from "../venues/blockscan-state-capability.js";
import { createRouteImmutableBinding } from "../venues/route-immutable-binding.js";

const TOKEN0 = "0x1111111111111111111111111111111111111111";
const TOKEN1 = "0x2222222222222222222222222222222222222222";
const POOL = "0x3333333333333333333333333333333333333333";
const ZERO = "0x0000000000000000000000000000000000000000";
function edge(overrides: Partial<TokenEdge> = {}): TokenEdge {
  return { instanceKey: POOL, executionVariantKey: "fixture", adapterId: "univ3-swap",
    target: POOL, tokenIn: TOKEN0, tokenOut: TOKEN1, slotKind: "swap", edgeKind: "swap",
    leavesStandingPosition: false, ...overrides };
}
const uncached = (edges: readonly TokenEdge[]) => deterministicHash(edges.map(blockScanEdgeMetadataFingerprint));
const fingerprint = (value: TokenEdge) => strictReadyGraphContractFingerprint([value]);
function v4Key() {
  return { currency0: TOKEN0, currency1: TOKEN1, fee: 3000, tickSpacing: 60, hooks: ZERO };
}

test("deep immutable data preserves canonical hash across cloned outer arrays", () => {
  const binding = createRouteImmutableBinding("fixture:v1", "0x1234");
  const shared = Object.freeze({ label: "nested" });
  const value = Object.freeze({ ...edge({ routeBinding: binding, v4PoolKey: Object.freeze(v4Key()) }),
    // Eligibility inspects all own data, including non-metadata extensions.
    extension: Object.freeze([shared, shared, Object.freeze(Object.create(null))]),
  });
  const expected = uncached([value]);
  for (let i = 0; i < 4; i++) {
    assert.equal(strictReadyGraphContractFingerprint([value]), expected);
    assert.equal(strictReadyGraphContractFingerprint(Object.freeze([value])), expected);
  }
  assert.equal(fingerprint(Object.freeze({ ...value })), expected, "an equal foreign edge still derives the same hash");
});

test("ordered outer hash still rejects reorder, replacement, duplication and removal", () => {
  const a = Object.freeze(edge()), b = Object.freeze(edge({ tokenIn: TOKEN1, tokenOut: TOKEN0 }));
  const expected = strictReadyGraphContractFingerprint([a, b]);
  assert.equal(expected, uncached([a, b]));
  for (const changed of [[b, a], [a, Object.freeze({ ...b, v3Fee: 500 })], [a, a], [a]]) {
    assert.notEqual(strictReadyGraphContractFingerprint(changed), expected);
    assert.equal(strictReadyGraphContractFingerprint(changed), uncached(changed));
  }
  const mutableArray = [a, b];
  assert.equal(strictReadyGraphContractFingerprint(mutableArray), expected);
  mutableArray.reverse();
  assert.notEqual(strictReadyGraphContractFingerprint(mutableArray), expected);
});

test("mutable edges and shallow-frozen V4 bindings never retain obsolete metadata", () => {
  const mutable = edge({ v3Fee: 3000 });
  const before = fingerprint(mutable);
  mutable.v3Fee = 500;
  assert.notEqual(fingerprint(mutable), before);
  assert.equal(fingerprint(mutable), uncached([mutable]));
  const key = v4Key(), shallow = Object.freeze(edge({ v4PoolKey: key }));
  const shallowBefore = fingerprint(shallow);
  key.fee = 500;
  assert.notEqual(fingerprint(shallow), shallowBefore);
  assert.equal(fingerprint(shallow), uncached([shallow]));
  Object.freeze(key);
  assert.equal(fingerprint(shallow), uncached([shallow]), "a later positive deep-freeze proof is allowed");
});

test("mutable route binding is revalidated, including rejection after payload corruption", () => {
  const binding = { ...createRouteImmutableBinding("fixture:v1", "0x1234") };
  const value = Object.freeze(edge({ routeBinding: binding }));
  const before = fingerprint(value);
  Object.assign(binding, createRouteImmutableBinding("fixture:v1", "0x5678"));
  assert.notEqual(fingerprint(value), before);
  assert.equal(fingerprint(value), uncached([value]));
  binding.payload = "0xabcd";
  assert.throws(() => fingerprint(value), /hash mismatch/);
  Object.assign(binding, createRouteImmutableBinding("fixture:v1", "0x5678"));
  assert.equal(fingerprint(value), uncached([value]));
  const malformedFrozen = Object.freeze(edge({ routeBinding: Object.freeze({ ...binding, payload: "0xffff" }) }));
  assert.throws(() => fingerprint(malformedFrozen), /hash mismatch/);
  assert.throws(() => fingerprint(malformedFrozen), /hash mismatch/, "a failed first hash is never cached");
});

test("frozen edge and nested binding accessors remain on the uncached validation path", () => {
  let fee = 3000, getterReads = 0;
  const getter = () => { getterReads++; return fee; };
  const accessor = Object.freeze(Object.defineProperty(edge(), "v3Fee", { enumerable: true, get: getter }));
  const expectedReads = (() => { uncached([accessor]); const n = getterReads; getterReads = 0; return n; })();
  const before = fingerprint(accessor);
  assert.equal(getterReads, expectedReads, "immutability eligibility does not invoke a getter");
  fee = 500;
  assert.notEqual(fingerprint(accessor), before);
  const key = Object.freeze(Object.defineProperty(v4Key(), "fee", { enumerable: true, get: getter }));
  const nested = Object.freeze(edge({ v4PoolKey: key }));
  const nestedBefore = fingerprint(nested);
  fee = 100;
  assert.notEqual(fingerprint(nested), nestedBefore);
  assert.equal(fingerprint(nested), uncached([nested]));
});

test("frozen proxies and nonplain inherited accessors cannot masquerade as immutable data", () => {
  let fee = 3000;
  const target = Object.freeze(edge());
  const proxy = new Proxy(target, { get: (object, key, receiver) =>
    key === "v3Fee" ? fee : Reflect.get(object, key, receiver) });
  const proxyBefore = fingerprint(proxy);
  fee = 500;
  assert.notEqual(fingerprint(proxy), proxyBefore);
  assert.equal(fingerprint(proxy), uncached([proxy]));
  const inherited = Object.freeze(Object.assign(Object.create({ get v3Fee() { return fee; } }), edge())) as TokenEdge;
  const inheritedBefore = fingerprint(inherited);
  fee = 100;
  assert.notEqual(fingerprint(inherited), inheritedBefore);
  class ForeignKey {
    currency0 = TOKEN0; currency1 = TOKEN1; tickSpacing = 60; hooks = ZERO;
    get fee() { return fee; }
  }
  const nested = Object.freeze(edge({ v4PoolKey: Object.freeze(new ForeignKey()) }));
  const nestedBefore = fingerprint(nested);
  fee = 50;
  assert.notEqual(fingerprint(nested), nestedBefore);
});

test("eligibility rejects mutable/function/nonplain/cyclic nested data without extra getter reads", t => {
  const cycle: Record<string, unknown> = {}; cycle.self = cycle; Object.freeze(cycle);
  for (const extension of [Object.freeze([{}]), Object.freeze({ fn: Object.freeze(() => {}) }),
    Object.freeze(new Map()), cycle]) {
    const value = Object.freeze({ ...edge(), extension });
    const original = Object.getOwnPropertyDescriptor;
    let reads = 0;
    const mock = t.mock.method(Object, "getOwnPropertyDescriptor", (object: object, key: PropertyKey) => {
      if (object === value) reads++;
      return original(object, key);
    });
    try {
      const first = fingerprint(value), firstReads = reads;
      assert(firstReads > 0);
      assert.equal(fingerprint(value), first);
      assert(reads > firstReads, "ineligible data must be checked again, not cached");
    } finally { mock.mock.restore(); }
  }
});
