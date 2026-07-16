import { ethers } from "ethers";
import { encodeCall } from "../../encoder.js";
import {
  makeProtocolAdapter,
  PROTOCOL_LEG_DESCRIPTORS,
  type ProtocolLegDescriptor,
} from "../../adapters/protocol-legs.js";
import type { ResolvedPlanNode } from "../../types.js";

type DecodedCall = {
  op: number;
  target: string;
  payloadLen: number;
  payload: Uint8Array;
};

type ProtocolCase = {
  id: string;
  signature: string;
  selector: string;
  expectedArgs: (node: ResolvedPlanNode, executor: string) => Array<bigint | string>;
};

const EXECUTOR = "0xE08D97e151473A848C3d9CA3f323Cb720472D015";
const WRONG_SELECTOR = "0x00000000";

const NODE: ResolvedPlanNode = {
  adapterId: "protocol-leg",
  target: "0x000000000000000000000000000000000000dEaD",
  tokenIn: "0x0000000000000000000000000000000000000001",
  tokenOut: "0x0000000000000000000000000000000000000002",
  amount: 123456789n,
  params: {},
  children: [],
};

const CASES: ProtocolCase[] = [
  {
    id: "wsteth-wrap",
    signature: "wrap(uint256)",
    selector: "0xea598cb0",
    expectedArgs: (node) => [node.amount],
  },
  {
    id: "wsteth-unwrap",
    signature: "unwrap(uint256)",
    selector: "0xde0e9a3e",
    expectedArgs: (node) => [node.amount],
  },
  {
    id: "erc4626-deposit",
    signature: "deposit(uint256,address)",
    selector: ethers.id("deposit(uint256,address)").slice(0, 10),
    expectedArgs: (node, executor) => [node.amount, executor],
  },
  {
    id: "erc4626-redeem",
    signature: "redeem(uint256,address,address)",
    selector: ethers.id("redeem(uint256,address,address)").slice(0, 10),
    expectedArgs: (node, executor) => [node.amount, executor, executor],
  },
  {
    // Non-standard silo redeem: multi-token exact-in redeem(token, shares, receiver, owner).
    // token arg (index 0) is sourced from node.tokenOut; selector must be 0xfea53be1 (distinct
    // from erc4626-redeem's 0xba087652 so matchTrace never shadows).
    id: "erc4626-redeem-silo",
    signature: "redeem(address,uint256,address,address)",
    selector: ethers.id("redeem(address,uint256,address,address)").slice(0, 10),
    expectedArgs: (node, executor) => [node.tokenOut, node.amount, executor, executor],
  },
  {
    id: "rocksolid-sync-deposit",
    signature: "syncDeposit(uint256,address,address)",
    selector: "0xd01d073a",
    expectedArgs: (node, executor) => [node.amount, executor, ethers.ZeroAddress],
  },
  {
    id: "metronome-synth-swap",
    signature: "swap(address,address,uint256)",
    selector: "0xdf791e50",
    expectedArgs: (node) => [node.tokenIn, node.tokenOut, node.amount],
  },
];

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error(`FAIL: ${msg}`);
}

function assertEqual<T>(actual: T, expected: T, msg: string): void {
  assert(actual === expected, `${msg}: got ${actual}, expected ${expected}`);
}

function functionName(signature: string): string {
  return signature.slice(0, signature.indexOf("("));
}

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

function descriptorById(id: string): ProtocolLegDescriptor {
  const desc = PROTOCOL_LEG_DESCRIPTORS.find((entry) => entry.id === id);
  assert(desc !== undefined, `descriptor missing: ${id}`);
  return desc;
}

function expectedEncode(testCase: ProtocolCase): Uint8Array {
  const iface = new ethers.Interface([`function ${testCase.signature}`]);
  const calldata = iface.encodeFunctionData(
    functionName(testCase.signature),
    testCase.expectedArgs(NODE, EXECUTOR),
  );
  return encodeCall(NODE.target, ethers.getBytes(calldata));
}

function testByteIdenticalPins(): void {
  for (const testCase of CASES) {
    const adapter = makeProtocolAdapter(descriptorById(testCase.id));
    const actual = adapter.encode(NODE, EXECUTOR, new Uint8Array());
    const expected = expectedEncode(testCase);
    assertEqual(ethers.hexlify(actual), ethers.hexlify(expected), `${testCase.id} encoded bytes`);
  }
  console.log("[protocol-legs] byte-identical pins: PASS");
}

function testSelectorPins(): void {
  for (const testCase of CASES) {
    const adapter = makeProtocolAdapter(descriptorById(testCase.id));
    assert(adapter.matchTrace(NODE.target, testCase.selector), `${testCase.id} selector should match`);
    assert(!adapter.matchTrace(NODE.target, WRONG_SELECTOR), `${testCase.id} wrong selector should not match`);
  }
  console.log("[protocol-legs] selector pins: PASS");
}

function testRoundTrip(): void {
  for (const testCase of CASES) {
    const desc = descriptorById(testCase.id);
    const adapter = makeProtocolAdapter(desc);
    const encoded = adapter.encode(NODE, EXECUTOR, new Uint8Array());
    const decodedCall = decodeCall(encoded);
    const iface = new ethers.Interface([`function ${testCase.signature}`]);
    const decoded = iface.decodeFunctionData(functionName(testCase.signature), decodedCall.payload);

    assertEqual(decodedCall.target, NODE.target.toLowerCase(), `${testCase.id} target`);
    assertEqual(BigInt(decoded[desc.amountArg]), NODE.amount, `${testCase.id} amount arg`);
    for (const index of desc.executorArgs) {
      assertEqual(String(decoded[index]).toLowerCase(), EXECUTOR.toLowerCase(), `${testCase.id} executor arg ${index}`);
    }
    if (desc.tokenOutArg !== undefined) {
      assertEqual(String(decoded[desc.tokenOutArg]).toLowerCase(), NODE.tokenOut.toLowerCase(), `${testCase.id} tokenOut arg ${desc.tokenOutArg}`);
    }
    if (desc.tokenInArg !== undefined) {
      assertEqual(String(decoded[desc.tokenInArg]).toLowerCase(), NODE.tokenIn.toLowerCase(), `${testCase.id} tokenIn arg ${desc.tokenInArg}`);
    }
    for (const index of desc.zeroAddressArgs ?? []) {
      assertEqual(String(decoded[index]).toLowerCase(), ethers.ZeroAddress, `${testCase.id} zero-address arg ${index}`);
    }
  }
  console.log("[protocol-legs] round-trip decode: PASS");
}

function testHoleGuard(): void {
  let threw = false;
  try {
    makeProtocolAdapter({
      id: "bad-hole",
      signature: "bad(uint256,address)",
      amountArg: 0,
      executorArgs: [],
      needsApprove: false,
    });
  } catch {
    threw = true;
  }

  assert(threw, "descriptor with uncovered arg index should throw");
  console.log("[protocol-legs] hole guard: PASS");
}

function main(): void {
  const tests = [
    testByteIdenticalPins,
    testSelectorPins,
    testRoundTrip,
    testHoleGuard,
  ];
  let passed = 0;
  for (const test of tests) {
    try {
      test();
      passed++;
    } catch (err) {
      console.error(`[protocol-legs] ${test.name}: FAIL`);
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  }
  console.log(`protocol-legs PASS (${passed}/${tests.length})`);
}

main();
