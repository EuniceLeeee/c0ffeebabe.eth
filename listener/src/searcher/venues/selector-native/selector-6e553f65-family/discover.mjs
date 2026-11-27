// ERC4626 deposit: Deposit event + asset transfer in + share mint.
const selector='0x6e553f65',eventTopic0='0xdcbc1c05240f31ff3ad067ef1ee35ce4997762752e3a095284754544f4c709d7',transferTopic='0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',zero='0x0000000000000000000000000000000000000000';
const word=(d,i)=>d?.slice(2+i*64,2+(i+1)*64);
const uint=w=>/^[0-9a-f]{64}$/.test(w)?BigInt('0x'+w):undefined;
const addr=w=>/^0{24}[a-f0-9]{40}$/.test(w)?'0x'+w.slice(24):null;
const topicAddr=t=>typeof t==='string'&&/^0x[0-9a-f]{64}$/.test(t)?addr(t.slice(2)):null;
export function discover(n,c,ctx){
 if(n.kind!=='call'||n.selector!==selector)return;
 const ev=ctx.uniqueLog(n,eventTopic0,(f,l)=>f===n&&l.emitter===n.target&&l.topics.length===3&&l.data?.length===2+2*64);
 if(!ev)return;
 const assets=uint(word(ev.data,0)),shares=uint(word(ev.data,1));
 if(!assets||!shares)return;
 let input,output;
 for(const l of ctx.byTopic.get(transferTopic)??[]){
  if(l.topics.length!==3||!l.data||l.data.length!==66)continue;
  const from=topicAddr(l.topics[1]),to=topicAddr(l.topics[2]),amount=word(l.data,0);
  if(!from||!to||from===to||!uint(amount))continue;
  const v=BigInt('0x'+amount);
  if(to===n.target&&v===assets)input={log:l,token:l.emitter,amount:v};
  if(from===zero&&l.emitter===n.target&&v===shares)output={log:l,token:n.target,amount:v};
 }
 if(!input||!output)return;
 return {selector:n.selector,callPath:n.path,selectorTarget:n.target,poolAddress:n.target,poolId:null,innerSwapPath:null,
  tokenIn:input.token,tokenOut:n.target,receiptIndices:[input.log.idx,output.log.idx,ev.idx].join(','),receiptRoles:['in','out','event'],
  evidence:'erc4626-deposit',amountVenueInRaw:String(input.amount),amountPayerInRaw:String(input.amount),amountPoolOutRaw:String(output.amount),amountReceivedOutRaw:String(output.amount)};
}
