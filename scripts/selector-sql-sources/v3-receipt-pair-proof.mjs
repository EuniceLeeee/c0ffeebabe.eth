// Independent historical evidence source. It does not infer the call selector
// or adopt a Family because an event happens to have the standard Swap ABI.
import assert from 'node:assert/strict';
import {renderV3ReceiptAddressUdf,sushiV3ReceiptFactory,v3LineageReceiptEvidence} from './v3-factory-assets.mjs';

const manager='0x1f98431c8ad98523631ae4a59f267346ea31f984';
const swap='0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67';
const transfer='0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const zero='0x'+'0'.repeat(40);
// Hypotheses, not a claim that all factory fee tiers are covered. A tier is
// returned only when its full CREATE2 address equals the emitting pool.
const fees=['100','500','3000','10000'];
function time(t){assert(typeof t==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/.test(t)&&Number.isFinite(Date.parse(t)),'invalid window timestamp');return "TIMESTAMP('"+t+"')";}
/** Requires logs and source_tx CTEs from the canonical receipt input; the
 * caller validates pinned chain/window coverage before publishing any rows.
 * Declare returned address UDF once. The
 * v3_receipt_pair_proofs CTE emits only positively authenticated per-log rows.
 * A transfer anywhere in this receipt can nominate an immutable currency,
 * never direction, magnitude, or chronological attribution to a particular
 * swap. Direction is exclusively the strict opposite signed Swap amounts.
 */
export async function renderV3ReceiptPairProof({chainId=1,fromBlock:lo,toBlock:hi,firstTime,lastTime}){
  assert.equal(arguments.length,1,'receipt-only query accepts the window and no auxiliary input');
  assert.equal(chainId,1,'mainnet factory only');assert(Number.isSafeInteger(lo)&&Number.isSafeInteger(hi)&&lo>0&&lo<=hi,'invalid block range');
  const start=time(firstTime),end=time(lastTime);assert(firstTime<=lastTime,'invalid time range');
  const udf=await renderV3ReceiptAddressUdf();
  const ctes=`v3p_keys AS (
 SELECT DISTINCT bh,th FROM logs WHERE topic0='${swap}'
), v3p_receipt AS (
 SELECT DISTINCT number,bh,th,ti,logTi,n,li,txTo,txSelector,emitter,topic0,topics,d
 FROM logs JOIN v3p_keys USING(bh,th) WHERE topic0 IN ('${swap}','${transfer}')
), v3p_slots AS (
 SELECT k.bh,k.li,COUNT(DISTINCT TO_JSON_STRING(STRUCT(l.transaction_hash,l.transaction_index,l.address,l.topics,l.data))) cnt
 FROM \`bigquery-public-data.crypto_ethereum.logs\` l JOIN (SELECT DISTINCT bh,li FROM v3p_receipt) k
  ON LOWER(l.block_hash)=k.bh AND l.log_index=k.li
 WHERE l.block_number BETWEEN ${lo} AND ${hi} AND l.block_timestamp BETWEEN ${start} AND ${end} GROUP BY k.bh,k.li
), v3p_tx AS (
 SELECT t.bh,t.th,COUNT(*) ct,COUNTIF(t.st=1) successes FROM source_tx t JOIN v3p_keys USING(bh,th) GROUP BY t.bh,t.th
), v3p_mark AS (
 SELECT r.*,IFNULL(ct=1 AND successes=1 AND cnt=1 AND li>=0 AND ti=logTi AND ti>=0 AND ti<n
 AND REGEXP_CONTAINS(th,r'^0x[0-9a-f]{64}$') AND REGEXP_CONTAINS(bh,r'^0x[0-9a-f]{64}$'),FALSE) valid
 FROM v3p_receipt r LEFT JOIN v3p_tx USING(bh,th) LEFT JOIN v3p_slots USING(bh,li)
), v3p_clean AS (
 SELECT * FROM (SELECT *,COUNTIF(NOT valid) OVER(PARTITION BY bh,th) badRows FROM v3p_mark) WHERE badRows=0
), v3p_flow AS (
 SELECT bh,th,emitter token,CONCAT('0x',RIGHT(LOWER(topics[SAFE_OFFSET(1)]),40)) src,
  CONCAT('0x',RIGHT(LOWER(topics[SAFE_OFFSET(2)]),40)) dst
 FROM v3p_clean WHERE topic0='${transfer}' AND ARRAY_LENGTH(topics)=3 AND REGEXP_CONTAINS(emitter,r'^0x[0-9a-f]{40}$')
  AND emitter!='${zero}' AND REGEXP_CONTAINS(LOWER(topics[SAFE_OFFSET(1)]),r'^0x0{24}[0-9a-f]{40}$')
  AND REGEXP_CONTAINS(LOWER(topics[SAFE_OFFSET(2)]),r'^0x0{24}[0-9a-f]{40}$')
  AND REGEXP_CONTAINS(d,r'^0x[0-9a-f]{64}$') AND d!=CONCAT('0x',REPEAT('0',64))
), v3p_swaps AS (
 SELECT *,SUBSTR(d,3,64) a0,SUBSTR(d,67,64) a1 FROM v3p_clean
 WHERE topic0='${swap}' AND ARRAY_LENGTH(topics)=3 AND emitter!='${zero}' AND REGEXP_CONTAINS(emitter,r'^0x[0-9a-f]{40}$')
 AND REGEXP_CONTAINS(LOWER(topics[SAFE_OFFSET(1)]),r'^0x0{24}[0-9a-f]{40}$') AND REGEXP_CONTAINS(LOWER(topics[SAFE_OFFSET(2)]),r'^0x0{24}[0-9a-f]{40}$')
 AND REGEXP_CONTAINS(d,r'^0x[0-9a-f]{128}0{24}[0-9a-f]{40}0{32}[0-9a-f]{32}(0{58}[0-7]|f{58}[89a-f])[0-9a-f]{5}$')
), v3p_signed AS (
 SELECT *,REGEXP_CONTAINS(a0,r'^[0-7]') asset0In FROM v3p_swaps
 WHERE a0!=REPEAT('0',64) AND a1!=REPEAT('0',64) AND REGEXP_CONTAINS(a0,r'^[0-7]')!=REGEXP_CONTAINS(a1,r'^[0-7]')
), v3p_assets AS (
 SELECT DISTINCT s.bh,s.th,s.emitter,f.token
 FROM (SELECT DISTINCT bh,th,emitter FROM v3p_signed) s JOIN v3p_flow f USING(bh,th)
 WHERE f.src!=f.dst AND f.src!='${zero}' AND f.dst!='${zero}' AND s.emitter IN (f.src,f.dst)
), v3p_bounded AS (
 SELECT * FROM (SELECT *,COUNT(*) OVER(PARTITION BY bh,th,emitter) hints FROM v3p_assets) WHERE hints BETWEEN 2 AND 8
), v3p_pairs AS (
 SELECT a.bh,a.th,a.emitter,a.token token0,b.token token1 FROM v3p_bounded a JOIN v3p_bounded b USING(bh,th,emitter) WHERE a.token<b.token
), v3p_verified AS (
 SELECT h.emitter,h.token0,h.token1,fee,f.factory FROM (SELECT DISTINCT emitter,token0,token1 FROM v3p_pairs) h
 CROSS JOIN UNNEST([${fees.map(x=>"'"+x+"'").join(',')}]) fee
 CROSS JOIN (SELECT '${manager}' factory UNION ALL SELECT '${sushiV3ReceiptFactory}') f
 WHERE v3FactoryExpectedPool(f.factory,h.token0,h.token1,fee)=h.emitter
), v3p_preferred AS (
 SELECT p.bh,p.th,p.emitter,p.token0,p.token1,v.fee,v.factory,
 MAX(IF(v.factory='${manager}',1,0)) OVER(PARTITION BY p.bh,p.th,p.emitter) hasPrimary
 FROM v3p_pairs p JOIN v3p_verified v USING(emitter,token0,token1)
), v3p_identity AS (
 SELECT bh,th,emitter,MIN(token0) token0,MIN(token1) token1,MIN(fee) fee,MIN(factory) factory FROM v3p_preferred
 WHERE hasPrimary=0 OR factory='${manager}' GROUP BY bh,th,emitter HAVING COUNT(*)=1
), v3_receipt_pair_proofs AS (
 SELECT s.number,s.bh,s.th,s.ti,s.li,s.txTo,s.txSelector,s.topic0,s.emitter AS address,CAST(NULL AS STRING) poolId,
  IF(s.asset0In,i.token0,i.token1) tokenIn,IF(s.asset0In,i.token1,i.token0) tokenOut,
  i.token0,i.token1,i.fee,IF(i.factory='${manager}','swap+v3-receipt-create2','${v3LineageReceiptEvidence.tag}') AS evidence
 FROM v3p_signed s JOIN v3p_identity i USING(bh,th,emitter)
)`;
  return {udf,ctes};
}
