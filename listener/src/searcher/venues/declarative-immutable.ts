import { immutableExactTrialData, isImmutableExactTrialData } from "../exact-trial-state.js";

const forbidden = new Set(["__proto__", "constructor", "prototype"]);
const checked = { math: new WeakSet<object>(), trial: new WeakSet<object>() };

/** JSON stays JSON. Runtime mathematical/state values additionally support Maps,
 * whose keys remain primitive and whose mutation APIs are sealed by the existing
 * trial-state issuer. Math numbers are exact safe integers (indices/decimals),
 * never a replacement for bigint amounts. */
export function immutableDeclarativeData<T>(value: T, mode: "math" | "trial"): T {
  const accepted = checked[mode], visiting = new Set<object>();
  const invalid = () => new Error(mode === "math"
    ? "math values must be lossless plain data or Maps"
    : "trial-state values must be plain data or Maps");
  function validate(value: unknown): void {
    if (value === null || ["string", "boolean", "bigint"].includes(typeof value)) return;
    if (value === undefined && mode === "trial") return;
    if (typeof value === "number" && (mode === "math" ? Number.isSafeInteger(value) : Number.isFinite(value))) return;
    if (!value || typeof value !== "object") throw invalid();
    const issued = isImmutableExactTrialData(value);
    if (issued && accepted.has(value)) return;
    if (visiting.has(value)) throw new Error("cyclic declarative runtime data");
    visiting.add(value);
    if (value instanceof Map) {
      if (Object.getPrototypeOf(value) !== Map.prototype || Reflect.ownKeys(value).length) throw invalid();
      // Calling a native Map method on an arbitrary Proxy throws. Only the
      // issuer's known readonly proxy may use its controlled bound iterator.
      const entries: IterableIterator<[unknown, unknown]> = issued ? value.entries() : Map.prototype.entries.call(value);
      for (const [key, item] of entries) {
        if (key !== null && typeof key === "object") throw new Error("declarative Map keys must be primitive");
        validate(key); validate(item);
      }
    } else if (Array.isArray(value)) {
      for (const key of Reflect.ownKeys(value)) {
        if (key !== "length" && (typeof key !== "string" || !/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length)) throw invalid();
      }
      for (let index = 0; index < value.length; index++) {
        const field = Object.getOwnPropertyDescriptor(value, String(index));
        if (!field || !("value" in field)) throw invalid();
        validate(field.value);
      }
    } else {
      if (Object.getPrototypeOf(value) !== Object.prototype) throw invalid();
      for (const key of Reflect.ownKeys(value)) {
        const field = Object.getOwnPropertyDescriptor(value, key)!;
        if (typeof key !== "string" || forbidden.has(key) || !("value" in field) || !field.enumerable) throw invalid();
        validate(field.value);
      }
    }
    visiting.delete(value);
    if (issued) accepted.add(value);
  }
  validate(value);
  const immutable = immutableExactTrialData(value);
  if (immutable !== null && typeof immutable === "object") accepted.add(immutable);
  return immutable;
}
