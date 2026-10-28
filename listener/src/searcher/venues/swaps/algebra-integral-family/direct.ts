import { ethers } from "ethers";
import { RuntimeAmountProgram } from "../../../../adapters/runtime-amount-program.js";
import type { AlgebraIntegralRoute } from "./types.js";
const TOKEN=new ethers.Interface(["function balanceOf(address) view returns(uint256)"]);
/** The existing emitter checks both full input return and debit. Explicit
 * direct delivery additionally binds the signed output to NEW receipt. */
export function algebraDirectOpening(p:RuntimeAmountProgram,r:AlgebraIntegralRoute,executor:string,recipient:string){
 p.constant(12,1n).math("sub",11,0,12)
  .call(r.tokenOut,TOKEN.encodeFunctionData("balanceOf",[recipient]),{static:true}).load(5,0).nativeBalance(6);
 if(recipient.toLowerCase()!==executor.toLowerCase())p
  .call(r.tokenOut,TOKEN.encodeFunctionData("balanceOf",[executor]),{static:true}).load(7,0)
  .call(r.tokenIn,TOKEN.encodeFunctionData("balanceOf",[recipient]),{static:true}).load(8,0);
}
export function algebraDirectClosing(p:RuntimeAmountProgram,r:AlgebraIntegralRoute,executor:string,recipient:string){
 // Read the signed return BEFORE any token getter replaces return data.
 p.load(10,r.direction==="zero-for-one"?32:0)
  .call(r.tokenOut,TOKEN.encodeFunctionData("balanceOf",[recipient]),{static:true}).load(11,0).math("sub",11,11,5)
  .constant(12,1n).math("sub",13,11,12).math("neg",12,11).equal(12,10)
  .nativeBalance(12).equal(12,6);
 if(recipient.toLowerCase()!==executor.toLowerCase())p
  .call(r.tokenOut,TOKEN.encodeFunctionData("balanceOf",[executor]),{static:true}).load(12,0).equal(12,7)
  .call(r.tokenIn,TOKEN.encodeFunctionData("balanceOf",[recipient]),{static:true}).load(12,0).equal(12,8);
}
