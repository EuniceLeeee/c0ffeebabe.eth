import test from 'node:test';
import assert from 'node:assert/strict';
import {toBeHex} from 'ethers';
import {createSqlIdentityStorageTransport} from '../sql-source-identity-storage.js';
import {createSelectorIdentityRequestReader,SelectorIdentityReadUnavailable} from '../venues/selector-source-identity.js';
const source={number:100,generation:1,hash:toBeHex(100,32)},address=toBeHex(1,20),slot=toBeHex(2,32),word=toBeHex(3,32);
test('identity storage is lazy, canonical-hash pinned and shares caller scheduler/control',async()=>{
 const controller=new AbortController(),scheduler={} as any;let created=0,destroyed=0;
 const storage=createSqlIdentityStorageTransport('unused',scheduler,source,controller.signal,123,(url,options)=>{
  assert.equal(url,'unused');assert.equal(options!.scheduler,scheduler);assert.equal(options!.signal,controller.signal);created++;
  return {sendWithControl:async(method:string,params:unknown[],control:{signal?:AbortSignal;deadlineAtMs?:number})=>{
   assert.equal(method,'eth_getStorageAt');assert.deepEqual(params,[address,slot,{blockHash:source.hash,requireCanonical:true}]);
   assert.equal(control.signal,controller.signal);assert.equal(control.deadlineAtMs,123);return word;
  },destroy(){destroyed++;}} as any;
 });
 assert.equal(created,0);assert.equal(await storage.readStorage(address,slot),word);assert.equal(created,1);
 assert.throws(()=>storage.readStorage(address,'0x1'),/bytes32/);await storage.close();assert.equal(destroyed,1);
 assert.throws(()=>storage.readStorage(address,slot),/closed/);
});
test('storage rejects malformed word responses and close drains active controlled reads',async()=>{
 const signal=new AbortController().signal;
 const bad=createSqlIdentityStorageTransport('unused',{} as any,source,signal,undefined,()=>({sendWithControl:async()=> '0x',destroy(){}} as any));
 await assert.rejects(bad.readStorage(address,slot),/response must be bytes32/);await bad.close();
 let reject!:(error:Error)=>void,destroyed=0;
 const live=createSqlIdentityStorageTransport('unused',{} as any,source,signal,undefined,()=>({
  sendWithControl:()=>new Promise((_resolve,r)=>{reject=r;}),destroy(){destroyed++;}} as any));
 const pending=live.readStorage(address,slot);let drained=false;const closing=live.close().then(()=>{drained=true;});
 assert.equal(destroyed,1);assert.equal(drained,false);reject(Error('cancelled'));await assert.rejects(pending,/cancelled/);await closing;assert(drained);
});
test('identity request reader caches a storage slot at one source, cannot simulate and cannot invent absent storage',async()=>{
 let n=0;const read=createSelectorIdentityRequestReader({source,read:async()=>{throw Error('unexpected call');},readCode:async()=>{throw Error('unexpected code');},
  readStorage:async(a,s)=>{assert.equal(a,address);assert.equal(s,slot);n++;return word;}});
 const request={id:'storage',kind:'get-storage' as const,address,slot};
 const result=await read([request,{...request,id:'duplicate'}],source);assert.equal(n,1);assert.equal(result.length,2);
 await assert.rejects(read([{id:'sim',kind:'effect-delta-simulation'} as any],source),/only caller-independent/);
 await assert.rejects(read([request],{...source,hash:toBeHex(200,32)}));
 const missing=createSelectorIdentityRequestReader({source,read:async()=>word,readCode:async()=>word});
 await assert.rejects(missing([request],source),SelectorIdentityReadUnavailable);
});
