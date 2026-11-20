import {receiptCallOwners, possibleReceiptOwners} from './receipt-call-owners.mjs';
import {callerReceiptEdges} from './caller-receipt-flows.mjs';

// Quantities remain integers in raw token units. Event balances describe the venue;
// a recipient amount is recorded only when a unique actual transfer identifies it.
const zero = '0x'+'0'.repeat(40);
const uint = s => /^[0-9a-f]{64}$/.test(s ?? '') ? BigInt('0x'+s) : undefined;
const addr = s => /^0{24}[0-9a-f]{40}$/.test(s ?? '') ? '0x'+s.slice(24) : undefined;
const inside = (path, root) => root === '' || path === root || path.startsWith(root+',');
const unique = values => { const set = new Set(values); return set.size === 1 ? set.values().next().value : undefined; };

export function mergeReceiptIndices(left, right) {
  return [...new Set((left+','+right).split(',').filter(Boolean))].sort((a,b)=>a-b).join(',');
}

function decode(log, schema) {
  if (log.topics[0] !== schema.topic) return;
  let topic = 1, offset = 2;
  const fields = {};
  for (const f of schema.fields) {
    const w = f.indexed ? log.topics[topic++]?.slice(2) : log.data.slice(offset,offset+=64);
    let v = uint(w);
    if (v === undefined) return;
    if (f.type === 'address') { v=addr(w); if (!v) return; }
    else if (f.type === 'bool') { if (v>1n) return; }
    else {
      const signed=f.type.startsWith('int'), bits=Number(f.type.replace(/^u?int/,''));
      if (!Number.isInteger(bits) || bits<8 || bits>256) return;
      if (signed) v=BigInt.asIntN(256,v);
      if ((signed ? BigInt.asIntN(bits,v) : BigInt.asUintN(bits,v)) !== v) return;
    }
    fields[f.name]=v;
  }
  if (topic===log.topics.length && offset===log.data.length) return fields;
}

function operandValue(call, operand, isAddress) {
  if (operand==='caller') return call.sender;
  if (operand==='value') return BigInt(call.value||0);
  const index=Number(/^arg(\d+)/.exec(operand)[1]);
  const word=call.input.slice(10+64*index,74+64*index);
  if (!isAddress) return uint(word);
  const value=addr(word);
  return value===zero && operand.endsWith('-or-caller') ? call.sender : value;
}

function matchesFields(call, fields, equals) {
  return Object.entries(equals).every(([name,operand])=>
    fields[name]===operandValue(call,operand,typeof fields[name]==='string'));
}

// A callback can settle its caller. A nested declared trade on the same
// contract instead accounts for its own reads and payments.
function belongsToAction(node, call, rules) {
  if (!inside(node.path,call.path)) return false;
  for (let n=node; n && n!==call; n=n.parent)
    if (n.target===call.target && rules[n.selector]) return false;
  return true;
}

function snapshotAssets(call, rule, snapshot, reads, event) {
  if (!snapshot || snapshot.idx>=event.idx) return [];
  const spec=rule.snapshot;
  const state=decode(snapshot,spec);
  if (!state) return [];
  const balances=reads.filter(n=>n.sender===call.target && n.input.slice(0,10)===spec.read
    && addr(n.input.slice(10,74))===call.target && n.input.length===74);
  if (new Set(balances.map(n=>n.target)).size!==2) return [];
  const candidates=spec.balances.map(f=>unique(balances.filter(n=>uint(n.output.slice(2))===state[f]).map(n=>n.target)));
  return candidates[0] && candidates[1] && candidates[0]!==candidates[1] ? candidates : [];
}

function project(call, rules, event, fields, snapshotLog, nodes, movements) {
  const rule=rules[call.selector];
  const deltas=rule.deltas.map(terms=>terms.reduce((n,term)=>n+(term[0]==='-' ? -fields[term.slice(1)] : fields[term]),0n));
  if (rule.reverseWhenFalse && fields[rule.reverseWhenFalse]===0n) deltas.reverse();
  if (deltas[0]*deltas[1]>=0n) return;
  const input=deltas[0]>0n?0:1, output=1-input;
  const resolve=name=>name==='caller'?call.sender:fields[name];
  const payer=resolve(rule.payer),recipient=resolve(rule.recipient);
  const reads=nodes.filter(n=>n.kind==='staticcall' && n.ok && n.parent?.valid
    && /^0x[0-9a-f]{64}$/.test(n.output || '') && belongsToAction(n,call,rules));
  const snapshot=snapshotAssets(call,rule,snapshotLog,reads,event);
  const scoped=movements.filter(m=>belongsToAction(m.node,call,rules));
  const assets=[];
  const settled=[];
  let boundAssets=true;
  for (const [i,source] of rule.assets.entries()) {
    const incoming=i===input;
    const qty=incoming?deltas[i]:-deltas[i];
    const possible=new Set();
    if (source==='self') possible.add(call.target);
    else if (source==='native') possible.add(zero);
    else {
      for (const n of reads) if (n.target===call.target && n.input===source) {
        const asset=addr(n.output.slice(2)); if (asset && asset!==zero) possible.add(asset);
      }
    }
    if (snapshot[i]) possible.add(snapshot[i]);
    if (!possible.size) boundAssets=false;
    const cash=scoped.filter(m=>incoming ? (m.to===call.target || (payer && m.from===payer))
      : recipient ? m.to===recipient : m.from===call.target);
    const exact=cash.filter(m=>m.amount===qty);
    // A declared asset (e.g. vault shares) is distinct from funds released for the same amount.
    // Infer an unknown currency only from a single scoped movement with the declared economic role.
    if (!possible.size && exact.length===1) possible.add(exact[0].asset);
    assets[i]=unique(possible);
    if (!assets[i]) return;
    const actual=cash.filter(m=>m.asset===assets[i] && (!incoming || !payer || m.from===payer));
    if (actual.length===1) settled[i]=actual[0];
  }
  if (assets[0]===assets[1]) return;
  return {selector:call.selector,poolAddress:call.target,poolId:null,boundAssets,tokenIn:assets[input],tokenOut:assets[output],
    callPath:call.path,selectorTarget:call.target,innerSwapPath:null,evidence:'declared-action-receipt',
    receiptIndices:[...new Set([event.idx,...(snapshot.length ? [snapshotLog.idx] : []),...settled.flatMap(m=>m?.index==null?[]:[m.index])])].sort((a,b)=>a-b).join(','),
    amountVenueInRaw:String(deltas[input]),amountPoolOutRaw:String(-deltas[output]),
    amountReceivedOutRaw:recipient && settled[output] ? String(settled[output].amount) : null,
    amountPayerInRaw:payer && settled[input] ? String(settled[input].amount) : null};
}

// Two actual movements, in input/output order. An ambiguous movement counts as
// a competitor even when only one of its possible owners is inside this action.
function transferProof(call, rule, event, fields, transfers, rules) {
  const requested=operandValue(call,rule.equals[rule.inputAmount],false);
  const returned=uint(call.output?.slice(2));
  if (!requested || !returned || (event && !fields)) return;
  function party(role) {
    if (role==='zero') return zero;
    const operand=rule.equals[role];
    const value=operandValue(call,operand,true);
    if (!fields) return value;
    if (operand!=='caller' && fields[role]!==value) return;
    return fields[role];
  }
  const settled=[];
  for (const side of rule.transferProof) {
    const amount=side.amount===rule.inputAmount ? requested : returned;
    if (fields && fields[side.amount]!==amount) return;
    const from=side.from && party(side.from), to=side.to && party(side.to);
    if ((side.from && !from) || (side.to && !to)) return;
    let found;
    for (const m of transfers) {
      if (m.amount!==amount || (from && m.from!==from) || (to && m.to!==to)) continue;
      if (side.token==='self' ? m.asset!==call.target : (m.asset===call.target || m.from===zero || m.to===zero)) continue;
      let overlaps=false, entirelyInside=true;
      for (const owner of m.owners) {
        if (belongsToAction(owner,call,rules)) overlaps=true;
        else entirelyInside=false;
      }
      if (!overlaps) continue;
      if (!entirelyInside || found) return;
      found=m;
    }
    if (!found) return;
    settled.push(found);
  }
  const [input,output]=settled;
  if (input.asset===output.asset) return;
  const indices=[input.index,output.index];
  if (event) indices.push(event.idx);
  return {selector:call.selector,poolAddress:call.target,poolId:null,tokenIn:input.asset,tokenOut:output.asset,
    callPath:call.path,selectorTarget:call.target,innerSwapPath:null,evidence:'declared-settlement-transfers',boundAssets:true,
    receiptIndices:indices.sort((a,b)=>a-b).join(','),amountPayerInRaw:String(input.amount),amountReceivedOutRaw:String(output.amount),
    amountVenueInRaw:null,amountPoolOutRaw:null};
}

// When order alone leaves several calls, calldata may settle a whole stream:
// every plausible call must declare that event and explain exactly one log.
// Unknown entries, duplicate amounts or jointly impossible order give no hint.
function calldataBindings(groups, possibleOwners, rules) {
  const bindings = new Map();
  for (const events of groups.values()) {
    if (events.length<2 || !events.some(e=>possibleOwners.get(e).size>1)) continue;
    const owners = new Set(), eventByCall = new Map();
    for (const event of events) {
      const possible = possibleOwners.get(event);
      const topic = event.topics[0];
      let match;
      for (const call of possible) {
        owners.add(call);
        const rule = rules[call.selector];
        if (rule?.topic!==topic) { match=undefined; break; }
        const fields = decode(event,rule);
        if (!fields || !matchesFields(call,fields,rule.equals)) continue;
        if (match) { match=undefined; break; }
        match=call;
      }
      if (!match || eventByCall.has(match)) break;
      eventByCall.set(match,event);
    }
    if (eventByCall.size===events.length && eventByCall.size===owners.size) {
      for (const [call,event] of eventByCall) if (possibleOwners.get(event).size>1) bindings.set(event,call);
    }
  }
  return bindings;
}

export function bindActionReceipts(rules, paths, logs, movements, sharedPools, transferTopic, transferReceipts, transferAnchors, emittedPaths) {
  const edges=new Map();
  const nodes = Array.from(paths.values());
  const topics = new Set();
  const byCall = new Map();
  const nativeMoves=movements.filter(m=>m.index===null);
  const payers=new Set(), recipients=new Set();
  for (const moves of [transferReceipts.values(), nativeMoves]) for (const m of moves) {
    payers.add(m.from); recipients.add(m.to);
  }
  const candidates=[];
  for (const call of nodes) {
    if (!call.selector || sharedPools.has(call.target)) continue;
    if (!emittedPaths.has(call.path) && payers.has(call.sender) && recipients.has(call.sender))
      candidates.push(call);
    const rule = rules[call.selector];
    if (!rule) continue;
    topics.add(rule.topic);
    if (rule.snapshot) topics.add(rule.snapshot.topic);
    if (rule.transferProof && uint(call.output?.slice(2))) {
      byCall.set(call,new Map());
      topics.add(transferTopic);
    }
  }
  if (candidates.length) topics.add(transferTopic);
  if (!topics.size || !logs.some(l=>topics.has(l.topics[0]))) return edges;
  const timeline = receiptCallOwners(nodes,logs,topics);
  if (!timeline) return edges;
  const possibleOwners = new Map(), groups = new Map();
  const transfers=[];
  for (const [event,placement] of timeline.placements) {
    const possible = possibleReceiptOwners(placement);
    if (event.topics[0]===transferTopic) {
      const movement=transferReceipts.get(event);
      if (movement) transfers.push({...movement,owners:possible});
      continue;
    }
    possibleOwners.set(event,possible);
    const key = event.emitter+'/'+event.topics[0];
    if (!groups.has(key)) groups.set(key,[]);
    groups.get(key).push(event);
  }
  const hints = calldataBindings(groups,possibleOwners,rules);
  if (hints.size && timeline.canPlace(hints)) {
    for (const [event,owner] of hints) possibleOwners.set(event,new Set([owner]));
  }

  // Keep cardinality per call and topic. An ambiguous or duplicate event
  // blocks only the calls that could actually own it.
  for (const [event,possible] of possibleOwners) {
    const topic = event.topics[0];
    for (const call of possible) {
      const rule = rules[call.selector];
      if (!rule || sharedPools.has(call.target) || (topic!==rule.topic && topic!==rule.snapshot?.topic)) continue;
      let owned = byCall.get(call);
      if (!owned) byCall.set(call,owned=new Map());
      owned.set(topic,possible.size===1 && !owned.has(topic) ? event : null);
    }
  }
  for (const [call,owned] of byCall) {
    const rule = rules[call.selector];
    const event = owned.get(rule.topic);
    const fields = event && decode(event,rule);
    const edge = fields && matchesFields(call,fields,rule.equals)
      && project(call,rules,event,fields,owned.get(rule.snapshot?.topic),nodes,movements);
    const paid = rule.transferProof && transferProof(call,rule,event,fields,transfers,rules);
    if (edge && paid) {
      if (edge.tokenIn!==paid.tokenIn || edge.tokenOut!==paid.tokenOut) {
        edges.set(call.path,null);
        continue;
      }
      edge.boundAssets=true;
      edge.amountPayerInRaw=paid.amountPayerInRaw;
      edge.amountReceivedOutRaw=paid.amountReceivedOutRaw;
      edge.receiptIndices=mergeReceiptIndices(edge.receiptIndices,paid.receiptIndices);
    }
    if (edge || paid) edges.set(call.path,edge || paid);
  }
  // Preserve a stronger receipt decision, including a contradictory or
  // ambiguous one. Caller flow only fills paths without an applicable proof.
  const remaining=candidates.filter(call=>!byCall.has(call));
  if (remaining.length) {
    for (const edge of callerReceiptEdges(remaining,timeline,transferReceipts,transferAnchors,nativeMoves))
      edges.set(edge.callPath,edge);
  }
  return edges;
}
