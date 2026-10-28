import assert from "node:assert/strict";
import test from "node:test";
import { Interface, toBeHex } from "ethers";
import { validateDeclarativeQuoteProof, verifyDeclarativeQuoteProof, type DeclarativeQuoteProof } from "../venues/declarative-quote-proof.js";
import type { AdapterRequest, AdapterRequestResult } from "../venues/adapter-request-program.js";

const source = { number: 100, hash: toBeHex(100, 32), generation: 3 };
const executor = toBeHex(1, 20), tokenIn = toBeHex(2, 20), tokenOut = toBeHex(3, 20), target = toBeHex(4, 20);
const signature = "function previewDeposit(uint256 assets) view returns (uint256 shares)";
const abi = new Interface([signature]);
const proof: DeclarativeQuoteProof = { step: "quote", requestId: "amountQuote", signature, amountPath: [0], outputPath: [0] };
const request: AdapterRequest = { id: proof.requestId, kind: "eth-call", to: target, data: abi.encodeFunctionData("previewDeposit", [7n]), completion: "return-data" };
const result: AdapterRequestResult = { id: proof.requestId, ok: true, source, provenance: { kind: "fixture", fingerprint: "fixture" },
  completion: "returned", data: abi.encodeFunctionResult("previewDeposit", [13n]) };
const input = { sourceKind: "view" as const, proof, request, result, source, amountIn: 7n, amountOut: 13n, tokenIn, tokenOut, executor };

test("view proof binds requested amount and returned output to one canonical call", () => {
  assert.doesNotThrow(() => verifyDeclarativeQuoteProof(input));
  assert.throws(() => verifyDeclarativeQuoteProof({ ...input, amountIn: 6n }), /amount mismatch/);
  assert.throws(() => verifyDeclarativeQuoteProof({ ...input, amountOut: 500n }), /amount mismatch/);
  assert.throws(() => verifyDeclarativeQuoteProof({ ...input, amountIn: 0n }), /positive/);
  assert.throws(() => verifyDeclarativeQuoteProof({ ...input, request: { ...request, data: "0x12345678" } }), /selector|data|fragment/i);
});

test("request failure, wrong source, missing attestation and noncanonical encodings reject", () => {
  assert.throws(() => verifyDeclarativeQuoteProof({ ...input, result: { id: proof.requestId, ok: false, source, failure: "rpc" } }), /successful request/);
  assert.throws(() => verifyDeclarativeQuoteProof({ ...input, result: { ...result, source: { ...source, hash: toBeHex(101, 32) } } }), /source/);
  assert.throws(() => verifyDeclarativeQuoteProof({ ...input, result: { ...result, provenance: { kind: "", fingerprint: "" } } }), /provenance/);
  assert.throws(() => verifyDeclarativeQuoteProof({ ...input, result: { ...result, data: result.data + "00".repeat(32) } }), /canonical/);
  assert.throws(() => verifyDeclarativeQuoteProof({ ...input, request: { ...request, data: request.data + "00".repeat(32) } }), /canonical/);
  assert.throws(() => verifyDeclarativeQuoteProof({ ...input, request: { ...request, id: "another" } }), /successful request/);
});

test("revert quotes require an explicit matching declaration and request completion", () => {
  const reverted = { ...result, completion: "reverted-as-declared" as const };
  assert.throws(() => verifyDeclarativeQuoteProof({ ...input, result: reverted }), /completion/);
  const declared = { ...proof, completion: "reverted-as-declared" as const };
  assert.throws(() => verifyDeclarativeQuoteProof({ ...input, proof: declared, result: reverted }), /completion/);
  assert.doesNotThrow(() => verifyDeclarativeQuoteProof({ ...input, proof: declared, result: reverted,
    request: { ...request, completion: "return-or-revert-data" } }));
});

test("ABI paths cover tuple and array values without executable expressions", () => {
  const signature = "function quote((address,uint256)[] rows) view returns ((uint256,uint256) amounts)";
  const abi = new Interface([signature]);
  const proof = { step: "quote", requestId: "amountQuote", signature, amountPath: [0, 1, 1], outputPath: [0, 1] };
  assert.doesNotThrow(() => verifyDeclarativeQuoteProof({ ...input, proof,
    request: { ...request, data: abi.encodeFunctionData("quote", [[[tokenIn, 8n], [tokenOut, 7n]]]) },
    result: { ...result, data: abi.encodeFunctionResult("quote", [[9n, 13n]]) } }));
  assert.throws(() => validateDeclarativeQuoteProof({ ...proof, amountPath: [0, 1, 0] }, "view"), /unsigned/);
  assert.throws(() => verifyDeclarativeQuoteProof({ ...input, proof: { ...proof, amountPath: [0, 2, 1] },
    request: { ...request, data: abi.encodeFunctionData("quote", [[[tokenIn, 8n], [tokenOut, 7n]]]) },
    result: { ...result, data: abi.encodeFunctionResult("quote", [[9n, 13n]]) } }), /missing/);
});

test("proof definitions reject unknown fields, absent signature and invalid paths", () => {
  for (const invalid of [{ ...proof, amountPath: [] }, { ...proof, amountPath: [-1] }, { ...proof, outputPath: [1] },
    { ...proof, amountPath: "$amountIn" }, { ...proof, signature: undefined }, { ...proof, signature: "function constantQuote() view returns(uint256)" },
    { ...proof, formula: "amountOut" }]) assert.throws(() => validateDeclarativeQuoteProof(invalid, "view"));
  assert.throws(() => validateDeclarativeQuoteProof(proof, "effect-simulation"), /unknown/);
  assert.throws(() => validateDeclarativeQuoteProof({ step: "quote", requestId: "amountQuote" }, "view"), /signature/);
});

const simulation: AdapterRequest = { id: "amountQuote", kind: "effect-delta-simulation",
  call: { caller: { kind: "executor" }, to: target, data: "0x12345678" },
  overrideIntent: { caller: { kind: "executor" }, tokenBalances: [{ token: tokenIn, amount: 7n }] },
  observe: ["token-delta"], observeTokenBalances: [{ token: tokenIn, account: { kind: "executor" } }, { token: tokenOut, account: { kind: "executor" } }] };
const effects = { tokenDeltas: [{ token: tokenIn, account: executor, delta: -7n }, { token: tokenOut, account: executor, delta: 13n }] };
const simulationInput = { ...input, sourceKind: "effect-simulation" as const, proof: { step: "quote", requestId: "amountQuote" },
  request: simulation, result: { ...result, effects, data: "0x" } };

test("effect quote proof uses actual input debit and output receipt", () => {
  assert.doesNotThrow(() => verifyDeclarativeQuoteProof(simulationInput));
  assert.throws(() => verifyDeclarativeQuoteProof({ ...simulationInput, amountOut: 500n }), /receipt mismatch/);
  assert.throws(() => verifyDeclarativeQuoteProof({ ...simulationInput, amountIn: 8n }), /debit/);
  assert.throws(() => verifyDeclarativeQuoteProof({ ...simulationInput, request }), /simulation/);
  assert.throws(() => verifyDeclarativeQuoteProof({ ...simulationInput, result: { ...simulationInput.result, completion: "reverted-as-declared" } }), /simulation/);
});

test("zero debit, wrong accounts/assets, duplicates and absent observations cannot prove a quote", () => {
  const badEffects = [undefined, { tokenDeltas: [] }, { tokenDeltas: [{ ...effects.tokenDeltas[0], delta: 0n }, effects.tokenDeltas[1]] },
    { tokenDeltas: effects.tokenDeltas.map(row => ({ ...row, account: target })) },
    { tokenDeltas: [effects.tokenDeltas[0], { ...effects.tokenDeltas[1], token: target }] },
    { tokenDeltas: [...effects.tokenDeltas, effects.tokenDeltas[0]] }];
  for (const effects of badEffects) assert.throws(() => verifyDeclarativeQuoteProof({ ...simulationInput,
    result: { ...simulationInput.result, effects } }));
  assert.throws(() => verifyDeclarativeQuoteProof({ ...simulationInput, tokenOut: tokenIn }), /distinct/);
});
