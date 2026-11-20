// Offline reconciliation of two independently produced inventories. A missing
// row in either inventory is not evidence of historical inactivity or absence.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createReadStream,createWriteStream,existsSync,mkdirSync,readFileSync,readdirSync,renameSync,writeFileSync} from 'node:fs';
import {once} from 'node:events';
import {basename,dirname,join,resolve} from 'node:path';
import {Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {StringDecoder} from 'node:string_decoder';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';
import {createGzip,createGunzip} from 'node:zlib';
import {candidateCoordinateFields} from './selector-candidate-instances-sql.mjs';

const H=()=>createHash('sha256'),sha=b=>H().update(b).digest('hex'),shaPattern=/^[a-f0-9]{64}$/;
const addr=/^0x[0-9a-f]{40}$/i,word=/^0x[0-9a-f]{64}$/i;
const idFields=['chainId','poolAddress','poolNamespace','poolId','tokenIn','tokenInId','tokenOut','tokenOutId'];
const kinds=['intersection','startup-only','sql-only','incomparable'];
function pin(got,expected,label) {
  if(expected!==undefined){assert(shaPattern.test(expected),'invalid '+label+' pin');assert.equal(got,expected,label+' differs');}
}
const strictAddress=x=>typeof x==='string'&&addr.test(x)?x.toLowerCase():x;
// Pool IDs and namespaces may be Family-defined *strings*. Keep spelling
// exactly; only the raw address columns have a universal address codec.
export function edgeCoordinates(r) {
  return Object.fromEntries(idFields.map(k=>[k,['poolAddress','tokenIn','tokenOut'].includes(k)?strictAddress(r[k]??null):r[k]??null]));
}
export const coordinateKey=r=>JSON.stringify(idFields.map(f=>r[f]??null));
export function incomparableReasons(r,chainId) {
  const reasons=[];
  if(!Number.isSafeInteger(r.chainId)||r.chainId<1||r.chainId!==chainId)reasons.push('chain-not-comparable');
  for(const name of ['poolAddress','tokenIn','tokenOut'])if(typeof r[name]!=='string'||!addr.test(r[name]))reasons.push('invalid-or-missing-'+name);
  if(r.poolNamespace!==null)reasons.push('startup-schema-has-no-pool-namespace');
  if(r.tokenInId!==null||r.tokenOutId!==null)reasons.push('startup-schema-has-no-token-ids');
  if(r.poolId!==null&&(typeof r.poolId!=='string'||r.poolId.length===0))reasons.push('invalid-pool-id');
  return reasons;
}
const sorted=xs=>[...xs].sort();
const dict=()=>Object.create(null);
const bump=(m,k,n=1)=>{m[k]=(m[k]??0)+n;};
function loadJson(p,checksum,label) {
  const bytes=readFileSync(p),digest=sha(bytes);pin(digest,checksum,label);
  return {data:JSON.parse(bytes),artifact:{path:resolve(p),bytes:bytes.length,sha256:digest}};
}
function validateWindow(w){
  assert(w&&Number.isSafeInteger(w.fromBlock)&&w.fromBlock>=0&&Number.isSafeInteger(w.toBlock)&&w.fromBlock<=w.toBlock&&word.test(w.headHash),'missing window anchor');
  return w;
}
function sameWindow(a,b){return a.fromBlock===b.fromBlock&&a.toBlock===b.toBlock&&a.headHash.toLowerCase()===b.headHash.toLowerCase();}
async function gzipLines(file,visit){
  const hash=H();let bytes=0,lines=0;
  await pipeline(createReadStream(file),new Transform({transform(b,enc,cb){hash.update(b);bytes+=b.length;cb(null,b);}}),
    createGunzip(),async src=>{
      const decoder=new StringDecoder('utf8');let rest='';
      for await (const chunk of src){
        const text=rest+decoder.write(chunk);let i=0,end;
        while((end=text.indexOf('\n',i))>=0){assert(end>i,'empty NDJSON row');visit(JSON.parse(text.slice(i,end)),++lines);i=end+1;}
        rest=text.slice(i);
      }
      rest+=decoder.end();if(rest)visit(JSON.parse(rest),++lines);
    });
  return {path:resolve(file),sha256:hash.digest('hex'),bytes,lines};
}
function newWriter(out,kind){
  const file=kind+'.ndjson.gz',tmp=join(out,file+'.partial'),hash=H();
  const z=createGzip(),finished=pipeline(z,new Transform({transform(b,enc,cb){hash.update(b);cb(null,b);}}),createWriteStream(tmp,{flags:'wx',mode:0o600}));
  finished.catch(()=>{});let count=0;
  return {write:async r=>{if(!z.write(JSON.stringify(r)+'\n'))await once(z,'drain');count++;},
    end:async()=>{z.end();await finished;renameSync(tmp,join(out,file));return {file,rows:count,sha256:hash.digest('hex')};}};
}
function refEvidence(row){
  assert.equal(row.verified,false,'SQL candidate cannot provide Ready admission or absence');
  assert(/^(?:0x)[0-9a-f]{8}$/.test(row.selector),'invalid SQL selector');
  assert(Array.isArray(row.familyIds)&&row.familyIds.length>0&&Array.isArray(row.observedFamilyIds),'missing candidate families');
  assert(row.familyIds.every(f=>typeof f==='string'&&f.startsWith('execution:'+row.selector+':abi-')&&shaPattern.test(f.split(':abi-')[1])),'invalid SQL family binding');
  assert.equal(new Set(row.familyIds).size,row.familyIds.length,'duplicate family in a candidate');
  assert.equal(new Set(row.observedFamilyIds).size,row.observedFamilyIds.length,'duplicate observed family');
  assert(row.observedFamilyIds.every(x=>row.familyIds.includes(x)),'observed noncandidate family');
  assert.equal(row.observedTargetSelector,row.observedFamilyIds.length>0,'selector observation disagrees');
  for(const k of candidateCoordinateFields)assert(Object.hasOwn(row,k),'missing candidate coordinate '+k);
  // Hash the original selector-bearing tuple independently of our comparison.
  const encoded=JSON.stringify(candidateCoordinateFields.map(k=>k==='chainId'?String(row[k]):row[k]??null));
  assert.equal(row.candidateInstanceKey,'candidate-edge:v1:'+sha(encoded),'candidate identity differs from its coordinates');
  return {candidateInstanceKey:row.candidateInstanceKey,selector:row.selector,familyIds:sorted(row.familyIds),observedFamilyIds:sorted(row.observedFamilyIds)};
}
const listFromRefs=(rs,field)=>sorted(new Set(rs.flatMap(s=>s[field])));
function startupStats(group,row){
  const [,,,,status,adapter]=row;assert(typeof status==='string'&&status.length&&typeof adapter==='string'&&adapter.length,'missing startup metadata');
  group.rows++;bump(group.adapters,adapter);bump(group.statuses,status);
}
export async function reconcileEdgeDifference({startup,instances,out,chainId,manifest=join(dirname(instances),'instances-summary.json'),
  startupSha256,instancesSha256,manifestSha256,startupSnapshotSha256,baselineSummary,baselineSummarySha256}){
  assert(Number.isSafeInteger(chainId)&&chainId>0,'explicit positive startup chainId required');
  assert(typeof out==='string'&&out.length,'output folder required');out=resolve(out);
  assert(!existsSync(out)||readdirSync(out).length===0,'output folder must be new or empty');
  const {data:ref,artifact:startupArtifact}=loadJson(startup,startupSha256,'startup input');
  assert(shaPattern.test(ref.sha256)&&Number.isSafeInteger(ref.source?.number)&&word.test(ref.source.hash),'missing startup snapshot/source');
  pin(ref.sha256,startupSnapshotSha256,'startup snapshot');
  assert(Array.isArray(ref.edgeRows)&&ref.graphEdges===ref.edgeRows.length,'incomplete startup export');
  validateWindow(ref.window);
  const {data:receipt,artifact:receiptArtifact}=loadJson(manifest,manifestSha256,'SQL manifest');
  assert(typeof receipt.job==='string'&&receipt.job.length&&typeof receipt.sourceLedger==='string'&&receipt.sourceLedger.length,'missing SQL job IDs');
  assert.equal(receipt.artifact,basename(instances),'SQL manifest points to a different artifact');
  assert.equal(receipt.verified,false,'unexpected SQL authority');validateWindow(receipt.window);
  assert.deepEqual(receipt.fields,candidateCoordinateFields,'candidate key schema differs');
  const source=new Map(),sql=new Map(),seen=new Set(),duplicates=dict(),incomparable=new Map();
  const inc=(side,c)=>{const k=JSON.stringify([side,coordinateKey(c)]);if(!incomparable.has(k))incomparable.set(k,{side,c,reasons:incomparableReasons(c,chainId)});
    return incomparable.get(k);};
  for(const row of ref.edgeRows){
    assert(Array.isArray(row)&&row.length===7,'unexpected startup edge projection');
    const [poolAddress,poolId,tokenIn,tokenOut]=row,c=edgeCoordinates({chainId,poolAddress,poolId,tokenIn,tokenOut});
    let g;const reasons=incomparableReasons(c,chainId),k=coordinateKey(c);
    if(reasons.length){const group=inc('startup',c);g=group.startup??={rows:0,adapters:dict(),statuses:dict()};}
    else{g=source.get(k)??{rows:0,adapters:dict(),statuses:dict()};source.set(k,g);}
    startupStats(g,row);
  }
  const sqlArtifact=await gzipLines(instances,row=>{
    const ev=refEvidence(row);assert(!seen.has(ev.candidateInstanceKey),'duplicate SQL candidate instance');
    seen.add(ev.candidateInstanceKey);const c=edgeCoordinates(row),k=coordinateKey(c),reasons=incomparableReasons(c,chainId);
    if(reasons.length){const group=inc('sql',c);(group.sql??=[]).push(ev);}
    else{if(!sql.has(k))sql.set(k,[]);sql.get(k).push(ev);}
  });pin(sqlArtifact.sha256,instancesSha256,'SQL input');assert.equal(sqlArtifact.lines,receipt.rows,'SQL manifest rows mismatch');
  let prior=null;
  if(baselineSummary){
    const {data,artifact}=loadJson(baselineSummary,baselineSummarySha256,'prior summary');
    assert.equal(data.format,'selector-edge-difference/v1');assert.equal(data.inputs.startup.sha256,startupArtifact.sha256,'baseline startup input differs');
    assert.equal(data.chainId,chainId,'baseline chain differs');
    prior={summary:artifact,sqlSha256:data.inputs.instances.sha256,window:data.sqlWindow,sameWindow:sameWindow(data.sqlWindow,receipt.window),counts:data.counts};
  }else assert(!baselineSummarySha256,'baseline hash needs a baseline summary');
  mkdirSync(out,{recursive:true,mode:0o700});
  const counts=Object.fromEntries(kinds.map(x=>[x,0])),reasonCounts=dict(),startupOnlyByAdapter=dict(),sources={inputRows:ref.edgeRows.length,comparableCoordinates:source.size,incomparableRows:0},
    sqlStats={inputRows:sqlArtifact.lines,comparableCoordinates:sql.size,incomparableRows:0};
  const writers=Object.fromEntries(kinds.map(k=>[k,newWriter(out,k)]));
  async function emit(kind,c,sg,refs,reasons=[],side=null){
    const adapterIds=sg?Object.keys(sg.adapters).sort():[];
    const startupPart=sg?{rows:sg.rows,adapterIds,rowsByAdapter:sg.adapters,rowsByQuoteStatus:sg.statuses}:null;
    const sqlPart=refs?{rows:refs.length,familyIds:listFromRefs(refs,'familyIds'),selectors:sorted(new Set(refs.map(r=>r.selector))),
      observedFamilyIds:listFromRefs(refs,'observedFamilyIds'),instances:refs.sort((a,b)=>a.candidateInstanceKey.localeCompare(b.candidateInstanceKey))}:null;
    counts[kind]++;if(sg?.rows>1)bump(duplicates,'startupCoordinatesWithMultipleRows');
    if(adapterIds.length>1)bump(duplicates,'startupCoordinatesWithMultipleAdapters');
    if(kind==='startup-only')for(const id of adapterIds)bump(startupOnlyByAdapter,id);
    if(kind==='incomparable'){for(const reason of reasons)bump(reasonCounts,reason);sources.incomparableRows+=sg?.rows??0;sqlStats.incomparableRows+=refs?.length??0;}
    await writers[kind].write({kind,physicalKey:'edge-coordinate:v1:'+sha(coordinateKey(c)),...c,startup:startupPart,sql:sqlPart,
      historicalActivity:'unassessed',absenceProven:false,...(side?{side,reasons}:{})});
  }
  for(const k of sorted(new Set([...source.keys(),...sql.keys()]))){
    const tuple=JSON.parse(k),c=Object.fromEntries(idFields.map((f,i)=>[f,tuple[i]]));
    await emit(source.has(k)?sql.has(k)?'intersection':'startup-only':'sql-only',c,source.get(k),sql.get(k));
  }
  for(const k of sorted(incomparable.keys())){const g=incomparable.get(k);await emit('incomparable',g.c,g.startup,g.sql,g.reasons,g.side);}
  const files=Object.fromEntries(await Promise.all(kinds.map(async k=>[k,await writers[k].end()])));
  assert.equal(sources.comparableCoordinates,counts.intersection+counts['startup-only']);
  assert.equal(sqlStats.comparableCoordinates,counts.intersection+counts['sql-only']);
  const summary={format:'selector-edge-difference/v1',chainId,inputs:{startup:startupArtifact,instances:sqlArtifact,sqlManifest:receiptArtifact},
    startupSource:ref.source,startupSnapshotSha256:ref.sha256,startupDiscoveryWindow:ref.window,sqlWindow:receipt.window,
    sameDiscoveryWindow:sameWindow(ref.window,receipt.window),sourceJobs:{startupDiscovery:ref.jobId,instances:receipt.job,sourceLedger:receipt.sourceLedger},
    coordinateFields:idFields,nativeEthWethAliased:false,counts,startup:sources,sql:sqlStats,duplicates,incomparableReasons:reasonCounts,
    startupOnlyByAdapter,note:'Adapter bins may overlap. Inventory differences are unassessed; zero absence verdicts. No Ready or on-chain validation.',
    prior,files};
  writeFileSync(join(out,'summary.json'),JSON.stringify(summary,null,2)+'\n',{mode:0o600,flag:'wx'});return summary;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const {values:a}=parseArgs({options:Object.fromEntries(['startup','instances','out','chain-id','manifest','startup-sha256','instances-sha256',
    'manifest-sha256','startup-snapshot-sha256','baseline-summary','baseline-summary-sha256'].map(k=>[k,{type:'string'}]))});
  assert(a.startup&&a.instances&&a.out&&a['chain-id'],'usage: --startup <family-price-poolkeys.json> --instances <candidate-instances.ndjson.gz> --out <new-directory> --chain-id 1');
  const r=await reconcileEdgeDifference({startup:a.startup,instances:a.instances,out:a.out,chainId:Number(a['chain-id']),manifest:a.manifest,
    startupSha256:a['startup-sha256'],instancesSha256:a['instances-sha256'],manifestSha256:a['manifest-sha256'],startupSnapshotSha256:a['startup-snapshot-sha256'],
    baselineSummary:a['baseline-summary'],baselineSummarySha256:a['baseline-summary-sha256']});
  console.log(JSON.stringify({counts:r.counts,files:r.files,output:resolve(a.out)}));
}
