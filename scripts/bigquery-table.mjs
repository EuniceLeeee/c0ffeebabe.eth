import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync } from 'node:fs';

export const digest = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
export function saveJson(path, value) {
  writeFileSync(path + '.tmp', JSON.stringify(value) + '\n', { mode: 0o600 });
  renameSync(path + '.tmp', path);
}
export function tableRef(name) {
  const match = /^([a-z][a-z0-9-]+)[.:]([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z0-9_-]+)$/.exec(name);
  assert(match, 'Expected project.dataset.table');
  return { projectId: match[1], datasetId: match[2], tableId: match[3] };
}
export function tableUrl(ref) {
  return 'https://bigquery.googleapis.com/bigquery/v2/projects/' + ref.projectId + '/datasets/' + ref.datasetId + '/tables/' + ref.tableId;
}
export function sourcePin(meta) {
  assert.equal(meta.type, 'TABLE', 'Input must be a saved table');
  assert(/^\d+$/.test(meta.numRows), 'Missing exact row count');
  const names = new Set(meta.schema.fields.map(field => field.name));
  for (const name of ['tx_hash', 'block_number', 'block_hash', 'receipt_status', 'logs', 'traces']) assert(names.has(name), 'Missing input field: ' + name);
  return { table: meta.tableReference, modified: meta.lastModifiedTime, rows: meta.numRows, schemaHash: digest(meta.schema) };
}
export function decodeRow(fields, row) {
  assert(Array.isArray(row.f) && row.f.length === fields.length, 'BigQuery row/schema mismatch');
  function value(field, raw) {
    if (field.mode === 'REPEATED') return (raw ?? []).map(item => value({ ...field, mode: 'NULLABLE' }, item.v));
    if (raw === null) return null;
    if (field.type === 'RECORD' || field.type === 'STRUCT') return decodeRow(field.fields, raw);
    if (field.type === 'BOOLEAN' || field.type === 'BOOL') return raw === true || raw === 'true';
    return raw; // Keep integer strings exact; consumers validate block/index values.
  }
  return Object.fromEntries(fields.map((field, index) => [field.name, value(field, row.f[index].v)]));
}
export function observationsFromTx(tx, counts) {
  const number = Number(tx.block_number);
  assert(Number.isSafeInteger(number) && number > 0, 'Invalid source block');
  assert(/^0x[0-9a-f]{64}$/i.test(tx.block_hash) && /^0x[0-9a-f]{64}$/i.test(tx.tx_hash), 'Invalid source identity');
  assert(Array.isArray(tx.logs) && Array.isArray(tx.traces), 'Missing logs/traces arrays');
  counts.transactions++;
  if (Number(tx.receipt_status) !== 1) { counts.failedTransactions++; return []; }
  const observations = tx.logs.map(log => ({ address: log.log_address, topics: log.topics, data: log.data,
    transactionHash: tx.tx_hash, blockNumber: number, blockHash: tx.block_hash, logIndex: Number(log.log_index) }));
  counts.logs += observations.length;
  if (!tx.traces.length) counts.transactionsWithoutTraces++;
  const parents = new Map(tx.traces.map(frame => [frame.trace_address ?? '', frame]));
  for (const frame of tx.traces) {
    if (frame.call_type !== 'call' || Number(frame.status) !== 1 || !frame.to_address || typeof frame.input !== 'string' || frame.input.length < 10) continue;
    const path = frame.trace_address ?? '';
    assert(path === '' || /^\d+(,\d+)*$/.test(path), 'Invalid trace path');
    const parts = path ? path.split(',') : [];
    const ancestors = path ? ['', ...parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join(','))] : [];
    if (ancestors.some(parent => !parents.has(parent))) { counts.missingAncestorCalls++; continue; }
    if (ancestors.some(parent => Number(parents.get(parent).status) !== 1 || parents.get(parent).call_type === 'staticcall')) { counts.rolledBackCalls++; continue; }
    observations.push({ kind: 'call', target: frame.to_address, data: frame.input, sender: frame.from_address,
      transactionHash: tx.tx_hash, blockNumber: number, blockHash: tx.block_hash, traceAddress: parts.map(Number) });
    counts.calls++;
  }
  return observations;
}
export function emptyCounts() {
  return { transactions: 0, failedTransactions: 0, transactionsWithoutTraces: 0, missingAncestorCalls: 0, rolledBackCalls: 0, logs: 0, calls: 0 };
}
export function makeApi(tokenFile, fetchImpl = fetch, sleep = ms => new Promise(resolve => setTimeout(resolve, ms))) {
  return async function get(url) {
    for (let attempt = 0; attempt < 7; attempt++) {
      const credential = JSON.parse(readFileSync(tokenFile, 'utf8'));
      assert(credential.expiresAt > Date.now(), 'BigQuery access token expired; resume after credential refresh');
      let response;
      try { response = await fetchImpl(url, { headers: { Authorization: 'Bearer ' + credential.token }, signal: AbortSignal.timeout(60000) }); }
      catch { if (attempt === 6) throw Error('BigQuery transport failed after bounded retries'); await sleep(Math.min(30000, 1000 * 2 ** attempt)); continue; }
      if (response.ok) return await response.json();
      const status = response.status;
      await response.body?.cancel();
      if (![429, 500, 502, 503, 504].includes(status) || attempt === 6) throw Error('BigQuery request failed: HTTP ' + status);
      await sleep(Math.min(30000, 1000 * 2 ** attempt));
    }
  };
}
