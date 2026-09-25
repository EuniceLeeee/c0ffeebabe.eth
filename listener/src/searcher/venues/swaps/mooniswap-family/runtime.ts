import { ethers } from "ethers";
import { lower } from "./codec.js";

// Verified Mooniswap runtime from the cached 0x2c4ea5... pool. This address is
// provenance, not an admission allowlist. Only token0/token1 constructor words
// are normalized; all opcodes and metadata must match the verified template.
// The creation CODECOPY/MSTORE table independently establishes these offsets.
export const IMMUTABLES = Object.freeze({
  token0: Object.freeze([4225, 5120, 5751, 6518, 6647, 7479, 9248, 12611]),
  token1: Object.freeze([5157, 5799, 6573, 6782, 7516, 9326, 9903, 12672]),
});
export const RUNTIME_LENGTH = 21340;
export const NORMALIZED_RUNTIME_HASH = "0x0f88c1b9bd3506a4f0659e1c75cba5d797d0e04d462f79da7eebd58cc51a6f90";
export function verifyPoolRuntime(code: string, token0: string, token1: string): boolean {
  const a = BigInt(lower(token0)), b = BigInt(lower(token1));
  if (a === 0n || a >= b) return false; // ERC20-only, sorted runtime variant.
  const bytes = ethers.getBytes(code);
  if (bytes.length !== RUNTIME_LENGTH) return false;
  for (const [key, value] of [["token0", a], ["token1", b]] as const) {
    for (const offset of IMMUTABLES[key]) {
      if (bytes[offset - 1] !== 0x7f || BigInt(ethers.hexlify(bytes.slice(offset, offset + 32))) !== value) return false;
      bytes.fill(0, offset, offset + 32);
    }
  }
  return ethers.keccak256(bytes) === NORMALIZED_RUNTIME_HASH;
}
