import test from 'node:test';import assert from 'node:assert/strict';import {reconcile} from './discover.mjs';import {corroborate} from './corroborate.mjs';
const a='0x'+'aa'.repeat(20),b='0x'+'bb'.repeat(20),c='0x'+'cc'.repeat(20),sel='0x12345678',hash='0x'+'11'.repeat(32),block='0x'+'22'.repeat(32);
const nodes=['','0'].map((path,i)=>({path,parent:i?'':null,kind:'call',to:b,from:a,committed:true,staticContext:false,input:sel}));
const tree={txHash:hash,nodes,logs:[{idx:11},{idx:12}],ownershipSource:'flat'}, enabled=new Set([sel]);
const edge=(path,idx)=>({path,selector:sel,poolAddress:b,poolId:null,tokenIn:a,tokenOut:c,amountInRaw:'5',amountOutRaw:'4',evidenceLogIndices:[idx]});
test('shared receipt invalidates BOTH claimants',()=>{const r=reconcile(tree,enabled,[{edges:[edge('',11)],unresolved:[]},{edges:[edge('0',11)],unresolved:[]}]);assert.equal(r.observations.length,0);assert.equal(r.unresolved.length,2);});
test('separate receipts: one direction, two observations, no synthetic reverse',()=>{const r=reconcile(tree,enabled,[{edges:[edge('',11),edge('0',12)],unresolved:[]}]);assert.equal(r.observations.length,2);assert.deepEqual(r.edgeDirections,[[sel,b,'',a,c]]);});
test('invalid witness index rejected',()=>assert.throws(()=>reconcile(tree,enabled,[{edges:[edge('',21)],unresolved:[]}])));
test('miss and unsupported selector stay visible',()=>assert.equal(reconcile(tree,enabled,[{edges:[],unresolved:[]}]).unresolved.length,2));
const log={address:b,topics:[hash],data:'0x',index:'0x0',position:'0x0'};
function fixture(){const sql={tx_hash:hash,block_hash:block,block_number:10,transaction_index:0,receipt_status:1,traces:[{trace_address:'',trace_type:'call',call_type:'call',from_address:a,to_address:b,input:sel,output:'0x',status:1,subtraces:0,value:'0'}],logs:[{log_index:10,log_address:b,topics:[hash],data:'0x'}]};
 const native={trace:{type:'CALL',from:a,to:b,input:sel,output:'0x',value:'0x0',logs:[log]},receipt:{transactionHash:hash,blockHash:block,blockNumber:'0xa',transactionIndex:'0x0',status:'0x1',from:a,to:b,logs:[{...log,logIndex:'0xa'}]}};return [sql,native];}
test('a witness cannot overwrite SQL fields or use its own path ordinal',()=>{const [s,n]=fixture();const r=corroborate(s,n);assert.equal(r.logs[0].ownerPath,'');assert.equal(r.nodes[0].input,sel);});
test('cannot corroborate mismatched SELFDESTRUCT value',()=>{const [s,n]=fixture();s.traces[0].subtraces=1;s.traces.push({trace_address:'0',trace_type:'suicide',status:1,subtraces:0,from_address:b,to_address:c,value:'0'});
  n.trace.calls=[{type:'SELFDESTRUCT',from:b,to:c,value:'0x11'}];assert.throws(()=>corroborate(s,n),/mismatch/);});
test('mismatched block, input, receipt, missing effects and absent ownership rejected',()=>{for(const edit of [n=>n.receipt.blockNumber='0xb',n=>n.trace.input='0x',n=>n.receipt.logs[0].data='0x00',n=>n.trace.calls=[{type:'CALL',from:b,to:c,value:'0x0',input:'0x',output:'0x'}],n=>delete n.trace.logs]){const [s,n]=fixture();edit(n);assert.throws(()=>corroborate(s,n));}});
