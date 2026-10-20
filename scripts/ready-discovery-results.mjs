import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { decodeRow } from './bigquery-table.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const identities = packages => packages.flatMap(value => {
  assert.equal(value.format, 'adapter-family-capability-shadow-v1');
  assert.equal(value.complete, true); assert.deepEqual(value.issues, []); assert.deepEqual(value.legacy, []);
  return value.exact.filter(item => item.identity.capability === 'discovery').map(item => item.identity);
}).sort((a, b) => a.familyId.localeCompare(b.familyId));

// Input is a completed, hash-bound SQL result, not an admitted Ready. Every
// candidate still enters the normal reverse binding / strict / checkpoint path.
export function openDiscoveryResults(directory, currentCatalog) {
  assert(directory.startsWith('/'), 'Absolute SQL result directory required');
  const read = name => JSON.parse(readFileSync(resolve(directory, name), 'utf8'));
  const plan = read('plan.json'), job = read('full-job.json'), state = read('full-download-state.json');
  assert(plan.blockRange && Number.isSafeInteger(plan.blockRange.fromBlock) && plan.blockRange.fromBlock > 0 && Number.isSafeInteger(plan.blockRange.toBlock) && plan.blockRange.toBlock >= plan.blockRange.fromBlock, 'Missing or invalid SQL block range');
  assert.equal(plan.cutoff?.number, plan.blockRange.toBlock, 'SQL cutoff must equal requested end block');
  assert(/^0x[0-9a-f]{64}$/i.test(plan.cutoff.hash), 'Invalid SQL cutoff hash');
  const manifestBytes = readFileSync(resolve(directory, 'result-pages-manifest.json'));
  const manifest = JSON.parse(manifestBytes);
  assert.equal(job.status.state, 'DONE'); assert(!job.status.errorResult, 'SQL query failed');
  assert(state.complete && state.nextPageToken === null, 'SQL result download is incomplete');
  for (const item of [state, manifest]) assert.equal(item.jobId, job.jobReference.jobId);
  assert(Number.isSafeInteger(state.rows) && state.rows > 0);
  assert.equal(String(state.rows), state.totalRows); assert.equal(state.rows, manifest.rows);
  assert.equal(state.pages, manifest.pages.length);
  const sql = readFileSync(resolve(directory, 'full-query.sql'), 'utf8');
  assert.equal(sha(sql), plan.sqlSha256, 'SQL source hash mismatch');
  assert.equal(job.configuration.query.query, sql, 'Saved query is not the completed job');
  const packages = plan.packageFiles.map((item, index) => {
    const bytes = readFileSync(resolve(directory, 'source-packages', String(index + 1).padStart(5, '0') + '.json'));
    assert.equal(sha(bytes), item.sha256, 'SQL discovery package changed');
    return JSON.parse(bytes);
  });
  const sourceIdentities = identities(packages), currentIdentities = identities([currentCatalog]);
  assert.equal(new Set(sourceIdentities.map(item => item.familyId)).size, sourceIdentities.length, 'Duplicate discovery Family');
  assert.equal(sourceIdentities.length, plan.familyCount);
  assert.deepEqual(sourceIdentities, currentIdentities, 'SQL discovery definitions differ from Ready runtime');
  const familyIds = new Set(sourceIdentities.map(item => item.familyId));
  const pin = { kind: 'discovery-sql-results-v1', jobId: state.jobId, rows: String(state.rows),
    manifestSha256: sha(manifestBytes), planSha256: sha(readFileSync(resolve(directory, 'plan.json'))),
    sqlSha256: plan.sqlSha256, rangeStart: plan.rangeStart, rangeEnd: plan.rangeEnd, blockRange: plan.blockRange, cutoff: plan.cutoff };
  return {
    pin,
    *entries() {
      let count = 0;
      for (const [index, part] of manifest.pages.entries()) {
        assert.equal(part.name, 'full-result-page-' + String(index + 1).padStart(5, '0') + '.json', 'SQL page sequence gap');
        const bytes = readFileSync(resolve(directory, part.name));
        assert.equal(sha(bytes), part.sha256, 'SQL result page hash mismatch');
        const page = JSON.parse(bytes);
        assert.equal(page.jobComplete, true); assert.equal(page.jobReference.jobId, state.jobId);
        assert.equal(page.totalRows, state.totalRows); assert.equal(page.rows.length, part.rows);
        for (const raw of page.rows) {
          const row = decodeRow(page.schema.fields, raw), block = Number(row.source_block);
          assert(['candidate', 'opaque'].includes(row.kind) && familyIds.has(row.family), 'Unknown SQL record kind or Family');
          assert(Number.isSafeInteger(block) && block >= plan.blockRange.fromBlock && block <= plan.blockRange.toBlock, 'SQL source block outside requested range');
          assert(/^0x[0-9a-f]{64}$/i.test(row.tx_hash), 'Invalid SQL evidence transaction');
          const snapshot = JSON.parse(row.snapshot);
          assert.equal(snapshot.blockNumber, block); assert.equal(snapshot.transactionHash.toLowerCase(), row.tx_hash.toLowerCase());
          assert(/^0x[0-9a-f]{64}$/i.test(snapshot.blockHash), 'Invalid SQL block hash');
          if (block === plan.cutoff.number) assert.equal(snapshot.blockHash.toLowerCase(), plan.cutoff.hash.toLowerCase(), 'SQL cutoff row hash mismatch');
          count++;
          yield { ...row, snapshot, block };
        }
      }
      assert.equal(count, state.rows, 'SQL result row count mismatch');
    },
  };
}
