import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyRawBlock} from './raw-input.mjs';
const hash='0x'+'11'.repeat(32), tx='0x'+'22'.repeat(32), a='0x'+'33'.repeat(20), b='0x'+'44'.repeat(20);
const control={header:{hash,transaction_count:1},txs:{n:1,distinct_hashes:1,failed:0},frames:{n:1,system_rows:0,roots:1,failed:0},receipt_logs:{n:0,distinct_indices:0,first_idx:null,last_idx:null}};
function verify(to,kind,receiptAddr=null){
 const common={block_hash:hash,block_number:1,from_address:a,input:'0x',value:'0',transaction_index:0};
 const rows=[['header',{hash,number:1,transaction_count:1}],['transaction',{...common,to_address:to,hash:tx,receipt_contract_address:receiptAddr,receipt_status:1}],
 ['trace',{...common,to_address:b,transaction_hash:tx,trace_type:kind,call_type:kind==='call'?'call':null,status:1,trace_address:'',subtraces:0,output:'0x'}]]
 .map(([row_kind,obj])=>({row_kind,raw_json:JSON.stringify(obj)}));return verifyRawBlock(rows,{height:1,hash,control});
}
test('root kind binds transaction recipient and a successful creation binds its receipt contract',()=>{
 assert.equal(verify(b,'call').rows.length,1);assert.equal(verify(null,'create',b).rows.length,1);
 assert.throws(()=>verify(null,'call'),/creation root/);assert.throws(()=>verify(b,'create',b),/root CALL/);
 assert.throws(()=>verify(null,'create',a));assert.throws(()=>verify(null,'create',null));
});
