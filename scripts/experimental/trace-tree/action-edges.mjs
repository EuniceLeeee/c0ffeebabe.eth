// Parallel evidence experiment. The caller supplies only transaction facts and selector permissions.
import rules from './action-rules.json' with { type: 'json' };
import {assessEconomicAction} from './action-economic.mjs';

const ZERO = '0x' + '0'.repeat(40);
const address = x => typeof x === 'string' && /^0x[0-9a-f]{40}$/i.test(x) ? x.toLowerCase() : null;
const wordAddr = w => typeof w === 'string' && /^0{24}[a-f0-9]{40}$/i.test(w) ? '0x'+w.slice(24).toLowerCase() : null;
const wordUint = w => typeof w === 'string' && /^[a-f\d]{64}$/i.test(w) ? BigInt('0x'+w) : null;
const selector = x => x?.input?.slice(0,10).toLowerCase();
const list = (s,head,n) => typeof s==='string' && s.length===head+n*64 && /^0x[a-f\d]*$/i.test(s) ? (s.slice(head).match(/.{64}/g)??[]) : null;
const kind = n => n?.kind?.toLowerCase();
const evOnly = new Set(rules.evidenceOnly);
const isLogIndex = n => Number.isSafeInteger(n) && n>=0;
function readAddress(k,ctx) {
  if(k==='zero') return ZERO;
  const a=k==='caller'?address(ctx.n.from):k==='pool'?ctx.pool:wordAddr(ctx.args[+k.slice(3)]);
  return a!==ZERO?a:null;
}
function readAmount(k,ctx) {return wordUint(k==='ret0'?ctx.ret[0]:ctx.args[+k.slice(3)]);}

export function extractEdges(tree,{enabledSelectors}={}) {
  if(!enabledSelectors || typeof enabledSelectors==='string' || !enabledSelectors[Symbol.iterator])
    throw Error('enabledSelectors must be an explicit selector iterable');
  const enabled=new Set(Array.from(enabledSelectors,s=>String(s).toLowerCase()));
  const by=new Map(), logs=tree.logs, nodes=tree.nodes, seenLogs=new Set();
  for(const n of nodes){if(by.has(n.path))throw Error('duplicate frame path');by.set(n.path,n);}
  for(const l of logs){if(!isLogIndex(l.idx)||seenLogs.has(l.idx))throw Error('invalid or duplicate receipt index');seenLogs.add(l.idx);}
  // Never traverse out of a reverted subtree, even when its child itself returned successfully.
  const committed=new Map(), visiting=new Set();
  function ok(n) {
    if(!n)return false;
    if(committed.has(n))return committed.get(n);
    if(visiting.has(n))throw Error('cyclic call graph');
    visiting.add(n);
    const result=n.committed===true && (n.parent==null || ok(by.get(n.parent)));
    visiting.delete(n); committed.set(n,result);return result;
  }
  function logical(n){while(n && (kind(n)==='delegatecall'||kind(n)==='callcode'))n=by.get(n.parent);return n;}
  const barrier=n=>kind(n)==='call' && !evOnly.has(selector(n)) && (rules.actions[selector(n)] || enabled.has(selector(n)));
  const nearest=new Map();
  function scope(n){if(!n)return null;if(nearest.has(n))return nearest.get(n);const r=barrier(n)?n:scope(by.get(n.parent));nearest.set(n,r);return r;}
  function owners(l){
    const paths=['unique','traced'].includes(l.ownership) && l.ownerPath!=null ? [l.ownerPath] :
      l.ownership==='ambiguous' && Array.isArray(l.candidatePaths)?l.candidatePaths:[];
    return paths.length ? [...new Set(paths.map(p=>by.get(p)))]:[];
  }
  const facts=logs.map(l=>{
    const ps=owners(l), topic=l.topics?.[0]?.toLowerCase(), emitter=address(l.emitter);
    const possible=ps.map(n=>n && ok(n) && address(n.contextAddress)===emitter ? logical(n) : null);
    let tx=null;
    if(topic===rules.transfer.topic && l.topics.length===3){
      const d=list(l.data,2,1),from=wordAddr(l.topics[1]?.slice(2)),to=wordAddr(l.topics[2]?.slice(2));
      if(d && from && to && emitter) tx={token:emitter,from,to,amount:wordUint(d[0])};
    }
    return {l,topic,emitter,possible,tx};
  });
  function could(f,n){return !f.possible.length || f.possible.some(p=>!p||scope(p)===n);}
  function own(f,n){return f.possible.length>0 && f.possible.every(p=>p===n);}
  function inside(f,n){return f.possible.length>0 && f.possible.every(p=>p && scope(p)===n);}
  function typed(f,t){
      const s=rules.transfer.methods[selector(t)], args=s && list(t.input,10,s.size), p=address(t.contextAddress);
      if(!args || kind(t)!=='call' || p!==f.tx.token)return false;
      // No-return ERC-20s still need an exact attributed Transfer. Never override an
      // explicit false or malformed ERC-20 boolean with an apparently matching log.
      if(t.output!=null && t.output!=='0x' && wordUint(list(t.output,2,1)?.[0])!==1n)return false;
      const ctx={n:t,args,pool:p,ret:[]};
      return readAddress(s.from,ctx)===f.tx.from && readAddress(s.to,ctx)===f.tx.to && readAmount(s.amount,ctx)===f.tx.amount;
  }
  function typedTransfer(f,n){
    return inside(f,n) && f.possible.every(t=>typed(f,t));
  }
  function proof(n,rule){
    if(rule.identity!=='address')return {reason:'logical-pool-id-unproven'};
    const pool=address(n.contextAddress),args=list(n.input,10,rule.calldataWords),ret=list(n.output,2,1);
    if(!pool || pool===ZERO || pool!==address(n.to) || !args||!ret)return {reason:'invalid-action-input-or-return'};
    const ctx={n,pool,args,ret},schema=rules.events[rule.event],parties=schema.parties.map(k=>readAddress(k,ctx)),amounts=rule.amounts.map(k=>readAmount(k,ctx));
    if(parties.some(x=>!x) || amounts.some(x=>x==null||x<=0n))return {reason:'invalid-action-parties-or-amounts'};
    const candidates=facts.filter(f=>f.emitter===pool&&f.topic===schema.topic&&could(f,n));
    // Exactly one conversion event, directly emitted by the subject call (including its delegates).
    const admitted=candidates.filter(f=>own(f,n));
    if(candidates.length!==1||admitted.length!==1)return {reason:candidates.length?'ambiguous-action-event':'missing-action-event'};
    const event=admitted[0],ws=list(event.l.data,2,amounts.length);
    if(!ws||ws.some((w,i)=>wordUint(w)!==amounts[i]) || event.l.topics.length!==parties.length+1 ||
      parties.some((p,i)=>wordAddr(event.l.topics[i+1]?.slice(2))!==p))return {reason:'action-event-disagrees-with-calldata-or-return'};
    const side=[];
    for(const [i,s] of schema.directions.entries()){
      const amount=amounts[s.amountIndex],from=readAddress(s.from,ctx),to=readAddress(s.to,ctx);
      if(!from||!to||from===to)return {reason:'invalid-settlement-endpoints'};
      const candidates=facts.filter(f=>f.tx && f.tx.token!==ZERO && could(f,n) && (s.token==='pool'?f.tx.token===pool:f.tx.token!==pool) && f.tx.from===from && f.tx.to===to);
      if(candidates.length!==1)return {reason:(candidates.length?'ambiguous':'missing')+'-side-'+i};
      const f=candidates[0];
      if(f.tx.amount!==amount || !(s.anchor==='action'?own(f,n):typedTransfer(f,n)))return {reason:'unproven-settlement-side-'+i};
      side.push(f);
    }
    if(side[0].tx.token===side[1].tx.token)return {reason:'same-asset'};
    const indices=new Set([event.l.idx,...side.map(f=>f.l.idx)]);
    if(indices.size!==3)return {reason:'receipt-reused'};
    // Unknown deductions, rebates or secondary flows may change the actual amount received.
    for(const f of facts){
      if(f.topic!==rules.transfer.topic || indices.has(f.l.idx)|| !could(f,n))continue;
      for(const [j,s] of side.entries()){
        if(f.emitter!==s.tx.token)continue;
        if(!f.tx)return {reason:'extra-or-ambiguous-settlement'};
        const account=j===0?s.tx.from:s.tx.to, touches=(who)=>who!==ZERO && [f.tx.from,f.tx.to].includes(who);
        // User-side payment/receipts must remain exact. Escrow is allowed to forward
        // currency to its strategy, but only on a separately proven subordinate transfer.
        if(touches(account) || ([s.tx.from,s.tx.to].some(touches) && !typedTransfer(f,n)))return {reason:'extra-or-ambiguous-settlement'};
      }
    }
    const evidenceCallPaths=[];
    for(const [i,s] of schema.directions.entries())if(s.anchor==='transferCall'){
      const ps=new Set(side[i].possible.map(x=>x.path));
      if(ps.size!==1)return {reason:'ambiguous-payment-frame'};
      evidenceCallPaths.push(...ps);
    }
    return {candidate:{selector:selector(n),poolAddress:pool,poolId:null,tokenIn:side[0].tx.token,tokenOut:side[1].tx.token,
      amountInRaw:String(side[0].tx.amount),amountOutRaw:String(side[1].tx.amount),path:n.path,evidenceLogIndices:[...indices],evidenceCallPaths}};
  }
  const unresolved=[],proposals=[],observedActions=[];
  for(const n of nodes){
    const sel=selector(n);
    if(!ok(n)||kind(n)!=='call'||!enabled.has(sel))continue;
    const rule=rules.actions[sel];let out=rule?proof(n,rule):{reason:evOnly.has(sel)?'evidence-only-selector':'selector-semantics-not-modelled'};
    if(rule&&['ambiguous-action-event','unproven-settlement-side-0','unproven-settlement-side-1','ambiguous-payment-frame'].includes(out.reason)){
      const alternative=assessEconomicAction(n,rule,{nodes,facts,by,ok,logical,scope,rules,zero:ZERO,sel:selector,addr:address,
        waddr:wordAddr,uint:wordUint,list,readAddress,readAmount,typed,own,inside});
      if(alternative)out=alternative;
    }
    if(out.candidate)proposals.push(out.candidate);
    else {
      if(out.observedAction)observedActions.push(out.observedAction);
      unresolved.push({path:n.path,selector:sel,reason:out.reason,...(out.observedAction?{observedAction:out.observedAction}:{})});
    }
  }
  const ids=r=>[...r.evidenceLogIndices.map(i=>'log:'+i),...r.evidenceCallPaths.map(p=>'call:'+p)];
  const used=new Map();for(const r of proposals)for(const id of ids(r))used.set(id,(used.get(id)??0)+1);
  const edges=[];
  for(const r of proposals){
    if(ids(r).some(i=>used.get(i)!==1))unresolved.push({path:r.path,selector:r.selector,reason:'competing-for-settlement'});
    else edges.push(r);
  }
  return {edges,unresolved,...(observedActions.length?{observedActions}:{})};
}
