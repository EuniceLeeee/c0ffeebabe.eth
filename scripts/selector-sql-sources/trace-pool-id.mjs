// A layout decodes calldata and log fields. The matcher below owns transaction,
// emitter, entry scope, full pool ID, direction, multiplicity and provenance.
import {keccak_256} from '../../listener/node_modules/@noble/hashes/esm/sha3.js';
import {hexToBytes,bytesToHex} from '../../listener/node_modules/@noble/hashes/esm/utils.js';
import {canonicalSwapTopics,decodeCanonicalSwap} from './canonical-swap-decode.mjs';
import {v4MainnetManager} from './v4-history.mjs';
import {partitionActionEvidence,reconcileCounterpartyReturn,reconcileDeferredGroup} from './trace-action-settlement.mjs';

const word=(input,i)=>input.slice(10+64*i,74+64*i);
const address=w=>/^0{24}[0-9a-f]{40}$/.test(w)?'0x'+w.slice(24):null;

// Offsets in a dynamic tuple array are measured from the element-offset
// table, whereas top-level offsets are measured from the start of arguments.
function vaultBatchSteps({input}) {
  const words = (input.length - 10) / 64;
  if (!Number.isInteger(words) || words < 9) return;
  const at = i => word(input, i);
  const small = i => {
    if (!Number.isInteger(i) || i < 0 || i >= words) return NaN;
    return Number(BigInt('0x' + at(i)));
  };
  const offset = i => small(i) / 32;
  const kind = small(0), swaps = offset(1), assets = offset(2);
  if (kind !== 0 && kind !== 1 || !Number.isInteger(swaps) || swaps < 9 ||
      !Number.isInteger(assets) || assets < 9) return;
  const count = small(swaps), assetCount = small(assets);
  if (!(count > 0 && swaps + 1 + count <= words && assetCount > 1 && assets + 1 + assetCount <= words)) return;
  const result = [];
  for (let i = 0; i < count; ++i) {
    const relative = offset(swaps + 1 + i);
    const base = swaps + 1 + relative;
    if (!Number.isInteger(relative) || relative < count || base + 5 > words) return;
    const inIndex = small(base + 1), outIndex = small(base + 2);
    if (inIndex >= assetCount || outIndex >= assetCount) return;
    const tokenIn = address(at(assets + 1 + inIndex)), tokenOut = address(at(assets + 1 + outIndex));
    if (!tokenIn || !tokenOut || tokenIn === tokenOut) return;
    const poolId = '0x' + at(base);
    result.push({poolId, poolAddress: poolId.slice(0,42), tokenIn, tokenOut, roles: [tokenIn, tokenOut],
      amountSide: kind, specifiedAmount: BigInt('0x' + at(base + 3))});
  }
  return result;
}

const v4Swap = {
    emitter:v4MainnetManager, entry:'0x48c89491', action:'0xf3cd914c',
    topic:canonicalSwapTopics.v4, evidence:'trace-signed-swap-poolkey',
    settlementEvidence:'action-return-reconciled-settlement',
    call({input,sender,target}){
      if(input.length<650 || (input.length-10)%64) return;
      const c0=address(word(input,0)),c1=address(word(input,1)),fee=word(input,2),spacing=word(input,3),flag=word(input,5);
      if(!c0 || !c1 || c0>=c1 || !address(word(input,4)) || !/^0{58}[0-9a-f]{6}$/.test(fee)
        || !/^0{60}[0-7][0-9a-f]{3}$/.test(spacing) || parseInt(spacing,16)===0 || !/^0{63}[01]$/.test(flag)) return;
      if(parseInt(fee,16)>1e6 && parseInt(fee,16)!==0x800000) return;
      const poolId='0x'+bytesToHex(keccak_256(hexToBytes(input.slice(10,330))));
      const forward=flag.endsWith('1');
      return {poolId,poolAddress:target,tokenIn:forward?c0:c1,tokenOut:forward?c1:c0,assets:[c0,c1],roles:[sender,forward]};
    },
    roles(log){
      const swap=decodeCanonicalSwap(canonicalSwapTopics,log.emitter,log.topics,log.data);
      if(swap?.decodeStatus==='decoded') return ['0x'+log.topics[2].slice(-40),swap.direction==='asset0-in'];
    },
    identityOnly(log) {
      if (!/^0x0{128}/.test(log.data)) return;
      const swap=decodeCanonicalSwap(canonicalSwapTopics,log.emitter,log.topics,log.data);
      if (swap?.decodeStatus==='uninterpretable') return '0x'+log.topics[2].slice(-40);
    },
};

const vaultSwap = {
    emitter:'0xba12222222228d8ba445958a75a0704d566bf2c8', entry:'0x52bbbe29', action:'0x52bbbe29',
    topic:'0x2170c741c41531aec20e7c107c24eecfdd15e69c9bb0a8dd37b1840b9e0b207b', evidence:'vault-swap-poolid',
    call({input}){
      if(!/^[0-9a-f]{64}$/.test(word(input,0))) return;
      const offset=Number(BigInt('0x'+word(input,0)));
      if(!Number.isSafeInteger(offset)||offset<224||offset%32||10+2*offset+384>input.length) return;
      const base=offset/32,poolId='0x'+word(input,base);
      const tokenIn=address(word(input,base+2)),tokenOut=address(word(input,base+3));
      if(!tokenIn||!tokenOut||tokenIn===tokenOut||!/^0{63}[01]$/.test(word(input,base+1))) return;
      return {poolId,poolAddress:poolId.slice(0,42),tokenIn,tokenOut,roles:[tokenIn,tokenOut],
        amountSide:Number(BigInt('0x'+word(input,base+1))), specifiedAmount:BigInt('0x'+word(input,base+4))};
    },
    roles({topics,data}){
      if(topics.length!==4||!/^0x[0-9a-f]{128}$/.test(data)||BigInt(data.slice(0,66))===0n||BigInt('0x'+data.slice(66))===0n) return;
      const a=address(topics[2].slice(2)),b=address(topics[3].slice(2));
      if(a && b && a!==b) return [a,b];
    },
};

export const poolIdLayouts = [v4Swap, vaultSwap, {
  emitter: vaultSwap.emitter, topic: vaultSwap.topic, roles: vaultSwap.roles,
  entry:'0x945bcec9', action:'0x945bcec9', evidence:'vault-batch-swap-poolid', steps:vaultBatchSteps,
}];

function edgeFor(call, entry, proof, layout, event) {
  return {selector:entry.selector,poolAddress:proof.poolAddress,poolId:proof.poolId,
    tokenIn:proof.tokenIn,tokenOut:proof.tokenOut,evidence:layout.evidence,
    callPath:entry.path,innerSwapPath:entry===call?null:call.path,selectorTarget:entry.target,
    receiptIndices:String(event.idx)};
}

// Calls using a batch and calls using the single-step ABI emit the same topic.
// Bind their whole ordered stream before publishing any step from it.
function bindOrderedSteps(layouts, calls, logs, topic) {
  const methods = new Map(layouts.filter(l => l.topic === topic).map(l => [l.action, l]));
  const events = logs.filter(l => l.emitter === layouts[0].emitter && l.topics[0] === topic);
  const edges = [];
  let previousCall;
  for (const call of calls) {
    const layout = methods.get(call.selector);
    if (!layout) continue;
    if (previousCall && (previousCall.path === '' || call.path.startsWith(previousCall.path + ','))) return [];
    previousCall = call;
    const steps = layout.steps ? layout.steps(call) : [layout.call(call)];
    if (!steps?.length) return [];
    let previous;
    for (const step of steps) {
      const event = events[edges.length];
      if (!event || !step || step.poolId !== event.topics[1]) return [];
      const roles = layout.roles(event);
      if (!roles || !step.roles.every((role, i) => role === roles[i])) return [];
      if (step.specifiedAmount !== undefined) {
        const amounts = [BigInt(event.data.slice(0,66)), BigInt('0x' + event.data.slice(66))];
        const side = step.amountSide;
        const assets = [step.tokenIn, step.tokenOut];
        if (step.specifiedAmount === 0n) {
          if (!previous || assets[side] !== previous.asset || amounts[side] !== previous.amount) return [];
        } else if (amounts[side] !== step.specifiedAmount) return [];
        previous = {asset: assets[1-side], amount: amounts[1-side]};
      }
      edges.push(edgeFor(call, call, step, layout, event));
    }
  }
  return events.length === edges.length ? edges : [];
}

// For events carrying identity only, align ALL manager actions and events in
// execution order. Never take the first matching receipt across sibling pools.
// An existing signed-event edge remains authoritative and is not duplicated.
function bindSettledActions(layout,calls,logs,context,published) {
  const rule=context?.proofs?.[layout.action];
  if(!rule || rule.entrySelector!==layout.entry || !layout.identityOnly) return [];
  const events=logs.filter(l=>l.emitter===layout.emitter && l.topics[0]===layout.topic);
  if(!events.some(l=>layout.identityOnly(l))) return [];
  const steps=calls.filter(n=>n.target===layout.emitter && n.selector===layout.action);
  if(steps.length!==events.length || steps.some((n,i)=>i && n.order<=steps[i-1].order)) return [];
  const batches=partitionActionEvidence(steps,context,new Map(events.map((e,i)=>[e,steps[i]])));
  const pending=[], claims=new Map(), unproven=new Map();
  for (const [i,n] of steps.entries()) {
    const event=events[i], proof=layout.call(n), batch=batches.get(n);
    if (!batch || batch.nested || !proof || proof.poolId!==event.topics[1]) return [];
    const actor=layout.identityOnly(event);
    if(!actor) {
      const roles=layout.roles(event);
      if(!roles || !proof.roles.every((r,j)=>r===roles[j])) return [];
      continue;
    }
    if(actor!==n.sender) return [];
    let entry=n.parent;
    while(entry && !(entry.target===layout.emitter && entry.selector===layout.entry)) entry=entry.parent;
    if(!entry || published.has(n.path)) continue;
    const validated=reconcileCounterpartyReturn(n,rule,proof.assets,proof.roles[1],batch,context.native);
    if(!validated) {
      if(rule.batch) {
        if(!unproven.has(entry)) unproven.set(entry,[]);
        unproven.get(entry).push({n,entry,proof,event,batch});
      }
      continue;
    }
    for(const k of validated.residualIndices) claims.set(k,(claims.get(k)??0)+1);
    const edge=edgeFor(n,entry,proof,layout,event);
    edge.evidence=layout.settlementEvidence;
    edge.receiptIndices=[...validated.receiptIndices,event.idx].sort((a,b)=>a-b).join(',');
    pending.push({edge,residualIndices:validated.residualIndices});
  }
  const result=pending.filter(p=>p.residualIndices.every(k=>claims.get(k)===1)).map(p=>p.edge);
  for (const members of unproven.values()) {
    const batch=reconcileDeferredGroup(members,rule,context);
    if(!batch) continue;
    for (let i=0;i<members.length;i++) {
      const {n,entry,proof,event}=members[i], edge=edgeFor(n,entry,proof,layout,event);
      edge.evidence=layout.settlementEvidence;
      // Cash corroborates the WHOLE entry; never repeat it per action. Each
      // member still owns its own signed return/identity log and inner path.
      if(i===0) edge.receiptIndices=[...batch.receiptIndices,event.idx].sort((a,b)=>a-b).join(',');
      result.push(edge);
    }
  }
  return result;
}

export function bindPoolIdReceipts(layouts, calls, logs, context) {
  const groups=new Map(), edges=[];
  function group(topic,poolId,roles){
    const key=JSON.stringify([topic,poolId,...roles]);
    if(!groups.has(key)) groups.set(key,{calls:[],logs:[]});
    return groups.get(key);
  }
  const decodedLogs=new Set();
  const orderedTopics = new Set(layouts.filter(l => l.steps).map(l => l.topic));
  for (const topic of orderedTopics) edges.push(...bindOrderedSteps(layouts, calls, logs, topic));
  for(const layout of layouts){
    if(layout.steps || orderedTopics.has(layout.topic)) continue;
    for(const call of calls){
      if(call.selector!==layout.action || call.target!==layout.emitter) continue;
      let entry=call;
      while(entry && !(entry.target===layout.emitter && entry.selector===layout.entry)) entry=entry.parent;
      if(!entry) continue;
      const proof=layout.call(call);
      if(proof) group(layout.topic,proof.poolId,proof.roles).calls.push({call,entry,proof,layout});
    }
    for(const log of logs){
      const id=log.topics[1];
      if(log.emitter!==layout.emitter || log.topics[0]!==layout.topic || !/^0x[0-9a-f]{64}$/.test(id) || decodedLogs.has(log.idx)) continue;
      const roles=layout.roles(log);
      if(roles){
        group(layout.topic,id,roles).logs.push(log);
        decodedLogs.add(log.idx);
      }
    }
  }
  for(const {calls:matches,logs:events} of groups.values()){
    if(matches.length!==events.length || !matches.length) continue;
    // Disjoint sibling calls and their emitted logs have the same execution order.
    // Nested identical calls can emit in the opposite order.
    matches.sort((a,b)=>a.call.order-b.call.order);
    if(matches.some(({call},i)=>i>0 && (call===matches[i-1].call || matches[i-1].call.path==='' || call.path.startsWith(matches[i-1].call.path+',')))) continue;
    matches.forEach(({call,entry,proof,layout},i)=>edges.push(edgeFor(call,entry,proof,layout,events[i])));
  }
  if(context?.proofs) {
    const published=new Set(edges.map(edge=>edge.innerSwapPath??edge.callPath));
    for(const layout of layouts) edges.push(...bindSettledActions(layout,calls,logs,context,published));
  }
  return edges;
}
