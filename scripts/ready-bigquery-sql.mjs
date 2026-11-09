import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { decodeRow, digest } from './bigquery-table.mjs';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

export function renderReadyDiscoverySql(ref, libraries, sourceQuery) {
  const table = [ref.projectId, ref.datasetId, ref.tableId].join('.');
  assert(/^[a-z][a-z0-9-]+\.[A-Za-z_]\w*\.[A-Za-z0-9_-]+$/.test(table));
  assert(libraries.length && libraries.every(uri => /^gs:\/\/[a-z0-9_.-]+\/mev-discovery-json-check\/[a-f0-9]{64}\/[a-z0-9-]+\.js$/.test(uri)));
  const template = readFileSync(new URL('./ready-discovery-udf.sql', import.meta.url), 'utf8');
  const [discovery, result] = template.split('-- DISCOVERY_RESULT');
  assert(result, 'Missing discovery query projection');
  const source = sourceQuery === undefined ? '`' + table + '`' : 'source_transactions';
  const prefix = sourceQuery === undefined ? discovery : discovery.replace('WITH discovered AS (',
    'WITH source_transactions AS (\n' + sourceQuery + '\n), discovered AS (');
  return prefix
    .replace('__LIBRARY_URIS__', libraries.map(uri => JSON.stringify(uri)).join(', '))
    .replace('`__SOURCE_TABLE__`', source)
    + `, source_coverage AS (
  SELECT CAST(COUNT(*) AS STRING) AS sourceRows,
    MIN(block_number) AS minBlock,
    ARRAY_AGG(STRUCT(block_number AS number, block_hash AS blockHash)
      ORDER BY block_number DESC, block_hash ASC LIMIT 1)[SAFE_OFFSET(0)] AS firstHead,
    ARRAY_AGG(STRUCT(block_number AS number, block_hash AS blockHash)
      ORDER BY block_number DESC, block_hash DESC LIMIT 1)[SAFE_OFFSET(0)] AS lastHead
  FROM ${source}
)
SELECT 'source' AS row_kind, TO_JSON_STRING(coverage) AS body
FROM source_coverage AS coverage
UNION ALL
SELECT 'witness' AS row_kind, TO_JSON_STRING(STRUCT(
  kind, family, instance_key AS key, source_block AS block, tx_hash AS tx,
  source_tx_hash AS sourceTx, source_hash AS sourceHash, PARSE_JSON(snapshot) AS snapshot
)) AS body
FROM (SELECT DISTINCT * FROM best_witnesses)
ORDER BY row_kind, body;`;
}

export async function compileReadyDiscovery(root, catalog, bucket) {
  const { buildDiscoveryUdf } = await import('./ready-discovery-udf-build.mjs');
  const temporary = mkdtempSync(join(tmpdir(), 'ready-discovery-'));
  try {
    const out = join(temporary, 'kernel');
    const expected = catalog.listAll().map(family => family.plugin.manifest.familyId).sort();
    const report = await buildDiscoveryUdf({
      catalog: join(root, 'listener/src/searcher/generated/family-capability-shadow.generated.json'),
      sourceRoot: join(root, 'listener'),
      reader: join(root, 'scripts/bigquery-table.mjs'),
      out, familyIds: expected,
    });
    assert.deepEqual([...report.familyIds].sort(), expected, 'Regenerate the capability catalog for this checkout before SQL discovery');
    return report.resources.map(resource => {
      const bytes = readFileSync(join(out, resource.file));
      assert.equal(sha256(bytes), resource.sha256, 'Discovery library changed');
      const object = 'mev-discovery-json-check/' + resource.sha256 + '/' + resource.file;
      return { uri: 'gs://' + bucket + '/' + object, bucket, object, bytes, sha256: resource.sha256 };
    });
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

export function readyDiscoveryJob({ ref, pin, location, libraries, maxBytes, codeHash, sourceQuery }) {
  assert(typeof location === 'string' && /^[A-Za-z0-9-]+$/.test(location), 'Missing BigQuery table location');
  assert(Number.isSafeInteger(maxBytes) && maxBytes > 0, '--sql-max-bytes must be a positive integer');
  const query = {
    query: renderReadyDiscoverySql(ref, libraries.map(library => library.uri), sourceQuery),
    useLegacySql: false, useQueryCache: false, maximumBytesBilled: String(maxBytes),
  };
  const jobId = 'mev_ready_discovery_' + digest({ pin, location, query, codeHash }).slice(0, 32);
  return { jobId, location, query };
}

export async function openReadyDiscoveryJob(api, ref, spec, libraries) {
  const base = 'https://bigquery.googleapis.com/bigquery/v2/projects/' + ref.projectId;
  const suffix = '?location=' + spec.location;
  const url = base + '/jobs/' + spec.jobId + suffix;
  let job = await api(url, { allowStatus: 404 });
  if (!job) {
    for (const library of libraries) {
      const object = encodeURIComponent(library.object);
      await api('https://storage.googleapis.com/upload/storage/v1/b/' + library.bucket +
        '/o?uploadType=media&ifGenerationMatch=0&name=' + object, {
        method: 'POST', headers: { 'Content-Type': 'application/javascript' }, body: library.bytes, allowStatus: 412,
      });
      const bytes = await api('https://storage.googleapis.com/storage/v1/b/' + library.bucket + '/o/' + object + '?alt=media', { bytes: true });
      assert.equal(sha256(bytes), library.sha256, 'Stored discovery library differs from compiled source');
    }
    job = await api(base + '/jobs', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, allowStatus: 409,
      body: JSON.stringify({
        jobReference: { projectId: ref.projectId, location: spec.location, jobId: spec.jobId },
        configuration: { jobTimeoutMs: '1200000', query: spec.query },
      }),
    }) ?? await api(url);
  }
  assert.equal(job.jobReference.jobId, spec.jobId);
  assert.equal(job.configuration.query.query, spec.query.query, 'Existing discovery job SQL differs');
  assert.equal(job.configuration.query.maximumBytesBilled, spec.query.maximumBytesBilled);
  assert(!job.status?.errorResult, 'BigQuery discovery failed: ' + job.status?.errorResult?.reason);
  return async (pageSize, pageToken) => {
    const pageUrl = new URL(base + '/queries/' + spec.jobId + suffix);
    pageUrl.searchParams.set('maxResults', String(pageSize));
    pageUrl.searchParams.set('timeoutMs', '10000');
    if (pageToken) pageUrl.searchParams.set('pageToken', pageToken);
    for (let attempt = 0; attempt < 6; attempt++) {
      const page = await api(pageUrl);
      if (page.jobComplete) return page;
    }
    throw new Error('SQL discovery is still running. Resume the same BigQuery job ' + spec.jobId);
  };
}

export function decodeSqlDiscoveryRow(fields, row, wiring, instanceKey, collectOpaque) {
  const value = decodeRow(fields, row);
  const record = JSON.parse(value.body);
  if (value.row_kind === 'source') {
    const { sourceRows: rows, minBlock, firstHead, lastHead } = record;
    assert(/^\d+$/.test(rows) && Number.isSafeInteger(Number(rows)), 'Invalid SQL discovery row count');
    assert(firstHead && Number.isSafeInteger(minBlock) && minBlock > 0 && Number.isSafeInteger(firstHead.number) &&
      minBlock <= firstHead.number && /^0x[0-9a-f]{64}$/i.test(firstHead.blockHash), 'Invalid SQL discovery coverage');
    assert.deepEqual(firstHead, lastHead, 'Conflicting maximum block hash');
    return { coverage: { rows, minBlock, maxBlock: firstHead.number, maxHash: firstHead.blockHash } };
  }
  assert.equal(value.row_kind, 'witness');
  assert(Number.isSafeInteger(record.block) && record.block > 0 &&
    /^0x[0-9a-f]{64}$/i.test(record.sourceHash) && /^0x[0-9a-f]{64}$/i.test(record.sourceTx), 'Invalid SQL discovery source');
  assert.equal(record.tx, record.sourceTx.toLowerCase(), 'SQL discovery transaction differs');
  const witness = record.kind === 'candidate' ? wiring.decodeCandidateSnapshot(record.snapshot) : record.snapshot;
  assert.equal(witness.transactionHash.toLowerCase(), record.tx, 'SQL discovery witness transaction differs');
  assert.equal(witness.blockNumber, record.block, 'SQL discovery witness block differs');
  assert.equal(witness.blockHash.toLowerCase(), record.sourceHash.toLowerCase(), 'SQL discovery witness block hash differs');
  if (record.kind === 'candidate') {
    assert.equal(witness.familyId, record.family);
    assert.equal(instanceKey(witness), record.key, 'SQL discovery candidate key differs');
    return { candidate: witness };
  }
  assert.equal(record.kind, 'opaque');
  assert(collectOpaque(witness).some(item => item.key === record.key && item.family === record.family), 'SQL opaque nomination disagrees with the active catalog');
  return { opaque: { key: record.key, log: witness } };
}
