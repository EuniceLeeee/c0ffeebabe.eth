import {matchesActionSettlement} from './action-settlement-evidence.mjs';
import {contradictedTransfer} from './contradicted-transfer.mjs';

const uint = word => /^[0-9a-f]{64}$/.test(word??'') ? BigInt('0x'+word) : null;
const address = word => /^0{24}[0-9a-f]{40}$/.test(word??'') ? '0x'+word.slice(24) : null;
const arg = (data,i) => data?.slice(10+64*i,74+64*i);
const inside = (p,scope) => scope==='' || p===scope || p.startsWith(scope+',');
const add = (map,k,v) => { if(!map.has(k)) map.set(k,[]); map.get(k).push(v); };

function transfer(n) {
  const s=n.input?.slice(0,10), pull=s==='0x23b872dd';
  if(!n.valid || n.kind!=='call' || (!pull && s!=='0xa9059cbb')||contradictedTransfer(n.output)) return;
  const from=pull?address(arg(n.input,0)):n.sender, to=address(arg(n.input,pull?1:0)), amount=uint(arg(n.input,pull?2:1));
  if(from && to && from!==to && amount>0n) return {node:n,asset:n.target,from,to,amount};
}

// One event and one action with the declared emitter/participants. Ambiguous
// repeated calls are not paired merely by ordering or by equal amounts.
function bind(call,rule,calls,events){
  const who=n=>address(arg(n.input,rule.recipientArg));
  const recipient=who(call);
  if(!recipient || calls.some(n=>n!==call && (inside(n.path,call.path) || inside(call.path,n.path)))) return;
  const competing=calls.filter(n=>n.sender===call.sender && who(n)===recipient);
  if(competing.length!==1) return;
  const matches=events.filter(e=>e.topics[0]===rule.topic
    && address(e.topics[rule.callerTopic]?.slice(2))===call.sender
    && address(e.topics[rule.recipientTopic]?.slice(2))===recipient);
  if(matches.length!==1) return;
  const event=matches[0], data=event.data;
  if(event.topics.length!==rule.topicCount || typeof data!=='string' || data.length!==2+64*rule.dataWords
    || !/^0x(?:[0-9a-f]{64})+$/.test(data)) return;
  const ds=rule.deltaWords.map(i=>uint(data.slice(2+64*i,66+64*i)));
  if(ds.length!==2||ds.includes(null)) return;
  const deltas=ds.map(u=>BigInt.asIntN(256,u)*BigInt(rule.sign??1));
  const input=deltas.find(a=>a>0n),out=deltas.find(a=>a<0n);
  if(!input||!out) return;
  return {event,recipient,expected:[input,-out]};
}

// Recover at most one missing receipt per action. A balance observation is
// about an asset AND a holder, not about every pool using the asset. Both
// endpoints must have a proved settlement; calldata alone is never enough.
export function balanceActionEdges(rules, paths, logsByEmitter, movements, transferReceipts, sharedPools, blocked) {
  if(!rules) return [];
  const candidates=new Map(); let missing=false;
  for(const n of paths.values())
    if(n.valid && n.kind==='call' && n.selector && rules[n.selector] && !sharedPools.has(n.target)){
      add(candidates,n.target,n);
      if(!blocked.has(n.path)) missing=true;
    }
  if(!missing) return [];
  // If the venue also executes an unknown mutable entry in this transaction,
  // receipt logs alone cannot exclude that frame as the actual event emitter.
  const uncertain=new Set();
  for(const n of paths.values())
    if(n.valid && n.kind==='call' && candidates.has(n.target) && !rules[n.selector]) uncertain.add(n.target);
  const byNode=new Map(), matchedReceipt=new Set();
  for(const m of movements){ if(m.index!=null){byNode.set(m.node,m);matchedReceipt.add(m.index);} }
  const unknownReceipt=new Set();
  for(const m of transferReceipts.values()) if(!matchedReceipt.has(m.index))
    for(const h of [m.from,m.to])unknownReceipt.add(m.asset+'/'+h);
  const results=[];
  for(const [venue,calls] of candidates){
    if(uncertain.has(venue)) continue;
    for(const call of calls) {
      if(blocked.has(call.path))continue;
      const rule=rules[call.selector], proof=bind(call,rule,calls,logsByEmitter.get(venue)??[]);
      if(!proof)continue;
      const {event,recipient,expected}=proof;
      const scope=[...paths.values()].filter(n=>inside(n.path,call.path));
      const items=scope.map(transfer).filter(Boolean);
      // Only the actual venue's own reads of a beneficiary count, not a
      // sibling's or callback's claimed balance. A proxy implementation's
      // DELEGATECALL is not a second token transfer or an independent venue.
      const reads=new Map();
      for(const n of scope) if(n.parent===call && n.sender===venue && n.kind==='staticcall'
           && n.ok && n.input?.slice(0,10)==='0x70a08231' && n.input.length===74){
        const holder=address(arg(n.input,0));
        if(holder && n.target) add(reads,n.target+'/'+holder,n);
      }
      const venueMoves=movements.filter(m=>inside(m.node.path,call.path)&&(m.from===venue||m.to===venue));
      const known=[venueMoves.filter(m=>m.to===venue),venueMoves.filter(m=>m.from===venue)];
      if(known[1].some(m=>m.to!==recipient))continue;
      const proposals=[];
      for(const side of [0,1]) {
        const opposite=1-side, holder=side===0?venue:recipient;
        const strong=known[opposite];
        if(!strong.length || strong.reduce((a,m)=>a+m.amount,0n)!==expected[opposite]
          || strong.some(m=>m.asset!==strong[0].asset) || unknownReceipt.has(strong[0].asset+'/'+venue)) continue;
        const weak=known[side];
        const outstanding=expected[side]-weak.reduce((a,m)=>a+m.amount,0n);
        if(outstanding<=0n)continue;
        const loose=items.filter(m=>!byNode.has(m.node) && (m.from===venue||m.to===venue));
        if(loose.length!==1)continue;
        const m=loose[0], id=m.asset+'/'+holder;
        if(m.to!==holder || (side===1 && m.from!==venue) || m.amount!==outstanding
          || m.asset===strong[0].asset || weak.some(k=>k.asset!==m.asset) || unknownReceipt.has(id)
          || unknownReceipt.has(m.asset+'/'+venue))continue;
        const pair=reads.get(id);
        if(pair?.length!==2 || !(pair[0].order<m.node.order && m.node.order<pair[1].order))continue;
        const balance=pair.map(n=>(/^0x[0-9a-f]{64}$/.test(n.output??'')?BigInt(n.output):null));
        if(balance.includes(null))continue;
        const interval=n=>n.order>pair[0].order&&n.order<pair[1].order;
        // Unrecognized state-changing calls to the asset within the interval
        // could mint/burn independently of the candidate payment.
        if(scope.some(n=>interval(n)&&n.valid&&n.kind==='call'&&n.target===m.asset&&!transfer(n)))continue;
        const changes=items.filter(k=>k.asset===m.asset&&interval(k.node)&&(k.to===holder||k.from===holder));
        if(changes.some(k=>k.node!==m.node && !byNode.has(k.node)))continue;
        const knownChange=changes.reduce((a,k)=>k.node===m.node?a:a+(k.to===holder?k.amount:-k.amount),0n);
        const residual=balance[1]-balance[0]-knownChange;
        if(residual!==outstanding)continue;
        const asset=[null,null];asset[side]=m.asset;asset[opposite]=strong[0].asset;
        const asKey=(move,i)=>[venue,i,move.node.path,move.asset].join('/');
        const checks=known.map((xs,i)=>({asset:asset[i],expected:expected[i],observed:xs.reduce((a,x)=>a+x.amount,0n)+(i===side?residual:0n),evidenceKeys:xs.map(x=>asKey(x,i))}));
        checks[side].evidenceKeys.push(asKey(m,side));
        if(matchesActionSettlement(checks))proposals.push({asset:[...asset], indices:[event.idx,...venueMoves.flatMap(x=>x.index==null?[]:[x.index])]});
      }
      if(proposals.length!==1)continue;
      const [{asset,indices}]=proposals;
      results.push({selector:call.selector,poolAddress:venue,poolId:null,tokenIn:asset[0],tokenOut:asset[1],
        evidence:'action-balance-settlement',callPath:call.path,selectorTarget:venue,innerSwapPath:null,
        venuePayments:true,settlementClaims:known.flatMap((moves,side)=>moves.map(m=>({side:side===0?'in':'out',asset:m.asset,...(m.index!=null?{logIndex:m.index}:{valuePath:m.node.path})}))),
        receiptIndices:[...new Set(indices)].sort((a,b)=>a-b).join(','),
        amountVenueInRaw:String(expected[0]),amountPoolOutRaw:String(expected[1]),amountReceivedOutRaw:String(expected[1])});
    }
  }
  return results;
}
