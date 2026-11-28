// RockSolid syncDeposit: asset transfer in + share mint out.
const selector='0xd01d073a';
const transferTopic='0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',zero='0x0000000000000000000000000000000000000000';
const word=(d,i)=>d?.slice(2+i*64,2+(i+1)*64);
const argWord=(d,i)=>d?.slice(10+i*64,10+(i+1)*64);
const uint=w=>typeof w==='string'&&/^[0-9a-f]{64}$/.test(w)?BigInt('0x'+w):undefined;
const addr=w=>typeof w==='string'&&/^0{24}[a-f0-9]{40}$/.test(w)?'0x'+w.slice(24):null;
const topicAddr=t=>typeof t==='string'&&/^0x[0-9a-f]{64}$/.test(t)?addr(t.slice(2)):null;
const inSubtree=(n,l)=>{const os=l&&n._ctxOwners?.get(l);if(!os)return false;for(const o of os)if(o===n||(n.path===''?o.path!=='':o.path.startsWith(n.path+',')))return true;return false;};
export function discover(n,c,ctx){
 if(n.kind!=='call'||n.selector!==selector)return;
 n._ctxOwners=ctx.owners;
 const assetsArg=uint(argWord(n.input,0)),receiverArg=addr(argWord(n.input,1));
 if(!assetsArg||!receiverArg||receiverArg===zero)return;
 const ins=[],outs=[];
 for(const l of ctx.byTopic.get(transferTopic)??[]){
  if(!inSubtree(n,l)||l.topics.length!==3||l.data?.length!==66)continue;
  const from=topicAddr(l.topics[1]),to=topicAddr(l.topics[2]),v=uint(word(l.data,0));
  if(!from||!to||from===to||!v)continue;
  if(l.emitter!==n.target&&from===n.sender&&v===assetsArg)ins.push({log:l,token:l.emitter,amount:v});
  if(l.emitter===n.target&&from===zero&&to===receiverArg)outs.push({log:l,token:n.target,amount:v});
 }
 if(ins.length!==1||outs.length!==1)return;
 const i=ins[0],o=outs[0];
 return {selector:n.selector,callPath:n.path,selectorTarget:n.target,poolAddress:n.target,poolId:null,innerSwapPath:null,
  tokenIn:i.token,tokenOut:n.target,receiptIndices:[i.log.idx,o.log.idx].join(','),receiptRoles:['in','out'],
  evidence:'rocksolid-sync-deposit',amountVenueInRaw:String(i.amount),amountPayerInRaw:String(i.amount),amountPoolOutRaw:String(o.amount),amountReceivedOutRaw:String(o.amount)};
}
