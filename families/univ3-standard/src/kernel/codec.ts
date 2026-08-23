const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const WORD_RE = /^0x[0-9a-fA-F]{64}$/;

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

function decodeWord(value: string): bigint {
  if (!WORD_RE.test(value)) throw new TypeError("result must be exactly one ABI word");
  return BigInt(value);
}

export function decodeAddressWord(value: string): string {
  decodeWord(value);
  if (!/^0{24}$/i.test(value.slice(2, 26))) throw new TypeError("address result has non-zero padding");
  return canonicalAddress(`0x${value.slice(26)}`);
}

export function decodeUint24Word(value: string): bigint {
  const decoded = decodeWord(value);
  if (decoded > 0xff_ffffn) throw new TypeError("value exceeds uint24");
  return decoded;
}

export function decodePositiveInt24Word(value: string): number {
  const decoded = decodeWord(value);
  const signed = (decoded & (1n << 255n)) === 0n ? decoded : decoded - (1n << 256n);
  if (signed <= 0n || signed > 0x7f_ffffn) throw new TypeError("tick spacing is not a positive int24");
  return Number(signed);
}
