import assert from 'node:assert/strict';
import test from 'node:test';
import {traceCallFlows} from './trace-call-flows.mjs';
import {poolIdLayouts} from './trace-pool-id.mjs';
import {canonicalSwapTopics} from './canonical-swap-decode.mjs';

const w=n=>BigInt.asUintN(256,BigInt(n)).toString(16).padStart(64,'0');
const a=n=>'0x'+w(n).slice(-40);
const actor=a(14),other=a(15),party=a(31),token=a(101),native=a(0);
const layout=poolIdLayouts[0], venue=layout.emitter, action=layout.action;
const rule={mode:'counterparty-net',returnBits:128,counterpartyArg:4,amountSign:'caller',entrySelector:layout.entry,
   batch:{callback:'0x91dd7346',pay:'0x11da60b4',take:'0x0b0d9c09'}};
const cfg={native,amountSwapSelector:'0x022c0d9f',amountSwapTopic:canonicalSwapTopics.v2,
  transferTopic:'0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
  settlementProofs:{[action]:rule}};
const topicAddr=x=>'0x'+w(x);
const call=(path,sender,target,input='0x',output=null,value='0',kind='call')=>({path,sender,target,input,output,kind,ok:true,value});
function sample(){
  const step=action+[native,token,3000,60,party,1,-20,1,288,0].map(w).join(''),pid=layout.call({input:step,target:venue,sender:actor}).poolId;
  const frames=[
    call('',other,actor,'0x0a0b0c0d'),call('0',actor,venue,layout.entry),call('0,0',venue,actor,'0x91dd7346'),
    call('0,0,0',actor,venue,step,'0x'+w((BigInt.asUintN(128,-20n)<<128n)|50n)),
    call('0,0,0,0',venue,party,'0x23aa2344'),
    call('0,0,0,0,0',party,venue,'0xaaaa0001'),
    call('0,0,0,0,0,0',venue,token,'0x70a08231'+w(venue),'0x'+w(100),0,'staticcall'),
    call('0,0,0,0,1',party,token,'0xaabbccdd'),
    call('0,0,0,0,2',party,venue,'0xaaaa0002'),
    call('0,0,0,0,2,0',venue,token,'0x70a08231'+w(venue),'0x'+w(150),0,'staticcall'),
    call('0,0,0,0,3',party,venue,'0xaaaa0003'),call('0,0,0,0,3,0',venue,party,'0x',null,'20'),
  ];
  const logs=[{idx:40,emitter:token,topics:[cfg.transferTopic,topicAddr(native),topicAddr(venue)],data:'0x'+w(50)},
    {idx:41,emitter:venue,topics:[layout.topic,pid,topicAddr(actor)],data:'0x'+[0,0,100,150,0,3000].map(w).join('')}];
  return {frames,logs,pid};
}
const edges=({frames,logs,pid},config=cfg)=>traceCallFlows(frames,logs,config).filter(e=>e.poolId===pid);
test('two-sided action-scoped settlement corroborates an identity-only event without adding payment legs',()=>{
  const [edge,...rest]=edges(sample());assert.equal(rest.length,0);assert.equal(edge.selector,layout.entry);
  assert.equal(edge.innerSwapPath,'0,0,0');assert.equal(edge.tokenIn,native);assert.equal(edge.tokenOut,token);
  assert.equal(edge.evidence,layout.settlementEvidence);assert.equal(edge.receiptIndices,'40,41');
});
test('normal signed event path stays unchanged, even without settlement or returns',()=>{
  const x=sample(); x.frames[3].output=null;
  x.logs[1].data='0x'+[-20,50,100,150,0,3000].map(w).join('');
  assert.equal(edges(x)[0].evidence,layout.evidence);
});
for(const [name,alter] of [
  ['missing native-side witness',x=>x.frames.at(-1).value='0'],
  ['reverted native-side parent',x=>x.frames.at(-2).ok=false],
  ['missing token receipt',x=>x.logs.shift()],
  ['mismatched balance',x=>x.frames[9].output='0x'+w(149)],
  ['mismatched return direction',x=>x.frames[3].output='0x'+w((20n<<128n)|BigInt.asUintN(128,-50n))],
  ['event partial or malformed',x=>x.logs[1].data='0x'+[0,50,100,150,0,3000].map(w).join('')],
  ['ambiguous event action',x=>x.logs.push({...x.logs[1],idx:42})],
  ['right amount at wrong account',x=>x.frames.at(-1).target=other],
  ['competing residual token calls',x=>x.frames.splice(8,0,call('0,0,0,0,1,0',token,token,'0x11111111'))],
  ['receipt actually belongs to another action',x=>{x.frames.push(call('0,0,1',actor,token,'0xaabbccdd'));x.logs[0].idx=42;x.logs.reverse();}],
  ['receipt placement ambiguous with another call',x=>{x.frames.splice(7,0,call('0,0,0,0,0,1',venue,token,'0xaabbccdd'));}],
  ['duplicate equal residual receipts',x=>x.logs.unshift({...x.logs[0],idx:39})],
  ['unaccounted venue payment in same CALL',x=>x.logs.unshift({idx:39,emitter:token,topics:[cfg.transferTopic,topicAddr(venue),topicAddr(other)],data:'0x'+w(7)})],
]) test(name+' does not prove both sides',()=>{const x=sample();alter(x);assert.equal(edges(x).length,0);});
test('return evidence not declared means no new edge',()=>assert.deepEqual(edges(sample(),{...cfg,settlementProofs:{}}),[]));
test('a different owning entry cannot reuse the layout',()=>assert.deepEqual(
  edges(sample(),{...cfg,settlementProofs:{[action]:{...rule,entrySelector:'0x12345678'}}}),[]));

function deferred(){
  const {frames:old,logs:oldLogs,pid}=sample(), f=old.slice(0,4), id=oldLogs[1], methods=rule.batch;
  f.push({...f[3],path:'0,0,1',output:'0x'+w((BigInt.asUintN(128,-12n)<<128n)|27n)},
    call('0,0,2',actor,venue,methods.pay,null,'32'),
    call('0,0,3',actor,venue,methods.take+w(token)+w(actor)+w(77)),
    call('0,0,3,0',venue,token,'0xa9059cbb'+w(actor)+w(77),'0x'+w(1))
  );
  return {pid,frames:f,logs:[{...id,idx:10},{...id,idx:11},
    {idx:12,emitter:token,topics:[cfg.transferTopic,topicAddr(venue),topicAddr(actor)],data:'0x'+w(77)}]};
}
test('disjoint same-direction returns with one group settlement consume its cash only once',()=>{
  const out=edges(deferred());assert.equal(out.length,2);assert.deepEqual(out.map(x=>x.innerSwapPath),['0,0,0','0,0,1']);
  assert.deepEqual(out.map(x=>x.receiptIndices),['10,12','11']);assert.equal(out[0].selector,layout.entry);
});
for(const [name,alter] of [
  ['one side not transferred',x=>x.logs.pop()],
  ['different input total',x=>x.frames[5].value='33'],
  ['duplicate actor payment',x=>x.frames.push(call('0,0,4',actor,venue,rule.batch.pay,null,'32'))],
  ['unrelated state mutation',x=>x.frames.push(call('0,0,4',actor,venue,'0x12345678'))],
  ['unrelated action inside hook',x=>x.frames.splice(4,0,call('0,0,0,0',venue,other,'0x12345678'))],
  ['outside recipient',x=>x.frames[6].input=rule.batch.take+w(token)+w(other)+w(77)],
  ['unaccounted venue payment during payout',x=>x.logs.push({idx:13,emitter:token,topics:[cfg.transferTopic,topicAddr(venue),topicAddr(other)],data:'0x'+w(7)})],
  ['unaccounted actor payment during payout',x=>x.logs.push({idx:13,emitter:token,topics:[cfg.transferTopic,topicAddr(other),topicAddr(actor)],data:'0x'+w(7)})],
  ['missing return for one constituent',x=>x.frames[4].output=null],
  ['opposite swap in same group',x=>{x.frames[4].input=x.frames[4].input.slice(0,10+5*64)+w(0)+x.frames[4].input.slice(10+6*64);x.frames[4].output='0x'+w((12n<<128n)|BigInt.asUintN(128,-27n));}],
]) test('group rejects '+name,()=>{const x=deferred();alter(x);assert.deepEqual(edges(x),[]);});
for(const [label,make,expected] of [['action',sample,1],['group',deferred,2]]) test(label+' ignores independently placed unrelated same-account sibling transfer',()=>{
  const x=make(), marker=a(985), idx=x.logs.at(-1).idx+1;
  x.frames.push(call('1',x.frames[0].target,marker,'0x99889988'),call('1,0',marker,token,'0x22334455'));
  x.logs.push({idx,emitter:marker,topics:[],data:null},
    {idx:idx+1,emitter:token,topics:[cfg.transferTopic,topicAddr(venue),topicAddr(other)],data:'0x'+w(7)});
  assert.equal(edges(x).length,expected);
});
