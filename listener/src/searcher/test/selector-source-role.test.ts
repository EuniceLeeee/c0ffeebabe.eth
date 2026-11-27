import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {compileSelectorExecutionSource as compile} from '../build-selector-execution-source.js';
import {normalizeSelectorNativeExecutionDefinition as normalize} from '../venues/selector-native-definition.js';
import {selectorExecutionPrograms,selectorProgramProjection,selectSingleExecution} from '../venues/selector-program-role.js';
import {syncDeclarativeProductionEntries as sync} from '../build-declarative-production.js';
import exec from '../venues/selector-native/selector-95991276-family/execution.source.json';
import identity from '../venues/selector-native/selector-95991276-family/identity.source.json';

const hash='a'.repeat(64);

test('two authored sources compile to disjoint identity options and a single execution template',()=>{
 const d=normalize(compile(exec,hash,identity));assert.equal(d.programs.length,2);
 const i=d.programs.find(p=>p.type==='independentIdentity')!,e=selectSingleExecution(d).program;
 assert.equal(e.type,'execution');assert.equal(selectorExecutionPrograms(d).length,1);
 assert(i.binding?.flow);assert.equal(i.execution,undefined);assert.equal(i.routes,undefined);assert.equal(i.projection,undefined);
 assert.equal((i as any).executionProgramKeys,undefined);assert.equal((e as any).executionProgramKeys,undefined);
 assert.equal(e.binding,undefined);assert(e.projection?.descriptor);assert(e.execution);assert.equal(e.refreshPolicy,'on-touch');
 assert.doesNotMatch(JSON.stringify(e),/gem\(\)|dai\(\)|to18ConversionFactor|\$binding\.|\"flow\"/);
 assert.doesNotMatch(JSON.stringify(i),/\$sqlEdge|\"execution\"|\"routes\"|\"executionProgramKeys\"/);
 assert.deepEqual(selectorProgramProjection(e),e.projection);
 assert.deepEqual(selectorProgramProjection(i),i.binding);
 const noIdentity=normalize(compile(exec,hash));assert.deepEqual(selectorExecutionPrograms(noIdentity),[e]);
});

test('source-owned definitions enforce 0..N independentIdentity and exactly 1 execution',()=>{
 const d=normalize(compile(exec,hash,identity));
 const onlyIdentities={...d,programs:d.programs.filter(p=>p.type==='independentIdentity')};
 assert.throws(()=>normalize(onlyIdentities),/exactly one execution program/);
 const e=selectSingleExecution(d).program;
 const twoExecs={...d,programs:[...d.programs,{...e,refreshPolicy:'each-block' as const}]};
 assert.throws(()=>normalize(twoExecs),/exactly one execution program/);
});

test('authored roles, crossed fields, duplicate option ids and mismatched sibling identities are rejected',()=>{
 for(const change of [{type:'execution'},{binding:{}}])assert.throws(()=>compile({...exec,...change},hash,identity));
 for(const change of [{type:'independentIdentity'},{execution:{}},{state:exec.state},{format:'identity-read-programs/v1'}])
  assert.throws(()=>compile(exec,hash,{...identity,...change}));
 assert.throws(()=>compile(exec,hash,{...identity,options:[identity.options[0],identity.options[0]]}),/duplicate identity option id/);
 assert.throws(()=>compile(exec,hash,{...identity,options:[{id:'same',tokenIn:'function gem() view returns (address)',tokenOut:'function gem() view returns (address)'}]}),/overlapping identity getter/);
 for(const change of [{selector:'0x12345678'},{signature:'function buyGem(address,uint256)'},
   {activation:{...identity.activation,enabled:false}},{activation:{...identity.activation,envKey:'SEARCHER_FAMILY_OTHER_ENABLED'}}])
  assert.throws(()=>compile(exec,hash,{...identity,...change}),/metadata differs/);
 const d=compile(exec,hash,identity),i=d.programs[0],e=d.programs[1];
 for(const changed of [{...i,execution:e.execution},{...i,routes:e.routes},{...i,projection:e.projection},
   {...e,binding:i.binding},{...e,projection:{...e.projection,flow:i.binding.flow}},{...e,type:'unknown'}])
  assert.throws(()=>normalize({...d,programs:[changed]}));
 const {directState:_ds,...untypedBase}=d;
 const legacy={...e};delete legacy.type;delete legacy.projection;delete legacy.sourceRefreshPolicy;legacy.binding=e.projection;
 assert.equal(selectorExecutionPrograms(normalize({...untypedBase,programs:[legacy]})).length,1,'untyped legacy declarations remain supported');
 assert.throws(()=>normalize({...d,programs:[i,e,legacy]}),/mix role-tagged and legacy/);
});

test('source generator supports 0..N identity options, checks mismatches and rejects orphan identity',async t=>{
 const temp=await mkdtemp(join(tmpdir(),'selector-roles-'));t.after(()=>rm(temp,{recursive:true,force:true}));
 const root=join(temp,'listener'),dir=join(root,'src/searcher/venues/selector-native/selector-95991276-family');
 await mkdir(dir,{recursive:true});await writeFile(join(root,'src/searcher/venues/selector-family-module.ts'),'export {};');
 const family=new URL('../venues/selector-native/selector-95991276-family/',import.meta.url),scripts=new URL('../../../../scripts/',import.meta.url);
 for(const [dest,from,names] of [[dir,family,['edge-discovery.json','discover.mjs']],
   [join(temp,'scripts'),scripts,['selector-family-event-discovery.mjs','selector-direct-f3/receipt-call-owners.mjs']]] as const)
  for(const name of names){const file=join(dest,name);await mkdir(dirname(file),{recursive:true});await writeFile(file,await readFile(new URL(name,from)));}
 const ef=join(dir,'execution.source.json'),idf=join(dir,'identity.source.json'),ir=join(dir,'selector-95991276.json');
 await writeFile(ef,JSON.stringify(exec));await writeFile(idf,JSON.stringify(identity));
 await sync({rootDirectory:root,mode:'write'});await sync({rootDirectory:root,mode:'check'});
 assert.deepEqual(JSON.parse(await readFile(ir,'utf8')).programs.map((p:any)=>p.type),['independentIdentity','execution']);
 await writeFile(idf,JSON.stringify({...identity,activation:{...identity.activation,enabled:false}}));
 await assert.rejects(sync({rootDirectory:root,mode:'write'}),/metadata differs/);
 await rm(idf);await sync({rootDirectory:root,mode:'write'});
 assert.deepEqual(JSON.parse(await readFile(ir,'utf8')).programs.map((p:any)=>p.type),['execution']);
 await writeFile(idf,JSON.stringify(identity));await rm(ef);await assert.rejects(sync({rootDirectory:root,mode:'write'}),/requires its matching/);
 await rm(idf);await assert.rejects(sync({rootDirectory:root,mode:'write'}),/cannot replace missing authored/);
});
