import {possibleReceiptOwners} from './receipt-call-owners.mjs';
const uint=w=>/^[0-9a-f]{64}$/.test(w??'')?BigInt('0x'+w):undefined;
const addr=w=>/^0{24}[0-9a-f]{40}$/.test(w??'')?'0x'+w.slice(24):undefined;

// For each emitter, intersecting slot ranges form a single component. Two
// disjoint ranges can also connect if the parent call resumed in both; union
// those by their actual owner. Touching but distinct slots alone do not join.
// Each covered slot is traversed once, irrespective of receipt multiplicity.
export function receiptComponents(entries){
  const bySlots=new Map(),parts=[],parent=[],byOwner=new Map(),rank=[];
  function newPart(){const i=parts.length;parts.push([]);parent.push(i);rank.push(0);return i;}
  function root(i){while(i!==parent[i]){parent[i]=parent[parent[i]];i=parent[i];}return i;}
  function register(n,i){
    const prev=byOwner.get(n);if(prev===undefined){byOwner.set(n,i);return;}
    let a=root(prev),b=root(i);if(a===b)return;
    if(rank[a]<rank[b])[a,b]=[b,a];
    parent[b]=a;if(rank[a]===rank[b])rank[a]++;
  }
  for(const item of entries){
    const r=item.owners.range;
    if(r.only){const i=newPart();parts[i].push(item);register(r.only,i);continue;}
    let v=bySlots.get(r.slots);if(!v)bySlots.set(r.slots,v=[]);v.push(item);
  }
  for(const [slots,items] of bySlots){
    items.sort((a,b)=>a.owners.range.first-b.owners.range.first);
    let part=-1,end=-1;
    for(const item of items){
      const {first,last}=item.owners.range;
      if(last<first)continue;
      if(first>end){part=newPart();end=first-1;}
      parts[part].push(item);
      for(let i=end+1;i<=last;i++)register(slots[i].owner,part);
      if(last>end)end=last;
    }
  }
  const out=new Map();
  for(let i=0;i<parts.length;i++){
    const id=root(i);let c=out.get(id);if(!c)out.set(id,c={items:[],owners:[]});
    for(const item of parts[i])c.items.push(item);
  }
  for(const [n,i] of byOwner)out.get(root(i)).owners.push(n);
  return out.values();
}

function request(n){
  if(n.kind!=='call'||!n.valid)return;
  const sig=n.input.slice(0,10),direct=sig==='0xa9059cbb';
  if(!direct&&sig!=='0x23b872dd')return;
  if(n.input.length!==(direct?138:202)||!/^0x[0-9a-f]+$/.test(n.input))return;
  if(n.output&&n.output!=='0x'&&!(n.output.length===66&&uint(n.output.slice(2))===1n))return;
  const w=i=>n.input.slice(10+i*64,74+i*64);
  const from=direct?n.sender:addr(w(0)),to=addr(w(direct?0:1)),amount=uint(w(direct?1:2));
  if(from&&to&&amount!==undefined)return [from,to,amount].join('/');
}

export function matchingPaymentStream(timeline,topic){
  const entries=[],chosen=new Map();
  for(const [e,p] of timeline.placements)if(e.topics[0]===topic)entries.push({e,owners:possibleReceiptOwners(p)});
  for(const c of receiptComponents(entries)){
    if(c.items.length!==c.owners.length||!c.items.some(x=>x.owners.size>1))continue;
    const keys=new Map(),bind=new Map();
    for(const n of c.owners){const k=request(n);if(!k||keys.has(k))break;keys.set(k,n);}
    if(keys.size!==c.owners.length)continue;
    for(const {e,owners} of c.items){
      const from=addr(e.topics[1]?.slice(2)),to=addr(e.topics[2]?.slice(2)),q=uint(e.data?.slice(2));
      if(e.topics.length!==3||!from||!to||q===undefined)break;
      const n=keys.get([from,to,q].join('/'));if(!n||!owners.has(n)||bind.has(n))break;
      bind.set(n,{e,owners});
    }
    if(bind.size===c.owners.length)for(const [n,{e,owners}] of bind)if(owners.size>1)chosen.set(e,n);
  }
  return chosen;
}
