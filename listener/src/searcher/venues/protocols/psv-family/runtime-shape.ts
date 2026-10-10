import { ethers } from "ethers";
import { address } from "./codec.js";
// Whole compiled source templates, not deployment address allowlists. Compiler
// inputs and immutable-reference proof are retained with the historical report.
export const PROXY_HASH = "0x46a010df31eb642b47284650e80051e8f6239a0c995003d230b437810bc4b9b4";
export const IMPLEMENTATION_TEMPLATE_HASH = "0x3143b58f2386be0d6550b83bfc461b0423e4640c64767a57ed5ee85f1112c6eb";
export function proveProxy(code: string): string {
  if (ethers.keccak256(code) !== PROXY_HASH) throw new Error("PSV unsupported proxy source"); return PROXY_HASH;
}
export function proveImplementation(code: string, implementation: string): string {
  let normalized = code.toLowerCase(); const word = "0".repeat(24) + address(implementation).slice(2);
  // UUPS __self: both references must bind this very implementation.
  for (const offset of [4253, 4473]) {
    const start = 2 + offset * 2;
    if (normalized.slice(start, start + 64) !== word) throw new Error("PSV UUPS self mismatch");
    normalized = normalized.slice(0, start) + "0".repeat(64) + normalized.slice(start + 64);
  }
  if (ethers.keccak256(normalized) !== IMPLEMENTATION_TEMPLATE_HASH) throw new Error("PSV unsupported implementation source");
  return ethers.keccak256(code);
}
