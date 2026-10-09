import assert from "node:assert/strict";
import test from "node:test";
import { ethers } from "ethers";
import { runtimeProgramScript } from "../../../../../adapters/runtime-amount-program.js";
import { CTOKEN_INTERFACE } from "../abi.js";
import { redeemProgram } from "../redeem-program.js";
import { EXECUTOR, MARKET, SOURCE, UNDERLYING } from "./fixtures.js";
import { assertAnchors, classifyRedeemLog, runtimeScriptEnvelope, successfulRedeemCalls } from "./history-evidence.js";

test("hash anchors are hashes, never block numbers, with case-insensitive equality", () => {
  const prices = { runtime: { sourceBlock: SOURCE.number, sourceBlockHash: SOURCE.hash.toUpperCase() } };
  const provenance = { stateSource: SOURCE, sourceHeader: { number: ethers.toQuantity(SOURCE.number), hash: SOURCE.hash } };
  assert.doesNotThrow(() => assertAnchors(SOURCE, prices, provenance));
  assert.throws(() => assertAnchors(SOURCE, prices, { ...provenance, stateSource: { ...SOURCE, hash: SOURCE.number } }));
  assert.throws(() => assertAnchors(SOURCE, { runtime: { ...prices.runtime, sourceBlock: SOURCE.number - 1 } }, provenance));
});
const frame = (method = "redeem", amount = 100n) => ({ type: "CALL", to: MARKET, from: EXECUTOR,
  input: CTOKEN_INTERFACE.encodeFunctionData(method, [amount]), output: CTOKEN_INTERFACE.encodeFunctionResult(method, [0n]) });
const markets = new Set([MARKET.toLowerCase()]);
const row = { emitter: MARKET, redeemer: EXECUTOR, redeemTokens: 100n, redeemAmount: 20n };
test("trace decoding skips selector bytes, reverted subtrees, delegate duplicates and nonzero errors", () => {
  const call = frame();
  const ok = successfulRedeemCalls({ ...call, calls: [{ ...call, type: "DELEGATECALL" }] }, markets);
  assert.equal(ok.length, 1); assert.equal(ok[0].argument, 100n);
  assert.deepEqual(successfulRedeemCalls({ error: "reverted", calls: [call] }, markets), []);
  assert.deepEqual(successfulRedeemCalls({ ...call, output: CTOKEN_INTERFACE.encodeFunctionResult("redeem", [1n]) }, markets), []);
  assert.deepEqual(successfulRedeemCalls({ ...call, output: "0x" }, markets), []);
});
test("one log is not assigned the interface of another or a mixed call", () => {
  const share = successfulRedeemCalls(frame(), markets), underlying = successfulRedeemCalls(frame("redeemUnderlying", 20n), markets);
  assert.equal(classifyRedeemLog(row, share, 1), "share-input");
  assert.equal(classifyRedeemLog(row, underlying, 1), "underlying-output");
  assert.equal(classifyRedeemLog(row, [...share, ...underlying], 1), "unverified-or-ambiguous");
  assert.equal(classifyRedeemLog(row, share, 2), "unverified-or-ambiguous");
  assert.equal(classifyRedeemLog({ ...row, redeemTokens: 101n }, share, 1), "unverified-or-ambiguous");
  assert.equal(classifyRedeemLog({ ...row, emitter: UNDERLYING }, share, 1), "unverified-or-ambiguous");
});
test("quoted encoding has an outer runtime amount/header, not the old bare CALL layout", () => {
  const program = redeemProgram(MARKET, UNDERLYING, EXECUTOR, 3n).bytes(), script = runtimeProgramScript(program, 100n);
  assert.deepEqual(runtimeScriptEnvelope(script), { amount: 100n, length: program.length, program: ethers.hexlify(program) });
  assert.throws(() => runtimeScriptEnvelope(script.slice(1)));
  assert.throws(() => runtimeScriptEnvelope(script.slice(0, -1)));
});
