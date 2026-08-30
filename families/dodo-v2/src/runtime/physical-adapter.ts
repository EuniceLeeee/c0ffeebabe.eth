import {
  assertExactKeys,
  assertHash,
  decodeCanonicalJson,
  encodeCanonicalBytes,
  encodeCanonicalJson,
  hashDomain,
  sha256Hex,
  type CanonicalJson,
  type Hash,
} from "../../../../packages/canonical-codec/src/index.ts";
import {
  decodeCanonicalCutoff,
  decodeCandidateEvidenceRef,
} from "../../../../packages/discovery/src/index.ts";
import {
  type FamilyPhysicalLifecycleAdapterFactoryV1,
  type FamilyPhysicalLifecycleAdapterV1,
  type FamilyPhysicalLifecycleExecutionV1,
  type FamilyPhysicalLifecyclePortsV1,
  type FamilyPhysicalRpcCompletionV1,
  type FamilyPhysicalRpcPortV1,
  type FamilyPhysicalTransportResultV1,
  decodeFamilySourcePlanPhysicalObservation,
} from "../../../../packages/family-sdk/runtime/index.ts";
import { DODO_V2_FAMILY_AUTHORING_HASH } from "../family-definition.ts";
import {
  DODO_V2_FACTORIES,
  DODO_V2_FAMILY_ID,
  DODO_V2_QUOTE_ACTOR,
} from "../manifest.ts";
import { canonicalAddress } from "../types.ts";

type RecordValue = Record<string, unknown>;

const SELECTORS = Object.freeze({
  baseToken: "0x4a248d2a",
  quoteToken: "0xd4b97046",
  pmm: "0xfd1ed7e9",
  userFee: "0x44096609",
  pools: "0x57a281dc",
});
const ZERO_ADDRESS = `0x${"0".repeat(40)}`;

function record(value: unknown, path: string): RecordValue {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${path} must be an object`);
  }
  return value as RecordValue;
}

function canonicalBytes(value: CanonicalJson, path: string): string {
  if (typeof value !== "string" || !/^0x(?:[0-9a-f]{2})*$/.test(value)) {
    throw new TypeError(`${path} returned non-canonical bytes`);
  }
  return value;
}

function word(value: bigint): string {
  if (value < 0n || value >= 1n << 256n) throw new RangeError("DODO physical ABI word overflow");
  return value.toString(16).padStart(64, "0");
}

function addressArgument(value: string): string {
  return canonicalAddress(value).slice(2).padStart(64, "0");
}

function exactWords(value: string, count: number, path: string): readonly bigint[] {
  if (!new RegExp(`^0x(?:[0-9a-f]{64}){${count}}$`).test(value)) {
    throw new TypeError(`${path} ABI result mismatch`);
  }
  return Object.freeze(Array.from({ length: count }, (_, index) =>
    BigInt(`0x${value.slice(2 + index * 64, 2 + (index + 1) * 64)}`)));
}

function addressWord(value: string, path: string): string {
  const decoded = exactWords(value, 1, path)[0]!;
  if (decoded > (1n << 160n) - 1n) throw new TypeError(`${path} contains a non-address word`);
  return canonicalAddress(`0x${decoded.toString(16).padStart(40, "0")}`);
}

function addressArray(value: string, path: string): readonly string[] {
  if (!/^0x(?:[0-9a-f]{64})+$/.test(value)) throw new TypeError(`${path} ABI result mismatch`);
  const words = exactWords(value, (value.length - 2) / 64, path);
  if (words.length < 2 || words[0] !== 32n || words[1]! > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new TypeError(`${path} ABI dynamic array header mismatch`);
  }
  const count = Number(words[1]!);
  if (words.length !== count + 2) throw new TypeError(`${path} ABI dynamic array length mismatch`);
  return Object.freeze(words.slice(2).map((item, index) => {
    if (item > (1n << 160n) - 1n) throw new TypeError(`${path}[${index}] contains a non-address word`);
    return canonicalAddress(`0x${item.toString(16).padStart(40, "0")}`);
  }));
}

function hex(value: Uint8Array): string {
  return `0x${Array.from(value, byte => byte.toString(16).padStart(2, "0")).join("")}`;
}

function returned(requestId: Hash, value: unknown): FamilyPhysicalTransportResultV1 {
  const canonical = decodeCanonicalJson(encodeCanonicalJson(value));
  return Object.freeze({ kind: "returned" as const, requestId, dataHex: hex(encodeCanonicalBytes(canonical)) });
}

function rebound(
  requestId: Hash,
  completion: Exclude<FamilyPhysicalRpcCompletionV1, { readonly kind: "returned" }>,
): FamilyPhysicalTransportResultV1 {
  if (completion.kind === "reverted") {
    return Object.freeze({ kind: "reverted" as const, requestId, dataHex: completion.dataHex });
  }
  return Object.freeze({ kind: "transportFailure" as const, requestId, failureCode: completion.failureCode });
}

function subrequestId(requestId: Hash, operation: string): Hash {
  return hashDomain("aloha/dodo-v2/physical-subrequest/v1", { requestId, operation });
}

async function call(
  rpc: FamilyPhysicalRpcPortV1,
  requestId: Hash,
  operation: string,
  target: string,
  data: string,
  blockHash: Hash,
  signal: AbortSignal,
  from?: string,
): Promise<FamilyPhysicalRpcCompletionV1> {
  const completion = await rpc.request({
    requestId: subrequestId(requestId, operation),
    method: "eth_call",
    params: Object.freeze([
      Object.freeze({ to: canonicalAddress(target), data, ...(from === undefined ? {} : { from: canonicalAddress(from) }) }),
      Object.freeze({ blockHash, requireCanonical: true }),
    ]),
  }, signal);
  if (completion.kind === "returned" || completion.kind === "reverted") {
    canonicalBytes(completion.dataHex, `DODO physical ${operation}`);
  }
  return completion;
}

function candidate(payload: RecordValue): { readonly pool: string; readonly snapshot: Hash } {
  const value = record(payload.candidate, "dodoPhysical.candidate");
  return Object.freeze({
    pool: canonicalAddress(String(value.instanceNominationKey)),
    snapshot: assertHash(value.candidateSubjectHash, "dodoPhysical.candidate.candidateSubjectHash"),
  });
}

function pmmWire(value: string): {
  readonly i: string;
  readonly K: string;
  readonly B: string;
  readonly Q: string;
  readonly B0: string;
  readonly Q0: string;
  readonly R: 0 | 1 | 2;
} {
  const values = exactWords(value, 7, "DODO physical PMM");
  if (values[6]! > 2n) throw new TypeError("DODO physical PMM R is invalid");
  return Object.freeze({
    i: values[0]!.toString(),
    K: values[1]!.toString(),
    B: values[2]!.toString(),
    Q: values[3]!.toString(),
    B0: values[4]!.toString(),
    Q0: values[5]!.toString(),
    R: Number(values[6]!) as 0 | 1 | 2,
  });
}

async function readState(
  rpc: FamilyPhysicalRpcPortV1,
  requestId: Hash,
  pool: string,
  blockHash: Hash,
  signal: AbortSignal,
): Promise<readonly FamilyPhysicalRpcCompletionV1[]> {
  return Promise.all([
    call(rpc, requestId, "pmm", pool, SELECTORS.pmm, blockHash, signal),
    call(rpc, requestId, "actor-fee", pool, `${SELECTORS.userFee}${addressArgument(DODO_V2_QUOTE_ACTOR)}`, blockHash, signal, DODO_V2_QUOTE_ACTOR),
  ]);
}

function requiredFailure(
  requestId: Hash,
  completions: readonly FamilyPhysicalRpcCompletionV1[],
): FamilyPhysicalTransportResultV1 | null {
  const failure = completions.find(value => value.kind !== "returned");
  return failure === undefined ? null : rebound(requestId, failure);
}

async function identity(
  payloadValue: CanonicalJson,
  ports: FamilyPhysicalLifecyclePortsV1,
  signal: AbortSignal,
): Promise<readonly FamilyPhysicalTransportResultV1[]> {
  const payload = record(payloadValue, "dodoPhysical.identity");
  assertExactKeys(payload, ["kind", "candidate", "evidence", "cutoff", "readPlan", "requestId"]);
  if (payload.kind !== "dodo-v2-identity-input") throw new TypeError("DODO physical identity kind mismatch");
  const cutoff = decodeCanonicalCutoff(payload.cutoff, "dodoPhysical.identity.cutoff");
  const requestId = assertHash(payload.requestId, "dodoPhysical.identity.requestId");
  const evidence = decodeCandidateEvidenceRef(payload.evidence, "dodoPhysical.identity.evidence");
  const evidenceBytes = ports.rawEvidence.read(evidence.rawLocatorHash);
  if (sha256Hex(evidenceBytes) !== evidence.rawLocatorHash) throw new TypeError("DODO physical raw evidence hash mismatch");
  const preferredDeclaration = evidence.kind === "source-plan"
    ? (() => {
        const observed = decodeFamilySourcePlanPhysicalObservation(evidenceBytes, "dodoPhysical.identity.sourceEvidence");
        const declaration = DODO_V2_FACTORIES.find(value => value.address === observed.request.target);
        if (declaration === undefined) throw new TypeError("DODO physical source evidence factory is not declared");
        return declaration;
      })()
    : null;
  const { pool, snapshot } = candidate(payload);
  const base = await Promise.all([
    call(ports.rpc, requestId, "base-token", pool, SELECTORS.baseToken, cutoff.hash, signal),
    call(ports.rpc, requestId, "quote-token", pool, SELECTORS.quoteToken, cutoff.hash, signal),
    ...await readState(ports.rpc, requestId, pool, cutoff.hash, signal),
  ]);
  const failure = requiredFailure(requestId, base);
  if (failure !== null) return Object.freeze([failure]);
  const baseToken = addressWord((base[0] as { readonly dataHex: string }).dataHex, "DODO physical base token");
  const quoteToken = addressWord((base[1] as { readonly dataHex: string }).dataHex, "DODO physical quote token");
  const pmm = pmmWire((base[2] as { readonly dataHex: string }).dataHex);
  const feeWords = exactWords((base[3] as { readonly dataHex: string }).dataHex, 2, "DODO physical actor fee");
  let declaration: (typeof DODO_V2_FACTORIES)[number] | null = null;
  let unresolved: Exclude<FamilyPhysicalRpcCompletionV1, { readonly kind: "returned" }> | null = null;
  const declarations = preferredDeclaration === null ? DODO_V2_FACTORIES : [preferredDeclaration] as const;
  for (const candidateDeclaration of declarations) {
    const completion = await call(
      ports.rpc,
      requestId,
      `registry:${candidateDeclaration.kind}`,
      candidateDeclaration.address,
      `${SELECTORS.pools}${addressArgument(baseToken)}${addressArgument(quoteToken)}`,
      cutoff.hash,
      signal,
    );
    if (completion.kind !== "returned") {
      if (unresolved === null) unresolved = completion;
      continue;
    }
    const pools = addressArray(completion.dataHex, `DODO physical registry ${candidateDeclaration.kind}`);
    if (pools.includes(pool)) {
      declaration = candidateDeclaration;
      break;
    }
  }
  if (declaration === null && unresolved !== null) return Object.freeze([rebound(requestId, unresolved)]);
  const selectedDeclaration = declaration ?? preferredDeclaration ?? DODO_V2_FACTORIES[0]!;
  return Object.freeze([returned(requestId, {
    kind: "dodo-v2-identity-facts",
    version: 1,
    candidateSnapshotHash: snapshot,
    candidateEvidenceBytesHex: hex(evidenceBytes),
    reads: {
      cutoff,
      pool,
      factory: selectedDeclaration.address,
      registry: selectedDeclaration.address,
      registryPool: declaration === null ? ZERO_ADDRESS : pool,
      baseToken,
      quoteToken,
      quoteActor: DODO_V2_QUOTE_ACTOR,
      pmm,
      lpFeeRate: feeWords[0]!.toString(),
      mtFeeRate: feeWords[1]!.toString(),
    },
  })]);
}

function statePool(payload: RecordValue): string {
  const identityMemo = record(payload.identityMemo, "dodoPhysical.state.identityMemo");
  const identity = record(identityMemo.identity, "dodoPhysical.state.identityMemo.identity");
  return canonicalAddress(String(identity.instanceKey));
}

async function state(
  payloadValue: CanonicalJson,
  rpc: FamilyPhysicalRpcPortV1,
  signal: AbortSignal,
): Promise<readonly FamilyPhysicalTransportResultV1[]> {
  const payload = record(payloadValue, "dodoPhysical.state");
  const expected = payload.kind === "dodo-v2-materialization-input"
    ? ["kind", "identityMemo", "cutoff", "readPlan", "requestId"]
    : ["kind", "identityMemo", "materialization", "cutoff", "readPlan", "requestId"];
  assertExactKeys(payload, expected);
  if (payload.kind !== "dodo-v2-materialization-input" && payload.kind !== "dodo-v2-projection-input") {
    throw new TypeError("DODO physical state kind mismatch");
  }
  const cutoff = decodeCanonicalCutoff(payload.cutoff, "dodoPhysical.state.cutoff");
  const requestId = assertHash(payload.requestId, "dodoPhysical.state.requestId");
  const pool = statePool(payload);
  const completions = await readState(rpc, requestId, pool, cutoff.hash, signal);
  const failure = requiredFailure(requestId, completions);
  if (failure !== null) return Object.freeze([failure]);
  const pmm = pmmWire((completions[0] as { readonly dataHex: string }).dataHex);
  const feeWords = exactWords((completions[1] as { readonly dataHex: string }).dataHex, 2, "DODO physical actor fee");
  return Object.freeze([returned(requestId, {
    kind: "dodo-v2-state-facts",
    version: 1,
    read: {
      cutoff,
      pool,
      quoteActor: DODO_V2_QUOTE_ACTOR,
      pmm,
      lpFeeRate: feeWords[0]!.toString(),
      mtFeeRate: feeWords[1]!.toString(),
    },
  })]);
}

function rehydration(payloadValue: CanonicalJson): readonly FamilyPhysicalTransportResultV1[] {
  const payload = record(payloadValue, "dodoPhysical.rehydration");
  assertExactKeys(payload, ["kind", "candidate", "cutoff", "readPlan", "referenceHash", "requestId"]);
  if (payload.kind !== "dodo-v2-rehydration-input") throw new TypeError("DODO physical rehydration kind mismatch");
  return Object.freeze([returned(
    assertHash(payload.requestId, "dodoPhysical.rehydration.requestId"),
    assertHash(payload.referenceHash, "dodoPhysical.rehydration.referenceHash"),
  )]);
}

const ADAPTER: FamilyPhysicalLifecycleAdapterV1 = Object.freeze({
  kind: "aloha.family-physical-lifecycle-adapter",
  version: 1,
  familyId: DODO_V2_FAMILY_ID,
  familyDefinitionHash: DODO_V2_FAMILY_AUTHORING_HASH,
  async execute(
    input: FamilyPhysicalLifecycleExecutionV1,
    ports: FamilyPhysicalLifecyclePortsV1,
    signal: AbortSignal,
  ) {
    if (input.familyId !== DODO_V2_FAMILY_ID || input.familyDefinitionHash !== DODO_V2_FAMILY_AUTHORING_HASH) {
      throw new TypeError("DODO physical release binding mismatch");
    }
    if (input.stage === "identity") return identity(input.programInput, ports, signal);
    if (input.stage === "materialization" || input.stage === "projection") return state(input.programInput, ports.rpc, signal);
    if (input.stage === "rehydration") return rehydration(input.programInput);
    throw new TypeError("DODO nomination is owner-only and has no physical program");
  },
});

export const DODO_V2_PHYSICAL_LIFECYCLE_ADAPTER_FACTORY: FamilyPhysicalLifecycleAdapterFactoryV1 =
  () => ADAPTER;
