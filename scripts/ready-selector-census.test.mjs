import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { buildDiscoveryUdf } from './ready-discovery-udf-build.mjs';
import { renderEthereumInputs, renderRawWindow, renderRawRefresh } from './ready-bigquery-window.mjs';

const window = { fromBlock: 10, toBlock: 11, firstTime: '2026-10-15T00:00:00.000000Z', lastTime: '2026-10-15T00:00:12.000000Z', transactions: '3' };
const a = n => '0x' + n.toString(16).padStart(40, '0');
const h = n => '0x' + n.toString(16).padStart(64, '0');

test('default Ready SQL includes top-level input and logs without scanning the traces table', () => {
  const sql = renderEthereumInputs(window);
  assert.match(sql, /crypto_ethereum\.transactions/);
  assert.match(sql, /crypto_ethereum\.logs/);
  assert.doesNotMatch(sql, /crypto_ethereum\.traces/);
  assert.doesNotMatch(sql, /LEFT JOIN traces/);
  for (const field of ['from_address', 'to_address', 'input', 'value']) assert(sql.includes('t.' + field));
  assert.match(sql, /FALSE AS trace_rows_present/);
  assert.match(sql, /ARRAY<STRUCT<[^\n]+>>\[\] AS traces/);
});

test('stored SQL calls are an explicit optional enrichment with the same output schema', () => {
  const sql = renderEthereumInputs(window, { withStoredCalls: true });
  assert.match(sql, /crypto_ethereum\.traces/);
  assert.match(sql, /LEFT JOIN traces/);
  assert.match(sql, /traces\.tx_hash IS NOT NULL AS trace_rows_present/);
  assert.match(sql, /t\.input, CAST\(t\.value AS STRING\)/);
  assert.throws(() => renderEthereumInputs(window, { withStoredCalls: 'true' }), /boolean/);
});

test('saved pre-census rows expose missing calldata; refresh fills only NULL metadata and rejects conflicts', () => {
  const ref = { projectId: 'project1', datasetId: 'Ready', tableId: 'history' };
  const query = renderRawWindow(ref, window);
  assert.match(query, /JSON_VALUE\(TO_JSON_STRING\(saved\), '\$\.input'\) AS input/);
  assert.match(query, /block_number BETWEEN 10 AND 11/);
  const refresh = renderRawRefresh(ref, window, { ...ref, tableId: 'fresh' });
  assert.match(refresh, /ADD COLUMN IF NOT EXISTS input STRING/);
  assert.match(refresh, /INSERT \([^\n]+from_address, to_address, input, value/);
  assert.match(refresh, /WHEN MATCHED AND \(/);
  assert.match(refresh, /input = COALESCE\(d\.input, s\.input\)/);
  assert.match(refresh, /transaction_index = COALESCE\(d\.transaction_index, s\.transaction_index\)/);
  assert.match(refresh, /d\.input IS NOT NULL AND s\.input IS NOT NULL AND LOWER\(d\.input\) IS DISTINCT FROM LOWER\(s\.input\)/);
  assert.match(refresh, /Saved transaction metadata conflicts with canonical source/);
  const update = refresh.match(/UPDATE SET ([^\n]+)/)[1];
  assert.doesNotMatch(update, /(?:logs|traces|trace_rows_present|receipt_status)\s*=/);
  assert(refresh.indexOf('Saved transaction metadata conflicts') < refresh.indexOf('MERGE '));
  assert.match(refresh, /Incomplete or duplicate transaction coverage/);
});

test('actual SQL UDF retains unknown and raw calls even when the active catalog has no matches', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'ready-census-udf-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const repository = resolve(fileURLToPath(new URL('..', import.meta.url))), sourceRoot = join(repository, 'listener');
  const catalog = join(sourceRoot, 'src/searcher/generated/family-capability-shadow.generated.json');
  const ids = [...new Set(JSON.parse(readFileSync(catalog, 'utf8')).exact.map(item => item.identity.familyId))];
  const familyId = ids[0];
  const out = join(directory, 'kernel');
  const report = await buildDiscoveryUdf({ catalog, sourceRoot, reader: join(repository, 'scripts/bigquery-table.mjs'), out, familyIds: [familyId] });
  assert(report.inputs.some(input => input.path.endsWith('ready-selector-census.ts')));
  const context = vm.createContext({});
  for (const resource of report.resources) vm.runInContext(readFileSync(join(out, resource.file), 'utf8'), context, { timeout: 30000 });
  const tx = { tx_hash: h(1), block_number: 10, block_hash: h(2), transaction_index: 0, receipt_status: 1,
    from_address: a(10), to_address: a(11), input: '0xdeadbabe' + h(17).slice(2), value: '0', traces: [], logs: [] };
  const rows = JSON.parse(context.DiscoveryKernel.compactTransactionJson(JSON.stringify(tx)));
  assert.equal(rows.filter(row => row.kind === 'candidate').length, 0);
  assert.equal(rows.filter(row => row.kind === 'selector-census').length, 1);
  const row = rows.find(row => row.kind === 'selector-census');
  assert.equal(row.key, '1|' + tx.tx_hash);
  assert.equal(row.snapshot.calls[0].selector, '0xdeadbabe');
  assert.equal(row.snapshot.calls[0].classification, 'raw-call');
  assert.equal(row.snapshot.status, 'unverified');
  assert.equal(row.snapshot.coverage.internalCalls, 'unobserved');
  assert.match(row.fingerprint, /^[0-9a-f]{64}$/);
  const edge = rows.find(row => row.kind === 'selector-edge');
  assert.equal(edge.snapshot.selector, '0xdeadbabe');
  assert.equal(edge.snapshot.status, 'unverified');
  assert.equal(edge.snapshot.completeness, 'incomplete');
  assert.equal(edge.snapshot.calldata, tx.input);
  const blank = JSON.parse(context.DiscoveryKernel.compactTransactionJson(JSON.stringify({ ...tx, input: '0x', to_address: null })));
  assert.deepEqual(blank.map(row=>row.kind).sort(), ['selector-census', 'selector-edge']);
  assert.equal(blank.find(row=>row.kind==='selector-census').snapshot.calls[0].selector, null);
  assert.equal(blank.find(row=>row.kind==='selector-edge').snapshot.scope.target, null);
  const emptyOut = join(directory, 'census-only');
  const emptyReport = await buildDiscoveryUdf({ catalog, sourceRoot, reader: join(repository, 'scripts/bigquery-table.mjs'), out: emptyOut, familyIds: [] });
  const emptyContext = vm.createContext({});
  for (const resource of emptyReport.resources) vm.runInContext(readFileSync(join(emptyOut, resource.file), 'utf8'), emptyContext, { timeout: 30000 });
  assert.equal(emptyReport.familyCount, 0);
  const withoutDeclarations = JSON.parse(emptyContext.DiscoveryKernel.compactTransactionJson(JSON.stringify(tx)));
  assert.deepEqual(withoutDeclarations.map(row=>row.kind).sort(), ['selector-census', 'selector-edge']);
  assert.equal(withoutDeclarations.find(row=>row.kind==='selector-census').snapshot.calls[0].selector, '0xdeadbabe');
  assert.equal(withoutDeclarations.find(row=>row.kind==='selector-edge').snapshot.selector, '0xdeadbabe');
});
