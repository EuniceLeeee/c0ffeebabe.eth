import { AbiCoder, concat, getCreate2Address, getAddress, isHexString, keccak256 } from "ethers";
import type { DeclarativeMathModel, MathValue } from "../../declarative-math.js";

/**
 * Pure declarative math for the PrecisionPool identity proof. This model only
 * derives the CREATE2 address from already-read runtime facts; it performs no
 * transport, admission or state access. The sibling runtime decoder remains the
 * single owner of the compiler immutable layout and the raw-byte checker.
 */
const MARKET_TYPE = "tuple(address token0,address token1,uint256 sqrtPLow,uint256 sqrtPHigh,uint256 fee,address hook,address feeRecipient,uint256 creatorFeeBps)";
type Data = Readonly<Record<string, any>>;
const MAX_UINT256 = (1n << 256n) - 1n;

function record(value: MathValue, label: string): Data {
  if (!value || typeof value !== "object" || Array.isArray(value) || value instanceof Map)
    throw new Error(`precision-pool math: ${label} must be a record`);
  return value as Data;
}
function uint(value: MathValue, label: string): bigint {
  const parsed = typeof value === "bigint" ? value
    : typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value) ? BigInt(value) : null;
  if (parsed === null || parsed < 0n || parsed > MAX_UINT256) throw new Error(`precision-pool math: ${label} must be uint256`);
  return parsed;
}
function address(value: MathValue, label: string): string {
  if (typeof value !== "string") throw new Error(`precision-pool math: ${label} must be an address`);
  return getAddress(value).toLowerCase();
}
function market(value: MathValue): readonly [string, string, bigint, bigint, bigint, string, string, bigint] {
  if (!Array.isArray(value) || value.length !== 8) throw new Error("precision-pool math: market tuple");
  return [address(value[0]!, "token0"), address(value[1]!, "token1"),
    uint(value[2]!, "sqrtPLow"), uint(value[3]!, "sqrtPHigh"), uint(value[4]!, "fee"),
    address(value[5]!, "hook"), address(value[6]!, "feeRecipient"), uint(value[7]!, "creatorFeeBps")];
}

export const precisionPoolCreate2MathModel: DeclarativeMathModel = {
  id: "precision-pool:create2",
  version: 1,
  validateInput(value) {
    const input = record(value, "create2 input");
    address(input.factory, "factory");
    if (typeof input.creation !== "string" || !isHexString(input.creation, true)) throw new Error("precision-pool math: creation");
    market(input.market as MathValue);
  },
  evaluate(value) {
    const input = record(value, "create2 input");
    const factory = address(input.factory, "factory");
    const creation = input.creation as string;
    const tuple = market(input.market as MathValue);
    const abi = AbiCoder.defaultAbiCoder();
    const salt = keccak256(abi.encode([MARKET_TYPE], [tuple]));
    const initCode = concat([creation, abi.encode(["address", MARKET_TYPE], [factory, tuple])]);
    return { predicted: getCreate2Address(factory, salt, keccak256(initCode)).toLowerCase() };
  },
  validateOutput(value) {
    const output = record(value, "create2 output");
    if (typeof output.predicted !== "string" || !/^0x[0-9a-f]{40}$/.test(output.predicted))
      throw new Error("precision-pool math: predicted address");
  },
};

export const precisionPoolMathModels: readonly DeclarativeMathModel[] = Object.freeze([precisionPoolCreate2MathModel]);
