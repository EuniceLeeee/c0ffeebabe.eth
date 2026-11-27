import {selectorExecutionPrograms,selectorProgramProjection} from "./selector-program-role.js";
import {createHash} from 'node:crypto';
import {AbiCoder, FunctionFragment, Interface, keccak256, type ParamType} from 'ethers';
import {compileSqlExecutionParamPlan,type ExecutionParamSource} from './selector-native-execution-param-plan.js';
import {selectorNativeProgramKey,type SelectorNativeExecutionDefinition} from './selector-native-definition.js';
import type {SqlLiveEdgeCoordinates} from './selector-native-sql-live-binding.js';

type Atom=string|boolean;
type HistoricalKind='pool-id-tuple'|'direction-asset'|'argument';
export type SqlObservedParam=Readonly<{key:string;kind:HistoricalKind;value:Atom}>;
export type SqlCurrentGetterCheck=Readonly<{target:string;calldata:string;expectedReturn:string;abi:string}>;
export type SqlRecipeParamHints=Readonly<{
  index:number;programKey:string;
  /** Historical nominations, NOT current values or execution authority. */
  observed:ReadonlyMap<string,SqlObservedParam>;
  /** Ordered, canonical ABI tuple proved against the entire logical pool ID.
   * Does not imply the pool exists, and is not a historical or current getter receipt. */
  verifiedTuple:ReadonlyMap<string,Atom>;
  currentGetterChecks:readonly SqlCurrentGetterCheck[];
}>;
export type SqlExecutionParamHints=Readonly<{recipes:readonly SqlRecipeParamHints[]}>;
const schema=new WeakMap<SelectorNativeExecutionDefinition,ReturnType<typeof compileContract>>();
const coder=AbiCoder.defaultAbiCoder(),addr=/^0x[0-9a-f]{40}$/,word=/^0x[0-9a-f]{64}$/;
const pathRe=/^(?:(?:0|[1-9]\d*)(?:,(?:0|[1-9]\d*))*)?$/;
const readPath=(p:unknown):p is string=>typeof p==='string'&&p.length<=4096&&pathRe.test(p);
const obj=(x:unknown):x is Record<string,unknown>=>x!==null&&typeof x==='object'&&!Array.isArray(x);
export class SqlParamEvidenceMismatch extends Error {
  constructor(message:string){super('SQL parameter evidence: '+message);this.name='SqlParamEvidenceMismatch';}
}
function need(ok:unknown,message:string):asserts ok{if(!ok)throw new SqlParamEvidenceMismatch(message);}
function immutable(x:unknown,seen=new WeakSet<object>()):boolean {
  if(x===null||typeof x!=='object'||seen.has(x))return true;
  if(!Object.isFrozen(x))return false;seen.add(x);return Object.values(x).every(y=>immutable(y,seen));
}
function only(row:Record<string,unknown>,keys:readonly string[]){
  return Object.keys(row).length===keys.length&&keys.every(k=>Object.hasOwn(row,k));
}
function compileContract(def:SelectorNativeExecutionDefinition){
  const plan=compileSqlExecutionParamPlan(def);
  // Old public IDs may have a logical poolId with no namespace. Resolve the
  // context of the hint, never the edge key, from the active declaration.
  const scopes=new Set(selectorExecutionPrograms(def).flatMap(p=>[selectorProgramProjection(p)?.stateBinding?.poolNamespace,selectorProgramProjection(p)?.nomination?.poolNamespace])
    .filter((n):n is string=>typeof n==='string'&&n.length>0));
  const unambiguousScope=scopes.size===1?[...scopes][0]:undefined;
  // These ABIs come only from the active definition, never from input rows.
  const abis=new Map<string, {f:FunctionFragment;iface:Interface}>();
  for(const r of plan.recipes)for(const q of r.requirements)for(const s of q.sources){
    for(const abi of [s.abi,s.signature])if(typeof abi==='string'&&!abis.has(abi)){const f=FunctionFragment.from(abi);abis.set(abi,{f,iface:new Interface([f])});}
  }
  return {abis,digest:createHash('sha256').update(JSON.stringify(def)).digest('hex'),recipes:plan.recipes.map(r=>({
    programKey:selectorNativeProgramKey(selectorExecutionPrograms(def)[r.index]!),
    scope:selectorProgramProjection(selectorExecutionPrograms(def)[r.index]!)?.stateBinding?.poolNamespace,
    legacyManager:unambiguousScope!==undefined&&selectorProgramProjection(selectorExecutionPrograms(def)[r.index]!)?.stateBinding?.poolNamespace===unambiguousScope
      ?def.managerCustody?.manager.toLowerCase():undefined,
    fields:new Map(r.requirements.map(f=>[f.key,f.sources])),
  }))};
}
function contract(def:SelectorNativeExecutionDefinition){
  let v=schema.get(def);if(v===undefined){v=compileContract(def);if(immutable(def))schema.set(def,v);}return v;
}
function canonicalAtom(value:unknown,type:string):value is Atom{
  if(type==='address')return typeof value==='string'&&addr.test(value);
  if(type==='bool')return typeof value==='boolean';
  const m=/^(u?int)(\d+)$/.exec(type);
  if(!m||typeof value!=='string'||value.length>80||! /^(?:0|-?[1-9]\d*)$/.test(value))return false;
  const n=BigInt(value),b=Number(m[2]);return b>=8&&b<=256&&b%8===0&&
    (m[1]==='uint'?BigInt.asUintN(b,n):BigInt.asIntN(b,n))===n;
}
function paramAt(f:FunctionFragment,path:readonly number[]):ParamType|undefined{
  let items=f.inputs,t:ParamType|undefined;
  if(!Array.isArray(path)||!path.length)return;
  for(const i of path){if(!Number.isSafeInteger(i)||i<0||i>=items.length)return;t=items[i];items=t?.components??[];}
  return t;
}
type GetterGroup={target:string;calldata:string;abi:string;fragment:FunctionFragment;iface:Interface;values:Map<number,Atom>;conflict:boolean};
type Ast=any;
const astPath=(x:Ast):string[]|undefined=>{
  if(typeof x==='string'&&x.startsWith('$'))return x.slice(1).split('.');
  if((x?.op==='get'||x?.op==='at')&&['string','number'].includes(typeof x.args?.[1])&&!String(x.args[1]).startsWith('$')){
    const p=astPath(x.args[0]);if(p)return [...p,String(x.args[1])];
  }
};
const peel=(x:Ast):Ast=>['address','lower','number','uint'].includes(x?.op)&&Array.isArray(x.args)&&x.args.length===1?peel(x.args[0]):x;
const at=(value:Ast,path:readonly string[])=>path.reduce((v,k)=>obj(v)&&Object.hasOwn(v,k)?v[k]:undefined,value);
function tupleDirectionOK(p:SelectorNativeExecutionDefinition['programs'][number],tuple:Map<string,Atom>,edge:SqlLiveEdgeCoordinates){
  // Interpret ONLY literal projections of already-committed fields used for
  // declaring the actual input/output. An unknown path/operation does not
  // become "false" in a conditional. Treat a native side as native only when
  // the declaration says so; there is no implicit ETH == WETH conversion.
  const descriptor=selectorProgramProjection(p)?.descriptor,dirs=p.routes?.directions;
  if(!Array.isArray(dirs)||edge.tokenInId!=null||edge.tokenOutId!=null)return false;
  const facts=new Map<string,Atom>();
  for(const [k,val] of tuple){const base=astPath(peel(at(descriptor,k.split('.').slice(1))));if(!base?.length||base[0]!=='binding')return false;
    const ref=base.join('.');if(facts.has(ref)&&facts.get(ref)!==val)return false;facts.set(ref,val);}
  function proj(x:Ast,depth=0):Atom|undefined{
    if(depth>25)return;
    const ref=astPath(x);
    if(ref){
      const k=ref.join('.');if(tuple.has(k))return tuple.get(k);if(facts.has(k))return facts.get(k);
      if(ref[0]==='descriptor')return proj(at(descriptor,ref.slice(1)),depth+1);return;
    }
    if(typeof x==='string'&&!x.startsWith('$')||typeof x==='boolean')return x;
    if(!Array.isArray(x?.args))return;
    if(x.op==='lower'||x.op==='address'){
      const a=proj(x.args[0],depth+1);return typeof a==='string'&&/^0x[0-9a-fA-F]{40}$/.test(a)?a.toLowerCase():undefined;
    }
    if(x.op==='eq'||x.op==='sameAddress'){
      const a=proj(x.args[0],depth+1),b=proj(x.args[1],depth+1);if(a===undefined||b===undefined)return;
      if(x.op==='eq')return a===b;
      return [a,b].every(v=>typeof v==='string'&&/^0x[0-9a-fA-F]{40}$/.test(v))?String(a).toLowerCase()===String(b).toLowerCase():undefined;
    }
    if(x.op==='if'){const a=proj(x.args[0],depth+1);if(typeof a==='boolean')return proj(x.args[a?1:2],depth+1);}
  }
  return dirs.some(d=>{
    const physical=(side:'tokenIn'|'tokenOut')=>{
      const kind=d.executionAssets===undefined?'erc20':proj(d.executionAssets?.[side==='tokenIn'?'input':'output']);
      if(kind==='native')return '0x'+'00'.repeat(20);if(kind!=='erc20')return;
      const a=proj(d[side]);return typeof a==='string'&&/^0x[0-9a-fA-F]{40}$/.test(a)?a.toLowerCase():undefined;};
    return physical('tokenIn')===edge.tokenIn&&physical('tokenOut')===edge.tokenOut;
  });
}
function currentGetterGroups(edge:SqlLiveEdgeCoordinates,fields:Map<string,ExecutionParamSource[]>,observed:ReadonlyMap<string,SqlObservedParam>,abis:ReturnType<typeof compileContract>['abis']){
  const groups=new Map<string,GetterGroup>(),values=edge as unknown as Record<string,unknown>;
  for(const x of observed.values())for(const s of fields.get(x.key)??[]){
    if(s.kind!=='getter')continue;
    // All call bytes come from the active declaration/edge, never from SQL.
    const target=s.target==='poolAddress'?edge.poolAddress:s.target;
    const {f,iface}=abis.get(s.abi)!;
    if(!addr.test(target)||!Number.isSafeInteger(s.outputIndex)||s.outputIndex<0||s.outputIndex>=f.outputs.length||
       !canonicalAtom(x.value,f.outputs[s.outputIndex]!.type)||f.format()!==s.signature)continue;
    const args:unknown[]=[];
    for(const arg of s.arguments){
      let v=arg.kind==='fixed'?arg.value:arg.kind==='edge'&&Object.hasOwn(values,arg.field)?values[arg.field]:undefined;
      if(arg.bytesPrefix!==undefined){
        if(typeof v!=='string'||! /^0x(?:[0-9a-f]{2})*$/.test(v)||v.length<2+arg.bytesPrefix*2){v=undefined;}
        else v=v.slice(0,2+arg.bytesPrefix*2);
      }args.push(v);
    }
    if(args.some(v=>v==null))continue;
    let calldata:string;try{calldata=iface.encodeFunctionData(f,args);}catch{continue;}
    const k=target+':'+calldata+':'+s.abi;
    const g=groups.get(k)??{target,calldata,abi:s.abi,fragment:f,iface,values:new Map<number,Atom>(),conflict:false};
    if(g.values.has(s.outputIndex)&&g.values.get(s.outputIndex)!==x.value)g.conflict=true;
    g.values.set(s.outputIndex,x.value);groups.set(k,g);
  }
  const checks:SqlCurrentGetterCheck[]=[];
  for(const g of groups.values()){
    if(g.conflict||g.values.size!==g.fragment.outputs.length)continue;
    const result=g.iface.encodeFunctionResult(g.fragment,g.fragment.outputs.map((_,i)=>g.values.get(i)!));
    checks.push(Object.freeze({target:g.target,calldata:g.calldata,expectedReturn:result,abi:g.abi}));
  }
  return Object.freeze(checks);
}

/** Uniform evidence is read through the hash-pinned SQL edge manifest. It
 * cannot manufacture a route, choose a winner, fund a price, inject an RPC
 * result, or supply a transaction. Nonuniform/legacy rows use normal binding. */
export function validateSqlExecutionParamHints(input:{
  definition:SelectorNativeExecutionDefinition;edge:SqlLiveEdgeCoordinates;evidence:unknown;
}):SqlExecutionParamHints|undefined{
  const {definition,edge,evidence:e}=input;
  if(e==null)return;
  need(obj(e),'invalid record');
  if(e.consensus==='nonuniform'||e.consensus==='not-declared'){
    need(only(e,['consensus']),'nonuniform evidence cannot include a winner');return;
  }
  need(only(e,['consensus','definitionSha256','recipes','txHash','callPath','innerSwapPath'])&&e.consensus==='uniform','invalid evidence envelope');
  need(edge.chainId===1&&edge.selector===definition.selector&&addr.test(edge.poolAddress)&&addr.test(edge.tokenIn)&&addr.test(edge.tokenOut)&&
    edge.tokenIn!==edge.tokenOut,'chain, selector or asset coordinates differ');
  need(typeof e.txHash==='string'&&word.test(e.txHash)&&readPath(e.callPath)&&
    (e.innerSwapPath===null||readPath(e.innerSwapPath)&&e.innerSwapPath!==e.callPath&&(e.callPath===''||e.innerSwapPath.startsWith(e.callPath+','))),
    'invalid transaction or action path');
  const live=contract(definition);
  need(e.definitionSha256===live.digest&&Array.isArray(e.recipes)&&e.recipes.length===live.recipes.length,'active declaration or recipe count differs');
  const recipes:SqlRecipeParamHints[]=[];
  for(const [i,r] of e.recipes.entries()){
    const {fields,programKey,scope,legacyManager}=live.recipes[i]!;
    need(obj(r)&&only(r,['index','observed','missing'])&&r.index===i&&Array.isArray(r.missing)&&Array.isArray(r.observed)&&
      r.observed.length+r.missing.length<=fields.size,'bad recipe identity or size');
    const all=new Set<string>(),observed=new Map<string,SqlObservedParam>(),verifiedTuple=new Map<string,Atom>();
    const tupleGroups=new Map<string,{types:string[];keys:Map<number,string>;values:Map<number,Atom>}>();
    const directions=new Map<string,boolean>();
    for(const x of r.observed){
      need(obj(x)&&only(x,['key','kind','value'])&&typeof x.key==='string'&&!all.has(x.key),'bad or repeated observed parameter');
      all.add(x.key);const ss=fields.get(x.key),obs=ss?.filter(s=>s.kind===x.kind);
      need(ss&&!ss.some(s=>s.kind==='fixed'||s.kind==='runtime')&&obs?.length===1&&
        ['argument','pool-id-tuple','direction-asset'].includes(String(x.kind)),'observed value not authorized by active execution declaration');
      const s=obs[0]!,value=x.value;
      if(s.kind==='argument'){
        const {f}=live.abis.get(s.signature)!,t=paramAt(f,s.path);need(s.role==='bound'&&s.frame==='entry'&&f.selector===edge.selector&&
          t&&canonicalAtom(value,t.type),'invalid bound argument or type');
      }else if(s.kind==='direction-asset'){
        need(s.frame==='entry'&&live.abis.get(s.signature)!.f.selector===edge.selector&&
          edge.tokenInId==null&&edge.tokenOutId==null&&edge.poolId==null&&
          !/^0x0{40}$/.test(edge.tokenIn)&&!/^0x0{40}$/.test(edge.tokenOut)&&
          ['tokenIn','tokenOut'].includes(s.yes)&&['tokenIn','tokenOut'].includes(s.no)&&s.yes!==s.no&&
          canonicalAtom(value,'address'),'invalid direction asset scope');
        const yes=edge[s.yes as 'tokenIn'|'tokenOut']===value, no=edge[s.no as 'tokenIn'|'tokenOut']===value;
        need(yes!==no,'historical asset differs from this edge');
        const g=JSON.stringify([s.signature,s.frame,s.when,s.otherwise]);
        need(!directions.has(g)||directions.get(g)===yes,'inconsistent direction assets');directions.set(g,yes);
      }else{
        need(e.innerSwapPath!==null&&typeof edge.poolId==='string'&&word.test(edge.poolId)&&!/^0x0{64}$/.test(edge.poolId)&&
          (edge.poolNamespace==null?legacyManager===edge.poolAddress:edge.poolNamespace===scope)&&
          Array.isArray(s.types)&&s.types.length>0&&Number.isSafeInteger(s.member)&&s.member>=0&&s.member<s.types.length&&
          canonicalAtom(value,s.types[s.member]),'invalid logical pool or ABI member');
        const groupKey=JSON.stringify([s.signature,s.path,s.types]);
        const g=tupleGroups.get(groupKey)??{types:s.types,keys:new Map<number,string>(),values:new Map<number,Atom>()};
        need(!g.keys.has(s.member),'duplicate tuple member');g.keys.set(s.member,x.key);g.values.set(s.member,value);tupleGroups.set(groupKey,g);
      }
      observed.set(x.key,Object.freeze({key:x.key,kind:x.kind as HistoricalKind,value:value as Atom}));
    }
    for(const k of r.missing){need(typeof k==='string'&&fields.has(k)&&!all.has(k),'unknown or repeated missing parameter');all.add(k);}
    for(const g of tupleGroups.values()){
      need(g.values.size===g.types.length,'incomplete pool-id tuple');
      const values=g.types.map((_,n)=>g.values.get(n)!);
      need(keccak256(coder.encode(g.types,values))===edge.poolId,'typed tuple does not hash to this logical pool');
      const tuple=new Map<string,Atom>();for(const [n,key] of g.keys)tuple.set(key,values[n]!);
      need(tupleDirectionOK(selectorExecutionPrograms(definition)[i]!,tuple,edge),'pool tuple does not establish direction assets');
      // Later descriptor finalizers are outside the SQL compiler's pure
      // projection. A trusted semantic contradiction must not depend on them.
      if(!selectorProgramProjection(selectorExecutionPrograms(definition)[i]!)?.descriptorReads)for(const [n,key] of g.keys)verifiedTuple.set(key,values[n]!);
    }
    recipes.push(Object.freeze({index:i,programKey,observed,verifiedTuple,currentGetterChecks:currentGetterGroups(edge,fields,observed,live.abis)}));
  }
  return Object.freeze({recipes:Object.freeze(recipes)});
}
