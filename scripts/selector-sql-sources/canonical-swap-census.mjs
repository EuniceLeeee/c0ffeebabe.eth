// Historical observation tool. A matching event ABI is not a verified Family,
// token binding, or proof that all trades at this address emit this event.
import assert from 'node:assert/strict';

export const canonicalSwapTopics=Object.freeze({
  v2:'0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822',
  v3:'0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67',
  v4:'0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f',
});

// Embedded verbatim in the BigQuery JS UDF, called only on matching topics.
// Integer widths/signs are checked as hex, never as imprecise JS Numbers.
export function decodeCanonicalSwap(topicByLayout,emitter,topics,data) {
  if(!Array.isArray(topics)||typeof topics[0]!=='string')return null;
  const layout=Object.keys(topicByLayout).find(k=>topicByLayout[k]===topics[0].toLowerCase());
  if(!layout)return null;
  const hexword=x=>typeof x==='string'&&/^0x[0-9a-f]{64}$/i.test(x);
  const paddedAddress=x=>typeof x==='string'&&/^0x0{24}[0-9a-f]{40}$/i.test(x);
  const poolId=layout==='v4'&&hexword(topics[1])?topics[1].toLowerCase():null;
  const result=(decodeStatus,direction=null)=>({layout,poolId,direction,decodeStatus});
  if(typeof emitter!=='string'||!/^0x[0-9a-f]{40}$/i.test(emitter)||topics.length!==3||!paddedAddress(topics[2])||
     (layout==='v4'?!poolId:!paddedAddress(topics[1])))return result('malformed');
  const n=layout==='v2'?4:layout==='v3'?5:6;
  if(typeof data!=='string'||data.length!==2+64*n||!/^0x[0-9a-f]+$/i.test(data))return result('malformed');
  const ws=data.slice(2).toLowerCase().match(/.{64}/g),zero=w=>/^0+$/.test(w);
  const negative=x=>/[89a-f]/.test(x[0]);
  const fits=(w,bits,signed)=>{const p=64-bits/4;return w.slice(0,p)===(signed&&negative(w.slice(p))?'f':'0').repeat(p);};
  const sign=w=>zero(w)?0:negative(w)?-1:1;
  if(layout==='v2'){
    const active=ws.map(w=>zero(w)?'0':'1').join('');
    if(active==='1001')return result('decoded','asset0-in');
    if(active==='0110')return result('decoded','asset1-in');
  }else{
    if(!fits(ws[2],160,false)||!fits(ws[3],128,false)||!fits(ws[4],24,true)||
       (layout==='v4'&&(!fits(ws[0],128,true)||!fits(ws[1],128,true)||!fits(ws[5],24,false))))return result('malformed');
    const a=sign(ws[0]),b=sign(ws[1]);
    if(a*b===-1)return result('decoded',(layout==='v3'?a>0:a<0)?'asset0-in':'asset1-in');
  }
  return result('uninterpretable'); // e.g. zero-sided, dual inputs, or flash flows.
}

function timestamp(value){
  assert(typeof value==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/.test(value)&&Number.isFinite(Date.parse(value)),'invalid timestamp');
  return "TIMESTAMP('"+value+"')";
}

export function renderCanonicalSwapCensusSql({fromBlock:lo,toBlock:hi,firstTime,lastTime,headHash,transactions}){
  assert(Number.isSafeInteger(lo)&&Number.isSafeInteger(hi)&&lo>0&&lo<=hi,'invalid block range');
  assert(typeof headHash==='string'&&/^0x[0-9a-f]{64}$/.test(headHash),'missing canonical head pin');
  assert(typeof transactions==='string'&&/^(0|[1-9]\d*)$/.test(transactions),'missing transaction count pin');
  const start=timestamp(firstTime),end=timestamp(lastTime);assert(firstTime<=lastTime,'invalid time order');
  const base='bigquery-public-data.crypto_ethereum',topics=Object.values(canonicalSwapTopics).map(t=>"'"+t+"'").join(',');
  return `CREATE TEMP FUNCTION decode_swap(emitter STRING, topics ARRAY<STRING>, payload STRING)
RETURNS STRUCT<layout STRING,poolId STRING,direction STRING,decodeStatus STRING>
LANGUAGE js AS r'''
${decodeCanonicalSwap.toString()}
return decodeCanonicalSwap(${JSON.stringify(canonicalSwapTopics)},emitter,topics,payload);
''';
WITH headers AS (
 SELECT b.number,LOWER(b.hash) bh,LOWER(b.parent_hash) parent,b.transaction_count n,b.timestamp ts
 FROM \`${base}.blocks\` AS b
 WHERE number BETWEEN ${lo} AND ${hi} AND timestamp BETWEEN ${start} AND ${end}
), linked AS (
 SELECT *,LAG(bh) OVER(ORDER BY number) previous FROM headers
), tx AS (
 SELECT h.number,h.bh,h.n,LOWER(t.hash) th,t.transaction_index ti,t.receipt_status st
 FROM \`${base}.transactions\` t JOIN headers h ON h.number=t.block_number AND h.bh=LOWER(t.block_hash)
 WHERE t.block_timestamp BETWEEN ${start} AND ${end}
), tx_counts AS (
 SELECT number,bh,COUNT(*) nt,COUNT(DISTINCT ti) positions,COUNT(DISTINCT th) hashes,
   COUNTIF(ti IS NULL OR ti<0 OR ti>=n OR st IS NULL OR st NOT IN(0,1) OR th IS NULL OR NOT REGEXP_CONTAINS(th,r'^0x[0-9a-f]{64}$')) bad
 FROM tx GROUP BY number,bh
), chain_check AS (
 SELECT COUNT(*) blockRows,COUNT(DISTINCT number) distinctBlocks,SUM(n) headerTx,SUM(IFNULL(nt,0)) sourceTx,
    COUNTIF(number=${lo} AND ts=${start}) AS firstAnchor,
    COUNTIF(number=${hi} AND bh='${headHash}' AND ts=${end}) AS headAnchor,
    COUNTIF(bh IS NULL OR NOT REGEXP_CONTAINS(bh,r'^0x[0-9a-f]{64}$') OR
      (number>${lo} AND (parent IS NULL OR previous IS NULL OR previous!=parent)) OR
      n IS NULL OR n<0 OR n!=IFNULL(nt,0) OR n!=IFNULL(positions,0) OR n!=IFNULL(hashes,0) OR IFNULL(bad,0)!=0) badBlocks
 FROM linked LEFT JOIN tx_counts USING(number,bh)
), raw_signal AS (
 SELECT h.number,h.bh,LOWER(l.transaction_hash) th,l.transaction_index ti,l.log_index li,
   LOWER(l.address) emitter,l.topics,l.data,t.st,t.ti txIndex
 FROM \`${base}.logs\` l JOIN headers h ON h.number=l.block_number AND h.bh=LOWER(l.block_hash)
 LEFT JOIN tx t ON h.number=t.number AND h.bh=t.bh AND LOWER(l.transaction_hash)=t.th
 WHERE l.block_timestamp BETWEEN ${start} AND ${end} AND LOWER(l.topics[SAFE_OFFSET(0)]) IN (${topics})
), checked AS (
 SELECT *,COUNT(*) OVER(PARTITION BY bh,li) slotRows FROM raw_signal
), decoded AS (
 SELECT *,decode_swap(emitter,topics,data) d,
   STRUCT(number AS blockNumber,bh AS blockHash,th AS transactionHash,ti AS transactionIndex,li AS logIndex) witness,
   st IS NULL OR st!=1 OR ti IS NULL OR ti!=txIndex OR li IS NULL OR li<0 OR slotRows!=1 AS invalidReceipt
 FROM checked
), signals AS (
 SELECT emitter,d.poolId,d.layout,d.direction,d.decodeStatus,COUNT(*) observations,COUNTIF(invalidReceipt) invalidReceipts,
  ARRAY_AGG(witness ORDER BY number,ti,li LIMIT 1)[OFFSET(0)] firstWitness,
  ARRAY_AGG(witness ORDER BY number DESC,ti DESC,li DESC LIMIT 1)[OFFSET(0)] lastWitness
 FROM decoded GROUP BY emitter,d.poolId,d.layout,d.direction,d.decodeStatus
), event_counts AS (
 SELECT IFNULL(SUM(invalidReceipts),0) invalidReceipts,IFNULL(SUM(observations),0) matchedLogs,
  IFNULL(SUM(IF(decodeStatus='malformed',observations,0)),0) malformedLogs,
  IFNULL(SUM(IF(decodeStatus='uninterpretable',observations,0)),0) uninterpretableLogs
 FROM signals
)
SELECT 'coverage' AS row_kind,IF(blockRows=${hi-lo+1} AND distinctBlocks=${hi-lo+1} AND firstAnchor=1 AND headAnchor=1
    AND CAST(headerTx AS STRING)='${transactions}' AND sourceTx=headerTx AND badBlocks=0 AND invalidReceipts=0,
  TO_JSON_STRING(STRUCT(${lo} AS fromBlock,${hi} AS toBlock,'${headHash}' AS headHash,
    blockRows AS blocks,sourceTx AS transactions,matchedLogs,malformedLogs,uninterpretableLogs,
    IF(matchedLogs=0,'no matching signal','observed') AS signalStatus,FALSE AS absenceProven)),
  ERROR('Canonical source window, receipt, or log-index coverage check failed')) AS body
FROM chain_check CROSS JOIN event_counts
UNION ALL
SELECT 'signal' AS row_kind,TO_JSON_STRING(STRUCT('observed' AS signalStatus,FALSE AS absenceProven,
 emitter,poolId,layout,direction,decodeStatus,observations,firstWitness,lastWitness)) AS body FROM signals;`;
}
