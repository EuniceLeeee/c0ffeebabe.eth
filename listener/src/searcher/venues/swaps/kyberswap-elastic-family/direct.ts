import { ethers } from "ethers";
import { RuntimeAmountProgram } from "../../../../adapters/runtime-amount-program.js";
import type { KyberSwapRoute } from "./types.js";
const TOKEN=new ethers.Interface(["function balanceOf(address) view returns(uint256)"]);
/** A requested receiver bypasses the default hop consumer. Check the actual
 * exact-input swap and both signed return words before returning control. */
export function kyberDirectOpening(p:RuntimeAmountProgram,r:KyberSwapRoute,executor:string,recipient:string){
  p.constant(12,1n).math("sub",11,0,12)
    .call(r.tokenIn,TOKEN.encodeFunctionData("balanceOf",[executor]),{static:true}).load(4,0)
    .call(r.tokenOut,TOKEN.encodeFunctionData("balanceOf",[recipient]),{static:true}).load(5,0).nativeBalance(6);
  if(recipient.toLowerCase()!==executor.toLowerCase())p
    .call(r.tokenOut,TOKEN.encodeFunctionData("balanceOf",[executor]),{static:true}).load(7,0)
    .call(r.tokenIn,TOKEN.encodeFunctionData("balanceOf",[recipient]),{static:true}).load(8,0);
}
export function kyberDirectClosing(p:RuntimeAmountProgram,r:KyberSwapRoute,executor:string,recipient:string){
  p.load(9,r.isToken0?0:32).equal(9,0).load(10,r.isToken0?32:0)
    .call(r.tokenIn,TOKEN.encodeFunctionData("balanceOf",[executor]),{static:true}).load(11,0).math("sub",11,4,11).equal(11,0)
    .call(r.tokenOut,TOKEN.encodeFunctionData("balanceOf",[recipient]),{static:true}).load(11,0).math("sub",11,11,5)
    .constant(12,1n).math("sub",13,11,12).math("neg",12,11).equal(12,10)
    .nativeBalance(12).equal(12,6);
  if(recipient.toLowerCase()!==executor.toLowerCase())p
    .call(r.tokenOut,TOKEN.encodeFunctionData("balanceOf",[executor]),{static:true}).load(12,0).equal(12,7)
    .call(r.tokenIn,TOKEN.encodeFunctionData("balanceOf",[recipient]),{static:true}).load(12,0).equal(12,8);
}
