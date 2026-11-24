import test from 'node:test';
import assert from 'node:assert/strict';
import {traceCallFlows} from './trace-call-flows.mjs';

const A=i=>'0x'+i.toString(16).padStart(40,'0'),W=i=>BigInt(i).toString(16).padStart(64,'0');
const [route,pool,wallet,t1,t2]=[10,11,12,13,14].map(A),T='0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const cfg={native:A(0),transferTopic:T,amountSwapSelector:'0x022c0d9f'},sel='0xaaaaaaaa',yes='0x'+W(1),no='0x'+W(0);
const frame=(path,sender,target,input,output='0x',kind='call')=>({path,sender,target,input,output,ok:true,kind,value:'0'});
const log=(idx,emitter,from,to,q)=>({idx,emitter,topics:[T,'0x'+W(from),'0x'+W(to)],data:'0x'+W(q)});
const transferIn=()=>frame('0,0',pool,t1,'0x23b872dd'+W(wallet)+W(pool)+W(5),yes);
const transferOut=()=>frame('0,1',pool,t2,'0xa9059cbb'+W(wallet)+W(7),yes);
const frames=()=>[frame('',wallet,route,'0x11111111'),frame('0',wallet,pool,sel),transferIn(),transferOut()];
const logs=()=>[log(0,t1,wallet,pool,5),log(1,t2,pool,wallet,7)];
const run=(fs,ls,cfg0=cfg)=>traceCallFlows(fs,ls,cfg0).filter(e=>e.poolAddress===pool&&e.selector===sel);

test('contradictory fungible return cannot fund a subtree or caller-receipt fallback; no-data is not false',()=>{
  for(const [result,expected] of [[yes,1],[null,1],['0x',1],[no,0],['0x02',0],[yes+'00',0]]){
    const fs=frames();fs[2].output=result;assert.equal(run(fs,logs()).length,expected,'net flow '+result);
    const mint=[logs()[0],log(1,pool,cfg.native,wallet,7)];
    assert.equal(run(fs.slice(0,-1),mint).length,expected,'caller-receipt '+result);
  }
});
test('an independently bound event and two onsite currency getters survive, but a contradicted receipt gives no wallet amount',()=>{
  const E='0x'+W(22),gs=['0x11112222','0x22223333'],x=frames();x[2].output=no;
  const fields=[{name:'qin',type:'uint256',indexed:false},{name:'qout',type:'uint256',indexed:false}];
  const r={topic:E,fields,equals:{},assets:gs,payer:'caller',recipient:'caller',deltas:[['qin'],['-qout']]};
  for(const [i,s] of gs.entries())x.push(frame('0,'+(i+2),pool,pool,s,'0x'+W([t1,t2][i]),'staticcall'));
  const a=run(x,[...logs(),{idx:2,emitter:pool,topics:[E],data:'0x'+W(5)+W(7)}],{...cfg,actionReceipts:{[sel]:r}});
  assert.equal(a.length,1);assert.deepEqual([a[0].tokenIn,a[0].tokenOut,a[0].amountVenueInRaw,a[0].amountPayerInRaw],[t1,t2,'5',null]);
});
test('a disjoint false at the same token does not poison an independently time-bounded valid payout',()=>{
  const f=frames();f.push(frame('1',wallet,route,'0x11223344'),frame('1,0',route,t1,'0xa9059cbb'+W(wallet)+W(4),no));
  const ls=[...logs(),{idx:2,emitter:route,topics:[],data:null},log(3,t1,route,wallet,4)];
  assert.equal(run(f,ls).length,1);
});
