import assert from "node:assert/strict";
import { sqlSelectorModules,type SqlTrialMarket } from "./sql-edge-live-producer.js";
import { isEnabledSqlExecutionLeg } from "./sql-execution-selectors.js";
import { sqlDirectionId,type SqlPriceEdge } from "./sql-edge-price-index.js";
import type { TokenEdge } from "./planner/token-graph.js";
import { effectiveAmountReferences,effectiveOwnsLocalExecutionReceipt,effectiveRowAmountReference,effectiveRowExecutionVerified,type EffectiveMidSnapshot } from "./blockscan-effective-mid.js";

export interface SqlSelectorRepresentative {
  readonly selector:string;readonly edgeId:string;readonly poolAddress:string;readonly poolId:string|null;
  readonly tokenIn:string;readonly tokenOut:string;readonly variantIds:readonly string[];
}
/** Selection is independent of compilation, pricing, input order and RPC.
 * No substitute is permitted for an unencodable or reverting sample. */
export function sqlSelectorRepresentatives(edges:readonly SqlPriceEdge[]):readonly SqlPriceEdge[] {
  const bySelector=new Map<string,SqlPriceEdge>();
  for(const row of edges){
    const m=sqlSelectorModules.get(row.selector);if(!m||!isEnabledSqlExecutionLeg(m))continue;
    const prev=bySelector.get(row.selector),uniform=row.executionParamEvidence?.consensus==="uniform",
      prevUniform=prev?.executionParamEvidence?.consensus==="uniform";
    if(!prev||(uniform&&!prevUniform)||(uniform===prevUniform&&row.candidateInstanceKey<prev.candidateInstanceKey))bySelector.set(row.selector,row);
  }
  assert(bySelector.size,"no enabled SQL selectors to check");
  return Object.freeze([...bySelector].sort(([a],[b])=>a<b?-1:1).map(([,e])=>e));
}

/** Reuse the normal SQL encoder's private variant set and directed graph asset
 * projection (native boundaries included). The public pool identity is SQL's,
 * not an independent Family lookup. Planning is not a simulation result. */
export function planSqlSelectorSamplePrices(representatives:readonly SqlPriceEdge[],markets:ReadonlyMap<string,SqlTrialMarket>):readonly SqlSelectorRepresentative[]{
  return Object.freeze(representatives.map(row=>{
    const edgeId=row.candidateInstanceKey,m=markets.get(edgeId);
    assert.equal(sqlDirectionId(row),edgeId,"SQL sample coordinates differ from its public key");
    return Object.freeze({selector:row.selector,edgeId,poolAddress:row.poolAddress,poolId:row.poolId,
      tokenIn:(m?.graph.tokenIn??row.tokenIn).toLowerCase(),tokenOut:(m?.graph.tokenOut??row.tokenOut).toLowerCase(),
      variantIds:Object.freeze([...(m?.variants.keys()??[])])});
  }));
}

export interface SqlSelectorSampleResult {
  readonly status:"passed"|"stopped";readonly selector:string;readonly edgeId:string;readonly index:number;readonly total:number;
  readonly remainingUnchecked:number;readonly sourceBlock:number;readonly reason?:string;
}

/** A completed producer table, not an arbitrary representative, gates trading.
 * Unreachable or reverting rows stay unpriced. At least one graph-owned price
 * must come from the actual funded simulation receipt path. */
export function assertSqlSourcePricePublication(effective:EffectiveMidSnapshot,graph:readonly TokenEdge[]):{usable:number}{
  assert(effective.complete&&!!effectiveAmountReferences(effective)&&effective.referenceWethInput>0n,
    "SQL startup requires a complete producer-owned price publication");
  let usable=0;
  for(const edge of graph){
    const id=edge.canonicalEdgeId,r=id&&effective.rows.get(id),ref=r&&effectiveRowAmountReference(r);
    if(!r||!ref||r.status!=="quoted"||!r.executionVerification?.variantId||!effectiveOwnsLocalExecutionReceipt(effective,r))continue;
    if(effectiveRowExecutionVerified(effective,r,edge,ref))usable++;
  }
  assert(usable>0,"SQL startup has no usable funded simulation prices");
  return {usable};
}
/** Consume the ordinary funded P+prefix price receipt, without a second SIM.
 * Stop at the first failed check; the tail of the plan remains unexamined. */
export function assertSqlSelectorSamplePrices(samples:readonly SqlSelectorRepresentative[],effective:EffectiveMidSnapshot,
  graph:readonly TokenEdge[],report?:(record:SqlSelectorSampleResult)=>void):void {
  assert(samples.length,"empty SQL selector sample plan");
  assert(new Set(samples.map(s=>s.selector)).size===samples.length,"duplicate selector in SQL sample plan");
  const owned=effective.complete&&!!effectiveAmountReferences(effective)&&effective.referenceWethInput>0n;
  const edges=new Map<string,TokenEdge>(),duplicates=new Set<string>(),wanted=new Set(samples.map(s=>s.edgeId));
  for(const edge of graph){const id=edge.canonicalEdgeId;if(id&&wanted.has(id)){if(edges.has(id))duplicates.add(id);else edges.set(id,edge);}}
  for(const [i,sample] of samples.entries()){
    const {selector,edgeId,poolAddress,poolId,tokenIn,tokenOut,variantIds}=sample;
    const edge=edges.get(edgeId),r=effective.rows.get(edgeId),s=effective.source,ref=r&&effectiveRowAmountReference(r);
    const coordinates=!!edge&&!duplicates.has(edgeId)&&edge.instanceKey===edgeId&&edge.executionVerification==="startup-simulation"&&
      edge.target.toLowerCase()===poolAddress&&(edge.poolId??null)===poolId&&edge.tokenIn.toLowerCase()===tokenIn&&edge.tokenOut.toLowerCase()===tokenOut;
    const reason=!owned?"no complete producer-owned source publication":
      !variantIds.length?"not simulated: no encodable SQL execution program":
      !coordinates?"missing or mismatched SQL graph direction or pool":
      !r?"no price row in the producer publication":
      r.status==="missing-valuation"?"not simulated: no funded input path":
      r.failureEvidence==="evm-revert-observed"&&r.status!=="quoted"?"no funded receipt: EVM revert observed":
      r.status!=="quoted"?"no funded receipt: producer status "+r.status:
      r.carried||r.quotedAt?.number!==s.number||r.quotedAt.hash!==s.hash||r.quotedAt.generation!==s.generation?"receipt is not fresh at the price source":
      !ref||(ref.path[0]?.amountIn??ref.amountIn)!==effective.referenceWethInput?"no funded P or prefix receipt":
      !r.executionVerification?.variantId||!variantIds.includes(r.executionVerification.variantId)?"receipt variant is not a SQL program for this sample":
      !effectiveOwnsLocalExecutionReceipt(effective,r)?"receipt was not issued by the required price producer":
      !effectiveRowExecutionVerified(effective,r,edge!,ref)?"invalid funded execution receipt":undefined;
    const progress={selector,edgeId,index:i+1,total:samples.length,remainingUnchecked:samples.length-i-1,sourceBlock:s.number};
    if(reason){report?.({...progress,status:"stopped",reason});throw Error("SQL startup stopped at selector "+(i+1)+"/"+samples.length+" "+selector+" "+edgeId+": "+reason);}
    report?.({...progress,status:"passed"});
  }
}
