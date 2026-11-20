-- Diagnostic for swap layouts in the pinned family-runtime catalog. No startup-table input.
CREATE TEMP FUNCTION addr(w STRING) AS (IF(REGEXP_CONTAINS(w,r'^0x0{24}[0-9a-f]{40}$'),CONCAT('0x',RIGHT(w,40)),NULL));
CREATE TEMP FUNCTION word(d STRING, i INT64) AS (SUBSTR(d,3+64*i,64));
CREATE TEMP FUNCTION signw(w STRING) AS (CASE WHEN w=REPEAT('0',64) THEN 0 WHEN LEFT(w,1) IN ('8','9','a','b','c','d','e','f') THEN -1 ELSE 1 END);
-- begin v3
CREATE TEMP FUNCTION mag(w STRING) RETURNS STRING LANGUAGE js AS r'''
 if(!w||!/^[0-9a-f]{64}$/.test(w))return null;
 if(parseInt(w[0],16)<8)return w;
 let r='',c=1;for(let i=63;i>=0;i--){let v=15-parseInt(w[i],16)+c;r=(v%16).toString(16)+r;c=v>>4;}return r;
''';
@V3_UDF
-- end v3
-- begin v2
@V2_UDF
-- end v2
-- begin v4
@KEY_UDF
-- end v4
WITH headers AS (SELECT number,LOWER(`hash`) AS bh,transaction_count AS n
 FROM `bigquery-public-data.crypto_ethereum.blocks` WHERE number BETWEEN @lo AND @hi AND timestamp BETWEEN @start AND @end),
source_tx AS (SELECT b.number,b.bh,b.n,LOWER(t.hash) th,t.transaction_index ti,t.receipt_status st,LOWER(t.to_address) txTo,t.input topLevelInput,
 IF(REGEXP_CONTAINS(LEFT(t.input,10),r'^0x[0-9A-Fa-f]{8}$'),LOWER(LEFT(t.input,10)),NULL) txSelector
 FROM `bigquery-public-data.crypto_ethereum.transactions` t JOIN headers b ON b.number=t.block_number AND b.bh=LOWER(t.block_hash)
 WHERE t.block_timestamp BETWEEN @start AND @end),
tx AS (SELECT * EXCEPT(topLevelInput) FROM source_tx WHERE st=1),
logs AS (SELECT t.*,l.log_index li,l.transaction_index logTi,LOWER(l.address) emitter,LOWER(l.topics[SAFE_OFFSET(0)]) topic0,l.topics,LOWER(l.data) d
 FROM `bigquery-public-data.crypto_ethereum.logs` l JOIN tx t ON t.number=l.block_number AND t.bh=LOWER(l.block_hash) AND t.th=LOWER(l.transaction_hash)
 WHERE l.block_timestamp BETWEEN @start AND @end@MANAGER_FILTER AND l.topics[SAFE_OFFSET(0)] IN (@READ_TOPICS)),
-- begin v2
@V2_CTES,
-- end v2
-- begin v3
flow AS (SELECT bh,th,li,emitter token,addr(topics[SAFE_OFFSET(1)]) src,addr(topics[SAFE_OFFSET(2)]) dst,word(d,0) amt
 FROM logs WHERE topic0=@TRANSFER AND ARRAY_LENGTH(topics)=3 AND REGEXP_CONTAINS(d,r'^0x[0-9a-f]{64}$') AND signw(word(d,0))!=0),
pair0 AS (SELECT *, COUNT(*) OVER(PARTITION BY bh,th,emitter) nswap,
 IF(signw(word(d,0))=1,word(d,0),word(d,1)) amtIn,
 mag(IF(signw(word(d,0))=-1,word(d,0),word(d,1))) amtOut
 FROM logs WHERE topic0 IN (@V3,@V3ALT) AND ARRAY_LENGTH(topics)=3
 AND LENGTH(d)=IF(topic0=@V3,322,450) AND signw(word(d,0))*signw(word(d,1))=-1),
pair AS (SELECT p.topic0,p.bh,p.th,p.li,p.txTo,p.txSelector,p.emitter AS address,CAST(NULL AS STRING) poolId,
 IF(COUNT(DISTINCT IF(f.dst=p.emitter AND f.amt=p.amtIn,f.token,NULL))=1,MAX(IF(f.dst=p.emitter AND f.amt=p.amtIn,f.token,NULL)),NULL) tokenIn,
 IF(COUNT(DISTINCT IF(f.src=p.emitter AND f.amt=p.amtOut,f.token,NULL))=1,MAX(IF(f.src=p.emitter AND f.amt=p.amtOut,f.token,NULL)),NULL) tokenOut,
 'swap+amount-matched-transfers' AS evidence,
 IF(MIN(signw(word(p.d,0)))=MAX(signw(word(p.d,0))),IF(MIN(signw(word(p.d,0)))>0,'asset0-in','asset1-in'),ERROR('conflicting swap direction at one log slot')) AS sourceDirection
 FROM pair0 p LEFT JOIN flow f ON p.nswap=1 AND p.bh=f.bh AND p.th=f.th AND f.li<p.li AND f.src!=f.dst
 AND f.src!='0x0000000000000000000000000000000000000000' AND f.dst!='0x0000000000000000000000000000000000000000'
 AND ((f.dst=p.emitter AND f.amt=p.amtIn) OR (f.src=p.emitter AND f.amt=p.amtOut))
 GROUP BY p.topic0,p.bh,p.th,p.li,p.txTo,p.txSelector,p.emitter),
@V3_CTES,
pair_with_receipt AS (
 SELECT p.topic0,p.bh,p.th,p.li,p.txTo,p.txSelector,p.address,p.poolId,
  COALESCE(v.tokenIn,p.tokenIn) tokenIn,COALESCE(v.tokenOut,p.tokenOut) tokenOut,
  COALESCE(v.evidence,p.evidence) evidence,p.sourceDirection
 FROM pair p LEFT JOIN v3_receipt_pair_proofs v ON p.bh=v.bh AND p.th=v.th AND p.li=v.li AND p.address=v.address AND p.topic0=v.topic0
 AND (v.evidence!=@V3_LINEAGE_TAG OR ((p.tokenIn IS NULL OR p.tokenOut IS NULL)
   AND (p.tokenIn IS NULL OR p.tokenIn=v.tokenIn) AND (p.tokenOut IS NULL OR p.tokenOut=v.tokenOut)))),
-- end v3
-- begin v4
@V4_CTES,
v4_valid_swaps AS (SELECT s.*,LOWER(s.topics[SAFE_OFFSET(1)]) poolId
 FROM v4_checked s
 WHERE s.validReceipt AND s.emitter=@MANAGER AND s.topic0=@V4 AND ARRAY_LENGTH(s.topics)=3
 AND REGEXP_CONTAINS(s.topics[SAFE_OFFSET(1)],r'^0x[0-9a-f]{64}$') AND addr(s.topics[SAFE_OFFSET(2)]) IS NOT NULL
 AND REGEXP_CONTAINS(s.d,r'^0x[0-9a-f]{384}$') AND signw(word(s.d,0))*signw(word(s.d,1))=-1
 AND REGEXP_CONTAINS(word(s.d,0),r'^(?:0{32}[0-7]|f{32}[89a-f])') AND REGEXP_CONTAINS(word(s.d,1),r'^(?:0{32}[0-7]|f{32}[89a-f])')
 AND STARTS_WITH(word(s.d,2),REPEAT('0',24)) AND STARTS_WITH(word(s.d,3),REPEAT('0',32))
 AND REGEXP_CONTAINS(word(s.d,4),r'^(?:0{58}[0-7]|f{58}[89a-f])') AND STARTS_WITH(word(s.d,5),REPEAT('0',58))),
@KEY_CTES
v4 AS (SELECT s.topic0,s.bh,s.th,s.li,s.txTo,s.txSelector,s.emitter address,s.poolId,
 @V4_ASSETS,
 IF(signw(word(s.d,0))=-1,'asset0-in','asset1-in') sourceDirection FROM v4_valid_swaps s@KEY_JOIN),
-- end v4
-- begin bal
bal AS (SELECT topic0,bh,th,li,txTo,txSelector,LEFT(LOWER(topics[SAFE_OFFSET(1)]),42) address,LOWER(topics[SAFE_OFFSET(1)]) poolId,
 addr(topics[SAFE_OFFSET(2)]) tokenIn,addr(topics[SAFE_OFFSET(3)]) tokenOut,'explicit-swap-event' evidence
 FROM logs WHERE emitter=@VAULT AND topic0=@BAL AND ARRAY_LENGTH(topics)=4 AND LENGTH(d)=130 AND signw(word(d,0))!=0 AND signw(word(d,1))!=0),
-- end bal
events AS (@EVENT_ROWS),
projected AS (SELECT topic0,txTo,txSelector,address,poolId,tokenIn,tokenOut,evidence,COUNT(*) observations,sourceDirection
 FROM events GROUP BY topic0,txTo,txSelector,address,poolId,tokenIn,tokenOut,evidence,sourceDirection),
result AS (SELECT 'event' AS kind,IF(sourceDirection IS NULL,
 TO_JSON_STRING(STRUCT(topic0,txTo,txSelector,address,poolId,tokenIn,tokenOut,evidence,observations)),TO_JSON_STRING(p)) AS body FROM projected p UNION ALL
 SELECT 'coverage',TO_JSON_STRING(STRUCT(COUNT(*) AS blocks,COUNT(DISTINCT number) AS distinctBlocks,SUM(n) AS transactions,
 ARRAY_AGG(bh ORDER BY number DESC LIMIT 1)[OFFSET(0)] AS headHash,(SELECT COUNT(*) FROM events) AS observations)) FROM headers)
SELECT * FROM result ORDER BY kind,body
