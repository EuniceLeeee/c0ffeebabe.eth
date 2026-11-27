import { EventFragment, ZeroAddress, getAddress } from "ethers";
import {selectorExecutionPrograms} from "./selector-program-role.js";
import { isDeepStrictEqual } from "node:util";
import { compileDeclarativeEventCodec, type DeclarativeEventLog } from "./declarative-event-codec.js";
import { compileDeclarativeValues } from "./declarative-values.js";
import {selectorPhysicalPoolActivity, type SelectorNativeExecutionDefinition, type SelectorNativeProgram} from "./selector-native-definition.js";

type Data=Record<string,any>;
function path(x:any):string|undefined {
  if(typeof x==="string"&&x.startsWith("$"))return x;
  if(x?.op==="lower"||x?.op==="address")return path(x.args[0]);
  if(x?.op==="get"&&typeof x.args[1]==="string"){const first=path(x.args[0]);return first&&first+"."+x.args[1];}
  return undefined;
}
function literal(x:unknown):string|undefined {
  try{return typeof x==="string"&&x!==ZeroAddress?getAddress(x).toLowerCase():undefined;}catch{return undefined;}
}
/** Only mandatory equalities establish ownership, never an OR branch, a graph
 * descriptor we do not have, or a global list of routers watching this topic. */
function requiredAddress(x:any,variable:string):string[] {
  if(x?.op==="and")return x.args.flatMap((child:any)=>requiredAddress(child,variable));
  if(x?.op!=="sameAddress"&&x?.op!=="eq")return [];
  const [a,b]=x.args,fixed=path(a)===variable?literal(b):path(b)===variable?literal(a):undefined;
  return fixed?[fixed]:[];
}
function emitters(p:SelectorNativeProgram,event:Data){
  const venue=p.routes?.venue as Data|undefined,resource=p.routes?.resource as Data|undefined,manager=path(venue?.manager);
  if(!manager||venue?.kind!=="manager-pool-id"||manager!==path(p.routes?.target)||manager!==path(resource?.target)||
    !path(venue?.poolId)||path(venue?.poolId)!==path(resource?.poolId))return [];
  const venuePins=(p.routes?.checks as Data[]|undefined)?.flatMap(s=>s.when===undefined?requiredAddress(s.assert,manager):[])??[];
  return [...new Set([...venuePins,...requiredAddress(event.valid,"$log.address")])];
}
/** The Family independently vouches for this exact indexed ABI field. Do not
 * step over any other guard: recognise only an owner pin and the direction
 * check on the very same two signed legs used to construct amountIn/Out.
 * Nothing here reads the specific amounts of a receipt or classifies a trade. */
function hasIndependentPoolId(c:SelectorNativeExecutionDefinition["managerCustody"],owner:string,abi:EventFragment,slotName:string,e:Data):boolean{
  if(!c||literal(c.manager)!==owner||!c.physicalPoolEvents?.some(p=>p.indexedPoolId===slotName&&
    EventFragment.from(p.signature).format("full")===abi.format("full"))||e.classification!=="swap"||e.receiptMode!==undefined||
    e.valid?.op!=="and"||!Array.isArray(e.valid.args)||e.valid.args.length!==2)return false;
  const inputs=abi.inputs.filter(p=>!p.indexed&&/^int\d+$/.test(p.type));
  const result=e.payload.amountOut,quantity=e.payload.amountIn;
  if(result?.op!=="if"||!Array.isArray(result.args)||result.args.length!==3)return false;
  const asArg=(v:Data)=>inputs.find(p=>path(v)==="$args."+p.name)?.name;
  const b=asArg(result.args[1]),a=asArg(result.args[2]);if(!a||!b||a===b)return false;
  const zero={op:"uint",args:[0]},get=(n:string)=>({op:"get",args:["$args",n]}),negative=(n:string)=>({op:"sub",args:[zero,get(n)]});
  const side=(x:string,y:string)=>({op:"and",args:[{op:"lt",args:[get(x),zero]},{op:"gt",args:[get(y),zero]}]});
  const direction=side(a,b),opposite={op:"or",args:[direction,side(b,a)]};
  if(!isDeepStrictEqual(result,{op:"if",args:[direction,get(b),get(a)]})||
    !isDeepStrictEqual(quantity,{op:"if",args:[direction,negative(a),negative(b)]}))return false;
  return e.valid.args.some((v:Data)=>v?.op==="sameAddress"&&requiredAddress(v,"$log.address")[0]===owner)&&
    e.valid.args.some((v:Data)=>isDeepStrictEqual(v,opposite));
}
/** Positive scoped activity, not SQL discovery/attestation. Every emitted ID
 * belongs to this emitting address. Even a match cannot exclude other touched
 * pools or unlogged changes; null commands no narrowing at all. */
export function createSqlEdgePriceLogScopes(definitions:readonly SelectorNativeExecutionDefinition[]){
  type Read=(l:DeclarativeEventLog)=>string|null;
  const index=new Map<string,Read[]>();
  type LedgerCodec=ReturnType<typeof compileDeclarativeEventCodec>;
  const custody=new Map<string,Map<string,{codec:LedgerCodec;abi:string}>|null>();
  // Conflicting or absent declarations from another program pinned to this
  // manager must also veto the independent path, even without a reader for
  // this topic from that program. Old (valid trade) processing is unchanged.
  const physicalConsensus=new Map<string,string|null>();
  // State-only declarations never enter SQL discovery/nomination, pricing or execution.
  const stateOnly=new Map<string,Read>(),existingObservation=new Set<string>();
  const sourcePhysical=new Map<string,Read>();
  for(const def of definitions)for(const p of selectorExecutionPrograms(def)){
    // A declaration cannot grant itself ownership of a manager by name. The
    // executable venue and resource must share the same independently pinned
    // manager. Undeclared/conflicting programs for that owner stay broad.
    const manager=path((p.routes?.venue as Data|undefined)?.manager);
    const sourceManager=def.directState?.poolId&&literal(def.managerCustody?.manager);
    const pins=sourceManager?[sourceManager]:manager?emitters(p,{}):[];
    if(pins.length===1){
      const owner=pins[0]!,c=def.managerCustody,prior=custody.get(owner);
      const activity=selectorPhysicalPoolActivity(c);
      const shape=JSON.stringify([...(c?.physicalPoolEvents??[]).map(p=>[EventFragment.from(p.signature).format("full"),p.indexedPoolId,false]),
        ...activity.map(p=>[EventFragment.from(p.signature).format("full"),p.indexedPoolId,true])].sort());
      const priorShape=physicalConsensus.get(owner);
      physicalConsensus.set(owner,priorShape===undefined||priorShape===shape?shape:null);
      if(sourceManager&&c)for(const e of [...(c.physicalPoolEvents??[]),...activity]){
        const codec=compileDeclarativeEventCodec({signature:e.signature}),k=owner+'/'+codec.topic!.toLowerCase();
        if(!sourcePhysical.has(k))sourcePhysical.set(k,l=>{
          const id=codec.decode(l)[e.indexedPoolId];
          return typeof id==='string'&&/^0x[0-9a-f]{64}$/i.test(id)?id.toLowerCase():null;
        });
      }
      for(const event of (p.observations?.events??[]) as Data[]){
        if(typeof event.signature==="string")existingObservation.add(owner+"/"+EventFragment.from(event.signature).topicHash.toLowerCase());
      }
      const nominee=p.binding?.nomination?.poolIdLogs;
      if(Array.isArray(nominee))for(const rule of nominee)if(typeof rule?.topic==="string")existingObservation.add(owner+"/"+rule.topic.toLowerCase());
      for(const e of activity)if(c&&literal(c.manager)===owner){
        const codec=compileDeclarativeEventCodec({signature:e.signature}),k=owner+"/"+codec.topic!.toLowerCase();
        if(!stateOnly.has(k))stateOnly.set(k,l=>{
          const id=codec.decode(l)[e.indexedPoolId];
          return typeof id==="string"&&/^0x[0-9a-f]{64}$/i.test(id)?id.toLowerCase():null;
        });
      }
      if(!c||literal(c.manager)!==owner||prior===null)custody.set(owner,null);
      else {
        const codecs=new Map(c.ledgerEvents.map(s=>{const codec=compileDeclarativeEventCodec({signature:s});return [codec.topic!.toLowerCase(),{codec,abi:EventFragment.from(s).format("full")}] as const;}));
        if(prior!==undefined&&(prior.size!==codecs.size||[...prior].some(([t,v])=>codecs.get(t)?.abi!==v.abi)))custody.set(owner,null);
        else custody.set(owner,codecs);
      }
    }
    const nominations=p.binding?.nomination?.poolIdLogs;
    if(!Array.isArray(nominations)||!Array.isArray(p.observations?.events))continue;
    let values:ReturnType<typeof compileDeclarativeValues>|undefined;
    for(const e of p.observations!.events as Data[]){
      if(typeof e.signature!=="string"||e.receiptMode==="unresolved"||!e.payload?.poolId)continue;
      const fragment=EventFragment.from(e.signature),topic=fragment.topicHash.toLowerCase();
      if(fragment.anonymous)continue;
      const pins=emitters(p,e);if(pins.length!==1)continue;
      // The same slot/target relationship must appear independently in the
      // nomination schema and in the typed event payload. A convenient bytes32
      // (e.g. salt, order hash, position key) is not itself a pool ID.
      const rules=nominations.filter((n:Data)=>n.emitter==="call-target"&&n.topic?.toLowerCase()===topic);
      if(!rules.length)continue;
      const key=pins[0]+"/"+topic,readers=index.get(key)??[];index.set(key,readers);
      const f=fragment.inputs.filter(x=>x.indexed),arg=path(e.payload.poolId);
      const slots=new Set<number>(rules.map((n:Data)=>n.topicIndex));
      const slot=[...slots][0]!,param=f[slot-1];
      if(slots.size!==1||!Number.isSafeInteger(slot)||slot<1||param?.type!=="bytes32"||!param.name||arg!=="$args."+param.name){
        readers.push(()=>null);continue;
      }
      const declaredPool=path(e.pool),binding=e.poolBinding;
      if(declaredPool!==arg&&declaredPool!=="$log.address"||
        binding&&(path(binding.id)!==path((p.routes?.venue as Data)?.poolId)||path(binding.emitter)!==path((p.routes?.venue as Data)?.manager))){
        readers.push(()=>null);continue;
      }
      const codec=compileDeclarativeEventCodec({signature:e.signature});
      const independent=hasIndependentPoolId(def.managerCustody,pins[0]!,fragment,param.name,e);
      values??=compileDeclarativeValues({abi:{},constants:{},expressions:{},...p.values});
      const evals=values;
      readers.push(log=>{
        const env={log,args:codec.decode(log)};
        if(!(independent&&custody.get(pins[0]!)&&physicalConsensus.get(pins[0]!))&&
          e.valid!==undefined&&evals.evaluate(e.valid,env)!==true)return null;
        const id=evals.evaluate(e.payload.poolId,env),pool=evals.evaluate(e.pool,env);
        if(typeof id!=="string"||!/^0x[0-9a-fA-F]{64}$/.test(id)||id.toLowerCase()!==log.topics[slot]?.toLowerCase())return null;
        if(typeof pool!=="string"||pool.toLowerCase()!==(declaredPool===arg?id.toLowerCase():log.address.toLowerCase()))return null;
        return id.toLowerCase();
      });
    }
  }
  // Resolve ABI ownership and collisions at registration time. An event that
  // names a pool goes through the same (emitter, decoded pool ID) path whether
  // or not it is also evidence of a trade. Neither the event name nor its fee
  // fields have any say in price refresh.
  for (const [key, decodeId] of stateOnly) {
    const [owner, topic] = key.split("/");
    const agreed = !!owner && !!topic && !!physicalConsensus.get(owner) && !!custody.get(owner) &&
      !custody.get(owner)?.has(topic) && !index.has(key) && !existingObservation.has(key);
    index.set(key, [agreed ? decodeId : () => null]);
  }
  // Source declarations name the physical event field directly. They no
  // longer need discovery nomination/getter machinery to select pool IDs.
  for(const [key,decode] of sourcePhysical){
    const [owner,topic]=key.split('/');
    const agreed=!!owner&&!!topic&&!!physicalConsensus.get(owner)&&!!custody.get(owner)&&!custody.get(owner)?.has(topic);
    index.set(key,[...(index.get(key)??[]),agreed?decode:()=>null]);
  }
  const read=(log:DeclarativeEventLog):readonly string[]|null=>{
    if(!log||typeof log.data!=="string"||log.data.length>131074||!Array.isArray(log.topics)||log.topics.length<1||log.topics.length>4||
      !log.topics.every(t=>typeof t==="string"&&/^0x[0-9a-fA-F]{64}$/.test(t)))return null;
    const a=literal(log.address);if(!a)return null;
    const topic=log.topics[0]!.toLowerCase(),readers=index.get(a+"/"+topic);
    const ledger=custody.get(a)?.get(topic);
    if(ledger){
      // A conflicting priced event or malformed receipt is not evidence of
      // settlement. [] means proven zero logical IDs; null means unknown.
      if(readers)return null;
      try{ledger.codec.decode(log);return [];}catch{return null;}
    }
    if(!readers)return null;
    try{
      const found=new Set(readers.map(read=>read(log)));
      if(found.size!==1)return null;const first=[...found][0];return first?[first]:null;
    }catch{return null;}
  };
  return Object.assign(read,{settlementBalanceOnly:(owner:string)=>!!custody.get(owner.toLowerCase())});
}
