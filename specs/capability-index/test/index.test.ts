import assert from "node:assert/strict";
import test from "node:test";
import { hashDomain, type Hash } from "../../../packages/canonical-codec/src/index.ts";
import { decodeCapabilityIndex, sealCapabilityIndex } from "../src/index.ts";

const h = (value: string): Hash => hashDomain("test/capability-index", value);
const entry = (capabilityId: string, dependencyIds: readonly string[] = []) => ({
  capabilityId,
  version: "1.0.0",
  schemaHash: h(`${capabilityId}:schema`),
  interpreterHash: h(`${capabilityId}:interpreter`),
  dependencyIds,
  modulePath: `families/${capabilityId}/capability.ts`,
  exportName: "CAPABILITY",
});

test("capability index is deterministic and order independent", () => {
  const first = sealCapabilityIndex([entry("demo.b", ["demo.a"]), entry("demo.a")]);
  const second = sealCapabilityIndex([entry("demo.a"), entry("demo.b", ["demo.a"])]);
  assert.equal(first.capabilityIndexRoot, second.capabilityIndexRoot);
  assert.deepEqual(first.entries.map(item => item.capabilityId), ["demo.a", "demo.b"]);
  assert.equal(decodeCapabilityIndex(first).capabilityIndexRoot, first.capabilityIndexRoot);
});

test("unknown, duplicate, cyclic, and forged capability entries fail closed", () => {
  assert.throws(() => sealCapabilityIndex([entry("demo.a", ["missing"])]), /unknown capability/);
  assert.throws(() => sealCapabilityIndex([entry("demo.a"), entry("demo.a")]), /duplicate capability/);
  assert.throws(() => sealCapabilityIndex([entry("demo.a", ["demo.b"]), entry("demo.b", ["demo.a"])]), /cycle/);
  const sealed = sealCapabilityIndex([entry("demo.a")]);
  assert.throws(() => decodeCapabilityIndex({ ...sealed, capabilityIndexRoot: h("forged") }), /root mismatch/);
  assert.throws(() => decodeCapabilityIndex({ ...sealed, entries: [{ ...sealed.entries[0]!, unknown: true }] }), /unknown field/);
});
