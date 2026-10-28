import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,copyFileSync,rmSync,existsSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {prepareRunReady,readyActivationCacheKey,readyFileSha256} from './bounded-live-ready.mjs';
test('automatic off/on/off: immutable source, cached subsets, code/activation identity and corruption fences',async()=>{
  const root=mkdtempSync(join(tmpdir(),'ready-switch-'));
  try{
    const runs=join(root,'runs');mkdirSync(runs);const source=join(root,'source.json');writeFileSync(source,'full Ready');
    const profile={runs},release={readySha256:await readyFileSha256(source),sourceBundleSha256:'a'.repeat(64),readyGeneration:9};
    let executions=0,index=0;
    const executeActivation=async({config,run,key,release})=>{
      executions++;const off=config.SEARCHER_FAMILY_ARBITRARY_NEW_NAME_ENABLED==='0';
      writeFileSync(join(run,'checkpoint.json'),off?'subset Ready':'full Ready');
      return {schemaVersion:1,cacheKey:key,sourceSha256:release.readySha256,sourceGeneration:release.readyGeneration,
        readySha256:await readyFileSha256(join(run,'checkpoint.json')),generation:off?10:9,scans:0,attestations:0};
    };
    const run=async(flag,override={})=>{
      const path=join(runs,String(++index));mkdirSync(path);copyFileSync(source,join(path,'checkpoint.json'));
      const config={SEARCHER_FAMILY_ARBITRARY_NEW_NAME_ENABLED:flag,SEARCHER_UNIVERSE_REBUILD_CHECKPOINT_PATH:join(path,'checkpoint.json')};
      return prepareRunReady({profile,release,config,run:path,executeActivation,...override});
    };
    const off=await run('0');assert.equal(off.generation,10);assert.equal(off.cacheHit,false);
    assert.equal((await run('0')).cacheHit,true);assert.equal(executions,1);
    const on=await run('1');assert.equal(on.generation,9);assert.equal(on.cacheHit,false);
    assert.equal((await run('0')).cacheHit,true);assert.equal(executions,2);
    assert.equal(readFileSync(source,'utf8'),'full Ready');
    assert.notEqual(readyActivationCacheKey(release,{SEARCHER_FAMILY_ARBITRARY_NEW_NAME_ENABLED:'0'}),readyActivationCacheKey({...release,sourceBundleSha256:'b'.repeat(64)},{SEARCHER_FAMILY_ARBITRARY_NEW_NAME_ENABLED:'0'}));
    assert.notEqual(readyActivationCacheKey(release,{}),readyActivationCacheKey({...release,config:{QUOTE_POLICY:'changed'}},{}));
    assert.notEqual(readyActivationCacheKey(release,{}),readyActivationCacheKey(release,{BOTVM_OWNER:'different'}));
    const key=readyActivationCacheKey(release,{SEARCHER_FAMILY_ARBITRARY_NEW_NAME_ENABLED:'0'});
    writeFileSync(join(root,'ready-activation-cache',key,'checkpoint.json'),'corrupt');
    await assert.rejects(run('0'),/cache changed/);assert.equal(executions,2);
    assert.equal(readFileSync(join(runs,String(index),'checkpoint.json'),'utf8'),'full Ready');
    await assert.rejects(run('bad',{executeActivation:async()=>{throw Error('unverified Family');}}),/unverified Family/);
    const badKey=readyActivationCacheKey(release,{SEARCHER_FAMILY_ARBITRARY_NEW_NAME_ENABLED:'bad'});
    assert(!existsSync(join(root,'ready-activation-cache',badKey)));
    assert(readdirSync(join(root,'ready-activation-cache')).every(name=>/^[0-9a-f]{64}$/.test(name)),'failed preparations leave no lock or staged entry');
  }finally{rmSync(root,{recursive:true,force:true});}
});

test('source/generation/attestation receipt mismatch cannot publish a cache',async()=>{
  for(const patch of [{sourceGeneration:4},{sourceSha256:'f'.repeat(64)},{generation:12},{attestations:1},{scans:1}]){
    const root=mkdtempSync(join(tmpdir(),'ready-receipt-'));
    try{
      const runs=join(root,'runs'),run=join(runs,'run');mkdirSync(run,{recursive:true});const path=join(run,'checkpoint.json');writeFileSync(path,'ready');
      const release={readySha256:await readyFileSha256(path),sourceBundleSha256:'a'.repeat(64),readyGeneration:9};
      await assert.rejects(prepareRunReady({profile:{runs},release,config:{SEARCHER_UNIVERSE_REBUILD_CHECKPOINT_PATH:path},run,
        executeActivation:async({key})=>({schemaVersion:1,cacheKey:key,sourceSha256:release.readySha256,sourceGeneration:9,generation:9,readySha256:release.readySha256,scans:0,attestations:0,...patch})}));
      assert.deepEqual(readdirSync(join(root,'ready-activation-cache')),[]);
    }finally{rmSync(root,{recursive:true,force:true});}
  }
});
