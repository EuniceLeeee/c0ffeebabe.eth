import { ethers } from "ethers";
import { RuntimeAmountProgram, type RuntimeAmountLeg } from "../../adapters/runtime-amount-program.js";
import type { FamilyRouteDescriptor } from "./adapter-family-plugin.js";
import { hashCanonical, type CanonicalValue } from "./canonical-value.js";

export const RUNTIME_ERC20 = new ethers.Interface([
  "function approve(address,uint256) returns(bool)",
  "function transfer(address,uint256) returns(bool)",
  "function balanceOf(address) view returns(uint256)",
]);
export const RUNTIME_WRAP = new ethers.Interface(["function withdraw(uint256)", "function deposit() payable"]);

export function runtimeLeg(actionAdapterId: string, program: RuntimeAmountProgram): RuntimeAmountLeg {
  return { actionAdapterId, program: ethers.hexlify(program.bytes()) };
}
export function runtimeExecutor(executor: string, ...forbidden: string[]): string {
  const actor = ethers.getAddress(executor);
  if (actor === ethers.ZeroAddress || forbidden.some(x => ethers.getAddress(x) === actor)) {
    throw new Error("runtime invalid executor");
  }
  return actor;
}
/** Compare the complete Family-owned projection, not just the action label. */
export function assertProjectedRuntimeRoute(route: FamilyRouteDescriptor, expected: readonly FamilyRouteDescriptor[]): void {
  const hash = hashCanonical(route as unknown as CanonicalValue);
  if (!expected.some(r => hashCanonical(r as unknown as CanonicalValue) === hash)) {
    throw new Error("runtime route binding mismatch");
  }
}
/** Exact temporary approval. Families explicitly choose this approval policy. */
export function runtimeExactApproval(p: RuntimeAmountProgram, token: string, spender: string): void {
  runtimeClearApproval(p, token, spender);
  p.call(token, RUNTIME_ERC20.encodeFunctionData("approve", [spender, 0n]), { patches: [{ offset: 36, reg: 0 }] });
}
export function runtimeClearApproval(p: RuntimeAmountProgram, token: string, spender: string): void {
  p.call(token, RUNTIME_ERC20.encodeFunctionData("approve", [spender, 0n]));
}
/** Only wrap native currency received during the owning Family's operation. */
export function runtimeWrapReceipt(p: RuntimeAmountProgram, wrapped: string, before = 13, after = 14): void {
  p.nativeBalance(after).math("sub", after, after, before)
    .call(wrapped, RUNTIME_WRAP.encodeFunctionData("deposit"), { valueReg: after });
}

/** Protocol-neutral native/wrapped boundary for one operation. The owner
 * supplies its native ABI/value argument; the common emitter protects native
 * inventory and wraps only this operation's receipt. r0 remains the working
 * input, and the caller reserves before/scratch for the whole operation. */
export function runtimeNativeBoundary(p: RuntimeAmountProgram, wrapped: string, before = 13, scratch = 14) {
  if (![before, scratch].every(r => Number.isInteger(r) && r > 0 && r < 16) || before === scratch) {
    throw new Error("runtime native boundary registers");
  }
  const token = ethers.getAddress(wrapped);
  if (token === ethers.ZeroAddress) throw new Error("runtime native wrapper address");
  p.nativeBalance(before);
  return {
    unwrapInput(amountReg = 0): void {
      if (!Number.isInteger(amountReg) || amountReg < 0 || amountReg >= 16 || amountReg === before || amountReg === scratch) {
        throw new Error("runtime native amount register");
      }
      p.call(token, RUNTIME_WRAP.encodeFunctionData("withdraw", [0n]), { patches: [{ offset: 4, reg: amountReg }] });
    },
    wrapOutput(): void { runtimeWrapReceipt(p, token, before, scratch); },
    assertRestored(): void { p.nativeBalance(scratch).equal(scratch, before); },
  };
}
