import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { hashDomain, sha256Hex, type Hash } from "../../../../packages/canonical-codec/src/index.ts";
import { decodePackedCallProgram } from "../../../../packages/execution-program/src/index.ts";
import { FAMILY_CATALOG } from "../../../../generated/family-catalog/index.ts";
import {
  UNIV2_STANDARD_FAMILY_DEFINITION_HASH,
  UNIV2_STANDARD_SWAP_ACTION_PORT,
  type UniV2SwapActionInputV1,
} from "../../../../families/univ2-standard/src/public.ts";
import {
  UNIV3_STANDARD_FAMILY_DEFINITION_HASH,
  UNIV3_STANDARD_SWAP_ACTION_PORT,
} from "../../../../families/univ3-standard/src/public.ts";
import {
  currentReleaseFamilyDecisions,
  type CurrentReleaseFamilyExclusionReasonV1,
} from "../../../catalog-generator/src/current-release.ts";
import type { HistoricalExecutionSettlementCoverageV1 } from "./variant-observer.ts";

export type CurrentAdapterComparisonStatus =
  | "consistent"
  | "contradicted"
  | "unresolved";

export type CurrentAdapterComparisonReasonCode =
  | "current-action-exact-match"
  | "effects-not-qualified"
  | "variant-not-covered"
  | "observed-action-invalid"
  | "observed-variant-metadata-mismatch"
  | "settlement-not-proven"
  | "synthetic-probe-not-byte-comparable"
  | "current-action-build-unavailable"
  | "current-action-abi-invalid"
  | "current-action-target-mismatch"
  | "current-action-calldata-mismatch";

export type ObservedSwapDirection = "zero-for-one" | "one-for-zero";

export interface CurrentAdapterClosureBindingV1 {
  readonly family: "univ2-standard" | "univ3-standard";
  readonly familyDefinitionHash: Hash;
  readonly releaseDecision: "include" | "exclude";
  readonly releaseExclusionReasons: readonly CurrentReleaseFamilyExclusionReasonV1[];
  readonly definitionCatalogLeafDigest: Hash | null;
  readonly actionOwnerRefs: readonly Hash[];
}

interface ObservedExecutionBaseV1 {
  readonly direction: ObservedSwapDirection;
  readonly target: string;
  /** Complete calldata sent to the observed pool. */
  readonly calldata: string;
  readonly currentProbeBinding: "historical-equivalent" | "synthetic-shape-only";
}

export interface UniV2CurrentAdapterComparisonInputV1 extends ObservedExecutionBaseV1 {
  readonly family: "univ2-standard";
  readonly executionVariant: "canonical-swap";
  readonly settlementMode:
    | "empty-callback-settlement-unproven"
    | "empty-callback-with-pretransfer-witness"
    | "callback";
  readonly settlementCoverage: HistoricalExecutionSettlementCoverageV1;
  /** The comparator invokes the current production action port with this input. */
  readonly currentActionInput: UniV2SwapActionInputV1;
}

type UniV3ActionBuildInput = Parameters<typeof UNIV3_STANDARD_SWAP_ACTION_PORT.build>[0];

export interface UniV3CurrentAdapterComparisonInputV1 extends ObservedExecutionBaseV1 {
  readonly family: "univ3-standard";
  readonly executionVariant: "exact-input" | "exact-output";
  readonly settlementMode: "callback";
  /** The comparator invokes the current production action port with this input. */
  readonly currentActionInput: UniV3ActionBuildInput;
}

export type CurrentAdapterComparisonInputV1 =
  | UniV2CurrentAdapterComparisonInputV1
  | UniV3CurrentAdapterComparisonInputV1;

export interface CurrentAdapterComparisonV1 {
  readonly schemaVersion: 1;
  readonly kind: "aloha.current-adapter-execution-variant-comparison";
  readonly advisoryOnly: true;
  readonly comparatorSpecDigest: Hash;
  readonly comparatorImplementationDigest: Hash;
  readonly status: CurrentAdapterComparisonStatus;
  readonly reasonCodes: readonly CurrentAdapterComparisonReasonCode[];
  readonly currentClosureBinding: CurrentAdapterClosureBindingV1;
}

const UNIV2_SWAP_SELECTOR = "0x022c0d9f";
const UNIV3_SWAP_SELECTOR = "0x128acb08";

export const CURRENT_ADAPTER_COMPARATOR_SPEC_DIGEST_V1 = hashDomain(
  "aloha/current-adapter-execution-variant-comparator-spec/v1",
  Object.freeze({
    advisoryOnly: true,
    families: Object.freeze(["univ2-standard", "univ3-standard"]),
    denominator: "family-executionVariant-direction-settlementMode",
    currentReleaseBinding: "reviewed-release-decision-plus-generated-catalog-when-included",
    statuses: Object.freeze(["consistent", "contradicted", "unresolved"]),
  }),
);

export const CURRENT_ADAPTER_COMPARATOR_IMPLEMENTATION_DIGEST_V1 = hashDomain(
  "aloha/current-adapter-execution-variant-comparator-implementation/v1",
  Object.freeze({
    sourceSha256: sha256Hex(readFileSync(fileURLToPath(import.meta.url))),
    executionProgramSourceSha256: sha256Hex(readFileSync(fileURLToPath(new URL(
      "../../../../packages/execution-program/src/index.ts",
      import.meta.url,
    )))),
  }),
);

function canonicalAddress(value: string, path: string): string {
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) throw new TypeError(`${path} must be an address`);
  return value.toLowerCase();
}

function canonicalCalldata(value: string, path: string): string {
  if (!/^0x(?:[0-9a-fA-F]{2})*$/.test(value)) throw new TypeError(`${path} must be even-length hex calldata`);
  return value.toLowerCase();
}

function wordAt(calldata: string, index: number): string {
  return calldata.slice(10 + index * 64, 10 + (index + 1) * 64);
}

function uintWord(calldata: string, index: number): bigint {
  return BigInt(`0x${wordAt(calldata, index)}`);
}

function closureBinding(family: CurrentAdapterComparisonInputV1["family"]): CurrentAdapterClosureBindingV1 {
  const decisions = currentReleaseFamilyDecisions().filter((item) => item.familyId === family);
  if (decisions.length !== 1) throw new TypeError(`current release decision is unavailable for ${family}`);
  const decision = decisions[0]!;
  const matches = FAMILY_CATALOG.entries.filter((entry) => entry.familyId === family);
  const expectedCount = decision.decision === "include" ? 1 : 0;
  if (matches.length !== expectedCount) {
    throw new TypeError(`generated Family catalog does not match the current release decision for ${family}`);
  }
  const entry = matches[0] ?? null;
  const familyDefinitionHash = family === "univ2-standard"
    ? UNIV2_STANDARD_FAMILY_DEFINITION_HASH
    : UNIV3_STANDARD_FAMILY_DEFINITION_HASH;
  if (entry !== null && entry.familyDefinitionHash !== familyDefinitionHash) {
    throw new TypeError(`generated Family definition does not match current source for ${family}`);
  }
  return Object.freeze({
    family,
    familyDefinitionHash,
    releaseDecision: decision.decision,
    releaseExclusionReasons: Object.freeze([...decision.exclusionReasons]),
    definitionCatalogLeafDigest: entry === null ? null : entry.definitionCatalogLeafDigest as Hash,
    actionOwnerRefs: Object.freeze(entry?.actionOwnerRefs.map((ownerRef) => ownerRef as Hash) ?? []),
  });
}

function result(
  currentClosureBinding: CurrentAdapterClosureBindingV1,
  status: CurrentAdapterComparisonStatus,
  reasonCodes: readonly CurrentAdapterComparisonReasonCode[],
): CurrentAdapterComparisonV1 {
  return Object.freeze({
    schemaVersion: 1,
    kind: "aloha.current-adapter-execution-variant-comparison",
    advisoryOnly: true,
    comparatorSpecDigest: CURRENT_ADAPTER_COMPARATOR_SPEC_DIGEST_V1,
    comparatorImplementationDigest: CURRENT_ADAPTER_COMPARATOR_IMPLEMENTATION_DIGEST_V1,
    status,
    reasonCodes: Object.freeze([...reasonCodes]),
    currentClosureBinding,
  });
}

interface ParsedUniV2Swap {
  readonly direction: ObservedSwapDirection;
  readonly callbackData: string;
  readonly recipient: string;
  readonly outputAmount: bigint;
}

function parseUniV2Swap(value: string): ParsedUniV2Swap {
  const calldata = canonicalCalldata(value, "observed.calldata");
  if (!calldata.startsWith(UNIV2_SWAP_SELECTOR) || calldata.length < 10 + 64 * 5 || (calldata.length - 10) % 64 !== 0) {
    throw new TypeError("observed UniV2 swap calldata length or selector mismatch");
  }
  const amount0Out = uintWord(calldata, 0);
  const amount1Out = uintWord(calldata, 1);
  if ((amount0Out === 0n) === (amount1Out === 0n)) throw new TypeError("observed UniV2 swap must have exactly one output direction");
  const recipientWord = wordAt(calldata, 2);
  if (!/^0{24}[0-9a-f]{40}$/.test(recipientWord)) throw new TypeError("observed UniV2 recipient padding invalid");
  if (uintWord(calldata, 3) !== 128n) throw new TypeError("observed UniV2 dynamic offset mismatch");
  const callbackLengthWord = uintWord(calldata, 4);
  if (callbackLengthWord > BigInt(Number.MAX_SAFE_INTEGER)) throw new TypeError("observed UniV2 callback length exceeds safe range");
  const callbackLength = Number(callbackLengthWord);
  const callbackStart = 10 + 64 * 5;
  const callbackEnd = callbackStart + callbackLength * 2;
  const expectedEnd = callbackStart + Math.ceil(callbackLength / 32) * 64;
  if (callbackEnd > calldata.length || calldata.length !== expectedEnd || !/^0*$/.test(calldata.slice(callbackEnd))) {
    throw new TypeError("observed UniV2 callback length or padding invalid");
  }
  return Object.freeze({
    direction: amount0Out === 0n ? "zero-for-one" : "one-for-zero",
    callbackData: `0x${calldata.slice(callbackStart, callbackEnd)}`,
    recipient: `0x${recipientWord.slice(24)}`,
    outputAmount: amount0Out > 0n ? amount0Out : amount1Out,
  });
}

function prepaidWitnessMatchesObserved(
  input: UniV2CurrentAdapterComparisonInputV1,
  observed: ParsedUniV2Swap,
): boolean {
  const witness = input.settlementCoverage;
  if (witness.status !== "observed" || witness.kind !== "univ2-prepaid-transfer-before-swap") return false;
  const expectedOutputRole = observed.direction === "zero-for-one" ? "token1" : "token0";
  const expectedInputRole = expectedOutputRole === "token0" ? "token1" : "token0";
  try {
    return canonicalAddress(witness.pair, "settlement.pair") === canonicalAddress(input.target, "observed.target")
      && canonicalAddress(witness.outputRecipient, "settlement.outputRecipient") === observed.recipient
      && canonicalAddress(witness.inputToken, "settlement.inputToken")
        !== canonicalAddress(witness.outputToken, "settlement.outputToken")
      && witness.inputTokenRole === expectedInputRole
      && witness.outputTokenRole === expectedOutputRole
      && /^(0|[1-9][0-9]*)$/.test(witness.inputAmount)
      && BigInt(witness.inputAmount) > 0n
      && witness.outputAmount === observed.outputAmount.toString(10);
  } catch {
    return false;
  }
}

interface ParsedUniV3Swap {
  readonly direction: ObservedSwapDirection;
  readonly executionVariant: "exact-input" | "exact-output";
}

/** Strict canonical ABI parser for swap(address,bool,int256,uint160,bytes). */
function parseCanonicalUniV3Swap(value: string): ParsedUniV3Swap {
  const calldata = canonicalCalldata(value, "observed.calldata");
  if (!calldata.startsWith(UNIV3_SWAP_SELECTOR) || calldata.length < 10 + 64 * 6 || (calldata.length - 10) % 64 !== 0) {
    throw new TypeError("UniV3 swap calldata length or selector mismatch");
  }
  const recipientWord = wordAt(calldata, 0);
  if (!/^0{24}[0-9a-f]{40}$/.test(recipientWord)) throw new TypeError("UniV3 recipient padding invalid");
  const zeroForOne = uintWord(calldata, 1);
  if (zeroForOne !== 0n && zeroForOne !== 1n) throw new TypeError("UniV3 direction bool invalid");
  const amountSpecifiedWord = uintWord(calldata, 2);
  const amountSpecified = amountSpecifiedWord < (1n << 255n)
    ? amountSpecifiedWord
    : amountSpecifiedWord - (1n << 256n);
  if (amountSpecified === 0n) throw new TypeError("UniV3 amountSpecified must be non-zero");
  if (!/^0{24}[0-9a-f]{40}$/.test(wordAt(calldata, 3))) throw new TypeError("UniV3 sqrtPriceLimitX96 exceeds uint160");
  if (uintWord(calldata, 4) !== 160n) throw new TypeError("UniV3 dynamic offset mismatch");
  const dataLengthWord = uintWord(calldata, 5);
  if (dataLengthWord > BigInt(Number.MAX_SAFE_INTEGER)) throw new TypeError("UniV3 callback data length exceeds safe range");
  const dataLength = Number(dataLengthWord);
  const dataStart = 10 + 64 * 6;
  const dataEnd = dataStart + dataLength * 2;
  const expectedEnd = dataStart + Math.ceil(dataLength / 32) * 64;
  if (dataEnd > calldata.length || calldata.length !== expectedEnd || !/^0*$/.test(calldata.slice(dataEnd))) {
    throw new TypeError("UniV3 callback data length or padding invalid");
  }
  return Object.freeze({
    direction: zeroForOne === 1n ? "zero-for-one" : "one-for-zero",
    executionVariant: amountSpecified > 0n ? "exact-input" : "exact-output",
  });
}

function compareUniV2(
  input: UniV2CurrentAdapterComparisonInputV1,
  binding: CurrentAdapterClosureBindingV1,
): CurrentAdapterComparisonV1 {
  let observed: ParsedUniV2Swap;
  try {
    canonicalAddress(input.target, "observed.target");
    observed = parseUniV2Swap(input.calldata);
  } catch {
    return result(binding, "unresolved", ["observed-action-invalid"]);
  }

  const callbackIsEmpty = observed.callbackData === "0x";
  const actualSettlement = callbackIsEmpty ? input.settlementMode : "callback";
  if (
    input.executionVariant !== "canonical-swap"
    || input.settlementMode !== actualSettlement
    || input.direction !== observed.direction
  ) {
    return result(binding, "unresolved", ["observed-variant-metadata-mismatch"]);
  }
  if (callbackIsEmpty) {
    if (
      input.settlementMode !== "empty-callback-with-pretransfer-witness"
      || !prepaidWitnessMatchesObserved(input, observed)
    ) return result(binding, "unresolved", ["settlement-not-proven"]);
  } else if (input.settlementMode !== "callback") {
    return result(binding, "unresolved", ["observed-variant-metadata-mismatch"]);
  }
  let currentTarget: string;
  let currentCalldata: string;
  try {
    const baseInput = { ...input.currentActionInput, callbackDataHex: "0x" };
    UNIV2_STANDARD_SWAP_ACTION_PORT.decode(UNIV2_STANDARD_SWAP_ACTION_PORT.build(baseInput));
    let action: ReturnType<typeof UNIV2_STANDARD_SWAP_ACTION_PORT.build>;
    try {
      action = UNIV2_STANDARD_SWAP_ACTION_PORT.decode(
        UNIV2_STANDARD_SWAP_ACTION_PORT.build({
          ...input.currentActionInput,
          callbackDataHex: observed.callbackData,
        }),
      );
    } catch {
      if (actualSettlement === "callback") return result(binding, "unresolved", ["variant-not-covered"]);
      throw new TypeError("current empty-callback action build failed");
    }
    const calls = decodePackedCallProgram(action.opaqueBytes, "current.univ2.action.opaqueBytes");
    if (calls.length !== 2) throw new TypeError("current UniV2 action is not transfer plus swap");
    currentTarget = canonicalAddress(calls[1]!.target, "current.univ2.swap.target");
    currentCalldata = canonicalCalldata(calls[1]!.calldata, "current.univ2.swap.calldata");
    const parsedCurrent = parseUniV2Swap(currentCalldata);
    if (parsedCurrent.callbackData !== observed.callbackData) {
      throw new TypeError("current UniV2 action callback differs from observed variant");
    }
  } catch {
    return result(binding, "unresolved", ["current-action-build-unavailable"]);
  }
  if (currentTarget !== input.target.toLowerCase()) {
    return result(binding, "contradicted", ["current-action-target-mismatch"]);
  }
  if (input.currentProbeBinding === "synthetic-shape-only") {
    return result(binding, "unresolved", ["synthetic-probe-not-byte-comparable", "effects-not-qualified"]);
  }
  if (currentCalldata !== input.calldata.toLowerCase()) {
    return result(binding, "contradicted", ["current-action-calldata-mismatch"]);
  }
  return result(binding, "consistent", ["current-action-exact-match", "effects-not-qualified"]);
}

function compareUniV3(
  input: UniV3CurrentAdapterComparisonInputV1,
  binding: CurrentAdapterClosureBindingV1,
): CurrentAdapterComparisonV1 {
  let observed: ParsedUniV3Swap;
  try {
    canonicalAddress(input.target, "observed.target");
    observed = parseCanonicalUniV3Swap(input.calldata);
  } catch {
    return result(binding, "unresolved", ["observed-action-invalid"]);
  }
  if (input.direction !== observed.direction || input.executionVariant !== observed.executionVariant) {
    return result(binding, "unresolved", ["observed-variant-metadata-mismatch"]);
  }

  let currentTarget: string;
  let currentCalldata: string;
  try {
    const action = UNIV3_STANDARD_SWAP_ACTION_PORT.build(input.currentActionInput);
    currentTarget = canonicalAddress(action.target, "current.univ3.action.target");
    currentCalldata = canonicalCalldata(action.calldata, "current.univ3.action.calldata");
  } catch {
    return result(binding, "unresolved", ["current-action-build-unavailable"]);
  }
  try {
    parseCanonicalUniV3Swap(currentCalldata);
  } catch {
    return result(binding, "contradicted", ["current-action-abi-invalid"]);
  }
  if (currentTarget !== input.target.toLowerCase()) {
    return result(binding, "contradicted", ["current-action-target-mismatch"]);
  }
  if (input.currentProbeBinding === "synthetic-shape-only") {
    return result(binding, "unresolved", ["synthetic-probe-not-byte-comparable", "effects-not-qualified"]);
  }
  if (currentCalldata !== input.calldata.toLowerCase()) {
    return result(binding, "contradicted", ["current-action-calldata-mismatch"]);
  }
  return result(binding, "consistent", ["current-action-exact-match", "effects-not-qualified"]);
}

/**
 * Advisory comparator only. It neither qualifies effects nor gates admission,
 * execution, or production release.
 */
export function compareCurrentAdapterExecutionVariantV1(
  input: CurrentAdapterComparisonInputV1,
): CurrentAdapterComparisonV1 {
  const binding = closureBinding(input.family);
  return input.family === "univ2-standard"
    ? compareUniV2(input, binding)
    : compareUniV3(input, binding);
}
