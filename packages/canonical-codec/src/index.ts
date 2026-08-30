import { createHash } from "node:crypto";
import { types as nodeTypes } from "node:util";

/** JSON values accepted by the Aloha wire format. */
export type CanonicalJsonPrimitive = null | boolean | string | number;
export type CanonicalJson =
  | CanonicalJsonPrimitive
  | readonly CanonicalJson[]
  | { readonly [key: string]: CanonicalJson };
export type CanonicalJsonObject = { readonly [key: string]: CanonicalJson };

export type Hash = `0x${string}`;

/** Resource bounds are part of the canonical wire contract, not a caller hint. */
export const CANONICAL_LIMITS = Object.freeze({
  maxBytes: 1_048_576,
  maxDepth: 64,
  maxArrayItems: 16_384,
  maxObjectProperties: 16_384,
  maxStringCodeUnits: 131_072,
  maxDecimalDigits: 128,
});

export type CanonicalCodecErrorCode =
  | "invalid-type"
  | "invalid-number"
  | "cyclic-value"
  | "invalid-json"
  | "duplicate-key"
  | "non-canonical"
  | "unknown-field"
  | "missing-field"
  | "invalid-field";

export class CanonicalCodecError extends TypeError {
  readonly code: CanonicalCodecErrorCode;
  readonly path: string;

  constructor(
    code: CanonicalCodecErrorCode,
    message: string,
    path = "$",
  ) {
    super(`${message} at ${path}`);
    this.name = "CanonicalCodecError";
    this.code = code;
    this.path = path;
  }
}

function fail(
  code: CanonicalCodecErrorCode,
  message: string,
  path = "$",
): never {
  throw new CanonicalCodecError(code, message, path);
}

function rejectProxy(value: object, path: string): void {
  // util.types.isProxy is a non-trapping brand check. Once a proxy is
  // rejected, ordinary-object inspection below cannot invoke proxy traps.
  if (nodeTypes.isProxy(value)) {
    fail("invalid-type", "Proxy objects are not accepted as object input", path);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  rejectProxy(value, "$" );
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function ownDataProperty(
  value: object,
  key: string,
  path: string,
): PropertyDescriptor {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor || !("value" in descriptor)) {
    fail("invalid-type", "accessor properties are not canonical JSON", path);
  }
  return descriptor;
}

function validateNumber(value: number, path: string): void {
  if (!Number.isFinite(value) || Object.is(value, -0)) {
    fail("invalid-number", "JSON numbers must be finite and not negative zero", path);
  }
  if (Math.abs(value) > Number.MAX_SAFE_INTEGER) {
    fail("invalid-number", "number magnitude exceeds safe precision", path);
  }
  // Fractional values are representable as JSON numbers. An integral value
  // must additionally be a safe integer so no two wire values collapse to the
  // same IEEE-754 value during decode.
  if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
    fail("invalid-number", "unsafe integer is not allowed", path);
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) {
    fail("invalid-number", "number cannot be encoded", path);
  }
  const digits = encoded.replace(/[^0-9]/g, "").length;
  if (digits > CANONICAL_LIMITS.maxDecimalDigits) {
    fail("invalid-number", "decimal representation exceeds policy", path);
  }
}

function rejectUnpairedSurrogates(value: string, path: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        fail("invalid-type", "unpaired UTF-16 high surrogate is not canonical", path);
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      fail("invalid-type", "unpaired UTF-16 low surrogate is not canonical", path);
    }
  }
}

interface CanonicalBudget {
  bytes: number;
}

function chargeBudget(budget: CanonicalBudget, bytes: number, path: string): void {
  budget.bytes += bytes;
  if (budget.bytes > CANONICAL_LIMITS.maxBytes) {
    fail("invalid-type", "canonical JSON exceeds byte policy", path);
  }
}

function validateCanonicalValue(
  value: unknown,
  path: string,
  active: Set<object>,
  depth = 0,
  budget: CanonicalBudget = { bytes: 0 },
  visited?: WeakSet<object>,
): asserts value is CanonicalJson {
  if (depth > CANONICAL_LIMITS.maxDepth) {
    fail("invalid-type", "JSON nesting exceeds policy", path);
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    if (typeof value === "string" && value.length > CANONICAL_LIMITS.maxStringCodeUnits) {
      fail("invalid-type", "JSON string exceeds policy", path);
    }
    if (typeof value === "string") rejectUnpairedSurrogates(value, path);
    chargeBudget(
      budget,
      value === null
        ? 4
        : typeof value === "boolean"
          ? (value ? 4 : 5)
          : new TextEncoder().encode(JSON.stringify(value)).length,
      path,
    );
    return;
  }
  if (typeof value === "number") {
    validateNumber(value, path);
    chargeBudget(budget, JSON.stringify(value).length, path);
    return;
  }
  if (typeof value !== "object") {
    fail("invalid-type", `unsupported JSON value type ${typeof value}`, path);
  }
  rejectProxy(value, path);
  if (active.has(value)) {
    fail("cyclic-value", "cyclic JSON value", path);
  }
  active.add(value);
  try {
    if (Array.isArray(value)) {
      if (value.length > CANONICAL_LIMITS.maxArrayItems) {
        fail("invalid-type", "array exceeds policy", path);
      }
      const ownKeys = Reflect.ownKeys(value);
      chargeBudget(budget, 1, path);
      for (const key of ownKeys) {
        if (typeof key === "symbol") {
          fail("invalid-type", "symbol properties are not canonical JSON", path);
        }
        if (key === "length") {
          continue;
        }
        if (!/^\d+$/.test(key) || Number(key) >= value.length) {
          fail("invalid-type", "arrays may not have extra properties", `${path}.${key}`);
        }
      }
      for (let index = 0; index < value.length; index += 1) {
        const itemPath = `${path}[${index}]`;
        if (!Object.prototype.hasOwnProperty.call(value, index)) {
          fail("invalid-type", "array holes are not canonical JSON", itemPath);
        }
        const descriptor = ownDataProperty(value, String(index), itemPath);
        if (!descriptor.enumerable) {
          fail("invalid-type", "non-enumerable array properties are not canonical JSON", itemPath);
        }
        if (index > 0) chargeBudget(budget, 1, itemPath);
        validateCanonicalValue(descriptor.value, itemPath, active, depth + 1, budget, visited);
      }
      chargeBudget(budget, 1, path);
      visited?.add(value);
      return;
    }
    if (!isPlainObject(value)) {
      fail("invalid-type", "only plain objects are canonical JSON", path);
    }
    const keys = Reflect.ownKeys(value);
    if (keys.length > CANONICAL_LIMITS.maxObjectProperties) {
      fail("invalid-type", "object exceeds property policy", path);
    }
    chargeBudget(budget, 1, path);
    let keyIndex = 0;
    for (const key of keys) {
      if (typeof key === "symbol") {
        fail("invalid-type", "symbol properties are not canonical JSON", path);
      }
      if (key.length > CANONICAL_LIMITS.maxStringCodeUnits) {
        fail("invalid-type", "object key exceeds string policy", `${path}.${key}`);
      }
      const itemPath = `${path}.${key}`;
      const descriptor = ownDataProperty(value, key, itemPath);
      if (!descriptor.enumerable) {
        fail("invalid-type", "non-enumerable properties are not canonical JSON", itemPath);
      }
      chargeBudget(
        budget,
        new TextEncoder().encode(JSON.stringify(key)).length + 1,
        itemPath,
      );
      if (keyIndex > 0) chargeBudget(budget, 1, itemPath);
      validateCanonicalValue(descriptor.value, itemPath, active, depth + 1, budget, visited);
      keyIndex += 1;
    }
    chargeBudget(budget, 1, path);
    visited?.add(value);
  } finally {
    active.delete(value);
  }
}

export function isCanonicalJson(value: unknown): value is CanonicalJson {
  try {
    validateCanonicalValue(value, "$", new Set<object>());
    return true;
  } catch (error) {
    if (error instanceof CanonicalCodecError) {
      return false;
    }
    throw error;
  }
}

function canonicalStringify(value: CanonicalJson, path: string): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    validateNumber(value, path);
    const encoded = JSON.stringify(value);
    if (encoded === undefined) {
      fail("invalid-number", "number cannot be encoded", path);
    }
    return encoded;
  }
  if (Array.isArray(value)) {
    return `[${value
      .map((item, index) => canonicalStringify(item, `${path}[${index}]`))
      .join(",")}]`;
  }
  const keys = Object.keys(value).sort();
  return `{${keys
    .map((key) => {
      const descriptor = ownDataProperty(value, key, `${path}.${key}`);
      return `${JSON.stringify(key)}:${canonicalStringify(
        descriptor.value,
        `${path}.${key}`,
      )}`;
    })
    .join(",")}}`;
}

export function encodeCanonicalJson(value: unknown): string {
  validateCanonicalValue(value, "$", new Set<object>());
  const result = canonicalStringify(value, "$");
  if (new TextEncoder().encode(result).length > CANONICAL_LIMITS.maxBytes) {
    fail("invalid-type", "canonical JSON exceeds byte policy", "$" );
  }
  return result;
}

export function encodeCanonicalBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(encodeCanonicalJson(value));
}

class StrictJsonParser {
  private readonly text: string;
  private index = 0;

  constructor(text: string) {
    this.text = text;
    if (new TextEncoder().encode(text).length > CANONICAL_LIMITS.maxBytes) {
      fail("invalid-json", "JSON input exceeds byte policy", "$" );
    }
  }

  parse(): CanonicalJson {
    this.skipWhitespace();
    const value = this.parseValue("$", 0);
    this.skipWhitespace();
    if (this.index !== this.text.length) {
      fail("invalid-json", "trailing data after JSON value", "$" );
    }
    return value;
  }

  private current(): string | undefined {
    return this.text[this.index];
  }

  private skipWhitespace(): void {
    while (
      this.current() === " " ||
      this.current() === "\t" ||
      this.current() === "\n" ||
      this.current() === "\r"
    ) {
      this.index += 1;
    }
  }

  private parseValue(path: string, depth: number): CanonicalJson {
    if (depth > CANONICAL_LIMITS.maxDepth) {
      fail("invalid-json", "JSON nesting exceeds policy", path);
    }
    const current = this.current();
    if (current === '"') return this.parseString(path);
    if (current === "{") return this.parseObject(path, depth);
    if (current === "[") return this.parseArray(path, depth);
    if (current === "t" && this.consumeLiteral("true")) return true;
    if (current === "f" && this.consumeLiteral("false")) return false;
    if (current === "n" && this.consumeLiteral("null")) return null;
    return this.parseNumber(path);
  }

  private consumeLiteral(literal: string): boolean {
    if (this.text.slice(this.index, this.index + literal.length) !== literal) {
      return false;
    }
    this.index += literal.length;
    return true;
  }

  private parseString(path: string): string {
    const start = this.index;
    this.index += 1;
    while (this.index < this.text.length) {
      const current = this.text[this.index];
      if (current === '"') {
        this.index += 1;
        const encoded = this.text.slice(start, this.index);
        try {
          const value = JSON.parse(encoded) as string;
          if (value.length > CANONICAL_LIMITS.maxStringCodeUnits) {
            fail("invalid-json", "JSON string exceeds policy", path);
          }
          rejectUnpairedSurrogates(value, path);
          return value;
        } catch {
          fail("invalid-json", "invalid JSON string", path);
        }
      }
      if (current === "\\") {
        this.index += 1;
        if (this.index >= this.text.length) {
          fail("invalid-json", "unterminated JSON escape", path);
        }
        this.index += 1;
        continue;
      }
      if (current.charCodeAt(0) < 0x20) {
        fail("invalid-json", "unescaped control character in string", path);
      }
      this.index += 1;
    }
    fail("invalid-json", "unterminated JSON string", path);
  }

  private parseNumber(path: string): number {
    const match = this.text
      .slice(this.index)
      .match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/);
    if (!match) {
      fail("invalid-json", "expected JSON value", path);
    }
    const raw = match[0];
    if (raw.replace(/[^0-9]/g, "").length > CANONICAL_LIMITS.maxDecimalDigits) {
      fail("invalid-number", "decimal representation exceeds policy", path);
    }
    const value = Number(raw);
    this.index += raw.length;
    validateNumber(value, path);
    return value;
  }

  private parseArray(path: string, depth: number): readonly CanonicalJson[] {
    this.index += 1;
    this.skipWhitespace();
    const result: CanonicalJson[] = [];
    if (this.current() === "]") {
      this.index += 1;
      return result;
    }
    while (true) {
      if (result.length >= CANONICAL_LIMITS.maxArrayItems) {
        fail("invalid-json", "array exceeds policy", path);
      }
      result.push(this.parseValue(`${path}[${result.length}]`, depth + 1));
      this.skipWhitespace();
      if (this.current() === ",") {
        this.index += 1;
        this.skipWhitespace();
        if (this.current() === "]") {
          fail("invalid-json", "trailing comma in array", path);
        }
        continue;
      }
      if (this.current() === "]") {
        this.index += 1;
        return result;
      }
      fail("invalid-json", "expected comma or closing array bracket", path);
    }
  }

  private parseObject(path: string, depth: number): CanonicalJsonObject {
    this.index += 1;
    this.skipWhitespace();
    const result: Record<string, CanonicalJson> = {};
    const seen = new Set<string>();
    if (this.current() === "}") {
      this.index += 1;
      return result;
    }
    while (true) {
      if (seen.size >= CANONICAL_LIMITS.maxObjectProperties) {
        fail("invalid-json", "object exceeds policy", path);
      }
      if (this.current() !== '"') {
        fail("invalid-json", "object key must be a JSON string", path);
      }
      const key = this.parseString(`${path}.*`);
      if (seen.has(key)) {
        fail("duplicate-key", `duplicate object key ${JSON.stringify(key)}`, `${path}.${key}`);
      }
      seen.add(key);
      this.skipWhitespace();
      if (this.current() !== ":") {
        fail("invalid-json", "expected colon after object key", `${path}.${key}`);
      }
      this.index += 1;
      this.skipWhitespace();
      const parsed = this.parseValue(`${path}.${key}`, depth + 1);
      Object.defineProperty(result, key, {
        configurable: true,
        enumerable: true,
        value: parsed,
        writable: true,
      });
      this.skipWhitespace();
      if (this.current() === ",") {
        this.index += 1;
        this.skipWhitespace();
        if (this.current() === "}") {
          fail("invalid-json", "trailing comma in object", path);
        }
        continue;
      }
      if (this.current() === "}") {
        this.index += 1;
        return result;
      }
      fail("invalid-json", "expected comma or closing object brace", path);
    }
  }
}

function asText(input: string | Uint8Array): string {
  if (typeof input === "string") return input;
  rejectProxy(input, "$" );
  if (
    !ArrayBuffer.isView(input) ||
    Object.getPrototypeOf(input) !== Uint8Array.prototype ||
    Object.getOwnPropertyDescriptor(input, "length") !== undefined
  ) {
    fail(
      "invalid-type",
      "binary input must be a native Uint8Array without a shadowed length",
      "$",
    );
  }
  if (input.length > CANONICAL_LIMITS.maxBytes) {
    fail("invalid-json", "JSON input exceeds byte policy", "$" );
  }
  if (input.length >= 3 && input[0] === 0xef && input[1] === 0xbb && input[2] === 0xbf) {
    fail("non-canonical", "UTF-8 BOM is not canonical JSON", "$" );
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(input);
  } catch {
    fail("invalid-json", "input is not valid UTF-8", "$" );
  }
}

/** Parse JSON while retaining duplicate-key detection, but do not require canonical ordering. */
export function decodeJson(input: string | Uint8Array): CanonicalJson {
  return deepFreeze(new StrictJsonParser(asText(input)).parse());
}

/** Decode only canonical bytes: no whitespace, alternate number forms, or unsorted keys. */
export function decodeCanonicalJson(
  input: string | Uint8Array,
): CanonicalJson {
  const text = asText(input);
  const value = decodeJson(text);
  if (encodeCanonicalJson(value) !== text) {
    fail("non-canonical", "JSON bytes are not canonical", "$" );
  }
  return value;
}

export const decodeCanonicalBytes = decodeCanonicalJson;

export function assertExactCanonicalBytes(
  value: unknown,
  bytes: Uint8Array,
): void {
  const expected = encodeCanonicalBytes(value);
  if (expected.length !== bytes.length) {
    fail("non-canonical", "bytes do not exactly encode the value", "$" );
  }
  for (let index = 0; index < expected.length; index += 1) {
    if (expected[index] !== bytes[index]) {
      fail("non-canonical", "bytes do not exactly encode the value", "$" );
    }
  }
}

export function deepFreeze<T>(value: T, seen = new Set<object>()): T {
  if (value === null || typeof value !== "object") return value;
  rejectProxy(value, "$" );
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
    fail("invalid-type", "typed arrays and ArrayBuffer are not JSON values", "$");
  }
  if (seen.has(value)) return value;
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor && "value" in descriptor) {
      deepFreeze(descriptor.value, seen);
    }
  }
  Object.freeze(value);
  return value;
}

export type ExactFieldDecoder<T = unknown> = (
  value: unknown,
  path: string,
) => T;

/** Executable schema authority used by the frozen spec packages. */
export interface CodecSchema<T> {
  readonly descriptor: CanonicalJsonObject;
  readonly decode: (value: unknown, path?: string) => T;
  readonly normalize: (value: unknown, path?: string) => T;
}

export type Infer<S extends CodecSchema<unknown>> = S extends CodecSchema<infer T>
  ? T
  : never;

export function defineSchema<T>(
  descriptor: CanonicalJsonObject,
  decoder: ExactFieldDecoder<T>,
): CodecSchema<T> {
  const schema: CodecSchema<T> = {
    descriptor: deepFreeze(descriptor),
    decode: (value, path = "$") => decoder(value, path),
    normalize: (value, path = "$") => deepFreeze(decoder(value, path)),
  };
  return Object.freeze(schema);
}

export function refineSchema<S extends CodecSchema<any>>(
  base: S,
  refinementId: string,
  refinementSpecDigest: Hash,
  refinement: (value: Infer<S>, path: string) => Infer<S>,
): CodecSchema<Infer<S>> {
  assertHash(refinementSpecDigest, "$.refinementSpecDigest");
  return defineSchema(
    {
      kind: "refined",
      refinementId,
      refinementSpecDigest,
      base: base.descriptor,
    },
    (value, path = "$") => refinement(base.decode(value, path), path),
  );
}

export type SchemaFields = Readonly<Record<string, CodecSchema<any>>>;
export type InferFields<F extends SchemaFields> = {
  readonly [K in keyof F]: Infer<F[K]>;
};

interface CanonicalInputGuardContext {
  readonly visited: WeakSet<object>;
}

let canonicalInputGuardContext: CanonicalInputGuardContext | null = null;

function decodeGuardedContainer<T>(
  value: unknown,
  path: string,
  decode: () => T,
): T {
  const context = canonicalInputGuardContext;
  const ownsGuard = context === null;
  if (ownsGuard) {
    const visited = new WeakSet<object>();
    canonicalInputGuardContext = { visited };
  }
  try {
    if (ownsGuard) {
      validateCanonicalValue(
        value,
        path,
        new Set<object>(),
        0,
        { bytes: 0 },
        canonicalInputGuardContext!.visited,
      );
    } else if (
      value !== null &&
      typeof value === "object" &&
      !context.visited.has(value)
    ) {
      // Refinements may re-enter a schema with a separately-created object. It
      // is not covered by the outer container's traversal and must receive its
      // own canonical validation before the trusted refinement sees it.
      validateCanonicalValue(
        value,
        path,
        new Set<object>(),
        0,
        { bytes: 0 },
        context.visited,
      );
    }
    return decode();
  } finally {
    if (ownsGuard) canonicalInputGuardContext = null;
  }
}

export function objectSchema<F extends SchemaFields>(
  fields: F,
): CodecSchema<InferFields<F>> {
  const fieldDecoders: Record<string, ExactFieldDecoder<unknown>> = {};
  const descriptors: Record<string, CanonicalJson> = {};
  for (const [key, schema] of Object.entries(fields)) {
    fieldDecoders[key] = (value, path) => schema.decode(value, path);
    descriptors[key] = schema.descriptor;
  }
  return defineSchema(
    { kind: "object", fields: descriptors },
    (value, path = "$") =>
      decodeGuardedContainer(
        value,
        path,
        () => decodeExactObject(value, fieldDecoders, path) as InferFields<F>,
      ),
  );
}

export function arraySchema<S extends CodecSchema<any>>(
  item: S,
): CodecSchema<readonly Infer<S>[]> {
  return defineSchema<readonly Infer<S>[]>(
    { kind: "array", item: item.descriptor },
    (value, path = "$") =>
      decodeGuardedContainer(
        value,
        path,
        () => fieldArray(value, (entry, entryPath) => item.decode(entry, entryPath), path),
      ) as readonly Infer<S>[],
  );
}

export function nullableSchema<S extends CodecSchema<any>>(
  schema: S,
): CodecSchema<Infer<S> | null> {
  return defineSchema<Infer<S> | null>(
    { kind: "nullable", inner: schema.descriptor },
    (value, path = "$") => value === null ? null : schema.decode(value, path),
  );
}

export function literalSchema<T extends string | number | boolean | null>(
  value: T,
): CodecSchema<T> {
  return defineSchema(
    { kind: "literal", value },
    (entry, path = "$") => {
      if (entry !== value) {
        fail("invalid-field", `expected literal ${JSON.stringify(value)}`, path);
      }
      return value;
    },
  );
}

export function enumSchema<const T extends readonly (string | number)[]>(
  values: T,
): CodecSchema<T[number]> {
  const allowed = new Set(values);
  return defineSchema(
    { kind: "enum", values: [...values] },
    (entry, path = "$") => {
      if ((typeof entry !== "string" && typeof entry !== "number") || !allowed.has(entry)) {
        fail("invalid-field", "value is outside enum", path);
      }
      return entry as T[number];
    },
  );
}

export const stringSchema = defineSchema(
  { kind: "string" },
  (value, path) => fieldString(value, path),
);
export const nonEmptyStringSchema = defineSchema(
  { kind: "non-empty-string" },
  (value, path) => assertNonEmptyString(value, path),
);
export const hashSchema = defineSchema(
  { kind: "hash" },
  (value, path) => assertHash(value, path),
);
export const decimalStringSchema = defineSchema(
  { kind: "decimal-string" },
  (value, path) => assertDecimalString(value, path),
);
export const semVerSchema = defineSchema(
  { kind: "semver" },
  (value, path) => assertSemVer(value, path),
);
export const gitSha40Schema = defineSchema(
  { kind: "git-sha40" },
  (value, path) => assertGitSha40(value, path),
);
export const canonicalJsonSchema = defineSchema(
  { kind: "canonical-json" },
  (value, path) => fieldCanonicalJson(value, path),
);
export const canonicalObjectSchema = defineSchema(
  { kind: "canonical-object" },
  (value, path) => fieldCanonicalObject(value, path),
);

export function assertPlainObject(
  value: unknown,
  path = "$",
): asserts value is Record<string, unknown> {
  if (!isPlainObject(value)) {
    fail("invalid-field", "expected a plain object", path);
  }
}

/** Reject array proxies before any reflective array inspection can invoke traps. */
export function assertConcreteArray(
  value: unknown,
  path = "$",
): asserts value is unknown[] {
  if (!Array.isArray(value)) {
    fail("invalid-field", "expected an array", path);
  }
  rejectProxy(value, path);
}

/** Read a union discriminator without invoking accessors or proxy traps. */
export function readOwnEnumerableDataProperty(
  value: unknown,
  key: string,
  path = "$",
): unknown {
  assertPlainObject(value, path);
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor || !("value" in descriptor)) {
    fail("invalid-field", `expected own data property ${JSON.stringify(key)}`, `${path}.${key}`);
  }
  if (!descriptor.enumerable) {
    fail("invalid-field", `expected enumerable property ${JSON.stringify(key)}`, `${path}.${key}`);
  }
  return descriptor.value;
}

export function assertExactKeys(
  value: unknown,
  keys: readonly string[],
  path = "$",
): asserts value is Record<string, unknown> {
  assertPlainObject(value, path);
  const expected = new Set(keys);
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length > CANONICAL_LIMITS.maxObjectProperties) {
    fail("invalid-field", "object exceeds policy", path);
  }
  for (const key of ownKeys) {
    if (typeof key === "symbol") {
      fail("unknown-field", "symbol field is not allowed", path);
    }
    if (key.length > CANONICAL_LIMITS.maxStringCodeUnits) {
      fail("invalid-field", "object key exceeds policy", `${path}.${key}`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable) {
      fail("unknown-field", `non-enumerable field ${JSON.stringify(key)} is not allowed`, `${path}.${key}`);
    }
    if (!expected.has(key)) {
      fail("unknown-field", `unknown field ${JSON.stringify(key)}`, `${path}.${key}`);
    }
  }
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      fail("missing-field", `missing field ${JSON.stringify(key)}`, `${path}.${key}`);
    }
  }
}

export function decodeExactObject<T extends object>(
  value: unknown,
  fields: { readonly [K in keyof T]: ExactFieldDecoder<T[K]> },
  path = "$",
): T {
  const keys = Object.keys(fields);
  assertExactKeys(value, keys, path);
  const output: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor)) {
      fail("invalid-field", "accessor fields are not accepted", `${path}.${key}`);
    }
    const decoder = (fields as Record<string, ExactFieldDecoder<unknown>>)[key];
    Object.defineProperty(output, key, {
      configurable: true,
      enumerable: true,
      value: decoder(descriptor.value, `${path}.${key}`),
      writable: true,
    });
  }
  return deepFreeze(output as T);
}

export function fieldString(value: unknown, path: string): string {
  if (typeof value !== "string") fail("invalid-field", "expected string", path);
  if (value.length > CANONICAL_LIMITS.maxStringCodeUnits) {
    fail("invalid-field", "string exceeds policy", path);
  }
  rejectUnpairedSurrogates(value, path);
  return value;
}

export function fieldBoolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") fail("invalid-field", "expected boolean", path);
  return value;
}

export function fieldNull(value: unknown, path: string): null {
  if (value !== null) fail("invalid-field", "expected null", path);
  return null;
}

export function fieldNumber(value: unknown, path: string): number {
  if (typeof value !== "number") fail("invalid-field", "expected number", path);
  validateNumber(value, path);
  return value;
}

export function fieldArray<T>(
  value: unknown,
  item: ExactFieldDecoder<T>,
  path: string,
): readonly T[] {
  if (!Array.isArray(value)) fail("invalid-field", "expected array", path);
  rejectProxy(value, path);
  if (value.length > CANONICAL_LIMITS.maxArrayItems) {
    fail("invalid-field", "array exceeds policy", path);
  }
  const keys = Reflect.ownKeys(value);
  for (const key of keys) {
    if (typeof key === "symbol") {
      fail("invalid-field", "symbol array property is not allowed", path);
    }
    if (key === "length") continue;
    if (!/^\d+$/.test(key) || Number(key) >= value.length) {
      fail("invalid-field", "array has extra property", `${path}.${key}`);
    }
  }
  const result: T[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const itemPath = `${path}[${index}]`;
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      fail("invalid-field", "sparse or accessor array item is not allowed", itemPath);
    }
    result.push(item(descriptor.value, itemPath));
  }
  return deepFreeze(result);
}

export function fieldCanonicalJson(
  value: unknown,
  path: string,
): CanonicalJson {
  if (
    value !== null &&
    typeof value === "object" &&
    canonicalInputGuardContext?.visited.has(value)
  ) {
    return value as CanonicalJson;
  }
  validateCanonicalValue(value, path, new Set<object>());
  return value;
}

export function fieldCanonicalObject(
  value: unknown,
  path: string,
): CanonicalJsonObject {
  if (
    value !== null &&
    typeof value === "object" &&
    canonicalInputGuardContext?.visited.has(value)
  ) {
    if (!isPlainObject(value)) {
      fail("invalid-field", "expected canonical JSON object", path);
    }
    return value as CanonicalJsonObject;
  }
  validateCanonicalValue(value, path, new Set<object>());
  if (!isPlainObject(value)) {
    fail("invalid-field", "expected canonical JSON object", path);
  }
  return value as CanonicalJsonObject;
}

export function sha256Hex(value: string | Uint8Array): Hash {
  const digest = createHash("sha256").update(value).digest("hex");
  return `0x${digest}` as Hash;
}

/** Hash a canonical payload with an explicit, NUL-delimited domain separator. */
export function hashDomain(domain: string, payload: unknown): Hash {
  const domainBytes = new TextEncoder().encode(domain);
  const payloadBytes = encodeCanonicalBytes(payload);
  const joined = new Uint8Array(domainBytes.length + 1 + payloadBytes.length);
  joined.set(domainBytes, 0);
  joined[domainBytes.length] = 0;
  joined.set(payloadBytes, domainBytes.length + 1);
  return sha256Hex(joined);
}

export function hashDomainBytes(domain: string, payload: Uint8Array): Hash {
  const domainBytes = new TextEncoder().encode(domain);
  const joined = new Uint8Array(domainBytes.length + 1 + payload.length);
  joined.set(domainBytes, 0);
  joined[domainBytes.length] = 0;
  joined.set(payload, domainBytes.length + 1);
  return sha256Hex(joined);
}

/**
 * Hash a large canonical partition without ever encoding the entire set as one
 * JSON value. Callers own canonical ordering; this function binds count, page
 * boundaries, every leaf value, and the requested domain.
 */
export function hashCanonicalPartition(
  domain: string,
  values: readonly unknown[],
  pageSize = 128,
): Hash {
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 1_024) {
    throw new RangeError("canonical partition pageSize must be 1..1024");
  }
  const leafHashes = values.map((value, index) => hashDomain(`${domain}/leaf/v1`, { index: String(index), value }));
  const pageHashes: Hash[] = [];
  for (let offset = 0; offset < leafHashes.length; offset += pageSize) {
    pageHashes.push(hashDomain(`${domain}/page/v1`, {
      pageIndex: String(pageHashes.length),
      firstIndex: String(offset),
      leafHashes: leafHashes.slice(offset, offset + pageSize),
    }));
  }
  return hashDomain(`${domain}/root/v1`, {
    count: String(values.length),
    pageSize: String(pageSize),
    pageHashes,
  });
}

export interface SchemaManifest<T> {
  readonly id: string;
  readonly version: string;
  readonly schemaHash: Hash;
  readonly schema: CodecSchema<T>;
}

export function defineSchemaManifest<T>(
  id: string,
  version: string,
  schema: CodecSchema<T>,
): SchemaManifest<T> {
  const schemaHash = hashDomain("aloha/schema-definition/v1", {
    id,
    version,
    descriptor: schema.descriptor,
  });
  return Object.freeze({ id, version, schemaHash, schema });
}

export function assertHash(value: unknown, path = "$"): Hash {
  if (
    typeof value !== "string" ||
    !/^0x[0-9a-f]{64}$/.test(value)
  ) {
    fail("invalid-field", "expected lowercase 32-byte 0x hash", path);
  }
  return value as Hash;
}

export function assertNonEmptyString(value: unknown, path = "$"): string {
  if (typeof value !== "string" || value.length === 0) {
    fail("invalid-field", "expected non-empty string", path);
  }
  if (value.length > CANONICAL_LIMITS.maxStringCodeUnits) {
    fail("invalid-field", "string exceeds policy", path);
  }
  rejectUnpairedSurrogates(value, path);
  if ([...value].some((character) => character.charCodeAt(0) < 0x20)) {
    fail("invalid-field", "control characters are not allowed", path);
  }
  return value;
}

export function assertDecimalString(value: unknown, path = "$"): string {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d*)$/.test(value)) {
    fail("invalid-field", "expected canonical unsigned decimal string", path);
  }
  if (value.length > CANONICAL_LIMITS.maxDecimalDigits) {
    fail("invalid-field", "decimal exceeds policy", path);
  }
  return value;
}

export function assertSemVer(value: unknown, path = "$"): string {
  if (
    typeof value !== "string" ||
    !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(
      value,
    )
  ) {
    fail("invalid-field", "expected canonical semantic version", path);
  }
  if (value.length > CANONICAL_LIMITS.maxStringCodeUnits) {
    fail("invalid-field", "semantic version exceeds policy", path);
  }
  return value;
}

export function assertGitSha40(value: unknown, path = "$"): string {
  if (typeof value !== "string" || !/^[0-9a-f]{40}$/.test(value)) {
    fail("invalid-field", "expected lowercase 40-hex git SHA", path);
  }
  return value;
}
