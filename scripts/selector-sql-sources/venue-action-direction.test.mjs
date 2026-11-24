import {test} from 'node:test';
import assert from 'node:assert/strict';
import {renderIndependentTraceEdges,ready21Window} from '../independent-trace-edges.mjs';
const sql=await renderIndependentTraceEdges(ready21Window);
const body=sql.match(/CREATE TEMP FUNCTION traceFlows\([\s\S]*?LANGUAGE js AS r'''\n([\s\S]*?)\n''';/)[1];
const run=new Function('frames','logs',body);
const cfg=JSON.parse(body.match(/return Discovery\.traceCallFlows\(frames, logs, (\{[^\n]*\})\);/)[1]);
const addr=n=>'0x'+BigInt(n).toString(16).padStart(40,'0'),w=n=>BigInt(n).toString(16).padStart(64,'0');
const [zero,alice,recipient,forwarder,outer,inner,usd,stranger]=Array.from({length:8},(_,i)=>addr(i));
const t=n=>'0x'+w(n),call=(path,sender,target,input,output,kind='call')=>({path,sender,target,input,output,kind,ok:true,value:'0'});
const log=(idx,emitter,tag,parties,amounts)=>({idx,emitter,topics:[tag,...parties.map(t)],data:'0x'+amounts.map(w).join('')});
const transfer=(i,a,f,to,n)=>log(i,a,cfg.transferTopic,[f,to],[n]);
const burn='0xba087652',mint='0x6e553f65',bal='0x70a08231',push='0xa9059cbb',pull='0x23b872dd';
function deposit(opts={}){
 const frames=[call('',alice,forwarder,'0xc16ae7a4','0x'),call('0',forwarder,outer,mint+w(90)+w(recipient),t(30)),
  call('0,0',outer,usd,pull+w(alice)+w(opts.callTo??opts.to??outer)+w(90),t(opts.falseReturn?0:1)),
  call('1',forwarder,inner,push+w(alice)+w(8),t(1))];
 const logs=[transfer(0,usd,alice,opts.to??outer,90),transfer(1,outer,zero,recipient,30),
  log(2,outer,cfg.actionReceipts[mint].topic,[opts.eventPayer??alice,recipient],[90,30]),transfer(3,inner,forwarder,alice,8)];
 if(opts.revert)frames[0].ok=false;
 if(opts.assetRead)frames.splice(3,0,call('0,1',outer,outer,'0x38d52e0f',opts.assetRead,'staticcall'));
 return run(frames,logs);
}
test('execution action may report the economic payer, not the forwarder: only the venue is the edge',()=>{
 assert.deepEqual(deposit().map(e=>[e.selector,e.poolAddress,e.tokenIn,e.tokenOut]),[[mint,outer,usd,outer]]);
 assert(deposit({assetRead:t(usd)}).some(e=>e.poolAddress===outer));
 for(const o of [{to:stranger},{callTo:stranger},{falseReturn:true},{revert:true},{eventPayer:stranger},{assetRead:t(stranger)},{assetRead:'0x'}])
  assert(!deposit(o).some(e=>e.poolAddress===outer),JSON.stringify(o));
});
function nested(o={}){
 const read=(p,x,n)=>call(p,o.readSender??outer,usd,bal+w(x),t(n),'staticcall');
 const frames=[call('',alice,outer,burn+w(45)+w(recipient)+w(alice),t(71)),
  read('0',recipient,100),call('1',outer,inner,burn+w(58)+w(recipient)+w(outer),t(71)),
  call('1,0',inner,usd,push+w(recipient)+w(71),t(o.falseReturn?0:1)),read('2',o.endHolder??recipient,o.end??171)];
 const logs=[transfer(4,outer,alice,zero,45),transfer(5,inner,outer,zero,58),transfer(6,usd,inner,recipient,71),
  log(7,inner,cfg.actionReceipts[burn].topic,[outer,recipient,outer],[71,58]),
  log(8,outer,cfg.actionReceipts[burn].topic,[alice,recipient,alice],[71,45])];
 if(o.extra){frames.push(call('3',outer,usd,push+w(recipient)+w(1),t(1)));logs.push(transfer(9,usd,outer,recipient,1));}
 if(o.noEvent)logs.pop();
 return run(frames,logs);
}
test('two real conversions, different shares and one physical payout; no duplicate measured fill',()=>{
 const es=nested();assert.deepEqual(es.map(e=>[e.poolAddress,e.tokenIn,e.tokenOut,e.amountPoolOutRaw,e.amountReceivedOutRaw]).sort(),
 [[outer,outer,usd,'71',null],[inner,inner,usd,'71',null]].sort());
});
test('the outer conversion is not proved by child cash alone or the wrong account, delta, or actor',()=>{
 for(const o of [{end:170},{endHolder:stranger},{readSender:stranger},{extra:true},{noEvent:true},{falseReturn:true}]){
  const es=nested(o);assert(!es.some(e=>e.poolAddress===outer),JSON.stringify(o));
  if(o.falseReturn)assert(!es.some(e=>e.poolAddress===inner),'failed token cannot attest a direction');
 }
});
