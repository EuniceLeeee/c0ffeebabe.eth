import assert from 'node:assert/strict';
import {canonicalSwapTopics} from './canonical-swap-census.mjs';
import {v4MainnetManager} from './v4-history.mjs';
// The verified key belongs to the Manager. A third-party wrapper that also
// subscribes to its Swap topic is not established by the Manager receipt.
export const v4SiblingReceiptEvidence=Object.freeze({tag:'swap+sibling-packed-poolkey-hash',selector:'0x48c89491'});
export const v4TransferPairReceiptEvidence=Object.freeze({tag:'swap+erc20-pair-transfer-poolkey-hash',selector:'0x48c89491'});
export const v4WindowPoolKeyEvidence=Object.freeze({tag:'swap+window-scoped-poolkey-hash',selector:'0x48c89491'});

// A PoolKey authenticates currencies, not a receipt's direction, ABI entry
// point, or caller. Include the *raw* scoped and older proofs before grouping:
// dropping a conflicting source before pooling would manufacture consensus.
export function v4ReceiptKeyConsensus(){
 const sources=[
  ['v4_calldata_evidence','swap+calldata-poolkey-hash',false],
  ['v4_native_receipt_evidence','swap+native-transfer-poolkey-hash',false],
  ['v4_native_packed_evidence','swap+native-packed-poolkey-hash',false],
  ['v4_native_input_evidence','swap+native-input-poolkey-hash',false],
  ['v4_sibling_packed_evidence',v4SiblingReceiptEvidence.tag,true],
  ['v4_transfer_pair_evidence',v4TransferPairReceiptEvidence.tag,true],
 ];
 const raw=sources.map(([table,,scoped],i)=>
  `SELECT ${scoped?'bh,th':'CAST(NULL AS STRING) bh,CAST(NULL AS STRING) th'},manager,poolId,c0,c1,preimage,${i+1} priority FROM ${table}`);
 return `v4_key_inputs AS (
 ${raw.join('\n UNION ALL\n ')}
 UNION ALL
 SELECT DISTINCT bh,th,emitter manager,poolId,CAST(NULL AS STRING) c0,CAST(NULL AS STRING) c1,CAST(NULL AS STRING) preimage,0 priority FROM v4_valid_swaps
), v4_key_contexts AS (
 SELECT bh,th,manager,poolId,COUNTIF(priority=0)>0 hasSwap,COUNTIF(priority>0) claims,
 COUNT(DISTINCT preimage) nImages,MIN(preimage) image,MIN(IF(priority>0,priority,NULL)) best,
 COUNTIF(priority>0 AND NOT IFNULL(v4ReceiptKeyId(preimage)=poolId AND c0=CONCAT('0x',SUBSTR(preimage,25,40))
 AND c1=CONCAT('0x',SUBSTR(preimage,89,40)),FALSE)) bad
 FROM v4_key_inputs GROUP BY bh,th,manager,poolId
), v4_key_windows AS (
 SELECT c.*,MAX(IF(bh IS NULL AND bad=0 AND nImages=1,image,NULL)) OVER pool priorImage,
 MAX(IF(bh IS NULL AND bad=0 AND nImages=1,best,NULL)) OVER pool priorRank,
 MIN(image) OVER pool loImage,MAX(image) OVER pool hiImage,
 MAX(IF(claims>0 AND (bad>0 OR nImages!=1 OR (bh IS NOT NULL AND NOT hasSwap)),1,0)) OVER pool conflict,
 MAX(IF(bh IS NOT NULL AND claims>0 AND hasSwap,1,0)) OVER pool hasScoped
 FROM v4_key_contexts c WINDOW pool AS (PARTITION BY manager,poolId)
), v4_key_policy AS (
 SELECT *,CASE WHEN priorImage IS NOT NULL THEN priorRank WHEN bad=0 AND nImages=1 THEN best
 WHEN hasScoped=1 AND conflict=0 AND loImage=hiImage THEN 7 END chosen
 FROM v4_key_windows WHERE hasSwap
), v4_key_selected AS (
 SELECT bh,th,manager,poolId,chosen,
 CASE WHEN chosen BETWEEN 1 AND 4 THEN priorImage WHEN chosen BETWEEN 5 AND 6 THEN image ELSE loImage END selected
 FROM v4_key_policy WHERE chosen IS NOT NULL
), v4_scoped_receipt_keys AS (
 SELECT bh,th,manager,poolId,CONCAT('0x',SUBSTR(selected,25,40)) c0,CONCAT('0x',SUBSTR(selected,89,40)) c1,
 CASE chosen ${sources.map(([,tag],i)=>`WHEN ${i+1} THEN '${tag}'`).join(' ')} ELSE '${v4WindowPoolKeyEvidence.tag}' END evidence
 FROM v4_key_selected
)`;
}

// A receipt is evidence of this Manager's Swap and its signed amounts. The
// logical pool ID is part of the event, but neither currency address is.
export function receiptV4Source() {
  assert.equal(arguments.length,0,'V4 Swap source does not accept auxiliary tables');
  return {ctes:`v4_rows AS (
  SELECT DISTINCT number,bh,th,ti,logTi,n,li,txTo,txSelector,emitter,topic0,topics,d FROM logs
  WHERE emitter='${v4MainnetManager}' AND topic0='${canonicalSwapTopics.v4}'
 ), v4_txcheck AS (
  SELECT t.bh,t.th,COUNT(*) receipts,COUNTIF(t.st=1) successes
  FROM source_tx t JOIN (SELECT DISTINCT bh,th FROM v4_rows) k USING(bh,th) GROUP BY t.bh,t.th
 ), v4_checked AS (
  SELECT l.*,IFNULL(receipts=1 AND successes=1 AND l.li>=0 AND l.logTi=l.ti AND l.ti>=0 AND l.ti<l.n
   AND REGEXP_CONTAINS(l.th,r'^0x[0-9a-f]{64}$') AND COUNT(*) OVER(PARTITION BY l.bh,l.li)=1,FALSE) AS validReceipt
  FROM v4_rows l LEFT JOIN v4_txcheck USING(bh,th)
 )`};
}
