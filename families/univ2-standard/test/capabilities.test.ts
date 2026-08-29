import assert from "node:assert/strict";
import test from "node:test";
import { hashDomain, type Hash } from "../../../packages/canonical-codec/src/index.ts";
import {
  decodeUniV2StateSnapshot,
  nominateUniV2,
  quoteV2ExactInput,
  UNIV2_STANDARD_COARSE_PORT,
  UNIV2_STANDARD_EXACT_PORT,
  UNIV2_STANDARD_STATE_PORT,
  UNIV2_STANDARD_SWAP_ACTION_PORT,
  UNIV2_SYNC_EVENT_TOPIC0,
  verifyUniV2IdentityStage,
} from "../src/public.ts";
import type { UniV2SwapActionV1 } from "../src/capabilities/action.ts";
import { decodePackedCallProgram, encodePackedCallProgram } from "../../../packages/execution-program/src/index.ts";

const hash = (label: string): Hash => hashDomain("aloha/univ2-standard/capability-test/v1", label);
const address = (digit: string) => `0x${digit.repeat(40)}`;
const word = (value: bigint) => value.toString(16).padStart(64, "0");
const addressWord = (value: string) => `0x${"0".repeat(24)}${value.slice(2)}`;
const reserves = (reserve0: bigint, reserve1: bigint, timestamp: bigint) => `0x${word(reserve0)}${word(reserve1)}${word(timestamp)}`;

const cutoff = Object.freeze({
  chainId: "1",
  number: "100",
  hash: hash("cutoff-block"),
  stateRoot: hash("cutoff-state"),
});
const pool = address("1");
const token0 = address("2");
const token1 = address("3");
const factory = address("f");
const recipient = address("4");

function identity() {
  const nominated = nominateUniV2({
    pool,
    evidence: {
      cutoff,
      blockNumber: "99",
      blockHash: hash("evidence-block"),
      txHash: hash("evidence-tx"),
      logIndex: "0",
      emitter: pool,
      topic0: UNIV2_SYNC_EVENT_TOPIC0,
      rawLocatorHash: hash("evidence-locator"),
    },
  });
  assert.equal(nominated.status, "nominated");
  const verified = verifyUniV2IdentityStage({
    nomination: nominated.candidate,
    reads: {
      cutoff,
      pool,
      token0ReturnHex: addressWord(token0),
      token1ReturnHex: addressWord(token1),
      factoryReturnHex: addressWord(factory),
      forwardPairReturnHex: addressWord(pool),
      reversePairReturnHex: addressWord(pool),
    },
  });
  assert.equal(verified.status, "verified");
  return verified.identity;
}

function stateFixture(reserve0 = 1_000_000n, reserve1 = 2_000_000n, timestamp = 42n) {
  const program = UNIV2_STANDARD_STATE_PORT.issueReserveReadProgram({ identity: identity(), source: cutoff });
  const response = {
    kind: "univ2-standard.state-read-response" as const,
    programHash: program.programHash,
    source: cutoff,
    pool,
    dataHex: reserves(reserve0, reserve1, timestamp),
  };
  const snapshot = UNIV2_STANDARD_STATE_PORT.decodeReserveReadResponse(program, response);
  return { program, response, snapshot };
}

test("state read is source/program/pool bound and reserves use exact ABI widths", () => {
  const fixture = stateFixture();
  assert.equal(fixture.snapshot.state.reserve0, "1000000");
  assert.equal(fixture.snapshot.state.reserve1, "2000000");
  assert.throws(() => UNIV2_STANDARD_STATE_PORT.decodeReserveReadResponse(
    { ...fixture.program, source: { ...cutoff, number: "101" } },
    fixture.response,
  ), /program-(?:hash|request)-mismatch/);
  assert.throws(() => UNIV2_STANDARD_STATE_PORT.decodeReserveReadResponse(
    fixture.program,
    { ...fixture.response, programHash: hash("wrong-program") },
  ), /response-binding-mismatch/);
  assert.throws(() => UNIV2_STANDARD_STATE_PORT.decodeReserveReadResponse(
    fixture.program,
    { ...fixture.response, source: { ...cutoff, number: "101" } },
  ), /response-binding-mismatch/);
  assert.throws(() => UNIV2_STANDARD_STATE_PORT.decodeReserveReadResponse(
    fixture.program,
    { ...fixture.response, pool: address("5") },
  ), /response-binding-mismatch/);
  assert.throws(() => UNIV2_STANDARD_STATE_PORT.decodeReserveReadResponse(
    fixture.program,
    { ...fixture.response, dataHex: `${fixture.response.dataHex}00` },
  ), /exactly three ABI words/);
  assert.throws(() => UNIV2_STANDARD_STATE_PORT.decodeReserveReadResponse(
    fixture.program,
    { ...fixture.response, dataHex: reserves(1n << 112n, 1n, 1n) },
  ), /uint112/);
  assert.throws(() => UNIV2_STANDARD_STATE_PORT.decodeReserveReadResponse(
    fixture.program,
    { ...fixture.response, dataHex: reserves(1n, 1n, 1n << 32n) },
  ), /uint32/);
});

test("coarse projection is integer-only, fee-aware, and bounds its complete input interval", () => {
  const { snapshot } = stateFixture();
  const inputAmount = "100000";
  const projection = UNIV2_STANDARD_COARSE_PORT.project({ state: snapshot, direction: "token0-to-token1", sampleInputAmount: inputAmount });
  const estimated = quoteV2ExactInput(1_000_000n, 2_000_000n, 100_000n, 30n);
  const capacity = 1_000_000n;
  // Independent no-fee constant-product oracle; do not reuse the Family
  // quote implementation to establish the interval claim.
  const oracle = (amountIn: bigint): bigint => amountIn * 2_000_000n / (1_000_000n + amountIn);
  const upper = oracle(capacity);
  assert.equal(projection.status, "rankable");
  assert.equal(projection.outputs[0]!.amount, estimated.toString(10));
  assert.equal(projection.inputCapacityUpperBound, capacity.toString(10));
  assert.equal(projection.conservativeOutputUpperBound!.amount, upper.toString(10));
  assert.ok(BigInt(projection.conservativeOutputUpperBound!.amount) >= BigInt(projection.outputs[0]!.amount));
  for (const amountIn of [0n, 1n, 100_000n, 500_000n, capacity]) {
    assert.ok(oracle(amountIn) <= BigInt(projection.conservativeOutputUpperBound!.amount));
  }
  const huge = UNIV2_STANDARD_COARSE_PORT.project({ state: snapshot, direction: "token1-to-token0", sampleInputAmount: "900719925474099300000000000000" });
  assert.equal(huge.status, "rankable");
  assert.match(huge.outputs[0]!.amount, /^\d+$/);
  assert.equal(huge.inputCapacityUpperBound, "900719925474099300000000000000");
  const zero = UNIV2_STANDARD_COARSE_PORT.project({ state: stateFixture(0n, 2_000_000n).snapshot, direction: "token0-to-token1", sampleInputAmount: inputAmount });
  assert.deepEqual({ status: zero.status, reasonCode: zero.reasonCode }, { status: "unavailable", reasonCode: "zero-liquidity" });
  assert.throws(() => UNIV2_STANDARD_COARSE_PORT.decode({ ...projection, projectionHash: hash("forged-hash") }), /hash mismatch/);
});

test("exact amount propagation agrees with coarse amount and fails closed on zero liquidity", () => {
  const { snapshot } = stateFixture();
  const exact = UNIV2_STANDARD_EXACT_PORT.propagateAmount({ state: snapshot, direction: "token0-to-token1", amountIn: "100000" });
  const coarse = UNIV2_STANDARD_COARSE_PORT.project({ state: snapshot, direction: "token0-to-token1", sampleInputAmount: "100000" });
  assert.equal(exact.status, "verified");
  assert.equal(exact.outputs[0]!.amount, coarse.outputs[0]!.amount);
  assert.equal(exact.obligationRefs.map(item => item.kind).join(","), "input,output");
  assert.equal(exact.obligationRoot, hashDomain("aloha/univ2-standard/obligation-root/v1", exact.obligationRefs));
  const unavailable = UNIV2_STANDARD_EXACT_PORT.propagateAmount({ state: stateFixture(0n, 2_000_000n).snapshot, direction: "token0-to-token1", amountIn: "100000" });
  assert.deepEqual({ status: unavailable.status, reasonCode: unavailable.reasonCode }, { status: "unavailable", reasonCode: "zero-liquidity" });
  assert.throws(() => UNIV2_STANDARD_EXACT_PORT.propagateAmount({ state: snapshot, direction: "token0-to-token1", amountIn: "0" }), /positive/);
});

function withActionHash(value: UniV2SwapActionV1): UniV2SwapActionV1 {
  const { actionHash: ignored, ...withoutHash } = value;
  void ignored;
  return { ...withoutHash, actionHash: hashDomain("aloha/univ2-standard/swap-action/v1", withoutHash) };
}

test("swap action owns strict ABI encoding and binds calldata to exact output", () => {
  const { snapshot } = stateFixture();
  const exact = UNIV2_STANDARD_EXACT_PORT.propagateAmount({ state: snapshot, direction: "token0-to-token1", amountIn: "100000" });
  const action = UNIV2_STANDARD_SWAP_ACTION_PORT.build({ exact, pool, tokenIn: token0, tokenOut: token1, direction: "token0-to-token1", recipient, callbackDataHex: "0x" });
  assert.match(action.opaqueBytes, /^0x01000201/);
  assert.equal(UNIV2_STANDARD_SWAP_ACTION_PORT.decode(action).actionOwnerId, "family.univ2-standard.swap-action");
  const obligationProof = UNIV2_STANDARD_SWAP_ACTION_PORT.verifyObligations(action);
  assert.equal(obligationProof.subjectRoot, action.obligationRoot);
  assert.equal(obligationProof.outcome, "satisfied");
  assert.throws(() => UNIV2_STANDARD_SWAP_ACTION_PORT.build({ exact, pool, tokenIn: token0, tokenOut: token1, direction: "token0-to-token1", recipient, callbackDataHex: "0x1234" }), /callback program is unavailable/);
  assert.throws(() => UNIV2_STANDARD_SWAP_ACTION_PORT.decode({ ...action, opaqueBytes: `0x02${action.opaqueBytes.slice(4)}` }), /version/);
  assert.throws(() => UNIV2_STANDARD_SWAP_ACTION_PORT.decode({ ...action, opaqueBytes: `${action.opaqueBytes}00` }), /trailing|length/);
  const calls = decodePackedCallProgram(action.opaqueBytes);
  const changedTransfer = encodePackedCallProgram([{ ...calls[0]!, calldata: `${calls[0]!.calldata.slice(0, -2)}01` as `0x${string}` }, calls[1]!]);
  const rehashed = withActionHash({ ...action, opaqueBytes: changedTransfer });
  assert.throws(() => UNIV2_STANDARD_SWAP_ACTION_PORT.decode(rehashed), /transfer\/input amount mismatch/);
  const forgedStateRoot = withActionHash({ ...action, constraintRefs: [hash("forged-state-root")] });
  assert.equal(UNIV2_STANDARD_SWAP_ACTION_PORT.decode(forgedStateRoot).constraintRefs[0], hash("forged-state-root"));
  assert.throws(() => UNIV2_STANDARD_SWAP_ACTION_PORT.verifyObligations(forgedStateRoot), /do not bind state, direction, and amounts/);
});

test("family definition declares the extension and one action owner", async () => {
  const { UNIV2_STANDARD_DEFINITION, UNIV2_STANDARD_EXTENSION_CAPABILITY_IDS, UNIV2_STANDARD_SWAP_ACTION_OWNER } = await import("../src/family-definition.ts");
  assert.deepEqual(Object.keys(UNIV2_STANDARD_DEFINITION.extensions).sort(), Object.values(UNIV2_STANDARD_EXTENSION_CAPABILITY_IDS).sort());
  assert.equal(UNIV2_STANDARD_SWAP_ACTION_OWNER.ownerId, "family.univ2-standard.swap-action");
  assert.deepEqual(UNIV2_STANDARD_SWAP_ACTION_OWNER.actionKinds, ["swap"]);
});
