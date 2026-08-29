import {
  assertExactKeys,
  assertHash,
  sha256Hex,
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
import { decodeConstantsView, decodeUint256, encodeConstantsView, encodeSwapInCall } from "../abi.ts";
import { FLUID_DEX_FAMILY_DEFINITION_HASH } from "../family-definition.ts";
import { FLUID_DEX_FACTORY, FLUID_DEX_FAMILY_ID } from "../manifest.ts";
import { canonicalAddress } from "../types.ts";

type RecordValue = Record<string, unknown>;
const GET_DEX_ADDRESS_SELECTOR = "0x12e366aa";
const PROBE_RECIPIENT = "0x000000000000000000000000000000000000dead";
const PROBE_AMOUNT = 10n ** 18n;

function record(value: unknown, path: string): RecordValue {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${path} must be an object`);
  return value as RecordValue;
}

function word(value: bigint): string {
  if (value < 0n || value >= 1n << 256n) throw new TypeError("fluid-dex physical word is outside uint256");
  return value.toString(16).padStart(64, "0");
}

function addressWord(value: string): string {
  return `0x${canonicalAddress(value).slice(2).padStart(64, "0")}`;
}

function rawBytes(value: Uint8Array): string {
  return `0x${Array.from(value, byte => byte.toString(16).padStart(2, "0")).join("")}`;
}

function returned(requestId: Hash, dataHex: string): FamilyPhysicalTransportResultV1 {
  if (!/^0x(?:[0-9a-f]{2})*$/.test(dataHex)) throw new TypeError("fluid-dex physical returned non-canonical bytes");
  return Object.freeze({ kind: "returned" as const, requestId, dataHex });
}

function completion(requestId: Hash, value: FamilyPhysicalRpcCompletionV1): FamilyPhysicalTransportResultV1 {
  if (value.kind === "returned") return returned(requestId, value.dataHex);
  if (value.kind === "reverted") return Object.freeze({ kind: "reverted" as const, requestId, dataHex: value.dataHex });
  return Object.freeze({ kind: "transportFailure" as const, requestId, failureCode: value.failureCode });
}

function exactCutoff(payload: RecordValue, input: FamilyPhysicalLifecycleExecutionV1) {
  const cutoff = decodeCanonicalCutoff(payload.cutoff, "fluidDexPhysical.cutoff");
  if (cutoff.chainId !== input.source.chainId || cutoff.number !== input.source.number
    || cutoff.hash !== input.source.hash || cutoff.stateRoot !== input.source.stateRoot) {
    throw new TypeError("fluid-dex physical source mismatch");
  }
  return cutoff;
}

function candidate(payload: RecordValue): RecordValue {
  const binding = record(payload.binding, "fluidDexPhysical.binding");
  return record(binding.candidate, "fluidDexPhysical.binding.candidate");
}

function nomination(input: FamilyPhysicalLifecycleExecutionV1): readonly FamilyPhysicalTransportResultV1[] {
  const payload = record(input.programInput, "fluidDexPhysical.nomination");
  assertExactKeys(payload, ["kind", "binding", "cutoff", "readPlan", "requestId"]);
  if (payload.kind !== "fluid-dex-nomination-input") throw new TypeError("fluid-dex physical nomination kind mismatch");
  exactCutoff(payload, input);
  return Object.freeze([returned(
    assertHash(payload.requestId, "fluidDexPhysical.nomination.requestId"),
    assertHash(candidate(payload).candidateSnapshotHash, "fluidDexPhysical.nomination.candidateSnapshotHash"),
  )]);
}

async function call(
  ports: FamilyPhysicalLifecyclePortsV1,
  requestId: Hash,
  target: string,
  data: string,
  blockHash: Hash,
  signal: AbortSignal,
): Promise<FamilyPhysicalRpcCompletionV1> {
  return ports.rpc.request({
    requestId,
    method: "eth_call",
    params: Object.freeze([
      Object.freeze({ to: canonicalAddress(target), data }),
      Object.freeze({ blockHash, requireCanonical: true }),
    ]),
  }, signal);
}

async function identity(
  input: FamilyPhysicalLifecycleExecutionV1,
  ports: FamilyPhysicalLifecyclePortsV1,
  signal: AbortSignal,
): Promise<readonly FamilyPhysicalTransportResultV1[]> {
  const payload = record(input.programInput, "fluidDexPhysical.identity");
  assertExactKeys(payload, ["kind", "binding", "cutoff", "readPlan", "requestIds"]);
  if (payload.kind !== "fluid-dex-identity-input") throw new TypeError("fluid-dex physical identity kind mismatch");
  const cutoff = exactCutoff(payload, input);
  if (!Array.isArray(payload.requestIds) || payload.requestIds.length !== 5) throw new TypeError("fluid-dex physical identity partition mismatch");
  const ids = payload.requestIds.map((value, index) => assertHash(value, `fluidDexPhysical.identity.requestIds[${index}]`));
  const pool = canonicalAddress(String(candidate(payload).target));
  const constants = await call(ports, ids[2]!, pool, encodeConstantsView(), cutoff.hash, signal);
  if (constants.kind !== "returned") return Object.freeze([completion(ids[2]!, constants)]);
  const decoded = decodeConstantsView(constants.dataHex, "fluidDexPhysical.constantsView");
  const reverse = await call(
    ports,
    ids[1]!,
    FLUID_DEX_FACTORY,
    `${GET_DEX_ADDRESS_SELECTOR}${word(decoded.dexId)}`,
    cutoff.hash,
    signal,
  );
  if (reverse.kind !== "returned") return Object.freeze([completion(ids[1]!, reverse)]);
  const evidence = record(candidate(payload).evidence, "fluidDexPhysical.identity.candidate.evidence");
  const rawLocatorHash = assertHash(evidence.rawLocatorHash, "fluidDexPhysical.identity.rawLocatorHash");
  const raw = ports.rawEvidence.read(rawLocatorHash);
  if (sha256Hex(raw) !== rawLocatorHash) throw new TypeError("fluid-dex physical raw evidence hash mismatch");
  return Object.freeze([
    returned(ids[0]!, addressWord(pool)),
    returned(ids[1]!, reverse.dataHex),
    returned(ids[2]!, addressWord(decoded.token0)),
    returned(ids[3]!, addressWord(decoded.token1)),
    returned(ids[4]!, rawBytes(raw)),
  ]);
}

function statePool(payload: RecordValue): string {
  const memo = record(payload.identityMemo, "fluidDexPhysical.state.identityMemo");
  const identity = record(memo.identity, "fluidDexPhysical.state.identity");
  return canonicalAddress(String(identity.instanceKey));
}

async function state(
  input: FamilyPhysicalLifecycleExecutionV1,
  ports: FamilyPhysicalLifecyclePortsV1,
  signal: AbortSignal,
): Promise<readonly FamilyPhysicalTransportResultV1[]> {
  const payload = record(input.programInput, "fluidDexPhysical.state");
  const expected = payload.kind === "fluid-dex-materialization-input"
    ? ["kind", "binding", "identityMemo", "cutoff", "readPlan", "requestId"]
    : ["kind", "binding", "identityMemo", "materialization", "cutoff", "readPlan", "requestId"];
  assertExactKeys(payload, expected);
  const cutoff = exactCutoff(payload, input);
  const requestId = assertHash(payload.requestId, "fluidDexPhysical.state.requestId");
  const quote = await call(
    ports,
    requestId,
    statePool(payload),
    encodeSwapInCall(true, PROBE_AMOUNT.toString(10), "0", PROBE_RECIPIENT),
    cutoff.hash,
    signal,
  );
  if (quote.kind !== "returned") return Object.freeze([completion(requestId, quote)]);
  const amountOut = decodeUint256(quote.dataHex, "fluidDexPhysical.swapIn");
  if (amountOut === 0n) throw new TypeError("fluid-dex physical quote returned zero");
  return Object.freeze([returned(requestId, `0x${word(PROBE_AMOUNT)}${word(amountOut)}`)]);
}

function rehydration(input: FamilyPhysicalLifecycleExecutionV1): readonly FamilyPhysicalTransportResultV1[] {
  const payload = record(input.programInput, "fluidDexPhysical.rehydration");
  assertExactKeys(payload, ["kind", "binding", "cutoff", "readPlan", "requestId", "referenceHash"]);
  if (payload.kind !== "fluid-dex-rehydration-input") throw new TypeError("fluid-dex physical rehydration kind mismatch");
  exactCutoff(payload, input);
  return Object.freeze([returned(
    assertHash(payload.requestId, "fluidDexPhysical.rehydration.requestId"),
    assertHash(payload.referenceHash, "fluidDexPhysical.rehydration.referenceHash"),
  )]);
}

const ADAPTER: FamilyPhysicalLifecycleAdapterV1 = Object.freeze({
  kind: "aloha.family-physical-lifecycle-adapter",
  version: 1,
  familyId: FLUID_DEX_FAMILY_ID,
  familyDefinitionHash: FLUID_DEX_FAMILY_DEFINITION_HASH,
  async execute(
    input: FamilyPhysicalLifecycleExecutionV1,
    ports: FamilyPhysicalLifecyclePortsV1,
    signal: AbortSignal,
  ) {
    if (input.familyId !== FLUID_DEX_FAMILY_ID || input.familyDefinitionHash !== FLUID_DEX_FAMILY_DEFINITION_HASH) {
      throw new TypeError("fluid-dex physical release binding mismatch");
    }
    if (input.stage === "nomination") return nomination(input);
    if (input.stage === "identity") return identity(input, ports, signal);
    if (input.stage === "materialization" || input.stage === "projection") return state(input, ports, signal);
    return rehydration(input);
  },
});

export const FLUID_DEX_PHYSICAL_LIFECYCLE_ADAPTER_FACTORY: FamilyPhysicalLifecycleAdapterFactoryV1 = () => ADAPTER;
