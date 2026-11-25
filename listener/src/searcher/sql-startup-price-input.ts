import assert from "node:assert/strict";
import {setImmediate as yieldToLive} from "node:timers/promises";
import {isEnabledSqlExecutionLeg} from "./sql-execution-selectors.js";
import {sqlSelectorModules,type SqlTrialGraphMetadata,type SqlTrialMarket} from "./sql-edge-live-producer.js";
import type {SqlStartupPriceTrials} from "./sql-startup-price-sessions.js";
import type {SqlPriceEdge} from "./sql-edge-price-index.js";
import {compileSqlTrialLegs} from "./venues/selector-native-sql-trial.js";
import {selectorExecutionResourceKey} from "./venues/selector-execution-keys.js";
import {selectorNativeProgramKey,type SelectorNativeExecutionDefinition} from "./venues/selector-native-definition.js";
import type {CanonicalSource} from "./venues/adapter-request-program.js";
import {sqlTrialVariantId} from "./sql-trial-variant.js";

export async function prepareSqlStartupPriceInputs(input:{
  edges:readonly SqlPriceEdge[];source:CanonicalSource;executor:string;transactionOrigin:string;signal?:AbortSignal;
  report?:(counts:{processed:number;locallyEncodable:number;unavailable:number})=>void;
}){
  const rows=new Map<string,SqlPriceEdge>(),markets=new Map<string,SqlTrialMarket>();
  const unavailable:{sqlEdgeKey:string;reason:string}[]=[];
  const policies=new Map<SelectorNativeExecutionDefinition,Map<string,"on-touch"|"each-block">>();
  function compile(edge:SqlPriceEdge,source:CanonicalSource){
    const m=sqlSelectorModules.get(edge.selector);assert(m&&isEnabledSqlExecutionLeg(m),"inactive SQL price selector");
    const d=m.definition;
    const result=compileSqlTrialLegs({definition:d,edge,source,executor:input.executor,transactionOrigin:input.transactionOrigin});
    let graph:SqlTrialGraphMetadata|undefined, p=policies.get(d);
    if(!p){p=new Map(d.programs.map(a=>[selectorNativeProgramKey(a),a.refreshPolicy==="on-touch"?"on-touch":"each-block"]));policies.set(d,p);}
    const variants=new Map<string,"on-touch"|"each-block">(),programs=new Map<string,(typeof result.legs)[number]["leg"]>();
    for(const trial of result.legs){
      const {tokenIn,tokenOut,poolNamespace,taxonomy}=trial;
      const g={tokenIn,tokenOut,slotKind:taxonomy.slotKind,...(taxonomy.protocolAction?{protocolAction:taxonomy.protocolAction}:{}),
        stateResourceKey:selectorExecutionResourceKey({chainId:edge.chainId,target:edge.poolAddress,
          ...(edge.poolId?{poolId:edge.poolId,poolNamespace:poolNamespace??undefined}:{})})};
      const id=sqlTrialVariantId(trial.programKey,trial.leg.program),policy=p.get(trial.programKey);
      assert(policy&&!variants.has(id),"duplicate or foreign SQL trial program");
      if(graph&&JSON.stringify(graph)!==JSON.stringify(g))return {...result,complete:false,graph:undefined,
        variants:new Map<string,"on-touch"|"each-block">(),programs:new Map<string,(typeof trial)["leg"]>(),issues:["encodings disagree on graph identity"]};
      graph??=g;variants.set(id,policy);programs.set(id,trial.leg);
    }
    return {...result,graph,variants,programs};
  }
  let lastYield=performance.now(),lastReport=lastYield;
  for(const [i,edge] of input.edges.entries()){
    if(performance.now()-lastYield>=40){
      await yieldToLive();lastYield=performance.now();
      if(lastYield-lastReport>=5000){input.report?.({processed:i,locallyEncodable:markets.size,unavailable:unavailable.length});lastReport=lastYield;}
    }
    input.signal?.throwIfAborted();
    const id=edge.candidateInstanceKey,m=sqlSelectorModules.get(edge.selector);
    if(!m||!isEnabledSqlExecutionLeg(m)){unavailable.push({sqlEdgeKey:id,reason:!m?"unregistered conversion selector":!m.activation.enabled?"selector is disabled":"selector has no independent conversion program"});continue;}
    rows.set(id,edge);
    const c=compile(edge,input.source);
    if(c.graph)markets.set(id,{graph:c.graph,variants:c.variants});
    else unavailable.push({sqlEdgeKey:id,reason:c.issues.join("; ")||"no compatible SQL execution recipe"});
  }
  const trials:SqlStartupPriceTrials={ids:new Set(rows.keys()),atSource(id,source){
    const e=rows.get(id);assert(e,"foreign SQL price edge");
    const m=markets.get(id),c=m&&compile(e,source);
    const same=!!m&&!!c?.graph&&JSON.stringify(m.graph)===JSON.stringify(c.graph);
    return {tokenIn:m?.graph.tokenIn??e.tokenIn,tokenOut:m?.graph.tokenOut??e.tokenOut,
      complete:!!same&&c!.complete,programs:same?c!.programs:new Map()};
  }};
  return {trials,markets,unavailable};
}
