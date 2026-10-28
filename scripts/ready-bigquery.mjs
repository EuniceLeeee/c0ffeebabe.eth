#!/usr/bin/env node
import assert from 'node:assert/strict';
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
  } });
  assert(args.out && args.out.startsWith('/'), '--out must be an absolute dedicated run directory');
  const out = resolve(args.out), tokenFile = out + '/bigquery-auth.json';
  if (args['token-stdin']) {
    assert(existsSync(out), 'Run directory missing');
    let token = ''; for await (const chunk of process.stdin) token += chunk;
    token = token.trim(); assert(/^[A-Za-z0-9._~-]{30,8192}$/.test(token), 'Invalid access token');
    const phase = existsSync(out + '/status.json') ? JSON.parse(readFileSync(out + '/status.json', 'utf8')).phase : null;
    if (phase === 'ready') { console.log('BigQuery credential no longer needed'); return; }
    saveJson(tokenFile, { token, expiresAt: Date.now() + 3300000 });
    console.log('Temporary BigQuery credential refreshed'); return;
  }
  if (args['auth-status']) {
    const status = existsSync(out + '/status.json') ? JSON.parse(readFileSync(out + '/status.json', 'utf8')) : { phase: 'not-started' };
    console.log(JSON.stringify({ phase: status.phase, rows: status.rows ?? 0, pages: status.pages ?? 0 })); return;
  }
  if (existsSync(out + '/status.json') && JSON.parse(readFileSync(out + '/status.json', 'utf8')).phase === 'ready') {
    console.log('This Ready run is complete; no additional round started'); return;
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
  const profile = JSON.parse(readFileSync(args.profile, 'utf8'));
  const reuse = selectCheckpointReuse(args, out, profile);
  const reuseCheckpoint = reuse.checkpoint;
  const ref = tableRef(args.table ?? '');
  const pageSize = Number(args['page-size']), concurrency = Number(args.concurrency);
  assert(Number.isInteger(pageSize) && pageSize > 0 && pageSize <= 10000, 'Invalid page size');
  assert(Number.isInteger(concurrency) && concurrency > 0 && concurrency <= 24, 'Invalid concurrency');
  const maxPages = args['max-pages'] === undefined ? Infinity : Number(args['max-pages']);
  assert(maxPages === Infinity || Number.isInteger(maxPages) && maxPages > 0, 'Invalid max-pages');
  const status = value => { saveJson(out + '/status.json', { ...value, updatedAt: new Date().toISOString() }); console.log(JSON.stringify(value)); };
  const api = makeApi(tokenFile), url = tableUrl(ref);
  const meta = await api(url), pin = sourcePin(meta);
  const pinPath = out + '/input-pin.json';
  if (existsSync(pinPath)) { assert(args.resume, 'Existing run requires --resume'); assert.deepEqual(JSON.parse(readFileSync(pinPath, 'utf8')), pin, 'Input table changed'); }
  else saveJson(pinPath, pin);
  const endpoint = JSON.parse(readFileSync(profile.rpcFile, 'utf8')).MAINNET_RPC_URL;
  assert(typeof endpoint === 'string' && endpoint, 'Missing configured RPC');
  const bin = realpathSync(resolve(args['revm-sim-bin'] ?? root + '/listener/revm-sim/target/release/revm-sim-ready'));
  assert(existsSync(bin), 'Ready simulator missing; build the Ready sidecar or pass --revm-sim-bin');
  Object.assign(process.env, { SEARCHER_DRY_RUN: '1', SEARCHER_BLOCKSCAN_SUBMIT: '0', SEARCHER_TEST_DISABLE_DOTENV: '1',
    MAINNET_RPC_URL: endpoint, SEARCHER_LIVE_RPC_URL: endpoint, SEARCHER_REVM_SIM_BIN: bin, SEARCHER_READY_REVM_SIM_BIN: bin,
    BOTVM_ADDRESS: profile.executor, BOTVM_OWNER: profile.wallet, SEARCHER_REBUILD_REVM_TIMEOUT_MS: '60000' });
  const activations = [];
  for (const file of readdirSync(root + '/listener/src/searcher/venues/production-families').filter(file => file.endsWith('.production.ts'))) {
    const key = readFileSync(root + '/listener/src/searcher/venues/production-families/' + file, 'utf8').match(/envKey:\s*["'](SEARCHER_FAMILY_[A-Z0-9_]+_ENABLED)["']/)?.[1];
    if (key) { process.env[key] = '1'; activations.push(key); }
  }
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
  const readerHash = digest([readFileSync(new URL('./ready-bigquery.mjs', import.meta.url), 'utf8'), readFileSync(new URL('./bigquery-table.mjs', import.meta.url), 'utf8')]);
  const runIdentity = { input: pin, codeHash, readerHash, executionIdentity: identity, simulator: bin,
    simulatorSha256: createHash('sha256').update(readFileSync(bin)).digest('hex'), activations, plan: wiring.expectedSourcePlanFingerprints(),
    profilePath: resolve(args.profile), checkpointReuse: reuse.enabled, reuseCheckpoint };
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
  const retainPatterns = catalog.listAll().flatMap(family => {
    const discovery = family.plugin.discovery;
    if (discovery?.reverseBinding?.kind !== 'implementation') return [];
    return (discovery.logPatterns ?? []).filter(pattern => pattern.emitter?.mode === 'singleton-indexed-bytes32').map(pattern => ({ familyId: family.plugin.manifest.familyId, pattern }));
  });
  const segmentDir = out + '/pages'; mkdirSync(segmentDir, { recursive: true });
  let state = { pages: 0, rows: 0, nextPageToken: null, inputComplete: false, counts: emptyCounts(), minBlock: null, maxBlock: null, maxHash: null, chainHash: digest(pin) };
  for (const file of readdirSync(segmentDir).filter(file => /^\d{8}\.json$/.test(file)).sort()) {
    const segment = JSON.parse(readFileSync(segmentDir + '/' + file, 'utf8'));
    assert.equal(segment.previousHash, state.chainHash, 'Checkpoint chain mismatch');
    assert.equal(segment.state.pages, state.pages + 1, 'Checkpoint sequence gap');
    const { segmentHash, ...payload } = segment; assert.equal(segmentHash, digest(payload), 'Checkpoint corrupted');
    for (const candidate of segment.candidates) mergeCandidate(wiring.decodeCandidateSnapshot(candidate));
    for (const [key, log] of segment.opaque) opaque.set(key, log);
    state = { ...segment.state, chainHash: segmentHash };
  }
  while (!state.inputComplete && state.pages < maxPages) {
    const disk = statfsSync(out); assert(Number(disk.bavail) * Number(disk.bsize) >= 2 * 1024 ** 3, 'Disk reserve below 2 GiB');
    const pageUrl = new URL(url + '/data'); pageUrl.searchParams.set('maxResults', String(pageSize));
    if (state.nextPageToken) pageUrl.searchParams.set('pageToken', state.nextPageToken);
    const page = await api(pageUrl);
    assert.equal(page.totalRows, pin.rows, 'Input row count changed');
    const rows = page.rows ?? [];
    assert(rows.length || !page.pageToken, 'Empty non-terminal BigQuery page');
    const observations = [];
    for (const row of rows) {
      const tx = decodeRow(meta.schema.fields, row), block = Number(tx.block_number);
      for (const observation of observationsFromTx(tx, state.counts)) observations.push(observation);
      state.minBlock = state.minBlock === null ? block : Math.min(state.minBlock, block);
      if (state.maxBlock === null || block > state.maxBlock) { state.maxBlock = block; state.maxHash = tx.block_hash; }
      else if (block === state.maxBlock) assert.equal(tx.block_hash.toLowerCase(), state.maxHash.toLowerCase(), 'Conflicting maximum block hash');
    }
    const changed = new Set();
    for (const candidate of wiring.dedupeFamilyCandidates(observations)) changed.add(mergeCandidate(candidate));
    const opaqueChanges = new Map();
    for (const log of observations) {
      if (log.kind === 'call' || !retainPatterns.length) continue;
      const matches = catalog.matches({ kind: 'log', source: { number: log.blockNumber, hash: log.blockHash, generation: log.blockNumber }, address: log.address, topics: log.topics, data: log.data });
      for (const match of matches) {
        const retained = retainPatterns.find(item => item.familyId === match.familyId && item.pattern.id === match.patternId);
        if (!retained) continue;
        const poolId = log.topics[retained.pattern.emitter.topicIndex];
        assert(/^0x[0-9a-f]{64}$/i.test(poolId), 'Invalid opaque instance ID');
        const key = [match.familyId, log.address.toLowerCase(), poolId.toLowerCase()].join('|');
        if (!opaque.has(key) || opaque.get(key).blockNumber < log.blockNumber) { opaque.set(key, log); opaqueChanges.set(key, log); }
      }
    }
    const next = { ...state, pages: state.pages + 1, rows: state.rows + rows.length, nextPageToken: page.pageToken ?? null, inputComplete: !page.pageToken };
    delete next.chainHash;
    assert(next.rows <= Number(pin.rows), 'Read beyond pinned row count');
    if (next.inputComplete) assert.equal(next.rows, Number(pin.rows), 'Incomplete terminal page');
    const segment = { previousHash: state.chainHash, pageContentHash: digest(page), state: next,
      candidates: [...changed].map(key => wiring.encodeCandidateSnapshot(byKey.get(key))), opaque: [...opaqueChanges] };
    const segmentHash = digest(segment); saveJson(segmentDir + '/' + String(next.pages).padStart(8, '0') + '.json', { ...segment, segmentHash });
    state = { ...next, chainHash: segmentHash };
    status({ phase: 'reading', ...state, nextPageToken: undefined, candidates: byKey.size, opaqueInstances: opaque.size, rssMiB: Math.round(process.memoryUsage().rss / 1024 ** 2) });
    if (state.pages % 100 === 0 || state.inputComplete) assert.deepEqual(sourcePin(await api(url)), pin, 'Input table mutated');
  }
  if (!state.inputComplete) { status({ phase: 'sample-complete', rows: state.rows, pages: state.pages, candidates: byKey.size, opaqueInstances: opaque.size }); return; }
  assert(state.maxBlock !== null, 'Empty table cannot produce Ready');
  assert.deepEqual(sourcePin(await api(url)), pin, 'Input table mutated');
  unlinkSync(tokenFile);
  status({ phase: 'strict', rows: state.rows, pages: state.pages, candidates: byKey.size, opaqueInstances: opaque.size, cutoff: state.maxBlock });
  const cutoff = await wiring.freezeCanonicalHead(state.maxBlock);
  assert.equal(cutoff.hash.toLowerCase(), state.maxHash.toLowerCase(), 'Input maximum block is not canonical');
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
