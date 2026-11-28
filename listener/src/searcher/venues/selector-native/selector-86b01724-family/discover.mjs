// Ella Exchange swap1: Bought event (isBuy=false) + ERC20 input transfer.
const selector='0x86b01724',eventTopic0='0x1274ee576717576d42e1502258a75b385cd5c0c3aaf74fb3cc5da13c2ad19700';
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
 const grossOut=uint(word(ev.data,1)),amtIn=uint(word(ev.data,2)),exch=addr(word(ev.data,3)),isBuy=uint(word(ev.data,4));
 if(!grossOut||!amtIn||exch!==n.target||isBuy!==0n)return;
 const ins=[];
 for(const l of ctx.byTopic.get(transferTopic)??[]){
  if(!inSubtree(n,l)||l.topics.length!==3||l.data?.length!==66)continue;
  const from=topicAddr(l.topics[1]),to=topicAddr(l.topics[2]),v=uint(word(l.data,0));
  if(!from||!to||from===to||!v)continue;
  if(to===n.target&&v===amtIn&&l.emitter!==weth)ins.push({log:l,token:l.emitter,amount:v});
 }
 if(ins.length!==1)return;
 const i=ins[0];
 return {selector:n.selector,callPath:n.path,selectorTarget:n.target,poolAddress:n.target,poolId:null,innerSwapPath:null,
  tokenIn:i.token,tokenOut:zero,receiptIndices:[i.log.idx,ev.idx].join(','),receiptRoles:['in','event'],
  evidence:'ella-swap1-sell',amountVenueInRaw:String(amtIn),amountPayerInRaw:String(amtIn),amountPoolOutRaw:String(grossOut),amountReceivedOutRaw:String(grossOut)};
}
