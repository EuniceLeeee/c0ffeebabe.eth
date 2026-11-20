import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';import os from 'node:os';import {join} from 'node:path';
import {ready21,checkReady21,exportPriceEdges,saveQueryStage} from './selector-window.mjs';
import {candidateCoordinateFields} from './selector-candidate-instances-sql.mjs';
import {sha} from './selector-query-client.mjs';
import {renderV4TraceReceiptKeys} from './selector-sql-sources/v4-trace-receipt-keys.mjs';
import {renderSelectorReceiptLayouts} from './selector-sql-sources/receipt-layouts.mjs';
import {canonicalSwapTopics} from './selector-sql-sources/canonical-swap-census.mjs';
import {loadSqlPriceEdges} from '../listener/src/searcher/sql-edge-price-index.ts';
test('Ready21 preset pins both bounds, chain head and full transaction coverage',()=>{
 assert.doesNotThrow(()=>checkReady21({...ready21}));
 for(const different of [{fromBlock:ready21.fromBlock-1},{toBlock:ready21.toBlock+1},{transactions:'1'},{headHash:'0x'+'0'.repeat(64)}]){
   assert.throws(()=>checkReady21({...ready21,...different}),/Ready21 window/);
 }
});
test('standard SQL export produces immutable, ordered, directly price-loadable files',async t=>{
 const dir=fs.mkdtempSync(join(os.tmpdir(),'selector-prices-out-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const addr=n=>'0x'+n.repeat(40),base={chainId:1,selector:'0x12345678',poolAddress:addr('9'),poolNamespace:null,poolId:null,
   tokenIn:addr('1'),tokenInId:null,tokenOut:addr('2'),tokenOutId:null,observedTargetSelector:true,familyIds:['one'],verified:false};
 const rows=[base,{...base,tokenIn:base.tokenOut,tokenOut:base.tokenIn}].map(e=>({...e,
   candidateInstanceKey:'candidate-edge:v1:'+sha(JSON.stringify(candidateCoordinateFields.map(k=>k==='chainId'?'1':e[k])))}));
 const a=exportPriceEdges(dir,rows,ready21),b=exportPriceEdges(dir,[...rows].reverse(),ready21,true);assert.deepEqual(a,b);
 const loaded=await loadSqlPriceEdges(join(dir,a.fixedManifest));assert.equal(loaded.edges.length,2);
 assert.deepEqual(loaded.edges.map(e=>e.candidateInstanceKey),rows.map(e=>e.candidateInstanceKey).sort());
 assert.throws(()=>exportPriceEdges(dir,rows.map(e=>({...e,tokenIn:addr('3')})),ready21,true));
});
const real=process.env.SELECTOR_SQL_EDGE_REFERENCE_DIR;
test('same 4,930 real SQL candidates reproduce exact compressed table and price manifest digests',{skip:!real},async t=>{
 const dir=fs.mkdtempSync(join(os.tmpdir(),'selector-prices-out-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const rows=JSON.parse(fs.readFileSync(join(real,'edges.json')));
 const r=exportPriceEdges(dir,rows.reverse(),ready21);const loaded=await loadSqlPriceEdges(join(dir,r.fixedManifest));
 assert.equal(loaded.edges.length,4930);assert.equal(loaded.manifest.edgeSha256,'3538d508a3eb2e731530518bedf2dbd89fc0799e687219fe6da0ee72e7b95cd8');
 assert.equal(r.sortedNdjsonSha256,'f13253d6b04a29441ed348ff7f210d09505681646080c962fbcfcb00601fa819');
 assert.equal(r.fixedManifestSha256,'e83be9fa6760ca8570143c180988b783a3a8f9933d834be387ebfb427e867102');
});
test('an interrupted query may reopen byte-identical stages, never overwrite a different SQL, receipt or window',()=>{
 const dir=fs.mkdtempSync(join(os.tmpdir(),'selector-resume-'));
 saveQueryStage(dir,'receipts.sql','original',false);saveQueryStage(dir,'receipts.sql','original',true);
 assert.throws(()=>saveQueryStage(dir,'receipts.sql','changed',true));assert.equal(fs.readFileSync(join(dir,'receipts.sql'),'utf8'),'original');
 const request={jobId:'J',estimate:10};saveQueryStage(dir,'receipts-request.json',request,true);saveQueryStage(dir,'receipts-request.json',request,true);
 assert.throws(()=>saveQueryStage(dir,'receipts-request.json',{...request,estimate:11},true));
 assert.throws(()=>saveQueryStage(dir,'../window.json',{},true));
});


test('trace and receipt queries share the signed Manager Swap and indexed pool ID checks',async()=>{
 const window={...ready21,firstTime:'2026-11-09T14:17:23.000000Z',lastTime:'2026-11-09T15:59:59.000000Z'};
 const selector='0x48c89491';
 const rules=[{familyId:'execution:'+selector+':abi-'+'a'.repeat(64),
   callPatterns:[{selector}],logPatterns:[{topic:canonicalSwapTopics.v4}]}];
 const [trace,receipt]=await Promise.all([
   renderV4TraceReceiptKeys({window,source:'test-project.Dataset.sealed_traces',rules}),
   renderSelectorReceiptLayouts(window,{v4CalldataKeys:true,v4NativeReceiptKeys:true}),
 ]);
 const validator=sql=>sql.slice(sql.indexOf('v4_valid_swaps AS'),sql.indexOf('v4_calldata_receipts AS'));
 assert.equal(validator(trace),validator(receipt));
 assert(validator(trace).includes("REGEXP_CONTAINS(s.topics[SAFE_OFFSET(1)],r'^0x[0-9a-f]{64}$')"));
 assert(trace.includes("LEFT(f.input, 10) = '0xf3cd914c'"));
 assert(trace.includes("LEFT(unlock.input, 10) = '0x48c89491'"));
 assert(trace.includes("f.sender = addr(s.topics[SAFE_OFFSET(2)])"));
 assert(trace.includes("f.poolId = s.poolId"));
 assert(trace.includes("f.zeroForOne = (signw(word(s.d, 0)) = -1)"));
 await assert.rejects(renderV4TraceReceiptKeys({window,source:'test-project.Dataset.sealed_traces',rules:[]}),
   /declared Manager Swap binding/);
});
