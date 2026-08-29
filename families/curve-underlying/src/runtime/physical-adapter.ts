import {
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
import {
  type FamilyPhysicalLifecycleAdapterFactoryV1,
  type FamilyPhysicalLifecycleAdapterV1,
  type FamilyPhysicalLifecycleExecutionV1,
  type FamilyPhysicalLifecyclePortsV1,
  type FamilyPhysicalRpcCompletionV1,
  type FamilyPhysicalRpcPortV1,
  type FamilyPhysicalTransportResultV1,
} from "../../../../packages/family-sdk/runtime/index.ts";
import {
  CURVE_UNDERLYING_FAMILY_AUTHORING_HASH,
} from "../family-definition.ts";
import { CURVE_METAREGISTRY, CURVE_UNDERLYING_FAMILY_ID, CURVE_UNDERLYING_I128_GET_DY_SELECTOR, CURVE_UNDERLYING_UINT_GET_DY_SELECTOR } from "../manifest.ts";
import { canonicalAddress, type CurveSelectorVariantV1 } from "../types.ts";

type RecordValue = Record<string, unknown>;

const SELECTORS = Object.freeze({
  handlers: "0x308d1b6d",
  coins: "0xa77576ef",
  decimals: "0x4cb088f1",
  balances: "0x59f4f351",
  getDyUnderlying: CURVE_UNDERLYING_I128_GET_DY_SELECTOR,
  getDyUnderlyingUint: CURVE_UNDERLYING_UINT_GET_DY_SELECTOR,
  amplification: "0xf446c1d0",
  fee: "0xddca3f43",
  offpegFeeMultiplier: "0x8edfdd5f",
  storedRates: "0xfd0684b1",
});
const BEHAVIOR_PROBE_AMOUNTS = Object.freeze([1n, 1_000_000n, 1_000_000_000_000_000_000n]);
const ZERO_ADDRESS = `0x${"0".repeat(40)}`;

function record(value: unknown, path: string): RecordValue {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${path} must be an object`);
  }
  return value as RecordValue;
}

function bytes(value: CanonicalJson, path: string): string {
  if (typeof value !== "string" || !/^0x(?:[0-9a-f]{2})*$/.test(value)) {
    throw new TypeError(`${path} returned non-canonical bytes`);
  }
  return value;
}

function word(value: bigint): string {
  if (value < 0n || value >= 1n << 256n) throw new RangeError("curve physical ABI word overflow");
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

function oneWord(value: string, path: string): bigint {
  return exactWords(value, 1, path)[0]!;
}

function dynamicWords(value: string, path: string): readonly bigint[] {
  if (!/^0x(?:[0-9a-f]{64})+$/.test(value)) throw new TypeError(`${path} ABI result mismatch`);
  const values = exactWords(value, (value.length - 2) / 64, path);
  if (values.length < 2 || values[0] !== 32n || values[1]! > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new TypeError(`${path} ABI dynamic array header mismatch`);
  }
  const count = Number(values[1]!);
  if (values.length !== count + 2) throw new TypeError(`${path} ABI dynamic array length mismatch`);
  return Object.freeze(values.slice(2));
}

function addressArray(value: string, count: number, path: string): readonly string[] {
  const output: string[] = [];
  let terminated = false;
  for (const valueWord of exactWords(value, count, path)) {
    if (valueWord > (1n << 160n) - 1n) throw new TypeError(`${path} contains a non-address word`);
    const decoded = canonicalAddress(`0x${valueWord.toString(16).padStart(40, "0")}`);
    if (decoded === ZERO_ADDRESS) {
      terminated = true;
      continue;
    }
    if (terminated) throw new TypeError(`${path} contains a non-zero trailing entry`);
    output.push(decoded);
  }
  return Object.freeze(output);
}

function canonicalHex(bytesValue: Uint8Array): string {
  return `0x${Array.from(bytesValue, value => value.toString(16).padStart(2, "0")).join("")}`;
}

function returned(requestId: Hash, value: unknown): FamilyPhysicalTransportResultV1 {
  const canonical = decodeCanonicalJson(encodeCanonicalJson(value));
  return Object.freeze({ kind: "returned" as const, requestId, dataHex: canonicalHex(encodeCanonicalBytes(canonical)) });
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
  return hashDomain("aloha/curve-underlying/physical-subrequest/v1", { requestId, operation });
}

async function ethCall(
  rpc: FamilyPhysicalRpcPortV1,
  requestId: Hash,
  operation: string,
  target: string,
  data: string,
  blockHash: Hash,
  signal: AbortSignal,
): Promise<FamilyPhysicalRpcCompletionV1> {
  const completion = await rpc.request({
    requestId: subrequestId(requestId, operation),
    method: "eth_call",
    params: Object.freeze([
      Object.freeze({ to: canonicalAddress(target), data }),
      Object.freeze({ blockHash, requireCanonical: true }),
    ]),
  }, signal);
  if (completion.kind === "returned" || completion.kind === "reverted") {
    bytes(completion.dataHex, `curve physical ${operation}`);
  }
  return completion;
}

async function getCode(
  rpc: FamilyPhysicalRpcPortV1,
  requestId: Hash,
  target: string,
  blockHash: Hash,
  signal: AbortSignal,
): Promise<FamilyPhysicalRpcCompletionV1> {
  const completion = await rpc.request({
    requestId: subrequestId(requestId, "pool-code"),
    method: "eth_getCode",
    params: Object.freeze([
      canonicalAddress(target),
      Object.freeze({ blockHash, requireCanonical: true }),
    ]),
  }, signal);
  if (completion.kind === "returned" || completion.kind === "reverted") {
    bytes(completion.dataHex, "curve physical pool-code");
  }
  return completion;
}

function candidateSubject(payload: RecordValue): { readonly pool: string; readonly snapshot: Hash } {
  const candidate = record(payload.candidate, "curvePhysical.candidate");
  return Object.freeze({
    pool: canonicalAddress(String(candidate.instanceNominationKey)),
    snapshot: assertHash(candidate.candidateSubjectHash, "curvePhysical.candidate.candidateSubjectHash"),
  });
}

async function identity(
  payloadValue: CanonicalJson,
  rpc: FamilyPhysicalRpcPortV1,
  signal: AbortSignal,
): Promise<readonly FamilyPhysicalTransportResultV1[]> {
  const payload = record(payloadValue, "curvePhysical.identity");
  assertExactKeys(payload, ["kind", "candidate", "cutoff", "readPlan", "requestId"]);
  if (payload.kind !== "curve-underlying-identity-input") throw new TypeError("curve physical identity kind mismatch");
  const cutoff = decodeCanonicalCutoff(payload.cutoff, "curvePhysical.identity.cutoff");
  const requestId = assertHash(payload.requestId, "curvePhysical.identity.requestId");
  const { pool, snapshot } = candidateSubject(payload);
  const argument = addressArgument(pool);
  const base = await Promise.all([
    ethCall(rpc, requestId, "registry-handlers", CURVE_METAREGISTRY, `${SELECTORS.handlers}${argument}`, cutoff.hash, signal),
    ethCall(rpc, requestId, "underlying-coins", CURVE_METAREGISTRY, `${SELECTORS.coins}${argument}`, cutoff.hash, signal),
    ethCall(rpc, requestId, "underlying-decimals", CURVE_METAREGISTRY, `${SELECTORS.decimals}${argument}`, cutoff.hash, signal),
    getCode(rpc, requestId, pool, cutoff.hash, signal),
  ]);
  const baseFailure = base.find(value => value.kind !== "returned");
  if (baseFailure !== undefined) {
    return Object.freeze([rebound(requestId, baseFailure)]);
  }
  const [handlersRaw, coinsRaw, decimalsRaw, code] = base.map(value =>
    (value as Extract<FamilyPhysicalRpcCompletionV1, { readonly kind: "returned" }>).dataHex);
  const handlers = addressArray(handlersRaw, 10, "curve physical handlers");
  const underlyingCoins = addressArray(coinsRaw, 8, "curve physical coins");
  const rawDecimals = exactWords(decimalsRaw, 8, "curve physical decimals");
  const underlyingDecimals = Object.freeze(rawDecimals.slice(0, underlyingCoins.length).map((value, index) => {
    if (value > 36n) throw new TypeError(`curve physical decimals[${index}] exceeds 36`);
    return Number(value);
  }));
  const verifiedDirections: { readonly i: number; readonly j: number; readonly selectorVariant: CurveSelectorVariantV1; readonly amountIn: string; readonly amountOut: string }[] = [];
  for (let i = 0; i < underlyingCoins.length; i += 1) {
    for (let j = 0; j < underlyingCoins.length; j += 1) {
      if (i === j) continue;
      let witness: { readonly i: number; readonly j: number; readonly selectorVariant: CurveSelectorVariantV1; readonly amountIn: string; readonly amountOut: string } | null = null;
      for (let probe = 0; probe < BEHAVIOR_PROBE_AMOUNTS.length; probe += 1) {
        const amountIn = BEHAVIOR_PROBE_AMOUNTS[probe]!;
        const data = `${SELECTORS.getDyUnderlying}${word(BigInt(i))}${word(BigInt(j))}${word(amountIn)}`;
        let completion = await ethCall(rpc, requestId, `get-dy-int128:${i}:${j}:${probe}`, pool, data, cutoff.hash, signal);
        if (completion.kind === "transportFailure") return Object.freeze([rebound(requestId, completion)]);
        let selectorVariant: CurveSelectorVariantV1 = "int128";
        if (completion.kind === "reverted") {
          selectorVariant = "uint256";
          completion = await ethCall(
            rpc,
            requestId,
            `get-dy-uint256:${i}:${j}:${probe}`,
            pool,
            `${SELECTORS.getDyUnderlyingUint}${word(BigInt(i))}${word(BigInt(j))}${word(amountIn)}`,
            cutoff.hash,
            signal,
          );
          if (completion.kind === "transportFailure") return Object.freeze([rebound(requestId, completion)]);
          if (completion.kind === "reverted") continue;
        }
        const amountOut = oneWord(completion.dataHex, `curve physical get-dy:${i}:${j}:${probe}`);
        if (amountOut > 0n && witness === null) {
          witness = Object.freeze({ i, j, selectorVariant, amountIn: amountIn.toString(), amountOut: amountOut.toString() });
        }
      }
      if (witness !== null) verifiedDirections.push(witness);
    }
  }
  return Object.freeze([returned(requestId, {
    kind: "curve-underlying-identity-facts",
    version: 1,
    candidateSnapshotHash: snapshot,
    reads: {
      cutoff,
      pool,
      metaRegistry: CURVE_METAREGISTRY,
      registryPool: handlers.length === 0 ? ZERO_ADDRESS : pool,
      poolHasCode: code !== "0x",
      handlers,
      underlyingCoins,
      underlyingDecimals,
      verifiedDirections,
    },
  })]);
}

function stateSubject(payload: RecordValue): { readonly pool: string; readonly decimals: readonly number[] } {
  const identityMemo = record(payload.identityMemo, "curvePhysical.state.identityMemo");
  const identity = record(identityMemo.identity, "curvePhysical.state.identityMemo.identity");
  const facts = record(identity.facts, "curvePhysical.state.identityMemo.identity.facts");
  if (!Array.isArray(facts.underlyingDecimals)) throw new TypeError("curve physical identity decimals missing");
  const decimals = facts.underlyingDecimals.map((value, index) => {
    if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > 36) {
      throw new TypeError(`curve physical identity decimals[${index}] invalid`);
    }
    return value as number;
  });
  return Object.freeze({ pool: canonicalAddress(String(identity.instanceKey)), decimals: Object.freeze(decimals) });
}

async function state(
  payloadValue: CanonicalJson,
  rpc: FamilyPhysicalRpcPortV1,
  signal: AbortSignal,
): Promise<readonly FamilyPhysicalTransportResultV1[]> {
  const payload = record(payloadValue, "curvePhysical.state");
  const expected = payload.kind === "curve-underlying-materialization-input"
    ? ["kind", "identityMemo", "cutoff", "readPlan", "requestId"]
    : ["kind", "identityMemo", "materialization", "cutoff", "readPlan", "requestId"];
  assertExactKeys(payload, expected);
  if (payload.kind !== "curve-underlying-materialization-input" && payload.kind !== "curve-underlying-projection-input") {
    throw new TypeError("curve physical state kind mismatch");
  }
  const cutoff = decodeCanonicalCutoff(payload.cutoff, "curvePhysical.state.cutoff");
  const requestId = assertHash(payload.requestId, "curvePhysical.state.requestId");
  const { pool, decimals } = stateSubject(payload);
  const argument = addressArgument(pool);
  const completions = await Promise.all([
    ethCall(rpc, requestId, "amplification", pool, SELECTORS.amplification, cutoff.hash, signal),
    ethCall(rpc, requestId, "fee", pool, SELECTORS.fee, cutoff.hash, signal),
    ethCall(rpc, requestId, "underlying-balances", CURVE_METAREGISTRY, `${SELECTORS.balances}${argument}`, cutoff.hash, signal),
    ethCall(rpc, requestId, "offpeg-fee-multiplier", pool, SELECTORS.offpegFeeMultiplier, cutoff.hash, signal),
  ]);
  const transportFailure = completions.find(value => value.kind === "transportFailure");
  if (transportFailure?.kind === "transportFailure") {
    return Object.freeze([rebound(requestId, transportFailure)]);
  }
  const requiredRevert = completions.slice(0, 3).find(value => value.kind === "reverted");
  if (requiredRevert?.kind === "reverted") return Object.freeze([rebound(requestId, requiredRevert)]);
  const amplificationRaw = (completions[0] as Extract<FamilyPhysicalRpcCompletionV1, { readonly kind: "returned" }>).dataHex;
  const feeRaw = (completions[1] as Extract<FamilyPhysicalRpcCompletionV1, { readonly kind: "returned" }>).dataHex;
  const balancesRaw = (completions[2] as Extract<FamilyPhysicalRpcCompletionV1, { readonly kind: "returned" }>).dataHex;
  const offpeg = completions[3]!;
  const balanceWords = exactWords(balancesRaw, 8, "curve physical balances");
  if (balanceWords.slice(decimals.length).some(value => value !== 0n)) {
    throw new TypeError("curve physical balances contain a non-zero trailing entry");
  }
  const balances = Object.freeze(balanceWords.slice(0, decimals.length).map(value => value.toString()));
  let rates: readonly string[];
  if (offpeg.kind === "returned") {
    const stored = await ethCall(rpc, requestId, "stored-rates", pool, SELECTORS.storedRates, cutoff.hash, signal);
    if (stored.kind !== "returned") return Object.freeze([rebound(requestId, stored)]);
    const storedValues = dynamicWords(stored.dataHex, "curve physical stored rates");
    if (storedValues.length < decimals.length || storedValues.slice(decimals.length).some(value => value !== 0n)) {
      throw new TypeError("curve physical stored rates domain mismatch");
    }
    rates = Object.freeze(storedValues.slice(0, decimals.length).map(value => value.toString()));
  } else {
    rates = Object.freeze(decimals.map(value => (10n ** BigInt(36 - value)).toString()));
  }
  const common = {
    cutoff,
    pool,
    variant: offpeg.kind === "returned" ? "ng" : "plain",
    A: oneWord(amplificationRaw, "curve physical A").toString(),
    fee: oneWord(feeRaw, "curve physical fee").toString(),
    balances,
    rates,
  };
  return Object.freeze([returned(requestId, {
    kind: "curve-underlying-state-facts",
    version: 1,
    read: offpeg.kind === "returned"
      ? { ...common, offpegFeeMultiplier: oneWord(offpeg.dataHex, "curve physical offpeg fee multiplier").toString() }
      : common,
  })]);
}

function rehydration(payloadValue: CanonicalJson): readonly FamilyPhysicalTransportResultV1[] {
  const payload = record(payloadValue, "curvePhysical.rehydration");
  assertExactKeys(payload, ["kind", "candidate", "cutoff", "priorPublication", "identityMemo", "readPlan", "referenceHash", "requestId"]);
  if (payload.kind !== "curve-underlying-rehydration-input") throw new TypeError("curve physical rehydration kind mismatch");
  return Object.freeze([returned(
    assertHash(payload.requestId, "curvePhysical.rehydration.requestId"),
    assertHash(payload.referenceHash, "curvePhysical.rehydration.referenceHash"),
  )]);
}

const ADAPTER: FamilyPhysicalLifecycleAdapterV1 = Object.freeze({
  kind: "aloha.family-physical-lifecycle-adapter",
  version: 1,
  familyId: CURVE_UNDERLYING_FAMILY_ID,
  familyDefinitionHash: CURVE_UNDERLYING_FAMILY_AUTHORING_HASH,
  async execute(
    input: FamilyPhysicalLifecycleExecutionV1,
    ports: FamilyPhysicalLifecyclePortsV1,
    signal: AbortSignal,
  ) {
    if (input.familyId !== CURVE_UNDERLYING_FAMILY_ID
      || input.familyDefinitionHash !== CURVE_UNDERLYING_FAMILY_AUTHORING_HASH) {
      throw new TypeError("curve physical release binding mismatch");
    }
    if (input.stage === "identity") return identity(input.programInput, ports.rpc, signal);
    if (input.stage === "materialization" || input.stage === "projection") return state(input.programInput, ports.rpc, signal);
    if (input.stage === "rehydration") return rehydration(input.programInput);
    throw new TypeError("curve nomination is owner-only and has no physical program");
  },
});

export const CURVE_UNDERLYING_PHYSICAL_LIFECYCLE_ADAPTER_FACTORY: FamilyPhysicalLifecycleAdapterFactoryV1 =
  () => ADAPTER;
