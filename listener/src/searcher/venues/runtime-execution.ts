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
