import { assertCapabilityRef, type CapabilityRefV1 } from "../../capability-contracts/src/index.ts";
import {
  assertHash,
  assertNonEmptyString,
  decodeCanonicalJson,
  decodeExactObject,
  deepFreeze,
  encodeCanonicalJson,
  fieldArray,
  hashDomain,
  type CanonicalJson,
  type Hash,
} from "../../canonical-codec/src/index.ts";
import { decodeFrozenProgramEnvelope, type FrozenProgramEnvelopeV1 } from "../../request-program/src/index.ts";
import {
  isExactFactSet,
  registerFactSet,
  requireInterpreterRegistry,
  requireTransportFactSet,
  type InterpreterRegistryStateV1,
} from "./internal/registry-state.ts";

export interface CapabilityInterpreterPortV1 {
  readonly registryRoot: Hash;
}

export interface FrameworkFactSetCapabilityV1 {
  readonly factSetHash: Hash;
}

export interface TransportFactSetCapabilityV1 {
  readonly factSetHash: Hash;
}

export interface ExecutionFactSourceV1 {
  readonly chainId: string;
  readonly blockNumber: string;
  readonly blockHash: Hash;
  readonly stateRoot: Hash;
  readonly executorAuthorityRoot: Hash;
  readonly workerEpoch: string;
  readonly executorSessionHash: Hash;
}

export type RetryableTransportCodeV1 = "rpc" | "deadline" | "abort" | "queue-full" | "resource-limit" | "worker-crash" | "source-stale";

export type TransportFactV1 =
  | { readonly kind: "returned"; readonly requestId: Hash; readonly requestFingerprint: Hash; readonly dataHex: string; readonly source: ExecutionFactSourceV1 }
  | { readonly kind: "reverted"; readonly requestId: Hash; readonly requestFingerprint: Hash; readonly dataHex: string; readonly source: ExecutionFactSourceV1 }
  | { readonly kind: "transportFailure"; readonly requestId: Hash; readonly requestFingerprint: Hash; readonly failureCode: RetryableTransportCodeV1; readonly source: ExecutionFactSourceV1 };

export type ProgramInterpretationDraftV1 =
  | { readonly kind: "verified"; readonly output: unknown }
  | { readonly kind: "chainProvenRejected"; readonly factSet: FrameworkFactSetCapabilityV1; readonly decisionCode: string }
  | { readonly kind: "invalidProgram"; readonly code: string };

export type ProgramInterpretationV1 =
  | { readonly kind: "verified"; readonly output: CanonicalJson; readonly outputSchemaRef: Hash }
  | { readonly kind: "chainProvenRejected"; readonly factSet: FrameworkFactSetCapabilityV1; readonly decisionCode: string }
  | { readonly kind: "retryable"; readonly failureCode: RetryableTransportCodeV1 }
  | { readonly kind: "invalidProgram"; readonly code: string };

export interface InterpretCapabilityProgramInputV1 {
  readonly program: FrozenProgramEnvelopeV1;
  readonly factSet: TransportFactSetCapabilityV1;
}

const FAILURE_CODES = new Set<RetryableTransportCodeV1>(["rpc", "deadline", "abort", "queue-full", "resource-limit", "worker-crash", "source-stale"]);

function source(value: unknown, path: string): ExecutionFactSourceV1 {
  return decodeExactObject<ExecutionFactSourceV1>(value, {
    chainId: (item, itemPath) => assertNonEmptyString(item, itemPath),
    blockNumber: (item, itemPath) => assertNonEmptyString(item, itemPath),
    blockHash: (item, itemPath) => assertHash(item, itemPath),
    stateRoot: (item, itemPath) => assertHash(item, itemPath),
    executorAuthorityRoot: (item, itemPath) => assertHash(item, itemPath),
    workerEpoch: (item, itemPath) => assertNonEmptyString(item, itemPath),
    executorSessionHash: (item, itemPath) => assertHash(item, itemPath),
  }, path);
}

function dataHex(value: unknown, path: string): string {
  const result = assertNonEmptyString(value, path);
  if (!/^0x(?:[0-9a-f]{2})*$/.test(result)) throw new TypeError(`canonical bytes hex required at ${path}`);
  return result;
}

function fact(value: unknown, path: string): TransportFactV1 {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`transport fact object required at ${path}`);
  const kind = Object.getOwnPropertyDescriptor(value, "kind");
  if (!kind || !("value" in kind)) throw new TypeError(`transport fact kind data property required at ${path}`);
  if (kind.value === "returned" || kind.value === "reverted") {
    return decodeExactObject(value, {
      kind: (item, itemPath) => { if (item !== kind.value) throw new TypeError(`fact kind mismatch at ${itemPath}`); return item as "returned" | "reverted"; },
      requestId: (item, itemPath) => assertHash(item, itemPath),
      requestFingerprint: (item, itemPath) => assertHash(item, itemPath),
      dataHex: (item, itemPath) => dataHex(item, itemPath),
      source: (item, itemPath) => source(item, itemPath),
    }, path) as TransportFactV1;
  }
  if (kind.value === "transportFailure") {
    return decodeExactObject(value, {
      kind: (item, itemPath) => { if (item !== "transportFailure") throw new TypeError(`fact kind mismatch at ${itemPath}`); return "transportFailure" as const; },
      requestId: (item, itemPath) => assertHash(item, itemPath),
      requestFingerprint: (item, itemPath) => assertHash(item, itemPath),
      failureCode: (item, itemPath) => { if (typeof item !== "string" || !FAILURE_CODES.has(item as RetryableTransportCodeV1)) throw new TypeError(`unknown transport failure at ${itemPath}`); return item as RetryableTransportCodeV1; },
      source: (item, itemPath) => source(item, itemPath),
    }, path);
  }
  throw new TypeError(`unknown transport fact kind at ${path}`);
}

function exactCapability(left: CapabilityRefV1, right: CapabilityRefV1): boolean {
  return encodeCanonicalJson(assertCapabilityRef(left)) === encodeCanonicalJson(assertCapabilityRef(right));
}

function sourceMatches(
  program: FrozenProgramEnvelopeV1,
  item: TransportFactV1,
  state: InterpreterRegistryStateV1,
): boolean {
  return item.source.chainId === program.source.chainId
    && item.source.blockNumber === program.source.number
    && item.source.blockHash === program.source.hash
    && item.source.stateRoot === program.source.stateRoot
    && item.source.executorAuthorityRoot === state.executorAuthorityRoot
    && item.source.workerEpoch === state.workerEpoch
    && item.source.executorSessionHash === state.executorSessionHash;
}

function invalid(code: string): ProgramInterpretationV1 {
  return deepFreeze({ kind: "invalidProgram" as const, code });
}

export function interpretCapabilityProgram(port: CapabilityInterpreterPortV1, input: InterpretCapabilityProgramInputV1): ProgramInterpretationV1 {
  let state;
  try {
    state = requireInterpreterRegistry(port);
  } catch {
    return invalid("interpreter-registry-unavailable");
  }
  let program: FrozenProgramEnvelopeV1;
  let facts: readonly TransportFactV1[];
  try {
    program = decodeFrozenProgramEnvelope(input.program);
    const issuedFacts = requireTransportFactSet(input.factSet, port);
    facts = fieldArray(issuedFacts.facts, (item, path) => fact(item, path), "facts");
    if (facts.length === 0) throw new TypeError("transport fact partition is empty");
    if (
      issuedFacts.programRequestFingerprint !== program.requestFingerprint
      || program.authorityHash !== state.programAuthorityHash
      || input.factSet.factSetHash !== hashDomain("aloha/transport-fact-set/v1", {
        programRequestFingerprint: issuedFacts.programRequestFingerprint,
        facts,
      })
      || facts.some(item => item.requestFingerprint !== program.requestFingerprint || !sourceMatches(program, item, state))
    ) throw new TypeError("transport fact program/source/authority mismatch");
    if (new Set(facts.map(item => item.requestId)).size !== facts.length) throw new TypeError("duplicate transport request id");
  } catch {
    return invalid("transport-facts-invalid");
  }
  const declaration = state.declarations.get(program.capabilityRef.capabilityId);
  if (declaration === undefined || !exactCapability(declaration.capabilityRef, program.capabilityRef)) return invalid("capability-not-qualified");
  const failure = facts.find(item => item.kind === "transportFailure");
  if (failure?.kind === "transportFailure") return deepFreeze({ kind: "retryable" as const, failureCode: failure.failureCode });
  const dependencyRefs = declaration.dependencyIds.map(id => state.capabilityRefs.get(id)!);
  const payload = decodeCanonicalJson(program.canonicalPayloadBytes);
  const factSetHash = hashDomain("aloha/framework-fact-set/v1", { requestFingerprint: program.requestFingerprint, facts });
  const factSet = Object.freeze({ factSetHash });
  registerFactSet(factSet, port, factSetHash);
  let draft: ProgramInterpretationDraftV1;
  try {
    draft = declaration.interpret({ program, payload, facts, dependencyRefs, factSet });
  } catch {
    return invalid("plugin-error");
  }
  if (draft.kind === "verified") {
    try {
      const output = declaration.outputCodec.decodeExact(draft.output);
      return deepFreeze({ kind: "verified" as const, output: decodeCanonicalJson(encodeCanonicalJson(output)), outputSchemaRef: declaration.outputSchemaRef });
    } catch {
      return invalid("output-codec-mismatch");
    }
  }
  if (draft.kind === "chainProvenRejected") {
    if (!/^[a-z][a-z0-9-]*$/.test(draft.decisionCode) || !isExactFactSet(draft.factSet, port, factSetHash)) return invalid("rejection-fact-set-invalid");
    return deepFreeze({ kind: "chainProvenRejected" as const, factSet: draft.factSet, decisionCode: draft.decisionCode });
  }
  if (draft.kind === "invalidProgram" && /^[a-z][a-z0-9-]*$/.test(draft.code)) return invalid(draft.code);
  return invalid("interpreter-outcome-invalid");
}

export type { CapabilityInterpreterDeclarationV1 } from "./internal/registry-state.ts";
