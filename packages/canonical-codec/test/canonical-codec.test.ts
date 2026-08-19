import assert from "node:assert/strict";
import test from "node:test";
import {
  CanonicalCodecError,
  decodeCanonicalJson,
  decodeJson,
  deepFreeze,
  defineSchemaManifest,
  arraySchema,
  canonicalJsonSchema,
  canonicalObjectSchema,
  decimalStringSchema,
  encodeCanonicalJson,
  isCanonicalJson,
  hashDomain,
  objectSchema,
  refineSchema,
  stringSchema,
} from "../src/index.ts";

const refinementSpecDigest = (id: string) => hashDomain(
  "aloha/schema-refinement-spec/v1",
  { id, version: "1.0.0" },
);

const errorCode = (code: CanonicalCodecError["code"]) => (error: unknown) =>
  error instanceof CanonicalCodecError && error.code === code;

test("canonical JSON sorts keys and round-trips exact bytes", () => {
  const encoded = encodeCanonicalJson({ z: [true, null], a: "value", m: 2 });
  assert.equal(encoded, '{"a":"value","m":2,"z":[true,null]}');
  assert.deepEqual(decodeCanonicalJson(encoded), {
    a: "value",
    m: 2,
    z: [true, null],
  });
  assert.equal(encodeCanonicalJson(decodeCanonicalJson(encoded)), encoded);
});

test("strict parser rejects duplicate keys and non-canonical forms", () => {
  assert.throws(() => decodeJson('{"x":1,"x":2}'), errorCode("duplicate-key"));
  assert.throws(() => decodeCanonicalJson('{"x":1.0}'), errorCode("non-canonical"));
  assert.throws(() => decodeCanonicalJson('{"x": 1}'), errorCode("non-canonical"));
  assert.throws(
    () => decodeCanonicalJson(new Uint8Array([0xef, 0xbb, 0xbf, 0x7b, 0x7d])),
    errorCode("non-canonical"),
  );
});

test("unpaired UTF-16 surrogates are rejected while pairs remain valid", () => {
  assert.throws(() => encodeCanonicalJson("\ud800"), errorCode("invalid-type"));
  assert.throws(() => encodeCanonicalJson("\udfff"), errorCode("invalid-type"));
  assert.throws(() => decodeCanonicalJson('"\\ud800"'));
  assert.throws(
    () => objectSchema({ value: stringSchema }).decode({ value: "\ud800" }),
    errorCode("invalid-type"),
  );
  assert.throws(() => stringSchema.decode("\udfff"), errorCode("invalid-type"));

  const pair = "\ud83d\ude00";
  const encoded = encodeCanonicalJson(pair);
  assert.equal(encoded, '"😀"');
  assert.equal(decodeCanonicalJson(encoded), pair);
});

test("unsafe integer and fractional precision are rejected", () => {
  assert.throws(
    () => encodeCanonicalJson({ value: Number.MAX_SAFE_INTEGER + 1 }),
    errorCode("invalid-number"),
  );
  assert.throws(
    () => encodeCanonicalJson({ value: 9007199254740991.5 }),
    errorCode("invalid-number"),
  );
  assert.throws(
    () => decodeJson('{"value":9007199254740992}'),
    errorCode("invalid-number"),
  );
  assert.equal(encodeCanonicalJson({ value: 0.125 }), '{"value":0.125}');
});

test("accessors, prototypes, typed arrays, holes, and cycles are not JSON", () => {
  const accessor: Record<string, unknown> = {};
  Object.defineProperty(accessor, "x", {
    enumerable: true,
    get: () => 1,
  });
  assert.throws(() => encodeCanonicalJson(accessor), errorCode("invalid-type"));
  const hidden: Record<string, unknown> = { visible: true };
  Object.defineProperty(hidden, "hidden", { enumerable: false, value: true });
  assert.throws(() => encodeCanonicalJson(hidden), errorCode("invalid-type"));
  const symbolKey = Symbol("hidden");
  const symbolValue: Record<string | symbol, unknown> = { visible: true };
  symbolValue[symbolKey] = true;
  assert.throws(() => encodeCanonicalJson(symbolValue), errorCode("invalid-type"));

  class NonPlain {
    readonly value = 1;
  }
  assert.throws(() => encodeCanonicalJson(new NonPlain()), errorCode("invalid-type"));
  assert.throws(() => encodeCanonicalJson(new Uint8Array([1])), errorCode("invalid-type"));
  assert.throws(() => deepFreeze(new Uint8Array([1])), errorCode("invalid-type"));

  const hole = [] as unknown[];
  hole.length = 1;
  assert.throws(() => encodeCanonicalJson(hole), errorCode("invalid-type"));

  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  assert.throws(() => encodeCanonicalJson(cycle), errorCode("cyclic-value"));
  assert.equal(isCanonicalJson({ ok: true }), true);
});

test("object-input guards do not invoke getters or proxy traps", () => {
  let getterHits = 0;
  const getterObject: Record<string, unknown> = {};
  Object.defineProperty(getterObject, "value", {
    enumerable: true,
    get: () => {
      getterHits += 1;
      return "unexpected";
    },
  });
  assert.throws(() => encodeCanonicalJson(getterObject));
  assert.equal(getterHits, 0);
  assert.throws(() => objectSchema({ value: stringSchema }).decode(getterObject));
  assert.equal(getterHits, 0);

  let proxyTrapHits = 0;
  const proxy = new Proxy({ value: "unexpected" }, {
    get: () => {
      proxyTrapHits += 1;
      return "unexpected";
    },
    ownKeys: () => {
      proxyTrapHits += 1;
      return ["value"];
    },
  });
  assert.throws(() => encodeCanonicalJson(proxy));
  assert.equal(proxyTrapHits, 0);

  let arrayGetterHits = 0;
  const array: unknown[] = [];
  Object.defineProperty(array, "0", {
    enumerable: true,
    configurable: true,
    get: () => {
      arrayGetterHits += 1;
      return "unexpected";
    },
  });
  array.length = 1;
  assert.throws(() => arraySchema(stringSchema).decode(array));
  assert.equal(arrayGetterHits, 0);
  assert.throws(() => decimalStringSchema.decode("9".repeat(1_000_000)));

  const guardedRefinement = objectSchema({
    value: refineSchema(
      stringSchema,
      "test.unrelated-object.v1",
      refinementSpecDigest("test.unrelated-object.v1"),
      () => {
      objectSchema({ value: stringSchema }).decode({ value: "x".repeat(131_073) });
      return "ok";
      },
    ),
  });
  assert.throws(() => guardedRefinement.decode({ value: "ok" }), errorCode("invalid-type"));
});

test("a failed outer guard cannot leak trusted visited state into later decodes", () => {
  let getterHits = 0;
  const nested: Record<string, unknown> = {};
  Object.defineProperty(nested, "value", {
    enumerable: true,
    get: () => {
      getterHits += 1;
      return "unexpected";
    },
  });

  assert.throws(
    () => objectSchema({ nested: canonicalJsonSchema }).decode({ nested }),
    errorCode("invalid-type"),
  );
  assert.throws(() => canonicalJsonSchema.decode(nested), errorCode("invalid-type"));
  assert.equal(getterHits, 0);
});

test("a refinement cannot catch a failed nested guard and reuse partial visited state", () => {
  let getterHits = 0;
  const nested: Record<string, unknown> = {};
  Object.defineProperty(nested, "value", {
    enumerable: true,
    get: () => {
      getterHits += 1;
      return "unexpected";
    },
  });
  const catchingRefinement = refineSchema(
    stringSchema,
    "test.caught-nested-guard.v1",
    refinementSpecDigest("test.caught-nested-guard.v1"),
    (value) => {
      assert.throws(
        () => objectSchema({ nested: canonicalJsonSchema }).decode({ nested }),
        errorCode("invalid-type"),
      );
      assert.throws(() => canonicalJsonSchema.decode(nested), errorCode("invalid-type"));
      return value;
    },
  );

  assert.equal(objectSchema({ value: catchingRefinement }).decode({ value: "ok" }).value, "ok");
  assert.equal(getterHits, 0);
});

test("refinement specification digest participates in schema identity", () => {
  const first = refineSchema(
    stringSchema,
    "test.identity.v1",
    refinementSpecDigest("test.identity.first.v1"),
    (value) => value,
  );
  const second = refineSchema(
    stringSchema,
    "test.identity.v1",
    refinementSpecDigest("test.identity.second.v1"),
    (value) => value,
  );

  assert.notEqual(
    defineSchemaManifest("test.identity", "1.0.0", first).schemaHash,
    defineSchemaManifest("test.identity", "1.0.0", second).schemaHash,
  );
});

test("bounded depth, string, collection, and byte policy rejects resource abuse", () => {
  let nested: unknown = null;
  for (let index = 0; index < 70; index += 1) nested = [nested];
  assert.throws(() => encodeCanonicalJson(nested), errorCode("invalid-type"));
  assert.throws(() => encodeCanonicalJson("x".repeat(131_073)), errorCode("invalid-type"));
  assert.throws(() => encodeCanonicalJson(Array.from({ length: 16_385 }, () => 0)), errorCode("invalid-type"));
  assert.throws(
    () => arraySchema(stringSchema).decode(Array.from({ length: 9 }, () => "x".repeat(131_072))),
    errorCode("invalid-type"),
  );
  assert.throws(() => decodeJson('{"x":"' + "x".repeat(131_073) + '"}'), errorCode("invalid-json"));

  const aggregate: Record<string, unknown> = {};
  for (let index = 0; index < 12_000; index += 1) {
    aggregate[`key-${index}`] = "x".repeat(100);
  }
  assert.throws(() => canonicalObjectSchema.decode(aggregate));
  let nestedAgain: unknown = null;
  for (let index = 0; index < 70; index += 1) nestedAgain = [nestedAgain];
  assert.throws(() => canonicalJsonSchema.decode(nestedAgain));
});

test("decoded values are deeply frozen", () => {
  const value = decodeCanonicalJson('{"a":{"b":[1]}}');
  assert.equal(Object.isFrozen(value), true);
  assert.equal(Object.isFrozen((value as { a: object }).a), true);
  assert.equal(Object.isFrozen((value as { a: { b: readonly unknown[] } }).a.b), true);
  assert.throws(() => {
    (value as { a: { b: unknown[] } }).a.b[0] = 2;
  });
});
