// Independent, offline diagnostic. Entry declarations own the ABI; this proof
// admits only one conversion settled across one direct custody callback.
import {createRequire} from 'node:module';
import rules from './keyed-rules.json' with {type:'json'};
const {Interface,AbiCoder,id,keccak256}=createRequire(new URL('../../../listener/package.json',import.meta.url))('ethers');
const abi=AbiCoder.defaultAbiCoder(), zero='0x'+'0'.repeat(40), norm=x=>typeof x==='string'?x.toLowerCase():null;
const mk=s=>{const i=new Interface(['function '+s]),f=i.fragments[0];return {i,f,s:f.selector};};
const cfg=rules.entries.map(r=>({...r,ev:id(r.event),...Object.fromEntries(['entry','callback','action','sync','pay','take'].map(k=>[k,mk(r[k])]))}));
const erc=rules.paymentMethods.map(mk),transfer=id(rules.transferEvent);
const s=n=>n?.input?.slice(0,10),inside=(p,root)=>p!=null&&(root===''||p===root||p.startsWith(root+','));
const wordAddr=t=>/^0x0{24}[0-9a-f]{40}$/.test(t)?'0x'+t.slice(-40):null;
const dataWord=x=>/^0x[0-9a-f]{64}$/.test(x)?BigInt(x):null;
const paths=(l)=>l.candidatePaths??[];
function decode(n,method) {
  if(s(n)!==method.s)return null;
  try{const args=method.i.decodeFunctionData(method.f,n.input);if(norm(method.i.encodeFunctionData(method.f,args))!==n.input)return null;return args;}
  catch{return null;}
}
// For an observed, successful call with exactly one bytes argument, EVM calldata can
// end at the declared payload. The missing zero-padding is not part of the argument.
// Keep the execution/settlement decoder exact; this reader cannot admit a priced leg.
function observedBytes(n,method) {
  if(s(n)!==method.s||method.f.inputs.length!==1||method.f.inputs[0].type!=='bytes')return null;
  const body=n.input.slice(10);
  if(body.length<128||!(/^(?:[a-f0-9]{2})+$/.test(body))||BigInt('0x'+body.slice(0,64))!==32n)return null;
  const declared=BigInt('0x'+body.slice(64,128)),tail=body.slice(128),bytes=BigInt(tail.length/2);
  if(bytes<declared||bytes>((declared+31n)/32n)*32n)return null;
  const end=Number(declared)*2;if(!/^0*$/.test(tail.slice(end)))return null;
  return '0x'+tail.slice(0,end);
}
function eventData(l,r) {
  if(l.topics.length!==3 || !wordAddr(l.topics[2]))return null;
  try{const vals=abi.decode(r.dataTypes,l.data);return norm(abi.encode(r.dataTypes,vals))===l.data?vals:null;}catch{return null;}
}
function currencyMove(l){
  if(l.topics.length!==3)return null;const from=wordAddr(l.topics[1]),to=wordAddr(l.topics[2]),amt=dataWord(l.data);
  return from&&to&&amt!==null?{from,to,amt}:null;
}
function actionId(n,r) {
  const a=decode(n,r.action);if(!a)return null;
  const key=a[r.keySlot],poolId=keccak256(abi.encode([r.action.f.inputs[r.keySlot]],[key])), currencies=r.currencySlots.map(i=>norm(key[i]));
  if(!currencies.every(Boolean)||currencies[0]>=currencies[1])return null;
  const w=dataWord(n.output);if(w==null)return {poolId,currencies};
  const b=BigInt(r.signedHalfBits),d=[BigInt.asIntN(Number(b),w>>b),BigInt.asIntN(Number(b),w)];
  const input=d[0]<0n?0:1,output=1-input;
  if(d[input]>=0n||d[output]<=0n || a[r.directionSlot[0]][r.directionSlot[1]] !== (input===0))return {poolId,currencies};
  return {poolId,currencies,d,tokenIn:currencies[input],tokenOut:currencies[output],amountInRaw:String(-d[input]),amountOutRaw:String(d[output])};
}
// Identify a committed *pool action* separately from settlement. This cannot publish a
// priced or settled leg, nor does it claim to know which physical frame emitted a log.
export function observeKeyedActions(tree,{enabledSelectors}={}){
  const enabled=new Set(enabledSelectors),nodes=tree.nodes.filter(n=>n.committed&&!n.staticContext&&n.kind==='call');
  const by=new Map(tree.nodes.map(n=>[n.path,n])),result=[];
  for(const r of cfg){
    if(!enabled.has(r.entry.s))continue;
    // A nested manager entry is always an ownership boundary, even if not decodable.
    const entries=new Map(nodes.filter(n=>n.to===r.manager&&s(n)===r.entry.s).map(n=>[n.path,n]));
    const actions=nodes.filter(n=>s(n)===r.action.s&&n.to===r.manager);
    const claims=[];
    for(const n of actions){
      const ancestors=[];let up=by.get(n.parent);
      while(up&&!entries.has(up.path)){ancestors.push(up);up=by.get(up.parent);}
      const cb=ancestors.pop(),actor=up?.from;
      if(!up||!cb||cb.kind!=='call'||cb.from!==r.manager||cb.to!==actor||n.from!==actor)continue;
      const input=observedBytes(up,r.entry);if(input===null||observedBytes(cb,r.callback)!==input)continue;
      // Same-custody self calls and delegate frames can dispatch the inner action.
      // Never cross a third-party venue/callback merely because the action is a descendant.
      if(ancestors.some(x=>!x.committed||x.staticContext||x.contextAddress!==actor||
        !(x.kind==='delegatecall'||(x.kind==='call'&&x.from===actor&&x.to===actor))))continue;
      const f=actionId(n,r);if(!f?.amountInRaw)continue;
      const fits=tree.logs.filter(l=>{
        if(l.emitter!==r.manager||l.topics[0]!==r.ev||l.topics[1]!==f.poolId||wordAddr(l.topics[2])!==n.from)return false;
        if(!paths(l).some(p=>by.get(p)?.logicalOwnerPath===n.path))return false;
        const v=eventData(l,r);return v&&v[0]===f.d[0]&&v[1]===f.d[1];
      });
      claims.push({n,entry:up,f,fits});
    }
    const used=new Map();for(const {fits} of claims)for(const l of fits)used.set(l.idx,(used.get(l.idx)??0)+1);
    for(const {n,entry,f,fits} of claims){
      if(fits.length!==1||used.get(fits[0].idx)!==1)continue;
      const l=fits[0];result.push({role:'observed-conversion-not-settlement',selector:r.entry.s,actionSelector:r.action.s,entryPath:entry.path,path:n.path,poolAddress:r.manager,poolId:f.poolId,tokenIn:f.tokenIn,tokenOut:f.tokenOut,amountInRaw:f.amountInRaw,amountOutRaw:f.amountOutRaw,receiptIndex:l.idx,physicalLogOwnership:l.ownership,txHash:tree.txHash});
    }
  }return result;
}
export function extractPoolActions(tree,{enabledSelectors}={}){
  if(!enabledSelectors||typeof enabledSelectors==='string'||!enabledSelectors[Symbol.iterator])throw Error('enabledSelectors required');
  const enabled=new Set([...enabledSelectors].map(norm)),by=new Map(tree.nodes.map(n=>[n.path,n])),edges=[],unresolved=[];
  const active=n=>n.committed===true&&!n.staticContext, mutable=n=>active(n)&&n.kind==='call';
  const matchOwner=(l,n)=>paths(l).length>0&&paths(l).every(p=>by.get(p)?.logicalOwnerPath===n.path);
  const maybe=(l,n)=>!paths(l).length||paths(l).some(p=>inside(p,n.path));
  const definitely=(l,n)=>paths(l).length&&paths(l).every(p=>inside(p,n.path));
  const nativeMoves=n=>active(n)&&['call','create','create2','selfdestruct'].includes(n.kind)&&BigInt(n.value)>0n;
  for(const r of cfg)for(const entry of tree.nodes){
    if(!enabled.has(r.entry.s)||!mutable(entry)||s(entry)!==r.entry.s||entry.to!==r.manager)continue;
    const manager=entry.to,actor=entry.from,scope=tree.nodes.filter(n=>active(n)&&inside(n.path,entry.path));
    const actions=scope.filter(n=>mutable(n)&&n.to===manager&&s(n)===r.action.s);
    const gap=(n,f,reason)=>unresolved.push({path:entry.path,selector:r.entry.s,actionPath:n?.path??null,actionSelector:n?s(n):null,
      poolAddress:manager,poolId:f?.poolId??null,currencies:f?.currencies??null,tokenIn:f?.tokenIn??null,tokenOut:f?.tokenOut??null,
      amountInRaw:f?.amountInRaw??null,amountOutRaw:f?.amountOutRaw??null,reason});
    if(!actions.length){gap(null,null,'no-committed-conversion-at-entry-manager');continue;}
    const facts=actions.map(n=>actionId(n,r));
    if(actions.length!==1){actions.forEach((a,i)=>gap(a,facts[i],'multiple-conversions-share-entry-settlement'));continue;}
    const n=actions[0],f=facts[0],reject=x=>gap(n,f,x);
    if(!f?.amountInRaw){reject('incomplete-pool-key-or-opposite-signed-return');continue;}
    const ins=decode(entry,r.entry), cbs=scope.filter(x=>x.parent===entry.path&&mutable(x));
    const cb=cbs[0];
    if(!ins||!cb||cbs.length!==1||cb.from!==manager||cb.to!==actor||!decode(cb,r.callback)||
      decode(cb,r.callback)[0]!==ins[0] || n.parent!==cb.path ||n.from!==actor){reject('conversion-not-bound-to-entry-callback');continue;}
    const calls=scope.filter(x=>x!==entry&&mutable(x)&&x.to===manager);
    if(calls.some(x=>x.parent!==cb.path||x.from!==actor||![r.action.s,r.sync.s,r.pay.s,r.take.s].includes(s(x)))){
      reject('unmodelled-manager-mutation-in-entry');continue;}
    const events=tree.logs.filter(l=>l.emitter===manager&&l.topics[0]===r.ev&&maybe(l,entry));
    if(events.length!==1||!matchOwner(events[0],n)||events[0].topics[1]!==f.poolId||wordAddr(events[0].topics[2])!==actor){
      reject('missing-or-ambiguous-pool-event-for-action');continue;}
    const ev=eventData(events[0],r);
    if(!ev||!((ev[0]===0n&&ev[1]===0n)||(ev[0]===f.d[0]&&ev[1]===f.d[1]))){reject('pool-event-contradicts-return');continue;}
    const which=m=>calls.filter(x=>s(x)===m.s);
    const pays=which(r.pay),takes=which(r.take),syncs=which(r.sync);
    const pay=pays[0],take=takes[0],sync=syncs[0],inAmt=BigInt(f.amountInRaw),outAmt=BigInt(f.amountOutRaw);
    const takeArgs=take&&decode(take,r.take);
    if(pays.length!==1||!decode(pay,r.pay)||dataWord(pay.output)!==inAmt||
       takes.length!==1||!takeArgs||norm(takeArgs[0])!==f.tokenOut||norm(takeArgs[1])!==actor||takeArgs[2]!==outAmt||take.output!=='0x'){
      reject('missing-or-conflicting-settlement-obligations');continue;}
    const native=f.tokenIn===zero;
    if(native?syncs.length!==0:(syncs.length!==1||norm(decode(sync,r.sync)?.[0])!==f.tokenIn||sync.output!=='0x')){
      reject('input-token-not-bound-to-settlement');continue;}
    const eth=scope.filter(x=>nativeMoves(x)&&(x.from===manager||x.to===manager||x.from===actor||x.to===actor));
    const witnesses=[n.path,pay.path,take.path],logs=[events[0].idx];
    let ok=true;
    for(const [asset,from,to,amt,isInput] of [[f.tokenIn,actor,manager,inAmt,true],[f.tokenOut,manager,actor,outAmt,false]]){
      if(asset===zero){
        const xs=eth.filter(x=>x.from===from&&x.to===to&&BigInt(x.value)===amt&&mutable(x)&&(isInput?x===pay:x.parent===take.path&&x.input==='0x'));
        if(eth.length!==1||xs.length!==1){ok=false;break;}
        witnesses.push(xs[0].path);continue;
      }
      // Scope every custody/counterparty receipt, including deductions that were
      // not represented by a separate transfer() frame. Uncertain ownership is
      // not permission to assign a transaction-global amount to this action.
      const receipts=tree.logs.filter(l=>{
        if(l.emitter!==asset||l.topics[0]!==transfer||!maybe(l,entry))return false;
        const m=currencyMove(l);return !m||[m.from,m.to].some(a=>a===manager||a===actor);
      });
      const payments=scope.filter(x=>mutable(x)&&x.to===asset&&erc.some(m=>s(x)===m.s)).flatMap(x=>{
        const m=erc.find(m=>s(x)===m.s),a=decode(x,m);if(!a)return [{x,invalid:true}];
        const [u,v,amount]=a.length===2?[x.from,norm(a[0]),a[1]]:[norm(a[0]),norm(a[1]),a[2]];
        return [u,v].some(b=>b===manager||b===actor)?[{x,u,v,amount}]:[];
      });
      if(receipts.length!==1||payments.length!==1||!definitely(receipts[0],entry)){ok=false;break;}
      const l=receipts[0],m=currencyMove(l),p=payments[0];
      if(!m||p.invalid||p.u!==from||m.from!==from||p.v!==to||m.to!==to||p.amount!==amt||m.amt!==amt||!matchOwner(l,p.x)||
        !(p.x.output==='0x'||dataWord(p.x.output)===1n)||p.x.parent!==(isInput?cb.path:take.path)){ok=false;break;}
      if(isInput&&!(scope.indexOf(sync)<scope.indexOf(p.x)&&scope.indexOf(p.x)<scope.indexOf(pay))){ok=false;break;}
      logs.push(l.idx);witnesses.push(p.x.path);
    }
    if(!ok||(f.tokenIn!==zero&&f.tokenOut!==zero&&eth.length)||BigInt(pay.value)!==(native?inAmt:0n)){
      reject('both-settlement-sides-not-uniquely-reconciled');continue;}
    edges.push({selector:r.entry.s,path:entry.path,actionPath:n.path,actionSelector:r.action.s,poolAddress:manager,poolId:f.poolId,
      tokenIn:f.tokenIn,tokenOut:f.tokenOut,amountInRaw:f.amountInRaw,amountOutRaw:f.amountOutRaw,
      evidenceCallPaths:[...new Set(witnesses)],evidenceLogIndices:logs});
  }return {edges,unresolved};
}
