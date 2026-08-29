import {
  assertExactKeys,
  assertHash,
  type CanonicalJson,
  type Hash,
} from "../../../../packages/canonical-codec/src/index.ts";
import {
  type FamilyPhysicalLifecycleAdapterFactoryV1,
  type FamilyPhysicalLifecycleAdapterV1,
  type FamilyPhysicalLifecycleExecutionV1,
  type FamilyPhysicalLifecyclePortsV1,
  type FamilyPhysicalRpcCompletionV1,
  type FamilyPhysicalRpcPortV1,
  type FamilyPhysicalTransportResultV1,
} from "../../../../packages/family-sdk/runtime/index.ts";
import { decodeCanonicalCutoff } from "../../../../packages/discovery/src/index.ts";
import { canonicalAddress } from "../kernel/codec.ts";
import {
  UNIV2_FACTORY_SELECTOR,
  UNIV2_GET_PAIR_SELECTOR,
  UNIV2_GET_RESERVES_SELECTOR,
  UNIV2_TOKEN0_SELECTOR,
  UNIV2_TOKEN1_SELECTOR,
} from "../schema/index.ts";
import {
  UNIV2_STANDARD_FAMILY_DEFINITION_HASH,
  UNIV2_STANDARD_FAMILY_ID,
} from "../family-definition.ts";

type RecordValue = Record<string, unknown>;

function record(value: unknown, path: string): RecordValue {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${path} must be an object`);
  }
  return value as RecordValue;
}

function hash(value: unknown, path: string): Hash {
  return assertHash(value, path);
}

function requestIds(value: unknown, expected: number): readonly Hash[] {
  if (!Array.isArray(value) || value.length !== expected) {
    throw new TypeError("univ2 physical request id partition mismatch");
  }
  const ids = value.map((item, index) => hash(item, `univ2Physical.requestIds[${index}]`));
  if (new Set(ids).size !== ids.length) throw new TypeError("univ2 physical request ids are duplicated");
  return Object.freeze(ids);
}

function addressWord(value: string, path: string): string {
  if (!/^0x[0-9a-f]{64}$/.test(value)) throw new TypeError(`${path} must be one ABI word`);
  return canonicalAddress(`0x${value.slice(26)}`);
}

function addressArgument(value: string): string {
  return canonicalAddress(value).slice(2).padStart(64, "0");
}

function returned(requestId: Hash, value: CanonicalJson, path: string): FamilyPhysicalTransportResultV1 {
  if (typeof value !== "string" || !/^0x(?:[0-9a-f]{2})*$/.test(value)) {
    throw new TypeError(`${path} returned non-canonical bytes`);
  }
  return Object.freeze({ kind: "returned" as const, requestId, dataHex: value });
}

function completion(
  requestId: Hash,
  value: FamilyPhysicalRpcCompletionV1,
  path: string,
): FamilyPhysicalTransportResultV1 {
  if (value.kind === "returned") return returned(requestId, value.dataHex, path);
  if (value.kind === "reverted") {
    if (!/^0x(?:[0-9a-f]{2})*$/.test(value.dataHex)) {
      throw new TypeError(`${path} reverted with non-canonical bytes`);
    }
    return Object.freeze({ kind: "reverted" as const, requestId, dataHex: value.dataHex });
  }
  return Object.freeze({ kind: "transportFailure" as const, requestId, failureCode: value.failureCode });
}

function call(
  rpc: FamilyPhysicalRpcPortV1,
  requestId: Hash,
  target: string,
  data: string,
  blockHash: Hash,
  signal: AbortSignal,
): Promise<FamilyPhysicalTransportResultV1> {
  return rpc.request({
    requestId,
    method: "eth_call",
    params: Object.freeze([
      Object.freeze({ to: canonicalAddress(target), data }),
      Object.freeze({ blockHash, requireCanonical: true }),
    ]),
  }, signal).then(value => completion(requestId, value, "univ2 physical eth_call"));
}

async function identity(
  payloadValue: CanonicalJson,
  rpc: FamilyPhysicalRpcPortV1,
  signal: AbortSignal,
): Promise<readonly FamilyPhysicalTransportResultV1[]> {
  const payload = record(payloadValue, "univ2Physical.identity");
  assertExactKeys(payload, ["kind", "nomination", "cutoff", "readPlan", "requestIds", "evidenceRoot"]);
  if (payload.kind !== "family-identity-input") throw new TypeError("univ2 physical identity kind mismatch");
  const nomination = record(payload.nomination, "univ2Physical.identity.nomination");
  const pool = canonicalAddress(String(nomination.pool));
  const cutoff = decodeCanonicalCutoff(payload.cutoff, "univ2Physical.identity.cutoff");
  const ids = requestIds(payload.requestIds, 5);
  const base = await Promise.all([
    call(rpc, ids[0]!, pool, UNIV2_TOKEN0_SELECTOR, cutoff.hash, signal),
    call(rpc, ids[1]!, pool, UNIV2_TOKEN1_SELECTOR, cutoff.hash, signal),
    call(rpc, ids[2]!, pool, UNIV2_FACTORY_SELECTOR, cutoff.hash, signal),
  ]);
  if (base.some(value => value.kind !== "returned")) return Object.freeze(base);
  const token0 = addressWord((base[0] as { readonly dataHex: string }).dataHex, "univ2Physical.token0");
  const token1 = addressWord((base[1] as { readonly dataHex: string }).dataHex, "univ2Physical.token1");
  const factory = addressWord((base[2] as { readonly dataHex: string }).dataHex, "univ2Physical.factory");
  const forward = `${UNIV2_GET_PAIR_SELECTOR}${addressArgument(token0)}${addressArgument(token1)}`;
  const reverse = `${UNIV2_GET_PAIR_SELECTOR}${addressArgument(token1)}${addressArgument(token0)}`;
  const pair = await Promise.all([
    call(rpc, ids[3]!, factory, forward, cutoff.hash, signal),
    call(rpc, ids[4]!, factory, reverse, cutoff.hash, signal),
  ]);
  return Object.freeze([...base, ...pair]);
}

function nestedPool(payload: RecordValue): string {
  if (payload.kind === "family-materialization-input") {
    const identityMemo = record(payload.identity, "univ2Physical.materialization.identity");
    const identity = record(identityMemo.identity, "univ2Physical.materialization.identity.identity");
    const facts = record(identity.facts, "univ2Physical.materialization.identity.identity.facts");
    return canonicalAddress(String(facts.pool));
  }
  if (payload.kind === "family-projection-input") {
    const materialization = record(payload.materialization, "univ2Physical.projection.materialization");
    return canonicalAddress(String(materialization.pool));
  }
  throw new TypeError("univ2 physical reserves payload kind mismatch");
}

async function reserves(
  payloadValue: CanonicalJson,
  rpc: FamilyPhysicalRpcPortV1,
  signal: AbortSignal,
): Promise<readonly FamilyPhysicalTransportResultV1[]> {
  const payload = record(payloadValue, "univ2Physical.reserves");
  const expected = payload.kind === "family-materialization-input"
    ? ["kind", "identity", "cutoff", "readPlan", "requestId"]
    : ["kind", "nomination", "identity", "materialization", "cutoff", "feeBps", "readPlan", "requestId", "evidenceRoot"];
  assertExactKeys(payload, expected);
  const cutoff = decodeCanonicalCutoff(payload.cutoff, "univ2Physical.reserves.cutoff");
  const requestId = hash(payload.requestId, "univ2Physical.reserves.requestId");
  return Object.freeze([
    await call(rpc, requestId, nestedPool(payload), UNIV2_GET_RESERVES_SELECTOR, cutoff.hash, signal),
  ]);
}

function rehydration(payloadValue: CanonicalJson): readonly FamilyPhysicalTransportResultV1[] {
  const payload = record(payloadValue, "univ2Physical.rehydration");
  assertExactKeys(payload, ["kind", "candidate", "cutoff", "priorPublication", "identityMemo", "readPlan", "referenceHash", "requestId"]);
  if (payload.kind !== "univ2-verified-memo-reuse-input") throw new TypeError("univ2 physical rehydration kind mismatch");
  const requestId = hash(payload.requestId, "univ2Physical.rehydration.requestId");
  const referenceHash = hash(payload.referenceHash, "univ2Physical.rehydration.referenceHash");
  return Object.freeze([Object.freeze({ kind: "returned" as const, requestId, dataHex: referenceHash })]);
}

const ADAPTER: FamilyPhysicalLifecycleAdapterV1 = Object.freeze({
  kind: "aloha.family-physical-lifecycle-adapter",
  version: 1,
  familyId: UNIV2_STANDARD_FAMILY_ID,
  familyDefinitionHash: UNIV2_STANDARD_FAMILY_DEFINITION_HASH,
  async execute(
    input: FamilyPhysicalLifecycleExecutionV1,
    ports: FamilyPhysicalLifecyclePortsV1,
    signal: AbortSignal,
  ) {
    if (input.familyId !== UNIV2_STANDARD_FAMILY_ID
      || input.familyDefinitionHash !== UNIV2_STANDARD_FAMILY_DEFINITION_HASH) {
      throw new TypeError("univ2 physical release binding mismatch");
    }
    if (input.stage === "identity") return identity(input.programInput, ports.rpc, signal);
    if (input.stage === "materialization" || input.stage === "projection") {
      return reserves(input.programInput, ports.rpc, signal);
    }
    if (input.stage === "rehydration") return rehydration(input.programInput);
    throw new TypeError("univ2 nomination is owner-only and has no physical program");
  },
});

export const UNIV2_STANDARD_PHYSICAL_LIFECYCLE_ADAPTER_FACTORY: FamilyPhysicalLifecycleAdapterFactoryV1 =
  () => ADAPTER;
