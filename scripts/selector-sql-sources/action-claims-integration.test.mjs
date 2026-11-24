import test from 'node:test';
import assert from 'node:assert/strict';
import {ready21Window,renderIndependentTraceEdges} from '../independent-trace-edges.mjs';

// Execute the UDF actually embedded by the production renderer. This is not
// a mock of claim finalization. Inputs are complete, deliberately tiny trees.
const sql=await renderIndependentTraceEdges(ready21Window);
const body=sql.match(/CREATE TEMP FUNCTION traceFlows\([\s\S]*?LANGUAGE js AS r'''\n([\s\S]*?)\n''';/)[1];
const run=new Function('frames','logs',body);
const cfg=JSON.parse(body.match(/return Discovery\.traceCallFlows\(frames, logs, (\{[^\n]*\})\);/)[1]);
const addr=n=>'0x'+BigInt(n).toString(16).padStart(40,'0'),w=n=>BigInt(n).toString(16).padStart(64,'0');
const wallet=addr(0x111),wrapper=addr(0x222),pool=addr(0x333),a=addr(0x444),b=addr(0x555),p2=addr(0x666),c=addr(0x777);
const call=(path,sender,target,input,output=null)=>({path,sender,target,input,ok:true,kind:'call',value:'0',output});
const swap=(recipient,amount)=>'0x022c0d9f'+w(0)+w(amount)+w(recipient)+w(128)+w(0);
const direct=(p,token,from,to,amount)=>call(p,from,token,'0xa9059cbb'+w(to)+w(amount),'0x'+w(1));
const delegated=(p,initiator,token,from,to,amount)=>call(p,initiator,token,'0x23b872dd'+w(from)+w(to)+w(amount),'0x'+w(1));
const log=(idx,emitter,from,to,q)=>({idx,emitter,topics:[cfg.transferTopic,'0x'+w(from),'0x'+w(to)],data:'0x'+w(q)});
const event=(idx,emitter,sender,recipient,qin,qout)=>({idx,emitter,topics:[cfg.amountSwapTopic,'0x'+w(sender),'0x'+w(recipient)],data:'0x'+w(qin)+w(0)+w(0)+w(qout)});
const selectors=['0xdeadbeef',swap(wallet,70)]; // unknown and enabled-looking but no venue evidence
const econ=(es)=>es.map(e=>[e.callPath,e.poolAddress,e.tokenIn,e.tokenOut]).sort();

test('forwarder has no trade of its own when both payments belong to the child venue',()=>{
 for(const entry of selectors){
  const frames=[call('',wallet,wrapper,entry),call('0',wrapper,pool,swap(wallet,70)),
   delegated('0,0',pool,a,wallet,pool,77),direct('0,1',b,pool,wallet,70)];
  const logs=[log(0,a,wallet,pool,77),log(1,b,pool,wallet,70),event(2,pool,wrapper,wallet,77,70)];
  assert.deepEqual(econ(run(frames,logs)),[['0',pool,a,b]]);
 }
});

test('one real deposit survives a forwarding wrapper; the vault mints directly to the end user',()=>{
 const payment=77,shares=70,rule=cfg.actionReceipts['0x6e553f65'];
 const logs=[log(0,a,wallet,wrapper,payment),log(1,a,wrapper,pool,payment),log(2,pool,cfg.native,wallet,shares),
  {idx:3,emitter:pool,topics:[rule.topic,'0x'+w(wrapper),'0x'+w(wallet)],data:'0x'+w(payment)+w(shares)}];
 // The same balances, recipients, mint receipt and Deposit are observed in
 // every case. Changing only the outer selector must not create/remove a pool.
 for(const entry of ['0x',...selectors]){
  const frames=[call('',wallet,wrapper,entry),delegated('0',wrapper,a,wallet,wrapper,payment),
   call('1',wrapper,pool,'0x6e553f65'+w(payment)+w(wallet),'0x'+w(shares)),delegated('1,0',pool,a,wrapper,pool,payment)];
  const es=run(frames,logs);
  assert.deepEqual(econ(es),[['1',pool,a,pool]],'outer '+entry.slice(0,10));
  assert.equal(es[0].amountVenueInRaw,'77');
  assert.equal(es[0].amountPoolOutRaw,'70');
 }
});

test('a direct payment from one real pool to another is output once and independent input once',()=>{
 const frames=[call('',wallet,wrapper,'0x'),delegated('0',wrapper,a,wallet,pool,77),
  call('1',wrapper,pool,swap(p2,70)),direct('1,0',b,pool,p2,70),call('2',wrapper,p2,swap(wallet,63)),direct('2,0',c,p2,wallet,63)];
 const logs=[log(0,a,wallet,pool,77),log(1,b,pool,p2,70),event(2,pool,wrapper,p2,77,70),
  log(3,c,p2,wallet,63),event(4,p2,wrapper,wallet,70,63)];
 const es=run(frames,logs);assert.deepEqual(econ(es),[['1',pool,a,b],['2',p2,b,c]]);
 assert(es.every(e=>e.receiptIndices.split(',').includes('1')),'middle payment evidence should survive on both sides');
});
