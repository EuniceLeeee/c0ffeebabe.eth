import { ethers } from "ethers";
import {
  ANGSTROM_V4_ADAPTER,
  ANGSTROM_V4_HOOK,
  angstromV4SwapActionAdapter,
} from "../../adapters/angstrom-v4.js";
import type { ResolvedPlanNode } from "../../types.js";

const CURRENCY0 = "0x0000000000000000000000000000000000000001";
const CURRENCY1 = "0x0000000000000000000000000000000000000002";
const HOOKS = ANGSTROM_V4_HOOK;
const OUTER_EXECUTOR = "0x0000000000000000000000000000000000000005";
const RECIPIENT = OUTER_EXECUTOR;
const AMOUNT = 123_456n;
const MIN_OUT = 120_000n;
const DEADLINE = 9_999_999_999n;
const BLOCKS = [24_000_001n, 24_000_002n];
const UNLOCK_DATA = [
  `0x${"11".repeat(85)}`,
  `0x${"22".repeat(123)}`,
];

const iface = new ethers.Interface([
  "function swap((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) key,bool zeroForOne,uint128 amountSpecified,uint128 minAmountOut,(uint64 blockNumber,bytes unlockData)[] attestations,address recipient,uint256 deadline) returns (uint256 amountOut)",
]);

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`FAIL: ${message}`);
}

function baseNode(): ResolvedPlanNode {
  return {
    adapterId: "angstrom-v4-swap",
    target: ANGSTROM_V4_ADAPTER,
    tokenIn: CURRENCY0,
    tokenOut: CURRENCY1,
    amount: AMOUNT,
    params: {
      currency0: CURRENCY0,
      currency1: CURRENCY1,
      fee: 0x800000n,
      tickSpacing: 60n,
      hooks: HOOKS,
      zeroForOne: true,
      amountSpecified: AMOUNT,
      minAmountOut: MIN_OUT,
      attestationBlockNumbers: [...BLOCKS],
      attestationUnlockData: [...UNLOCK_DATA],
      recipient: RECIPIENT,
      deadline: DEADLINE,
    },
    children: [],
  };
}

function testExactEncoding(): void {
  const encoded = angstromV4SwapActionAdapter.encode(
    baseNode(),
    OUTER_EXECUTOR,
    new Uint8Array(),
  );
  assert(encoded[0] === 0x00, "must use value-zero CALL opcode");
  assert(
    ethers.getAddress(ethers.hexlify(encoded.slice(1, 21))) ===
      ANGSTROM_V4_ADAPTER,
    "must call the official Angstrom adapter",
  );
  const payloadLength =
    (encoded[21] << 16) | (encoded[22] << 8) | encoded[23];
  const payload = ethers.hexlify(encoded.slice(24));
  assert(
    payloadLength === ethers.dataLength(payload),
    "BotVM payload length must be exact",
  );
  assert(payload.slice(0, 10) === "0xa88f90c1", "official swap selector");

  const decoded = iface.decodeFunctionData("swap", payload);
  const key = decoded[0];
  assert(key.currency0 === CURRENCY0, "currency0");
  assert(key.currency1 === CURRENCY1, "currency1");
  assert(BigInt(key.fee) === 0x800000n, "fee");
  assert(BigInt(key.tickSpacing) === 60n, "tickSpacing");
  assert(key.hooks === HOOKS, "hooks");
  assert(decoded[1] === true, "zeroForOne");
  assert(BigInt(decoded[2]) === AMOUNT, "amountSpecified");
  assert(BigInt(decoded[3]) === MIN_OUT, "minAmountOut");
  assert(decoded[4].length === 2, "attestation count");
  for (let index = 0; index < BLOCKS.length; index++) {
    assert(
      BigInt(decoded[4][index].blockNumber) === BLOCKS[index],
      `attestation ${index} block`,
    );
    assert(
      decoded[4][index].unlockData === UNLOCK_DATA[index],
      `attestation ${index} bytes`,
    );
  }
  assert(decoded[5] === RECIPIENT, "explicit recipient");
  assert(decoded[5] === OUTER_EXECUTOR, "recipient must be executing BotVM");
  assert(BigInt(decoded[6]) === DEADLINE, "deadline");
}

function testTraceMatching(): void {
  assert(
    angstromV4SwapActionAdapter.matchTrace(
      ANGSTROM_V4_ADAPTER.toLowerCase(),
      "0xA88F90C1",
    ),
    "official target and selector match",
  );
  assert(
    !angstromV4SwapActionAdapter.matchTrace(RECIPIENT, "0xa88f90c1"),
    "same selector on another target must not match",
  );
  assert(
    !angstromV4SwapActionAdapter.matchTrace(ANGSTROM_V4_ADAPTER, "0xdeadbeef"),
    "wrong selector must not match",
  );
  assert(
    !angstromV4SwapActionAdapter.matchTrace("not-an-address", "0xa88f90c1"),
    "invalid target must not match",
  );
}

function testReverseDirection(): void {
  const node = baseNode();
  node.tokenIn = CURRENCY1;
  node.tokenOut = CURRENCY0;
  node.params.zeroForOne = false;
  const payload = encodedPayload(
    angstromV4SwapActionAdapter.encode(
      node,
      OUTER_EXECUTOR,
      new Uint8Array(),
    ),
  );
  assert(iface.decodeFunctionData("swap", payload)[1] === false, "reverse direction");
}

function testFailClosedValidation(): void {
  expectFailure(
    (node) => {
      node.target = RECIPIENT;
    },
    "target must be official adapter",
  );
  expectFailure(
    (node) => {
      node.params.hooks =
        "0x0000000000000000000000000000000000000003";
    },
    "hooks must be canonical",
  );
  expectFailure(
    (node) => {
      node.params.currency0 = "not-an-address";
    },
    "requires valid address currency0",
  );
  expectFailure(
    (node) => {
      node.params.currency0 = ethers.ZeroAddress;
    },
    "requires nonzero address currency0",
  );
  expectFailure(
    (node) => {
      node.params.currency0 = CURRENCY1;
      node.params.currency1 = CURRENCY0;
    },
    "requires currency0 < currency1",
  );
  expectFailure(
    (node) => {
      node.params.fee = 1n << 24n;
    },
    "fee must be in",
  );
  expectFailure(
    (node) => {
      node.params.tickSpacing = 1n << 23n;
    },
    "tickSpacing must be in",
  );
  expectFailure(
    (node) => {
      node.params.zeroForOne = 1n;
    },
    "requires boolean zeroForOne",
  );
  expectFailure(
    (node) => {
      node.params.amountSpecified = 0n;
      node.amount = 0n;
    },
    "amountSpecified must be in",
  );
  expectFailure(
    (node) => {
      node.params.amountSpecified = AMOUNT + 1n;
    },
    "must equal the resolved node amount",
  );
  expectFailure(
    (node) => {
      node.params.minAmountOut = -1n;
    },
    "minAmountOut must be in",
  );
  expectFailure(
    (node) => {
      node.params.recipient = ethers.ZeroAddress;
    },
    "requires nonzero address recipient",
  );
  expectFailure(
    (node) => {
      node.params.recipient =
        "0x0000000000000000000000000000000000000004";
    },
    "recipient must equal the executing BotVM",
  );
  expectFailure(
    (node) => {
      node.params.deadline = 0n;
    },
    "deadline must be in",
  );
  expectFailure(
    (node) => {
      node.params.attestationBlockNumbers = [];
      node.params.attestationUnlockData = [];
    },
    "requires at least one attestation",
  );
  expectFailure(
    (node) => {
      node.params.attestationBlockNumbers = [BLOCKS[0]];
    },
    "must have equal length",
  );
  expectFailure(
    (node) => {
      node.params.attestationBlockNumbers = [BLOCKS[0], BLOCKS[0]];
    },
    "duplicate attestation block",
  );
  expectFailure(
    (node) => {
      node.params.attestationBlockNumbers = [1n << 64n, BLOCKS[1]];
    },
    "attestationBlockNumbers must be in",
  );
  expectFailure(
    (node) => {
      node.params.attestationUnlockData = ["0x1234", UNLOCK_DATA[1]];
    },
    "20-byte node followed by a non-empty signature",
  );
  expectFailure(
    (node) => {
      node.params.attestationUnlockData = [
        `0x${"33".repeat(20)}`,
        UNLOCK_DATA[1],
      ];
    },
    "20-byte node followed by a non-empty signature",
  );
  expectFailure(
    (node) => {
      node.tokenOut = RECIPIENT;
    },
    "route tokens do not match",
  );
  expectFailure(
    () => {},
    "cannot encode an inner script",
    new Uint8Array([0x01]),
  );
}

function expectFailure(
  mutate: (node: ResolvedPlanNode) => void,
  expected: string,
  innerScript = new Uint8Array(),
): void {
  const node = baseNode();
  mutate(node);
  let message = "";
  try {
    angstromV4SwapActionAdapter.encode(node, OUTER_EXECUTOR, innerScript);
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  assert(
    message.includes(expected),
    `expected error containing "${expected}", got "${message}"`,
  );
}

function encodedPayload(encoded: Uint8Array): string {
  assert(encoded[0] === 0x00, "expected CALL opcode");
  const payloadLength =
    (encoded[21] << 16) | (encoded[22] << 8) | encoded[23];
  const payload = ethers.hexlify(encoded.slice(24));
  assert(
    payloadLength === ethers.dataLength(payload),
    "encoded payload length",
  );
  return payload;
}

testExactEncoding();
testTraceMatching();
testReverseDirection();
testFailClosedValidation();
console.log("angstrom-v4 action adapter PASS (4/4)");
