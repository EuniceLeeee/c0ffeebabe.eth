import {test} from 'node:test';import assert from 'node:assert/strict';
import {resolveActionClaims} from './action-claims.mjs';
const row=(name,side,logIndex,independentDirection=false)=>({name,tokenIn:side==='in'?'A':'B',tokenOut:side==='out'?'A':'B',amountPayerInRaw:'10',amountReceivedOutRaw:'9',independentDirection,settlementClaims:[{asset:'A',side,logIndex}]});
test('two converters cannot claim a single receipt as both of their own payment inputs',()=>{
 assert.deepEqual(resolveActionClaims([row('a','in',0),row('b','in',0)]),[]);
});
test('a single direct pool-to-pool receipt may be one output and the next input; identical transfers at different indices stay distinct',()=>{
 const xs=[row('a','out',0),row('b','in',0),row('c','in',1)];
 assert.equal(resolveActionClaims(xs).length,3);assert(xs.every(e=>!('settlementClaims' in e)));
});
test('nominal direction survives a contested payment only when independently supported; actual fill remains unknown',()=>{
 const vals=resolveActionClaims([row('a','out',4,true),row('b','out',4)]);assert.equal(vals.length,1);assert.equal(vals[0].amountReceivedOutRaw,null);assert.equal(vals[0].amountPayerInRaw,'10');
});
test('a repeated reference on the same observation is not a second conversion',()=>{
 const r=row('a','out',1);r.settlementClaims.push(r.settlementClaims[0]);assert.equal(resolveActionClaims([r]).length,1);
});
test('caller flow cannot turn a nested venue payment into a second conversion',()=>{
 const observed={...row('inner','out',8),venuePayments:true,callPath:'1,0'};
 const parent={...row('outer','out',8),evidence:'caller-receipt-net-flow',callPath:'1'};
 assert.deepEqual(resolveActionClaims([parent,observed]).map(e=>e.name),['inner']);
});
test('native value uses the exact value-carrying call, not a fabricated token receipt',()=>{
 const value=(p)=>({asset:'ETH',side:'out',valuePath:p});
 const other={name:'other',callPath:'9',tokenOut:'ETH',settlementClaims:[value('9,1')]};
 const inner={name:'inner',venuePayments:true,callPath:'1,2',tokenOut:'ETH',settlementClaims:[value('1,2,0')]};
 const outer={name:'outer',evidence:'caller-receipt-net-flow',callPath:'1',tokenOut:'ETH',settlementClaims:[value('1,2,0')]};
 assert.deepEqual(resolveActionClaims([outer,inner,other]).map(x=>x.name),['inner','other']);
});
