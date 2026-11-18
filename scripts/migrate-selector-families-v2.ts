/** Offline source migration only. Production never imports this program or v1 data. */
import { readFileSync, writeFileSync, readdirSync, mkdirSync } from "node:fs";
import { pruneOriginalSelectorProvenance } from "./selector-family-v2-prune.js";
import { dirname, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { normalizeSelectorNativeExecutionDefinition, selectorNativeProgramKey } from "../listener/src/searcher/venues/selector-native-definition.js";
import { normalizeSelectorNativeFundingDefinition } from "../listener/src/searcher/venues/selector-native-funding-definition.js";
import { hashCanonical } from "../listener/src/searcher/venues/canonical-value.js";
type Data=Record<string,any>;
const root=resolve(dirname(fileURLToPath(import.meta.url)),".."),arg=(key:string)=>{const i=process.argv.indexOf(key);return i<0?undefined:process.argv[i+1];};
const sourceRoot=arg("--source-root");if(!sourceRoot)throw new Error("--source-root must point to the archived selector-native/v1 source tree");
const sourceDir=resolve(sourceRoot,"listener/src/searcher/venues/selector-native"),destination=resolve(root,"listener/src/searcher/venues/selector-native");
const reportFile=resolve(arg("--report")??resolve(root,"scripts/selector-family-v2-migration.json"));
const clone=<T>(value:T):T=>JSON.parse(JSON.stringify(value));
const digest=(value:unknown)=>createHash("sha256").update(JSON.stringify(value)).digest("hex");
const op=(name:string,...args:any[])=>({op:name,args}),get=(name:string)=>op("get",op("returned",name),"data");
const empty=(value:any)=>value&&typeof value==="object"&&!Array.isArray(value)&&!Object.keys(value).length;
function walk(value:any,visit:(value:any)=>void):void {visit(value);if(value&&typeof value==="object")Object.values(value).forEach(item=>walk(item,visit));}
function path(value:any):string|undefined {
 if(typeof value==="string"&&value.startsWith("$"))return value;
 if(value?.op==="get"&&typeof value.args?.[1]==="string"){const base=path(value.args[0]);if(base)return base+"."+value.args[1];}
 if(["address","lower"].includes(value?.op)&&value.args?.length===1)return path(value.args[0]);
 return undefined;
}
function simplifyOwnedAssertion(value:any):any {
 if(Array.isArray(value))return value.map(simplifyOwnedAssertion);
 if(!value||typeof value!=="object")return value;
 const out=Object.fromEntries(Object.entries(value).map(([key,item])=>[key,simplifyOwnedAssertion(item)]));
 if(["eq","sameAddress"].includes(out.op)&&out.args.some((item:any)=>{const p=path(item);return p==="$route.adapterId"||p?.startsWith("$route.bindingRef.");}))return true;
 if(out.op==="and"){if(out.args.includes(false))return false;const args=out.args.filter((x:any)=>x!==true);return args.length===0?true:args.length===1?args[0]:{...out,args};}
 if(out.op==="or"){if(out.args.includes(true))return true;const args=out.args.filter((x:any)=>x!==false);return args.length===0?false:args.length===1?args[0]:{...out,args};}
 return out;
}
function compact(program:Data,notes:string[]):Data {
 const p=clone(program);p.meta={label:p.label};delete p.label;
 for(const key of ["context","state"])if(empty(p[key]))delete p[key];
 if(p.binding){
  const other=clone(p);delete other.binding.candidate;
  if(p.binding.candidate&&!JSON.stringify(other).includes('"$candidate')){delete p.binding.candidate;notes.push("Removed unused legacy candidate label/projection.");}
  if(empty(p.binding.facts))delete p.binding.facts;
  if(p.binding.descriptor&&!p.binding.descriptor.op&&path(p.binding.descriptor.target)==="$target")delete p.binding.descriptor.target;
  if(empty(p.binding.descriptor))delete p.binding.descriptor;
  if(empty(p.binding))delete p.binding;
 }
 if(p.routes){
  const originalTarget=p.routes.target??"$descriptor.target";
  if(path(p.routes.target)==="$descriptor.target")delete p.routes.target;
  if(p.routes.resource&&Object.keys(p.routes.resource).length===1&&path(p.routes.resource.target)===path(originalTarget))delete p.routes.resource;
  if(p.routes.venue&&Object.keys(p.routes.venue).every(key=>["kind","target"].includes(key))&&path(p.routes.venue.target)===path(originalTarget))delete p.routes.venue;
  if(Array.isArray(p.routes.directions)){
   if(p.routes.allowedDirections&&p.routes.directions.every((d:any)=>p.routes.allowedDirections.includes(d.id)))delete p.routes.allowedDirections;
   for(const direction of p.routes.directions)delete direction.adapterId;
  }
 }
 for(const [owner,key] of [[p,"checks"],[p.routes,"checks"],[p.routes,"assertions"]] as const)if(owner?.[key]){
  const before=JSON.stringify(owner[key]);owner[key]=owner[key].map(simplifyOwnedAssertion).filter((s:any)=>s.assert!==true);
  if(JSON.stringify(owner[key])!==before)notes.push("Removed adapterId/bindingRef assertions superseded by native descriptor, route and action ownership validation.");
  if(!owner[key].length)delete owner[key];
 }
 if(empty(p.routes))delete p.routes;
 return p;
}
/** Pair getters are fallback data only. SQL/census assets make this flow issue
 * zero requests; it never reads a factory, code hash or protocol identity. */
function assetBinding(sources:Record<"tokenIn"|"tokenOut",string|{getter:string}>):Data {
 const abi:Data={},requests:any[]=[],result:Data={};
 for(const side of ["tokenIn","tokenOut"] as const){
  const source=sources[side],observed=`$scope.${side}`;
  if(typeof source==="string"){result[side]=op("coalesce",observed,source);continue;}
  const missing=op("not",op("defined",observed)),name=`asset${side}`,id=`selector-assets:${side}`,signature=`function ${source.getter} view returns(address)`;
  abi[name]=[signature];
  requests.push(op("if",missing,[{id,kind:"eth-call",to:"$target",data:op("encode",name,source.getter,[]),completion:"return-data"}],[]));
  result[side]=op("coalesce",observed,op("lower",op("address",op("decode",name,source.getter,get(id),0))));
 }
 if(!requests.length)return {binding:{descriptor:result}};
 return {values:{abi},binding:{flow:{version:1,steps:[{id:"assets",requirements:{transports:["eth-call"]},requests:op("concat",...requests),result}],result:{tokenIn:"$steps.assets.tokenIn",tokenOut:"$steps.assets.tokenOut"}},descriptor:{tokenIn:"$binding.tokenIn",tokenOut:"$binding.tokenOut"}}};
}
function minimal(definition:Data,program:Data):Data|undefined {
 const label=program.label,role=(...roles:string[])=>roles.map((role,index)=>({path:[index],role}));
 let parameters:any[],payment:string,pair:ReturnType<typeof assetBinding>|undefined;
 if(label==="protocol:goldx/active-unit-mint"){
  parameters=role("executor","amountIn");payment="approval";pair=assetBinding({tokenIn:program.values.constants.paxg,tokenOut:program.values.constants.goldx});
 }else if(label==="protocol:token-migration/mantle-immutable-runtime"){
  parameters=role("amountIn");payment="approval";pair=assetBinding({tokenIn:{getter:"BIT_TOKEN_ADDRESS()"},tokenOut:{getter:"MNT_TOKEN_ADDRESS()"}});
 }else if(label==="protocol:wsteth/steth-active-binding"){
  const wrap=definition.selector==="0xea598cb0";parameters=role("amountIn");payment=wrap?"approval":"none";
  pair=assetBinding(wrap?{tokenIn:{getter:"stETH()"},tokenOut:"$target"}:{tokenIn:"$target",tokenOut:{getter:"stETH()"}});
 }else if(label==="protocol:token-conversion/btb-bear-v1"){
  const mint=definition.selector==="0xa0712d68";parameters=role("amountIn");payment=mint?"approval":"none";
  pair=assetBinding(mint?{tokenIn:{getter:"BTB_TOKEN()"},tokenOut:"$target"}:{tokenIn:"$target",tokenOut:{getter:"BTB_TOKEN()"}});
 }else if(label==="protocol:metronome-synth/active-synth-membership"){
  parameters=role("tokenIn","tokenOut","amountIn");payment="approval";
 }else if(label==="protocol:astra-multitoken/observed-active-registry"){
  parameters=role("tokenIn","tokenOut","amountIn","minimumOut");payment="approval";
 }else if(label==="custom-swap:zero1-curve/bonding-sale"){
  const buy=definition.selector==="0x59a87bc1";parameters=role("amountIn","minimumOut","recipient");payment="approval";
  pair=assetBinding(buy?{tokenIn:{getter:"zero1()"},tokenOut:{getter:"coin()"}}:{tokenIn:{getter:"coin()"},tokenOut:{getter:"zero1()"}});
 }else return undefined;
 const out:Data={parameters,payment:{kind:payment},...pair,meta:{label}};
 // Taxonomy and event direction matching are existing downstream contracts.
 const directions=program.routes?.directions;
 if(Array.isArray(directions)&&directions.length===1&&(definition.domain==="swap"||directions[0].taxonomy?.protocolAction!=="convert"))
  out.routes={directions:[{id:directions[0].id,enabled:true,tokenIn:"$descriptor.tokenIn",tokenOut:"$descriptor.tokenOut",taxonomy:directions[0].taxonomy}]};
 if(program.observations)out.observations=clone(program.observations);
 if(program.refreshPolicy&&program.refreshPolicy!=="on-touch")out.refreshPolicy=program.refreshPolicy;
 return out;
}
function fixSingleEntry(definition:Data,program:Data,notes:string[]):void {
 if(program.meta?.label!=="protocol:few-wrapped/factory-wrapper-effects")return;
 const to=definition.signature.includes("To("),wrap=definition.selector==="0xea598cb0"||definition.selector==="0x26599850";
 const chosen=clone(program.execution.steps.find((step:any)=>step.id===(to?"convertTo":"convert")));delete chosen.when;
 chosen.call.signature=`function ${wrap?"wrap":"unwrap"}${to?"To":""}(uint256${to?",address":""}) returns(uint256)`;
 if(wrap){chosen.approval.when=undefined;delete chosen.approval.when;}else delete chosen.approval;
 const allowance=program.execution.steps.find((step:any)=>step.id==="allowance");
 program.execution.steps=[chosen,...(wrap?[{...allowance,when:undefined}]:[])].map((step:any)=>Object.fromEntries(Object.entries(step).filter(([,v])=>v!==undefined)));
 program.execution.settlement.directOutput=to;
 program.execution.protectedAddresses=program.execution.protectedAddresses.filter((value:any)=>!(value?.op==="address"&&value.args?.length===0));
 if(!to){for(const effect of program.execution.effects)if(effect.kind==="credit")effect.account="$executor";
  program.execution.effects=program.execution.effects.filter((effect:any)=>effect.when!=="$externalRecipient");}
 notes.push("Fixed one-selector ownership: this recipe always calls the declared wrap/unwrap or wrapTo/unwrapTo entry, and only recipient-bearing entries advertise direct forwarding. Kept 1:1 return, balance and allowance invariants; removed an invalid empty address expression left by the former identity projection.");
}
function reasons(program:Data):string[] {
 const text=JSON.stringify(program.execution),found=new Set<string>();
 if(text.includes('"frame"')||text.includes('"callback"'))found.add("authenticated callback frame and child settlement");
 if(text.includes('"native"')||text.includes('"value"'))found.add("native-value transfer or native-balance effects");
 if(text.includes('"maximum"')||text.includes('"inputMode"')||text.includes('"deferred"'))found.add("maximum-input/deferred debt semantics");
 if(text.includes('"quoteOutput"'))found.add("output amount computed for an exact-output call");
 if(text.includes('"preflight"'))found.add("source-bound preflight/state invariants");
 if(text.includes('"supply"'))found.add("token-supply invariant");
 if(text.includes('"save"')||text.includes('"math"'))found.add("returned values or runtime arithmetic used by settlement/guards");
 if(program.execution?.steps?.length>1)found.add("ordered multi-call execution");
 if(program.execution?.contextChecks?.length)found.add("execution context guards");
 if(program.runtimeEvidence)found.add("authenticated current-block evidence");
 if(program.routes?.resources)found.add("multiple physical resources in one atomic call");
 if(!found.size)found.add("fixed parameter expressions or explicit effects beyond the role-only call");
 return [...found];
}
function summary(program:Data):Data {
 const calls:any[]=[];walk(program.execution,value=>{if(value?.signature&&value?.target)calls.push({signature:value.signature,target:value.target,arguments:value.args??[],value:value.value??null});});
 return {executionVersion:program.execution.version,settlement:program.execution.settlement,calls,effectKinds:[...new Set((program.execution.effects??[]).map((e:any)=>e.kind??"expression"))],
  bindingReads:(program.binding?.flow?.steps??[]).map((s:any)=>({id:s.id,requests:Array.isArray(s.requests)?s.requests.length:"expression"})),
  nomination:program.binding?.nomination??null,physicalResources:program.routes?.resources??program.routes?.resource??null};
}
const migrations:any[]=[],declarations:any[]=[];let ordinary=0,funding=0,simplified=0,executable=0,observational=0,bytesBefore=0,bytesAfter=0;
for(const directory of readdirSync(sourceDir).sort()){
 const file=resolve(sourceDir,directory,directory.replace(/-family$/,"")+".json"),old=JSON.parse(readFileSync(file,"utf8")),outputFile=resolve(destination,directory,directory.replace(/-family$/,"")+".json");
 let author:Data;const report={selector:old.selector,source:relative(resolve(sourceRoot),file),sourceSha256:digest(old),status:""};bytesBefore+=Buffer.byteLength(JSON.stringify(old));
 if(old.domain==="funding"){
  funding++;const roles=old.selector==="0xe0232b42"?["tokenIn","amountIn","children"]:["executor","tokenIn","amountIn","children"];
  const refs=(value:any):any=>Array.isArray(value)?value.map(refs):value&&typeof value==="object"?Object.fromEntries(Object.entries(value).map(([key,item])=>[key,refs(item)])):value==="$asset"?"$tokenIn":value==="$amount"?"$amountIn":value;
  author={format:"selector-family/v2",selector:old.selector,signature:old.signature,domain:"funding",activation:old.activation,meta:{label:old.identity?.label??""},parameters:roles.map((role,index)=>({path:[index],role})),
   execution:refs({callback:old.callback,repayment:old.repayment}),funding:refs({liquidity:old.liquidity,fee:old.fee,...(old.priority?{priority:old.priority}:{})})};
  const normalized=normalizeSelectorNativeFundingDefinition(author);Object.assign(report,{status:"migrated-funding",semanticSha256:hashCanonical(normalized as any)});
 }else{
  ordinary++;const programs:Data[]=[];
  for(const [index,oldProgram] of (old.programs??[]).entries()){
   const notes:string[]=[],simple=minimal(old,oldProgram);let program=simple??compact(oldProgram,notes),prunedLegacyProvenance=false;
   if(simple){simplified++;notes.push("Parameters and payment now select the common call compiler; removed the duplicated execution VM, route construction and unused identity/registry data.");
    notes.push("Existing positive ERC20 effects remain mandatory; the common compiler additionally enforces unchanged native balance and clears/verifies approvals. Missing pair addresses retain only declared asset-getter fallback; a complete census pair needs no binding RPC.");}
   else { fixSingleEntry(old,program,notes); const before=JSON.stringify(program);pruneOriginalSelectorProvenance(program,notes);prunedLegacyProvenance=before!==JSON.stringify(program); }
   const {label:_label,...oldSemantic}=oldProgram;
   programs.push(program);migrations.push({selector:old.selector,programIndex:index,legacyLabel:oldProgram.label,oldProgramKey:`parameters:${hashCanonical(oldSemantic)}`,
    oldExecutionSha256:digest(oldProgram.execution),oldSummary:summary(oldProgram),mode:simple?"parameters-and-payment":"execution-extension",requiredExtensions:simple?[]:reasons(program),notes,...(prunedLegacyProvenance?{prunedLegacyProvenance:true}:{})});
  }
  author={format:"selector-family/v2",selector:old.selector,signature:old.signature,domain:old.domain,activation:old.activation};
  if(programs.length===1)Object.assign(author,programs[0]);else if(programs.length)author.programs=programs;
  else author.unsupportedReason=old.unsupportedReason;
  const normalized=normalizeSelectorNativeExecutionDefinition(author);
  if(programs.length)executable++;else observational++;
  normalized.programs.forEach((program,index)=>{const row=migrations.find(row=>row.selector===old.selector&&row.programIndex===index)!;row.newProgramKey=selectorNativeProgramKey(program);row.newSemanticSha256=hashCanonical(program as any);});
  Object.assign(report,{status:programs.length?"migrated-executable":"migrated-observation-only",programs:programs.length,semanticSha256:hashCanonical(normalized as any),...(programs.length?{}:{reason:old.unsupportedReason})});
 }
 declarations.push(report);const content=JSON.stringify(author,null,2)+"\n";
 if(!process.argv.includes("--report-only")){mkdirSync(dirname(outputFile),{recursive:true});writeFileSync(outputFile,content);}
 bytesAfter+=Buffer.byteLength(JSON.stringify(author));
}
const lineage=JSON.parse(readFileSync(resolve(root,"listener/src/searcher/generated/selector-native-migration.generated.json"),"utf8"));
const baseSourceRoot=arg("--base-source-root");
const oldRoots=new Map<string,Data>();
for(const row of migrations){row.legacyExactReferences=lineage.migrations.filter((old:Data)=>old.programKey===row.oldProgramKey||old.alternativeProgramKeys?.includes(row.oldProgramKey)).map((old:Data)=>{
 const entry:Data={source:old.source,variant:old.variant,directions:old.directions??null,origin:old.kind};
 if(baseSourceRoot){const file=resolve(baseSourceRoot,old.source),original=JSON.parse(readFileSync(file,"utf8"));oldRoots.set(old.source,original);
  const variants=[original.standard,...(original.variantFiles??[]).map((name:string)=>JSON.parse(readFileSync(resolve(dirname(file),name),"utf8")))].filter(Boolean),variant=variants.find((v:Data)=>v.id===old.variant)??original.standard;
  entry.baseFamily=original.scope?.family;entry.baseRootSha256=digest(original);entry.baseExact=variant?.exact??original.exact??null;
  entry.baseExecutionSha256=variant?.execution?digest(variant.execution):null;}
 return entry;
 });if(!row.legacyExactReferences.length)throw new Error(`missing old Exact mapping ${row.selector} ${row.oldProgramKey}`);}
const report={format:"selector-family-v2-migration/v1",baseCommit:"fdb859a9b9b606a38c3b7afa52452752849ee465",scope:"original 93 execution declarations and two funding declarations; additional fdb typed families are inventoried separately",legacyRootFiles:[...oldRoots.keys()].sort(),ordinaryFamilies:ordinary,fundingFamilies:funding,executableOrdinaryFamilies:executable,observationOnlyOrdinaryFamilies:observational,
 executablePrograms:migrations.length,automaticParameterPrograms:simplified,explicitExtensionPrograms:migrations.length-simplified,prunedLegacyProvenancePrograms:migrations.filter(row=>row.prunedLegacyProvenance).length,compactJsonBytes:{before:bytesBefore,after:bytesAfter},declarations,migrations};
mkdirSync(dirname(reportFile),{recursive:true});writeFileSync(reportFile,JSON.stringify(report,null,2)+"\n");
console.log(JSON.stringify({...report,declarations:undefined,migrations:undefined}));
