import assert from "node:assert/strict";
import { getAddress, keccak256 } from "ethers";
import { loadBotVmRuntimeCode } from "../shared/executor/botvm-executor.js";
import { loadLiveSqlTables } from "./sql-live-tables.js";
import { buildSqlEdgeLiveProducer, sqlSelectorModules, type SqlLiveMaterializedRoute } from "./sql-edge-live-producer.js";
import { PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG as catalog } from "./venues/production-family-composition.js";
import { issueSqlFamilyAlternatives } from "./venues/selector-native-sql-live-materializer.js";
import { PinnedRethQuoteBackend } from "./pinned-reth-quote-backend.js";
import type { RethTransportScheduler } from "./reth-transport-scheduler.js";

type ExecutionIdentity={executor:string;transactionOrigin:string};
type IntakeProvider={send(method:string,params:unknown[]):Promise<unknown>};
type Disposition={sqlEdgeKey:string;reason:string};

/** SQL describes observed conversions, not a funded execution test. The live
 * issuer constructs the catalog-owned alternatives at this source; main's
 * normal startup pricing and revert filter decide which are executable. */
export async function initializeSqlLiveProducer(input:{
  env:NodeJS.ProcessEnv; provider:IntakeProvider; executionIdentity:ExecutionIdentity;
  currentHead:number; expectedHeadHash:string; rpcUrl:string; scheduler?:RethTransportScheduler;
  signal:AbortSignal; configuredRuntimeCode?:string;
}) {
  const {env,provider,executionIdentity,signal,scheduler}=input;
  const path=env.SEARCHER_SQL_LIVE_INPUT_PATH, digest=env.SEARCHER_SQL_LIVE_INPUT_SHA256;
  assert(path && digest,"live requires SEARCHER_SQL_LIVE_INPUT_PATH and SEARCHER_SQL_LIVE_INPUT_SHA256 (swap and funding tables)");
  signal.throwIfAborted();
  const {manifest,edges,fundingAssets,fundingTableSha256}=await loadLiveSqlTables(path,digest);
  assert(Number.isSafeInteger(input.currentHead)&&input.currentHead>=manifest.toBlock,"SQL discovery window is ahead of the startup source");
  assert(/^0x[a-f0-9]{64}$/.test(input.expectedHeadHash),"invalid startup source hash");
  assert(scheduler && input.rpcUrl,"SQL input requires the shared production RPC transport");
  const source=Object.freeze({number:input.currentHead,hash:input.expectedHeadHash,generation:input.currentHead});
  async function checkHeight(n:number,expected:string){
    signal.throwIfAborted();
    const tag="0x"+n.toString(16);
    const b=await provider.send("eth_getBlockByNumber",[tag,false]) as {number?:string;hash?:string}|null;
    assert(b?.number===tag&&b.hash?.toLowerCase()===expected,"SQL discovery or runtime binding source is not canonical at "+n);
  }
  async function checkSources(){
    if(source.number===manifest.toBlock) assert.equal(source.hash,manifest.cutoffHash,"SQL discovery hash differs at startup source");
    else await checkHeight(manifest.toBlock,manifest.cutoffHash);
    await checkHeight(source.number,source.hash);
    signal.throwIfAborted();
  }
  assert.equal(await provider.send("eth_chainId",[]),"0x1","SQL input is for Ethereum mainnet");
  await checkSources();
  assert.notEqual(getAddress(executionIdentity.executor),getAddress(executionIdentity.transactionOrigin),"SQL execution actors must be distinct");
  if(input.configuredRuntimeCode!==undefined)
    assert(env.SEARCHER_DRY_RUN==="1"&&env.SEARCHER_BLOCKSCAN_SUBMIT!=="1"&&env.SEARCHER_SUBMIT!=="1","SQL executor override is dry-run only");
  const expectedCode=loadBotVmRuntimeCode(executionIdentity.transactionOrigin).keccak256;
  const batchSize=32, capacity=scheduler.snapshot().capacity;
  const backend=new PinnedRethQuoteBackend(input.rpcUrl,source.hash,{transportScheduler:scheduler,transportLane:"producer-bulk",
    maxBatchSize:batchSize,maxConcurrentBatches:capacity,retryRpcThrottle:true,allowSingleCallFallback:false,signal,scopeLabel:"SQL live binding"});
  const rows:{routes:SqlLiveMaterializedRoute[];unavailable?:Disposition}[]=new Array(edges.length);
  const control=new AbortController(), active=AbortSignal.any([signal,control.signal]);
  let cursor=0,completed=0,boundDirections=0,enabledDirections=0,privateRecipes=0;
  const uniqueReads=new Set<string>();
  const read=(to:string,data:string)=>{active.throwIfAborted();uniqueReads.add(to+":"+data);return backend.call({to,data});};
  const readCode=(to:string)=>{active.throwIfAborted();uniqueReads.add(to.toLowerCase());return backend.getCode(to);};
  const report=(phase:string)=>{
    const s=backend.stats();
    console.log("[searcher/sql-live-binding] "+JSON.stringify({phase,sourceBlock:source.number,sourceHash:source.hash,rows:edges.length,
      completed,boundDirections,enabledDirections,privateRecipes,unboundDirections:enabledDirections-boundDirections,uniqueReads:uniqueReads.size,
      batches:s.batchesSent,wireItems:s.batchedItems,memoHits:s.memoHits,throttleRetries:s.throttleRetries,timeoutRetries:s.timeoutRetries,
      connectionResetRetries:s.connectionResetRetries}));
  };
  try {
    const code=input.configuredRuntimeCode??await readCode(executionIdentity.executor);
    assert(typeof code==="string"&&code!=="0x"&&keccak256(code)===expectedCode,"SQL executor runtime differs from its owner-bound executable");
    report("begin");
    async function work(){
      try {
        for(;;) {
          active.throwIfAborted();
          const i=cursor++; if(i>=edges.length)return;
          const edge=edges[i]!,sqlEdgeKey=edge.candidateInstanceKey,m=sqlSelectorModules.get(edge.selector);
          let routes:SqlLiveMaterializedRoute[]=[],reason:string|undefined;
          if(!m) reason="unregistered conversion selector";
          else if(!m.activation.enabled) reason="selector is disabled";
          else if(m.definition.domain!=="swap" && m.definition.domain!=="protocol") reason="selector is not a conversion";
          else {
            const r=await issueSqlFamilyAlternatives({catalog,definition:m.definition,edge,source,...executionIdentity,signal:active,read,readCode});
            routes=r.alternatives.map(({instance,routeKey,programKey})=>({sqlEdgeKey,instance,routeKey,programKey}));
            if(routes.length===0)reason=r.issues.join("; ")||"Family did not issue a route";
          }
          rows[i]={routes,...(reason===undefined?{}:{unavailable:{sqlEdgeKey,reason}})};
          completed++;
          if(m?.activation.enabled && (m.definition.domain==="swap"||m.definition.domain==="protocol"))enabledDirections++;
          if(routes.length){boundDirections++;privateRecipes+=routes.length;}
          if(completed%256===0)report("progress");
        }
      } catch(e){if(!active.aborted){control.abort(e);backend.abort(e);}throw e;}
    }
    // Physical permits count batches, not business rows. This admits enough
    // work to coalesce source reads, without creating one promise per SQL row.
    const settled=await Promise.allSettled(Array.from({length:Math.min(edges.length,batchSize*capacity)},work));
    active.throwIfAborted();for(const s of settled)if(s.status==="rejected")throw s.reason;
    await checkSources();
    const unavailable=Object.freeze(rows.flatMap(r=>r.unavailable?[Object.freeze(r.unavailable)]:[]));
    const producer=buildSqlEdgeLiveProducer({source,edges,swapTableSha256:manifest.edgeSha256,fundingAssets,fundingTableSha256,
      currentHead:source.number,materialized:rows.flatMap(r=>r.routes),unavailable});
    // Emit each cause once with a bounded list of its SQL keys, rather than
    // repeating potentially large recipe diagnostics once per missing leg.
    const keysByReason=new Map<string,string[]>();
    for(const {sqlEdgeKey,reason} of unavailable){const keys=keysByReason.get(reason)??[];keys.push(sqlEdgeKey);keysByReason.set(reason,keys);}
    for(const [reason,keys] of keysByReason)for(let i=0;i<keys.length;i+=32)
      console.log("[searcher/sql-leg-disposition] "+JSON.stringify({sourceBlock:source.number,reason,sqlEdgeKeys:keys.slice(i,i+32)}));
    report("complete");
    return {...producer,unavailable};
  } finally {await backend.closeAndDrain();}
}
