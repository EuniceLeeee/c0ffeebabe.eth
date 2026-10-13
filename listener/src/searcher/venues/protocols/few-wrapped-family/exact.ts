import { localZeroExactMethod,type ExactQuoteInput,type ExactQuoteSemantics,type ExactRequestProgram } from "../../adapter-family-plugin.js";
import { assertSource,assertSameSource,returnedResult } from "../standard-family/common.js";
import { runtimeExecutor } from "../../runtime-execution.js";
import { amount,guardRequests,assertCurrentBinding } from "./codec.js";
import { conversionRequest,decodeReceipt,simulationRequirements } from "./simulation.js";
import { assertInvocation } from "./binding.js";
import type { Descriptor,Route,Evidence } from "./types.js";
type Input=ExactQuoteInput<Descriptor,Route>;
function check(i:Input){assertInvocation(i.descriptor,i.route);amount(i.amountIn,true);runtimeExecutor(i.executor,i.descriptor.target,i.descriptor.asset,i.descriptor.factory);}
function evidence(i:Input,out:bigint):Evidence{return {kind:"few-execution-receipt",source:i.source,executor:i.executor,
  direction:i.route.direction,amountIn:i.amountIn,amountOut:out,bindingFingerprint:i.route.bindingRef.fingerprint};}
export const exactProgram:ExactRequestProgram<Descriptor,Route,Evidence>={
  requirements:i=>{check(i);return i.amountIn===0n?{transports:[]}:{...simulationRequirements,transports:["get-code","eth-call","effect-delta-simulation"]};},
  buildRequests(i){check(i);return i.amountIn===0n?[]:[...guardRequests(i.descriptor),conversionRequest("few-exact",i.descriptor,i.route.direction,i.amountIn)];},
  decode({programInput:i,initialResults:results}){
    check(i);if(i.amountIn===0n){if(results.length)throw new Error("few zero quote has reads");return {amountOut:0n,evidence:evidence(i,0n)};}
    assertSource(assertSameSource(results.map(r=>returnedResult(results,r.id))),i.source);
    assertCurrentBinding(i.descriptor,results);
    const out=decodeReceipt(results,"few-exact",i.descriptor,i.route.direction,i.amountIn,i.executor).amountOut;
    return {amountOut:out,evidence:evidence(i,out)};
  },
};
export const exact={
  methods:()=>[
    localZeroExactMethod<Descriptor,Route,Evidence>("zero",i=>{check(i);return {amountOut:0n,evidence:evidence(i,0n)};}),
    {id:"few-conversion-receipt",kind:"request-program",chainAmountQuote:true,program:exactProgram},
  ],
  cacheCompatibilityProjection:i=>({bindingFingerprint:i.route.bindingRef.fingerprint,executor:i.executor.toLowerCase()}),
} satisfies ExactQuoteSemantics<Descriptor,Route,Evidence>;
