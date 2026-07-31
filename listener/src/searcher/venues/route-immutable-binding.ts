import { createHash } from "node:crypto";

/**
 * Family-owned immutable execution metadata carried from discovery into the
 * graph without teaching the kernel protocol-specific fields.
 *
 * `schema` is a public, versioned codec identifier owned by one family.
 * `payload` is the canonical hex encoding for that schema.
 * `hash` binds both fields at every persistence/graph boundary.
 */
export interface RouteImmutableBinding {
  readonly schema: string;
  readonly payload: string;
  readonly hash: string;
}

const SCHEMA_RE = /^[a-z0-9][a-z0-9._:/-]{0,127}$/;
const HASH_RE = /^0x[0-9a-f]{64}$/;
const HEX_RE = /^0x(?:[0-9a-f]{2})*$/;
const HASH_DOMAIN = "mev-route-immutable-binding-v1";
const MAX_PAYLOAD_BYTES = 16_384;

export function createRouteImmutableBinding(
  schema: string,
  payload: string,
): RouteImmutableBinding {
  const normalizedSchema = normalizeSchema(schema);
  const normalizedPayload = normalizePayload(payload);
  return Object.freeze({
    schema: normalizedSchema,
    payload: normalizedPayload,
    hash: routeImmutableBindingHash(normalizedSchema, normalizedPayload),
  });
}

export function validateRouteImmutableBinding(
  value: RouteImmutableBinding,
  expectedSchema?: string,
): RouteImmutableBinding {
  if (!value || typeof value !== "object") {
    throw new Error("route immutable binding must be an object");
  }
  const schema = normalizeSchema(value.schema);
  const payload = normalizePayload(value.payload);
  const hash = normalizeHash(value.hash);
  if (
    expectedSchema !== undefined &&
    schema !== normalizeSchema(expectedSchema)
  ) {
    throw new Error(
      `route immutable binding schema ${schema} does not match ${expectedSchema}`,
    );
  }
  const expectedHash = routeImmutableBindingHash(schema, payload);
  if (hash !== expectedHash) {
    throw new Error(
      `route immutable binding hash mismatch for schema ${schema}`,
    );
  }
  return Object.freeze({ schema, payload, hash });
}

/**
 * Validate and normalize the optional binding carried by a shared pool/edge
 * object before any family callback or identity/hash projection consumes it.
 */
export function validateRouteImmutableBindingCarrier<
  T extends { readonly routeBinding?: RouteImmutableBinding },
>(value: T): T {
  if (value.routeBinding === undefined) return value;
  return {
    ...value,
    routeBinding: validateRouteImmutableBinding(value.routeBinding),
  };
}

/** Content identity for an optional binding; validation always precedes use. */
export function validatedRouteImmutableBindingHash(
  value: RouteImmutableBinding | undefined,
): string | null {
  return value === undefined
    ? null
    : validateRouteImmutableBinding(value).hash;
}

export function routeImmutableBindingHash(
  schema: string,
  payload: string,
): string {
  const normalizedSchema = normalizeSchema(schema);
  const normalizedPayload = normalizePayload(payload);
  return `0x${
    createHash("sha256")
      .update(HASH_DOMAIN)
      .update("\0")
      .update(normalizedSchema)
      .update("\0")
      .update(normalizedPayload)
      .digest("hex")
  }`;
}

function normalizeSchema(value: string): string {
  if (typeof value !== "string" || !SCHEMA_RE.test(value)) {
    throw new Error(
      "route immutable binding schema must be a lowercase versioned identifier",
    );
  }
  return value;
}

function normalizePayload(value: string): string {
  if (typeof value !== "string") {
    throw new Error("route immutable binding payload must be hex");
  }
  const normalized = value.toLowerCase();
  if (!HEX_RE.test(normalized)) {
    throw new Error(
      "route immutable binding payload must be canonical byte-aligned hex",
    );
  }
  if ((normalized.length - 2) / 2 > MAX_PAYLOAD_BYTES) {
    throw new Error(
      `route immutable binding payload exceeds ${MAX_PAYLOAD_BYTES} bytes`,
    );
  }
  return normalized;
}

function normalizeHash(value: string): string {
  if (typeof value !== "string") {
    throw new Error("route immutable binding hash must be hex");
  }
  const normalized = value.toLowerCase();
  if (!HASH_RE.test(normalized)) {
    throw new Error("route immutable binding hash must be bytes32");
  }
  return normalized;
}
