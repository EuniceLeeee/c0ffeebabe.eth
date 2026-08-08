import assert from "node:assert/strict";
import { hashCanonical } from "../venues/canonical-value.js";

assert.equal(
  hashCanonical({ z: [1n, true], a: { y: "value", x: null } }),
  hashCanonical({ a: { x: null, y: "value" }, z: [1n, true] }),
  "object insertion order must not affect the semantic hash",
);
assert.notEqual(
  hashCanonical(1n),
  hashCanonical({ $bigint: "1" }),
  "a bigint must not collide with a user record",
);
assert.notEqual(hashCanonical(0), hashCanonical(-0));
assert.notEqual(hashCanonical(1), hashCanonical("1"));

assert.throws(
  () => hashCanonical({ missing: undefined } as never),
  /unsupported canonical value type: undefined/,
);
assert.throws(
  () => hashCanonical([, "value"] as never),
  /must not be sparse/,
);
assert.throws(
  () => hashCanonical({ bad: Number.NaN } as never),
  /numbers must be finite/,
);
assert.throws(
  () => hashCanonical(Object.assign(["value"], { extra: true }) as never),
  /must not have extra properties/,
);

const symbolRecord = { value: 1 } as Record<PropertyKey, unknown>;
symbolRecord[Symbol("hidden")] = true;
assert.throws(
  () => hashCanonical(symbolRecord as never),
  /must not have symbol keys/,
);

const cyclic: { self?: unknown } = {};
cyclic.self = cyclic;
assert.throws(
  () => hashCanonical(cyclic as never),
  /must not contain cycles/,
);

console.log("canonical-value PASS (typed deterministic fail-closed encoding)");
