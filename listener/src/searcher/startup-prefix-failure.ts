import type { EffectiveAmountReference } from "./blockscan-effective-mid.js";
import type { CanonicalSource } from "./venues/adapter-request-program.js";
import type { TokenEdge } from "./planner/token-graph.js";
import { blockScanEdgeKey } from "./venues/blockscan-state-capability.js";
import { RevmStrictError } from "./revm-sim-client.js";

interface Request {
  source: CanonicalSource; edge: TokenEdge; amountIn: bigint; reference: EffectiveAmountReference;
  maxInputPathHops: number;
}
// A prefix failure permits choosing another already-funded path for the SAME
// target, not filtering that target. No receipt / log from disk grants a retry.
const attempts=new WeakMap<object,{n:number;hash:string;generation:number;edge:TokenEdge;
  ref:EffectiveAmountReference;amount:bigint;hops:number;failed:string}>();
export function startupPriceRevert(work:Request,obs:Readonly<Record<string,unknown>>) {
  const error=Object.assign(new RevmStrictError("observation","startup execution price reverted"),{code:"STARTUP_EXECUTION_REVERT"});
  const {source,reference,amountIn,edge}=work,hop=obs.failedHop;
  if(obs.status==="revert" && obs.failureStage==="prefix" && obs.targetAttempted===false &&
    obs.sourceBlock===source.number && obs.sourceBlockHash===source.hash && obs.generation===source.generation &&
    obs.targetBlock===source.number+1 && obs.edgeId===blockScanEdgeKey(edge) &&
    obs.expectedAmountIn===String(amountIn) && reference.amountIn===amountIn && typeof hop==="number" && Number.isInteger(hop) &&
    hop>=0 && hop<reference.path.length && reference.path[hop]!.edgeId===obs.failedEdgeId &&
    Array.isArray(obs.prefixEdges) && obs.prefixEdges.length===reference.path.length &&
    reference.path.every((s,i)=>s.edgeId===(obs.prefixEdges as readonly unknown[])[i])){
    attempts.set(error,{n:source.number,hash:source.hash,generation:source.generation,edge,ref:reference,
      amount:amountIn,hops:work.maxInputPathHops,failed:reference.path[hop]!.edgeId});
  }
  return error;
}
export function startupFailedFundingEdge(error:unknown,work:Request):string|undefined {
  const hit=typeof error==="object" && error!==null ? attempts.get(error):undefined;
  return hit && hit.n===work.source.number && hit.hash===work.source.hash && hit.generation===work.source.generation &&
    hit.edge===work.edge && hit.ref===work.reference && hit.amount===work.amountIn && hit.hops===work.maxInputPathHops ? hit.failed:undefined;
}
