import test from 'node:test';
import assert from 'node:assert/strict';
import {Interface,ZeroAddress,toBeHex} from 'ethers';
import {compileSelectorExecutionSource} from '../build-selector-execution-source.js';
import {normalizeSelectorNativeExecutionDefinition as normalize} from '../venues/selector-native-definition.js';
import {selectSingleExecution} from '../venues/selector-program-role.js';
import {readSelectorSourceIdentity,assertSelectorSourceIdentity} from '../venues/selector-source-identity.js';
import exec from '../venues/selector-native/selector-95991276-family/execution.source.json';
import identity from '../venues/selector-native/selector-95991276-family/identity.source.json';
import {defineSelectorFamilyModule} from '../venues/selector-family-module.js';
import {definedFamilyPluginContractSummary} from '../venues/adapter-family-plugin.js';
import {FamilyCapabilityCatalog,FAMILY_CAPABILITY_NAMES,capabilityManifestHash} from '../venues/family-capability-catalog.js';
import {hashCanonical} from '../venues/canonical-value.js';
import {issueSelectorCurrentSourceRoutes} from '../venues/selector-source-issued-route.js';

const source={number:100,generation:1,hash:toBeHex(100,32)},a=(n:number)=>toBeHex(n,20);
const definition=normalize(compileSelectorExecutionSource(exec,'a'.repeat(64),identity));
const edge={chainId:1,selector:exec.selector,poolAddress:a(1),tokenIn:a(2),tokenOut:a(3)};
const abi=new Interface(identity.options.flatMap(o=>[o.tokenIn,o.tokenOut]));
const programKey=selectSingleExecution(definition).programKey;

function reader(fault?:string){
 let reads=0;
 return {
  get reads(){return reads;},
  async readRequests(requests:any[],pin:typeof source){
   assert.deepEqual(pin,source);
   return requests.map(r=>{
    reads++;assert.equal(r.kind,'eth-call');assert.equal(r.to,edge.poolAddress);
    const f=abi.getFunction(r.data.slice(0,10))!;
    const value=fault==='zero'?ZeroAddress:fault==='same'?edge.tokenIn:f.name==='gem'?edge.tokenIn:edge.tokenOut;
    return {
     id:r.id,
     source:fault==='stale'?{...source,generation:2}:source,
     ok:true,
     completion:'returned',
     data:abi.encodeFunctionResult(f,[value]),
     provenance:{kind:'local-fixture',fingerprint:toBeHex(1,32)},
    };
   });
  },
 };
}

test('identity-options/v1 confirms pool tokens and binds single execution without executionProgramKeys',async()=>{
 const transport=reader(),r=await readSelectorSourceIdentity({definition,edge,source,readRequests:transport.readRequests as any});
 assert.equal(transport.reads,2);assert.deepEqual(r.issues,[]);assert.equal(r.matches.length,1);
 const match=r.matches[0]!;
 assert.equal((match as any).executionProgramKeys,undefined);
 assert.equal(match.direction,'sell-gem');
 assert.equal(match.binding.gem.toLowerCase(),edge.tokenIn);
 assert.equal(match.binding.dai.toLowerCase(),edge.tokenOut);
 assertSelectorSourceIdentity(match,{definition,edge,source,programKey});
 for(const input of [
  {definition,edge:{...edge,poolAddress:a(8)},source,programKey},
  {definition,edge:{...edge,hookData:'0x1234'},source,programKey},
  {definition,edge,source:{...source,generation:2},programKey},
  {definition,edge,source,programKey:'fake'},
 ])assert.throws(()=>assertSelectorSourceIdentity(match,input));
 assert.throws(()=>assertSelectorSourceIdentity({...match},{definition,edge,source,programKey}));
});

test('generic engine checks reject zero address, identical tokens, reversed edge and stale source',async()=>{
 for(const fault of ['zero','same','stale']){
  const r=await readSelectorSourceIdentity({definition,edge,source,readRequests:reader(fault).readRequests as any});
  assert.equal(r.matches.length,0);assert(r.issues.length>0);
 }
 const sameEdge=await readSelectorSourceIdentity({definition,edge:{...edge,tokenOut:edge.tokenIn},source,readRequests:reader().readRequests as any});
 assert.equal(sameEdge.matches.length,0);assert(sameEdge.issues.some(s=>s.includes('distinct')));
 const reversed=await readSelectorSourceIdentity({definition,edge:{...edge,tokenIn:edge.tokenOut,tokenOut:edge.tokenIn},source,readRequests:reader().readRequests as any});
 assert.equal(reversed.matches.length,0);assert(reversed.issues.some(s=>s.includes('differs from edge')));
 await assert.rejects(readSelectorSourceIdentity({definition,edge,source,readRequests:async()=>{throw Error('transport down');}}),/transport down/);
 await assert.rejects(readSelectorSourceIdentity({definition,edge,source,readRequests:async requests=>requests.map(r=>({id:r.id,ok:false,source,failure:'rpc'}))}),/transport did not complete/);
});

test('identity dispatch never forwards simulation requests or an optional-only identity read',async()=>{
 for(const request of [{id:'x',kind:'eth-simulate'},{id:'x',kind:'eth-call',to:edge.poolAddress,data:'0x',required:false}]){
  const raw=compileSelectorExecutionSource(exec,'a'.repeat(64),identity);
  raw.programs[0].binding.flow.steps[0].requests=[request];const d=normalize(raw);let calls=0;
  await assert.rejects(readSelectorSourceIdentity({definition:d,edge,source,readRequests:async()=>{calls++;return [];}}),/identity dispatch permits/);
  assert.equal(calls,0);
 }
});

test('more than one matching identity option is rejected as direction ambiguous',async()=>{
 const original=definition.programs.find(p=>p.type==='independentIdentity')!,duplicate=structuredClone(original) as any;
 duplicate.binding.descriptor.direction='sell-gem-alt';
 const d=normalize({...definition,programs:[original,duplicate,selectSingleExecution(definition).program]});
 let codes=0;
 const r=await issueSelectorCurrentSourceRoutes({definition:d,edge,source,catalog:{} as any,executor:a(4),transactionOrigin:a(5),
  readIdentityRequests:reader().readRequests as any,read:async()=>{throw Error('unexpected');},readCode:async()=>{codes++;return '0x6000';}});
 assert.equal(codes,0);
 assert.equal(r.alternatives.length,0);
 assert(r.issues.includes('direction ambiguous'),r.issues.join('; '));
});

test('current identity and zero-identity definitions reach formal lifecycle and single execution route',async()=>{
 for(const withIdentity of [true,false]){
  const def=withIdentity?definition:normalize(compileSelectorExecutionSource(exec,'a'.repeat(64)));
  const {plugin}=defineSelectorFamilyModule(def),entries=FAMILY_CAPABILITY_NAMES.map(capability=>({familyId:plugin.manifest.familyId,capability,
   contractVersion:'source-identity-test/v1',contentHash:hashCanonical({family:plugin.manifest.familyId,capability}),semanticDependencies:[`contract:${capability}`],provenanceCommit:null}));
  const catalog=new FamilyCapabilityCatalog({modules:[{sourceFile:'fixture/source-identity.production.ts',plugin,
   definitionBoundaryHash:definedFamilyPluginContractSummary(plugin).definitionBoundaryHash}],generatedManifest:{format:'adapter-family-capabilities-v1',entries,manifestHash:capabilityManifestHash(entries)}});
  let reads=0,codes=0;const input={definition:def,edge,source,catalog,executor:a(4),transactionOrigin:a(5),
   readCode:async(target:string)=>{assert.equal(target,edge.poolAddress);codes++;return '0x6000';},
   read:async(target:string,data:string)=>{
    assert.equal(target,edge.poolAddress);reads++;const f=abi.getFunction(data.slice(0,10))!;
    return abi.encodeFunctionResult(f,[f.name==='gem'?edge.tokenIn:edge.tokenOut]);
   }};
  const r=await issueSelectorCurrentSourceRoutes(input);assert.equal(r.alternatives.length,1,r.issues.join('; '));
  assert.equal(reads,withIdentity?2:0);assert.equal(codes,1);
  assert.equal(r.alternatives[0]!.programKey,selectSingleExecution(def).programKey);
  assert.equal(r.alternatives[0]!.instance.routes.length,1);assert.match(r.alternatives[0]!.program,/^0x/);
  if(withIdentity){
   const bad=await issueSelectorCurrentSourceRoutes({...input,edge:{...edge,tokenIn:edge.tokenOut,tokenOut:edge.tokenIn}});
   assert.equal(bad.alternatives.length,0);assert(bad.issues.some(s=>s.includes('differs from edge')));
  }
 }
});
