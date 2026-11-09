import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { scanDiscoveryPackages, buildDiscoveryUdf, declarativeBinding } from './ready-discovery-udf-build.mjs';

function fixture(t) {
  const dir=realpathSync(mkdtempSync(join(tmpdir(),'mev-discovery-udf-test-')));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const source=join(dir,'source'),packages=join(dir,'packages');
  mkdirSync(join(source,'src'),{recursive:true});mkdirSync(packages);
  writeFileSync(join(source,'src/discovery.ts'),'export const arbitraryDiscovery={};\n');
  writeFileSync(join(source,'src/manifest.ts'),'export const arbitraryManifest={};\n');
  const root=familyId=>({precision:'capability-exact',identity:{familyId,capability:'discovery',contentHash:'fixture-hash',semanticDependencies:[]},
    root:{capability:'discovery',entrySourceFile:'src/discovery.ts',entryExport:'arbitraryDiscovery',additionalSourceFiles:['src/manifest.ts'],absence:null}});
  const artifact=ids=>({format:'adapter-family-capability-shadow-v1',complete:true,issues:[],legacy:[],exact:ids.map(root)});
  const save=(path,value)=>writeFileSync(path,JSON.stringify(value));
  return {dir,source,packages,root,artifact,save};
}

test('discovers arbitrary new Family roots across every nested package JSON',t=>{
  const f=fixture(t);f.save(join(f.packages,'first.json'),f.artifact(['synthetic:arbitrary-101']));
  mkdirSync(join(f.packages,'nested'));f.save(join(f.packages,'nested/second.json'),f.artifact(['synthetic:never-hardcoded-102']));
  f.save(join(f.packages,'unrelated.json'),{format:'unrelated'});
  const result=scanDiscoveryPackages(f.packages,f.source);
  assert.equal(result.packages.length,2);
  assert.deepEqual(result.roots.map(root=>root.familyId),['synthetic:arbitrary-101','synthetic:never-hardcoded-102']);
});

test('accepts the explicit JSON file path and records package/source provenance',t=>{
  const f=fixture(t),path=join(f.packages,'one.json');f.save(path,f.artifact(['synthetic:one']));
  const result=scanDiscoveryPackages(path,f.source);
  assert.equal(result.roots.length,1);assert.match(result.packages[0].sha256,/^[0-9a-f]{64}$/);
  assert.equal(result.roots[0].entrySourceFile,realpathSync(join(f.source,'src/discovery.ts')));
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
  for(const change of [a=>a.complete=false,a=>a.issues.push('bad'),a=>a.legacy.push({}),a=>a.exact[0].root.absence='declared-absent',a=>a.exact[0].precision='approximate']){
    const artifact=f.artifact(['synthetic:invalid']);change(artifact);f.save(path,artifact);
    assert.throws(()=>scanDiscoveryPackages(path,f.source));
  }
});

test('missing source files, missing manifest metadata, invalid exports and path escapes fail closed',t=>{
  const f=fixture(t),path=join(f.packages,'bad.json');writeFileSync(join(f.dir,'outside.ts'),'export const x=1;');
  for(const change of [a=>a.exact[0].root.entrySourceFile='src/missing.ts',a=>a.exact[0].root.additionalSourceFiles=[],
    a=>a.exact[0].root.entryExport='bad();',a=>a.exact[0].root.entrySourceFile='../outside.ts']){
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


test('JSON compiler binds the actual production root and exact ordered child closure',t=>{
  const f=fixture(t),family=join(f.source,'src/family'),entries=join(f.source,'src/searcher/venues/production-families');
  mkdirSync(family,{recursive:true});mkdirSync(entries,{recursive:true});
  const definition=join(family,'family.json'),child=join(family,'child.json');
  const raw={manifest:{familyId:'synthetic:json'},scope:{family:'synthetic:json'},variantFiles:['./child.json']};
  f.save(definition,raw);f.save(child,{id:'child'});
  const root={familyId:'synthetic:json',entryExport:'compile',entrySourceFile:join(f.source,'src/discovery.ts'),additionalSourceFiles:[definition,child]};
  const entry=join(entries,'fixture.production.ts');
  const code="import {compile} from '../../../discovery.js';import raw from '../../../family/family.json';import child from '../../../family/child.json';export const plugin=compile(raw,[child]);";
  writeFileSync(entry,code);
  assert.deepEqual(declarativeBinding(root,f.source).children,[child]);
  assert.throws(()=>declarativeBinding({...root,additionalSourceFiles:[definition]},f.source),/closure/);
  writeFileSync(entry,code.replace('[child]','[]'));
  assert.throws(()=>declarativeBinding(root,f.source),/bindings disagree/);
  writeFileSync(entry,code);f.save(definition,{...raw,variantFiles:['./child.json','./child.json']});
  assert.throws(()=>declarativeBinding(root,f.source),/Duplicate JSON/);
  f.save(definition,{...raw,scope:{family:'synthetic:wrong'}});
  assert.throws(()=>declarativeBinding(root,f.source),/scope mismatch/);
});
