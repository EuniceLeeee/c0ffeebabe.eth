#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createOpaqueNominationCollector } from './ready-opaque-nominations.mjs';
import { compileReadyDiscovery, readyDiscoveryJob, openReadyDiscoveryJob, decodeSqlDiscoveryRow } from './ready-bigquery-sql.mjs';
import { parseReadyWindow, resolveReadyWindow, renderEthereumInputs, refreshReadyRawTable, renderRawWindow, runWindowQuery } from './ready-bigquery-window.mjs';
import { applyReadyLiveFamilyFlags, enableReadyFamilies } from './ready-family-activation.mjs';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, statfsSync, unlinkSync, realpathSync, renameSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { tableRef, tableUrl, sourcePin, decodeRow, observationsFromTx, emptyCounts, digest, saveJson, makeApi } from './bigquery-table.mjs';

// Only a reference to the last completed result; the existing checkpoint remains
// the sole authority for validation, memo reuse and retry history.
function rememberReady(profilePath, out) {
  assert(existsSync(out + '/checkpoint.json'), 'Completed Ready checkpoint is missing; refusing to publish reference');
  const path = resolve(profilePath) + '.latest-ready.json', temporary = path + '.tmp.' + process.pid;
  writeFileSync(temporary, JSON.stringify({ checkpoint: out + '/checkpoint.json' }) + '\n', { mode: 0o600 });
  renameSync(temporary, path);
}

function selectCheckpointReuse(args, out, profile) {
  assert(!(args['no-reuse-checkpoint'] && args['reuse-checkpoint'] !== undefined), 'Checkpoint reuse options conflict');
  const identityPath = out + '/run-identity.json';
  let enabled, checkpoint;
  if (existsSync(identityPath)) {
    const saved = JSON.parse(readFileSync(identityPath, 'utf8'));
    enabled = saved.checkpointReuse ?? (saved.reuseCheckpoint !== undefined);
    checkpoint = saved.reuseCheckpoint ?? null;
    assert(!args['no-reuse-checkpoint'] || !enabled, 'Cannot disable checkpoint reuse in a started run; use a new output directory');
    assert(args['reuse-checkpoint'] === undefined || resolve(args['reuse-checkpoint']) === checkpoint, 'Run code/config changed: checkpoint reuse source');
  } else {
    enabled = !args['no-reuse-checkpoint'];
    const latestPath = resolve(args.profile) + '.latest-ready.json';
    checkpoint = enabled ? args['reuse-checkpoint'] ?? profile.ready ?? null : null;
    if (enabled && args['reuse-checkpoint'] === undefined && existsSync(latestPath)) {
      checkpoint = JSON.parse(readFileSync(latestPath, 'utf8')).checkpoint;
      assert(typeof checkpoint === 'string' && checkpoint.length > 0, 'Invalid latest Ready reference; refusing a fresh rebuild');
    }
  }
  if (checkpoint !== null) {
    assert(typeof checkpoint === 'string' && checkpoint.startsWith('/'), 'Reuse checkpoint must be an absolute path');
    checkpoint = resolve(checkpoint);
    assert.notEqual(checkpoint, out + '/checkpoint.json', 'Reuse source must differ from the new run checkpoint');
    assert(existsSync(out + '/checkpoint.json') || existsSync(checkpoint), 'Previous Ready checkpoint is missing; restore it or explicitly use --no-reuse-checkpoint in a new run');
  }
  return { enabled, checkpoint };
}

export async function main(argv = process.argv.slice(2)) {
  const { values: args } = parseArgs({ args: argv, options: {
    table: { type: 'string' }, out: { type: 'string' }, root: { type: 'string' },
    'profile': { type: 'string', default: '/opt/mev-cloud/manual-live/profile.json' },
    'token-stdin': { type: 'boolean' }, 'auth-status': { type: 'boolean' },
    'page-size': { type: 'string', default: '1000' }, 'max-pages': { type: 'string' },
    'concurrency': { type: 'string', default: '4' }, resume: { type: 'boolean' },
    'revm-sim-bin': { type: 'string' },
    'reuse-checkpoint': { type: 'string' },
    'no-reuse-checkpoint': { type: 'boolean' },
    'from-day': { type: 'string' }, 'to-day': { type: 'string' },
    'from-block': { type: 'string' }, 'to-block': { type: 'string' },
    'live-config': { type: 'string' }, 'incremental-table': { type: 'string' },
    'raw-only': { type: 'boolean' }, 'candidates-only': { type: 'boolean' },
    'sql-discovery-bucket': { type: 'string' }, 'sql-max-bytes': { type: 'string' },
  } });
  assert(args.out && args.out.startsWith('/'), '--out must be an absolute dedicated run directory');
  const out = resolve(args.out), tokenFile = out + '/bigquery-auth.json';
  if (args['token-stdin']) {
    assert(existsSync(out), 'Run directory missing');
    let token = ''; for await (const chunk of process.stdin) token += chunk;
    token = token.trim(); assert(/^[A-Za-z0-9._~-]{30,8192}$/.test(token), 'Invalid access token');
    const phase = existsSync(out + '/status.json') ? JSON.parse(readFileSync(out + '/status.json', 'utf8')).phase : null;
    if (['ready', 'candidates', 'raw-complete'].includes(phase)) { console.log('BigQuery credential no longer needed'); return; }
    saveJson(tokenFile, { token, expiresAt: Date.now() + 3300000 });
    console.log('Temporary BigQuery credential refreshed'); return;
  }
  if (args['auth-status']) {
    const status = existsSync(out + '/status.json') ? JSON.parse(readFileSync(out + '/status.json', 'utf8')) : { phase: 'not-started' };
    console.log(JSON.stringify({ phase: status.phase, rows: status.rows ?? 0, pages: status.pages ?? 0 })); return;
  }
  if (existsSync(out + '/status.json') &&
      ['ready', 'candidates', 'raw-complete'].includes(JSON.parse(readFileSync(out + '/status.json', 'utf8')).phase)) {
    console.log('This BigQuery run is complete; no additional round started'); return;
  }
  // Strict already finished if its result was saved, even if publishing the
  // latest-reference/status failed. Recover that bookkeeping without re-running.
  if (existsSync(out + '/result.json')) {
    const result = JSON.parse(readFileSync(out + '/result.json', 'utf8'));
    const saved = JSON.parse(readFileSync(out + '/run-identity.json', 'utf8'));
    assert.equal(saved.profilePath, resolve(args.profile), 'Completed Ready belongs to a different profile');
    rememberReady(args.profile, out);
    saveJson(out + '/status.json', { phase: 'ready', rows: result.read.rows, pages: result.read.pages,
      cutoff: result.cutoff, accounting: result.accounting, updatedAt: new Date().toISOString() });
    if (existsSync(tokenFile)) unlinkSync(tokenFile);
    console.log('Completed Ready publication recovered; no additional strict run started'); return;
  }
  const root = resolve(args.root ?? dirname(import.meta.dirname));
  const history = tableRef(args.table ?? '');
  let ref = history;
  const selection = parseReadyWindow(args);
  assert(!args['raw-only'] || selection && !args['candidates-only'], 'Raw export requires a window and cannot run candidate discovery');
  assert(!args['incremental-table'] || selection, 'An incremental table requires a window');
  const bucket = args['sql-discovery-bucket'];
  const maxBytes = Number(args['sql-max-bytes']);
  if (selection || bucket !== undefined) assert(Number.isSafeInteger(maxBytes) && maxBytes > 0, 'BigQuery windows require a positive --sql-max-bytes');
  else assert(args['sql-max-bytes'] === undefined, '--sql-max-bytes requires SQL mode');
  if (bucket !== undefined) assert(/^[a-z0-9_.-]+$/.test(bucket), 'Invalid BigQuery discovery bucket');
  if (selection && !args['raw-only']) assert(bucket && args['live-config'], 'Candidate windows require --sql-discovery-bucket and --live-config');
  const pageSize = Number(args['page-size']), concurrency = Number(args.concurrency);
  assert(Number.isInteger(pageSize) && pageSize > 0 && pageSize <= 10000, 'Invalid page size');
  assert(Number.isInteger(concurrency) && concurrency > 0 && concurrency <= 24, 'Invalid concurrency');
  const maxPages = args['max-pages'] === undefined ? Infinity : Number(args['max-pages']);
  assert(maxPages === Infinity || Number.isInteger(maxPages) && maxPages > 0, 'Invalid max-pages');
  const status = value => { saveJson(out + '/status.json', { ...value, updatedAt: new Date().toISOString() }); console.log(JSON.stringify(value)); };
  const profile = args['raw-only'] ? null : JSON.parse(readFileSync(args.profile, 'utf8'));
  const reuse = args['raw-only'] || args['candidates-only'] ? { enabled: false, checkpoint: null } : selectCheckpointReuse(args, out, profile);
  const reuseCheckpoint = reuse.checkpoint;
  const api = makeApi(tokenFile);
  const historicalMeta = await api(tableUrl(history));
  const window = selection ? await resolveReadyWindow(api, history, historicalMeta.location, maxBytes, selection) : null;
  let sourceQuery = window ? renderEthereumInputs(window) : undefined;
  if (args['incremental-table']) {
    ref = tableRef(args['incremental-table']);
    const refreshPath = out + '/incremental-refresh.json';
    if (args.resume && existsSync(refreshPath)) {
      const previous = JSON.parse(readFileSync(refreshPath, 'utf8'));
      assert.deepEqual(previous.table, ref, 'Incremental table changed during resume');
      assert.deepEqual(previous.window, window, 'Incremental window changed during resume');
    } else {
      const update = await refreshReadyRawTable(api, history, ref, historicalMeta.location, maxBytes, window);
      saveJson(refreshPath, { ...update, window });
    }
    sourceQuery = renderRawWindow(ref, window);
  }
  if (args['raw-only']) {
    const sql = 'SELECT * FROM (\n' + sourceQuery + '\n) ORDER BY block_number, transaction_index, tx_hash';
    const result = await runWindowQuery(api, ref, historicalMeta.location, maxBytes, sql, pageSize, 'ready_raw');
    assert.equal(result.page.totalRows, window.transactions, 'Raw input does not cover the canonical transaction count');
    saveJson(out + '/raw-preview.json', { window, jobId: result.jobId, totalRows: result.page.totalRows,
      fields: result.page.schema.fields, rows: result.page.rows, moreResults: Boolean(result.page.pageToken) });
    status({ phase: 'raw-complete', jobId: result.jobId, rows: Number(window.transactions), window });
    unlinkSync(tokenFile);
    return;
  }
  const url = tableUrl(ref);
  const meta = ref === history ? historicalMeta : await api(url);
  const pin = sourcePin(meta);
  const inputRows = window?.transactions ?? pin.rows;
  const pinPath = out + '/input-pin.json';
  if (existsSync(pinPath)) { assert(args.resume, 'Existing run requires --resume'); assert.deepEqual(JSON.parse(readFileSync(pinPath, 'utf8')), pin, 'Input table changed'); }
  else saveJson(pinPath, pin);
  const endpoint = JSON.parse(readFileSync(profile.rpcFile, 'utf8')).MAINNET_RPC_URL;
  assert(typeof endpoint === 'string' && endpoint, 'Missing configured RPC');
  assert(args['revm-sim-bin'] === undefined, 'Local REVM is unsupported; Ready uses the configured node RPC');
  Object.assign(process.env, { SEARCHER_DRY_RUN: '1', SEARCHER_BLOCKSCAN_SUBMIT: '0', SEARCHER_TEST_DISABLE_DOTENV: '1',
    MAINNET_RPC_URL: endpoint, SEARCHER_LIVE_RPC_URL: endpoint,
    BOTVM_ADDRESS: profile.executor, BOTVM_OWNER: profile.wallet, SEARCHER_REBUILD_REVM_TIMEOUT_MS: '60000' });
  const activations = args['live-config'] === undefined ? enableReadyFamilies(root) :
    applyReadyLiveFamilyFlags(root, JSON.parse(readFileSync(args['live-config'], 'utf8')));
  const { createRebuildWiring, rebuildFamilyInstanceDedupeKey } = await import(pathToFileURL(root + '/listener/src/searcher/universe-rebuild-production.ts'));
  const { PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG: catalog } = await import(pathToFileURL(root + '/listener/src/searcher/venues/production-family-composition.ts'));
  const identity = { executor: profile.executor, transactionOrigin: profile.wallet };
  const wiring = createRebuildWiring({ rpcUrl: endpoint, executionIdentity: identity });
  wiring.readyThrottle?.limitConcurrency(concurrency);
  const codeFiles = []; const visit = folder => { for (const file of readdirSync(folder, { withFileTypes: true }).sort((a,b) => a.name.localeCompare(b.name))) {
    const path = folder + '/' + file.name;
    if (file.isDirectory()) visit(path); else if (file.isFile()) codeFiles.push([path.slice(root.length), digest(readFileSync(path).toString())]);
  } }; visit(root + '/listener/src');
  const codeHash = digest(codeFiles);
  const readerHash = digest([readFileSync(new URL('./ready-bigquery.mjs', import.meta.url), 'utf8'), readFileSync(new URL('./bigquery-table.mjs', import.meta.url), 'utf8'), readFileSync(new URL('./ready-family-activation.mjs', import.meta.url), 'utf8'), readFileSync(new URL('./ready-opaque-nominations.mjs', import.meta.url), 'utf8')]);
  const sqlReaderHash = bucket === undefined ? null : digest(readFileSync(new URL('./ready-bigquery-sql.mjs', import.meta.url), 'utf8'));
  const libraries = bucket === undefined ? [] : await compileReadyDiscovery(root, catalog, bucket);
  const sqlJob = bucket === undefined ? null : readyDiscoveryJob({ ref, pin, location: meta.location, libraries, maxBytes, codeHash, sourceQuery });
  const runIdentity = { input: pin, codeHash, readerHash, executionIdentity: identity, simulator: 'node-rpc', activations, plan: wiring.expectedSourcePlanFingerprints(),
    profilePath: resolve(args.profile), checkpointReuse: reuse.enabled, reuseCheckpoint,
    ...(sqlJob ? { sqlJob, sqlReaderHash } : {}),
    ...(window ? { window, windowReaderHash: digest(readFileSync(new URL('./ready-bigquery-window.mjs', import.meta.url), 'utf8')) } : {}),
    ...(args['candidates-only'] ? { candidatesOnly: true } : {}) };
  if (existsSync(out + '/run-identity.json')) assert.deepEqual(JSON.parse(readFileSync(out + '/run-identity.json', 'utf8')), runIdentity, 'Run code/config changed');
  else saveJson(out + '/run-identity.json', runIdentity);
  const byKey = new Map(), opaque = new Map();
  const mergeCandidate = candidate => {
    const key = rebuildFamilyInstanceDedupeKey(candidate), prior = byKey.get(key);
    const chosen = prior ? wiring.dedupeFamilyCandidates([{ kind: 'startup-candidate', candidate: prior }, { kind: 'startup-candidate', candidate }])[0] : candidate;
    if (chosen) byKey.set(key, chosen);
    return key;
  };
  // Shared-Vault/PoolManager retain evidence follows Family-declared emitter identity.
  // No protocol names, ABI/selectors or address allowlists live in this importer.
  const collectOpaque = createOpaqueNominationCollector(catalog);
  const segmentDir = out + '/pages'; mkdirSync(segmentDir, { recursive: true });
  const counts = sqlJob ? { sqlCandidates: 0, sqlOpaque: 0 } : emptyCounts();
  let state = { pages: 0, rows: 0, nextPageToken: null, inputComplete: false, counts, minBlock: null, maxBlock: null, maxHash: null, chainHash: digest(pin) };
  for (const file of readdirSync(segmentDir).filter(file => /^\d{8}\.json$/.test(file)).sort()) {
    const segment = JSON.parse(readFileSync(segmentDir + '/' + file, 'utf8'));
    assert.equal(segment.previousHash, state.chainHash, 'Checkpoint chain mismatch');
    assert.equal(segment.state.pages, state.pages + 1, 'Checkpoint sequence gap');
    const { segmentHash, ...payload } = segment; assert.equal(segmentHash, digest(payload), 'Checkpoint corrupted');
    for (const candidate of segment.candidates) mergeCandidate(wiring.decodeCandidateSnapshot(candidate));
    for (const [key, log] of segment.opaque) opaque.set(key, log);
    state = { ...segment.state, chainHash: segmentHash };
  }
  let readSqlPage;
  while (!state.inputComplete && state.pages < maxPages) {
    const disk = statfsSync(out); assert(Number(disk.bavail) * Number(disk.bsize) >= 2 * 1024 ** 3, 'Disk reserve below 2 GiB');
    const pageUrl = new URL(url + '/data'); pageUrl.searchParams.set('maxResults', String(pageSize));
    if (state.nextPageToken) pageUrl.searchParams.set('pageToken', state.nextPageToken);
    if (sqlJob && !readSqlPage) {
      status({ phase: 'sql-discovery', jobId: sqlJob.jobId, sqlResultRows: state.sqlResultRows ?? 0, pages: state.pages });
      readSqlPage = await openReadyDiscoveryJob(api, ref, sqlJob, libraries);
    }
    const page = readSqlPage ? await readSqlPage(pageSize, state.nextPageToken) : await api(pageUrl);
    if (!readSqlPage) assert.equal(page.totalRows, pin.rows, 'Input row count changed');
    const rows = page.rows ?? [];
    assert(rows.length || !page.pageToken, 'Empty non-terminal BigQuery page');
    const observations = [], sqlCandidates = [], sqlOpaque = [];
    let sourceRows = state.rows;
    for (const row of rows) {
      if (readSqlPage) {
        const decoded = decodeSqlDiscoveryRow(page.schema.fields, row, wiring, rebuildFamilyInstanceDedupeKey, collectOpaque);
        if (decoded.coverage) {
          assert.equal(sourceRows, 0, 'Duplicate SQL source coverage');
          assert.equal(decoded.coverage.rows, inputRows, 'SQL discovery input row count changed');
          if (window) {
            assert(decoded.coverage.minBlock >= window.fromBlock && decoded.coverage.maxBlock <= window.toBlock, 'SQL discovery escaped its block range');
            if (decoded.coverage.maxBlock === window.toBlock) assert.equal(decoded.coverage.maxHash.toLowerCase(), window.headHash);
          }
          const { minBlock, maxBlock, maxHash } = decoded.coverage;
          Object.assign(state, { minBlock, maxBlock, maxHash });
          sourceRows = Number(decoded.coverage.rows);
        } else {
          assert(sourceRows > 0, 'SQL witnesses arrived before source coverage');
          if (decoded.candidate) {
            sqlCandidates.push({ kind: 'startup-candidate', candidate: decoded.candidate });
            state.counts.sqlCandidates++;
          } else {
            sqlOpaque.push(decoded.opaque);
            state.counts.sqlOpaque++;
          }
        }
        continue;
      }
      const tx = decodeRow(meta.schema.fields, row), block = Number(tx.block_number);
      for (const observation of observationsFromTx(tx, state.counts)) observations.push(observation);
      sourceRows++;
      state.minBlock = state.minBlock === null ? block : Math.min(state.minBlock, block);
      if (state.maxBlock === null || block > state.maxBlock) { state.maxBlock = block; state.maxHash = tx.block_hash; }
      else if (block === state.maxBlock) assert.equal(tx.block_hash.toLowerCase(), state.maxHash.toLowerCase(), 'Conflicting maximum block hash');
    }
    const changed = new Set();
    for (const candidate of wiring.dedupeFamilyCandidates(readSqlPage ? sqlCandidates : observations)) changed.add(mergeCandidate(candidate));
    const opaqueChanges = new Map();
    const retain = ({ key, log }) => {
      if (!opaque.has(key) || opaque.get(key).blockNumber < log.blockNumber) {
        opaque.set(key, log); opaqueChanges.set(key, log);
      }
    };
    if (readSqlPage) sqlOpaque.forEach(retain);
    else for (const log of observations) collectOpaque(log).forEach(retain);
    const next = { ...state, pages: state.pages + 1, rows: sourceRows, nextPageToken: page.pageToken ?? null, inputComplete: !page.pageToken };
    if (readSqlPage) {
      const total = Number(page.totalRows);
      assert(Number.isSafeInteger(total) && total >= 1, 'Missing SQL result row count');
      next.sqlResultRows = (state.sqlResultRows ?? 0) + rows.length;
      assert(next.sqlResultRows <= total, 'SQL discovery result exceeded its row count');
      if (next.inputComplete) assert.equal(next.sqlResultRows, total, 'Incomplete SQL discovery result');
    }
    delete next.chainHash;
    assert(next.rows <= Number(inputRows), 'Read beyond pinned row count');
    if (next.inputComplete) assert.equal(next.rows, Number(inputRows), 'Incomplete terminal page');
    const segment = { previousHash: state.chainHash, pageContentHash: digest(page), state: next,
      candidates: [...changed].map(key => wiring.encodeCandidateSnapshot(byKey.get(key))), opaque: [...opaqueChanges] };
    const segmentHash = digest(segment); saveJson(segmentDir + '/' + String(next.pages).padStart(8, '0') + '.json', { ...segment, segmentHash });
    state = { ...next, chainHash: segmentHash };
    status({ phase: 'reading', ...state, nextPageToken: undefined, candidates: byKey.size, opaqueInstances: opaque.size, rssMiB: Math.round(process.memoryUsage().rss / 1024 ** 2) });
    if (state.pages % 100 === 0 || state.inputComplete) assert.deepEqual(sourcePin(await api(url)), pin, 'Input table mutated');
  }
  if (!state.inputComplete) { status({ phase: 'sample-complete', rows: state.rows, ...(sqlJob ? { sqlResultRows: state.sqlResultRows ?? 0 } : {}), pages: state.pages, candidates: byKey.size, opaqueInstances: opaque.size }); return; }
  assert(state.maxBlock !== null, 'Empty table cannot produce Ready');
  assert.deepEqual(sourcePin(await api(url)), pin, 'Input table mutated');
  if (args['candidates-only']) {
    const familyIds = catalog.listAll().map(family => family.plugin.manifest.familyId).sort();
    saveJson(out + '/nominations.json', { window, familyIds, jobId: sqlJob?.jobId ?? null,
      candidates: [...byKey.values()].map(candidate => wiring.encodeCandidateSnapshot(candidate)),
      opaque: [...opaque.entries()] });
    status({ phase: 'candidates', jobId: sqlJob?.jobId ?? null, rows: state.rows, familyIds,
      candidates: byKey.size, opaqueInstances: opaque.size });
    unlinkSync(tokenFile);
    return;
  }
  unlinkSync(tokenFile);
  status({ phase: 'strict', rows: state.rows, pages: state.pages, candidates: byKey.size, opaqueInstances: opaque.size, cutoff: state.maxBlock });
  const cutoff = await wiring.freezeCanonicalHead(window?.toBlock ?? state.maxBlock);
  assert.equal(cutoff.hash.toLowerCase(), window?.headHash ?? state.maxHash.toLowerCase(), 'Input maximum block is not canonical');
  const reverse = await wiring.reverseBindOpaqueCandidates({ observations: [...opaque.values()], cutoff, knownCandidates: [...byKey.values()] });
  for (const candidate of reverse) mergeCandidate(candidate);
  const candidates = [...byKey.values()]; opaque.clear(); byKey.clear();
  const full = createRebuildWiring({ rpcUrl: endpoint, executionIdentity: identity, startupCandidates: candidates,
    readyThrottle: wiring.readyThrottle });
  const { rebuildUniverse } = await import(pathToFileURL(root + '/listener/src/searcher/universe-rebuild-runner.ts'));
  const { UniverseRebuildCheckpointStore } = await import(pathToFileURL(root + '/listener/src/searcher/universe-rebuild-checkpoint.ts'));
  // Imported candidates use the production startup source; the normal one-block
  // activity scan seals its OWN coverage. Never fabricate week-long RPC receipts.
  const store = new UniverseRebuildCheckpointStore({ path: out + '/checkpoint.json' });
  const runId = 'bigquery-ready-' + digest(runIdentity).slice(0, 20);
  let prior = await store.load();
  if (prior === null && reuseCheckpoint !== null) {
    prior = await store.inheritReadyFrom(new UniverseRebuildCheckpointStore({ path: resolve(reuseCheckpoint) }));
    console.log(JSON.stringify({ phase: 'ready-checkpoint-inherited', checkpointFingerprint: prior.checkpointFingerprint,
      verifiedMemos: Object.keys(prior.verifiedMemos).length, retryable: Object.keys(prior.retryableAttemptsByCandidateKey).length }));
  } else if (prior === null) {
    console.log(JSON.stringify({ phase: 'ready-checkpoint-not-inherited', reason: reuse.enabled ? 'first-run-no-previous-result' : 'explicitly-disabled' }));
  }
  const ready = await rebuildUniverse({ ...full, store,
    runId, observationRange: { fromBlock: cutoff.number, toBlock: cutoff.number },
    attestationConcurrency: concurrency,
    resumeCompletedOutcomes: args.resume === true && prior?.inProgressRun?.runId === runId,
    log: text => console.log(text) });
  saveJson(out + '/result.json', { input: pin, inputRange: { fromBlock: state.minBlock, toBlock: state.maxBlock }, read: state,
    nominatedCandidates: candidates.length, cutoff: ready.cutoff, generation: ready.generation, accounting: ready.candidateAccounting, codeHash });
  rememberReady(args.profile, out);
  status({ phase: 'ready', rows: state.rows, pages: state.pages, cutoff: ready.cutoff, accounting: ready.candidateAccounting });
  if (existsSync(tokenFile)) unlinkSync(tokenFile);
}

if (process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url) {
  main().then(() => process.exit(0)).catch(error => {
    const message = String(error?.message ?? error).replace(/https?:\/\/[^\s"']+/g, '[REDACTED_URL]');
    const index = process.argv.indexOf('--out'), out = index < 0 ? undefined : process.argv[index + 1];
    if (out?.startsWith('/') && existsSync(out + '/input-pin.json')) {
      const prior = existsSync(out + '/status.json') ? JSON.parse(readFileSync(out + '/status.json', 'utf8')) : {};
      saveJson(out + '/status.json', { ...prior, previousPhase: prior.phase, phase: 'failed', error: message, updatedAt: new Date().toISOString() });
      if (existsSync(out + '/bigquery-auth.json')) unlinkSync(out + '/bigquery-auth.json');
    }
    console.error(message); process.exit(1);
  });
}
