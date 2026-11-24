-- Independent control: counts from the four source tables, not from the export job.
SELECT
 (SELECT AS STRUCT b.hash,b.transaction_count FROM `bigquery-public-data.crypto_ethereum.blocks` b WHERE b.number=@block AND DATE(b.timestamp)=@day) AS header,
 (SELECT AS STRUCT COUNT(*) AS n,COUNT(DISTINCT t.hash) AS distinct_hashes,COUNTIF(t.receipt_status=0) AS failed FROM `bigquery-public-data.crypto_ethereum.transactions` t WHERE t.block_number=@block AND DATE(t.block_timestamp)=@day) AS txs,
 (SELECT AS STRUCT COUNT(*) AS n,COUNTIF(f.transaction_hash IS NULL) AS system_rows,COUNTIF(f.transaction_hash IS NOT NULL AND IFNULL(f.trace_address,'')='') AS roots,COUNTIF(f.status=0) AS failed FROM `bigquery-public-data.crypto_ethereum.traces` f WHERE f.block_number=@block AND DATE(f.block_timestamp)=@day) AS frames,
 (SELECT AS STRUCT COUNT(*) AS n,COUNT(DISTINCT l.log_index) AS distinct_indices,MIN(l.log_index) AS first_idx,MAX(l.log_index) AS last_idx FROM `bigquery-public-data.crypto_ethereum.logs` l WHERE l.block_number=@block AND DATE(l.block_timestamp)=@day) AS receipt_logs
