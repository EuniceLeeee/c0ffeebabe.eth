-- Calls originate in the validated trace. Keep ABI extraction for the root
-- witness path and resolve unambiguous internal address-pool flows in SQL.
WITH coverage AS (
  SELECT COUNT(*) AS sourceRows, MIN(block_number) AS minBlock,
    ARRAY_AGG(STRUCT(block_number AS number, block_hash AS blockHash)
      ORDER BY block_number DESC LIMIT 1)[SAFE_OFFSET(0)] AS head
  FROM @TRACE_TABLE
), inventory AS (
  SELECT IF(TO_JSON_STRING(library_call_selectors()) = TO_JSON_STRING(@SELECTORS),
    @SELECTORS, ERROR('Discovery selector inventory changed')) AS selectors
), root_calls AS (
  SELECT t.* EXCEPT(traces) REPLACE(FALSE AS trace_rows_present),
    ARRAY<STRING>[] AS traces
  FROM @TRACE_TABLE AS t CROSS JOIN inventory
  WHERE t.receipt_status = 1 AND LEFT(t.input, 10) IN UNNEST(selectors)
), internal_registry AS (
  SELECT selector, MIN(familyId) AS familyId
  FROM UNNEST(@ADDRESS_FAMILIES) GROUP BY selector HAVING COUNT(*) = 1
), frames AS (
  SELECT t.block_hash, t.tx_hash, f.to_address AS target,
    f.from_address AS caller, f.trace_address, f.value,
    LEFT(f.input, 10) AS selector, t.logs, t.traces
  FROM @TRACE_TABLE AS t CROSS JOIN UNNEST(t.traces) AS f
  WHERE t.receipt_status = 1 AND f.trace_type = 'call' AND f.call_type = 'call' AND f.status = 1
    AND NOT EXISTS (
      SELECT 1 FROM UNNEST(t.traces) AS ancestor
      WHERE f.trace_address != ''
        AND (ancestor.trace_address = '' OR STARTS_WITH(f.trace_address, CONCAT(ancestor.trace_address, ',')))
        AND (ancestor.status != 1 OR ancestor.call_type = 'staticcall')
    )
), unique_internal AS (
  -- Include competing unregistered calls in the count. Their receipt flows
  -- cannot be attributed to the selected selector merely because it is known.
  SELECT f.*, r.familyId
  FROM frames AS f LEFT JOIN internal_registry AS r USING(selector)
  QUALIFY COUNT(*) OVER (PARTITION BY f.block_hash, f.tx_hash, f.target) = 1
    AND f.trace_address != '' AND r.familyId IS NOT NULL AND f.target != f.caller
), erc20 AS (
  SELECT f.block_hash, f.tx_hash, f.target, f.selector, f.familyId, l.log_address AS asset,
    IF(LOWER(l.topics[SAFE_OFFSET(1)]) = CONCAT('0x', LPAD(SUBSTR(f.caller, 3), 64, '0')), 'in', 'out') AS side
  FROM unique_internal AS f CROSS JOIN UNNEST(f.logs) AS l
  WHERE ARRAY_LENGTH(l.topics) = 3
    AND LOWER(l.topics[SAFE_OFFSET(0)]) = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
    AND REGEXP_CONTAINS(l.data, r'^0x[0-9a-f]{64}$') AND l.data != CONCAT('0x', REPEAT('0', 64))
    AND LEAST(LOWER(l.topics[SAFE_OFFSET(1)]), LOWER(l.topics[SAFE_OFFSET(2)]))
      = CONCAT('0x', LPAD(SUBSTR(LEAST(f.caller, f.target), 3), 64, '0'))
    AND GREATEST(LOWER(l.topics[SAFE_OFFSET(1)]), LOWER(l.topics[SAFE_OFFSET(2)]))
      = CONCAT('0x', LPAD(SUBSTR(GREATEST(f.caller, f.target), 3), 64, '0'))
), native AS (
  -- Match real CALL value. A wrapped token's Transfer remains an ERC20 flow.
  SELECT block_hash, tx_hash, target, selector, familyId,
    CONCAT('0x', REPEAT('0', 40)) AS asset, 'in' AS side
  FROM unique_internal WHERE REGEXP_CONTAINS(value, r'^[1-9][0-9]*$')
  UNION ALL
  SELECT f.block_hash, f.tx_hash, f.target, f.selector, f.familyId,
    CONCAT('0x', REPEAT('0', 40)), 'out'
  FROM unique_internal AS f CROSS JOIN UNNEST(f.traces) AS payment
  WHERE payment.trace_type = 'call' AND payment.call_type = 'call' AND payment.status = 1
    AND payment.from_address = f.target AND payment.to_address = f.caller
    AND REGEXP_CONTAINS(payment.value, r'^[1-9][0-9]*$')
    AND STARTS_WITH(payment.trace_address, CONCAT(f.trace_address, ','))
    AND NOT EXISTS (
      SELECT 1 FROM UNNEST(f.traces) AS ancestor
      WHERE STARTS_WITH(payment.trace_address, CONCAT(ancestor.trace_address, ','))
        AND (ancestor.status != 1 OR ancestor.call_type = 'staticcall')
    )
), internal_directions AS (
  SELECT familyId, selector, target, MIN(IF(side = 'in', asset, NULL)) AS tokenIn,
    MIN(IF(side = 'out', asset, NULL)) AS tokenOut
  FROM (SELECT * FROM erc20 UNION ALL SELECT * FROM native)
  GROUP BY block_hash, tx_hash, target, selector, familyId
  HAVING COUNT(DISTINCT IF(side = 'in', asset, NULL)) = 1
    AND COUNT(DISTINCT IF(side = 'out', asset, NULL)) = 1
    AND tokenIn != tokenOut
), witnesses AS (
  SELECT edge AS body FROM root_calls AS t
  CROSS JOIN UNNEST(JSON_QUERY_ARRAY(direction_edges(TO_JSON_STRING(t)))) AS edge
  @VAULT_WITNESSES
  UNION ALL
  SELECT TO_JSON_STRING((SELECT AS STRUCT 1 AS chainId, d.*, 'trace-address-asset-flow' AS evidence)) FROM internal_directions AS d
)
SELECT 'source' AS row_kind, TO_JSON_STRING(STRUCT(
  CAST(sourceRows AS STRING) AS sourceRows, minBlock, head AS firstHead, head AS lastHead
)) AS body FROM coverage
UNION ALL
SELECT DISTINCT 'witness' AS row_kind, body FROM witnesses
