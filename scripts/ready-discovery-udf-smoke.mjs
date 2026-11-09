#!/usr/bin/env node
// Bounded remote JS-runtime check over saved fixture rows only; no table scan,
// identity RPC, Ready mutation, signing, deployment or live process.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import vm from 'node:vm';
const args=Object.fromEntries(process.argv.slice(2).reduce((rows,key,i,all)=>i%2?rows:[...rows,[key,all[i+1]]],[]));
assert(Object.keys(args).every(k=>['--kernel','--fixtures','--project','--bucket','--configuration','--out'].includes(k)));
for(const k of ['--kernel','--fixtures','--project','--bucket','--configuration','--out'])assert(args[k],k+' required');
assert(/^[a-z][a-z0-9-]+$/.test(args['--project'])&&/^[a-z0-9_.-]+$/.test(args['--bucket']));
const out=resolve(args['--out']);mkdirSync(out,{recursive:false});
const save=(name,data)=>writeFileSync(out+'/'+name,JSON.stringify(data,null,2)+'\n',{flag:'wx',mode:0o600});
const sha=b=>createHash('sha256').update(b).digest('hex');
const kernel=readFileSync(args['--kernel']), bytes=readFileSync(args['--fixtures']);
assert(bytes.length<=1024**2&&kernel.length<=8*1024**2,'bounded input size');
const fixture=JSON.parse(bytes), rows=fixture.transactions;
assert(fixture.format==='bigquery-discovery-parity-v1'&&rows.length>0&&rows.length<=32,'bounded fixture rows');
const provenance=JSON.parse(readFileSync(resolve(dirname(args['--kernel']),'build-provenance.json'),'utf8'));
const resources=provenance.resources;
assert(Array.isArray(resources)&&resources.length>0&&resources.at(-1).file===basename(args['--kernel']));
const sandbox=vm.createContext({});
const resourceBytes=resources.map(r=>{assert(/^[a-z0-9-]+\.js$/.test(r.file));const b=readFileSync(resolve(dirname(args['--kernel']),r.file));assert.equal(sha(b),r.sha256);assert(b.length<=1048576);vm.runInContext(b.toString(),sandbox,{timeout:30000});return b;});
const expected=rows.map(tx=>JSON.parse(sandbox.DiscoveryKernel.compactTransactionJson(JSON.stringify(tx))));
const token=execFileSync('gcloud',['--configuration='+args['--configuration'],'auth','print-access-token'],{encoding:'utf8',timeout:30000,stdio:['ignore','pipe','pipe']}).trim();
async function request(url,body,method='POST',contentType='application/json') {
  const res=await fetch(url,{method,headers:{Authorization:'Bearer '+token,'Content-Type':contentType},...(body===undefined?{}:{body:contentType==='application/json'?JSON.stringify(body):body}),signal:AbortSignal.timeout(30000)});
  return res;
}
const libraries=[];
for(const [i,resource] of resources.entries()){
  const object='mev-discovery-json-check/'+resource.sha256+'/'+resource.file;
  const objectUrl='https://storage.googleapis.com/storage/v1/b/'+args['--bucket']+'/o/'+encodeURIComponent(object);
  const uploaded=await request('https://storage.googleapis.com/upload/storage/v1/b/'+args['--bucket']+'/o?uploadType=media&ifGenerationMatch=0&name='+encodeURIComponent(object),resourceBytes[i],'POST','application/javascript');
  assert(uploaded.ok||uploaded.status===412,'UDF artifact upload failed HTTP '+uploaded.status);await uploaded.body?.cancel();
  const stored=await request(objectUrl+'?alt=media',undefined,'GET');assert(stored.ok,'UDF artifact read failed');assert.equal(sha(new Uint8Array(await stored.arrayBuffer())),resource.sha256,'stored UDF differs');
  libraries.push('gs://'+args['--bucket']+'/'+object);
}
const sql=`CREATE TEMP FUNCTION discover(tx STRING) RETURNS STRING LANGUAGE js OPTIONS(library=[${libraries.map(v=>JSON.stringify(v)).join(',')}]) AS r'''return DiscoveryKernel.compactTransactionJson(tx);'''; SELECT sample.id, discover(sample.tx) AS result FROM UNNEST(@samples) AS sample ORDER BY sample.id`;
const query={query:sql,useLegacySql:false,useQueryCache:false,maximumBytesBilled:String(10*1024**2),parameterMode:'NAMED',queryParameters:[{name:'samples',parameterType:{type:'ARRAY',arrayType:{type:'STRUCT',structTypes:[{name:'id',type:{type:'INT64'}},{name:'tx',type:{type:'STRING'}}]}},parameterValue:{arrayValues:rows.map((tx,id)=>({structValues:{id:{value:String(id)},tx:{value:JSON.stringify(tx)}}}))}}]};
const jobId='mev_json_discovery_'+sha(JSON.stringify({query,kernel:sha(kernel)})).slice(0,24), project=args['--project'];
const jobPath='https://bigquery.googleapis.com/bigquery/v2/projects/'+project+'/jobs/'+jobId+'?location=US';
save('inputs.json',{kernelSha256:sha(kernel),fixturesSha256:sha(bytes),rows:rows.length,libraries,jobId,query,scope:'registered fixtures only, no table scan'});
let res=await request(jobPath,undefined,'GET');
if(res.status===404){await res.body?.cancel();res=await request('https://bigquery.googleapis.com/bigquery/v2/projects/'+project+'/jobs',{jobReference:{projectId:project,jobId,location:'US'},configuration:{jobTimeoutMs:'60000',query}});}
assert(res.ok,'BigQuery job request HTTP '+res.status);let job=await res.json();
for(let i=0;i<50&&job.status?.state!=='DONE';i++){await new Promise(r=>setTimeout(r,1000));res=await request(jobPath,undefined,'GET');assert(res.ok);job=await res.json();}
save('job.json',job);assert.equal(job.status?.state,'DONE','job pending; do not start another job');assert(!job.status.errorResult,JSON.stringify(job.status.errorResult));
res=await request('https://bigquery.googleapis.com/bigquery/v2/projects/'+project+'/queries/'+jobId+'?location=US&maxResults=100',undefined,'GET');assert(res.ok);const result=await res.json();save('results.json',result);
assert(result.jobComplete&&!result.pageToken);assert.equal(result.rows?.length,rows.length);
const actual=result.rows.map(row=>JSON.parse(row.f[1].v));assert.deepEqual(actual,expected,'BigQuery runtime differs from the same compiled sandbox');
const report={result:'pass',rows:rows.length,candidates:actual.flat().filter(r=>r.kind==='candidate').length,opaque:actual.flat().filter(r=>r.kind==='opaque').length,kernelSha256:sha(kernel),fixturesSha256:sha(bytes),jobId,bytesProcessed:job.statistics?.query?.totalBytesProcessed,bytesBilled:job.statistics?.query?.totalBytesBilled,slotMs:job.statistics?.totalSlotMs,scope:'query-side discovery parity, not identity/Family execution acceptance'};
save('verdict.json',report);console.log(JSON.stringify(report));
