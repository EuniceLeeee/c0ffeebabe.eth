import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FunctionFragment, Interface, id, keccak256, toBeHex } from 'ethers';
import { readySelectorCensusFromTransaction } from '../ready-selector-census.js';
import { createStrictCentralAdapterRuntime } from '../strict-central-adapter-runtime.js';
import { runStrictFamilyLifecycle } from '../strict-family-lifecycle-runner.js';
import { defineProtocolFamily, defineSwapFamily, definedFamilyPluginContractSummary } from '../venues/adapter-family-plugin.js';
import { FamilyCapabilityCatalog, FAMILY_CAPABILITY_NAMES, capabilityManifestHash, asPricedFamily } from '../venues/family-capability-catalog.js';
import { executeFamilyExactQuote, buildFamilyExecutionFragment, buildFamilyRuntimeAmountLeg } from '../venues/adapter-family-runtime.js';
import { hashCanonical } from '../venues/canonical-value.js';
import { compileSelectorNativeExecutionFamily } from '../venues/selector-native-family.js';
import { normalizeSelectorNativeExecutionDefinition } from '../venues/selector-native-definition.js';
import { selectorExecutionResourceKey } from '../venues/selector-execution-keys.js';
const VENUES=resolve(dirname(fileURLToPath(import.meta.url)),'../venues/selector-native');
const address=(n:number)=>toBeHex(n,20),ACTOR=address(1001),SENDER=address(1002),TARGET=address(1003),ASSET=address(1011),SHARE=TARGET;
const SOURCE={number:100,hash:toBeHex(100,32),generation:1},CODE='0x6001600055';
function load(selector:string,labelSuffix?:string){const raw=JSON.parse(readFileSync(resolve(VENUES,`selector-${selector}-family/selector-${selector}.json`),'utf8'));
 if(labelSuffix)raw.programs=raw.programs.filter((p:any)=>p.meta?.label?.endsWith(labelSuffix));
 return normalizeSelectorNativeExecutionDefinition(raw) as any;}
function fixture(raw:any,target:string,args:readonly unknown[],read?:(data:string,to:string)=>string,mode:{badDebit?:boolean;revert?:boolean;logs?:readonly unknown[]}={}){
 const definition=normalizeSelectorNativeExecutionDefinition(raw),compiled=compileSelectorNativeExecutionFamily(definition);
 const plugin=(definition.domain==='swap'?defineSwapFamily(compiled as any):defineProtocolFamily(compiled as any)) as any;
 const familyId=plugin.manifest.familyId;
 const entries=FAMILY_CAPABILITY_NAMES.map(capability=>({familyId,capability,contractVersion:'native-regression/v1',contentHash:hashCanonical({capability,definition:JSON.stringify(definition)}),semanticDependencies:[`contract:${capability}`],provenanceCommit:null}));
 const catalog=new FamilyCapabilityCatalog({modules:[{sourceFile:'test/native.production.ts',plugin,definitionBoundaryHash:definedFamilyPluginContractSummary(plugin).definitionBoundaryHash}],generatedManifest:{format:'adapter-family-capabilities-v1',entries,manifestHash:capabilityManifestHash(entries)}});
 const abi=new Interface([definition.signature]),census=readySelectorCensusFromTransaction({chainId:1,transactionHash:toBeHex(101,32),blockNumber:SOURCE.number,blockHash:SOURCE.hash,status:1,from:SENDER,to:target,input:abi.encodeFunctionData(definition.selector,args),logs:mode.logs??[],traces:[]});
 const requests:any[]=[],simulated:any[]=[];
 const runtime=createStrictCentralAdapterRuntime({executor:ACTOR,transactionOrigin:SENDER,generationFence:{assertCurrent(generation,source){assert.equal(generation,SOURCE.generation);assert.deepEqual(source,SOURCE);}},
  provider:{async getCode(){requests.push('get-code');return CODE;},async getStorage(){throw new Error('unexpected storage read');},async call(tx){requests.push(tx);if(!read)throw new Error('unexpected Ready RPC');return read(tx.data,tx.to);}},
  simulator:{executorProgramCodeHash:keccak256(CODE),async simulate({request}){simulated.push(request);const amount=request.overrideIntent.tokenBalances![0]!,input=amount.token.toLowerCase();
   return mode.revert?{data:'0x',completion:'reverted' as const}:{data:'0x',effects:{tokenDeltas:request.observeTokenBalances!.map(row=>({token:row.token,account:ACTOR,delta:row.token.toLowerCase()===input?-(mode.badDebit?amount.amount-1n:amount.amount):amount.amount*2n})),nativeDeltas:[{account:ACTOR,delta:0n}]}};
  }}});
 const publish=()=>runStrictFamilyLifecycle({catalog,familyId,source:SOURCE,runtime,observations:[{kind:'call',source:SOURCE,target,sender:SENDER,data:census.calls[0]!.calldata!,transactionHash:census.transactionHash!,traceAddress:[],opaque:{selectorCensus:census,callId:census.calls[0]!.id} as any}]});
 return {definition,plugin,familyId,catalog,runtime,requests,simulated,publish};
}
const simpleSignature='function convert(address tokenIn,address tokenOut,uint256 amount,address recipient,uint256 pool) returns(uint256)';
function simple(multiple=false){const program={parameters:[{path:[0],role:'tokenIn'},{path:[1],role:'tokenOut'},{path:[2],role:'amountIn'},{path:[3],role:'recipient'},{path:[4],role:'bound'}],binding:{nomination:{tokenInPath:[0],tokenOutPath:[1],parameterPaths:[[4]]},facts:{},descriptor:{target:'$target'}},payment:{kind:'none'}};
 return {format:'selector-family/v2',selector:FunctionFragment.from(simpleSignature).selector,signature:simpleSignature,domain:'protocol',programs:[program,...(multiple?[{...program,payment:{kind:'approval'}}]:[])]};}

test('all migrated execution references and observed interfaces compile without old definitions or adapters',()=>{
 const executableSelectors=new Set<string>();for(const dir of readdirSync(VENUES)){const path=resolve(VENUES,dir,`${dir.replace(/-family$/,'')}.json`);let raw:any;try{raw=JSON.parse(readFileSync(path,'utf8'));}catch{continue;}if(raw.domain==='funding'||raw.domain==='credit')continue;
  const definition=normalizeSelectorNativeExecutionDefinition(raw),compiled=compileSelectorNativeExecutionFamily(definition);(definition.domain==='swap'?defineSwapFamily:defineProtocolFamily)(compiled as any);if(definition.programs.length)executableSelectors.add(definition.selector);
  assert(!JSON.stringify(raw).includes('bindingPlugin'));assert(!JSON.stringify(raw).includes('"source": "../../'));
 }
 const report=JSON.parse(readFileSync(resolve(VENUES,'../../generated/selector-native-migration.generated.json'),'utf8'));assert.equal(report.executableReferences,99);assert.deepEqual(report.pending,[]);
 const originalSelectors=new Set<string>(report.migrations.map((row:any)=>row.selector));assert.equal(originalSelectors.size,57);
 for(const selector of originalSelectors)assert(executableSelectors.has(selector),`original Exact selector was lost: ${selector}`);
 const migration=JSON.parse(readFileSync(new URL('../../../../scripts/selector-family-v2-migration.json',import.meta.url),'utf8'));
 assert.equal(migration.declarations.length,95);
 for(const declaration of migration.declarations){const raw=JSON.parse(readFileSync(new URL('../../../../'+declaration.source,import.meta.url),'utf8'));assert.equal(raw.format,'selector-family/v2');assert.equal(raw.selector,declaration.selector);}

});
test('simple ABI definitions reject omitted, overlapping, out-of-range and mistyped parameter roles',()=>{
 const original=simple();for(const change of [(p:any)=>{p.parameters.pop();},(p:any)=>{p.parameters.push({...p.parameters[0]});},(p:any)=>{p.parameters[0].path=[99];},(p:any)=>{p.parameters[2].role='recipient';},(p:any)=>{p.parameters[2].role='bound';}]){
  const copy=JSON.parse(JSON.stringify(original));change(copy.programs[0]);assert.throws(()=>normalizeSelectorNativeExecutionDefinition(copy),/parameter|amountIn/);
 }
});
test('simple selector parameters bind with zero RPC and zero Ready SIM, then one execution SIM quotes the new amount',async()=>{
 const f=fixture(simple(),TARGET,[ASSET,address(1012),7n,SENDER,5n]);const publication=await f.publish();
 assert.equal(publication.instances.length,1,JSON.stringify(publication.outcomes));assert.deepEqual(f.requests,[]);assert.deepEqual(f.simulated,[]);
 const instance=publication.instances[0]!,route=instance.routeHandles[0]!,family=asPricedFamily(f.catalog.forFamily(f.familyId));
 assert.equal(f.plugin.routes.projectGraph({descriptor:instance.descriptor,route:instance.routes[0]}).executionVerification,'startup-simulation');
 const exact=await executeFamilyExactQuote({family,route,amountIn:77n,source:SOURCE,generation:SOURCE.generation,runtime:f.runtime,executor:ACTOR,runtimeEvidence:[]});
 assert.equal(exact.status,'resolved',JSON.stringify(exact,(_k,v)=>typeof v==='bigint'?String(v):v));if(exact.status!=='resolved')return;assert.equal(exact.amountOut,154n);assert.equal(f.simulated.length,1);
 const fragment=buildFamilyExecutionFragment({family,route,exact,minAmountOut:exact.amountOut,executor:ACTOR,runtimeEvidence:[],actionOwnership:f.catalog});
 assert.equal(fragment.status,'resolved');assert(buildFamilyRuntimeAmountLeg({family,route,source:SOURCE,executor:ACTOR,runtimeEvidence:[],runtime:f.runtime,actionOwnership:f.catalog}));
});
test('a single selector keeps all parameter recipes while their physical liquidity resource is shared',async()=>{
 const f=fixture(simple(true),TARGET,[ASSET,address(1012),7n,SENDER,5n]);const p=await f.publish();assert.equal(p.instances.length,2,JSON.stringify(p.outcomes));
 const rows=p.instances.map(i=>({descriptor:i.descriptor,route:i.routes[0]!}));assert.equal(new Set(rows.map(r=>f.plugin.routes.projectGraph(r).stateResourceKey)).size,1);
 assert.equal(new Set(p.instances.map(i=>i.instanceKey)).size,2);assert.equal(new Set(rows.map(r=>r.route.routeKey)).size,2);
});
test('SIM rejects a receipt with the wrong debit and never turns it into a successful quote',async()=>{
 const f=fixture(simple(),TARGET,[ASSET,address(1012),7n,SENDER,5n],undefined,{badDebit:true}),p=await f.publish();const family=asPricedFamily(f.catalog.forFamily(f.familyId));
 const result=await executeFamilyExactQuote({family,route:p.instances[0]!.routeHandles[0]!,amountIn:77n,source:SOURCE,generation:SOURCE.generation,runtime:f.runtime,executor:ACTOR,runtimeEvidence:[]});assert.notEqual(result.status,'resolved');
});
test('migrated redeem uses its execution ABI and needs only executable token binding, no identity probes',async()=>{
 const raw=load('ba087652','/standalone-standard-behavior');
 const getter=new Interface(['function asset() view returns(address)']);
 const f=fixture(raw,TARGET,[7n,SENDER,SENDER],data=>getter.encodeFunctionResult(getter.parseTransaction({data})!.fragment,[ASSET]));const p=await f.publish();
 assert.equal(p.instances.length,1,JSON.stringify(p.outcomes));assert.equal(f.requests.length,1);assert.equal(f.simulated.length,0);
 const row=p.instances[0]!,route=row.routes[0]!;assert.equal(route.tokenIn.toLowerCase(),SHARE);assert.equal(route.tokenOut.toLowerCase(),ASSET);
 const family=asPricedFamily(f.catalog.forFamily(f.familyId)),exact=await executeFamilyExactQuote({family,route:row.routeHandles[0]!,amountIn:123n,source:SOURCE,generation:SOURCE.generation,runtime:f.runtime,executor:ACTOR,runtimeEvidence:[]});
 assert.equal(exact.status,'resolved',JSON.stringify(exact,(_k,v)=>typeof v==='bigint'?String(v):v));if(exact.status==='resolved')assert.equal(exact.amountOut,246n);
});

test('a migrated multi-asset selector binds its observed ordered pair and touched invalidates all existing price groups',async()=>{
 const tokens=[ASSET,address(1012),address(1013)],abi=new Interface(['function tokensCount() view returns(uint256)','function changesEnabled() view returns(bool)','function changeFee() view returns(uint256)','function TOTAL_PERCRENTS() view returns(uint256)','function inLendingMode() view returns(uint256)','function supportsInterface(bytes4) view returns(bool)','function tokens(uint256) view returns(address)','function weights(address) view returns(uint256)','function decimals() view returns(uint8)']);
 const f=fixture(load('5e5144eb'),TARGET,[tokens[0],tokens[1],123n,1n],data=>{const p=abi.parseTransaction({data})!;const v=p.name==='tokensCount'?3n:p.name==='changesEnabled'||p.name==='supportsInterface'?true:p.name==='TOTAL_PERCRENTS'?10000n:p.name==='tokens'?tokens[Number(p.args[0])]:p.name==='weights'?1000n:p.name==='decimals'?6n:0n;return abi.encodeFunctionResult(p.fragment,[v]);});
 const publication=await f.publish(),instance=publication.instances[0]!;assert.equal(instance.routes.length,1);assert.equal(f.requests.length,0);assert.equal(f.simulated.length,0);
 assert.equal(new Set(instance.routes.map(route=>f.plugin.routes.projectGraph({descriptor:instance.descriptor,route}).stateResourceKey)).size,1);
 const family=asPricedFamily(f.catalog.forFamily(f.familyId));
 for(const route of instance.routeHandles){const exact=await executeFamilyExactQuote({family,route,amountIn:11n,source:SOURCE,generation:SOURCE.generation,runtime:f.runtime,executor:ACTOR,runtimeEvidence:[]});assert.equal(exact.status,'resolved',JSON.stringify(exact,(_k,v)=>typeof v==='bigint'?String(v):v));}
 const groups=instance.routes.map(route=>{const stateKey=f.plugin.pricing.stateKey(route),descriptor=f.plugin.pricing.compileDraft({descriptor:instance.descriptor,routes:[route],stateKey});return {stateKey,descriptor,routes:[route],dependencies:f.plugin.pricing.dependencies({descriptor,routes:[route]})};});
 const mutation=f.plugin.pricing.mutation.compile({entries:groups});assert.equal(mutation.affectedStateKeys({observation:{kind:'call',source:SOURCE,target:TARGET,data:'0xdeadbeef'}}).length,new Set(groups.map(g=>g.stateKey)).size);
});

test('a singleton entry keeps execution target, observation target, physical resource and pool id independent',async()=>{
 const vault='0xba12222222228d8ba445958a75a0704d566bf2c8',pool=address(1050),poolId=`${pool}0001${'00'.repeat(10)}`,tokens=[ASSET,address(1012),address(1013)];
 const abi=new Interface(['function getPool(bytes32) view returns(address,uint8)','function getPoolTokens(bytes32) view returns(address[],uint256[],uint256)','function decimals() view returns(uint8)']);
 const f=fixture(load('52bbbe29'),vault,[[poolId,0,tokens[0],tokens[1],123n,'0x'],[SENDER,false,SENDER,false],0n,9999999n],data=>{const p=abi.parseTransaction({data})!;return abi.encodeFunctionResult(p.fragment,p.name==='getPool'?[pool,1]:p.name==='getPoolTokens'?[tokens,[50000n,60000n,70000n],99n]:[6]);});
 const publication=await f.publish(),instance=publication.instances[0]!;assert.equal(instance.routes.length,6);assert.equal(f.simulated.length,0);
 for(const route of instance.routes){const projected=f.plugin.routes.projectGraph({descriptor:instance.descriptor,route});assert.equal(projected.executionTarget,vault);assert.equal(projected.observationTarget.toLowerCase(),pool);assert.equal(projected.observationPoolId,poolId);assert.equal(projected.venueIdentity.resource.target,vault);}
 const family=asPricedFamily(f.catalog.forFamily(f.familyId)),exact=await executeFamilyExactQuote({family,route:instance.routeHandles[0]!,amountIn:17n,source:SOURCE,generation:SOURCE.generation,runtime:f.runtime,executor:ACTOR,runtimeEvidence:[]});assert.equal(exact.status,'resolved',JSON.stringify(exact,(_k,v)=>typeof v==='bigint'?String(v):v));
});

test('optional eth_call compares the new amount with SIM and cannot replace its debit proof',async()=>{
 const raw=simple();Object.assign(raw.programs[0]!,{ethCall:{signature:'function preview(uint256) view returns(uint256)',arguments:['$amountIn'],outputWord:0}});
 const abi=new Interface(['function preview(uint256) view returns(uint256)']);
 const f=fixture(raw,TARGET,[ASSET,address(1012),7n,SENDER,5n],data=>{const p=abi.parseTransaction({data})!;assert.equal(p.args[0],77n);return abi.encodeFunctionResult(p.fragment,[999n]);});
 const p=await f.publish();assert.equal(f.requests.length,0);const exact=await executeFamilyExactQuote({family:asPricedFamily(f.catalog.forFamily(f.familyId)),route:p.instances[0]!.routeHandles[0]!,amountIn:77n,source:SOURCE,generation:SOURCE.generation,runtime:f.runtime,executor:ACTOR,runtimeEvidence:[]});
 assert.equal(exact.status,'resolved');if(exact.status==='resolved')assert.equal(exact.amountOut,154n);assert.equal(f.requests.length,1);
});

test('logical token IDs remain in executable ERC20 route identity while actual NFT flows stay unverified',async()=>{
 const raw=simple();Object.assign(raw.programs[0]!.binding.nomination,{tokenInIdPath:[4]});
 const f=fixture(raw,TARGET,[ASSET,address(1012),7n,SENDER,5n]),p=await f.publish();
 assert.equal(p.instances.length,1,JSON.stringify(p.outcomes));
 const route=p.instances[0]!.routes[0]! as any;assert.equal(route.tokenInId,'5');assert.equal(route.scope.tokenInId,'5');
 const other=await fixture(raw,TARGET,[ASSET,address(1012),7n,SENDER,6n]).publish();assert.notEqual(other.instances[0]!.routes[0]!.routeKey,route.routeKey);
 const exact=await executeFamilyExactQuote({family:asPricedFamily(f.catalog.forFamily(f.familyId)),route:p.instances[0]!.routeHandles[0]!,amountIn:77n,source:SOURCE,generation:SOURCE.generation,runtime:f.runtime,executor:ACTOR,runtimeEvidence:[]});
 assert.equal(exact.status,'resolved');
 const nft=fixture(raw,TARGET,[ASSET,address(1012),7n,SENDER,5n],undefined,{logs:[{address:ASSET,topics:[id('Transfer(address,address,uint256)'),toBeHex(BigInt(SENDER),32),toBeHex(BigInt(TARGET),32),toBeHex(5,32)],data:'0x',logIndex:0}]});
 await assert.rejects(nft.publish(),/non-ERC20 token flow requires token-id balance observation/);assert.equal(nft.simulated.length,0);
});

test('a composite execution publishes its complete physical resources and either pool touch invalidates pricing',async()=>{
 const raw=load('cb70e273'),constants=raw.programs[0].values.constants;
 const f=fixture(raw,TARGET,[constants.path,[7n],SENDER]),p=await f.publish();assert.equal(p.instances.length,1,JSON.stringify(p.outcomes));
 const instance=p.instances[0]!,route=instance.routes[0]! as any,projection=f.plugin.routes.projectGraph({descriptor:instance.descriptor,route});
 const expected=[constants.curve,constants.vault].map(target=>selectorExecutionResourceKey({chainId:1,target})).sort();
 assert.deepEqual(projection.stateResourceKeys,expected);assert(!projection.stateResourceKeys.includes(selectorExecutionResourceKey({chainId:1,target:TARGET})));
 const stateKey=f.plugin.pricing.stateKey(route),descriptor=f.plugin.pricing.compileDraft({descriptor:instance.descriptor,routes:[route],stateKey}),dependencies=f.plugin.pricing.dependencies({descriptor,routes:[route]});
 const mutation=f.plugin.pricing.mutation.compile({entries:[{stateKey,descriptor,routes:[route],dependencies}]});
 for(const target of [constants.curve,constants.vault])assert.deepEqual(mutation.affectedStateKeys({observation:{kind:'call',source:SOURCE,target,data:'0xdeadbeef'}}),[stateKey]);
});
