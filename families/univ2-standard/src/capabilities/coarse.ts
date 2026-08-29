import {
  assertDecimalString,
  assertHash,
  assertNonEmptyString,
  decodeExactObject,
  deepFreeze,
  hashDomain,
  type CanonicalJson,
  type Hash,
} from "../../../../packages/canonical-codec/src/index.ts";
import { decodeCanonicalCutoff, type CanonicalCutoffV1 } from "../../../../packages/discovery/src/index.ts";
import { erc20AssetReferenceV1 } from "../../../../packages/asset-ref/src/index.ts";
import { quoteV2ExactInput } from "../kernel/math.ts";
import { decodeUniV2StateSnapshot, type UniV2StateSnapshotV1 } from "./state.ts";
import {
  UNIV2_STANDARD_COARSE_CAPABILITY_ID,
  UNIV2_STANDARD_COARSE_INTERPRETER_HASH,
  UNIV2_STANDARD_COARSE_SCHEMA_HASH,
  UNIV2_STANDARD_SWAP_FEE_BPS,
  UNIV2_STANDARD_SWAP_GAS_UPPER_BOUND,
} from "./metadata.ts";
import { decodeUniV2OpaqueCanonical, encodeUniV2OpaqueCanonical } from "./opaque.ts";

export type UniV2CoarseDirectionV1 = "token0-to-token1" | "token1-to-token0";

export interface UniV2CoarseInputV1 {
  readonly state: UniV2StateSnapshotV1;
  readonly direction: UniV2CoarseDirectionV1;
  readonly sampleInputAmount: string;
}

export interface UniV2GenericAssetAmountV1 {
  readonly assetRef: Hash;
  readonly amount: string;
}

export interface UniV2ConservativeUpperBoundV1 {
  readonly amount: string;
  readonly proofProgramRef: Hash;
  readonly proofRoot: Hash;
}

export interface UniV2CoarseProjectionV1 {
  readonly kind: "univ2-standard.coarse-projection";
  readonly schemaVersion: 1;
  readonly schemaRef: typeof UNIV2_STANDARD_COARSE_SCHEMA_HASH;
  readonly capabilityId: typeof UNIV2_STANDARD_COARSE_CAPABILITY_ID;
  readonly interpreterHash: typeof UNIV2_STANDARD_COARSE_INTERPRETER_HASH;
  readonly source: CanonicalCutoffV1;
  readonly inputs: readonly UniV2GenericAssetAmountV1[];
  readonly outputs: readonly UniV2GenericAssetAmountV1[];
  readonly conservativeOutputUpperBound: UniV2ConservativeUpperBoundV1 | null;
  readonly inputCapacityUpperBound: string | null;
  readonly gasUpperBound: string;
  readonly constraintRefs: readonly Hash[];
  readonly stateFactsRoot: Hash;
  readonly opaqueBytes: string;
  readonly status: "rankable" | "unavailable";
  readonly reasonCode: "zero-liquidity" | "invalid-input" | null;
  readonly projectionHash: Hash;
}

export interface UniV2CoarsePortV1 {
  readonly project: (input: UniV2CoarseInputV1) => UniV2CoarseProjectionV1;
  readonly decode: (value: unknown) => UniV2CoarseProjectionV1;
}

function sameSource(left: CanonicalCutoffV1, right: CanonicalCutoffV1): boolean {
  return left.chainId === right.chainId && left.number === right.number && left.hash === right.hash && left.stateRoot === right.stateRoot;
}

function source(value: unknown, path: string): CanonicalCutoffV1 {
  return decodeCanonicalCutoff(value, path);
}

function assetRef(chainId: string, token: string): Hash {
  return erc20AssetReferenceV1(chainId, token).assetRef;
}

function parseDirection(value: unknown, path: string): UniV2CoarseDirectionV1 {
  if (value !== "token0-to-token1" && value !== "token1-to-token0") throw new TypeError(`${path} direction mismatch`);
  return value;
}

function decodeAmount(value: unknown, path: string, allowZero = false): string {
  const amount = assertDecimalString(value, path);
  if (!allowZero && BigInt(amount) <= 0n) throw new TypeError(`${path} must be positive`);
  return amount;
}

function semanticBytes(input: {
  readonly source: CanonicalCutoffV1;
  readonly stateFactsRoot: Hash;
  readonly direction: UniV2CoarseDirectionV1;
  readonly sampleInputAmount: string;
  readonly estimatedOutputAmount: string | null;
  readonly conservativeOutputUpperBoundAmount: string | null;
  readonly feeBps: string;
}): string {
  return encodeUniV2OpaqueCanonical({
    kind: "univ2-standard.coarse-semantics",
    schemaVersion: 1,
    source: input.source,
    stateFactsRoot: input.stateFactsRoot,
    direction: input.direction,
    sampleInputAmount: input.sampleInputAmount,
    estimatedOutputAmount: input.estimatedOutputAmount,
    conservativeOutputUpperBoundAmount: input.conservativeOutputUpperBoundAmount,
    feeBps: input.feeBps,
  });
}

function projectionHash(value: Omit<UniV2CoarseProjectionV1, "projectionHash">): Hash {
  return hashDomain("aloha/univ2-standard/coarse-projection/v1", value);
}

function unavailable(input: UniV2CoarseInputV1, reasonCode: "zero-liquidity" | "invalid-input"): UniV2CoarseProjectionV1 {
  const state = decodeUniV2StateSnapshot(input.state);
  const direction = parseDirection(input.direction, "univ2.coarse.direction");
  const amount = decodeAmount(input.sampleInputAmount, "univ2.coarse.sampleInputAmount", true);
  const inputToken = direction === "token0-to-token1" ? state.token0 : state.token1;
  const withoutHash: Omit<UniV2CoarseProjectionV1, "projectionHash"> = {
    kind: "univ2-standard.coarse-projection" as const,
    schemaVersion: 1 as const,
    schemaRef: UNIV2_STANDARD_COARSE_SCHEMA_HASH,
    capabilityId: UNIV2_STANDARD_COARSE_CAPABILITY_ID,
    interpreterHash: UNIV2_STANDARD_COARSE_INTERPRETER_HASH,
    source: state.source,
    inputs: [{ assetRef: assetRef(state.source.chainId, inputToken), amount }],
    outputs: [],
    conservativeOutputUpperBound: null,
    inputCapacityUpperBound: null,
    gasUpperBound: UNIV2_STANDARD_SWAP_GAS_UPPER_BOUND,
    constraintRefs: Object.freeze([state.stateFactsRoot]),
    stateFactsRoot: state.stateFactsRoot,
    opaqueBytes: semanticBytes({
      source: state.source,
      stateFactsRoot: state.stateFactsRoot,
      direction,
      sampleInputAmount: amount,
      estimatedOutputAmount: null,
      conservativeOutputUpperBoundAmount: null,
      feeBps: UNIV2_STANDARD_SWAP_FEE_BPS.toString(10),
    }),
    status: "unavailable",
    reasonCode,
  };
  return decodeUniV2CoarseProjection({ ...withoutHash, projectionHash: projectionHash(withoutHash) });
}

function project(input: UniV2CoarseInputV1): UniV2CoarseProjectionV1 {
  const state = decodeUniV2StateSnapshot(input.state);
  const direction = parseDirection(input.direction, "univ2.coarse.direction");
  const amount = decodeAmount(input.sampleInputAmount, "univ2.coarse.sampleInputAmount");
  const reserveIn = BigInt(direction === "token0-to-token1" ? state.state.reserve0 : state.state.reserve1);
  const reserveOut = BigInt(direction === "token0-to-token1" ? state.state.reserve1 : state.state.reserve0);
  const inputToken = direction === "token0-to-token1" ? state.token0 : state.token1;
  const outputToken = direction === "token0-to-token1" ? state.token1 : state.token0;
  if (reserveIn <= 0n || reserveOut <= 0n) return unavailable(input, "zero-liquidity");
  const amountIn = BigInt(amount);
  const estimated = quoteV2ExactInput(reserveIn, reserveOut, amountIn, UNIV2_STANDARD_SWAP_FEE_BPS);
  // The proof covers every input in [0, capacity], not only the sampled
  // amount.  Constant-product exact output is monotone in amountIn, so the
  // no-fee quote at the interval endpoint is an absolute upper bound for all
  // fee-charged quotes inside the declared interval.
  const capacity = amountIn > reserveIn ? amountIn : reserveIn;
  const upper = quoteV2ExactInput(reserveIn, reserveOut, capacity, 0n);
  const proofProgramRef = hashDomain("aloha/univ2-standard/coarse-upper-bound-program/v1", {
    stateFactsRoot: state.stateFactsRoot,
    direction,
    inputCapacityUpperBound: capacity.toString(10),
  });
  const proofRoot = hashDomain("aloha/univ2-standard/coarse-upper-bound-proof/v1", {
    proofProgramRef,
    reserveIn: reserveIn.toString(10),
    reserveOut: reserveOut.toString(10),
    inputCapacityUpperBound: capacity.toString(10),
    amountOutUpperBound: upper.toString(10),
  });
  const constraintRefs = Object.freeze([
    state.stateFactsRoot,
    hashDomain("aloha/univ2-standard/fee-policy/v1", UNIV2_STANDARD_SWAP_FEE_BPS.toString(10)),
    hashDomain("aloha/univ2-standard/constant-product/v1", { reserveIn: reserveIn.toString(10), reserveOut: reserveOut.toString(10) }),
  ].sort());
  const withoutHash: Omit<UniV2CoarseProjectionV1, "projectionHash"> = {
    kind: "univ2-standard.coarse-projection" as const,
    schemaVersion: 1 as const,
    schemaRef: UNIV2_STANDARD_COARSE_SCHEMA_HASH,
    capabilityId: UNIV2_STANDARD_COARSE_CAPABILITY_ID,
    interpreterHash: UNIV2_STANDARD_COARSE_INTERPRETER_HASH,
    source: state.source,
    inputs: [{ assetRef: assetRef(state.source.chainId, inputToken), amount }],
    outputs: [{ assetRef: assetRef(state.source.chainId, outputToken), amount: estimated.toString(10) }],
    conservativeOutputUpperBound: {
      amount: upper.toString(10),
      proofProgramRef,
      proofRoot,
    },
    inputCapacityUpperBound: capacity.toString(10),
    gasUpperBound: UNIV2_STANDARD_SWAP_GAS_UPPER_BOUND,
    constraintRefs,
    stateFactsRoot: state.stateFactsRoot,
    opaqueBytes: semanticBytes({
      source: state.source,
      stateFactsRoot: state.stateFactsRoot,
      direction,
      sampleInputAmount: amount,
      estimatedOutputAmount: estimated.toString(10),
      conservativeOutputUpperBoundAmount: upper.toString(10),
      feeBps: UNIV2_STANDARD_SWAP_FEE_BPS.toString(10),
    }),
    status: "rankable",
    reasonCode: null,
  };
  return decodeUniV2CoarseProjection({ ...withoutHash, projectionHash: projectionHash(withoutHash) });
}

export function decodeUniV2CoarseProjection(value: unknown, path = "univ2.coarseProjection"): UniV2CoarseProjectionV1 {
  const decoded = decodeExactObject(value, {
    kind: (item, itemPath) => { if (item !== "univ2-standard.coarse-projection") throw new TypeError(`${itemPath} kind mismatch`); return item; },
    schemaVersion: (item, itemPath) => { if (item !== 1) throw new TypeError(`${itemPath} version mismatch`); return 1 as const; },
    schemaRef: (item, itemPath) => { if (item !== UNIV2_STANDARD_COARSE_SCHEMA_HASH) throw new TypeError(`${itemPath} schema mismatch`); return UNIV2_STANDARD_COARSE_SCHEMA_HASH; },
    capabilityId: (item, itemPath) => { if (item !== UNIV2_STANDARD_COARSE_CAPABILITY_ID) throw new TypeError(`${itemPath} capability mismatch`); return UNIV2_STANDARD_COARSE_CAPABILITY_ID; },
    interpreterHash: (item, itemPath) => { if (item !== UNIV2_STANDARD_COARSE_INTERPRETER_HASH) throw new TypeError(`${itemPath} interpreter mismatch`); return UNIV2_STANDARD_COARSE_INTERPRETER_HASH; },
    source: (item, itemPath) => source(item, itemPath),
    inputs: (item, itemPath) => Array.isArray(item) ? item.map((entry, index) => decodeExactObject(entry, { assetRef: (field, fieldPath) => assertHash(field, fieldPath), amount: (field, fieldPath) => assertDecimalString(field, fieldPath) }, `${itemPath}[${index}]`)) : (() => { throw new TypeError(`${itemPath} must be an array`); })(),
    outputs: (item, itemPath) => Array.isArray(item) ? item.map((entry, index) => decodeExactObject(entry, { assetRef: (field, fieldPath) => assertHash(field, fieldPath), amount: (field, fieldPath) => assertDecimalString(field, fieldPath) }, `${itemPath}[${index}]`)) : (() => { throw new TypeError(`${itemPath} must be an array`); })(),
    conservativeOutputUpperBound: (item, itemPath) => item === null ? null : decodeExactObject(item, { amount: (field, fieldPath) => assertDecimalString(field, fieldPath), proofProgramRef: (field, fieldPath) => assertHash(field, fieldPath), proofRoot: (field, fieldPath) => assertHash(field, fieldPath) }, itemPath),
    inputCapacityUpperBound: (item, itemPath) => item === null ? null : assertDecimalString(item, itemPath),
    gasUpperBound: (item, itemPath) => assertDecimalString(item, itemPath),
    constraintRefs: (item, itemPath) => Array.isArray(item) ? item.map((entry, index) => assertHash(entry, `${itemPath}[${index}]`)) : (() => { throw new TypeError(`${itemPath} must be an array`); })(),
    stateFactsRoot: (item, itemPath) => assertHash(item, itemPath),
    opaqueBytes: (item, itemPath) => assertNonEmptyString(item, itemPath),
    status: (item, itemPath) => { if (item !== "rankable" && item !== "unavailable") throw new TypeError(`${itemPath} status mismatch`); return item; },
    reasonCode: (item, itemPath) => item === null || item === "zero-liquidity" || item === "invalid-input" ? item : (() => { throw new TypeError(`${itemPath} reason mismatch`); })(),
    projectionHash: (item, itemPath) => assertHash(item, itemPath),
  }, path);
  if ((decoded.status === "rankable") !== (decoded.reasonCode === null)) throw new TypeError(`${path} status/reason mismatch`);
  if (decoded.status === "rankable" && (decoded.outputs.length !== 1 || decoded.conservativeOutputUpperBound === null || decoded.inputCapacityUpperBound === null)) throw new TypeError(`${path} rankable fields missing`);
  const { projectionHash: ignored, ...withoutHash } = decoded;
  void ignored;
  if (projectionHash(withoutHash as Omit<UniV2CoarseProjectionV1, "projectionHash">) !== decoded.projectionHash) throw new TypeError(`${path} hash mismatch`);
  decodeUniV2OpaqueCanonical(decoded.opaqueBytes, `${path}.opaqueBytes`);
  return deepFreeze(decoded) as UniV2CoarseProjectionV1;
}

export const UNIV2_STANDARD_COARSE_PORT: UniV2CoarsePortV1 = Object.freeze({
  project,
  decode: decodeUniV2CoarseProjection,
});
