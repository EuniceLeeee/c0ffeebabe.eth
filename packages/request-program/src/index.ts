import {
  assertCapabilityRef,
  asOwnerRef,
  asSchemaRef,
  type CapabilityRefV1,
  type OwnerRef,
  type SchemaRef,
} from "../../capability-contracts/src/index.ts";
import {
  assertHash,
  assertNonEmptyString,
  decodeCanonicalJson,
  decodeExactObject,
  deepFreeze,
  encodeCanonicalJson,
  hashDomain,
  type Hash,
} from "../../canonical-codec/src/index.ts";
import { requireProgramIssuer, type ProgramPayloadCodecV1 } from "./internal/issuer-state.ts";

export const CORE_PROGRAM_ENVELOPE_SCHEMA = hashDomain("aloha/frozen-program-envelope-schema/v1", {
  fields: ["schemaVersion", "kind", "envelopeSchemaRef", "payloadSchemaRef", "capabilityRef", "issuerRef", "source", "authorityHash", "canonicalPayloadBytes", "payloadHash", "requestFingerprint"],
});

export interface ProgramSourceAnchorV1 {
  readonly chainId: string;
  readonly number: string;
  readonly hash: Hash;
  readonly stateRoot: Hash;
}

export interface ProgramIssuerCapabilityV1 {
  readonly issuerRef: OwnerRef;
  readonly capabilityRef: CapabilityRefV1;
}

export interface FrozenProgramEnvelopeV1 {
  readonly schemaVersion: 1;
  readonly kind: "aloha.frozen-program";
  readonly envelopeSchemaRef: Hash;
  readonly payloadSchemaRef: SchemaRef;
  readonly capabilityRef: CapabilityRefV1;
  readonly issuerRef: OwnerRef;
  readonly source: ProgramSourceAnchorV1;
  readonly authorityHash: Hash;
  /** Canonical JSON bytes represented as their exact UTF-8 string. */
  readonly canonicalPayloadBytes: string;
  readonly payloadHash: Hash;
  readonly requestFingerprint: Hash;
}

export interface FrozenProgramRecordV1 {
  readonly schemaVersion: 1;
  readonly kind: "aloha.frozen-program-record";
  readonly requestFingerprint: Hash;
  readonly canonicalEnvelopeBytes: string;
  readonly recordHash: Hash;
}

function decimal(value: unknown, path: string): string {
  const result = assertNonEmptyString(value, path);
  if (!/^(0|[1-9][0-9]*)$/.test(result)) throw new TypeError(`canonical decimal required at ${path}`);
  return result;
}

function source(value: unknown, path: string): ProgramSourceAnchorV1 {
  return Object.freeze(decodeExactObject<ProgramSourceAnchorV1>(value, {
    chainId: (item, itemPath) => decimal(item, itemPath),
    number: (item, itemPath) => decimal(item, itemPath),
    hash: (item, itemPath) => assertHash(item, itemPath),
    stateRoot: (item, itemPath) => assertHash(item, itemPath),
  }, path));
}

function envelopeWithoutFingerprint(value: Omit<FrozenProgramEnvelopeV1, "requestFingerprint">): Hash {
  return hashDomain("aloha/frozen-program/v1", value);
}

export function decodeFrozenProgramEnvelope(value: unknown, path = "frozenProgram"): FrozenProgramEnvelopeV1 {
  const decoded = decodeExactObject(value, {
    schemaVersion: (item, itemPath) => { if (item !== 1) throw new TypeError(`unsupported schema at ${itemPath}`); return 1 as const; },
    kind: (item, itemPath) => { if (item !== "aloha.frozen-program") throw new TypeError(`invalid kind at ${itemPath}`); return "aloha.frozen-program" as const; },
    envelopeSchemaRef: (item, itemPath) => assertHash(item, itemPath),
    payloadSchemaRef: (item, itemPath) => asSchemaRef(item as Hash, itemPath),
    capabilityRef: (item, itemPath) => assertCapabilityRef(item, itemPath),
    issuerRef: (item, itemPath) => asOwnerRef(item as Hash, itemPath),
    source: (item, itemPath) => source(item, itemPath),
    authorityHash: (item, itemPath) => assertHash(item, itemPath),
    canonicalPayloadBytes: (item, itemPath) => assertNonEmptyString(item, itemPath),
    payloadHash: (item, itemPath) => assertHash(item, itemPath),
    requestFingerprint: (item, itemPath) => assertHash(item, itemPath),
  }, path);
  if (decoded.envelopeSchemaRef !== CORE_PROGRAM_ENVELOPE_SCHEMA) throw new TypeError("frozen program envelope schema mismatch");
  if (decoded.payloadSchemaRef !== decoded.capabilityRef.schemaHash) throw new TypeError("frozen program payload schema mismatch");
  const payload = decodeCanonicalJson(decoded.canonicalPayloadBytes);
  if (encodeCanonicalJson(payload) !== decoded.canonicalPayloadBytes) throw new TypeError("frozen program payload bytes are not canonical");
  if (hashDomain("aloha/program-payload/v1", { schemaRef: decoded.payloadSchemaRef, canonicalPayloadBytes: decoded.canonicalPayloadBytes }) !== decoded.payloadHash) throw new TypeError("frozen program payload hash mismatch");
  const { requestFingerprint, ...base } = decoded;
  if (envelopeWithoutFingerprint(base) !== requestFingerprint) throw new TypeError("frozen program fingerprint mismatch");
  return deepFreeze(decoded);
}

export function issueFrozenProgram(issuer: ProgramIssuerCapabilityV1, input: {
  readonly source: ProgramSourceAnchorV1;
  readonly value: unknown;
}): FrozenProgramEnvelopeV1 {
  const state = requireProgramIssuer(issuer as object);
  const normalizedSource = source(input.source, "source");
  const payload = state.codec.decodeExact(input.value);
  const canonicalPayloadBytes = encodeCanonicalJson(payload);
  if (encodeCanonicalJson(state.codec.decodeExact(decodeCanonicalJson(canonicalPayloadBytes))) !== canonicalPayloadBytes) throw new TypeError("program codec round-trip changed canonical bytes");
  const payloadHash = hashDomain("aloha/program-payload/v1", { schemaRef: state.codec.schemaRef, canonicalPayloadBytes });
  const base = deepFreeze({
    schemaVersion: 1 as const,
    kind: "aloha.frozen-program" as const,
    envelopeSchemaRef: CORE_PROGRAM_ENVELOPE_SCHEMA,
    payloadSchemaRef: state.codec.schemaRef,
    capabilityRef: state.capabilityRef,
    issuerRef: state.issuerRef,
    source: normalizedSource,
    authorityHash: state.authorityHash,
    canonicalPayloadBytes,
    payloadHash,
  });
  return decodeFrozenProgramEnvelope({ ...base, requestFingerprint: envelopeWithoutFingerprint(base) });
}

export function persistFrozenProgram(program: FrozenProgramEnvelopeV1): FrozenProgramRecordV1 {
  const normalized = decodeFrozenProgramEnvelope(program);
  const canonicalEnvelopeBytes = encodeCanonicalJson(normalized);
  return deepFreeze({
    schemaVersion: 1 as const,
    kind: "aloha.frozen-program-record" as const,
    requestFingerprint: normalized.requestFingerprint,
    canonicalEnvelopeBytes,
    recordHash: hashDomain("aloha/frozen-program-record/v1", canonicalEnvelopeBytes),
  });
}

export function rehydrateFrozenProgram(
  issuer: ProgramIssuerCapabilityV1,
  record: unknown,
): FrozenProgramEnvelopeV1 {
  const state = requireProgramIssuer(issuer as object);
  const decoded = decodeExactObject(record, {
    schemaVersion: (item, itemPath) => { if (item !== 1) throw new TypeError(`unsupported record schema at ${itemPath}`); return 1 as const; },
    kind: (item, itemPath) => { if (item !== "aloha.frozen-program-record") throw new TypeError(`invalid record kind at ${itemPath}`); return "aloha.frozen-program-record" as const; },
    requestFingerprint: (item, itemPath) => assertHash(item, itemPath),
    canonicalEnvelopeBytes: (item, itemPath) => assertNonEmptyString(item, itemPath),
    recordHash: (item, itemPath) => assertHash(item, itemPath),
  }, "frozenProgramRecord");
  if (hashDomain("aloha/frozen-program-record/v1", decoded.canonicalEnvelopeBytes) !== decoded.recordHash) throw new TypeError("frozen program record hash mismatch");
  const program = decodeFrozenProgramEnvelope(decodeCanonicalJson(decoded.canonicalEnvelopeBytes));
  if (program.requestFingerprint !== decoded.requestFingerprint) throw new TypeError("frozen program record fingerprint mismatch");
  if (
    program.issuerRef !== state.issuerRef
    || program.authorityHash !== state.authorityHash
    || encodeCanonicalJson(program.capabilityRef) !== encodeCanonicalJson(state.capabilityRef)
  ) throw new TypeError("frozen program issuer or authority mismatch");
  if (asSchemaRef(state.codec.schemaRef) !== program.payloadSchemaRef) throw new TypeError("frozen program codec schema mismatch");
  if (encodeCanonicalJson(state.codec.decodeExact(decodeCanonicalJson(program.canonicalPayloadBytes))) !== program.canonicalPayloadBytes) throw new TypeError("rehydrated payload codec mismatch");
  return program;
}

export type { ProgramPayloadCodecV1 } from "./internal/issuer-state.ts";
