import {matchesActionSettlement} from './action-settlement-evidence.mjs';
import {receiptCallOwners, possibleReceiptOwners} from './receipt-call-owners.mjs';

const addressWord = w => /^0{24}[\da-f]{40}$/.test(w) ? '0x'+w.slice(24) : null;
const inside = (child,root) => root === '' || child === root || child.startsWith(root+',');
const signed = (x, sign) => sign ? x : -x;
function returnedSides(call,rule,forward) {
  if(rule?.mode!=='counterparty-net'||rule.amountSign!=='caller'||rule.returnBits!==128||
    !/^0x[\da-f]{64}$/.test(call.output)) return;
  const packed=BigInt(call.output), sides=[BigInt.asIntN(128,packed>>128n),BigInt.asIntN(128,packed)];
  if(forward ? sides[0]<0n && sides[1]>0n : sides[1]<0n && sides[0]>0n) return sides;
}

// Partition evidence by actual CALL ancestry, not tx-level totals, caller alone
// or chronological proximity. A venue/counterparty pair can settle repeatedly
// in the same callback. No movement/observation may belong to two actions.
export function partitionActionEvidence(actions, context, boundEvents=new Map()) {
  const chosen = new Set(actions), owners = new Map(), batches = new Map();
  const matched = new Set(context.movements.filter(m=>m.index!=null).map(m=>m.index)), receipts=new Map();
  const logByIndex = new Map(), relevantTopics = new Set(), byAccount=new Map(), ownerCache=new Map();
  const key=(asset,account,sign,amount)=>asset+'/'+account+'/'+sign+'/'+amount;
  for (const [log,m] of context.transferReceipts ?? []) {
    logByIndex.set(m.index,log); relevantTopics.add(log.topics[0]);
    for (const account of [m.to,m.from]) {
      const k=m.asset+'/'+account;
      if(!byAccount.has(k)) byAccount.set(k,[]);
      byAccount.get(k).push(m.index);
    }
    if (matched.has(m.index)) continue;
    for(const [account,sign] of [[m.to,'+'],[m.from,'-']]) {
      const k=key(m.asset,account,sign,m.amount);
      receipts.set(k,receipts.has(k)?null:m);
    }
  }
  const placements=context.logs && relevantTopics.size &&
    receiptCallOwners(context.paths.values(), context.logs, relevantTopics)?.withBindings(boundEvents);
  const ownersOf=index=>{
    if(!ownerCache.has(index)) {
      const range=placements?.get?.(logByIndex.get(index));
      ownerCache.set(index,range ? possibleReceiptOwners(range) : null);
    }
    return ownerCache.get(index);
  };
  const receiptBoundTo=(m,n,allowDescendants=false)=>{
    const possible=ownersOf(m.index);
    if (!possible) return false;
    return allowDescendants ? possible.size>0 && [...possible].every(o=>inside(o.path,n.path)) : possible.size===1 && possible.has(n);
  };
  // A token can emit further balance-changing receipts from the very same
  // transfer CALL without making an additional child CALL. Account for every
  // relevant receipt that could have occurred inside the candidate; a receipt
  // proven to be in a disjoint sibling is irrelevant.
  const coversReceipts=(root,assets,accounts,consumed)=>{
    for(const asset of assets) for(const account of accounts) {
      for(const index of byAccount.get(asset+'/'+account)??[]) {
        if(consumed.has(index)) continue;
        const possible=ownersOf(index);
        if(!possible?.size || [...possible].some(o=>inside(o.path,root.path))) return false;
      }
    }
    return true;
  };
  for (const n of context.paths.values()) {
    const owner = chosen.has(n) ? n : owners.get(n.parent);
    if (!owner) continue;
    owners.set(n, owner);
    if (chosen.has(n)) batches.set(n, {nodes:[], movements:[], nested:false,receiptBoundTo,coversReceipts,
      residualReceipt:(asset,account,delta)=>receipts.get(key(asset,account,delta>0n?'+':'-',delta>0n?delta:-delta))});
    batches.get(owner).nodes.push(n);
    if (chosen.has(n) && owners.has(n.parent)) {
      batches.get(n).nested = true;
      batches.get(owners.get(n.parent)).nested = true;
    }
  }
  for (const m of context.movements) {
    const owner = owners.get(m.node);
    if (owner) batches.get(owner).movements.push(m);
  }
  return batches;
}

// Use only actions with a declared packed, signed two-asset return. Sums and
// signs are BigInts all the way to the JSON row. For this mode physical flows
// at the manager vs its counterparty have the same signs as the caller return.
export function reconcileCounterpartyReturn(call, rule, assets, forward, batch, native) {
  if (!batch || batch.nested || rule?.mode!=='counterparty-net' || rule.returnBits!==128 ||
      rule.amountSign!=='caller' || !Number.isSafeInteger(rule.counterpartyArg) || rule.counterpartyArg<0 ||
      !/^0x[\da-f]{64}$/.test(call.output)) return;
  const pos=10+64*rule.counterpartyArg, party=addressWord(call.input.slice(pos,pos+64));
  if (!party || party===native || party===call.target || party===call.sender) return;
  const deltas=returnedSides(call,rule,forward);
  if (!deltas) return;
  const branches = batch.nodes.filter(n=>n.parent===call && n.valid && n.kind==='call' && n.target===party && n.sender===call.target);
  if (!branches.length) return;
  const venue=call.target, inParty = n => branches.some(b=>inside(n.path,b.path));
  const receiptIndices = new Set(), residualIndices=[], legs = [];
  for (const [i,asset] of assets.entries()) {
    const expected=deltas[i], keys=[];
    const seen=batch.movements.filter(m=>m.asset===asset && (m.from===venue||m.to===venue));
    let observed=0n;
    for (const m of seen) {
      const credit=m.to===venue;
      if ((credit?m.from:m.to)!==party || !inParty(m.node) || m.amount<=0n || (expected>0n)!==credit) return;
      observed+=signed(m.amount,credit);
      keys.push('movement:'+m.node.path);
      if (m.index!=null) {
        // Explicit ERC20 transfer calldata already names sender/recipient/amount;
        // independently rule out a receipt belonging to a DIFFERENT swap.
        if(!batch.receiptBoundTo(m,call,true)) return;
        receiptIndices.add(m.index);
      }
    }
    // For a nonstandard payment (e.g. issue directly to the account),
    // the venue's own reads bracket exactly one otherwise unattributed,
    // successful, counterparty-initiated call to THIS token. Never add a
    // balance change twice: the direct evidence inside that interval counts
    // toward the same balance change. Two competing payments are ambiguous.
    const reads=batch.nodes.filter(n=>n.target===asset && n.sender===venue && n.input?.slice(0,10)==='0x70a08231' &&
      addressWord(n.input.slice(10))===venue && n.kind==='staticcall' && n.ok && n.parent?.valid);
    if (reads.length) {
      if (reads.length!==2 || !reads.every(n=>inParty(n) && /^0x[\da-f]{64}$/.test(n.output))) return;
      const [start,end]=reads, actual=BigInt(end.output)-BigInt(start.output);
      if (actual!==expected || seen.some(m=>m.node.order<=start.order || m.node.order>=end.order)) return;
      if (observed!==actual) {
        const reserved=new Set(seen.map(m=>m.node));
        const options=batch.nodes.filter(n=>n.order>start.order && n.order<end.order && n.kind==='call' && n.valid &&
          n.target===asset && !reserved.has(n));
        const residual=actual-observed, receipt=batch.residualReceipt(asset,venue,residual);
        const counterparty=receipt && (residual>0n?receipt.from:receipt.to);
        if (options.length!==1 || options[0].sender!==party || !inParty(options[0]) ||
            (residual>0n)!==(expected>0n) || !receipt || !batch.receiptBoundTo(receipt,options[0]) ||
            (counterparty!==party && counterparty!==native)) return;
        keys.push('payment:'+options[0].path,'balance:'+start.path,'balance:'+end.path,'receipt:'+receipt.index);
        receiptIndices.add(receipt.index);
        residualIndices.push(receipt.index);
        observed=actual;
      }
    }
    if (observed!==expected) return;
    legs.push({asset,expected:expected<0n?-expected:expected,observed:observed<0n?-observed:observed,evidenceKeys:keys});
  }
  return matchesActionSettlement(legs) && batch.coversReceipts(call,assets,[venue],receiptIndices)
    ? {receiptIndices:[...receiptIndices],residualIndices} : undefined;
}

// Narrow group proof: a single declared callback, one pool/direction, consecutive
// disjoint actions with their own signed returns, then exactly one payment and
// one withdrawal. Independently balance BOTH gross totals. Unknown mutations,
// mid-group settlements and offsets are not explainable by this evidence.
export function reconcileDeferredGroup(members,rule,context) {
  if(!rule.batch || members.length<2) return;
  const {n:first,entry,proof}=members[0], cb=first.parent, actor=first.sender, venue=first.target;
  const {tokenIn,tokenOut,poolId}=proof, methods=rule.batch;
  if (!cb || !cb.valid || cb.kind!=='call' || cb.input.slice(0,10)!==methods.callback ||
      cb.parent!==entry || entry.sender!==actor || cb.sender!==venue || cb.target!==actor) return;
  const totals=[0n,0n], stepSet=new Set();
  for(const m of members){
    const {n,proof:p}=m, deltas=returnedSides(n,rule,p.roles[1]);
    if(!deltas || n.parent!==cb || n.target!==venue || n.sender!==actor || m.entry!==entry ||
        p.poolId!==poolId || p.tokenIn!==tokenIn || p.tokenOut!==tokenOut) return;
    totals[0]-=deltas[p.roles[1]?0:1];totals[1]+=deltas[p.roles[1]?1:0];stepSet.add(n);
  }
  const nodes=[...context.paths.values()].filter(n=>inside(n.path,entry.path));
  const mutable=nodes.filter(n=>n.valid && n.kind!=='staticcall' && n!==entry);
  if(mutable.some(n=>n.parent===entry && n!==cb)) return;
  const top=mutable.filter(n=>n.parent===cb), payments=top.filter(n=>n.kind==='call' && n.target===venue &&
      n.input===methods.pay && n.sender===actor), takes=top.filter(n=>n.kind==='call' && n.target===venue &&
      n.input.slice(0,10)===methods.take && n.sender===actor);
  if(payments.length!==1 || takes.length!==1) return;
  const payment=payments[0], take=takes[0], last=members.at(-1).n.order;
  if(take.order<=last || payment.order<=last || !/^0x[\da-f]{200}$/.test(take.input) ||
     addressWord(take.input.slice(10,74))!==tokenOut || addressWord(take.input.slice(74,138))!==actor ||
     BigInt('0x'+take.input.slice(138,202))!==totals[1]) return;
  const scope=context.movements.filter(m=>inside(m.node.path,entry.path));
  const cash=scope.filter(m=>m.from===actor || m.to===actor);
  const ins=cash.filter(m=>m.asset===tokenIn && m.from===actor && m.to===venue && m.amount===totals[0]);
  const outs=cash.filter(m=>m.asset===tokenOut && m.from===venue && m.to===actor && m.amount===totals[1]);
  if(cash.length!==2 || ins.length!==1 || outs.length!==1) return;
  const [inflow]=ins,[outflow]=outs;
  if(tokenIn===context.native ? inflow.node!==payment :
     (!Number.isSafeInteger(inflow.index) || inflow.node.parent!==cb || inflow.node.order<=last || inflow.node.order>=payment.order)) return;
  if(outflow.node.parent!==take || (tokenOut!==context.native && !Number.isSafeInteger(outflow.index))) return;
  const directionMoves=[inflow,outflow];
  if(directionMoves.some(m=>m.index!=null && !members[0].batch.receiptBoundTo(m,m.node))) return;
  // No third-party actions or unaccounted consumes of the callback's balance.
  const allowed=new Set([cb,payment,take,inflow.node,outflow.node,...stepSet]);
  for(const n of mutable){
    if(allowed.has(n)) continue;
    // Swap-owned hook frames may consult state; an unaccounted mutation could
    // change the shared ledger, so this bounded group intentionally rejects it.
    if(stepSet.has(n.parent) && n.kind==='call' && n.sender===venue &&
       n.target===addressWord(n.parent.input.slice(10+64*rule.counterpartyArg,74+64*rule.counterpartyArg)) &&
       BigInt(n.value??'0')===0n) continue;
    return;
  }
  if(!matchesActionSettlement([
    {asset:tokenIn,expected:totals[0],observed:inflow.amount,evidenceKeys:['movement:'+inflow.node.path]},
    {asset:tokenOut,expected:totals[1],observed:outflow.amount,evidenceKeys:['movement:'+outflow.node.path]},
  ])) return;
  const indices=new Set([inflow.index,outflow.index].filter(Number.isSafeInteger));
  return members[0].batch.coversReceipts(entry,[tokenIn,tokenOut],[venue,actor],indices)
    ? {receiptIndices:[...indices]} : undefined;
}
