import { createHash } from "node:crypto";

export type CanonicalScalar = null | boolean | string | number | bigint;

export type CanonicalValue =
  | CanonicalScalar
  | readonly CanonicalValue[]
  | { readonly [key: string]: CanonicalValue };

const frozenJsonCache = new WeakMap<object, { json: string; sha256?: string }>();

/**
 * Hash a protocol-owned semantic projection without depending on object key
 * insertion order. Unsupported values fail closed instead of being silently
 * dropped by JSON.stringify.
 */
export function hashCanonical(value: CanonicalValue): string {
  if (value !== null && typeof value === "object") {
    const cached = frozenJsonCache.get(value);
    if (cached !== undefined) {
      return (cached.sha256 ??= createHash("sha256").update(cached.json).digest("hex"));
    }
  }
  const { json, deepFrozen } = encodeCanonicalJson(value, new Set<object>());
  const digest = createHash("sha256").update(json).digest("hex");
  if (deepFrozen && value !== null && typeof value === "object") {
    frozenJsonCache.set(value, { json, sha256: digest });
  }
  return digest;
}

function encodeCanonicalJson(
  value: unknown,
  seen: Set<object>,
): { json: string; deepFrozen: boolean } {
  if (value === null) return { json: '["null"]', deepFrozen: true };
  if (typeof value === "boolean") return { json: value ? '["boolean",true]' : '["boolean",false]', deepFrozen: true };
  if (typeof value === "string") return { json: `["string",${JSON.stringify(value)}]`, deepFrozen: true };
  if (typeof value === "bigint") return { json: `["bigint",${JSON.stringify(value.toString())}]`, deepFrozen: true };
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("canonical value numbers must be finite");
    }
    return { json: `["number",${JSON.stringify(Object.is(value, -0) ? "-0" : value.toString())}]`, deepFrozen: true };
  }
  if (typeof value !== "object") {
    throw new Error(`unsupported canonical value type: ${typeof value}`);
  }
  const cached = frozenJsonCache.get(value);
  if (cached !== undefined) {
    return { json: cached.json, deepFrozen: true };
  }
  if (seen.has(value)) throw new Error("canonical value must not contain cycles");
  seen.add(value);
  try {
    let allChildrenFrozen = Object.isFrozen(value);
    let json: string;
    if (Array.isArray(value)) {
      assertDenseCanonicalArray(value);
      const parts: string[] = new Array(value.length);
      for (let i = 0; i < value.length; i++) {
        const child = encodeCanonicalJson(value[i], seen);
        parts[i] = child.json;
        if (!child.deepFrozen) allChildrenFrozen = false;
      }
      json = `["array",[${parts.join(",")}]]`;
    } else {
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new Error("canonical value objects must be plain records");
      }
      const record = value as Readonly<Record<string, unknown>>;
      const keys = assertCanonicalRecordKeys(record);
      const parts: string[] = new Array(keys.length);
      for (let i = 0; i < keys.length; i++) {
        const k = keys[i]!;
        const child = encodeCanonicalJson(record[k], seen);
        parts[i] = `[${JSON.stringify(k)},${child.json}]`;
        if (!child.deepFrozen) allChildrenFrozen = false;
      }
      json = `["object",[${parts.join(",")}]]`;
    }
    if (allChildrenFrozen) {
      frozenJsonCache.set(value, { json });
    }
    return { json, deepFrozen: allChildrenFrozen };
  } finally {
    seen.delete(value);
  }
}

function assertDenseCanonicalArray(value: readonly unknown[]): void {
  const own = Reflect.ownKeys(value);
  if (own.length !== value.length + 1) {
    for (let index = 0; index < value.length; index++) {
      if (!Object.hasOwn(value, index)) {
        throw new Error("canonical value arrays must not be sparse");
      }
    }
    throw new Error("canonical value arrays must not have extra properties");
  }
  for (let i = 0; i < own.length; i++) {
    const key = own[i]!;
    if (typeof key !== "string") {
      throw new Error("canonical value arrays must not have extra properties");
    }
    if (key === "length") continue;
    const idx = Number(key);
    if (!Number.isSafeInteger(idx) || idx < 0 || idx >= value.length || String(idx) !== key) {
      throw new Error("canonical value arrays must not have extra properties");
    }
  }
}

function assertCanonicalRecordKeys(
  value: Readonly<Record<string, unknown>>,
): readonly string[] {
  const keys: string[] = [];
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") {
      throw new Error("canonical value objects must not have symbol keys");
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !("value" in descriptor)
    ) {
      throw new Error(
        "canonical value object properties must be enumerable data fields",
      );
    }
    keys.push(key);
  }
  return keys.sort();
}
