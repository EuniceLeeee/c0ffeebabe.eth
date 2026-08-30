import assert from "node:assert/strict";
import test from "node:test";
import { hashDomain, type Hash } from "../../../../packages/canonical-codec/src/index.ts";
import { decodePackedCallProgram } from "../../../../packages/execution-program/src/index.ts";
import { FAMILY_CATALOG } from "../../../../generated/family-catalog/index.ts";
import {
  nominateUniV2,
  UNIV2_STANDARD_FAMILY_DEFINITION_HASH,
  UNIV2_STANDARD_EXACT_PORT,
  UNIV2_STANDARD_STATE_PORT,
  UNIV2_STANDARD_SWAP_ACTION_PORT,
  UNIV2_SYNC_EVENT_TOPIC0,
  verifyUniV2IdentityStage,
  type UniV2SwapActionInputV1,
} from "../../../../families/univ2-standard/src/public.ts";
import {
  deriveUniV3Routes,
  UNIV3_STANDARD_FAMILY_DEFINITION_HASH,
  UNIV3_STANDARD_SWAP_ACTION_PORT,
  type UniV3IdentityV1,
  type UniV3QuoteV1,
} from "../../../../families/univ3-standard/src/public.ts";
import { compareCurrentAdapterExecutionVariantV1 } from "../src/current-adapter-comparator.ts";

const h = (label: string): Hash => hashDomain("aloha/current-adapter-comparator/test/v1", label);
const address = (digit: string) => `0x${digit.repeat(40)}`;
const word = (value: bigint) => value.toString(16).padStart(64, "0");
const addressWord = (value: string) => value.slice(2).padStart(64, "0");
const cutoff = Object.freeze({ chainId: "1", number: "100", hash: h("block"), stateRoot: h("state") });
const poolV2 = address("1");
const token0 = address("2");
const token1 = address("3");
const recipient = address("4");
const PREPAID_SETTLEMENT_WITNESS = Object.freeze({
  status: "observed" as const,
  kind: "univ2-prepaid-transfer-before-swap" as const,
  associationPolicy:
    "unique-successful-pre-transfer-since-prior-same-pair-swap-and-exact-output-transfer-descendant" as const,
  inputTransferMethod: "transfer" as const,
  inputTransferFramePath: Object.freeze(["0"]),
  inputTransferFrameIndex: "1",
  inputToken: token0,
  inputTokenRole: "token0" as const,
  inputSender: recipient,
  pair: poolV2,
  inputAmount: "100000",
  outputTransferFramePath: Object.freeze(["1", "0"]),
  outputTransferFrameIndex: "3",
  outputToken: token1,
  outputTokenRole: "token1" as const,
  outputRecipient: recipient,
  outputAmount: "181322",
});
const UNRESOLVED_SETTLEMENT = Object.freeze({
  status: "unresolved" as const,
  reason: "no trace-local witness",
});

function currentUniV2Input(): UniV2SwapActionInputV1 {
  const nomination = nominateUniV2({
    pool: poolV2,
    evidence: {
      cutoff,
      blockNumber: "99",
      blockHash: h("evidence-block"),
      txHash: h("evidence-tx"),
      logIndex: "0",
      emitter: poolV2,
      topic0: UNIV2_SYNC_EVENT_TOPIC0,
      rawLocatorHash: h("locator"),
    },
  });
  assert.equal(nomination.status, "nominated");
  if (nomination.status !== "nominated") throw new Error("UniV2 nomination unavailable");
  const identity = verifyUniV2IdentityStage({
    nomination: nomination.candidate,
    reads: {
      cutoff,
      pool: poolV2,
      token0ReturnHex: `0x${addressWord(token0)}`,
      token1ReturnHex: `0x${addressWord(token1)}`,
      factoryReturnHex: `0x${addressWord(address("f"))}`,
      forwardPairReturnHex: `0x${addressWord(poolV2)}`,
      reversePairReturnHex: `0x${addressWord(poolV2)}`,
    },
  });
  assert.equal(identity.status, "verified");
  if (identity.status !== "verified") throw new Error("UniV2 identity unavailable");
  const program = UNIV2_STANDARD_STATE_PORT.issueReserveReadProgram({ identity: identity.identity, source: cutoff });
  const snapshot = UNIV2_STANDARD_STATE_PORT.decodeReserveReadResponse(program, {
    kind: "univ2-standard.state-read-response",
    programHash: program.programHash,
    source: cutoff,
    pool: poolV2,
    dataHex: `0x${word(1_000_000n)}${word(2_000_000n)}${word(42n)}`,
  });
  const exact = UNIV2_STANDARD_EXACT_PORT.propagateAmount({
    state: snapshot,
    direction: "token0-to-token1",
    amountIn: "100000",
  });
  assert.equal(exact.status, "verified");
  return Object.freeze({
    exact,
    pool: poolV2,
    tokenIn: token0,
    tokenOut: token1,
    direction: "token0-to-token1",
    recipient,
    callbackDataHex: "0x",
  });
}

function replaceWord(calldata: string, index: number, replacement: string): string {
  const start = 10 + index * 64;
  return `${calldata.slice(0, start)}${replacement}${calldata.slice(start + 64)}`;
}

function withNonEmptyUniV2Callback(calldata: string): string {
  return `${calldata.slice(0, 10 + 4 * 64)}${word(1n)}${"01".padEnd(64, "0")}`;
}

function currentUniV3Input() {
  const pool = address("5");
  const identity: UniV3IdentityV1 = Object.freeze({
    cutoff,
    candidateSnapshotHash: h("candidate"),
    facts: Object.freeze({
      pool,
      factory: address("6"),
      token0,
      token1,
      fee: "3000",
      tickSpacing: 60,
      reversePool: pool,
    }),
    factsHash: h("identity-facts"),
    instanceKey: pool,
  });
  const route = deriveUniV3Routes(identity)[0]!;
  const quoteBody = {
    cutoff,
    routeBindingHash: route.routeBindingHash,
    amountIn: "1000",
    amountOut: "900",
    stateHash: h("univ3-state"),
  };
  const quote: UniV3QuoteV1 = Object.freeze({
    ...quoteBody,
    quoteHash: hashDomain("aloha/univ3-standard/quote/v1", quoteBody),
  });
  return Object.freeze({ identity, route, quote, recipient, minAmountOut: quote.amountOut });
}

function canonicalUniV3Swap(options: { readonly callbackData?: string } = {}): string {
  const data = options.callbackData ?? "aabb";
  return `0x128acb08${addressWord(recipient)}${word(1n)}${word(1000n)}${word(1n)}${word(160n)}${word(BigInt(data.length / 2))}${data.padEnd(Math.ceil(data.length / 64) * 64, "0")}`;
}

test("current prepaid-empty UniV2 execution is consistent and exact-binds the generated closure", () => {
  const currentActionInput = currentUniV2Input();
  const currentAction = UNIV2_STANDARD_SWAP_ACTION_PORT.build(currentActionInput);
  const decoded = UNIV2_STANDARD_SWAP_ACTION_PORT.decode(currentAction);
  const calls = decodePackedCallProgram(decoded.opaqueBytes);
  assert.equal(calls.length, 2);
  const observed = calls[1]!;
  const comparison = compareCurrentAdapterExecutionVariantV1({
    family: "univ2-standard",
    direction: "zero-for-one",
    executionVariant: "canonical-swap",
    settlementMode: "empty-callback-with-pretransfer-witness",
    settlementCoverage: PREPAID_SETTLEMENT_WITNESS,
    target: observed.target,
    calldata: observed.calldata,
    currentProbeBinding: "historical-equivalent",
    currentActionInput,
  });
  assert.deepEqual(
    { status: comparison.status, reasonCodes: comparison.reasonCodes },
    { status: "consistent", reasonCodes: ["current-action-exact-match", "effects-not-qualified"] },
  );
  const catalogEntry = FAMILY_CATALOG.entries.find((entry) => entry.familyId === "univ2-standard")!;
  assert.deepEqual(comparison.currentClosureBinding, {
    family: "univ2-standard",
    familyDefinitionHash: UNIV2_STANDARD_FAMILY_DEFINITION_HASH,
    releaseDecision: "include",
    releaseExclusionReasons: [],
    definitionCatalogLeafDigest: catalogEntry.definitionCatalogLeafDigest,
    actionOwnerRefs: catalogEntry.actionOwnerRefs,
  });
  assert.ok(Object.isFrozen(comparison.currentClosureBinding));
  assert.ok(Object.isFrozen(comparison.currentClosureBinding.actionOwnerRefs));
  assert.equal("familyDefinitionHash" in currentActionInput, false);
  assert.equal("definitionCatalogLeafDigest" in currentActionInput, false);
  assert.equal("actionOwnerRefs" in currentActionInput, false);
});

test("UniV2 target/calldata mutations contradict the current action while non-empty callback remains uncovered", () => {
  const currentActionInput = currentUniV2Input();
  const action = UNIV2_STANDARD_SWAP_ACTION_PORT.build(currentActionInput);
  const swap = decodePackedCallProgram(action.opaqueBytes)[1]!;
  const changedCalldata = replaceWord(swap.calldata, 1, word(BigInt(`0x${swap.calldata.slice(74, 138)}`) + 1n));
  const changed = compareCurrentAdapterExecutionVariantV1({
    family: "univ2-standard",
    direction: "zero-for-one",
    executionVariant: "canonical-swap",
    settlementMode: "empty-callback-with-pretransfer-witness",
    settlementCoverage: Object.freeze({ ...PREPAID_SETTLEMENT_WITNESS, outputAmount: "181323" }),
    target: swap.target,
    calldata: changedCalldata,
    currentProbeBinding: "historical-equivalent",
    currentActionInput,
  });
  assert.deepEqual(
    { status: changed.status, reasonCodes: changed.reasonCodes },
    { status: "contradicted", reasonCodes: ["current-action-calldata-mismatch"] },
  );
  const catalogEntry = FAMILY_CATALOG.entries.find((entry) => entry.familyId === "univ2-standard")!;
  assert.equal(changed.currentClosureBinding.familyDefinitionHash, catalogEntry.familyDefinitionHash);
  assert.equal(changed.currentClosureBinding.definitionCatalogLeafDigest, catalogEntry.definitionCatalogLeafDigest);
  assert.deepEqual(changed.currentClosureBinding.actionOwnerRefs, catalogEntry.actionOwnerRefs);
  const changedTarget = compareCurrentAdapterExecutionVariantV1({
    family: "univ2-standard",
    direction: "zero-for-one",
    executionVariant: "canonical-swap",
    settlementMode: "empty-callback-with-pretransfer-witness",
    settlementCoverage: Object.freeze({ ...PREPAID_SETTLEMENT_WITNESS, pair: address("9") }),
    target: address("9"),
    calldata: swap.calldata,
    currentProbeBinding: "historical-equivalent",
    currentActionInput,
  });
  assert.deepEqual(
    { status: changedTarget.status, reasonCodes: changedTarget.reasonCodes },
    { status: "contradicted", reasonCodes: ["current-action-target-mismatch"] },
  );

  const historicalCallback = compareCurrentAdapterExecutionVariantV1({
    family: "univ2-standard",
    direction: "zero-for-one",
    executionVariant: "canonical-swap",
    settlementMode: "callback",
    settlementCoverage: UNRESOLVED_SETTLEMENT,
    target: swap.target,
    calldata: withNonEmptyUniV2Callback(swap.calldata),
    currentProbeBinding: "historical-equivalent",
    currentActionInput,
  });
  assert.deepEqual(
    { status: historicalCallback.status, reasonCodes: historicalCallback.reasonCodes },
    { status: "unresolved", reasonCodes: ["variant-not-covered"] },
  );
});

test("empty callback without an observed pre-transfer witness is unresolved", () => {
  const currentActionInput = currentUniV2Input();
  const swap = decodePackedCallProgram(UNIV2_STANDARD_SWAP_ACTION_PORT.build(currentActionInput).opaqueBytes)[1]!;
  const comparison = compareCurrentAdapterExecutionVariantV1({
    family: "univ2-standard",
    direction: "zero-for-one",
    executionVariant: "canonical-swap",
    settlementMode: "empty-callback-settlement-unproven",
    settlementCoverage: UNRESOLVED_SETTLEMENT,
    target: swap.target,
    calldata: swap.calldata,
    currentProbeBinding: "synthetic-shape-only",
    currentActionInput,
  });
  assert.deepEqual(
    { status: comparison.status, reasonCodes: comparison.reasonCodes },
    { status: "unresolved", reasonCodes: ["settlement-not-proven"] },
  );
});

test("synthetic UniV2 shape probe cannot manufacture a full-calldata contradiction", () => {
  const currentActionInput = currentUniV2Input();
  const swap = decodePackedCallProgram(UNIV2_STANDARD_SWAP_ACTION_PORT.build(currentActionInput).opaqueBytes)[1]!;
  const changedCalldata = replaceWord(swap.calldata, 1, word(BigInt(`0x${swap.calldata.slice(74, 138)}`) + 1n));
  const comparison = compareCurrentAdapterExecutionVariantV1({
    family: "univ2-standard",
    direction: "zero-for-one",
    executionVariant: "canonical-swap",
    settlementMode: "empty-callback-with-pretransfer-witness",
    settlementCoverage: Object.freeze({ ...PREPAID_SETTLEMENT_WITNESS, outputAmount: "181323" }),
    target: swap.target,
    calldata: changedCalldata,
    currentProbeBinding: "synthetic-shape-only",
    currentActionInput,
  });
  assert.deepEqual(
    { status: comparison.status, reasonCodes: comparison.reasonCodes },
    { status: "unresolved", reasonCodes: ["synthetic-probe-not-byte-comparable", "effects-not-qualified"] },
  );
});

test("canonical five-parameter UniV3 observation contradicts the current four-word action closure", () => {
  const currentActionInput = currentUniV3Input();
  const currentAction = UNIV3_STANDARD_SWAP_ACTION_PORT.build(currentActionInput);
  assert.equal(currentAction.target, currentActionInput.identity.instanceKey);
  assert.equal(currentAction.calldata.length, 10 + 4 * 64);
  const comparison = compareCurrentAdapterExecutionVariantV1({
    family: "univ3-standard",
    direction: "zero-for-one",
    executionVariant: "exact-input",
    settlementMode: "callback",
    target: currentAction.target,
    calldata: canonicalUniV3Swap(),
    currentProbeBinding: "synthetic-shape-only",
    currentActionInput,
  });
  assert.deepEqual(
    { status: comparison.status, reasonCodes: comparison.reasonCodes },
    { status: "contradicted", reasonCodes: ["current-action-abi-invalid"] },
  );
  assert.equal(comparison.currentClosureBinding.familyDefinitionHash, UNIV3_STANDARD_FAMILY_DEFINITION_HASH);
  assert.equal(comparison.currentClosureBinding.releaseDecision, "exclude");
  assert.deepEqual(comparison.currentClosureBinding.releaseExclusionReasons, [
    "execution-program-blocked",
    "final-simulation-blocked",
  ]);
  assert.equal(comparison.currentClosureBinding.definitionCatalogLeafDigest, null);
  assert.deepEqual(comparison.currentClosureBinding.actionOwnerRefs, []);
});

test("an un-runnable current builder is unresolved, never manufactured into a verdict", () => {
  const valid = currentUniV3Input();
  const currentActionInput = {
    ...valid,
    quote: { ...valid.quote, routeBindingHash: h("foreign-route") },
  };
  assert.throws(() => UNIV3_STANDARD_SWAP_ACTION_PORT.build(currentActionInput), /lineage/);
  const comparison = compareCurrentAdapterExecutionVariantV1({
    family: "univ3-standard",
    direction: "zero-for-one",
    executionVariant: "exact-input",
    settlementMode: "callback",
    target: valid.identity.instanceKey,
    calldata: canonicalUniV3Swap(),
    currentProbeBinding: "historical-equivalent",
    currentActionInput,
  });
  assert.deepEqual(
    { status: comparison.status, reasonCodes: comparison.reasonCodes },
    { status: "unresolved", reasonCodes: ["current-action-build-unavailable"] },
  );
});
