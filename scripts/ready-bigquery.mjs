#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, statfsSync, unlinkSync, realpathSync, renameSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { tableRef, tableUrl, sourcePin, decodeRow, observationsFromTx, emptyCounts, digest, saveJson, makeApi } from './bigquery-table.mjs';
import { openDiscoveryResults } from './ready-discovery-results.mjs';

// Only a reference to the last completed result; the existing checkpoint remains
// the sole authority for validation, memo reuse and retry history.
function rememberReady(profilePath, out) {
  assert(existsSync(out + '/checkpoint.json'), 'Completed Ready checkpoint is missing; refusing to publish reference');
  const path = resolve(profilePath) + '.latest-ready.json', temporary = path + '.tmp.' + process.pid;
  writeFileSync(temporary, JSON.stringify({ checkpoint: out + '/checkpoint.json' }) + '\n', { mode: 0o600 });
  renameSync(temporary, path);
}

function selectCheckpointReuse(args, out, profile) {
  assert(!(args['no-reuse-checkpoint'] && (args['reuse-checkpoint'] !== undefined || args['reuse-proofs-checkpoint'] !== undefined)), 'Checkpoint reuse options conflict');
  assert(!(args['reuse-proofs-checkpoint'] && args['reuse-checkpoint']), 'Choose completed Ready or proof-only inheritance');
  const identityPath = out + '/run-identity.json';
  let enabled, checkpoint;
  if (existsSync(identityPath)) {
    const saved = JSON.parse(readFileSync(identityPath, 'utf8'));
    enabled = saved.checkpointReuse ?? (saved.reuseCheckpoint !== undefined);
    checkpoint = saved.reuseCheckpoint ?? null;
    assert(!args['no-reuse-checkpoint'] || !enabled, 'Cannot disable checkpoint reuse in a started run; use a new output directory');
    assert((args['reuse-checkpoint'] ?? args['reuse-proofs-checkpoint']) === undefined || resolve(args['reuse-checkpoint'] ?? args['reuse-proofs-checkpoint']) === checkpoint, 'Run code/config changed: checkpoint reuse source');
  } else {
    enabled = !args['no-reuse-checkpoint'];
    const latestPath = resolve(args.profile) + '.latest-ready.json';
    checkpoint = enabled ? args['reuse-checkpoint'] ?? args['reuse-proofs-checkpoint'] ?? profile.ready ?? null : null;
    if (enabled && args['reuse-checkpoint'] === undefined && args['reuse-proofs-checkpoint'] === undefined && existsSync(latestPath)) {
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
    table: { type: 'string' }, 'discovery-results': { type: 'string' }, out: { type: 'string' }, root: { type: 'string' },
    'profile': { type: 'string', default: '/opt/mev-cloud/manual-live/profile.json' },
    'token-stdin': { type: 'boolean' }, 'auth-status': { type: 'boolean' },
    'page-size': { type: 'string', default: '1000' }, 'max-pages': { type: 'string' },
    'concurrency': { type: 'string', default: '1' }, resume: { type: 'boolean' },
    'reuse-checkpoint': { type: 'string' },
    'reuse-proofs-checkpoint': { type: 'string' }, 'reuse-proofs-parent': { type: 'string' },
    'public-env': { type: 'string' },
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
  const savedIdentity = existsSync(out + '/run-identity.json') ? JSON.parse(readFileSync(out + '/run-identity.json', 'utf8')) : undefined;
  const proofOnly = args['reuse-proofs-checkpoint'] !== undefined || savedIdentity?.proofOnly === true;
  const proofParentPath = args['reuse-proofs-parent'] ?? savedIdentity?.proofParentPath ?? null;
  assert(!proofOnly || proofParentPath?.startsWith('/'), 'Proof-only inheritance requires an absolute --reuse-proofs-parent');
  assert(proofOnly || proofParentPath === null, '--reuse-proofs-parent requires proof-only inheritance');
  const proofParentBytes = proofOnly ? readFileSync(dirname(reuseCheckpoint) + '/parent.json') : null;
  const proofParent = proofParentBytes ? JSON.parse(proofParentBytes) : null;
  assert(!(args.table && args['discovery-results']), 'Choose a table or SQL discovery results, not both');
  const sqlResults = args['discovery-results'] === undefined ? undefined : openDiscoveryResults(
    resolve(args['discovery-results']), JSON.parse(readFileSync(root + '/listener/src/searcher/generated/family-capability-shadow.generated.json', 'utf8')));
  const ref = sqlResults ? undefined : tableRef(args.table ?? '');
  const pageSize = Number(args['page-size']), concurrency = Number(args.concurrency);
  assert(Number.isInteger(pageSize) && pageSize > 0 && pageSize <= 10000, 'Invalid page size');
  assert(Number.isInteger(concurrency) && concurrency > 0 && concurrency <= 24, 'Invalid concurrency');
  const maxPages = args['max-pages'] === undefined ? Infinity : Number(args['max-pages']);
  assert(maxPages === Infinity || Number.isInteger(maxPages) && maxPages > 0, 'Invalid max-pages');
  const status = value => { saveJson(out + '/status.json', { ...value, updatedAt: new Date().toISOString() }); console.log(JSON.stringify(value)); };
  const api = makeApi(tokenFile), url = ref ? tableUrl(ref) : undefined;
  const meta = sqlResults ? undefined : await api(url), pin = sqlResults?.pin ?? sourcePin(meta);
  const pinPath = out + '/input-pin.json';
  if (existsSync(pinPath)) { assert(args.resume, 'Existing run requires --resume'); assert.deepEqual(JSON.parse(readFileSync(pinPath, 'utf8')), pin, 'Input table changed'); }
  else saveJson(pinPath, pin);
  const endpoint = JSON.parse(readFileSync(profile.rpcFile, 'utf8')).MAINNET_RPC_URL;
  assert(typeof endpoint === 'string' && endpoint, 'Missing configured RPC');
  const publicEnvPath = args['public-env'] ?? savedIdentity?.publicEnvPath ?? profile.publicEnv ?? null;
  const publicEnv = publicEnvPath ? JSON.parse(readFileSync(publicEnvPath, 'utf8')) : {};
  assert(publicEnv && typeof publicEnv === 'object' && !Array.isArray(publicEnv), 'Invalid public environment');
  const bin = publicEnv.SEARCHER_REVM_SIM_BIN ?? profile.simulator ?? profile.release + '/runtime/listener/revm-sim/target/release/revm-sim';
  const executor = publicEnv.BOTVM_ADDRESS ?? profile.executor, owner = publicEnv.BOTVM_OWNER ?? profile.wallet;
  assert(executor && owner, 'Missing public execution identity');
  assert(publicEnv.SEARCHER_DRY_RUN === undefined || publicEnv.SEARCHER_DRY_RUN === '1', 'SQL Ready requires dry-run');
  assert(publicEnv.SEARCHER_BLOCKSCAN_SUBMIT === undefined || publicEnv.SEARCHER_BLOCKSCAN_SUBMIT === '0', 'SQL Ready cannot submit');
  assert(existsSync(bin), 'Configured simulator does not exist');
  Object.assign(process.env, { SEARCHER_DRY_RUN: '1', SEARCHER_BLOCKSCAN_SUBMIT: '0', SEARCHER_TEST_DISABLE_DOTENV: '1',
    MAINNET_RPC_URL: endpoint, SEARCHER_LIVE_RPC_URL: endpoint, SEARCHER_REVM_SIM_BIN: bin,
    BOTVM_ADDRESS: executor, BOTVM_OWNER: owner, SEARCHER_REBUILD_REVM_TIMEOUT_MS: publicEnv.SEARCHER_REVM_TIMEOUT_MS ?? '60000' });
  for (const key of ['SEARCHER_DRY_RUN_BOTVM_CODE_OVERRIDE', 'SEARCHER_DRY_RUN_KEYLESS', 'SEARCHER_REVM_TIMEOUT_MS', 'SEARCHER_BLOCKSCAN_QUOTE_TOLERANCE_ENABLED', 'SEARCHER_EV_GATE']) {
    if (publicEnv[key] !== undefined) { assert.equal(typeof publicEnv[key], 'string', 'Invalid public setting ' + key); process.env[key] = publicEnv[key]; }
  }
  const activations = [];
  for (const file of readdirSync(root + '/listener/src/searcher/venues/production-families').filter(file => file.endsWith('.production.ts')).sort()) {
    const key = readFileSync(root + '/listener/src/searcher/venues/production-families/' + file, 'utf8').match(/envKey:\s*["'](SEARCHER_FAMILY_[A-Z0-9_]+_ENABLED)["']/)?.[1];
    if (key) {
      assert(['0', '1'].includes(publicEnv[key]), 'Public environment must explicitly configure ' + key);
      process.env[key] = publicEnv[key]; activations.push([key, publicEnv[key]]);
    }
  }
  const { createRebuildWiring, rebuildFamilyInstanceDedupeKey, candidateFingerprint } = await import(pathToFileURL(root + '/listener/src/searcher/universe-rebuild-production.ts'));
  const { PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG: catalog } = await import(pathToFileURL(root + '/listener/src/searcher/venues/production-family-composition.ts'));
  const activeFamilyIds = new Set(catalog.listAll().map(family => family.plugin.manifest.familyId));
  const identity = { executor, transactionOrigin: owner };
  if (proofOnly) {
    assert(sqlResults, 'Proof-only inheritance requires fixed-range SQL discovery results');
    assert.equal(proofParent.schema, 'ready-family-supplement/v1', 'Invalid proof parent metadata');
    assert.deepEqual(proofParent.range, pin.blockRange, 'Proof parent range differs from SQL range');
    assert.equal(proofParent.source.number, pin.cutoff.number, 'Proof parent cutoff differs from SQL cutoff');
    assert.equal(proofParent.source.hash.toLowerCase(), pin.cutoff.hash.toLowerCase(), 'Proof parent cutoff hash differs');
    assert.equal(proofParent.identity, dirname(reuseCheckpoint).split('/').at(-1), 'Proof parent directory identity differs');
  }
  const wiring = createRebuildWiring({ rpcUrl: endpoint, executionIdentity: identity });
  const codeFiles = []; const visit = folder => { for (const file of readdirSync(folder, { withFileTypes: true }).sort((a,b) => a.name.localeCompare(b.name))) {
    const path = folder + '/' + file.name;
    if (file.isDirectory()) visit(path); else if (file.isFile()) codeFiles.push([path.slice(root.length), digest(readFileSync(path).toString())]);
  } }; visit(root + '/listener/src');
  const codeHash = digest(codeFiles);
  const readerHash = digest([readFileSync(new URL('./ready-bigquery.mjs', import.meta.url), 'utf8'), readFileSync(new URL('./bigquery-table.mjs', import.meta.url), 'utf8'), readFileSync(new URL('./ready-discovery-results.mjs', import.meta.url), 'utf8')]);
  const runIdentity = { input: pin, codeHash, readerHash, executionIdentity: identity, simulator: bin, activations, plan: wiring.expectedSourcePlanFingerprints(),
    profilePath: resolve(args.profile), checkpointReuse: reuse.enabled, reuseCheckpoint, proofOnly, proofParentPath,
    proofParentMetadataHash: proofParentBytes ? digest(proofParentBytes.toString()) : null,
    publicEnvPath, publicEnvHash: publicEnvPath ? digest(publicEnv) : null };
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
  if (sqlResults) {
    assert.equal(maxPages, Infinity, '--max-pages applies only to raw-table reads');
    assert.equal(readdirSync(segmentDir).length, 0, 'SQL run cannot contain raw-table segments');
    let candidateRecords = 0, opaqueRecords = 0;
    const inactiveRecords = {};
    for (const row of sqlResults.entries()) {
      state.rows++;
      state.minBlock = state.minBlock === null ? row.block : Math.min(state.minBlock, row.block);
      if (state.maxBlock === null || row.block > state.maxBlock) { state.maxBlock = row.block; state.maxHash = row.snapshot.blockHash; }
      else if (row.block === state.maxBlock) assert.equal(state.maxHash.toLowerCase(), row.snapshot.blockHash.toLowerCase(), 'Conflicting SQL observed block hash');
      if (!activeFamilyIds.has(row.family)) { inactiveRecords[row.family] = (inactiveRecords[row.family] ?? 0) + 1; continue; }
      if (row.kind === 'candidate') {
        const candidate = wiring.decodeCandidateSnapshot(row.snapshot);
        assert.equal(candidate.familyId, row.family, 'SQL candidate Family mismatch');
        assert.equal(rebuildFamilyInstanceDedupeKey(candidate), row.instance_key, 'SQL candidate instance key mismatch');
        assert.equal(candidateFingerprint(candidate), row.fingerprint, 'SQL candidate fingerprint mismatch');
        mergeCandidate(candidate); candidateRecords++;
      } else {
        const log = row.snapshot;
        const matches = catalog.matches({ kind: 'log', source: { number: row.block, hash: log.blockHash, generation: row.block }, address: log.address, topics: log.topics, data: log.data });
        const retained = retainPatterns.find(item => item.familyId === row.family && matches.some(match => match.familyId === row.family && match.patternId === item.pattern.id));
        assert(retained, 'SQL opaque evidence is not recognized by the current discovery catalog');
        const poolId = log.topics[retained.pattern.emitter.topicIndex];
        assert(/^0x[0-9a-f]{64}$/i.test(poolId), 'Invalid opaque instance ID');
        assert.equal([row.family, log.address.toLowerCase(), poolId.toLowerCase()].join('|'), row.instance_key, 'SQL opaque instance key mismatch');
        if (!opaque.has(row.instance_key) || opaque.get(row.instance_key).blockNumber < row.block) opaque.set(row.instance_key, log);
        opaqueRecords++;
      }
      if (state.rows % 5000 === 0) status({ phase: 'reading-sql-results', rows: state.rows, candidates: byKey.size, opaqueInstances: opaque.size });
    }
    state = { ...state, pages: 0, inputComplete: true, counts: { candidateRecords, opaqueRecords, inactiveRecords } };
    saveJson(out + '/sql-input-verified.json', { pin, rows: state.rows, candidates: byKey.size, opaqueInstances: opaque.size, inactiveRecords, requestedRange: pin.blockRange, observedRange: { fromBlock: state.minBlock, toBlock: state.maxBlock }, cutoff: pin.cutoff });
  }
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
  if (!sqlResults) assert.deepEqual(sourcePin(await api(url)), pin, 'Input table mutated');
  if (existsSync(tokenFile)) unlinkSync(tokenFile);
  const targetCutoff = sqlResults ? pin.cutoff : { number: state.maxBlock, hash: state.maxHash };
  status({ phase: 'strict', rows: state.rows, pages: state.pages, candidates: byKey.size, opaqueInstances: opaque.size, cutoff: targetCutoff.number });
  const cutoff = await wiring.freezeCanonicalHead(targetCutoff.number);
  assert.equal(cutoff.hash.toLowerCase(), targetCutoff.hash.toLowerCase(), 'Requested cutoff block is not canonical');
  const reverse = await wiring.reverseBindOpaqueCandidates({ observations: [...opaque.values()], cutoff, knownCandidates: [...byKey.values()] });
  for (const candidate of reverse) mergeCandidate(candidate);
  const candidates = [...byKey.values()]; opaque.clear(); byKey.clear();
  const full = createRebuildWiring({ rpcUrl: endpoint, executionIdentity: identity, startupCandidates: candidates });
  const { rebuildUniverse } = await import(pathToFileURL(root + '/listener/src/searcher/universe-rebuild-runner.ts'));
  const { UniverseRebuildCheckpointStore } = await import(pathToFileURL(root + '/listener/src/searcher/universe-rebuild-checkpoint.ts'));
  // Imported candidates use the production startup source; the normal one-block
  // activity scan seals its OWN coverage. Never fabricate week-long RPC receipts.
  const store = new UniverseRebuildCheckpointStore({ path: out + '/checkpoint.json' });
  const runId = 'bigquery-ready-' + digest(runIdentity).slice(0, 20);
  let prior = await store.load();
  if (prior === null && reuseCheckpoint !== null) {
    const sourceStore = new UniverseRebuildCheckpointStore({ path: resolve(reuseCheckpoint) });
    if (proofOnly) {
      // Release the large completed snapshot before loading the partial store.
      // Retain only authenticated identity summaries while loading the partial store.
      const parent = await (async () => {
        const parentStore = new UniverseRebuildCheckpointStore({ path: resolve(proofParentPath) });
        const envelope = (await parentStore.loadReadOnlySnapshot())?.envelope;
        assert(envelope?.readyGeneration && envelope.inProgressRun === null, 'Proof parent must be a completed Ready');
        assert.equal(envelope.revision, proofParent.parentRevision, 'Proof parent revision changed');
        assert.equal(envelope.checkpointFingerprint, proofParent.parentCheckpointFingerprint, 'Proof parent fingerprint changed');
        return { checkpointFingerprint: envelope.checkpointFingerprint,
          memoIdentities: Object.entries(envelope.verifiedMemos).map(([key, memo]) => [key, memo.familyId, memo.familyCandidateKey]) };
      })();
      const source = await sourceStore.load();
      assert(source?.inProgressRun?.familyUpdateScope, 'Proof source is not a scoped Family supplement');
      assert.equal(source.inProgressRun.fromBlock, pin.blockRange.fromBlock, 'Proof source range differs');
      assert.equal(source.inProgressRun.cutoff.number, pin.cutoff.number, 'Proof source cutoff differs');
      assert.equal(source.inProgressRun.cutoff.hash.toLowerCase(), pin.cutoff.hash.toLowerCase(), 'Proof source cutoff hash differs');
      assert.equal(source.inProgressRun.familyUpdateScope.parentCheckpointFingerprint, parent.checkpointFingerprint, 'Proof source parent fingerprint differs');
      assert.deepEqual(source.inProgressRun.familyUpdateScope.familyIds, proofParent.familyIds, 'Proof source scope differs from parent metadata');
      for (const [key, familyId, familyCandidateKey] of parent.memoIdentities) {
        const inherited = source.verifiedMemos[key];
        assert(inherited && inherited.familyId === familyId && inherited.familyCandidateKey === familyCandidateKey, 'Partial checkpoint lost or changed inherited parent memo identity');
      }
      prior = await store.inheritRebuildProofsFrom(sourceStore);
      saveJson(out + '/proof-inheritance.json', { source: reuseCheckpoint, parent: proofParentPath, parentMetadata: proofParent, parentMetadataHash: runIdentity.proofParentMetadataHash,
        parentMemos: parent.memoIdentities.length, inheritedMemos: Object.keys(prior.verifiedMemos).length, checkpointFingerprint: prior.checkpointFingerprint, copiedCoverage: false, copiedOutcomes: false });
    } else prior = await store.inheritReadyFrom(sourceStore);
    console.log(JSON.stringify({ phase: 'ready-checkpoint-inherited', checkpointFingerprint: prior.checkpointFingerprint,
      verifiedMemos: Object.keys(prior.verifiedMemos).length, retryable: Object.keys(prior.retryableAttemptsByCandidateKey).length }));
  } else if (prior === null) {
    console.log(JSON.stringify({ phase: 'ready-checkpoint-not-inherited', reason: reuse.enabled ? 'first-run-no-previous-result' : 'explicitly-disabled' }));
  }
  const ready = await rebuildUniverse({ ...full, store,
    freezeCanonicalHead: async requestedBlock => {
      assert.equal(requestedBlock, cutoff.number, 'Strict must use the pinned SQL/input cutoff');
      const frozen = await full.freezeCanonicalHead(requestedBlock);
      assert.equal(frozen.number, cutoff.number, 'Strict cutoff number changed');
      assert.equal(frozen.hash.toLowerCase(), cutoff.hash.toLowerCase(), 'Strict cutoff hash changed');
      return frozen;
    },
    runId, observationRange: { fromBlock: cutoff.number, toBlock: cutoff.number },
    attestationConcurrency: concurrency,
    resumeCompletedOutcomes: args.resume === true && prior?.inProgressRun?.runId === runId,
    log: text => console.log(text) });
  saveJson(out + '/result.json', { input: pin, inputRange: sqlResults ? pin.blockRange : { fromBlock: state.minBlock, toBlock: state.maxBlock },
    observedInputRange: { fromBlock: state.minBlock, toBlock: state.maxBlock }, productionActivityCoverage: { fromBlock: cutoff.number, toBlock: cutoff.number }, read: state,
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
