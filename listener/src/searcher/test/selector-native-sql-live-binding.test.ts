import assert from 'node:assert/strict';
import test from 'node:test';
import { FunctionFragment, Interface, ZeroAddress, toBeHex } from 'ethers';
import { runStrictFamilyLifecycle } from '../strict-family-lifecycle-runner.js';
import { createStrictCentralAdapterRuntime } from '../strict-central-adapter-runtime.js';
import { readySelectorCensusFromTransaction } from '../ready-selector-census.js';
import { compileSelectorNativeExecutionFamily } from '../venues/selector-native-family.js';
import { normalizeSelectorNativeExecutionDefinition, selectorNativeProgramKey } from '../venues/selector-native-definition.js';
import { defineSwapFamily, definedFamilyPluginContractSummary } from '../venues/adapter-family-plugin.js';
import { FamilyCapabilityCatalog, FAMILY_CAPABILITY_NAMES, capabilityManifestHash } from '../venues/family-capability-catalog.js';
import { hashCanonical } from '../venues/canonical-value.js';
import { assertSqlLiveRouteBinding } from '../venues/selector-native-sql-live-binding.js';

test('only the genuinely issued, source-bound direction and the paid recipe match', async () => {
  const addr = (n:number) => toBeHex(n,20), executor = addr(11), owner = addr(12), pool = addr(13), a = addr(14), b = addr(15);
  const source = { number: 99, hash: toBeHex(99,32), generation: 3 };
  const signature = 'function convert(address,address,uint256,address) returns(uint256)', selector = FunctionFragment.from(signature).selector;
  const definition = normalizeSelectorNativeExecutionDefinition({ format:'selector-family/v2', signature, selector, domain:'swap', programs:[{
    parameters:['tokenIn','tokenOut','amountIn','recipient'].map((role,i)=>({role,path:[i]})),
    routes:{ target:'$descriptor.target', resource:{target:'$descriptor.target'}, directions:[
      {id:'convert', enabled:true, tokenIn:'$descriptor.tokenIn',tokenOut:'$descriptor.tokenOut',taxonomy:{slotKind:'swap'}}]},
    execution:{version:1, requireCanonicalSource:true, settlement:{directOutput:true},
      call:{target:'$candidate.target',signature,args:['$route.tokenIn','$route.tokenOut',{runtime:'amountIn'},'$recipient']},
      protectedAddresses:['$candidate.target','$route.tokenIn','$route.tokenOut'],effects:[
        {kind:'debit',token:'$route.tokenIn',account:'$executor',equals:{runtime:'amountIn'}},
        {kind:'credit',token:'$route.tokenOut',account:'$recipient',minimum:'$minAmountOut'},{kind:'unchanged-native'}]},
  }]});
  const programKey = selectorNativeProgramKey(definition.programs[0]!);
  const plugin = defineSwapFamily(compileSelectorNativeExecutionFamily<'swap'>(definition));
  const entries = FAMILY_CAPABILITY_NAMES.map(capability=>({familyId:plugin.manifest.familyId,capability,contractVersion:'fixture/v1',
    contentHash:hashCanonical({capability}),semanticDependencies:[`contract:${capability}`],provenanceCommit:null}));
  const catalog = new FamilyCapabilityCatalog({ modules:[{sourceFile:'fixture/selector.production.ts',plugin,
    definitionBoundaryHash:definedFamilyPluginContractSummary(plugin).definitionBoundaryHash}],
    generatedManifest:{format:'adapter-family-capabilities-v1',entries,manifestHash:capabilityManifestHash(entries)} });
  const neverRead = async (): Promise<never> => { throw Error('unexpected provider read'); };
  const runtime = createStrictCentralAdapterRuntime({ executor, transactionOrigin:owner,
    generationFence:{assertCurrent(g,s){assert.equal(g,source.generation);assert.deepEqual(s,source);}},
    provider:{getCode:neverRead,getStorage:neverRead,call:neverRead} });
  const calldata = new Interface([signature]).encodeFunctionData(selector,[a,b,3n,owner]);
  const tx = readySelectorCensusFromTransaction({ chainId:1, blockNumber:source.number,blockHash:source.hash,transactionHash:toBeHex(23,32),
    transactionIndex:0,status:1,from:owner,to:pool,input:calldata,logs:[],traces:[] });
  const published = await runStrictFamilyLifecycle({catalog,familyId:plugin.manifest.familyId,source,runtime,observations:[{
    kind:'call',source,target:pool,sender:owner,transactionHash:tx.transactionHash!,data:calldata,traceAddress:[],
    opaque:{selectorCensus:tx,callId:tx.calls[0]!.id} as never}]});
  const instance=published.instances[0]!,routeKey=instance.routes[0]!.routeKey, family=catalog.forFamily(instance.familyId);
  const edge={chainId:1,selector,poolAddress:pool,tokenIn:a,tokenOut:b}, valid={family,instance,routeKey,edge,programKey,source};
  assert.equal(assertSqlLiveRouteBinding(valid),instance.routeHandles[0]);
  for(const change of [{poolAddress:addr(16)}, {poolId:toBeHex(1,32)}, {poolNamespace:'another'}, {tokenInId:'1'},
    {tokenIn:b,tokenOut:a},{tokenOut:ZeroAddress},{chainId:5},{selector:'0xabcdef01'}])
    assert.throws(()=>assertSqlLiveRouteBinding({...valid,edge:{...edge,...change}}));
  assert.throws(()=>assertSqlLiveRouteBinding({...valid,programKey:'parameters:'+'a'.repeat(64)}));
  assert.throws(()=>assertSqlLiveRouteBinding({...valid,source:{...source,hash:toBeHex(100,32)}}));
  assert.throws(()=>assertSqlLiveRouteBinding({...valid,instance:{...instance}}));
});
