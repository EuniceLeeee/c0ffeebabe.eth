import {
  assertDecimalString,
  assertHash,
  assertNonEmptyString,
  decodeExactObject,
  deepFreeze,
  hashDomain,
  type Hash,
} from "../../../../packages/canonical-codec/src/index.ts";
import { decodeCanonicalCutoff, type CanonicalCutoffV1 } from "../../../../packages/discovery/src/index.ts";
import { erc20AssetReferenceV1 } from "../../../../packages/asset-ref/src/index.ts";
import { quoteV2ExactInput } from "../kernel/math.ts";
import { decodeUniV2StateSnapshot, type UniV2StateSnapshotV1 } from "./state.ts";
import {
  UNIV2_STANDARD_EXACT_CAPABILITY_ID,
  UNIV2_STANDARD_EXACT_INTERPRETER_HASH,
  UNIV2_STANDARD_EXACT_SCHEMA_HASH,
  UNIV2_STANDARD_SWAP_FEE_BPS,
  UNIV2_STANDARD_SWAP_GAS_UPPER_BOUND,
} from "./metadata.ts";
import { encodeUniV2OpaqueCanonical } from "./opaque.ts";
import type { UniV2CoarseDirectionV1, UniV2GenericAssetAmountV1 } from "./coarse.ts";

export interface UniV2ExactInputV1 {
  readonly state: UniV2StateSnapshotV1;
  readonly direction: UniV2CoarseDirectionV1;
  readonly amountIn: string;
}

export interface UniV2ObligationRefV1 {
  readonly kind: "input" | "output";
  readonly ref: Hash;
}

export interface UniV2ExactEvaluationV1 {
  readonly kind: "univ2-standard.exact-evaluation";
  readonly schemaVersion: 1;
  readonly schemaRef: typeof UNIV2_STANDARD_EXACT_SCHEMA_HASH;
  readonly capabilityId: typeof UNIV2_STANDARD_EXACT_CAPABILITY_ID;
  readonly interpreterHash: typeof UNIV2_STANDARD_EXACT_INTERPRETER_HASH;
  readonly source: CanonicalCutoffV1;
  readonly inputs: readonly UniV2GenericAssetAmountV1[];
  readonly outputs: readonly UniV2GenericAssetAmountV1[];
  readonly gasUpperBound: string;
  readonly constraintRefs: readonly Hash[];
  readonly obligationRefs: readonly UniV2ObligationRefV1[];
  readonly obligationRoot: Hash;
  readonly stateFactsRoot: Hash;
  readonly opaqueBytes: string;
  readonly status: "verified" | "unavailable";
  readonly reasonCode: "zero-liquidity" | "invalid-amount" | null;
  readonly evaluationHash: Hash;
}

export interface UniV2ExactPortV1 {
  readonly propagateAmount: (input: UniV2ExactInputV1) => UniV2ExactEvaluationV1;
  readonly decode: (value: unknown) => UniV2ExactEvaluationV1;
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

function amount(value: unknown, path: string): string {
  const result = assertDecimalString(value, path);
  if (BigInt(result) <= 0n) throw new TypeError(`${path} must be positive`);
  return result;
}

function obligationRefs(state: UniV2StateSnapshotV1, direction: UniV2CoarseDirectionV1, amountIn: string, amountOut: string): readonly UniV2ObligationRefV1[] {
  const common = { stateFactsRoot: state.stateFactsRoot, direction, amountIn, amountOut };
  return Object.freeze([
    Object.freeze({ kind: "input" as const, ref: hashDomain("aloha/univ2-standard/obligation/input/v1", common) }),
    Object.freeze({ kind: "output" as const, ref: hashDomain("aloha/univ2-standard/obligation/output/v1", common) }),
  ]);
}

function evaluationHash(value: Omit<UniV2ExactEvaluationV1, "evaluationHash">): Hash {
  return hashDomain("aloha/univ2-standard/exact-evaluation/v1", value);
}

function unavailable(input: UniV2ExactInputV1, reasonCode: "zero-liquidity" | "invalid-amount"): UniV2ExactEvaluationV1 {
  const state = decodeUniV2StateSnapshot(input.state);
  const direction = parseDirection(input.direction, "univ2.exact.direction");
  const amountIn = assertDecimalString(input.amountIn, "univ2.exact.amountIn");
  const inputToken = direction === "token0-to-token1" ? state.token0 : state.token1;
  const outputToken = direction === "token0-to-token1" ? state.token1 : state.token0;
  const refs = obligationRefs(state, direction, amountIn, "0");
  const withoutHash: Omit<UniV2ExactEvaluationV1, "evaluationHash"> = {
    kind: "univ2-standard.exact-evaluation" as const,
    schemaVersion: 1 as const,
    schemaRef: UNIV2_STANDARD_EXACT_SCHEMA_HASH,
    capabilityId: UNIV2_STANDARD_EXACT_CAPABILITY_ID,
    interpreterHash: UNIV2_STANDARD_EXACT_INTERPRETER_HASH,
    source: state.source,
    inputs: [{ assetRef: assetRef(state.source.chainId, inputToken), amount: amountIn }],
    outputs: [{ assetRef: assetRef(state.source.chainId, outputToken), amount: "0" }],
    gasUpperBound: UNIV2_STANDARD_SWAP_GAS_UPPER_BOUND,
    constraintRefs: Object.freeze([state.stateFactsRoot]),
    obligationRefs: refs,
    obligationRoot: hashDomain("aloha/univ2-standard/obligation-root/v1", refs),
    stateFactsRoot: state.stateFactsRoot,
    opaqueBytes: encodeUniV2OpaqueCanonical({ kind: "univ2-standard.exact-semantics", schemaVersion: 1, source: state.source, stateFactsRoot: state.stateFactsRoot, direction, amountIn, amountOut: "0", feeBps: UNIV2_STANDARD_SWAP_FEE_BPS.toString(10) }),
    status: "unavailable",
    reasonCode,
  };
  return decodeUniV2ExactEvaluation({ ...withoutHash, evaluationHash: evaluationHash(withoutHash) });
}

function propagateAmount(input: UniV2ExactInputV1): UniV2ExactEvaluationV1 {
  const state = decodeUniV2StateSnapshot(input.state);
  const direction = parseDirection(input.direction, "univ2.exact.direction");
  const amountIn = amount(input.amountIn, "univ2.exact.amountIn");
  const reserveIn = BigInt(direction === "token0-to-token1" ? state.state.reserve0 : state.state.reserve1);
  const reserveOut = BigInt(direction === "token0-to-token1" ? state.state.reserve1 : state.state.reserve0);
  if (reserveIn <= 0n || reserveOut <= 0n) return unavailable(input, "zero-liquidity");
  const amountOut = quoteV2ExactInput(reserveIn, reserveOut, BigInt(amountIn), UNIV2_STANDARD_SWAP_FEE_BPS).toString(10);
  const inputToken = direction === "token0-to-token1" ? state.token0 : state.token1;
  const outputToken = direction === "token0-to-token1" ? state.token1 : state.token0;
  const refs = obligationRefs(state, direction, amountIn, amountOut);
  const constraintRefs = Object.freeze([
    state.stateFactsRoot,
    hashDomain("aloha/univ2-standard/fee-policy/v1", UNIV2_STANDARD_SWAP_FEE_BPS.toString(10)),
  ].sort());
  const withoutHash: Omit<UniV2ExactEvaluationV1, "evaluationHash"> = {
    kind: "univ2-standard.exact-evaluation" as const,
    schemaVersion: 1 as const,
    schemaRef: UNIV2_STANDARD_EXACT_SCHEMA_HASH,
    capabilityId: UNIV2_STANDARD_EXACT_CAPABILITY_ID,
    interpreterHash: UNIV2_STANDARD_EXACT_INTERPRETER_HASH,
    source: state.source,
    inputs: [{ assetRef: assetRef(state.source.chainId, inputToken), amount: amountIn }],
    outputs: [{ assetRef: assetRef(state.source.chainId, outputToken), amount: amountOut }],
    gasUpperBound: UNIV2_STANDARD_SWAP_GAS_UPPER_BOUND,
    constraintRefs,
    obligationRefs: refs,
    obligationRoot: hashDomain("aloha/univ2-standard/obligation-root/v1", refs),
    stateFactsRoot: state.stateFactsRoot,
    opaqueBytes: encodeUniV2OpaqueCanonical({ kind: "univ2-standard.exact-semantics", schemaVersion: 1, source: state.source, stateFactsRoot: state.stateFactsRoot, direction, amountIn, amountOut, feeBps: UNIV2_STANDARD_SWAP_FEE_BPS.toString(10) }),
    status: "verified",
    reasonCode: null,
  };
  return decodeUniV2ExactEvaluation({ ...withoutHash, evaluationHash: evaluationHash(withoutHash) });
}

export function decodeUniV2ExactEvaluation(value: unknown, path = "univ2.exactEvaluation"): UniV2ExactEvaluationV1 {
  const decoded = decodeExactObject(value, {
    kind: (item, itemPath) => { if (item !== "univ2-standard.exact-evaluation") throw new TypeError(`${itemPath} kind mismatch`); return item; },
    schemaVersion: (item, itemPath) => { if (item !== 1) throw new TypeError(`${itemPath} version mismatch`); return 1 as const; },
    schemaRef: (item, itemPath) => { if (item !== UNIV2_STANDARD_EXACT_SCHEMA_HASH) throw new TypeError(`${itemPath} schema mismatch`); return UNIV2_STANDARD_EXACT_SCHEMA_HASH; },
    capabilityId: (item, itemPath) => { if (item !== UNIV2_STANDARD_EXACT_CAPABILITY_ID) throw new TypeError(`${itemPath} capability mismatch`); return UNIV2_STANDARD_EXACT_CAPABILITY_ID; },
    interpreterHash: (item, itemPath) => { if (item !== UNIV2_STANDARD_EXACT_INTERPRETER_HASH) throw new TypeError(`${itemPath} interpreter mismatch`); return UNIV2_STANDARD_EXACT_INTERPRETER_HASH; },
    source: (item, itemPath) => source(item, itemPath),
    inputs: (item, itemPath) => Array.isArray(item) ? item.map((entry, index) => decodeExactObject(entry, { assetRef: (field, fieldPath) => assertHash(field, fieldPath), amount: (field, fieldPath) => assertDecimalString(field, fieldPath) }, `${itemPath}[${index}]`)) : (() => { throw new TypeError(`${itemPath} must be an array`); })(),
    outputs: (item, itemPath) => Array.isArray(item) ? item.map((entry, index) => decodeExactObject(entry, { assetRef: (field, fieldPath) => assertHash(field, fieldPath), amount: (field, fieldPath) => assertDecimalString(field, fieldPath) }, `${itemPath}[${index}]`)) : (() => { throw new TypeError(`${itemPath} must be an array`); })(),
    gasUpperBound: (item, itemPath) => assertDecimalString(item, itemPath),
    constraintRefs: (item, itemPath) => Array.isArray(item) ? item.map((entry, index) => assertHash(entry, `${itemPath}[${index}]`)) : (() => { throw new TypeError(`${itemPath} must be an array`); })(),
    obligationRefs: (item, itemPath) => Array.isArray(item) ? item.map((entry, index) => decodeExactObject(entry, { kind: (field, fieldPath) => { if (field !== "input" && field !== "output") throw new TypeError(`${fieldPath} kind mismatch`); return field; }, ref: (field, fieldPath) => assertHash(field, fieldPath) }, `${itemPath}[${index}]`)) : (() => { throw new TypeError(`${itemPath} must be an array`); })(),
    obligationRoot: (item, itemPath) => assertHash(item, itemPath),
    stateFactsRoot: (item, itemPath) => assertHash(item, itemPath),
    opaqueBytes: (item, itemPath) => assertNonEmptyString(item, itemPath),
    status: (item, itemPath) => { if (item !== "verified" && item !== "unavailable") throw new TypeError(`${itemPath} status mismatch`); return item; },
    reasonCode: (item, itemPath) => item === null || item === "zero-liquidity" || item === "invalid-amount" ? item : (() => { throw new TypeError(`${itemPath} reason mismatch`); })(),
    evaluationHash: (item, itemPath) => assertHash(item, itemPath),
  }, path);
  if ((decoded.status === "verified") !== (decoded.reasonCode === null)) throw new TypeError(`${path} status/reason mismatch`);
  if (decoded.inputs.length !== 1 || decoded.outputs.length !== 1) throw new TypeError(`${path} amount vectors must have one leg`);
  const kinds = decoded.obligationRefs.map(item => item.kind);
  if (kinds.join(",") !== "input,output") throw new TypeError(`${path} obligation order mismatch`);
  if (decoded.obligationRoot !== hashDomain("aloha/univ2-standard/obligation-root/v1", decoded.obligationRefs)) throw new TypeError(`${path} obligation root mismatch`);
  const { evaluationHash: ignored, ...withoutHash } = decoded;
  void ignored;
  if (evaluationHash(withoutHash as Omit<UniV2ExactEvaluationV1, "evaluationHash">) !== decoded.evaluationHash) throw new TypeError(`${path} hash mismatch`);
  return deepFreeze(decoded) as UniV2ExactEvaluationV1;
}

export const UNIV2_STANDARD_EXACT_PORT: UniV2ExactPortV1 = Object.freeze({
  propagateAmount,
  decode: decodeUniV2ExactEvaluation,
});
