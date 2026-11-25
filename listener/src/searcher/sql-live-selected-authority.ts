import assert from "node:assert/strict";
import type { AdapterWorkControl } from "./adapter-work-intent.js";
import { buildSqlEdgeLiveProducer, sqlSelectorModules, type SqlLiveMaterializedRoute } from "./sql-edge-live-producer.js";
import type { SqlPriceEdge } from "./sql-edge-price-index.js";
import { isEnabledSqlExecutionLeg } from "./sql-execution-selectors.js";
import { PinnedRethQuoteBackend } from "./pinned-reth-quote-backend.js";
import type { RethTransportScheduler } from "./reth-transport-scheduler.js";
import type { StrictReadyFundingAsset } from "./strict-production-runtime-session.js";
import type { CanonicalSource } from "./venues/adapter-request-program.js";
import { PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG as catalog } from "./venues/production-family-composition.js";
import { issueSqlFamilyAlternatives } from "./venues/selector-native-sql-live-materializer.js";
import { sqlLiveWitnessTransport } from "./sql-live-witness-transport.js";
import { compileSqlTrialLegs } from "./venues/selector-native-sql-trial.js";

/** Admission for a selected execution (or an unresolved price variant), not
 * graph discovery. Don't allow an unspecified scope to become an all-edge scan.
 * A mixed route is issued at one pin; a successful SQL-only sim isn't proof. */
export function createSqlSelectedAuthority(input:{
  edges:readonly SqlPriceEdge[]; fundingAssets:readonly StrictReadyFundingAsset[];
  swapTableSha256:string; fundingTableSha256:string; executionIdentity:{executor:string;transactionOrigin:string};
  rpcUrl:string; scheduler:RethTransportScheduler; signal:AbortSignal; directIds:ReadonlySet<string>;
}){
  const rows=new Map(input.edges.map(e=>[e.candidateInstanceKey,e]));
  assert.equal(rows.size,input.edges.length,"duplicate selected SQL identities");
  return async (request:{source:CanonicalSource;requiredEdgeIds:ReadonlySet<string>;control?:AdapterWorkControl})=>{
    const ids=[...request.requiredEdgeIds];
    if(!ids.some(id=>input.directIds.has(id)))return undefined;
    const selected=ids.map(id=>{const row=rows.get(id);assert(row,"foreign selected SQL edge");return row;});
    const {source,control}=request;
    assert(Number.isSafeInteger(source.number)&&source.number>=0&&Number.isSafeInteger(source.generation)&&source.generation>=0&&
      /^0x[0-9a-f]{64}$/.test(source.hash),"invalid selected SQL source");
    const abort=new AbortController(),signal=AbortSignal.any([input.signal,abort.signal,...(control?.signal?[control.signal]:[])]);
    const open=()=>{signal.throwIfAborted();if(control?.deadlineAtMs!==undefined&&Date.now()>=control.deadlineAtMs)throw Error("selected SQL authority deadline");};
    open();
    const capacity=input.scheduler.snapshot().capacity;
    const backend=new PinnedRethQuoteBackend(input.rpcUrl,source.hash,{transportScheduler:input.scheduler,transportLane:"exact",
      maxBatchSize:32,maxConcurrentBatches:capacity,retryRpcThrottle:true,allowSingleCallFallback:false,
      deadlineAtMs:control?.deadlineAtMs,signal,scopeLabel:"selected SQL execution binding"});
    const read=(to:string,data:string)=>{open();return backend.call({to,data});},readCode=(a:string)=>{open();return backend.getCode(a);};
    const witness=sqlLiveWitnessTransport(input.rpcUrl,input.scheduler,signal,control?.deadlineAtMs);
    const materialized:SqlLiveMaterializedRoute[]=[],unavailable:{sqlEdgeKey:string;reason:string}[]=[];
    let cursor=0;
    async function work(){
      try{
        for(;;){
          open();const edge=selected[cursor++];if(!edge)return;
          const sqlEdgeKey=edge.candidateInstanceKey,m=sqlSelectorModules.get(edge.selector);
          assert(m&&isEnabledSqlExecutionLeg(m),"inactive or unregistered selected SQL direction");
          const direct=input.directIds.has(sqlEdgeKey);
          const historicalProgramKeys=direct&&edge.executionParamEvidence?.consensus==="uniform"&&edge.executionParamEvidence.callPath===""
            ?compileSqlTrialLegs({definition:m.definition,edge,source,...input.executionIdentity}).legs.map(v=>v.programKey):undefined;
          const result=await issueSqlFamilyAlternatives({catalog,definition:m.definition,edge,source,signal,...input.executionIdentity,
            read,readCode,matchPriceTrial:direct,readCallWitness:witness.readCallWitness,historicalProgramKeys});
          if(!result.alternatives.length)unavailable.push({sqlEdgeKey,reason:result.issues.join("; ")||"no issued runtime route"});
          for(const {instance,routeKey,programKey} of result.alternatives)materialized.push({sqlEdgeKey,instance,routeKey,programKey});
        }
      }catch(e){if(!signal.aborted)abort.abort(e);throw e;}
    }
    try{
      const settled=await Promise.allSettled(Array.from({length:Math.min(selected.length,capacity*32)},work));
      for(const s of settled)if(s.status==="rejected")throw s.reason;
      open();
      return buildSqlEdgeLiveProducer({source,edges:selected,swapTableSha256:input.swapTableSha256,
        fundingAssets:input.fundingAssets,fundingTableSha256:input.fundingTableSha256,currentHead:source.number,materialized,unavailable}).runtimeRoot;
    }finally{witness.close();await backend.closeAndDrain();}
  };
}
