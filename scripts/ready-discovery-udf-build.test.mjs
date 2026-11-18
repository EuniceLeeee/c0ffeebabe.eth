import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { scanDiscoveryPackages, buildDiscoveryUdf, declarativeBinding } from './ready-discovery-udf-build.mjs';
import { createFamilyCapabilityShadowArtifact } from '../listener/src/searcher/venues/family-capability-shadow.ts';
import { FAMILY_CAPABILITY_NAMES } from '../listener/src/searcher/venues/family-capability-catalog.ts';
import { generateAbsentCapabilityIdentity } from '../listener/src/searcher/venues/capability-content-hash.ts';

function fixture(t) {
  const dir=realpathSync(mkdtempSync(join(tmpdir(),'mev-discovery-udf-test-')));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const source=join(dir,'source'),packages=join(dir,'packages');
  mkdirSync(join(source,'src/searcher/venues'),{recursive:true});mkdirSync(packages);
  writeFileSync(join(source,'src/searcher/venues/selector-family-module.ts'),'export function defineSelectorFamilyModule(definition){return definition;}\n');
  const document=JSON.stringify({format:'selector-family/v2',selector:'0x12345678'});
  writeFileSync(join(source,'src/definition.json'),document);
  const integrity={sourceFile:'src/definition.json',sha256:createHash('sha256').update(document).digest('hex')};
  const root=(familyId,capability='discovery')=>({precision:'capability-exact',identity:generateAbsentCapabilityIdentity({familyId,capability,provenanceCommit:null}),
    root:capability==='discovery'?{capability,entrySourceFile:'src/searcher/venues/selector-family-module.ts',entryExport:'defineSelectorFamilyModule',additionalSourceFiles:['src/definition.json'],authoringIntegrity:[integrity],absence:null}
      :{capability,entrySourceFile:null,entryExport:null,additionalSourceFiles:[],absence:'declared-absent'}});
  const artifact=ids=>JSON.parse(JSON.stringify(createFamilyCapabilityShadowArtifact({legacy:[],exact:ids.flatMap(id=>FAMILY_CAPABILITY_NAMES.map(capability=>root(id,capability)))})));
  const save=(path,value)=>writeFileSync(path,JSON.stringify(value));
  return {dir,source,packages,root,artifact,save};
}

test('discovers new v2 Family roots across every nested package JSON',t=>{
  const f=fixture(t);f.save(join(f.packages,'first.json'),f.artifact(['synthetic:arbitrary-101']));
  mkdirSync(join(f.packages,'nested'));f.save(join(f.packages,'nested/second.json'),f.artifact(['synthetic:never-hardcoded-102']));
  f.save(join(f.packages,'unrelated.json'),{format:'unrelated'});
  const result=scanDiscoveryPackages(f.packages,f.source);
  assert.equal(result.packages.length,2);
  assert.deepEqual(result.roots.map(root=>root.familyId),['synthetic:arbitrary-101','synthetic:never-hardcoded-102']);
});

test('metadata byte changes require a fresh artifact even when execution semantics are unchanged',t=>{
  const f=fixture(t),path=join(f.packages,'one.json');f.save(path,f.artifact(['synthetic:one']));
  scanDiscoveryPackages(path,f.source);
  writeFileSync(join(f.source,'src/definition.json'),JSON.stringify({format:'selector-family/v2',selector:'0x12345678',meta:{note:'new description'}}));
  assert.throws(()=>scanDiscoveryPackages(path,f.source),/Stale authored JSON byte integrity/);
});

test('accepts the explicit JSON file path and records package/source provenance',t=>{
  const f=fixture(t),path=join(f.packages,'one.json');f.save(path,f.artifact(['synthetic:one']));
  const result=scanDiscoveryPackages(path,f.source);
  assert.equal(result.roots.length,1);assert.match(result.packages[0].sha256,/^[0-9a-f]{64}$/);
  assert.equal(result.roots[0].entrySourceFile,realpathSync(join(f.source,'src/searcher/venues/selector-family-module.ts')));
});

test('duplicate Family roots fail closed, including duplicates from separate packages',t=>{
  const f=fixture(t);for(const name of ['a','b'])f.save(join(f.packages,name+'.json'),f.artifact(['synthetic:duplicate']));
  assert.throws(()=>scanDiscoveryPackages(f.packages,f.source),/Duplicate discovery root/);
});

test('a declared Family with no discovery entry is never silently omitted',t=>{
  const f=fixture(t),artifact=f.artifact(['synthetic:included']);
  artifact.exact.push({precision:'capability-exact',identity:{familyId:'synthetic:missing',capability:'capture'},root:{absence:null}});
  f.save(join(f.packages,'bad.json'),artifact);
  assert.throws(()=>scanDiscoveryPackages(f.packages,f.source),/missing a discovery capability root/);
});

test('incomplete, absent, legacy and non-exact capability roots fail closed',t=>{
  const f=fixture(t),path=join(f.packages,'bad.json');
  const discovery=a=>a.exact.find(row=>row.identity.capability==='discovery');
  for(const change of [a=>a.complete=false,a=>a.issues.push('bad'),a=>a.legacy.push({}),a=>discovery(a).root.absence='declared-absent',a=>discovery(a).precision='approximate']){
    const artifact=f.artifact(['synthetic:invalid']);change(artifact);f.save(path,artifact);
    assert.throws(()=>scanDiscoveryPackages(path,f.source));
  }
});

test('missing source files, missing authored definition, invalid exports and path escapes fail closed',t=>{
  const f=fixture(t),path=join(f.packages,'bad.json');writeFileSync(join(f.dir,'outside.ts'),'export const x=1;');
  const discovery=a=>a.exact.find(row=>row.identity.capability==='discovery');
  for(const change of [a=>discovery(a).root.entrySourceFile='src/missing.ts',a=>discovery(a).root.additionalSourceFiles=[],
    a=>discovery(a).root.entryExport='bad();',a=>discovery(a).root.entrySourceFile='../outside.ts']){
    const artifact=f.artifact(['synthetic:invalid']);change(artifact);f.save(path,artifact);
    assert.throws(()=>scanDiscoveryPackages(path,f.source));
  }
});

test('empty package collections fail rather than producing an empty filtering kernel',t=>{
  const f=fixture(t);f.save(join(f.packages,'other.json'),{format:'unrelated'});
  assert.throws(()=>scanDiscoveryPackages(f.packages,f.source),/No complete discovery capability package/);
});

test('builder never overwrites an existing output directory',async t=>{
  const f=fixture(t);await assert.rejects(buildDiscoveryUdf({catalog:f.packages,sourceRoot:f.source,reader:join(f.source,'reader.mjs'),out:f.source}),/Output directory must be new/);
});


test('retired handwritten and old JSON compilers cannot enter the query runtime',t=>{
  const f=fixture(t);
  for(const entryExport of ['arbitraryDiscovery','compileDeclarativeProtocol','compileSelectorExecutionFamily','compileSelectorExecutionDeclarationFamily'])
    assert.throws(()=>declarativeBinding({entryExport},f.source),/Retired discovery root/);
});

test('the complete native catalog builds in a browser realm without execution or old adapters',async t=>{
  const repository=resolve(fileURLToPath(new URL('..',import.meta.url)));
  const dir=mkdtempSync(join(tmpdir(),'native-discovery-catalog-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const options={catalog:join(repository,'listener/src/searcher/generated/family-capability-shadow.generated.json'),
    sourceRoot:join(repository,'listener'),reader:join(repository,'scripts/bigquery-table.mjs'),out:join(dir,'kernel')};
  const report=await buildDiscoveryUdf(options),context=vm.createContext({});
  const expectedFamilies=JSON.parse(readFileSync(options.catalog,'utf8')).exact.filter(row=>row.identity.capability==='discovery').map(row=>row.identity.familyId).sort();
  assert(expectedFamilies.length>=95,'the migrated inventory cannot drop the original selector declarations');
  assert.equal(report.familyCount,expectedFamilies.length);
  for(const resource of report.resources){assert(resource.bytes<=1024*1024);vm.runInContext(readFileSync(join(options.out,resource.file),'utf8'),context,{timeout:30000});}
  assert.equal(vm.runInContext('typeof Buffer+":"+typeof process+":"+typeof require',context),'undefined:undefined:undefined');
  const rules=JSON.parse(JSON.stringify(context.DiscoveryKernel.rules()));assert.deepEqual(rules.map(row=>row.familyId).sort(),expectedFamilies);
  assert(rules.every(rule=>/^execution:0x[0-9a-f]{8}:abi-[0-9a-f]{64}$/.test(rule.familyId)));
  for(const name of ['selector-family-module.ts','selector-native-family.ts','selector-native-runtime.ts','selector-native-funding.ts','declarative-execution.ts','adapter-family-runtime.ts'])
    assert(!report.inputs.some(row=>row.path.endsWith('/'+name)),name+' cannot enter a SQL nomination program');
  assert(!report.inputs.some(row=>/\/venues\/(protocols|swaps|funding|execution-shapes)\//.test(row.path)));
  const tx={tx_hash:'0x'+'33'.repeat(32),block_number:'100',block_hash:'0x'+'44'.repeat(32),receipt_status:'1',
    from_address:'0x'+'11'.repeat(20),to_address:'0x'+'22'.repeat(20),input:'0xdeadbeef'+'00'.repeat(32),logs:[],traces:[]};
  const records=JSON.parse(context.DiscoveryKernel.compactTransactionJson(JSON.stringify(tx)));
  assert.equal(records.filter(row=>row.kind==='selector-census').length,1);
  const census=records.find(row=>row.kind==='selector-census').snapshot;
  assert(census.calls.some(call=>call.selector==='0xdeadbeef'),'unknown selectors remain visible');
  assert.equal(records.filter(row=>row.kind==='candidate').length,0);
  const edges=records.filter(row=>row.kind==='selector-edge');assert.equal(edges.length,census.calls.length);
  assert(edges.every(row=>row.snapshot.status==='unverified'&&row.snapshot.completeness==='incomplete'));
  const omitted={...tx};delete omitted.input;
  const incomplete=JSON.parse(context.DiscoveryKernel.compactTransactionJson(JSON.stringify(omitted))).find(row=>row.kind==='selector-census');
  assert.equal(incomplete.snapshot.status,'unverified');
  t.diagnostic(JSON.stringify({families:report.familyCount,kernelBytes:report.kernelBytes,resources:report.resources.length,unknownSelectorRetained:true}));
});
