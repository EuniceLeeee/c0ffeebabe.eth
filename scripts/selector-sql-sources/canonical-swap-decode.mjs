export const canonicalSwapTopics=Object.freeze({
  v2:'0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822',
  v3:'0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67',
  v4:'0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f',
});

// Embedded verbatim in the BigQuery JS UDF, called only on matching topics.
// Integer widths/signs are checked as hex, never as imprecise JS Numbers.
export function decodeCanonicalSwap(topicByLayout,emitter,topics,data) {
  if(!Array.isArray(topics)||typeof topics[0]!=='string')return null;
  const layout=Object.keys(topicByLayout).find(k=>topicByLayout[k]===topics[0].toLowerCase());
  if(!layout)return null;
  const hexword=x=>typeof x==='string'&&/^0x[0-9a-f]{64}$/i.test(x);
  const paddedAddress=x=>typeof x==='string'&&/^0x0{24}[0-9a-f]{40}$/i.test(x);
  const poolId=layout==='v4'&&hexword(topics[1])?topics[1].toLowerCase():null;
  const result=(decodeStatus,direction=null)=>({layout,poolId,direction,decodeStatus});
  if(typeof emitter!=='string'||!/^0x[0-9a-f]{40}$/i.test(emitter)||topics.length!==3||!paddedAddress(topics[2])||
     (layout==='v4'?!poolId:!paddedAddress(topics[1])))return result('malformed');
  const n=layout==='v2'?4:layout==='v3'?5:6;
  if(typeof data!=='string'||data.length!==2+64*n||!/^0x[0-9a-f]+$/i.test(data))return result('malformed');
  const ws=data.slice(2).toLowerCase().match(/.{64}/g),zero=w=>/^0+$/.test(w);
  const negative=x=>/[89a-f]/.test(x[0]);
  const fits=(w,bits,signed)=>{const p=64-bits/4;return w.slice(0,p)===(signed&&negative(w.slice(p))?'f':'0').repeat(p);};
  const sign=w=>zero(w)?0:negative(w)?-1:1;
  if(layout==='v2'){
    const active=ws.map(w=>zero(w)?'0':'1').join('');
    if(active==='1001')return result('decoded','asset0-in');
    if(active==='0110')return result('decoded','asset1-in');
  }else{
    if(!fits(ws[2],160,false)||!fits(ws[3],128,false)||!fits(ws[4],24,true)||
       (layout==='v4'&&(!fits(ws[0],128,true)||!fits(ws[1],128,true)||!fits(ws[5],24,false))))return result('malformed');
    const a=sign(ws[0]),b=sign(ws[1]);
    if(a*b===-1)return result('decoded',(layout==='v3'?a>0:a<0)?'asset0-in':'asset1-in');
  }
  return result('uninterpretable'); // e.g. zero-sided, dual inputs, or flash flows.
}
