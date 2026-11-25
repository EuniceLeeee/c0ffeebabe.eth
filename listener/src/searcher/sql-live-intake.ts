import assert from "node:assert/strict";
import { getAddress, keccak256 } from "ethers";
import { loadBotVmRuntimeCode } from "../shared/executor/botvm-executor.js";
import { loadLiveSqlTables } from "./sql-live-tables.js";
import { buildSqlEdgeLiveProducer } from "./sql-edge-live-producer.js";
import { prepareSqlStartupPriceInputs } from "./sql-startup-price-input.js";
import { planSqlSelectorSamplePrices,sqlSelectorRepresentatives } from "./sql-selector-startup-check.js";
import { createSqlSelectedAuthority } from "./sql-live-selected-authority.js";
import { PinnedRethQuoteBackend } from "./pinned-reth-quote-backend.js";
import type { RethTransportScheduler } from "./reth-transport-scheduler.js";

type ExecutionIdentity={executor:string;transactionOrigin:string};
type IntakeProvider={send(method:string,params:unknown[]):Promise<unknown>};

/** SQL identifies and encodes startup price legs. Actual funded receipts are
 * checked at price publication. Independent issuance is for selected execution. */
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
  const readCode=(to:string)=>{signal.throwIfAborted();return backend.getCode(to);};
  try {
    const code=input.configuredRuntimeCode??await readCode(executionIdentity.executor);
    assert(typeof code==="string"&&code!=="0x"&&keccak256(code)===expectedCode,"SQL executor runtime differs from its owner-bound executable");
    const representatives=sqlSelectorRepresentatives(edges);
    const {trials,markets,unavailable}=await prepareSqlStartupPriceInputs({edges,source,...executionIdentity,signal,
      report:counts=>console.log("[searcher/sql-local-encoding] "+JSON.stringify({sourceBlock:source.number,rows:edges.length,...counts}))});
    const sqlSelectorSamples=planSqlSelectorSamplePrices(representatives,markets);
    await checkSources();
    const producer=buildSqlEdgeLiveProducer({source,edges,swapTableSha256:manifest.edgeSha256,fundingAssets,fundingTableSha256,
      currentHead:source.number,materialized:[],trialMarkets:markets,unavailable});
    const selectedAuthority=createSqlSelectedAuthority({edges,swapTableSha256:manifest.edgeSha256,fundingAssets,fundingTableSha256,
      executionIdentity,rpcUrl:input.rpcUrl,scheduler,signal,directIds:new Set(markets.keys())});
    // Emit each cause once with a bounded list of its SQL keys, rather than
    // repeating potentially large recipe diagnostics once per missing leg.
    const keysByReason=new Map<string,string[]>();
    for(const {sqlEdgeKey,reason} of unavailable){const keys=keysByReason.get(reason)??[];keys.push(sqlEdgeKey);keysByReason.set(reason,keys);}
    for(const [reason,keys] of keysByReason)for(let i=0;i<keys.length;i+=32)
      console.log("[searcher/sql-leg-disposition] "+JSON.stringify({sourceBlock:source.number,reason,sqlEdgeKeys:keys.slice(i,i+32)}));
    console.log("[searcher/sql-startup-intake] "+JSON.stringify({sourceBlock:source.number,rows:edges.length,
      samples:sqlSelectorSamples.length,locallyEncodable:markets.size,unavailable:unavailable.length,bulkPoolBindingReads:0}));
    return {...producer,unavailable,trials,selectedAuthority,sqlSelectorSamples};
  } finally {await backend.closeAndDrain();}
}
