export function positiveAmount(value: string, path: string, allowZero = false): bigint {
  if (!/^\d+$/.test(value)) throw new TypeError(`${path} must be a decimal integer`);
  const amount = BigInt(value);
  if (!allowZero && amount <= 0n) throw new TypeError(`${path} must be positive`);
  return amount;
}
export function encodeAddressWord(value: string): string { if (!/^0x[0-9a-fA-F]{40}$/.test(value)) throw new TypeError("address word invalid"); return value.slice(2).toLowerCase().padStart(64, "0"); }
export function encodeUintWord(value: string): string { const hex = positiveAmount(value, "uint").toString(16); if (hex.length > 64) throw new TypeError("uint word overflow"); return hex.padStart(64, "0"); }
export function encodeBytes(value: string): string { if (!/^0x(?:[0-9a-fA-F]{2})*$/.test(value)) throw new TypeError("bytes invalid"); const bytes = value.slice(2).toLowerCase(); return `${encodeUintWord("32")}${encodeUintWord(String(bytes.length / 2))}${bytes.padEnd(Math.ceil(bytes.length / 64) * 64, "0")}`; }
export function encodeMorphoFlashLoan(token: string, assets: string, data: string, selector: string): string { const body = `${encodeAddressWord(token)}${encodeUintWord(assets)}${encodeUintWord("96")}${encodeBytes(data)}`; return `${selector}${body}`; }
