import assert from "node:assert/strict";
import test from "node:test";
import { Interface, toBeHex } from "ethers";
import { compileDeclarativeValues } from "../venues/declarative-values.js";
import { quoteProofGroups, quoteProofSteps, validateDeclarativeQuoteProof, verifyDeclarativeQuoteChain,
  verifyDeclarativeQuoteProof, type DeclarativeQuoteProof } from "../venues/declarative-quote-proof.js";
import type { AdapterRequest, AdapterRequestResult } from "../venues/adapter-request-program.js";

const a = (n: number) => toBeHex(n, 20), source = { number: 100, hash: toBeHex(100, 32), generation: 2 };
const executor = a(1), tokenIn = a(2), tokenOut = a(3), target = a(4);
const op = (op: string, ...args: unknown[]) => ({ op, args });
const values = compileDeclarativeValues({ abi: {}, constants: {}, expressions: {} });
const signature = "function quote(uint256) view returns(uint256)";
const abi = new Interface([signature]);
const proof: DeclarativeQuoteProof = { version: 2, step: "query", requestId: "query", signature,
  amountPath: [0], outputPath: [0], requestBinding: { target: "$target", caller: { kind: "none" } } };
const request: AdapterRequest = { id: "query", kind: "eth-call", to: target,
  data: abi.encodeFunctionData("quote", [7n]), completion: "return-data" };
const result: AdapterRequestResult = { id: "query", ok: true, source, completion: "returned",
  data: abi.encodeFunctionResult("quote", [13n]), provenance: { kind: "fixture", fingerprint: "fixture" } };
const input = { proof, request, result, source, sourceKind: "view" as const, amountIn: 7n, amountOut: 13n,
  tokenIn, tokenOut, executor, evaluate: values.evaluate, environment: { target } };

test("extended quote requires bound target/caller without weakening original source/call checks", () => {
  assert.doesNotThrow(() => verifyDeclarativeQuoteProof(input));
  for (const changed of [
    { request: { ...request, to: a(5) } },
    { request: { ...request, caller: { kind: "executor" as const } } },
    { request: { ...request, id: "elsewhere" } },
    { result: { ...result, source: { ...source, generation: 3 } } },
    { result: { ...result, provenance: { kind: "", fingerprint: "" } } },
    { request: { ...request, data: "0x12345678" } },
    { request: { ...request, data: request.data + "00".repeat(32) } },
    { result: { ...result, data: result.data + "00".repeat(32) } },
  ]) assert.throws(() => verifyDeclarativeQuoteProof({ ...input, ...changed }));
  assert.throws(() => verifyDeclarativeQuoteProof({ ...input, evaluate: undefined }), /evaluator/);
  assert.throws(() => validateDeclarativeQuoteProof({ ...proof, requestBinding: undefined }, "view"), /plain definition/);
  const named = { ...proof, requestBinding: { target, caller: { kind: "verified-actor", evidenceId: "fixtureActor" } } };
  assert.doesNotThrow(() => verifyDeclarativeQuoteProof({ ...input, proof: named,
    request: { ...request, caller: { kind: "verified-actor", evidenceId: "fixtureActor" } } }));
  assert.throws(() => verifyDeclarativeQuoteProof({ ...input, proof: named,
    request: { ...request, caller: { kind: "verified-actor", evidenceId: "differentActor" } } }), /caller/);
});

test("derived call input preserves original input and checks a source-bound relation", () => {
  const derived: DeclarativeQuoteProof = { ...proof, inputBinding: {
    value: op("add", "$quote.amountIn", op("sub", "$steps.position.balance", "$steps.position.reserve")),
    checks: [op("gt", "$quote.amountIn", op("uint", "0")), op("gte", "$steps.position.balance", "$steps.position.reserve")],
  } };
  const changed = { ...input, proof: derived, request: { ...request, data: abi.encodeFunctionData("quote", [17n]) },
    environment: { target, steps: { position: { balance: 20n, reserve: 10n } } } };
  assert.doesNotThrow(() => verifyDeclarativeQuoteProof(changed));
  assert.equal(changed.amountIn, 7n);
  assert.throws(() => verifyDeclarativeQuoteProof({ ...changed, amountIn: 8n }), /amount mismatch/);
  assert.throws(() => verifyDeclarativeQuoteProof({ ...changed,
    environment: { target, steps: { position: { balance: 21n, reserve: 10n } } } }), /amount mismatch/);
  assert.throws(() => verifyDeclarativeQuoteProof({ ...changed,
    environment: { target, steps: { position: { balance: 9n, reserve: 10n } } } }), /check failed/);
  assert.doesNotThrow(() => verifyDeclarativeQuoteProof({ ...changed,
    environment: { ...changed.environment, quote: { amountIn: 999n } } }));
  for (const inputBinding of [
    { value: op("uint", "17"), checks: [true] },
    { value: "$quote.amountIn", checks: [] },
    { value: "$quote.amountIn", checks: [1] },
    { value: "$quote.amountIn", checks: [false] },
  ]) assert.throws(() => verifyDeclarativeQuoteProof({ ...input, proof: { ...proof, inputBinding } }));
});

test("signed request input and packed signed output use declared ABI and bit boundaries", () => {
  const signature = "function quote(int128) view returns(bytes32,bytes32)", abi = new Interface([signature]);
  const packed: DeclarativeQuoteProof = { ...proof, signature, outputWord: { offset: 0, width: 128, signed: true, negate: true },
    inputBinding: { value: op("sub", op("uint", "0"), "$quote.amountIn"), checks: [op("gt", "$quote.amountIn", op("uint", "0"))] } };
  const word = toBeHex((9n << 128n) + (1n << 128n) - 13n, 32);
  const changed = { ...input, proof: packed, request: { ...request, data: abi.encodeFunctionData("quote", [-7n]) },
    result: { ...result, data: abi.encodeFunctionResult("quote", [word, toBeHex(100, 32)]) } };
  assert.doesNotThrow(() => verifyDeclarativeQuoteProof(changed));
  assert.throws(() => verifyDeclarativeQuoteProof({ ...changed, amountOut: 12n }), /amount mismatch/);
  assert.throws(() => verifyDeclarativeQuoteProof({ ...changed, proof: { ...packed, outputWord: { ...packed.outputWord!, negate: false } } }), /amount mismatch/);
  assert.throws(() => verifyDeclarativeQuoteProof({ ...changed,
    request: { ...changed.request, data: abi.encodeFunctionData("quote", [7n]) } }), /amount mismatch/);
  for (const outputWord of [
    { offset: -1, width: 128, signed: true }, { offset: 128, width: 129, signed: true },
    { offset: 0, width: 0, signed: false }, { offset: 0, width: 128.5, signed: false },
    { offset: 0, width: 128, signed: "yes" }, { offset: 0, width: 128, signed: true, extra: 1 },
  ]) assert.throws(() => validateDeclarativeQuoteProof({ ...packed, outputWord }, "view"), /word bounds/);
  assert.throws(() => validateDeclarativeQuoteProof({ ...packed, outputPath: [2] }, "view"), /ABI path/);
  assert.throws(() => validateDeclarativeQuoteProof({ ...proof, outputWord: packed.outputWord }, "view"), /ABI path/);
});

test("custom-error quote binds exact selector, completion and canonical payload", () => {
  const signature = "function quote(uint256)", errorSignature = "error Quoted(uint256)", abi = new Interface([signature, errorSignature]);
  const reverted: DeclarativeQuoteProof = { ...proof, signature, errorSignature, completion: "reverted-as-declared" };
  const changed = { ...input, proof: reverted, request: { ...request, completion: "return-or-revert-data" as const },
    result: { ...result, completion: "reverted-as-declared" as const, data: abi.encodeErrorResult("Quoted", [13n]) } };
  assert.doesNotThrow(() => verifyDeclarativeQuoteProof(changed));
  assert.throws(() => verifyDeclarativeQuoteProof({ ...changed, result: { ...changed.result, completion: "returned" } }), /completion/);
  assert.throws(() => verifyDeclarativeQuoteProof({ ...changed, request }), /completion/);
  assert.throws(() => verifyDeclarativeQuoteProof({ ...changed,
    result: { ...changed.result, data: "0x12345678" + changed.result.data.slice(10) } }), /selector|error|signature/i);
  assert.throws(() => verifyDeclarativeQuoteProof({ ...changed,
    result: { ...changed.result, data: changed.result.data + "00".repeat(32) } }), /canonical/);
  assert.throws(() => verifyDeclarativeQuoteProof({ ...changed,
    result: { ...changed.result, data: changed.result.data.slice(0, -2) } }));
  assert.throws(() => validateDeclarativeQuoteProof({ ...reverted, completion: "returned" }, "view"), /reverted completion/);
  assert.throws(() => validateDeclarativeQuoteProof({ ...reverted, version: undefined }, "view"), /unknown/);
});

test("conditional proof selects exactly one branch before reading any observation", () => {
  const other = { ...proof, step: "other", requestId: "other", signature: "function opposite(uint256) view returns(uint256)" };
  const choices = { version: 2, choices: [
    { when: op("eq", "$direction", "forward"), proof },
    { when: op("eq", "$direction", "reverse"), proof: other },
  ] };
  const observed: string[] = [];
  const observation = (p: DeclarativeQuoteProof) => {
    observed.push(p.requestId);
    assert.equal(p.requestId, "query"); // The missing reverse read must never be touched.
    return { request, result };
  };
  verifyDeclarativeQuoteChain({ ...input, proof: choices, environment: { target, direction: "forward" }, observation });
  assert.deepEqual(observed, ["query"]);
  assert.equal(quoteProofGroups(choices, "view").length, 2);
  assert.equal(quoteProofSteps(choices, "view").length, 2);
  for (const decisions of [[false, false], [true, true], [1, false]]) {
    observed.length = 0;
    assert.throws(() => verifyDeclarativeQuoteChain({ ...input,
      proof: { version: 2, choices: choices.choices.map((choice, i) => ({ ...choice, when: decisions[i] })) }, observation }), /exactly one|boolean/);
    assert.deepEqual(observed, []);
  }
  assert.throws(() => quoteProofGroups({ version: 2, choices: [{ when: true, proof: choices }] }, "view"), /unknown/);
  assert.throws(() => quoteProofGroups({ version: 2, choices: Array(129).fill({ when: true, proof }) }, "view"), /choices/);
});

test("conditional ordered chain verifies intermediate custom-error output before final amount", () => {
  const errorSignature = "error Quoted(uint256)", errorAbi = new Interface([errorSignature]);
  const first: DeclarativeQuoteProof = { ...proof, errorSignature, completion: "reverted-as-declared" };
  const last: DeclarativeQuoteProof = { ...proof, step: "last", requestId: "last" };
  const observation = (p: DeclarativeQuoteProof) => p.requestId === "query" ? {
    request: { ...request, completion: "return-or-revert-data" as const },
    result: { ...result, completion: "reverted-as-declared" as const, data: errorAbi.encodeErrorResult("Quoted", [11n]) },
  } : {
    request: { ...request, id: "last", data: abi.encodeFunctionData("quote", [11n]) },
    result: { ...result, id: "last" },
  };
  const chain = { version: 2, choices: [{ when: true, proof: { steps: [first, last] } }] };
  assert.doesNotThrow(() => verifyDeclarativeQuoteChain({ ...input, proof: chain, observation }));
  assert.throws(() => verifyDeclarativeQuoteChain({ ...input, proof: chain, observation, amountIn: 8n }), /amount mismatch/);
  assert.throws(() => verifyDeclarativeQuoteChain({ ...input, proof: chain, observation, amountOut: 14n }), /amount mismatch/);
});

test("view binds nominal input, capacity, token, gross quote and checked net receipt", () => {
  const signature = "function quote(address,uint256) view returns(uint256)";
  const view = new Interface([signature]);
  const receiptBinding = { inputAssetPath: [0], feeNumerator: op("uint", "1"), feeDenominator: op("uint", "100"),
    maximumInput: "$steps.state.headroom", unavailableOnRevertOrEmpty: true };
  const spec: DeclarativeQuoteProof = { ...proof, signature, amountPath: [1], receiptBinding };
  const request: AdapterRequest = { id: "query", kind: "eth-call", to: target,
    data: view.encodeFunctionData("quote", [tokenIn, 7]), completion: "return-or-revert-data" };
  const base = { ...input, proof: spec, request, result: { ...result, data: view.encodeFunctionResult("quote", [200n]) },
    amountOut: 198n, environment: { target, steps: { state: { headroom: 7n } } } };
  verifyDeclarativeQuoteProof(base);
  assert.throws(() => verifyDeclarativeQuoteProof({ ...base, amountOut: 200n }), /amount mismatch/);
  assert.throws(() => verifyDeclarativeQuoteProof({ ...base, amountOut: 0n }), /amount mismatch/);
  assert.throws(() => verifyDeclarativeQuoteProof({ ...base, request: { ...request,
    data: view.encodeFunctionData("quote", [tokenOut, 7n]) } }), /asset/);
  const capped = { ...base, environment: { target, steps: { state: { headroom: 6n } } }, amountOut: 0n };
  verifyDeclarativeQuoteProof(capped);
  assert.throws(() => verifyDeclarativeQuoteProof({ ...capped, amountOut: 198n }), /amount mismatch/);
  verifyDeclarativeQuoteProof({ ...base, amountOut: 0n, result: { ...result, data: view.encodeFunctionResult("quote", [0n]) } });
  for (const settled of [{ ...result, data: "0x" }, { ...result, data: "0xabcd", completion: "reverted-as-declared" as const }]) {
    verifyDeclarativeQuoteProof({ ...base, result: settled, amountOut: 0n });
    assert.throws(() => verifyDeclarativeQuoteProof({ ...base, result: settled }), /amount mismatch/);
    assert.throws(() => verifyDeclarativeQuoteProof({ ...base, result: { ...settled, source: { ...source, number: 101 } }, amountOut: 0n }));
    assert.throws(() => verifyDeclarativeQuoteProof({ ...base, result: settled,
      request: { ...request, data: view.encodeFunctionData("quote", [tokenIn, 6n]) }, amountOut: 0n }), /amount mismatch/);
  }
  assert.throws(() => verifyDeclarativeQuoteProof({ ...base, result: { id: "query", source, ok: false, failure: "rpc" }, amountOut: 0n }));
  assert.throws(() => verifyDeclarativeQuoteProof({ ...base, proof: { ...spec, receiptBinding: { ...receiptBinding, maximumInput: 0 } } }), /source-bound/);
  assert.throws(() => verifyDeclarativeQuoteProof({ ...base, proof: { ...spec, receiptBinding: { ...receiptBinding, feeDenominator: op("uint", "0") } } }), /deduction/);
});
