// Optional offline witness. Never copy native ordinals into SQL paths.
import assert from 'node:assert/strict';
import {buildTree} from './trace-tree.mjs';
const nat=n=>n==null?null:BigInt(n).toString();
const nonempty=x=>x??'0x';
function skeleton(tree) {
  const children=new Map(),by=new Map(tree.nodes.map(n=>[n.path,n]));
  for(const n of tree.nodes){if(n.parent!==null){const a=children.get(n.parent)??[];a.push(n);children.set(n.parent,a);}}
  const counts={ignoredStaticLeaves:0};const list=[];
  function visit(n,key){
    list.push([key,n]);let ix=0;
    const kids=(children.get(n.path)??[]).sort((a,b)=>Number(a.path.split(',').at(-1))-Number(b.path.split(',').at(-1)));
    for(const c of kids){
      // EVM read-only leaves cannot emit a committed LOG. Keep SQL reads in the output!
      // This normalization is strictly for aligning log-owner paths between providers.
      if(c.kind==='staticcall'&&!children.has(c.path)){counts.ignoredStaticLeaves++;continue;}
      visit(c,key+'/'+ix++);
    }
  }
  visit(by.get(''),'ROOT');return {list,counts};
}
export function corroborate(sql,witness) {
  assert(sql.tx_hash&&sql.block_hash&&sql.block_number!=null&&witness?.receipt?.blockHash,'require anchored SQL transaction and witness receipt');
  const a=buildTree(sql),b=buildTree(witness);
  assert.equal(a.txHash,b.txHash,'receipt transaction hash mismatch');
  assert.equal(sql.block_hash.toLowerCase(),witness.receipt.blockHash.toLowerCase(),'receipt block mismatch');
  assert.equal(nat(sql.block_number),nat(witness.receipt.blockNumber),'height mismatch');
  assert.equal(nat(sql.transaction_index),nat(witness.receipt.transactionIndex),'transaction index mismatch');
  assert.equal(b.ownershipSource,'traced','witness lacks authoritative per-frame logs');
  const A=skeleton(a),B=skeleton(b),map=new Map();assert.equal(A.list.length,B.list.length,'effectful call count mismatch');
  for(let i=0;i<A.list.length;i++){
    const [p,x]=A.list[i],[q,y]=B.list[i];
    assert.equal(p,q,'call tree topology mismatch');
    for(const k of ['kind','committed','staticContext','from','to','contextAddress','input'])assert.equal(x[k],y[k],'frame mismatch: '+k);
    assert.equal(nonempty(x.output),nonempty(y.output),'frame return mismatch');
    if(['call','create','create2','selfdestruct'].includes(x.kind)){
      if(x.committed)assert(x.value!=null && y.value!=null,'unobserved movement value');
      assert.equal(nat(x.value),nat(y.value),'call value mismatch');
    }
    map.set(y.path,x.path);
  }
  const N=new Map(a.nodes.map(n=>[n.path,n]));assert.equal(a.logs.length,b.logs.length,'receipt count mismatch');
  const logs=a.logs.map((l,i)=>{
    const r=b.logs[i];assert.deepEqual([l.idx,l.emitter,l.topics,l.data],[r.idx,r.emitter,r.topics,r.data],'receipt payload mismatch');
    assert.equal(r.ownership,'traced');const p=map.get(r.ownerPath);assert(p!==undefined,'unmatched emitting frame');
    assert(l.candidatePaths.includes(p),'witness contradicts SQL event order/context');
    return {...l,ownerPath:p,logicalOwnerPath:N.get(p).logicalOwnerPath,candidatePaths:[p],ownership:'traced'};
  });
  return {...a,logs,ownershipSource:'sql+corroborated-frame-logs',alignment:{sqlNodes:a.nodes.length,witnessNodes:b.nodes.length,matchedNonStaticLeafAndParentNodes:A.list.length}};
}
