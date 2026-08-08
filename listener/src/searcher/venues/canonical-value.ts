import { createHash } from "node:crypto";

export type CanonicalScalar = null | boolean | string | number | bigint;

export type CanonicalValue =
  | CanonicalScalar
  | readonly CanonicalValue[]
  | { readonly [key: string]: CanonicalValue };

/**
 * Hash a protocol-owned semantic projection without depending on object key
 * insertion order. Unsupported values fail closed instead of being silently
 * dropped by JSON.stringify.
 */
export function hashCanonical(value: CanonicalValue): string {
  return createHash("sha256")
    .update(JSON.stringify(encodeCanonical(value, new Set<object>())))
    .digest("hex");
}

type CanonicalEncoding =
  | readonly ["null"]
  | readonly ["boolean", boolean]
  | readonly ["string", string]
  | readonly ["number", string]
  | readonly ["bigint", string]
  | readonly ["array", readonly CanonicalEncoding[]]
  | readonly [
      "object",
      readonly (readonly [string, CanonicalEncoding])[],
    ];

function encodeCanonical(
  value: unknown,
  seen: Set<object>,
): CanonicalEncoding {
  if (value === null) return ["null"];
  if (typeof value === "boolean") return ["boolean", value];
  if (typeof value === "string") return ["string", value];
  if (typeof value === "bigint") return ["bigint", value.toString()];
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("canonical value numbers must be finite");
    }
    return ["number", Object.is(value, -0) ? "-0" : value.toString()];
  }
  if (typeof value !== "object") {
    throw new Error(`unsupported canonical value type: ${typeof value}`);
  }
  if (seen.has(value)) throw new Error("canonical value must not contain cycles");
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      assertDenseCanonicalArray(value);
      return [
        "array",
        value.map((item) => encodeCanonical(item, seen)),
      ];
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error("canonical value objects must be plain records");
    }
    const record = value as Readonly<Record<string, unknown>>;
    const keys = assertCanonicalRecordKeys(record);
    return [
      "object",
      keys.map((key) => [key, encodeCanonical(record[key], seen)]),
    ];
  } finally {
    seen.delete(value);
  }
}

function assertDenseCanonicalArray(value: readonly unknown[]): void {
  for (let index = 0; index < value.length; index++) {
    if (!Object.hasOwn(value, index)) {
      throw new Error("canonical value arrays must not be sparse");
    }
  }
  const expectedKeys = new Set([
    "length",
    ...Array.from({ length: value.length }, (_, index) => String(index)),
  ]);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !expectedKeys.has(key)) {
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
