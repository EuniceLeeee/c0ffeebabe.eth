// Precision Pool swapExactIn: Swap(address indexed,uint256,uint256,address indexed) + ERC20/native settlement.
const selector='0xa6220b66',eventTopic0='0x2a9237ff5aa599ef4c5ee4b1142b53429d5755e2685fe6288b2e3320202115f5';
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
 const ev=ctx.uniqueLog(n,eventTopic0,(f,l)=>f===n&&l.emitter===n.target&&l.topics.length===3&&l.data?.length===2+2*64);
 if(!ev)return;
 const tokInEvt=topicAddr(ev.topics[1]),toEvt=topicAddr(ev.topics[2]),amtIn=uint(word(ev.data,0)),amtOut=uint(word(ev.data,1));
 if(!tokInEvt||!toEvt||toEvt===zero||!amtIn||!amtOut)return;
 const ins=[],outs=[];
 for(const l of ctx.byTopic.get(transferTopic)??[]){
  if(!inSubtree(n,l)||l.topics.length!==3||l.data?.length!==66)continue;
  const from=topicAddr(l.topics[1]),to=topicAddr(l.topics[2]),v=uint(word(l.data,0));
  if(!from||!to||from===to||!v)continue;
  if(l.emitter===tokInEvt&&to===n.target&&v===amtIn)ins.push({log:l,token:tokInEvt,amount:v});
  if(from===n.target&&to===toEvt&&v===amtOut)outs.push({log:l,token:l.emitter,amount:v});
 }
 const val=BigInt(n.value||'0');
 let tokIn,tokOut;
 const ids=[],roles=[];
 if(tokInEvt===zero&&val===amtIn&&ins.length===0){tokIn=zero;}
 else if(tokInEvt!==zero&&val===0n&&ins.length===1){tokIn=tokInEvt;ids.push(ins[0].log.idx);roles.push('in');}
 else return;
 if(outs.length===1){tokOut=outs[0].token;ids.push(outs[0].log.idx);roles.push('out');}
 else if(outs.length===0&&tokIn!==zero){tokOut=zero;}
 else return;
 if(tokIn===tokOut||(tokIn===zero&&tokOut===weth)||(tokOut===zero&&tokIn===weth))return;
 ids.push(ev.idx);roles.push('event');
 return {selector:n.selector,callPath:n.path,selectorTarget:n.target,poolAddress:n.target,poolId:null,innerSwapPath:null,
  tokenIn:tokIn,tokenOut:tokOut,receiptIndices:ids.join(','),receiptRoles:roles,
  evidence:'precision-pool-swap-exact-in',amountVenueInRaw:String(amtIn),amountPayerInRaw:String(amtIn),amountPoolOutRaw:String(amtOut),amountReceivedOutRaw:String(amtOut)};
}
