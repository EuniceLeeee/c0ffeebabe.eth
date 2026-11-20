import { blockTransferEndpoints, type BlockTouchedObservation } from "./blockscan-touched-state.js";

export interface PoolLegBinding {
  readonly poolAddress: string; readonly poolId?: string|null; readonly poolNamespace?: string|null;
  readonly legId: string; readonly stateKey: string;
}
export interface PoolLegSelection { readonly legIds: readonly string[]; readonly stateKeys: readonly string[] }
/** null = unknown; [] = positively identified non-price event; other IDs
 * identify logical pools. A transfer skip affects physical pool selection
 * only; the caller must still consult independent Family dependencies. */
export type PoolLogScopes = ((log: {address:string;topics:readonly string[];data:string})=>readonly string[]|null) & {
  readonly settlementBalanceOnly?:(owner:string)=>boolean;
};
const empty:PoolLegSelection=Object.freeze({legIds:Object.freeze([]),stateKeys:Object.freeze([])});
const address=(s:string)=>/^0x[0-9a-f]{40}$/i.test(s)&&!/^0x0{40}$/i.test(s);
const opaque=(s:string)=>typeof s==="string"&&s.length>0&&s.length<=256;
type Builder={legs:Set<string>;states:Set<string>};
const build=():Builder=>({legs:new Set(),states:new Set()});
const freeze=(b:Builder):PoolLegSelection=>Object.freeze({legIds:Object.freeze([...b.legs]),stateKeys:Object.freeze([...b.states])});
const combined=(...entries:Iterable<PoolLegSelection>[]):PoolLegSelection=>{
  const b=build();for(const group of entries)for(const x of group){
    for(const id of x.legIds)b.legs.add(id);for(const k of x.stateKeys)b.states.add(k);
  }return b.legs.size?freeze(b):empty;
};
/** One immutable index per topology. The leg and its local pricing owner are
 * deliberately separate; neither a token address nor a function selector is a pool. */
export class PoolLegRefreshIndex {
  readonly #entries:Map<string,PoolLegSelection>;
  readonly #managers=new Set<string>();
  readonly addresses:readonly string[];
  constructor(input:Iterable<PoolLegBinding>){
    const groups=new Map<string,Builder>(),addresses=new Set<string>();
    const add=(key:string,r:PoolLegBinding)=>{let b=groups.get(key);if(!b){b=build();groups.set(key,b);}
      b.legs.add(r.legId);b.states.add(r.stateKey);};
    for(const row of input){
      const addr=row.poolAddress.toLowerCase(),id=row.poolId??null,ns=row.poolNamespace??null;
      if(!address(addr)||!row.legId||!row.stateKey||(id!==null&&!opaque(id))||(ns!==null&&(!opaque(ns)||id===null)))throw Error("invalid pool to leg binding");
      addresses.add(addr);add(JSON.stringify([addr,id,ns]),row);
      if(id!==null){this.#managers.add(addr);add(JSON.stringify([addr,id]),row);add(JSON.stringify([addr]),row);}
    }
    this.addresses=Object.freeze([...addresses]);
    this.#entries=new Map(Array.from(groups,([key,b])=>[key,freeze(b)]));
  }
  isManager(addr:string){return this.#managers.has(addr.toLowerCase());}
  forPool(addr:string,id?:string|null,ns?:string|null):PoolLegSelection{
    return this.#entries.get(JSON.stringify(id!=null&&ns===undefined?[addr.toLowerCase(),id]:[addr.toLowerCase(),id??null,ns??null]))??empty;
  }
  forUnscopedManager(addr:string):PoolLegSelection{return this.#entries.get(JSON.stringify([addr.toLowerCase()]))??empty;}
}
function collect(index:PoolLegRefreshIndex,inputs:readonly {address:string;ids?:readonly string[]|null}[]){
  const direct=new Map<string,{poolAddress:string;poolId?:string}>(),fallback=new Set<string>();
  const groups:PoolLegSelection[]=[],unknown:PoolLegSelection[]=[];
  for(const v of inputs){
    const a=v.address.toLowerCase();
    const single=index.forPool(a);
    if(single.legIds.length){direct.set(JSON.stringify([a]),{poolAddress:a});groups.push(single);}
    if(!index.isManager(a))continue;
    if(v.ids==null){fallback.add(a);unknown.push(index.forUnscopedManager(a));continue;}
    for(const id of v.ids){const scoped=index.forPool(a,id);
      if(scoped.legIds.length){direct.set(JSON.stringify([a,id]),{poolAddress:a,poolId:id});groups.push(scoped);}}
  }
  const known=combined(groups),other=combined(unknown);
  return {...combined([known,other]),directLegIds:known.legIds,directPools:[...direct.values()],fallbackLegIds:other.legIds,fallbackManagers:[...fallback]};
}
export function observePoolBalanceRefresh(index:PoolLegRefreshIndex,addresses:readonly string[]){
  return collect(index,addresses.map(address=>({address})));
}
/** No recursive invalidation through route hops. A transfer treats the two
 * balance owners as addresses, not every pool using the token. Unknown
 * singleton activity is explicit and confined to that manager. */
export function observePoolLegRefresh(index:PoolLegRefreshIndex,obs:BlockTouchedObservation,readIds?:PoolLogScopes){
  if(obs.kind==="call")return collect(index,[{address:obs.target}]);
  const ids=readIds&&index.isManager(obs.address)?readIds({address:obs.address,topics:obs.topics,data:obs.data}):undefined;
  const endpoints=blockTransferEndpoints(obs.topics),canonicalAmount=endpoints.length===2&&/^0x[0-9a-f]{64}$/i.test(obs.data);
  return collect(index,[{address:obs.address,ids},...endpoints.map(address=>({address,
    ids:canonicalAmount&&readIds?.settlementBalanceOnly?.(address)?[]:null}))]);
}
