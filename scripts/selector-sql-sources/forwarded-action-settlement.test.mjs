import test from 'node:test';
import assert from 'node:assert/strict';
import {ready21Window,renderIndependentTraceEdges} from '../independent-trace-edges.mjs';

const sql=await renderIndependentTraceEdges(ready21Window);
const udf=sql.match(/CREATE TEMP FUNCTION traceFlows\([\s\S]*?LANGUAGE js AS r'''\n([\s\S]*?)\n''';/)[1];
const run=new Function('frames','logs',udf),cfg=JSON.parse(udf.match(/return Discovery\.traceCallFlows\(frames, logs, (\{[^\n]*\})\);/)[1]);
const w=n=>BigInt(n).toString(16).padStart(64,'0'),address=n=>'0x'+n.toString(16).padStart(40,'0');
const [zero,user,wrapper,venue,asset,custody,stranger]=[0,1,2,3,4,5,6].map(address);
const selector='0xba087652',q=217n,r=399n,topic=x=>'0x'+w(x);
const call=(path,sender,target,input,ret)=>({path,sender,target,input,ok:true,kind:'call',value:'0',output:ret??null});
const transfer=(idx,emitter,from,to,value)=>({idx,emitter,topics:[cfg.transferTopic,topic(from),topic(to)],data:topic(value)});
function sample(option={}){
  const frames=[call('',user,wrapper,'0xc16ae7a4'),call('0',wrapper,venue,selector+w(q)+w(user)+w(user),topic(option.return??r)),
    call('0,0',venue,custody,'0x8844dddd'),call('0,0,0',custody,asset,'0xa9059cbb'+w(user)+w(r),topic(1))];
  const e={idx:7,emitter:venue,topics:[cfg.actionReceipts[selector].topic,topic(option.sender??user),topic(option.receiver??user),topic(user)],
    data:'0x'+w(option.assets??r)+w(option.shares??q)};
  const logs=[transfer(2,venue,user,zero,q),transfer(5,asset,custody,user,r)];
  if(!option.missing)logs.push(e);
  if(option.duplicate)logs.push({...e,idx:8});
  if(option.reverted)frames[1].ok=false;
  return run(frames,logs);
}
test('forwarded redeem with its own unique event, both explicit roles, shares and return retains just the venue',()=>{
  const es=sample();assert.deepEqual(es.map(e=>[e.callPath,e.selector,e.poolAddress,e.tokenIn,e.tokenOut,e.receiptIndices,
    e.amountPayerInRaw,e.amountReceivedOutRaw,e.amountVenueInRaw,e.amountPoolOutRaw]),
    [['0',selector,venue,venue,asset,'2,5,7','217','399',null,null]]);
});
test('no preferential attribution for a missing/duplicate event, inconsistent amounts, beneficiary or unrelated reported sender',()=>{
  for(const opt of [{missing:true},{duplicate:true},{shares:q+1n},{assets:r-1n},{return:r+1n},{receiver:stranger},
    {sender:stranger},{reverted:true}])assert.equal(sample(opt).some(e=>e.callPath==='0'),false,JSON.stringify(opt,(_,x)=>typeof x==='bigint'?String(x):x));
});
