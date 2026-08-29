/** Pure ABI codec for the release-owned RockSolid quote boundary. */
export function decodeRocksolidUint256(dataHex: string): bigint {
  if (!/^0x[0-9a-fA-F]{64}$/.test(dataHex)) throw new TypeError("RockSolid return must be one ABI uint256 word");
  return BigInt(dataHex);
}

export function assertRocksolidQuote(amountIn: bigint, amountOut: bigint): bigint {
  if (amountIn <= 0n || amountOut <= 0n) throw new RangeError("RockSolid quote amounts must be positive");
  return amountOut;
}
