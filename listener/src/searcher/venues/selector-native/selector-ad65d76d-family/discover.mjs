// Uniswap V1 ETH->Token: TokenPurchase event + ERC20 output transfer.
const selector='0xad65d76d',eventTopic0='0xcd60aa75dea3072fbc07ae6d7d856b5dc5f4eee88854f5b4abf7b680ef8bc50f';
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
 const ev=ctx.uniqueLog(n,eventTopic0,(f,l)=>f===n&&l.emitter===n.target&&l.topics.length===4&&l.data==='0x');
 if(!ev)return;
 const ethSold=uint(ev.topics[2]?.slice(2)),tokensBought=uint(ev.topics[3]?.slice(2));
 if(!ethSold||!tokensBought||BigInt(n.value||'0')!==ethSold)return;
 const outs=[];
 for(const l of ctx.byTopic.get(transferTopic)??[]){
  if(!inSubtree(n,l)||l.topics.length!==3||l.data?.length!==66)continue;
  const from=topicAddr(l.topics[1]),to=topicAddr(l.topics[2]),v=uint(word(l.data,0));
  if(!from||!to||from===to||!v)continue;
  if(from===n.target&&v===tokensBought&&l.emitter!==weth)outs.push({log:l,token:l.emitter,amount:v});
 }
 if(outs.length!==1)return;
 const o=outs[0];
 return {selector:n.selector,callPath:n.path,selectorTarget:n.target,poolAddress:n.target,poolId:null,innerSwapPath:null,
  tokenIn:zero,tokenOut:o.token,receiptIndices:[o.log.idx,ev.idx].join(','),receiptRoles:['out','event'],
  evidence:'univ1-token-purchase-transfer',amountVenueInRaw:String(ethSold),amountPayerInRaw:String(ethSold),amountPoolOutRaw:String(tokensBought),amountReceivedOutRaw:String(tokensBought)};
}
