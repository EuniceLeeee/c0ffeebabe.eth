import { FunctionFragment, Interface, ZeroAddress, getAddress, keccak256 } from "ethers";
import { types } from "node:util";
import { getEthersCallRpcError } from "../rpc-throttle-guard.js";
import type { CanonicalSource } from "./adapter-request-program.js";
import { assertDeclarativeExecutionSource } from "./declarative-execution.js";
import { compileDeclarativeReadFlow } from "./declarative-read-flow.js";
import { RUNTIME_ERC20 } from "./runtime-execution.js";
import { selectorNativeProgramKey, type SelectorNativeExecutionDefinition, type SelectorNativeProgram } from "./selector-native-definition.js";
import { createSelectorNativeRuntime } from "./selector-native-runtime.js";

interface Edge {
  readonly selector: string; readonly poolAddress: string; readonly tokenIn: string; readonly tokenOut: string;
  readonly poolId?: string | null; readonly poolNamespace?: string | null;
  readonly tokenInId?: string | null; readonly tokenOutId?: string | null;
}
interface EdgePriceInput {
  readonly edge: Edge; readonly definition: SelectorNativeExecutionDefinition; readonly source: CanonicalSource;
  readonly executor: string; readonly transactionOrigin: string;
  /** The caller must pin every read to source.hash, requireCanonical=true. */
  readonly read: (to: string,data: string) => Promise<string>;
  /** Optional token runtime reads for recipes that model token transfers. Same pin as read(). */
  readonly readCode?: (token:string) => Promise<string>;
  /** Retain original source-pinned read bytes for the formal price publication. */
  readonly captureBinding?: boolean;
}
type Row=Record<string,any>;
export interface SqlLiveBindingReceipt {
  readonly format:"sql-edge-pinned-reads/v1"; readonly source:CanonicalSource;
  readonly selector:string; readonly poolAddress:string; readonly tokenIn:string; readonly tokenOut:string;
  readonly executor:string; readonly transactionOrigin:string; readonly programKey:string; readonly programHash:string;
  readonly calls:readonly (readonly [string,string])[]; readonly code:readonly (readonly [string,string])[];
}
type Leg={ programKey: string; program: string; bindingReceipt?: SqlLiveBindingReceipt };
const address=(a:string)=>getAddress(a).toLowerCase();
function need(ok:unknown,message:string):asserts ok { if(!ok)throw new Error(message); }
function ref(x:any):string|undefined {
  if(typeof x==="string"&&x.startsWith("$"))return x;
  if(x?.op==="get"&&typeof x.args[1]==="string"){const p=ref(x.args[0]);return p&&p+"."+x.args[1];}
  if(["lower","address"].includes(x?.op)&&x.args.length===1)return ref(x.args[0]);
  return undefined;
}
const hasRef=(x:any,path:string):boolean=>ref(x)===path||!!x&&typeof x==="object"&&Object.values(x).some(v=>hasRef(v,path));
const only=(x:Row,...keys:string[])=>x&&typeof x==="object"&&!Array.isArray(x)&&Object.keys(x).every(k=>keys.includes(k));
function getterDecoder(expr:any,alias:string,signature:string,id:string){
  const wrappers:string[]=[];
  while(["lower","address","number"].includes(expr?.op)&&expr.args.length===1){wrappers.push(expr.op);expr=expr.args[0];}
  const a=expr?.args;
  need(expr?.op==="decode"&&a.length===4&&a[0]===alias&&a[1]===signature&&a[3]===0&&
    a[2]?.op==="get"&&a[2].args[1]==="data"&&a[2].args[0]?.op==="returned"&&a[2].args[0].args[0]===id,"unbound getter decoder");
  return wrappers.reduceRight<unknown>((value,op)=>({op,args:[value]}),"$decoded");
}
function shape(def:SelectorNativeExecutionDefinition,p:SelectorNativeProgram){
  const binding=p.binding, routes=p.routes, exec=p.execution;
  need(def.domain==="swap"&&exec&&!p.parameters&&!p.runtimeEvidence&&!p.state&&!p.context&&!p.receiptChecks&&!p.ethCall&&!p.dependencies&&!p.payment,
    "requires signed, observed, stateful or non-direct execution evidence");
  need(binding&&only(binding,"facts","descriptor","flow","nomination")&&only(binding.facts as Row),"requires additional binding or identity evidence");
  need(routes&&!routes.resources&&only(routes.venue as Row,"kind","pool")&&(routes.venue as Row).kind==="address-pool",
    "not a single address-pool execution resource");
  const venue=routes.venue as Row;
  const poolField=ref(routes.target);need(poolField&&/^\$descriptor\.\w+$/.test(poolField)&&ref(venue.pool)===poolField&&
    (!routes.resource||only(routes.resource as Row,"target")&&ref((routes.resource as Row).target)===poolField),"unbound physical resource");
  const dirs=routes.directions;need(Array.isArray(dirs)&&dirs.length===2&&dirs.every(d=>d.enabled===true&&!d.executionAssets&&
    d.tokenInId==null&&d.tokenOutId==null&&d.fields&&!["tokenIn","tokenOut","tokenInId","tokenOutId","poolId","poolNamespace",
      "executionAssets","resource","resources","venue","target","routeKey","direction","adapterId"].some(k=>Object.hasOwn(d.fields,k))&&
    only(d,"id","enabled","tokenIn","tokenOut","taxonomy","fields")&&d.taxonomy?.slotKind==="swap"),"unproven directional or native asset semantics");
  const f0=ref(dirs[0].tokenIn),f1=ref(dirs[0].tokenOut);
  need(f0&&f1&&f0!==f1&&[f0,f1].every(s=>/^\$descriptor\.\w+$/.test(s))&&ref(dirs[1].tokenIn)===f1&&ref(dirs[1].tokenOut)===f0,"pair not independently bound");
  const descriptor=binding.descriptor as Row,fields=descriptor?.op==="merge"&&descriptor.args.length===1?descriptor.args[0]:descriptor;
  need(ref(fields?.[poolField.split(".")[1]!])==="$target","descriptor does not bind the SQL pool");
  // The only state-changing top-level calls allowed by this profile are the
  // registered entry at this pool and transfer of the exact input to this pool.
  // All pricing calls/math, callback checks, reserve readings and fees stay in
  // the Family's actual production runtime; none is inferred from selector.
  const fn=FunctionFragment.from(def.signature);
  const entry=(call:Row|undefined)=>call&&ref(call.target)===poolField&&!call.value&&
    FunctionFragment.from(call.signature).format("sighash")===fn.format("sighash");
  const math=(s:Row)=>only(s,"id","when","math")&&s.math;
  const staticRead=(s:Row)=>only(s,"id","when","static","call")&&s.static===true&&s.call&&!s.call.value&&
    [poolField,"$route.tokenIn","$route.tokenOut"].includes(ref(s.call.target)??"")&&["view","pure"].includes(FunctionFragment.from(s.call.signature).stateMutability);
  const payment=(call:Row)=>ref(call.target)==="$route.tokenIn"&&!call.value&&FunctionFragment.from(call.signature).format("sighash")===RUNTIME_ERC20.getFunction("transfer")!.format("sighash")&&
    call.args?.length===2&&ref(call.args[0])===poolField&&only(call.args[1],"runtime")&&call.args[1].runtime==="amountIn";
  need(exec.version===2&&exec.requireCanonicalSource===true&&!exec.quoteOutput&&Array.isArray(exec.steps)&&exec.steps.length>0&&
    exec.steps.every((s:Row)=>math(s)||staticRead(s)||s.frame&&only(s,"id","when","frame")&&s.frame.callback&&entry(s.frame.call)||
      only(s,"id","when","call")&&s.call&&(entry(s.call)||payment(s.call))),"unsupported entry, funding, or callback target");
  const entries:Row[]=exec.steps.filter((s:Row)=>!s.static&&entry(s.frame?.call??s.call));
  need(entries.length>0&&(!p.quoteOutput||p.quoteOutput.version===1&&Array.isArray(p.quoteOutput.steps)&&
    p.quoteOutput.steps.every((s:Row)=>math(s)||staticRead(s))),"missing entry or unsupported in-VM pricing recipe");
  const flow=binding.flow,steps=flow?.steps;
  need(flow&&Array.isArray(steps)&&[1,2].includes(steps.length)&&Array.isArray(steps[0].requests)&&!steps[0].decode&&steps[0].result&&!steps[0].when,"needs other data than independent pool fields");
  const step=steps[0],getters=new Map<string,{abi:Interface;fn:FunctionFragment;project:unknown}>();
  for(const r of step.requests){
    need(only(r,"id","to","kind","data","completion")&&r.kind==="eth-call"&&r.completion==="return-data"&&ref(r.to)==="$target"&&r.data?.op==="encode","not a direct pool field read");
    const [alias,signature,args]=r.data.args,decl=p.values?.abi?.[alias];need(typeof signature==="string"&&Array.isArray(args)&&!args.length&&
      Array.isArray(decl)&&decl.length===1,"not a declared argument-free getter");
    const fn=FunctionFragment.from(decl[0]),name=fn.name,out=fn.outputs[0]?.type,path="$descriptor."+name;
    need(fn.format("sighash")===signature&&fn.inputs.length===0&&["view","pure"].includes(fn.stateMutability)&&fn.outputs.length===1&&
      !getters.has(r.id)&&flow.result?.[step.id]?.[name]==="$steps."+step.id+"."+name&&
      fields[name]==="$binding."+step.id+"."+name,"unbound or non-scalar pool field");
    // Address reads may resolve only the two directed assets. Numeric reads must
    // both govern a declared route check and populate a field on each route.
    // In particular, no read for factory membership, provenance, or code identity.
    need(out==="address"?[f0,f1].includes(path):!!out&&/^u?int\d+$/.test(out)&&hasRef(routes.checks,path)&&
      dirs.every(d=>ref(d.fields[name])===path),"additional getter is not a pair asset or required numeric route field");
    getters.set(r.id,{abi:new Interface([fn]),fn,project:getterDecoder(step.result[name],alias,signature,r.id)});
  }
  const names=new Set([...getters.values()].filter(({fn})=>fn.outputs[0]?.type==="address").map(({fn})=>"$descriptor."+fn.name));
  need(names.size===2&&names.has(f0)&&names.has(f1),"both directed assets must come from pool reads");
  need(Object.keys(step.result).length===getters.size&&only(flow.result,...steps.map((s:Row)=>s.id))&&Object.keys(flow.result[step.id]).length===getters.size,"requires additional derived binding data");
  const codeFields:{key:string;assetField:string}[]=[];
  const next=steps[1];
  if(next){
    need(!next.decode&&!next.when&&Array.isArray(next.requests)&&next.requests.length===2&&next.result&&
      Object.keys(next.result).length===2&&Object.keys(flow.result[next.id]??{}).length===2,"not a two-asset transfer-model code projection");
    for(const [key,val] of Object.entries(next.result) as [string,Row][]){
      const rr=next.requests.filter((r:Row)=>r.id===val.args?.[0]);
      need(val.op==="code"&&val.args.length===1&&rr.length===1&&only(rr[0],"id","kind","address")&&rr[0].kind==="get-code"&&
        flow.result[next.id][key]==="$steps."+next.id+"."+key&&hasRef(fields,"$binding."+next.id+"."+key),"not a declared token code field");
      const asset=[...names].map(s=>s.slice("$descriptor.".length)).find(a=>ref(rr[0].address)==="$steps."+step.id+"."+a);
      need(asset&&!codeFields.some(f=>f.assetField===asset),"code target is not a unique directed pool asset");
      codeFields.push({key,assetField:asset});
    }
  }
  const rt=createSelectorNativeRuntime(def,p);
  return {rt,flow:compileDeclarativeReadFlow(flow,rt.values),getters,codeFields,entries};
}
type CompiledShape={key:string; compiled:ReturnType<typeof shape>} | {key:string; issue:string};
interface RegistryPlan {selector:string; programs:Map<SelectorNativeProgram,CompiledShape>}
const frozenPlans=new WeakMap<SelectorNativeExecutionDefinition,RegistryPlan>();
// normalizeSelectorNativeExecutionDefinition returns recursively frozen JSON.
// Checking only the top object would let a test fixture mutate a cached route.
// Accessors, proxies and containers with mutable internal slots are not JSON.
function immutableJson(v:unknown,seen=new Set<object>()):boolean {
  if(v===null||["string","number","boolean"].includes(typeof v))return true;
  if(typeof v!=="object"||types.isProxy(v)||!Object.isFrozen(v))return false;
  if(seen.has(v))return true;
  if(![null,Object.prototype,Array.prototype].includes(Object.getPrototypeOf(v)))return false;
  seen.add(v);
  return Reflect.ownKeys(v).every(k=>{
    const d=Object.getOwnPropertyDescriptor(v,k);
    return typeof k==="string"&&!!d&&Object.hasOwn(d,"value")&&immutableJson(d.value,seen);
  });
}
function registryPlan(def:SelectorNativeExecutionDefinition):RegistryPlan {
  const prior=frozenPlans.get(def);if(prior)return prior;
  const plan={selector:FunctionFragment.from(def.signature).selector,programs:new Map<SelectorNativeProgram,CompiledShape>()};
  if(immutableJson(def))frozenPlans.set(def,plan); // otherwise this invocation owns the plan
  return plan;
}
function programShape(plan:RegistryPlan,def:SelectorNativeExecutionDefinition,p:SelectorNativeProgram):CompiledShape {
  const prior=plan.programs.get(p);if(prior)return prior;
  const key=selectorNativeProgramKey(p);let compiled:CompiledShape;
  try{compiled={key,compiled:shape(def,p)};}catch(e){compiled={key,issue:e instanceof Error?e.message:"unsupported template"};}
  // shape() examines only immutable declaration content. The caller's block,
  // edge, authority, field values, errors and receipts never enter this cache.
  plan.programs.set(p,compiled);return compiled;
}
class ReadInfrastructure {constructor(readonly cause:unknown){}}
/** Only an independently evidenced address pair is eligible to nominate a
 * direction without a transaction. Uses precisely the compiler's shape checks. */
export function hasSqlPairBinding(def:SelectorNativeExecutionDefinition,p:SelectorNativeProgram):boolean {
  return "compiled" in programShape(registryPlan(def),def,p);
}
function reverted(err:unknown){
  const e=(getEthersCallRpcError(err)??err) as Row|undefined;
  if(!e||typeof e!=="object"||e.status>=400||e.statusCode>=400||e.cause)return false;
  const data=typeof e.data==="string"&&/^0x(?:[a-f0-9]{2})*$/i.test(e.data);
  return e.code===3||e.code==="CALL_EXCEPTION"&&data||e.code===-32000&&data&&/^execution reverted\b/i.test(e.message)||
    e.code==null&&e.message==="execution reverted";
}
// This returns trial programs, not an attestation, a quote, or authorization to
// execute. Multiple viable variants remain separate for pinned read-only simulation.
export async function compileEdgePriceLegs(input:EdgePriceInput):Promise<{legs:Leg[];issues:string[]}> {
  const {edge,definition,source,read}=input;
  assertDeclarativeExecutionSource(source);
  const executor=address(input.executor),transactionOrigin=address(input.transactionOrigin);
  need(executor!==ZeroAddress&&transactionOrigin!==ZeroAddress,"missing caller authority");
  const issues:string[]=[],legs:Leg[]=[],invalid=(reason:string)=>({legs:[],issues:[reason]});
  const plan=registryPlan(definition);
  if(edge.selector!==definition.selector||plan.selector!==edge.selector)return invalid("edge selector differs from declared entry");
  if(definition.unsupportedReason||!definition.programs.length)return invalid("no executable template for selector");
  if([edge.poolId,edge.poolNamespace,edge.tokenInId,edge.tokenOutId].some(v=>v!=null))return invalid("logical pool, namespace or token IDs require another projection");
  let target:string,tokenIn:string,tokenOut:string;
  try{target=address(edge.poolAddress);tokenIn=address(edge.tokenIn);tokenOut=address(edge.tokenOut);}catch{return invalid("invalid edge address");}
  if([target,tokenIn,tokenOut].includes(ZeroAddress)||new Set([target,tokenIn,tokenOut,executor]).size!==4)return invalid("native or non-distinct address-pair inputs");
  const scope={tokenIn,tokenOut},ctx={target,scope,source,executor,transactionOrigin},cache=new Map<string,string>(),codes=new Map<string,string>();
  for(const p of definition.programs){
    const info=programShape(plan,definition,p),key=info.key;
    if("issue" in info){issues.push(key+": "+info.issue);continue;}
    try{
      const {rt,flow,getters,codeFields,entries}=info.compiled,start=flow.start(ctx),fieldValues:Row={};
      need(!codeFields.length||input.readCode,"requires pinned token runtime code for transfer semantics");
      for(const r of start.requests){
        const g=getters.get(r.id);
        need(r.kind==="eth-call"&&address(r.to)===target&&g&&r.data===g.fn.selector,"different getter/target after declaration evaluation");
        let raw=cache.get(r.data);
        if(raw===undefined){
          try{raw=await read(target,r.data);}catch(e){if(reverted(e))throw Error("pool getter reverted: "+r.data);throw new ReadInfrastructure(e);}
          if(typeof raw!=="string"||!/^0x(?:[a-f0-9]{2})*$/i.test(raw))throw new ReadInfrastructure(Error("invalid hex result from pinned eth_call"));
          cache.set(r.data,raw);
        }
        need(raw.length===66,"pool getter did not return one ABI word: "+r.data);
        const decoded=g.abi.decodeFunctionResult(g.fn,raw);
        need(g.abi.encodeFunctionResult(g.fn,decoded).toLowerCase()===raw.toLowerCase(),"noncanonical pool getter result");
        // The read callback returns bytes, not scheduler-owned attestation.
        // Project the verified scalar only; never manufacture a strict proof.
        fieldValues[g.fn.name]=rt.values.evaluate(g.project,{decoded:decoded[0]});
      }
      const steps:Row={[flow.stepIds[0]!]:fieldValues};
      if(codeFields.length){
        const assets=codeFields.map(f=>address(fieldValues[f.assetField]));
        need(assets.includes(tokenIn)&&assets.includes(tokenOut),"observed pair does not match the requested assets");
        const tokenCode:Row={};
        for(const [i,f] of codeFields.entries()){
          const asset=assets[i]!;let bytecode=codes.get(asset);
          if(bytecode===undefined){
            try{bytecode=await input.readCode!(asset);}catch(e){throw new ReadInfrastructure(e);}
            if(typeof bytecode!=="string"||!/^0x(?:[0-9a-f]{2})*$/i.test(bytecode))throw new ReadInfrastructure(Error("invalid hex result from pinned eth_getCode"));
            codes.set(asset,bytecode);
          }
          need(bytecode!=="0x","token had no runtime code at source");tokenCode[f.key]=bytecode;
        }
        steps[flow.stepIds[1]!]=tokenCode;
      }
      const binding=rt.values.evaluate(p.binding!.flow!.result,{...ctx,steps});
      const descriptor=rt.resources.evaluate(p.binding!.descriptor,{...ctx,binding,facts:{}});
      const env=rt.environment({...ctx,descriptor});need(address(env.target)===target,"execution target differs from pool");
      rt.resources.run(p.routes!.checks??[],env);
      const directions=rt.resources.evaluate(p.routes!.directions,env) as Row[];
      const matches=directions.filter(d=>d.enabled===true&&(!p.routes!.allowedDirections||p.routes!.allowedDirections.includes(d.id))&&
        address(d.tokenIn)===tokenIn&&address(d.tokenOut)===tokenOut);
      need(matches.length===1,"observed asset direction missing or ambiguous");
      const d=matches[0]!,route={...d.fields,...scope,direction:d.id,adapterId:rt.actionId,target};
      const full=rt.environment({...ctx,descriptor,route,runtimeEvidence:[]});
      rt.resources.run(p.routes!.assertions??[],full);rt.values.run(p.checks??[],full);
      const venue=rt.resources.evaluate(p.routes!.venue,full),resource=rt.resources.evaluate(p.routes!.resource??{target:"$target"},full);
      need(address(venue.pool)===target&&address(resource.target)===target&&!Object.hasOwn(route,"poolId")&&!Object.hasOwn(route,"tokenInId")&&!Object.hasOwn(route,"tokenOutId"),"route resource differs from SQL edge");
      need(entries.filter(s=>s.when===undefined||rt.values.evaluate(s.when,full)===true).length===1,"ambiguous execution entry for this direction");
      const leg=rt.buildRuntimeLeg({...ctx,descriptor,route,runtimeEvidence:[]});
      need(leg?.program,"production runtime declined leg");
      if(!input.captureBinding){legs.push({programKey:key,program:leg.program});continue;}
      need(input.readCode,"pinned target bytecode is required for binding capture");
      if(!codes.has(target)){
        let code:string;
        try{code=await input.readCode(target);}catch(e){throw new ReadInfrastructure(e);}
        if(typeof code!=="string"||!/^0x(?:[a-f0-9]{2})*$/i.test(code))throw new ReadInfrastructure(Error("malformed pinned bytecode"));
        need(code!=="0x","no runtime code at price target");codes.set(target,code.toLowerCase());
      }
      const usedCalls=[...getters.values()].map(g=>[g.fn.selector,cache.get(g.fn.selector)!.toLowerCase()] as const);
      const usedCode=[target,...codeFields.map(f=>address(fieldValues[f.assetField]))].map(a=>[a,codes.get(a)!.toLowerCase()] as const);
      legs.push({programKey:key,program:leg.program,bindingReceipt:{ format:"sql-edge-pinned-reads/v1", source:{...source},
        selector:edge.selector,poolAddress:target,tokenIn,tokenOut,executor,transactionOrigin,programKey:key,programHash:keccak256(leg.program),
        calls:usedCalls,code:usedCode }});
    }catch(e){
      if(e instanceof ReadInfrastructure)throw e.cause;
      issues.push(key+": "+(e instanceof Error?e.message:"unsupported template"));
    }
  }
  return {legs,issues};
}
