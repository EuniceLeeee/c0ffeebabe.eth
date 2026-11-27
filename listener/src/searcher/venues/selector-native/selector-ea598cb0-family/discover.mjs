// Wrap: underlying transfer in + wrapper mint + wrap event.
const selector='0xea598cb0',eventTopic0='0xeb5580a0908e96b78bdcb1a3c5638793b491a6073c3ff56061a069cb20581773',transferTopic='0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',zero='0x0000000000000000000000000000000000000000';
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
  if(to===n.target&&l.emitter!==n.target)input={log:l,token:l.emitter,amount};
  if(from===zero&&l.emitter===n.target)output={log:l,token:n.target,amount};
 }
 if(!input||!output)return;
 return {selector:n.selector,callPath:n.path,selectorTarget:n.target,poolAddress:n.target,poolId:null,innerSwapPath:null,
  tokenIn:input.token,tokenOut:n.target,receiptIndices:[input.log.idx,output.log.idx,ev.idx].join(','),receiptRoles:['in','out','event'],
  evidence:'wrapper-wrap',amountVenueInRaw:String(amount),amountPayerInRaw:String(amount),amountPoolOutRaw:String(amount),amountReceivedOutRaw:String(amount)};
}
