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
import { canonicalAddress } from "../kernel/codec.ts";
import type { UniV2CoarseDirectionV1, UniV2GenericAssetAmountV1 } from "./coarse.ts";
import type { UniV2ExactEvaluationV1, UniV2ObligationRefV1 } from "./exact.ts";
import {
  decodePackedCallProgram,
  encodePackedCallProgram,
  normalizeEffectTransportDeclaration,
  type EffectTransportDeclarationV1,
} from "../../../../packages/execution-program/src/index.ts";
import {
  UNIV2_STANDARD_SWAP_ACTION_IMPLEMENTATION_HASH,
  UNIV2_STANDARD_SWAP_ACTION_OWNER_ID,
  UNIV2_STANDARD_SWAP_ACTION_SCHEMA_HASH,
  UNIV2_STANDARD_SWAP_SELECTOR,
  UNIV2_STANDARD_SWAP_GAS_UPPER_BOUND,
} from "./metadata.ts";

const ERC20_TRANSFER_SELECTOR = "0xa9059cbb" as const;

export interface UniV2SwapActionInputV1 {
  readonly exact: UniV2ExactEvaluationV1;
  readonly pool: string;
  readonly tokenIn: string;
  readonly tokenOut: string;
  readonly direction: UniV2CoarseDirectionV1;
  readonly recipient: string;
  readonly callbackDataHex?: string;
}

export interface UniV2SwapActionV1 {
  readonly kind: "univ2-standard.swap-action";
  readonly schemaVersion: 1;
  readonly schemaRef: typeof UNIV2_STANDARD_SWAP_ACTION_SCHEMA_HASH;
  readonly actionOwnerId: typeof UNIV2_STANDARD_SWAP_ACTION_OWNER_ID;
  readonly actionImplementationHash: typeof UNIV2_STANDARD_SWAP_ACTION_IMPLEMENTATION_HASH;
  readonly source: CanonicalCutoffV1;
  readonly inputs: readonly UniV2GenericAssetAmountV1[];
  readonly outputs: readonly UniV2GenericAssetAmountV1[];
  readonly gasUpperBound: string;
  readonly constraintRefs: readonly Hash[];
  readonly obligationRefs: readonly UniV2ObligationRefV1[];
  readonly obligationRoot: Hash;
  readonly exactEvaluationHash: Hash;
  /** ABI bytes are opaque to the central action compiler. */
  readonly opaqueBytes: string;
  readonly effectTransport: EffectTransportDeclarationV1;
  readonly actionHash: Hash;
}

export interface UniV2SwapActionPortV1 {
  readonly build: (input: UniV2SwapActionInputV1) => UniV2SwapActionV1;
  readonly decode: (value: unknown) => UniV2SwapActionV1;
  readonly verifyObligations: (value: unknown) => UniV2SwapActionObligationProofV1;
}

export interface UniV2SwapActionObligationProofV1 {
  readonly kind: "aloha.family-action-obligation-verifier-receipt-v1";
  readonly schemaRef: Hash;
  readonly implementationHash: Hash;
  readonly subjectRoot: Hash;
  readonly proofRoot: Hash;
  readonly outcome: "satisfied";
}

interface DecodedSwapCalldataV1 {
  readonly amount0Out: bigint;
  readonly amount1Out: bigint;
  readonly recipient: string;
  readonly callbackDataHex: string;
}

interface DecodedTransferCalldataV1 {
  readonly recipient: string;
  readonly amount: bigint;
}

function source(value: unknown, path: string): CanonicalCutoffV1 {
  return decodeCanonicalCutoff(value, path);
}

function direction(value: unknown, path: string): UniV2CoarseDirectionV1 {
  if (value !== "token0-to-token1" && value !== "token1-to-token0") throw new TypeError(`${path} direction mismatch`);
  return value;
}

function uintWord(value: bigint, path: string): string {
  if (value < 0n || value >= (1n << 256n)) throw new RangeError(`${path} outside uint256`);
  return value.toString(16).padStart(64, "0");
}

function addressWord(value: string, path: string): string {
  return `${canonicalAddress(value).slice(2).padStart(64, "0")}`;
}

function callbackBytes(value: unknown, path: string): string {
  const result = value === undefined ? "0x" : value;
  if (typeof result !== "string" || !/^0x(?:[0-9a-fA-F]{2})*$/.test(result)) throw new TypeError(`${path} must be hex bytes`);
  const canonical = result.toLowerCase();
  // A plain UniV2 swap has no callback authority.  The dynamic bytes field
  // is deliberately fixed to canonical empty bytes until an owner-issued
  // callback program is part of the action contract.
  if (canonical !== "0x") throw new TypeError(`${path} callback program is unavailable`);
  return "0x";
}

function encodeSwapCalldata(amount0Out: bigint, amount1Out: bigint, recipient: string, callbackDataHex: string): string {
  const callbackBytesLength = (callbackDataHex.length - 2) / 2;
  const paddedLength = Math.ceil(callbackBytesLength / 32) * 64;
  const callbackHex = callbackDataHex.slice(2).padEnd(paddedLength, "0");
  return `${UNIV2_STANDARD_SWAP_SELECTOR}${uintWord(amount0Out, "amount0Out")}${uintWord(amount1Out, "amount1Out")}${addressWord(recipient, "recipient")}${uintWord(128n, "bytesOffset")}${uintWord(BigInt(callbackBytesLength), "bytesLength")}${callbackHex}`;
}

function encodeTransferCalldata(recipient: string, amount: bigint): string {
  return `${ERC20_TRANSFER_SELECTOR}${addressWord(recipient, "transfer.recipient")}${uintWord(amount, "transfer.amount")}`;
}

function decodeTransferCalldata(value: unknown, path: string): DecodedTransferCalldataV1 {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{136}$/.test(value) || value.slice(0, 10).toLowerCase() !== ERC20_TRANSFER_SELECTOR) throw new TypeError(`${path} transfer calldata invalid`);
  const bytes = value.toLowerCase();
  const recipientWord = bytes.slice(10, 74);
  if (!/^0{24}[0-9a-f]{40}$/.test(recipientWord)) throw new TypeError(`${path} transfer recipient padding invalid`);
  return Object.freeze({ recipient: canonicalAddress(`0x${recipientWord.slice(24)}`), amount: BigInt(`0x${bytes.slice(74)}`) });
}

function decodeActionScript(value: unknown, path: string): { readonly transfer: DecodedTransferCalldataV1; readonly swap: DecodedSwapCalldataV1 } {
  const calls = decodePackedCallProgram(value, path);
  if (calls.length !== 2) throw new TypeError(`${path} must contain transfer and swap`);
  if (calls[0]!.value !== "0" || calls[1]!.value !== "0") throw new TypeError(`${path} CALL values must be zero`);
  return Object.freeze({
    transfer: decodeTransferCalldata(calls[0]!.calldata, `${path}.transfer`),
    swap: decodeSwapCalldata(calls[1]!.calldata, `${path}.swap`),
  });
}

function decodeSwapCalldata(value: unknown, path = "univ2.swapAction.opaqueBytes"): DecodedSwapCalldataV1 {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]*$/.test(value) || value.length < 2 + 8 + 64 * 5 || (value.length - 10) % 64 !== 0) throw new TypeError(`${path} calldata length invalid`);
  const bytes = value.toLowerCase();
  if (bytes.slice(0, 10) !== UNIV2_STANDARD_SWAP_SELECTOR) throw new TypeError(`${path} selector mismatch`);
  const wordAt = (index: number): bigint => BigInt(`0x${bytes.slice(10 + index * 64, 10 + (index + 1) * 64)}`);
  const amount0Out = wordAt(0);
  const amount1Out = wordAt(1);
  const recipientWord = bytes.slice(10 + 2 * 64, 10 + 3 * 64);
  if (!/^0{24}[0-9a-f]{40}$/.test(recipientWord)) throw new TypeError(`${path} recipient padding invalid`);
  const recipient = canonicalAddress(`0x${recipientWord.slice(24)}`);
  if (wordAt(3) !== 128n) throw new TypeError(`${path} dynamic offset mismatch`);
  const dataLengthWord = wordAt(4);
  if (dataLengthWord > BigInt(Number.MAX_SAFE_INTEGER)) throw new TypeError(`${path} dynamic length exceeds safe range`);
  const dataLength = Number(dataLengthWord);
  const dataStart = 10 + 5 * 64;
  const dataEnd = dataStart + dataLength * 2;
  const expectedLength = dataStart + Math.ceil(dataLength / 32) * 64;
  if (!Number.isSafeInteger(dataLength) || dataEnd > bytes.length || bytes.length !== expectedLength) throw new TypeError(`${path} dynamic length invalid`);
  const padding = bytes.slice(dataEnd);
  if (!/^0*$/.test(padding)) throw new TypeError(`${path} dynamic padding non-zero`);
  const callbackDataHex = `0x${bytes.slice(dataStart, dataEnd)}`;
  if (callbackDataHex !== "0x") throw new TypeError(`${path} callback program is unavailable`);
  return Object.freeze({ amount0Out, amount1Out, recipient, callbackDataHex: "0x" });
}

function actionHash(value: Omit<UniV2SwapActionV1, "actionHash">): Hash {
  return hashDomain("aloha/univ2-standard/swap-action/v1", value);
}

function build(input: UniV2SwapActionInputV1): UniV2SwapActionV1 {
  const exact = input.exact;
  if (exact.status !== "verified") throw new TypeError("univ2-swap-action-exact-unavailable");
  const pool = canonicalAddress(input.pool);
  const tokenIn = canonicalAddress(input.tokenIn);
  const tokenOut = canonicalAddress(input.tokenOut);
  if (tokenIn === tokenOut) throw new TypeError("univ2-swap-action-token-pair-invalid");
  const routeDirection = direction(input.direction, "univ2.swapAction.direction");
  const recipient = canonicalAddress(input.recipient);
  const amountIn = assertDecimalString(exact.inputs[0]?.amount, "univ2.swapAction.amountIn");
  const amountOut = assertDecimalString(exact.outputs[0]?.amount, "univ2.swapAction.amountOut");
  if (BigInt(amountIn) <= 0n || BigInt(amountOut) <= 0n) throw new TypeError("univ2-swap-action-amount-invalid");
  const callbackDataHex = callbackBytes(input.callbackDataHex, "univ2.swapAction.callbackDataHex");
  const swapCalldata = routeDirection === "token0-to-token1"
    ? encodeSwapCalldata(0n, BigInt(amountOut), recipient, callbackDataHex)
    : encodeSwapCalldata(BigInt(amountOut), 0n, recipient, callbackDataHex);
  const calldata = encodePackedCallProgram([
    { target: tokenIn as `0x${string}`, value: "0", calldata: encodeTransferCalldata(pool, BigInt(amountIn)) as `0x${string}` },
    { target: pool as `0x${string}`, value: "0", calldata: swapCalldata as `0x${string}` },
  ]);
  const effectTransport = normalizeEffectTransportDeclaration({
    caller: { ref: { kind: "observed-sender" }, executionMode: "top-level" },
    preCalls: [],
    observeTokenBalances: [
      { token: tokenIn, account: recipient },
      { token: tokenOut, account: recipient },
    ],
    observeLogs: false,
  }, "univ2.swapAction.effectTransport");
  const withoutHash: Omit<UniV2SwapActionV1, "actionHash"> = {
    kind: "univ2-standard.swap-action" as const,
    schemaVersion: 1 as const,
    schemaRef: UNIV2_STANDARD_SWAP_ACTION_SCHEMA_HASH,
    actionOwnerId: UNIV2_STANDARD_SWAP_ACTION_OWNER_ID,
    actionImplementationHash: UNIV2_STANDARD_SWAP_ACTION_IMPLEMENTATION_HASH,
    source: exact.source,
    inputs: exact.inputs,
    outputs: exact.outputs,
    gasUpperBound: UNIV2_STANDARD_SWAP_GAS_UPPER_BOUND,
    constraintRefs: exact.constraintRefs,
    obligationRefs: exact.obligationRefs,
    obligationRoot: exact.obligationRoot,
    exactEvaluationHash: exact.evaluationHash,
    opaqueBytes: calldata,
    effectTransport,
  };
  return decodeUniV2SwapAction({ ...withoutHash, actionHash: actionHash(withoutHash) });
}

export function decodeUniV2SwapAction(value: unknown, path = "univ2.swapAction"): UniV2SwapActionV1 {
  const decoded = decodeExactObject(value, {
    kind: (item, itemPath) => { if (item !== "univ2-standard.swap-action") throw new TypeError(`${itemPath} kind mismatch`); return item; },
    schemaVersion: (item, itemPath) => { if (item !== 1) throw new TypeError(`${itemPath} version mismatch`); return 1 as const; },
    schemaRef: (item, itemPath) => { if (item !== UNIV2_STANDARD_SWAP_ACTION_SCHEMA_HASH) throw new TypeError(`${itemPath} schema mismatch`); return UNIV2_STANDARD_SWAP_ACTION_SCHEMA_HASH; },
    actionOwnerId: (item, itemPath) => { if (item !== UNIV2_STANDARD_SWAP_ACTION_OWNER_ID) throw new TypeError(`${itemPath} owner mismatch`); return UNIV2_STANDARD_SWAP_ACTION_OWNER_ID; },
    actionImplementationHash: (item, itemPath) => { if (item !== UNIV2_STANDARD_SWAP_ACTION_IMPLEMENTATION_HASH) throw new TypeError(`${itemPath} implementation mismatch`); return UNIV2_STANDARD_SWAP_ACTION_IMPLEMENTATION_HASH; },
    source: (item, itemPath) => source(item, itemPath),
    inputs: (item, itemPath) => Array.isArray(item) ? item.map((entry, index) => decodeExactObject(entry, { assetRef: (field, fieldPath) => assertHash(field, fieldPath), amount: (field, fieldPath) => assertDecimalString(field, fieldPath) }, `${itemPath}[${index}]`)) : (() => { throw new TypeError(`${itemPath} must be an array`); })(),
    outputs: (item, itemPath) => Array.isArray(item) ? item.map((entry, index) => decodeExactObject(entry, { assetRef: (field, fieldPath) => assertHash(field, fieldPath), amount: (field, fieldPath) => assertDecimalString(field, fieldPath) }, `${itemPath}[${index}]`)) : (() => { throw new TypeError(`${itemPath} must be an array`); })(),
    gasUpperBound: (item, itemPath) => assertDecimalString(item, itemPath),
    constraintRefs: (item, itemPath) => Array.isArray(item) ? item.map((entry, index) => assertHash(entry, `${itemPath}[${index}]`)) : (() => { throw new TypeError(`${itemPath} must be an array`); })(),
    obligationRefs: (item, itemPath) => Array.isArray(item) ? item.map((entry, index) => decodeExactObject(entry, { kind: (field, fieldPath) => { if (field !== "input" && field !== "output") throw new TypeError(`${fieldPath} kind mismatch`); return field; }, ref: (field, fieldPath) => assertHash(field, fieldPath) }, `${itemPath}[${index}]`)) : (() => { throw new TypeError(`${itemPath} must be an array`); })(),
    obligationRoot: (item, itemPath) => assertHash(item, itemPath),
    exactEvaluationHash: (item, itemPath) => assertHash(item, itemPath),
    opaqueBytes: (item, itemPath) => assertNonEmptyString(item, itemPath),
    effectTransport: (item, itemPath) => normalizeEffectTransportDeclaration(item, itemPath),
    actionHash: (item, itemPath) => assertHash(item, itemPath),
  }, path);
  if (decoded.inputs.length !== 1 || decoded.outputs.length !== 1) throw new TypeError(`${path} amount vectors must have one leg`);
  const script = decodeActionScript(decoded.opaqueBytes, `${path}.opaqueBytes`);
  const calldata = script.swap;
  if ((calldata.amount0Out === 0n) === (calldata.amount1Out === 0n)) throw new TypeError(`${path} must contain exactly one output direction`);
  const calldataOutputAmount = (calldata.amount0Out === 0n ? calldata.amount1Out : calldata.amount0Out).toString(10);
  if (script.transfer.amount.toString(10) !== decoded.inputs[0]!.amount) throw new TypeError(`${path} transfer/input amount mismatch`);
  if (decoded.outputs[0]!.amount !== calldataOutputAmount) throw new TypeError(`${path} calldata/output amount mismatch`);
  if (decoded.gasUpperBound !== UNIV2_STANDARD_SWAP_GAS_UPPER_BOUND) throw new TypeError(`${path} gas bound mismatch`);
  if (decoded.obligationRoot !== hashDomain("aloha/univ2-standard/obligation-root/v1", decoded.obligationRefs)) throw new TypeError(`${path} obligation root mismatch`);
  const { actionHash: ignored, ...withoutHash } = decoded;
  void ignored;
  if (actionHash(withoutHash as Omit<UniV2SwapActionV1, "actionHash">) !== decoded.actionHash) throw new TypeError(`${path} hash mismatch`);
  return deepFreeze(decoded) as UniV2SwapActionV1;
}

export function verifyUniV2SwapActionObligations(value: unknown): UniV2SwapActionObligationProofV1 {
  const action = decodeUniV2SwapAction(value, "univ2.obligationProof.action");
  if (action.constraintRefs.length === 0 || action.inputs.length !== 1 || action.outputs.length !== 1) {
    throw new TypeError("univ2 obligation proof requires state constraints and one input/output");
  }
  const calldata = decodeActionScript(action.opaqueBytes, "univ2.obligationProof.opaqueBytes").swap;
  const direction: UniV2CoarseDirectionV1 = calldata.amount0Out === 0n ? "token0-to-token1" : "token1-to-token0";
  const matchingStateRoots = action.constraintRefs.filter(stateFactsRoot => {
    const common = { stateFactsRoot, direction, amountIn: action.inputs[0]!.amount, amountOut: action.outputs[0]!.amount };
    return action.obligationRefs[0]?.kind === "input"
      && action.obligationRefs[0].ref === hashDomain("aloha/univ2-standard/obligation/input/v1", common)
      && action.obligationRefs[1]?.kind === "output"
      && action.obligationRefs[1].ref === hashDomain("aloha/univ2-standard/obligation/output/v1", common);
  });
  if (matchingStateRoots.length !== 1) {
    throw new TypeError("univ2 obligation refs do not bind state, direction, and amounts");
  }
  const expected = action.obligationRefs;
  const obligations = Object.freeze([
    Object.freeze({ ref: expected[0]!.ref, relation: "debit" as const, assetRef: action.inputs[0]!.assetRef, amount: action.inputs[0]!.amount }),
    Object.freeze({ ref: expected[1]!.ref, relation: "credit" as const, assetRef: action.outputs[0]!.assetRef, amount: action.outputs[0]!.amount }),
  ]);
  const body = Object.freeze({
    actionHash: action.actionHash,
    exactEvaluationHash: action.exactEvaluationHash,
    obligationRoot: action.obligationRoot,
    obligations,
  });
  return deepFreeze({
    kind: "aloha.family-action-obligation-verifier-receipt-v1",
    schemaRef: UNIV2_STANDARD_SWAP_ACTION_SCHEMA_HASH,
    implementationHash: UNIV2_STANDARD_SWAP_ACTION_IMPLEMENTATION_HASH,
    subjectRoot: action.obligationRoot,
    proofRoot: hashDomain("aloha/univ2-standard/action-obligation-postcondition/v1", body),
    outcome: "satisfied",
  });
}

export const UNIV2_STANDARD_SWAP_ACTION_PORT: UniV2SwapActionPortV1 = Object.freeze({
  build,
  decode: decodeUniV2SwapAction,
  verifyObligations: verifyUniV2SwapActionObligations,
});
