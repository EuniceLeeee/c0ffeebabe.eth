// DODO V2 sell-base: DODOSwap event + prepaid input transfer + output transfer.
const selector='0xbd6015b4',eventTopic0='0xc2c0245e056d5fb095f04cd6373bc770802ebd1e6c918eb78fdef843cdb37b0f';
const transferTopic='0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',zero='0x0000000000000000000000000000000000000000',weth='0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
const word=(d,i)=>d?.slice(2+i*64,2+(i+1)*64);
const argWord=(d,i)=>d?.slice(10+i*64,10+(i+1)*64);
const uint=w=>typeof w==='string'&&/^[0-9a-f]{64}$/.test(w)?BigInt('0x'+w):undefined;
const addr=w=>typeof w==='string'&&/^0{24}[a-f0-9]{40}$/.test(w)?'0x'+w.slice(24):null;
const topicAddr=t=>typeof t==='string'&&/^0x[0-9a-f]{64}$/.test(t)?addr(t.slice(2)):null;
const inSubtree=(n,l)=>{const os=l&&n._ctxOwners?.get(l);if(!os)return false;for(const o of os)if(o===n||(n.path===''?o.path!=='':o.path.startsWith(n.path+',')))return true;return false;};
export function discover(n,c,ctx){
 if(n.kind!=='call'||n.selector!==selector)return;
 n._ctxOwners=ctx.owners;
 const ev=ctx.uniqueLog(n,eventTopic0,(f,l)=>f===n&&l.emitter===n.target&&l.topics.length===1&&l.data?.length===2+6*64);
 if(!ev)return;
 const fromTok=addr(word(ev.data,0)),toTok=addr(word(ev.data,1)),fromAmt=uint(word(ev.data,2)),toAmt=uint(word(ev.data,3));
 if(!fromTok||!toTok||fromTok===zero||toTok===zero||fromTok===toTok||!fromAmt||!toAmt)return;
 const ins=[],outs=[];
 for(const l of ctx.byTopic.get(transferTopic)??[]){
  if(l.topics.length!==3||l.data?.length!==66)continue;
  const from=topicAddr(l.topics[1]),to=topicAddr(l.topics[2]),v=uint(word(l.data,0));
  if(!from||!to||from===to||!v)continue;
  if(l.emitter===fromTok&&to===n.target&&v===fromAmt&&l.idx<ev.idx)ins.push({log:l,token:fromTok,amount:v});
  if(l.emitter===toTok&&from===n.target&&v===toAmt&&inSubtree(n,l))outs.push({log:l,token:toTok,amount:v});
 }
 if(ins.length!==1||outs.length!==1)return;
 const i=ins[0],o=outs[0];
 if(i.log.idx>=o.log.idx||o.log.idx>=ev.idx)return;
 return {selector:n.selector,callPath:n.path,selectorTarget:n.target,poolAddress:n.target,poolId:null,innerSwapPath:null,
  tokenIn:fromTok,tokenOut:toTok,receiptIndices:[i.log.idx,o.log.idx,ev.idx].join(','),receiptRoles:['in','out','event'],
  evidence:'dodo-v2-sell-base',amountVenueInRaw:String(i.amount),amountPayerInRaw:String(i.amount),amountPoolOutRaw:String(o.amount),amountReceivedOutRaw:String(o.amount)};
}
