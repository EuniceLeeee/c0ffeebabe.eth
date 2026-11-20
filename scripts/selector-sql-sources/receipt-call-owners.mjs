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
      if (relevantTopics.has(log.topics[0])) result.set(log,{slots,first:first[i],last});
    }
    return result;
  }
  const placements=locate();
  if (placements) return {placements,withBindings:locate,canPlace:bindings=>locate(bindings,true)===true};
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
