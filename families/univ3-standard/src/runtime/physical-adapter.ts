import {
  assertDecimalString,
  assertExactKeys,
  assertHash,
  decodeCanonicalJson,
  encodeCanonicalBytes,
  encodeCanonicalJson,
  hashDomain,
  type CanonicalJson,
  type Hash,
} from "../../../../packages/canonical-codec/src/index.ts";
import { decodeCanonicalCutoff } from "../../../../packages/discovery/src/index.ts";
import type {
  FamilyPhysicalLifecycleAdapterFactoryV1,
  FamilyPhysicalLifecycleAdapterV1,
  FamilyPhysicalLifecycleExecutionV1,
  FamilyPhysicalLifecyclePortsV1,
  FamilyPhysicalRpcCompletionV1,
  FamilyPhysicalRpcPortV1,
  FamilyPhysicalTransportResultV1,
} from "../../../../packages/family-sdk/runtime/index.ts";
import { UNIV3_STANDARD_FAMILY_AUTHORING_HASH } from "../family-definition.ts";
import { decodeAddressWord } from "../kernel/codec.ts";
import {
  decodeUniV3Fee,
  decodeUniV3Liquidity,
  decodeUniV3Slot0,
  decodeUniV3Tick,
  decodeUniV3TickBitmap,
  decodeUniV3TickSpacing,
  encodeUniV3StateCall,
} from "../search-codec.ts";
import { canonicalAddress } from "../types.ts";
import { UNIV3_STANDARD_FAMILY_ID } from "../manifest.ts";

type RecordValue = Record<string, unknown>;

const IDENTITY_SELECTORS = Object.freeze({
  token0: "0x0dfe1681",
  token1: "0xd21220a7",
  factory: "0xc45a0155",
  fee: "0xddca3f43",
  tickSpacing: "0xd0c93a7c",
  getPool: "0x1698ee82",
});

function record(value: unknown, path: string): RecordValue {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${path} must be an object`);
  }
  return value as RecordValue;
}

function integer(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value)) throw new TypeError(`${path} must be a safe integer`);
  return value as number;
}

function bytes(value: string, path: string): string {
  if (!/^0x(?:[0-9a-f]{2})*$/.test(value)) throw new TypeError(`${path} must be canonical bytes`);
  return value;
}

function word(value: bigint): string {
  if (value < 0n || value >= 1n << 256n) throw new RangeError("univ3 physical ABI word overflow");
  return value.toString(16).padStart(64, "0");
}

function addressWord(value: string): string {
  return canonicalAddress(value).slice(2).padStart(64, "0");
}

function canonicalHex(value: unknown): string {
  const canonical = decodeCanonicalJson(encodeCanonicalJson(value as CanonicalJson));
  return `0x${Array.from(encodeCanonicalBytes(canonical), item => item.toString(16).padStart(2, "0")).join("")}`;
}

function returned(requestId: Hash, value: unknown): FamilyPhysicalTransportResultV1 {
  return Object.freeze({ kind: "returned" as const, requestId, dataHex: canonicalHex(value) });
}

function outward(requestId: Hash, value: FamilyPhysicalRpcCompletionV1): FamilyPhysicalTransportResultV1 {
  if (value.kind === "returned") {
    return Object.freeze({ kind: "returned" as const, requestId, dataHex: bytes(value.dataHex, "univ3 physical returned bytes") });
  }
  if (value.kind === "reverted") {
    return Object.freeze({ kind: "reverted" as const, requestId, dataHex: bytes(value.dataHex, "univ3 physical revert bytes") });
  }
  return Object.freeze({ kind: "transportFailure" as const, requestId, failureCode: value.failureCode });
}

function firstNonReturn(
  requestId: Hash,
  values: readonly FamilyPhysicalRpcCompletionV1[],
): FamilyPhysicalTransportResultV1 | null {
  const value = values.find(item => item.kind !== "returned");
  return value === undefined ? null : outward(requestId, value);
}

function returnedData(value: FamilyPhysicalRpcCompletionV1, path: string): string {
  if (value.kind !== "returned") throw new TypeError(`${path} was not returned`);
  return bytes(value.dataHex, path);
}

function subrequestId(requestId: Hash, operation: string): Hash {
  return hashDomain("aloha/univ3-standard/physical-subrequest/v1", { requestId, operation });
}

function call(
  rpc: FamilyPhysicalRpcPortV1,
  requestId: Hash,
  operation: string,
  target: string,
  data: string,
  blockHash: Hash,
  signal: AbortSignal,
): Promise<FamilyPhysicalRpcCompletionV1> {
  return rpc.request(Object.freeze({
    requestId: subrequestId(requestId, operation),
    method: "eth_call" as const,
    params: Object.freeze([
      Object.freeze({ to: canonicalAddress(target), data: bytes(data, `univ3 physical ${operation} calldata`) }),
      Object.freeze({ blockHash, requireCanonical: true }),
    ]),
  }), signal);
}

function acknowledgement(payloadValue: CanonicalJson, expectedKind: string, factKind: string): readonly FamilyPhysicalTransportResultV1[] {
  const payload = record(payloadValue, `univ3Physical.${expectedKind}`);
  if (payload.kind !== expectedKind) throw new TypeError(`univ3 physical ${expectedKind} kind mismatch`);
  const requestId = assertHash(payload.requestId, `univ3Physical.${expectedKind}.requestId`);
  const value = expectedKind === "univ3-nomination-input"
    ? assertHash(record(payload.candidate, "univ3Physical.nomination.candidate").candidateSubjectHash, "univ3Physical.nomination.candidateSubjectHash")
    : assertHash(payload.referenceHash, "univ3Physical.rehydration.referenceHash");
  return Object.freeze([returned(requestId, { kind: factKind, version: 1, value })]);
}

async function identity(
  payloadValue: CanonicalJson,
  rpc: FamilyPhysicalRpcPortV1,
  signal: AbortSignal,
): Promise<readonly FamilyPhysicalTransportResultV1[]> {
  const payload = record(payloadValue, "univ3Physical.identity");
  assertExactKeys(payload, ["kind", "candidate", "cutoff", "readPlan", "requestId"]);
  if (payload.kind !== "univ3-identity-input") throw new TypeError("univ3 physical identity kind mismatch");
  const candidate = record(payload.candidate, "univ3Physical.identity.candidate");
  const pool = canonicalAddress(String(candidate.instanceNominationKey));
  const snapshot = assertHash(candidate.candidateSubjectHash, "univ3Physical.identity.candidateSubjectHash");
  const cutoff = decodeCanonicalCutoff(payload.cutoff, "univ3Physical.identity.cutoff");
  const requestId = assertHash(payload.requestId, "univ3Physical.identity.requestId");
  const base = await Promise.all([
    call(rpc, requestId, "token0", pool, IDENTITY_SELECTORS.token0, cutoff.hash, signal),
    call(rpc, requestId, "token1", pool, IDENTITY_SELECTORS.token1, cutoff.hash, signal),
    call(rpc, requestId, "factory", pool, IDENTITY_SELECTORS.factory, cutoff.hash, signal),
    call(rpc, requestId, "fee", pool, IDENTITY_SELECTORS.fee, cutoff.hash, signal),
    call(rpc, requestId, "tick-spacing", pool, IDENTITY_SELECTORS.tickSpacing, cutoff.hash, signal),
  ]);
  const baseFailure = firstNonReturn(requestId, base);
  if (baseFailure !== null) return Object.freeze([baseFailure]);
  const token0 = decodeAddressWord(returnedData(base[0]!, "univ3 physical token0"));
  const token1 = decodeAddressWord(returnedData(base[1]!, "univ3 physical token1"));
  const factory = decodeAddressWord(returnedData(base[2]!, "univ3 physical factory"));
  const fee = decodeUniV3Fee(returnedData(base[3]!, "univ3 physical fee"));
  const tickSpacing = decodeUniV3TickSpacing(returnedData(base[4]!, "univ3 physical tick spacing"));
  const reverse = await call(
    rpc,
    requestId,
    "factory-get-pool",
    factory,
    `${IDENTITY_SELECTORS.getPool}${addressWord(token0)}${addressWord(token1)}${word(fee)}`,
    cutoff.hash,
    signal,
  );
  if (reverse.kind !== "returned") return Object.freeze([outward(requestId, reverse)]);
  return Object.freeze([returned(requestId, {
    kind: "univ3-identity-facts",
    version: 1,
    candidateSnapshotHash: snapshot,
    reads: {
      cutoff,
      pool,
      factory,
      token0,
      token1,
      fee: fee.toString(),
      tickSpacing,
      reversePool: decodeAddressWord(bytes(reverse.dataHex, "univ3 physical reverse pool")),
    },
  })]);
}

function stateSubject(payload: RecordValue): Readonly<{
  pool: string;
  fee: string;
  tickSpacing: number;
}> {
  const memo = record(payload.identityMemo, "univ3Physical.state.identityMemo");
  const identity = record(memo.identity, "univ3Physical.state.identityMemo.identity");
  const facts = record(identity.facts, "univ3Physical.state.identityMemo.identity.facts");
  return Object.freeze({
    pool: canonicalAddress(String(identity.instanceKey)),
    fee: assertDecimalString(facts.fee, "univ3Physical.state.identity.fee"),
    tickSpacing: integer(facts.tickSpacing, "univ3Physical.state.identity.tickSpacing"),
  });
}

async function state(
  payloadValue: CanonicalJson,
  rpc: FamilyPhysicalRpcPortV1,
  signal: AbortSignal,
): Promise<readonly FamilyPhysicalTransportResultV1[]> {
  const payload = record(payloadValue, "univ3Physical.state");
  const expected = payload.kind === "univ3-materialization-input"
    ? ["kind", "identityMemo", "cutoff", "readPlan", "requestId"]
    : ["kind", "identityMemo", "materialization", "cutoff", "readPlan", "requestId"];
  assertExactKeys(payload, expected);
  if (payload.kind !== "univ3-materialization-input" && payload.kind !== "univ3-projection-input") {
    throw new TypeError("univ3 physical state kind mismatch");
  }
  const cutoff = decodeCanonicalCutoff(payload.cutoff, "univ3Physical.state.cutoff");
  const requestId = assertHash(payload.requestId, "univ3Physical.state.requestId");
  const subject = stateSubject(payload);
  const baseCalls = [
    ["slot0", encodeUniV3StateCall("slot0", subject.pool)],
    ["liquidity", encodeUniV3StateCall("liquidity", subject.pool)],
    ["fee", encodeUniV3StateCall("fee", subject.pool)],
    ["tick-spacing", encodeUniV3StateCall("tickSpacing", subject.pool)],
  ] as const;
  const base = await Promise.all(baseCalls.map(([operation, request]) =>
    call(rpc, requestId, operation, request.target, request.data, cutoff.hash, signal)));
  const baseFailure = firstNonReturn(requestId, base);
  if (baseFailure !== null) return Object.freeze([baseFailure]);
  const slot0 = decodeUniV3Slot0(returnedData(base[0]!, "univ3 physical slot0"));
  const liquidity = decodeUniV3Liquidity(returnedData(base[1]!, "univ3 physical liquidity"));
  const fee = decodeUniV3Fee(returnedData(base[2]!, "univ3 physical fee"));
  const tickSpacing = decodeUniV3TickSpacing(returnedData(base[3]!, "univ3 physical tick spacing"));
  if (fee.toString() !== subject.fee || tickSpacing !== subject.tickSpacing) {
    throw new TypeError("univ3 physical static state binding changed");
  }
  const compressed = Math.floor(slot0.tick / tickSpacing);
  const wordIndex = Math.floor(compressed / 256);
  const bitmapRequest = encodeUniV3StateCall("tickBitmap", subject.pool, wordIndex);
  const bitmapCompletion = await call(rpc, requestId, `tick-bitmap:${wordIndex}`, bitmapRequest.target, bitmapRequest.data, cutoff.hash, signal);
  if (bitmapCompletion.kind !== "returned") return Object.freeze([outward(requestId, bitmapCompletion)]);
  const bitmap = decodeUniV3TickBitmap(bytes(bitmapCompletion.dataHex, "univ3 physical tick bitmap"));
  const initializedTicks: number[] = [];
  for (let bit = 0; bit < 256; bit += 1) {
    if ((bitmap & (1n << BigInt(bit))) === 0n) continue;
    const tick = (wordIndex * 256 + bit) * tickSpacing;
    if (tick >= -887272 && tick <= 887272) initializedTicks.push(tick);
  }
  const tickCompletions = await Promise.all(initializedTicks.map(tick => {
    const request = encodeUniV3StateCall("ticks", subject.pool, tick);
    return call(rpc, requestId, `tick:${tick}`, request.target, request.data, cutoff.hash, signal);
  }));
  const tickFailure = firstNonReturn(requestId, tickCompletions);
  if (tickFailure !== null) return Object.freeze([tickFailure]);
  const ticks = Object.freeze(tickCompletions.map((completion, index) => {
    const decoded = decodeUniV3Tick(returnedData(completion, `univ3 physical tick ${initializedTicks[index]}`));
    if (!decoded.initialized) throw new TypeError(`univ3 physical bitmap tick is not initialized ${initializedTicks[index]}`);
    return Object.freeze({ tick: initializedTicks[index]!, liquidityNet: decoded.liquidityNet.toString() });
  }));
  return Object.freeze([returned(requestId, {
    kind: "univ3-state-facts",
    version: 1,
    read: {
      cutoff,
      pool: subject.pool,
      sqrtPriceX96: slot0.sqrtPriceX96.toString(),
      tick: slot0.tick,
      liquidity: liquidity.toString(),
      fee: fee.toString(),
      tickSpacing,
      tickBitmap: [Object.freeze({ word: wordIndex, bits: bitmap.toString() })],
      ticks,
    },
  })]);
}

const ADAPTER: FamilyPhysicalLifecycleAdapterV1 = Object.freeze({
  kind: "aloha.family-physical-lifecycle-adapter",
  version: 1,
  familyId: UNIV3_STANDARD_FAMILY_ID,
  familyDefinitionHash: UNIV3_STANDARD_FAMILY_AUTHORING_HASH,
  async execute(
    input: FamilyPhysicalLifecycleExecutionV1,
    ports: FamilyPhysicalLifecyclePortsV1,
    signal: AbortSignal,
  ) {
    if (input.familyId !== UNIV3_STANDARD_FAMILY_ID
      || input.familyDefinitionHash !== UNIV3_STANDARD_FAMILY_AUTHORING_HASH) {
      throw new TypeError("univ3 physical release binding mismatch");
    }
    if (input.stage === "nomination") {
      return acknowledgement(input.programInput, "univ3-nomination-input", "univ3-nomination-facts");
    }
    if (input.stage === "identity") return identity(input.programInput, ports.rpc, signal);
    if (input.stage === "materialization" || input.stage === "projection") {
      return state(input.programInput, ports.rpc, signal);
    }
    return acknowledgement(input.programInput, "univ3-rehydration-input", "univ3-rehydration-facts");
  },
});

export const UNIV3_STANDARD_PHYSICAL_LIFECYCLE_ADAPTER_FACTORY: FamilyPhysicalLifecycleAdapterFactoryV1 =
  () => ADAPTER;
