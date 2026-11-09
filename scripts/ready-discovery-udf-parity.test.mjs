import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import test from 'node:test';
import { createOpaqueNominationCollector } from './ready-opaque-nominations.mjs';
import { Interface } from '../listener/node_modules/ethers/lib.esm/index.js';
import { buildDiscoveryUdf } from './ready-discovery-udf-build.mjs';
import { enableReadyFamilies } from './ready-family-activation.mjs';
import { observationsFromTx, emptyCounts } from './bigquery-table.mjs';

const root=resolve(fileURLToPath(new URL('..',import.meta.url)));
process.env.SEARCHER_TEST_DISABLE_DOTENV='1';
enableReadyFamilies(root);
const {PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG:catalog}=await import('../listener/src/searcher/venues/production-family-composition.ts');
const production=await import('../listener/src/searcher/universe-rebuild-production.ts');
const plain=x=>JSON.parse(JSON.stringify(x,(_k,v)=>typeof v==='bigint'?{$type:'bigint',value:String(v)}:v));
const sort=rows=>rows.map(row=>JSON.stringify(row)).sort();
const address=n=>'0x'+BigInt(n).toString(16).padStart(40,'0');
function argument(type,index=1) {
  if(type.baseType==='array') return Array.from({length:type.arrayLength<0?1:type.arrayLength},()=>argument(type.arrayChildren,index));
  if(type.baseType==='tuple') return type.components.map((t,i)=>argument(t,i+1));
  if(type.type==='address')return address(index);
  if(type.type==='bool')return true;
  if(type.type==='bytes')return '0x';
  if(type.type==='string')return 'fixture';
  if(/^bytes\d+$/.test(type.type))return '0x'+'01'.repeat(Number(type.type.slice(5)));
  return 1n;
}

test('query sandbox and production agree for every packaged Family declaration and actual candidate encoding',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'udf-parity-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const report=await buildDiscoveryUdf({catalog:process.env.DISCOVERY_CAPABILITY_PACKAGE??join(root,'listener/src/searcher/generated/family-capability-shadow.generated.json'),sourceRoot:join(root,'listener'),reader:join(root,'scripts/bigquery-table.mjs'),out:join(dir,'kernel')});
  const context=vm.createContext({});for(const resource of report.resources) vm.runInContext(readFileSync(join(dir,'kernel',resource.file),'utf8'),context,{timeout:30000});
  const kernel=context.DiscoveryKernel, ids=new Set(report.familyIds), rules=plain(kernel.rules());
  assert.equal(rules.length,ids.size);
  const collectOpaque=createOpaqueNominationCollector(catalog);
  let transactions=0, candidates=0, opaque=0;const nominated=new Set();
  function compare(tx) {
    const observations=observationsFromTx(tx,emptyCounts());
    const expected=observations.flatMap(o=>o.kind==='call'?production.candidatesFromCall(o):production.candidatesFromLog(o))
      .filter(c=>ids.has(c.familyId)).map(c=>({family:c.familyId,key:production.rebuildFamilyInstanceDedupeKey(c),fingerprint:production.candidateFingerprint(c)}));
    const actual=plain(kernel.compactTransaction(tx)).filter(r=>r.kind==='candidate').map(r=>({family:r.family,key:r.key,fingerprint:r.fingerprint}));
    assert.deepEqual(sort(actual),sort(expected),tx.traces[0]?.input?.slice(0,10));
    const expectedOpaque=observations.flatMap(collectOpaque).filter(r=>ids.has(r.family)).map(r=>({family:r.family,key:r.key,block:r.log.blockNumber,tx:r.log.transactionHash.toLowerCase(),logIndex:r.log.logIndex??null,snapshot:r.log}));
    const actualOpaque=plain(kernel.compactTransaction(tx)).filter(r=>r.kind==='opaque').map(({family,key,block,tx,logIndex,snapshot})=>({family,key,block,tx,logIndex,snapshot}));
    assert.deepEqual(sort(actualOpaque),sort(expectedOpaque),'production streaming opaque retention parity');
    opaque+=actualOpaque.length;
    for(const row of actual)nominated.add(row.family);
    candidates+=actual.length;transactions++;
  }
  for(const row of rules) {
    const d=catalog.forStrictFamily(row.familyId).plugin.discovery;
    assert.deepEqual(row.callPatterns,plain(d?.callPatterns??[]),row.familyId+' calls');
    assert.deepEqual(row.logPatterns,plain(d?.logPatterns??[]),row.familyId+' logs');
    for(const pattern of d?.callPatterns??[]) {
      if(!pattern.signature)continue;
      const abi=new Interface([pattern.signature.startsWith('function ')?pattern.signature:'function '+pattern.signature]);
      const fn=abi.fragments.find(x=>x.type==='function');
      const tx={tx_hash:'0x'+'33'.repeat(32),block_number:'25750000',block_hash:'0x'+'44'.repeat(32),receipt_status:'1',logs:[],
        traces:[{trace_address:'',to_address:address(999),from_address:address(998),call_type:'call',status:'1',input:abi.encodeFunctionData(fn,fn.inputs.map((p,i)=>argument(p,i+1)))}]};
      compare(tx);compare({...tx,receipt_status:'0'});
      compare({...tx,traces:[{...tx.traces[0],status:'0'}]});
    }
  }
  const historical = JSON.parse(readFileSync(join(root,'listener/src/searcher/test/fixtures/bigquery-discovery/transactions.json'),'utf8'));
  for(const tx of historical.transactions) compare(tx);
  assert.equal(opaque,4,'saved real transactions retain both V4 Family nominations for two observed pools');
  for(const tx of historical.transactions) {
    const foreign={...tx,logs:tx.logs.map(log=>({...log,log_address:address(997)}))};
    compare(foreign);
    assert.equal(plain(kernel.compactTransaction(foreign)).filter(r=>r.kind==='opaque').length,0,'same topics from a foreign emitter are not opaque nominations');
  }
  const opaqueTx=historical.transactions.find(tx=>plain(kernel.compactTransaction(tx)).some(r=>r.kind==='opaque'));
  assert(opaqueTx);
  for(const rewrite of [
    log=>({...log,topics:log.topics.slice(0,1)}),
    log=>({...log,topics:[log.topics[0],'0xbad']}),
    log=>({...log,topics:['0x'+'fe'.repeat(32),...log.topics.slice(1)]}),
  ]) {
    const tx={...opaqueTx,logs:opaqueTx.logs.map(rewrite)};
    compare(tx);
    assert.equal(plain(kernel.compactTransaction(tx)).filter(r=>r.kind==='opaque').length,0);
  }
  compare({...opaqueTx,receipt_status:'0'});
  compare({tx_hash:'0x'+'33'.repeat(32),block_number:'25750000',block_hash:'0x'+'44'.repeat(32),receipt_status:'1',logs:[],traces:[]});
  assert(nominated.has('protocol:erc4626'),'JSON discovery must nominate actual candidates');
  assert(nominated.has('univ2-standard'),'Swap JSON must retain real call decoding');
  assert(transactions>20&&candidates>10);
  t.diagnostic(JSON.stringify({families:ids.size,transactions,candidates,opaque,nominatedFamilies:[...nominated].sort(),kernelBytes:report.kernelBytes}));
});
