import {
  assertExactKeys,
  assertHash,
  sha256Hex,
  type CanonicalJson,
  type Hash,
} from "../../../../packages/canonical-codec/src/index.ts";
import {
  type FamilyPhysicalLifecycleAdapterFactoryV1,
  type FamilyPhysicalLifecycleAdapterV1,
  type FamilyPhysicalLifecycleExecutionV1,
  type FamilyPhysicalLifecyclePortsV1,
  type FamilyPhysicalRpcCompletionV1,
  type FamilyPhysicalTransportResultV1,
} from "../../../../packages/family-sdk/runtime/index.ts";
import { decodeCanonicalCutoff } from "../../../../packages/discovery/src/index.ts";
import {
  UNIV4_GET_LIQUIDITY_SELECTOR,
  UNIV4_GET_SLOT0_SELECTOR,
  UNIV4_STATE_VIEW,
  decodeWords,
  encodePoolIdCall,
} from "../abi.ts";
import {
  UNIV4_FAMILY_DEFINITION_HASH,
} from "../family-definition.ts";
import { UNIV4_FAMILY_ID } from "../manifest.ts";

type RecordValue = Record<string, unknown>;
const Q96 = 1n << 96n;

function record(value: unknown, path: string): RecordValue {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${path} must be an object`);
  return value as RecordValue;
}

function bytes(value: Uint8Array): string {
  return `0x${Array.from(value, byte => byte.toString(16).padStart(2, "0")).join("")}`;
}

function word(value: bigint): string {
  if (value < 0n || value >= 1n << 256n) throw new TypeError("univ4 physical word is outside uint256");
  return value.toString(16).padStart(64, "0");
}

function returned(requestId: Hash, dataHex: string): FamilyPhysicalTransportResultV1 {
  if (!/^0x(?:[0-9a-f]{2})*$/.test(dataHex)) throw new TypeError("univ4 physical returned non-canonical bytes");
  return Object.freeze({ kind: "returned" as const, requestId, dataHex });
}

function completion(requestId: Hash, value: FamilyPhysicalRpcCompletionV1): FamilyPhysicalTransportResultV1 {
  if (value.kind === "returned") return returned(requestId, value.dataHex);
  if (value.kind === "reverted") return Object.freeze({ kind: "reverted" as const, requestId, dataHex: value.dataHex });
  return Object.freeze({ kind: "transportFailure" as const, requestId, failureCode: value.failureCode });
}

function exactCutoff(payload: RecordValue, input: FamilyPhysicalLifecycleExecutionV1) {
  const cutoff = decodeCanonicalCutoff(payload.cutoff, "univ4Physical.cutoff");
  if (cutoff.chainId !== input.source.chainId || cutoff.number !== input.source.number
    || cutoff.hash !== input.source.hash || cutoff.stateRoot !== input.source.stateRoot) {
    throw new TypeError("univ4 physical source mismatch");
  }
  return cutoff;
}

function nomination(input: FamilyPhysicalLifecycleExecutionV1): readonly FamilyPhysicalTransportResultV1[] {
  const payload = record(input.programInput, "univ4Physical.nomination");
  assertExactKeys(payload, ["kind", "binding", "cutoff", "readPlan", "requestId"]);
  if (payload.kind !== "univ4-nomination-input") throw new TypeError("univ4 physical nomination kind mismatch");
  exactCutoff(payload, input);
  const binding = record(payload.binding, "univ4Physical.nomination.binding");
  return Object.freeze([returned(
    assertHash(payload.requestId, "univ4Physical.nomination.requestId"),
    assertHash(binding.candidateSubjectHash, "univ4Physical.nomination.candidateSubjectHash"),
  )]);
}

function identity(
  input: FamilyPhysicalLifecycleExecutionV1,
  ports: FamilyPhysicalLifecyclePortsV1,
): readonly FamilyPhysicalTransportResultV1[] {
  const payload = record(input.programInput, "univ4Physical.identity");
  assertExactKeys(payload, ["kind", "binding", "cutoff", "readPlan", "requestIds"]);
  if (payload.kind !== "univ4-identity-input") throw new TypeError("univ4 physical identity kind mismatch");
  exactCutoff(payload, input);
  if (!Array.isArray(payload.requestIds) || payload.requestIds.length !== 1) throw new TypeError("univ4 physical identity partition mismatch");
  const binding = record(payload.binding, "univ4Physical.identity.binding");
  if (!Array.isArray(binding.evidence) || binding.evidence.length === 0) throw new TypeError("univ4 physical identity evidence is empty");
  const evidence = record(binding.evidence[0], "univ4Physical.identity.evidence[0]");
  const rawLocatorHash = assertHash(evidence.rawLocatorHash, "univ4Physical.identity.rawLocatorHash");
  const raw = ports.rawEvidence.read(rawLocatorHash);
  if (sha256Hex(raw) !== rawLocatorHash) throw new TypeError("univ4 physical raw evidence hash mismatch");
  return Object.freeze([returned(assertHash(payload.requestIds[0], "univ4Physical.identity.requestId"), bytes(raw))]);
}

function instanceKey(payload: RecordValue): Hash {
  if (payload.kind === "univ4-materialization-input") {
    const memo = record(payload.identityMemo, "univ4Physical.materialization.identityMemo");
    const identity = record(memo.identity, "univ4Physical.materialization.identity");
    return assertHash(identity.instanceKey, "univ4Physical.materialization.instanceKey");
  }
  if (payload.kind === "univ4-projection-input") {
    const memo = record(payload.identityMemo, "univ4Physical.projection.identityMemo");
    const identity = record(memo.identity, "univ4Physical.projection.identity");
    return assertHash(identity.instanceKey, "univ4Physical.projection.instanceKey");
  }
  throw new TypeError("univ4 physical state kind mismatch");
}

async function state(
  input: FamilyPhysicalLifecycleExecutionV1,
  ports: FamilyPhysicalLifecyclePortsV1,
  signal: AbortSignal,
): Promise<readonly FamilyPhysicalTransportResultV1[]> {
  const payload = record(input.programInput, "univ4Physical.state");
  const expected = payload.kind === "univ4-materialization-input"
    ? ["kind", "binding", "identityMemo", "cutoff", "readPlan", "requestId"]
    : ["kind", "binding", "identityMemo", "materialization", "cutoff", "readPlan", "requestId"];
  assertExactKeys(payload, expected);
  const cutoff = exactCutoff(payload, input);
  const requestId = assertHash(payload.requestId, "univ4Physical.state.requestId");
  const poolId = instanceKey(payload);
  const params = (data: string) => Object.freeze([
    Object.freeze({ to: UNIV4_STATE_VIEW.toLowerCase(), data }),
    Object.freeze({ blockHash: cutoff.hash, requireCanonical: true }),
  ]);
  const [slot0, liquidity] = await Promise.all([
    ports.rpc.request({ requestId, method: "eth_call", params: params(encodePoolIdCall(UNIV4_GET_SLOT0_SELECTOR, poolId)) }, signal),
    ports.rpc.request({ requestId, method: "eth_call", params: params(encodePoolIdCall(UNIV4_GET_LIQUIDITY_SELECTOR, poolId)) }, signal),
  ]);
  if (slot0.kind !== "returned") return Object.freeze([completion(requestId, slot0)]);
  if (liquidity.kind !== "returned") return Object.freeze([completion(requestId, liquidity)]);
  const sqrtPriceX96 = decodeWords(slot0.dataHex, 4, "univ4Physical.slot0")[0]!;
  const activeLiquidity = decodeWords(liquidity.dataHex, 1, "univ4Physical.liquidity")[0]!;
  if (sqrtPriceX96 === 0n || activeLiquidity === 0n) throw new TypeError("univ4 physical pool is inactive");
  const reserve0 = activeLiquidity * Q96 / sqrtPriceX96;
  const reserve1 = activeLiquidity * sqrtPriceX96 / Q96;
  if (reserve0 === 0n || reserve1 === 0n) throw new TypeError("univ4 physical virtual reserves round to zero");
  return Object.freeze([returned(requestId, `0x${word(reserve0)}${word(reserve1)}`)]);
}

function rehydration(input: FamilyPhysicalLifecycleExecutionV1): readonly FamilyPhysicalTransportResultV1[] {
  const payload = record(input.programInput, "univ4Physical.rehydration");
  assertExactKeys(payload, ["kind", "binding", "cutoff", "readPlan", "requestId", "referenceHash"]);
  if (payload.kind !== "univ4-rehydration-input") throw new TypeError("univ4 physical rehydration kind mismatch");
  exactCutoff(payload, input);
  return Object.freeze([returned(
    assertHash(payload.requestId, "univ4Physical.rehydration.requestId"),
    assertHash(payload.referenceHash, "univ4Physical.rehydration.referenceHash"),
  )]);
}

const ADAPTER: FamilyPhysicalLifecycleAdapterV1 = Object.freeze({
  kind: "aloha.family-physical-lifecycle-adapter",
  version: 1,
  familyId: UNIV4_FAMILY_ID,
  familyDefinitionHash: UNIV4_FAMILY_DEFINITION_HASH,
  async execute(
    input: FamilyPhysicalLifecycleExecutionV1,
    ports: FamilyPhysicalLifecyclePortsV1,
    signal: AbortSignal,
  ) {
    if (input.familyId !== UNIV4_FAMILY_ID || input.familyDefinitionHash !== UNIV4_FAMILY_DEFINITION_HASH) {
      throw new TypeError("univ4 physical release binding mismatch");
    }
    if (input.stage === "nomination") return nomination(input);
    if (input.stage === "identity") return identity(input, ports);
    if (input.stage === "materialization" || input.stage === "projection") return state(input, ports, signal);
    return rehydration(input);
  },
});

export const UNIV4_PHYSICAL_LIFECYCLE_ADAPTER_FACTORY: FamilyPhysicalLifecycleAdapterFactoryV1 = () => ADAPTER;
