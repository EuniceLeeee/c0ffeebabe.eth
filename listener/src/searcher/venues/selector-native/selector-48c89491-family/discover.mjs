// Uniswap V4: PoolManager Swap event plus settlement transfers.
// hookData is read from the inner PoolManager.swap call, not from the event.
const selector='0x48c89491';
const swapSelector='0xf3cd914c';
const eventTopic0='0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f';
const transferTopic='0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const zero='0x0000000000000000000000000000000000000000';
const word=(d,i)=>d?.slice(2+i*64,2+(i+1)*64);
const sint=w=>/^[0-9a-f]{64}$/.test(w)?BigInt.asIntN(256,BigInt('0x'+w)):undefined;
const addr=w=>/^0{24}[a-f0-9]{40}$/.test(w)?'0x'+w.slice(24):null;
const topicAddr=t=>typeof t==='string'&&/^0x[0-9a-f]{64}$/.test(t)?addr(t.slice(2)):null;
const abs=x=>x<0n?-x:x;
const isDescendant=(parent,child)=>child.path!==parent.path&&child.path.startsWith(parent.path+',');

function decodeHookData(input){
 const data=typeof input==='string'&&input.startsWith(swapSelector)?input.slice(10):null;
 if(!data||data.length<8*64+64)return;
 const offsetWord=data.slice(8*64,9*64);
 if(!/^[0-9a-f]{64}$/.test(offsetWord))return;
 const offset=Number(BigInt('0x'+offsetWord));
 if(!Number.isSafeInteger(offset)||offset<0||offset%32!==0)return;
 const at=offset*2;
 if(at+64>data.length)return;
 const lengthWord=data.slice(at,at+64);
 if(!/^[0-9a-f]{64}$/.test(lengthWord))return;
 const length=Number(BigInt('0x'+lengthWord));
 if(!Number.isSafeInteger(length)||length<0||at+64+length*2>data.length)return;
 return '0x'+data.slice(at+64,at+64+length*2);
}

export function discover(n,c,ctx){
 if(n.kind!=='call'||n.selector!==selector)return;
 const swapEvent=ctx.uniqueLog(n,eventTopic0,(f,l)=>f===n&&l.emitter===n.target&&l.topics.length===3&&l.data?.length===2+6*64);
 if(!swapEvent)return;
 const a0=sint(word(swapEvent.data,0)),a1=sint(word(swapEvent.data,1));
 if(a0===undefined||a1===undefined||a0===0n||a1===0n||(a0>0n)===(a1>0n))return;
 const amounts=new Set([String(abs(a0)),String(abs(a1))]);
 const ins=[],outs=[];
 for(const l of ctx.byTopic.get(transferTopic)??[]){
  if(l.topics.length!==3||!l.data||l.data.length!==66)continue;
  const from=topicAddr(l.topics[1]),to=topicAddr(l.topics[2]),amount=word(l.data,0);
  if(!from||!to||from===to||!/^[0-9a-f]{64}$/.test(amount)||!amounts.has(String(BigInt('0x'+amount))))continue;
  if(to===n.target)ins.push({log:l,token:l.emitter,amount:BigInt('0x'+amount)});
  if(from===n.target)outs.push({log:l,token:l.emitter,amount:BigInt('0x'+amount)});
 }
 if(ins.length!==1||outs.length>1)return;
 const i=ins[0];
 const other=[...amounts].find(x=>x!==String(i.amount));
 const o=outs[0]??(other?{log:null,token:zero,amount:BigInt(other)}:undefined);
 if(!o)return;
 const ids=[i.log.idx,o.log?.idx??swapEvent.idx,swapEvent.idx].filter((x,j,a)=>a.indexOf(x)===j);
 const owners=ctx.owners?.get(swapEvent);
 const candidateSwaps=ctx.nodes.filter(x=>x.valid&&x.kind==='call'&&x.target===n.target&&x.selector===swapSelector&&isDescendant(n,x));
 const ownedSwaps=owners?candidateSwaps.filter(x=>owners.has(x)):candidateSwaps;
 const inner=ownedSwaps.length===1?ownedSwaps[0]:candidateSwaps.length===1?candidateSwaps[0]:undefined;
 const hookData=inner?decodeHookData(inner.input):undefined;
 return {selector:n.selector,callPath:n.path,selectorTarget:n.target,poolAddress:n.target,poolId:swapEvent.topics[1].toLowerCase(),innerSwapPath:inner?.path??null,
  tokenIn:i.token,tokenOut:o.token,receiptIndices:ids.join(','),receiptRoles:o.log?['in','out','event']:['in','event'],
  evidence:'univ4-swap-event-settlement',amountVenueInRaw:String(i.amount),amountPayerInRaw:String(i.amount),amountPoolOutRaw:String(o.amount),amountReceivedOutRaw:String(o.amount),
  ...(hookData!==undefined?{hookData}:{})};
}
