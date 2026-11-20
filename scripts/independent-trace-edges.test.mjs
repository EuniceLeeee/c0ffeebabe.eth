import assert from 'node:assert/strict';
import test from 'node:test';
import {keccak256} from '../listener/node_modules/ethers/lib.esm/crypto/keccak.js';
import {Interface} from '../listener/node_modules/ethers/lib.esm/abi/interface.js';
import {poolIdLayouts} from './selector-sql-sources/trace-pool-id.mjs';
import {flowConfig as cfg,ready21Window,renderIndependentTraceEdges} from './independent-trace-edges.mjs';
import {fileURLToPath} from 'node:url';
import {compileActionReceipts} from './selector-sql-sources/compile-action-receipts.mjs';
import {traceCallFlows} from './selector-sql-sources/trace-call-flows.mjs';

const addr=n=>'0x'+n.toString(16).padStart(40,'0');
const word=n=>BigInt(n).toString(16).padStart(64,'0');
const router=addr(1),pool=addr(2),tokenA=addr(3),tokenB=addr(4),wallet=addr(5);
const swap='0x022c0d9f';
const call=(path,sender,target,input,rest={})=>({path,sender,target,input,ok:true,kind:'call',value:'0',...rest});
const root=()=>call('',wallet,router,'0x');
const move=(path,token,from,to,amount)=>call(path,from,token,'0xa9059cbb'+word(to)+word(amount));
const receipt=(idx,token,from,to,amount)=>({idx,emitter:token,topics:[cfg.transferTopic,'0x'+word(from),'0x'+word(to)],data:'0x'+word(amount)});
const run=(frames,logs)=>traceCallFlows(frames,logs,cfg).filter(e=>e.poolAddress===pool);
test('a read does not consume a prepayment; two later payouts cannot claim it by proximity',()=>{
  const frames=[root(),move('0',tokenA,wallet,pool,99),call('2',router,pool,'0x0902f1ac'),
    call('10',router,pool,swap),move('10,0',tokenB,pool,wallet,14),
    call('11',router,pool,'0xdddddddd'),move('11,0',tokenB,pool,wallet,15)];
  const logs=[receipt(0,tokenA,wallet,pool,99),receipt(1,tokenB,pool,wallet,14),receipt(2,tokenB,pool,wallet,15)];
  assert.deepEqual(run(frames,logs),[]);
  const rows=run(frames.slice(0,-2),logs.slice(0,-1));
  assert.deepEqual(rows.map(e=>[e.selector,e.tokenIn,e.tokenOut,e.callPath,e.receiptIndices]),[[swap,tokenA,tokenB,'10','0,1']]);
});

test('an intervening refund cannot spend the uniquely receipt-bound later swap prepayment',()=>{
  for (const credit of [100,97]) {
    const frames=[root(),move('0',tokenA,wallet,pool,100),
      call('1',router,pool,'0xdddddddd'),move('1,0',addr(8),pool,router,5),
      call('2',router,pool,swap+word(0)+word(30)+word(wallet)),move('2,0',tokenB,pool,wallet,30)];
    const event={idx:4,emitter:pool,topics:[cfg.amountSwapTopic,'0x'+word(router),'0x'+word(wallet)],
      data:'0x'+word(credit)+word(0)+word(0)+word(30)};
    const logs=[receipt(1,tokenA,wallet,pool,credit),receipt(2,addr(8),pool,router,5),
      receipt(3,tokenB,pool,wallet,30),event];
    assert.deepEqual(run(frames,logs).map(e=>[e.callPath,e.tokenIn,e.tokenOut,e.receiptIndices]),[['2',tokenA,tokenB,'1,3,4']]);
    assert.deepEqual(run(frames,logs.slice(0,-1)),[]);
  }
});

test('a payout inside a transfer callback cannot claim a prepayment that has not completed',()=>{
  const frames = [root(),move('0',tokenA,wallet,pool,40),call('0,0',tokenA,router,'0xaaaa0000'),
    call('0,0,0',router,pool,'0xbbbb0000'),move('0,0,0,0',tokenB,pool,wallet,30)];
  const logs = [receipt(4,tokenB,pool,wallet,30),receipt(5,tokenA,wallet,pool,40)];
  assert.deepEqual(run(frames,logs),[]);
});
test('two target calls keep separate flows including delegate-emitted proxy-token logs',()=>{
  const frames=[root(),call('0',router,pool,swap),move('0,0',tokenA,wallet,pool,5),
    call('0,0,0',tokenA,addr(6),'0xa9059cbb'+word(pool)+word(5),{kind:'delegatecall'}),
    move('0,1',tokenB,pool,wallet,9),call('1',router,pool,'0xaaaa0000'),
    move('1,0',tokenB,wallet,pool,9),move('1,1',tokenA,pool,wallet,5)];
  const logs=[receipt(0,tokenA,wallet,pool,5),receipt(1,tokenB,pool,wallet,9),receipt(2,tokenB,wallet,pool,9),receipt(3,tokenA,pool,wallet,5)];
  assert.deepEqual(run(frames,logs).map(e=>[e.selector,e.tokenIn,e.tokenOut]),[[swap,tokenA,tokenB],['0xaaaa0000',tokenB,tokenA]]);
  assert.equal(run(frames,logs.filter(l=>l.idx!==0)).length,1);
});
test('failed paths and unmatched or ambiguous log ownership cannot fund an edge',()=>{
  const frames=[root(),call('0',router,pool,swap),call('0,0',pool,wallet,'0x',{ok:false}),
    move('0,0,0',tokenA,wallet,pool,12),move('0,1',tokenB,pool,wallet,3)];
  const logs=[receipt(0,tokenA,wallet,pool,12),receipt(1,tokenB,pool,wallet,3)];
  assert.deepEqual(run(frames,logs),[]);
  frames[2].ok=true;
  assert.equal(run(frames,[...logs,{...logs[0],idx:2}]).length,0);
});

test('a settlement callback stays observable and does not hide a nested pool action',()=>{
  const otherPool = addr(7), otherAsset = addr(8), payer = addr(9);
  const frames = [root(),call('0',router,pool,'0x128acb08'),
    move('0,0',tokenB,pool,wallet,8),call('0,1',pool,wallet,'0xfa461e33'),
    move('0,1,0',tokenA,wallet,pool,10),call('0,1,1',wallet,otherPool,'0xaaaa0000'),
    move('0,1,1,0',tokenB,payer,otherPool,4),move('0,1,1,1',otherAsset,otherPool,payer,3)];
  const logs = [receipt(0,tokenB,pool,wallet,8),receipt(1,tokenA,wallet,pool,10),
    receipt(2,tokenB,payer,otherPool,4),receipt(3,otherAsset,otherPool,payer,3)];
  const rows = traceCallFlows(frames,logs,cfg);
  assert.deepEqual(rows.map(e=>[e.selector,e.poolAddress,e.tokenIn,e.tokenOut]),[
    ['0x128acb08',pool,tokenA,tokenB],['0xfa461e33',wallet,tokenB,tokenA],
    ['0xaaaa0000',otherPool,tokenB,otherAsset],
  ]);
});
test('native ETH nets the real CALL value and refunds, remains distinct from WETH and ignores delegate value',()=>{
  const weth='0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',large=2n**185n;
  const frames=[root(),call('0',router,pool,swap,{value:String(large)}),
    call('0,0',pool,router,'0x',{value:String(large-1n)}),
    call('0,1',pool,addr(7),'0x',{kind:'delegatecall',value:String(large)}),
    move('0,2',weth,pool,wallet,10)];
  const logs=[receipt(0,weth,pool,wallet,10)];
  assert.deepEqual(run(frames,logs).map(e=>[e.tokenIn,e.tokenOut]),[[cfg.native,weth]]);
  frames[2].value=String(large);
  assert.deepEqual(run(frames,logs),[]);
});
test('unknown calls on a shared manager do not fall back to address-pool edges',async()=>{
  const manager=poolIdLayouts[0].emitter;
  const frames=[root(),call('0',router,manager,swap),move('0,0',tokenA,wallet,manager,2),move('0,1',tokenB,manager,wallet,1)];
  assert.deepEqual(traceCallFlows(frames,[receipt(0,tokenA,wallet,manager,2),receipt(1,tokenB,manager,wallet,1)],cfg),[]);
  const sql=await renderIndependentTraceEdges(ready21Window);
  assert.deepEqual([...new Set([...sql.matchAll(/`([\w.-]+)\x60/g)].map(m=>m[1]))].sort(),
    ['blocks','logs','traces','transactions'].map(n=>'bigquery-public-data.crypto_ethereum.'+n));
});
test('one caller pays and receives minted shares; a different beneficiary is not its receipt',()=>{
  const qty=13n, shares=9n, frames=[root(),call('0',wallet,pool,'0x6e553f65'+word(qty)+word(wallet)),
    call('0,0',pool,tokenA,'0x23b872dd'+word(wallet)+word(pool)+word(qty))];
  const payment=receipt(4,tokenA,wallet,pool,qty);
  const result=run(frames,[payment,receipt(5,pool,cfg.native,wallet,shares)]);
  assert.deepEqual(result.map(e=>[e.evidence,e.tokenIn,e.tokenOut,e.amountPayerInRaw,e.amountReceivedOutRaw]),
    [['caller-receipt-net-flow',tokenA,pool,'13','9']]);
  assert.deepEqual(run(frames,[payment,receipt(5,pool,cfg.native,router,shares)]),[]);
});

test('unknown selectors on the same target produce both directions from distinct caller receipts',()=>{
  const buy='0xaabb0011', sell='0xaabb0022';
  const frames=[root(),call('0',router,pool,sell),move('0,0',tokenA,pool,router,18),
    move('1',tokenA,router,wallet,17),call('2',router,pool,buy),
    call('2,0',pool,tokenA,'0x23b872dd'+word(router)+word(pool)+word(7))];
  const logs=[receipt(0,pool,router,cfg.native,13),receipt(1,tokenA,pool,router,18),
    receipt(2,tokenA,router,wallet,17),receipt(3,pool,cfg.native,router,5),receipt(4,tokenA,router,pool,7)];
  const edges=(f,l)=>run(f,l).map(e=>[e.callPath,e.selector,e.tokenIn,e.tokenOut,e.receiptIndices,
    e.amountPayerInRaw,e.amountReceivedOutRaw]).sort();
  assert.deepEqual(edges(frames,logs),[['0',sell,pool,tokenA,'0,1','13','18'],['2',buy,tokenA,pool,'3,4','7','5']]);
  assert.deepEqual(edges(frames.map(f=>f.path==='0'?{...f,ok:false}:f),logs.slice(2)).map(e=>e[0]),['2']);
  // Same token could have emitted this payment in either of two sibling calls.
  const sibling=call('1',router,tokenA,'0x23b872dd'+word(pool)+word(router)+word(18));
  assert.deepEqual(edges([...frames.slice(0,3),sibling],logs.slice(0,2)),[]);
});
test('a nested action by the same caller owns its transfers; three currencies do not imply a pair',()=>{
  const inner=addr(71), custody=addr(72);
  const frames=[root(),call('0',router,pool,'0xaaaa0001'),call('0,0',pool,router,'0xaaaa0002'),
    call('0,0,0',router,inner,'0xaaaa0003'),
    call('0,0,0,0',inner,tokenA,'0x23b872dd'+word(router)+word(custody)+word(20))];
  const logs=[receipt(1,tokenA,router,custody,20),receipt(2,inner,cfg.native,router,15)];
  const rows=(f,l)=>traceCallFlows(f,l,cfg).filter(e=>e.evidence==='caller-receipt-net-flow');
  assert.deepEqual(rows(frames,logs).map(e=>[e.callPath,e.tokenIn,e.tokenOut]),[['0,0,0',tokenA,inner]]);
  const third=call('0,0,0,1',inner,tokenB,'0xa9059cbb'+word(router)+word(3));
  assert.deepEqual(rows([...frames,third],[...logs,receipt(3,tokenB,inner,router,3)]),[]);
  const nativeInput=frames.map(n=>n.path==='0,0,0'?{...n,value:'1'}:n);
  assert.deepEqual(rows(nativeInput,logs),[]);
});
test('a native refund does not create the reverse direction and ambiguous multi-token inputs stay unresolved',()=>{
  const frames=[root(),call('1',router,pool,swap,{value:'1'}),move('1,0',tokenA,wallet,pool,10),move('1,1',tokenB,pool,wallet,10)];
  assert.deepEqual(run(frames,[receipt(0,tokenA,wallet,pool,10),receipt(1,tokenB,pool,wallet,10)]),[]);
});
test('Balancer Swap keeps the Vault call target and uses the calldata-backed pool ID, with no address fallback',()=>{
  const vault=poolIdLayouts[1];
  const poolId=pool+'00'.repeat(12);
  const calldata='0x52bbbe29'+word(224)+'0'.repeat(6*64)+poolId.slice(2)+word(0)+word(tokenA)+word(tokenB)+word(15)+word(192)+word(0);
  const nodes=[root(),call('1',router,vault.emitter,calldata)];
  const event={idx:2,emitter:vault.emitter,topics:[vault.topic,poolId,'0x'+word(tokenA),'0x'+word(tokenB)],data:'0x'+word(15)+word(9)};
  const [edge]=traceCallFlows(nodes,[event],cfg);
  assert.equal(edge.selectorTarget,vault.emitter);
  assert.equal(edge.poolAddress,pool);
  assert.equal(edge.poolId,poolId);
  assert.deepEqual(traceCallFlows(nodes,[{...event,topics:[vault.topic,'0x'+word(123),...event.topics.slice(2)]}],cfg),[]);
  assert.deepEqual(traceCallFlows(nodes,[{...event,data:'0x'+word(16)+word(9)}],cfg),[]);
});
test('V4 and Balancer use the same full-ID binding; V4 also proves enclosing unlock, sender and direction',()=>{
  const layout=poolIdLayouts[0], m=layout.emitter;
  const key=word(0)+word(tokenB)+word(3000)+word(60)+word(0);
  const id=keccak256('0x'+key), input=layout.action+key+word(1)+word(7)+word(10)+word(288)+word(0);
  const frames=[root(),call('0',router,m,layout.entry),call('0,0',m,router,'0x12345678'),call('0,0,0',router,m,input)];
  const event={idx:4,emitter:m,topics:[layout.topic,id,'0x'+word(router)],
    data:'0x'+word(2n**256n-5n)+word(7)+word(9)+word(1)+word(0)+word(3000)};
  const rows=(f,l)=>traceCallFlows(f,l,cfg);
  const [e]=rows(frames,[event]);
  assert.deepEqual([e.poolId,e.selector,e.callPath,e.innerSwapPath,e.tokenIn,e.tokenOut],[id,layout.entry,'0','0,0,0',cfg.native,tokenB]);
  for(const bad of [{topics:[layout.topic,'0x'+word(123),'0x'+word(router)]},
    {topics:[layout.topic,id,'0x'+word(wallet)]},{data:'0x'+word(5)+word(2n**256n-7n)+event.data.slice(130)}]){
    assert.deepEqual(rows(frames,[{...event,...bad}]),[]);
  }
  assert.deepEqual(rows(frames.map((f,i)=>i===1?{...f,input:'0x12345678'}:f),[event]),[]);
  assert.deepEqual(rows(frames.map((f,i)=>i===2?{...f,ok:false}:f),[event]),[]);
  assert.deepEqual(rows(frames,[event,{...event,idx:5}]),[]);
});
test('a smaller credited input needs a unique transfer, a bound swap and the exact observed output',()=>{
  const frame=call('1',router,pool,swap+word(0)+word(30)+word(wallet));
  const frames=[root(),move('0',tokenA,wallet,pool,100),frame,move('1,0',tokenB,pool,wallet,30)];
  const credit=receipt(10,tokenA,wallet,pool,97),debit=receipt(11,tokenB,pool,wallet,30);
  const event={idx:12,emitter:pool,topics:[cfg.amountSwapTopic,'0x'+word(router),'0x'+word(wallet)],
    data:'0x'+word(97)+word(0)+word(0)+word(30)};
  const logs=[credit,debit,event], [e]=run(frames,logs);
  assert.deepEqual([e.tokenIn,e.tokenOut,e.evidence,e.receiptIndices],[tokenA,tokenB,'swap-confirmed-net-input','10,11,12']);
  assert.deepEqual(run(frames,[credit,debit]),[]);
  const extra=receipt(10,tokenA,wallet,pool,101);
  assert.equal(run(frames,[extra,debit,{...event,data:'0x'+word(101)+event.data.slice(66)}])[0].evidence,e.evidence);
  for(const bad of [{...event,emitter:router},{...event,data:'0x'+word(98)+event.data.slice(66)},
    {...event,topics:[cfg.amountSwapTopic,'0x'+word(wallet),'0x'+word(wallet)]}]){
    assert.deepEqual(run(frames,[credit,debit,bad]),[]);
  }
  assert.deepEqual(run(frames,[receipt(9,tokenB,router,pool,1),...logs]),[]);
  assert.deepEqual(run(frames,[{...credit,idx:9},...logs]),[]);
  assert.deepEqual(run([frames[0],frames[1],{...frames[1],path:'0,0'},...frames.slice(2)],logs),[]);
  assert.deepEqual(run([frames[0],frames[2],frames[3],{...frames[1],path:'2'}],logs),[]);
  assert.equal(run(frames,[receipt(10,tokenA,wallet,pool,100),debit])[0].evidence,'prepaid-and-subtree-net-flow');
});
test('parallel vault swaps remain distinct by full poolId even at a common pool address and token pair',()=>{
  const layout=poolIdLayouts.find(l=>l.entry==='0x52bbbe29');
  const ids=[pool+'00'.repeat(11)+'01',pool+'00'.repeat(11)+'02'];
  const calls=ids.map((id,i)=>call(String(i),router,layout.emitter,layout.action+word(224)+'0'.repeat(6*64)+id.slice(2)
    +word(0)+word(tokenA)+word(tokenB)+word(15)+word(192)+word(0)));
  const logs=ids.map((id,i)=>({idx:i,emitter:layout.emitter,topics:[layout.topic,id,'0x'+word(tokenA),'0x'+word(tokenB)],
    data:'0x'+word(15)+word(9)}));
  const rows=traceCallFlows([root(),...calls],logs,cfg);
  assert.deepEqual(rows.map(e=>[e.poolAddress,e.poolId,e.tokenIn,e.tokenOut]),ids.map(id=>[pool,id,tokenA,tokenB]));
  assert.deepEqual(traceCallFlows([root(),...calls],[logs[0],{...logs[0],idx:1}],cfg),[]);
  assert.deepEqual(traceCallFlows([root(),...calls],[{...logs[1],idx:0},{...logs[0],idx:1}],cfg),[]);
});

function netPayoutCase(inputReceived = 40n, outputReceived = 27n) {
  const nominal = 30n;
  const frame = call('1', router, pool, swap + word(0) + word(nominal) + word(wallet));
  const frames = [root(), move('0', tokenA, wallet, pool, 40n), frame, move('1,0', tokenB, pool, wallet, nominal)];
  const credit = receipt(10, tokenA, wallet, pool, inputReceived);
  const payout = receipt(11, tokenB, pool, wallet, outputReceived);
  const event = {idx: 12, emitter: pool, topics: [cfg.amountSwapTopic, '0x' + word(router), '0x' + word(wallet)],
    data: '0x' + word(inputReceived) + word(0) + word(0) + word(nominal)};
  return {frames, credit, payout, event};
}

test('Swap binds its gross output to calldata and keeps the actual recipient credit in raw units', () => {
  for (const actual of [27n, 34n, 2n ** 180n + 3n]) {
    const {frames, credit, payout, event} = netPayoutCase(40n, actual);
    const [edge] = run(frames, [credit, payout, event]);
    assert.deepEqual([edge.evidence, edge.callPath, edge.tokenIn, edge.tokenOut, edge.receiptIndices],
      ['swap-confirmed-net-output', '1', tokenA, tokenB, '10,11,12']);
    assert.deepEqual([edge.amountPoolOutRaw, edge.amountReceivedOutRaw], ['30', String(actual)]);
  }
  const {frames, credit, payout, event} = netPayoutCase(38n);
  const [edge] = run(frames, [credit, payout, event]);
  assert.equal(edge.evidence, 'swap-confirmed-net-input-and-output');
  assert.equal(edge.amountReceivedOutRaw, '27');
});

test('an output discrepancy requires a unique swap call, event, recipient and transfer', () => {
  const {frames, credit, payout, event} = netPayoutCase();
  for (const logs of [
    [credit, payout], [payout, event], [credit, event],
    [credit, payout, {...event, emitter: router}],
    [credit, payout, {...event, topics: [cfg.amountSwapTopic, '0x' + word(wallet), event.topics[2]]}],
    [credit, payout, {...event, topics: [cfg.amountSwapTopic, event.topics[1], '0x' + word(router)]}],
    [credit, payout, {...event, data: '0x' + word(41) + event.data.slice(66)}],
    [credit, payout, {...event, data: event.data.slice(0, 194) + word(29)}],
    [credit, payout, event, {...event, idx: 13}],
    [credit, payout, {...payout, idx: 12}, {...event, idx: 13}],
    [credit, receipt(11, tokenB, pool, router, 27n), event],
    [credit, receipt(11, tokenA, pool, wallet, 27n), event],
    [credit, payout, receipt(12, addr(8), pool, wallet, 1n), {...event, idx: 13}],
    [credit, event, {...payout, idx: 13}],
  ]) assert.deepEqual(run(frames, logs), []);

  const logs = [credit, payout, event];
  for (const ambiguousFrames of [
    [...frames, {...frames[2], path: '2'}],
    [...frames, move('1,1', tokenB, pool, wallet, 30n)],
    [...frames, move('1,1', addr(8), pool, wallet, 30n)],
    [frames[0], frames[1], frames[2], {...frames[3], path: '2'}],
    [frames[0], frames[1], frames[2], {...frames[3], ok: false}],
    [frames[0], frames[2], frames[3], {...frames[1], path: '2'}],
  ]) assert.deepEqual(run(ambiguousFrames, logs), []);
});

test('a prepaid input belongs to at most one payout-bearing pool call', () => {
  const {frames, credit, payout, event} = netPayoutCase();
  const tail = [call('2', router, pool, '0x12345678'), move('2,0', addr(8), pool, wallet, 9n)];
  const rows = run([...frames, ...tail], [credit, payout, event, receipt(13, addr(8), pool, wallet, 9n)]);
  assert.deepEqual(rows.map(e => [e.callPath, e.evidence]), [['1', 'swap-confirmed-net-output']]);
});

const batchAbi = new Interface([
  'function batchSwap(uint8 kind,(bytes32 poolId,uint256 assetInIndex,uint256 assetOutIndex,uint256 amount,bytes userData)[] steps,address[] assets,(address,bool,address,bool) funds,int256[] limits,uint256 deadline)',
]);
test('batch binds every step in receipt order, including zero-amount chains in both directions', () => {
  const layout = poolIdLayouts.find(l => l.entry === '0x945bcec9');
  const ids = [pool + '00'.repeat(12), addr(7) + '01'.repeat(12)];
  const assets = [tokenA, tokenB, addr(6)];
  const event = (idx,id,a,b,qtyIn,qtyOut) => ({
    idx, emitter: layout.emitter, topics:[layout.topic, id, '0x'+word(a), '0x'+word(b)],
    data:'0x'+word(qtyIn)+word(qtyOut),
  });
  const forward = [event(3,ids[0],assets[0],assets[1],20,15),event(4,ids[1],assets[1],assets[2],15,8)];
  for (const kind of [0,1]) {
    const steps = kind === 0 ? [[ids[0],0,1,20,'0x'],[ids[1],1,2,0,'0x']]
      : [[ids[1],1,2,8,'0x'],[ids[0],0,1,0,'0x']];
    const logs = (kind === 0 ? forward : [...forward].reverse()).map((e,i) => ({...e,idx:i+3}));
    const encode = s => batchAbi.encodeFunctionData('batchSwap',[kind,s,assets,[wallet,false,wallet,false],[0,0,0],0]);
    const frame = call('0',router,layout.emitter,encode(steps));
    const rows = (f,l) => traceCallFlows([root(),f],l,cfg);
    assert.deepEqual(rows(frame,logs).map(e=>[e.selector,e.poolId,e.receiptIndices]),
      steps.map(([id],i)=>[layout.entry,id,String(i+3)]));
    assert.deepEqual(rows(frame,logs.slice(0,1)),[]);
    assert.deepEqual(rows(frame,[{...logs[1],idx:3},{...logs[0],idx:4}]),[]);
    const badAmount = kind===0 ? word(14)+word(8) : word(20)+word(14);
    assert.deepEqual(rows(frame,[logs[0],{...logs[1],data:'0x'+badAmount}]),[]);
    assert.deepEqual(rows({...frame,input:encode([[...steps[0].slice(0,3),0,'0x'],steps[1]])},logs),[]);
    assert.deepEqual(rows({...frame,input:encode([steps[0],[steps[1][0],9,2,0,'0x']])},logs),[]);
    assert.deepEqual(rows({...frame,input:layout.entry+word(kind)+word(2n**240n)+frame.input.slice(138)},logs),[]);
    const single = poolIdLayouts.find(l=>l.entry==='0x52bbbe29');
    const singleData=single.action+word(224)+'0'.repeat(6*64)+ids[0].slice(2)+word(0)+word(tokenA)+word(tokenB)+word(20)+word(192)+word(0);
    const sibling=call('1',router,single.emitter,singleData);
    const mixed=traceCallFlows([root(),frame,sibling],[...logs,{...forward[0],idx:7}],cfg);
    assert.deepEqual(mixed.map(e=>e.selector),[layout.entry,layout.entry,single.entry]);
    assert.deepEqual(traceCallFlows([root(),frame,{...sibling,path:'0,0'}],[...logs,{...forward[0],idx:7}],cfg),[]);
  }
});

const receiptRules = compileActionReceipts(fileURLToPath(new URL('../', import.meta.url)));
const receiptConfig = {...cfg, actionReceipts:receiptRules};
const actionsAt = (frames,logs,target=pool) => traceCallFlows(frames,logs,receiptConfig)
  .filter(row=>row.poolAddress===target && row.evidence==='declared-action-receipt');

test('the action event binds mint or deposit to its real selector, payer, owner and units',()=>{
  const assets=15n, shares=4n;
  const deposit='0x6e553f65', mint='0x94bf804d';
  for (const [selector,quantity] of [[deposit,assets],[mint,shares]]) {
    const frame=call('0',wallet,pool,selector+word(quantity)+word(router));
    const transfer=call('0,0',pool,tokenA,'0x23b872dd'+word(wallet)+word(addr(11))+word(assets));
    const cash=receipt(3,tokenA,wallet,addr(11),assets);
    const event={idx:4,emitter:pool,topics:[receiptRules[selector].topic,'0x'+word(wallet),'0x'+word(router)],data:'0x'+word(assets)+word(shares)};
    const rows=actionsAt([root(),frame,transfer],[cash,event]);
    assert.deepEqual(rows.map(r=>[r.selector,r.tokenIn,r.tokenOut,r.amountVenueInRaw,r.amountPayerInRaw,r.amountPoolOutRaw,r.amountReceivedOutRaw]),
      [[selector,tokenA,pool,'15','15','4',null]]);
    const nodes=[root(),frame,transfer];
    assert.deepEqual(actionsAt(nodes,[cash]),[]);
    assert.deepEqual(actionsAt(nodes,[cash,event,{...event,idx:5}]),[]);
    assert.deepEqual(actionsAt(nodes,[cash,{...event,topics:[event.topics[0],event.topics[2],event.topics[1]]}]),[]);
    assert.deepEqual(actionsAt(nodes,[cash,{...event,data:'0x'+word(77)+word(9)}]),[]);
    assert.deepEqual(actionsAt([...nodes,call('1',wallet,pool,'0xaaaaaaaa')],[cash,event]),[]);
    assert.deepEqual(actionsAt([root(),{...frame,ok:false},transfer],[cash,event]),[]);
  }
});

test('snapshot pins two token sides to the pool balances and does not invent a recipient credit',()=>{
  const rule=receiptRules[swap], frame=call('0',router,pool,swap+word(0)+word(9)+word(wallet));
  const read=(p,token,q)=>call(p,pool,token,rule.snapshot.read+word(pool),{kind:'staticcall',output:'0x'+word(q)});
  const sync={idx:1,emitter:pool,topics:[rule.snapshot.topic],data:'0x'+word(71)+word(31)};
  const event={idx:2,emitter:pool,topics:[rule.topic,'0x'+word(router),'0x'+word(wallet)],data:'0x'+word(17)+word(0)+word(0)+word(9)};
  const frames=[root(),frame,read('0,0',tokenB,31),read('0,1',tokenA,71)];
  const rows=actionsAt(frames,[sync,event]);
  assert.deepEqual(rows.map(r=>[r.tokenIn,r.tokenOut,r.amountVenueInRaw,r.amountPoolOutRaw,r.amountReceivedOutRaw]),[[tokenA,tokenB,'17','9',null]]);
  assert.deepEqual(actionsAt(frames,[{...sync,idx:3},event]),[]);
  assert.deepEqual(actionsAt(frames,[{...sync,data:'0x'+word(31)+word(31)},event]),[]);
  assert.deepEqual(actionsAt(frames,[sync,{...event,data:'0x'+word(17)+word(0)+word(0)+word(6)}]),[]);
  assert.deepEqual(actionsAt(frames.map((x,i)=>i===3?{...x,ok:false}:x),[sync,event]),[]);
});

test('a receipt-backed address leg cannot replace the required poolId at a shared manager',()=>{
  const target=poolIdLayouts[0].emitter;
  const frame=call('0',wallet,target,'0x6e553f65'+word(10)+word(wallet));
  const part=call('0,0',target,tokenA,'0x23b872dd'+word(wallet)+word(target)+word(10));
  const event={idx:2,emitter:target,topics:[receiptRules['0x6e553f65'].topic,'0x'+word(wallet),'0x'+word(wallet)],data:'0x'+word(10)+word(8)};
  assert.deepEqual(actionsAt([root(),frame,part],[receipt(1,tokenA,wallet,target,10),event],target),[]);
});

test('headers alone isolate the outer trade after an unknown callback, also through a proxy',()=>{
  const deposit='0x6e553f65', trade=call('0',wallet,pool,deposit+word(15)+word(router));
  const frames=[root(),trade,call('0,0',pool,addr(11),'0x12345678',{kind:'delegatecall'}),
    call('0,0,0',pool,addr(12),'0xaaaaaaaa'),call('0,0,0,0',addr(12),pool,'0xbbbbbbbb'),
    call('0,0,0,0,0',pool,tokenA,'0x23b872dd'+word(wallet)+word(addr(12))+word(15)),
    call('0,0,1',pool,addr(13),'0xcccccccc')];
  const cash=receipt(5,tokenA,wallet,addr(12),15);
  const marker={idx:6,emitter:addr(13),topics:[],data:null};
  const event={idx:7,emitter:pool,topics:[receiptRules[deposit].topic,'0x'+word(wallet),'0x'+word(router)],data:'0x'+word(15)+word(4)};
  const [bound]=actionsAt(frames,[cash,marker,event]);
  assert.deepEqual([bound.callPath,bound.tokenIn,bound.tokenOut],['0',tokenA,pool]);
  assert.deepEqual(actionsAt(frames,[cash,event]),[]);
  assert.deepEqual(actionsAt(frames,[cash,{...marker,emitter:addr(42)},event]),[]);
  assert.deepEqual(actionsAt(frames,[cash,marker,{...event,idx:6}]),[]);
});

test('two swaps at the same address read only their own snapshots and logs',()=>{
  const r=receiptRules[swap];
  const frames=[root()], logs=[];
  for (let i=0;i<2;i++){
    const path=String(2*i), q=i+11, out=i+3;
    frames.push(call(path,router,pool,swap+word(0)+word(out)+word(wallet)));
    for(const [j,t] of [tokenA,tokenB].entries())frames.push(call(path+','+j,pool,t,r.snapshot.read+word(pool),
      {kind:'staticcall',output:'0x'+word(q+j)}));
    const anchor=addr(15+i);
    frames.push(call(path+',2',pool,anchor,'0x'));
    logs.push({idx:i*4,emitter:anchor,topics:[],data:null},
      {idx:i*4+1,emitter:pool,topics:[r.snapshot.topic],data:'0x'+word(q)+word(q+1)},
      {idx:i*4+2,emitter:pool,topics:[r.topic,'0x'+word(router),'0x'+word(wallet)],data:'0x'+word(8)+word(0)+word(0)+word(out)});
    // A header outside the previous call brackets its trailing events.
    frames.push(call(String(2*i+1),router,addr(30+i),'0x'));
    logs.push({idx:i*4+3,emitter:addr(30+i),topics:[],data:null});
  }
  assert.deepEqual(actionsAt(frames,logs).map(e=>[e.callPath,e.amountPoolOutRaw,e.receiptIndices]).sort(),
    [['0','3','1,2'],['2','4','5,6']]);
  const duplicate=[...logs,{...logs[6],idx:8}];
  assert.deepEqual(actionsAt(frames,duplicate),[]); // impossible after the final bracketing call
});

test('an ambiguous event affects only overlapping calls at that emitter',()=>{
  const method='0x6e553f65', cfgTopic=receiptRules[method].topic;
  const enter=(p)=>call(p,wallet,pool,method+word(15)+word(router));
  const pay=(p)=>call(p,pool,tokenA,'0x23b872dd'+word(wallet)+word(addr(9))+word(15));
  const event=idx=>({idx,emitter:pool,topics:[cfgTopic,'0x'+word(wallet),'0x'+word(router)],data:'0x'+word(15)+word(4)});
  const marker={idx:3,emitter:addr(20),topics:[],data:null};
  const frames=[root(),enter('0'),pay('0,0'),call('1',wallet,pool,'0xdeadbeef'),call('2',wallet,addr(20),'0x'),enter('3'),pay('3,0')];
  const logs=[receipt(1,tokenA,wallet,addr(9),15),event(2),marker,receipt(4,tokenA,wallet,addr(9),15),event(5)];
  assert.deepEqual(actionsAt(frames,logs).map(e=>e.callPath),['3']);
  frames[3].ok=false;
  assert.deepEqual(actionsAt(frames,logs).map(e=>e.callPath).sort(),['0','3']);
});

test('an outer declared trade cannot borrow the inner trade on the same address as evidence of its currency',()=>{
  const sel='0x6e553f65', targetCall=p=>call(p,wallet,pool,sel+word(15)+word(router));
  const header=(idx,emitter)=>({idx,emitter,topics:[],data:null});
  const event=idx=>({idx,emitter:pool,topics:[receiptRules[sel].topic,'0x'+word(wallet),'0x'+word(router)],data:'0x'+word(15)+word(4)});
  const frames=[root(),targetCall('0'),call('0,0',pool,wallet,'0xaaaa0000'),targetCall('0,0,0'),
    call('0,0,0,0',pool,tokenA,'0x23b872dd'+word(wallet)+word(addr(9))+word(15)),call('0,0,0,1',pool,addr(10),'0x'),
    call('0,1',pool,addr(11),'0x')];
  const logs=[receipt(1,tokenA,wallet,addr(9),15),event(2),header(3,addr(10)),header(4,addr(11)),event(5)];
  assert.deepEqual(actionsAt(frames,logs).map(e=>e.callPath),['0,0,0']);
});

test('two otherwise indistinguishable entries can use a complete, ordered one-to-one calldata/event binding',()=>{
  const sel='0xb460af94';
  const qty=[13,29];
  const frames=[root()];
  for (const [i,assets] of qty.entries()) {
    const input=sel+word(assets)+word(wallet)+word(wallet),p=String(i);
    frames.push(call(p,wallet,pool,input),call(p+',0',pool,pool,'0x38d52e0f',{kind:'staticcall',output:'0x'+word(tokenA)}));
  }
  const events=qty.map((n,i)=>({idx:4+i,emitter:pool,topics:[receiptRules[sel].topic,...Array(3).fill('0x'+word(wallet))],
    data:'0x'+word(n)+word(n+1)}));
  const rows=(f,l)=>actionsAt(f,l).map(e=>[e.callPath,e.amountPoolOutRaw]).sort();
  assert.deepEqual(rows(frames,events),[['0','13'],['1','29']]);
  assert.deepEqual(rows(frames,[events[0]]),[]);
  assert.deepEqual(rows(frames,[events[0],{...events[0],idx:5}]),[]);
  assert.deepEqual(rows(frames,[{...events[1],idx:4},{...events[0],idx:5}]),[]);
  assert.deepEqual(rows([...frames,call('2',wallet,pool,'0xdeadbeef')],events),[]);
});

test('a relayed deposit needs both role-bound transfers with the declared argument and exact return',()=>{
  const sel='0x6e553f65', receiver=addr(13), custody=addr(14);
  const entry=call('0',router,pool,sel+word(15)+word(receiver),{output:'0x'+word(4)});
  const frames=[root(),entry,call('0,0',pool,tokenA,'0x12345678')];
  const cash=receipt(1,tokenA,wallet,custody,15), shares=receipt(2,pool,cfg.native,receiver,4);
  const event={idx:3,emitter:pool,topics:[receiptRules[sel].topic,'0x'+word(wallet),'0x'+word(receiver)],
    data:'0x'+word(15)+word(4)};
  const rows=(f,l)=>traceCallFlows(f,l,receiptConfig).filter(e=>e.poolAddress===pool);
  const [leg]=rows(frames,[cash,shares,event]);
  assert.deepEqual([leg.tokenIn,leg.tokenOut,leg.amountPayerInRaw,leg.amountReceivedOutRaw,leg.receiptIndices],
    [tokenA,pool,'15','4','1,2,3']);
  for(const rejected of [[shares,event],[cash,event],[cash,shares,{...event,data:'0x'+word(16)+word(4)}],
    [receipt(0,tokenB,wallet,custody,15),cash,shares,event], [cash,receipt(2,pool,cfg.native,wallet,4),event]])
    assert.deepEqual(rows(frames,rejected),[]);
  assert.deepEqual(rows([frames[0],{...entry,output:entry.output+'00'},frames[2]],[cash,shares,event]),[]);
  assert.deepEqual(rows([frames[0],{...entry,input:sel+word(16)+word(receiver)},frames[2]],[cash,shares,event]),[]);
});

test('a redeem with no action event binds the burn to the owner and payment to the receiver',()=>{
  const sel='0xba087652', receiver=addr(13);
  const entry=call('0',router,pool,sel+word(8)+word(receiver)+word(wallet),{output:'0x'+word(25)});
  const frames=[root(),entry,call('0,0',pool,tokenB,'0x33333333')];
  const burn=receipt(1,pool,wallet,cfg.native,8), payment=receipt(2,tokenB,addr(12),receiver,25);
  const rows=(f,l)=>traceCallFlows(f,l,receiptConfig).filter(e=>e.poolAddress===pool);
  assert.deepEqual(rows(frames,[burn,payment]).map(e=>[e.tokenIn,e.tokenOut,e.evidence]),[[pool,tokenB,'declared-settlement-transfers']]);
  assert.deepEqual(rows(frames,[burn,receipt(2,tokenB,addr(12),wallet,25)]),[]);
  assert.deepEqual(rows([...frames,call('1',router,pool,entry.input,{output:entry.output})],[payment,{...burn,idx:3}]),[]);
});

test('a bound receipt pair supersedes a conflicting generic flow and retains its evidence',()=>{
  const other=addr(15),read=(path,selector,asset)=>call(path,pool,pool,selector,{kind:'staticcall',output:'0x'+word(asset)});
  const frames=[root(),call('0',router,pool,swap+word(0)+word(9)+word(wallet)),
    read('0,0','0x0dfe1681',tokenA),read('0,1','0xd21220a7',tokenB),
    move('0,2',other,wallet,pool,11),move('0,3',tokenB,pool,wallet,9)];
  const logs=[receipt(1,other,wallet,pool,11),receipt(2,tokenB,pool,wallet,9),
    {idx:3,emitter:pool,topics:[cfg.amountSwapTopic,'0x'+word(router),'0x'+word(wallet)],data:'0x'+word(15)+word(0)+word(0)+word(9)}];
  const rows=traceCallFlows(frames,logs,receiptConfig).filter(e=>e.poolAddress===pool);
  assert.deepEqual(rows.map(e=>[e.tokenIn,e.tokenOut,e.evidence,e.conflictingFlow]),[[tokenA,tokenB,'declared-action-receipt',
    {tokenIn:other,tokenOut:tokenB,evidence:'subtree-net-flow',receiptIndices:'1,2'}]]);
});

test('a conflict between proven token identity and proven payments withholds the whole frame',()=>{
  const sel='0x6e553f65',other=addr(15);
  const input=sel+word(15)+word(wallet);
  const frames=[root(),call('0',wallet,pool,input,{output:'0x'+word(4)}),
    call('0,0',pool,pool,'0x38d52e0f',{kind:'staticcall',output:'0x'+word(other)}),
    move('0,1',tokenA,wallet,pool,15),move('0,2',tokenB,pool,wallet,7)];
  const logs=[receipt(1,tokenA,wallet,pool,15),receipt(2,tokenB,pool,wallet,7),receipt(3,pool,cfg.native,wallet,4),
    {idx:4,emitter:pool,topics:[receiptRules[sel].topic,'0x'+word(wallet),'0x'+word(wallet)],data:'0x'+word(15)+word(4)}];
  assert.equal(run(frames,logs).length,1);
  assert.deepEqual(traceCallFlows(frames,logs,receiptConfig).filter(e=>e.poolAddress===pool),[]);
});
