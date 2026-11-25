// Maintain only the original raw archive. Headers are verification data, never inserted.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';
import {googleApi,sha} from './selector-query-client.mjs';
import {renderSelectorTraceSourceSql} from './selector-trace-source-sql.mjs';
import {HISTORY,HISTORY_URL,RAW_FIELDS,sqlTable,scope,ts,hash,checkTraceWindow,parseHistoryMeta,historyDescription,pinTraceWindow,planResize,traceQuery} from './selector-trace-store.mjs';
const upstream=sqlTable('bigquery-public-data.crypto_ethereum.blocks'), dest=sqlTable(HISTORY),gi=2n**30n;
const stamp=s=>`FORMAT_TIMESTAMP('%Y-%m-%dT%H:%M:%E6SZ',${s},'UTC')`;
const header=filter=>`SELECT number block_number,LOWER(\`hash\`) block_hash,LOWER(parent_hash) parent_hash,timestamp block_time,transaction_count txs FROM ${upstream} WHERE ${filter}`;
const selected=w=>header(`number BETWEEN ${w.fromBlock} AND ${w.toBlock} AND timestamp BETWEEN ${ts(w.firstTime)} AND ${ts(w.lastTime)}`);
const one=async(api,sql,label,cap=16n*gi)=>(await traceQuery(api,sql,cap,label,{limit:1})).rows[0];
function selectPins(h,cond='TRUE'){
 return `SELECT MIN(block_number) fromBlock,MAX(block_number) toBlock,ARRAY_AGG(block_hash ORDER BY block_number DESC LIMIT 1)[SAFE_OFFSET(0)] headHash,
 ${stamp('MIN(block_time)')} firstTime,${stamp('MAX(block_time)')} lastTime,CAST(SUM(txs) AS STRING) transactions FROM ${h} WHERE ${cond}`;
}
const pin=x=>checkTraceWindow({...x,chainId:1,fromBlock:Number(x.fromBlock),toBlock:Number(x.toBlock)});
const emptyJson="TO_JSON_STRING(ARRAY(SELECT AS STRUCT block_number AS block,block_hash AS `hash` FROM wanted WHERE txs=0 ORDER BY block_number))";
function headerSeal(w,h){
 return `SELECT COUNT(*)=${w.toBlock-w.fromBlock+1} AND COUNT(DISTINCT block_number)=COUNT(*) AND COUNT(DISTINCT block_hash)=COUNT(*)
 AND COUNTIF(block_number=${w.fromBlock} AND block_time=${ts(w.firstTime)})=1
 AND COUNTIF(block_number=${w.toBlock} AND block_time=${ts(w.lastTime)} AND block_hash='${w.headHash}')=1
 AND SUM(txs)=${w.transactions}
 AND COUNTIF(NOT IFNULL(REGEXP_CONTAINS(block_hash,r'^0x[0-9a-f]{64}$') AND REGEXP_CONTAINS(parent_hash,r'^0x[0-9a-f]{64}$') AND txs>=0 AND
   (block_number=${w.fromBlock} OR parent_hash=prior AND block_time>prior_time),FALSE))=0
 FROM (SELECT *,LAG(block_hash) OVER(ORDER BY block_number) prior,LAG(block_time) OVER(ORDER BY block_number) prior_time FROM ${h})`;
}
function compareHeaders(w,h,filter='TRUE'){
 return `WITH seen AS (
 SELECT block_number,ANY_VALUE(block_hash) block_hash,COUNT(*) n,COUNT(DISTINCT block_hash) hashes,
 COUNT(DISTINCT tx_hash) unique_txs,COUNT(DISTINCT transaction_index) slots,MAX(transaction_index) max_slot,
 COUNTIF(NOT IFNULL(REGEXP_CONTAINS(block_hash,r'^0x[0-9a-f]{64}$') AND REGEXP_CONTAINS(tx_hash,r'^0x[0-9a-f]{64}$') AND transaction_index>=0 AND trace_rows_present,FALSE)) bad
 FROM ${dest} WHERE ${scope(w)} GROUP BY block_number
 ), expected AS (SELECT * FROM ${h} WHERE ${filter})
 SELECT COUNTIF(e.block_number IS NULL OR IFNULL(n,0)!=e.txs OR (n IS NOT NULL AND
  NOT IFNULL(n=unique_txs AND n=slots AND n-1=max_slot AND hashes=1 AND bad=0 AND s.block_hash=e.block_hash,FALSE)))=0
 FROM seen s FULL JOIN expected e USING(block_number)`;
}
function proofSql(w){
 return `CREATE TEMP TABLE wanted AS ${selected(w)};
 ASSERT (${headerSeal(w,'wanted')}) AS 'block header continuity or cutoff failed';
 ASSERT (${compareHeaders(w,'wanted')}) AS 'missing/duplicate raw rows, or raw block hash differs from canonical header';
 ASSERT ((SELECT COUNT(DISTINCT tx_hash) FROM ${dest} WHERE ${scope(w)})=${w.transactions}) AS 'duplicate transaction hashes';
 SELECT ${emptyJson} emptyJson;`;
}
const chunks=gaps=>gaps.flatMap(([a,b])=>Array.from({length:Math.ceil((b-a+1)/4096)},(_,i)=>[a+i*4096,Math.min(b,a+(i+1)*4096-1)]));
export function resizeSql(old,target,windows,{maxEmptyBytes=10000}={}){
 old=checkTraceWindow(old);target=checkTraceWindow(target);const {missing,excess}=planResize(old,target);
 assert(Number.isSafeInteger(maxEmptyBytes)&&maxEmptyBytes>=2&&maxEmptyBytes<=10000);
 assert.deepEqual(windows.map(w=>[w.fromBlock,w.toBlock]),chunks(missing),'fetch only missing block ranges');
 let pre;const stages=windows.map((w,i)=>{
  const [f,s]=renderSelectorTraceSourceSql({window:w,materialize:true}).split('CREATE TEMP TABLE canonical_trace AS\n');
  assert(s);if(pre)assert.equal(pre,f);pre=f;return `CREATE TEMP TABLE missing_${i} AS ${s};`;
 });
 const lo=Math.max(old.fromBlock,target.fromBlock),hi=Math.min(old.toBlock,target.toBlock);
 const retained=lo<=hi?compareHeaders({...target,fromBlock:lo,toBlock:hi},'wanted',`block_number BETWEEN ${lo} AND ${hi}`):null;
 return `CREATE TEMP TABLE wanted AS ${selected(target)};
 ASSERT (${headerSeal(target,'wanted')}) AS 'target header count, parent links or cutoff failed';
 ASSERT BYTE_LENGTH(${emptyJson})<=${maxEmptyBytes} AS 'coverage certificate exceeds metadata space; archive unchanged';
 ${pre??''}
 ${stages.join('\n')}
 BEGIN TRANSACTION;
 -- A non-appending DML acquires the transaction write lock without rewriting retained rows.
 DELETE FROM ${dest} WHERE FALSE;
 ASSERT (SELECT COUNT(*)=${old.transactions} AND COUNTIF(NOT IFNULL(${scope(old)},FALSE))=0 FROM ${dest}) AS 'archive changed: replan';
 ${retained?`ASSERT (${retained}) AS 'retained blocks do not match the canonical headers; no writes committed';`:''}
 ${excess.map(([a,b])=>`DELETE FROM ${dest} WHERE block_number BETWEEN ${a} AND ${b};`).join('\n')}
 ${windows.map((w,i)=>`INSERT INTO ${dest} (${RAW_FIELDS}) SELECT ${RAW_FIELDS} FROM missing_${i};`).join('\n')}
 ASSERT (${compareHeaders(target,'wanted')}) AS 'after merge, block/receipt continuity failed';
 ASSERT (SELECT COUNT(*)=${target.transactions} AND COUNT(DISTINCT tx_hash)=${target.transactions} AND COUNTIF(NOT IFNULL(${scope(target)},FALSE))=0 FROM ${dest}) AS 'duplicate or out-of-window rows';
 COMMIT TRANSACTION;
 SELECT ${emptyJson} emptyJson;`;
}
async function certify(api,m,w,result){
 const empty=JSON.parse(result.rows[0].emptyJson);assert(empty.every(e=>Number.isSafeInteger(e.block)&&hash.test(e.hash)));
 assert.equal(m.numRows,w.transactions,'archive row count not equal to verified window');
 const record={format:'ethereum-history-coverage/v2',table:HISTORY,schemaSha256:sha(JSON.stringify(m.schema)),window:w,empty,jobId:result.jobId};
 const desc=historyDescription(m,record);
 const r=await api(HISTORY_URL,{method:'PATCH',headers:{'Content-Type':'application/json','If-Match':m.etag},body:JSON.stringify({description:desc})});
 assert.equal(r.description,desc);assert.equal(r.numRows,w.transactions);
 assert.deepEqual(r.schema,m.schema,'original schema must not change');
 const pinned=await pinTraceWindow(w,{api});
 return {table:HISTORY,window:w,emptyBlocks:empty.length,snapshotAt:pinned.snapshotAt,verificationJob:result.jobId,bytesBilled:result.bytesBilled};
}
export async function adoptTraceStore(api,receipt,cap=32n*gi){
 assert.equal(receipt.table,HISTORY);assert.equal(receipt.copyStatus,'DONE');
 const w=checkTraceWindow(receipt.window),m=await api(HISTORY_URL),published=parseHistoryMeta(m);
 if(published){assert.deepEqual(published.window,w);return {table:HISTORY,window:w,...await pinTraceWindow(w,{api})};}
 assert.equal(m.creationTime,receipt.created);assert.equal(m.lastModifiedTime,receipt.modified);
 assert.equal(m.numBytes,receipt.numBytes);assert.equal(m.numRows,receipt.numRows);assert.equal(sha(JSON.stringify(m.schema)),receipt.schemaSha256);
 const r=await traceQuery(api,proofSql(w),cap,'adopt',{limit:1,jobId:'trace_store_adopt_'+sha(proofSql(w)+cap).slice(0,24)});
 const current=await api(HISTORY_URL);assert.equal(current.etag,m.etag,'archive changed during validation; no certificate written');
 return certify(api,m,w,r);
}
async function fromDays(api,a,b){
 const day=/^\d{4}-\d\d-\d\d$/;assert(day.test(a??'')&&day.test(b??'')&&a<=b,'use inclusive YYYY-MM-DD dates (Asia/Shanghai)');
 const cond=`timestamp >= TIMESTAMP(DATE '${a}','Asia/Shanghai') AND timestamp < TIMESTAMP(DATE_ADD(DATE '${b}', INTERVAL 1 DAY),'Asia/Shanghai')`;
 const w=pin(await one(api,selectPins('('+header(cond)+')'),'wanted'));
 const first=Date.parse(a+'T00:00:00+08:00'),end=Date.parse(b+'T00:00:00+08:00')+86400000;
 assert(end<Date.now()&&Date.parse(w.firstTime)-first<5*60_000&&end-Date.parse(w.lastTime)<5*60_000,'date range is not fully indexed');
 return w;
}
export async function resizeTraceStore(api,target,cap,{apply=false}={}){
 target=checkTraceWindow(target);
 const m=await api(HISTORY_URL),published=parseHistoryMeta(m);assert(published,'original archive must be adopted first');
 const old=published.window,plan=planResize(old,target),parts=chunks(plan.missing);
 if(!parts.length&&!plan.excess.length){assert.deepEqual(old,target);const p=await pinTraceWindow(target,{api});return {status:'unchanged',plan,window:target,snapshotAt:p.snapshotAt};}
 if(!apply){await pinTraceWindow(old,{api});return {status:'planned',plan,window:target};}
 assert(parts.length<=64,'add new days in smaller date-window increments');
 const windows=await Promise.all(parts.map(async ([lo,hi])=>{
  const r=pin(await one(api,selectPins('('+selected(target)+')',`block_number BETWEEN ${lo} AND ${hi}`),'missing_headers'));
  assert.equal(r.fromBlock,lo);assert.equal(r.toBlock,hi);return r;
 }));
 const maxEmptyBytes=Math.min(10000,13000-Buffer.byteLength(published.baseDescription,'utf8'));
 const sql=resizeSql(old,target,windows,{maxEmptyBytes}),jobId='trace_store_resize_'+sha(sql+'\0'+cap+'\0'+published.record.jobId).slice(0,24);
 const result=await traceQuery(api,sql,cap,'resize',{limit:1,jobId});
 const after=await api(HISTORY_URL),now=parseHistoryMeta(after);
 if(now?.record.jobId===result.jobId){
  assert.deepEqual(now.window,target);return {status:'published',plan,window:target,...await pinTraceWindow(target,{api})};
 }
 assert.deepEqual(now?.record,published.record,'archive certificate changed concurrently; will not replace it');
 return {status:'published',plan,...await certify(api,after,target,result)};
}
async function main(){
 const [mode,...args]=process.argv.slice(2);
 if(!mode||mode==='--help'){console.log('selector-trace-store-maintain.mjs adopt --archive-receipt FILE --apply\nselector-trace-store-maintain.mjs resize [--window pinned.json | --from-day YYYY-MM-DD --through-day YYYY-MM-DD] [--apply --max-bytes N]\nDate bounds are inclusive, Asia/Shanghai. Default resize only plans; --apply can prune existing rows.');return;}
 const {values:v}=parseArgs({args,options:{'archive-receipt':{type:'string'},window:{type:'string'},'from-day':{type:'string'},'through-day':{type:'string'},'max-bytes':{type:'string'},apply:{type:'boolean'}}});
 const get=n=>JSON.parse(fs.readFileSync(v[n],'utf8')),api=googleApi(),cap=v['max-bytes'];
 let r;
 if(mode==='adopt'){assert(v.apply&&v['archive-receipt'],'adopt requires explicit --apply and archive receipt');r=await adoptTraceStore(api,get('archive-receipt'));}
 else if(mode==='resize'){
  assert(!(v.window&&(v['from-day']||v['through-day'])),'choose pins or dates');
  if(v.apply)assert(/^\d+$/.test(cap??'')&&BigInt(cap)>0n,'explicit --max-bytes required');
  const w=v.window?checkTraceWindow(get('window')):await fromDays(api,v['from-day'],v['through-day']);
  r=await resizeTraceStore(api,w,cap,{apply:!!v.apply});
 }else throw Error('unknown history maintenance operation');
 console.log(JSON.stringify(r));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(e=>{console.error(String(e.message).slice(0,600));process.exitCode=1;});
