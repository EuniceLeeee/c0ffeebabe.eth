import test from 'node:test';import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {buildTree} from './trace-tree.mjs';import {extractPoolActions,observeKeyedActions} from './keyed-actions.mjs';
import cfg from './keyed-rules.json' with {type:'json'};
const {Interface,AbiCoder,id,keccak256}=createRequire(new URL('../../../listener/package.json',import.meta.url))('ethers');
const r=cfg.entries[0], reg=r.manager,zero='0x'+'0'.repeat(40), token='0x'+'1'.repeat(40), tokenB='0x'+'2'.repeat(40),actor='0x'+'a'.repeat(40),other='0x'+'b'.repeat(40);
const abi=AbiCoder.defaultAbiCoder(),iface=new Interface([r.entry,r.callback,r.action,r.pay,r.sync,r.take,...cfg.paymentMethods].map(x=>'function '+x));
const sel=iface.getFunction(r.entry).selector,fmt=(sig,args)=>iface.encodeFunctionData(sig,args).toLowerCase();
const w=x=>'0x'+BigInt.asUintN(256,BigInt(x)).toString(16).padStart(64,'0'),aw=a=>'0x'+a.slice(2).padStart(64,'0');
const call=(from,to,input,output='0x',value=0n)=>({from,to,input,output,value:w(value),type:'CALL',calls:[],logs:[]});
function fixture({native='input',zeroEv=false}={}){
  const c=[native==='none'?token:zero,native==='none'?tokenB:token],input=native==='output'?1:0,out=1-input,mIn=101n,mOut=96n;
  const key=[...c,3000,60,zero],pid=keccak256(abi.encode(['tuple(address,address,uint24,int24,address)'],[key])), d=input===0?[-mIn,mOut]:[mOut,-mIn];
  const action=call(actor,reg,fmt(r.action,[key,[input===0,-mIn,1000n],'0x']),w((BigInt.asUintN(128,d[0])<<128n)|BigInt.asUintN(128,d[1])));
  const ev={address:reg,topics:[id(r.event),pid,aw(actor)],data:abi.encode(r.dataTypes,[...(zeroEv?[0n,0n]:d),900n,0n,-1,3000]),position:'0x0'};action.logs.push(ev);
  const take=call(actor,reg,fmt(r.take,[c[out],actor,mOut])),pay=call(actor,reg,fmt(r.pay,[]),w(mIn),input===0&&c[input]===zero?mIn:0n);
  const cb=call(reg,actor,fmt(r.callback,['0x1234'])),entry=call(actor,reg,fmt(r.entry,['0x1234'])); entry.calls.push(cb);cb.calls.push(action);
  const transfer=(asset,source,dest,amt)=>{
    const t=call(source,asset,fmt('transfer',[dest,amt]),w(1));
    t.logs.push({address:asset,topics:[id(cfg.transferEvent),aw(source),aw(dest)],data:w(amt),position:'0x0'});return t;};
  if(c[input]!==zero)cb.calls.push(call(actor,reg,fmt(r.sync,[c[input]])),transfer(c[input],actor,reg,mIn));
  cb.calls.push(pay,take);take.calls.push(c[out]===zero?call(reg,actor,'0x','0x',mOut):transfer(c[out],reg,actor,mOut));
  function normalized(){
    const ls=[];function walk(n){ls.push(...n.logs);n.calls.forEach(walk);}walk(entry);
    const receipt={transactionHash:w(934),status:'0x1',logs:ls.map((l,i)=>({...l,logIndex:i+15}))};
    return buildTree({trace:entry,receipt});
  }
  return {entry,cb,take,pay,action,ev,normalized,c,pid,mIn,mOut};
}
const get=x=>extractPoolActions(x.normalized(),{enabledSelectors:[sel]});
const observe=x=>observeKeyedActions(x.normalized(),{enabledSelectors:[sel]});
const shortBytes=(sig,x='1234',padding='')=>iface.getFunction(sig).selector+w(32).slice(2)+w(x.length/2).slice(2)+x+padding;
test('observed composer bytes may omit or shorten trailing zero padding; strict settlement unchanged',()=>{
 for(const p of ['', '00','00000000']){const x=fixture();x.entry.input=shortBytes(r.entry,'1234',p);
   assert.equal(observe(x).length,1);assert.equal(get(x).edges.length,0);}
 const x=fixture();x.cb.input=shortBytes(r.callback);assert.equal(observe(x).length,1);assert.equal(get(x).edges.length,0);
});
test('one same-custody self-call below the declared callback may dispatch the swap only as observed',()=>{
 const x=fixture(),h=call(actor,actor,'0x4511aabb');h.calls.push(x.action);
 x.cb.calls[x.cb.calls.indexOf(x.action)]=h;x.entry.input=shortBytes(r.entry);
 const obs=observe(x);assert.equal(obs.length,1);assert.equal(obs[0].path,'0,0,0');assert.equal(get(x).edges.length,0);
});
for(const [why,alter] of [
 ['wrong offset',x=>{x.entry.input=iface.getFunction(r.entry).selector+w(64).slice(2)+w(2).slice(2)+'1234';}],
 ['truncated declared bytes',x=>{x.entry.input=shortBytes(r.entry).slice(0,-2);}],
 ['nonzero padding',x=>{x.cb.input=shortBytes(r.callback,'1234','0001');}],
 ['oversized even if appended bytes are zero',x=>{x.cb.input=fmt(r.callback,['0x1234'])+'00';}],
 ['different declared payload',x=>{x.cb.input=shortBytes(r.callback,'1200');}],
 ['untrusted intermediate contract CALL then actor reentry',x=>{const a=call(actor,other,'0xcccccccc'),b=call(other,actor,'0xbbbbbbbb');a.calls.push(b);b.calls.push(x.action);x.cb.calls[0]=a;}],
 ['event amounts/return contradict even when both are the same direction',x=>{x.ev.data=abi.encode(r.dataTypes,[-99n,96n,900n,0n,-1,3000]);}]
])test('observation rejects '+why,()=>{const x=fixture();alter(x);assert.equal(observe(x).length,0);});
test('action-only proof requires matched entry, actual return and compatible receipt; never promotes settlement',()=>{
 const x=fixture();x.cb.calls=x.cb.calls.filter(y=>y!==x.take);const t=x.normalized();
 assert.equal(extractPoolActions(t,{enabledSelectors:[sel]}).edges.length,0);
 const a=observeKeyedActions(t,{enabledSelectors:[sel]});assert.equal(a.length,1);assert.equal(a[0].poolId,x.pid);
 assert.equal(observeKeyedActions(t,{enabledSelectors:[]}).length,0);
 const bad=structuredClone(t);bad.logs[0].topics[1]=w(0);assert.equal(observeKeyedActions(bad,{enabledSelectors:[sel]}).length,0);
});
test('identical events cannot be credited to one nested action by proximity',()=>{
 const x=fixture();const t=x.normalized();const e=t.logs[0];t.logs.push({...e,idx:99999});
 assert.equal(observeKeyedActions(t,{enabledSelectors:[sel]}).length,0);
});
for(const native of ['input','output','none'])test('one explicit single-action settlement admits '+native,()=>{
  const x=fixture({native}),out=get(x);assert.equal(out.unresolved.length,0);assert.equal(out.edges.length,1);
  const [e]=out.edges;assert.equal(e.selector,sel);assert.equal(e.actionSelector,'0xf3cd914c');assert.equal(e.poolAddress,reg);assert.equal(e.poolId,x.pid);
  assert.equal(e.amountInRaw,'101');assert.equal(e.amountOutRaw,'96');assert.equal(e.tokenIn,x.c[native==='output'?1:0]);assert.equal(e.tokenOut,x.c[native==='output'?0:1]);
  assert.equal(new Set(e.evidenceCallPaths).size,e.evidenceCallPaths.length);
});
test('zero/zero event authenticates only pool; separately signed returns and both payments still required',()=>{
  const x=fixture({zeroEv:true});assert.equal(get(x).edges.length,1);x.pay.value=w(100);assert.equal(get(x).edges.length,0);});
for(const [name,mut] of [
  ['missing payout receipt',x=>{x.take.calls[0].logs=[];}],
  ['extra manager spend inside ERC20 payout without a distinct call',x=>{x.take.calls[0].logs.push({...x.take.calls[0].logs[0],topics:[id(cfg.transferEvent),aw(reg),aw(other)],data:w(2)});}],
  ['extra native transfer on input side',x=>{x.cb.calls.push(call(actor,reg,'0x','0x',1n));}],
  ['competing inner swap',x=>{x.cb.calls.push(structuredClone(x.action));}],
  ['full pool id does not match event',x=>{x.ev.topics[1]=w(101010);}],
  ['input/output swapped in event',x=>{x.ev.data=abi.encode(r.dataTypes,[96n,-101n,900n,0n,-1,3000]);}],
  ['output receipt binds only different beneficiary',x=>{x.take.calls[0].logs[0].topics[2]=aw(other);}],
  ['unexplained mutable manager action',x=>{x.cb.calls.push(call(actor,reg,'0xffffffff'));}],
  ['trailing junk on action ABI',x=>{x.action.input+='00';}],
  ['same selector on non-manager',x=>{x.action.to=other;x.action.logs=[];}],
  ['opposing return sign with conflicting direction bit',x=>{x.action.output=w((BigInt.asUintN(128,96n)<<128n)|BigInt.asUintN(128,-101n));}],
  ['ETH input not funded by payable settle',x=>{x.pay.value=w(0);}],
  ['rollback excludes even locally successful swap',x=>{x.cb.error='revert';x.action.logs=[];x.take.calls[0].logs=[];}],
])test('do not publish: '+name,()=>{const x=fixture();mut(x);assert.equal(get(x).edges.length,0);});
test('forged actor on nested action contradicts parent execution context',()=>{
  const x=fixture();x.action.from=other;assert.throws(()=>get(x),/child sender/);
});
test('evidence-only selector cannot become an independent execution entry',()=>{
  const x=fixture();const q=extractPoolActions(x.normalized(),{enabledSelectors:['0xf3cd914c','0x91dd7346']});assert.deepEqual(q.edges,[]);});
test('full calculated id and direction retained for every conflicting swap instead of publishing or dropping',()=>{
  const x=fixture();x.cb.calls.push(structuredClone(x.action));const q=get(x);
  assert.equal(q.unresolved.length,2);assert(q.unresolved.every(t=>t.poolId===x.pid&&t.tokenIn===zero&&t.amountOutRaw==='96'&&t.path===''));
  assert.notEqual(q.unresolved[0].actionPath,q.unresolved[1].actionPath);});
test('flat receipt with side potentially owned by a sibling fails closed',()=>{
  const x=fixture(),t=x.normalized(),l=t.logs.find(l=>l.emitter===token);l.ownership='ambiguous';l.ownerPath=null;l.candidatePaths.push('');
  assert.equal(extractPoolActions(t,{enabledSelectors:[sel]}).edges.length,0);});
