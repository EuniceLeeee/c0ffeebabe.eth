import {readFileSync} from 'node:fs';import {gunzipSync} from 'node:zlib';import test from 'node:test';import assert from 'node:assert/strict';
import {indexedTrieRoot,verifyReceiptRoot,computeLogBloom} from './receipt-root.mjs';
const captured=gunzipSync(readFileSync(process.env.TRACE_TREE_RAW_FIXTURE??new URL('../raw-block.ndjson.gz',import.meta.url))).toString().trim().split('\n').map(JSON.parse)
  .filter(r=>r.row_kind!=='trace').map(r=>({...r,raw_json:JSON.parse(r.raw_json)}));
const root='0x43d6b85d021046485224338891a560dd55f36b2606e087c7739a499839a5bff2';
const fresh=()=>structuredClone(captured),logs=r=>r.filter(x=>x.row_kind==='receipt_log').map(x=>x.raw_json).sort((x,y)=>+x.log_index- +y.log_index);
test('empty trie is the known Ethereum empty trie root, not keccak of empty string',()=>{
 assert.equal(indexedTrieRoot([]),'0x56e81f171bcc55a6ff8345e692c0f86e5b48e01b996cadc001622fb5e363b421');
 assert.equal(computeLogBloom([]).toString('hex'),'00'.repeat(256));});
test('real 349-receipt block matches header with all 5,169 logs; raw export row order does not matter',()=>{
 const a=verifyReceiptRoot([...captured].reverse());
 assert.equal(a.valid,true);assert.equal(a.receiptsRoot.computed,root);assert.equal(a.receiptLogs,5169);
 assert.equal(a.logsBloom.setBits,2048);assert.deepEqual(a.byType,{0:32,2:312,4:5});assert.deepEqual(a.byStatus,{0:5,1:344});
});
test('changing just one log data byte invalidates the commitment although saturated OR bloom still matches',()=>{
 const r=fresh(),l=logs(r).find(l=>l.data.length>2);l.data=l.data.slice(0,-2)+(l.data.endsWith('00')?'01':'00');
 const a=verifyReceiptRoot(r);assert.equal(a.receiptsRoot.match,false);assert.equal(a.logsBloom.match,true);});
test('reversing two distinct receipt logs in the same transaction invalidates the commitment even though bloom is unchanged',()=>{
 const r=fresh(),ls=logs(r);const i=ls.findIndex((l,j)=>j>0&&l.transaction_index===ls[j-1].transaction_index&&(l.data!==ls[j-1].data||l.address!==ls[j-1].address));
 assert(i>0);[ls[i].log_index,ls[i-1].log_index]=[ls[i-1].log_index,ls[i].log_index];
 const a=verifyReceiptRoot(r);assert(!a.receiptsRoot.match);assert(a.logsBloom.match);
});
test('omitting terminal receipt log changes root even though log indexes are still consecutive',()=>{
 const r=fresh(),last=logs(r).at(-1);const a=verifyReceiptRoot(r.filter(l=>l.raw_json!==last));assert(!a.valid);});
test('changing a typed receipt to legacy changes committed bytes even when gas/status/logs agree',()=>{
 const r=fresh(),t=r.find(r=>r.row_kind==='transaction'&& +r.raw_json.transaction_type===4);t.raw_json.transaction_type=0;
 const a=verifyReceiptRoot(r);assert(!a.receiptsRoot.match);assert(a.logsBloom.match);});
test('mixed block, duplicate log index and inconsistent cumulative gas reject before verification',()=>{
 for(const [mut,reason] of [
   [r=>logs(r)[0].block_hash='0x'+'00'.repeat(32),/different block/],
   [r=>logs(r)[1].log_index=0,/log index/],
   [r=>r.find(a=>a.row_kind==='transaction').raw_json.receipt_cumulative_gas_used='0',/cumulative gas/]
 ]){const r=fresh();mut(r);assert.throws(()=>verifyReceiptRoot(r),reason);}
});
test('typed receipt does not commit the supplied block hash or trace facts: scope is explicit',()=>{
 const r=fresh().map(w=>{const o=w.raw_json;const x='0x'+'11'.repeat(32);if(w.row_kind==='header')o.hash=x;else o.block_hash=x;return w;});
 r.push({row_kind:'trace',raw_json:{invented:true}});assert(verifyReceiptRoot(r).valid);
});
