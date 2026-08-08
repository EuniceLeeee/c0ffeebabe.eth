import type { AdapterDescriptor } from "../../adapters/adapter-descriptors.js";
import type { ActionAdapter } from "../../types.js";

export interface FamilyOwnedActionAdapter {
  readonly id: string;
  readonly isWrapper: boolean;
  readonly field2Offset: ActionAdapter["field2Offset"];
  readonly encode: ActionAdapter["encode"];
  readonly matchTrace: ActionAdapter["matchTrace"];
  readonly descriptor: AdapterDescriptor & {
    readonly edgeKind: "swap" | "protocol" | "flash" | "credit";
  };
}

const boundFamilyOwnedActions = new WeakSet<object>();

/**
 * Binds an existing low-level encoder to the descriptor that the strict
 * Family owns. The returned adapter is already synchronously guarded and
 * deeply immutable, so it can be passed directly to defineSwapFamily or
 * another strict Domain constructor without an author-written mutable wrapper.
 *
 * This is a definition helper only. It does not register or load the action,
 * and it cannot turn shared infrastructure into a Family-owned route root.
 */
export function bindFamilyOwnedAction(input: {
  readonly action: ActionAdapter;
  readonly descriptor: AdapterDescriptor & {
    readonly edgeKind: "swap" | "protocol" | "flash" | "credit";
  };
}): FamilyOwnedActionAdapter {
  const { action, descriptor } = input;
  assertRawActionContract(action);
  if (boundFamilyOwnedActions.has(action)) {
    throw new Error(`ActionAdapter ${action.id} is already Family-bound`);
  }
  if (action.id !== descriptor.adapterId) {
    throw new Error(
      `ActionAdapter ${action.id} does not match descriptor ` +
        descriptor.adapterId,
    );
  }
  if (
    action.descriptor !== undefined &&
    !sameDescriptor(action.descriptor, descriptor)
  ) {
    throw new Error(
      `ActionAdapter ${action.id} has a conflicting embedded descriptor`,
    );
  }

  const implementation = {
    id: action.id,
    isWrapper: action.isWrapper,
    field2Offset: action.field2Offset,
    encode: action.encode,
    matchTrace: action.matchTrace,
  } satisfies ActionAdapter;
  assertSynchronousFunction(
    implementation.encode,
    `ActionAdapter ${action.id}.encode`,
  );
  assertSynchronousFunction(
    implementation.matchTrace,
    `ActionAdapter ${action.id}.matchTrace`,
  );
  if (typeof implementation.field2Offset === "function") {
    assertSynchronousFunction(
      implementation.field2Offset,
      `ActionAdapter ${action.id}.field2Offset`,
    );
  }

  // Seal callback-owned state before it disappears behind the wrappers. The
  // generated execution capability hash still follows the real action source
  // module; these wrappers are only the runtime contract guard.
  deepFreezeCallback(
    implementation.encode,
    `ActionAdapter ${action.id}.encode implementation`,
    new Set<object>(),
  );
  deepFreezeCallback(
    implementation.matchTrace,
    `ActionAdapter ${action.id}.matchTrace implementation`,
    new Set<object>(),
  );
  if (typeof implementation.field2Offset === "function") {
    deepFreezeCallback(
      implementation.field2Offset,
      `ActionAdapter ${action.id}.field2Offset implementation`,
      new Set<object>(),
    );
  }
  Object.freeze(implementation);

  const finalDescriptor = Object.freeze({ ...descriptor });
  const receiver = Object.freeze({
    ...implementation,
    descriptor: finalDescriptor,
  }) satisfies ActionAdapter;
  const encode: ActionAdapter["encode"] = (...args) => {
    const result = Reflect.apply(implementation.encode, receiver, args);
    assertNonThenable(result, `ActionAdapter ${action.id}.encode`);
    return result;
  };
  const matchTrace: ActionAdapter["matchTrace"] = (...args) => {
    const result = Reflect.apply(implementation.matchTrace, receiver, args);
    assertNonThenable(result, `ActionAdapter ${action.id}.matchTrace`);
    return result;
  };
  const field2Offset = typeof implementation.field2Offset === "function"
    ? ((...args: Parameters<Exclude<
        ActionAdapter["field2Offset"],
        number | null
      >>) => {
        const result = Reflect.apply(
          implementation.field2Offset as Exclude<
            ActionAdapter["field2Offset"],
            number | null
          >,
          receiver,
          args,
        );
        assertNonThenable(result, `ActionAdapter ${action.id}.field2Offset`);
        return result;
      })
    : implementation.field2Offset;

  Object.freeze(encode);
  Object.freeze(matchTrace);
  if (typeof field2Offset === "function") Object.freeze(field2Offset);
  const bound: FamilyOwnedActionAdapter = Object.freeze({
    id: implementation.id,
    isWrapper: implementation.isWrapper,
    field2Offset,
    encode,
    matchTrace,
    descriptor: finalDescriptor,
  });
  boundFamilyOwnedActions.add(bound);
  return bound;
}

/** Runtime identity gate; structural lookalikes and spread copies fail. */
export function assertBoundFamilyOwnedAction(
  value: unknown,
): asserts value is FamilyOwnedActionAdapter {
  if (
    value === null ||
    typeof value !== "object" ||
    !boundFamilyOwnedActions.has(value)
  ) {
    throw new Error(
      "family ActionAdapter must come from bindFamilyOwnedAction",
    );
  }
  if (!Object.isFrozen(value)) {
    throw new Error("bound family ActionAdapter is not frozen");
  }
}

function assertRawActionContract(action: ActionAdapter): void {
  if (
    action === null ||
    typeof action !== "object" ||
    Array.isArray(action) ||
    (Object.getPrototypeOf(action) !== Object.prototype &&
      Object.getPrototypeOf(action) !== null)
  ) {
    throw new Error("ActionAdapter must be a plain object");
  }
  const allowed = new Set([
    "descriptor",
    "encode",
    "field2Offset",
    "id",
    "isWrapper",
    "matchTrace",
  ]);
  for (const key of Reflect.ownKeys(action)) {
    if (typeof key !== "string" || !allowed.has(key)) {
      throw new Error(`ActionAdapter has unknown field ${String(key)}`);
    }
    const property = Object.getOwnPropertyDescriptor(action, key);
    if (
      property === undefined ||
      !property.enumerable ||
      !("value" in property)
    ) {
      throw new Error(`ActionAdapter.${key} must be an enumerable data field`);
    }
  }
  for (const key of [
    "encode",
    "field2Offset",
    "id",
    "isWrapper",
    "matchTrace",
  ]) {
    if (!Object.hasOwn(action, key)) {
      throw new Error(`ActionAdapter is missing required field ${key}`);
    }
  }
  if (typeof action.id !== "string" || action.id.length === 0) {
    throw new Error("ActionAdapter id must be a non-empty string");
  }
  if (typeof action.isWrapper !== "boolean") {
    throw new Error(`ActionAdapter ${action.id} isWrapper must be boolean`);
  }
  if (
    action.field2Offset !== null &&
    typeof action.field2Offset !== "number" &&
    typeof action.field2Offset !== "function"
  ) {
    throw new Error(`ActionAdapter ${action.id} field2Offset is invalid`);
  }
  if (
    typeof action.encode !== "function" ||
    typeof action.matchTrace !== "function"
  ) {
    throw new Error(`ActionAdapter ${action.id} is missing its encoder contract`);
  }
}

function sameDescriptor(
  left: AdapterDescriptor,
  right: AdapterDescriptor,
): boolean {
  return left.adapterId === right.adapterId &&
    left.lineage === right.lineage &&
    left.edgeKind === right.edgeKind &&
    left.action === right.action &&
    left.canSendValue === right.canSendValue &&
    left.leavesStandingPositionDefault ===
      right.leavesStandingPositionDefault;
}

function assertSynchronousFunction(value: Function, label: string): void {
  if (value.constructor?.name === "AsyncFunction") {
    throw new Error(`${label} must be synchronous`);
  }
}

function assertNonThenable(value: unknown, label: string): void {
  if (
    value === null ||
    (typeof value !== "object" && typeof value !== "function")
  ) {
    return;
  }
  let then: unknown;
  try {
    then = (value as { readonly then?: unknown }).then;
  } catch {
    throw new Error(`${label} returned an unreadable thenable`);
  }
  if (typeof then === "function") {
    throw new Error(`${label} returned a thenable; it must be synchronous`);
  }
}

function deepFreezeCallback(
  value: Function,
  path: string,
  stack: Set<object>,
): void {
  if (stack.has(value)) throw new Error(`${path} must not contain cycles`);
  stack.add(value);
  for (const key of Reflect.ownKeys(value)) {
    if (key === "arguments" || key === "caller") continue;
    const property = Object.getOwnPropertyDescriptor(value, key);
    if (property === undefined || !("value" in property)) {
      throw new Error(`${path}.${String(key)} must be a data field`);
    }
    if (key === "prototype" && property.value !== undefined) {
      deepFreezeCallbackPrototype(
        property.value,
        `${path}.prototype`,
        stack,
        value,
      );
    } else {
      deepFreezeCallbackValue(property.value, `${path}.${String(key)}`, stack);
    }
  }
  stack.delete(value);
  Object.freeze(value);
}

function deepFreezeCallbackValue(
  value: unknown,
  path: string,
  stack: Set<object>,
): void {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) {
    return;
  }
  if (typeof value === "function") {
    deepFreezeCallback(value, path, stack);
    return;
  }
  if (stack.has(value)) throw new Error(`${path} must not contain cycles`);
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${path} must contain only plain records and arrays`);
  }
  stack.add(value);
  for (const key of Reflect.ownKeys(value)) {
    const property = Object.getOwnPropertyDescriptor(value, key);
    if (property === undefined || !("value" in property)) {
      throw new Error(`${path}.${String(key)} must be a data field`);
    }
    deepFreezeCallbackValue(property.value, `${path}.${String(key)}`, stack);
  }
  stack.delete(value);
  Object.freeze(value);
}

function deepFreezeCallbackPrototype(
  value: unknown,
  path: string,
  stack: Set<object>,
  owner: Function,
): void {
  if (value === null || typeof value !== "object") return;
  if (stack.has(value)) throw new Error(`${path} must not contain cycles`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${path} must be a plain function prototype`);
  }
  stack.add(value);
  for (const key of Reflect.ownKeys(value)) {
    const property = Object.getOwnPropertyDescriptor(value, key);
    if (property === undefined || !("value" in property)) {
      throw new Error(`${path}.${String(key)} must be a data field`);
    }
    if (key === "constructor" && property.value === owner) continue;
    deepFreezeCallbackValue(property.value, `${path}.${String(key)}`, stack);
  }
  stack.delete(value);
  Object.freeze(value);
}
