import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {buildTree} from './trace-tree.mjs';
import {extractPairActions} from './pair-actions.mjs';
import rules from './pair-rules.json' with {type:'json'};
const s2='0x022c0d9f',s3='0x128acb08',un='0x48c89491',T=rules.transferTopic;
const A=i=>'0x'+String(i).repeat(40),pool=A(1),router=A(2),a=A(3),b=A(4),misc=A(5),user=A(6);
const w=v=>typeof v==='string'&&v.startsWith('0x')?v.slice(2).padStart(64,'0'):BigInt.asUintN(256,BigInt(v)).toString(16).padStart(64,'0');
const blob=(...ws)=>'0x'+ws.map(w).join(''),input=(sel,...ws)=>sel+blob(...ws).slice(2);
const n=(path,parent,from,to,input,output,kind='call')=>({path,parent,from,to,input,output,kind,contextAddress:to,committed:true,value:'0'});
const log=(idx,emitter,path,topics,data)=>({idx,emitter,ownerPath:path,candidatePaths:[path],ownership:'traced',topics,data});
const pay=(path,parent,from,to,token,amount)=>n(path,parent,from,token,input('0xa9059cbb',to,amount),blob(1));
const move=(idx,p,from,to,token,val)=>log(idx,token,p,[T,blob(from),blob(to)],blob(val));
const balance=(p,up,tok,val)=>n(p,up,pool,tok,input('0x70a08231',pool),blob(val),'staticcall');
function v2(){
  return {nodes:[n('',null,user,router,'0xaabbccdd','0x'),pay('0','',router,pool,a,10),
    n('1','',router,pool,input(s2,0,7,user,128,0),'0x'),pay('1,0','1',pool,user,b,7),
    balance('1,1','1',a,100),balance('1,2','1',b,50)],
    logs:[move(11,'0',router,pool,a,10),move(12,'1,0',pool,user,b,7),log(14,pool,'1',[rules.actions[s2].event,blob(router),blob(user)],blob(10,0,0,7))]};
}
function v3(){
  return {nodes:[n('',null,user,router,'0xaabbccdd','0x'),n('0','',router,pool,input(s3,user,1,10,11,160,0),blob(10,-7)),
    pay('0,0','0',pool,user,b,7),balance('0,1','0',a,90),
    n('0,2','0',pool,router,'0xfa461e33','0x'),pay('0,2,0','0,2',router,pool,a,10),balance('0,3','0',a,100)],
    logs:[move(11,'0,0',pool,user,b,7),move(12,'0,2,0',router,pool,a,10),log(14,pool,'0',[rules.actions[s3].event,blob(router),blob(user)],blob(10,-7,25,100,0))]};
}
const run=t=>extractPairActions(t,{enabledSelectors:[s2,s3,un]});
for(const [name,make] of [['adjacent prepayment + measured actual currency pair',v2],['in-frame receipts and independent signed return',v3]]){
  test(name,()=>{const {edges,unresolved}=run(make());assert.equal(unresolved.length,0);assert.equal(edges.length,1);
    const e=edges[0];assert.deepEqual([e.tokenIn,e.tokenOut,e.amountInRaw,e.amountOutRaw,e.poolId],[a,b,'10','7',null]);
    assert.equal(e.evidenceLogIndices.length,3);assert.ok(e.evidenceCallPaths.length>=2);});
}
for(const [name,build,mutate] of [
  ['unrelated immediately previous equal-value token',v2,t=>{t.nodes[1].to=t.nodes[1].contextAddress=misc;t.logs[0].emitter=misc;}],
  ['unattributed settlement is not positive evidence',v2,t=>{t.logs[0].ownership='unattributed';t.logs[0].ownerPath=null;t.logs[0].candidatePaths=[];}],
  ['third-party donation of same asset in addition to prepayment',v2,t=>{t.logs.unshift(move(9,'2',misc,pool,a,10));}],
  ['recipient event mismatch',v2,t=>{t.logs.at(-1).topics[2]=blob(misc);}],
  ['action calldata four bytes found elsewhere do not dispatch',v2,t=>{t.nodes[2].input='0xaaaabbbb'+t.nodes[2].input.slice(2);}],
  ['reverted ancestor invalidates descendants',v3,t=>{t.nodes[0].committed=false;}],
  ['direct/native WETH alias rejected',v3,t=>{t.nodes.push({...n('0,4','0',router,pool,'0x','0x'),value:'10'});}],
  ['canonical bool mismatch with amount slots',v3,t=>{t.nodes[1].input=input(s3,user,0,10,11,160,0);}],
  ['two output legs are not one directional exchange',v2,t=>{t.logs.at(-1).data=blob(10,0,1,7);}],
  ['incorrect signed return',v3,t=>{t.nodes[1].output=blob(10,-6);}],
  ['one-sided amount mismatch',v3,t=>{t.logs[1].data=blob(9);}],
  ['cross-action ambiguous event',v3,t=>{Object.assign(t.logs.at(-1),{ownership:'ambiguous',ownerPath:null,candidatePaths:['0','1']});}],
  ['fee/rebate including the recipient changes real out',v3,t=>{t.logs.splice(1,0,move(13,'0,0',user,misc,b,1));}],
  ['failed ERC20 return',v3,t=>{t.nodes[2].output=blob(0);}],
  ['unsupported known shared selector cannot impersonate standalone pool',v2,t=>{t.nodes[2].input=un+t.nodes[2].input.slice(10);}],
  ['missing output is not made up by event/return',v3,t=>{t.logs.shift();}],
  ['missing input plus wrong account balance',v3,t=>{t.logs.splice(1,1);t.nodes.at(-1).input=input('0x70a08231',router);}],
  ['intervening unaccounted stateful token call before second balance',v3,t=>{t.logs.splice(1,1);t.nodes.push(n('0,2,1','0,2',router,a,'0xaaaaaaaa','0x'));}],
  ['malformed ERC20-like receipt blocks amount reconciliation',v3,t=>{t.logs[1].data='0x';}],
  ['real equal-value payment in unrelated currency is not measured input when input Transfer is missing',v3,t=>{
    t.nodes.push(pay('0,2,1','0,2',router,pool,misc,10));t.logs[1]=move(12,'0,2,1',router,pool,misc,10);
  }],
  ['unlogged alternative output payment cannot supply an apparent single output',v3,t=>{t.nodes.push(pay('0,4','0',pool,user,misc,7));}],
  ['receipts do not override incorrect internal input balance delta',v3,t=>{t.nodes.at(-1).output=blob(89);}],
  ['same-value second payment is ambiguous',v3,t=>{t.nodes.push(pay('0,2,1','0,2',router,pool,a,10));t.logs.splice(1,0,move(13,'0,2,1',router,pool,a,10));}],
  ['ambiguous receipt candidates with no unique physical pay path',v3,t=>{t.nodes.push(pay('0,2,1','0,2',router,pool,a,10));Object.assign(t.logs[1],{ownerPath:null,ownership:'ambiguous',candidatePaths:['0,2,0','0,2,1']});}],
])test(name,()=>{const t=build();mutate(t);assert.equal(run(t).edges.length,0);});
test('supported alternate input evidence is tied to the exact token, pool and sole payment',()=>{
  const t=v3();t.logs.splice(1,1);const {edges}=run(t);assert.equal(edges.length,1);
  assert.deepEqual(edges[0].evidenceLogIndices,[11,14]);assert.deepEqual(edges[0].evidenceCallPaths,['0,1','0,2,0','0,3','0,0']);
});
test('empty enabled set does not discover, unspecified policy throws',()=>{
  assert.equal(extractPairActions(v2(),{enabledSelectors:[]}).edges.length,0);assert.throws(()=>extractPairActions(v2()));});
test('fully-declared delegate proxy emits under its own logical storage address, not implementation',()=>{
  const t=v3();const proxyImpl={...n('0,8','0',router,misc,t.nodes[1].input,t.nodes[1].output,'delegatecall'),contextAddress:pool};
  t.nodes.push(proxyImpl);Object.assign(t.logs.at(-1),{ownerPath:'0,8',candidatePaths:['0,8']});assert.equal(run(t).edges[0].poolAddress,pool);
});
const fixture=process.env.PAIR_FIXTURES;
for(const [id,poolAddress,tokenIn,amountInRaw,amountOutRaw] of [
  ['0x04721d1467cd9bf061723aeeeda3629ba4a118cd2bf957a831c3c302e56509a1','0x1df4c6e36d61416813b42fe32724ef11e363eddc','0x9e9fbde7c7a83c43913bddc8779158f1368f0413','73578512929748251','2766306168062150'],
  ['0x4da85e11c36effa243d226d81833c566c0f01b603e5df7f0be9bb86984ff7c32','0x37c3b0a2850da4c40dae6d0b026f970bbe201536','0x5c27976c770ea3c1e7732b1c907fc415c96f0a3b','25550000000000000000','17826191848529651']
])test('archived on-chain call+receipt '+id,{skip:!fixture},()=>{
  const {edges}=run(buildTree(JSON.parse(fs.readFileSync(fixture+'/'+id+'.json','utf8'))));const target=edges.filter(x=>x.poolAddress===poolAddress);
  assert.equal(target.length,1);const e=target[0];assert.equal(e.tokenIn,tokenIn);assert.equal(e.tokenOut,'0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2');
  assert.equal(e.amountInRaw,amountInRaw);assert.equal(e.amountOutRaw,amountOutRaw);
});
