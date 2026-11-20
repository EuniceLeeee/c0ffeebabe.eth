-- Bind the actual Swap call to a signed Manager receipt. The five ABI words
-- supply a PoolKey, and the receipt supplies the pool ID. Match them by hash,
-- sender, transaction, and direction. A Manager address is never a pool ID.
WITH v4_checked AS (
  SELECT t.block_hash AS bh, t.tx_hash AS th, l.log_index AS li,
    l.log_address AS emitter, l.topics, l.data AS d,
    LOWER(l.topics[SAFE_OFFSET(0)]) AS topic0, TRUE AS validReceipt
  FROM @TRACE_TABLE AS t CROSS JOIN UNNEST(t.logs) AS l
  WHERE t.receipt_status = 1 AND l.log_address = @MANAGER
    AND LOWER(l.topics[SAFE_OFFSET(0)]) = @V4
), @V4_VALID_SWAPS,
v4_calldata_receipts AS (
  SELECT bh, th, ARRAY_AGG(DISTINCT poolId LIMIT 257) AS ids
  FROM v4_valid_swaps GROUP BY bh, th
), v4_trace_frames AS (
  SELECT t.block_hash AS bh, t.tx_hash AS th, f.to_address AS manager,
    (
      SELECT unlock.trace_address FROM UNNEST(t.traces) AS unlock
      WHERE unlock.to_address = @MANAGER AND LEFT(unlock.input, 10) = @UNLOCK_SELECTOR
        AND unlock.trace_type = 'call' AND unlock.call_type = 'call' AND unlock.status = 1
        AND f.trace_address != ''
        AND (unlock.trace_address = '' OR STARTS_WITH(f.trace_address, CONCAT(unlock.trace_address, ',')))
      ORDER BY LENGTH(unlock.trace_address) DESC LIMIT 1
    ) AS unlockPath,
    f.trace_address AS swapPath, f.from_address AS sender, SUBSTR(f.input, 11, 320) AS preimage,
    SUBSTR(f.input, 331, 64) = LPAD('1', 64, '0') AS zeroForOne
  FROM @TRACE_TABLE AS t
  CROSS JOIN UNNEST(t.traces) AS f
  WHERE t.receipt_status = 1
    AND f.trace_type = 'call' AND f.call_type = 'call' AND f.status = 1
    AND f.to_address = @MANAGER AND LEFT(f.input, 10) = @SWAP_SELECTOR
    AND LENGTH(f.input) >= 650 AND MOD(LENGTH(f.input) - 10, 64) = 0
    AND SUBSTR(f.input, 331, 64) IN (REPEAT('0', 64), LPAD('1', 64, '0'))
    -- The Family entry is unlock(bytes). Its pool identity and direction
    -- come from the descendant swap, which owns the PoolKey and event.
    AND NOT EXISTS (
      SELECT 1 FROM UNNEST(t.traces) AS ancestor
      WHERE f.trace_address != ''
        AND (ancestor.trace_address = '' OR STARTS_WITH(f.trace_address, CONCAT(ancestor.trace_address, ',')))
        AND (ancestor.status != 1 OR ancestor.call_type = 'staticcall')
    )
), v4_trace_decoded AS (
  SELECT f.bh, f.th, f.unlockPath, f.swapPath, f.manager, f.sender, f.zeroForOne, k.poolId, k.c0, k.c1, k.preimage
  FROM v4_trace_frames AS f JOIN v4_calldata_receipts AS r USING (bh, th)
  CROSS JOIN UNNEST(v4CalldataReceiptKeys(CONCAT('0x', f.preimage), r.ids)) AS k
  WHERE f.unlockPath IS NOT NULL
), v4_trace_receipt_keys AS (
  SELECT DISTINCT s.bh, s.th, s.li, f.unlockPath, f.swapPath, f.zeroForOne, f.manager, f.poolId, f.c0, f.c1, f.preimage
  FROM v4_trace_decoded AS f JOIN v4_valid_swaps AS s
    ON f.bh = s.bh AND f.th = s.th AND f.manager = s.emitter AND f.poolId = s.poolId
    AND f.sender = addr(s.topics[SAFE_OFFSET(2)])
    AND f.zeroForOne = (signw(word(s.d, 0)) = -1)
)
@PROJECTION
