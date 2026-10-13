import { RuntimeAmountProgram } from "../../../../adapters/runtime-amount-program.js";
import { runtimeLeg,runtimeExecutor,runtimeExactApproval } from "../../runtime-execution.js";
import { NO_EXECUTION_RUNTIME_PROJECTION,type ExecutionSemantics } from "../../adapter-family-plugin.js";
import { sameAddress } from "../standard-family/common.js";
import { clearWrapApproval } from "./approval.js";
import { ABI,amount } from "./codec.js";
import { assertInvocation } from "./binding.js";
import type { Descriptor,Route,Evidence } from "./types.js";
export const execution={
  buildRuntimeLeg(i){
    const d=i.descriptor,r=i.route;assertInvocation(d,r);runtimeExecutor(i.executor,d.target,d.asset,d.factory);
    const p=new RuntimeAmountProgram();if(r.direction==="wrap")runtimeExactApproval(p,d.asset,d.target);
    p.call(d.target,ABI.encodeFunctionData(r.direction,[0n]),{patches:[{offset:4,reg:0}]});
    if(r.direction==="wrap")clearWrapApproval(p,d.asset,d.target,i.executor);
    return runtimeLeg(r.adapterId,p);
  },
  runtimeProjection:()=>NO_EXECUTION_RUNTIME_PROJECTION,
  buildFragment(i){
    assertInvocation(i.descriptor,i.route);amount(i.amountIn);amount(i.quotedAmountOut);amount(i.minAmountOut,true);
    const e=i.exactEvidence;
    if(e.kind!=="few-execution-receipt"||e.direction!==i.route.direction||e.amountIn!==i.amountIn||e.amountOut!==i.quotedAmountOut||
      !sameAddress(e.executor,i.executor)||e.bindingFingerprint!==i.route.bindingRef.fingerprint)throw new Error("few exact evidence mismatch");
    return {requirements:[],nodes:[{adapterId:i.route.adapterId,target:i.descriptor.target,tokenIn:i.route.tokenIn,
      tokenOut:i.route.tokenOut,amount:i.amountIn,params:{minAmountOut:i.minAmountOut},children:[]}]};
  },
  expectedEffects:({route:r})=>[{kind:"token-delta",token:r.tokenIn,account:"executor",direction:"decrease"},
    {kind:"token-delta",token:r.tokenOut,account:"executor",direction:"increase"}],
} satisfies ExecutionSemantics<Descriptor,Route,Evidence>;
