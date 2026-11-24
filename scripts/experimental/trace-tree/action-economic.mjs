// Evidence assembled at action scope. A currency movement can be proven without
// assigning an ambiguous receipt to a physical LOG instruction; never mutate owners.
export function assessEconomicAction(n,rule,H) {
  const {nodes,facts,by,ok,logical,scope,rules,zero,sel,addr,waddr,uint,list,readAddress,readAmount,typed,own,inside}=H;
  const err=reason=>({reason}),args=list(n.input,10,rule.calldataWords),ret=list(n.output,2,1),pool=addr(n.to),schema=rules.events[rule.event];
  if(!args||!ret||rule.identity!=='address'||pool!==addr(n.contextAddress)||!pool||pool===zero)return null;
  const ctx={n,pool,args,ret},amounts=rule.amounts.map(k=>readAmount(k,ctx)),parties=schema.parties.map(k=>readAddress(k,ctx));
  if(amounts.some(v=>v==null||v<=0n)||parties.some(v=>!v))return null;
  const unique=x=>[...new Set(x)],desc=(x,a)=>typeof x==='string'&&(x===a||a===''||x.startsWith(a+','));
  const order=new Map(nodes.map((v,i)=>[v,i]));
  const matchesEvent=f=>f.emitter===pool&&f.topic===schema.topic&&
    f.l.topics.length===parties.length+1&&parties.every((p,i)=>waddr(f.l.topics[i+1]?.slice(2))===p)&&
    (list(f.l.data,2,amounts.length)??[]).length===amounts.length&&list(f.l.data,2,amounts.length).every((w,i)=>uint(w)===amounts[i]);
  const witnessed=facts.filter(f=>matchesEvent(f)&&f.possible.includes(n));
  if(witnessed.length!==1)return null;
  const ev=witnessed[0];
  // No competing conversion at this custody address may also fit the observed event.
  const rivals=nodes.filter(t=>{
    if(t===n||!ok(t)||t.kind!=='call'||addr(t.to)!==pool)return false;
    const r=rules.actions[sel(t)];if(!r||rules.events[r.event]?.topic!==schema.topic)return false;
    const other={n:t,pool,args:list(t.input,10,r.calldataWords),ret:list(t.output,2,1)};
    return other.args&&other.ret&&r.amounts.every((k,i)=>readAmount(k,other)===amounts[i])&&rules.events[r.event].parties.every((k,i)=>readAddress(k,other)===parties[i]);
  });
  if(rivals.length)return err('competing-equivalent-conversions');
  const steps=[],records=[],callPaths=new Set(),issues=[],sideFacts=[];
  const snapshot=(token,account)=>nodes.flatMap(t=>{
    const a=sel(t)===rules.balanceRead.selector&&list(t.input,10,1),v=list(t.output,2,1);
    return ok(t)&&t.kind==='staticcall'&&addr(t.to)===token&&a&&waddr(a[0])===account&&v?[{t,v:uint(v[0])}]:[];
  });
  function bracket(reads,subject,expected,common,allowed){
    // Select nearest two reads, not whichever two happen to yield a desired delta.
    const S=order.get(subject),rs=reads.filter(({t})=>common(t)),pre=rs.filter(x=>order.get(x.t)<S).at(-1),post=rs.find(x=>order.get(x.t)>S);
    if(!pre||!post)return {proven:false,reason:'no-two-sided-balance',postOnly:post?.t.path??null};
    const start=order.get(pre.t),end=order.get(post.t);
    if(post.v-pre.v!==expected)return {proven:false,contradiction:true,reason:'balance-delta-contradicts-action'};
    if(nodes.slice(start+1,end).some(t=>ok(t)&&!t.staticContext&&t.kind!=='staticcall'&&!allowed(t)))return {proven:false,reason:'balance-window-has-other-mutable-call'};
    return {proven:true,pre:pre.t.path,post:post.t.path,before:String(pre.v),after:String(post.v)};
  }
  for(const [i,dir] of schema.directions.entries()){
    const from=readAddress(dir.from,ctx),to=readAddress(dir.to,ctx),amount=amounts[dir.amountIndex];
    const cash=facts.filter(f=>f.tx&&f.tx.token!==zero&&(dir.token==='pool'?f.tx.token===pool:f.tx.token!==pool)&&f.tx.from===from&&f.tx.to===to&&
      f.tx.amount===amount&&f.possible.some(x=>x&&scope(x)===n));
    if(cash.length!==1)return null;
    const f=cash[0],token=f.tx.token,account=i===0?from:to,net=i===0?-amount:amount;
    const logicalOwners=unique(f.possible.filter(Boolean).map(t=>t.path)), payments=unique(f.possible.filter(t=>t&&typed(f,t)));
    if(dir.anchor==='transferCall'&&(payments.length!==1||scope(payments[0])!==n))return null;
    if(dir.anchor==='action'&&!f.possible.includes(n))return null;
    const direct=dir.anchor==='action'?own(f,n):inside(f,n)&&logicalOwners.length===1;
    // A direct sibling before/after the conversion can measure the actual payer
    // (side 0) or beneficiary (side 1) regardless of physically ambiguous LOG.
    const accReads=snapshot(token,account);
    const external=bracket(accReads,n,net,t=>t.parent===n.parent,
      t=>desc(t.path,n.path)&&scope(t)===n);
    if(external.contradiction)return err(external.reason);
    let custody=null;
    if(payments.length===1){
      const p=payments[0];callPaths.add(p.path);
      const change=to===pool?amount:from===pool?-amount:null;
      if(change!==null&&logical(by.get(p.parent))===n){
        custody=bracket(snapshot(token,pool),p,change,t=>logical(by.get(t.parent))===n,
          t=>desc(t.path,p.path)&&scope(t)===n);
        if(custody.contradiction)return err(custody.reason);
      }
    }
    // A reserve-only increase corroborates the input; it does not prove how much
    // the payer actually lost in the presence of ambiguous fees or refunds.
    const proved=direct||external.proven;
    if(!proved)issues.push('side-'+i+':'+external.reason);
    if(external.proven){callPaths.add(external.pre);callPaths.add(external.post);}
    if(custody?.proven){callPaths.add(custody.pre);callPaths.add(custody.post);}
    sideFacts.push(f);
    steps.push({side:i,amount:String(amount),token,proved,direct,account,accountBalance:external,custodyBalance:custody,
      matchedPaymentPath:payments[0]?.path??null,receiptIndex:f.l.idx,logicalOwnerCandidates:logicalOwners});
  }
  if(steps[0].token===steps[1].token)return null;
  const indices=unique([ev.l.idx,...sideFacts.map(f=>f.l.idx)]);
  if(indices.length!==3)return null;
  for(const [i,s] of steps.entries()){
    for(const f of facts){
      if(f.emitter!==s.token||f.topic!==rules.transfer.topic||indices.includes(f.l.idx))continue;
      if(f.possible.length&&f.possible.every(p=>p&&scope(p)!==n))continue;
      if(f.tx&&f.tx.from!==s.account&&f.tx.to!==s.account)continue;
      // Don't suppress a contradictory or additional fee/rebate by matching the
      // original amount. A separate successful payment call may belong to the
      // preceding/following transaction step; overlap remains provisional.
      if(f.possible.length&&f.possible.every(p=>p&&scope(p)===n))return err('additional-economic-endpoint-flow');
      issues.push('side-'+i+':unseparated-other-account-flow:'+f.l.idx);
    }
  }
  for(const s of steps)for(const p of nodes){
    if(!ok(p)||p.kind!=='call'||scope(p)!==n||addr(p.to)!==s.token||p.path===s.matchedPaymentPath)continue;
    const method=rules.transfer.methods[sel(p)],a=method&&list(p.input,10,method.size);
    if(!method)continue;
    const c={n:p,args:a,pool:s.token,ret:[]};
    if(!a||[readAddress(method.from,c),readAddress(method.to,c)].includes(s.account))return err('additional-economic-endpoint-payment');
  }
  // This module describes alternatives after the ordinary proof has already
  // failed. An account delta cannot identify the counterparty for an ambiguous
  // transfer. Keep it diagnostic even when all the numeric observations agree.
  if(!issues.length)issues.push('receipt-to-action-attribution-remains-unproved');
  const evidence={eventIndex:ev.l.idx,eventPhysicalOwnership:ev.l.ownership,eventPhysicalCandidates:ev.l.candidatePaths,
    sides:steps,missingProof:unique(issues)};
  const base={path:n.path,selector:sel(n),poolAddress:pool,poolId:null,tokenIn:steps[0].token,tokenOut:steps[1].token,
    amountInRaw:steps[0].amount,amountOutRaw:steps[1].amount,evidenceLogIndices:indices,evidenceCallPaths:[...callPaths],
    evidenceMode:'action-economic',economicEvidence:evidence};
  return {reason:'observed-conversion-with-incomplete-settlement-proof',observedAction:{...base,tier:'provisional'}};
}
