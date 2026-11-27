// Curve exchange: TokenExchange event plus settlement transfers.
const selector='0x3df02124',eventTopic0='0x8b3e96f2b889fa771c53c981b40daf005f63f637f1869f707052d15a3dd97140',transferTopic='0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const word=(d,i)=>d?.slice(2+i*64,2+(i+1)*64);
const uint=w=>/^[0-9a-f]{64}$/.test(w)?BigInt('0x'+w):undefined;
const addr=w=>/^0{24}[a-f0-9]{40}$/.test(w)?'0x'+w.slice(24):null;
const topicAddr=t=>typeof t==='string'&&/^0x[0-9a-f]{64}$/.test(t)?addr(t.slice(2)):null;
export function discover(n,c,ctx){
 if(n.kind!=='call'||n.selector!==selector)return;
 const ev=ctx.uniqueLog(n,eventTopic0,(f,l)=>f===n&&l.emitter===n.target&&l.topics.length===2&&l.data?.length===2+4*64);
 if(!ev)return;
 const amountIn=uint(word(ev.data,1)),amountOut=uint(word(ev.data,3));
 if(!amountIn||!amountOut)return;
 const ins=[],outs=[];
 for(const l of ctx.byTopic.get(transferTopic)??[]){
  if(l.topics.length!==3||!l.data||l.data.length!==66)continue;
  const from=topicAddr(l.topics[1]),to=topicAddr(l.topics[2]),amount=word(l.data,0);
  if(!from||!to||from===to||!uint(amount))continue;
  const v=BigInt('0x'+amount);
  if(to===n.target&&v===amountIn)ins.push({log:l,token:l.emitter,amount:v});
  if(from===n.target&&v===amountOut)outs.push({log:l,token:l.emitter,amount:v});
 }
 if(ins.length!==1||outs.length!==1)return;
 const i=ins[0],o=outs[0];
 if(i.log.idx>=ev.idx||o.log.idx>=ev.idx)return;
 return {selector:n.selector,callPath:n.path,selectorTarget:n.target,poolAddress:n.target,poolId:null,innerSwapPath:null,
  tokenIn:i.token,tokenOut:o.token,receiptIndices:[i.log.idx,o.log.idx,ev.idx].join(','),receiptRoles:['in','out','event'],
  evidence:'curve-token-exchange',amountVenueInRaw:String(i.amount),amountPayerInRaw:String(i.amount),amountPoolOutRaw:String(o.amount),amountReceivedOutRaw:String(o.amount)};
}
