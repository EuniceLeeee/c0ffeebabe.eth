// Few Wrapped wrapTo: underlying transfer in + wrapper mint + Wrap event.
const selector='0x26599850',eventTopic0='0xeb5580a0908e96b78bdcb1a3c5638793b491a6073c3ff56061a069cb20581773';
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
 const ev=ctx.uniqueLog(n,eventTopic0,(f,l)=>f===n&&l.emitter===n.target&&l.topics.length===3&&l.data?.length===2+64);
 if(!ev)return;
 const amount=uint(word(ev.data,0));
 if(!amount)return;
 const ins=[],outs=[];
 for(const l of ctx.byTopic.get(transferTopic)??[]){
  if(!inSubtree(n,l)||l.topics.length!==3||l.data?.length!==66)continue;
  const from=topicAddr(l.topics[1]),to=topicAddr(l.topics[2]),v=uint(word(l.data,0));
  if(!from||!to||from===to||v!==amount)continue;
  if(to===n.target&&l.emitter!==n.target)ins.push({log:l,token:l.emitter,amount:v});
  if(from===zero&&l.emitter===n.target)outs.push({log:l,token:n.target,amount:v});
 }
 if(ins.length!==1||outs.length!==1)return;
 const i=ins[0],o=outs[0];
 return {selector:n.selector,callPath:n.path,selectorTarget:n.target,poolAddress:n.target,poolId:null,innerSwapPath:null,
  tokenIn:i.token,tokenOut:n.target,receiptIndices:[i.log.idx,o.log.idx,ev.idx].join(','),receiptRoles:['in','out','event'],
  evidence:'wrapper-wrap-to',amountVenueInRaw:String(amount),amountPayerInRaw:String(amount),amountPoolOutRaw:String(amount),amountReceivedOutRaw:String(amount)};
}
