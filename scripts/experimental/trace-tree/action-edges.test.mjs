import {test} from 'node:test';
import assert from 'node:assert/strict';
import {extractEdges} from './action-edges.mjs';
import cfg from './action-rules.json' with {type:'json'};
import {buildTree} from './trace-tree.mjs';
const addr=n=>'0x'+n.toString(16).padStart(40,'0'),w=n=>BigInt(n).toString(16).padStart(64,'0'),topic=n=>'0x'+w(n);
const [zero,pool,asset,payer,receiver,owner,other]=[0,10,11,12,13,14,15].map(addr);
const sels=Object.keys(cfg.actions);
const log=(idx,emitter,topics,data,ownerPath)=>({idx,emitter,topics,data,ownerPath,candidatePaths:[ownerPath],ownership:'traced'});
const transfer=(i,t,f,to,amt,p)=>log(i,t,[cfg.transfer.topic,topic(f),topic(to)],topic(amt),p);
const call=(path,parent,from,to,input,output)=>({path,parent,kind:'call',from,to,contextAddress:to,input,output,value:'0',committed:true});
function scenario(s=sels[0]){
  const issue=[sels[0],sels[1]].includes(s), reverseAmount=[sels[1],sels[3]].includes(s),key=issue?'issue':'retire';
  const assets=309n,shares=299n,amount=reverseAmount?shares:assets,ret=reverseAmount?assets:shares;
  const n=call('',null,payer,pool,s+w(amount)+w(receiver)+(issue?'':w(owner)),topic(ret));
  const t=call('0','',pool,asset,issue?'0x23b872dd'+w(payer)+w(pool)+w(assets):'0xa9059cbb'+w(receiver)+w(assets),topic(1));
  const a=issue?transfer(0,asset,payer,pool,assets,'0'):transfer(0,asset,pool,receiver,assets,'0');
  const b=issue?transfer(1,pool,zero,receiver,shares,''):transfer(1,pool,owner,zero,shares,'');
  const e=log(2,pool,[cfg.events[key].topic,topic(payer),topic(receiver),...(issue?[]:[topic(owner)])],'0x'+w(assets)+w(shares),'');
  return {nodes:[n,t],logs:[a,b,e]};
}
const run=(t,enabledSelectors=sels)=>extractEdges(t,{enabledSelectors});
for(const s of sels)test('decode '+s+' with both independently observed amounts',()=>{
  const {edges,unresolved}=run(scenario(s));assert.equal(unresolved.length,0);assert.equal(edges.length,1);
  const inc=[sels[0],sels[1]].includes(s),e=edges[0];assert.deepEqual([e.selector,e.poolAddress,e.poolId,e.tokenIn,e.tokenOut,e.amountInRaw,e.amountOutRaw,e.path],[s,pool,null,inc?asset:pool,inc?pool:asset,inc?'309':'299',inc?'299':'309','']);assert.deepEqual(e.evidenceCallPaths,['0']);assert.deepEqual(new Set(e.evidenceLogIndices),new Set([0,1,2]));
});
test('no positive claim under disabled conversion, unknown selector explicitly unresolved',()=>{
  const t=scenario();assert.deepEqual(run(t,[]),{edges:[],unresolved:[]});t.nodes[0].input='0x12345678'+t.nodes[0].input.slice(10);
  assert.equal(run(t,['0x12345678']).unresolved[0].reason,'selector-semantics-not-modelled');
});
test('receipt cannot override false or malformed payment return; no-return still needs the exact attributed receipt',()=>{
  for(const output of [topic(0),topic(2),'0x01','0x00','0x'+w(1)+w(0)]){
    const t=scenario();t.nodes[1].output=output;assert.equal(run(t).edges.length,0);
  }
  for(const output of [null,'0x']){
    const t=scenario();t.nodes[1].output=output;assert.equal(run(t).edges.length,1);
    t.logs[0].data=topic(308);assert.equal(run(t).edges.length,0);
    t.logs.shift();assert.equal(run(t).edges.length,0);
  }
});
test('transfer/approve/callback may provide evidence, cannot become an edge',()=>{
  for(const sel of ['0xa9059cbb','0x095ea7b3','0x91dd7346']){
    const t=scenario();t.nodes[0].input=sel+t.nodes[0].input.slice(10);
    assert.deepEqual(run(t,[sel]).unresolved.map(r=>r.reason),['evidence-only-selector']);
  }
});
test('delegate and callcode ownership is execution-context based, no second conversion',()=>{
  for(const k of ['delegatecall','callcode']){
    const t=scenario(), d={...t.nodes[0],path:'1',parent:'',kind:k,from:pool,to:other,contextAddress:pool};t.nodes.push(d);
    t.logs[1].ownerPath='1';t.logs[2].ownerPath='1';const r=run(t);assert.equal(r.edges.length,1);assert.equal(r.edges[0].path,'');
  }
});
test('misbound owners, different recipient, incorrect amount, zero amounts or uncommitted ancestor reject',()=>{
  for(const fn of [
    t=>t.logs[0].ownerPath='',t=>t.logs[1].topics[2]=topic(other),t=>t.logs[2].topics[1]=topic(other),
    t=>t.nodes[0].output=topic(301),t=>t.nodes[0].output=topic(0),
    t=>t.nodes[1].input=t.nodes[1].input.slice(0,-64)+w(123),t=>t.nodes[1].committed=false,t=>t.nodes[0].committed=false]){
    const t=scenario();fn(t);assert.equal(run(t).edges.length,0);
  }
});
test('two present payments, or an extra credit, refund, fee or deduction are not silently ignored',()=>{
  for(const mutate of [
    t=>t.logs.push({...t.logs[0],idx:3}),t=>t.logs.push(transfer(3,asset,other,pool,1,'0')),
    t=>t.logs.push(transfer(3,asset,pool,payer,3,'0')),t=>t.logs.push(transfer(3,pool,receiver,other,1,'')),
    t=>t.logs.push(transfer(3,asset,payer,other,1,'0'))]){
      const t=scenario();mutate(t);assert.equal(run(t).edges.length,0);
    }
});
test('same selector elsewhere does not give an outer action ownership of an inner payment',()=>{
  const t=scenario();t.nodes.push({...t.nodes[0],path:'1',parent:'',to:other,contextAddress:other});t.nodes[1].parent='1';t.nodes[1].path='1,0';t.logs[0].ownerPath='1,0';
  assert.equal(run(t).edges.length,0);
});
test('fully witnessed custody forwarding is not another user-side payment; a fee or refund to the economic endpoint is',()=>{
  const t=scenario();t.nodes.push(call('1','',pool,asset,'0xa9059cbb'+w(other)+w(309),topic(1)));t.logs.push(transfer(3,asset,pool,other,309,'1'));assert.equal(run(t).edges.length,1);
  t.nodes[2].input='0xa9059cbb'+w(payer)+w(309);t.logs[3].topics[2]=topic(payer);assert.equal(run(t).edges.length,0);
});
test('nested disabled known converter or enabled unmodelled action still isolates its transfers',()=>{
  for(const s of [sels[2],'0x01020304']){
    const t=scenario();t.nodes.push({...t.nodes[0],path:'1',parent:'',input:s});t.nodes[1].parent='1';t.nodes[1].path='1,0';t.logs[0].ownerPath='1,0';
    assert.equal(run(t,[sels[0],'0x01020304']).edges.length,0);
  }
});
test('ambiguous conversion event shared by different logical owners cannot be scored twice',()=>{
  const t=scenario();t.nodes.push({...t.nodes[0],path:'1',parent:''});t.logs[2].ownership='ambiguous';t.logs[2].ownerPath=null;t.logs[2].candidatePaths=['','1'];
  assert.equal(run(t).edges.length,0);
});
test('unplaced same-token payment or missing side rejects; separate sibling activity is not part of action',()=>{
  const t=scenario();t.logs[0].ownerPath=null;t.logs[0].ownership='unattributed';assert.equal(run(t).edges.length,0);
  const missing=scenario();missing.logs=missing.logs.slice(1);assert.equal(run(missing).edges.length,0);
  const tree=scenario();tree.nodes.forEach(n=>{n.path='0'+(n.path?','+n.path:'');n.parent=n.parent==null?'':'0';});tree.logs.forEach(l=>{l.ownerPath='0'+(l.ownerPath?','+l.ownerPath:'');});tree.nodes.unshift(call('',null,other,other,'0x12345678','0x'));tree.nodes.push(call('1','',payer,asset,'0xa9059cbb'+w(other)+w(1),topic(1)));tree.logs.push(transfer(3,asset,payer,other,1,'1'));assert.equal(run(tree).edges.length,1);
});
test('duplicate identifiers rejected rather than being counted as independent proof',()=>{
  const t=scenario();t.logs.push({...t.logs[0]});assert.throws(()=>run(t),/duplicate receipt index/);
  const s=scenario();s.nodes.push({...s.nodes[0]});assert.throws(()=>run(s),/duplicate frame path/);
});
test('pool manager multi-asset calls and settlement-only cases do not degrade to manager address as pool',()=>{
  const t=scenario(),s='0xf3cd914c';t.nodes[0].input=s+t.nodes[0].input.slice(10);
  const r=run(t,[s]);assert.equal(r.edges.length,0);assert.equal(r.unresolved.length,1);
});
function flatLike({ambiguousPayment=false,ambiguousMint=false}={}){
  const t=scenario(),act=t.nodes[0],p=t.nodes[1];act.path='1';act.parent='';p.path='1,0';p.parent='1';
  for(const l of t.logs){l.ownership='unique';l.ownerPath=l.idx===0?'1,0':'1';l.candidatePaths=[l.ownerPath];}
  const sibling=call('5','',payer,pool,'0xa9059cbb'+w(other)+w(299),topic(1));
  t.nodes=[call('',null,other,payer,'0x02030405','0x'),act,p,sibling];
  const unbind=(l,ps)=>Object.assign(l,{ownership:'ambiguous',ownerPath:null,candidatePaths:ps});
  unbind(t.logs[2],['1','5']);if(ambiguousMint)unbind(t.logs[1],['1','5']);
  if(ambiguousPayment){t.nodes.push(call('6','',payer,asset,'0x095ea7b3'+w(other)+w(309),topic(1)));unbind(t.logs[0],['1,0','6']);}
  return t;
}
test('both proved monetary sides are informative, not a confirmed edge when the action event is ambiguous',()=>{
  const t=flatLike(),r=run(t);assert.equal(r.edges.length,0);
  const e=r.observedActions[0];assert.equal(e.evidenceMode,'action-economic');assert.equal(e.economicEvidence.eventPhysicalOwnership,'ambiguous');
  assert.deepEqual(e.economicEvidence.eventPhysicalCandidates,['1','5']);assert.deepEqual(e.economicEvidence.missingProof,['receipt-to-action-attribution-remains-unproved']);
  assert.equal(t.logs.at(-1).ownerPath,null);
});
test('post-only and bracketed recipient balances remain distinct, neither overrides an ambiguous settlement',()=>{
  const t=flatLike({ambiguousMint:true}),br=(p,val)=>({...call(p,'',payer,pool,'0x70a08231'+w(receiver),topic(val)),kind:'staticcall',staticContext:true});
  t.nodes.splice(3,0,br('2',399));
  let r=run(t);assert.equal(r.edges.length,0);assert.equal(r.observedActions.length,1);assert.equal(r.observedActions[0].tier,'provisional');assert.equal(r.observedActions[0].economicEvidence.sides[1].accountBalance.postOnly,'2');
  t.nodes.splice(1,0,br('0',100));r=run(t);assert.equal(r.edges.length,0);
  assert.deepEqual(r.observedActions[0].economicEvidence.sides[1].accountBalance,{proven:true,pre:'0',post:'2',before:'100',after:'399'});
  t.nodes.find(x=>x.path==='2').output=topic(398);r=run(t);assert.equal(r.edges.length,0);assert.equal(r.observedActions,undefined);
});
test('duplicate sibling converter or prior unrelated same-amount event is not a confirmed or provisional action',()=>{
  const t=flatLike({ambiguousMint:true}),clone={...t.nodes[1],path:'7',parent:''};t.nodes.push(clone);
  let r=run(t);assert.equal(r.edges.length,0);assert.equal(r.observedActions,undefined);
  const diff=flatLike({ambiguousMint:true});Object.assign(diff.logs[2],{ownership:'unique',ownerPath:'5',candidatePaths:['5']});
  r=run(diff);assert.equal(r.edges.length,0);assert.equal(r.observedActions,undefined);
});
test('conflicting same-amount payment, separated nested payment, false return and known fee cannot generate observations',()=>{
  for(const alter of [
    t=>{t.nodes.push({...t.nodes[2],path:'8',parent:''});t.logs[0].candidatePaths.push('8');},
    t=>{t.nodes.push({...t.nodes[1],path:'1,4',parent:'1',input:sels[3],to:other,contextAddress:other});t.nodes[2].parent='1,4';},
    t=>{t.nodes[2].output=topic(0);},
    t=>{t.logs.push({...transfer(9,asset,payer,other,1,'1,0'),ownership:'unique'});}
  ]){const t=flatLike({ambiguousPayment:true,ambiguousMint:true});alter(t);const r=run(t);assert.equal(r.edges.length,0);assert.equal(r.observedActions,undefined);}
});
test('unknown extra fee/refund that might be inside stays provisional even with a matching candidate, never confirmed',()=>{
  const t=flatLike();const fee=transfer(8,pool,receiver,other,1,'');Object.assign(fee,{ownership:'ambiguous',ownerPath:null,candidatePaths:['1','5']});t.logs.push(fee);
  const r=run(t);assert.equal(r.edges.length,0);assert(r.observedActions[0].economicEvidence.missingProof.some(k=>k.includes('unseparated-other-account-flow')));
});
test('earlier non-standard payment plus no-op transferFrom and independently nested debit cannot prove payment to vault',()=>{
  const vault=pool,relay=other,attacker=addr(91),marker=addr(92),root=addr(93),tag='0xabababab',hash=topic(75),block=topic(76),M=topic(77);
  const nodes=[],traces=[],logs=[];
  const frame=(p,from,to,input,output,children=[],kind='call')=>({type:kind.toUpperCase(),from,to,input,output,value:'0x0',calls:children,logs:[],p});
  const mov=(token,from,to,amt,index)=>({address:token,topics:[cfg.transfer.topic,topic(from),topic(to)],data:topic(amt),index,position:0});
  const fake=frame('0',payer,asset,'0x12341234','0x');fake.logs.push(mov(asset,payer,vault,100,0));
  const br=(p,x)=>frame(p,payer,asset,'0x70a08231'+w(payer),topic(x),[],'staticcall');
  const noop=frame('2,0',vault,asset,'0x23b872dd'+w(payer)+w(vault)+w(100),topic(1));
  const genuine=frame('2,1,1',relay,asset,'0x23b872dd'+w(payer)+w(attacker)+w(100),topic(1));genuine.logs.push(mov(asset,payer,attacker,100,2));
  const mk=(p,index)=>{const c=frame(p,relay,marker,'0x12121212','0x');c.logs.push({address:marker,topics:[M],data:'0x',index,position:0});return c;};
  const ch=frame('2,1',vault,relay,tag,'0x',[mk('2,1,0',1),genuine,mk('2,1,2',3)]);
  const act=frame('2',payer,vault,sels[0]+w(100)+w(receiver),topic(90),[noop,ch]);
  act.logs.push({...mov(vault,zero,receiver,90,4),position:2},{address:vault,topics:[cfg.events.issue.topic,topic(payer),topic(receiver)],data:'0x'+w(100)+w(90),index:5,position:2});
  const trace=frame('',root,payer,'0x11223344','0x',[fake,br('1',300),act,br('3',200)]);
  function walk(n){nodes.push(n);traces.push({trace_address:n.p,trace_type:'call',call_type:n.type.toLowerCase(),status:1,subtraces:n.calls.length,from_address:n.from,to_address:n.to,input:n.input,output:n.output,value:'0'});logs.push(...n.logs);n.calls.forEach(walk);}
  walk(trace);logs.sort((a,b)=>a.index-b.index);
  const receipt={status:'0x1',transactionHash:hash,blockHash:block,logs:logs.map(l=>({...l,logIndex:l.index+100}))};
  const flat=buildTree({tx_hash:hash,block_hash:block,receipt_status:1,logs:receipt.logs,traces}),native=buildTree({trace,receipt});
  const opts={enabledSelectors:[sels[0],tag]},x=extractEdges(flat,opts),y=extractEdges(native,opts);
  assert.deepEqual(flat.logs[0].candidatePaths,['0','2,0']);assert.equal(native.logs[0].ownerPath,'0');
  assert.equal(x.edges.length,0);assert.equal(y.edges.length,0);
  assert.equal(x.observedActions[0].economicEvidence.sides[0].accountBalance.reason,'balance-window-has-other-mutable-call');
  assert.equal(x.observedActions[0].economicEvidence.sides[0].proved,false);
  assert.equal(y.observedActions,undefined);
});
