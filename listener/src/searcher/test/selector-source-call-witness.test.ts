import test from 'node:test';
import assert from 'node:assert/strict';
import { Interface, zeroPadValue, toBeHex } from 'ethers';
import { createSelectorSourceCallWitnessReader,assertVerifiedSelectorSourceCall } from '../venues/selector-source-call-witness.js';

// Two equal sellGem calls to the same venue with identical transfers. The position/ordinal
// of a committed receipt distinguishes the two independent executions (never a tx-wide zip).
const a=(x:string)=>'0x'+x.repeat(40),h=(x:string)=>'0x'+x.repeat(64);
const [user,router,pool,tokenIn,tokenOut,pocket,recipient]=['1','2','3','4','5','6','7'].map(a);
const txHash=h('a'),anchor=h('b'),source={number:123,hash:anchor,generation:8};
const psm=new Interface(['function sellGem(address,uint256)','event SellGem(address indexed usr,uint256 gemAmt,uint256 fee)']);
const token=new Interface(['function transferFrom(address,address,uint256)','function transfer(address,uint256)','event Transfer(address indexed from,address indexed to,uint256 amount)']);
const selector=psm.getFunction('sellGem')!.selector,edge={chainId:1,selector,poolAddress:pool,poolId:null,tokenIn,tokenOut};
const tx={hash:txHash,from:user,to:router,blockNumber:'0x7b',blockHash:anchor,transactionIndex:'0x0',chainId:'0x1',value:'0x0',input:'0x12345678'};
function fixture(){
  const log=(address:string,e:{data:string;topics:readonly string[]},idx:number,pos:number)=>({address,data:e.data,topics:[...e.topics],index:toBeHex(idx),position:toBeHex(pos)});
  const rc:any={transactionHash:txHash,from:user,to:router,status:'0x1',blockNumber:tx.blockNumber,blockHash:anchor,transactionIndex:'0x0',logs:[]};
  function action(start:number){
    const src=log(tokenIn,token.encodeEventLog('Transfer',[router,pocket,21n]),start,0);
    const dst=log(tokenOut,token.encodeEventLog('Transfer',[pool,recipient,99n]),start+1,0);
    const act=log(pool,psm.encodeEventLog('SellGem',[recipient,21n,0n]),start+2,2);
    for(const l of [src,dst,act])rc.logs.push({address:l.address,topics:l.topics,data:l.data,logIndex:'0x'+(201+rc.logs.length).toString(16),blockHash:anchor,blockNumber:tx.blockNumber,transactionHash:txHash,transactionIndex:'0x0',removed:false});
    return {type:'CALL',from:router,to:pool,input:psm.encodeFunctionData('sellGem',[recipient,21n]),logs:[act],calls:[
      {type:'CALL',from:pool,to:tokenIn,input:token.encodeFunctionData('transferFrom',[router,pocket,21n]),logs:[src]},
      {type:'CALL',from:pool,to:tokenOut,input:token.encodeFunctionData('transfer',[recipient,99n]),logs:[dst]},
    ]};
  }
  const trace={type:'CALL',from:user,to:router,input:tx.input,value:'0x0',calls:[action(0),action(3)]};
  const block={number:tx.blockNumber,hash:anchor,transactions:[txHash]};
  const reader=createSelectorSourceCallWitnessReader({async send(method,params){
    if(method==='debug_traceTransaction'){assert.deepEqual(params,[txHash,{tracer:'callTracer',tracerConfig:{withLog:true}}]);return trace;}
    return method==='eth_getBlockByNumber'?block:method==='eth_getTransactionByHash'?tx:rc;
  }});return {trace,rc,block,read:(callPath:string,e=edge)=>reader({txHash,callPath,edge:e,source})};
}
test('two identical actions: each independently verified with three distinct receipts and the true spender/recipient roles',async()=>{
  const f=fixture();const [first,second]=await Promise.all([f.read('0'),f.read('1')]);
  assert.deepEqual(first.receiptIndices,[201,202,203]);assert.deepEqual(second.receiptIndices,[204,205,206]);
  assert.deepEqual([first.actor,first.calldata,first.amountIn,first.amountOut],[router,psm.encodeFunctionData('sellGem',[recipient,21n]),'21','99']);
  assertVerifiedSelectorSourceCall(first,{edge,source});
  for(const wrong of [{...source,hash:h('c')},{...source,generation:9}])assert.throws(()=>assertVerifiedSelectorSourceCall(first,{edge,source:wrong}));
  assert.throws(()=>assertVerifiedSelectorSourceCall(structuredClone(first),{edge,source}));
  await assert.rejects(f.read('0',{...edge,tokenIn:tokenOut,tokenOut:tokenIn}));await assert.rejects(f.read(''));
});
test('do not combine one action’s payment with a sibling receipt; canonical membership, ancestors and full trace matter',async()=>{
  for(const mutate of [
    (f:ReturnType<typeof fixture>)=>{const a=f.trace.calls[0]!,b=f.trace.calls[1]!;
      [a.calls[1]!.logs[0],b.calls[1]!.logs[0]]=[b.calls[1]!.logs[0]!,a.calls[1]!.logs[0]!];},
    (f:ReturnType<typeof fixture>)=>{f.trace.calls[0]!.calls[0]!.logs=[];},
    (f:ReturnType<typeof fixture>)=>{f.rc.logs[1].data=zeroPadValue(toBeHex(98),32);},
    (f:ReturnType<typeof fixture>)=>{Object.assign(f.trace.calls[0]!,{error:'execution reverted'});},
    (f:ReturnType<typeof fixture>)=>{f.block.hash=h('d');},
    (f:ReturnType<typeof fixture>)=>{f.block.transactions[0]=h('e');},
    (f:ReturnType<typeof fixture>)=>{f.rc.logs[2].removed=true;},
  ]){const f=fixture();mutate(f);await assert.rejects(f.read('0'));}
});
