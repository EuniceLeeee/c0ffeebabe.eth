import {
  assertHash,
  assertNonEmptyString,
  decodeExactObject,
  deepFreeze,
  encodeCanonicalJson,
  hashDomain,
  type Hash,
} from "../../../../packages/canonical-codec/src/index.ts";
import { decodeCanonicalCutoff, type CanonicalCutoffV1 } from "../../../../packages/discovery/src/index.ts";
import { canonicalAddress, decodeReserves } from "../kernel/codec.ts";
import {
  decodeIdentityMemo,
  sealMaterializedState,
  UNIV2_GET_RESERVES_SELECTOR,
  type UniV2IdentityMemoV1,
  type UniV2MaterializedStateV1,
  type UniV2SourceRequestV1,
} from "../schema/index.ts";
import {
  UNIV2_STANDARD_STATE_CAPABILITY_ID,
  UNIV2_STANDARD_STATE_INTERPRETER_HASH,
  UNIV2_STANDARD_STATE_SCHEMA_HASH,
} from "./metadata.ts";

export interface UniV2StateReadProgramV1 {
  readonly kind: "univ2-standard.state-read-program";
  readonly schemaVersion: 1;
  readonly schemaRef: typeof UNIV2_STANDARD_STATE_SCHEMA_HASH;
  readonly capabilityId: typeof UNIV2_STANDARD_STATE_CAPABILITY_ID;
  readonly interpreterHash: typeof UNIV2_STANDARD_STATE_INTERPRETER_HASH;
  readonly source: CanonicalCutoffV1;
  readonly instanceKey: string;
  readonly pool: string;
  readonly token0: string;
  readonly token1: string;
  readonly identityFactsHash: Hash;
  readonly request: UniV2SourceRequestV1;
  readonly programHash: Hash;
}

export interface UniV2StateReadResponseV1 {
  readonly kind: "univ2-standard.state-read-response";
  readonly programHash: Hash;
  readonly source: CanonicalCutoffV1;
  readonly pool: string;
  readonly dataHex: string;
}

export interface UniV2StateSnapshotV1 {
  readonly kind: "univ2-standard.state-snapshot";
  readonly schemaVersion: 1;
  readonly schemaRef: typeof UNIV2_STANDARD_STATE_SCHEMA_HASH;
  readonly source: CanonicalCutoffV1;
  readonly instanceKey: string;
  readonly pool: string;
  readonly token0: string;
  readonly token1: string;
  readonly identityFactsHash: Hash;
  readonly state: UniV2MaterializedStateV1;
  readonly sourceRequest: UniV2SourceRequestV1;
  readonly stateFactsRoot: Hash;
}

export interface UniV2StateReadPortV1 {
  readonly issueReserveReadProgram: (input: {
    readonly identity: UniV2IdentityMemoV1;
    readonly source: CanonicalCutoffV1;
  }) => UniV2StateReadProgramV1;
  readonly decodeReserveReadResponse: (
    program: UniV2StateReadProgramV1,
    response: UniV2StateReadResponseV1,
  ) => UniV2StateSnapshotV1;
}

function sameSource(left: CanonicalCutoffV1, right: CanonicalCutoffV1): boolean {
  return left.chainId === right.chainId
    && left.number === right.number
    && left.hash === right.hash
    && left.stateRoot === right.stateRoot;
}

function source(value: unknown, path: string): CanonicalCutoffV1 {
  return decodeCanonicalCutoff(value, path);
}

function request(pool: string, cutoff: CanonicalCutoffV1): UniV2SourceRequestV1 {
  return Object.freeze({
    requestId: hashDomain("aloha/univ2-standard/request-id/v1", {
      phase: "materialization",
      target: pool,
      data: UNIV2_GET_RESERVES_SELECTOR,
      cutoff,
    }),
    phase: "materialization",
    target: pool,
    data: UNIV2_GET_RESERVES_SELECTOR,
    cutoff,
    responseEncoding: "abi-reserves",
  });
}

function validateIdentity(value: UniV2IdentityMemoV1): UniV2IdentityMemoV1 {
  const identity = decodeIdentityMemo(value, "univ2.state.identity");
  if (identity.instanceKey !== identity.facts.pool) throw new TypeError("univ2-state-identity-instance-mismatch");
  if (identity.factsHash !== hashDomain("aloha/univ2-standard/identity-facts/v1", identity.facts)) throw new TypeError("univ2-state-identity-facts-mismatch");
  return identity;
}

function programHash(program: Omit<UniV2StateReadProgramV1, "programHash">): Hash {
  return hashDomain("aloha/univ2-standard/state-read-program/v1", program);
}

function decodeProgram(value: UniV2StateReadProgramV1): UniV2StateReadProgramV1 {
  const decoded = decodeExactObject(value, {
    kind: (item, path) => { if (item !== "univ2-standard.state-read-program") throw new TypeError(`${path} kind mismatch`); return item; },
    schemaVersion: (item, path) => { if (item !== 1) throw new TypeError(`${path} version mismatch`); return 1 as const; },
    schemaRef: (item, path) => { if (item !== UNIV2_STANDARD_STATE_SCHEMA_HASH) throw new TypeError(`${path} schema mismatch`); return UNIV2_STANDARD_STATE_SCHEMA_HASH; },
    capabilityId: (item, path) => { if (item !== UNIV2_STANDARD_STATE_CAPABILITY_ID) throw new TypeError(`${path} capability mismatch`); return UNIV2_STANDARD_STATE_CAPABILITY_ID; },
    interpreterHash: (item, path) => { if (item !== UNIV2_STANDARD_STATE_INTERPRETER_HASH) throw new TypeError(`${path} interpreter mismatch`); return UNIV2_STANDARD_STATE_INTERPRETER_HASH; },
    source: (item, path) => source(item, path),
    instanceKey: (item, path) => typeof item === "string" ? canonicalAddress(item) : (() => { throw new TypeError(`${path} must be an address`); })(),
    pool: (item, path) => typeof item === "string" ? canonicalAddress(item) : (() => { throw new TypeError(`${path} must be an address`); })(),
    token0: (item, path) => typeof item === "string" ? canonicalAddress(item) : (() => { throw new TypeError(`${path} must be an address`); })(),
    token1: (item, path) => typeof item === "string" ? canonicalAddress(item) : (() => { throw new TypeError(`${path} must be an address`); })(),
    identityFactsHash: (item, path) => assertHash(item, path),
    request: (item, path) => decodeExactObject(item, {
      requestId: (field, fieldPath) => assertHash(field, fieldPath),
      phase: (field, fieldPath) => { if (field !== "materialization") throw new TypeError(`${fieldPath} phase mismatch`); return field; },
      target: (field, fieldPath) => typeof field === "string" ? canonicalAddress(field) : (() => { throw new TypeError(`${fieldPath} must be an address`); })(),
      data: (field, fieldPath) => assertNonEmptyString(field, fieldPath),
      cutoff: (field, fieldPath) => source(field, fieldPath),
      responseEncoding: (field, fieldPath) => { if (field !== "abi-reserves") throw new TypeError(`${fieldPath} encoding mismatch`); return field; },
    }, `${"univ2.state.program"}.request`),
    programHash: (item, path) => assertHash(item, path),
  }, "univ2.state.program");
  if (decoded.instanceKey !== decoded.pool || decoded.token0 === decoded.token1 || decoded.request.target !== decoded.pool || decoded.request.data !== UNIV2_GET_RESERVES_SELECTOR || !sameSource(decoded.request.cutoff, decoded.source)) throw new TypeError("univ2-state-program-request-mismatch");
  const { programHash: ignored, ...withoutHash } = decoded;
  void ignored;
  if (programHash(withoutHash as Omit<UniV2StateReadProgramV1, "programHash">) !== decoded.programHash) throw new TypeError("univ2-state-program-hash-mismatch");
  return deepFreeze(decoded) as UniV2StateReadProgramV1;
}

function decodeResponse(value: unknown): UniV2StateReadResponseV1 {
  return decodeExactObject(value, {
    kind: (item, path) => { if (item !== "univ2-standard.state-read-response") throw new TypeError(`${path} kind mismatch`); return item; },
    programHash: (item, path) => assertHash(item, path),
    source: (item, path) => source(item, path),
    pool: (item, path) => typeof item === "string" ? canonicalAddress(item) : (() => { throw new TypeError(`${path} must be an address`); })(),
    dataHex: (item, path) => {
      if (typeof item !== "string" || !/^0x(?:[0-9a-fA-F]{2})*$/.test(item)) throw new TypeError(`${path} must be hex bytes`);
      return item.toLowerCase();
    },
  }, "univ2.state.response");
}

function issueReserveReadProgram(input: { readonly identity: UniV2IdentityMemoV1; readonly source: CanonicalCutoffV1 }): UniV2StateReadProgramV1 {
  const identity = validateIdentity(input.identity);
  const cutoff = source(input.source, "univ2.state.issue.source");
  const read = request(identity.facts.pool, cutoff);
  const withoutHash: Omit<UniV2StateReadProgramV1, "programHash"> = Object.freeze({
    kind: "univ2-standard.state-read-program" as const,
    schemaVersion: 1 as const,
    schemaRef: UNIV2_STANDARD_STATE_SCHEMA_HASH,
    capabilityId: UNIV2_STANDARD_STATE_CAPABILITY_ID,
    interpreterHash: UNIV2_STANDARD_STATE_INTERPRETER_HASH,
    source: cutoff,
    instanceKey: identity.instanceKey,
    pool: identity.facts.pool,
    token0: identity.facts.token0,
    token1: identity.facts.token1,
    identityFactsHash: identity.factsHash,
    request: read,
  });
  return decodeProgram({ ...withoutHash, programHash: programHash(withoutHash) });
}

function decodeReserveReadResponse(programInput: UniV2StateReadProgramV1, responseInput: UniV2StateReadResponseV1): UniV2StateSnapshotV1 {
  const program = decodeProgram(programInput);
  const response = decodeResponse(responseInput);
  if (response.programHash !== program.programHash || response.pool !== program.pool || !sameSource(response.source, program.source)) throw new TypeError("univ2-state-response-binding-mismatch");
  const reserves = decodeReserves(response.dataHex);
  const state = sealMaterializedState({
    cutoff: program.source,
    pool: program.pool,
    reserve0: reserves.reserve0.toString(10),
    reserve1: reserves.reserve1.toString(10),
    blockTimestampLast: reserves.blockTimestampLast.toString(10),
  });
  const snapshot: Omit<UniV2StateSnapshotV1, "stateFactsRoot"> & { readonly stateFactsRoot: Hash } = {
    kind: "univ2-standard.state-snapshot" as const,
    schemaVersion: 1 as const,
    schemaRef: UNIV2_STANDARD_STATE_SCHEMA_HASH,
    source: program.source,
    instanceKey: program.instanceKey,
    pool: program.pool,
    token0: program.token0,
    token1: program.token1,
    identityFactsHash: program.identityFactsHash,
    state,
    sourceRequest: program.request,
    stateFactsRoot: hashDomain("aloha/univ2-standard/state-facts-root/v1", {
      source: program.source,
      instanceKey: program.instanceKey,
      token0: program.token0,
      token1: program.token1,
      identityFactsHash: program.identityFactsHash,
      stateHash: state.stateHash,
      requestId: program.request.requestId,
    }),
  };
  return decodeUniV2StateSnapshot(snapshot);
}

export function decodeUniV2StateSnapshot(value: unknown, path = "univ2.stateSnapshot"): UniV2StateSnapshotV1 {
  const decoded = decodeExactObject(value, {
    kind: (item, itemPath) => { if (item !== "univ2-standard.state-snapshot") throw new TypeError(`${itemPath} kind mismatch`); return item; },
    schemaVersion: (item, itemPath) => { if (item !== 1) throw new TypeError(`${itemPath} version mismatch`); return 1 as const; },
    schemaRef: (item, itemPath) => { if (item !== UNIV2_STANDARD_STATE_SCHEMA_HASH) throw new TypeError(`${itemPath} schema mismatch`); return UNIV2_STANDARD_STATE_SCHEMA_HASH; },
    source: (item, itemPath) => source(item, itemPath),
    instanceKey: (item, itemPath) => typeof item === "string" ? canonicalAddress(item) : (() => { throw new TypeError(`${itemPath} must be an address`); })(),
    pool: (item, itemPath) => typeof item === "string" ? canonicalAddress(item) : (() => { throw new TypeError(`${itemPath} must be an address`); })(),
    token0: (item, itemPath) => typeof item === "string" ? canonicalAddress(item) : (() => { throw new TypeError(`${itemPath} must be an address`); })(),
    token1: (item, itemPath) => typeof item === "string" ? canonicalAddress(item) : (() => { throw new TypeError(`${itemPath} must be an address`); })(),
    identityFactsHash: (item, itemPath) => assertHash(item, itemPath),
    state: (item, itemPath) => decodeExactObject(item, {
      cutoff: (field, fieldPath) => source(field, fieldPath),
      pool: (field, fieldPath) => typeof field === "string" ? canonicalAddress(field) : (() => { throw new TypeError(`${fieldPath} must be an address`); })(),
      reserve0: (field, fieldPath) => assertNonEmptyString(field, fieldPath),
      reserve1: (field, fieldPath) => assertNonEmptyString(field, fieldPath),
      blockTimestampLast: (field, fieldPath) => assertNonEmptyString(field, fieldPath),
      stateHash: (field, fieldPath) => assertHash(field, fieldPath),
    }, `${path}.state`),
    sourceRequest: (item, itemPath) => decodeExactObject(item, {
      requestId: (field, fieldPath) => assertHash(field, fieldPath),
      phase: (field, fieldPath) => { if (field !== "materialization") throw new TypeError(`${fieldPath} phase mismatch`); return field; },
      target: (field, fieldPath) => typeof field === "string" ? canonicalAddress(field) : (() => { throw new TypeError(`${fieldPath} must be an address`); })(),
      data: (field, fieldPath) => assertNonEmptyString(field, fieldPath),
      cutoff: (field, fieldPath) => source(field, fieldPath),
      responseEncoding: (field, fieldPath) => { if (field !== "abi-reserves") throw new TypeError(`${fieldPath} encoding mismatch`); return field; },
    }, `${path}.sourceRequest`),
    stateFactsRoot: (item, itemPath) => assertHash(item, itemPath),
  }, path);
  if (decoded.instanceKey !== decoded.pool || decoded.token0 === decoded.token1 || decoded.state.pool !== decoded.pool || !sameSource(decoded.source, decoded.state.cutoff) || !sameSource(decoded.source, decoded.sourceRequest.cutoff) || decoded.sourceRequest.target !== decoded.pool || decoded.sourceRequest.data !== UNIV2_GET_RESERVES_SELECTOR) throw new TypeError(`${path} lineage mismatch`);
  const expectedState = sealMaterializedState({
    cutoff: decoded.source,
    pool: decoded.pool,
    reserve0: decoded.state.reserve0,
    reserve1: decoded.state.reserve1,
    blockTimestampLast: decoded.state.blockTimestampLast,
  });
  if (expectedState.stateHash !== decoded.state.stateHash) throw new TypeError(`${path}.stateHash mismatch`);
  const expectedRoot = hashDomain("aloha/univ2-standard/state-facts-root/v1", {
    source: decoded.source,
    instanceKey: decoded.instanceKey,
    token0: decoded.token0,
    token1: decoded.token1,
    identityFactsHash: decoded.identityFactsHash,
    stateHash: decoded.state.stateHash,
    requestId: decoded.sourceRequest.requestId,
  });
  if (expectedRoot !== decoded.stateFactsRoot) throw new TypeError(`${path}.stateFactsRoot mismatch`);
  return deepFreeze(decoded) as UniV2StateSnapshotV1;
}

export const UNIV2_STANDARD_STATE_PORT: UniV2StateReadPortV1 = Object.freeze({
  issueReserveReadProgram,
  decodeReserveReadResponse,
});
