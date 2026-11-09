-- Query-side discovery only. The generated library loads every discovery root
-- from the supplied Family capability JSON package; SQL contains no venue rules.
-- Keep all top-ranked witnesses: the natural reader retains the first witness
-- on an exact tie, and table scan order must not be invented here.
CREATE TEMP FUNCTION discovery_records(tx STRING)
RETURNS STRING
LANGUAGE js
OPTIONS (library = [__LIBRARY_URIS__])
AS r'''return DiscoveryKernel.compactTransactionJson(tx);''';

WITH discovered AS (
  SELECT discovery_records(TO_JSON_STRING(STRUCT(
    tx_hash, block_number, block_hash, transaction_index,
    receipt_status, trace_rows_present, traces, logs
  ))) AS discovery_result
  FROM `__SOURCE_TABLE__`
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
    JSON_VALUE(record, '$.signature') AS signature
  FROM discovered, UNNEST(JSON_QUERY_ARRAY(discovery_result)) AS record
), best_witnesses AS (
  SELECT * FROM records
  QUALIFY DENSE_RANK() OVER (
    PARTITION BY kind, instance_key
    ORDER BY source_block DESC, evidence_score DESC, fingerprint ASC
  ) = 1
)
SELECT DISTINCT * FROM best_witnesses;
