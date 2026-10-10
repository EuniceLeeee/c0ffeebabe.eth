import { ethers } from "ethers";
// solc 0.7.6+7338295f, optimizer 200, metadata bytecodeHash=none.
// Independently compiled Etherscan WeightedIndex source, input SHA256
// a40f3b9fa85b683e914797fad4037aaf909a62828b5ec4eea1b2f3c5a47015f9.
// Only compiler-reported immutable words are variable, never instruction bytes.
export const NORMALIZED_CODE_HASH = "0xd6c722955476be393dbf38f51df65318135545023e97da5f532fdf48cb53a768";
export const IMMUTABLES = {
  BOND_FEE: [5745, 8534], DEBOND_FEE: [7321, 7937],
  V2_ROUTER: [2245, 2284, 4047, 4192, 4239, 11982, 12170],
  V2_POOL: [1781, 2002, 2158, 2211, 2517, 2692, 2835, 9295, 9373],
  DAI: [2332, 3867, 4105, 4158, 4279, 4528, 4703, 4846, 6606, 6759, 11900, 12307, 12949, 13709],
  WETH: [9750, 9894, 10614, 12982], V3_TWAP_UTILS: [1437, 7501], V2_FACTORY: [9847, 12902],
} as const;
export function proveRuntime(code: string) {
  if (!/^0x[0-9a-f]+$/i.test(code) || code.length !== 2 + 16972 * 2) throw new Error("peapods unsupported runtime size");
  let normalized = code.slice(2).toLowerCase();
  const values = {} as Record<keyof typeof IMMUTABLES, bigint>;
  for (const [name, offsets] of Object.entries(IMMUTABLES) as [keyof typeof IMMUTABLES, readonly number[]][]) {
    const words = offsets.map(offset => normalized.slice(offset * 2, (offset + 32) * 2));
    if (new Set(words).size !== 1) throw new Error("peapods inconsistent immutable " + name);
    const value = BigInt("0x" + words[0]);
    if (!name.endsWith("FEE") && (value === 0n || value >= 1n << 160n)) throw new Error("peapods invalid immutable address");
    values[name] = value;
    for (const offset of offsets) normalized = normalized.slice(0, offset * 2) + "0".repeat(64) + normalized.slice((offset + 32) * 2);
  }
  if (ethers.keccak256("0x" + normalized) !== NORMALIZED_CODE_HASH) throw new Error("peapods unsupported source runtime");
  if (values.DEBOND_FEE > 10000n) throw new Error("peapods unsupported underflow fee");
  return { codeHash: ethers.keccak256(code), feeBps: values.DEBOND_FEE };
}
