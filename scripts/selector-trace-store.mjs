// The original raw table remains one transaction per row, with exactly its original schema.
import assert from 'node:assert/strict';
import {googleApi,sha} from './selector-query-client.mjs';
import {decodeRow} from './bigquery-table.mjs';
import {openReadyDiscoveryJob} from './ready-bigquery-sql.mjs';
export const HISTORY='eth-token-480803.Ready.eth_mainnet_raw_26155910_26378389_62b23cae';
export const PROJECT='eth-token-480803', LOCATION='US', BASE='https://bigquery.googleapis.com/bigquery/v2/projects/'+PROJECT;
export const HISTORY_URL=BASE+'/datasets/Ready/tables/'+HISTORY.split('.')[2];
export const RAW_FIELDS='tx_hash,block_hash,block_number,transaction_index,receipt_status,from_address,to_address,input,value,trace_rows_present,traces,logs';
export const sqlTable=s=>'\x60'+s+'\x60';
export const hash=/^0x[0-9a-f]{64}$/;
const iso=/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/;
export const clockSql="FORMAT_TIMESTAMP('%Y-%m-%dT%H:%M:%E6SZ',CURRENT_TIMESTAMP(),'UTC')";
export function ts(s){assert(typeof s==='string'&&iso.test(s)&&Number.isFinite(Date.parse(s)),'invalid UTC pin');return "TIMESTAMP('"+s+"')";}
export function checkTraceWindow(w){
 assert(w&&w.chainId===1&&Number.isSafeInteger(w.fromBlock)&&Number.isSafeInteger(w.toBlock)&&w.fromBlock>0&&w.toBlock>=w.fromBlock,'invalid Ethereum window');
 assert(typeof w.transactions==='string'&&/^\d+$/.test(w.transactions)&&BigInt(w.transactions)<2n**63n&&hash.test(w.headHash??''),'invalid window pins');
 ts(w.firstTime);ts(w.lastTime);assert(w.firstTime<=w.lastTime);
 if(w.fromBlock===w.toBlock)assert.equal(w.firstTime,w.lastTime,'a single block must have one timestamp');
 return Object.fromEntries(['chainId','fromBlock','toBlock','firstTime','lastTime','headHash','transactions'].map(k=>[k,w[k]]));
}
export function scope(w){checkTraceWindow(w);return `block_number BETWEEN ${w.fromBlock} AND ${w.toBlock}`;}
export function fixedTraceRead(w,snapshotAt){assert(snapshotAt,'missing fixed-history snapshot');return `SELECT ${RAW_FIELDS} FROM ${sqlTable(HISTORY)} FOR SYSTEM_TIME AS OF ${ts(snapshotAt)} WHERE ${scope(w)}`;}
export function planResize(old,target){
 for(const r of [old,target])assert(Number.isSafeInteger(r?.fromBlock)&&Number.isSafeInteger(r?.toBlock)&&r.fromBlock>0&&r.toBlock>=r.fromBlock);
 const outside=(a,b)=>{const lo=Math.max(a.fromBlock,b.fromBlock),hi=Math.min(a.toBlock,b.toBlock);
  if(lo>hi)return [[a.fromBlock,a.toBlock]];
  return [[a.fromBlock,lo-1],[hi+1,a.toBlock]].filter(([x,y])=>x<=y);};
 return {missing:outside(target,old),excess:outside(old,target)};
}
const postfix='\nCanonical coverage v2: ';
export function parseHistoryMeta(m){
 assert(m?.type==='TABLE'&&m.location===LOCATION&&!m.expirationTime,'expected permanent Ethereum archive in US');
 assert.deepEqual(m.schema.fields.map(f=>f.name),RAW_FIELDS.split(','),'history schema changed');
 const p=m.description?.split(postfix)??[];
 assert(p.length<=2,'ambiguous history certificate');if(p.length!==2)return null;
 const record=JSON.parse(p[1]),w=checkTraceWindow(record.window);
 assert.equal(record.format,'ethereum-history-coverage/v2');assert.equal(record.table,HISTORY);
 assert.equal(record.schemaSha256,sha(JSON.stringify(m.schema)));
 const empty=record.empty;assert(Array.isArray(empty)&&new Set(empty.map(e=>e.block)).size===empty.length);
 for(const e of empty)assert(Number.isSafeInteger(e.block)&&e.block>=w.fromBlock&&e.block<=w.toBlock&&hash.test(e.hash));
 return {window:w,empty,baseDescription:p[0],record};
}
export function historyDescription(meta,record){
 assert.equal(record.table,HISTORY);assert.equal(record.schemaSha256,sha(JSON.stringify(meta.schema)));
 assert(meta.description?.split(postfix).length<=2||!meta.description);
 const s=(meta.description??'').split(postfix)[0]+postfix+JSON.stringify(record);
 assert(Buffer.byteLength(s,'utf8')<=15000,'history proof exceeds description limit');
 return s;
}
export function coverageSql(w,asOf,empty=[]){
 const typed=empty.length?`[${empty.map(e=>{assert(Number.isSafeInteger(e.block)&&hash.test(e.hash));return "STRUCT("+e.block+" AS n,'"+e.hash+"' AS h)";}).join(',')}]`:'ARRAY<STRUCT<n INT64,h STRING>>[]';
 return `WITH all_tx AS (
  SELECT block_number,block_hash,tx_hash,transaction_index,trace_rows_present FROM ${sqlTable(HISTORY)}${asOf?' FOR SYSTEM_TIME AS OF '+ts(asOf):''} WHERE ${scope(w)}
 ), by_block AS (
  SELECT block_number,ANY_VALUE(block_hash) block_hash,COUNT(*) n_txs,COUNT(DISTINCT transaction_index) slots,MAX(transaction_index) max_slot,
   COUNT(DISTINCT block_hash) hashes,COUNTIF(NOT IFNULL(REGEXP_CONTAINS(block_hash,r'^0x[0-9a-f]{64}$') AND REGEXP_CONTAINS(tx_hash,r'^0x[0-9a-f]{64}$') AND transaction_index>=0,FALSE)) bad,
   COUNTIF(NOT IFNULL(trace_rows_present,FALSE)) missing FROM all_tx GROUP BY block_number
 ), empty AS (SELECT n AS block_number,h AS block_hash FROM UNNEST(${typed})),
 checked AS (SELECT COALESCE(b.block_number,e.block_number) block_number,COALESCE(b.block_hash,e.block_hash) block_hash,
   IFNULL(n_txs,0) AS txs,IFNULL(missing,0) AS missing, e.block_number IS NOT NULL AS is_empty,
   IF(b.block_number IS NULL,FALSE,e.block_number IS NOT NULL OR bad>0 OR hashes!=1 OR slots!=n_txs OR max_slot!=n_txs-1) AS bad
  FROM by_block b FULL JOIN empty e USING(block_number))
 SELECT ${asOf?"'"+asOf+"'":clockSql} AS snapshotAt,COUNT(*) activeHashes,MIN(block_number) firstBlock,MAX(block_number) lastBlock,
  ARRAY_AGG(block_hash IGNORE NULLS ORDER BY block_number DESC LIMIT 1)[SAFE_OFFSET(0)] head,
  COALESCE(SUM(txs),0) transactions,(SELECT COUNT(DISTINCT tx_hash) FROM all_tx) distinctTx,COALESCE(SUM(missing),0) missingTraces,
  COUNTIF(is_empty) emptyBlocks,COUNTIF(bad) invalid FROM checked`;
}
export function checkTraceCoverage(w,r){
 assert(r&&String(r.invalid)==='0'&&Number(r.activeHashes)===w.toBlock-w.fromBlock+1&&Number(r.firstBlock)===w.fromBlock&&Number(r.lastBlock)===w.toBlock,'fixed history has missing/duplicate blocks or receipts');
 assert(r.transactions===w.transactions&&r.distinctTx===w.transactions&&r.missingTraces==='0','fixed history has incomplete transaction coverage');
 assert.equal(r.head,w.headHash,'fixed history cutoff hash differs');ts(r.snapshotAt);return {...r,firstTime:w.firstTime,lastTime:w.lastTime};
}
export async function traceQuery(api,sql,cap,label,{limit=100,jobId}={}){
 assert(/^\d+$/.test(String(cap))&&BigInt(cap)>0n);
 const id=jobId??'trace_store_'+label+'_'+sha(sql+'\0'+cap+'\0'+Date.now()).slice(0,23);
 const query={query:sql,useLegacySql:false,useQueryCache:false,maximumBytesBilled:String(cap),scriptOptions:{statementByteBudget:String(cap)}};
 const get=await openReadyDiscoveryJob(api,{projectId:PROJECT},{location:LOCATION,query,jobId:id},[],{waitForCompletion:true});
 let next,n;const rows=[];
 do{const p=await get(Math.min(limit+1,1000),next);n??=Number(p.totalRows??0);assert(n<=limit,'unexpected number of source query result rows');
    rows.push(...(p.rows??[]).map(r=>decodeRow(p.schema.fields,r)));next=p.pageToken;}while(next);
 assert.equal(rows.length,n);
 const job=await api(BASE+'/jobs/'+id+'?location='+LOCATION);assert(job.status.state==='DONE'&&!job.status.errorResult);
 return {rows,jobId:id,bytesBilled:job.statistics.query.totalBytesBilled??'0',sqlSha256:sha(sql)};
}
export async function pinTraceWindow(window,{api=googleApi(),asOf,cap=16n*2n**30n}={}){
 const w=checkTraceWindow(window);if(asOf)ts(asOf);
 const m=await api(HISTORY_URL),p=parseHistoryMeta(m);assert(p,'original history needs its coverage certificate; no public trace fallback');
 assert.equal(m.numRows,p.window.transactions,'original history changed without a published coverage certificate');
 assert(w.fromBlock>=p.window.fromBlock&&w.toBlock<=p.window.toBlock&&w.firstTime>=p.window.firstTime&&w.lastTime<=p.window.lastTime,'requested window is not fully maintained; update history first');
 if(w.fromBlock===p.window.fromBlock)assert.equal(w.firstTime,p.window.firstTime,'fixed history first timestamp differs');
 if(w.toBlock===p.window.toBlock)assert.equal(w.lastTime,p.window.lastTime,'fixed history last timestamp differs');
 if(w.toBlock===p.window.toBlock)assert.equal(w.headHash,p.window.headHash,'window ended on another chain');
 const empty=p.empty.filter(e=>e.block>=w.fromBlock&&e.block<=w.toBlock);
 const r=await traceQuery(api,coverageSql(w,asOf,empty),cap,'coverage',{limit:1});
 const coverage=checkTraceCoverage(w,r.rows[0]);
 const end=await api(HISTORY_URL);assert.equal(end.etag,m.etag,'history changed while pinning, retry the read');
 return {snapshotAt:coverage.snapshotAt,coverage,jobId:r.jobId};
}
