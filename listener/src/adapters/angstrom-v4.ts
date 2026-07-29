import { ethers } from "ethers";
import { encodeCall } from "../encoder.js";
import type { ActionAdapter, ResolvedParam, ResolvedPlanNode } from "../types.js";

/**
 * Official mainnet Angstrom periphery adapter. Pool identity remains an
 * explicit PoolKey input; this singleton is only the physical call target.
 */
export const ANGSTROM_V4_ADAPTER =
  "0xb535aEB27335B91e1B5bcCbd64888bA7574eFBF8";
export const ANGSTROM_V4_HOOK =
  "0x0000000aa232009084Bd71A5797d089AA4Edfad4";

const UINT24_MAX = (1n << 24n) - 1n;
const INT24_MIN = -(1n << 23n);
const INT24_MAX = (1n << 23n) - 1n;
const UINT64_MAX = (1n << 64n) - 1n;
const UINT128_MAX = (1n << 128n) - 1n;
const UINT256_MAX = (1n << 256n) - 1n;
const ANGSTROM_NODE_PREFIX_BYTES = 20;

const angstromAdapterIface = new ethers.Interface([
  "function swap((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) key,bool zeroForOne,uint128 amountSpecified,uint128 minAmountOut,(uint64 blockNumber,bytes unlockData)[] attestations,address recipient,uint256 deadline) returns (uint256 amountOut)",
]);
const swapSelector = angstromAdapterIface.getFunction("swap")!.selector;

/**
 * Direct call to the official AngstromAdapter. Every calldata argument is
 * explicit in node.params. Because ResolvedParam deliberately has no nested
 * object-array type, attestations use two parallel arrays:
 * `attestationBlockNumbers: bigint[]` and `attestationUnlockData: string[]`.
 */
export const angstromV4SwapActionAdapter: ActionAdapter = {
  id: "angstrom-v4-swap",
  isWrapper: false,
  field2Offset: null,

  encode(node: ResolvedPlanNode, executor: string, innerScript: Uint8Array) {
    assertOfficialTarget(node.target);
    if (innerScript.length !== 0) {
      throw new Error("angstrom-v4-swap is a leaf and cannot encode an inner script");
    }

    const currency0 = requiredNonzeroAddress(node.params, "currency0");
    const currency1 = requiredNonzeroAddress(node.params, "currency1");
    if (addressValue(currency0) >= addressValue(currency1)) {
      throw new Error("angstrom-v4-swap requires currency0 < currency1");
    }
    const hooks = requiredNonzeroAddress(node.params, "hooks");
    if (hooks !== ANGSTROM_V4_HOOK) {
      throw new Error(
        `angstrom-v4-swap hooks must be canonical ${ANGSTROM_V4_HOOK}`,
      );
    }
    const fee = requiredUint(node.params, "fee", UINT24_MAX);
    const tickSpacing = requiredInt(node.params, "tickSpacing", INT24_MIN, INT24_MAX);
    const zeroForOne = requiredBoolean(node.params, "zeroForOne");
    const amountSpecified = requiredUint(
      node.params,
      "amountSpecified",
      UINT128_MAX,
      false,
    );
    const minAmountOut = requiredUint(node.params, "minAmountOut", UINT128_MAX);
    const recipient = requiredNonzeroAddress(node.params, "recipient");
    let normalizedExecutor: string;
    try {
      normalizedExecutor = ethers.getAddress(executor);
    } catch {
      throw new Error("angstrom-v4-swap requires a valid executor address");
    }
    if (recipient !== normalizedExecutor) {
      throw new Error(
        "angstrom-v4-swap recipient must equal the executing BotVM",
      );
    }
    const deadline = requiredUint(node.params, "deadline", UINT256_MAX, false);
    const attestationBlockNumbers = requiredBigintArray(
      node.params,
      "attestationBlockNumbers",
    );
    const attestationUnlockData = requiredStringArray(
      node.params,
      "attestationUnlockData",
    );

    if (amountSpecified !== node.amount) {
      throw new Error(
        "angstrom-v4-swap amountSpecified must equal the resolved node amount",
      );
    }
    assertRouteCurrencies(node, currency0, currency1, zeroForOne);
    if (attestationBlockNumbers.length === 0) {
      throw new Error("angstrom-v4-swap requires at least one attestation");
    }
    if (attestationBlockNumbers.length !== attestationUnlockData.length) {
      throw new Error(
        "angstrom-v4-swap attestation block/data arrays must have equal length",
      );
    }

    const seenBlocks = new Set<bigint>();
    const attestations = attestationBlockNumbers.map((blockNumber, index) => {
      assertUint("attestationBlockNumbers", blockNumber, UINT64_MAX);
      if (seenBlocks.has(blockNumber)) {
        throw new Error(
          `angstrom-v4-swap has duplicate attestation block ${blockNumber}`,
        );
      }
      seenBlocks.add(blockNumber);
      const unlockData = normalizeAttestationBytes(
        attestationUnlockData[index],
        index,
      );
      return { blockNumber, unlockData };
    });

    const calldata = angstromAdapterIface.encodeFunctionData("swap", [
      {
        currency0,
        currency1,
        fee: Number(fee),
        tickSpacing: Number(tickSpacing),
        hooks,
      },
      zeroForOne,
      amountSpecified,
      minAmountOut,
      attestations,
      recipient,
      deadline,
    ]);
    // encodeCall emits BotVM CALL (opcode 0x00), so this action can never attach
    // native value to the official adapter.
    return encodeCall(ANGSTROM_V4_ADAPTER, ethers.getBytes(calldata));
  },

  matchTrace(target: string, selector: string) {
    try {
      return ethers.getAddress(target) === ANGSTROM_V4_ADAPTER &&
        selector.toLowerCase() === swapSelector.toLowerCase();
    } catch {
      return false;
    }
  },
};

function assertOfficialTarget(target: string): void {
  let normalized: string;
  try {
    normalized = ethers.getAddress(target);
  } catch {
    throw new Error("angstrom-v4-swap requires a valid target address");
  }
  if (normalized !== ANGSTROM_V4_ADAPTER) {
    throw new Error(
      `angstrom-v4-swap target must be official adapter ${ANGSTROM_V4_ADAPTER}`,
    );
  }
}

function requiredBoolean(
  params: ResolvedPlanNode["params"],
  key: string,
): boolean {
  const value = params[key];
  if (typeof value !== "boolean") {
    throw new Error(`angstrom-v4-swap requires boolean ${key}`);
  }
  return value;
}

function requiredUint(
  params: ResolvedPlanNode["params"],
  key: string,
  max: bigint,
  allowZero = true,
): bigint {
  const value = params[key];
  if (typeof value !== "bigint") {
    throw new Error(`angstrom-v4-swap requires bigint ${key}`);
  }
  assertUint(key, value, max, allowZero);
  return value;
}

function assertUint(
  key: string,
  value: bigint,
  max: bigint,
  allowZero = true,
): void {
  if (value < 0n || value > max || (!allowZero && value === 0n)) {
    const domain = allowZero ? `[0, ${max}]` : `[1, ${max}]`;
    throw new Error(`angstrom-v4-swap ${key} must be in ${domain}`);
  }
}

function requiredInt(
  params: ResolvedPlanNode["params"],
  key: string,
  min: bigint,
  max: bigint,
): bigint {
  const value = params[key];
  if (typeof value !== "bigint") {
    throw new Error(`angstrom-v4-swap requires bigint ${key}`);
  }
  if (value < min || value > max) {
    throw new Error(`angstrom-v4-swap ${key} must be in [${min}, ${max}]`);
  }
  return value;
}

function requiredNonzeroAddress(
  params: ResolvedPlanNode["params"],
  key: string,
): string {
  const value = params[key];
  if (typeof value !== "string") {
    throw new Error(`angstrom-v4-swap requires address ${key}`);
  }
  let normalized: string;
  try {
    normalized = ethers.getAddress(value);
  } catch {
    throw new Error(`angstrom-v4-swap requires valid address ${key}`);
  }
  if (normalized === ethers.ZeroAddress) {
    throw new Error(`angstrom-v4-swap requires nonzero address ${key}`);
  }
  return normalized;
}

function requiredBigintArray(
  params: ResolvedPlanNode["params"],
  key: string,
): bigint[] {
  const value: ResolvedParam | undefined = params[key];
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== "bigint")
  ) {
    throw new Error(`angstrom-v4-swap requires bigint[] ${key}`);
  }
  return value as bigint[];
}

function requiredStringArray(
  params: ResolvedPlanNode["params"],
  key: string,
): string[] {
  const value: ResolvedParam | undefined = params[key];
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== "string")
  ) {
    throw new Error(`angstrom-v4-swap requires string[] ${key}`);
  }
  return value as string[];
}

function normalizeAttestationBytes(value: string, index: number): string {
  if (
    !ethers.isHexString(value) ||
    ethers.dataLength(value) <= ANGSTROM_NODE_PREFIX_BYTES
  ) {
    throw new Error(
      `angstrom-v4-swap attestationUnlockData[${index}] must be ` +
        "a 20-byte node followed by a non-empty signature",
    );
  }
  return ethers.hexlify(ethers.getBytes(value));
}

function assertRouteCurrencies(
  node: ResolvedPlanNode,
  currency0: string,
  currency1: string,
  zeroForOne: boolean,
): void {
  let tokenIn: string;
  let tokenOut: string;
  try {
    tokenIn = ethers.getAddress(node.tokenIn);
    tokenOut = ethers.getAddress(node.tokenOut);
  } catch {
    throw new Error("angstrom-v4-swap requires valid route token addresses");
  }
  const expectedIn = zeroForOne ? currency0 : currency1;
  const expectedOut = zeroForOne ? currency1 : currency0;
  if (tokenIn !== expectedIn || tokenOut !== expectedOut) {
    throw new Error(
      "angstrom-v4-swap route tokens do not match PoolKey direction",
    );
  }
}

function addressValue(address: string): bigint {
  return BigInt(address.toLowerCase());
}
