// Official swap discovery and independently sourced funding. Historical exports below
// remain importable; none of the legacy swap queries are used by this CLI.
import assert from 'node:assert/strict';
import {existsSync,mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {join,resolve,basename} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import {parseArgs} from 'node:util';
import {googleApi,sha} from './selector-query-client.mjs';
import {decodeRow} from './bigquery-table.mjs';
import {openReadyDiscoveryJob} from './ready-bigquery-sql.mjs';
import {renderSqlFundingSources} from './selector-funding-sql.mjs';
import {assertPinnedFundingWindow,assertTraceFundingCoverage,splitSqlFundingRows} from './selector-live-funding-export.mjs';
import {renderSelectorTraceSourceSql} from './selector-trace-source-sql.mjs';
import {HISTORY,fixedTraceRead,pinTraceWindow} from './selector-trace-store.mjs';

const root=fileURLToPath(new URL('../',import.meta.url)),gib=2**30;
export const ready21=Object.freeze({fromBlock:26377878,toBlock:26378389,transactions:'168648',
 headHash:'0x62b23cae3b410e09f24910f072a94e2a65b68917a91168dda8648e0d5375c618'});
export function checkReady21(w){
 for(const k of Object.keys(ready21))assert.equal(w[k],ready21[k],'Ready21 window mismatch: '+k);
 assert.equal(w.toBlock-w.fromBlock+1,512);
}
// Never replace stage evidence or silently attach a changed query to a job.
export function saveQueryStage(dir,name,value,resuming){
 assert.equal(name,basename(name));assert(/^[a-z][a-z0-9-]*\.(json|sql)$/.test(name)||name==='candidate-instances.ndjson.gz');
 const dest=join(dir,name),bytes=Buffer.isBuffer(value)?value:Buffer.from(typeof value==='string'?value:JSON.stringify(value,null,2)+'\n');
 if(resuming&&existsSync(dest)){assert(readFileSync(dest).equals(bytes),'existing query stage differs: '+name);return;}
 writeFileSync(dest,bytes,{mode:0o600,flag:'wx'});
}
// Funding has no swap-edge inputs. Same query shapes and billing ceilings as the previous producer.
export async function runIndependentWindowFunding(dir,window,resuming=false,providedApi,{asOf,maxBytes=String(3*gib)}={}){
 const projectId=process.env.SELECTOR_BQ_PROJECT??'eth-token-480803';assert(/^[a-z][a-z0-9-]+$/.test(projectId));
 const ref={projectId},location='US',jobs={};
 assert(/^\d+$/.test(maxBytes)&&BigInt(maxBytes)>0n&&BigInt(maxBytes)<=BigInt(Number.MAX_SAFE_INTEGER));
 const scope={kind:'selector-window-funding/v2',projectId,location,dirName:basename(dir),maxBytes};
 const save=(f,x)=>saveQueryStage(dir,f,x,resuming);
 if(resuming)assert(existsSync(join(dir,'funding-scope.json')),'resume original independent funding directory only');
 save('funding-scope.json',scope);
 save('window.json',window);
 const api=providedApi??googleApi();
 const pinfile=join(dir,'source-pin.json');
 const oldPin=resuming&&existsSync(pinfile)?JSON.parse(readFileSync(pinfile,'utf8')):undefined;
 if(oldPin&&asOf!==undefined)assert.equal(asOf,oldPin.snapshotAt,'funding resume snapshot differs');
 const proved=await pinTraceWindow(window,{api,asOf:oldPin?.snapshotAt??asOf,cap:BigInt(maxBytes)});
 if(oldPin){assert.equal(proved.snapshotAt,oldPin.snapshotAt);assert.deepEqual(proved.coverage,oldPin.coverage);}
 const pin=oldPin??proved;save('source-pin.json',pin);
 async function stage(name,sql){
   const sqlSha256=sha(sql),jobId='sel512_'+name+'_'+sha(basename(dir)+sqlSha256).slice(0,24);
   const capBytes=Number(maxBytes),query={query:sql,useLegacySql:false,useQueryCache:true,maximumBytesBilled:maxBytes};
   save(name+'.sql',sql);const jobsUrl='https://bigquery.googleapis.com/bigquery/v2/projects/'+projectId+'/jobs';
   const req=name+'-request.json',reqfile=join(dir,req);let estimate;
   if(resuming&&existsSync(reqfile)){
     const old=JSON.parse(readFileSync(reqfile,'utf8'));assert.equal(old.sqlSha256,sqlSha256);assert.equal(old.jobId,jobId);
     assert.equal(old.capBytes,capBytes);estimate=old.estimate;
   }else{
     const dry=await api(jobsUrl,{method:'POST',timeoutMs:150000,maxAttempts:1,headers:{'Content-Type':'application/json'},body:JSON.stringify({
       jobReference:{projectId,location},configuration:{dryRun:true,query}})});
     estimate=Number(dry.statistics?.query?.totalBytesProcessed);
   }
   assert(Number.isSafeInteger(estimate)&&estimate>=0&&estimate<=capBytes,'estimate over cap: '+name+' '+estimate);
   save(req,{jobId,sqlSha256,capBytes,estimate});
   console.error(name+': '+jobId+' ('+estimate+' estimated bytes)');
   const read=await openReadyDiscoveryJob(api,ref,{jobId,location,query},[],{waitForCompletion:true});
   // Staging server-side tables only needs the completion signal. In
   // particular, never download even the first raw transaction/trace here.
   const completion=await read(0);assert.equal(completion.rows?.length??0,0);
   const j=await api(jobsUrl+'/'+jobId+'?location='+location);assert(!j.status.errorResult&&j.status.state==='DONE');
   const t=j.configuration.query.destinationTable;assert.equal(t.projectId,projectId);
   const table=[t.projectId,t.datasetId,t.tableId].join('.');
   jobs[name]={jobId,sqlSha256,table,estimate,bytesBilled:j.statistics.query.totalBytesBilled,cacheHit:j.statistics.query.cacheHit};save(name+'-job.json',jobs[name]);
   return {read,table};
 }
 async function rows(s){
   let token,count;const all=[];do{const p=await s.read(5000,token);count??=Number(p.totalRows);assert.equal(count,Number(p.totalRows));
     for(const r of p.rows??[])all.push(decodeRow(p.schema.fields,r));token=p.pageToken;}while(token);
   assert.equal(all.length,count);return all;
 }
 assertTraceFundingCoverage(window,pin.coverage,window.toBlock-window.fromBlock+1);
 const funds=await stage('funding',await renderSqlFundingSources(HISTORY,join(root,'listener'),{traceRead:fixedTraceRead(window,pin.snapshotAt)}));
 const {rows:fundingRows,failures}=splitSqlFundingRows((await rows(funds)).map(x=>JSON.parse(x.body)),window);
 const funding={format:'sql-live-funding/v1',chainId:1,window,rows:fundingRows,failures,
   sourceSnapshotAt:pin.snapshotAt,coverageJob:pin.jobId,sourceTable:HISTORY,
   sourceCoverage:pin.coverage,queryJob:jobs.funding.jobId,querySha256:jobs.funding.sqlSha256};
 save('funding.json',funding);

 return {funding:join(dir,'funding.json'),fundingSha256:sha(readFileSync(join(dir,'funding.json'))),rows:fundingRows.length,sourceSnapshotAt:pin.snapshotAt};
}

const help=[
 'selector-window.mjs --sql-only [--window pinned.json | --preset ready21] [--live-selectors-only]',
 '  Print only the official independent discovery SQL; no credentials, network or file writes.',
 'selector-window.mjs --out NEWDIR [--window pinned.json | --preset ready21] [--live-selectors-only]',
 '  Discover from the managed history table (default 16 GiB cap, optional --max-bytes). No public trace fallback.',
 'selector-window.mjs --funding-only --out NEWDIR [--window pinned.json | --preset ready21]',
 '  Generate funding.json from the managed history table (default 3 GiB cap, optional --max-bytes).',
 '  Use --snapshot-at to reuse the discovery snapshot, or supply this funding artifact to paired generation.',
 '  For a partial funding job use --funding-only --resume DIR; reopen only identical pinned stages.',
 'selector-window.mjs --from-manifest MANIFEST --manifest-sha256 SHA --previous PREVIOUS-FIXED-MANIFEST',
 '  --previous-sha256 SHA --funding SAME-WINDOW-FUNDING --funding-sha256 SHA --out NEWDIR [--window pinned.json]',
 '  Entirely offline: verify an independent discovery receipt (or a sealed full-export archive) and reuse',
 '  the previous public IDs and independently sealed funding. Choose --no-prior for a new public-ID lineage',
 '  instead of both previous arguments. --swaps-only omits funding and cannot start live.',
 '  To discover then prepare both tables in one command: omit --from-manifest/--manifest-sha256 and supply',
 '  the same --previous/--funding pairs with --out NEWDIR and your pinned window. Discovery then uses the live selector filter.',
].join('\n');
function sameWindow(a,b){
 for(const k of ['chainId','fromBlock','toBlock','firstTime','lastTime','transactions','headHash'])assert.equal(a[k],b[k],'window mismatch: '+k);
}
function readPinned(file,expect,label){
 assert(typeof file==='string'&&/^[a-f0-9]{64}$/.test(expect??''),'missing --'+label+' or its explicit SHA-256');
 const b=readFileSync(resolve(file));assert.equal(sha(b),expect,label+' digest mismatch');return JSON.parse(b);
}
async function main(){
 const keys=['preset','out','window','resume','from-manifest','manifest-sha256','previous','previous-sha256','funding','funding-sha256','snapshot-at','max-bytes'];
 const flags=['help','sql-only','live-selectors-only','swaps-only','funding-only','no-prior'];
 const {values:v}=parseArgs({options:Object.fromEntries([...keys.map(k=>[k,{type:'string'}]),...flags.map(k=>[k,{type:'boolean'}])])});
 if(v.help){console.log(help);return;}
 const offline=v['from-manifest']!==undefined,prepare=offline||!!v['swaps-only']||!!v['no-prior']||['manifest-sha256','previous','previous-sha256','funding','funding-sha256'].some(k=>v[k]!==undefined);
 assert(!(v.preset&&v.window),'select either --preset or --window');if(v.preset)assert.equal(v.preset,'ready21','unknown preset');
 assert(!v.resume||v['funding-only'],'only incomplete funding jobs can --resume; use --from-manifest for a completed discovery');
 assert(!v['manifest-sha256']||offline,'--manifest-sha256 requires --from-manifest');
 assert(!(v['sql-only']&&(prepare||v['funding-only']||v.out||v.resume)),'--sql-only is renderer only');
 assert(!(v['funding-only']&&(prepare||v['live-selectors-only'])),'funding is independent of swap discovery');
 const {ready21Window,renderIndependentTraceEdges}=await import('./independent-trace-edges.mjs');
 const receipt=offline?readPinned(v['from-manifest'],v['manifest-sha256'],'manifest'):undefined;
 const resuming=!!v.resume;const out=v.out?resolve(v.out):undefined;
 assert(!resuming||!out,'choose a new output directory or a partial funding directory');
 const fundingResume=resuming?resolve(v.resume):undefined;
 const window=v.window?JSON.parse(readFileSync(resolve(v.window),'utf8')):v.preset?ready21Window:
   receipt?.window??(resuming?JSON.parse(readFileSync(join(fundingResume,'window.json'),'utf8')):ready21Window);
 assert.equal(window.chainId,1,'a pinned mainnet window is required');
 renderSelectorTraceSourceSql({window}); // validates all canonical interval/time/count/hash pins without IO
 if(offline)sameWindow(window,receipt.window);
 if(v['sql-only']){process.stdout.write(await renderIndependentTraceEdges(window,{liveSelectorsOnly:!!v['live-selectors-only'],fixedSource:v['snapshot-at']?{snapshotAt:v['snapshot-at']}:undefined})+'\n');return;}
 assert(!offline||(!v['snapshot-at']&&!v['max-bytes']),'offline mode uses its receipt pins, not CLI overrides');
 assert(out||fundingResume,'specify --out NEWDIR (no implicit paid discovery)');
 if(out)assert(!existsSync(out),'refusing existing output directory');
 if(v['funding-only']){
   const dir=fundingResume??out;
   if(resuming){assert(!existsSync(join(dir,'funding.json')),'funding job already completed');sameWindow(window,JSON.parse(readFileSync(join(dir,'window.json'),'utf8')));}
   else mkdirSync(dir,{mode:0o700});
   console.log(JSON.stringify(await runIndependentWindowFunding(dir,window,resuming,undefined,{asOf:v['snapshot-at'],maxBytes:v['max-bytes']})));return;
 }
 let asOf=v['snapshot-at'];
 if(prepare){
   if(v['no-prior'])assert(!v.previous&&!v['previous-sha256'],'--no-prior excludes previous-coordinate arguments');
   else {
     const previous=readPinned(v.previous,v['previous-sha256'],'previous');
     assert(previous.toBlock<=window.toBlock,'future published coordinates');
     if(previous.toBlock===window.toBlock)assert.equal(previous.cutoffHash,window.headHash,'wrong prior cutoff');
     if(!offline){const {loadSqlPriceEdges}=await import('../listener/src/searcher/sql-edge-price-index.ts');await loadSqlPriceEdges(resolve(v.previous));}
   }
   if(v['swaps-only'])assert(!v.funding&&!v['funding-sha256'],'--swaps-only does not accept funding');
   else {
     const funding=readPinned(v.funding,v['funding-sha256'],'funding');
     assertPinnedFundingWindow(window,funding);
     if(!offline){
       assert(funding.sourceSnapshotAt,'paired generation needs funding from the fixed history; regenerate funding, not public traces');
       if(asOf!==undefined)assert.equal(asOf,funding.sourceSnapshotAt);
       asOf=funding.sourceSnapshotAt;
     }
     const {readSqlFundingRows}=await import('../listener/src/searcher/sql-live-tables.ts');
     readSqlFundingRows(funding,{fromBlock:window.fromBlock,toBlock:window.toBlock,cutoffHash:window.headHash});
   }
 }
 let upstream=offline?resolve(v['from-manifest']):undefined,upstreamSha256=v['manifest-sha256'],dest=out;
 if(!offline){
   // Preserve the upstream producer job receipt and SQL. No second discovery implementation.
   mkdirSync(out,{mode:0o700});const discovery=prepare?join(out,'discovery'):out;
   if(prepare){mkdirSync(discovery,{mode:0o700});dest=join(out,'live-input');}
   saveQueryStage(discovery,'window.json',window,false);const argv=[join(root,'scripts','independent-trace-edges.mjs'),'--window',join(discovery,'window.json'),'--out',discovery];
   if(prepare||v['live-selectors-only'])argv.push('--live-selectors-only');
   if(asOf!==undefined)argv.push('--snapshot-at',asOf);
   if(v['max-bytes']!==undefined)argv.push('--max-bytes',v['max-bytes']);
   const child=spawnSync(process.execPath,['--import',join(root,'listener','node_modules','tsx','dist','loader.mjs'),...argv],{cwd:root,stdio:'inherit'});
   if(child.error)throw child.error;assert.equal(child.status,0,'independent discovery failed; no live input sealed');
   if(!prepare)return;
   upstream=join(discovery,'manifest.json');upstreamSha256=sha(readFileSync(upstream));
 }else assert(!v['live-selectors-only'],'offline mode attests the selector mode from the upstream manifest');
 const {exportIndependentLive}=await import('./selector-independent-live-export.mjs');
 const result=await exportIndependentLive({upstream,upstreamSha256,previous:v.previous?resolve(v.previous):undefined,previousSha256:v['previous-sha256'],
   funding:v.funding?resolve(v.funding):undefined,fundingSha256:v['funding-sha256'],out:dest,swapsOnly:!!v['swaps-only'],noPrior:!!v['no-prior']});
 console.log(JSON.stringify({out:dest,...result}));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(e=>{console.error(e.message);process.exitCode=1;});
