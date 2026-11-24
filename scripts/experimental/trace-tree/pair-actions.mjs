// Isolated transaction-evidence experiment. No pre-existing graph or pool/asset lookup.
import rules from './pair-rules.json' with { type: 'json' };
const ZERO='0x'+'0'.repeat(40);
const addr=x=>typeof x==='string'&&/^0x[0-9a-f]{40}$/i.test(x)?x.toLowerCase():null;
const wordAddress=w=>typeof w==='string'&&/^0{24}[0-9a-f]{40}$/i.test(w)?'0x'+w.slice(24).toLowerCase():null;
const uint=w=>BigInt('0x'+w), sint=w=>BigInt.asIntN(256,uint(w));
const selector=n=>n?.input?.slice(0,10)?.toLowerCase();
const bytes=x=>typeof x==='string'&&/^0x(?:[0-9a-f]{2})*$/i.test(x);
const words=(s,start,n)=>bytes(s)&&s.length===start+64*n?(s.slice(start).match(/.{64}/g)??[]):null;
const within=(p,a)=>typeof p==='string'&&(p===a||a===''||p.startsWith(a+','));
const topicAddress=x=>typeof x==='string'&&x.startsWith('0x')?wordAddress(x.slice(2)):null;
const allEqual=(a,b)=>a.every(x=>x===b);
function actionArgs(n,s){
  if(!bytes(n.input)||n.input.length<10+64*(s.headWords+1))return null;
  const args=n.input.slice(10,10+64*s.headWords).match(/.{64}/g);
  if(uint(args[s.bytesArg])!==32n*BigInt(s.headWords))return null;
  const tail=n.input.slice(10+64*s.headWords),len=uint(tail.slice(0,64)),data=tail.slice(64);
  if(BigInt(data.length)<2n*len||BigInt(data.length)>64n*((len+31n)/32n)||!/^[0]*$/.test(data.slice(2*Number(len))))return null;
  return args;
}
function eventAmounts(s,data,args,ret){
  const w=words(data,2,s.eventWords);if(!w)return null;
  let ins,outs;
  if(s.eventAmounts.signed){
    const signed=s.eventAmounts.signed.map(i=>sint(w[i]));
    ins=signed.map(x=>x>0n?x:0n);outs=signed.map(x=>x<0n?-x:0n);
  }else{
    ins=s.eventAmounts.inputs.map(i=>uint(w[i]));outs=s.eventAmounts.outputs.map(i=>uint(w[i]));
  }
  const i=ins.findIndex(x=>x>0n),o=outs.findIndex(x=>x>0n);
  if(i<0||o<0||i===o||ins.filter(x=>x>0n).length!==1||outs.filter(x=>x>0n).length!==1)return null;
  if(s.emptyReturn&&ret!=null&&ret!=='0x')return null;
  if(s.assertOutputArgs&&!s.assertOutputArgs.every((a,k)=>uint(args[a])===outs[k]))return null;
  if(s.assertSignedReturn){const rw=words(ret,2,2);if(!rw||!s.assertSignedReturn.every((a,k)=>uint(rw[k])===uint(w[a])))return null;}
  if(s.directionBool!=null&&uint(args[s.directionBool])!==(i===0?1n:0n))return null;
  if(s.signedLimit!=null){
    const lim=sint(args[s.signedLimit]);if(lim===0n||(lim>0n?ins[i]>lim:outs[o]>-lim))return null;
  }
  if(s.sqrtPriceLimit!=null){const lim=uint(args[s.sqrtPriceLimit]);if(!lim||lim>>160n)return null;}
  return {amountIn:ins[i],amountOut:outs[o]};
}
function payment(n){
  const s=rules.payments[selector(n)],a=s&&words(n.input,10,s.words);
  if(!a||n.kind!=='call'||n.staticContext||addr(n.to)!==addr(n.contextAddress)||!(n.output==null||n.output==='0x'||(words(n.output,2,1)&&uint(words(n.output,2,1)[0])===1n)))return null;
  const from=s.payer==='caller'?addr(n.from):wordAddress(a[s.payer]),to=wordAddress(a[s.payee]),token=addr(n.to);
  return from&&to&&from!==to&&from!==ZERO&&to!==ZERO&&token&&token!==ZERO?
    {n,token,from,to,amount:uint(a[s.amount])}:null;
}
function decodeTransfer(l){
  if(l.topics[0]!==rules.transferTopic||l.topics.length!==3)return null;
  const w=words(l.data,2,1),from=topicAddress(l.topics[1]),to=topicAddress(l.topics[2]);
  return w&&from&&to?{token:addr(l.emitter),from,to,amount:uint(w[0])}:null;
}
function pathCmp(a,b){
  const x=a===''?[]:a.split(',').map(Number),y=b===''?[]:b.split(',').map(Number);
  for(let i=0;i<Math.min(x.length,y.length);i++){if(x[i]!==y[i])return x[i]-y[i];}return x.length-y.length;
}
export function extractPairActions(tree,{enabledSelectors}={}){
  if(!enabledSelectors||typeof enabledSelectors==='string'||!enabledSelectors[Symbol.iterator])throw Error('explicit enabledSelectors required');
  const enabled=new Set([...enabledSelectors].map(s=>s.toLowerCase())),by=new Map(),logIds=new Set();
  for(const n of tree.nodes){if(by.has(n.path))throw Error('duplicate frame');by.set(n.path,n);}
  for(const l of tree.logs){if(!Number.isSafeInteger(l.idx)||l.idx<0||logIds.has(l.idx))throw Error('invalid receipt index');logIds.add(l.idx);}
  const states=new Map();
  function ok(n){
    if(!n)return false;if(states.has(n)){if(states.get(n)===null)throw Error('cyclic frame');return states.get(n);}
    states.set(n,null);const good=!!(n.committed===true&&(n.parent==null||ok(by.get(n.parent))));states.set(n,good);return good;
  }
  function logical(n){while(n&&['delegatecall','callcode'].includes(n.kind))n=by.get(n.parent);return n;}
  const nodes=tree.nodes.filter(ok).sort((a,b)=>pathCmp(a.path,b.path));
  const facts=tree.logs.map(l=>{
    const raw=l.ownership==='ambiguous'?l.candidatePaths:['unique','traced'].includes(l.ownership)&&l.ownerPath!=null?[l.ownerPath]:[];
    const owners=[...new Set((raw??[]).map(p=>{
      const n=by.get(p);return ok(n)&&addr(n.contextAddress)===addr(l.emitter)?logical(n)?.path:null;
    }))];
    // Indexed token-ID transfers have no fungible amount word. Never treat an ID as money.
    const indexedId=l.topics[0]===rules.transferTopic && l.topics.length===4 && l.data==='0x' &&
      topicAddress(l.topics[1]) && topicAddress(l.topics[2]) && /^0x[0-9a-f]{64}$/.test(l.topics[3]);
    return {l,owners,m:decodeTransfer(l),indexedId:!!indexedId};
  });
  const pays=nodes.map(payment).filter(Boolean);
  const note=(n,reason)=>({selector:selector(n),poolAddress:addr(n.contextAddress),path:n.path,reason});
  const proposals=[],unresolved=[];
  function prove(n,s){
    const no=reason=>({reason});
    if(s.identity!=='direct')return no('shared-id-and-assets-not-proved');
    const pool=addr(n.contextAddress),caller=addr(n.from),args=actionArgs(n,s),recipient=args&&wordAddress(args[s.recipient]);
    if(!pool||pool===ZERO||addr(n.to)!==pool||!caller||!recipient||recipient===ZERO||recipient===pool||!args)return no('invalid-action');
    if(nodes.some(t=>t!==n&&t.kind==='call'&&t.contextAddress===pool&&rules.actions[selector(t)]&&(within(t.path,n.path)||within(n.path,t.path))))return no('nested-same-venue-action');
    const events=facts.filter(f=>f.l.emitter===pool&&f.l.topics[0]===s.event&&(!f.owners.length||f.owners.includes(null)||f.owners.includes(n.path)));
    if(events.length!==1||!events[0].owners.length||!allEqual(events[0].owners,n.path))return no(events.length?'ambiguous-action-event':'missing-action-event');
    const ev=events[0].l;
    if(ev.topics.length!==3||topicAddress(ev.topics[1])!==caller||topicAddress(ev.topics[2])!==recipient)return no('event-parties-mismatch');
    const delta=eventAmounts(s,ev.data,args,n.output);
    if(!delta)return no('event-call-or-return-mismatch');
    const {amountIn,amountOut}=delta,inside=p=>within(p,n.path);
    // Some actions consume a transfer immediately before the action. Only an independently
    // proved direct sibling payment to the pool is eligible, not arbitrary transaction-wide logs.
    const pnum=n.path===''?-1:Number(n.path.split(',').at(-1)),prev=n.parent==null||pnum<=0?null:(n.parent===''?'':n.parent+',')+String(pnum-1);
    const adjacent=!!(s.permitAdjacentPrepayment && prev!=null && pays.some(p=>p.n.path===prev&&p.n.from===caller&&p.to===pool&&p.amount===amountIn));
    const eligible=p=>inside(p)||(adjacent&&p===prev);
    const potential=(f,pred)=>!f.owners.length||f.owners.includes(null)||f.owners.some(pred);
    const accepted=(f,pred)=>f.owners.length>0&&f.owners.every(p=>p!=null&&pred(p));
    const payments=pays.filter(p=>eligible(p.n.path));
    const br=rules.balanceRead, reads=nodes.flatMap(t=>{
      const a=selector(t)===br.selector&&words(t.input,10,br.words),v=words(t.output,2,1);
      return a&&v&&logical(by.get(t.parent))===n&&t.kind==='staticcall'&&addr(t.from)===pool&&wordAddress(a[br.account])===pool?
        [{token:addr(t.to),balance:uint(v[0]),path:t.path}]:[];
    });
    function measuredInputs(required){
      const matches=[];
      for(const token of new Set(reads.map(r=>r.token))){
        const rs=reads.filter(r=>r.token===token);if(!token||token===pool||token===ZERO||rs.length!==2)continue;
        const [a,b]=rs;if(b.balance-a.balance!==required)continue;
        const actual=nodes.filter(t=>inside(t.path)&&pathCmp(t.path,a.path)>0&&pathCmp(t.path,b.path)<0&&t.kind==='call'&&!t.staticContext&&addr(t.to)===token);
        const p=actual.length===1&&payments.find(p=>p.n===actual[0]&&p.to===pool&&p.amount===required);
        if(p)matches.push({token,from:p.from,to:p.to,logs:[],paths:[a.path,p.n.path,b.path]});
      }
      return matches;
    }
    const measured=s.requireMeasuredInput?measuredInputs(amountIn):[];
    const sides=[];
    for(const [isInput,required] of [[true,amountIn],[false,amountOut]]){
      const scope=isInput?eligible:inside;
      const endpoint=m=>isInput?m.to===pool:m.from===pool&&m.to===recipient;
      const found=facts.filter(f=>f.m&&f.m.token!==ZERO&&f.m.token!==pool&&potential(f,scope)&&endpoint(f.m));
      if(found.length>1)return no('ambiguous-settlement');
      if(found.length){
        const f=found[0],m=f.m;
        if(m.amount!==required||f.l.idx>=ev.idx||!accepted(f,scope)||f.owners.length!==1)return no('unattributed-or-incorrect-settlement');
        const p=payments.find(p=>p.n.path===f.owners[0]&&p.token===m.token&&p.from===m.from&&p.to===m.to&&p.amount===required);
        if(!p)return no('transfer-receipt-payment-disagree');
        // Even a genuine payment with matching amount can be a *different currency*
        // than the one the pool measured. Require all action-specific evidence to agree.
        if(isInput&&s.requireMeasuredInput){
          if(measured.length!==1||measured[0].token!==p.token||!measured[0].paths.includes(p.n.path))return no('payment-disagrees-with-measured-input');
          sides.push({...measured[0],logs:[f.l.idx]});
        }else sides.push({token:p.token,from:p.from,to:p.to,logs:[f.l.idx],paths:[p.n.path]});continue;
      }
      if(!isInput)return no('missing-output-settlement');
      // Missing input Transfer: two reads *by the pool itself* must surround exactly one
      // stateful call into the token, paying that account the exact increase in balance.
      const matches=measured.filter(({token})=>!facts.some(f=>!f.indexedId&&f.l.emitter===token&&f.l.topics[0]===rules.transferTopic&&potential(f,inside)&&(!f.m||f.m.to===pool||f.m.from===pool)));
      if(matches.length!==1)return no(matches.length?'ambiguous-balance-settlement':'missing-input-settlement');
      sides.push(matches[0]);
    }
    const [a,b]=sides,used=new Set([ev.idx,...a.logs,...b.logs]),claimed=new Set([...a.paths,...b.paths]);
    if(a.token===b.token)return no('same-asset');
    if(payments.filter(p=>p.from===pool&&p.to===recipient).length!==1)return no('competing-output-payment');
    // A sibling donation in a third token can have exactly the expected numeric value.
    // Establish that the pair itself measured both identified currencies in this action.
    if(s.requirePairBalanceAssets){
      const assets=new Set(reads.map(r=>r.token));
      if(assets.size!==2||!assets.has(a.token)||!assets.has(b.token))return no('unproved-pair-assets');
      for(const read of reads)claimed.add(read.path);
      if(adjacent&&a.paths.includes(prev)&&facts.some(f=>!used.has(f.l.idx)&&f.m?.token===a.token&&f.m.to===pool&&f.l.idx<ev.idx))
        return no('multiple-prepayments');
    }
    if(nodes.some(t=>eligible(t.path)&&t.value!=null&&BigInt(t.value)>0n&&['call','selfdestruct','create','create2'].includes(t.kind)&&[t.from,t.to].includes(pool)))return no('additional-native-settlement');
    for(const side of sides){
      const parties=new Set([side.from,side.to]);
      if(facts.some(f=>!used.has(f.l.idx)&&!f.indexedId&&f.l.emitter===side.token&&f.l.topics[0]===rules.transferTopic&&potential(f,eligible)&&
        (!f.m||parties.has(f.m.to)||parties.has(f.m.from))))return no('additional-or-unattributed-transfer');
      if(payments.some(p=>!claimed.has(p.n.path)&&p.token===side.token&&(parties.has(p.to)||parties.has(p.from))))return no('additional-payment');
    }
    return {edge:{selector:selector(n),poolAddress:pool,poolId:null,tokenIn:a.token,tokenOut:b.token,amountInRaw:String(amountIn),amountOutRaw:String(amountOut),
      path:n.path,evidenceLogIndices:[...used].sort((x,y)=>x-y),evidenceCallPaths:[...claimed]}};
  }
  for(const n of nodes){
    const sel=selector(n),rule=rules.actions[sel];if(n.kind!=='call'||n.staticContext||!rule||!enabled.has(sel))continue;
    const r=prove(n,rule);if(r.edge)proposals.push(r.edge);else unresolved.push(note(n,r.reason));
  }
  const claims=edge=>[...edge.evidenceLogIndices.map(i=>'L'+i),...edge.evidenceCallPaths.map(p=>'C'+p)];
  const counts=new Map();for(const edge of proposals)for(const id of claims(edge))counts.set(id,1+(counts.get(id)??0));
  const edges=proposals.filter(e=>{if(claims(e).every(id=>counts.get(id)===1))return true;unresolved.push(note(by.get(e.path),'shared-proof-between-actions'));return false;});
  return {edges,unresolved};
}
