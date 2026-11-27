import {selectorExecutionPrograms,selectorProgramProjection} from "./selector-program-role.js";
import type {SelectorNativeProgram} from './selector-native-definition.js';
import type {SqlRecipeParamHints} from './selector-native-sql-param-hints.js';
type Data=Record<string,any>;
const obj=(x:any):x is Data=>x!==null&&typeof x==='object'&&!Array.isArray(x);
export function sourceParameterOrigin(x:any):string[]|undefined{
 if(typeof x==='string'&&x.startsWith('$'))return x.slice(1).split('.');
 if(['address','lower','number','uint'].includes(x?.op)&&x.args?.length===1)return sourceParameterOrigin(x.args[0]);
 if(['get','at'].includes(x?.op)&&x.args?.length===2&&/^[A-Za-z_0-9]+$/.test(String(x.args[1]))){
  const p=sourceParameterOrigin(x.args[0]);if(p)return [...p,String(x.args[1])];
 }
}
function fields(x:any):Data|undefined{
 if(!obj(x))return;if(!Object.hasOwn(x,'op'))return x;
 if(x.op==='merge'&&Array.isArray(x.args)&&x.args.every((a:any)=>obj(a)&&!Object.hasOwn(a,'op')))
  return Object.assign(Object.create(null),...x.args);
}
function member(x:any,path:readonly string[]):any{
 for(const k of path){const m=fields(x);if(!m||!Object.hasOwn(m,k))return;x=m[k];}return x;
}
function put(root:Data,path:readonly string[],value:unknown){
 if(!path.length||path.some(k=>!/^[A-Za-z0-9_]+$/.test(k)||['__proto__','constructor','prototype'].includes(k)))throw Error('invalid source parameter path');
 for(const k of path.slice(0,-1)){if(!Object.hasOwn(root,k))root[k]=Object.create(null);if(!obj(root[k]))throw Error('source parameter shape conflict');root=root[k];}
 const k=path.at(-1)!;if(Object.hasOwn(root,k)&&root[k]!==value)throw Error('source parameter value conflict');root[k]=value;
}
/** Inverse of authored lossless scalar projections, shared by trial and issued
 * source execution. Fixed JSON expressions never accept an observed override. */
export function selectorSourceParameters(p:SelectorNativeProgram,h:SqlRecipeParamHints){
 const binding:Data=Object.create(null),args:Data=Object.create(null);
 for(const [key,o] of h.observed){
  if(!key.startsWith('descriptor.'))continue;
  const path=sourceParameterOrigin(member(selectorProgramProjection(p)?.descriptor,key.split('.').slice(1)));
  if(path?.[0]==='binding'&&path.length>1)put(binding,path.slice(1),o.value);
  if(o.kind==='argument'&&(path?.[0]==='args'||path?.[0]==='arguments')&&
    p.parameters?.some(v=>v.role==='bound'&&v.path.join('.')===path.slice(1).join('.')))put(args,path.slice(1),o.value);
 }
 return {binding,args};
}
