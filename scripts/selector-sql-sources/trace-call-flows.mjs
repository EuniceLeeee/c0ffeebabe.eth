import {bindActionReceipts,mergeReceiptIndices} from './bind-action-receipts.mjs';
import {bindPoolIdReceipts,poolIdLayouts} from './trace-pool-id.mjs';
import {matchSwapInput, matchSwapOutput, ownsDiscrepantInput} from './trace-swap-input.mjs';

const sharedPools=new Map();
for (const layout of poolIdLayouts) {
  if (!sharedPools.has(layout.emitter)) sharedPools.set(layout.emitter,[]);
  sharedPools.get(layout.emitter).push(layout);
}

// Frames are successful only if all ancestors committed. Keep transfer calldata
// and the receipt's actual credited amount as separate pieces of evidence.
export function traceCallFlows(frames, logs, cfg) {
  const groups = (map, key) => {
    if (!map.has(key)) map.set(key, []);
    return map.get(key);
  };
  const word = (data, i) => data.slice(10 + 64*i, 74 + 64*i);
  const address = w => /^0{24}[0-9a-f]{40}$/.test(w) ? '0x' + w.slice(24) : null;
  const addrTopic = t => t && address(t.slice(2));
  const inside = (p, parent) => p === parent || parent === '' || p.startsWith(parent + ',');
  const movements = [], transfers = new Map(), transferLogs = new Map();
  const transferReceipts=new Map();
  const paths = new Map(), actions = new Map(), emitted = [], logsByEmitter = new Map();
  const incomingLogs=new Map(), callParties=new Map(), logParties=new Map();
  const payoutCounts = new Map();
  const possiblePayers = new Set();
  function owningCall(node, target) {
    for (let n = node; n; n = n.parent) {
      if (n.net && n.target === target) return n;
    }
  }
  const parties=(asset,from,to)=>[asset,from,to].join('/');
  const movementKey = (asset, from, to, quantity) => [asset,from,to,quantity].join('/');
  for (const l of logs) {
    groups(logsByEmitter, l.emitter).push(l);
    if (l.topics[0] !== cfg.transferTopic || l.topics.length !== 3 || !/^0x[0-9a-f]{64}$/.test(l.data)) continue;
    const from = addrTopic(l.topics[1]), to = addrTopic(l.topics[2]);
    const amount=BigInt(l.data);
    if (!from || !to || from===to || !amount) continue;
    transferReceipts.set(l,{asset:l.emitter,from,to,amount,index:l.idx});
    groups(incomingLogs,to).push(l);
    groups(logParties,parties(l.emitter,from,to)).push(l);
    groups(transferLogs, movementKey(l.emitter, from, to, l.data.slice(2))).push(l);
  }
  for (const [order, f] of frames.entries()) {
    const parent = f.path === '' ? null : paths.get(f.path.split(',').slice(0,-1).join(','));
    const valid = f.ok && (!parent || parent.valid) && f.kind !== 'staticcall';
    const node = { ...f, parent, valid, order };
    paths.set(f.path, node);
    if (!valid || f.kind !== 'call' || !f.target || f.target === f.sender) continue;
    const amount = BigInt(f.value || '0');
    if (amount > 0n) movements.push({node, asset:cfg.native, from:f.sender, to:f.target, amount, index:null});
    if (f.input.length < 10) continue;
    const selector = f.input.slice(0,10);
    if (selector === '0xa9059cbb' || selector === '0x23b872dd') {
      const direct = selector === '0xa9059cbb';
      const from = direct ? f.sender : address(word(f.input,0)), to = address(word(f.input,direct ? 0 : 1));
      const w = word(f.input,direct ? 1 : 2);
      if (from && to && from !== to && /^[0-9a-f]{64}$/.test(w) && BigInt('0x'+w) > 0n) {
        groups(transfers,movementKey(f.target,from,to,w)).push(node);
        groups(callParties,parties(f.target,from,to)).push(node);
        const owner = owningCall(parent, from);
        if (owner) possiblePayers.add(owner);
        if (owner?.selector === cfg.amountSwapSelector) {
          if (!payoutCounts.has(owner)) payoutCounts.set(owner, new Map());
          const counts = payoutCounts.get(owner);
          counts.set(to, (counts.get(to) ?? 0) + 1);
        }
      }
      continue;
    }
    if (selector === '0x095ea7b3' || selector === '0x70a08231') continue;
    node.selector = selector;
    node.net = new Map();
    node.indices = new Set();
    groups(actions,f.target).push(node);
  }
  const discrepancies=new Map();
  const transferAnchors=new Map();
  const outputTransfers = new Map();
  for (const [key, nodes] of transfers) {
    const events = transferLogs.get(key);
    const [asset,from,to,w] = key.split('/');
    if (!events || events.length !== nodes.length) {
      const party=parties(asset,from,to), candidates=logParties.get(party);
      if (!events && callParties.get(party).length===1 && candidates?.length===1) {
        groups(discrepancies,to).push({node:nodes[0],log:candidates[0]});
        const owner = owningCall(nodes[0].parent, from);
        if (payoutCounts.get(owner)?.get(to) === 1) {
          groups(outputTransfers, owner).push({asset, from, to, amount: BigInt('0x' + w),
            index: candidates[0].idx, received: BigInt(candidates[0].data)});
        }
      }
      continue;
    }
    if (nodes.some((n,i) => i > 0 && inside(n.path,nodes[i-1].path))) continue;
    if (nodes.length===1) transferAnchors.set(events[0],nodes[0]);
    nodes.forEach((node,i) => movements.push({node,...transferReceipts.get(events[i])}));
  }
  const add = (node,move,delta) => {
    node.net.set(move.asset,(node.net.get(move.asset) || 0n) + delta);
    if (move.index !== null) node.indices.add(move.index);
  };
  const pending = new Map();
  const assigned = new Map();
  function attribute(move, target, incoming) {
    if (!actions.has(target)) return;
    const owner = owningCall(move.node, target);
    if (owner) {
      add(owner, move, incoming ? move.amount : -move.amount);
      groups(assigned, owner).push(move);
      return;
    }
    // Native value on a payable call is accounted for at that call. Only
    // externally prepaid ERC20 transfers are eligible for forward assignment.
    if (incoming && move.index !== null) groups(pending,target).push(move);
  }
  for (const move of movements) {
    attribute(move,move.from,false);
    attribute(move,move.to,true);
  }
  for (const [target, list] of actions) {
    const targetLogs=logsByEmitter.get(target) || [];
    const layouts=sharedPools.get(target);
    if (layouts) {
      emitted.push(...bindPoolIdReceipts(layouts,list,targetLogs));
      continue;
    }
    const byFrame = new Map();
    const outputProofs = new Map();
    const incoming = incomingLogs.get(target) || [];
    for (const n of list) {
      const outputs = outputTransfers.get(n);
      if (!outputs) continue;
      const proof = matchSwapOutput(n, outputs, list, targetLogs, incoming, incomingLogs, cfg);
      if (proof) outputProofs.set(n, proof);
    }
    const payeeCalls = list.filter(n => possiblePayers.has(n) || [...n.net.values()].some(v => v < 0n));
    const mismatch=discrepancies.get(target) || [];
    const prepaid = pending.get(target) || [];
    const inputProofs = new Map();
    const ownersByReceipt = new Map();
    if (mismatch.length || (prepaid.length && payeeCalls.length > 1)) {
      for (const call of payeeCalls) {
        const proof = outputProofs.get(call) ?? matchSwapInput(call, assigned.get(call) || [], targetLogs, incoming, cfg);
        if (!proof) continue;
        inputProofs.set(call, proof);
        groups(ownersByReceipt, proof.input.idx).push(call);
      }
    }
    function prepaidOwner(node, receiptIndex) {
      // Preorder visits a transfer before its own callbacks; the transfer
      // need not have credited the pool until those callbacks return.
      const followsTransfer = call => call.order > node.order && !inside(call.path, node.path);
      const owners = ownersByReceipt.get(receiptIndex);
      if (owners) return owners.length === 1 && followsTransfer(owners[0]) ? owners[0] : undefined;
      // With multiple later payouts, chronological proximity alone is ambiguous.
      const last = payeeCalls[payeeCalls.length - 1];
      const previous = payeeCalls[payeeCalls.length - 2];
      if (last && followsTransfer(last) && (!previous || !followsTransfer(previous))
          && !inputProofs.has(last)) return last;
    }
    for (const move of prepaid) {
      const owner = prepaidOwner(move.node, move.index);
      if (owner) groups(byFrame, owner).push(move);
    }
    for (const n of list) {
      let evidence = 'subtree-net-flow';
      const credits = byFrame.get(n);
      const payout = outputProofs.get(n);
      if (payout) {
        const {input, output, swap} = payout;
        const funding = [...(assigned.get(n) || []), ...(credits || [])];
        const exactInput = funding.length === 1 && funding[0].to === target && funding[0].index === input.idx;
        const netInput = !funding.length && ownsDiscrepantInput(n, input, mismatch, prepaidOwner);
        if (exactInput || netInput) {
          emitted.push({selector: n.selector, poolAddress: target, poolId: null, tokenIn: input.emitter,
            tokenOut: output.asset, evidence: netInput ? 'swap-confirmed-net-input-and-output' : 'swap-confirmed-net-output',
            callPath: n.path, selectorTarget: target, innerSwapPath: null,
            receiptIndices: [input.idx, output.index, swap.idx].sort((a,b) => a-b).join(','),
            amountPoolOutRaw: String(output.amount), amountReceivedOutRaw: String(output.received)});
        }
        continue;
      }
      if (credits) {
        if ([...n.net.values()].every(v=>v<=0n)) {
          for (const m of credits) add(n,m,m.amount);
          evidence = 'prepaid-and-subtree-net-flow';
          const proof = inputProofs.get(n);
          if (proof) {
            n.indices.add(proof.swap.idx);
            evidence = 'swap-confirmed-prepayment';
          }
        }
      }
      if (mismatch.length && !credits && n.net.size===1) {
        const proof = inputProofs.get(n);
        if (proof && ownsDiscrepantInput(n, proof.input, mismatch, prepaidOwner)) {
          add(n,{asset:proof.input.emitter,index:proof.input.idx},BigInt(proof.input.data));
          n.indices.add(proof.swap.idx);
          evidence='swap-confirmed-net-input';
        }
      }
      const positive = [], negative = [];
      for (const [token,delta] of n.net) {
        if (delta > 0n) positive.push(token);
        if (delta < 0n) negative.push(token);
      }
      if (positive.length === 1 && negative.length === 1)
        emitted.push({selector:n.selector,poolAddress:target,poolId:null,tokenIn:positive[0],tokenOut:negative[0],
          evidence,callPath:n.path,selectorTarget:target,innerSwapPath:null,
          receiptIndices:[...n.indices].sort((a,b)=>a-b).join(',')});
    }
  }
  const rules=cfg.actionReceipts??{};
  const emittedPaths=new Set(emitted.map(e=>e.callPath));
  const declared=bindActionReceipts(rules,paths,logs,movements,sharedPools,cfg.transferTopic,transferReceipts,transferAnchors,emittedPaths);
  if (!declared.size) return emitted;
  // Only ordinary CALL paths have one pair per frame. Shared managers keep
  // their independently keyed logical pools.
  const result=emitted.filter(flow=>{
    if (flow.poolId || !declared.has(flow.callPath)) return true;
    const edge=declared.get(flow.callPath);
    if (!edge) return false;
    if (flow.tokenIn!==edge.tokenIn || flow.tokenOut!==edge.tokenOut) {
      const netOnly=flow.evidence==='subtree-net-flow' || flow.evidence==='prepaid-and-subtree-net-flow';
      if (edge.boundAssets && netOnly)
        edge.conflictingFlow={tokenIn:flow.tokenIn,tokenOut:flow.tokenOut,evidence:flow.evidence,receiptIndices:flow.receiptIndices};
      else declared.delete(flow.callPath);
      return false;
    }
    declared.delete(flow.callPath);
    flow.amountVenueInRaw??=edge.amountVenueInRaw;
    flow.amountPayerInRaw??=edge.amountPayerInRaw;
    flow.amountPoolOutRaw??=edge.amountPoolOutRaw;
    flow.amountReceivedOutRaw??=edge.amountReceivedOutRaw;
    flow.receiptIndices=mergeReceiptIndices(flow.receiptIndices,edge.receiptIndices);
    return true;
  });
  for (const edge of declared.values()) if (edge) result.push(edge);
  return result;
}
