// Complete selector SQL pipeline. The default comparison interval is fixed;
// the reference Graph is never an input to any query stage.
import assert from 'node:assert/strict';
import {existsSync,mkdirSync,mkdtempSync,writeFileSync,readFileSync} from 'node:fs';
import {join,resolve,basename,dirname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';
import {gzipSync} from 'node:zlib';
import {googleApi,loadPublishedRules,sha} from './selector-query-client.mjs';
import {decodeRow} from './bigquery-table.mjs';
import {openReadyDiscoveryJob} from './ready-bigquery-sql.mjs';
import {resolveReadyWindow} from './ready-bigquery-window.mjs';
import {loadCatalogEventRules,renderCatalogEventQuery} from './selector-event-catalog-sql.mjs';
import {selectorWindowTopLevelSelectors,renderSelectorWindowCallsSql,renderSelectorWindowTraceCallsSql} from './selector-window-calls-sql.mjs';
import {renderV4TraceReceiptKeys} from './selector-sql-sources/v4-trace-receipt-keys.mjs';
import {renderSelectorReceiptLayouts} from './selector-sql-sources/receipt-layouts.mjs';
import {renderSelectorWindowLedger} from './selector-family-window-ledger-sql.mjs';
import {candidateCoordinateFields,renderSelectorCandidateInstancesSql} from './selector-candidate-instances-sql.mjs';
import {renderSqlFundingSources} from './selector-funding-sql.mjs';
import {assertTraceFundingCoverage,splitSqlFundingRows} from './selector-live-funding-export.mjs';
import {renderTraceCoverageSql,traceOrdinaryRegistry,traceResourceKind} from './selector-trace-window-sql.mjs';
import {renderSelectorTraceSourceSql} from './selector-trace-source-sql.mjs';

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
export function exportPriceEdges(dir,candidates,window,resuming=false){
 const edges=[...candidates].sort((a,b)=>a.candidateInstanceKey.localeCompare(b.candidateInstanceKey));
 assert.equal(new Set(edges.map(e=>e.candidateInstanceKey)).size,edges.length);
 for(const e of edges){
   const tuple=candidateCoordinateFields.map(k=>k==='chainId'?String(e[k]):e[k]);
   assert.equal(e.candidateInstanceKey,'candidate-edge:v1:'+sha(JSON.stringify(tuple)));assert.equal(e.verified,false);
 }
 const wire=Buffer.from(edges.map(e=>JSON.stringify(e)+'\n').join('')),gz=gzipSync(wire,{level:6});
 const edgeFile='candidate-instances.ndjson.gz',fixedManifest='fixed-edge-manifest.json';
 const manifest={format:'ready-fixed-edges/v1',edgeFile,edgeSha256:sha(gz),rows:edges.length,
   fromBlock:window.fromBlock,toBlock:window.toBlock,cutoffHash:window.headHash};
 saveQueryStage(dir,'edges.json',edges,resuming);saveQueryStage(dir,edgeFile,gz,resuming);saveQueryStage(dir,fixedManifest,manifest,resuming);
 return {fixedManifest,fixedManifestSha256:sha(readFileSync(join(dir,fixedManifest))),sortedNdjsonSha256:sha(wire)};
}
async function main(){
 const {values:v}=parseArgs({options:{preset:{type:'string',default:'ready21'},out:{type:'string'},resume:{type:'string'},reference:{type:'string'},'reuse-inputs':{type:'string'},'discovery-libraries':{type:'string'},'receipt-only-edges':{type:'boolean'},help:{type:'boolean'}}});
 if(v.help){console.log('selector-window.mjs [--preset ready21] [--out parent-directory] [--resume incomplete-query-dir] [--reuse-inputs previous-manifest.json] [--discovery-libraries content-addressed-uris.json] [--receipt-only-edges] [--reference graph.json (compare only after export)]');return;}
 assert.equal(v.preset,'ready21','use --preset ready21');
 const projectId=process.env.SELECTOR_BQ_PROJECT??'eth-token-480803';assert(/^[a-z][a-z0-9-]+$/.test(projectId));
 const base=resolve(v.out??join(root,'logs/selector-ready21-512'));mkdirSync(base,{recursive:true});
 const dir=v.resume?resolve(v.resume):mkdtempSync(join(base,'query-'));
 if(v.resume){assert.equal(dirname(dir),base);assert(/^query-[a-zA-Z0-9]{6}$/.test(basename(dir))&&existsSync(join(dir,'window.json'))&&!existsSync(join(dir,'manifest.json')),'resume an incomplete query only');}
 const save=(f,x)=>saveQueryStage(dir,f,x,!!v.resume);
 console.error('Query artifacts: '+dir);
 const api=googleApi(),ref={projectId},location='US',jobs={};
 const published=v['discovery-libraries']?JSON.parse(readFileSync(resolve(v['discovery-libraries']),'utf8')):undefined;
 assert(published===undefined||Array.isArray(published),'Expected an ordered discovery library URI array');
 const [window,{rules,libraries}]=await Promise.all([
   resolveReadyWindow(api,ref,location,4*gib,{fromBlock:ready21.fromBlock,toBlock:ready21.toBlock,revision:basename(dir)}),loadPublishedRules(root,api,published)
 ]);
 checkReady21(window);save('window.json',window);
 const previous=v['reuse-inputs']?JSON.parse(readFileSync(resolve(v['reuse-inputs']))):null;
 if(previous){checkReady21(previous.window);assert.equal(previous.chainId,1);}
 async function stage(name,sql,limitGiB){
   const sqlSha256=sha(sql),jobId='sel512_'+name+'_'+sha(basename(dir)+sqlSha256).slice(0,24);
   const query={query:sql,useLegacySql:false,useQueryCache:true,maximumBytesBilled:String(limitGiB*gib)};
   save(name+'.sql',sql);const jobsUrl='https://bigquery.googleapis.com/bigquery/v2/projects/'+projectId+'/jobs';
   // Only identical, unchanged upstream queries may be reused. Never accept a
   // caller-supplied table in lieu of the successful, byte-matched query job.
   if(previous&&(name==='catalog'||(name==='calls'&&previous.jobs.calls?.sqlSha256===sqlSha256))){
     const old=previous.jobs[name];assert.equal(old.sqlSha256,sqlSha256);
     assert(/^sel512_[a-z-]+_[0-9a-f]{24}$/.test(old.jobId));
     const j=await api(jobsUrl+'/'+old.jobId+'?location='+location);assert.equal(j.status.state,'DONE');assert(!j.status.errorResult);
     assert.equal(j.configuration.query.query,sql);const t=j.configuration.query.destinationTable;assert.equal(t.projectId,projectId);
     const table=[t.projectId,t.datasetId,t.tableId].join('.');assert.equal(table,old.table);
     const meta=await api('https://bigquery.googleapis.com/bigquery/v2/projects/'+projectId+'/datasets/'+t.datasetId+'/tables/'+t.tableId);
     assert.deepEqual(meta.tableReference,t);
     jobs[name]={...old,reused:true};save(name+'-job.json',jobs[name]);return {table};
   }
   const req=name+'-request.json',reqfile=join(dir,req);let estimate;
   if(v.resume&&existsSync(reqfile)){
     const old=JSON.parse(readFileSync(reqfile,'utf8'));assert.equal(old.sqlSha256,sqlSha256);assert.equal(old.jobId,jobId);
     assert.equal(old.capBytes,limitGiB*gib);estimate=old.estimate;
   }else{
     const dry=await api(jobsUrl,{method:'POST',timeoutMs:150000,maxAttempts:1,headers:{'Content-Type':'application/json'},body:JSON.stringify({
       jobReference:{projectId,location},configuration:{dryRun:true,query}})});
     estimate=Number(dry.statistics?.query?.totalBytesProcessed);
   }
   assert(Number.isSafeInteger(estimate)&&estimate>=0&&estimate<=limitGiB*gib,'estimate over cap: '+name+' '+estimate);
   save(req,{jobId,sqlSha256,capBytes:limitGiB*gib,estimate});
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
 const catalog=loadCatalogEventRules(root), selectors=selectorWindowTopLevelSelectors(rules);
 const traceBacked=!v['receipt-only-edges'];
 const [fundingFrames,events]=await Promise.all([
   stage('funding-frames',renderSelectorTraceSourceSql({window}),4),
   stage('catalog',renderCatalogEventQuery({window,catalog}),9)
 ]);
 const fundingCoverage=await rows(await stage('funding-coverage',renderTraceCoverageSql(fundingFrames.table),1));
 assert.equal(fundingCoverage.length,1);assertTraceFundingCoverage(window,fundingCoverage[0]);
 const source=traceBacked?fundingFrames.table:undefined;
 const [calls,enriched,traceV4]=await Promise.all([
   stage('calls',traceBacked?renderSelectorWindowTraceCallsSql({
     source,selectors,libraries,registry:traceOrdinaryRegistry(root,rules,traceResourceKind),
   }):renderSelectorWindowCallsSql({window,selectors,libraries}),9),
   stage('receipts',await renderSelectorReceiptLayouts(window,{v4CalldataKeys:true,v4NativeReceiptKeys:true}),9),
   traceBacked?stage('v4-trace',await renderV4TraceReceiptKeys({window,source,rules}),4):null
 ]);
 const coverage=await rows(await stage('coverage',`SELECT 'calls' k,body FROM \`${calls.table}\` WHERE row_kind='source' UNION ALL SELECT 'receipts',body FROM \`${enriched.table}\` WHERE kind='coverage'`,1));
 assert.equal(coverage.length,2);const c=JSON.parse(coverage.find(x=>x.k==='calls').body),r=JSON.parse(coverage.find(x=>x.k==='receipts').body);
 assert.equal(String(c.sourceRows),window.transactions);assert.equal(Number(c.minBlock),window.fromBlock);assert.equal(Number(c.lastHead.number),window.toBlock);assert.equal(c.lastHead.blockHash,window.headHash);assert.deepEqual(c.firstHead,c.lastHead);
 assert.equal(Number(r.blocks),512);assert.equal(Number(r.distinctBlocks),512);assert.equal(String(r.transactions),window.transactions);assert.equal(r.headHash,window.headHash);
 const ledger=await stage('ledger',renderSelectorWindowLedger({calls:calls.table,events:events.table,enriched:enriched.table,rules,traceV4:traceV4?.table}),2);
 const result=await stage('edges',renderSelectorCandidateInstancesSql(ledger.table),2);
 const candidates=(await rows(result)).map(x=>JSON.parse(x.body));assert.equal(new Set(candidates.map(x=>x.candidateInstanceKey)).size,candidates.length);
 const funds=await stage('funding',await renderSqlFundingSources(fundingFrames.table,join(root,'listener')),3);
 const {rows:fundingRows,failures}=splitSqlFundingRows((await rows(funds)).map(x=>JSON.parse(x.body)),window);
 const funding={format:'sql-live-funding/v1',chainId:1,window,rows:fundingRows,failures,
   sourceJob:jobs['funding-frames'].jobId,coverageJob:jobs['funding-coverage'].jobId,
   sourceCoverage:fundingCoverage[0],queryJob:jobs.funding.jobId,querySha256:jobs.funding.sqlSha256};
 save('funding.json',funding);
 const edgeReceipts=exportPriceEdges(dir,candidates,window,!!v.resume);
 save('manifest.json',{preset:'ready21',chainId:1,window,discoveryLibraries:libraries,edgeCallSource:traceBacked?'trace':'receipt-only',callsCoverage:c,receiptCoverage:r,ordinaryFamilies:catalog.ordinaryFamilies.length,...edgeReceipts,
   fundingSources:fundingRows.length,fundingFailureGroups:failures.length,
   fundingFailureObservations:failures.reduce((n,f)=>n+f.observations,0),fundingFile:'funding.json',fundingTableSha256:sha(readFileSync(join(dir,'funding.json'))),
   jobs,count:candidates.length,observedSelector:candidates.filter(e=>e.observedTargetSelector).length,
   semantics:'selector candidates, not verified graph edges',referenceUsedAsInput:false});
 let comparison;
 if(v.reference){
   const reference=resolve(v.reference),bytes=readFileSync(reference),graph=JSON.parse(bytes);
   checkReady21({...graph.window,transactions:String(graph.window?.transactions)});assert.equal(graph.edges.length,4403,'expected the verified Ready21 export');
   const {writeSelectorWindowComparison}=await import('./selector-window-compare.mjs');
   comparison=(await writeSelectorWindowComparison({instances:join(dir,'edges.json'),reference,referenceSha256:sha(bytes),instancesSha256:sha(readFileSync(join(dir,'edges.json'))),
     chainId:1,pins:join(dir,'window.json'),out:join(dir,'comparison')})).counts;
 }
 console.log(JSON.stringify({edges:join(dir,'edges.json'),count:candidates.length,window,comparison}));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(e=>{console.error(e.message);process.exitCode=1;});
