import assert from "node:assert/strict";
import test from "node:test";
import { ethers } from "ethers";
import { RuntimeAmountProgram, withRuntimeHopContext, type RuntimeSettlementRequest } from "../../adapters/runtime-amount-program.js";
import { buildRuntimeSettlementRoot } from "../simulator/runtime-settlement.js";

const address = (i: number) => ethers.getAddress(ethers.toBeHex(i, 20));
for (const debtInput of [false, true]) test(`direct debt requires both ends' capabilities (${debtInput})`, () => {
  const requests: RuntimeSettlementRequest[] = [];
  const emit = (index: number, request?: RuntimeSettlementRequest) => {
    if (request) requests.push(request);
    return { actionAdapterId: "fixture", tokenIn: address(index + 1), tokenOut: address(2 - index),
      program: ethers.hexlify(new RuntimeAmountProgram().constant(1, 1n).bytes()),
      settlement: index === 0 ? { quoteOutput: true as const, directOutput: true as const, settleOutput: true as const }
        : { deferredInput: address(9), ...(debtInput ? { deferredDebtInput: true as const } : {}) } };
  };
  assert(buildRuntimeSettlementRoot({ legs: [emit(0), emit(1)], amount: 20n, minimumProfit: 1n,
    executor: address(10), build: emit }));
  assert.equal(requests[1]?.kind, debtInput ? "settle-output" : "direct-output");
  const payment = requests[2];
  assert.equal(payment?.kind, "deferred-input");
  if (payment?.kind === "deferred-input") assert.equal(payment.paymentInput, debtInput ? "debt" : undefined);
});

test("diagnostic context is data-only and rejects malformed hop/hash", () => {
  assert.equal(ethers.getBytes(new RuntimeAmountProgram().diagnosticHop(0, ethers.id("witness")).bytes()).length, 35);
  for (const hop of [-1, 6, 1.5]) assert.throws(() => new RuntimeAmountProgram().diagnosticHop(hop, ethers.id("witness")));
  for (const hash of ["0x", ethers.ZeroHash]) assert.throws(() => new RuntimeAmountProgram().diagnosticHop(0, hash));
});

test("hop tagging reuses a frame but preserves the 128-instruction boundary", () => {
  const hash = ethers.id("witness");
  const program = new RuntimeAmountProgram().constant(1, 3n).call(address(9), "0x12345678")
    .run(new RuntimeAmountProgram().constant(2, 4n).bytes());
  const prefix = new RuntimeAmountProgram().diagnosticHop(0, hash).bytes();
  assert.equal(ethers.hexlify(withRuntimeHopContext(0, hash, program.bytes())),
    ethers.concat([prefix, program.bytes().slice(1)]));
  const full = new RuntimeAmountProgram();
  for (let i = 0; i < 128; i++) full.equal(0, 0);
  assert.equal(ethers.hexlify(withRuntimeHopContext(0, hash, full.bytes())),
    ethers.hexlify(new RuntimeAmountProgram().diagnosticHop(0, hash).run(full.bytes()).bytes()));
  for (const malformed of ["0x0101", "0x0108", "0x01ff"]) assert.equal(
    ethers.hexlify(withRuntimeHopContext(0, hash, malformed)),
    ethers.hexlify(new RuntimeAmountProgram().diagnosticHop(0, hash).run(malformed).bytes()));
});
