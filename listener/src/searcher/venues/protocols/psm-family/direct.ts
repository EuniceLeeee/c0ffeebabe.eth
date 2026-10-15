import { ethers } from "ethers";
import { RuntimeAmountProgram } from "../../../../adapters/runtime-amount-program.js";
import { runtimeClearApproval } from "../../runtime-execution.js";
import { PSM_INTERFACE, PSM_WAD } from "./codec.js";
import type { PsmDescriptor, PsmRoute } from "./types.js";
const TOKEN=new ethers.Interface(["function balanceOf(address) view returns(uint256)","function allowance(address,address) view returns(uint256)","function approve(address,uint256) returns(bool)"]);
/** DssLitePsm's buyGem argument is gem output. Keep the entire input budget in
 * r0; verify its integer cost and refund separately from the output receipt. */
export function psmDirectProgram(d:PsmDescriptor,r:PsmRoute,executor:string,recipient:string){
  const sell=r.direction==="sell-gem",p=new RuntimeAmountProgram();
  p.constant(11,1n).math("sub",8,0,11)
    .call(r.tokenIn,TOKEN.encodeFunctionData("balanceOf",[executor]),{static:true}).load(1,0)
    .call(r.tokenOut,TOKEN.encodeFunctionData("balanceOf",[recipient]),{static:true}).load(2,0).nativeBalance(3);
  if(recipient.toLowerCase()!==executor.toLowerCase())p
    .call(r.tokenOut,TOKEN.encodeFunctionData("balanceOf",[executor]),{static:true}).load(12,0)
    .call(r.tokenIn,TOKEN.encodeFunctionData("balanceOf",[recipient]),{static:true}).load(13,0);
  p.call(d.target,PSM_INTERFACE.encodeFunctionData(sell?"tin":"tout"),{static:true}).load(5,0)
    .constant(9,PSM_WAD).constant(10,d.decimalScale).math("sub",8,9,5);
  if(sell)p.constant(8,0n).math("add",6,0,8).math("mul",7,0,10)
    .math("mul",8,7,5).math("div",8,8,9).math("sub",7,7,8);
  else p.math("add",4,0,11).math("mul",4,4,9).math("sub",4,4,11)
    .math("add",8,9,5).math("div",4,4,8).math("div",4,4,10)
    .math("mul",6,4,10).math("mul",8,6,5).math("div",8,8,9).math("add",6,6,8)
    .constant(8,0n).math("add",7,4,8);
  p.math("sub",8,6,11).math("sub",8,7,11).math("sub",8,0,6);
  runtimeClearApproval(p,r.tokenIn,d.target);
  p.call(r.tokenIn,TOKEN.encodeFunctionData("approve",[d.target,0n]),{patches:[{offset:36,reg:6}]});
  p.call(d.target,PSM_INTERFACE.encodeFunctionData(sell?"sellGem":"buyGem",[recipient,0n]),{patches:[{offset:36,reg:sell?0:4}]})
    .load(8,0).equal(8,sell?7:6);
  runtimeClearApproval(p,r.tokenIn,d.target);
  p.call(r.tokenIn,TOKEN.encodeFunctionData("allowance",[executor,d.target]),{static:true}).load(14,0).constant(15,0n).equal(14,15)
    .call(r.tokenIn,TOKEN.encodeFunctionData("balanceOf",[executor]),{static:true}).load(8,0).math("sub",8,1,8).equal(8,6)
    .call(r.tokenOut,TOKEN.encodeFunctionData("balanceOf",[recipient]),{static:true}).load(8,0).math("sub",8,8,2).equal(8,7)
    .nativeBalance(8).equal(8,3);
  if(recipient.toLowerCase()!==executor.toLowerCase())p
    .call(r.tokenOut,TOKEN.encodeFunctionData("balanceOf",[executor]),{static:true}).load(8,0).equal(8,12)
    .call(r.tokenIn,TOKEN.encodeFunctionData("balanceOf",[recipient]),{static:true}).load(8,0).equal(8,13);
  return p;
}
