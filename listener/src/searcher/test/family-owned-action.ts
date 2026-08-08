import assert from "node:assert/strict";
import type { ActionAdapter } from "../../types.js";
import {
  assertBoundFamilyOwnedAction,
  bindFamilyOwnedAction,
} from "../venues/family-owned-action.js";

const implementationState = { revision: 1 };
const encode = Object.assign(
  () => new Uint8Array([implementationState.revision]),
  { implementationState },
);
const action: ActionAdapter = {
  id: "fixture-swap",
  isWrapper: false,
  field2Offset: null,
  encode,
  matchTrace: () => true,
};

const bound = bindFamilyOwnedAction({
  action,
  descriptor: {
    adapterId: "fixture-swap",
    lineage: "custom-swap:fixture",
    edgeKind: "swap",
    action: "swap",
    canSendValue: false,
    leavesStandingPositionDefault: false,
  },
});
assertBoundFamilyOwnedAction(bound);
assert.equal(bound.id, action.id);
assert.equal(bound.descriptor.edgeKind, "swap");
assert.deepEqual([...bound.encode({} as never, "0x0", new Uint8Array())], [1]);
assert(Object.isFrozen(bound));
assert(Object.isFrozen(bound.descriptor));
assert(Object.isFrozen(bound.encode));
assert(Object.isFrozen(bound.matchTrace));
assert(Object.isFrozen(encode));
assert(Object.isFrozen(implementationState));
assert.throws(() => {
  implementationState.revision = 2;
}, TypeError);
assert.throws(() => {
  (bound.descriptor as { action: string }).action = "convert";
}, TypeError);
assert.throws(
  () => assertBoundFamilyOwnedAction({ ...bound }),
  /must come from bindFamilyOwnedAction/,
  "a structural copy must not forge Family ownership",
);

assert.throws(
  () => bindFamilyOwnedAction({
    action,
    descriptor: {
      ...bound.descriptor,
      adapterId: "wrong",
    },
  }),
  /does not match descriptor/,
);

const thenable = bindFamilyOwnedAction({
  action: {
    id: "fixture-thenable",
    isWrapper: false,
    field2Offset: null,
    encode: (() => Promise.resolve(new Uint8Array())) as never,
    matchTrace: () => false,
  },
  descriptor: {
    adapterId: "fixture-thenable",
    lineage: "custom-swap:fixture-thenable",
    edgeKind: "swap",
    action: "swap",
    canSendValue: false,
    leavesStandingPositionDefault: false,
  },
});
assert.throws(
  () => thenable.encode({} as never, "0x0", new Uint8Array()),
  /returned a thenable; it must be synchronous/,
);

assert.throws(
  () => bindFamilyOwnedAction({
    action: {
      id: "fixture-async",
      isWrapper: false,
      field2Offset: null,
      encode: (async () => new Uint8Array()) as never,
      matchTrace: () => false,
    },
    descriptor: {
      adapterId: "fixture-async",
      lineage: "custom-swap:fixture-async",
      edgeKind: "swap",
      action: "swap",
      canSendValue: false,
      leavesStandingPositionDefault: false,
    },
  }),
  /encode must be synchronous/,
);

console.log(
  "family-owned-action PASS " +
    "(unforgeable ownership + immutable implementation + sync guards)",
);
