import {selectorExecutionPrograms,selectorProgramProjection,selectSingleExecution} from "./selector-program-role.js";
import { FunctionFragment, Interface, getAddress, MaxUint256, ZeroAddress } from "ethers";
import { assertExecutionRounding } from "../../shared/executor/amount-rounding.js";
import { compileDeclarativeReadFlow } from "./declarative-read-flow.js";
import { compileDeclarativeValues, validateDeclarativeStatements } from "./declarative-values.js";
import { compileInstanceEvidence } from "./declarative-instance-evidence.js";
import { compileSignedBlockEvidence } from "./declarative-runtime-evidence.js";
import { createDeclarativeRuntimeMathRegistry } from "./declarative-runtime-math.js";
import { assertDeclarativeExecutionSource, buildDeclarativeRuntimeLeg, buildDeclarativeQuotedFragment,
  type DeclarativeConversionExecution } from "./declarative-execution.js";
import { buildDeclarativeExecutionSimulation, decodeDeclarativeExecutionSimulationReceipt } from "./declarative-simulation.js";
import { assertSource } from "./selector-execution-evidence.js";
import { normalizeSelectorExecutionAsset, normalizeSelectorExecutionResource } from "./selector-execution-keys.js";
import { bindSelectorNativeMath } from "./selector-native-math.js";
import { hashCanonical } from "./canonical-value.js";
import { freezeSelectorNative, selectorNativeFamilyId, selectorNativeProgramKey,
  type SelectorNativeExecutionDefinition, type SelectorNativeProgram } from "./selector-native-definition.js";
import type { SelectorNativeBindingCandidate } from "./selector-native-discovery.js";
import { selectorObservedTargetCode } from "./selector-native-discovery.js";
import { assertVerifiedSelectorSourceCall } from "./selector-source-call-witness.js";
import {validateSqlExecutionParamHints} from './selector-native-sql-param-hints.js';
import {selectorSourceParameters} from './selector-source-parameters.js';
import {assertSelectorSourceIdentity} from './selector-source-identity.js';
import type { AdapterRequest, AdapterRequestResult, CanonicalSource, RequestRequirements } from "./adapter-request-program.js";
type Data=Record<string,any>;
export interface SelectorNativeBindingProof {
 readonly source:CanonicalSource;readonly executor:string;readonly transactionOrigin?:string;
 readonly executionRoundingRawUnits?:bigint;
 readonly rounds:readonly (readonly AdapterRequestResult[])[];
 readonly stage:"binding"|"complete"|"unavailable";
 readonly bound?:Data;readonly reason?:string;
}
const same=(a:string,b:string)=>getAddress(a)===getAddress(b);
const cleanFrozen=new WeakSet<object>();
const clean=(v:any):any=>{
 if(!v||typeof v!=='object')return v;
 if(cleanFrozen.has(v))return v;
 if(Array.isArray(v)){
  let sameRef=Object.isFrozen(v);
  const mapped=v.map(x=>{const c=clean(x);if(c!==x||(c&&typeof c==='object'&&!cleanFrozen.has(c)))sameRef=false;return c;});
  if(sameRef){cleanFrozen.add(v);return v;}
  return mapped;
 }
 const keys=Object.keys(v);
 let sameRef=Object.isFrozen(v);
 const out:Record<string,any>={};
 for(let i=0;i<keys.length;i++){
  const k=keys[i]!,x=v[k];
  if(x===undefined){sameRef=false;continue;}
  const c=clean(x);
  if(c!==x||(c&&typeof c==='object'&&!cleanFrozen.has(c)))sameRef=false;
  out[k]=c;
 }
 if(sameRef){cleanFrozen.add(v);return v;}
 return out;
};
const hash=(v:any)=>hashCanonical(clean(v));
/** Token IDs can name logical ERC20 resource slots. Only actual NFT transfers
 * require balance observations which the ERC20 execution backend cannot prove. */
export function selectorNativeHasNonFungibleFlow(candidate:SelectorNativeBindingCandidate,assets:Data=candidate.scope):boolean {
 if(candidate.candidateKind!=="selector-native-execution")return false;
 const tokens=[assets.tokenIn,assets.tokenOut].filter((v):v is string=>typeof v==='string').map(v=>getAddress(v).toLowerCase());
 return candidate.census.tokenFlows.some(flow=>flow.standard!=='erc20'&&tokens.includes(flow.token.toLowerCase())&&BigInt(flow.amount)>0n);
}
function valueDocument(...sources:readonly (Data|undefined)[]):Data {
 const out:Data={abi:{},constants:{},expressions:{},programs:{}};
 for(const source of sources)if(source)for(const key of ['abi','constants','expressions','programs'])Object.assign(out[key],source[key]??{});
 const inputs=[...new Set(sources.flatMap(s=>Array.isArray(s?.inputs)?s!.inputs:[]))];if(inputs.length)out.inputs=inputs;
 return out;
}
/** This compiler consumes a complete execution definition. It has no protocol
 * registry, legacy root/child loader, pricing model or identity adapter. */
export function createSelectorNativeRuntime(definition:SelectorNativeExecutionDefinition,program:SelectorNativeProgram){
 if(program.type==='independentIdentity')throw Error('identity program cannot create an execution runtime');
 const projection=selectorProgramProjection(program);
 for(const checks of [program.checks,program.routes?.checks,program.routes?.assertions,program.receiptChecks?.checks])if(checks)validateDeclarativeStatements(checks);
 const family=selectorNativeFamilyId(definition),key=selectorNativeProgramKey(program),actionId=`${family}:call`,lineage=`${family}:${key}`;
 const models=program.math?bindSelectorNativeMath(program.math):{};
 const values=compileDeclarativeValues(valueDocument(program.values) as any,{},models);
 const resources=compileDeclarativeValues(valueDocument(program.values,program.resourceValues) as any,{},models);
 const flow=projection?.flow?compileDeclarativeReadFlow(projection.flow,values):undefined;
 const stateAuthority=projection?.stateBinding?.authority
  ?compileDeclarativeReadFlow(projection.stateBinding.authority,values):undefined;
 const instanceReads=projection?.descriptorReads?compileInstanceEvidence(projection.descriptorReads,resources):undefined;
 const runtimeMath=program.runtimeMath?createDeclarativeRuntimeMathRegistry(program.runtimeMath.models??[]).bind({version:program.runtimeMath.version,entries:program.runtimeMath.entries}):undefined;
 const options=runtimeMath?{math:runtimeMath}:{};
 const signed=program.runtimeEvidence?compileSignedBlockEvidence(family,program.runtimeEvidence,values):undefined;
 const abi=new Interface([definition.signature]);
 function bindingEnvironment(candidate:SelectorNativeBindingCandidate,source:CanonicalSource,executor:string,transactionOrigin?:string,executionRoundingRawUnits=0n):Data {
  assertDeclarativeExecutionSource(source);getAddress(executor);
  assertExecutionRounding(executionRoundingRawUnits);
  if(transactionOrigin!==undefined)getAddress(transactionOrigin);
  if(candidate.candidateKind==='selector-native-source-identity'){
   if(!definition.directState||!program.execution||flow||stateAuthority||signed||instanceReads)throw Error('source identity execution cannot run legacy binding');
   if(selectSingleExecution(definition).programKey!==key)throw Error('source identity execution must target single execution program');
   if(candidate.identity!==null)assertSelectorSourceIdentity(candidate.identity,{definition,edge:candidate.edge,source,programKey:key});
   else if(definition.programs.some(p=>p.type==='independentIdentity'))throw Error('source identity missing for identity-guarded definition');
   if(!selectorObservedTargetCode(candidate,source,candidate.target))throw Error('source identity lacks current deployed-code observation');
   const hookData=candidate.edge.hookData?.toLowerCase()??'0x';
   return {candidate,scope:candidate.scope,target:candidate.target,sqlEdge:{tokenIn:candidate.scope.tokenIn,tokenOut:candidate.scope.tokenOut,hookData},
    sourceParameters:candidate.identity?.binding??{},source,executor,transactionOrigin,executionPolicy:{executionRoundingRawUnits},familyId:family,programLineage:lineage};
  }
  if(candidate.candidateKind==="selector-native-source"){
   if(!definition.directState||!program.execution||signed||instanceReads)throw Error("source program needs undeclared state");
   if(selectSingleExecution(definition).programKey!==key)throw Error("source witness must target single execution program");
   assertVerifiedSelectorSourceCall(candidate.witness,{edge:candidate.witness,source,discoveryRuleHash:definition.directState.discoveryRuleHash});
   if(!selectorObservedTargetCode(candidate,source,candidate.target))throw Error("source execution lacks current deployed-code observation");
   const args=abi.decodeFunctionData(FunctionFragment.from(definition.signature),candidate.witness.calldata).toArray(true);
   const hints=validateSqlExecutionParamHints({definition,edge:candidate.witness,evidence:candidate.witness.executionParamEvidence});
   const hint=hints?.recipes.find(p=>p.programKey===key);
   if(!hint)throw Error('source execution lacks independently reconstructed parameters');
   const sourceParameters=selectorSourceParameters(program,hint);
   const hookData=(candidate.witness as Data).hookData?.toLowerCase()??'0x';
   return {candidate,scope:candidate.scope,target:candidate.target,sqlEdge:{tokenIn:candidate.witness.tokenIn,tokenOut:candidate.witness.tokenOut,hookData},
    args,arguments:args,sourceParameters:sourceParameters.binding,source,executor,transactionOrigin,executionPolicy:{executionRoundingRawUnits},familyId:family,programLineage:lineage};
  }
  if(candidate.candidateKind==="selector-native-state"){
   const spec=projection?.stateBinding;
   // The Family discovery boundary also admits the restricted, independently
   // read SQL pair profile. It has no synthetic calldata or candidate fields.
   if(!flow||!program.execution||signed)throw new Error("recipe has no state-bound execution");
   const physical={target:candidate.target,scope:candidate.scope};
   const env={...physical,candidate:physical,source,executor,transactionOrigin,
    executionPolicy:{executionRoundingRawUnits},familyId:family,programLineage:lineage};
   return {...env,candidate:spec?.candidate===undefined?physical:values.evaluate(spec.candidate,env)};
  }
  const call=candidate.census.calls.find(row=>row.id===candidate.callId)!;
  const args=abi.decodeFunctionData(FunctionFragment.from(definition.signature),call.calldata!).toArray(true);
  const env={candidate,census:candidate.census,call,args,arguments:args,target:candidate.target,scope:candidate.scope,
   tokenIn:candidate.scope.tokenIn,tokenOut:candidate.scope.tokenOut,observedAmountIn:candidate.observedAmountIn,
   source,executor,transactionOrigin,executionPolicy:{executionRoundingRawUnits},familyId:family,programLineage:lineage};
  return {...env,candidate:projection?.candidate===undefined?candidate:values.evaluate(projection.candidate,env)};
 }
 function environment(input:Data):Data {
  const env={...input,routes:input.routes??input.descriptor?.routes??[],direction:input.direction??input.route?.direction,
   executionPolicy:input.descriptor?.executionPolicy??{executionRoundingRawUnits:0n},
   familyId:family,programLineage:lineage,
   ...(signed&&Object.hasOwn(input,'runtimeEvidence')?{authenticatedEvidence:signed.authenticate({runtimeEvidence:input.runtimeEvidence,source:input.source??input.exactEvidence?.source,
    descriptor:{...input.descriptor,instanceKey:input.descriptor.signedInstanceKey??input.descriptor.instanceKey}})}:{})};
  return {...env,...values.evaluate(program.context??{},env),binding:values.evaluate(program.state??{},env),
   target:program.routes?resources.evaluate(program.routes.target,{...env,descriptor:input.descriptor}):input.descriptor.target};
 }
 function finishBinding(candidate:SelectorNativeBindingCandidate,env:Data,binding:unknown,staticResults?:readonly AdapterRequestResult[]):Data {
  function completed(value:unknown):Data {
   if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('native binding must produce execution parameters');
   const explicit=value as Data,scope=candidate.scope;
   const descriptor:Data={...(env.arguments===undefined?{}:{args:env.args,arguments:env.arguments}),...scope,...explicit,executionPolicy:env.executionPolicy};
   // SQL nominations and current binding evidence complement one another;
   // neither is permission to silently replace the other's asset identity.
   for(const side of ['tokenIn','tokenOut'] as const){
    if(scope[side]!==undefined&&explicit[side]!==undefined&&!same(scope[side],explicit[side]))throw new Error('observed token differs from execution parameter binding');
    if(descriptor[side]!==undefined)descriptor[side]=getAddress(descriptor[side]).toLowerCase();
    const idKey=`${side}Id` as 'tokenInId'|'tokenOutId';
    const ids=[scope[idKey],explicit[idKey]].filter(v=>v!==undefined).map(v=>normalizeSelectorExecutionAsset({address:descriptor[side]??candidate.target,id:v}).id!);
    if(new Set(ids).size>1)throw new Error('observed token id differs from execution parameter binding');
    if(ids.length)descriptor[idKey]=ids[0];
   }
   for(const field of ['poolId','poolNamespace'] as const){
    if(scope[field]!==undefined&&explicit[field]!==undefined&&String(scope[field])!==String(explicit[field]))throw new Error(`observed ${field} differs from execution parameter binding`);
    if(descriptor[field]!==undefined)descriptor[field]=String(descriptor[field]);
   }
   descriptor.target=getAddress(descriptor.target).toLowerCase();
   return descriptor;
  }
  const factsValue=values.evaluate(projection?.facts??{}, {...env,binding});
  if(!factsValue||typeof factsValue!=='object'||Array.isArray(factsValue))throw new Error('native execution facts must be a record');
  const facts={...factsValue,facts:factsValue,subject:projection?.subject===undefined?candidate.target:values.evaluate(projection.subject,{...env,binding}),
   familyId:family,lineageId:lineage,provenance:[]};
  const draft=completed(projection?resources.evaluate(projection.descriptor,{...env,binding,facts}):{});
  if(instanceReads&&staticResults!==undefined){
   const staticEvidence=instanceReads.decode({programInput:draft,results:staticResults});
   resources.run(projection!.descriptorReads!.checks??[],{draft,staticEvidence,sharedBindings:[]});
   return completed(resources.evaluate(projection!.descriptorReads!.finalize,{draft,staticEvidence,sharedBindings:[]}));
  }
  return draft;
 }
 function progress(candidate:SelectorNativeBindingCandidate,source:CanonicalSource,executor:string,transactionOrigin:string|undefined,rounds:readonly (readonly AdapterRequestResult[])[],executionRoundingRawUnits=0n):Data {
  const env=bindingEnvironment(candidate,source,executor,transactionOrigin,executionRoundingRawUnits);let binding:unknown=env.sourceParameters??{},used=0;
  const dependencies=new Set<string>([candidate.target]);
  const note=(requests:readonly AdapterRequest[])=>requests.forEach(request=>{if('to'in request&&typeof request.to==='string')dependencies.add(getAddress(request.to).toLowerCase());if('address'in request&&typeof request.address==='string')dependencies.add(getAddress(request.address).toLowerCase());});
  function readFlow(compiled:NonNullable<typeof flow>,scope:Data,requireRead:boolean,trackPricingDependencies=true):Data{
   const bound=compiled.start(scope as any);if(trackPricingDependencies)note(bound.requests);
   if(requireRead&&!bound.requests.some(request=>request.required!==false))
    throw new Error("state binding must issue a required identity read");
   if(used===rounds.length)return {next:bound};
   const initial=rounds[used++]!,dependent:unknown[]=[];bound.decode(initial);
   for(let index=0;;index++){
    const next=compiled.program.buildDependentProgram!({programInput:scope as any,completedRound:index,initialResults:initial,priorEvidence:dependent});
     if(!next)break;if(trackPricingDependencies)note(next.requests);
    if(used===rounds.length)return {next};
    dependent.push(next.decode(rounds[used++]!));
   }
   return {value:compiled.complete(scope as any,initial,dependent).decode()};
  }
  const state=candidate.candidateKind==="selector-native-state";
  if(flow&&candidate.candidateKind!=="selector-native-source"){
   const read=readFlow(flow,env,state);
   if(read.next)return read;binding=read.value;
  }
  if(state&&stateAuthority){
   // No requested pair or selector calldata enters the authority program.
   const read=readFlow(stateAuthority,{...env,binding},true,false);
   if(read.next)return read;
   if(read.value!==true)throw new Error("state binding authority did not confirm the issued resource");
  }
  const draft=finishBinding(candidate,env,binding);
  let descriptor=draft;
  if(instanceReads){const requests=instanceReads.buildRequests(draft);note(requests);
   if(used===rounds.length)return {next:{requirements:instanceReads.requirements(draft),requests,decode:(results:readonly AdapterRequestResult[])=>instanceReads.decode({programInput:draft,results})}};
   const result=rounds[used++]!;result.forEach(r=>assertSource(r.source,source));descriptor=finishBinding(candidate,env,binding,result);
  }
  if(used!==rounds.length)throw new Error('native binding transcript has extra rounds');
  // These fields are framework ownership, never accepted from JSON identity.
  descriptor={...descriptor,familyId:family,lineageId:lineage,instanceKey:candidate.target,provenance:[],runtimeRequirements:[]};
  if(signed)descriptor.signedInstanceKey=values.evaluate(program.runtimeEvidence!.call.instance,env);
  if(projection?.match!==undefined&&values.evaluate(projection.match,{descriptor,programLineage:lineage})!==true)throw new Error('execution parameter shape mismatch');
  const innerRoutes=projectInnerRoutes(candidate,descriptor,env);
  if(!innerRoutes.length)throw new Error('no compatible execution direction');
  return {bound:freezeSelectorNative({descriptor,innerRoutes,dependencies:[...dependencies].sort(),
    ...(env.arguments===undefined?{}:{arguments:env.arguments})})};
 }
 function step(input:{candidate:SelectorNativeBindingCandidate;source?:CanonicalSource;executor?:string;transactionOrigin?:string;evidence?:SelectorNativeBindingProof;executionRoundingRawUnits?:bigint}){
  if(!input.source||!input.executor)throw new Error('current source and executor authority required');
  const {candidate,source,executor,transactionOrigin}=input,executionRoundingRawUnits=input.executionRoundingRawUnits??0n;
  assertExecutionRounding(executionRoundingRawUnits);
  if(candidate.programKey!==key)throw new Error('candidate belongs to another execution parameter program');
  if(selectorNativeHasNonFungibleFlow(candidate))throw new Error('non-ERC20 token flow requires token-id balance observation');
  const prior=input.evidence;
  if(prior){assertSource(prior.source,source);if(!same(prior.executor,executor)||prior.transactionOrigin?.toLowerCase()!==transactionOrigin?.toLowerCase())throw new Error('binding actor/origin changed');if((prior.executionRoundingRawUnits??0n)!==executionRoundingRawUnits)throw new Error('binding execution policy changed');}
  const rounds=prior?.rounds??[];
  const current=progress(candidate,source,executor,transactionOrigin,rounds,executionRoundingRawUnits);
  const proof=(more:readonly (readonly AdapterRequestResult[])[]):SelectorNativeBindingProof=>{
   const state=progress(candidate,source,executor,transactionOrigin,more,executionRoundingRawUnits);
   return freezeSelectorNative({source,executor:getAddress(executor).toLowerCase(),...(transactionOrigin?{transactionOrigin:getAddress(transactionOrigin).toLowerCase()}:{}),executionRoundingRawUnits,rounds:more,
    stage:state.bound?'complete':'binding',...(state.bound?{bound:state.bound}:{})});
  };
  if(current.bound)return {requirements:{transports:[]} as RequestRequirements,requests:[] as readonly AdapterRequest[],decode(results:readonly AdapterRequestResult[]){if(results.length)throw new Error('unexpected static binding evidence');return proof(rounds);}};
  return {requirements:current.next.requirements as RequestRequirements,requests:current.next.requests as readonly AdapterRequest[],decode(results:readonly AdapterRequestResult[]){
   results.forEach(result=>assertSource(result.source,source));current.next.decode(results);return proof([...rounds,[...results]]);
  }};
 }
 function verify(candidate:SelectorNativeBindingCandidate,proof:SelectorNativeBindingProof):Data {
  if(proof.stage!=='complete'||!proof.bound)throw new Error('execution binding is incomplete');
  const rebuilt=progress(candidate,proof.source,proof.executor,proof.transactionOrigin,proof.rounds,proof.executionRoundingRawUnits??0n).bound;
  if(!rebuilt||hash(rebuilt)!==hash(proof.bound))throw new Error('execution binding transcript changed');return rebuilt;
 }
 function projectInnerRoutes(candidate:SelectorNativeBindingCandidate,descriptor:Data,bindingEnv:Data):Data[]{
  const env=environment({...bindingEnv,descriptor});resources.run(program.routes?.checks??[],env);
  const rows=program.routes?.directions!==undefined?resources.evaluate(program.routes.directions,{...env,descriptor}):[{id:'execute',enabled:true,tokenIn:descriptor.tokenIn,tokenOut:descriptor.tokenOut,taxonomy:definition.domain==='swap'?{slotKind:'swap'}:{slotKind:'protocol',protocolAction:'convert'}}];
  if(!Array.isArray(rows)||!rows.length||rows.length>10000)throw new Error('invalid execution direction list');
  const result:Data[]=[];
  for(const d of rows){
   if(program.routes?.allowedDirections&&!program.routes.allowedDirections.includes(d.id))continue;
   if(d.enabled!==undefined&&resources.evaluate(d.enabled,env)!==true)continue;
   const tokenIn=getAddress(resources.evaluate(d.tokenIn,env)),tokenOut=getAddress(resources.evaluate(d.tokenOut,env));
   if(same(tokenIn,tokenOut))throw new Error('execution route has identical assets');
   const executionAssets=d.executionAssets?resources.evaluate(d.executionAssets,env):undefined;
   const matchesSide=(descToken:unknown,graphToken:string,assetKind:unknown)=>
    !descToken||same(String(descToken),graphToken)||(assetKind==='native'&&same(String(descToken),ZeroAddress));
   if(!matchesSide(descriptor.tokenIn,tokenIn,executionAssets?.input)||
      !matchesSide(descriptor.tokenOut,tokenOut,executionAssets?.output))continue;
   const fields=resources.evaluate(d.fields??{},env);
   const route:Data={...fields,familyId:family,lineageId:lineage,instanceKey:candidate.target,routeKey:d.id,direction:d.id,
    target:env.target,adapterId:actionId,tokenIn,tokenOut,taxonomy:d.taxonomy,
    ...(executionAssets?{executionAssets}:{})};
   if(candidate.candidateKind==="selector-native-state"){
    const matches=(wanted:string,actual:string,asset:unknown)=>asset==="native"
      ? wanted===ZeroAddress
      : wanted!==ZeroAddress&&same(wanted,actual);
    if(!matches(candidate.requestedDirection.tokenIn,tokenIn,route.executionAssets?.input)||
       !matches(candidate.requestedDirection.tokenOut,tokenOut,route.executionAssets?.output))continue;
   }
   function bindIds(venue:Data={}):void {
    for(const side of ['tokenIn','tokenOut'] as const){
     const idKey=`${side}Id` as 'tokenInId'|'tokenOutId',ids=[candidate.scope[idKey],descriptor[idKey],fields[idKey],venue[idKey]].filter(value=>value!==undefined)
       .map(value=>normalizeSelectorExecutionAsset({address:route[side],id:value}).id!);
     if(new Set(ids).size>1)throw new Error('observed token id differs from execution parameter binding');
     if(ids.length)route[idKey]=ids[0];
    }
   }
   bindIds();
   const context=environment({...bindingEnv,descriptor,route,runtimeEvidence:[]});
   const explicitVenue=program.routes?.venue?resources.evaluate(program.routes.venue,{...context,descriptor,route}):{};
   const venue:Data={...explicitVenue};
   for(const field of ['poolId','poolNamespace'] as const){
    const values=[candidate.scope[field],descriptor[field],explicitVenue[field]].filter(value=>value!==undefined).map(String);
    if(new Set(values).size>1)throw new Error(`observed ${field} differs from execution parameter binding`);
    if(values.length)venue[field]=values[0];
   }
   bindIds(venue);
   resources.run(program.routes?.assertions??[],context);values.run(program.checks??[],context);
   const resourceScope=(value:any)=>normalizeSelectorExecutionResource({...value,chainId:candidate.scope.chainId});
   const defaultResource={target:env.target,...(venue.poolId===undefined?{}:{poolId:venue.poolId}),...(venue.poolNamespace===undefined?{}:{poolNamespace:venue.poolNamespace})};
   const explicitResource=program.routes?.resource?resources.evaluate(program.routes.resource,{...context,descriptor,route}):{};
   const resource=resourceScope({...defaultResource,...explicitResource});
   const physicalResources=program.routes?.resources?.map(value=>resourceScope(resources.evaluate(value,{...context,descriptor,route})));
   if(candidate.candidateKind==="selector-native-state"&&(
     !same(resource.target,candidate.target)||resource.poolId!==candidate.scope.poolId||
     resource.poolNamespace!==candidate.scope.poolNamespace||physicalResources?.length
   ))throw new Error("state binding route differs from nominated physical resource");
   if(candidate.scope.poolId!==undefined&&venue.poolId!==undefined&&String(candidate.scope.poolId)!==String(venue.poolId))throw new Error('observed pool id differs from execution parameter binding');
   if(candidate.scope.poolNamespace!==undefined&&venue.poolNamespace!==undefined&&candidate.scope.poolNamespace!==venue.poolNamespace)throw new Error('pool namespace differs from execution parameter binding');
   if(selectorNativeHasNonFungibleFlow(candidate,route))throw new Error('non-ERC20 token flow requires token-id balance observation');
   entryTarget(context,candidate);
   result.push({...route,venue,resource,...(physicalResources?{resources:physicalResources}:{})});
  }
  if(candidate.candidateKind==="selector-native-state"&&result.length>1)throw new Error("state binding direction is ambiguous");
  if(new Set(result.map(r=>r.direction)).size!==result.length)throw new Error('duplicate execution direction');return result;
 }
 function execution(candidate?:SelectorNativeBindingCandidate):DeclarativeConversionExecution {
  if(program.execution)return {...program.execution,...(program.quoteOutput?{quoteOutput:program.quoteOutput}:{})} as DeclarativeConversionExecution;
  if(!candidate||candidate.candidateKind!=="selector-native-execution")throw new Error('parameter execution requires an observed call binding');
  const args:Data[]=JSON.parse(JSON.stringify(candidate.arguments));
  for(const parameter of program.parameters??[]){
   if(['bound','poolId','tokenInId','tokenOutId'].includes(parameter.role))continue;
   const replacement:any=parameter.role==='amountIn'?{runtime:'amountIn'}:parameter.role==='minimumOut'?'$minAmountOut':parameter.role==='recipient'?'$recipient':parameter.role==='executor'?'$executor':`$route.${parameter.role}`;
   let parent:any=args;for(const i of parameter.path.slice(0,-1))parent=parent[i];parent[parameter.path.at(-1)!]=replacement;
  }
  const directOutput=program.parameters!.some(parameter=>parameter.role==='recipient');
  const base={settlement:{directOutput},requireCanonicalSource:true,protectedAddresses:['$target','$route.tokenIn','$route.tokenOut'],
   effects:[{kind:'debit',token:'$route.tokenIn',account:'$executor',equals:{runtime:'amountIn'}},{kind:'credit',token:'$route.tokenOut',account:directOutput?'$recipient':'$executor',minimum:'$minAmountOut'},{kind:'unchanged-native'},
    ...(directOutput?[{kind:'unchanged-token',token:'$route.tokenOut',account:'$executor',when:'$externalRecipient'},{kind:'unchanged-token',token:'$route.tokenIn',account:'$recipient',when:'$externalRecipient'}]:[])]};
  const call={target:'$target',signature:definition.signature,args},payment=program.payment?.address??'$target';
  return (program.payment?.kind==='pretransfer'?{...base,version:2,steps:[{id:'payment',call:{target:'$route.tokenIn',signature:'function transfer(address,uint256) returns(bool)',args:[payment,{runtime:'amountIn'}]}},{id:'execute',call}]}:
   {...base,version:1,call,...(program.payment?.kind==='approval'?{approval:{token:'$route.tokenIn',spender:payment,mode:'exact-clear',verifyAllowance:true}}:{})}) as DeclarativeConversionExecution;
 }
 function entryTarget(env:Data,candidate:SelectorNativeBindingCandidate):void {
  assertExecutionEntry(env,execution(candidate),candidate.target);
 }
 function assertExecutionEntry(env:Data,decl:DeclarativeConversionExecution,target:string):void {
  const matches=new Set<string>(),signature=FunctionFragment.from(definition.signature).format('sighash');
  const context={...env,recipient:env.executor,minAmountOut:1n,directSettlement:false,externalRecipient:false,fundedSettlement:true,deferredSettlement:false};
  function visit(v:any):void {if(!v||typeof v!=='object')return;if(Array.isArray(v)){v.forEach(visit);return;}if(v.op){visit(values.evaluate(v,context));return;}
   if(v.when!==undefined&&values.evaluate(v.when,context)!==true)return;
   if(v.signature!==undefined&&v.target!==undefined&&v.static!==true){const fn=FunctionFragment.from(values.evaluate(v.signature,context));if(fn.selector===definition.selector&&fn.format('sighash')===signature)matches.add(getAddress(values.evaluate(v.target,context)));}
   for(const[field,child]of Object.entries(v))if(!['preflight','quoteOutput','callback','settlement','effects'].includes(field)&&v.static!==true)visit(child);
  }
  visit(decl.version===1?{call:decl.call}:{steps:decl.steps});
  if(matches.size!==1||!same([...matches][0]!,target))throw new Error('observed execution entry target/signature differs from parameter program');
 }
 const requirements:RequestRequirements={transports:['effect-delta-simulation',...(program.ethCall?['eth-call' as const]:[])],caller:'executor',
  ...(program.ethCall?{completions:['return-data' as const]}:{}),effects:[...new Set(['return-data','revert-data','token-delta','native-delta',...(program.receiptChecks?.observe??[]),...(program.receiptChecks?.totalSupplies!==undefined?['total-supply-delta']:[])])] as any};
 function simulation(input:Data,id:string):AdapterRequest {
  if(typeof input.amountIn!=='bigint'||input.amountIn<=0n||input.amountIn>MaxUint256)throw new Error('simulation amount must be positive uint256');
  const env=environment(input);
  return buildDeclarativeExecutionSimulation({kind:'declarative-execution-simulation',id,amountIn:'$amountIn',required:true,...(program.receiptChecks?{observe:program.receiptChecks.observe as any,...(program.receiptChecks.tokenBalances===undefined?{}:{tokenBalances:program.receiptChecks.tokenBalances}),...(program.receiptChecks.totalSupplies===undefined?{}:{totalSupplies:program.receiptChecks.totalSupplies})}:{})},env,values,execution(input.candidate),options);
 }
 function decodeSimulation(input:Data,request:AdapterRequest,result:AdapterRequestResult):bigint {
  const env=environment(input),leg=buildDeclarativeRuntimeLeg(execution(input.candidate),env,values,options);
  const amountOut=decodeDeclarativeExecutionSimulationReceipt({request,result,source:input.source,executor:input.executor,tokenIn:input.route.tokenIn,tokenOut:input.route.tokenOut,amountIn:input.amountIn,...(leg?.inputMode?{inputMode:leg.inputMode}:{})});
  values.run(program.receiptChecks?.checks??[],{...env,result,amountOut});return amountOut;
 }
 function ethCall(input:Data,id:string):AdapterRequest|undefined {
  if(!program.ethCall)return undefined;
  const env=environment(input),abi=new Interface([program.ethCall.signature]),fn=FunctionFragment.from(program.ethCall.signature);
  return {id,kind:'eth-call',required:false,to:input.candidate.target,caller:{kind:'executor'},completion:'return-data',
   data:abi.encodeFunctionData(fn,values.evaluate(program.ethCall.arguments,env))};
 }
 function decodeEthCall(input:Data,result:AdapterRequestResult|undefined,amountOut:bigint):Data|undefined {
  if(!program.ethCall)return undefined;
  if(!result)return {available:false};assertSource(result.source,input.source);
  if(!result.ok||result.completion!=='returned')return {available:false};
  try {const abi=new Interface([program.ethCall.signature]),fn=FunctionFragment.from(program.ethCall.signature),decoded=abi.decodeFunctionResult(fn,result.data);
   if(abi.encodeFunctionResult(fn,decoded).toLowerCase()!==result.data.toLowerCase())return {available:false};
   const word=result.data.slice(2+program.ethCall.outputWord*64,2+(program.ethCall.outputWord+1)*64);
   if(!/^[0-9a-f]{64}$/i.test(word))return {available:false};const output=BigInt(`0x${word}`);if(output<=0n)return {available:false};
   return {available:true,amountOut:output,matchesSimulation:output===amountOut};
  }catch{return {available:false};}
 }
 return {key,lineage,actionId,program,values,resources,signed,requirements,environment,step,verify,execution,assertExecutionEntry,
  requiredReadRounds:(flow?.stepIds.length??0)+(stateAuthority?.stepIds.length??0)+(instanceReads?1:0)+1,simulation,decodeSimulation,ethCall,decodeEthCall,
  dependencies(input:Data):readonly string[]{if(program.dependencies===undefined)return [];const rows=values.evaluate(program.dependencies,environment(input));if(!Array.isArray(rows))throw new Error('execution dependencies must be addresses');return rows.map((row:any)=>getAddress(row).toLowerCase());},
  buildRuntimeLeg(input:Data){return buildDeclarativeRuntimeLeg(execution(input.candidate),environment(input),values,options);},
  buildFragment(input:Data){return buildDeclarativeQuotedFragment(execution(input.candidate),environment(input),values,options);}};
}
export type SelectorNativeRuntime=ReturnType<typeof createSelectorNativeRuntime>;
