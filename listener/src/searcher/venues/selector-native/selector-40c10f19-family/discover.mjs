// GoldX mint: PAXG transfer in + GOLDX mint out.
const selector='0x40c10f19',goldx='0x355c665e101b9da58704a8fddb5feef210ef20c0',paxg='0x45804880de22913dafe09f4980848ece6ecbaf78';
const transferTopic='0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',zero='0x0000000000000000000000000000000000000000';
const word=(d,i)=>d?.slice(2+i*64,2+(i+1)*64);
const argWord=(d,i)=>d?.slice(10+i*64,10+(i+1)*64);
const uint=w=>typeof w==='string'&&/^[0-9a-f]{64}$/.test(w)?BigInt('0x'+w):undefined;
const addr=w=>typeof w==='string'&&/^0{24}[a-f0-9]{40}$/.test(w)?'0x'+w.slice(24):null;
const topicAddr=t=>typeof t==='string'&&/^0x[0-9a-f]{64}$/.test(t)?addr(t.slice(2)):null;
const inSubtree=(n,l)=>{const os=l&&n._ctxOwners?.get(l);if(!os)return false;for(const o of os)if(o===n||(n.path===''?o.path!=='':o.path.startsWith(n.path+',')))return true;return false;};
export function discover(n,c,ctx){
 if(n.kind!=='call'||n.selector!==selector||n.target!==goldx)return;
 n._ctxOwners=ctx.owners;
 const recvArg=addr(argWord(n.input,0)),amtArg=uint(argWord(n.input,1));
 if(!recvArg||recvArg===zero||!amtArg)return;
 const ins=[],outs=[];
 for(const l of ctx.byTopic.get(transferTopic)??[]){
  if(!inSubtree(n,l)||l.topics.length!==3||l.data?.length!==66)continue;
  const from=topicAddr(l.topics[1]),to=topicAddr(l.topics[2]),v=uint(word(l.data,0));
  if(!from||!to||from===to||!v)continue;
  if(l.emitter===paxg&&from===n.sender)ins.push({log:l,token:paxg,amount:v});
  if(l.emitter===goldx&&from===zero&&to===recvArg)outs.push({log:l,token:goldx,amount:v});
 }
 if(ins.length!==1||outs.length!==1)return;
 const i=ins[0],o=outs[0];
 return {selector:n.selector,callPath:n.path,selectorTarget:n.target,poolAddress:n.target,poolId:null,innerSwapPath:null,
  tokenIn:paxg,tokenOut:goldx,receiptIndices:[i.log.idx,o.log.idx].join(','),receiptRoles:['in','out'],
  evidence:'goldx-mint',amountVenueInRaw:String(i.amount),amountPayerInRaw:String(i.amount),amountPoolOutRaw:String(o.amount),amountReceivedOutRaw:String(o.amount)};
}
