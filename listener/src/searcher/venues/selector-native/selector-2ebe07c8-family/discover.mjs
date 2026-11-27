// Vault depositAsset: share mint + asset transfer in + deposit event.
const selector='0x2ebe07c8',eventTopic0='0x993597fdd4cbd87389cb9843bad4e114afb2fafa9811ac902e20896c4d1f8831',transferTopic='0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',zero='0x0000000000000000000000000000000000000000';
const word=(d,i)=>d?.slice(2+i*64,2+(i+1)*64);
const uint=w=>/^[0-9a-f]{64}$/.test(w)?BigInt('0x'+w):undefined;
const addr=w=>/^0{24}[a-f0-9]{40}$/.test(w)?'0x'+w.slice(24):null;
const topicAddr=t=>typeof t==='string'&&/^0x[0-9a-f]{64}$/.test(t)?addr(t.slice(2)):null;
export function discover(n,c,ctx){
 if(n.kind!=='call'||n.selector!==selector)return;
 const ev=ctx.uniqueLog(n,eventTopic0,(f,l)=>f===n&&l.emitter===n.target&&l.topics.length===4&&l.data?.length===2+3*64);
 if(!ev)return;
 const amount=uint(word(ev.data,0)); if(!amount)return;
 let input,output;
 for(const l of ctx.byTopic.get(transferTopic)??[]){
  if(l.topics.length!==3||!l.data||l.data.length!==66)continue;
  const from=topicAddr(l.topics[1]),to=topicAddr(l.topics[2]),a=word(l.data,0);
  if(!from||!to||from===to||!uint(a))continue;
  if(to===n.target&&BigInt('0x'+a)===amount)input={log:l,token:l.emitter,amount};
  if(from===zero&&l.emitter!==n.target)output={log:l,token:l.emitter,amount:BigInt('0x'+a)};
 }
 if(!input||!output)return;
 return {selector:n.selector,callPath:n.path,selectorTarget:n.target,poolAddress:n.target,poolId:null,innerSwapPath:null,
  tokenIn:input.token,tokenOut:output.token,receiptIndices:[input.log.idx,output.log.idx,ev.idx].join(','),receiptRoles:['in','out','event'],
  evidence:'vault-deposit-asset',amountVenueInRaw:String(input.amount),amountPayerInRaw:String(input.amount),amountPoolOutRaw:String(output.amount),amountReceivedOutRaw:String(output.amount)};
}
