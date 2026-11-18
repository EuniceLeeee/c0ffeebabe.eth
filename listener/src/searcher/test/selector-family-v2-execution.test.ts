import assert from 'node:assert/strict';
import test from 'node:test';
import { FunctionFragment, Interface, id, keccak256, toBeHex } from 'ethers';
import { readySelectorCensusFromTransaction } from '../ready-selector-census.js';
import { buildFamilyRouteGraphView } from '../adapter-family-graph-runtime.js';
import { createStrictCentralAdapterRuntime } from '../strict-central-adapter-runtime.js';
import { runStrictFamilyLifecycle } from '../strict-family-lifecycle-runner.js';
import { StrictProductionFamilyDeclarations } from '../strict-production-family-declarations.js';
import { StrictProductionRuntimeRoot } from '../strict-production-runtime-session.js';
import { defineSwapFamily, defineProtocolFamily, definedFamilyPluginContractSummary } from '../venues/adapter-family-plugin.js';
import { FamilyCapabilityCatalog, FAMILY_CAPABILITY_NAMES, capabilityManifestHash, asPricedFamily } from '../venues/family-capability-catalog.js';
import { executeFamilyExactQuote, buildFamilyExecutionFragment, buildFamilyRuntimeAmountLeg } from '../venues/adapter-family-runtime.js';
import { AdapterFamilyRegistry } from '../venues/adapter-family-registry.js';
import { hashCanonical } from '../venues/canonical-value.js';
import { compileSelectorNativeExecutionFamily } from '../venues/selector-native-family.js';
import { normalizeSelectorNativeExecutionDefinition, selectorNativeProgramKey } from '../venues/selector-native-definition.js';
import { selectorNativeCandidateFromCensus } from '../venues/selector-native-discovery.js';
import { createSelectorNativeRuntime } from '../venues/selector-native-runtime.js';
import { selectorExecutionResourceKey } from '../venues/selector-execution-keys.js';

const a=(n:number)=>toBeHex(n,20),h=(n:number)=>toBeHex(n,32);
const target=a(100),sender=a(101),executor=a(102),tokenIn=a(200),tokenOut=a(201),other=a(202),poolId=h(301);
const source={number:500,hash:h(500),generation:1},code='0x6001600055';
const signature='function execute(bytes32 pool,address input,address output,uint256 amount,uint256 minimum,address recipient) returns(uint256)';
const roles=['poolId','tokenIn','tokenOut','amountIn','minimumOut','recipient'];
function simple(payment:'none'|'approval'|'pretransfer'='none'):any{return {selector:FunctionFragment.from(signature).selector,signature,
  parameters:roles.map((role,index)=>({path:[index],role})),...(payment==='none'?{}:{payment:{kind:payment}})};}
const args=[poolId,tokenIn,tokenOut,7n,1n,sender];
function census(raw:any,arguments_:readonly unknown[]=args,logs:readonly any[]=[],transaction=501){
  return readySelectorCensusFromTransaction({chainId:1,transactionHash:h(transaction),blockNumber:source.number,blockHash:source.hash,status:1,
    from:sender,to:target,input:new Interface([raw.signature]).encodeFunctionData(raw.selector,arguments_),logs,traces:[]});
}
function fixture(raw:any,arguments_:readonly unknown[]=args,options:{logs?:readonly any[];noSimulator?:boolean;badDebit?:boolean}={}){
 const definition=normalizeSelectorNativeExecutionDefinition(raw),compiled=compileSelectorNativeExecutionFamily(definition);
 const plugin=(definition.domain==='swap'?defineSwapFamily(compiled as any):defineProtocolFamily(compiled as any)) as any;
 const familyId=plugin.manifest.familyId;
 const entries=FAMILY_CAPABILITY_NAMES.map(capability=>({familyId,capability,contractVersion:'selector-family-v2-test',contentHash:hashCanonical({definition,capability} as any),semanticDependencies:[`contract:${capability}`],provenanceCommit:null}));
 const catalog=new FamilyCapabilityCatalog({modules:[{sourceFile:'fixture/minimal.production.ts',plugin,definitionBoundaryHash:definedFamilyPluginContractSummary(plugin).definitionBoundaryHash}],generatedManifest:{format:'adapter-family-capabilities-v1',entries,manifestHash:capabilityManifestHash(entries)}});
 const observed=census(raw,arguments_,options.logs),reads:any[]=[],sims:any[]=[];
 const runtime=createStrictCentralAdapterRuntime({executor,transactionOrigin:sender,generationFence:{assertCurrent(g,s){assert.equal(g,source.generation);assert.deepEqual(s,source);}},
  provider:{async getCode(){reads.push('get-code');throw new Error('unexpected code read');},async getStorage(){reads.push('get-storage');throw new Error('unexpected storage read');},async call(tx){reads.push(tx);return h(99);}},
  ...(options.noSimulator?{}:{simulator:{executorProgramCodeHash:keccak256(code),async simulate({request}:any){sims.push(request);const funded=request.overrideIntent.tokenBalances[0];
   return {data:'0x',effects:{tokenDeltas:request.observeTokenBalances.map((row:any)=>({token:row.token,account:executor,delta:row.token.toLowerCase()===funded.token.toLowerCase()?-(options.badDebit?funded.amount-1n:funded.amount):funded.amount*2n})),nativeDeltas:[{account:executor,delta:0n}]}};
  }}})});
 const publish=()=>runStrictFamilyLifecycle({catalog,familyId,source,runtime,observations:[{kind:'call',source,target,sender,data:observed.calls[0]!.calldata!,transactionHash:observed.transactionHash!,traceAddress:[],opaque:{selectorCensus:observed,callId:observed.calls[0]!.id} as any}]});
 return {definition,plugin,familyId,catalog,runtime,reads,sims,publish,observed};
}
async function exact(f:ReturnType<typeof fixture>,publication:Awaited<ReturnType<ReturnType<typeof fixture>['publish']>>,amountIn=77n){
 return executeFamilyExactQuote({family:asPricedFamily(f.catalog.forFamily(f.familyId)),route:publication.instances[0]!.routeHandles[0]!,amountIn,source,generation:source.generation,runtime:f.runtime,executor,runtimeEvidence:[]});
}
function graph(f:ReturnType<typeof fixture>,publication:Awaited<ReturnType<ReturnType<typeof fixture>['publish']>>){return buildFamilyRouteGraphView({routes:publication.instances.flatMap(instance=>instance.routes.map((route,index)=>({family:f.catalog.forFamily(f.familyId),descriptor:instance.descriptor,route,handle:instance.routeHandles[index]!})))});}

test('v2 inline syntax canonicalizes once and inert metadata never changes runtime hashes or recipes',()=>{
 const raw=simple('approval'),inline=normalizeSelectorNativeExecutionDefinition(raw),{selector,signature,...program}=raw;
 const expanded=normalizeSelectorNativeExecutionDefinition({format:'selector-family/v2',selector,signature,domain:'swap',programs:[program]});
 const withMeta=normalizeSelectorNativeExecutionDefinition({selector,signature,meta:{identity:'old-brand',program:{op:'forbidden'}},programs:[{...program,meta:{name:'rename',source:'analysis-only'}}]});
 assert.deepEqual(inline,expanded);assert.deepEqual(inline,withMeta);assert.equal(inline.domain,'swap');assert.equal(inline.format,'selector-family/v2');
 assert.equal(hashCanonical(inline as any),hashCanonical(withMeta as any));assert.equal(selectorNativeProgramKey(inline.programs[0]!),selectorNativeProgramKey(withMeta.programs[0]!));
 assert(!JSON.stringify(withMeta).includes('old-brand'));assert(!Object.hasOwn(withMeta,'meta'));assert(!Object.hasOwn(withMeta.programs[0]!,'meta'));
 for(const bad of [{...raw,format:'selector-native-execution/v1'},{...raw,programs:[program]},{...raw,label:'old'},{selector,signature,programs:[{...program,label:'old'}]}])assert.throws(()=>normalizeSelectorNativeExecutionDefinition(bad));
});

test('metadata rejects executable properties, inherited prototypes, symbols and sparse arrays without evaluating getters',()=>{
 let invoked=0;const getter=Object.defineProperty({},'value',{enumerable:true,get(){invoked++;return 'bad';}});
 const array:any[]=[];Object.defineProperty(array,'0',{enumerable:true,get(){invoked++;return 'bad';}});
 const extra:any[]=[];Object.defineProperty(extra,'ignored',{enumerable:true,value:'bad'});
 const symbol={name:'meta',[Symbol('hidden')]:'bad'},sparse=new Array(1),inherited=Object.create({notJson:true});
 for(const meta of [getter,array,extra,symbol,sparse,inherited])assert.throws(()=>normalizeSelectorNativeExecutionDefinition({...simple(),meta}),/JSON|property/);
 assert.equal(invoked,0);
});

test('minimal swap seals, binds and enters the issued graph without observations, RPC, or Ready simulation',async()=>{
 const f=fixture(simple('approval')),published=await f.publish();assert.equal(published.instances.length,1,JSON.stringify(published.outcomes));
 assert.deepEqual(f.reads,[]);assert.deepEqual(f.sims,[]);assert.deepEqual(f.plugin.swap,{victimSupport:'none'});
 const view=graph(f,published),edge=view.edges[0]!;assert.equal(view.edges.length,1);assert.equal(edge.executionVerification,'startup-simulation');
 assert.equal(edge.stateResourceKey,selectorExecutionResourceKey({chainId:1,target,poolId,poolNamespace:'contract-pool-id'}));
 assert.equal((f.plugin.routes.projectGraph({descriptor:published.instances[0]!.descriptor,route:published.instances[0]!.routes[0]}).venueIdentity as any).scope.poolId,poolId);
 const declarations=new StrictProductionFamilyDeclarations(f.catalog);assert.equal(declarations.routeFamilies.length,1);assert.deepEqual(declarations.swapObservationGroups,[]);
 assert.equal(declarations.isSwapLog({address:target,topics:[id('Swap()')],data:'0x',blockNumber:500,blockHash:source.hash} as any),false);
 const {createStrictRegistryProjection}=await import('../venues/strict-catalog-registry-projection.js');
 const registry=new AdapterFamilyRegistry(createStrictRegistryProjection(f.catalog),{definitionBoundaryHashFor:()=>definedFamilyPluginContractSummary(f.plugin).definitionBoundaryHash},{strictProjected:true});
 assert.equal(registry.swaps().length,1);assert.deepEqual(registry.landedEvents().swapEvents,[]);assert.deepEqual(registry.victimModels().list(),[]);
 const root=new StrictProductionRuntimeRoot({catalog:f.catalog,readySource:source,readyGraph:view.edges,readyInstances:published.instances,readyFundingAssets:[]});
 const touched=root.resolveBlockTouchedStateKeys({kind:'call',target,data:'0xdeadbeef'},{number:501,hash:h(501)});
 assert.deepEqual(new Set(touched),new Set(published.instances.flatMap(i=>i.pricingInstances.map(p=>String(p.stateKey)))));
 const quote=await exact(f,published);assert.equal(quote.status,'resolved');if(quote.status!=='resolved')return;
 assert.equal(quote.amountOut,154n);assert.equal(f.sims.length,1);
 const built=buildFamilyExecutionFragment({family:asPricedFamily(f.catalog.forFamily(f.familyId)),route:published.instances[0]!.routeHandles[0]!,exact:quote,minAmountOut:154n,executor,runtimeEvidence:[],actionOwnership:f.catalog});
 assert.equal(built.status,'resolved');
});

test('default resource identity keeps observed pool IDs and explicit namespaces without guessing a router pool',async()=>{
 const raw={...simple(),binding:{nomination:{poolNamespace:'vault-scope'}}};
 const first=fixture(raw),second=fixture(raw,[h(302),...args.slice(1)]),one=await first.publish(),two=await second.publish();
 const edgeOne=graph(first,one).edges[0]!,edgeTwo=graph(second,two).edges[0]!;
 assert.notEqual(edgeOne.stateResourceKey,edgeTwo.stateResourceKey);assert.notEqual(one.instances[0]!.instanceKey,two.instances[0]!.instanceKey);
 assert.equal(edgeOne.stateResourceKey,selectorExecutionResourceKey({chainId:1,target,poolId,poolNamespace:'vault-scope'}));
 const projected=first.plugin.routes.projectGraph({descriptor:one.instances[0]!.descriptor,route:one.instances[0]!.routes[0]});
 assert.equal(projected.venueIdentity.resource.target,target);assert.equal(projected.venueIdentity.scope.poolNamespace,'vault-scope');
 assert.equal(edgeOne.observationPoolId,poolId);
});

test('partial bindings complement missing token addresses and logical IDs while conflicting observations are rejected',async()=>{
 const signature='function convert(uint256 amount,address recipient,uint256 inputId) returns(uint256)';
 const raw={selector:FunctionFragment.from(signature).selector,signature,parameters:[{path:[0],role:'amountIn'},{path:[1],role:'recipient'},{path:[2],role:'tokenInId'}],binding:{descriptor:{tokenIn,tokenOut,tokenOutId:'11'}}};
 const f=fixture(raw,[7n,sender,9n]),p=await f.publish();assert.equal(p.instances.length,1,JSON.stringify(p.outcomes));
 const route=p.instances[0]!.routes[0]! as any,descriptor=(p.instances[0]!.descriptor as any).bound.descriptor;
 assert.equal(route.tokenIn.toLowerCase(),tokenIn);assert.equal(route.tokenOut.toLowerCase(),tokenOut);assert.equal(route.tokenInId,'9');assert.equal(route.tokenOutId,'11');
 assert.equal(descriptor.target,target);assert.deepEqual(descriptor.args,descriptor.arguments);assert.equal(f.reads.length,0);
 for(const binding of [{tokenIn:other},{poolId:h(999)},{poolNamespace:'wrong'}]){
  const bad={...simple(),binding:{nomination:{poolNamespace:'expected'},descriptor:binding}},definition=normalizeSelectorNativeExecutionDefinition(bad),observed=census(bad),candidate=selectorNativeCandidateFromCensus(definition,observed,observed.calls[0]!.id)!;
  const runtime=createSelectorNativeRuntime(definition,definition.programs[0]!);
  assert.throws(()=>runtime.step({candidate,source,executor,transactionOrigin:sender}),/differs from execution parameter binding/);
 }
 const conflict={...raw,binding:{descriptor:{tokenIn,tokenOut,tokenInId:'10'}}},definition=normalizeSelectorNativeExecutionDefinition(conflict),observed=census(conflict,[7n,sender,9n]);
 const candidate=selectorNativeCandidateFromCensus(definition,observed,observed.calls[0]!.id)!;
 assert.throws(()=>createSelectorNativeRuntime(definition,definition.programs[0]!).step({candidate,source,executor,transactionOrigin:sender}),/token id differs/);
});

test('unique ERC20 transfer hints can fill a minimal route and ambiguous transfer sets remain unverified',async()=>{
 const signature='function convert(uint256 amount) returns(uint256)',raw={selector:FunctionFragment.from(signature).selector,signature,parameters:[{path:[0],role:'amountIn'}]};
 const transfer=(token:string,from:string,to:string,amount:bigint,index:number)=>({address:token,topics:[id('Transfer(address,address,uint256)'),h(Number(BigInt(from))),h(Number(BigInt(to)))],data:toBeHex(amount,32),logIndex:index});
 const logs=[transfer(tokenIn,sender,target,7n,0),transfer(tokenOut,target,sender,14n,1)];
 const f=fixture(raw,[7n],{logs}),p=await f.publish();assert.equal(p.instances.length,1,JSON.stringify(p.outcomes));assert.equal(p.instances[0]!.routes[0]!.tokenIn.toLowerCase(),tokenIn);
 const unknown=census(raw,[7n],[...logs,transfer(other,target,sender,3n,2)]),definition=normalizeSelectorNativeExecutionDefinition(raw),candidate=selectorNativeCandidateFromCensus(definition,unknown,unknown.calls[0]!.id)!;
 assert(candidate);assert.equal(candidate.scope.tokenOut,undefined);
 assert.throws(()=>createSelectorNativeRuntime(definition,definition.programs[0]!).step({candidate,source,executor,transactionOrigin:sender}));
 const unavailable=fixture(raw,[7n],{logs:[...logs,transfer(other,target,sender,3n,2)]});
 await assert.rejects(unavailable.publish(),/identity-work-unresolved.*execution-binding-unavailable/);
});

for(const kind of ['none','approval','pretransfer'] as const)test(`simple ${kind} payment produces the same guarded VM program as its explicit declaration`,async()=>{
 const raw=simple(kind),base={settlement:{directOutput:true},requireCanonicalSource:true,protectedAddresses:['$target','$route.tokenIn','$route.tokenOut'],effects:[
  {kind:'debit',token:'$route.tokenIn',account:'$executor',equals:{runtime:'amountIn'}},{kind:'credit',token:'$route.tokenOut',account:'$recipient',minimum:'$minAmountOut'},{kind:'unchanged-native'},
  {kind:'unchanged-token',token:'$route.tokenOut',account:'$executor',when:'$externalRecipient'},{kind:'unchanged-token',token:'$route.tokenIn',account:'$recipient',when:'$externalRecipient'}]},
  call={target:'$target',signature,args:[poolId,'$route.tokenIn','$route.tokenOut',{runtime:'amountIn'},'$minAmountOut','$recipient']};
 const execution=kind==='pretransfer'?{...base,version:2,steps:[{id:'payment',call:{target:'$route.tokenIn',signature:'function transfer(address,uint256) returns(bool)',args:['$target',{runtime:'amountIn'}]}},{id:'execute',call}]}:
  {...base,version:1,call,...(kind==='approval'?{approval:{token:'$route.tokenIn',spender:'$target',mode:'exact-clear',verifyAllowance:true}}:{})};
 const a=fixture(raw),b=fixture({...raw,execution}),pa=await a.publish(),pb=await b.publish();
 const leg=(f:ReturnType<typeof fixture>,p:Awaited<ReturnType<typeof f.publish>>)=>buildFamilyRuntimeAmountLeg({family:asPricedFamily(f.catalog.forFamily(f.familyId)),route:p.instances[0]!.routeHandles[0]!,source,runtime:f.runtime,executor,runtimeEvidence:[],actionOwnership:f.catalog});
 assert.deepEqual(leg(a,pa),leg(b,pb));assert(leg(a,pa));
});

test('a call without a recipient parameter only advertises executor settlement',async()=>{
 const signature='function convert(address,address,uint256) returns(uint256)',raw={selector:FunctionFragment.from(signature).selector,signature,parameters:['tokenIn','tokenOut','amountIn'].map((role,i)=>({path:[i],role}))};
 const f=fixture(raw,[tokenIn,tokenOut,7n]),p=await f.publish(),common={family:asPricedFamily(f.catalog.forFamily(f.familyId)),route:p.instances[0]!.routeHandles[0]!,source,runtime:f.runtime,executor,runtimeEvidence:[],actionOwnership:f.catalog};
 const leg=buildFamilyRuntimeAmountLeg(common);assert(leg);assert.equal(leg.settlement?.directOutput,undefined);
 assert.equal(buildFamilyRuntimeAmountLeg({...common,settlement:{kind:'direct-output',recipient:other}}),null);
 assert.equal((await exact(f,p)).status,'resolved');
});

test('eth_call never grants an execution quote when balance simulation is absent or contradicts actual input',async()=>{
 const raw={...simple(),ethCall:{signature:'function preview(uint256) view returns(uint256)',arguments:['$amountIn'],outputWord:0}};
 for(const options of [{noSimulator:true},{badDebit:true}]){
  const f=fixture(raw,args,options),p=await f.publish();assert.equal(p.instances.length,1);assert.equal(f.reads.length,0);assert.equal(f.sims.length,0);
  const result=await exact(f,p);assert.notEqual(result.status,'resolved');
  assert.equal(graph(f,p).edges[0]!.executionVerification,'startup-simulation');
 }
});
