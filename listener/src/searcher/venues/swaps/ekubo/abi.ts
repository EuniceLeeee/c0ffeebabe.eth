import { ethers } from "ethers";
import type { TokenEdge } from "../../../planner/token-graph.js";
import {
  decodeEkuboPoolKeyBinding,
  ekuboDirection,
  type EkuboPoolKey,
} from "./pool-key.js";

export const EKUBO_CORE =
  "0x00000000000014aa86c5d3c41765bb24e11bd701";
export const EKUBO_ROUTER =
  "0xd26f20001a72a18c002b00e6710000d68700ce00";
export const EKUBO_CORE_DEPLOY_BLOCK = 24_133_391;

export const EKUBO_POOL_INITIALIZED_TOPIC = ethers.id(
  "PoolInitialized(bytes32,(address,address,bytes32),int32,uint96)",
).toLowerCase();

export const EKUBO_CORE_SWAP_DATA_BYTES = 116;
export const EKUBO_CORE_SWAP_POOL_ID_OFFSET_BYTES = 20;

export const ekuboRouterIface = new ethers.Interface([
  "function quote((address token0,address token1,bytes32 config) poolKey,bool isToken1,int128 amount,uint96 sqrtRatioLimit,uint256 skipAhead) returns (bytes32 balanceUpdate,bytes32 stateAfter)",
  "function swap((address token0,address token1,bytes32 config) poolKey,bool isToken1,int128 amount,uint96 sqrtRatioLimit,uint256 skipAhead,int256 calculatedAmountThreshold,address recipient) payable returns (bytes32 balanceUpdate)",
  "function swapAllowPartialFill((address token0,address token1,bytes32 config) poolKey,bool isToken1,int128 amount,uint96 sqrtRatioLimit,uint256 skipAhead,address recipient) payable returns (bytes32 balanceUpdate)",
]);

export const EKUBO_ROUTER_SWAP_SELECTOR = ekuboRouterIface.getFunction(
  "swap((address,address,bytes32),bool,int128,uint96,uint256,int256,address)",
)!.selector.toLowerCase();
export const EKUBO_ROUTER_PARTIAL_SWAP_SELECTOR = ekuboRouterIface.getFunction(
  "swapAllowPartialFill((address,address,bytes32),bool,int128,uint96,uint256,address)",
)!.selector.toLowerCase();

const INT128_MODULUS = 1n << 128n;
const INT128_SIGN = 1n << 127n;
const INT128_MASK = INT128_MODULUS - 1n;
export const EKUBO_MAX_EXACT_INPUT = INT128_SIGN - 1n;

export interface EkuboBalanceUpdate {
  readonly delta0: bigint;
  readonly delta1: bigint;
}

export interface ParsedEkuboCoreSwapLog extends EkuboBalanceUpdate {
  readonly locker: string;
  readonly poolId: string;
  readonly stateAfter: string;
}

export function encodeEkuboQuote(
  poolKey: EkuboPoolKey,
  isToken1: boolean,
  amountIn: bigint,
): string {
  assertEkuboExactInput(amountIn);
  return ekuboRouterIface.encodeFunctionData("quote", [
    poolKey,
    isToken1,
    amountIn,
    0n,
    0n,
  ]);
}

export function encodeEkuboSwap(
  poolKey: EkuboPoolKey,
  isToken1: boolean,
  amountIn: bigint,
  calculatedAmountThreshold: bigint,
  recipient: string,
): string {
  assertEkuboExactInput(amountIn);
  if (calculatedAmountThreshold <= 0n) {
    throw new Error("Ekubo swap requires a positive output threshold");
  }
  return ekuboRouterIface.encodeFunctionData(
    "swap((address,address,bytes32),bool,int128,uint96,uint256,int256,address)",
    [
      poolKey,
      isToken1,
      amountIn,
      0n,
      0n,
      calculatedAmountThreshold,
      ethers.getAddress(recipient),
    ],
  );
}

export function decodeEkuboQuoteOutput(
  edge: TokenEdge,
  data: string,
  expectedAmountIn?: bigint,
): bigint {
  const binding = edge.routeBinding;
  if (!binding) throw new Error("Ekubo quote edge is missing its PoolKey binding");
  const poolKey = decodeEkuboPoolKeyBinding(binding);
  const isToken1 = ekuboDirection(edge.tokenIn, edge.tokenOut, poolKey);
  const decoded = ekuboRouterIface.decodeFunctionResult("quote", data);
  const update = decodeEkuboBalanceUpdate(String(decoded[0]));
  return exactInputAmountOut(update, isToken1, expectedAmountIn);
}

export function decodeEkuboBalanceUpdate(
  value: string,
): EkuboBalanceUpdate {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error("Ekubo balance update must be bytes32");
  }
  const packed = BigInt(value);
  return Object.freeze({
    delta0: signedInt128(packed >> 128n),
    delta1: signedInt128(packed & INT128_MASK),
  });
}

export function parseEkuboCoreSwapLog(data: string): ParsedEkuboCoreSwapLog {
  if (
    !/^0x[0-9a-fA-F]+$/.test(data) ||
    (data.length - 2) / 2 !== EKUBO_CORE_SWAP_DATA_BYTES
  ) {
    throw new Error(
      `Ekubo anonymous swap log must be ${EKUBO_CORE_SWAP_DATA_BYTES} bytes`,
    );
  }
  const raw = data.slice(2).toLowerCase();
  const locker = ethers.getAddress(`0x${raw.slice(0, 40)}`);
  const poolId = `0x${raw.slice(40, 104)}`;
  const balanceUpdate = `0x${raw.slice(104, 168)}`;
  const stateAfter = `0x${raw.slice(168, 232)}`;
  return Object.freeze({
    locker,
    poolId,
    ...decodeEkuboBalanceUpdate(balanceUpdate),
    stateAfter,
  });
}

export function exactInputAmountOut(
  update: EkuboBalanceUpdate,
  isToken1: boolean,
  expectedAmountIn?: bigint,
): bigint {
  const specified = isToken1 ? update.delta1 : update.delta0;
  const calculated = isToken1 ? update.delta0 : update.delta1;
  if (specified <= 0n || calculated >= 0n) {
    throw new Error(
      "Ekubo quote is not a positive exact-input/negative-output update",
    );
  }
  if (expectedAmountIn !== undefined && specified !== expectedAmountIn) {
    throw new Error(
      `Ekubo quote partially filled ${specified}/${expectedAmountIn}`,
    );
  }
  return -calculated;
}

export function assertEkuboExactInput(amountIn: bigint): void {
  if (amountIn <= 0n || amountIn > EKUBO_MAX_EXACT_INPUT) {
    throw new Error("Ekubo exact input must fit positive int128");
  }
}

function signedInt128(value: bigint): bigint {
  const masked = value & INT128_MASK;
  return masked >= INT128_SIGN ? masked - INT128_MODULUS : masked;
}
