import assert from 'node:assert/strict';
import test from 'node:test';
import {possibleReceiptOwners,receiptCallOwners} from './receipt-call-owners.mjs';
import {traceCallFlows} from './trace-call-flows.mjs';

const a=n=>'0x'+n.toString(16).padStart(40,'0'),w=n=>BigInt(n).toString(16).padStart(64,'0');
const [z,router,venue,under,share,wallet]=[0,1,2,3,4,5].map(a);
const transfer='0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const cfg={native:z,transferTopic:transfer,actionReceipts:{},actionSwaps:[],amountSwapSelector:'0x022c0d9f'};
const call=(path,sender,target,input,output='0x'+w(1))=>({path,sender,target,input,output,ok:true,value:'0',kind:'call'});
const send=(p,asset,from,to,q)=>call(p,from,asset,'0xa9059cbb'+w(to)+w(q));
const receipt=(idx,asset,from,to,q)=>({idx,emitter:asset,topics:[transfer,'0x'+w(from),'0x'+w(to)],data:'0x'+w(q)});

test('pins keep only the actual writer, and remain global on every later consumer',()=>{
  const r={kind:'call',valid:true,parent:null,target:venue},middle={kind:'call',valid:true,parent:r,target:under};
  const inner={kind:'call',valid:true,parent:middle,target:venue};
  const l=[receipt(0,venue,router,wallet,1),receipt(1,under,router,wallet,2),receipt(2,venue,router,wallet,3)];
  const t=receiptCallOwners([r,middle,inner],l,new Set([transfer]));
  const first=t.constrain(new Map([[l[0],r],[l[2],r]]));
  assert.deepEqual([...possibleReceiptOwners(first.placements.get(l[2]))],[r]);
  assert.equal(first.canPlace(new Map([[l[2],inner]])),false);
  assert.equal(first.constrain(new Map([[l[2],inner]])),undefined);
  assert.deepEqual([...possibleReceiptOwners(first.withBindings(new Map()).get(l[1]))],[middle]);
});

test('closed ERC20 stream distinguishes real self-transfer from a later venue debit; unknown or false competitors veto',()=>{
  const frames=[call('',wallet,router,'0x'),call('0',router,under,'0x23b872dd'+w(router)+w(router)+w(10)),
    call('1',router,venue,'0x95991276'),call('1,0',venue,under,'0x23b872dd'+w(router)+w(wallet)+w(10)),
    send('1,1',share,venue,router,9)];
  const logs=[receipt(1,under,router,router,10),receipt(3,under,router,wallet,10),receipt(4,share,venue,router,9)];
  const run=(f,l)=>traceCallFlows(f,l,cfg).filter(e=>e.evidence==='caller-receipt-net-flow'&&e.callPath==='1');
  assert.deepEqual(run(frames,logs).map(e=>[e.tokenIn,e.tokenOut,e.receiptIndices]),[[under,share,'3,4']]);
  for(const change of [{input:'0x11223344'}, {output:'0x'+w(0)}, {input:frames[1].input+'00'}]){
    assert.deepEqual(run(frames.map(f=>f.path==='0'?{...f,...change}:f),logs),[]);
  }
  // A second unaccounted Transfer can come from either call; matching the
  // expected #3 in the transaction alone cannot rescue it.
  assert.deepEqual(run(frames,[...logs.slice(0,1),receipt(2,under,router,router,1),...logs.slice(1)]),[]);
});
