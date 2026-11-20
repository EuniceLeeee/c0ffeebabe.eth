import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {EventFragment} from '../listener/node_modules/ethers/lib.esm/index.js';
import {scanDiscoveryPackages} from './ready-discovery-udf-build.mjs';
import {normalizeSelectorNativeExecutionDefinition,selectorNativeFamilyId} from '../listener/src/searcher/venues/selector-native-definition.ts';

// An observation candidate only, not an execution selector witness or Ready proof.
// Use authored value expressions, not event names or a protocol dispatch table.
function specFor(e,p) {
  const abi=e.signature===undefined?null:EventFragment.from(e.signature);
  if(abi&&e.topic)assert.equal(abi.topicHash,e.topic.toLowerCase());
  const topic0=abi?.topicHash??e.topic?.toLowerCase()??null;
  assert(topic0?/^0x[0-9a-f]{64}$/.test(topic0):e.packed);
  const fields=abi?.inputs.map((f,i)=>[f.name||String(i),f.type,f.indexed===true])??null;
  const exprs={valid:e.valid??true,pool:e.pool??null,id:e.payload?.poolId??null,manager:e.payload?.manager??null,
    tokenIn:e.payload?.tokenIn??null,tokenOut:e.payload?.tokenOut??null,amountIn:e.payload?.amountIn??null,amountOut:e.payload?.amountOut??null};
  const constants={};
  for(const m of JSON.stringify(exprs).matchAll(/"\$constants\.([A-Za-z0-9_]+)"/g)){
    if(Object.hasOwn(p.values?.constants??{},m[1]))constants[m[1]]=p.values.constants[m[1]];
  }
  return {topic0,variant:{fields,packed:e.packed??null,kind:e.classification,mode:e.receiptMode??null,constants,exprs}};
}

export function loadCatalogEventRules(root=process.cwd(),{familyIds}={}) {
  const dir=resolve(root,'listener'),inventory=scanDiscoveryPackages(join(dir,'src/searcher/generated/family-capability-shadow.generated.json'),dir);
  const groups=new Map(),ordinary=[];
  for(const r of inventory.roots){
    if(familyIds&&!familyIds.includes(r.familyId))continue;
    const paths=r.additionalSourceFiles.filter(f=>f.endsWith('.json'));assert.equal(paths.length,1,'Unexpected definition root');
    const doc=JSON.parse(readFileSync(paths[0]));
    if(doc.domain==='funding'||doc.domain==='credit')continue;
    const def=normalizeSelectorNativeExecutionDefinition(doc),familyId=selectorNativeFamilyId(def);assert.equal(familyId,r.familyId);
    ordinary.push(familyId);
    for(const p of def.programs)for(const e of p.observations?.events??[]){
      const {topic0,variant}=specFor(e,p),anonymousAddress=e.packed?.address?.toLowerCase()??null,anonymousBytes=e.packed?.dataLengthBytes??null;
      const k=JSON.stringify([familyId,topic0,anonymousAddress,anonymousBytes]);
      if(!groups.has(k))groups.set(k,{familyId,familySelector:def.selector,topic0,anonymousAddress,anonymousBytes,variants:[]});
      const g=groups.get(k);if(!g.variants.some(v=>JSON.stringify(v)===JSON.stringify(variant)))g.variants.push(variant);
    }
  }
  if(familyIds)assert.deepEqual([...ordinary].sort(),[...familyIds].sort(),'Unknown or nonordinary family');
  return {ordinaryFamilies:ordinary,topics:[...new Set([...groups.values()].map(g=>g.topic0).filter(Boolean))].sort(),rules:[...groups.values()]};
}

// The same bounded pure implementation runs locally and in the BigQuery JS UDF.
// Words are exact hex strings: no uint256 amounts are converted to doubles.
export function projectDeclaredEvent(variants,topics,data,emitter) {
  const zero='0x'+'0'.repeat(40),unknown=()=>{throw Error('unavailable')};
  const address=s=>typeof s==='string'&&/^0x[0-9a-f]{40}$/.test(s);
  const id=s=>typeof s==='string'&&/^0x[0-9a-f]{64}$/.test(s);
  const num=(mag,negative=false)=>({mag:mag.replace(/^0+/,'')||'0',negative});
  function integer(x) {
    if(x&&typeof x.mag==='string')return x;
    if(typeof x==='number'){if(!Number.isSafeInteger(x))unknown();x=String(x);}
    if(typeof x!=='string')unknown();
    if(/^0x[0-9a-f]+$/i.test(x))return num(x.slice(2).toLowerCase());
    if(!/^-?[0-9]{1,78}$/.test(x))unknown();
    const digits=[0];for(const d of x.replace(/^-/,'').split('')){let carry=Number(d);
      for(let i=0;i<digits.length;i++){const v=digits[i]*10+carry;digits[i]=v%16;carry=Math.floor(v/16);}if(carry)digits.push(carry);}
    return num(digits.reverse().map(v=>v.toString(16)).join(''),x[0]==='-');
  }
  const cmp=(a,b)=>{a=integer(a);b=integer(b);if(a.negative!==b.negative)return a.negative?-1:1;
    return (a.negative?-1:1)*(a.mag.length!==b.mag.length?Math.sign(a.mag.length-b.mag.length):a.mag<b.mag?-1:a.mag>b.mag?1:0);};
  const signed=(w)=>{if(parseInt(w[0],16)<8)return num(w);let s='',carry=1;for(let i=w.length-1;i>=0;i--){const v=15-parseInt(w[i],16)+carry;s=(v%16).toString(16)+s;carry=v>>4;}return num(s,true);};
  function word(type,w){
    if(!/^[0-9a-f]{64}$/.test(w))throw Error('malformed');
    if(type==='address'){if(!/^0{24}/.test(w))throw Error('malformed');return '0x'+w.slice(24);}
    if(type==='bool'){if(!/^0{63}[01]$/.test(w))throw Error('malformed');return w.endsWith('1');}
    const b=/^bytes([0-9]+)$/.exec(type);if(b){const n=2*Number(b[1]);if(n>64||!/^0*$/.test(w.slice(n)))throw Error('malformed');return '0x'+w.slice(0,n);}
    const m=/^(u?int)([0-9]+)$/.exec(type);if(m){const n=Number(m[2])/4;
      const hi=w.slice(0,64-n),lo=w.slice(-n),neg=m[1]==='int'&&parseInt(lo[0],16)>=8;
      if(hi!==(neg?'f':'0').repeat(64-n))throw Error('malformed');return m[1]==='int'?signed(w):num(w);}
    unknown();
  }
  function decode(v){
    if(!v.fields&&!v.packed)unknown();
    if(!/^0x(?:[0-9a-f]{2})*$/.test(data))throw Error('malformed');
    const args={};
    if(v.packed){
      const p=v.packed;if(emitter!==p.address.toLowerCase()||topics.length||data.length!==2+p.dataLengthBytes*2)throw Error('malformed');
      for(const f of p.fields){const s=data.slice(2+2*f.offsetBytes,2+2*(f.offsetBytes+f.lengthBytes));
        args[f.name]=f.encoding==='uint'?num(s):f.encoding==='int'?signed(s):'0x'+s;}
      return args;
    }
    if(v.fields.some(([,t])=>! /^(address|bool|bytes[0-9]+|u?int[0-9]+)$/.test(t)))unknown();
    const ni=v.fields.filter(f=>f[2]).length;
    if(topics.length!==1+ni||data.length!==2+64*(v.fields.length-ni))throw Error('malformed');
    let i=1,j=2;for(const [name,type,indexed] of v.fields){
      const w=indexed?topics[i++].slice(2):data.slice(j,j+=64);args[name]=word(type,w);}
    return args;
  }
  function val(x,args,constants){
    if(x==null)unknown();
    if(typeof x==='string'){
      if(x==='$log.address')return emitter;
      if(x.startsWith('$args.')){const k=x.slice(6);if(!Object.prototype.hasOwnProperty.call(args,k))unknown();return args[k];}
      if(x.startsWith('$constants.')){const k=x.slice(11);if(!Object.prototype.hasOwnProperty.call(constants,k))unknown();const s=constants[k];return typeof s==='string'&&/^0x/i.test(s)?s.toLowerCase():s;}
      if(x[0]==='$')unknown();return x;
    }
    if(typeof x!=='object')return x;
    if(!Array.isArray(x.args))unknown();
    if(x.op==='get'&&['$args','$log','$constants'].includes(x.args[0])&&typeof x.args[1]==='string')return val(x.args[0]+'.'+x.args[1],args,constants);
    const a=x.args.map(t=>val(t,args,constants));
    if(x.op==='address'){if(!address(a[0]))unknown();return a[0];}
    if(x.op==='lower'){if(typeof a[0]!=='string')unknown();return a[0].toLowerCase();}
    if(x.op==='bytes'&&typeof a[0]==='string'&&/^0x[0-9a-f]*$/.test(a[0])&&Number.isInteger(a[1])&&Number.isInteger(a[2])&&a[1]>=0&&a[2]>=0&&a[1]+a[2]<=(a[0].length-2)/2)return '0x'+a[0].slice(2+2*a[1],2+2*(a[1]+a[2]));
    if(x.op==='uint'){const n=integer(a[0]);if(n.negative)unknown();return n;}
    if(x.op==='and'||x.op==='or'){if(!a.every(t=>typeof t==='boolean'))unknown();return x.op==='and'?a.every(Boolean):a.some(Boolean);}
    if(x.op==='not'){if(typeof a[0]!=='boolean')unknown();return !a[0];}
    if(x.op==='sameAddress'){if(!address(a[0])||!address(a[1]))unknown();return a[0]===a[1];}
    if(x.op==='eq'||x.op==='ne'){const equal=(typeof a[0]==='object'||typeof a[1]==='object')?cmp(a[0],a[1])===0:a[0]===a[1];return x.op==='eq'?equal:!equal;}
    if(['gt','gte','lt','lte'].includes(x.op)){const n=cmp(a[0],a[1]);return ({gt:n>0,gte:n>=0,lt:n<0,lte:n<=0})[x.op];}
    unknown();
  }
  const empty=(status,reason)=>({status,reason,poolAddress:null,poolId:null,tokenIn:null,tokenOut:null});
  const outputs=variants.map(v=>{
    if(v.kind!=='swap'||v.mode==='mutation-only')return empty('non-action','declared-mutation');
    if(v.mode==='unresolved')return empty('pending','opaque-event');
    let args;try{args=decode(v);}catch(e){return empty(e.message==='malformed'?'non-action':'pending',e.message==='malformed'?'invalid-abi-layout':'unsupported-abi-layout');}
    const expr=v.exprs,get=k=>val(expr[k],args,v.constants),opt=k=>{try{return get(k);}catch{return null;}};
    const p=opt('pool'),pid=opt('id'),m=opt('manager');
    const poolAddress=address(p)?p:address(m)?m:null,poolId=id(pid)?pid:id(p)?p:null;
    const rejected=reason=>empty('non-action',reason);
    const pending=(reason)=>({...empty('pending',reason),poolAddress,poolId});
    let valid;try{valid=get('valid');}catch{return pending('predicate-needs-context');}
    if(valid!==true)return rejected('declared-predicate-failed');
    const tokenIn=opt('tokenIn'),tokenOut=opt('tokenOut');
    if(!poolAddress||!address(tokenIn)||!address(tokenOut))return pending('pool-assets-need-context');
    if(tokenIn===tokenOut||poolAddress===zero)return rejected('degenerate-edge');
    try{if(cmp(get('amountIn'),0)<=0||cmp(get('amountOut'),0)<=0)return rejected('nonpositive-amount');}
    catch{return pending('amounts-need-context');}
    return {status:'candidate',reason:'declared-event-fields',poolAddress,poolId,tokenIn,tokenOut};
  });
  const unique=[...new Set(outputs.filter(o=>o.status!=='non-action').map(o=>JSON.stringify(o)))];
  if(unique.length===1)return JSON.parse(unique[0]);
  if(unique.length>1)return empty('pending','program-interpretations-differ');
  return outputs[0]??empty('pending','no-declaration');
}

export function renderCatalogEventQuery({window:w,catalog}) {
  assert(Number.isSafeInteger(w.fromBlock)&&Number.isSafeInteger(w.toBlock)&&w.fromBlock>0&&w.toBlock>=w.fromBlock);
  assert([w.firstTime,w.lastTime].every(t=>/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/.test(t))&&w.firstTime<=w.lastTime);
  const q=s=>JSON.stringify(s),arr=catalog.rules.map(r=>{
    assert(/^execution:0x[0-9a-f]{8}:abi-[0-9a-f]{64}$/.test(r.familyId)&&r.familyId.split(':')[1]===r.familySelector);
    const disc=r.topic0??('anonymous:'+r.anonymousAddress+':'+r.anonymousBytes);
    return '('+[r.familyId,r.familySelector,disc,JSON.stringify(r.variants)].map(q).join(',')+')';
  });
  const anon=catalog.rules.filter(r=>!r.topic0);assert(arr.length>0);
  const key=`CASE WHEN ARRAY_LENGTH(l.topics)>0 THEN LOWER(l.topics[SAFE_OFFSET(0)]) ${[...new Set(anon.map(r=>{assert(/^0x[0-9a-f]{40}$/.test(r.anonymousAddress)&&Number.isSafeInteger(r.anonymousBytes));return "WHEN LOWER(l.address)='"+r.anonymousAddress+"' AND LENGTH(l.data)="+(2+2*r.anonymousBytes)+" THEN 'anonymous:"+r.anonymousAddress+":"+r.anonymousBytes+"'";}))].join('\n')} END`;
  return `CREATE TEMP FUNCTION project_catalog_event(v STRING,topics ARRAY<STRING>,d STRING,emitter STRING)
RETURNS STRUCT<status STRING,reason STRING,poolAddress STRING,poolId STRING,tokenIn STRING,tokenOut STRING> LANGUAGE js AS r'''
return (${projectDeclaredEvent.toString()})(JSON.parse(v),topics.map(x=>x.toLowerCase()),d,emitter);
''';
WITH catalog AS (SELECT * FROM UNNEST(ARRAY<STRUCT<familyId STRING,familySelector STRING,disc STRING,variants STRING>>[${arr.join(',\n')}])),
headers AS (SELECT number, LOWER(\`hash\`) AS bh FROM \`bigquery-public-data.crypto_ethereum.blocks\` WHERE number BETWEEN ${w.fromBlock} AND ${w.toBlock} AND timestamp BETWEEN TIMESTAMP('${w.firstTime}') AND TIMESTAMP('${w.lastTime}')),
tx AS (SELECT h.number,h.bh,LOWER(t.hash) th,LOWER(t.to_address) txTo,IF(REGEXP_CONTAINS(LEFT(t.input,10),r'^0x[0-9a-fA-F]{8}$'),LOWER(LEFT(t.input,10)),NULL) txSelector FROM \`bigquery-public-data.crypto_ethereum.transactions\` t JOIN headers h ON t.block_number=h.number AND LOWER(t.block_hash)=h.bh WHERE t.receipt_status=1 AND t.block_timestamp BETWEEN TIMESTAMP('${w.firstTime}') AND TIMESTAMP('${w.lastTime}')),
logs AS (SELECT t.txTo,t.txSelector,LOWER(l.address) emitter,LOWER(l.topics[SAFE_OFFSET(0)]) topic0,${key} disc,l.topics,LOWER(l.data) d
 FROM \`bigquery-public-data.crypto_ethereum.logs\` l JOIN tx t ON t.number=l.block_number AND t.bh=LOWER(l.block_hash) AND t.th=LOWER(l.transaction_hash)
 WHERE l.block_timestamp BETWEEN TIMESTAMP('${w.firstTime}') AND TIMESTAMP('${w.lastTime}')),
hits AS (SELECT c.familyId,c.familySelector,l.topic0,l.emitter,l.txTo,l.txSelector,project_catalog_event(c.variants,l.topics,l.d,l.emitter) r
 FROM logs l JOIN catalog c ON c.disc=l.disc)
SELECT familyId,familySelector,topic0,emitter,txTo,txSelector,r.status,r.reason,r.poolAddress,r.poolId,r.tokenIn,r.tokenOut,COUNT(*) eventCount
FROM hits GROUP BY familyId,familySelector,topic0,emitter,txTo,txSelector,r.status,r.reason,r.poolAddress,r.poolId,r.tokenIn,r.tokenOut`;
}
