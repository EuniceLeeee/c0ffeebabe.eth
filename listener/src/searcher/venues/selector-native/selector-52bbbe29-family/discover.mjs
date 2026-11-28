// Balancer V2 Vault single swap: Swap(bytes32 indexed,address indexed,address indexed,uint256,uint256) + ERC20 settlement.
const selector='0x52bbbe29',eventTopic0='0x2170c741c41531aec20e7c107c24eecfdd15e69c9bb0a8dd37b1840b9e0b207b',vault='0xba12222222228d8ba445958a75a0704d566bf2c8';
const transferTopic='0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',zero='0x0000000000000000000000000000000000000000',weth='0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
const word=(d,i)=>d?.slice(2+i*64,2+(i+1)*64);
const argWord=(d,i)=>d?.slice(10+i*64,10+(i+1)*64);
const uint=w=>typeof w==='string'&&/^[0-9a-f]{64}$/.test(w)?BigInt('0x'+w):undefined;
const addr=w=>typeof w==='string'&&/^0{24}[a-f0-9]{40}$/.test(w)?'0x'+w.slice(24):null;
const topicAddr=t=>typeof t==='string'&&/^0x[0-9a-f]{64}$/.test(t)?addr(t.slice(2)):null;
const inSubtree=(n,l)=>{const os=l&&n._ctxOwners?.get(l);if(!os)return false;for(const o of os)if(o===n||(n.path===''?o.path!=='':o.path.startsWith(n.path+',')))return true;return false;};
export function discover(n,c,ctx){
 if(n.kind!=='call'||n.selector!==selector||n.target!==vault)return;
 n._ctxOwners=ctx.owners;
 const off=uint(argWord(n.input,0)),fromInt=uint(argWord(n.input,2)),toInt=uint(argWord(n.input,4));
 if(off===undefined||off<224n||off%32n!==0n||fromInt!==0n||toInt!==0n)return;
 const base=Number(off/32n),poolWord=argWord(n.input,base),kindWord=uint(argWord(n.input,base+1));
 if(!poolWord||!/^[0-9a-f]{64}$/.test(poolWord)||(kindWord!==0n&&kindWord!==1n))return;
 const poolId='0x'+poolWord,poolAddr=poolId.slice(0,42),spec=Number(BigInt('0x'+poolId.slice(42,46)));
 if(poolAddr===zero||spec>2)return;
 const ev=ctx.uniqueLog(n,eventTopic0,(f,l)=>f===n&&l.emitter===vault&&l.topics.length===4&&l.data?.length===2+2*64&&l.topics[1]?.toLowerCase()===poolId);
 if(!ev)return;
 const tokIn=topicAddr(ev.topics[2]),tokOut=topicAddr(ev.topics[3]),amtIn=uint(word(ev.data,0)),amtOut=uint(word(ev.data,1));
 if(!tokIn||!tokOut||tokIn===zero||tokOut===zero||tokIn===tokOut||!amtIn||!amtOut)return;
 const ins=[],outs=[];
 for(const l of ctx.byTopic.get(transferTopic)??[]){
  if(!inSubtree(n,l)||l.topics.length!==3||l.data?.length!==66)continue;
  const from=topicAddr(l.topics[1]),to=topicAddr(l.topics[2]),v=uint(word(l.data,0));
  if(!from||!to||from===to||!v)continue;
  if(l.emitter===tokIn&&to===vault&&v===amtIn)ins.push({log:l,token:tokIn,amount:v});
  if(l.emitter===tokOut&&from===vault&&v===amtOut)outs.push({log:l,token:tokOut,amount:v});
 }
 if(ins.length!==1||outs.length!==1)return;
 const i=ins[0],o=outs[0];
 return {selector:n.selector,callPath:n.path,selectorTarget:n.target,poolAddress:n.target,poolId,innerSwapPath:null,
  tokenIn:tokIn,tokenOut:tokOut,receiptIndices:[i.log.idx,o.log.idx,ev.idx].join(','),receiptRoles:['in','out','event'],
  evidence:'vault-swap-poolid',amountVenueInRaw:String(amtIn),amountPayerInRaw:String(amtIn),amountPoolOutRaw:String(amtOut),amountReceivedOutRaw:String(amtOut)};
}
