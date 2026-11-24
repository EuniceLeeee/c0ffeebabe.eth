import {receiptCallOwners, possibleReceiptOwners} from './receipt-call-owners.mjs';
import {matchingPaymentStream,receiptComponents} from './payment-stream.mjs';
import {callerReceiptEdges} from './caller-receipt-flows.mjs';
import {actionAssetIdentity,provedCounterMovement,confirmedPaymentOwner} from './action-asset-identity.mjs';

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

function project(call, rules, event, fields, snapshotLog, nodes, movements, identityContext) {
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
  const settled=[],identityIndices=[],inferred=[],claims=[];
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
    const cash=scoped.filter(m=>incoming ? (m.to===call.target || (payer && m.from===payer))
      : recipient ? m.to===recipient : m.from===call.target);
    const exact=cash.filter(m=>m.amount===qty);
    let identityOnly=false;
    if (source.startsWith('0x') && (!exact.length || (possible.size&&!exact.some(m=>possible.has(m.asset))))) {
      const proof=actionAssetIdentity(call,nodes,identityContext,{incoming,qty,payer,recipient});
      if(proof){
        if(possible.size&&!possible.has(proof.asset))return {assetIdentityConflict:true};
        identityOnly=!possible.has(proof.asset);
        if(identityOnly)claims.push({side:incoming?'in':'out',asset:proof.asset,logIndex:proof.creditIndex});
        possible.add(proof.asset);identityIndices.push(...proof.indices);
      }
    }
    if (!possible.size) boundAssets=false;
    // A declared asset (e.g. vault shares) is distinct from funds released for the same amount.
    // Infer an unknown currency only from a single scoped movement with the declared economic role.
    if (!possible.size && exact.length===1) {possible.add(exact[0].asset);inferred[i]=exact[0];}
    assets[i]=unique(possible);
    if (!assets[i]) return;
    const actual=cash.filter(m=>m.asset===assets[i] && (!incoming || !payer || m.from===payer));
    if (!identityOnly && actual.length===1) settled[i]=actual[0];
  }
  if(claims.length)for(const [i,m] of inferred.entries()){
    if(!m)continue;
    if(!provedCounterMovement(m,call,nodes,identityContext,{incoming:i===input,payer,recipient}))return;
    if(m.index!=null)claims.push({side:i===input?'in':'out',asset:m.asset,logIndex:m.index});
  }
  if (assets[0]===assets[1]) return;
  return {selector:call.selector,poolAddress:call.target,poolId:null,boundAssets,tokenIn:assets[input],tokenOut:assets[output],
    callPath:call.path,selectorTarget:call.target,innerSwapPath:null,evidence:'declared-action-receipt',
    ...(claims.length?{settlementClaims:claims,venuePayments:true}:boundAssets?{independentDirection:true}:{}),
    receiptIndices:[...new Set([event.idx,...identityIndices,...claims.map(c=>c.logIndex),...(snapshot.length ? [snapshotLog.idx] : []),...settled.flatMap(m=>m?.index==null?[]:[m.index])])].sort((a,b)=>a-b).join(','),
    amountVenueInRaw:String(deltas[input]),amountPoolOutRaw:String(-deltas[output]),
    amountReceivedOutRaw:recipient && settled[output] ? String(settled[output].amount) : null,
    amountPayerInRaw:payer && settled[input] ? String(settled[input].amount) : null};
}

// Two actual movements, in input/output order. An ambiguous movement counts as
// a competitor even when only one of its possible owners is inside this action.
function transferProof(call, rule, event, fields, transfers, rules, nodes, logs, transferTopic) {
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
  // A forwarder can be msg.sender while the event names the economic user.
  // This does not relax project()'s caller equality. For precedence over an
  // ancestor's wallet net, require the action's OWN unique event, both settled
  // sides, and all explicit calldata fields. A differing reported sender must
  // itself be an explicitly named address AND an observed payer/beneficiary.
  const equalities=Object.entries(rule.equals);
  const explicitParty=new Set();
  const matchesExplicit=call.valid && event && fields && equalities.every(([name,op])=>{
    if(op==='caller')return true;
    const v=fields[name];
    if(v!==operandValue(call,op,typeof v==='string'))return false;
    if(typeof v==='string' && v!==zero && (v===input.from||v===output.to))explicitParty.add(v);
    return true;
  });
  const verifiedEvent=matchesExplicit && equalities.every(([name,op])=>op!=='caller'||fields[name]===call.sender||explicitParty.has(fields[name]));
  // Decode the venue's own conversion, not an ancestor's wallet net. One
  // side is this venue's own mint/burn (including its delegate); the other
  // must touch the venue directly or be independently measured by the venue.
  const self=rule.transferProof.findIndex(s=>s.token==='self'), ext=1-self;
  let venueDirection=false;
  if(matchesExplicit && self!==-1 && rule.transferProof[ext].token==='external' &&
    settled[self].owners.size===1 && settled[self].owners.has(call)){
    const m=settled[ext],side=rule.transferProof[ext],incoming=ext===0;
    const direct=incoming?m.to===call.target:m.from===call.target;
    // A forwarder need not be the economic sender. Accept that difference
    // only if the event *declares this role on this side* and the actual
    // counterparty is the venue. A matching amount alone proves no role.
    const roles=equalities.every(([name,op])=>op!=='caller'||fields[name]===call.sender||
      (direct && (incoming?side.from:side.to)===name && fields[name]===(incoming?m.from:m.to)));
    const owner=roles&&confirmedPaymentOwner(m);
    venueDirection=!!owner && (direct || venueMeasuredSide(call,m,incoming,owner,nodes,logs,transferTopic));
    if(venueDirection){
      // The declaration, not a same-sized payment, owns currency identity.
      // In particular the caller/forwarder mismatch can bypass project().
      const getters=rule.assets.filter(s=>s.startsWith('0x'));
      if(getters.length!==1||!rule.assets.includes('self'))venueDirection=false;
      else if(nodes.some(n=>n.ok && n.parent?.valid && n.kind==='staticcall' &&
        n.target===call.target && n.input===getters[0] && belongsToAction(n,call,rules) &&
        addr(n.output?.slice(2))!==m.asset))return {assetIdentityConflict:true};
    }
  }
  return {selector:call.selector,poolAddress:call.target,poolId:null,tokenIn:input.asset,tokenOut:output.asset,
    callPath:call.path,selectorTarget:call.target,innerSwapPath:null,evidence:'declared-settlement-transfers',boundAssets:true,
    ...(verifiedEvent||venueDirection?{venuePayments:true}:{}), ...(venueDirection?{decodedVenueDirection:true}:{}),
    settlementClaims:[{side:'in',logIndex:input.index,asset:input.asset},{side:'out',logIndex:output.index,asset:output.asset}],
    receiptIndices:indices.sort((a,b)=>a-b).join(','),amountPayerInRaw:String(input.amount),amountReceivedOutRaw:String(output.amount),
    amountVenueInRaw:null,amountPoolOutRaw:null};
}

// Forward settlement can pay the beneficiary from a child venue. The child's
// transfer alone cannot identify the parent's asset. Require the parent itself
// to have checked the exact beneficiary balance before AND after that payment.
function venueMeasuredSide(call,m,incoming,owner,nodes,logs,transferTopic){
  const holder=incoming?m.from:m.to;
  if(!owner || owner.target!==m.asset || !inside(owner.path,call.path))return false;
  const q='0x70a08231'+'0'.repeat(24)+holder.slice(2);
  const reads=[];
  for(const n of nodes){
    if(n.kind!=='staticcall'||!n.ok||n.sender!==call.target||n.target!==m.asset||n.input!==q)continue;
    let ctx=n.parent;
    while(ctx?.valid && (ctx.kind==='delegatecall'||ctx.kind==='callcode'))ctx=ctx.parent;
    if(ctx===call)reads.push(n);
  }
  if(reads.length!==2 || reads[0].order>=owner.order || reads[1].order<=owner.order)return false;
  const [before,after]=reads.map(n=>uint(n.output?.slice(2)));
  if(before===undefined||after===undefined||after-before!==(incoming?-m.amount:m.amount))return false;
  return !logs.some(l=>l.idx!==m.index && l.emitter===m.asset && l.topics[0]===transferTopic &&
    l.topics.slice(1,3).some(t=>addr(t?.slice(2))===holder));
}

// When order alone leaves several calls, calldata may settle a whole stream:
// every plausible call must declare that event and explain exactly one log.
// Unknown entries, duplicate amounts or jointly impossible order give no hint.
function calldataBindings(groups, possibleOwners, rules) {
  const bindings = new Map();
  for (const events of groups.values()) {
    if (events.length<2 || !events.some(e=>possibleOwners.get(e).size>1)) continue;
    // A genuinely disjoint later invocation on the same address cannot
    // invalidate an earlier closed stream. Partition by *all* possible
    // owners, including unknown calls, before looking at decoded fields.
    const pieces=receiptComponents(events.map(e=>({e,owners:possibleOwners.get(e)})));
    for(const {items,owners} of pieces){
      const members=items.map(x=>x.e);
      if(members.length<2 || members.length!==owners.length||owners.some(n=>rules[n.selector]?.topic!==members[0].topics[0]))continue;
      const byCall=new Map();
      for(const e of members){
        const possible=possibleOwners.get(e),decoded=new Map();let match,ambiguous=false;
        // Unknown calls, callback dispatches, or malformed declared events
        // cannot be eliminated by a signature/amount mismatch alone.
        for(const c of possible){const rule=rules[c.selector];if(!decoded.has(rule))decoded.set(rule,decode(e,rule));
          const fs=decoded.get(rule);if(fs&&matchesFields(c,fs,rule.equals)){
            if(match){ambiguous=true;break;}match=c;
          }}
        if(ambiguous||!match||byCall.has(match))break;
        byCall.set(match,e);
      }
      if(byCall.size!==members.length)continue;
      for(const [c,e] of byCall)if(possibleOwners.get(e).size>1)bindings.set(e,c);
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
    topics.add(rule.topic);topics.add(transferTopic);
    if (rule.snapshot) topics.add(rule.snapshot.topic);
    if (rule.transferProof && uint(call.output?.slice(2))) {
      byCall.set(call,new Map());
      topics.add(transferTopic);
    }
  }
  if (candidates.length) topics.add(transferTopic);
  if (!topics.size || !logs.some(l=>topics.has(l.topics[0]))) return edges;
  let timeline = receiptCallOwners(nodes,logs,topics);
  if (!timeline) return edges;
  let possibleOwners, groups;
  function indexOwners() {
    possibleOwners=new Map();groups=new Map();
    for(const [event,placement] of timeline.placements){
      if(event.topics[0]===transferTopic)continue;
      possibleOwners.set(event,possibleReceiptOwners(placement));
      const k=event.emitter+'/'+event.topics[0];if(!groups.has(k))groups.set(k,[]);
      groups.get(k).push(event);
    }
  }
  const paymentHints=matchingPaymentStream(timeline,transferTopic);
  if(paymentHints.size)timeline=timeline.constrain(paymentHints)??timeline;
  indexOwners();
  const hints=calldataBindings(groups,possibleOwners,rules);
  if(hints.size){
    const constrained=timeline.constrain(hints);
    if(constrained){timeline=constrained;indexOwners();}
  }
  const transfers=[];
  const provenTransferAnchors=new Map();
  for (const [event,placement] of timeline.placements) {
    if (event.topics[0]===transferTopic) {
      const possible=possibleReceiptOwners(placement),movement=transferReceipts.get(event);
      if (movement) transfers.push({...movement,owners:possible});
      // A unique amount in the transaction is not proof that an earlier or
      // later unknown call at this token address did not emit the receipt.
      const anchor=transferAnchors.get(event);
      if(anchor&&possible.size===1&&possible.has(anchor))provenTransferAnchors.set(event,anchor);
    }
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
      && project(call,rules,event,fields,owned.get(rule.snapshot?.topic),nodes,movements,
        {timeline,transferReceipts,transferAnchors:provenTransferAnchors,logs});
    if(edge?.assetIdentityConflict){edges.set(call.path,null);continue;}
    const paid = rule.transferProof && transferProof(call,rule,event,fields,transfers,rules,nodes,logs,transferTopic);
    if(paid?.assetIdentityConflict){edges.set(call.path,null);continue;}
    if (edge && paid) {
      if (edge.tokenIn!==paid.tokenIn || edge.tokenOut!==paid.tokenOut) {
        edges.set(call.path,null);
        continue;
      }
      edge.boundAssets=true;
      // This is the declared venue action, with its own matching economic
      // event AND both settled sides. The caller-only fallback has no such
      // claim on the same receipts.
      edge.venuePayments=true;
      if(paid.decodedVenueDirection)edge.decodedVenueDirection=true;
      edge.amountPayerInRaw=paid.amountPayerInRaw;
      edge.amountReceivedOutRaw=paid.amountReceivedOutRaw;
      edge.settlementClaims=paid.settlementClaims;
      edge.receiptIndices=mergeReceiptIndices(edge.receiptIndices,paid.receiptIndices);
    }
    if (edge || paid) edges.set(call.path,edge || paid);
  }
  // Preserve a stronger receipt decision, including a contradictory or
  // ambiguous one. Caller flow only fills paths without an applicable proof.
  const remaining=candidates.filter(call=>!byCall.has(call));
  if (remaining.length) {
    for (const edge of callerReceiptEdges(remaining,timeline,transferReceipts,provenTransferAnchors,nativeMoves))
      edges.set(edge.callPath,edge);
  }
  return edges;
}
