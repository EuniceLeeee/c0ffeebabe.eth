import test from "node:test";
import assert from "node:assert/strict";
import {createServer} from "node:http";
import {setTimeout as wait} from "node:timers/promises";
import {PinnedRethQuoteBackend} from "../pinned-reth-quote-backend.js";
import {RethTransportScheduler} from "../reth-transport-scheduler.js";

const pin="0x"+"a".repeat(64),a="0x"+"1".repeat(40),b="0x"+"2".repeat(40);
test("code lookups are coalesced, pinned, retried by the shared scheduler, and distinct from an empty-calldata call",async t=>{
  const batches:any[][]=[];let refused=false;
  const server=createServer(async(req,res)=>{
    const buf=[];for await(const c of req)buf.push(c);const rows=JSON.parse(Buffer.concat(buf).toString());
    assert(Array.isArray(rows));batches.push(rows);
    res.setHeader("content-type","application/json");
    if(!refused&&rows[0].method==="eth_getCode"){refused=true;res.statusCode=429;res.end("[]");return;}
    res.end(JSON.stringify(rows.map(q=>{
      assert.deepEqual(q.params[1],{blockHash:pin,requireCanonical:true});
      if(q.method==="eth_getCode")assert([a,b].includes(q.params[0]));
      else {assert.equal(q.method,"eth_call");assert.deepEqual(q.params[0],{to:a,data:"0x"});}
      return {id:q.id,jsonrpc:"2.0",result:q.method==="eth_getCode"?"0x6000":"0x12"};
    })));
  });
  await new Promise<void>(r=>server.listen(0,"127.0.0.1",r));const port=server.address();assert(port&&typeof port==="object");
  const scheduler=new RethTransportScheduler({capacity:2,producerReserved:1,retryDelayMs:1,maxRetryDelayMs:1});
  const client=new PinnedRethQuoteBackend("http://127.0.0.1:"+port.port,pin,{transportLane:"producer-bulk",transportScheduler:scheduler,
    allowSingleCallFallback:false,retryRpcThrottle:true,maxBatchSize:32,maxConcurrentBatches:2,deadlineAtMs:Date.now()+5000});
  t.after(async()=>{await client.closeAndDrain();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));});
  assert.deepEqual(await Promise.all([client.getCode(a),client.getCode(a),client.getCode(b),client.call({to:a,data:"0x"})]),
    ["0x6000","0x6000","0x6000","0x12"]);
  const before=batches.length;assert.equal(await client.getCode(a),"0x6000");assert.equal(await client.call({to:a,data:"0x"}),"0x12");
  assert.equal(batches.length,before);assert(refused);assert.equal(client.stats().singleCallFallbacks,0);assert.equal(client.stats().throttleRetries,1);
  assert.equal(batches.find(q=>q[0].method==="eth_getCode")!.length,2);
  assert.equal(client.stats().totalCalls,3);assert.equal(scheduler.snapshot().activeTotal,0);
});
test("cancelling one code waiter cannot cancel a sibling; closing the source drains its physical request",async t=>{
  let requests=0,release!:()=>void;const gate=new Promise<void>(r=>{release=r;});
  const server=createServer(async(req,res)=>{
    const buf=[];for await(const c of req)buf.push(c);const rows=JSON.parse(Buffer.concat(buf).toString());
    requests++;await gate;if(res.destroyed)return;res.setHeader("content-type","application/json");
    res.end(JSON.stringify(rows.map((q:any)=>({jsonrpc:"2.0",id:q.id,result:"0x6000"}))));
  });
  await new Promise<void>(r=>server.listen(0,"127.0.0.1",r));const port=server.address();assert(port&&typeof port==="object");
  const scheduler=new RethTransportScheduler({capacity:2,producerReserved:1});
  const client=new PinnedRethQuoteBackend("http://127.0.0.1:"+port.port,pin,{transportLane:"producer-bulk",transportScheduler:scheduler,
    deadlineAtMs:Date.now()+5000});
  t.after(async()=>{release();await client.closeAndDrain();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));});
  const c=new AbortController(),left=client.getCode(a,{signal:c.signal}),right=client.getCode(a);
  const observed=Promise.allSettled([left,right]);
  for(let i=0;!requests&&i<100;i++)await wait(2);assert.equal(requests,1);
  c.abort();assert.equal(scheduler.snapshot().activeTotal,1);
  release();const [cancelled,ok]=await observed;assert.equal(cancelled!.status,"rejected");assert.deepEqual(ok,{status:"fulfilled",value:"0x6000"});
  await client.closeAndDrain();assert.equal(client.stats().activeTransports,0);assert.equal(scheduler.snapshot().activeTotal,0);
  await assert.rejects(client.getCode(a));assert.equal(requests,1);
});
