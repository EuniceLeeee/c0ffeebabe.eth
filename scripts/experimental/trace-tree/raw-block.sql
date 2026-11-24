-- Raw Ethereum BigQuery export. Parameters: @day DATE UTC, @block INT64.
-- Independent scans: no transaction join, selector/topic/status filter, UDF, or byte truncation.
-- TO_JSON_STRING preserves the full source row, including provider-specific optional fields.
SELECT 'header' AS row_kind,TO_JSON_STRING(b) AS raw_json
FROM `bigquery-public-data.crypto_ethereum.blocks` AS b
WHERE b.number=@block AND DATE(b.timestamp)=@day
UNION ALL
SELECT 'transaction',TO_JSON_STRING(t)
FROM `bigquery-public-data.crypto_ethereum.transactions` AS t
WHERE t.block_number=@block AND DATE(t.block_timestamp)=@day
UNION ALL
SELECT 'trace',TO_JSON_STRING(f)
FROM `bigquery-public-data.crypto_ethereum.traces` AS f
WHERE f.block_number=@block AND DATE(f.block_timestamp)=@day
UNION ALL
SELECT 'receipt_log',TO_JSON_STRING(l)
FROM `bigquery-public-data.crypto_ethereum.logs` AS l
WHERE l.block_number=@block AND DATE(l.block_timestamp)=@day
