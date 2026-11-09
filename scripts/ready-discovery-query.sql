-- Read-only discovery annotation, NOT a Ready input filter or admission result.
-- Replace __SOURCE_TABLE__ with a validated project.dataset.table identifier.
-- @discovery_rules_json is generated from the same frozen Family catalog as Ready.
-- Every source transaction is returned, including transactions with no rule hits.
-- Failed/static/rolled-back calls may be annotated; production discovery decides
-- their eligibility using the complete transaction/ancestor evidence.
-- Address-surface, registry bootstrap and retained memo sources are separate;
-- this query only describes the log/call evidence in the supplied transaction table.
WITH discovery_rules AS (
  SELECT ARRAY(
    SELECT DISTINCT AS STRUCT
      JSON_VALUE(rule, '$.family_id') AS family_id,
      JSON_VALUE(rule, '$.kind') AS kind,
      LOWER(JSON_VALUE(rule, '$.signature')) AS signature
    FROM UNNEST(JSON_QUERY_ARRAY(@discovery_rules_json)) AS rule
  ) AS rules
), transaction_signatures AS (
  SELECT
    tx.tx_hash,
    tx.block_number,
    tx.block_hash,
    tx.receipt_status,
    ARRAY(
      SELECT DISTINCT LOWER(log.topics[SAFE_OFFSET(0)])
      FROM UNNEST(tx.logs) AS log
      WHERE log.topics[SAFE_OFFSET(0)] IS NOT NULL
    ) AS log_topics,
    ARRAY(
      SELECT DISTINCT LOWER(SUBSTR(frame.input, 1, 10))
      FROM UNNEST(tx.traces) AS frame
      WHERE REGEXP_CONTAINS(frame.input, r'^0x[0-9a-fA-F]{8}')
    ) AS call_selectors
  FROM `__SOURCE_TABLE__` AS tx
)
SELECT
  tx.tx_hash,
  tx.block_number,
  tx.block_hash,
  tx.receipt_status,
  ARRAY(
    SELECT AS STRUCT rule.family_id, rule.kind, rule.signature
    FROM UNNEST(declarations.rules) AS rule
    WHERE
      (rule.kind = 'log' AND rule.signature IN UNNEST(tx.log_topics))
      OR (rule.kind = 'call' AND rule.signature IN UNNEST(tx.call_selectors))
    ORDER BY rule.family_id, rule.kind, rule.signature
  ) AS discovery_hits
FROM transaction_signatures AS tx
CROSS JOIN discovery_rules AS declarations;
