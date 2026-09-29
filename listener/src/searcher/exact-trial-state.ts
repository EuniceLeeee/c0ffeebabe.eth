import type {
  ExactTrialState, ExactTrialStateChange, ExactTrialStateRef,
} from "./venues/adapter-family-plugin.js";

/** Private immutable cells; no protocol fields or Family identities. */
export interface ExactTrialSnapshot {
  readonly view: ExactTrialState;
}
interface Cell {
  readonly ref: ExactTrialStateRef;
  readonly value: unknown;
  readonly versions: ReadonlyMap<string, number>;
}
interface State {
  readonly cells: ReadonlyMap<string, Cell>;
  readonly versions: ReadonlyMap<string, number>;
}
const snapshots = new WeakMap<ExactTrialSnapshot, State>();
const immutableValues = new WeakSet<object>();

/** A route composition failure, not evidence that an entire Family is broken. */
export class ExactTrialStateConflictError extends Error {
  constructor(message: string) { super(message); this.name = "ExactTrialStateConflictError"; }
}

function refValue(ref: ExactTrialStateRef): ExactTrialStateRef {
  if (!ref || [ref.key, ref.schema, ref.binding].some(v =>
    typeof v !== "string" || v.length === 0 || v.trim() !== v)) {
    throw new Error("invalid exact trial state reference");
  }
  if (ref.dependencies !== undefined && (!Array.isArray(ref.dependencies) ||
      ref.dependencies.some(v => typeof v !== "string" || !v || v.trim() !== v))) {
    throw new Error("invalid exact trial state dependencies");
  }
  return Object.freeze({ key: ref.key, schema: ref.schema, binding: ref.binding,
    dependencies: Object.freeze([...new Set([ref.key, ...(ref.dependencies ?? [])])].sort()) });
}
function checkBinding(left: ExactTrialStateRef, right: ExactTrialStateRef): void {
  if (left.schema !== right.schema || left.binding !== right.binding ||
      JSON.stringify(left.dependencies) !== JSON.stringify(right.dependencies)) {
    throw new ExactTrialStateConflictError(`exact trial state binding conflict: ${right.key}`);
  }
}

function issue(state: State): ExactTrialSnapshot {
  const snapshot = Object.freeze({ view: Object.freeze({
    get(ref: ExactTrialStateRef): unknown | undefined {
      const requested = refValue(ref);
      const cell = state.cells.get(requested.key);
      // Dynamic models may discover their dependency closure on the first read.
      // Looking up such an existing cell always checks its FULL stored closure.
      if (cell) checkBinding(cell.ref, ref.dependencies === undefined
        ? { ...requested, dependencies: cell.ref.dependencies } : requested);
      for (const dependency of cell?.ref.dependencies ?? requested.dependencies!) {
        if ((state.versions.get(dependency) ?? 0) !== (cell?.versions.get(dependency) ?? 0)) {
          throw new ExactTrialStateConflictError(`exact trial state invalidated dependency: ${dependency}`);
        }
      }
      return cell?.value;
    },
  }) });
  snapshots.set(snapshot, state);
  return snapshot;
}

export function emptyExactTrialState(): ExactTrialSnapshot { return issue({ cells: new Map(), versions: new Map() }); }

/** Atomic copy-on-write publication. A failed quote never commits partial cells;
 * sharing an earlier snapshot creates an independent branch for another amount. */
export function applyExactTrialState(
  base: ExactTrialSnapshot, changes: readonly ExactTrialStateChange[], effects: readonly string[] = [],
): ExactTrialSnapshot {
  const previous = snapshots.get(base);
  if (!previous) throw new Error("unissued exact trial snapshot");
  if (!Array.isArray(changes)) throw new Error("exact trial quote must declare stateChanges");
  if (!Array.isArray(effects) || effects.some(v => typeof v !== "string" || !v || v.trim() !== v)) {
    throw new Error("invalid exact trial state effects");
  }
  const cells = new Map(previous.cells);
  const versions = new Map(previous.versions);
  const changed = new Set(effects);
  for (const change of changes) changed.add(refValue(change?.ref).key);
  for (const key of changed) versions.set(key, (versions.get(key) ?? 0) + 1);
  const seen = new Set<string>();
  for (const change of changes) {
    const ref = refValue(change?.ref);
    if (seen.has(ref.key)) throw new Error(`duplicate exact trial state change: ${ref.key}`);
    seen.add(ref.key);
    const incumbent = previous.cells.get(ref.key);
    if (incumbent) checkBinding(incumbent.ref, ref);
    if (change.value === undefined) throw new Error("undefined exact trial state");
    cells.set(ref.key, Object.freeze({ ref, value: immutableData(change.value),
      versions: new Map(ref.dependencies!.map(key => [key, versions.get(key) ?? 0])) }));
  }
  return issue({ cells, versions });
}

/** Freeze owned copies, including collection mutation APIs. Frozen Maps alone
 * are mutable. Already-issued subtrees (e.g. tick data) can be shared unchanged. */
function immutableData(value: unknown, visiting = new Set<object>()): unknown {
  if (value === null || ["string", "boolean", "bigint", "undefined"].includes(typeof value)) return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "object") throw new Error("exact trial state must be finite data");
  if (immutableValues.has(value)) return value;
  if (visiting.has(value)) throw new Error("cyclic exact trial state");
  visiting.add(value);
  let result: object;
  if (value instanceof Map) {
    const entries = new Map<unknown, unknown>();
    for (const [key, item] of Map.prototype.entries.call(value)) {
      if (key !== null && typeof key === "object") throw new Error("exact trial map key must be primitive");
      entries.set(immutableData(key, visiting), immutableData(item, visiting));
    }
    const readonly = new Proxy(entries, { get(target, key) {
      if (key === "valueOf") return () => readonly;
      if (key === "set" || key === "delete" || key === "clear") {
        return () => { throw new Error("exact trial state is immutable"); };
      }
      if (key === "forEach") return (callback: (v: unknown, k: unknown, m: unknown) => void, thisArg?: unknown) =>
        target.forEach((v, k) => callback.call(thisArg, v, k, readonly));
      const member = Reflect.get(target, key, target);
      return typeof member === "function" ? member.bind(target) : member;
    } });
    result = Object.freeze(readonly);
  } else if (Array.isArray(value)) {
    const copy: unknown[] = [];
    for (const key of Reflect.ownKeys(value)) {
      if (key !== "length" && (typeof key !== "string" || !/^(0|[1-9][0-9]*)$/.test(key) ||
          Number(key) >= value.length)) throw new Error("exact trial array has non-index properties");
    }
    for (let index = 0; index < value.length; index++) {
      const property = Object.getOwnPropertyDescriptor(value, String(index));
      if (!property || !("value" in property)) throw new Error("exact trial array must contain plain data");
      copy.push(immutableData(property.value, visiting));
    }
    result = Object.freeze(copy);
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new Error("exact trial state must be plain data");
    const copy: Record<string, unknown> = {};
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") throw new Error("exact trial state symbol key unsupported");
      const property = Object.getOwnPropertyDescriptor(value, key)!;
      if (!("value" in property)) throw new Error("exact trial state accessors unsupported");
      Object.defineProperty(copy, key, { value: immutableData(property.value, visiting), enumerable: true });
    }
    result = Object.freeze(copy);
  }
  visiting.delete(value);
  immutableValues.add(result);
  return result;
}
