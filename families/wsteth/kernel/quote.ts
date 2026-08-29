/** Pure ABI codec for the release-owned wstETH conversion quote boundary. */
export function decodeWstethUint256(dataHex: string): bigint {
  if (!/^0x[0-9a-fA-F]{64}$/.test(dataHex)) throw new TypeError("wstETH return must be one ABI uint256 word");
  return BigInt(dataHex);
}

export function assertWstethQuote(amountIn: bigint, amountOut: bigint): bigint {
  if (amountIn <= 0n || amountOut <= 0n) throw new RangeError("wstETH quote amounts must be positive");
  return amountOut;
}
