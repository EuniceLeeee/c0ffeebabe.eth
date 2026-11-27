// Unwrap: wrapper burn + underlying transfer out.
const selector='0x5dbd6059',eventTopic0='0x12d6424519838e57637c6db9df31af32d7926ff0a53dd37007c191d0fe302818',transferTopic='0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',zero='0x0000000000000000000000000000000000000000';
const word=(d,i)=>d?.slice(2+i*64,2+(i+1)*64);
const uint=w=>/^[0-9a-f]{64}$/.test(w)?BigInt('0x'+w):undefined;
const addr=w=>/^0{24}[a-f0-9]{40}$/.test(w)?'0x'+w.slice(24):null;
const topicAddr=t=>typeof t==='string'&&/^0x[0-9a-f]{64}$/.test(t)?addr(t.slice(2)):null;
export function discover(n,c,ctx){
 if(n.kind!=='call'||n.selector!==selector)return;
 const ev=ctx.uniqueLog(n,eventTopic0,(f,l)=>f===n&&l.emitter===n.target&&l.topics.length===3&&l.data?.length===2+64);
 if(!ev)return;
 const amount=uint(word(ev.data,0)); if(!amount)return;
 let input,output;
 for(const l of ctx.byTopic.get(transferTopic)??[]){
  if(l.topics.length!==3||!l.data||l.data.length!==66)continue;
  const from=topicAddr(l.topics[1]),to=topicAddr(l.topics[2]),a=word(l.data,0);
  if(!from||!to||from===to||!uint(a)||BigInt('0x'+a)!==amount)continue;
  if(l.emitter===n.target&&to===zero)input={log:l,token:n.target,amount};
  if(l.emitter!==n.target&&from===n.target)output={log:l,token:l.emitter,amount};
 }
 if(!input||!output)return;
 return {selector:n.selector,callPath:n.path,selectorTarget:n.target,poolAddress:n.target,poolId:null,innerSwapPath:null,
  tokenIn:n.target,tokenOut:output.token,receiptIndices:[input.log.idx,output.log.idx,ev.idx].join(','),receiptRoles:['in','out','event'],
  evidence:'wrapper-unwrap',amountVenueInRaw:String(amount),amountPayerInRaw:String(amount),amountPoolOutRaw:String(amount),amountReceivedOutRaw:String(amount)};
}
