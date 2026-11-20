// Observability only: no selected keys, pricing authority or scheduling decisions
// come from this journal. Scope it to a single immutable runtime root.
export interface PhysicalHit {
  readonly directPools:readonly {poolAddress:string;poolId?:string}[];
  readonly directLegIds:readonly string[];
  readonly fallbackLegIds:readonly string[];
  readonly fallbackManagers:readonly string[];
}
type Anchor={number:number;hash:string};
const bucket=()=>({pools:new Set<string>(),direct:new Set<string>(),fallback:new Set<string>(),managers:new Set<string>()});
type Bucket=ReturnType<typeof bucket>;
export class PoolTouchCounts {
  private blocks=new Map<string,{n:number;parent:string;mode:string;data:Bucket}>();
  discard(hash:string){this.blocks.delete(hash);}
  begin(n:number,hash:string,parent:string,mode:string){
    const data=bucket();
    const hit=(h:PhysicalHit)=>{
      for(const p of h.directPools)data.pools.add(JSON.stringify([p.poolAddress,p.poolId??null]));
      for(const id of h.directLegIds)data.direct.add(id);
      for(const id of h.fallbackLegIds)data.fallback.add(id);
      for(const a of h.fallbackManagers)data.managers.add(a);
    };
    return {hit,seal:(complete=true)=>{if(!complete){this.blocks.delete(hash);return;}
      this.blocks.set(hash,{n,parent,mode,data});while(this.blocks.size>256)this.blocks.delete(this.blocks.keys().next().value!);}};
  }
  summary(base:Anchor,target:Anchor,mode:string){
    const span=target.number-base.number;
    if(span<0||span>256)return {coverage:"unavailable",reason:"out_of_retained_range"} as const;
    let hash=target.hash, all:Bucket|undefined;
    for(let n=target.number;n>base.number;n--){const b=this.blocks.get(hash);
      if(!b||b.n!==n||b.mode!==mode)return {coverage:"unavailable",reason:"missing_block_or_mode"} as const;
      // The ordinary one-head path only reads the sealed bucket; copying/merging
      // sets is necessary only when distinct canonical blocks form a catch-up.
      if(span===1)all=b.data;
      else {
        all??=bucket();
        for(const k of ["pools","direct","fallback","managers"] as const)for(const v of b.data[k])all[k].add(v);
      }
      hash=b.parent;
    }
    if(hash!==base.hash)return {coverage:"unavailable",reason:"different_branch"} as const;
    all??=bucket();
    let overlap=0;for(const id of all.fallback)if(all.direct.has(id))overlap++;
    return {coverage:"complete_observed_input",observedBlocks:span,directPools:all.pools.size,
      directPublicLegs:all.direct.size,fallbackManagers:all.managers.size,fallbackPublicLegs:all.fallback.size,
      directFallbackOverlapLegs:overlap} as const;
  }
}

/** Build, encode and emit only diagnostic fields inside this boundary. In
 * particular no exception from an old receipt or the output sink can turn
 * an otherwise successful effective price publication into a failed build. */
export function reportOptionalEffectiveCounts(build:()=>unknown,write:(line:string)=>void){
  try{write(`[searcher/effective-mid] ${JSON.stringify(build())}`);}catch{/* diagnostic only */}
}

// This is an outcome breakdown, not a claim about *why* an old quote was
// invalidated. Same-source rebuilds are not evidence of another RPC. Consume
// the existing published-row pass; never copy the graph to make this report.
export function priceCarryOutcomes<T extends {readonly status:string}>(
  current:ReadonlyMap<string,T>,previous:ReadonlyMap<string,T>|undefined,isCarried:(r:T)=>boolean,
){
  let carried=0,priorQuotedInCurrentGraph=0,priorQuotedRetained=0,priorQuotedAtCurrentSource=0,priorQuotedNowUnpriced=0;
  for(const [key,row] of current){
    const oldObservation=isCarried(row);
    if(oldObservation)carried++;
    if(previous?.get(key)?.status!=="quoted")continue;
    priorQuotedInCurrentGraph++;
    if(row.status!=="quoted")priorQuotedNowUnpriced++;
    else if(oldObservation)priorQuotedRetained++;
    else priorQuotedAtCurrentSource++;
  }
  return {carried,carryOutcomes:{priorBasePresent:previous!==undefined,priorQuotedInCurrentGraph,priorQuotedRetained,
    priorQuotedAtCurrentSource,priorQuotedNowUnpriced}};
}
