import {selectorExecutionPrograms,selectorProgramProjection} from "./selector-program-role.js";
// Compile data requirements from the actual executable expression, not from a
// list of getters or the set of fields present in a historical Ready file.
import {FunctionFragment} from 'ethers';

// The authoring DSL is arbitrary JSON, narrowed by structural checks at each step.
type Expr = any;
type NodeEnv = Record<string, Expr>;
export type ExecutionParamSource = {kind:string; [field:string]:Expr};
export type ExecutionParamRequirement = {key:string;sources:ExecutionParamSource[]};
export type ExecutionParamPlan = {selector:string;recipes:{index:number;requirements:ExecutionParamRequirement[]}[]};
const obj=(x:Expr)=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const fixed=(value:Expr):ExecutionParamSource=>({kind:'fixed',value}), edge=(field:string):ExecutionParamSource=>({kind:'edge',field});
const runtime=(field:string):ExecutionParamSource=>({kind:'runtime',field}), missing=(reason:string):ExecutionParamSource=>({kind:'unresolved',reason});
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
const own=(o:Expr,k:PropertyKey)=>o!=null&&Object.hasOwn(o,k);
const literal=(x:Expr)=>['string','number','boolean'].includes(typeof x)&&!(typeof x==='string'&&x.startsWith('$'));
const pick=(x:Expr,path:readonly string[]):Expr=>{for(const k of path){if(!own(x,k))return undefined;x=x[k];}return x;};
function pathOf(x:Expr):string[]|undefined{
  if(typeof x==='string'&&x.startsWith('$'))return x.slice(1).split('.');
  if((x?.op==='get'||x?.op==='at')&&literal(x.args?.[1])){
    const p=pathOf(x.args[0]);if(p)return [...p,String(x.args[1])];
  }
}
const unwrap=(x:Expr):Expr=>['address','lower','number','uint'].includes(x?.op)&&x.args.length===1?unwrap(x.args[0]):x;
function select(x:Expr,path:readonly string[]):Expr{
  if(!path.length)return x;
  const ref=pathOf(x);if(ref)return '$'+[...ref,...path].join('.');
  if(x?.op==='merge'){
    // The last member wins. Never assume earlier values survive an unbounded
    // spread to the right.
    for(let i=x.args.length-1;i>=0;i--){const t=x.args[i];if(!obj(t)||t.op||own(t,path[0]))return select(t,path);}
  }
  if(obj(x)&&!x.op||Array.isArray(x))return own(x,path[0])?select(x[path[0]],path.slice(1)):undefined;
}
function walkNodes(x:Expr,visit:(n:Expr)=>void):void{if(!x||typeof x!=='object')return;visit(x);for(const y of Object.values(x))walkNodes(y,visit);}
function canonicalFn(sig:Expr){try{return FunctionFragment.from(sig);}catch{return null;}}
function abiFor(doc:Expr,group:string,sig:string):string|null{
  const fn=canonicalFn(sig);if(!fn)return null;
  return (doc.abi?.[group]??[]).find((s:Expr)=>canonicalFn(s)?.format()===fn.format())??null;
}
const runFields=new Set(['executor','recipient','externalRecipient','transactionOrigin','minAmountOut','quotedAmountOut','amountIn','source','direction','executionPolicy','directSettlement','deferredSettlement','fundedSettlement','authenticatedEvidence','runtimeEvidence','exactEvidence']);
// Invert the *declared* direction constraints of an entry call. The observed
// direction must already be established independently by SQL; this may label
// its two assets, never discover the direction or infer it from address order.
function orderedAssetSources(def:Expr,p:Expr,resolve:(x:Expr)=>ExecutionParamSource){
  const byKey=new Map(),dirs=p.routes?.directions,entry=canonicalFn(def.signature);
  if(!entry||!Array.isArray(dirs)||dirs.length!==2||!dirs.every(d=>typeof d.id==='string')||dirs[0].id===dirs[1].id)return byKey;
  const keys=dirs.map(d=>[pathOf(d.tokenIn)?.join('.'),pathOf(d.tokenOut)?.join('.')]);
  if(!keys[0].every(k=>k?.startsWith('descriptor.'))||keys[0][0]===keys[0][1]||!same(keys[0],keys[1].slice().reverse()))return byKey;
  const truth=(x:Expr,d:Expr):boolean|undefined=>{
    if(typeof x==='boolean')return x;
    const path=pathOf(x);
    if(path?.[0]==='route'&&path.length===2&&typeof d.fields?.[path[1]]==='boolean')return d.fields[path[1]];
    if(x?.op==='not'){const a=truth(x.args[0],d);return typeof a==='boolean'?!a:undefined;}
    if(x?.op==='eq'||x?.op==='ne'){
      const i=x.args.findIndex((v:Expr)=>pathOf(v)?.join('.')==='route.direction');
      if(i>=0&&dirs.some((dir:Expr)=>dir.id===x.args[1-i]))return x.op==='eq'?d.id===x.args[1-i]:d.id!==x.args[1-i];
    }
  };
  function arm(x:Expr,d:Expr):Expr{
    if(x?.op==='if'){const cond=truth(x.args[0],d);if(cond!==undefined)return arm(x.args[cond?1:2],d);}
    return x;
  }
  const entries:({guards:Expr[],x:Expr}|null)[]=[];
  function walk(x:Expr,guards:Expr[]=[]):void{
    if(!x||typeof x!=='object')return;
    if(own(x,'when'))guards=[...guards,x.when];
    if(typeof x.signature==='string'&&Array.isArray(x.args)&&canonicalFn(x.signature)?.format()===entry!.format()){
      const t=resolve(x.target);if(t.kind!=='edge'||t.field!=='poolAddress'){entries.push(null);return;}
      entries.push({guards,x});}
    for(const v of Object.values(x))walk(v,guards);
  }
  walk(p.execution);if(!entries.length||entries.some(x=>x===null))return byKey;
  const cases=dirs.map(d=>entries.filter((v):v is NonNullable<typeof v>=>v!==null).filter(({guards})=>!guards.some(g=>truth(g,d)===false)).map(({x})=>x));
  if(cases.some(c=>!c.length))return byKey;
  // Every applicable encoding for a direction must impose the same condition;
  // one alternate callback program may not silently contradict the rest.
  const bool:Expr[][]=[],amount:Expr[][]=[];
  for(const [i,type] of entry.inputs.entries()){
    const sets=cases.map((c,j)=>c.map(x=>{const a=arm(x.args[i],dirs[j]);if(type.type==='bool')return truth(a,dirs[j]);
      if(/^uint\d+$/.test(type.type)){
        const raw=a?.op==='uint'?a.args[0]:a;if(raw===0||raw==='0')return 'zero';
        if(obj(a)&&(typeof a.runtime==='string'||typeof a.quoteOutput==='string'))return 'variable';
      }}));
    if(!sets.every(s=>s.every(v=>v!==undefined&&v===s[0]))||sets[0][0]===sets[1][0])continue;
    const pair=sets.map(s=>s[0]);if(type.type==='bool')bool.push([i,...pair]);else amount.push([i,...pair]);
  }
  const signature=entries[0]!.x.signature;let when:Expr[],otherwise:Expr[];
  if(bool.length===1){const [i,a,b]=bool[0];when=[{path:[i],test:'eq',value:a}];otherwise=[{path:[i],test:'eq',value:b}];}
  else if(!bool.length&&amount.length===2&&amount[0][1]!==amount[1][1]){
    const test=(t:Expr)=>t==='zero'?'zero':'positive';
    when=amount.map(([i,t])=>({path:[i],test:test(t)}));otherwise=amount.map(([i,,t])=>({path:[i],test:test(t)}));
  }else return byKey;
  keys[0].forEach((k,i)=>byKey.set(k,{kind:'direction-asset',signature,frame:'entry',when,otherwise,yes:i?'tokenOut':'tokenIn',no:i?'tokenIn':'tokenOut'}));
  return byKey;
}
function edgeField(p:readonly string[]){
  const s=p.join('.');
  if(s==='sqlEdge.tokenIn')return 'tokenIn';
  if(s==='sqlEdge.tokenOut')return 'tokenOut';
  if(s==='sqlEdge.hookData')return 'hookData';
  if(s==='target'||s==='scope.target'||s==='candidate.target'||s==='candidate.scope.target')return 'poolAddress';
  for(const k of ['poolId','poolNamespace','tokenIn','tokenOut','tokenInId','tokenOutId','chainId','hookData']){
    if(s==='scope.'+k||s==='candidate.scope.'+k)return k;
  }
}
function localResult(step:Expr,name:readonly string[]):Expr{
  if(step.result)return select(step.result,name);
  const ops=step.decode;
  if(!Array.isArray(ops)||ops.some((s:Expr)=>s.when||s.try||s.attempt))return;
  const ret=ops.at(-1)?.return;if(ret===undefined)return;
  const p=pathOf(ret);if(!p)return select(ret,name);
  const defs=ops.filter((s:Expr)=>s.let===p[0]);if(defs.length===1)return select(defs[0].value,[...p.slice(1),...name]);
}
function compileRecipe(def:Expr,p:Expr,index:number){
  const doc={abi:{...p.values?.abi,...p.resourceValues?.abi},constants:{...p.values?.constants,...p.resourceValues?.constants},
    expressions:{...p.values?.expressions,...p.resourceValues?.expressions},programs:{...p.values?.programs,...p.resourceValues?.programs}};
  const binding:Expr=selectorProgramProjection(p)??{},flow=binding.flow??{},steps=flow.steps??[],byStep=new Map<string,Expr>(steps.map((s:Expr)=>[s.id,s]));
  const requirements=new Map<string,ExecutionParamRequirement>(),tupleByKey=new Map<string,ExecutionParamSource>();
  const base=(x:Expr,depth=0):ExecutionParamSource=>{
    if(depth>45)return missing('cyclic-or-deep-binding');
    if(literal(x)||x===null)return fixed(x);
    const u=unwrap(x);if(u!==x){const v=base(u,depth+1);if(v.kind==='fixed'){
      try{const op=x.op,value=v.value;if(op==='lower'&&typeof value==='string')return fixed(value.toLowerCase());
        if(op==='address'&&/^0x[0-9a-fA-F]{40}$/.test(value))return fixed(value.toLowerCase());
        if(op==='uint'&&typeof value!=='boolean')return fixed(BigInt(value).toString());
        if(op==='number'&&Number.isSafeInteger(Number(value)))return fixed(Number(value));}catch{}return missing('nonliteral-cast');}return v;}
    const path=pathOf(x);
    if(path){
      const [head,...tail]=path,ef=edgeField(path);if(ef)return edge(ef);
      if(head==='constants'){const v=pick(doc.constants,tail);return literal(v)||v===null?fixed(v):missing('non-scalar-configuration');}
      if(runFields.has(head))return runtime(path.join('.'));
      if(head==='candidate'&&tail.length && own(binding.stateBinding?.candidate,tail[0]))return base(select(binding.stateBinding.candidate,tail),depth+1);
      if(head==='descriptor')return base(select(binding.descriptor,tail),depth+1);
      if(head==='binding')return base(select(flow.result,tail),depth+1);
      if(head==='steps'&&byStep.has(tail[0]))return base(localResult(byStep.get(tail[0]),tail.slice(1)),depth+1);
      if((head==='args'||head==='arguments')&&tail.length){
        const a=(p.parameters??[]).find((a:Expr)=>same(a.path.map(String),tail));if(a?.role==='bound')return {kind:'argument',signature:def.signature,path:a.path,role:'bound',frame:'entry'};
      }
      if(own(p.context,head))return base(select(p.context[head],tail),depth+1);
      return missing('unresolved-declaration');
    }
    if(x?.op==='coalesce'){
      // These coordinates always exist on a SQL execution leg. Do not
      // collect the non-SQL fallback as another historical requirement.
      if(x.args[0]==='$sqlEdge.tokenIn')return edge('tokenIn');
      if(x.args[0]==='$sqlEdge.tokenOut')return edge('tokenOut');
      if(x.args[0]==='$sqlEdge.hookData')return edge('hookData');
      const a=base(x.args[0],depth+1);if(a.kind==='fixed')return a.value===null?base(x.args[1],depth+1):a;
      return missing('conditional-binding');
    }
    if(x?.op==='decode')return getter(x,x.args[3]??0,depth+1);
    return missing('derived-or-unresolved');
  };
  // Follow a particular selected component through result projection. A
  // decodeAll result remains indexed: it is never implicitly component zero.
  function selected(x:Expr,tail:readonly string[]=[],depth=0):ExecutionParamSource{
    if(depth>45)return missing('cyclic-or-deep-binding');
    const y=pathOf(x);
    if(y){
      const [h,...t]=[...y,...tail];
      if(h==='binding')return selected(flow.result,t,depth+1);
      if(h==='steps'&&byStep.has(t[0])){const st=byStep.get(t[0]);return selected(localResult(st,[]),t.slice(1),depth+1);}
      if(h==='descriptor')return selected(binding.descriptor,t,depth+1);
      return base('$'+[h,...t].join('.'),depth+1);
    }
    if(unwrap(x)!==x){
      if(tail.length)return missing('invalid-projection');
      const normal=base(x,depth+1);return normal.kind==='unresolved'?selected(x.args[0],[],depth+1):normal;
    }
    if(x?.op==='decodeAll'){
      if(tail.length!==1||!/^\d+$/.test(tail[0]))return missing('whole-abi-result');return getter(x,Number(tail[0]),depth+1);
    }
    if(x?.op==='decode'&&!tail.length)return getter(x,x.args[3]??0,depth+1);
    if(tail.length){const [k,...rest]=tail;if((obj(x)&&!x.op||Array.isArray(x))&&own(x,k))return selected(x[k],rest,depth+1);
      const v=select(x,tail);return v===undefined?missing('missing-projection'):selected(v,[],depth+1);}
    return base(x,depth+1);
  }
  function getter(x:Expr,i:number,depth:number):ExecutionParamSource{
    const [group,signature,result]=x.args;if(!Number.isSafeInteger(i)||i<0)return missing('unsupported-getter-output');
    const returned=result?.op==='get'&&result.args[1]==='data'?result.args[0]:null;
    if(returned?.op!=='returned'||typeof returned.args[0]!=='string')return missing('unbound-getter-result');
    const requests=steps.flatMap((s:Expr)=>s.requests??[]).filter((r:Expr)=>r.id===returned.args[0]);
    const r=requests[0],abi=abiFor(doc,group,signature);if(requests.length!==1||!r||r.kind!=='eth-call'||r.data?.op!=='encode'||r.data.args[0]!==group||r.data.args[1]!==signature||!abi)return missing('unbound-getter-request');
    if(i>=(canonicalFn(abi)?.outputs?.length??0))return missing('invalid-getter-component');
    const t=base(r.to,depth+1);const target=t.kind==='edge'&&t.field==='poolAddress'?'poolAddress':t.kind==='fixed'&&/^0x[0-9a-f]{40}$/i.test(t.value)?t.value.toLowerCase():null;
    if(!target||!Array.isArray(r.data.args[2]))return missing('unsupported-getter-target');
    const args=r.data.args[2].map((a:Expr)=>{if(a?.op==='bytes'&&a.args[1]===0&&Number.isInteger(a.args[2])&&a.args[2]>0&&a.args[2]<=32){
      const v=base(a.args[0],depth+1);if(v.kind==='edge')return {...v,bytesPrefix:a.args[2]};}return base(a,depth+1);});
    if(args.some((a:Expr)=>!['fixed','edge'].includes(a.kind)))return missing('unsupported-getter-arguments');
    return {kind:'getter',signature,target,arguments:args,outputIndex:i,abi};
  }
  // Prove, from the same read result and its authored postcondition, that
  // the exact ABI tuple belongs to the *full* logical-pool id. Merely seeing
  // five familiar fields or a function named swap does not establish this.
  for(const step of steps){
    const ds=step.decode;if(!Array.isArray(ds)||ds.length!==3||ds.some(x=>x.when)||!ds[0].let||ds[2]?.return!=='$'+ds[0].let)continue;
    const eq=ds[1].assert;if(eq?.op!=='eq')continue;
    const id=eq.args.findIndex((x:Expr)=>{const b=base(x);return b.kind==='edge'&&b.field==='poolId';});if(id<0)continue;
    const h=unwrap(eq.args[1-id]),enc=h?.args?.[0];if(h?.op!=='codeHash'||enc?.op!=='abiEncode')continue;
    const [types,arg]=enc.args,ref=pathOf(arg);if(!Array.isArray(types)||!types.length||!ref||ref[0]!==ds[0].let)continue;
    const decoded=select(ds[0].value,ref.slice(1));if(decoded?.op!=='decodeAll')continue;
    const outputs=canonicalFn(abiFor(doc,decoded.args[0],decoded.args[1]))?.outputs?.map(o=>o.type);if(!same(types,outputs))continue;
    walkNodes(p.execution?.steps,node=>{
      const call=node.call,fn=canonicalFn(call?.signature),t=selected(call?.target);
      if(!fn||t.kind!=='edge'||t.field!=='poolAddress')return;
      fn.inputs.forEach((arg,i)=>{
        if(arg.baseType!=='tuple'||!same(arg.components!.map(c=>c.type),types))return;
        const paths=arg.components!.map((c,j)=>pathOf(Array.isArray(call.args?.[i])?call.args[i][j]:call.args?.[i]?.[c.name]));
        if(paths.some((path,j)=>!path||!same(selected('$'+path.join('.')),getter(decoded,j,0))||getter(decoded,j,0).kind!=='getter'))return;
        paths.forEach((path,j)=>tupleByKey.set(path!.join('.'),{kind:'pool-id-tuple',signature:call.signature,path:[i],types,member:j}));
      });
    });
  }
  // A source-owned ABI commitment replaces an old getter postcondition. This
  // only nominates tuple bytes; the consumer still verifies the full pool ID.
  const declaredTuple=binding.stateBinding?.poolIdTuple;
  if(declaredTuple){
    const fn=canonicalFn(declaredTuple.signature);let part:import('ethers').ParamType|undefined;
    for(const [depth,i] of (declaredTuple.path??[]).entries()){
      part=depth===0?fn?.inputs[i]:part?.baseType==='tuple'?part.components?.[i]:undefined;
      if(!part)break;
    }
    if(part?.baseType==='tuple'&&part.components?.length===declaredTuple.fields?.length){
      const types=part.components!.map(t=>t.type);
      declaredTuple.fields.forEach((field:string,member:number)=>tupleByKey.set('descriptor.'+field,
        {kind:'pool-id-tuple',signature:declaredTuple.signature,path:declaredTuple.path,types,member}));
    }
  }
  const ordered=orderedAssetSources(def,p,selected);
  const put=(key:string,sources:ExecutionParamSource[]):void=>{if(!requirements.has(key))requirements.set(key,{key,sources});};
  const roots=new Set();
  function requirePath(path:string[]):void{
    const key=path.join('.');if(roots.has(key))return;roots.add(key);
    const [h,...t]=path;
    // finishBinding/projection assign these identifiers after reading the
    // declarative descriptor and never request them from the chain.
    if((h==='descriptor'||h==='route')&&t.length===1&&['familyId','lineageId','instanceKey'].includes(t[0])||
       h==='route'&&t.length===1&&['adapterId','routeKey'].includes(t[0]))return put(key,[runtime(key)]);
    if(h==='target'){
      const selectedTarget=p.routes?.target??'$descriptor.target';scan(selectedTarget,{});
      return put(key,[selected(selectedTarget)]);
    }
    if(h==='binding'){
      // In the execution environment "binding" is the evaluated state
      // projection, not the similarly named discovery/identity read flow.
      const declaration=select(p.state,t);
      if(declaration!==undefined)scan(declaration,{});
      return put(key,[declaration===undefined?missing('unresolved-execution-state'):selected(declaration)]);
    }
    if(h==='route'){
      if(['tokenIn','tokenOut','target','direction','executionAssets'].includes(t[0])){
        // The execution route may use a normalized graph token rather than
        // the observed native asset. Select using declared direction assets;
        // do not blindly alias route.tokenIn/out to physical SQL addresses.
        const dirs=p.routes?.directions;
        if(Array.isArray(dirs)&&t[0]!=='target')for(const d of dirs){
          scan(d.tokenIn,{});scan(d.tokenOut,{});
          if(t[0]==='executionAssets')scan(d.executionAssets,{});
        }
        put(key,[runtime(key)]);return;
      }
      const dirs:Expr[]=Array.isArray(p.routes?.directions)?p.routes.directions:[],xs=dirs.map(d=>select(d.fields??{},t));if(xs.length&&xs.every(x=>x!==undefined)){
        for(const x of xs)scan(x,{});
        if(xs.every(x=>same(x,xs[0]))){const v=selected(xs[0]);if(v.kind!=='unresolved')return put(key,[v]);}
        return put(key,[runtime('selected-route.'+t.join('.'))]);
      }
    }
    if(own(p.context,h)){const x=select(p.context[h],t);if(x!==undefined)scan(x,{});}
    const v=selected('$'+key);
    const hint=tupleByKey.get(key)??ordered.get(key);
    put(key,v.kind==='fixed'?[v]:hint?[hint,v]:[v]);
  }
  const expanding=new Set();let budget=30000;
  function scan(node:Expr,env:NodeEnv):void{
    if(--budget<0){put('unresolved-budget',[missing('analysis-bound')]);return;}
    const ref=pathOf(node);
    if(ref){const [name,...t]=ref;
      if(own(env,name)){const b=env[name];if(b!==null){const x=select(b.value,t);if(x===undefined){scan(b.value,b.env);return;}scan(x,b.env);}return;}
      requirePath(ref);return;
    }
    if(!node||typeof node!=='object')return;
    if(own(node,'runtime')&&typeof node.runtime==='string'){put('vm.'+node.runtime,[runtime(node.runtime)]);return;}
    if(['expression','program'].includes(node.op)){
      const [name,args]=node.args,k=node.op+':'+name,body=(node.op==='expression'?doc.expressions:doc.programs)[name];
      if(!body||expanding.has(k)){put(k,[missing('unavailable-named-value')]);return;}
      const e={...env};for(const [n,v] of Object.entries(args??{}))e[n]={value:v,env};
      expanding.add(k);
      if(node.op==='program'&&Array.isArray(body)){
        for(const s of body){if(s.let&&!s.when){e[s.let]={value:s.value,env:{...e}};continue;}scan(s,e);}
      }else scan(body,e);
      expanding.delete(k);return;
    }
    if(['map','flatMap','filter','some','every'].includes(node.op)){
      const [rows,name,body]=node.args;scan(rows,env);scan(body,{...env,[name]:null,index:null});return;
    }
    for(const v of Object.values(node))scan(v,env);
  }
  if(p.execution){
    const {quoteOutput:inner,...core}=p.execution;
    let requiresExports=false;walkNodes(core,n=>{if(typeof n.quoteOutput==='string')requiresExports=true;});
    scan(core,{});if(requiresExports){const q=p.quoteOutput??inner;if(q)scan(q,{});else put('quoteOutput',[missing('missing-execution-quote-export')]);}
  }else{
    const fn=canonicalFn(def.signature),known=new Map<string,string>((p.parameters??[]).map((v:Expr)=>[v.path.join('.'),v.role]));
    const visit=(t:import('ethers').ParamType,path:number[]):void=>{const key=path.join('.'),role=known.get(key);
      if(role!==undefined){put('args.'+key,[role==='bound'?{kind:'argument',signature:def.signature,path,role:'bound',frame:'entry'}:
        ['poolId','tokenInId','tokenOutId','tokenIn','tokenOut'].includes(role)?edge(role):runtime(role)]);return;}
      if(t.baseType==='tuple')t.components!.forEach((v,i)=>visit(v,[...path,i]));else put('args.'+key,[missing('argument-without-binding-role')]);};
    if(fn)fn.inputs.forEach((v,i)=>visit(v,[i]));else put('arguments',[missing('invalid-abi')]);
  }
  return {index,requirements:[...requirements.values()].sort((a,b)=>a.key.localeCompare(b.key))};
}
export function compileSqlExecutionParamPlan(definition:Expr):ExecutionParamPlan{
  const active=['swap','protocol'].includes(definition.domain)&&definition.activation?.enabled!==false;
  return {selector:definition.selector,recipes:active?(selectorExecutionPrograms(definition)??[]).map((p:Expr,i:number)=>compileRecipe(definition,p,i)):[]};
}
