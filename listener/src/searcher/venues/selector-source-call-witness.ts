import { readFile } from 'node:fs/promises';
import { readCanonicalSqlWitnessTransaction, type WitnessMethod } from './selector-sql-call-witness.js';
import type { CanonicalSource } from './adapter-request-program.js';
import type { SqlLiveEdgeCoordinates as Edge } from './selector-native-sql-live-binding.js';
import {readSelectorDiscoveryRuleHash} from './selector-discovery-rule-hash.js';
import {createHash} from 'node:crypto';
import {normalizeSelectorNativeExecutionDefinition,freezeSelectorNative} from './selector-native-definition.js';
import {compileSqlExecutionParamPlan} from './selector-native-execution-param-plan.js';

type SourceRpc={send:(method:WitnessMethod|'debug_traceTransaction',params:unknown[],signal?:AbortSignal)=>Promise<unknown>};
type Locator={readonly txHash:string;readonly callPath:string;readonly edge:Edge;readonly source:CanonicalSource;readonly signal?:AbortSignal};
export type VerifiedSelectorSourceCall=Readonly<{
  chainId:1;txHash:string;callPath:string;blockNumber:number;blockHash:string;selector:string;poolAddress:string;poolId:string|null;
  tokenIn:string;tokenOut:string;actor:string;calldata:string;receiptIndices:readonly number[];amountIn:string;amountOut:string;
  discoveryRuleHash:string;
  poolNamespace:string|null;executionParamEvidence:unknown;
}>;
const issued=new WeakMap<VerifiedSelectorSourceCall,CanonicalSource>();
const address=/^0x[0-9a-f]{40}$/, hash=/^0x[0-9a-f]{64}$/, bytes=/^0x(?:[0-9a-f]{2})*$/;
function need(ok:unknown,reason:string):asserts ok{if(!ok)throw Error('selector source witness: '+reason);}
function record(v:unknown):Record<string,any>{need(v&&typeof v==='object'&&!Array.isArray(v),'invalid RPC object');return v as Record<string,any>;}
function nat(x:unknown){need((typeof x==='string'&&/^0x[0-9a-f]+$/.test(x))||typeof x==='number','missing trace log coordinate');const n=Number(x);need(Number.isSafeInteger(n)&&n>=0,'invalid trace log coordinate');return n;}
type Frame={path:string;kind:string;sender:string;target:string;input:string;paramInput:string;output:string|null;value:string;ok:boolean};
type FlatLog={idx:number;emitter:string;topics:string[];data:string};

// Match ALL committed logs in actual execution order (not by token or amount). A delegate emits
// for its enclosing CALL. Geth's position is the number of finished children; index is optional.
function traceInputs(raw:unknown,tx:Record<string,any>,rc:Record<string,any>){
  const frames:Frame[]=[],owners=new Map<number,string>(),logs:FlatLog[]=rc.logs.map((l:any)=>({idx:Number(l.logIndex),emitter:l.address,topics:l.topics,data:l.data}));
  let next=0,relative=true,absolute=true;
  function walk(v:unknown,path:string,ancestorOk:boolean,ancestorOwner:Frame|null,depth:number){
    const n=record(v);need(depth<=256&&frames.length<32768&&typeof n.type==='string','invalid trace shape');
    const kind=n.type.toLowerCase(),sender=n.from,target=n.to,input=n.input??'0x',output=n.output??null;
    need(['call','delegatecall','callcode','staticcall','create','create2','selfdestruct'].includes(kind)&&address.test(sender)&&
      address.test(target)&&typeof input==='string'&&input.length<=524290&&bytes.test(input)&&
      (output===null||(typeof output==='string'&&output.length<=524290&&bytes.test(output))),'malformed trace frame');
    const ok=ancestorOk&&!n.error;
    const value=String(n.value??'0x0');need(/^0x[0-9a-f]+$/.test(value),'invalid trace value');
    const f={path,kind,sender,target,input,paramInput:input,output,value,ok};frames.push(f);
    const owner=kind==='delegatecall'||kind==='callcode'?ancestorOwner:f;
    const childs=n.calls??[],events=n.logs??[];need(Array.isArray(childs)&&Array.isArray(events)&&events.length<=logs.length,'malformed trace children/logs');
    let j=0;
    for(let i=0;i<=childs.length;i++){
      while(j<events.length&&nat(events[j].position)===i){
        const l=record(events[j++]),r=logs[next];
        need(ok&&owner&&r&&r.emitter===owner.target&&r.emitter===l.address&&r.data===l.data&&Array.isArray(l.topics)&&
          r.topics.length===l.topics.length&&r.topics.every((t,k)=>t===l.topics[k]),'frame log disagrees with ordered canonical receipt');
        if(l.index!==undefined){const idx=nat(l.index);relative&&=idx===next;absolute&&=idx===r.idx;need(relative||absolute,'trace log index disagrees with receipt');}
        owners.set(r.idx,owner.path);next++;
      }
      if(i<childs.length)walk(childs[i],path===''?String(i):`${path},${i}`,ok,owner,depth+1);
    }
    need(j===events.length,'invalid or out-of-order trace log position');
  }
  const root=record(raw);need(root.type==='CALL'&&!root.error&&root.from===tx.from&&root.to===tx.to&&root.input===tx.input&&
    BigInt(root.value??'0x0')===BigInt(tx.value),'trace root differs from included transaction');
  walk(root,'',true,null,0);need(next===logs.length,'withLog is missing receipt logs');return {frames,logs,owners};
}

type Discovered={selector:string;callPath:string;innerSwapPath?:string|null;poolAddress:string;poolId:string|null;tokenIn:string;tokenOut:string;receiptIndices:string;amountPayerInRaw?:string;amountReceivedOutRaw?:string;paramPayload?:string|null};
// Resolve from the release root, for either listener/src or listener/dist. Never import a path from SQL.
const release=new URL('../../../../',import.meta.url);
async function recognizer(selector:string){
  const family=new URL('listener/src/searcher/venues/selector-native/selector-'+selector.slice(2)+'-family/',release);
  const [definition,rule,kernel]=await Promise.all([readFile(new URL('selector-'+selector.slice(2)+'.json',family),'utf8').then(JSON.parse),
    readFile(new URL('edge-discovery.json',family),'utf8').then(JSON.parse),import(new URL('scripts/selector-family-event-discovery.mjs',release).href)]);
  need(definition.selector===selector,'Family discovery owner differs');
  const discoveryRuleHash=await readSelectorDiscoveryRuleHash(family,new URL('scripts/',release));
  need(definition.directState?.discoveryRuleHash===discoveryRuleHash,'Family discovery rule differs from the source execution capability');
  const module=rule.type==='familyModule'?{[selector]:(await import(new URL('discover.mjs',family).href)).discover}:{};
  const d=normalizeSelectorNativeExecutionDefinition(definition),params=await import(new URL('scripts/selector-execution-param-observation.mjs',release).href);
  const plan={...compileSqlExecutionParamPlan(d),definitionSha256:createHash('sha256').update(JSON.stringify(d)).digest('hex')};
  return {discoveryRuleHash,poolNamespace:d.directState?.poolNamespace??null,
    find:(frames:Frame[],logs:FlatLog[]):Discovered[]=>params.annotateExecutionParams(kernel.discoverFamilyEventEdges(frames,logs,{[selector]:rule},module),frames,{[selector]:plan})};
}
// Only release code is cached. Every chain witness is independently pinned to
// its requested source below; this cache grants no historical/reorg reuse.
// Running releases are immutable, and a different release has a new module URL.
const methods=new Map<string,ReturnType<typeof recognizer>>();
function coordinateMatch(x:VerifiedSelectorSourceCall,e:Edge){return e.chainId===x.chainId&&e.selector===x.selector&&
  e.poolAddress===x.poolAddress&&(e.poolId??null)===x.poolId&&(e.poolNamespace==null||e.poolNamespace===x.poolNamespace)&&e.tokenIn===x.tokenIn&&e.tokenOut===x.tokenOut&&e.tokenInId==null&&e.tokenOutId==null;}
export function assertVerifiedSelectorSourceCall(proof:VerifiedSelectorSourceCall,ref:{edge:Edge;source:CanonicalSource;discoveryRuleHash?:string}){
  const pin=issued.get(proof);need(pin&&pin.number===ref.source.number&&pin.hash===ref.source.hash&&pin.generation===ref.source.generation&&coordinateMatch(proof,ref.edge),
    'unissued, mismatched or stale source witness');
  if(ref.discoveryRuleHash!==undefined)need(/^[0-9a-f]{64}$/.test(ref.discoveryRuleHash)&&proof.discoveryRuleHash===ref.discoveryRuleHash,
    'source witness uses another Family discovery rule');
}
/** The SQL reference only locates a mined transaction. Asset/recipe claims in the row do not enter discovery. */
export function createSelectorSourceCallWitnessReader(rpc:SourceRpc){
  return async({txHash,callPath,edge,source,signal}:Locator):Promise<VerifiedSelectorSourceCall>=>{
  need(edge.chainId===1&&/^0x[0-9a-f]{8}$/.test(edge.selector)&&hash.test(txHash)&&typeof callPath==='string'&&callPath.length<=4096&&
    /^(?:|(?:0|[1-9]\d*)(?:,(?:0|[1-9]\d*))*)$/.test(callPath)&&Number.isSafeInteger(source.number)&&source.number>=0&&hash.test(source.hash)&&
    Number.isSafeInteger(source.generation)&&source.generation>=0,'invalid source or locator');signal?.throwIfAborted();
  const raw=await rpc.send('debug_traceTransaction',[txHash,{tracer:'callTracer',tracerConfig:{withLog:true}}],signal);
  const {tx,rc,n}=await readCanonicalSqlWitnessTransaction(rpc,txHash,signal);
  need(n<=source.number&&(n!==source.number||tx.blockHash===source.hash),'future or noncanonical source');
  const {frames,logs,owners}=traceInputs(raw,tx,rc),action=frames.find(f=>f.path===callPath);
  need(action?.ok&&action.kind==='call'&&action.input.startsWith(edge.selector),'wrong or failed execution frame');
  if(!methods.has(edge.selector))methods.set(edge.selector,recognizer(edge.selector));
  const {find,discoveryRuleHash,poolNamespace}=await methods.get(edge.selector)!,matches=find(frames,logs).filter(r=>r.callPath===callPath&&
    r.poolAddress===edge.poolAddress&&(r.poolId??null)===(edge.poolId??null)&&r.tokenIn===edge.tokenIn&&r.tokenOut===edge.tokenOut);
  need(matches.length===1,'absent or ambiguous independently discovered action');const [r]=matches;
  need(r!.selector===edge.selector&&r!.poolAddress===action.target&&typeof r!.receiptIndices==='string'&&
    /^[1-9]\d*$/.test(r!.amountPayerInRaw??'')&&/^[1-9]\d*$/.test(r!.amountReceivedOutRaw??''),'missing action, debit or receipt');
  const ids=r!.receiptIndices.split(',').map(Number),subtree=(p:string)=>p===callPath||callPath===''||p.startsWith(callPath+',');
  need(ids.length>0&&new Set(ids).size===ids.length,'missing or repeated receipt evidence');
  // For a selected route do not accept inference across multiple same-address CALLs. This
  // restriction is narrower than discovery: only a uniquely identifiable emitter in THIS
  // action may justify current admission. Delegate/implementation frames share its owner.
  for(const id of ids){const log=logs.find(l=>l.idx===id),owner=owners.get(id);
    need(log&&owner!==undefined&&subtree(owner),'receipt belongs to another action');
    const plausible=frames.filter(f=>f.ok&&subtree(f.path)&&f.target===log.emitter&&['call','create','create2'].includes(f.kind));
    need(plausible.length===1&&plausible[0]!.path===owner,'ambiguous or mismatched receipt-emitting frame');}
  need(r!.paramPayload,'missing independently reconstructed execution parameters');
  const executionParamEvidence=freezeSelectorNative({consensus:'uniform',...JSON.parse(r!.paramPayload),txHash,callPath,innerSwapPath:r!.innerSwapPath??null});
  const proof=Object.freeze({chainId:1 as const,txHash,callPath,blockNumber:n,blockHash:String(tx.blockHash),selector:r!.selector,poolAddress:r!.poolAddress,
    poolId:r!.poolId??null,tokenIn:r!.tokenIn,tokenOut:r!.tokenOut,actor:action.sender,calldata:action.input,receiptIndices:Object.freeze(ids),
    amountIn:r!.amountPayerInRaw!,amountOut:r!.amountReceivedOutRaw!,discoveryRuleHash,poolNamespace,executionParamEvidence});
  need(coordinateMatch(proof,edge),'edge differs from independent action');signal?.throwIfAborted();issued.set(proof,Object.freeze({...source}));return proof;
};}
