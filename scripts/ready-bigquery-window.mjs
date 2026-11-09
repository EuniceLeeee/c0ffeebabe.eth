import assert from 'node:assert/strict';
import { decodeRow, digest, tableUrl } from './bigquery-table.mjs';
import { openReadyDiscoveryJob } from './ready-bigquery-sql.mjs';

const ethereum = 'bigquery-public-data.crypto_ethereum';
const utc = value => {
  assert(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/.test(value), 'Invalid canonical block timestamp');
  return `TIMESTAMP('${value}')`;
};

export function parseReadyWindow(args) {
  const fromDay = args['from-day'], toDay = args['to-day'];
  const fromBlock = args['from-block'], toBlock = args['to-block'];
  if ([fromDay, toDay, fromBlock, toBlock].every(value => value === undefined)) return null;
  if (fromDay !== undefined || toDay !== undefined) {
    assert(fromBlock === undefined && toBlock === undefined, 'Choose days or blocks');
    for (const day of [fromDay, toDay]) {
      assert(typeof day === 'string' && /^\d{4}-\d\d-\d\d$/.test(day), 'Use --from-day and --to-day as YYYY-MM-DD');
      const date = new Date(day + 'T00:00:00Z');
      assert(Number.isFinite(date.getTime()) && date.toISOString().startsWith(day), 'Invalid calendar day');
    }
    assert(fromDay <= toDay, 'Invalid day order');
    return { fromDay, toDay };
  }
  assert(typeof fromBlock === 'string' && /^\d+$/.test(fromBlock) &&
    typeof toBlock === 'string' && /^\d+$/.test(toBlock), 'Use --from-block and --to-block');
  const window = { fromBlock: Number(fromBlock), toBlock: Number(toBlock) };
  assert(Number.isSafeInteger(window.toBlock) && Number.isSafeInteger(window.fromBlock) &&
    window.fromBlock > 0 && window.fromBlock <= window.toBlock, 'Invalid block range');
  return window;
}

export function readyWindowPredicate(window, column = 'block_number') {
  assert(Number.isSafeInteger(window.fromBlock) && Number.isSafeInteger(window.toBlock) &&
    window.fromBlock > 0 && window.fromBlock <= window.toBlock);
  return `${column} BETWEEN ${window.fromBlock} AND ${window.toBlock}`;
}

export async function runWindowQuery(api, ref, location, maxBytes, sql, pageSize, name, revision) {
  const query = { query: sql, useLegacySql: false, useQueryCache: false, maximumBytesBilled: String(maxBytes) };
  const spec = { location, query, jobId: 'mev_' + name + '_' + digest({ ref, location, query, revision }).slice(0, 24) };
  const read = await openReadyDiscoveryJob(api, ref, spec, []);
  const page = await read(pageSize);
  const project = 'https://bigquery.googleapis.com/bigquery/v2/projects/' + ref.projectId;
  const job = await api(project + '/jobs/' + spec.jobId + '?location=' + location);
  assert.equal(job.status.state, 'DONE');
  assert(!job.status.errorResult, 'Window query failed: ' + job.status.errorResult?.reason);
  return { jobId: spec.jobId, page, stats: job.statistics.query, destination: job.configuration.query.destinationTable };
}

export async function resolveReadyWindow(api, ref, location, maxBytes, selection) {
  const byDay = selection.fromDay !== undefined;
  const start = byDay ? `TIMESTAMP(DATE '${selection.fromDay}', 'Asia/Shanghai')` : null;
  const end = byDay ? `TIMESTAMP(DATE_ADD(DATE '${selection.toDay}', INTERVAL 1 DAY), 'Asia/Shanghai')` : null;
  const scan = byDay ? `timestamp >= TIMESTAMP_SUB(${start}, INTERVAL 1 HOUR)
    AND timestamp < TIMESTAMP_ADD(${end}, INTERVAL 1 HOUR)` : readyWindowPredicate(selection, 'number');
  const filter = byDay ? `WHERE timestamp >= ${start} AND timestamp < ${end}` : '';
  const edges = byDay ? `, (SELECT MIN(timestamp) < ${start} AND MAX(timestamp) >= ${end} FROM headers) AS complete_days` : '';
  const sql = `WITH headers AS (
  SELECT number, timestamp, \`hash\` AS block_hash, transaction_count FROM \`${ethereum}.blocks\` WHERE ${scan}
)
SELECT COUNT(*) AS block_count, COUNT(DISTINCT number) AS distinct_blocks,
  MIN(number) AS from_block, MAX(number) AS to_block, SUM(transaction_count) AS transactions,
  FORMAT_TIMESTAMP('%Y-%m-%dT%H:%M:%E6SZ', MIN(timestamp), 'UTC') AS first_time,
  FORMAT_TIMESTAMP('%Y-%m-%dT%H:%M:%E6SZ', MAX(timestamp), 'UTC') AS last_time,
  ARRAY_AGG(block_hash ORDER BY number DESC LIMIT 1)[SAFE_OFFSET(0)] AS head_hash
  ${edges}
FROM headers ${filter}`;
  const result = await runWindowQuery(api, ref, location, maxBytes, sql, 1, 'ready_window');
  const row = decodeRow(result.page.schema.fields, result.page.rows[0]);
  const fromBlock = Number(row.from_block), toBlock = Number(row.to_block);
  assert(Number.isSafeInteger(fromBlock) && fromBlock > 0 && Number.isSafeInteger(toBlock) &&
    toBlock >= fromBlock && Number(row.block_count) === toBlock - fromBlock + 1 &&
    row.block_count === row.distinct_blocks, 'Incomplete canonical block interval');
  if (byDay) assert.equal(row.complete_days, true, 'Public dataset does not cover both day boundaries');
  else assert(fromBlock === selection.fromBlock && toBlock === selection.toBlock, 'Public dataset is missing requested blocks');
  assert(/^\d+$/.test(row.transactions) && /^0x[0-9a-f]{64}$/i.test(row.head_hash), 'Missing canonical coverage');
  return { fromBlock, toBlock, firstTime: row.first_time, lastTime: row.last_time,
    headHash: row.head_hash.toLowerCase(), transactions: row.transactions, headerJob: result.jobId };
}

function canonicalHeaders(window) {
  return `SELECT number, LOWER(\`hash\`) AS block_hash FROM \`${ethereum}.blocks\`
  WHERE ${readyWindowPredicate(window, 'number')}
    AND timestamp BETWEEN ${utc(window.firstTime)} AND ${utc(window.lastTime)}`;
}

const tableName = ref => '`' + [ref.projectId, ref.datasetId, ref.tableId].join('.') + '`';

export function renderEthereumInputs(window) {
  const time = alias => `${alias}.block_timestamp BETWEEN ${utc(window.firstTime)} AND ${utc(window.lastTime)}`;
  return `WITH headers AS (${canonicalHeaders(window)}),
  tx AS (
    SELECT LOWER(t.\`hash\`) AS tx_hash, t.block_number, b.block_hash, t.transaction_index, t.receipt_status
    FROM \`${ethereum}.transactions\` AS t
    JOIN headers AS b ON t.block_number = b.number AND LOWER(t.block_hash) = b.block_hash
    WHERE ${time('t')}
  ), traces AS (
    SELECT LOWER(t.transaction_hash) AS tx_hash, LOWER(t.block_hash) AS block_hash,
      ARRAY_AGG(STRUCT(t.trace_address, t.trace_type, t.call_type, LOWER(t.from_address) AS from_address,
        LOWER(t.to_address) AS to_address, t.input, t.status) ORDER BY t.trace_address) AS traces
    FROM \`${ethereum}.traces\` AS t
    JOIN headers AS b ON t.block_number = b.number AND LOWER(t.block_hash) = b.block_hash
    WHERE ${time('t')} GROUP BY 1, 2
  ), logs AS (
    SELECT LOWER(l.transaction_hash) AS tx_hash, LOWER(l.block_hash) AS block_hash,
      ARRAY_AGG(STRUCT(l.log_index, LOWER(l.address) AS log_address, l.topics, l.data) ORDER BY l.log_index) AS logs
    FROM \`${ethereum}.logs\` AS l
    JOIN headers AS b ON l.block_number = b.number AND LOWER(l.block_hash) = b.block_hash
    WHERE ${time('l')} GROUP BY 1, 2
  )
  SELECT tx.*, traces.tx_hash IS NOT NULL AS trace_rows_present, IFNULL(traces.traces, []) AS traces, IFNULL(logs.logs, []) AS logs
  FROM tx LEFT JOIN traces USING(tx_hash, block_hash) LEFT JOIN logs USING(tx_hash, block_hash)`;
}

export function renderRawRefresh(ref, window, input) {
  const target = tableName(ref);
  const range = readyWindowPredicate(window, 'd.block_number');
  assert(/^\d+$/.test(window.transactions), 'Invalid source transaction count');
  const fields = ['tx_hash', 'block_number', 'block_hash', 'transaction_index', 'receipt_status', 'trace_rows_present', 'traces', 'logs'];
  return `BEGIN TRANSACTION;
ASSERT NOT EXISTS (
  SELECT 1 FROM ${target} AS d
  LEFT JOIN (${canonicalHeaders(window)}) AS b ON d.block_number = b.number
  WHERE ${range} AND LOWER(d.block_hash) IS DISTINCT FROM b.block_hash
) AS 'Saved table conflicts with canonical block hashes';
MERGE ${target} AS d
USING ${tableName(input)} AS s
ON ${range} AND d.block_number = s.block_number AND LOWER(d.tx_hash) = s.tx_hash
WHEN NOT MATCHED THEN
  INSERT (${fields.join(', ')}) VALUES (${fields.map(field => 's.' + field).join(', ')});
ASSERT (
  SELECT COUNT(*) = ${window.transactions} AND COUNT(DISTINCT LOWER(tx_hash)) = ${window.transactions}
  FROM ${target} AS d WHERE ${range}
) AS 'Incomplete or duplicate transaction coverage; raw table update rolled back';
COMMIT TRANSACTION;`;
}

export async function refreshReadyRawTable(api, history, ref, location, maxBytes, window) {
  assert(ref.projectId === history.projectId && ref.datasetId === history.datasetId && ref.tableId !== history.tableId,
    'Incremental table must be separate from the historical table, in the same dataset');
  if (!await api(tableUrl(ref), { allowStatus: 404 })) {
    await runWindowQuery(api, ref, location, maxBytes,
      `CREATE TABLE IF NOT EXISTS ${tableName(ref)} AS SELECT * FROM ${tableName(history)} WHERE FALSE`, 1, 'ready_raw_init');
  }
  // BigQuery's SELECT result is a short-lived job result. Applying the MERGE
  // to that result avoids a second scan of the public logs and traces.
  const day = new Date().toISOString().slice(0, 10);
  const raw = await runWindowQuery(api, ref, location, maxBytes, renderEthereumInputs(window), 1, 'ready_raw_source', day);
  assert.equal(raw.page.totalRows, window.transactions, 'Raw input does not cover the canonical transaction count');
  assert(raw.destination?.projectId === ref.projectId && raw.destination.datasetId.startsWith('_'),
    'Missing BigQuery-managed input result');
  const before = await api(tableUrl(ref));
  const result = await runWindowQuery(api, ref, location, maxBytes,
    renderRawRefresh(ref, window, raw.destination), 1, 'ready_raw_merge', before.lastModifiedTime);
  return { jobId: result.jobId, sourceJob: raw.jobId, table: (await api(tableUrl(ref))).tableReference,
    bytesProcessed: result.stats?.totalBytesProcessed };
}

export function renderRawWindow(ref, window) {
  return `SELECT tx_hash, block_number, block_hash, transaction_index, receipt_status, trace_rows_present, traces, logs
FROM ${tableName(ref)} WHERE ${readyWindowPredicate(window)}`;
}
