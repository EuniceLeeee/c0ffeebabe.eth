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

  // Non-decreasing placement permits multiple logs in one execution slot.
  // Greedy prefix/suffix bounds are attainable. Every matching slot between
  // them can be combined with the earliest prefix and the latest suffix.
  const first = new Array(logs.length);
  let lower = 0;
  for (let i=0; i<logs.length; i++) {
    const slots = slotsByAddress.get(logs[i].emitter);
    if (!slots || (i && logs[i].idx <= logs[i-1].idx)) return;
    const index = lowerBound(slots,lower);
    if (index === slots.length) return;
    lower = slots[index].position;
    first[i] = index;
  }
  let upper = position;
  const placements = new Map();
  for (let i=logs.length-1; i>=0; i--) {
    const log = logs[i];
    const slots = slotsByAddress.get(log.emitter);
    const last = lowerBound(slots,upper+1)-1;
    if (last < first[i]) return;
    upper = slots[last].position;
    if (relevantTopics.has(log.topics[0])) placements.set(log,{slots,first:first[i],last});
  }
  // A set of ABI bindings can be individually plausible and jointly out of
  // order. Replay the entire receipt order with those extra constraints.
  function canPlace(bindings) {
    let lower = 0;
    for (const log of logs) {
      const slots = slotsByAddress.get(log.emitter);
      let i = lowerBound(slots,lower);
      const owner = bindings.get(log);
      if (owner) while (i<slots.length && slots[i].owner!==owner) i++;
      if (i===slots.length) return false;
      lower = slots[i].position;
    }
    return true;
  }
  return {placements,canPlace};
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
