import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,existsSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {Interface,FunctionFragment} from '../listener/node_modules/ethers/lib.esm/index.js';
import {renderIndependentTraceEdges,ready21Window} from './independent-trace-edges.mjs';
import {runIndependentWindowFunding} from './selector-window.mjs';
import {assertPinnedFundingWindow} from './selector-live-funding-export.mjs';
import {loadLiveSqlTables} from '../listener/src/searcher/sql-live-tables.ts';
import {selectorFundingInstanceKey} from '../listener/src/searcher/venues/selector-native-funding-definition.ts';
import {selectorAssetOfferKey} from '../listener/src/searcher/venues/selector-execution-keys.ts';
const root=fileURLToPath(new URL('..',import.meta.url)),sha=b=>createHash('sha256').update(b).digest('hex');
const runner=(...args)=>spawnSync(process.execPath,['--import',join(root,'listener/node_modules/tsx/dist/loader.mjs'),join(root,'scripts/selector-window.mjs'),...args],{cwd:root,encoding:'utf8',timeout:35_000,maxBuffer:4e6,env:{...process.env,SELECTOR_GCLOUD_CONFIG:'no-funding-or-node-access-in-offline-tests'}});
const ok=(...args)=>{const x=runner(...args);assert.equal(x.status,0,x.stderr);return x.stdout;};
const w={...ready21Window,fromBlock:ready21Window.toBlock-8,transactions:'44'};
const dir=()=>mkdtempSync(join(tmpdir(),'selector-window-independent-'));
const put=(p,o)=>{const b=JSON.stringify(o)+'\n';writeFileSync(p,b);return sha(b);},read=p=>JSON.parse(readFileSync(p));
test('official --sql-only is the upstream renderer byte-for-byte on a non-default pin, both filter modes',async()=>{
 const d=dir(),f=join(d,'window.json');put(f,w);
 for(const filtered of [false,true]){const sql=await renderIndependentTraceEdges(w,{liveSelectorsOnly:filtered});
 assert.equal(ok('--window',f,'--sql-only',...(filtered?['--live-selectors-only']:[])),sql+'\n');}
});
test('retired swap jobs, mixed modes and wrong input fingerprints cannot dispatch queries',()=>{
 const d=dir(),f=join(d,'bad.json');put(f,{window:w});const dest=join(d,'out');
 for(const args of [['--reuse-inputs',f],['--reference',f],['--resume',d],['--sql-only','--out',dest],['--funding-only','--live-selectors-only','--out',dest],
 ['--from-manifest',f,'--manifest-sha256','0'.repeat(64),'--out',dest],['--out',dest,'--no-prior','--previous',f,'--swaps-only']]){
 const x=runner(...args);assert.equal(x.status,1,x.stdout);assert(!/gcloud|Could not read|cannot reach google/i.test(x.stderr));assert(!existsSync(dest));}
});
function fundRow(w){
 const provider='0x'+'ab'.repeat(20),asset='0x'+'ba'.repeat(20),iface=new Interface(['function flashLoan(address,uint256,bytes)']);
 const selector=iface.getFunction('flashLoan').selector;
 return {offerKey:selectorAssetOfferKey(selectorFundingInstanceKey({chainId:1,selector,provider,asset,signature:'function flashLoan(address,uint256,bytes)'}),{address:asset}),provider,asset,selector,
  input:iface.encodeFunctionData(selector,[asset,2,'0x']),callback:FunctionFragment.from('function onMorphoFlashLoan(uint256,bytes)').selector,
  block_number:w.toBlock,block_hash:w.headHash,tx_hash:'0x'+'61'.repeat(32),transaction_index:0,trace_address:'',callback_path:'0',observations:1};
}
function fakeJobApi(w,offers,over=false){
 const submitted=[],estimates=[],jobs=new Map(),coverage={transactions:w.transactions,distinctTx:w.transactions,activeHashes:String(w.toBlock-w.fromBlock+1),firstBlock:String(w.fromBlock),lastBlock:String(w.toBlock),head:w.headHash,missingTraces:'0'};
 return {submitted,estimates,api:async(raw,o={})=>{const u=new URL(raw);const name=u.pathname.split('/').at(-1);
  if(o.method==='POST'){const x=JSON.parse(o.body),q=x.configuration.query;
   if(x.configuration.dryRun){estimates.push(q.maximumBytesBilled);return {statistics:{query:{totalBytesProcessed:over?String(5*2**30):'100'}}};}
   const id=x.jobReference.jobId;assert(!jobs.has(id));submitted.push(q.maximumBytesBilled);const kind=id.includes('_funding-frames_')?'frames':id.includes('_funding-coverage_')?'coverage':id.includes('_funding_')?'offers':null;
   assert(kind,'no retired discovery stage');jobs.set(id,{kind,job:{jobReference:x.jobReference,configuration:{query:{...q,destinationTable:{projectId:x.jobReference.projectId,datasetId:'_tmp',tableId:kind}}},status:{state:'DONE'},statistics:{query:{totalBytesBilled:'10',cacheHit:false}}}});return jobs.get(id).job;}
  if(u.pathname.includes('/jobs/'))return jobs.get(name)?.job??null;
  assert(u.pathname.includes('/queries/'));if(u.searchParams.get('maxResults')==='0')return {jobComplete:true,rows:[]};
  const v=jobs.get(name).kind==='coverage'?[coverage]:offers.map(r=>({body:JSON.stringify(r)}));
  return {jobComplete:true,totalRows:String(v.length),schema:{fields:Object.keys(v[0]).map(name=>({name,type:'STRING'}))},rows:v.map(row=>({f:Object.values(row).map(v=>({v}))}))};
 }};
}
test('fresh funding keeps 4/1/3 GiB caps, same-window trace coverage and a separately reusable input for offline CLI',async()=>{
 const d=dir(),f=join(d,'fund');mkdirSync(f);const mock=fakeJobApi(w,[fundRow(w)]);
 const fund=await runIndependentWindowFunding(f,w,false,mock.api);
 assert.deepEqual(mock.submitted,[4,1,3].map(n=>String(n*2**30)));assert.deepEqual(mock.submitted,mock.estimates);
 assert.equal(fund.rows,1);assert.equal(read(fund.funding).sourceCoverage.activeHashes,'9');
 const x=join(d,'in');mkdirSync(x);const pool='0x'+'12'.repeat(20),tx='0x'+'ee'.repeat(32);
 const rows=[{selector:'0x128acb08',poolAddress:pool,callTarget:pool,poolId:null,tokenIn:'0x'+'21'.repeat(20),tokenOut:'0x'+'34'.repeat(20),observations:'1',observedTargetSelector:true,verified:false,
    evidenceTypes:['subtree-net-flow'],example:{txHash:tx,selectorTarget:pool,callPath:'1',evidence:'subtree-net-flow'}}];
 const mb=join(x,'manifest.json'),msha=put(mb,{window:w,total:1,observations:1,liveSelectorsOnly:true,sqlSha256:sha(await renderIndependentTraceEdges(w,{liveSelectorsOnly:true})),edgesSha256:put(join(x,'edges.json'),rows)});
 const source=['--from-manifest',mb,'--manifest-sha256',msha,'--no-prior'];const full=join(d,'priced-input');
 const result=JSON.parse(ok(...source,'--funding',fund.funding,'--funding-sha256',fund.fundingSha256,'--out',full));
 assert.equal(result.accepted,1);const loaded=await loadLiveSqlTables(join(full,'sql-live-input.json'),result.inputSha256);assert.equal(loaded.edges.length,1);assert.equal(loaded.fundingAssets.length,1);
 const only=join(d,'swaps-only');assert.equal(JSON.parse(ok(...source,'--swaps-only','--out',only)).accepted,1);assert(!existsSync(join(only,'sql-live-input.json')));
 const mismatch=join(d,'wrong-window.json');put(mismatch,{...w,fromBlock:w.fromBlock-1});
 assert.match(runner(...source,'--window',mismatch,'--swaps-only','--out',join(d,'wrong')).stderr,/window mismatch/);
 const winFile=join(d,'pin.json');put(winFile,w);const original=read(fund.funding);
 const legacy={...original,window:{fromBlock:w.fromBlock,toBlock:w.toBlock,headHash:w.headHash},provenance:{trace:{coverage:original.sourceCoverage}}};delete legacy.sourceCoverage;
 assert.doesNotThrow(()=>assertPinnedFundingWindow(w,legacy));
 assert.throws(()=>assertPinnedFundingWindow(w,{...legacy,sourceCoverage:{...original.sourceCoverage,successfulTx:'7'},provenance:{trace:{coverage:{...original.sourceCoverage,successfulTx:'8'}}}}),/conflicting funding coverage/);
 for(const b of [{...original,sourceCoverage:{...original.sourceCoverage,transactions:'1',distinctTx:'1'}},
   {...original,window:{...original.window,firstTime:original.window.lastTime}}]){
   const badFile=join(d,'bad-funding.json'),digest=put(badFile,b),noJob=join(d,'should-not-start');
   const rejected=runner('--window',winFile,'--no-prior','--funding',badFile,'--funding-sha256',digest,'--out',noJob);
   assert.equal(rejected.status,1);assert(!/gcloud|googleapis/i.test(rejected.stderr));assert(!existsSync(noJob),'failure must precede any paid discovery');
 }
 assert.equal(sha(readFileSync(mb)),msha);assert.equal(sha(readFileSync(fund.funding)),fund.fundingSha256);
});
test('an over-cap estimate cannot submit even one funding job',async()=>{
 const mock=fakeJobApi(w,[],true);await assert.rejects(runIndependentWindowFunding(dir(),w,false,mock.api),/estimate over cap/);assert.equal(mock.submitted.length,0);
});
