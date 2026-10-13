import type { AdapterRequest, AdapterRequestResult, RequestRequirements } from "../../adapter-request-program.js";
import { returnedResult, sameAddress } from "../standard-family/common.js";
import { ABI,address,amount } from "./codec.js";
import type { Binding,Direction } from "./types.js";
export const simulationRequirements: RequestRequirements = {
  transports:["effect-delta-simulation"],caller:"executor",
  effects:["return-data","revert-data","token-delta","total-supply-delta","native-delta","logs"],
};
export function conversionRequest(id:string,b:Pick<Binding,"target"|"asset">,direction:Direction,value:bigint):AdapterRequest {
  amount(value);address(b.target);address(b.asset);
  if(sameAddress(b.target,b.asset)||!["wrap","unwrap"].includes(direction)) throw new Error("few invalid conversion");
  const caller={kind:"executor" as const};
  return {id,kind:"effect-delta-simulation",
    preCalls:direction==="wrap"?[0n,value].map(v=>({caller,to:b.asset,data:ABI.encodeFunctionData("approve",[b.target,v])})):[],
    call:{caller,executionMode:"impersonated-call-frame",to:b.target,data:ABI.encodeFunctionData(direction,[value])},
    overrideIntent:{caller,tokenBalances:[{token:direction==="wrap"?b.asset:b.target,amount:value}]},
    observeTokenBalances:[{token:b.asset,account:caller},{token:b.target,account:caller},{token:b.asset,account:b.target}],
    observe:["return-data","revert-data","token-delta","total-supply-delta","native-delta","logs"]};
}
export function decodeReceipt(results:readonly AdapterRequestResult[],id:string,b:Pick<Binding,"target"|"asset">,
  direction:Direction,value:bigint,executor?:string) {
  amount(value);const result=returnedResult(results,id),deltas=result.effects?.tokenDeltas??[];
  const shares=deltas.filter(r=>sameAddress(r.token,b.target));
  if(shares.length!==1||deltas.length!==3)throw new Error("few missing or duplicate token balances");
  const actor=address(shares[0].account);
  if([b.target,b.asset].some(x=>sameAddress(x,actor))||(executor!==undefined&&!sameAddress(actor,executor)))throw new Error("few receipt actor mismatch");
  const delta=(token:string,account:string)=>{
    const rows=deltas.filter(r=>sameAddress(r.token,token)&&sameAddress(r.account,account));
    if(rows.length!==1)throw new Error("few token observation mismatch");return rows[0].delta;
  };
  const sign=direction==="wrap"?1n:-1n,supplies=result.effects?.totalSupplyDeltas??[],native=result.effects?.nativeDeltas??[];
  const supply=supplies.filter(r=>sameAddress(r.token,b.target));
  if(BigInt(ABI.decodeFunctionResult(direction,result.data)[0])!==value || delta(b.target,actor)!==sign*value ||
    delta(b.asset,actor)!==-sign*value || delta(b.asset,b.target)!==sign*value ||
    supply.length!==1||supply[0].delta!==sign*value ||
    supplies.some(r=>!sameAddress(r.token,b.target)&&r.delta!==0n) ||
    native.length!==1||!sameAddress(native[0].account,actor)||native[0].delta!==0n)
    throw new Error("few incomplete debit, receipt, supply or backing");
  const name=direction==="wrap"?"Wrap":"Unwrap";
  const logs=(result.effects?.logs??[]).filter(l=>sameAddress(l.address,b.target)).flatMap(l=>{
    try{const e=ABI.parseLog({topics:[...l.topics],data:l.data});return e?.name===name?[e]:[];}catch{return [];}
  });
  if(logs.length!==1||!sameAddress(logs[0].args.sender,actor)||!sameAddress(logs[0].args.to,actor)||BigInt(logs[0].args.amount)!==value)
    throw new Error("few conversion event mismatch");
  return {source:result.source,actor,amountOut:delta(direction==="wrap"?b.target:b.asset,actor)};
}
