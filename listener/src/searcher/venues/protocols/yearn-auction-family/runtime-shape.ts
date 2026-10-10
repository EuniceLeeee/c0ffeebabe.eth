import { ethers } from "ethers";
import { address } from "./codec.js";
// Verified 1.0.4 compiler runtime, not a deployment-address allowlist.
export const IMPLEMENTATION_HASH = "0x7c46c5abd2d4231ed6324eeb7f2e726e4250a1ab2d70ed166f59e3307dfccb56";
export function cloneImplementation(code: string): string {
  const m = /^0x363d3d373d3d3d363d73([0-9a-f]{40})5af43d82803e903d91602b57fd5bf3$/i.exec(code);
  if (!m) throw new Error("Yearn auction unsupported clone source"); return address("0x" + m[1]);
}
export function proveImplementation(code: string): string {
  if (ethers.keccak256(code) !== IMPLEMENTATION_HASH) throw new Error("Yearn auction unsupported implementation source");
  return IMPLEMENTATION_HASH;
}
