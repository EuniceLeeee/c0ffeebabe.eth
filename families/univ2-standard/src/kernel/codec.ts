const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const WORD_RE = /^0x[0-9a-fA-F]{64}$/;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export function canonicalAddress(value: string): string {
  if (!ADDRESS_RE.test(value)) throw new TypeError("address must be exactly 20 bytes");
  return `0x${value.slice(2).toLowerCase()}`;
}

export function lowerAddress(value: string): string {
  return canonicalAddress(value);
}

export function sameAddress(left: string, right: string): boolean {
  return canonicalAddress(left) === canonicalAddress(right);
}

export function decodeAddressWord(value: string): string {
  if (!WORD_RE.test(value)) throw new TypeError("address result must be exactly one ABI word");
  if (!/^0{24}$/i.test(value.slice(2, 26))) throw new TypeError("address result has non-zero padding");
  return canonicalAddress(`0x${value.slice(26)}`);
}

export interface UniV2Reserves {
  readonly reserve0: bigint;
  readonly reserve1: bigint;
  readonly blockTimestampLast: number;
}

export function decodeReserves(value: string): UniV2Reserves {
  if (!/^0x(?:[0-9a-fA-F]{64}){3}$/.test(value)) throw new TypeError("reserves result must be exactly three ABI words");
  const reserve0 = BigInt(`0x${value.slice(2, 66)}`);
  const reserve1 = BigInt(`0x${value.slice(66, 130)}`);
  const timestamp = BigInt(`0x${value.slice(130, 194)}`);
  if (reserve0 >= 1n << 112n || reserve1 >= 1n << 112n) throw new TypeError("reserve exceeds uint112");
  if (timestamp >= 1n << 32n) throw new TypeError("timestamp exceeds uint32");
  return Object.freeze({ reserve0, reserve1, blockTimestampLast: Number(timestamp) });
}

export function isZeroAddress(value: string): boolean {
  return canonicalAddress(value) === ZERO_ADDRESS;
}
