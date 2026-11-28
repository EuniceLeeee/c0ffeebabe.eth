// Curve Crypto exchange: TokenExchange (v1 4-word or NG 6-word) plus ERC-20 settlement transfers.
const selector='0x65b2489b';
const topicNg='0x143f1f8e861fbdeddd5b46e844b7d3ac7b86a122f36e8c463859ee6811b1f29c';
const topicV1='0xb2e76ae99761dc136e598d4a629bb347eccb9532a5f8bbd72e18467c3c34cc98';
const transferTopic='0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',zero='0x0000000000000000000000000000000000000000';
const word=(d,i)=>d?.slice(2+i*64,2+(i+1)*64);
const uint=w=>typeof w==='string'&&/^[0-9a-f]{64}$/.test(w)?BigInt('0x'+w):undefined;
const addr=w=>typeof w==='string'&&/^0{24}[a-f0-9]{40}$/.test(w)?'0x'+w.slice(24):null;
const topicAddr=t=>typeof t==='string'&&/^0x[0-9a-f]{64}$/.test(t)?addr(t.slice(2)):null;
const inSubtree=(ctx,n,l)=>{const os=l&&ctx.owners.get(l);if(!os)return false;for(const o of os)if(o===n||(n.path===''?o.path!=='':o.path.startsWith(n.path+',')))return true;return false;};
export function discover(n,c,ctx){
 if(n.kind!=='call'||n.selector!==selector||(n.value&&BigInt(n.value)!==0n))return;
 const evNg=ctx.uniqueLog(n,topicNg,(f,l)=>f===n&&l.emitter===n.target&&l.topics.length===2&&l.data?.length===2+6*64);
 const evV1=ctx.uniqueLog(n,topicV1,(f,l)=>f===n&&l.emitter===n.target&&l.topics.length===2&&l.data?.length===2+4*64);
 if(Boolean(evNg)===Boolean(evV1))return;
 const ev=evNg??evV1;
 const soldId=uint(word(ev.data,0)),amountIn=uint(word(ev.data,1)),boughtId=uint(word(ev.data,2)),amountOut=uint(word(ev.data,3));
 if(soldId===undefined||boughtId===undefined||soldId===boughtId||soldId>2n||boughtId>2n||!amountIn||!amountOut)return;
 const ins=[],outs=[];
 for(const l of ctx.byTopic.get(transferTopic)??[]){
  if(l.topics.length!==3||l.data?.length!==66)continue;
  const from=topicAddr(l.topics[1]),to=topicAddr(l.topics[2]),v=uint(word(l.data,0));
  if(!from||!to||from===to||from===zero||to===zero||!v)continue;
  if(inSubtree(ctx,n,l)&&l.idx<ev.idx&&to===n.target&&v===amountIn)ins.push({log:l,token:l.emitter,amount:v});
  if(inSubtree(ctx,n,l)&&l.idx<ev.idx&&from===n.target&&v===amountOut)outs.push({log:l,token:l.emitter,amount:v});
 }
 if(ins.length!==1||outs.length!==1||ins[0].token===outs[0].token)return;
 const i=ins[0],o=outs[0];
 if(i.log.idx>=ev.idx||o.log.idx>=ev.idx)return;
 return {selector:n.selector,callPath:n.path,selectorTarget:n.target,poolAddress:n.target,poolId:null,innerSwapPath:null,
  tokenIn:i.token,tokenOut:o.token,receiptIndices:[i.log.idx,o.log.idx,ev.idx].join(','),receiptRoles:['in','out','event'],
  evidence:'curve-crypto-token-exchange',amountVenueInRaw:String(i.amount),amountPayerInRaw:String(i.amount),amountPoolOutRaw:String(o.amount),amountReceivedOutRaw:String(o.amount)};
}
