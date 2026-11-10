#!/usr/bin/env node
// Bounded BigQuery experiment runner. No RPC, strict, Ready mutation or live.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const [mode, directory] = process.argv.slice(2);
assert(['dry-run', 'submit', 'status', 'download'].includes(mode), 'Use dry-run|submit|status|download OUTPUT_DIRECTORY');
assert(directory?.startsWith('/'), 'Absolute evidence directory required');
const read = name => JSON.parse(readFileSync(resolve(directory, name), 'utf8'));
const save = (name, value) => writeFileSync(resolve(directory, name), JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
const hash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const plan = read('full-query-plan.json');
const pin = plan.sourcePin;
assert.equal(pin.table.projectId, plan.project);
assert.equal(plan.location, 'US');
assert(Number.isSafeInteger(plan.maximumBytesBilled) && plan.maximumBytesBilled > 0 && plan.maximumBytesBilled <= 100 * 1024 ** 3);
const sql = readFileSync(resolve(directory, 'full-query.sql'), 'utf8');
assert.equal(hash(sql), plan.sqlSha256);
const token = execFileSync('gcloud', ['--configuration=' + plan.gcloudConfiguration, 'auth', 'print-access-token'], { encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
async function api(path, body, missingOkay = false) {
  save('last-api.json', { time: new Date().toISOString(), method: body ? 'POST' : 'GET', path, requestBytes: body ? Buffer.byteLength(JSON.stringify(body)) : 0 });
  const response = await fetch('https://bigquery.googleapis.com/bigquery/v2/projects/' + plan.project + path, { method: body ? 'POST' : 'GET', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(60000) });
  if (missingOkay && response.status === 404) return null;
  const value = await response.json();
  if (!response.ok) { save('api-error.json', { status: response.status, error: value.error }); throw Error('BigQuery HTTP ' + response.status + ': ' + value.error?.message); }
  return value;
}
async function verifySource() {
  const meta = await api(`/datasets/${pin.table.datasetId}/tables/${pin.table.tableId}`);
  assert.deepEqual({ table: meta.tableReference, modified: meta.lastModifiedTime, rows: meta.numRows, schemaHash: hash(meta.schema) }, pin, 'Source table changed since natural ingestion');
  save('verified-source.json', meta);
}
const query = { query: sql, useLegacySql: false, maximumBytesBilled: String(plan.maximumBytesBilled), useQueryCache: false };
const jobId = 'mev_discovery_udf_full_' + hash({ sql, input: pin, libraryHashes: plan.libraryHashes }).slice(0, 24);
const location = '?location=' + plan.location;
if (mode === 'dry-run') {
  await verifySource();
  const result = await api('/jobs', { jobReference: { projectId: plan.project, location: plan.location }, configuration: { dryRun: true, query } });
  save('full-dry-run.json', result);
  const bytes = Number(result.statistics?.query?.totalBytesProcessed ?? result.statistics?.totalBytesProcessed);
  assert(Number.isSafeInteger(bytes) && bytes <= plan.maximumBytesBilled);
  console.log(JSON.stringify({ phase: 'full-dry-run-passed', bytes, families: plan.familyCount, sourceRows: pin.rows, jobId }));
} else if (mode === 'submit') {
  await verifySource();
  const dry = read('full-dry-run.json');
  assert.equal(dry.configuration.query.query, sql, 'Dry-run does not match current query');
  const request = { jobReference: { projectId: plan.project, location: plan.location, jobId }, configuration: { jobTimeoutMs: '1200000', query } };
  save('full-request.json', request);
  const prior = await api('/jobs/' + jobId + location, undefined, true);
  const job = prior ?? await api('/jobs', request);
  save('full-job.json', job);
  console.log(JSON.stringify({ phase: 'full-query-submitted', jobId, reused: prior !== null, status: job.status }));
} else if (mode === 'status') {
  const job = await api('/jobs/' + jobId + location);
  save('full-job.json', job);
  console.log(JSON.stringify({ phase: 'full-query-status', jobId, status: job.status, started: job.statistics?.startTime, ended: job.statistics?.endTime, bytes: job.statistics?.query?.totalBytesProcessed, slotMs: job.statistics?.totalSlotMs, destination: job.configuration?.query?.destinationTable }));
  assert(!job.status?.errorResult, 'Query failed; error evidence retained');
} else {
  const job = await api('/jobs/' + jobId + location);
  assert.equal(job.status?.state, 'DONE'); assert(!job.status?.errorResult);
  const statePath = resolve(directory, 'download-state.json');
  let state = existsSync(statePath) ? read('download-state.json') : { jobId, pages: 0, rows: 0, nextPageToken: null, complete: false };
  assert.equal(state.jobId, jobId);
  for (let step = 0; step < 30 && !state.complete; step++) {
    const suffix = state.nextPageToken ? '&pageToken=' + encodeURIComponent(state.nextPageToken) : '';
    const result = await api('/queries/' + jobId + location + '&maxResults=5000' + suffix);
    assert(result.jobComplete, 'Query output is not complete');
    save('result-page-' + String(state.pages + 1).padStart(5, '0') + '.json', result);
    state = { jobId, pages: state.pages + 1, rows: state.rows + (result.rows?.length ?? 0), totalRows: result.totalRows, nextPageToken: result.pageToken ?? null, complete: !result.pageToken };
    save('download-state.json', state);
    console.log(JSON.stringify({ phase: 'result-page-saved', pages: state.pages, rows: state.rows, totalRows: state.totalRows }));
  }
  if (state.complete) await verifySource();
  console.log(JSON.stringify({ phase: 'full-query-download', pages: state.pages, rows: state.rows, totalRows: state.totalRows, complete: state.complete }));
}
