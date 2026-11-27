// Uniswap V3: the pool's Swap event plus the two settlement Transfer logs.
const selector='0x128acb08',eventTopic0='0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67',transferTopic='0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const word=(d,i)=>d?.slice(2+i*64,2+(i+1)*64);
const sint=w=>/^[0-9a-f]{64}$/.test(w)?BigInt.asIntN(256,BigInt('0x'+w)):undefined;
const addr=w=>/^0{24}[a-f0-9]{40}$/.test(w)?'0x'+w.slice(24):null;
const topicAddr=t=>typeof t==='string'&&/^0x[0-9a-f]{64}$/.test(t)?addr(t.slice(2)):null;
const abs=x=>x<0n?-x:x;
export function discover(n,c,ctx){
 if(n.kind!=='call'||n.selector!==selector)return;
 const swap=ctx.uniqueLog(n,eventTopic0,(f,l)=>f===n&&l.emitter===n.target&&l.topics.length===3&&l.data?.length===2+5*64);
 if(!swap)return;
 const a0=sint(word(swap.data,0)),a1=sint(word(swap.data,1));
 if(a0===undefined||a1===undefined||a0===0n||a1===0n||(a0>0n)===(a1>0n))return;
 const amountIn=abs(a0>0n?a0:a1),amountOut=abs(a0<0n?a0:a1);
 const facts=[];
 for(const l of ctx.byTopic.get(transferTopic)??[]){
  if(l.topics.length!==3||!l.data||l.data.length!==66)continue;
  const from=topicAddr(l.topics[1]),to=topicAddr(l.topics[2]),amount=word(l.data,0);
  if(!from||!to||from===to||!/^[0-9a-f]{64}$/.test(amount))continue;
  if(to===n.target&&BigInt('0x'+amount)===amountIn)facts.push({kind:'in',log:l,token:l.emitter,amount:BigInt('0x'+amount)});
  if(from===n.target&&BigInt('0x'+amount)===amountOut)facts.push({kind:'out',log:l,token:l.emitter,amount:BigInt('0x'+amount)});
 }
 const ii=facts.filter(x=>x.kind==='in'),oo=facts.filter(x=>x.kind==='out');
 if(ii.length!==1||oo.length!==1)return;
 const i=ii[0],o=oo[0];
 if(i.log.idx>=swap.idx||o.log.idx>=swap.idx)return;
 return {selector:n.selector,callPath:n.path,selectorTarget:n.target,poolAddress:n.target,poolId:null,innerSwapPath:null,
  tokenIn:i.token,tokenOut:o.token,receiptIndices:[i.log.idx,o.log.idx,swap.idx].join(','),receiptRoles:['in','out','event'],
  evidence:'univ3-swap-event-transfer-pair',amountVenueInRaw:String(i.amount),amountPayerInRaw:String(i.amount),amountPoolOutRaw:String(o.amount),amountReceivedOutRaw:String(o.amount)};
}
