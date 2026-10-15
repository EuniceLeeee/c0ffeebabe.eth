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
    const request=i.settlement;if(request&&request.kind!=="direct-output")return null;
    const recipient=request?runtimeExecutor(request.recipient,d.target,d.asset,d.factory):i.executor;
    const p=new RuntimeAmountProgram();
    // The direct-output leaf has a different receiver. Validate its own exact
    // 1:1 conversion before the shared continuation can consume the receipt.
    if(request){
      p.constant(15,1n).math("sub",14,0,15)
        .call(r.tokenIn,ABI.encodeFunctionData("balanceOf",[i.executor]),{static:true}).load(1,0)
        .call(r.tokenOut,ABI.encodeFunctionData("balanceOf",[recipient]),{static:true}).load(2,0).nativeBalance(3);
      if(!sameAddress(recipient,i.executor))p
        .call(r.tokenOut,ABI.encodeFunctionData("balanceOf",[i.executor]),{static:true}).load(4,0)
        .call(r.tokenIn,ABI.encodeFunctionData("balanceOf",[recipient]),{static:true}).load(5,0);
    }
    if(r.direction==="wrap")runtimeExactApproval(p,d.asset,d.target);
    p.call(d.target,ABI.encodeFunctionData(request?`${r.direction}To`:r.direction,request?[0n,recipient]:[0n]),{patches:[{offset:4,reg:0}]});
    if(request)p.load(6,0).equal(6,0);
    if(r.direction==="wrap")clearWrapApproval(p,d.asset,d.target,i.executor);
    if(request){
      p.call(r.tokenIn,ABI.encodeFunctionData("balanceOf",[i.executor]),{static:true}).load(7,0).math("sub",7,1,7).equal(7,0)
        .call(r.tokenOut,ABI.encodeFunctionData("balanceOf",[recipient]),{static:true}).load(8,0).math("sub",8,8,2).equal(8,0)
        .nativeBalance(7).equal(7,3);
      if(!sameAddress(recipient,i.executor))p
        .call(r.tokenOut,ABI.encodeFunctionData("balanceOf",[i.executor]),{static:true}).load(7,0).equal(7,4)
        .call(r.tokenIn,ABI.encodeFunctionData("balanceOf",[recipient]),{static:true}).load(7,0).equal(7,5);
    }
    return {...runtimeLeg(r.adapterId,p),settlement:{directOutput:true as const},
      ...(request?{settlementRequest:request}:{})};
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
