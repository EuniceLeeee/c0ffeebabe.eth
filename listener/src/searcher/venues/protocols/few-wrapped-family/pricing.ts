import { bindRequestResultRound,collectRequestProgramResults,type PricingSemantics } from "../../adapter-family-plugin.js";
import { compileAddressMutations } from "../../mutation-index.js";
import { assertSameSource,returnedResult,protocolMid,sameAddress } from "../standard-family/common.js";
import { currentRequests,assertCurrentBinding,probeAmount } from "./codec.js";
import { conversionRequest,decodeReceipt,simulationRequirements } from "./simulation.js";
import { assertInvocation,projection } from "./binding.js";
import type { Descriptor,Route,PricingDescriptor,Snapshot } from "./types.js";
export const pricing = {
  // The underlying token may impose dynamic transfer permissions. Keep the
  // actual conversion proof fresh until a narrower dependency model is proven.
  refreshPolicy:"each-block",stateKey:(r:Route)=>r.instanceKey,
  staticBindingProjection:({descriptor:d})=>projection(d),
  snapshotCompatibilityProjection:({descriptor:d})=>projection(d),
  compileDraft({descriptor:d,stateKey,routes}) {
    if(stateKey!==d.instanceKey||routes.length!==2||new Set(routes.map(r=>r.direction)).size!==2)throw new Error("few pricing route set mismatch");
    routes.forEach(r=>assertInvocation(d,r));return {...d,routes:[...routes]};
  },
  finalizePricingDescriptor:({draft})=>draft,
  current:{
    requirements:()=>({transports:["get-code","eth-call"]}),
    buildRequests:({descriptor:d})=>currentRequests(d),
    buildDependentProgram({current:{descriptor:d},completedRound,initialResults}) {
      assertCurrentBinding(d,initialResults);const sample=probeAmount(initialResults);
      if(sample===0n)throw new Error("few no backed pricing capacity");
      return completedRound===0?bindRequestResultRound(simulationRequirements,
        d.routes.map(r=>conversionRequest(`few-current-${r.direction}`,d,r.direction,sample))):null;
    },
    decodeSnapshot({descriptor:d,initialResults,dependentEvidence}) {
      const results=collectRequestProgramResults(initialResults,dependentEvidence);
      const source=assertSameSource(results.map(r=>returnedResult(results,r.id)));
      assertCurrentBinding(d,initialResults);const value=probeAmount(initialResults);
      return {source,quotes:Object.fromEntries(d.routes.map(r=>[r.routeKey,{amountIn:value,amountOut:decodeReceipt(results,`few-current-${r.direction}`,d,r.direction,value).amountOut}]))};
    },
    deriveMids:({descriptor:d,snapshot,routes})=>new Map(routes.map(r=>[r.routeKey,protocolMid({route:r,adapterId:r.adapterId,target:d.target,quote:snapshot.quotes[r.routeKey]})])),
  },
  dependencies:({descriptor:d})=>[d.target,d.asset,d.factory].map(a=>a.toLowerCase()),
  mutation:{
    compile:({entries})=>compileAddressMutations(entries,({descriptor:d})=>({addresses:[d.target,d.asset,d.factory],keys:[d.instanceKey]}),{kinds:["log","call"]}),
    affectedStateKeys:({descriptor:d,observation:o})=>(o.kind==="log"?[d.target,d.asset,d.factory].some(a=>sameAddress(a,o.address)):
      o.kind==="call"&&[d.target,d.asset,d.factory].some(a=>sameAddress(a,o.target)))?[d.instanceKey]:[],
  },
} satisfies PricingSemantics<Descriptor,Route,PricingDescriptor,Snapshot>;
