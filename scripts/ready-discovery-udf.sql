-- Query-side discovery only. The generated library loads every discovery root
-- from the supplied Family capability JSON package; SQL contains no venue rules.
CREATE TEMP FUNCTION discovery_records(tx STRING)
RETURNS STRING
LANGUAGE js
OPTIONS (library = [__LIBRARY_URIS__])
AS r'''return DiscoveryKernel.compactTransactionJson(tx);''';

WITH discovered AS (
  SELECT tx_hash AS source_tx_hash, block_hash AS source_hash,
    discovery_records(TO_JSON_STRING(STRUCT(
    tx_hash, block_number, block_hash,
    SAFE_CAST(JSON_VALUE(TO_JSON_STRING(source_tx), '$.transaction_index') AS INT64) AS transaction_index,
    receipt_status,
    JSON_VALUE(TO_JSON_STRING(source_tx), '$.from_address') AS from_address,
    JSON_VALUE(TO_JSON_STRING(source_tx), '$.to_address') AS to_address,
    JSON_VALUE(TO_JSON_STRING(source_tx), '$.input') AS input,
    JSON_VALUE(TO_JSON_STRING(source_tx), '$.value') AS value,
    SAFE_CAST(JSON_VALUE(TO_JSON_STRING(source_tx), '$.trace_rows_present') AS BOOL) AS trace_rows_present,
    PARSE_JSON(JSON_QUERY(TO_JSON_STRING(source_tx), '$.traces')) AS traces,
    logs
  ))) AS discovery_result
  FROM `__SOURCE_TABLE__` AS source_tx
), records AS (
  SELECT
    JSON_VALUE(record, '$.kind') AS kind,
    JSON_VALUE(record, '$.family') AS family,
    JSON_VALUE(record, '$.key') AS instance_key,
    CAST(JSON_VALUE(record, '$.block') AS INT64) AS source_block,
    CAST(JSON_VALUE(record, '$.score') AS INT64) AS evidence_score,
    JSON_VALUE(record, '$.fingerprint') AS fingerprint,
    JSON_QUERY(record, '$.snapshot') AS snapshot,
    JSON_VALUE(record, '$.tx') AS tx_hash,
    SAFE_CAST(JSON_VALUE(record, '$.logIndex') AS INT64) AS log_index,
    JSON_VALUE(record, '$.signature') AS signature,
    source_tx_hash, source_hash
  FROM discovered, UNNEST(JSON_QUERY_ARRAY(discovery_result)) AS record
), ranked_witnesses AS (
  SELECT *, TO_JSON_STRING(STRUCT(
    kind, family, instance_key AS key, source_block AS block, tx_hash AS tx,
    source_tx_hash AS sourceTx, source_hash AS sourceHash, fingerprint, PARSE_JSON(snapshot) AS snapshot
  )) AS body
  FROM records
), best_witnesses AS (
  SELECT * FROM ranked_witnesses
  QUALIFY ROW_NUMBER() OVER (
    PARTITION BY kind, family, instance_key
    ORDER BY source_block DESC, evidence_score DESC, fingerprint ASC, body ASC
  ) = 1
), opaque_evidence AS (
  SELECT DISTINCT SUBSTR(instance_key, LENGTH(family) + 2) AS physical_key,
    source_block, tx_hash, source_tx_hash, source_hash, snapshot
  FROM best_witnesses
  WHERE kind = 'opaque'
), compact_witnesses AS (
  -- Census is a transaction ledger, not a best Family nomination. Preserve
  -- every supplied row so conflicting duplicate sources cannot be hidden.
  SELECT body FROM ranked_witnesses WHERE kind = 'selector-census'
  UNION ALL
  SELECT body FROM best_witnesses WHERE kind = 'candidate'
  UNION ALL
  -- Direction/resource observations are independent of Ready admission.
  -- Incomplete/unknown calls carry a source-call key and remain visible.
  SELECT body FROM best_witnesses WHERE kind = 'selector-edge'
  UNION ALL
  SELECT TO_JSON_STRING(STRUCT(
    'opaque-group' AS kind, physical_key AS key,
    ARRAY_AGG(STRUCT(source_block AS block, tx_hash AS tx,
      source_tx_hash AS sourceTx, source_hash AS sourceHash, PARSE_JSON(snapshot) AS snapshot)
      ORDER BY source_block DESC, tx_hash, source_hash, snapshot) AS witnesses
  )) AS body
  FROM opaque_evidence
  GROUP BY physical_key
)
-- DISCOVERY_RESULT
SELECT body FROM compact_witnesses;
