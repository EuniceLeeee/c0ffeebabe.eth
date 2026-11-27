import { blockTransferEndpoints, type BlockTouchedObservation } from "./blockscan-touched-state.js";

export interface PoolLegBinding {
  readonly poolAddress: string; readonly poolId?: string|null; readonly poolNamespace?: string|null;
  readonly legId: string; readonly stateKey: string;
  readonly activity?: PoolActivityRule;
}
/** A Family's state declaration, not a token-to-all-pools dependency. */
export interface PoolActivityRule {
  readonly on: readonly ("call-target"|"log-emitter"|"asset-transfer-endpoint"|"pool-id-event")[];
  readonly assets: readonly string[];
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
/** Activity and selection use this same pair of startup coordinates. A leg
 * ID, resource/recipe hash or traded currency is not a physical pool key. */
export function canonicalPhysicalPoolId(id:string|null|undefined):string|null {
  return id!=null&&/^0x[0-9a-f]{64}$/i.test(id)?id.toLowerCase():id??null;
}
export function touchedPoolKey(poolAddress:string,poolId?:string|null):string {
  return JSON.stringify([poolAddress.toLowerCase(),canonicalPhysicalPoolId(poolId)]);
}
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
  readonly #activity=new Map<string,(PoolActivityRule|undefined)[]>();
  readonly addresses:readonly string[];
  constructor(input:Iterable<PoolLegBinding>,readonly publishedPoolResources=false){
    const groups=new Map<string,Builder>(),addresses=new Set<string>();
    const add=(key:string,r:PoolLegBinding)=>{let b=groups.get(key);if(!b){b=build();groups.set(key,b);}
      b.legs.add(r.legId);b.states.add(r.stateKey);};
    for(const row of input){
      const addr=row.poolAddress.toLowerCase(),id=canonicalPhysicalPoolId(row.poolId),ns=row.poolNamespace??null;
      if(!address(addr)||!row.legId||!row.stateKey||(id!==null&&!opaque(id))||(ns!==null&&(!opaque(ns)||id===null)))throw Error("invalid pool to leg binding");
      addresses.add(addr);add(JSON.stringify([addr,id,ns]),row);
      const activity=this.#activity.get(addr)??[];
      if(row.activity&&(!row.activity.on.length||
        (id!==null? row.activity.on.length!==1||row.activity.on[0]!=="pool-id-event":
          row.activity.on.some(k=>!["call-target","log-emitter","asset-transfer-endpoint"].includes(k)))||
        row.activity.assets.some(t=>!/^0x[0-9a-f]{40}$/i.test(t))))throw Error("invalid declared pool activity");
      activity.push(row.activity?Object.freeze({on:Object.freeze([...row.activity.on]),
        assets:Object.freeze(row.activity.assets.map(t=>t.toLowerCase()))}):undefined);
      this.#activity.set(addr,activity);
      if(id!==null){this.#managers.add(addr);add(JSON.stringify([addr,id]),row);add(JSON.stringify([addr]),row);}
    }
    this.addresses=Object.freeze([...addresses]);
    this.#entries=new Map(Array.from(groups,([key,b])=>[key,freeze(b)]));
  }
  isManager(addr:string){return this.#managers.has(addr.toLowerCase());}
  acceptsActivity(addr:string,kind:PoolActivityRule["on"][number],token?:string):boolean{
    const rows=this.#activity.get(addr.toLowerCase());
    // Existing undeclared resources retain their established behavior. A pool
    // is refreshed as one unit if any enabled leg's declaration is affected.
    return !rows||rows.some(r=>!r||r.on.includes(kind)&&(kind!=="asset-transfer-endpoint"||
      token!==undefined&&r.assets.some(t=>t.toLowerCase()===token.toLowerCase())));
  }
  forPool(addr:string,id?:string|null,ns?:string|null):PoolLegSelection{
    const canonical=canonicalPhysicalPoolId(id);
    return this.#entries.get(JSON.stringify(canonical!=null&&ns===undefined?[addr.toLowerCase(),canonical]:[addr.toLowerCase(),canonical,ns??null]))??empty;
  }
  forUnscopedManager(addr:string):PoolLegSelection{return this.#entries.get(JSON.stringify([addr.toLowerCase()]))??empty;}
}
/** SQL pool identity is an observed address (plus optional manager pool ID).
 * Resource identity is opaque and comes from the startup Graph. A physical
 * pool may publish multiple resource keys, but the converse is not valid. */
export function publishedPoolLegIndex(rows:Iterable<PoolLegBinding>):PoolLegRefreshIndex {
  const resources=new Map<string,{poolAddress:string;poolId:string|null;ids:Map<string,PoolActivityRule|undefined>}>();
  const seen=new Set<string>();
  for(const {poolAddress,poolId,legId,stateKey,activity} of rows){
    const addr=poolAddress.toLowerCase(),id=canonicalPhysicalPoolId(poolId),old=resources.get(stateKey);
    if(seen.has(legId)||!stateKey)throw Error("duplicate SQL leg or missing published pool resource");
    if(old && (old.poolAddress!==addr||old.poolId!==id))throw Error("published pool resource aliases distinct physical pools");
    seen.add(legId);
    const entry=old??{poolAddress:addr,poolId:id,ids:new Map<string,PoolActivityRule|undefined>()};
    entry.ids.set(legId,activity);resources.set(stateKey,entry);
  }
  function* bindings(){
    for(const [stateKey,r] of resources)for(const [legId,activity] of r.ids)
      yield {poolAddress:r.poolAddress,poolId:r.poolId,stateKey,legId,activity};
  }
  return new PoolLegRefreshIndex(bindings(),true);
}
function collect(index:PoolLegRefreshIndex,inputs:readonly {address:string;ids?:readonly string[]|null}[]){
  const direct=new Map<string,{poolAddress:string;poolId?:string}>(),fallback=new Set<string>();
  const groups:PoolLegSelection[]=[],unknown:PoolLegSelection[]=[];
  for(const v of inputs){
    const a=v.address.toLowerCase();
    const single=index.forPool(a);
    if(single.legIds.length){
      // The same SQL target can have both address-only and manager/ID rows.
      // Receiving a manager event cannot prove a second, address-only pool
      // moved. Keep its conservative pricing work without inflating pool hits.
      if(index.publishedPoolResources && index.isManager(a))unknown.push(single);
      else {direct.set(touchedPoolKey(a),{poolAddress:a});groups.push(single);}
    }
    if(!index.isManager(a))continue;
    if(v.ids==null){fallback.add(a);unknown.push(index.forUnscopedManager(a));continue;}
    for(const item of v.ids){const id=canonicalPhysicalPoolId(item)!;const scoped=index.forPool(a,id);
      if(scoped.legIds.length){direct.set(touchedPoolKey(a,id),{poolAddress:a,poolId:id});groups.push(scoped);}}
  }
  const known=combined(groups),other=combined(unknown);
  return {...combined([known,other]),directLegIds:known.legIds,directStateKeys:known.stateKeys,directPools:[...direct.values()],touchedPoolKeys:[...direct.keys()],fallbackLegIds:other.legIds,fallbackManagers:[...fallback]};
}
export function observePoolBalanceRefresh(index:PoolLegRefreshIndex,addresses:readonly string[]){
  return collect(index,addresses.map(address=>({address})));
}
/** No recursive invalidation through route hops. A transfer treats the two
 * balance owners as addresses, not every pool using the token. Unknown
 * singleton activity is explicit and confined to that manager. */
export function observePoolLegRefresh(index:PoolLegRefreshIndex,obs:BlockTouchedObservation,readIds?:PoolLogScopes){
  if(obs.kind==="call")return collect(index,index.acceptsActivity(obs.target,"call-target")?[{address:obs.target}]:[]);
  const ids=readIds&&index.isManager(obs.address)?readIds({address:obs.address,topics:obs.topics,data:obs.data}):undefined;
  const endpoints=blockTransferEndpoints(obs.topics),canonicalAmount=endpoints.length===2&&/^0x[0-9a-f]{64}$/i.test(obs.data);
  return collect(index,[...(index.acceptsActivity(obs.address,"log-emitter")||
    ids!=null&&ids.length>0&&index.acceptsActivity(obs.address,"pool-id-event")?[{address:obs.address,ids}]:[]),
    ...endpoints.filter(address=>index.acceptsActivity(address,"asset-transfer-endpoint",canonicalAmount?obs.address:undefined)).map(address=>({address,
    ids:canonicalAmount&&readIds?.settlementBalanceOnly?.(address)?[]:null}))]);
}
