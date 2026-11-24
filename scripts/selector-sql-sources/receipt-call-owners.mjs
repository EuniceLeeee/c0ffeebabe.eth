const indexes=new WeakMap();
function indexFor(slots){
  let idx=indexes.get(slots);if(idx)return idx;
  const previous=new Int32Array(slots.length),positions=new Map();
  for(let i=0;i<slots.length;i++){
    const n=slots[i].owner,v=positions.get(n);
    if(v===undefined){previous[i]=-1;positions.set(n,i);}
    else if(typeof v==='number'){previous[i]=v;positions.set(n,[v,i]);}
    else{previous[i]=v[v.length-1];v.push(i);}
  }
  idx={previous,positions};indexes.set(slots,idx);return idx;
}
function firstAtOrAfter(list,n){let l=0,r=list.length;while(l<r){const m=(l+r)>>>1;if(list[m]<n)l=m+1;else r=m;}return l;}

// A Set-compatible read-only view: all receipts at one emitter share one
// sparse occurrence index. Even a million possible receipt/call pairs are
// represented by one range per receipt. Iteration keeps first-seen order.
class OwnerRange{
  constructor(range){this.range=range;}
  *[Symbol.iterator](){const {slots,first,last,only}=this.range;
    if(only){yield only;return;}
    if(first===last){yield slots[first].owner;return;}
    const {previous}=indexFor(slots);
    for(let i=first;i<=last;i++)if(previous[i]<first)yield slots[i].owner;
  }
  get size(){const r=this.range;
    if(r.only||r.first===r.last)return 1;
    if(r.ownerCount==null){let n=0;for(const _ of this)n++;r.ownerCount=n;}
    return r.ownerCount;
  }
  has(n){const {slots,first,last,only}=this.range;if(only)return only===n;
    if(first===last)return slots[first].owner===n;
    const v=indexFor(slots).positions.get(n);
    if(typeof v==='number')return first<=v&&v<=last;
    if(!v)return false;
    const i=firstAtOrAfter(v,first);return i<v.length&&v[i]<=last;
  }
}
export function possibleReceiptOwners(range){return new OwnerRange(range);}

// locate emits ranges in reverse receipt order. For each emitter BOTH ends
// are non-increasing, so counting distinct owners in all ranges uses one
// sliding window. Later size checks are O(1), with O(total slots) live state.
function countRanges(placements){
  const windows=new Map();
  for(const r of placements.values()){
    if(r.only||r.first===r.last)continue;
    const slots=r.slots;let w=windows.get(slots);
    if(!w){w={counts:new Map(),first:slots.length,last:-1};windows.set(slots,w);}
    if(r.last<w.first){w.counts.clear();w.first=r.last+1;}
    else for(let i=w.last;i>r.last;i--){const o=slots[i].owner,n=w.counts.get(o)-1;if(n)w.counts.set(o,n);else w.counts.delete(o);}
    for(let i=w.first-1;i>=r.first;i--){const o=slots[i].owner;w.counts.set(o,(w.counts.get(o)||0)+1);}
    r.ownerCount=w.counts.size;w.first=r.first;w.last=r.last;
  }
}

// Each slot represents execution in one call, between child calls. A caller
// cannot emit while a child is running. DELEGATECALL and CALLCODE retain the
// caller's emitting address and logical owner.
export function receiptCallOwners(nodes, logs, relevantTopics) {
  const slotsByAddress = new Map();
  const stack = [];
  let position = 0;
  let lastOwner;

  function resume(owner) {
    if (!owner || owner === lastOwner) return;
    lastOwner = owner;
    let slots = slotsByAddress.get(owner.target);
    if (!slots) slotsByAddress.set(owner.target, slots = []);
    slots.push({position:position++, owner});
  }

  for (const frame of nodes) {
    while (stack.length && stack[stack.length-1].frame !== frame.parent) {
      stack.pop();
      resume(stack[stack.length-1]?.owner);
    }
    let owner;
    if (frame.valid) {
      if (frame.kind === 'call' || frame.kind === 'create' || frame.kind === 'create2') owner = frame;
      else if (frame.kind === 'delegatecall' || frame.kind === 'callcode') owner = stack[stack.length-1]?.owner;
    }
    stack.push({frame,owner});
    resume(owner);
  }
  while (stack.length) {
    stack.pop();
    resume(stack[stack.length-1]?.owner);
  }

  // Prefix/suffix bounds narrow every receipt when a unique transfer pins
  // a neighbouring log. Multiple logs can still occupy one execution slot.
  function locate(bindings, checkOnly=false) {
    const first = checkOnly ? undefined : new Array(logs.length);
    let lower = 0;
    for (let i=0; i<logs.length; i++) {
      const log=logs[i], slots=slotsByAddress.get(log.emitter), owner=bindings?.get(log);
      if (!slots || (i && log.idx<=logs[i-1].idx)) return;
      let index=lowerBound(slots,lower);
      if (owner) while (index<slots.length && slots[index].owner!==owner) index++;
      if (index===slots.length) return;
      lower=slots[index].position;
      if (first) first[i]=index;
    }
    if (checkOnly) return true;
    let upper=position;
    const result=new Map();
    for (let i=logs.length-1; i>=0; i--) {
      const log=logs[i], slots=slotsByAddress.get(log.emitter), owner=bindings?.get(log);
      let last=lowerBound(slots,upper+1)-1;
      if (owner) while (last>=first[i] && slots[last].owner!==owner) last--;
      if (last<first[i]) return;
      upper=slots[last].position;
      if (relevantTopics.has(log.topics[0])) {
        // The bound caller can yield to another call to the same contract and
        // resume. Interior slots are NOT all the bound owner just because the
        // two endpoints are. Preserve original EVM positions for other logs.
        result.set(log,{slots,first:first[i],last,...(owner?{only:owner}:{})});
      }
    }
    countRanges(result);
    return result;
  }
  function view(pins,placements) {
    function combine(more) {
      const all=new Map(pins);
      for(const [l,n] of more) {
        if(all.has(l)&&all.get(l)!==n)return;
        all.set(l,n);
      }
      return all;
    }
    return {placements,
      withBindings:more=>{const all=combine(more);if(all)return locate(all);},
      canPlace:more=>{const all=combine(more);return !!all&&locate(all,true)===true;},
      constrain:more=>{const all=combine(more),next=all&&locate(all);if(next)return view(all,next);}
    };
  }
  const placements=locate();if(placements)return view(new Map(),placements);
}

function lowerBound(slots, position) {
  let left=0, right=slots.length;
  while (left < right) {
    const mid = left + Math.floor((right-left)/2);
    if (slots[mid].position < position) left=mid+1;
    else right=mid;
  }
  return left;
}
