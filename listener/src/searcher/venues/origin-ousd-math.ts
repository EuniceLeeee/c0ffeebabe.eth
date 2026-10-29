import { MaxUint256 } from "ethers";
import type { DeclarativeMathModel, MathValue } from "./declarative-math.js";

const MAX_UINT256 = MaxUint256;
/** USDC (6 decimals) -> OUSD (18 decimals) scale of the verified vault mint. */
const ORIGIN_OUSD_DECIMAL_SCALE = 10n ** 12n;

function uint(value: MathValue, label: string): bigint {
  if (typeof value !== "bigint" || value < 0n || value > MAX_UINT256) {
    throw new Error(`${label} must be a uint256`);
  }
  return value;
}

function mintQuote(value: MathValue): bigint {
  const amountIn = uint(value, "Origin OUSD mint amountIn");
  if (amountIn > MAX_UINT256 / ORIGIN_OUSD_DECIMAL_SCALE) {
    throw new Error("Origin OUSD mint scaling overflow");
  }
  return amountIn * ORIGIN_OUSD_DECIMAL_SCALE;
}

/**
 * Source-faithful Origin OUSD vault mint ratio: the verified implementation
 * mints `amountIn * 1e12` OUSD for `amountIn` USDC with no fee and no preview
 * function, and its checked Solidity arithmetic rejects a product above
 * uint256. The model performs no transport, ABI, state or settlement work.
 */
export const originOusdMintQuoteMathModel: DeclarativeMathModel = Object.freeze({
  id: "origin-ousd:mint-quote",
  version: 1,
  validateInput(value: MathValue): void {
    const amountIn = uint(value, "Origin OUSD mint amountIn");
    if (amountIn > MAX_UINT256 / ORIGIN_OUSD_DECIMAL_SCALE) {
      throw new Error("Origin OUSD mint scaling overflow");
    }
  },
  evaluate(value: MathValue): MathValue {
    return mintQuote(value);
  },
  validateOutput(value: MathValue): void {
    uint(value, "Origin OUSD mint quote output");
  },
});
