-- GoogleSQL. Parameters: @day DATE (UTC), @block INT64, @hashes ARRAY<STRING>.
-- One row per canonical transaction, no protocol/topic/selector filters or calldata truncation.
-- logs are in receipt order; this source does NOT supply the emitting call path.
WITH hdr AS (
 SELECT b.number,LOWER(b.hash) bh FROM `bigquery-public-data.crypto_ethereum.blocks` b
 WHERE DATE(b.timestamp)=@day AND b.number=@block
), txs AS (
 SELECT LOWER(t.hash) tx_hash,h.bh block_hash,t.block_number,t.transaction_index,t.receipt_status,
        LOWER(t.from_address) from_address,LOWER(t.to_address) to_address,LOWER(t.input) input
 FROM `bigquery-public-data.crypto_ethereum.transactions` t JOIN hdr h ON t.block_number=h.number AND LOWER(t.block_hash)=h.bh
 WHERE DATE(t.block_timestamp)=@day AND t.block_number=@block AND LOWER(t.hash) IN UNNEST(@hashes)
), frames AS (
 SELECT t.tx_hash, ARRAY_AGG(STRUCT(COALESCE(f.trace_address,'') AS trace_address,
       LOWER(f.trace_type) AS trace_type, LOWER(f.call_type) AS call_type, f.status,f.subtraces,
       LOWER(f.from_address) AS from_address, LOWER(f.to_address) AS to_address,
       LOWER(f.input) AS input, LOWER(f.output) AS output,CAST(f.value AS STRING) AS value)
       ORDER BY f.trace_address) AS traces
 FROM `bigquery-public-data.crypto_ethereum.traces` f JOIN txs t ON LOWER(f.transaction_hash)=t.tx_hash
 AND LOWER(f.block_hash)=t.block_hash AND f.transaction_index=t.transaction_index
 WHERE DATE(f.block_timestamp)=@day AND f.block_number=@block
 GROUP BY t.tx_hash
), receipts AS (
 SELECT t.tx_hash,ARRAY_AGG(STRUCT(l.log_index AS log_index,LOWER(l.address) AS log_address,l.topics AS topics,LOWER(l.data) AS data) ORDER BY l.log_index) AS logs
 FROM `bigquery-public-data.crypto_ethereum.logs` l JOIN txs t ON LOWER(l.transaction_hash)=t.tx_hash
 AND LOWER(l.block_hash)=t.block_hash AND l.transaction_index=t.transaction_index
 WHERE DATE(l.block_timestamp)=@day AND l.block_number=@block
 GROUP BY t.tx_hash
)
SELECT t.*,f.traces,IFNULL(r.logs,[]) AS logs FROM txs t
LEFT JOIN frames f USING(tx_hash) LEFT JOIN receipts r USING(tx_hash) ORDER BY t.transaction_index
