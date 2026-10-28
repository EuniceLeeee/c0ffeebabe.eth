import assert from "node:assert/strict";
import { test } from "node:test";
import { ethers } from "ethers";
import { originalEkuboLeg } from "./history-evidence.js";
import { EKUBO_CORE, EKUBO_ROUTER } from "../../ekubo/abi.js";
import { ekuboPoolId } from "../../ekubo/pool-key.js";
import { NO_RECEIVER } from "../codec.js";

function fixture(reverse = false) {
  const caller = "0x1000000000000000000000000000000000000001";
  const key = { token0: ethers.ZeroAddress, token1: "0xdac17f958d2ee523a2206206994597c13d831ec7",
    config: "0x00000000000000000000000000000000000000000020c49ba5e353f88000137c" };
  const id = ekuboPoolId(key), amountIn = 100_000n, amountOut = 400n;
  const packed = ethers.toBeHex((BigInt.asUintN(128, reverse ? -amountOut : amountIn) << 128n) | BigInt.asUintN(128, reverse ? amountIn : -amountOut), 32);
  const data = ethers.concat([EKUBO_ROUTER, id, packed, ethers.ZeroHash]);
  const transfer = new ethers.Interface(["event Transfer(address indexed from,address indexed to,uint256 value)",
    "function transfer(address,uint256) returns(bool)"]);
  const output = { address: key.token1, ...transfer.encodeEventLog(transfer.getEvent("Transfer")!, [EKUBO_CORE, caller, amountOut]) };
  const receipt = { logs: [{ address: EKUBO_CORE, topics: [], data, logIndex: "0x1" }, ...(reverse ? [] : [output])] };
  const payment = reverse ? { type: "CALL", from: EKUBO_CORE, to: caller, value: ethers.toQuantity(amountOut), input: "0x" } :
    { type: "CALL", from: EKUBO_CORE, to: key.token1, input: transfer.encodeFunctionData("transfer", [caller, amountOut]) };
  const trace: any = { type: "CALL", from: caller, to: EKUBO_ROUTER,
    input: NO_RECEIVER.encodeFunctionData("swap", [key, reverse, amountIn, 0, 0, amountOut]),
    output: NO_RECEIVER.encodeFunctionResult("swap", [packed]), calls: [payment] };
  const descriptor = { poolKey: key };
  return { caller, key, id, amountIn, amountOut, packed, transfer, output, receipt, trace, payment, descriptor };
}
test("Core bytes32 key, signed deltas, successful call and independent receipt agree", () => {
  const { id, descriptor, receipt, trace, amountIn, amountOut, key } = fixture();
  const observed = originalEkuboLeg(id, descriptor, receipt, trace);
  assert.equal(observed.amountIn, amountIn); assert.equal(observed.amountOut, amountOut);
  assert.equal(observed.tokenIn, "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2");
  assert.throws(() => originalEkuboLeg(ethers.ZeroHash, descriptor, receipt, trace));
  assert.throws(() => originalEkuboLeg(id, descriptor, { logs: receipt.logs.slice(0, 1) }, trace));
  assert.throws(() => originalEkuboLeg(id, descriptor, receipt, { ...trace, error: "reverted" }));
  assert.throws(() => originalEkuboLeg(id, descriptor, receipt, { ...trace, output: NO_RECEIVER.encodeFunctionResult("swap", [ethers.ZeroHash]) }));
  assert.throws(() => originalEkuboLeg(id, descriptor, receipt, { ...trace,
    input: NO_RECEIVER.encodeFunctionData("swap", [key, false, amountIn + 1n, 0, 0, amountOut]) }));
});
test("token output receipt is bound to its Ekubo sender and selected successful swap subtree", () => {
  const { id, descriptor, receipt, trace, payment, transfer, key, caller, amountOut } = fixture();
  const foreign = "0x1000000000000000000000000000000000000009";
  const wrongSender = { address: key.token1, ...transfer.encodeEventLog(transfer.getEvent("Transfer")!, [foreign, caller, amountOut]) };
  assert.throws(() => originalEkuboLeg(id, descriptor, { logs: [receipt.logs[0], wrongSender] }, trace), /receipt/);
  const sibling = { type: "CALL", from: caller, to: foreign, input: "0x", calls: [{ ...trace, calls: [] }, payment] };
  assert.throws(() => originalEkuboLeg(id, descriptor, receipt, sibling), /selected swap/);
  assert.throws(() => originalEkuboLeg(id, descriptor, receipt, { ...trace, calls: [{ ...payment, error: "revert" }] }), /selected swap/);
});
test("native output cannot be borrowed from a sibling or reverted subtree", () => {
  const { id, descriptor, receipt, trace, payment, caller, amountOut } = fixture(true);
  assert.equal(originalEkuboLeg(id, descriptor, receipt, trace).amountOut, amountOut);
  const sibling = { type: "CALL", from: caller, to: "0x1000000000000000000000000000000000000009", input: "0x",
    calls: [{ ...trace, calls: [] }, payment] };
  assert.throws(() => originalEkuboLeg(id, descriptor, receipt, sibling), /native output/);
  assert.throws(() => originalEkuboLeg(id, descriptor, receipt, { ...trace,
    calls: [{ type: "CALL", error: "revert", calls: [payment] }] }), /native output/);
});
