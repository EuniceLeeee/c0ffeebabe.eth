import assert from 'node:assert/strict';
import {renderVaultRootUdf,vaultRootSelectors} from './selector-sql-sources/vault-root-directions.mjs';

const source = 'bigquery-public-data.crypto_ethereum';

function normalizedSelectors(values) {
  assert(Array.isArray(values) && values.every(s => typeof s === 'string' && /^0x[0-9a-f]{8}$/i.test(s)),
    'Invalid catalog selector');
  return [...new Set(values.map(s => s.toLowerCase()))].sort();
}

export function selectorWindowTopLevelSelectors(rules) {
  assert(Array.isArray(rules) && rules.every(r => r && Array.isArray(r.callPatterns)), 'Invalid discovery rules');
  return normalizedSelectors(rules.flatMap(r => r.callPatterns.map(p => p.selector)));
}

function timestamp(value) {
  assert(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(value)
    && Number.isFinite(Date.parse(value)), 'Invalid canonical timestamp');
  return "TIMESTAMP('" + value + "')";
}

/** A no-trace production-UDF projection for the public indexed Ethereum tables.
 * Push only the UDF's exact no-trace early return into SQL. The query checks
 * that the pushed selector set actually agrees with the loaded library, so
 * one obsolete catalog entry cannot silently exclude successful directions.
 */
export function renderSelectorWindowCallsSql({window, selectors, libraries, singleTxBlockSize}) {
  const keys = normalizedSelectors(selectors);
  assert(Array.isArray(libraries) && libraries.length && libraries.every(x => typeof x === 'string'
    && /^gs:\/\/[a-z0-9_.-]+\/mev-discovery-json-check\/[0-9a-f]{64}\/[a-z0-9-]+\.js$/.test(x)), 'Invalid discovery UDF resources');
  const {fromBlock, toBlock, firstTime, lastTime, headHash, transactions} = window;
  assert(Number.isSafeInteger(fromBlock) && Number.isSafeInteger(toBlock) && fromBlock>0 && fromBlock<=toBlock, 'Invalid block range');
  assert(typeof headHash==='string' && /^0x[0-9a-f]{64}$/.test(headHash), 'Invalid pinned head hash');
  assert(typeof transactions==='string' && /^(0|[1-9]\d*)$/.test(transactions), 'Missing canonical transaction count');
  const from=timestamp(firstTime),to=timestamp(lastTime);
  assert(firstTime<=lastTime, 'Invalid time range');
  const keyList='ARRAY<STRING>[' + keys.map(x=>"'"+x+"'").join(',') + ']';
  const options='OPTIONS (library = [' + libraries.map(x=>JSON.stringify(x)).join(', ') + '])';
  const rootKeys=keys.filter(k=>vaultRootSelectors.includes(k));
  if(singleTxBlockSize!==undefined)assert(fromBlock===toBlock&&transactions==='1'&&Number.isSafeInteger(singleTxBlockSize)&&singleTxBlockSize>0,'invalid single-transaction block size');
  // Only the supplemental proofs require canonical receipt positions checked
  // across the entire block. This does not change which legacy rows execute.
  const rootSource=rootKeys.length?`direct_tx AS (
 SELECT checked.block_number,checked.block_hash,checked.tx_hash,checked.transaction_index
 FROM (SELECT t.*,COUNT(*) OVER(PARTITION BY t.block_number,t.block_hash,t.transaction_index) posCopies,
   COUNT(*) OVER(PARTITION BY t.block_number,t.block_hash,t.tx_hash) hashCopies FROM tx t) checked
 JOIN headers h ON h.number=checked.block_number AND h.block_hash=checked.block_hash
 WHERE posCopies=1 AND hashCopies=1 AND checked.transaction_index>=0 AND checked.transaction_index<${singleTxBlockSize??'h.transaction_count'}
 AND checked.receipt_status=1 AND LOWER(LEFT(checked.input,10)) IN UNNEST(ARRAY<STRING>[${rootKeys.map(s=>"'"+s+"'").join(',')}])
), direct_block_slots AS (
 SELECT l.block_number,LOWER(l.block_hash) block_hash,l.log_index,COUNT(*) copies,MIN(LOWER(l.transaction_hash)) tx_hash,MIN(l.transaction_index) ti
 FROM \`${source}.logs\` l JOIN (SELECT DISTINCT block_number,block_hash FROM direct_tx) b
 ON b.block_number=l.block_number AND b.block_hash=LOWER(l.block_hash)
 WHERE l.block_timestamp BETWEEN ${from} AND ${to} GROUP BY l.block_number,LOWER(l.block_hash),l.log_index
), direct_checked AS (
 SELECT i.block_number,i.block_hash,i.tx_hash,i.transaction_index
 FROM inputs i JOIN direct_tx USING(block_number,block_hash,tx_hash,transaction_index)
 CROSS JOIN UNNEST(i.logs) l LEFT JOIN direct_block_slots s
 ON i.block_number=s.block_number AND i.block_hash=s.block_hash AND l.log_index=s.log_index
 GROUP BY i.block_number,i.block_hash,i.tx_hash,i.transaction_index HAVING
 COUNTIF(NOT IFNULL(l.log_index>=0 AND s.copies=1 AND s.tx_hash=i.tx_hash AND s.ti=i.transaction_index,FALSE))=0
 AND COUNT(*)=COUNT(DISTINCT l.log_index) AND MAX(l.log_index)-MIN(l.log_index)+1=COUNT(*)
), `:'';
  return `CREATE TEMP FUNCTION direction_edges(tx STRING)
RETURNS STRING LANGUAGE js ${options}
AS r'''return DiscoveryKernel.directionEdgesJson(tx);''';
${rootKeys.length?renderVaultRootUdf(options):''}
CREATE TEMP FUNCTION library_call_selectors()
RETURNS ARRAY<STRING> LANGUAGE js ${options}
AS r'''const rows = DiscoveryKernel.rules().flatMap(r => r.callPatterns.map(p => p.selector.toLowerCase()));
return Array.from(new Set(rows)).sort();''';
WITH headers AS (
  SELECT number, LOWER(\`hash\`) AS block_hash, transaction_count
  FROM \`${source}.blocks\`
  WHERE number BETWEEN ${fromBlock} AND ${toBlock} AND timestamp BETWEEN ${from} AND ${to}
), tx AS (
  SELECT LOWER(t.\`hash\`) AS tx_hash, t.block_number, h.block_hash, t.transaction_index, t.receipt_status,
    LOWER(t.from_address) AS from_address, LOWER(t.to_address) AS to_address, t.input, CAST(t.value AS STRING) AS value
  FROM \`${source}.transactions\` t JOIN headers h
    ON t.block_number=h.number AND LOWER(t.block_hash)=h.block_hash
  WHERE t.block_timestamp BETWEEN ${from} AND ${to}
), eligible AS (
  SELECT * FROM tx WHERE receipt_status=1 AND LOWER(LEFT(input,10)) IN UNNEST(${keyList})
), log_rows AS (
  SELECT e.tx_hash, e.block_hash,
    ARRAY_AGG(STRUCT(l.log_index, LOWER(l.address) AS log_address, l.topics, l.data) ORDER BY l.log_index) AS logs
  FROM \`${source}.logs\` l JOIN eligible e
    ON l.block_number=e.block_number AND LOWER(l.block_hash)=e.block_hash AND LOWER(l.transaction_hash)=e.tx_hash
  WHERE l.block_timestamp BETWEEN ${from} AND ${to}
  GROUP BY e.tx_hash,e.block_hash
), inputs AS (
  SELECT e.*, FALSE AS trace_rows_present, ARRAY<STRING>[] AS traces, IFNULL(l.logs,[]) AS logs
  FROM eligible e LEFT JOIN log_rows l USING(tx_hash,block_hash)
), ${rootSource}witnesses AS (
  SELECT DISTINCT edge AS body
  FROM inputs AS i CROSS JOIN UNNEST(JSON_QUERY_ARRAY(direction_edges(TO_JSON_STRING(i)))) AS edge
  ${rootKeys.length?`UNION DISTINCT
  SELECT edge AS body FROM inputs AS i JOIN direct_checked USING(block_number,block_hash,tx_hash,transaction_index)
  CROSS JOIN UNNEST(JSON_QUERY_ARRAY(vaultRootDirections(TO_JSON_STRING(i)))) AS edge`:''}
), header_check AS (
  SELECT COUNT(*)=${toBlock-fromBlock+1} AND COUNT(DISTINCT number)=${toBlock-fromBlock+1}
    AND COUNTIF(number=${toBlock} AND block_hash='${headHash}')=1
    AND CAST(SUM(transaction_count) AS STRING)='${transactions}' AS pinned FROM headers
), coverage AS (
  SELECT IF((SELECT pinned FROM header_check) AND CAST(COUNT(*) AS STRING)='${transactions}'
      AND TO_JSON_STRING(library_call_selectors())=TO_JSON_STRING(${keyList}),
      CAST(COUNT(*) AS STRING),ERROR('Pinned source or discovery selector inventory changed')) AS sourceRows,
    MIN(block_number) AS minBlock,
    ARRAY_AGG(STRUCT(block_number AS number, block_hash AS blockHash) ORDER BY block_number DESC,block_hash ASC LIMIT 1)[SAFE_OFFSET(0)] AS firstHead,
    ARRAY_AGG(STRUCT(block_number AS number, block_hash AS blockHash) ORDER BY block_number DESC,block_hash DESC LIMIT 1)[SAFE_OFFSET(0)] AS lastHead
  FROM tx
)
SELECT 'source' AS row_kind, TO_JSON_STRING(c) AS body FROM coverage c
UNION ALL SELECT 'witness' AS row_kind, body FROM witnesses
ORDER BY row_kind,body;`;
}
