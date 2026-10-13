import { RuntimeAmountProgram, runtimeProgramScript } from "../../../../adapters/runtime-amount-program.js";
import { bindFamilyOwnedAction } from "../../family-owned-action.js";
import { runtimeExecutor, runtimeExactApproval } from "../../runtime-execution.js";
import { ABI,address,amount } from "./codec.js";
import { clearWrapApproval } from "./approval.js";
import type { Direction } from "./types.js";
function createAction(direction:Direction){
  const id=`few-${direction}`;
  return bindFamilyOwnedAction({action:{id,isWrapper:false,field2Offset:null,
    encode(n,executor,inner){
      runtimeExecutor(executor,n.target,n.tokenIn,n.tokenOut);address(n.target);address(n.tokenIn);address(n.tokenOut);amount(n.amount);
      const minimum=amount(n.params.minAmountOut as bigint,true);
      if(n.adapterId!==id||n.children.length||inner.length||Object.keys(n.params).length!==1||n.tokenIn.toLowerCase()===n.tokenOut.toLowerCase()||
        (direction==="wrap"?n.tokenOut:n.tokenIn).toLowerCase()!==n.target.toLowerCase())throw new Error("few invalid action");
      // Check this operation's deltas; existing output cannot satisfy the minimum.
      const p=new RuntimeAmountProgram()
        .call(n.tokenIn,ABI.encodeFunctionData("balanceOf",[executor]),{static:true}).load(1,0)
        .call(n.tokenOut,ABI.encodeFunctionData("balanceOf",[executor]),{static:true}).load(2,0);
      if(direction==="wrap")runtimeExactApproval(p,n.tokenIn,n.target);
      p.call(n.target,ABI.encodeFunctionData(direction,[0n]),{patches:[{offset:4,reg:0}]});
      if(direction==="wrap")clearWrapApproval(p,n.tokenIn,n.target,executor);
      p.call(n.tokenIn,ABI.encodeFunctionData("balanceOf",[executor]),{static:true}).load(3,0)
        .math("sub",5,1,3).equal(5,0)
        .call(n.tokenOut,ABI.encodeFunctionData("balanceOf",[executor]),{static:true}).load(4,0)
        .math("sub",5,4,2).constant(6,minimum).math("sub",5,5,6);
      return runtimeProgramScript(p.bytes(),n.amount);
    },
    matchTrace:(_target,selector)=>[direction,`${direction}To`].some(fn=>ABI.getFunction(fn)!.selector===selector),
  },descriptor:{adapterId:id,lineage:"custom-protocol:few-wrapped",edgeKind:"protocol",action:direction,canSendValue:false,leavesStandingPositionDefault:false}});
}
export const wrapAction=createAction("wrap");
export const unwrapAction=createAction("unwrap");
