import { ethers } from "ethers";
import {
  isStateCallAbortedError,
  type StateBackend,
} from "../../../shared/state/state-backend.js";

const curveIface = new ethers.Interface([
  "function get_dy(int128 i, int128 j, uint256 dx) view returns (uint256)",
  "function coins(uint256 i) view returns (address)",
]);
const curveIfaceUint = new ethers.Interface([
  "function get_dy(uint256 i, uint256 j, uint256 dx) view returns (uint256)",
]);
const curveIfaceIntCoins = new ethers.Interface([
  "function coins(int128 i) view returns (address)",
]);
const curveCoinsCache = new Map<string, string[]>();

export async function queryCurveCoins(
  state: Pick<StateBackend, "call">,
  pool: string,
): Promise<string[]> {
  const key = pool.toLowerCase();
  const cached = curveCoinsCache.get(key);
  if (cached) return cached;
  const coins: string[] = [];
  for (let i = 0; i < 8; i++) {
    const addr = await queryCurveCoinAt(state, pool, i);
    if (!addr) break;
    coins.push(addr);
  }
  if (coins.length === 0) throw new Error(`curve pool ${pool} exposed no coins`);
  curveCoinsCache.set(key, coins);
  return coins;
}

export async function resolveCurveIndices(
  state: Pick<StateBackend, "call">,
  pool: string,
  tokenIn: string,
  tokenOut: string,
): Promise<[number, number]> {
  const coins = await queryCurveCoins(state, pool);
  return [findIndex(coins, tokenIn), findIndex(coins, tokenOut)];
}

export async function quoteCurvePlain(
  state: Pick<StateBackend, "call">,
  pool: string,
  tokenIn: string,
  tokenOut: string,
  amountIn: bigint,
): Promise<bigint> {
  const [i, j] = await resolveCurveIndices(state, pool, tokenIn, tokenOut);
  try {
    const data = curveIface.encodeFunctionData("get_dy", [BigInt(i), BigInt(j), amountIn]);
    const result = await state.call({ to: pool, data });
    return BigInt(result);
  } catch (error) {
    if (isStateCallAbortedError(error)) throw error;
    const data = curveIfaceUint.encodeFunctionData("get_dy", [BigInt(i), BigInt(j), amountIn]);
    const result = await state.call({ to: pool, data });
    return BigInt(result);
  }
}

async function queryCurveCoinAt(
  state: Pick<StateBackend, "call">,
  pool: string,
  index: number,
): Promise<string | null> {
  for (const iface of [curveIface, curveIfaceIntCoins]) {
    try {
      const data = iface.encodeFunctionData("coins", [BigInt(index)]);
      const result = await state.call({ to: pool, data });
      if (!result || result === "0x") continue;
      const addr = ethers.getAddress(`0x${result.slice(-40)}`);
      if (addr === ethers.ZeroAddress) return null;
      return addr;
    } catch (error) {
      if (isStateCallAbortedError(error)) throw error;
      // Try the next common Curve ABI shape.
    }
  }
  return null;
}

function findIndex(coins: readonly string[], token: string): number {
  const key = token.toLowerCase();
  const idx = coins.findIndex((coin) => coin.toLowerCase() === key);
  if (idx < 0) throw new Error(`token ${token} not in curve pool coins [${coins.join(",")}]`);
  return idx;
}
