// Inputs are per-action observations, not transaction-wide evidence. Nothing
// here issues an execution grant or substitutes historical values for a quote.
import { FunctionFragment } from '../listener/node_modules/ethers/lib.esm/abi/fragments.js';
import { keccak256 } from '../listener/node_modules/ethers/lib.esm/crypto/keccak.js';

const pathShape = /^(?:|(?:0|[1-9]\d*)(?:,(?:0|[1-9]\d*))*)$/;
const address = /^0x[0-9a-f]{40}$/, bytes32 = /^0x[0-9a-f]{64}$/;
const id = x => typeof x === 'string' ? x.toLowerCase() : '';
const parent = p => p.includes(',') ? p.slice(0,p.lastIndexOf(',')) : '';
const descends = (child, ancestor) => child !== ancestor && (ancestor === '' || child.startsWith(ancestor+','));
const abiCache = new Map();
function fragment(sig){
  if(typeof sig!=='string' || sig.length>4096)return;
  if(abiCache.has(sig))return abiCache.get(sig);
  let f; try{ f=FunctionFragment.from(sig); }catch{ return; }
  if(abiCache.size<4096)abiCache.set(sig,f);
  return f;
}

/** Build once for the complete transaction. The archived table uses complete
 * canonical trace paths. Missing/duplicate paths must not bind an action. */
export function buildSqlExecutionFrameIndex(frames){
  const paths=new Map(), decoded=new Map(),tupleEvidence=new Map(),success=new Map(); let invalid=!Array.isArray(frames);
  if(!invalid)for(const f of frames){
    if(!f || typeof f.path!=='string' || f.path.length>4096 || !pathShape.test(f.path) || paths.has(f.path)){
      invalid=true;break;
    }
    paths.set(f.path,f);
  }
  function successful(p){
    if(invalid || typeof p!=='string' || !paths.has(p))return false;
    const original=p;
    for(;;){
      if(success.has(p)){success.set(original,success.get(p));return success.get(p);}
      if(paths.get(p)?.ok!==true){success.set(original,false);return false;}
      if(p===''){success.set(original,true);return true;}p=parent(p);
    }
  }
  // Preserve the real action input. Do not require unrelated dynamic tails
  // to be padded: some successful contracts accept shortened hookData etc.
  function argumentsAt(frame,signature){
    const k=frame.path+':'+signature;
    if(decoded.has(k))return decoded.get(k);
    const f=fragment(signature),input=id(frame?.fullInput??frame?.input);
    if(!f || input.slice(0,10)!==f.selector || input.length>262154 || !/^0x(?:[0-9a-f]{2})+$/.test(input)){decoded.set(k,undefined);return;}
    const args={params:f.inputs,body:input.slice(10)};
    decoded.set(k,args);return args;
  }
  return {paths,successful,argumentsAt,tupleEvidence};
}

function staticWidth(t){
  if(t.baseType==='array'){
    const width=staticWidth(t.arrayChildren);
    return t.arrayLength<0 || width===null?null:t.arrayLength*width;
  }
  if(t.baseType==='tuple'){
    let n=0;for(const p of t.components){const w=staticWidth(p);if(w===null)return null;n+=w;}return n;
  }
  return t.type==='bytes'||t.type==='string'?null:1;
}
function atPath(args,path){
  if(!args || !Array.isArray(path) || !path.length || path.length>16)return;
  let {params,body}=args, word=0;
  for(let i=0;i<path.length;i++){
    const p=path[i];if(!Number.isSafeInteger(p)||p<0||p>=params.length)return;
    for(let j=0;j<p;j++)word+=staticWidth(params[j])??1;
    const type=params[p],w=staticWidth(type);
    if(w===null || !Number.isSafeInteger(word) || !Number.isSafeInteger(w) || w<1 || word*64+w*64>body.length)return;
    if(i===path.length-1)return {type,bytes:body.slice(word*64,(word+w)*64)};
    if(type.baseType!=='tuple')return; // never index arbitrary bytes/dynamic arrays
    params=type.components;
  }
}
const primitive=t=>t==='address'||t==='bool'||/^u?int(?:8|16|24|32|40|48|56|64|72|80|88|96|104|112|120|128|136|144|152|160|168|176|184|192|200|208|216|224|232|240|248|256)$/.test(t);
function scalar(t,word){
  if(!primitive(t)||word.length!==64)return;
  if(t==='address')return word.startsWith('0'.repeat(24))?'0x'+word.slice(24):undefined;
  const n=BigInt('0x'+word);
  if(t==='bool')return n===0n?false:n===1n?true:undefined;
  const bits=Number(t.match(/[0-9]+/)[0]);
  const v=t.startsWith('uint')?BigInt.asUintN(bits,n):BigInt.asIntN(bits,n);
  return BigInt.asUintN(256,v)===n?v.toString(10):undefined;
}
function actionFrame(index,edge,signature,at){
  if(edge.conflictingFlow || !index || !index.successful(edge.callPath))return;
  const entry=index.paths.get(edge.callPath), target=id(edge.selectorTarget), sel=id(edge.selector);
  if(!address.test(target)||entry?.kind!=='call'||id(entry.target)!==target||
     id(entry.input).slice(0,10)!==sel)return;
  const current=fragment(signature)?.selector;
  if(at==='entry'||(at==='action' && edge.innerSwapPath==null)){
    if(current===sel)return entry;
    return;
  }
  if(at!=='inner' && at!=='action')return;
  const inner=edge.innerSwapPath;
  if(typeof inner!=='string'||!descends(inner,edge.callPath)||!index.successful(inner))return;
  // Do not borrow an identically shaped call under a nested entry instance.
  for(let p=parent(inner);p!==edge.callPath;p=parent(p)){
    const n=index.paths.get(p);
    if(id(n?.target)===target && id(n?.input).slice(0,10)===sel)return;
  }
  const f=index.paths.get(inner);
  if(f?.kind==='call' && id(f.target)===target && id(f.input).slice(0,10)===current)return f;
}
const edgeFields=new Set(['chainId','selector','poolAddress','poolId','poolNamespace','tokenIn','tokenOut','tokenInId','tokenOutId']);
// Two independently authored mirrored route directions. An ABI numeric
// quantity is a boolean witness here, never a reusable transaction amount.
function directionAsset(s,index,edge){
  if(s.frame!=='entry'||!['tokenIn','tokenOut'].includes(s.yes)||!['tokenIn','tokenOut'].includes(s.no)||s.yes===s.no||
     !address.test(edge.tokenIn??'')||!address.test(edge.tokenOut??'')||
     edge.tokenIn===edge.tokenOut||[edge.tokenIn,edge.tokenOut].some(a=>/^0x0{40}$/.test(a))||
     edge.tokenInId!=null||edge.tokenOutId!=null||!Array.isArray(s.when)||!Array.isArray(s.otherwise)||
     !s.when.length||s.when.length>16||s.otherwise.length!==s.when.length)return;
  const f=actionFrame(index,edge,s.signature,'entry');
  if(!f||id(f.target)!==id(edge.poolAddress))return;
  const args=index.argumentsAt(f,s.signature), branches=[];
  for(const predicates of [s.when,s.otherwise]){
    const checks=new Map();let met=true;
    for(const pred of predicates){
      if(!pred || !Array.isArray(pred.path))return;
      const path=JSON.stringify(pred.path),arg=atPath(args,pred.path);if(!arg||checks.has(path))return;
      const value=scalar(arg.type.type,arg.bytes);if(value===undefined)return;
      let guard;
      if(pred.test==='eq'&&arg.type.type==='bool'&&typeof pred.value==='boolean'){
        guard=pred.value?'true':'false';met=met&&value===pred.value;
      }else if((pred.test==='zero'||pred.test==='positive')&&arg.type.type.startsWith('uint')&&pred.value===undefined){
        guard=pred.test;met=met&&(pred.test==='zero'?value==='0':BigInt(value)>0n);
      }else return;
      checks.set(path,guard);
    }
    branches.push({checks,met});
  }
  const opposite={true:'false',false:'true',zero:'positive',positive:'zero'};
  const [a,b]=branches;
  if(a.met===b.met||[...a.checks].some(([p,g])=>b.checks.get(p)!==opposite[g]))return;
  return edge[a.met?s.yes:s.no];
}
function resolveSource(s,index,edge){
  if(s.kind==='edge')return edgeFields.has(s.field)?edge[s.field]??undefined:undefined;
  if(s.kind==='direction-asset')return directionAsset(s,index,edge);
  if(s.kind!=='pool-id-tuple' && s.kind!=='argument')return;
  // Only the compiler's explicit bound-scalar role can promote a plain
  // argument. Seeing a recipient/amount/deadline in historical calldata is
  // not proof it belongs in a new transaction.
  if(s.kind==='argument' && (s.role!=='bound'||!['entry','inner'].includes(s.frame)))return;
  const f=actionFrame(index,edge,s.signature,s.frame??'action');
  if(!f)return;
  const item=atPath(index.argumentsAt(f,s.signature),s.path);
  if(!item)return;
  if(s.kind==='argument')return scalar(item.type.type,item.bytes);
  // Do not treat a bytes32 pool ID as reversible. The *observed* typed
  // calldata tuple must commit to the complete logical-pool identity.
  if(!bytes32.test(edge.poolId??'') || /^0x0{64}$/.test(edge.poolId) ||
     id(edge.poolAddress)!==id(f.target)||item.type.baseType!=='tuple'||!Array.isArray(s.types)||
     !s.types.length||s.types.length>32||s.types.length!==item.type.components.length||
     !Number.isSafeInteger(s.member)||s.member<0||s.member>=s.types.length)return;
  if(!s.types.every((t,i)=>primitive(t)&&item.type.components[i].type===t))return;
  const key=JSON.stringify([f.path,s.signature,s.path,s.types,edge.poolId]);
  if(!index.tupleEvidence.has(key)){
    const members=s.types.map((t,i)=>scalar(t,item.bytes.slice(i*64,(i+1)*64)));
    index.tupleEvidence.set(key,members.some(v=>v===undefined)||keccak256('0x'+item.bytes)!==edge.poolId ? null : members);
  }
  return index.tupleEvidence.get(key)?.[s.member];
}

/** Deterministic values only; historical provenance is attached separately by
 * the caller. Mixed fixed/runtime data should be separate declaration keys. */
export function resolveSqlExecutionTraceParams({edge,index,recipe}){
  const values=[],runtime=[],unresolved=[];
  for(const {key,sources} of recipe.requirements){
    const fixed=sources.filter(s=>s.kind==='fixed');
    if(fixed.length){
      if(fixed.some(s=>s.value===undefined||JSON.stringify(s.value)!==JSON.stringify(fixed[0].value)))
        unresolved.push({key,reason:'conflicting-fixed-declarations'});
      else values.push({key,value:fixed[0].value,kind:'fixed'});
      continue;
    }
    const rt=sources.filter(s=>s.kind==='runtime');
    if(rt.length){runtime.push({key,fields:[...new Set(rt.map(s=>s.field))].sort()});continue;}
    const found=[];
    for(const s of sources){
      const value=resolveSource(s,index,edge);
      if(value!==undefined)found.push({key,value,kind:s.kind});
    }
    if(!found.length)unresolved.push({key,reason:edge.conflictingFlow && sources.some(s=>s.kind==='argument'||s.kind==='pool-id-tuple'||s.kind==='direction-asset')
      ? 'conflicting-action-flow' : sources.some(s=>s.kind==='getter')?'source-block-read-not-proven-immutable':'missing-attributed-static-evidence'});
    else if(found.some(v=>JSON.stringify(v.value)!==JSON.stringify(found[0].value)))
      unresolved.push({key,reason:'conflicting-static-evidence'});
    else values.push(found[0]);
  }
  return {values,runtime,unresolved};
}
