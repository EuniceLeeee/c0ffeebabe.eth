// Offline inventory comparison, not admission, proof of a trade, or proof of absence.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createWriteStream,existsSync,mkdirSync,readFileSync,readdirSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {Readable,Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';
import {createGzip} from 'node:zlib';
import {candidateCoordinateFields} from './selector-candidate-instances-sql.mjs';
import {edgeCoordinates,coordinateKey} from './selector-edge-difference.mjs';

const sha=x=>createHash('sha256').update(x).digest('hex');
const hex64=/^[0-9a-f]{64}$/;
const address=x=>typeof x==='string'&&x.length===42&&/^0x[0-9a-f]{40}$/i.test(x);
const text=x=>typeof x==='string'&&x.length>0;
const axes=['poolNamespace','tokenInId','tokenOutId'];
const kinds=['intersection','ref-only','sql-only','ref-incomparable','sql-incomparable'];
const distinct=xs=>[...new Set(xs)].sort();
const inc=(m,k)=>{m[k]=(m[k]??0)+1;};
const record=x=>x&&typeof x==='object'&&!Array.isArray(x);

function poolKind(c){
  if(c.poolNamespace===null&&c.poolId===null)return 'address-pool';
  if(c.poolNamespace===null&&address(c.poolId)&&c.poolId.toLowerCase()===c.poolAddress)return 'legacy-address-pool-id';
  return 'logical-pool';
}

function invalidCoordinates(c,chainId){
  const reasons=[];
  if(c.chainId!==chainId)reasons.push('chain-not-comparable');
  for(const k of ['poolAddress','tokenIn','tokenOut'])if(!address(c[k]))reasons.push('invalid-or-missing-'+k);
  for(const k of ['poolId',...axes])if(c[k]!==null&&!text(c[k]))reasons.push('invalid-'+k);
  if(c.poolNamespace!==null&&c.poolId===null)reasons.push('pool-namespace-without-pool-id');
  return reasons;
}

function validateCandidate(x){
  assert(record(x),'invalid SQL instance');
  for(const k of candidateCoordinateFields)assert(Object.hasOwn(x,k),'missing SQL candidate coordinate '+k);
  assert(typeof x.selector==='string'&&x.selector.length===10&&/^0x[0-9a-f]{8}$/.test(x.selector),'invalid SQL selector');
  assert.equal(x.verified,false,'SQL candidate cannot provide Ready admission');
  const {familyIds:f,observedFamilyIds:o}=x;
  assert(Array.isArray(f)&&f.length>0&&Array.isArray(o),'missing SQL family evidence');
  const prefix='execution:'+x.selector+':abi-';
  assert(f.every(id=>typeof id==='string'&&id.startsWith(prefix)&&id.length===prefix.length+64&&hex64.test(id.slice(prefix.length))),'invalid SQL family binding');
  assert.equal(new Set(f).size,f.length,'duplicate SQL family');
  assert.equal(new Set(o).size,o.length,'duplicate observed Family');
  assert(o.every(id=>f.includes(id)),'observed noncandidate Family');
  assert.equal(x.observedTargetSelector,o.length>0,'SQL selector observation disagrees');
  const tuple=candidateCoordinateFields.map(k=>k==='chainId'?String(x[k]):x[k]??null);
  assert.equal(x.candidateInstanceKey,'candidate-edge:v1:'+sha(JSON.stringify(tuple)),'SQL instance key differs from coordinates');
}

// The coarse tuples can explain an unmatched result, never make it equal.
const axisKey=c=>JSON.stringify([c.chainId,c.poolAddress,c.poolId,c.tokenIn,c.tokenOut]);
const aliasKey=c=>JSON.stringify([c.chainId,c.poolAddress,c.tokenIn,c.tokenInId,c.tokenOut,c.tokenOutId]);
const logicalBaseKey=c=>JSON.stringify([c.chainId,c.poolAddress,c.tokenIn,c.tokenOut]);
const compatibleAxes=(a,b)=>axes.every(k=>a[k]===null||b[k]===null||a[k]===b[k]);
function index(groups,key,filter=()=>true){
  const map=new Map();
  for(const g of groups.values())if(!g.reasons.length&&filter(g.c)){
    const k=key(g.c),rows=map.get(k)??[];rows.push(g);map.set(k,rows);
  }
  return map;
}

export function compareSelectorWindow({instances,reference,chainId}){
  assert(Number.isSafeInteger(chainId)&&chainId>0,'explicit positive chain ID required');
  assert(Array.isArray(instances),'SQL instances must be an array');
  assert(record(reference)&&Array.isArray(reference.edges),'reference.edges must be an array');
  if(reference.chainId!==undefined)assert.equal(reference.chainId,chainId,'reference chain pin mismatch');
  const ref=new Map(),sql=new Map(),seen=new Set();
  const add=(map,rowIndex,row,c)=>{
    const k=coordinateKey(c),g=map.get(k)??{k,c,reasons:invalidCoordinates(c,chainId),rows:[]};
    g.rows.push({rowIndex,record:row});map.set(k,g);
  };
  reference.edges.forEach((row,i)=>{
    assert(record(row),'invalid reference edge row');
    add(ref,i,row,edgeCoordinates({...row,chainId:Object.hasOwn(row,'chainId')?row.chainId:chainId,poolAddress:row.target}));
  });
  instances.forEach((row,i)=>{
    validateCandidate(row);assert(!seen.has(row.candidateInstanceKey),'duplicate SQL candidate instance');seen.add(row.candidateInstanceKey);
    add(sql,i,row,edgeCoordinates(row));
  });
  const refAxes=Object.fromEntries(axes.map(k=>[k,reference.edges.some(x=>Object.hasOwn(x,k))]));
  const groups=Object.fromEntries(kinds.map(k=>[k,[]])),reasonCounts={ref:Object.create(null),sql:Object.create(null)};
  const seenExact=new Set(),refOnlyAdapters=Object.create(null),sqlOnlySelectors=Object.create(null);
  function emit(kind,g,r,s,reasons=[]){
    const refPart=r?{rows:r.rows,adapterIds:distinct(r.rows.map(({record})=>record.adapterId).filter(text))}:null;
    const sqlPart=s?{rows:s.rows,selectors:distinct(s.rows.map(({record})=>record.selector)),
      familyIds:distinct(s.rows.flatMap(({record})=>record.familyIds)),observedFamilyIds:distinct(s.rows.flatMap(({record})=>record.observedFamilyIds))}:null;
    if(kind==='ref-only')for(const adapter of refPart.adapterIds)inc(refOnlyAdapters,adapter);
    if(kind==='sql-only')for(const selector of sqlPart.selectors)inc(sqlOnlySelectors,selector);
    if(reasons.length)for(const reason of reasons)inc(reasonCounts[kind.startsWith('ref')?'ref':'sql'],reason);
    groups[kind].push({kind,physicalKey:'edge-coordinate:v1:'+sha(g.k),...g.c,poolKind:poolKind(g.c),ref:refPart,sql:sqlPart,
      ...(reasons.length?{reasons}:{}),historicalActivity:'unassessed',absenceProven:false});
  }
  for(const [k,r] of ref){
    const s=sql.get(k);
    if(!r.reasons.length&&s&&!s.reasons.length){seenExact.add(k);emit('intersection',r,r,s);}
  }
  const refByAxis=index(ref,axisKey),sqlByAxis=index(sql,axisKey);
  const addressKind=c=>poolKind(c)!=='logical-pool';
  const refAliases=index(ref,aliasKey,addressKind),sqlAliases=index(sql,aliasKey,addressKind);
  const logicalCompatibilityIndex=input=>({
    absent:index(input,logicalBaseKey,c=>c.poolId===null),logical:index(input,logicalBaseKey,c=>poolKind(c)==='logical-pool'),
  });
  function visit(side,input,otherByAxis,otherAliases,otherLogical){
    for(const [k,g] of input){
      if(seenExact.has(k))continue;
      const c=g.c,reasons=[...g.reasons];
      if(!reasons.length){
        if(side==='sql')for(const field of axes)if(c[field]!==null&&!refAxes[field])reasons.push('reference-schema-has-no-'+field);
        const tuples=otherByAxis.get(axisKey(c))??[];
        for(const t of tuples){
          if(!compatibleAxes(c,t.c))continue;
          for(const field of axes)if((c[field]===null)!==(t.c[field]===null))reasons.push('one-side-missing-'+field);
        }
        if(addressKind(c)&&(otherAliases.get(aliasKey(c))??[]).some(t=>poolKind(c)!==poolKind(t.c)))
          reasons.push('legacy-address-pool-alias-unproven');
        const missingId=c.poolId===null?otherLogical.logical:poolKind(c)==='logical-pool'?otherLogical.absent:null;
        if((missingId?.get(logicalBaseKey(c))??[]).some(t=>compatibleAxes(c,t.c)))reasons.push('one-side-missing-poolId');
      }
      emit(side+(reasons.length?'-incomparable':'-only'),g,side==='ref'?g:null,side==='sql'?g:null,distinct(reasons));
    }
  }
  visit('ref',ref,sqlByAxis,sqlAliases,logicalCompatibilityIndex(sql));
  visit('sql',sql,refByAxis,refAliases,logicalCompatibilityIndex(ref));
  for(const rows of Object.values(groups))rows.sort((a,b)=>a.physicalKey<b.physicalKey?-1:a.physicalKey>b.physicalKey?1:0);
  const counts=Object.fromEntries(kinds.map(k=>[k,groups[k].length]));
  const rows=Object.fromEntries(['ref','sql'].map(side=>[side,Object.fromEntries(kinds.map(k=>[k,groups[k].reduce((n,g)=>n+(g[side]?.rows.length??0),0)]))]));
  for(const [side,source,map] of [['ref',reference.edges,ref],['sql',instances,sql]]){
    assert.equal(Object.values(rows[side]).reduce((a,b)=>a+b,0),source.length,'source rows not conserved');
    assert.equal(counts.intersection+counts[side+'-only']+counts[side+'-incomparable'],map.size,'source coordinates not conserved');
  }
  const summary={format:'selector-window-compare/v1',chainId,counts,rows,reasons:reasonCounts,
    reference:{inputRows:reference.edges.length,uniqueCoordinates:ref.size,axesPresent:refAxes},sql:{inputRows:instances.length,uniqueCoordinates:sql.size},
    refOnlyAdapters,sqlOnlySelectors,nativeEthWethAliased:false,legacyAddressPoolAliased:false,
    note:'Directed exact coordinate comparison only. Legacy address-pool aliases without evidence remain incomparable. No absence, Ready admission, prices or selector equivalence inferred.'};
  return {summary,groups};
}

function readJson(path,expected){
  const bytes=readFileSync(path),sha256=sha(bytes);
  if(expected!==undefined){assert(hex64.test(expected),'invalid file hash pin');assert.equal(sha256,expected,'file hash pin mismatch: '+path);}
  return {value:JSON.parse(bytes),artifact:{path:resolve(path),bytes:bytes.length,sha256}};
}
async function writeRows(out,k,rows){
  const file=k+'.ndjson.gz',hash=createHash('sha256');
  function* serialize(){for(const r of rows)yield JSON.stringify(r)+'\n';}
  const digest=new Transform({transform(data,_,done){hash.update(data);done(null,data);}});
  await pipeline(Readable.from(serialize()),createGzip(),digest,createWriteStream(join(out,file),{flags:'wx',mode:0o600}));
  return {file,rows:rows.length,sha256:hash.digest('hex')};
}

export async function writeSelectorWindowComparison({instances,reference,out,chainId,instancesSha256,referenceSha256,pins}){
  assert(text(out),'output directory required');out=resolve(out);
  assert(!existsSync(out)||readdirSync(out).length===0,'output directory must be new or empty');
  const s=readJson(instances,instancesSha256),r=readJson(reference,referenceSha256),p=pins===undefined?null:readJson(pins);
  const {summary,groups}=compareSelectorWindow({instances:s.value,reference:r.value,chainId});
  mkdirSync(out,{recursive:true,mode:0o700});
  summary.inputs={sql:s.artifact,reference:r.artifact,...(p?{pins:p.artifact}:{})};
  if(p)summary.pins=p.value;
  summary.files=Object.fromEntries(await Promise.all(kinds.map(async k=>[k,await writeRows(out,k,groups[k])])));
  writeFileSync(join(out,'summary.json'),JSON.stringify(summary,null,2)+'\n',{mode:0o600,flag:'wx'});
  return summary;
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const options=Object.fromEntries(['instances','reference','out','chain-id','instances-sha256','reference-sha256','pins'].map(k=>[k,{type:'string'}]));
  const {values:a}=parseArgs({options});
  assert(a.instances&&a.reference&&a.out&&a['chain-id'],'usage: --instances <sql-instances.json> --reference <graph.json> --chain-id 1 --out <new-directory> [--pins pins.json]');
  const s=await writeSelectorWindowComparison({instances:a.instances,reference:a.reference,out:a.out,chainId:Number(a['chain-id']),
    instancesSha256:a['instances-sha256'],referenceSha256:a['reference-sha256'],pins:a.pins});
  console.log(JSON.stringify({out:resolve(a.out),counts:s.counts,files:s.files}));
}
