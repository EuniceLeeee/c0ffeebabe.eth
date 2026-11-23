import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';import os from 'node:os';import {join} from 'node:path';
import {ready21,checkReady21,saveQueryStage} from './selector-window.mjs';
test('Ready21 preset pins both bounds, chain head and full transaction coverage',()=>{
 assert.doesNotThrow(()=>checkReady21({...ready21}));
 for(const different of [{fromBlock:ready21.fromBlock-1},{toBlock:ready21.toBlock+1},{transactions:'1'},{headHash:'0x'+'0'.repeat(64)}]){
   assert.throws(()=>checkReady21({...ready21,...different}),/Ready21 window/);
 }
});
test('an interrupted query may reopen byte-identical stages, never overwrite a different SQL, receipt or window',()=>{
 const dir=fs.mkdtempSync(join(os.tmpdir(),'selector-resume-'));
 saveQueryStage(dir,'receipts.sql','original',false);saveQueryStage(dir,'receipts.sql','original',true);
 assert.throws(()=>saveQueryStage(dir,'receipts.sql','changed',true));assert.equal(fs.readFileSync(join(dir,'receipts.sql'),'utf8'),'original');
 const request={jobId:'J',estimate:10};saveQueryStage(dir,'receipts-request.json',request,true);saveQueryStage(dir,'receipts-request.json',request,true);
 assert.throws(()=>saveQueryStage(dir,'receipts-request.json',{...request,estimate:11},true));
 assert.throws(()=>saveQueryStage(dir,'../window.json',{},true));
});
