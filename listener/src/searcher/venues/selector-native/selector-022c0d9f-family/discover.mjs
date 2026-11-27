// Uniswap V2: the pool's Swap event plus its input/output Transfer logs.
const selector='0x022c0d9f',eventTopic0='0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822',transferTopic='0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const word=(d,i)=>d?.slice(2+i*64,2+(i+1)*64);
const uint=w=>/^[0-9a-f]{64}$/.test(w)?BigInt('0x'+w):undefined;
const addr=w=>/^0{24}[a-f0-9]{40}$/.test(w)?'0x'+w.slice(24):null;
const topicAddr=t=>typeof t==='string'&&/^0x[0-9a-f]{64}$/.test(t)?addr(t.slice(2)):null;
export function discover(n,c,ctx){
 if(n.kind!=='call'||n.selector!==selector)return;
 const swap=ctx.uniqueLog(n,eventTopic0,(f,l)=>f===n&&l.emitter===n.target&&l.topics.length===3&&l.data?.length===2+4*64);
 if(!swap)return;
 const w=[0,1,2,3].map(i=>word(swap.data,i));
 const ins=[w[0],w[1]].filter(x=>uint(x)>0n),outs=[w[2],w[3]].filter(x=>uint(x)>0n);
 if(ins.length!==1||outs.length!==1)return;
 const amountIn=ins[0],amountOut=outs[0];
 const facts=[];
 for(const l of ctx.byTopic.get(transferTopic)??[]){
  if(l.topics.length!==3||!l.data||l.data.length!==66)continue;
  const from=topicAddr(l.topics[1]),to=topicAddr(l.topics[2]),amount=word(l.data,0);
  if(!from||!to||from===to||!uint(amount))continue;
  if(to===n.target&&amount===amountIn)facts.push({kind:'in',log:l,token:l.emitter,amount:uint(amount)});
  if(from===n.target&&amount===amountOut)facts.push({kind:'out',log:l,token:l.emitter,amount:uint(amount)});
 }
 const ii=facts.filter(x=>x.kind==='in'),oo=facts.filter(x=>x.kind==='out');
 if(ii.length!==1||oo.length!==1)return;
 const i=ii[0],o=oo[0];
 if(i.log.idx>=o.log.idx||o.log.idx>=swap.idx)return;
 return {selector:n.selector,callPath:n.path,selectorTarget:n.target,poolAddress:n.target,poolId:null,innerSwapPath:null,
  tokenIn:i.token,tokenOut:o.token,receiptIndices:[i.log.idx,o.log.idx,swap.idx].join(','),receiptRoles:['in','out','event'],
  evidence:'univ2-swap-event-transfer-pair',amountVenueInRaw:String(i.amount),amountPayerInRaw:String(i.amount),amountPoolOutRaw:String(o.amount),amountReceivedOutRaw:String(o.amount)};
}
