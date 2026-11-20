import assert from 'node:assert/strict';

// Use the same null/empty root convention as Ethereum ETL. A discarded or
// missing branch makes the source invalid; failed frames stay in the materialized
// data so consumers can independently reject failed ancestors.
function treeIssue(nodes){
 if(!Array.isArray(nodes)||!nodes.length)return 'missing trace root';
 const by=new Map(),counts=new Map();
 for(const n of nodes){
  const p=n.p===null?'':n.p;
  if(typeof p!=='string'||(p!==''&&!/^(0|[1-9][0-9]*)(,(0|[1-9][0-9]*))*$/.test(p)))return 'invalid trace path';
  if(by.has(p))return 'duplicate trace path';
  if(n.st!==0&&n.st!==1)return 'unknown trace status';
  if(!Number.isSafeInteger(n.subs)||n.subs<0)return 'unknown trace child count';
  by.set(p,n);
 }
 if(!by.has(''))return 'missing trace root';
 for(const p of by.keys())if(p!==''){
  const pos=p.lastIndexOf(','),parent=pos<0?'':p.slice(0,pos),child=Number(p.slice(pos+1)),pn=by.get(parent);
  if(!pn)return 'missing trace parent';
  if(!Number.isSafeInteger(child)||child>=pn.subs)return 'out-of-range child index';
  counts.set(parent,(counts.get(parent)||0)+1);
 }
 for(const [p,n] of by)if(n.subs!==(counts.get(p)||0))return 'missing declared trace child';
 return null;
}
const source='bigquery-public-data.crypto_ethereum',addr="r'^0x[0-9a-f]{40}$'",hash="r'^0x[0-9a-f]{64}$'",bytes="r'^0x(?:[0-9a-f]{2})*$'";
function stamp(s){assert(typeof s==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/.test(s)&&Number.isFinite(Date.parse(s)),'invalid UTC pin');return "TIMESTAMP('"+s+"')";}

export function renderSelectorTraceSourceSql({window,...extra}){
 assert.equal(Object.keys(extra).length,0,'no auxiliary source, selector or target');
 const {chainId=1,fromBlock:lo,toBlock:hi,firstTime,lastTime,headHash,transactions}=window;
 assert(chainId===1&&Number.isSafeInteger(lo)&&Number.isSafeInteger(hi)&&lo>0&&hi>=lo,'invalid canonical mainnet block interval');
 assert(typeof transactions==='string'&&/^(?:0|[1-9][0-9]*)$/.test(transactions)&&BigInt(transactions)<=9223372036854775807n,'invalid transaction count');
 assert(typeof headHash==='string'&&/^0x[0-9a-f]{64}$/.test(headHash),'invalid canonical head hash');
 const t0=stamp(firstTime),t1=stamp(lastTime);assert(firstTime<=lastTime,'invalid time interval');
 const limits=(n,t)=>`${n} BETWEEN ${lo} AND ${hi} AND ${t} BETWEEN ${t0} AND ${t1}`;
 return `CREATE TEMP FUNCTION selectorTraceTreeIssue(nodes ARRAY<STRUCT<p STRING,st FLOAT64,subs FLOAT64>>)
 RETURNS STRING LANGUAGE js AS r'''
${treeIssue.toString()}
return treeIssue(nodes);
''';
WITH header_base AS (
 SELECT b.number,LOWER(b.hash) block_hash,LOWER(b.parent_hash) parent_hash,b.timestamp ts,b.transaction_count n
 FROM \`${source}.blocks\` b WHERE ${limits('b.number','b.timestamp')}
), headers AS (
 SELECT h.*,LAG(block_hash) OVER(ORDER BY number) previous_hash FROM header_base h
), header_seal AS (
 SELECT COUNT(*)=${hi-lo+1} AND COUNT(DISTINCT number)=${hi-lo+1} AND COUNT(DISTINCT block_hash)=${hi-lo+1}
 AND COUNTIF(NOT IFNULL(REGEXP_CONTAINS(block_hash,${hash}) AND REGEXP_CONTAINS(parent_hash,${hash}) AND n>=0,FALSE))=0
 AND COUNTIF(number>${lo} AND parent_hash IS DISTINCT FROM previous_hash)=0
 AND COUNTIF(number=${lo} AND ts=${t0})=1 AND COUNTIF(number=${hi} AND block_hash='${headHash}' AND ts=${t1})=1
 AND SUM(n)=${transactions} ok FROM headers
), tx_base AS (
 SELECT h.number block_number,h.block_hash,h.n,t.transaction_index,LOWER(t.hash) tx_hash,t.receipt_status,
 LOWER(t.from_address) from_address,LOWER(t.to_address) to_address,LOWER(t.receipt_contract_address) created,
 LOWER(t.input) input,CAST(t.value AS STRING) value
 FROM \`${source}.transactions\` t JOIN headers h ON t.block_number=h.number AND LOWER(t.block_hash)=h.block_hash
 WHERE ${limits('t.block_number','t.block_timestamp')}
), tx AS (
 SELECT x.*,COUNT(*) OVER(PARTITION BY block_hash) read_n,COUNT(*) OVER(PARTITION BY block_hash,transaction_index) pos_n,
 COUNT(*) OVER(PARTITION BY tx_hash) hash_n FROM tx_base x
), trace_base AS (
 SELECT h.number block_number,h.block_hash,LOWER(t.transaction_hash) tx_hash,t.transaction_index,
 COALESCE(t.trace_address,'') trace_address,LOWER(t.trace_type) trace_type,LOWER(t.call_type) call_type,t.status,t.subtraces,
 LOWER(t.from_address) from_address,LOWER(t.to_address) to_address,LOWER(t.input) input,LOWER(t.output) output,CAST(t.value AS STRING) value
 FROM \`${source}.traces\` t JOIN headers h ON t.block_number=h.number AND LOWER(t.block_hash)=h.block_hash
 WHERE ${limits('t.block_number','t.block_timestamp')}
 AND NOT(t.transaction_hash IS NULL AND t.transaction_index IS NULL AND IFNULL(LOWER(t.trace_type),'')='reward')
), trace_groups AS (
 SELECT block_number,block_hash,tx_hash,MIN(transaction_index) loTi,MAX(transaction_index) hiTi,COUNTIF(transaction_index IS NULL) nullTi,
 ARRAY_AGG(STRUCT(trace_address,trace_type,call_type,status,from_address,to_address,input,output,value,subtraces)
 ORDER BY IF(trace_address='','',ARRAY_TO_STRING(ARRAY(SELECT LPAD(component,20,'0') FROM UNNEST(SPLIT(trace_address,',')) component WITH OFFSET ord ORDER BY ord),','))) traces
 FROM trace_base GROUP BY block_number,block_hash,tx_hash
), log_base AS (
 SELECT h.number block_number,h.block_hash,LOWER(l.transaction_hash) tx_hash,l.transaction_index, l.log_index,
 LOWER(l.address) log_address,l.topics,LOWER(l.data) data,
 ROW_NUMBER() OVER(PARTITION BY h.block_hash ORDER BY l.log_index)-1 expected_slot,
 LAG(l.transaction_index) OVER(PARTITION BY h.block_hash ORDER BY l.log_index) previous_ti
 FROM \`${source}.logs\` l JOIN headers h ON l.block_number=h.number AND LOWER(l.block_hash)=h.block_hash
 WHERE ${limits('l.block_number','l.block_timestamp')}
), log_groups AS (
 SELECT block_number,block_hash,tx_hash,MIN(transaction_index) loTi,MAX(transaction_index) hiTi,
 COUNTIF(NOT IFNULL(transaction_index>=0 AND log_index=expected_slot AND (previous_ti IS NULL OR transaction_index>=previous_ti)
 AND REGEXP_CONTAINS(log_address,${addr}) AND REGEXP_CONTAINS(data,${bytes}) AND ARRAY_LENGTH(topics)<=4
 AND NOT EXISTS(SELECT 1 FROM UNNEST(topics) v WHERE NOT IFNULL(REGEXP_CONTAINS(LOWER(v),${hash}),FALSE)),FALSE)) bad,
 ARRAY_AGG(STRUCT(log_index,log_address,topics,data) ORDER BY log_index) logs FROM log_base GROUP BY block_number,block_hash,tx_hash
), joined AS (
 SELECT t.*,r.traces,IFNULL(l.logs,[]) logs,r.loTi r0,r.hiTi r1,r.nullTi rn,l.loTi l0,l.hiTi l1,l.bad bad_log,
 (SELECT AS STRUCT f.* FROM UNNEST(r.traces) f WHERE f.trace_address='' LIMIT 1) root,
 selectorTraceTreeIssue(ARRAY(SELECT AS STRUCT f.trace_address p,CAST(f.status AS FLOAT64) st,CAST(f.subtraces AS FLOAT64) subs FROM UNNEST(r.traces) f)) tree_issue,
 COUNT(*) OVER() total_rows
 FROM tx t FULL OUTER JOIN trace_groups r USING(block_number,block_hash,tx_hash)
 FULL OUTER JOIN log_groups l USING(block_number,block_hash,tx_hash)
), audited AS (
 SELECT j.*,CASE
 WHEN NOT IFNULL(hash_n=1 AND pos_n=1 AND read_n=n AND transaction_index BETWEEN 0 AND n-1 AND receipt_status IN(0,1)
 AND REGEXP_CONTAINS(tx_hash,${hash}) AND REGEXP_CONTAINS(from_address,${addr})
 AND (to_address IS NULL OR REGEXP_CONTAINS(to_address,${addr})) AND REGEXP_CONTAINS(input,${bytes}) AND value IS NOT NULL,FALSE)
 THEN 'transaction hash, slot, header count or envelope'
 WHEN NOT IFNULL(r0=transaction_index AND r1=transaction_index AND rn=0,FALSE) THEN 'trace owner or missing trace row'
 WHEN tree_issue IS NOT NULL THEN tree_issue
 WHEN NOT IFNULL(root.from_address=from_address AND root.input=input AND root.status=receipt_status AND root.value=value AND (
 (to_address IS NOT NULL AND root.trace_type='call' AND root.call_type='call' AND root.to_address=to_address) OR
 (to_address IS NULL AND root.trace_type='create' AND (IFNULL(root.to_address=created,FALSE) OR (receipt_status=0 AND root.to_address IS NULL)))),FALSE)
 THEN 'root does not match transaction or creation receipt'
 WHEN ARRAY_LENGTH(logs)>0 AND NOT IFNULL(l0=transaction_index AND l1=transaction_index AND bad_log=0 AND receipt_status=1,FALSE)
 THEN 'invalid or misowned block log slot' END issue FROM joined j
)
SELECT a.tx_hash,a.block_hash,a.block_number,a.transaction_index,a.receipt_status,a.from_address,a.to_address,a.input,a.value,
 TRUE trace_rows_present,a.traces,a.logs
FROM header_seal h LEFT JOIN audited a ON TRUE
WHERE CASE WHEN NOT IFNULL(h.ok,FALSE) THEN ERROR('trace source: header pin mismatch')
 WHEN IFNULL(a.total_rows,0)!=${transactions} THEN ERROR('trace source: wrong total transaction count or orphan input rows')
 WHEN a.total_rows IS NULL THEN FALSE
 WHEN a.issue IS NOT NULL THEN ERROR(CONCAT('trace source: ',a.issue,' at ',IFNULL(a.tx_hash,'unknown transaction')))
 ELSE TRUE END`;
}
