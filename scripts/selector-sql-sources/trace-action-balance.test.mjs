import assert from 'node:assert/strict';
import test from 'node:test';
import {traceCallFlows} from './trace-call-flows.mjs';

const addr=n=>'0x'+String(n).padStart(40,'0'), w=n=>BigInt.asUintN(256,BigInt(n)).toString(16).padStart(64,'0');
const [router,pool,assetA,assetB,payer,other]=[1,2,3,4,5,6].map(addr);
const topic=n=>'0x'+w(n), transfer='0x'+'a'.repeat(64), action='0x10101010', event='0x'+'b'.repeat(64);
const cfg={native:addr(0),transferTopic:transfer,balanceActions:{[action]:{topic:event,deltaWords:[0,1],
  sign:1,callerTopic:1,recipientTopic:2,recipientArg:0,dataWords:2,topicCount:3}}};
const node=(path,kind,sender,target,input,output=null)=>({path,kind,sender,target,input,output,ok:true,value:'0'});
const pay=(to,n)=>'0xa9059cbb'+w(to)+w(n), balance=(path,holder,n,asset=assetA)=>node(path,'staticcall',pool,asset,'0x70a08231'+w(holder),'0x'+w(n));
const log=(idx,emitter,subject,from,to,n)=>({idx,emitter,topics:[subject,topic(from),topic(to)],data:'0x'+w(n)});
const make=()=>({
  frames:[
    node('','call',payer,router,'0x01010101'),
    node('0','call',router,pool,action+w(router)),
    node('0,0','call',pool,assetB,pay(router,6)),
    balance('0,1',pool,100),
    node('0,2','call',pool,router,'0x02020202'),
    node('0,2,0','call',router,assetA,pay(pool,17)),balance('0,3',pool,117)],
  logs:[log(5,assetB,transfer,pool,router,6),{...log(6,pool,event,router,router,17),data:'0x'+w(17)+w(-6)}]});

const seen=d=>traceCallFlows(d.frames,d.logs,cfg).filter(e=>e.poolAddress===pool&&e.selector===action);
test('normalized eligible action; payment in callback bound to pool read; non-standard token event not needed',()=>{
  const edges=seen(make());assert.equal(edges.length,1);
  assert.deepEqual([edges[0].tokenIn,edges[0].tokenOut,edges[0].amountVenueInRaw,edges[0].amountReceivedOutRaw,edges[0].receiptIndices],
    [assetA,assetB,'17','6','5,6']);
});
test('opposite direction and recipient balance support missing payout receipt',()=>{
  const x=make();
  x.frames=[x.frames[0],x.frames[1],balance('0,0',router,2,assetB),node('0,1','call',pool,assetB,pay(router,6)),
    balance('0,2',router,8,assetB),node('0,3','call',pool,router,'0x02020202'),node('0,3,0','call',router,assetA,pay(pool,17))];
  x.logs=[log(5,assetA,transfer,router,pool,17),{...x.logs[1],data:'0x'+w(-6)+w(17)}];
  assert.equal(seen(x)[0]?.evidence,'action-balance-settlement');
});
test('known movements deducted from the same balance interval; do not count a second payment twice',()=>{
  const x=make();x.frames[5].input=pay(pool,14);
  x.frames.splice(6,0,node('0,2,1','call',other,assetA,pay(pool,3)));
  x.logs.unshift(log(4,assetA,transfer,other,pool,3));
  // Existing paths remain untouched, even when a legacy net-flow already
  // covers this partial-with-receipt case. Exercise recovery with a complete
  // synthetic bill via the ordinary production flow only when eligible.
  assert.equal(seen(x).length,1);assert.equal(seen(x)[0].evidence,'subtree-net-flow');
  x.logs.shift();assert.equal(seen(x).length,0);
});
for(const [name,edit] of [
  ['wrong holder',d=>d.frames[3].input='0x70a08231'+w(other)],
  ['wrong pool balance delta',d=>d.frames[6].output='0x'+w(118)],
  ['noncanonical balance return',d=>d.frames[6].output+='0'],
  ['receipt amount conflict',d=>d.logs[1].data='0x'+w(17)+w(-7)],
  ['extra event fields',d=>d.logs[1].data+=w(1)],
  ['wrong caller',d=>d.logs[1].topics[1]=topic(other)],
  ['wrong recipient',d=>d.logs[1].topics[2]=topic(other)],
  ['two calls share one payment interval',d=>d.frames.splice(6,0,node('0,2,1','call',router,assetA,pay(pool,17)))],
  ['unallocated fungible receipt conflicts',d=>d.logs.unshift(log(4,assetA,transfer,other,pool,1))],
  ['unallocated receipt also conflicts on purportedly complete payout side',d=>d.logs.unshift(log(4,assetB,transfer,pool,other,1))],
  ['another mutation of token between reads',d=>d.frames.splice(6,0,node('0,2,1','call',other,assetA,'0x90909090'))],
  ['output does not reach declared recipient',d=>{d.frames[2].input=pay(other,6);d.logs[0].topics[2]=topic(other);}],
  ['reverted callback',d=>d.frames[4].ok=false],
  ['explicit false on the no-receipt payment',d=>d.frames[5].output='0x'+w(0)],
  ['malformed nonempty return on the no-receipt payment',d=>d.frames[5].output='0x01'],
  ['reverted outer action',d=>d.frames[1].ok=false],
  ['payment only a delegatecall',d=>d.frames[5].kind='delegatecall'],
  ['forwarded getter not read directly by action',d=>d.frames[6].path='0,2,3'],
  ['another same-address call could own the receipt',d=>d.frames.push(node('1','call',router,pool,'0x12341234'))],
  ['indistinguishable sibling events',d=>d.logs.push({...d.logs[1],idx:7})],
  ['indistinguishable sibling calls',d=>d.frames.push({...d.frames[1],path:'1'})],
  ['unrelated call reuses the same venue and reads',d=>d.frames.push({...d.frames[1],path:'0,4'})],
  ['payment of different asset',d=>d.frames[5].target=other],
  ['same side paid only after balance interval',d=>{const [p]=d.frames.splice(5,1);d.frames.push({...p,path:'0,4'});}],
])test('fails closed: '+name,()=>{const d=make();edit(d);assert.equal(seen(d).length,0);});
test('no action declaration, no inference; already emitted established flow stays unchanged',()=>{
  const x=make();assert(!traceCallFlows(x.frames,x.logs,{...cfg,balanceActions:undefined}).some(e=>e.poolAddress===pool));
  x.logs.unshift(log(4,assetA,transfer,router,pool,17));const legacy=traceCallFlows(x.frames,x.logs,{...cfg,balanceActions:undefined});
  assert.deepEqual(traceCallFlows(x.frames,x.logs,cfg),legacy);
});
