// Offline bridge, not a discovery engine or launcher. First run the unmodified
// independent-trace-edges CLI with --live-selectors-only. Its original receipt
// and complete edges.json are the evidence; the price table is just a projection.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {constants,createReadStream} from 'node:fs';
import {mkdir,readFile,writeFile,copyFile} from 'node:fs/promises';
import {createInterface} from 'node:readline';
import {Transform} from 'node:stream';
import {dirname,join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';
import {createGunzip,gzipSync} from 'node:zlib';
import {sqlDirectionId,loadSqlPriceEdges} from '../listener/src/searcher/sql-edge-price-index.ts';
import {sealSqlLiveInput} from '../listener/src/searcher/sql-live-input-cli.ts';
import {loadLiveSqlTables,readSqlFundingRows} from '../listener/src/searcher/sql-live-tables.ts';
import {poolIdLayouts} from './selector-sql-sources/trace-pool-id.mjs';
import {assertPinnedFundingWindow} from './selector-live-funding-export.mjs';
import {GENERATED_PRODUCTION_FAMILY_ENTRIES} from '../listener/src/searcher/generated/production-family-entries.generated.ts';

const sha=data=>createHash('sha256').update(data).digest('hex');
const json=x=>JSON.stringify(x)+'\n';
const addr=x=>typeof x==='string'&&/^0x[0-9a-f]{40}$/.test(x);
const word=x=>typeof x==='string'&&/^0x[0-9a-f]{64}$/.test(x);
const zero='0x'+'0'.repeat(40);
const key=r=>JSON.stringify([r.selector,r.poolAddress,r.poolId,r.tokenIn,r.tokenOut]);
const physical=r=>JSON.stringify([r.selector,r.poolAddress,r.poolId]);
const sourceRef=x=>({selector:x.selector,poolAddress:x.poolAddress,poolId:x.poolId,tokenIn:x.tokenIn,tokenOut:x.tokenOut});
const registry=()=>new Map(GENERATED_PRODUCTION_FAMILY_ENTRIES.map(e=>e.module.selectorFamilyModule)
  .filter(m=>m.activation.enabled&&['swap','protocol'].includes(m.definition.domain)).map(m=>[m.definition.selector,m.definition]));
function inspectProgram(p){
  const n=p.binding?.nomination??{}, s=p.binding?.stateBinding??{}, args=p.parameters??[];
  const namespace=[...new Set([n.poolNamespace,s.poolNamespace].filter(Boolean))];
  return {namespace,resourceId:!!(namespace.length||n.poolIdPath||n.poolIdLogs?.length||args.some(a=>a.role==='poolId')),
    assetId:!!(n.tokenInIdPath||n.tokenOutIdPath||args.some(a=>['tokenInId','tokenOutId'].includes(a.role)))};
}
function windowOf(w){
  assert(w?.chainId===1&&Number.isSafeInteger(w.fromBlock)&&w.fromBlock>=0&&Number.isSafeInteger(w.toBlock)&&w.toBlock>=w.fromBlock&&word(w.headHash),'invalid discovery window');
  return {fromBlock:w.fromBlock,toBlock:w.toBlock,cutoffHash:w.headHash};
}

/** Prior coordinates can preserve an existing public ID, never nominate a new row. */
function observedSharedEntry(r) {
  return word(r.poolId) && r.evidenceTypes.length > 0 && r.evidenceTypes.every(evidence =>
    poolIdLayouts.some(layout => layout.entry === r.selector && layout.emitter === r.example.selectorTarget && layout.evidence === evidence));
}

function projector(prior,defs,{legacyCoordinates=false}={}){
  const byKey=new Map(),nsByPhysical=new Map(),accepted=[],rejected=[];
  for(const p of prior){
    assert.equal(p.candidateInstanceKey,sqlDirectionId(p),'invalid prior public ID');
    const k=key(p),g=byKey.get(k)??[];g.push(p);byKey.set(k,g);
    if(p.poolId!==null){const k=physical(p),s=nsByPhysical.get(k)??new Set();s.add(p.poolNamespace);nsByPhysical.set(k,s);}
  }
  const aliases=[];
  let preserved=0,source=0;
  function add(r,rowIndex){
    source++;
    const d=defs.get(r.selector);
    assert(d,'SQL output does not match the current enabled swap/protocol selectors');
    assert(r.verified===false&&r.observedTargetSelector===true&&r.example&&word(r.example.txHash)&&addr(r.example.selectorTarget)&&
      typeof r.example.callPath==='string'&&Array.isArray(r.evidenceTypes)&&r.evidenceTypes.includes(r.example.evidence),'missing independent discovery evidence');
    const observedAddress=legacyCoordinates?r.poolAddress:r.example.observedPoolAddress;
    const shared=observedSharedEntry(r);
    const target=legacyCoordinates&&shared?r.example.selectorTarget:r.poolAddress;
    const canonical={...r,poolAddress:target};
    const priorRows=byKey.get(key(canonical))??[],shapes=(d.programs??[]).map(inspectProgram);
    const reject=reason=>rejected.push({rowIndex,...sourceRef(r),reason,priorIds:priorRows.map(p=>p.candidateInstanceKey),
      observations:r.observations,example:r.example}); // rowIndex also links to the untouched source row
    if(!addr(r.poolAddress)||r.poolAddress===zero||!addr(r.tokenIn)||!addr(r.tokenOut)||r.tokenIn===r.tokenOut||
      !(r.poolId===null||word(r.poolId)))return reject('invalid-or-unrepresented-pool-or-asset-coordinates');
    // Legacy shared-pool layouts bound every observation to a single emitter
    // before grouping. A representative witness alone cannot authorize a redirect.
    if(r.example.selectorTarget!==target || (!legacyCoordinates && r.callTarget!==target) ||
       (observedAddress!=null && observedAddress!==target && !shared))
      return reject('example-call-target-differs-from-physical-pool');
    if(priorRows.length>1)return reject('multiple-prior-public-ids-for-this-upstream-key');
    if(priorRows[0]?.tokenInId!=null||priorRows[0]?.tokenOutId!=null||shapes.some(s=>s.assetId)){
      return reject('upstream-movements-do-not-identify-asset-subtypes');
    }
    if(r.poolId===null&&(d.managerCustody?.manager?.toLowerCase()===r.poolAddress||shapes.length&&shapes.every(s=>s.resourceId))){
      return reject('required-logical-pool-id-absent');
    }
    const declarations=new Set(shapes.flatMap(s=>s.namespace));let poolNamespace=null;
    if(priorRows.length){poolNamespace=priorRows[0].poolNamespace;}
    else if(r.poolId!==null){
      // Do not create a second coordinate for an already-priced logical pool.
      const priorNs=nsByPhysical.get(physical(canonical));
      if(priorNs?.size===1)poolNamespace=[...priorNs][0];
      else if(!priorNs&&declarations.size===1)poolNamespace=[...declarations][0];
      else return reject('pool-namespace-not-uniquely-evidenced');
    }
    // Old identity may preserve an explicitly unqualified coordinate. It
    // cannot qualify new observations for an unsupported or ambiguous domain.
    if(poolNamespace!==null){
      if(declarations.size&&!declarations.has(poolNamespace))return reject('prior-and-declared-pool-namespace-disagree');
      if(declarations.size!==1)return reject('pool-namespace-not-uniquely-evidenced');
    }
    const coords={chainId:1,selector:r.selector,poolAddress:target,poolNamespace,poolId:r.poolId,tokenIn:r.tokenIn,tokenInId:null,tokenOut:r.tokenOut,tokenOutId:null};
    const candidateInstanceKey=sqlDirectionId(coords);
    if(priorRows.length){assert.equal(candidateInstanceKey,priorRows[0].candidateInstanceKey);preserved++;}
    if(shared && addr(observedAddress) && observedAddress!==target) {
      const old=byKey.get(key({...r,poolAddress:observedAddress}))??[];
      for(const p of old) {
        if(p.tokenInId==null && p.tokenOutId==null && (p.poolNamespace==null || p.poolNamespace===poolNamespace))
          aliases.push({previous:p.candidateInstanceKey,current:candidateInstanceKey});
      }
    }
    accepted.push({candidateInstanceKey,...coords});
  }
  return {add,finish(){assert.equal(accepted.length+rejected.length,source);return {accepted,rejected,preserved,aliases};}};
}
export function projectIndependentRows(rows,prior,defs=registry()){
  const p=projector(prior,defs),seen=new Set();
  for(const [i,r] of rows.entries()){const k=key(r);assert(!seen.has(k),'duplicate upstream discovery key');seen.add(k);p.add(r,i);}
  return p.finish();
}

async function pinned(path,expected){
  assert(typeof expected==='string'&&/^[a-f0-9]{64}$/.test(expected),'explicit artifact SHA-256 required');
  const b=await readFile(path);assert.equal(sha(b),expected,'artifact digest mismatch: '+path);return b;
}
const save=(dir,name,b)=>writeFile(join(dir,name),b,{flag:'wx',mode:0o600});
async function fileSha(path){
  const h=createHash('sha256');for await(const chunk of createReadStream(path))h.update(chunk);return h.digest('hex');
}
async function* jsonArray(stream){
  // Upstream pretty-prints its array. Never concatenate its potentially >512 MiB contents.
  let state='start',depth=0,quoted=false,escape=false,buf='';
  for await(const chunk of stream.setEncoding('utf8')){
    let start=depth?0:-1;
    for(let i=0;i<chunk.length;i++){
      const c=chunk[i];
      if(!depth){
        if(/\s/.test(c))continue;
        if(state==='start'&&c==='['){state='first';continue;}
        if((state==='first'||state==='comma')&&c===']'){state='end';continue;}
        if(state==='comma'&&c===','){state='next';continue;}
        assert((state==='first'||state==='next')&&c==='{','malformed upstream JSON array');
        start=i;depth=1;quoted=escape=false;continue;
      }
      if(quoted){if(escape)escape=false;else if(c==='\\')escape=true;else if(c==='"')quoted=false;continue;}
      if(c==='"')quoted=true;
      else if(c==='{'||c==='[')depth++;
      else if(c==='}'||c===']'){
        if(--depth===0){assert.equal(c,'}');buf+=chunk.slice(start,i+1);yield JSON.parse(buf);buf='';start=-1;state='comma';}
      }
    }
    if(start>=0)buf+=chunk.slice(start);
    assert(buf.length<=16*1024*1024,'unbounded upstream JSON record');
  }
  assert(state==='end'&&depth===0,'incomplete upstream JSON array');
}
async function* jsonLinesGzip(raw){
  const stream=raw.compose(createGunzip());
  const lines=createInterface({input:stream,crlfDelay:Infinity});
  try{for await(const line of lines){assert(line.length&&line.length<=16*1024*1024,'empty/oversize archive record');yield JSON.parse(line);}}
  finally{lines.close();stream.destroy();}
}
export async function exportIndependentLive({upstream,upstreamSha256,previous,previousSha256,funding,fundingSha256,out,swapsOnly=false,noPrior=false}){
  // No fallback, no environment-selected alternate generator and no network.
  const {renderIndependentTraceEdges}=await import('./independent-trace-edges.mjs');
  const mb=await pinned(upstream,upstreamSha256),m=JSON.parse(mb),window=windowOf(m.window);
  let sql=await renderIndependentTraceEdges(m.window,{liveSelectorsOnly:true});
  const declaredSql=m.filtered?.sqlSha256??m.sqlSha256;
  const legacyCoordinates=sha(sql)!==declaredSql;
  if(legacyCoordinates)sql=await renderIndependentTraceEdges(m.window,{liveSelectorsOnly:true,legacyCoordinates});
  const archive=m.format==='independent-discovery-archive/v1';
  if(archive){
    assert(['all','filtered'].includes(m.mode)&&typeof m.edgeFile==='string'&&m.edgeFile.length,'invalid archive format');
    assert.equal(sha(sql),m.filtered.sqlSha256,'archived filter differs from production SQL/activation');
    assert.equal(sha(await renderIndependentTraceEdges(m.window,{legacyCoordinates})),m.fullSqlSha256,'archived full discovery SQL differs');
  }else{
    assert.equal(m.liveSelectorsOnly,true,'an actual filtered discovery receipt is required');
    assert.equal(sha(sql),m.sqlSha256,'discovery SQL/registry/activation mismatch');
  }
  const raw=archive?resolve(dirname(upstream),m.edgeFile):join(dirname(upstream),'edges.json');
  assert(typeof m.edgesSha256==='string'&&/^[0-9a-f]{64}$/.test(m.edgesSha256),'missing edge artifact digest');
  assert(noPrior?(!previous&&!previousSha256):(previous&&previousSha256),'pin previous published coordinates or explicitly select no-prior');
  let prior=[];
  if(!noPrior){
    const pm=JSON.parse(await pinned(previous,previousSha256));
    const loaded=await loadSqlPriceEdges(previous);prior=loaded.edges;
    assert.deepEqual(loaded.manifest,{edgeSha256:pm.edgeSha256,cutoffHash:pm.cutoffHash,fromBlock:pm.fromBlock,toBlock:pm.toBlock,rows:pm.rows});
    assert(pm.toBlock<=window.toBlock,'future published coordinates');
    if(pm.toBlock===window.toBlock)assert.equal(pm.cutoffHash,window.cutoffHash,'previous coordinates are from a different fork');
  }
  assert(swapsOnly?(!funding&&!fundingSha256):(funding&&fundingSha256),'supply original funding or explicitly select swaps-only');
  const fb=swapsOnly?null:await pinned(funding,fundingSha256);
  const doc=fb&&JSON.parse(fb);
  if(doc)assertPinnedFundingWindow(m.window,doc);
  const funds=doc&&readSqlFundingRows(doc,window);
  const defs=registry(),project=projector(prior,defs,{legacyCoordinates});
  const ah=createHash('sha256'),fh=createHash('sha256');let last='',rawRows=0,source=0,obs=0;
  const rawHash=createHash('sha256'),bytes=createReadStream(raw).compose(new Transform({
    transform(chunk,_encoding,next){rawHash.update(chunk);next(null,chunk);}
  }));
  try{for await(const r of archive?jsonLinesGzip(bytes):jsonArray(bytes)){
    assert(/^0x[a-f0-9]{8}$/.test(r.selector)&&addr(r.poolAddress)&&(r.poolId===null||word(r.poolId))&&addr(r.tokenIn)&&addr(r.tokenOut),'noncanonical upstream coordinates');
    const tsv=[r.selector,r.poolAddress,r.poolId??'',r.tokenIn,r.tokenOut].join('\t')+'\n';
    assert(tsv>last,'duplicate/unsorted upstream discovery keys');last=tsv;ah.update(tsv);rawRows++;
    if(archive&&m.mode==='all'&&!defs.has(r.selector))continue;
    fh.update(tsv);source++;
    const count=Number(r.observations);assert(Number.isSafeInteger(count)&&count>0);obs+=count;
    project.add(r,rawRows-1);
  }}finally{bytes.destroy();}
  assert.equal(rawHash.digest('hex'),m.edgesSha256,'edge artifact bytes differ');
  const keySha256=ah.digest('hex'),filteredKeySha256=fh.digest('hex');
  assert.equal(rawRows,m.total,'incomplete upstream result');
  if(archive){
    assert.equal(keySha256,m.keySha256,'archive canonical source keys differ');assert.equal(filteredKeySha256,m.filtered.keySha256,'archive filtered keys differ');
    assert.equal(source,m.filtered.rows,'archive selector count differs');
  }else{assert.equal(obs,m.observations);}
  const {accepted,rejected,preserved,aliases}=project.finish();
  assert.equal(new Set(accepted.map(r=>r.candidateInstanceKey)).size,accepted.length,'duplicate normalized direction');
  assert.equal(new Set(aliases.map(r=>r.previous)).size,aliases.length,'ambiguous previous direction alias');
  await mkdir(out,{mode:0o700}); // new directory only; no existing artifact or run is ever overwritten
  await save(out,'upstream-manifest.json',mb);
  const sourceName=archive?'upstream-edges.jsonl.gz':'upstream-edges.json';
  await copyFile(raw,join(out,sourceName),constants.COPYFILE_EXCL);
  assert.equal(await fileSha(join(out,sourceName)),m.edgesSha256,'upstream input changed during packaging');
  await save(out,'direction-id-aliases.jsonl.gz',gzipSync(aliases.map(json).join('')));
  await save(out,'rejected.jsonl.gz',gzipSync(rejected.map(json).join('')));
  const result={format:'independent-live-projection/v1',upstreamSha256,sourceName,sourceEdgesSha256:m.edgesSha256,sqlSha256:sha(sql),previousSha256,
    fundingSha256,...window,rawRows,keySha256,filteredKeySha256,source,previousDirectionAliases:aliases.length,accepted:accepted.length,rejected:rejected.length,preserved,fundingOffers:funds?.length??null,
    rejectionCounts:Object.fromEntries([...new Set(rejected.map(r=>r.reason))].map(k=>[k,rejected.filter(r=>r.reason===k).length]))};
  if(accepted.length){
    const edgeFile='candidate-instances.ndjson.gz',content=gzipSync(accepted.map(json).join(''));
    await save(out,edgeFile,content);
    const manifest=join(out,'fixed-edge-manifest.json');
    await save(out,'fixed-edge-manifest.json',json({format:'ready-fixed-edges/v1',edgeFile,edgeSha256:sha(content),rows:accepted.length,...window}));
    if(fb){await save(out,'funding.json',fb);
    const sealed=await sealSqlLiveInput({manifest,funding:join(out,'funding.json'),out:join(out,'sql-live-input.json')});
    const loaded=await loadLiveSqlTables(sealed.path,sealed.sha256);
    assert.equal(loaded.edges.length,accepted.length);assert.equal(loaded.fundingAssets.length,funds.length);
    result.inputSha256=sealed.sha256;
    }else assert.equal((await loadSqlPriceEdges(manifest)).edges.length,accepted.length);
  }
  await save(out,'projection.json',json(result));return result;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  try{
    const names=['upstream','upstream-sha256','previous','previous-sha256','funding','funding-sha256','out'];
    const {values:v}=parseArgs({options:Object.fromEntries([...names.map(k=>[k,{type:'string'}]),['help',{type:'boolean'}],['swaps-only',{type:'boolean'}],['no-prior',{type:'boolean'}]])});
    if(v.help)console.log('Offline only. Run original independent-trace-edges.mjs --live-selectors-only first. Then: '+names.map(k=>'--'+k+' <value>').join(' ')+' (or --swaps-only without funding; --no-prior for a new identity lineage)');
    else{for(const k of names.filter(k=>(!v['swaps-only']||!k.startsWith('funding'))&&(!v['no-prior']||!k.startsWith('previous'))))assert(v[k],'missing --'+k);
      console.log(JSON.stringify(await exportIndependentLive({upstream:v.upstream,upstreamSha256:v['upstream-sha256'],previous:v.previous,
        previousSha256:v['previous-sha256'],funding:v.funding,fundingSha256:v['funding-sha256'],out:v.out,swapsOnly:v['swaps-only'],noPrior:v['no-prior']}))); }
  }catch(e){console.error(e.message);process.exitCode=1;}
}
