import {selectorExecutionPrograms,selectorProgramProjection} from "./selector-program-role.js";
import { getAddress } from "ethers";
import { instanceKey, lineageId, routeKey } from "./adapter-family-identifiers.js";
import { localZeroExactMethod, type FamilyPlugin, type IdentityVariant } from "./adapter-family-plugin.js";
import type { AdapterRequestResult, CanonicalSource } from "./adapter-request-program.js";
import { hashCanonical } from "./canonical-value.js";
import { createRouteCaptureMaterialization } from "./capture-materialization.js";
import { createDeclarativeProgramAction, assertDeclarativeExecutionSource } from "./declarative-execution.js";
import { compileDeclarativeSwap } from "./declarative-swap-domain.js";
import { compileDeclarativeEventCodec } from "./declarative-event-codec.js";
import { createObservedExecutionMutation } from "./observed-execution-mutation.js";
import { createSqlEdgePriceLogScopes } from "./sql-edge-price-log-scopes.js";
import { selectorNativePricingPools, selectorNativeMutationRole, scopeSelectorNativeMutation } from "./selector-native-pricing-activity.js";
import {selectorPaidRankRole} from "./selector-native/paid-ranking-registry.js";
import { selectorExecutionInstanceKey, selectorExecutionResourceKey, selectorExecutionRouteKey } from "./selector-execution-keys.js";
import { assertSource } from "./selector-execution-evidence.js";
import { edgeObservationTarget } from "./route-observation-identity.js";
import { freezeSelectorNative, normalizeSelectorNativeExecutionDefinition, selectorNativeFamilyId } from "./selector-native-definition.js";
import { assertSelectorNativeCandidate, compileSelectorNativeDiscovery, type SelectorNativeBindingCandidate } from "./selector-native-discovery.js";
import { createSelectorNativeRuntime, selectorNativeHasNonFungibleFlow, type SelectorNativeBindingProof, type SelectorNativeRuntime } from "./selector-native-runtime.js";
type Data=Record<string,any>;
const cleanFrozen=new WeakSet<object>();
const clean=(v:any):any=>{
 if(!v||typeof v!=='object')return v;
 if(cleanFrozen.has(v))return v;
 if(Array.isArray(v)){
  let sameRef=Object.isFrozen(v);
  const mapped=v.map(x=>{const c=clean(x);if(c!==x|| (c&&typeof c==='object'&&!cleanFrozen.has(c)))sameRef=false;return c;});
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
const frozen=<T>(v:T):T=>freezeSelectorNative(v);
const same=(a:string,b:string)=>getAddress(a)===getAddress(b);
const unique=<T>(items:readonly T[]):T[]=>[...new Map(items.map(item=>[hash(item),item])).values()];
const list=(items:readonly string[])=>[...new Set(items)];
const verifiedDeepFrozen=new WeakSet<object>();
const deeplyFrozen=(v:any,seen?:WeakSet<object>):boolean=>{
 if(!v||typeof v!=='object'||verifiedDeepFrozen.has(v))return true;
 const active=seen??new WeakSet<object>();
 if(active.has(v))return true;active.add(v);
 const ok=Object.isFrozen(v)&&Object.values(Object.getOwnPropertyDescriptors(v)).every(d=>'value'in d&&deeplyFrozen(d.value,active));
 if(ok)verifiedDeepFrozen.add(v);
 return ok;
};
const RUNTIME_REQUIREMENTS=frozen([{kind:'source-state',freshness:'current-head'},{kind:'execution-actor',role:'executor'},
 {kind:'effect-observation',effects:['token-delta','native-delta']}]);
/** Selector + complete ABI owns the family. Execution parameter programs may
 * provide several ways to invoke the same physical pool; each is independently
 * source-bound and the existing funded startup SIM decides executable prices. */
export function compileSelectorNativeExecutionFamily<Domain extends 'swap'|'protocol'='swap'|'protocol'>(raw:unknown):FamilyPlugin<Domain>{
 const definition=normalizeSelectorNativeExecutionDefinition(raw),definitionHash=hash(definition),projection=compileSelectorNativeDiscovery(definition),family=selectorNativeFamilyId(definition),actionId=`${family}:call`;
 const runtimes=selectorExecutionPrograms(definition).map(p=>createSelectorNativeRuntime(definition,p)),byKey=new Map(runtimes.map(r=>[r.key,r]));
 const runtimeFor=(descriptor:Data)=>byKey.get(descriptor.programKey)??(()=>{throw new Error('execution parameter program changed');})();
 function descriptorFor(runtime:SelectorNativeRuntime,candidate:SelectorNativeBindingCandidate,proof:SelectorNativeBindingProof):Data{
  assertSelectorNativeCandidate(candidate,definition);if(candidate.programKey!==runtime.key)throw new Error('execution candidate belongs to another recipe');const bound=runtime.verify(candidate,proof);
  const logicalInstanceKey=selectorExecutionInstanceKey({chainId:candidate.scope.chainId,familyId:family,target:candidate.target,
   ...(candidate.scope.poolId===undefined?{}:{poolId:candidate.scope.poolId}),...(candidate.scope.poolNamespace===undefined?{}:{poolNamespace:candidate.scope.poolNamespace}),immutableParameters:candidate.immutableParameters});
  // Parameter recipes are independently tested alternatives, never additional
  // liquidity. The physical resource key below excludes this binding suffix.
  const bindingScope={logicalInstanceKey,programKey:runtime.key,assets:bound.innerRoutes.map((r:Data)=>({tokenIn:r.tokenIn.toLowerCase(),tokenOut:r.tokenOut.toLowerCase(),tokenInId:r.tokenInId??null,tokenOutId:r.tokenOutId??null}))};
  const key=instanceKey(`execution-instance:${hash(bindingScope)}`);
  const data={familyId:family,lineageId:lineageId(runtime.lineage),instanceKey:key,logicalInstanceKey,target:candidate.target,programKey:runtime.key,
   candidate,proof,bound,runtimeRequirements:RUNTIME_REQUIREMENTS,provenance:[{kind:'selector-parameter-binding',subject:key,evidenceHash:hash({source:proof.source,rounds:proof.rounds,bound})}]};
  const sealed=frozen({...data,bindingFingerprint:hash(data)});
  checked.add(sealed);
  return sealed;
 }
 const checked=new WeakSet<object>();
 function assertDescriptor(descriptor:Data):SelectorNativeRuntime{
  const runtime=runtimeFor(descriptor);if(checked.has(descriptor))return runtime;
  if(hash(descriptorFor(runtime,descriptor.candidate,descriptor.proof))!==hash(descriptor))throw new Error('native descriptor differs from its source-bound transcript');
  if(deeplyFrozen(descriptor))checked.add(descriptor);return runtime;
 }
 const routeCache=new WeakMap<object,readonly Data[]>();
 function routesFor(descriptor:Data):readonly Data[]{
  const old=routeCache.get(descriptor);if(old)return old;
  assertDescriptor(descriptor);const candidate=descriptor.candidate;
  const routes=descriptor.bound.innerRoutes.map((inner:Data)=>{
   const poolId=candidate.scope.poolId??inner.venue?.poolId,poolNamespace=candidate.scope.poolNamespace??inner.venue?.poolNamespace;
   const scope={chainId:candidate.scope.chainId,target:candidate.target,...(poolId===undefined?{}:{poolId}),...(poolNamespace===undefined?{}:{poolNamespace}),
    tokenIn:inner.tokenIn.toLowerCase(),tokenOut:inner.tokenOut.toLowerCase(),
    ...(inner.tokenInId===undefined?{}:{tokenInId:String(inner.tokenInId)}),...(inner.tokenOutId===undefined?{}:{tokenOutId:String(inner.tokenOutId)})};
   const resource={chainId:candidate.scope.chainId,...inner.resource},resourceKey=selectorExecutionResourceKey(resource),key=routeKey(selectorExecutionRouteKey(descriptor.instanceKey,{tokenIn:{address:inner.tokenIn,...(inner.tokenInId===undefined?{}:{id:String(inner.tokenInId)})},tokenOut:{address:inner.tokenOut,...(inner.tokenOutId===undefined?{}:{id:String(inner.tokenOutId)})},direction:inner.direction}));
   const physical=inner.resources?new Map<string,Data>(inner.resources.map((value:Data)=>{const resource={...value,target:value.target,chainId:candidate.scope.chainId};return [selectorExecutionResourceKey(resource),resource];})):undefined;
   const resourceKeys=physical?[...physical.keys()].sort():undefined;
   return frozen({familyId:family,lineageId:descriptor.lineageId,instanceKey:descriptor.instanceKey,routeKey:key,adapterId:actionId,target:candidate.target,
    tokenIn:inner.tokenIn,tokenOut:inner.tokenOut,taxonomy:inner.taxonomy,...(inner.executionAssets?{executionAssets:inner.executionAssets}:{}),
    ...(inner.tokenInId===undefined?{}:{tokenInId:String(inner.tokenInId)}),...(inner.tokenOutId===undefined?{}:{tokenOutId:String(inner.tokenOutId)}),
    direction:inner.direction,programKey:descriptor.programKey,scope,resource,...(resourceKeys?{resources:resourceKeys.map(key=>physical!.get(key)!),resourceKeys}:{}),observationTarget:inner.target,...(resource.poolId===undefined?{}:{observationPoolId:resource.poolId}),resourceKey,pricingStateKey:`${resourceKey}:binding:${hash({logicalInstanceKey:descriptor.logicalInstanceKey,programKey:descriptor.programKey})}`,
    bindingRef:{bindingKey:descriptor.instanceKey,fingerprint:hash({definition:definitionHash,programKey:descriptor.programKey,parameters:descriptor.bound.descriptor,scope})},runtimeRequirements:RUNTIME_REQUIREMENTS});
  });
  if(new Set(routes.map((r:Data)=>r.routeKey)).size!==routes.length)throw new Error('duplicate native execution route');
  if(checked.has(descriptor))routeCache.set(descriptor,routes);return frozen(routes);
 }
 function invocation(input:Data):{runtime:SelectorNativeRuntime;inner:Data}{
  const runtime=assertDescriptor(input.descriptor),route=routesFor(input.descriptor).find(r=>r.routeKey===input.route.routeKey);
  if(!route||(route!==input.route&&hash(route)!==hash(input.route)))throw new Error('native route binding changed');
  const proof=input.descriptor.proof;
  if(input.executor!==undefined&&!same(input.executor,proof.executor))throw new Error('execution actor differs from Ready binding');
  if(input.executor!==undefined&&input.transactionOrigin?.toLowerCase()!==proof.transactionOrigin?.toLowerCase())throw new Error('execution origin differs from Ready binding');
  if(input.prefix?.length)throw new Error('native execution requires the central source-bound EVM prefix capability');
  const innerRoute=input.descriptor.bound.innerRoutes.find((r:Data)=>r.direction===route.direction)!;
  return {runtime,inner:{...input,candidate:input.descriptor.candidate,arguments:input.descriptor.bound.arguments,args:input.descriptor.bound.arguments,
   scope:input.descriptor.candidate.scope,descriptor:input.descriptor.bound.descriptor,route:innerRoute}};
 }
 // A missing token hint or an incompatible parameter recipe is a visible
 // unverified candidate. It must not abort unrelated Ready nominations.
 const bindingStep=(runtime:SelectorNativeRuntime,input:Data)=>{
  try{return runtime.step(input as any);}catch(error){return {requirements:{transports:[]},requests:[],decode:()=>({stage:'unavailable',source:input.source,executor:input.executor,rounds:input.evidence?.rounds??[],reason:`execution-binding-unavailable: ${error instanceof Error?error.message:String(error)}`})};}
 };
 const variants:IdentityVariant<any,any,any>[]=runtimes.map(runtime=>({id:runtime.key,kind:'custom',lineageId:lineageId(runtime.lineage),
  applies(candidate){try{assertSelectorNativeCandidate(candidate,definition);return candidate.programKey===runtime.key;}catch{return false;}},
  requirements(input){return bindingStep(runtime,input).requirements;},buildRequests(input){return bindingStep(runtime,input).requests;},
  decode(input){try{return bindingStep(runtime,input.step).decode(input.results);}catch(error){return {stage:'unavailable',source:input.step.source,executor:input.step.executor,rounds:input.step.evidence?.rounds??[],reason:`execution-binding-unavailable: ${error instanceof Error?error.message:String(error)}`};}},
  decide(input){if(input.evidence?.stage==='unavailable')return {status:'retryable',reasonCode:input.evidence.reason};
   if(!input.source||!input.executor)return {status:'retryable',reasonCode:'current source and executor authority required'};
   if(selectorNativeHasNonFungibleFlow(input.candidate))return {status:'retryable',reasonCode:'non-ERC20 token flow requires token-id balance observation'};
   if(input.evidence?.stage!=='complete')return {status:'continue'};
   assertSource(input.evidence.source,input.source);const descriptor=descriptorFor(runtime,input.candidate,input.evidence);
   return {status:'verified',identity:{familyId:family,lineageId:lineageId(runtime.lineage),subject:input.candidate.target,provenance:descriptor.provenance,descriptor}};
  }}));
 if(!variants.length)variants.push({id:'observed-non-entry',kind:'custom',lineageId:lineageId(`${family}:observed`),applies:()=>true,requirements:()=>({transports:[]}),buildRequests:()=>[],decode:()=>({}),
  decide:()=>({status:'invalid-program',reasonCode:definition.unsupportedReason!})});
 function dependencies(input:Data):readonly string[]{
  const descriptor=input.descriptor.instance??input.descriptor,runtime=assertDescriptor(descriptor);
  const found=new Set<string>(descriptor.bound.dependencies);
  function collect(v:any):void {if(typeof v==='string'&&/^0x[0-9a-f]{40}$/i.test(v))found.add(getAddress(v).toLowerCase());else if(v&&typeof v==='object')Object.values(v).forEach(collect);}
  collect(descriptor.bound.descriptor);collect(runtime.program.values?.constants);collect(runtime.program.execution);
  input.routes.forEach((r:Data)=>{found.add(r.target.toLowerCase());found.add(r.resource.target.toLowerCase());found.add(r.observationTarget.toLowerCase());found.add(r.tokenIn.toLowerCase());found.add(r.tokenOut.toLowerCase());
   r.resources?.forEach((resource:Data)=>found.add(resource.target.toLowerCase()));
   const mapped=invocation({descriptor,route:r});runtime.dependencies({...mapped.inner,source:descriptor.proof.source,executor:descriptor.proof.executor,transactionOrigin:descriptor.proof.transactionOrigin,runtimeEvidence:[]}).forEach(address=>found.add(address));});
  return [...found].sort();
 }
 const physicalCache=new WeakMap<object,WeakMap<object,ReturnType<typeof selectorNativePricingPools>>>();
 function pricingPools(input:Data){
  const old=physicalCache.get(input.descriptor)?.get(input.route);if(old)return old;
  const {runtime,inner}=invocation(input);
  let result:ReturnType<typeof selectorNativePricingPools>;
  if(definition.directState&&['selector-native-source','selector-native-source-identity'].includes(input.descriptor.candidate.candidateKind)){
   const resource=input.route.resource,scope=input.descriptor.candidate.scope;
   if(input.route.resources||resource.target!==scope.target||resource.poolId!==scope.poolId||
      resource.poolNamespace!==scope.poolNamespace||selectorExecutionResourceKey(resource)!==input.route.resourceKey)
    throw Error('source-declared physical owner differs from issued route');
   result=frozen([{poolAddress:resource.target,resourceKey:input.route.resourceKey,
    ...(resource.poolId===undefined?{}:{poolId:resource.poolId}),...(resource.poolNamespace===undefined?{}:{poolNamespace:resource.poolNamespace})}]);
  }else result=selectorNativePricingPools(runtime.program,input.route,inner.route);
  if(checked.has(input.descriptor)&&deeplyFrozen(input.route)){
   let byRoute=physicalCache.get(input.descriptor);if(!byRoute){byRoute=new WeakMap();physicalCache.set(input.descriptor,byRoute);}
   byRoute.set(input.route,result);
  }
  return result;
 }
 const programScopes=new Map<string,ReturnType<typeof createSqlEdgePriceLogScopes>>();
 const noScopes=()=>null;
 const mutation=scopeSelectorNativeMutation(createObservedExecutionMutation<Data,Data>({
  isLearned:()=>true,stateKey:route=>route.pricingStateKey,dependencies
 }),entry=>{
  const instance=entry.descriptor.instance??entry.descriptor,runtime=assertDescriptor(instance);
  const pools=entry.routes.map(route=>pricingPools({descriptor:instance,route}));
  let scopes=programScopes.get(runtime.key)??noScopes;
  if(scopes===noScopes&&pools.some(rs=>rs.some(r=>r.poolId!==undefined))){
   scopes=createSqlEdgePriceLogScopes([{...definition,programs:[runtime.program]}]);programScopes.set(runtime.key,scopes);
  }
  return selectorNativeMutationRole({program:runtime.program,instance,routes:entry.routes,pools,scopes});
 },dependencies,(entry,physical)=>{
  const instance=entry.descriptor.instance??entry.descriptor,runtime=assertDescriptor(instance);
  const owned=selectorPaidRankRole(runtime.key);
  return owned?{profile:owned({program:runtime.program,instance,routes:entry.routes,dependencies:entry.dependencies,physical})}:undefined;
 });
 function quote(input:Data,results:readonly AdapterRequestResult[]):Data{
  const {runtime,inner}=invocation(input),request=runtime.simulation(inner,`${input.route.routeKey}:simulation:${input.amountIn}`);
  const optional=runtime.ethCall(inner,`${request.id}:eth-call`),expected=[request.id,...(optional?[optional.id]:[])];
  if(results.length!==expected.length||new Set(results.map(r=>r.id)).size!==expected.length||results.some(r=>!expected.includes(r.id)))throw new Error('native quote result coverage mismatch');
  const amountOut=runtime.decodeSimulation(inner,request,results.find(r=>r.id===request.id)!);
  const comparison=runtime.decodeEthCall(inner,results.find(r=>r.id===optional?.id),amountOut);
  return {amountOut,evidence:frozen({kind:'selector-native-simulation',source:input.source,programKey:runtime.key,bindingFingerprint:input.descriptor.bindingFingerprint,
   routeKey:input.route.routeKey,executor:input.executor.toLowerCase(),...(input.transactionOrigin?{transactionOrigin:input.transactionOrigin.toLowerCase()}:{}),
   runtimeEvidence:input.runtimeEvidence??[],amountIn:input.amountIn,amountOut,...(comparison?{ethCall:comparison}:{}),results:[...results]})};
 }
 const action=createDeclarativeProgramAction({adapterId:actionId,lineage:`custom-protocol:${family}`,edgeKind:definition.domain==='swap'?'swap':'protocol',
  action:definition.domain==='swap'?'swap':'convert',canSendValue:false,leavesStandingPositionDefault:false} as any,[{signature:definition.signature}]);
 const signed=runtimes.flatMap(r=>r.signed?[r.signed.discovery]:[]);
 const discovery={...projection.discovery,...(signed.length?{
  canonicalIntakeTargets:list(signed.flatMap(s=>s.canonicalIntakeTargets)),runtimeEvidenceRouteActivation:{mode:'current-head-block-scan',scope:'family'},
  runtimeEvidenceFromObservation:(input:any)=>unique(signed.flatMap(s=>s.runtimeEvidenceFromObservation(input))),
  pendingRuntimeEvidenceFromObservation:async(input:any)=>unique((await Promise.all(signed.map(s=>s.pendingRuntimeEvidenceFromObservation(input)))).flat())}: {})};
 const result:any={manifest:projection.manifest,discovery,capture:createRouteCaptureMaterialization({familyId:family,discovery:discovery as any}),
  identity:{memoReuse:'recheck-identity',requiredReadRounds:Math.max(1,...runtimes.map(r=>r.requiredReadRounds)),variants,identityKey:(identity:Data)=>identity.descriptor.instanceKey},
  instance:{instanceKey:(identity:Data)=>identity.descriptor.instanceKey,compileDraft(identity:Data){assertDescriptor(identity.descriptor);if(identity.familyId!==family||identity.lineageId!==identity.descriptor.lineageId||identity.subject!==identity.descriptor.target)throw new Error('native ownership changed');return identity.descriptor;},
   finalizeDescriptor({draft,sharedBindings}:Data){if(sharedBindings.length)throw new Error('unexpected native shared binding');assertDescriptor(draft);return draft;},staticBindingProjection(descriptor:Data){assertDescriptor(descriptor);return [descriptor.programKey,descriptor.bindingFingerprint];}},
  routes:{project:({descriptor}:Data)=>routesFor(descriptor),pricingPools,projectGraph(input:Data){invocation(input);return {routeActionAdapterId:actionId,executionTarget:input.route.target,executionVerification:'startup-simulation',stateResourceKey:input.route.resourceKey,
   ...(input.route.resourceKeys?{stateResourceKeys:input.route.resourceKeys}:{}),
   observationTarget:input.route.observationTarget,...(input.route.observationPoolId===undefined?{}:{observationPoolId:input.route.observationPoolId}),
   venueIdentity:{scope:input.route.scope,resource:input.route.resource,...(input.route.resources?{resources:input.route.resources}:{}),selector:definition.selector,signature:definition.signature,immutableParameters:input.descriptor.candidate.immutableParameters,programKey:input.descriptor.programKey}};}},
  pricing:{refreshPolicy:runtimes.some(r=>r.program.refreshPolicy!=='on-touch')?'each-block':'on-touch',stateKey:(route:Data)=>route.pricingStateKey,
   // A descriptor identifies one verified recipe, not every recipe of the selector.
   // Leave homogeneous families (including the single-recipe Credit wrapper) unchanged.
   ...(definition.directState||runtimes.some(r=>r.program.refreshPolicy==='on-touch')&&runtimes.some(r=>r.program.refreshPolicy!=='on-touch')?{
    refreshPolicyForInstance({descriptor}:Data){
     const runtime=assertDescriptor(descriptor.instance);
     // This capability is issued only by the Family's declared discovery rule,
     // not by sharing its entry selector or a legacy recipe's program bytes.
     if(definition.directState&&['selector-native-source','selector-native-source-identity'].includes(descriptor.instance.candidate.candidateKind))return runtime.program.sourceRefreshPolicy??runtime.program.refreshPolicy??'each-block';
     return runtime.program.refreshPolicy==='on-touch'?'on-touch':'each-block';
    }}:{}),
   staticBindingProjection(input:Data){assertDescriptor(input.descriptor);return [input.descriptor.bindingFingerprint];},snapshotCompatibilityProjection(input:Data){assertDescriptor(input.descriptor);return [input.descriptor.bindingFingerprint];},
   compileDraft(input:Data){input.routes.forEach((route:Data)=>{invocation({descriptor:input.descriptor,route});if(route.pricingStateKey!==input.stateKey)throw new Error('native pricing group changed');});return {instance:input.descriptor,routes:input.routes,stateKey:input.stateKey};},
   finalizePricingDescriptor({draft,sharedBindings}:Data){if(sharedBindings.length)throw new Error('unexpected native pricing binding');assertDescriptor(draft.instance);return draft;},dependencies,
   mutation,
   current:{requirements:()=>({transports:[]}),buildRequests:()=>[],decodeSnapshot:()=>frozen({format:'awaiting-startup-simulation/v1'}),deriveMids:()=>new Map()}},
  exact:{methods(input:Data){const {runtime}=invocation(input);return [localZeroExactMethod('native-zero',()=>({amountOut:0n,evidence:{kind:'native-zero'}})),{
   id:'native-balance-simulation',kind:'request-program',chainAmountQuote:true,program:{requirements:()=>runtime.requirements,
    buildRequests(current:Data){const mapped=invocation(current),id=`${current.route.routeKey}:simulation:${current.amountIn}`,optional=mapped.runtime.ethCall(mapped.inner,`${id}:eth-call`);return [mapped.runtime.simulation(mapped.inner,id),...(optional?[optional]:[])];},
    decode({programInput,initialResults,dependentEvidence}:Data){if(dependentEvidence.length)throw new Error('unexpected native quote rounds');return quote(programInput,initialResults);}}}];},
   cacheCompatibilityProjection(input:Data){invocation(input);return [input.descriptor.bindingFingerprint,input.executor.toLowerCase(),input.transactionOrigin?.toLowerCase()??null,hash(input.runtimeEvidence??[])];}},
  execution:{buildRuntimeLeg(input:Data){const mapped=invocation(input);return mapped.runtime.buildRuntimeLeg(mapped.inner);},runtimeProjection:()=>({allowanceSpender:null,prewarmQuoteCalls:[]}),
   buildFragment(input:Data){const mapped=invocation(input),proof=input.exactEvidence;
    if(!proof||proof.kind!=='selector-native-simulation'||proof.programKey!==mapped.runtime.key||proof.bindingFingerprint!==input.descriptor.bindingFingerprint||proof.routeKey!==input.route.routeKey||
      !same(proof.executor,input.executor)||proof.transactionOrigin?.toLowerCase()!==input.transactionOrigin?.toLowerCase()||proof.amountIn!==input.amountIn||proof.amountOut!==input.quotedAmountOut||
      hash(proof.runtimeEvidence)!==hash(input.runtimeEvidence??[])||input.minAmountOut<=0n||input.minAmountOut>input.quotedAmountOut)throw new Error('native Exact receipt does not bind execution');
    if(input.source!==undefined)assertSource(proof.source,input.source);assertDeclarativeExecutionSource(proof.source);
    const checked=quote({...input,source:proof.source,runtimeEvidence:proof.runtimeEvidence},proof.results);if(checked.amountOut!==input.quotedAmountOut)throw new Error('native Exact receipt changed');
    const fragment=mapped.runtime.buildFragment({...mapped.inner,source:proof.source});return {...fragment,nodes:fragment.nodes.map((node:any)=>({...node,target:input.route.target}))};},
   expectedEffects(input:Data){invocation(input);return [{kind:'token-delta',token:input.route.tokenIn,account:'executor',direction:'decrease'},{kind:'token-delta',token:input.route.tokenOut,account:'executor',direction:'increase'}];}},actionAdapters:[action]};
 if(definition.domain==='protocol')result.protocol={candidateKinds:['observed-call'],activeBehaviorProof:'startup-simulation'};
 else result.swap=observations(runtimes,projection.manifest,discovery,assertDescriptor);
 return result;
}

function observations(runtimes:readonly SelectorNativeRuntime[],manifest:Data,discovery:Data,assertDescriptor:(descriptor:Data)=>SelectorNativeRuntime):Data {
 const entries:{runtime:SelectorNativeRuntime;domain:Data}[]=runtimes.flatMap(runtime=>{
  if(!runtime.program.observations)return [];
  const raw=JSON.parse(JSON.stringify(runtime.program.observations)),ids=new Map<string,string>();
  for(const event of raw.events){const codec=compileDeclarativeEventCodec(event);const pattern=codec.topic&&discovery.logPatterns?.find((p:Data)=>p.topic.toLowerCase()===codec.topic!.toLowerCase());if(pattern)ids.set(event.id,pattern.id);}
  for(const event of raw.events){event.id=ids.get(event.id)??event.id;if(event.relatedEvents)event.relatedEvents=event.relatedEvents.map((id:string)=>ids.get(id)??id);}
  return [{runtime,domain:compileDeclarativeSwap(raw,runtime.values,manifest)}];
 });
 if(!entries.length)return {victimSupport:'none'};
 const patterns=new Set([...(discovery.callPatterns??[]),...(discovery.logPatterns??[])].map((p:Data)=>p.id));
 const receipt=entries.map(e=>e.domain.receiptObservation);
 const landedPatterns=list(entries.flatMap(e=>e.domain.landedEvents.patternIds));
 return {victimSupport:'detect-only',...(landedPatterns.length?{landedEvents:{patternIds:landedPatterns,classify(input:Data){const classes=entries.map(e=>e.domain.landedEvents.classify(input as any));return classes.includes('swap')?'swap':classes.includes('mutation')?'mutation':null;}}}:{}),
  observation:{patternIds:list([...entries.flatMap(e=>e.domain.observation.patternIds).filter(id=>patterns.has(id)),...discovery.callPatterns.map((p:Data)=>p.id)]),decode:(input:Data)=>unique(entries.flatMap(e=>e.domain.observation.decode(input as any)))},
  receiptObservation:{topics:list(receipt.flatMap(r=>r.topics)),canonicalIntakeTargets:list(receipt.flatMap(r=>r.canonicalIntakeTargets)),
   ...(receipt.some(r=>r.anonymousLogs)?{anonymousLogs:unique(receipt.flatMap(r=>r.anonymousLogs??[]))}:{}),
   observedPoolIdentity(log:any){const values=list(receipt.map(r=>r.observedPoolIdentity(log)).filter((v):v is string=>v!==null));return values.length===1?values[0]:null;},
   async decodeReceiptImpacts(input:Data){const outputs=await Promise.all(entries.map(async({runtime,domain})=>{
    const graph=input.graph.filter((edge:Data)=>{const binding=input.resolveBinding?.(edge);return binding?.descriptor?.programKey===runtime.key;});
    const ids=input.matchedOwnedTriggers.filter((t:Data)=>domain.receiptObservation.topics.includes(t.topic0)||
     domain.receiptObservation.anonymousLogs?.length&&input.logs[t.logIndex]?.topics.length===0);if(!ids.length||!graph.length)return {status:'no-match'};
    const edgesByTarget=new Map<string,Data[]>();for(const edge of graph){const key=edgeObservationTarget(edge).toLowerCase();edgesByTarget.set(key,[...(edgesByTarget.get(key)??[]),edge]);}
    return domain.receiptObservation.decodeReceiptImpacts({...input,graph,edgesByTarget,matchedOwnedTriggers:ids,resolveBinding:(edge:Data)=>{
     const binding=input.resolveBinding?.(edge);if(!binding)return undefined;assertDescriptor(binding.descriptor);
     return {...binding,descriptor:{...binding.descriptor.bound.descriptor,familyId:binding.descriptor.familyId,instanceKey:binding.descriptor.instanceKey}};
    }} as any);
   }));
   const failed=outputs.find(o=>o.status==='unresolved');if(failed)return failed;
   const matched=outputs.filter((o:any)=>o.status==='resolved') as any[];if(!matched.length)return {status:'no-match'};
   return {status:'resolved',impacts:unique(matched.flatMap(o=>o.impacts)),mutations:unique(matched.flatMap(o=>o.mutations)),consumedTriggerIds:list(matched.flatMap(o=>o.consumedTriggerIds))};
  }} };
}
