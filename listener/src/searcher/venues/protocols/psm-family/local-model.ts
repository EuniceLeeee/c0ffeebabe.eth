import { ethers } from "ethers";

// Verified DssLitePsm.sol (solc 0.8.16) executable, from the cached source at
// 0xf6e72db5454dd049d0788e411b06cfaf16853042 (provenance, not admission).
// Independently checked against the constructor's immutable MSTORE patch table.
// All opcode and metadata bytes stay bound; only declared constructor words vary.
export const PSM_IMMUTABLES = {
  vat: [611, 2087, 2803, 3609, 4475, 5039, 5169, 5547, 6014],
  scale: [650, 3139, 4811, 6272, 6653, 7231],
  gem: [804, 3173, 4331, 4845, 6305, 6954, 7391],
  daiJoin: [983, 1985, 4059, 5791],
  ilk: [1022, 2134, 2850, 4522, 5594, 5957],
  pocket: [1069, 3095, 4767, 6352, 6899, 7344],
  dai: [1162, 3375, 6156, 6778, 7519],
} as const;
const HASH = "0x6b8c2bf9a814772f4e39afe094f5160819151cede740dbeaea610c0dfc66e511";

/** Model selection only. The existing reverse/behavioral identity is unchanged. */
export function verifyPsmTrialModel(code: string, binding: {
  readonly gem: string; readonly dai: string; readonly pocket: string; readonly decimalScale: bigint;
}): boolean {
  if (!/^0x(?:[0-9a-fA-F]{2})+$/.test(code)) return false;
  const bytes = ethers.getBytes(code);
  if (bytes.length !== 8414) return false;
  const values: Partial<Record<keyof typeof PSM_IMMUTABLES, bigint>> = {
    gem: BigInt(binding.gem), dai: BigInt(binding.dai), pocket: BigInt(binding.pocket), scale: binding.decimalScale,
  };
  for (const [name, offsets] of Object.entries(PSM_IMMUTABLES)) {
    const first = BigInt(ethers.hexlify(bytes.slice(offsets[0], offsets[0] + 32)));
    const expected = values[name as keyof typeof PSM_IMMUTABLES] ?? first;
    for (const offset of offsets) {
      if (bytes[offset - 1] !== 0x7f || BigInt(ethers.hexlify(bytes.slice(offset, offset + 32))) !== expected) return false;
      bytes.fill(0, offset, offset + 32);
    }
  }
  return ethers.keccak256(bytes) === HASH;
}
