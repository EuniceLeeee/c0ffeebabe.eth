import assert from 'node:assert/strict';
import test from 'node:test';
import {buildTree} from './trace-tree.mjs';

const hash='0x'+'ab'.repeat(32),block='0x'+'cd'.repeat(32);
const a=n=>'0x'+n.toString(16).padStart(40,'0'),A=a(10),B=a(11),C=a(12),CODE=a(99),EOA=a(4);
const topic='0x'+'ef'.repeat(32);
function row(p,from,to,subs=0,k='call',status=1){return {trace_address:p,trace_type:'call',call_type:k,from_address:from,to_address:to,subtraces:subs,status,input:'0x',output:'0x',value:'0'};}
const log=(i,emitter,data='0x')=>({log_index:i,log_address:emitter,topics:[topic],data});
const flat=(traces,logs=[],ok=1)=>({tx_hash:hash,block_hash:block,receipt_status:ok,traces,logs});
const receipt=(ls=[])=>({status:'0x1',transactionHash:hash,blockHash:block,logs:ls.map((x,i)=>({
  transactionHash:hash,blockHash:block,logIndex:i+17,address:x.address,data:x.data,topics:x.topics,removed:false}))});
const frame=(from,to,cs=[],type='CALL')=>({from,to,type,input:'0x',output:'0x',value:'0x0',calls:cs});
const raw=(a,n,pos=0,ord=0)=>({address:a,topics:[topic],data:'0x'+n.toString(16).padStart(2,'0'),index:ord,position:pos});
test('canonical: repeated same-emitter sibling calls do not uniquely own a log',()=>{
 const x=buildTree(flat([row('',EOA,A,2),row('0',A,B),row('1',A,B)],[log(138,B)]));
 assert.equal(x.logs[0].ownerPath,null);assert.deepEqual(x.logs[0].candidatePaths,['0','1']);assert.equal(x.logs[0].ownership,'ambiguous');
});
test('canonical: an unambiguous different emitter constrains the receipt sequence',()=>{
 const x=buildTree(flat([row('1',A,C),row('2',A,B),row('',EOA,A,3),row('0',A,B)],[log(38,B),log(39,C),log(40,B)]));
 assert.deepEqual(x.logs.map(l=>l.ownerPath),['0','1','2']);
 assert.equal(x.ownershipSource,'flat');assert.equal(x.nodes[0].path,'');
});
test('caller can emit before or after a nested call',()=>{
 const x=buildTree(flat([row('',EOA,A,1),row('0',A,B)],[log(17,A),log(18,B),log(19,A)]));
 assert.deepEqual(x.logs.map(l=>l.ownerPath),['','0','']);
});
test('delegate executes in parent context: flat physical owner ambiguous, logical one certain',()=>{
 const x=buildTree(flat([row('',EOA,A,1),row('0',A,CODE,0,'delegatecall')],[log(1,A)]));
 assert.deepEqual(x.logs[0].candidatePaths,['','0']);assert.equal(x.logs[0].logicalOwnerPath,'');
 assert.equal(x.nodes[1].contextAddress,A);assert.equal(x.nodes[1].to,CODE);
});
test('static or reverted descendant cannot log even if its local status says success',()=>{
 const x=buildTree(flat([row('',EOA,A,3),row('0',A,B,1,'call',0),row('0,0',B,C),row('1',A,B,1,'staticcall'),row('1,0',B,C),row('2',A,C)],
   [log(45,C)]));
 assert.equal(x.logs[0].ownerPath,'2');
 assert.equal(x.nodes.find(n=>n.path==='0,0').committed,false);
 assert.equal(x.nodes.find(n=>n.path==='1,0').staticContext,true);
});
test('no physical frame for emitter or contradictory physical ordering rejects entire transaction',()=>{
 const n=[row('',EOA,A,2),row('0',A,B),row('1',A,C)];
 assert.throws(()=>buildTree(flat(n,[log(87,B),log(88,EOA)])),/no possible/);
 assert.throws(()=>buildTree(flat(n,[log(88,C),log(89,B)])),/impossible/);
});
test('preserves create, selfdestruct and value precision without allowing a destruction to emit',()=>{
 const x=buildTree(flat([row('',EOA,A,2),{...row('0',A,B),trace_type:'create',call_type:null,value:'123456789012345678901'},
   {...row('1',A,C),trace_type:'suicide',call_type:null,input:null,output:null,value:'17'}],[log(13,B)]));
 assert.equal(x.nodes[1].value,'123456789012345678901');assert.equal(x.nodes[2].kind,'selfdestruct');
 assert.equal(x.logs[0].ownerPath,'0');assert.equal(x.nodes[2].value,'17');
});
for(const [label,traces] of [
 ['duplicate path',[row('',EOA,A,2),row('0',A,B),row('0',A,B)]],
 ['missing child',[row('',EOA,A,2),row('1',A,B)]],
 ['missing parent',[row('',EOA,A),row('0,0',A,B)]],
 ['invalid status',[row('',EOA,A,0,'call',2)]],
 ['invalid path',[row('',EOA,A,1),row('01',A,B)]],
 ['missing child count',[{...row('',EOA,A),subtraces:null}]],
 ['bad calldata',[{...row('',EOA,A),input:'0x3'}]]
])test(label+' rejected',()=>assert.throws(()=>buildTree(flat(traces)),/trace-tree:/));
test('duplicate, noncontiguous, or reversed receipt indexes rejected',()=>{
 for(const indices of [[1,1],[1,3],[2,1]])assert.throws(()=>buildTree(flat([row('',EOA,A)],indices.map(i=>log(i,A)))),/index/);
});
test('oracle: nested frame and receipt deduplicate; identical sibling events are not conflated',()=>{
 const x=raw(B,3,0,0), y=raw(B,3,0,1),r=frame(EOA,A,[{...frame(A,B),logs:[x]},{...frame(A,B),logs:[y]}]);
 const out=buildTree({trace:r,receipt:receipt([x,y])});
 assert.deepEqual(out.logs.map(l=>[l.idx,l.ownerPath,l.ownership]),[[17,'0','traced'],[18,'1','traced']]);
});
test('oracle verifies physical frame for delegate log, receipt authoritative on individual block index',()=>{
 const l=raw(A,1,0,17),r=frame(EOA,A,[{...frame(A,CODE,[],'DELEGATECALL'),logs:[l]}]);
 const x=buildTree({trace:r,receipt:receipt([l])});
 assert.equal(x.logs[0].ownerPath,'0');assert.equal(x.logs[0].logicalOwnerPath,'');assert.equal(x.logs[0].idx,17);
});
test('oracle with position but no indexes preserves parent/child emission order',()=>{
 const l1=raw(A,2,0),l2=raw(B,4,0),l3=raw(A,9,1);for(const l of [l1,l2,l3])delete l.index;
 const r={...frame(EOA,A,[{...frame(A,B),logs:[l2]}]),logs:[l1,l3]};
 assert.deepEqual(buildTree({trace:r,receipt:receipt([l1,l2,l3])}).logs.map(l=>l.ownerPath),['','0','']);
 assert.throws(()=>buildTree({trace:r,receipt:receipt([l1,l3,l2])}),/payload/);
});
test('oracle with indexes but no child position still verifies achievable EVM ordering',()=>{
 const x=raw(C,1,0,0),y=raw(B,2,0,1);delete x.position;delete y.position;
 const r=frame(EOA,A,[{...frame(A,B),logs:[y]},{...frame(A,C),logs:[x]}]);
 assert.throws(()=>buildTree({trace:r,receipt:receipt([x,y])}),/impossible/);
});
test('mismatched or incomplete oracle evidence does not overwrite the receipt',()=>{
 const x=raw(B,1,0,0),y=raw(B,2,0,1),r=frame(EOA,A,[{...frame(A,B),logs:[x]}]);
 assert.throws(()=>buildTree({trace:r,receipt:receipt([x,y])}),/count/);
 assert.throws(()=>buildTree({trace:r,receipt:receipt([y])}),/payload/);
 const modified=receipt([x]);modified.logs[0].transactionHash=block;assert.throws(()=>buildTree({trace:r,receipt:modified}),/transaction/);
});
test('fully absent withLog is explicit fallback, not traced attribution',()=>{
 const l=raw(B,6),r=frame(EOA,A,[frame(A,B)]);
 const out=buildTree({trace:r,receipt:receipt([l])});assert.equal(out.ownershipSource,'flat-no-frame-logs');assert.equal(out.logs[0].ownership,'unique');
});
test('failed tx cannot produce receipt logs',()=>{
 const m=flat([row('',EOA,A,0,'call',0)],[log(17,A)],0);assert.throws(()=>buildTree(m),/reverted/);
 assert.throws(()=>buildTree({...m,logs:[],receipt_status:1}),/root\/receipt/);
});
test('binding to available envelope rejects wrong sender, destination and calldata',()=>{
 const t=flat([row('',EOA,A)]);
 for(const extra of [{from_address:C},{to_address:C},{input:'0x01'}])assert.throws(()=>buildTree({...t,...extra}),/envelope/);
 assert.throws(()=>buildTree({trace:frame(EOA,A),receipt:{...receipt(),contractAddress:A}}),/creation/);
});
test('partially present nested positions must agree with receipt order also when indexes are present',()=>{
 const x=raw(A,1,1,0),y=raw(B,2,0,1);delete y.position;
 const r={...frame(EOA,A,[{...frame(A,B),logs:[y]}]),logs:[x]};
 assert.throws(()=>buildTree({trace:r,receipt:receipt([x,y])}),/impossible/);
});
test('committed destruction must name its beneficiary and state the amount including true zero',()=>{
 const d={...row('0',A,C),trace_type:'suicide',call_type:null,input:null,output:null,value:'0'};
 for(const bad of [{value:null},{to_address:null}])assert.throws(()=>buildTree(flat([row('',EOA,A,1),{...d,...bad}])),/value|beneficiary/);
 assert.equal(buildTree(flat([row('',EOA,A,1),d])).nodes[1].value,'0');
 const f={...frame(A,B),type:'SELFDESTRUCT',value:'0x1'};delete f.value;
 assert.throws(()=>buildTree({trace:frame(EOA,A,[f]),receipt:receipt()}),/value/);
});
test('every entered child is sent by execution context, not EOA or delegate code address',()=>{
 const tx=[row('',EOA,A,1),row('0',A,CODE,1,'delegatecall'),row('0,0',A,B)];
 assert.equal(buildTree(flat(tx)).nodes[2].from,A);
 for(const bad of [EOA,CODE,C])assert.throws(()=>buildTree(flat([tx[0],tx[1],{...tx[2],from_address:bad}])),/child sender/);
});
