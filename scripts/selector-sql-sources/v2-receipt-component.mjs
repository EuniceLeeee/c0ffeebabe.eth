// Receipt enrichment for the registered V2 Swap layout. A different factory
// with the same ABI still uses the previous single-swap amount-matching path.
import assert from 'node:assert/strict';
import {renderV2PairUdf,renderV2LineagePairUdf} from './v2-pair-assets.mjs';
const swap='0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822';
const transfer='0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const zero="'0x0000000000000000000000000000000000000000'";
// Address-shaped words are nominations only. Never interpret the first four
// bytes as an inner call or infer the semantics of any word. Over either cap
// abstain on the *whole* input, never authenticate against a truncated set.
function alignedCandidates(input){
 if(typeof input!=='string'||input.length<74||input.length>2+2*24576||input.length%2!==0||!input.startsWith('0x')||
    /[^0-9a-f]/i.test(input.slice(2)))return [];
 const hints=new Set();
 for(let i=10;i+64<=input.length;i+=64){
   const w=input.slice(i,i+64).toLowerCase();
   if(w.startsWith('0'.repeat(24))&&w!=='0'.repeat(64))hints.add('0x'+w.slice(24));
   if(hints.size>192)return [];
 }
 return Array.from(hints);
}
const outerUdf=`CREATE TEMP FUNCTION v2OuterAlignedHints(outerInput STRING) RETURNS ARRAY<STRING> LANGUAGE js AS r'''
${alignedCandidates.toString()}
return alignedCandidates(outerInput);
''';`;
export async function renderV2ReceiptComponent(win){
 const {chainId=1,fromBlock:lo,toBlock:hi}=win;
 assert.equal(chainId,1,'mainnet V2 factory only');
 assert(Number.isSafeInteger(lo)&&Number.isSafeInteger(hi)&&lo>0&&hi>=lo,'invalid V2 block pins');
 const ts=x=>{if(typeof x!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/.test(x)||!Number.isFinite(Date.parse(x)))throw Error('invalid V2 time pin');return "TIMESTAMP('"+x+"')";};
 const start=ts(win.firstTime),end=ts(win.lastTime);
 // In v2_match, nine is an overflow sentinel; never search a truncated subset of a larger receipt.
 const ctes=`v2_txkeys AS (
 SELECT DISTINCT bh,th FROM logs
 WHERE topic0='${swap}'
), v2_receipt_rows AS (
 SELECT DISTINCT number,bh,th,ti,logTi,n,li,txTo,txSelector,emitter,topic0,topics,d FROM logs JOIN v2_txkeys USING(bh,th)
 WHERE topic0 IN ('${swap}','${transfer}')
), v2_slotcheck AS (
 SELECT s.bh,s.li,COUNT(DISTINCT TO_JSON_STRING(STRUCT(l.transaction_hash,l.transaction_index,l.address,l.topics,l.data))) slotRows
 FROM \`bigquery-public-data.crypto_ethereum.logs\` l JOIN (SELECT DISTINCT bh,li FROM v2_receipt_rows) s
 ON LOWER(l.block_hash)=s.bh AND l.log_index=s.li
 WHERE l.block_number BETWEEN ${lo} AND ${hi} AND l.block_timestamp BETWEEN ${start} AND ${end} GROUP BY s.bh,s.li
), v2_tx_ok AS (
 SELECT t.bh,t.th,COUNT(*) ct,COUNTIF(t.st=1) successes FROM source_tx t
 JOIN v2_txkeys g USING(bh,th) GROUP BY t.bh,t.th
), v2_validated AS (
 SELECT v.*,COUNTIF(topic0='${swap}') OVER(PARTITION BY bh,th,emitter) nswap,IFNULL(ct=1 AND successes=1 AND li>=0 AND ti=logTi AND ti>=0 AND ti<n
 AND REGEXP_CONTAINS(th,r'^0x[0-9a-f]{64}$') AND slotRows=1,FALSE) ok
 FROM v2_receipt_rows v LEFT JOIN v2_tx_ok USING(bh,th) LEFT JOIN v2_slotcheck USING(bh,li)
), v2_checked AS (
 SELECT *,COUNTIF(topic0='${transfer}' AND NOT ok) OVER(PARTITION BY bh,th)=0 cleanFlowReceipt FROM v2_validated
), v2_flow AS (
 SELECT bh,th,li,emitter token,addr(topics[SAFE_OFFSET(1)]) src,addr(topics[SAFE_OFFSET(2)]) dst,word(d,0) amt
 FROM v2_checked WHERE ok AND cleanFlowReceipt AND topic0='${transfer}' AND ARRAY_LENGTH(topics)=3
 AND REGEXP_CONTAINS(emitter,r'^0x[0-9a-f]{40}$') AND REGEXP_CONTAINS(d,r'^0x[0-9a-f]{64}$') AND word(d,0)!=REPEAT('0',64)
), v2_classified_flow AS (
 SELECT *,src!=${zero} AND dst!=${zero} ordinary FROM v2_flow
), v2_words AS (
 SELECT *,word(d,0) i0,word(d,1) i1,word(d,2) o0,word(d,3) o1
 FROM v2_checked WHERE ok AND topic0='${swap}' AND ARRAY_LENGTH(topics)=3 AND addr(topics[SAFE_OFFSET(1)]) IS NOT NULL
 AND addr(topics[SAFE_OFFSET(2)]) IS NOT NULL AND REGEXP_CONTAINS(d,r'^0x[0-9a-f]{256}$')
), v2_swaps AS (
 SELECT *,i0!=REPEAT('0',64) asset0In,IF(i0!=REPEAT('0',64),i0,i1) amtIn,IF(o0!=REPEAT('0',64),o0,o1) amtOut FROM v2_words
 WHERE (i0!=REPEAT('0',64) AND i1=REPEAT('0',64) AND o0=REPEAT('0',64) AND o1!=REPEAT('0',64))
 OR (i0=REPEAT('0',64) AND i1!=REPEAT('0',64) AND o0!=REPEAT('0',64) AND o1=REPEAT('0',64))
), v2_match AS (
 SELECT p.topic0,p.bh,p.th,p.li,p.txTo,p.txSelector,p.emitter address,p.asset0In,
 ARRAY_AGG(DISTINCT IF(f.ordinary,f.token,NULL) IGNORE NULLS LIMIT 9) hinted,
 ARRAY_AGG(DISTINCT f.token IGNORE NULLS LIMIT 9) allHints,
 COUNTIF(NOT f.ordinary AND f.token!=${zero})>0 hasIssuance,
 IF(p.nswap=1 AND COUNT(DISTINCT IF(f.ordinary AND f.dst=p.emitter AND f.amt=p.amtIn,f.token,NULL))=1,MAX(IF(f.ordinary AND f.dst=p.emitter AND f.amt=p.amtIn,f.token,NULL)),NULL) legacyIn,
 IF(p.nswap=1 AND COUNT(DISTINCT IF(f.ordinary AND f.src=p.emitter AND f.amt=p.amtOut,f.token,NULL))=1,MAX(IF(f.ordinary AND f.src=p.emitter AND f.amt=p.amtOut,f.token,NULL)),NULL) legacyOut
 FROM v2_swaps p LEFT JOIN v2_classified_flow f ON f.bh=p.bh AND f.th=p.th AND f.li<p.li AND f.src!=f.dst
  AND (f.src=p.emitter OR f.dst=p.emitter)
 GROUP BY p.topic0,p.bh,p.th,p.li,p.txTo,p.txSelector,p.emitter,p.asset0In,p.nswap
), v2_auth AS (
 SELECT m.*,CASE WHEN ARRAY_LENGTH(hinted)=2 THEN
   IF(v2ExpectedPair(hinted[SAFE_OFFSET(0)],hinted[SAFE_OFFSET(1)])=address,hinted,NULL)
 WHEN ARRAY_LENGTH(hinted) BETWEEN 3 AND 8 THEN
   (SELECT IF(COUNT(*)=1,[MIN(a),MIN(b)],NULL) FROM UNNEST(hinted) a CROSS JOIN UNNEST(hinted) b
    WHERE IF(a<b,v2ExpectedPair(a,b)=m.address,FALSE))
 WHEN ARRAY_LENGTH(hinted)=1 THEN
   (SELECT IF(COUNT(*)=1,[m.hinted[SAFE_OFFSET(0)],MIN(nominee)],NULL) FROM UNNEST(v2OuterAlignedHints(t.topLevelInput)) nominee
    WHERE IF(nominee!=m.hinted[SAFE_OFFSET(0)],v2ExpectedPair(m.hinted[SAFE_OFFSET(0)],nominee)=m.address,FALSE))
 END verifiedHints
 FROM v2_match m LEFT JOIN source_tx t ON ARRAY_LENGTH(m.hinted)=1 AND t.st=1 AND m.bh=t.bh AND m.th=t.th
), v2_issuance_auth AS (
 SELECT m.*,CASE WHEN verifiedHints IS NOT NULL THEN verifiedHints
 WHEN hasIssuance AND (legacyIn IS NULL OR legacyOut IS NULL) AND ARRAY_LENGTH(allHints) BETWEEN 2 AND 8 THEN
  (SELECT IF(COUNT(*)=1,[MIN(a),MIN(b)],NULL) FROM UNNEST(allHints) a CROSS JOIN UNNEST(allHints) b
   WHERE IF(a<b,v2ExpectedPair(a,b)=m.address,FALSE))
 END finalHints FROM v2_auth m
), v2_lineage_auth AS (
 SELECT m.*,CASE WHEN finalHints IS NOT NULL THEN finalHints
 WHEN legacyIn IS NULL OR legacyOut IS NULL THEN CASE
  WHEN ARRAY_LENGTH(hinted)=2 THEN IF(v2LineageExpectedPair(hinted[SAFE_OFFSET(0)],hinted[SAFE_OFFSET(1)])=address,hinted,NULL)
  WHEN ARRAY_LENGTH(hinted) BETWEEN 3 AND 8 THEN
  (SELECT IF(COUNT(*)=1,[MIN(a),MIN(b)],NULL) FROM UNNEST(hinted) a CROSS JOIN UNNEST(hinted) b
   WHERE IF(a<b,v2LineageExpectedPair(a,b)=m.address,FALSE))
 END END namedHints FROM v2_issuance_auth m
), v2_resolved AS (
 SELECT topic0,bh,th,li,txTo,txSelector,address,CAST(NULL AS STRING) poolId,
 CASE WHEN namedHints IS NOT NULL THEN
 IF(asset0In,LEAST(namedHints[OFFSET(0)],namedHints[OFFSET(1)]),GREATEST(namedHints[OFFSET(0)],namedHints[OFFSET(1)])) ELSE legacyIn END tokenIn,
 CASE WHEN namedHints IS NOT NULL THEN
 IF(asset0In,GREATEST(namedHints[OFFSET(0)],namedHints[OFFSET(1)]),LEAST(namedHints[OFFSET(0)],namedHints[OFFSET(1)])) ELSE legacyOut END tokenOut,
 CASE WHEN verifiedHints IS NOT NULL AND ARRAY_LENGTH(hinted)=1 THEN 'swap+v2-transfer-calldata-create2'
 WHEN verifiedHints IS NOT NULL THEN 'swap+v2-receipt-create2' WHEN finalHints IS NOT NULL THEN 'swap+v2-issuance-receipt-create2'
 WHEN namedHints IS NOT NULL THEN 'swap+v2-lineage-receipt-create2'
 ELSE 'swap+amount-matched-transfers' END evidence,
 IF(asset0In,'asset0-in','asset1-in') sourceDirection
 FROM v2_lineage_auth
)`;
 return {udf:(await Promise.all([renderV2PairUdf(),renderV2LineagePairUdf()])).join('\n')+'\n'+outerUdf,ctes};
}
