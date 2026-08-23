/**
 * Deep-copy a component tree into a distinct mutable object graph so the
 * Family guard can wrap its methods without mutating the shared univ4
 * Family objects. Functions are shared by reference (the guard wraps them
 * again per Family); plain objects/arrays are copied; frozen leaves are
 * copied too (the copy itself is unfrozen).
 */
export function deepGuardCopy<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return value.map((item) => deepGuardCopy(item)) as unknown as T;
  }
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>)) {
    out[key] = deepGuardCopy((value as Record<string, unknown>)[key]);
  }
  return out as T;
}
