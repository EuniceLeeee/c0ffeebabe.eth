import { ethers } from "ethers";
import { ADDR } from "../../shared/constants/addresses.js";
import type { OrderflowEvent } from "../orderflow/manual-source.js";

export interface PoolImpact {
  pool: string;
  tokenIn: string;
  tokenOut: string;
  amountIn: bigint;
  direction: "wstUSR-to-DOLA" | "DOLA-to-wstUSR";
}

const CURVE_EXCHANGE = new ethers.Interface([
  "function exchange(int128 i, int128 j, uint256 dx, uint256 min_dy)",
  "function exchange(int128 i, int128 j, uint256 dx, uint256 min_dy, address receiver)",
  "function exchange_received(int128 i, int128 j, uint256 dx, uint256 min_dy)",
  "function exchange_received(int128 i, int128 j, uint256 dx, uint256 min_dy, address receiver)",
]);

const CURVE_SELECTORS = new Set([
  "0x3df02124",
  "0xddc1f59d",
  "0x7e3db030",
  "0xafb43012",
]);

export function detectPoolImpact(event: OrderflowEvent): PoolImpact[] {
  const direct = detectDirectCurveCall(event);
  if (direct.length > 0) return direct;

  return detectCurveLogs(event);
}

function detectDirectCurveCall(event: OrderflowEvent): PoolImpact[] {
  if (!event.to || event.to.toLowerCase() !== ADDR.CURVE_DOLA_WSTUSR.toLowerCase()) {
    return [];
  }
  const selector = event.input.slice(0, 10).toLowerCase();
  if (!CURVE_SELECTORS.has(selector)) return [];

  const parsed = CURVE_EXCHANGE.parseTransaction({ data: event.input });
  if (!parsed) return [];

  const i = BigInt(parsed.args[0]);
  const j = BigInt(parsed.args[1]);
  const amountIn = BigInt(parsed.args[2]);

  if (i === 1n && j === 0n) {
    return [{
      pool: ADDR.CURVE_DOLA_WSTUSR,
      tokenIn: ADDR.WSTUSR,
      tokenOut: ADDR.DOLA,
      amountIn,
      direction: "wstUSR-to-DOLA",
    }];
  }

  if (i === 0n && j === 1n) {
    return [{
      pool: ADDR.CURVE_DOLA_WSTUSR,
      tokenIn: ADDR.DOLA,
      tokenOut: ADDR.WSTUSR,
      amountIn,
      direction: "DOLA-to-wstUSR",
    }];
  }

  return [];
}

function detectCurveLogs(event: OrderflowEvent): PoolImpact[] {
  const impacts: PoolImpact[] = [];
  const abi = ethers.AbiCoder.defaultAbiCoder();

  for (const log of event.logs) {
    if (log.address.toLowerCase() !== ADDR.CURVE_DOLA_WSTUSR.toLowerCase()) continue;
    if (log.topics[0]?.toLowerCase() !== "0x8b3e96f2b889fa771c53c981b40daf005f63f637f1869f707052d15a3dd97140") {
      continue;
    }

    const [soldId, tokensSold, boughtId] = abi.decode(
      ["uint256", "uint256", "uint256", "uint256"],
      log.data,
    );
    const i = BigInt(soldId);
    const j = BigInt(boughtId);
    const amountIn = BigInt(tokensSold);

    if (i === 1n && j === 0n) {
      impacts.push({
        pool: ADDR.CURVE_DOLA_WSTUSR,
        tokenIn: ADDR.WSTUSR,
        tokenOut: ADDR.DOLA,
        amountIn,
        direction: "wstUSR-to-DOLA",
      });
    } else if (i === 0n && j === 1n) {
      impacts.push({
        pool: ADDR.CURVE_DOLA_WSTUSR,
        tokenIn: ADDR.DOLA,
        tokenOut: ADDR.WSTUSR,
        amountIn,
        direction: "DOLA-to-wstUSR",
      });
    }
  }

  return impacts;
}
