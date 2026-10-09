// Compiled-code and synthetic transport contracts. Not fresh historical EVM or performance.
import assert from "node:assert/strict";
import test from "node:test";
import { ethers } from "ethers";
import { declareRequestProgram } from "../../../adapter-request-program.js";
import { plugin } from "../../../production-families/algebra-integral.production.js";
import { bindCypherPluginCode, ALGEBRA_QUOTER_CODE_HASH, ALGEBRA_QUOTER_INTERFACE } from "../quoter-model.js";
import { algebraQuoterProgram } from "../quoter-exact.js";
import { candidateFor, decisionWith, EXECUTOR, FACTORY, MEASURED_INSTANCES, SOURCE } from "./fixtures.js";
import { COMPILED, DYNAMIC_FACTS, dynamicAnswer, dynamicDescriptor, PLUGIN_FACTORY, pluginCode } from "./dynamic-fixtures.js";

test("compiled source binds the captured plugin code and Quoter code, not a pool address allowlist", () => {
  assert.equal(ethers.keccak256(pluginCode(DYNAMIC_FACTS.pool)), COMPILED.provenance.codeHash);
  assert.equal(ethers.keccak256(COMPILED.quoterRuntime), ALGEBRA_QUOTER_CODE_HASH);
  for (const pool of MEASURED_INSTANCES) {
    assert.equal(bindCypherPluginCode(pluginCode(pool.pool), pool.pool, FACTORY), ethers.getAddress(PLUGIN_FACTORY));
  }
  const code = ethers.getBytes(pluginCode(DYNAMIC_FACTS.pool));
  code[100] ^= 1;
  assert.equal(bindCypherPluginCode(ethers.hexlify(code), DYNAMIC_FACTS.pool, FACTORY), null);
  const mismatched = ethers.getBytes(pluginCode(DYNAMIC_FACTS.pool));
  mismatched[664 + 31] ^= 1;
  assert.equal(bindCypherPluginCode(ethers.hexlify(mismatched), DYNAMIC_FACTS.pool, FACTORY), null);
  assert.equal(bindCypherPluginCode(pluginCode(DYNAMIC_FACTS.pool), MEASURED_INSTANCES[1]!.pool, FACTORY), null);
});

test("dynamic identity admits bound code despite fee view/lastFee disagreement", () => {
  for (const sample of MEASURED_INSTANCES) {
    const facts = { ...DYNAMIC_FACTS, ...sample };
    const decision = decisionWith(dynamicAnswer(facts), candidateFor(facts));
    assert.equal(decision.status, "verified");
    if (decision.status !== "verified") throw Error("not verified");
    assert.equal(decision.identity.facts.executedFee.kind, "cypher-bound-quoter");
  }
});

for (const id of ["quoter-code", "plugin-code", "quoter-factory", "factory-pool-deployer"]) {
  test(`dynamic identity fails closed for foreign ${id}`, () => {
    const reply = dynamicAnswer();
    const decision = decisionWith(request => {
      const answer = reply(request);
      if (request.id !== id || !answer.ok) return answer;
      return { ...answer, data: request.kind === "get-code" ? "0x00" : ethers.zeroPadValue("0x", 32) };
    }, candidateFor(DYNAMIC_FACTS));
    assert.equal(decision.status, "retryable");
  });
}

test("dynamic identity rejects source mixing rather than trusting matching addresses", () => {
  const reply = dynamicAnswer();
  assert.throws(() => decisionWith(request => request.id === "plugin-code"
    ? { ...reply(request), source: { ...SOURCE, number: SOURCE.number + 1 } } : reply(request), candidateFor(DYNAMIC_FACTS)), /source/);
});

function input(direction = "zero-for-one") {
  const descriptor = dynamicDescriptor();
  const route = plugin.routes.project({ descriptor }).find(r => r.direction === direction)!;
  return { descriptor, route, executor: EXECUTOR, transactionOrigin: EXECUTOR,
    amountIn: 1_000n, source: SOURCE, runtimeEvidence: [] };
}

// Exact's decoder consumes dependent evidence; the request declaration only
// needs the shared synchronous requirements and request constructors.
const declaration = {
  requirements: algebraQuoterProgram.requirements,
  buildRequests: algebraQuoterProgram.buildRequests,
  decode: () => undefined,
};

for (const direction of ["zero-for-one", "one-for-zero"]) {
  test(`dynamic ${direction}: single round, correct custom deployer, no fee extrapolation`, () => {
    const current = input(direction);
    const declared = declareRequestProgram(declaration, current);
    assert.equal(declared.requests.length, 4);
    const request = declared.requests.find(r => r.id === "exact-quoter")!;
    assert.equal(request.kind, "eth-call");
    if (request.kind !== "eth-call") throw Error("wrong request kind");
    assert.deepEqual(request.caller, { kind: "transaction-origin" });
    const args = ALGEBRA_QUOTER_INTERFACE.decodeFunctionData("quoteExactInputSingle", request.data);
    assert.equal(args.deployer, ethers.ZeroAddress);
    assert.equal(args.amountIn, current.amountIn);
    assert.equal(args.tokenIn.toLowerCase(), current.route.tokenIn.toLowerCase());
    const quote = algebraQuoterProgram.decode({ programInput: current,
      initialResults: declared.requests.map(dynamicAnswer()), dependentEvidence: [] });
    assert.equal(quote.amountOut, 2_000n);
    assert.equal(quote.evidence.reportedLastFee, 500n);
    assert(!("executedFee" in quote.evidence));
    const method = plugin.exact.methods(current)[1]!;
    assert.equal(method.kind, "request-program");
    if (method.kind !== "request-program") throw Error("missing method");
    assert.equal(method.chainAmountQuote, true);
    assert.notEqual(method.stateOnlyReads, true);
    assert.equal(plugin.pricing.refreshPolicyForInstance?.({
      descriptor: plugin.pricing.compileDraft({ descriptor: current.descriptor,
        stateKey: current.descriptor.instanceKey, routes: [current.route] }), routes: [current.route],
    }), "each-block");
  });
}

for (const id of ["pool-plugin", "plugin-code", "quoter-code", "exact-quoter"]) {
  test(`Exact refuses stale or malformed ${id}`, () => {
    const current = input();
    const declared = declareRequestProgram(declaration, current);
    const results = declared.requests.map(request => {
      const result = dynamicAnswer()(request);
      return result.id === id && result.ok ? { ...result, data: "0x" } : result;
    });
    assert.throws(() => algebraQuoterProgram.decode({ programInput: current, initialResults: results, dependentEvidence: [] }));
  });
}

test("Quoter needs the actual origin and an int256 positive input", () => {
  assert.throws(() => algebraQuoterProgram.buildRequests({ ...input(), transactionOrigin: undefined }), /origin/);
  assert.throws(() => algebraQuoterProgram.buildRequests({ ...input(), amountIn: 1n << 255n }), /input/);
});
