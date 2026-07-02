import { ethers } from "ethers";
import {
  wethDepositValueAdapter,
  wethWithdrawAmountAdapter,
} from "../../adapters/wrap.js";
import { univ4SettleValueAdapter } from "../../adapters/univ4.js";
import { ADDR } from "../../shared/constants/addresses.js";
import type { ResolvedPlanNode } from "../../types.js";

type DecodedCall = {
  op: number;
  target: string;
  value: bigint;
  payloadLen: number;
  payload: Uint8Array;
};

const EXECUTOR = "0xE08D97e151473A848C3d9CA3f323Cb720472D015";

function readUint24(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] << 16) | (bytes[offset + 1] << 8) | bytes[offset + 2];
}

function readUint(bytes: Uint8Array): bigint {
  return BigInt(ethers.hexlify(bytes));
}

function decodeCall(bytes: Uint8Array): DecodedCall {
  const op = bytes[0];
  if (op !== 0x00 && op !== 0x01) {
    throw new Error(`unexpected opcode ${op}`);
  }

  const target = ethers.hexlify(bytes.slice(1, 21)).toLowerCase();
  const value = op === 0x01 ? readUint(bytes.slice(21, 33)) : 0n;
  const lenOffset = op === 0x01 ? 33 : 21;
  const payloadLen = readUint24(bytes, lenOffset);
  const payload = bytes.slice(lenOffset + 3);
  if (payload.length !== payloadLen) {
    throw new Error(`payload length ${payload.length} != encoded ${payloadLen}`);
  }

  return { op, target, value, payloadLen, payload };
}

function node(overrides: Partial<ResolvedPlanNode>): ResolvedPlanNode {
  return {
    adapterId: "test",
    target: ADDR.WETH,
    tokenIn: ADDR.WETH,
    tokenOut: ADDR.WETH,
    amount: 0n,
    params: {},
    children: [],
    ...overrides,
  };
}

function expectEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}: got ${actual}, expected ${expected}`);
  }
}

function expectHex(actual: Uint8Array, expected: string, message: string): void {
  expectEqual(ethers.hexlify(actual).toLowerCase(), expected.toLowerCase(), message);
}

function testWethDepositValue(): void {
  const amount = 123456789n;
  const encoded = wethDepositValueAdapter.encode(node({ amount }), EXECUTOR, new Uint8Array());
  const decoded = decodeCall(encoded);

  expectEqual(decoded.op, 0x01, "weth-deposit-value opcode");
  expectEqual(decoded.target, ADDR.WETH.toLowerCase(), "weth-deposit-value target");
  expectEqual(decoded.value, amount, "weth-deposit-value msg.value");
  expectEqual(ethers.hexlify(decoded.payload.slice(0, 4)), "0xd0e30db0", "weth-deposit-value selector");
}

function testWethWithdrawAmount(): void {
  const amount = 123456789n;
  const encoded = wethWithdrawAmountAdapter.encode(node({ amount }), EXECUTOR, new Uint8Array());
  const decoded = decodeCall(encoded);
  const expectedPayload = "0x2e1a7d4d" + amount.toString(16).padStart(64, "0");

  expectEqual(decoded.op, 0x00, "weth-withdraw-amount opcode");
  expectEqual(decoded.target, ADDR.WETH.toLowerCase(), "weth-withdraw-amount target");
  expectHex(decoded.payload, expectedPayload, "weth-withdraw-amount payload");
}

function testUniv4SettleValue(): void {
  const amount = 123456789n;
  const settleIface = new ethers.Interface(["function settle()"]);
  const expectedPayload = settleIface.encodeFunctionData("settle");
  const encoded = univ4SettleValueAdapter.encode(
    node({ target: ADDR.UNISWAP_V4_POOL_MANAGER, amount }),
    EXECUTOR,
    new Uint8Array(),
  );
  const decoded = decodeCall(encoded);

  expectEqual(decoded.op, 0x01, "univ4-settle-value opcode");
  expectEqual(decoded.target, ADDR.UNISWAP_V4_POOL_MANAGER.toLowerCase(), "univ4-settle-value target");
  expectEqual(decoded.value, amount, "univ4-settle-value msg.value");
  expectHex(decoded.payload, expectedPayload, "univ4-settle-value payload");
}

function main(): void {
  testWethDepositValue();
  testWethWithdrawAmount();
  testUniv4SettleValue();
  console.log("v4-native-adapters PASS (3/3)");
}

try {
  main();
} catch (e) {
  console.error("FAIL:", e instanceof Error ? e.message : e);
  process.exit(1);
}
