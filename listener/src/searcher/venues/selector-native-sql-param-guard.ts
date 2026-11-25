import type { SelectorNativeProgram } from './selector-native-definition.js';

const obj=(v:unknown):v is Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const address=(v:unknown):v is string=>typeof v==='string'&&/^0x[0-9a-f]{40}$/i.test(v);
const member=(s:unknown):s is string=>typeof s==='string'&&/^[a-zA-Z][a-zA-Z0-9_]*$/.test(s)&&!['constructor','prototype','__proto__'].includes(s);
function path(v:unknown,depth=0):string[]|undefined{
  if(depth>16)return;
  if(typeof v==='string'&&v.startsWith('$descriptor')){
    const [root,...p]=v.split('.');if(root==='$descriptor'&&p.every(member))return p;return;
  }
  if(!obj(v)||v.op!=='get'||!Array.isArray(v.args)||v.args.length!==2||!member(v.args[1]))return;
  const base=path(v.args[0],depth+1);return base&&[...base,v.args[1]];
}
function declaredLeaf(root:unknown,p:readonly string[]):boolean{
  if(!p.length||['executionPolicy','target','tokenIn','tokenOut','tokenInId','tokenOutId','poolNamespace','poolId',
    'familyId','lineageId','instanceKey','provenance','runtimeRequirements','signedInstanceKey'].includes(p[0]!))return false;
  for(const k of p){if(!obj(root)||Object.hasOwn(root,'op')||!Object.hasOwn(root,k))return false;root=root[k];}return true;
}

/** Negative evidence only. The declared binding's successful getter must
 * yield preimage bytes whose keccak is this complete pool id. If the ordinary
 * mandatory route check contradicts that preimage, no successful binding
 * could issue this recipe. Never convert historical bytes into a current
 * getter, code read, permission, passing route, or successful simulation. */
export function contradictedCommittedRoute(p:SelectorNativeProgram,tuple:ReadonlyMap<string,string|boolean>):boolean {
  if(!tuple.size||!p.binding?.stateBinding||p.binding.descriptorReads||!p.binding.descriptor||
     (p.context&&Object.keys(p.context).length>0))return false;
  for(const statement of p.routes?.checks??[]){
    // A preceding declaration or conditional can shadow the environment.
    if(!obj(statement)||!Object.hasOwn(statement,'assert')||Object.keys(statement).some(k=>k!=='assert'&&k!=='error'))break;
    const e=statement.assert;
    if(!obj(e)||e.op!=='sameAddress'||!Array.isArray(e.args)||e.args.length!==2)continue;
    for(const i of [0,1]){
      const k=path(e.args[i]),expected=e.args[1-i];
      if(!k||!address(expected)||!declaredLeaf(p.binding.descriptor,k))continue;
      const v=tuple.get('descriptor.'+k.join('.'));
      if(address(v)&&v.toLowerCase()!==expected.toLowerCase())return true;
    }
  }
  return false;
}
