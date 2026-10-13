import type { RuntimeAmountProgram } from "../../../../adapters/runtime-amount-program.js";
import { runtimeClearApproval } from "../../runtime-execution.js";
import { ABI } from "./codec.js";

/** A successful approve call can return false; verify the resulting allowance. */
export function clearWrapApproval(p:RuntimeAmountProgram,asset:string,wrapper:string,executor:string):void {
  runtimeClearApproval(p,asset,wrapper);
  p.call(asset,ABI.encodeFunctionData("allowance",[executor,wrapper]),{static:true}).load(14,0)
    .constant(15,0n).equal(14,15);
}
