import assert from "node:assert/strict";
import { ethers } from "ethers";
import { ERC4626_INTERFACE as EVENTS } from "../abi.js";
const same=(a:string,b:string)=>a.toLowerCase()===b.toLowerCase();
const WETH="0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
const WRAP=new ethers.Interface(["event Deposit(address indexed dst,uint256 wad)","event Transfer(address indexed from,address indexed to,uint256 value)"]);
export function assertRecipientEvent(logs:readonly any[],c:{deposit:boolean;vault:string;asset:string;executor:string;recipient:string;amount:bigint;output:bigint;assetSupplyDelta:bigint;expectedEventAssets?:bigint}) {
 assert(c.expectedEventAssets===undefined||c.deposit,"event-asset override is deposit-only");
 if(c.expectedEventAssets!==undefined)assert(c.expectedEventAssets>=0n&&c.expectedEventAssets<=c.amount);
 const events=logs.map((log,index)=>({log,index})).filter(x=>same(x.log.address,c.vault)&&same(x.log.topics[0],EVENTS.getEvent(c.deposit?"Deposit":"Withdraw")!.topicHash));assert.equal(events.length,1);
 const {log,index}=events[0]!,e=EVENTS.parseLog(log)!.args;
 assert(same(e.sender,c.executor));assert.equal(e.assets,c.deposit?(c.expectedEventAssets??c.amount):c.output);assert.equal(e.shares,c.deposit?c.output:c.amount);
 if(c.deposit){assert(same(e.owner,c.recipient));return {kind:"deposit-final-owner",receiver:c.recipient};}
 assert(same(e.owner,c.executor));
 if(same(e.receiver,c.recipient))return {kind:"withdraw-final-receiver",receiver:c.recipient};
 // Native-underlying fToken emits its internal native receiver, then wraps exactly
 // those assets and transfers WETH to the requested final recipient. This is an
 // observation rule, never identity/admission or a per-instance allowlist.
 assert(same(c.asset,WETH)&&same(e.receiver,c.vault)&&!same(c.recipient,c.vault));
 const wrapped=logs.map((log,index)=>({log,index})).filter(x=>same(x.log.address,WETH)&&same(x.log.topics[0],WRAP.getEvent("Deposit")!.topicHash));assert.equal(wrapped.length,1);
 const w=WRAP.parseLog(wrapped[0]!.log)!.args;assert(same(w.dst,c.vault));assert.equal(w.wad,c.output);assert.equal(c.assetSupplyDelta,c.output);
 const transfers=logs.map((log,index)=>({log,index})).filter(x=>same(x.log.address,WETH)&&same(x.log.topics[0],WRAP.getEvent("Transfer")!.topicHash));assert.equal(transfers.length,1);
 const t=WRAP.parseLog(transfers[0]!.log)!.args;assert(same(t.from,c.vault)&&same(t.to,c.recipient));assert.equal(t.value,c.output);
 assert(index<wrapped[0]!.index&&wrapped[0]!.index<transfers[0]!.index);
 return {kind:"withdraw-native-intermediate-then-weth",eventReceiver:c.vault,receiver:c.recipient,wrapped:c.output,scope:"exact newly wrapped WETH leaves the vault; actor native and full token deltas checked separately; no independent vault native storageDiff claim"};
}
// Correlate a saved execution to the exact reconstructed request and the next raw
// result, including zero-input calls interleaved between modes. Never stage-find:
// stage labels repeat across old inventories, and status can precede observation.
export function savedExecutionReplay(prior:any) {
 const rows=[...prior.samples.flatMap((s:any)=>s.executions),...prior.roundTrips];
 assert.equal(rows.length,prior.rawStrict.length);let cursor=0;const used=new Set<any>();
 return {
  take(request:any,stage:string,source:any,codeHash:string){
   const matches=rows.filter((r:any)=>!used.has(r)&&JSON.stringify(r.request)===JSON.stringify(request));
   if(!matches.length){assert.equal(cursor,rows.length,"saved prefix not fully consumed");return undefined;}
   assert.equal(matches.length,1,"ambiguous saved request");const row=matches[0],raw=prior.rawStrict[cursor];assert(raw);assert.equal(raw.stage,stage);assert.equal(raw.result.strict.counterfactualExecutorCode.keccak256,codeHash);
   assert.deepEqual(row.value.source,source);assert.equal(row.value.ok,true);assert.equal(raw.result.ok,true);assert.equal(raw.result.sourceAttestation.blockNumber,source.number);assert.equal(raw.result.sourceAttestation.blockHash,source.hash);
   assert.equal(raw.result.success,row.value.completion==="returned");
   if(raw.result.success){
    assert.equal(raw.result.strict.outcome.kind,"Success");assert.equal(raw.result.output,row.value.data);
    for(const key of ["tokenDeltas","totalSupplyDeltas","logs"])assert.deepEqual(raw.result.strict[key],row.value.effects[key]);
    assert.deepEqual(raw.result.strict.nativeDeltas.map(({account,delta}:any)=>({account,delta})),row.value.effects.nativeDeltas);
   }else{assert.equal(row.value.completion,"reverted-as-declared");assert.equal(raw.result.strict.outcome.phase,"main");assert.equal(raw.result.strict.outcome.kind,"Revert");assert.deepEqual(row.value.effects,{tokenDeltas:[],nativeDeltas:[],totalSupplyDeltas:[],logs:[]});}
   used.add(row);cursor++;return {row,raw:raw.result,index:cursor-1};
  },done(){assert.equal(cursor,rows.length);return cursor;}
 };
}
