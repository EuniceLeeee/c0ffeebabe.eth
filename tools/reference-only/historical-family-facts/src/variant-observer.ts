import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  hashDomain,
  sha256Hex,
  type CanonicalJson,
  type Hash,
} from "../../../../packages/canonical-codec/src/index.ts";
import {
  loadHistoricalFamilyFactBundleV1,
  type HistoricalFamilyFactManifestV1,
  type HistoricalRpcRole,
  type SupportedSelectorCandidateV1,
} from "./index.ts";

const UNIV2_SWAP_SELECTOR = "0x022c0d9f" as const;
const UNIV3_SWAP_SELECTOR = "0x128acb08" as const;
const ERC20_TRANSFER_SELECTOR = "0xa9059cbb" as const;
const ERC20_TRANSFER_FROM_SELECTOR = "0x23b872dd" as const;

const OBSERVER_SPEC_V1 = Object.freeze({
  schemaVersion: 1,
  kind: "aloha.historical-execution-variant-observer-spec",
  advisoryOnly: true,
  selectorCandidates: Object.freeze({
    "univ2-standard": Object.freeze({
      selector: UNIV2_SWAP_SELECTOR,
      signature: "swap(uint256,uint256,address,bytes)",
      canonicalDynamicOffsetBytes: "128",
    }),
    "univ3-standard": Object.freeze({
      selector: UNIV3_SWAP_SELECTOR,
      signature: "swap(address,bool,int256,uint160,bytes)",
      canonicalDynamicOffsetBytes: "160",
    }),
  }),
  identityPolicy: "manifest-transaction-receipt-header-membership-stateRoot-and-trace-root",
  tracePolicy: "successful-callTracer-frame-and-successful-ancestors",
  prepaidSettlementPolicy:
    "unique-successful-pre-transfer-since-prior-same-pair-swap-plus-exact-output-transfer-descendant",
  logPolicy: "frame-local-logs-required-no-receipt-greedy-association",
  effectsPolicy: "frame-local-effects-required",
});

const OBSERVER_IMPLEMENTATION_V1 = Object.freeze({
  schemaVersion: 1,
  kind: "aloha.historical-execution-variant-observer-implementation",
  abiPolicy: "exact-head-offset-address-bool-uint160-bytes-padding-and-length",
  identityJoin: "transactionIndex-header-transactions-and-exact-root-call",
  calldataCommitment: "sha256-full-calldata-bytes",
  frameIdentity: "preorder-index-path-from-to-value",
  grouping: "selectorCandidate-executionVariant-direction-settlementMode",
});

export const HISTORICAL_EXECUTION_VARIANT_OBSERVER_SPEC_DIGEST_V1 = hashDomain(
  "aloha/historical-execution-variant-observer-spec/v1",
  OBSERVER_SPEC_V1,
);

export const HISTORICAL_EXECUTION_VARIANT_OBSERVER_IMPLEMENTATION_DIGEST_V1 = hashDomain(
  "aloha/historical-execution-variant-observer-implementation/v1",
  {
    descriptor: OBSERVER_IMPLEMENTATION_V1,
    sourceFiles: Object.freeze([
      Object.freeze({
        role: "observer",
        sha256: sha256Hex(readFileSync(fileURLToPath(import.meta.url))),
      }),
      Object.freeze({
        role: "bundle-loader",
        sha256: sha256Hex(readFileSync(fileURLToPath(new URL("./index.ts", import.meta.url)))),
      }),
      Object.freeze({
        role: "canonical-codec",
        sha256: sha256Hex(readFileSync(fileURLToPath(new URL("../../../../packages/canonical-codec/src/index.ts", import.meta.url)))),
      }),
    ]),
  },
);

export type HistoricalExecutionVariantStatusV1 = "observed" | "unresolved";
export type HistoricalExecutionDirectionV1 = "zero-for-one" | "one-for-zero";
export type HistoricalExecutionVariantV1 =
  | "canonical-swap"
  | "exact-input"
  | "exact-output";
export type HistoricalSettlementModeV1 =
  | "empty-callback-settlement-unproven"
  | "empty-callback-with-pretransfer-witness"
  | "callback";

export interface HistoricalExecutionManifestIdentityV1 {
  readonly manifestRoot: Hash;
  readonly chainId: string | null;
  readonly canonicalBlockHash: Hash | null;
  readonly txHash: Hash | null;
}

export interface HistoricalExecutionCoverageV1 {
  readonly status: "unresolved";
  readonly reason: string;
}

export interface HistoricalUniV2PrepaidSettlementWitnessV1 {
  readonly status: "observed";
  readonly kind: "univ2-prepaid-transfer-before-swap";
  readonly associationPolicy:
    "unique-successful-pre-transfer-since-prior-same-pair-swap-and-exact-output-transfer-descendant";
  readonly inputTransferMethod: "transfer" | "transferFrom";
  readonly inputTransferFramePath: readonly string[];
  readonly inputTransferFrameIndex: string;
  readonly inputToken: string;
  readonly inputTokenRole: "token0" | "token1";
  readonly inputSender: string;
  readonly pair: string;
  readonly inputAmount: string;
  readonly outputTransferFramePath: readonly string[];
  readonly outputTransferFrameIndex: string;
  readonly outputToken: string;
  readonly outputTokenRole: "token0" | "token1";
  readonly outputRecipient: string;
  readonly outputAmount: string;
}

export type HistoricalExecutionSettlementCoverageV1 =
  | HistoricalExecutionCoverageV1
  | HistoricalUniV2PrepaidSettlementWitnessV1;

export interface HistoricalExecutionVariantCaseV1 {
  readonly selectorCandidate: SupportedSelectorCandidateV1;
  readonly identityStatus: "selector-candidate-only";
  readonly executionVariant: HistoricalExecutionVariantV1;
  readonly direction: HistoricalExecutionDirectionV1;
  readonly settlementMode: HistoricalSettlementModeV1;
  readonly framePath: readonly string[];
  readonly frameIndex: string;
  readonly from: string;
  readonly to: string;
  readonly value: string;
  readonly selector: typeof UNIV2_SWAP_SELECTOR | typeof UNIV3_SWAP_SELECTOR;
  readonly calldataSha256: Hash;
  readonly calldataByteLength: string;
  readonly callbackDataByteLength: string;
  readonly settlementCoverage: HistoricalExecutionSettlementCoverageV1;
  readonly logCoverage: HistoricalExecutionCoverageV1;
  readonly effectsCoverage: HistoricalExecutionCoverageV1;
  readonly caseId: Hash;
}

export interface HistoricalExecutionVariantGroupV1 {
  readonly selectorCandidate: SupportedSelectorCandidateV1;
  readonly identityStatus: "selector-candidate-only";
  readonly executionVariant: HistoricalExecutionVariantV1;
  readonly direction: HistoricalExecutionDirectionV1;
  readonly settlementMode: HistoricalSettlementModeV1;
  readonly caseIds: readonly Hash[];
}

export interface HistoricalExecutionVariantObservationV1 {
  readonly schemaVersion: 1;
  readonly kind: "aloha.historical-execution-variant-observation";
  readonly advisoryOnly: true;
  readonly status: HistoricalExecutionVariantStatusV1;
  readonly reasons: readonly string[];
  readonly observerSpecDigest: Hash;
  readonly observerImplementationDigest: Hash;
  readonly manifestIdentity: HistoricalExecutionManifestIdentityV1;
  readonly cases: readonly HistoricalExecutionVariantCaseV1[];
  readonly groups: readonly HistoricalExecutionVariantGroupV1[];
  readonly caseRoot: Hash;
}

interface DecodedVariantBase {
  readonly executionVariant: HistoricalExecutionVariantV1;
  readonly direction: HistoricalExecutionDirectionV1;
  readonly settlementMode: HistoricalSettlementModeV1;
  readonly selector: typeof UNIV2_SWAP_SELECTOR | typeof UNIV3_SWAP_SELECTOR;
  readonly callbackDataByteLength: string;
}

interface DecodedUniV2Variant extends DecodedVariantBase {
  readonly family: "univ2-standard";
  readonly recipient: string;
  readonly amount0Out: bigint;
  readonly amount1Out: bigint;
}

interface DecodedUniV3Variant extends DecodedVariantBase {
  readonly family: "univ3-standard";
}

type DecodedVariant = DecodedUniV2Variant | DecodedUniV3Variant;

function fail(message: string): never {
  throw new TypeError(message);
}

function plainObject(value: unknown, path: string): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) fail(`expected plain object at ${path}`);
  return value as Record<string, unknown>;
}

function address(value: unknown, path: string): string {
  if (typeof value !== "string") fail(`expected address at ${path}`);
  const result = value.toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(result)) fail(`expected address at ${path}`);
  return result;
}

function hexData(value: unknown, path: string): string {
  if (typeof value !== "string") fail(`expected hex data at ${path}`);
  const result = value.toLowerCase();
  if (!/^0x(?:[0-9a-f]{2})*$/.test(result)) fail(`expected even-length hex data at ${path}`);
  return result;
}

function hexQuantity(value: unknown, path: string): string {
  if (typeof value !== "string") fail(`expected canonical hex quantity at ${path}`);
  const result = value.toLowerCase();
  if (!/^0x(?:0|[1-9a-f][0-9a-f]*)$/.test(result)) {
    fail(`expected canonical hex quantity at ${path}`);
  }
  return result;
}

function hash(value: unknown, path: string): Hash {
  if (typeof value !== "string") fail(`expected 32-byte hash at ${path}`);
  const result = value.toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(result)) fail(`expected 32-byte hash at ${path}`);
  return result as Hash;
}

function assertHistoricalIdentity(
  manifest: HistoricalFamilyFactManifestV1,
  results: Readonly<Record<HistoricalRpcRole, CanonicalJson>>,
): void {
  const transaction = plainObject(results.transaction, "$.transaction");
  const receipt = plainObject(results.receipt, "$.receipt");
  const header = plainObject(results.header, "$.header");
  const trace = plainObject(results.trace, "$.trace");
  if (hash(transaction.hash, "$.transaction.hash") !== manifest.txHash) fail("transaction hash does not match manifest");
  if (hash(transaction.blockHash, "$.transaction.blockHash") !== manifest.canonicalBlockHash) {
    fail("transaction block hash does not match manifest");
  }
  if (hash(receipt.transactionHash, "$.receipt.transactionHash") !== manifest.txHash) {
    fail("receipt transaction hash does not match manifest");
  }
  if (hash(receipt.blockHash, "$.receipt.blockHash") !== manifest.canonicalBlockHash) {
    fail("receipt block hash does not match manifest");
  }
  if (hexQuantity(receipt.status, "$.receipt.status") !== "0x1") fail("receipt status is not successful");
  if (hash(header.hash, "$.header.hash") !== manifest.canonicalBlockHash) fail("header hash does not match manifest");
  hash(header.stateRoot, "$.header.stateRoot");
  const transactionIndex = hexQuantity(transaction.transactionIndex, "$.transaction.transactionIndex");
  const receiptIndex = hexQuantity(receipt.transactionIndex, "$.receipt.transactionIndex");
  if (receiptIndex !== transactionIndex) fail("transaction and receipt transactionIndex mismatch");
  const numericIndex = BigInt(transactionIndex);
  if (numericIndex > BigInt(Number.MAX_SAFE_INTEGER)) fail("transactionIndex exceeds observer bounds");
  if (!Array.isArray(header.transactions)) fail("expected transactions array at $.header.transactions");
  const indexedHash = header.transactions[Number(numericIndex)];
  if (indexedHash === undefined) fail("transactionIndex is outside header.transactions");
  if (hash(indexedHash, `$.header.transactions[${numericIndex}]`) !== manifest.txHash) {
    fail("header transaction at transactionIndex does not match manifest txHash");
  }
  if (trace.type !== "CALL") fail("trace root type does not match transaction CALL");
  if (address(trace.from, "$.trace.from") !== address(transaction.from, "$.transaction.from")) {
    fail("trace root from does not match transaction");
  }
  if (address(trace.to, "$.trace.to") !== address(transaction.to, "$.transaction.to")) {
    fail("trace root to does not match transaction");
  }
  if (hexData(trace.input, "$.trace.input") !== hexData(transaction.input, "$.transaction.input")) {
    fail("trace root input does not match transaction");
  }
  if (hexQuantity(trace.value, "$.trace.value") !== hexQuantity(transaction.value, "$.transaction.value")) {
    fail("trace root value does not match transaction");
  }
}

function hasFailure(node: Record<string, unknown>): boolean {
  return Object.prototype.hasOwnProperty.call(node, "error") ||
    Object.prototype.hasOwnProperty.call(node, "revertReason") ||
    node.failed === true ||
    node.success === false;
}

function word(body: string, index: number, path: string): string {
  const start = index * 64;
  if (body.length < start + 64) fail(`truncated ABI word at ${path}`);
  return body.slice(start, start + 64);
}

function unsignedWord(body: string, index: number, path: string): bigint {
  return BigInt(`0x${word(body, index, path)}`);
}

function signedWord(body: string, index: number, path: string): bigint {
  const unsigned = unsignedWord(body, index, path);
  return unsigned < (1n << 255n) ? unsigned : unsigned - (1n << 256n);
}

function addressWord(body: string, index: number, path: string): string {
  const encoded = word(body, index, path);
  if (!/^0{24}/.test(encoded)) fail(`non-canonical address padding at ${path}`);
  return `0x${encoded.slice(24)}`;
}

function uint160Word(body: string, index: number, path: string): bigint {
  const encoded = word(body, index, path);
  if (!/^0{24}/.test(encoded)) fail(`non-canonical uint160 padding at ${path}`);
  return BigInt(`0x${encoded}`);
}

function boolWord(body: string, index: number, path: string): boolean {
  const encoded = unsignedWord(body, index, path);
  if (encoded !== 0n && encoded !== 1n) fail(`non-canonical bool at ${path}`);
  return encoded === 1n;
}

function dynamicBytesLength(
  body: string,
  headWords: number,
  offsetIndex: number,
  path: string,
): number {
  const bodyBytes = body.length / 2;
  const expectedOffset = BigInt(headWords * 32);
  const offset = unsignedWord(body, offsetIndex, `${path}.offset`);
  if (offset !== expectedOffset) fail(`non-canonical dynamic offset at ${path}`);
  const lengthWordIndex = Number(offset / 32n);
  const length = unsignedWord(body, lengthWordIndex, `${path}.length`);
  if (length > BigInt(Number.MAX_SAFE_INTEGER)) fail(`dynamic bytes length exceeds observer bounds at ${path}`);
  const byteLength = Number(length);
  const paddedLength = Math.ceil(byteLength / 32) * 32;
  const expectedBodyBytes = Number(offset) + 32 + paddedLength;
  if (bodyBytes !== expectedBodyBytes) fail(`trailing or truncated dynamic ABI data at ${path}`);
  const dataStart = (Number(offset) + 32) * 2;
  const padding = body.slice(dataStart + byteLength * 2);
  if (!/^0*$/.test(padding)) fail(`non-zero dynamic bytes padding at ${path}`);
  return byteLength;
}

function decodeUniV2(calldata: string, path: string): DecodedVariant {
  const body = calldata.slice(10);
  const amount0Out = unsignedWord(body, 0, `${path}.amount0Out`);
  const amount1Out = unsignedWord(body, 1, `${path}.amount1Out`);
  const recipient = addressWord(body, 2, `${path}.to`);
  const callbackDataByteLength = dynamicBytesLength(body, 4, 3, `${path}.data`);
  let direction: HistoricalExecutionDirectionV1;
  if (amount0Out > 0n && amount1Out === 0n) direction = "one-for-zero";
  else if (amount0Out === 0n && amount1Out > 0n) direction = "zero-for-one";
  else fail(`UniV2 swap must have exactly one non-zero output at ${path}`);
  return Object.freeze({
    family: "univ2-standard",
    executionVariant: "canonical-swap",
    direction,
    settlementMode: callbackDataByteLength === 0 ? "empty-callback-settlement-unproven" : "callback",
    selector: UNIV2_SWAP_SELECTOR,
    callbackDataByteLength: String(callbackDataByteLength),
    recipient,
    amount0Out,
    amount1Out,
  });
}

function decodeUniV3(calldata: string, path: string): DecodedVariant {
  const body = calldata.slice(10);
  addressWord(body, 0, `${path}.recipient`);
  const zeroForOne = boolWord(body, 1, `${path}.zeroForOne`);
  const amountSpecified = signedWord(body, 2, `${path}.amountSpecified`);
  uint160Word(body, 3, `${path}.sqrtPriceLimitX96`);
  const callbackDataByteLength = dynamicBytesLength(body, 5, 4, `${path}.data`);
  if (amountSpecified === 0n) fail(`UniV3 amountSpecified must be non-zero at ${path}`);
  return Object.freeze({
    family: "univ3-standard",
    executionVariant: amountSpecified > 0n ? "exact-input" : "exact-output",
    direction: zeroForOne ? "zero-for-one" : "one-for-zero",
    settlementMode: "callback",
    selector: UNIV3_SWAP_SELECTOR,
    callbackDataByteLength: String(callbackDataByteLength),
  });
}

function decodeVariant(calldata: string, path: string): DecodedVariant | null {
  if (calldata.startsWith(UNIV2_SWAP_SELECTOR)) return decodeUniV2(calldata, path);
  if (calldata.startsWith(UNIV3_SWAP_SELECTOR)) return decodeUniV3(calldata, path);
  return null;
}

const LOG_COVERAGE: HistoricalExecutionCoverageV1 = Object.freeze({
  status: "unresolved",
  reason: "callTracer has no frame-local logs; receipt logs are not associated greedily",
});

const EFFECTS_COVERAGE: HistoricalExecutionCoverageV1 = Object.freeze({
  status: "unresolved",
  reason: "callTracer has no frame-local token or balance effects",
});

const CALLBACK_SETTLEMENT_COVERAGE: HistoricalExecutionCoverageV1 = Object.freeze({
  status: "unresolved",
  reason: "callback settlement is not independently proven by this call-trace observer",
});

interface TraceFrame {
  readonly node: Record<string, unknown>;
  readonly path: readonly number[];
  readonly tracePath: string;
  readonly frameIndex: number;
  readonly successful: boolean;
  readonly from: string | null;
  readonly to: string | null;
  readonly input: string | null;
}

interface Erc20TransferFrame {
  readonly method: "transfer" | "transferFrom";
  readonly frame: TraceFrame;
  readonly token: string;
  readonly sender: string;
  readonly recipient: string;
  readonly amount: bigint;
}

function decodeErc20Transfer(frame: TraceFrame): Erc20TransferFrame | null {
  if (!frame.successful || frame.node.type !== "CALL" || frame.input === null || frame.to === null || frame.from === null) {
    return null;
  }
  const selector = frame.input.slice(0, 10);
  const body = frame.input.slice(10);
  if (selector === ERC20_TRANSFER_SELECTOR) {
    if (body.length !== 128) return null;
    return Object.freeze({
      method: "transfer",
      frame,
      token: frame.to,
      sender: frame.from,
      recipient: addressWord(body, 0, `${frame.tracePath}.input.to`),
      amount: unsignedWord(body, 1, `${frame.tracePath}.input.amount`),
    });
  }
  if (selector === ERC20_TRANSFER_FROM_SELECTOR) {
    if (body.length !== 192) return null;
    return Object.freeze({
      method: "transferFrom",
      frame,
      token: frame.to,
      sender: addressWord(body, 0, `${frame.tracePath}.input.from`),
      recipient: addressWord(body, 1, `${frame.tracePath}.input.to`),
      amount: unsignedWord(body, 2, `${frame.tracePath}.input.amount`),
    });
  }
  return null;
}

function isDescendantPath(candidate: readonly number[], ancestor: readonly number[]): boolean {
  return candidate.length > ancestor.length && ancestor.every((value, index) => candidate[index] === value);
}

function unresolvedSettlement(reason: string): HistoricalExecutionCoverageV1 {
  return Object.freeze({ status: "unresolved", reason });
}

function prepaidSettlementWitness(
  swapFrame: TraceFrame,
  decoded: DecodedUniV2Variant,
  transfers: readonly Erc20TransferFrame[],
  priorSamePairSwapIndex: number,
): HistoricalExecutionSettlementCoverageV1 {
  if (swapFrame.to === null) return unresolvedSettlement("empty callback swap target is unavailable");
  const outputAmount = decoded.amount0Out > 0n ? decoded.amount0Out : decoded.amount1Out;
  const outputTransfers = transfers.filter((item) =>
    item.method === "transfer"
    && item.frame.from === swapFrame.to
    && item.recipient === decoded.recipient
    && item.amount === outputAmount
    && isDescendantPath(item.frame.path, swapFrame.path)
  );
  if (outputTransfers.length !== 1) {
    return unresolvedSettlement("empty callback swap lacks one unique exact output-token transfer descendant");
  }
  const outputTransfer = outputTransfers[0]!;
  const candidates = transfers.filter((item) =>
    item.frame.frameIndex > priorSamePairSwapIndex
    && item.frame.frameIndex < swapFrame.frameIndex
    && item.recipient === swapFrame.to
    && item.amount > 0n
    && item.token !== outputTransfer.token
  );
  if (candidates.length !== 1) {
    return unresolvedSettlement("empty callback swap lacks one unique trace-local pre-transfer witness");
  }
  const inputTransfer = candidates[0]!;
  const outputTokenRole = decoded.amount0Out > 0n ? "token0" : "token1";
  const inputTokenRole = outputTokenRole === "token0" ? "token1" : "token0";
  return Object.freeze({
    status: "observed",
    kind: "univ2-prepaid-transfer-before-swap",
    associationPolicy:
      "unique-successful-pre-transfer-since-prior-same-pair-swap-and-exact-output-transfer-descendant",
    inputTransferMethod: inputTransfer.method,
    inputTransferFramePath: Object.freeze(inputTransfer.frame.path.map(String)),
    inputTransferFrameIndex: String(inputTransfer.frame.frameIndex),
    inputToken: inputTransfer.token,
    inputTokenRole,
    inputSender: inputTransfer.sender,
    pair: swapFrame.to,
    inputAmount: inputTransfer.amount.toString(10),
    outputTransferFramePath: Object.freeze(outputTransfer.frame.path.map(String)),
    outputTransferFrameIndex: String(outputTransfer.frame.frameIndex),
    outputToken: outputTransfer.token,
    outputTokenRole,
    outputRecipient: outputTransfer.recipient,
    outputAmount: outputTransfer.amount.toString(10),
  });
}

function observeCases(trace: CanonicalJson): readonly Omit<HistoricalExecutionVariantCaseV1, "caseId">[] {
  const frames: TraceFrame[] = [];
  let frameIndex = 0;
  const visit = (raw: unknown, path: readonly number[], ancestorsSuccessful: boolean): void => {
    const tracePath = `$.trace${path.map((index) => `.calls[${index}]`).join("")}`;
    const node = plainObject(raw, tracePath);
    const currentIndex = frameIndex++;
    const successful = ancestorsSuccessful && !hasFailure(node);
    const input = typeof node.input === "string" ? hexData(node.input, `${tracePath}.input`) : null;
    if (node.input !== undefined && input === null) {
      fail(`expected hex data at ${tracePath}.input`);
    }
    frames.push(Object.freeze({
      node,
      path: Object.freeze([...path]),
      tracePath,
      frameIndex: currentIndex,
      successful,
      from: typeof node.from === "string" ? address(node.from, `${tracePath}.from`) : null,
      to: typeof node.to === "string" ? address(node.to, `${tracePath}.to`) : null,
      input,
    }));
    if (node.calls !== undefined) {
      if (!Array.isArray(node.calls)) fail(`expected calls array at ${tracePath}.calls`);
      node.calls.forEach((child, childIndex) => visit(child, [...path, childIndex], successful));
    }
  };
  visit(trace, [], true);
  const transfers = Object.freeze(frames.map(decodeErc20Transfer).filter(
    (item): item is Erc20TransferFrame => item !== null,
  ));
  const cases: Omit<HistoricalExecutionVariantCaseV1, "caseId">[] = [];
  for (const frame of frames) {
    if (!frame.successful || frame.input === null) continue;
    const selector = frame.input.length >= 10 ? frame.input.slice(0, 10) : frame.input;
    if (selector !== UNIV2_SWAP_SELECTOR && selector !== UNIV3_SWAP_SELECTOR) continue;
    if (frame.node.type !== "CALL") fail(`swap frame must have CALL type at ${frame.tracePath}.type`);
    if (frame.from === null || frame.to === null) fail(`swap frame identity is incomplete at ${frame.tracePath}`);
    const decoded = decodeVariant(frame.input, `${frame.tracePath}.input`)!;
    let settlementCoverage: HistoricalExecutionSettlementCoverageV1 = CALLBACK_SETTLEMENT_COVERAGE;
    let settlementMode = decoded.settlementMode;
    if (decoded.family === "univ2-standard" && decoded.callbackDataByteLength === "0") {
      const priorSamePairSwap = frames.filter((candidate) =>
        candidate.frameIndex < frame.frameIndex
        && candidate.successful
        && candidate.to === frame.to
        && candidate.input?.startsWith(UNIV2_SWAP_SELECTOR)
      ).at(-1);
      const priorSamePairSwapSubtreeEnd = priorSamePairSwap === undefined
        ? -1
        : frames.reduce((latest, candidate) =>
          candidate.path.length >= priorSamePairSwap.path.length
          && priorSamePairSwap.path.every((value, index) => candidate.path[index] === value)
            ? Math.max(latest, candidate.frameIndex)
            : latest,
        priorSamePairSwap.frameIndex);
      settlementCoverage = prepaidSettlementWitness(
        frame,
        decoded,
        transfers,
        priorSamePairSwapSubtreeEnd,
      );
      if (settlementCoverage.status === "observed") settlementMode = "empty-callback-with-pretransfer-witness";
    }
    const bytes = Uint8Array.from(Buffer.from(frame.input.slice(2), "hex"));
    cases.push(Object.freeze({
      selectorCandidate: decoded.family,
      identityStatus: "selector-candidate-only",
      executionVariant: decoded.executionVariant,
      direction: decoded.direction,
      settlementMode,
      framePath: Object.freeze(frame.path.map(String)),
      frameIndex: String(frame.frameIndex),
      from: frame.from,
      to: frame.to,
      value: hexQuantity(frame.node.value, `${frame.tracePath}.value`),
      selector: decoded.selector,
      calldataSha256: sha256Hex(bytes),
      calldataByteLength: String(bytes.length),
      callbackDataByteLength: decoded.callbackDataByteLength,
      settlementCoverage,
      logCoverage: LOG_COVERAGE,
      effectsCoverage: EFFECTS_COVERAGE,
    }));
  }
  return Object.freeze(cases);
}

function manifestIdentity(
  expectedManifestRoot: Hash,
  manifest: HistoricalFamilyFactManifestV1 | null,
): HistoricalExecutionManifestIdentityV1 {
  return Object.freeze({
    manifestRoot: manifest?.manifestRoot ?? expectedManifestRoot,
    chainId: manifest?.chainId ?? null,
    canonicalBlockHash: manifest?.canonicalBlockHash ?? null,
    txHash: manifest?.txHash ?? null,
  });
}

function groupCases(
  cases: readonly HistoricalExecutionVariantCaseV1[],
): readonly HistoricalExecutionVariantGroupV1[] {
  const groups = new Map<string, HistoricalExecutionVariantGroupV1>();
  for (const item of cases) {
    const key = [item.selectorCandidate, item.executionVariant, item.direction, item.settlementMode].join("|");
    const prior = groups.get(key);
    groups.set(key, Object.freeze({
      selectorCandidate: item.selectorCandidate,
      identityStatus: "selector-candidate-only",
      executionVariant: item.executionVariant,
      direction: item.direction,
      settlementMode: item.settlementMode,
      caseIds: Object.freeze([...(prior?.caseIds ?? []), item.caseId]),
    }));
  }
  return Object.freeze([...groups.values()].sort((left, right) =>
    [left.selectorCandidate, left.executionVariant, left.direction, left.settlementMode].join("|").localeCompare(
      [right.selectorCandidate, right.executionVariant, right.direction, right.settlementMode].join("|"),
    )));
}

function observation(
  status: HistoricalExecutionVariantStatusV1,
  reasons: readonly string[],
  identity: HistoricalExecutionManifestIdentityV1,
  rawCases: readonly Omit<HistoricalExecutionVariantCaseV1, "caseId">[],
): HistoricalExecutionVariantObservationV1 {
  const cases = Object.freeze(rawCases.map((item) => Object.freeze({
    ...item,
    caseId: hashDomain("aloha/historical-execution-variant-case/v1", {
      observerSpecDigest: HISTORICAL_EXECUTION_VARIANT_OBSERVER_SPEC_DIGEST_V1,
      observerImplementationDigest: HISTORICAL_EXECUTION_VARIANT_OBSERVER_IMPLEMENTATION_DIGEST_V1,
      manifestIdentity: identity,
      evidence: item,
    }),
  })));
  const groups = groupCases(cases);
  const rootPayload = {
    observerSpecDigest: HISTORICAL_EXECUTION_VARIANT_OBSERVER_SPEC_DIGEST_V1,
    observerImplementationDigest: HISTORICAL_EXECUTION_VARIANT_OBSERVER_IMPLEMENTATION_DIGEST_V1,
    manifestIdentity: identity,
    status,
    reasons,
    cases,
    groups,
  };
  return Object.freeze({
    schemaVersion: 1,
    kind: "aloha.historical-execution-variant-observation",
    advisoryOnly: true,
    status,
    reasons: Object.freeze([...reasons]),
    observerSpecDigest: HISTORICAL_EXECUTION_VARIANT_OBSERVER_SPEC_DIGEST_V1,
    observerImplementationDigest: HISTORICAL_EXECUTION_VARIANT_OBSERVER_IMPLEMENTATION_DIGEST_V1,
    manifestIdentity: identity,
    cases,
    groups,
    caseRoot: hashDomain("aloha/historical-execution-variant-case-root/v1", rootPayload),
  });
}

export function observeHistoricalExecutionVariantsV1(
  rootDirectory: string,
  expectedManifestRoot: Hash,
): HistoricalExecutionVariantObservationV1 {
  let manifest: HistoricalFamilyFactManifestV1 | null = null;
  try {
    const bundle = loadHistoricalFamilyFactBundleV1(rootDirectory, expectedManifestRoot);
    manifest = bundle.manifest;
    const identity = manifestIdentity(expectedManifestRoot, manifest);
    assertHistoricalIdentity(manifest, bundle.results);
    const cases = observeCases(bundle.results.trace);
    if (cases.length === 0) {
      return observation("unresolved", ["no successful strictly decoded UniV2 or UniV3 swap frame observed"], identity, []);
    }
    return observation("observed", [], identity, cases);
  } catch (error) {
    return observation(
      "unresolved",
      [error instanceof Error ? error.message : String(error)],
      manifestIdentity(expectedManifestRoot, manifest),
      [],
    );
  }
}
