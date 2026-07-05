import { ethers } from "ethers";
import { psmAdapter } from "../../adapters/psm.js";
import { ADDR } from "../../shared/constants/addresses.js";
import type { ResolvedPlanNode } from "../../types.js";

type DecodedCall = {
  op: number;
  target: string;
  payloadLen: number;
  payload: Uint8Array;
};

const EXECUTOR = "0xE08D97e151473A848C3d9CA3f323Cb720472D015";
const SELL_GEM_SELECTOR = "0x95991276";
const BUY_GEM_SELECTOR = ethers.id("buyGem(address,uint256)").slice(0, 10);

function readUint24(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] << 16) | (bytes[offset + 1] << 8) | bytes[offset + 2];
}

function decodeCall(bytes: Uint8Array): DecodedCall {
  const op = bytes[0];
  if (op !== 0x00) {
    throw new Error(`unexpected opcode ${op}`);
  }

  const target = ethers.hexlify(bytes.slice(1, 21)).toLowerCase();
  const payloadLen = readUint24(bytes, 21);
  const payload = bytes.slice(24);
  if (payload.length !== payloadLen) {
    throw new Error(`payload length ${payload.length} != encoded ${payloadLen}`);
  }

  return { op, target, payloadLen, payload };
}

function node(overrides: Partial<ResolvedPlanNode>): ResolvedPlanNode {
  return {
    adapterId: "psm",
    target: ADDR.SKY_PSM_LITE,
    tokenIn: ADDR.USDC,
    tokenOut: ADDR.DAI,
    amount: 0n,
    params: {},
    children: [],
    ...overrides,
  };
}

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error(`FAIL: ${msg}`);
}

function assertEqual<T>(actual: T, expected: T, msg: string): void {
  assert(actual === expected, `${msg}: got ${actual}, expected ${expected}`);
}

function decodePsmArgs(payload: Uint8Array): [string, bigint] {
  const [usr, gemAmt] = ethers.AbiCoder.defaultAbiCoder().decode(
    ["address", "uint256"],
    payload.slice(4),
  ) as unknown as [string, bigint];
  return [usr, gemAmt];
}

function testSellGemBuild(): void {
  const usdcIn = 123_456_789n;
  const encoded = psmAdapter.encode(node({ amount: usdcIn }), EXECUTOR, new Uint8Array());
  const decoded = decodeCall(encoded);
  const [usr, gemAmt] = decodePsmArgs(decoded.payload);

  assertEqual(decoded.target, ADDR.SKY_PSM_LITE.toLowerCase(), "sellGem target");
  assertEqual(ethers.hexlify(decoded.payload.slice(0, 4)), SELL_GEM_SELECTOR, "sellGem selector");
  assertEqual(usr.toLowerCase(), EXECUTOR.toLowerCase(), "sellGem usr");
  assertEqual(gemAmt, usdcIn, "sellGem gemAmt");
  console.log("[psm-build] sellGem calldata: PASS");
}

function testBuyGemBuild(): void {
  const usdcOut = 98_765_432n;
  const encoded = psmAdapter.encode(
    node({
      tokenIn: ADDR.DAI,
      tokenOut: ADDR.USDC,
      amount: usdcOut,
    }),
    EXECUTOR,
    new Uint8Array(),
  );
  const decoded = decodeCall(encoded);
  const [usr, gemAmt] = decodePsmArgs(decoded.payload);

  assertEqual(decoded.target, ADDR.SKY_PSM_LITE.toLowerCase(), "buyGem target");
  assertEqual(ethers.hexlify(decoded.payload.slice(0, 4)), BUY_GEM_SELECTOR, "buyGem selector");
  assertEqual(usr.toLowerCase(), EXECUTOR.toLowerCase(), "buyGem usr");
  assertEqual(gemAmt, usdcOut, "buyGem gemAmt");
  console.log("[psm-build] buyGem calldata: PASS");
}

function testRejectsNonUsdcNode(): void {
  let threw = false;
  try {
    psmAdapter.encode(
      node({
        tokenIn: ADDR.DAI,
        tokenOut: ADDR.WETH,
        amount: 1n,
      }),
      EXECUTOR,
      new Uint8Array(),
    );
  } catch (err) {
    threw = err instanceof Error && err.message.includes("PSM node must have USDC on one side");
  }

  assert(threw, "non-USDC PSM node should throw");
  console.log("[psm-build] non-USDC node rejected: PASS");
}

function main(): void {
  testSellGemBuild();
  testBuyGemBuild();
  testRejectsNonUsdcNode();
  console.log("psm-build PASS (3/3)");
}

try {
  main();
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
