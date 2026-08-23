import assert from "node:assert/strict";
import test from "node:test";
import { hashDomain } from "../../canonical-codec/src/index.ts";
import { assertCapabilityRef } from "../src/index.ts";

const h = (value: string) => hashDomain("test/capability-contracts", value);
const ref = () => ({
  capabilityId: "demo.exact",
  version: "1.0.0",
  schemaHash: h("schema"),
  interpreterHash: h("interpreter"),
  ownerRef: h("owner"),
});

test("runtime capability ref is exact and authority fields are mandatory", () => {
  assert.deepEqual(assertCapabilityRef(ref()), ref());
  assert.throws(() => assertCapabilityRef({ ...ref(), extra: true }), /unknown field/);
  const { ownerRef: _ownerRef, ...missing } = ref();
  assert.throws(() => assertCapabilityRef(missing), /missing field/);
});
