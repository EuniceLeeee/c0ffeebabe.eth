import test, {type TestContext} from "node:test";
import assert from "node:assert/strict";
import {createServer, type ServerResponse} from "node:http";
import {setTimeout as wait} from "node:timers/promises";
import {RethTransportScheduler} from "../reth-transport-scheduler.js";
import {PinnedRethQuoteBackend} from "../pinned-reth-quote-backend.js";
import {isStateCallAbortedError} from "../../shared/state/state-backend.js";

const pin="0x"+"ab".repeat(32), addr=(n:number)=>"0x"+n.toString(16).padStart(40,"0");
type Row={method:string;params:unknown[];id:number};
const ok=(res:ServerResponse,b:Row[])=>res.end(JSON.stringify(b.map(r=>({id:r.id,jsonrpc:"2.0",result:"0x1234"}))));
async function fixture(t:TestContext,serve:(res:ServerResponse,b:Row[],i:number)=>void,
  options:{capacity?:number;batch?:number;delay?:number;signal?:AbortSignal;fallback?:boolean}={}){
  const batches:Row[][]=[];
  const s=createServer(async(req,res)=>{
    const data=[];for await(const c of req)data.push(c);const batch=JSON.parse(Buffer.concat(data).toString());
    assert(Array.isArray(batch),"no exhausted-batch fallback to single requests");batches.push(batch);
    for(const r of batch)assert.deepEqual(r.params[1],{blockHash:pin,requireCanonical:true});
    serve(res,batch,batches.length);
  });
  await new Promise<void>(done=>s.listen(0,"127.0.0.1",done));const where=s.address();assert(where&&typeof where==="object");
  const cap=options.capacity??2,delay=options.delay??1;
  const scheduler=new RethTransportScheduler({capacity:cap,producerReserved:1,retryDelayMs:delay,maxRetryDelayMs:delay,maxRetriesAtOne:2});
  const client=new PinnedRethQuoteBackend("http://127.0.0.1:"+where.port,pin,{transportLane:"producer-bulk",
    transportScheduler:scheduler,allowSingleCallFallback:options.fallback??false,retryRpcThrottle:true,maxBatchSize:options.batch??2,maxConcurrentBatches:cap,signal:options.signal,
    deadlineAtMs:Date.now()+4000});
  t.after(async()=>{await client.closeAndDrain();s.closeAllConnections();await new Promise<void>(r=>s.close(()=>r()));});
  return {client,batches,scheduler};
}
for(const method of ["eth_call","eth_getCode"] as const)for(const partial of [false,true]){
  test(method+" recovers from physical reset "+(partial?"mid-response":"before headers")+" with the same pin",async t=>{
    const {client,batches,scheduler}=await fixture(t,(res,b,i)=>{
      if(i!==1){ok(res,b);return;}
      if(!partial){res.socket!.destroy();return;}
      res.writeHead(200,{"content-type":"application/json","content-length":4096});
      const sock=res.socket!;res.write("[",()=>setImmediate(()=>sock.destroy()));
    });
    const read=(n:number)=>method==="eth_call"?client.call({to:addr(n),data:"0x01"}):client.getCode(addr(n));
    assert.deepEqual(await Promise.all([read(1),read(2)]),["0x1234","0x1234"]);
    assert.deepEqual(batches.map(b=>b.length),[2,1,1]);
    assert.deepEqual(batches[0]!.map(x=>x.id).sort(),batches.slice(1).flatMap(b=>b.map(x=>x.id)).sort());
    const stats=client.stats();assert.equal(stats.connectionResetRetries,1);assert.equal(stats.throttleRetries,0);
    assert.equal(stats.timeoutRetries,0);assert.equal(stats.singleCallFallbacks,0);assert.equal(scheduler.snapshot().activeTotal,0);
  });
}
test("an always-reset read exhausts only the shared configured floor budget and preserves the system error",async t=>{
  const {client,batches}=await fixture(t,res=>res.socket!.destroy(),{batch:1,capacity:1,fallback:true});
  await assert.rejects(client.call({to:addr(4),data:"0x12"}),(err:Error&{code?:string;cause?:{code?:string}})=>{
    assert.equal(err.code,"ECONNRESET");assert.equal(err.cause?.code,"ECONNRESET");return true;
  });
  assert.equal(batches.length,3);assert.equal(client.stats().connectionResetRetries,2);assert.equal(client.stats().singleCallFallbacks,0);
});
test("an RPC error with a socket message/code or an EVM revert is not a wire reset",async t=>{
  const {client,batches}=await fixture(t,(res,b,i)=>res.end(JSON.stringify(b.map(r=>({id:r.id,jsonrpc:"2.0",
    error:i===1?{code:"ECONNRESET",message:"socket hang up"}:{code:3,data:"0x",message:"execution reverted: socket hang up"}})))));
  for(let i=0;i<2;i++)await assert.rejects(client.getCode(addr(i+1)),/socket hang up/);
  assert.equal(batches.length,2);assert.equal(client.stats().connectionResetRetries,0);assert.equal(client.stats().throttleRetries,0);
});
test("cancellation during reset cooldown drains without replay",async t=>{
  const ctl=new AbortController(),{client,batches,scheduler}=await fixture(t,res=>res.socket!.destroy(),{delay:250,signal:ctl.signal});
  const read=client.getCode(addr(4));void read.catch(()=>{});
  for(let i=0;i<100 && !client.stats().connectionResetRetries;i++)await wait(2);
  assert.equal(client.stats().connectionResetRetries,1);ctl.abort();await assert.rejects(read,isStateCallAbortedError);
  await client.closeAndDrain();assert.equal(batches.length,1);assert.equal(scheduler.snapshot().activeTotal,0);
});
