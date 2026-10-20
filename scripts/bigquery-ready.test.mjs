import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { tableRef, sourcePin, decodeRow, observationsFromTx, emptyCounts, makeApi } from './bigquery-table.mjs';
import { main } from './ready-bigquery.mjs';

const hash = '0x' + 'a'.repeat(64), blockHash = '0x' + 'b'.repeat(64);
const frame = (path, to, extra = {}) => ({ trace_address: path, to_address: to, from_address: 'trace-sender', call_type: 'call', status: '1', input: '0x12345678', ...extra });
const tx = traces => ({ tx_hash: hash, block_number: '123', block_hash: blockHash, receipt_status: '1', logs: [], traces });

test('table names are explicit; URI and malformed source inputs fail closed', () => {
  assert.deepEqual(tableRef('eth-token-480803.Ready.1008-1015'), { projectId: 'eth-token-480803', datasetId: 'Ready', tableId: '1008-1015' });
  for (const value of ['', 'coffee', 'https://example.com', 'project.dataset.table/other']) assert.throws(() => tableRef(value));
});
test('BigQuery nested/repeated decoding preserves integer precision and empty arrays', () => {
  const fields = [{ name: 'n', type: 'INTEGER' }, { name: 'traces', mode: 'REPEATED', type: 'RECORD', fields: [{ name: 'input', type: 'STRING' }, { name: 'ok', type: 'BOOLEAN' }] }, { name: 'logs', type: 'RECORD', mode: 'REPEATED', fields: [] }];
  assert.deepEqual(decodeRow(fields, { f: [{ v: '9007199254740993' }, { v: [{ v: { f: [{ v: '0x12345678' }, { v: 'true' }] } }] }, { v: [] }] }), { n: '9007199254740993', traces: [{ input: '0x12345678', ok: true }], logs: [] });
  assert.throws(() => decodeRow(fields, { f: [] }));
});
test('all successful calls including executor/sender enter; only failed/static/insufficient evidence is excluded', () => {
  const row = { ...tx([frame('', 'executor'), frame('0', 'sender'), frame('1', 'failed', { status: 0 }), frame('1,0', 'child'), frame('2', 'static', { call_type: 'staticcall' }), frame('2,0', 'static-child'), frame('3', 'no-input', { input: null }), frame('4,0', 'missing-parent')]), executor: 'executor', from_address: 'sender' };
  const counts = emptyCounts();
  assert.deepEqual(observationsFromTx(row, counts).map(call => call.target), ['executor', 'sender']);
  assert.equal(counts.calls, 2); assert.equal(counts.rolledBackCalls, 2); assert.equal(counts.missingAncestorCalls, 1);
  assert.deepEqual(observationsFromTx({ ...row, receipt_status: '0' }, counts), []);
});
test('root absence, malformed row identity and path do not become admitted evidence', () => {
  const counts = emptyCounts();
  assert.deepEqual(observationsFromTx(tx([frame('0', 'child')]), counts), []);
  assert.throws(() => observationsFromTx({ ...tx([]), block_hash: 'bad' }, counts));
  assert.throws(() => observationsFromTx(tx([frame('x', 'child')]), counts));
});
test('bounded HTTP retries do not expose remote bodies or tokens', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bq-auth-test-'));
  try {
    const token = dir + '/auth.json'; writeFileSync(token, JSON.stringify({ token: 'sensitive-test-token', expiresAt: Date.now() + 10000 }));
    let tries = 0;
    const api = makeApi(token, async () => { tries++; return tries < 3 ? new Response('secret diagnostics', { status: 429 }) : Response.json({ ok: true }); }, async () => {});
    assert.deepEqual(await api('https://unused.invalid'), { ok: true }); assert.equal(tries, 3);
    const denied = makeApi(token, async () => new Response('secret diagnostics', { status: 403 }));
    await assert.rejects(denied('https://unused.invalid'), { message: 'BigQuery request failed: HTTP 403' });
  } finally { rmSync(dir, { recursive: true }); }
});

function fixture(withOpaque = false) {
  const root = mkdtempSync(join(tmpdir(), 'bq-ready-test-')), out = root + '/run';
  mkdirSync(out); mkdirSync(root + '/listener/src/searcher/venues/production-families', { recursive: true });
  mkdirSync(root + '/release/runtime/listener/revm-sim/target/release', { recursive: true });
  writeFileSync(root + '/release/runtime/listener/revm-sim/target/release/revm-sim', 'fixture');
  writeFileSync(root + '/rpc.json', JSON.stringify({ MAINNET_RPC_URL: 'https://unused.invalid' }));
  writeFileSync(root + '/profile.json', JSON.stringify({ rpcFile: root + '/rpc.json', release: root + '/release', executor: 'executor', wallet: 'wallet' }));
  writeFileSync(out + '/bigquery-auth.json', JSON.stringify({ token: 'fixture-token', expiresAt: Date.now() + 60000 }));
  writeFileSync(root + '/listener/src/searcher/universe-rebuild-production.ts', `import {writeFileSync} from 'node:fs';
export const rebuildFamilyInstanceDedupeKey = c => c.address;
export const candidateFingerprint = c => c.address;
export function createRebuildWiring(input) { return {
 startupCandidates: input.startupCandidates,
 expectedSourcePlanFingerprints: () => ({startup:'s',activity:'a'}),
 encodeCandidateSnapshot: c => c, decodeCandidateSnapshot: c => c,
 dedupeFamilyCandidates: obs => [...new Map(obs.map(o => { const c=o.kind==='startup-candidate'?o.candidate:{familyId:'test',address:o.target??o.address,blockNumber:o.blockNumber};return [c.address,c];})).values()],
 freezeCanonicalHead: async n => ({number:n,hash:'${blockHash}',generation:n}),
 reverseBindOpaqueCandidates: async ({observations}) => {writeFileSync('${out}/reverse.json',JSON.stringify(observations));return observations.map(o=>({familyId:'opaque',address:o.topics[1],blockNumber:o.blockNumber}));}
}; }
`);
  writeFileSync(root + '/listener/src/searcher/venues/production-family-composition.ts', withOpaque
    ? `export const PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG={listAll:()=>[{plugin:{manifest:{familyId:'test'}}},{plugin:{manifest:{familyId:'opaque'},discovery:{reverseBinding:{kind:'implementation'},logPatterns:[{id:'pool-id',emitter:{mode:'singleton-indexed-bytes32',topicIndex:1}}]}}}],matches:o=>o.topics.length===2?[{familyId:'opaque',patternId:'pool-id'}]:[]};`
    : `export const PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG={listAll:()=>[{plugin:{manifest:{familyId:'test'}}}],matches:()=>[]};`);
  writeFileSync(root + '/listener/src/searcher/universe-rebuild-checkpoint.ts', `import {existsSync,readFileSync,writeFileSync} from 'node:fs';
export class UniverseRebuildCheckpointStore {
 constructor(input){this.path=input.path;}
 async load(){return existsSync(this.path)?JSON.parse(readFileSync(this.path,'utf8')):null;}
 async loadReadOnlySnapshot(){const envelope=await this.load();return envelope===null?null:{envelope,capturedAt:new Date().toISOString(),sourcePath:this.path};}
 async inheritRebuildProofsFrom(source){const prior=await source.load();const result={verifiedMemos:prior.verifiedMemos,retryableAttemptsByCandidateKey:prior.retryableAttemptsByCandidateKey,readyGeneration:null,inProgressRun:null,checkpointFingerprint:'proof-only'};writeFileSync(this.path,JSON.stringify(result),{flag:'wx'});return result;}
 async inheritReadyFrom(source){const prior=await source.load();if(!prior?.readyGeneration||prior.inProgressRun)throw Error('Ready inheritance requires a completed source checkpoint');writeFileSync(this.path,JSON.stringify(prior),{flag:'wx'});return prior;}
}`);
  writeFileSync(root + '/listener/src/searcher/universe-rebuild-runner.ts', `import {writeFileSync,existsSync,mkdirSync} from 'node:fs'; export async function rebuildUniverse(input){await input.freezeCanonicalHead(input.observationRange.toBlock);if(input.resumeCompletedOutcomes)throw Error('completed-outcome resume requires a sealed unfinished run');if(existsSync('${root}/fail-strict'))throw Error('fixture strict failed');const prior=await input.store.load();writeFileSync(input.store.path,JSON.stringify({candidates:input.startupCandidates,range:input.observationRange,inheritedFingerprint:prior?.checkpointFingerprint,checkpointFingerprint:'result:'+input.runId,verifiedMemos:{},retryableAttemptsByCandidateKey:{},inProgressRun:null,readyGeneration:{cutoff:{number:123,hash:'${blockHash}'}}}));if(existsSync('${root}/fail-publication'))mkdirSync('${root}/profile.json.latest-ready.json');return {cutoff:{number:123,hash:'${blockHash}'},generation:1,candidateAccounting:{total:2,verified:2,retryable:0}};}`);
  const fields = [
    ...['tx_hash', 'block_number', 'block_hash', 'receipt_status'].map(name => ({ name, type: 'STRING' })),
    { name: 'logs', type: 'RECORD', mode: 'REPEATED', fields: [{name:'log_address',type:'STRING'},{name:'topics',type:'STRING',mode:'REPEATED'},{name:'data',type:'STRING'},{name:'log_index',type:'INTEGER'}] },
    { name: 'traces', type: 'RECORD', mode: 'REPEATED', fields: ['trace_address','to_address','from_address','call_type','status','input'].map(name => ({name,type:'STRING'})) },
  ];
  const encode = (schema, obj) => ({ f: schema.map(field => ({ v: field.mode === 'REPEATED' ? obj[field.name].map(value => ({ v: field.fields ? encode(field.fields, value) : value })) : obj[field.name] })) });
  const meta = { type: 'TABLE', tableReference: tableRef('project1.Ready.table'), lastModifiedTime: '1', numRows: '2', schema: { fields } };
  const requests = [];
  const fetcher = async raw => {
    const url = new URL(raw); requests.push(url.pathname + url.search);
    if (!url.pathname.endsWith('/data')) return Response.json(meta);
    const second = url.searchParams.has('pageToken');
    const row = tx([frame('', second ? 'pool-two' : 'pool-one')]);
    if (withOpaque) {
      row.block_number = second ? '123' : '122';
      row.logs = (second ? ['c','d'] : ['c']).map((id, index) => ({ log_address:'shared-emitter',topics:['0x'+'e'.repeat(64),'0x'+id.repeat(64)],data:'0x',log_index:String(index) }));
    }
    return Response.json({ totalRows: '2', ...(second?{}:{pageToken:'page-two'}), rows:[encode(fields,row)] });
  };
  const argv = ['--table','project1.Ready.table','--root',root,'--out',out,'--profile',root+'/profile.json'];
  return { root, out, meta, fetcher, requests, argv };
}
test('actual entry point stops safely after a sample, then resumes every row into one Ready without refetching page 1', async () => {
  const f = fixture(), oldFetch = globalThis.fetch; globalThis.fetch = f.fetcher;
  try {
    await main([...f.argv, '--max-pages', '1']);
    assert(!existsSync(f.out + '/checkpoint.json'));
    assert.equal(JSON.parse(readFileSync(f.out + '/status.json')).phase, 'sample-complete');
    f.requests.length = 0;
    await main([...f.argv, '--resume']);
    assert.equal(f.requests.filter(url => url.includes('/data?')).length, 1);
    assert(f.requests.some(url => url.includes('pageToken=page-two')));
    const ready = JSON.parse(readFileSync(f.out + '/checkpoint.json'));
    assert.deepEqual(ready.candidates.map(c => c.address), ['pool-one','pool-two']);
    assert.deepEqual(ready.range, { fromBlock: 123, toBlock: 123 });
    assert.equal(JSON.parse(readFileSync(f.out + '/result.json')).read.rows, 2);
    assert(!existsSync(f.out + '/bigquery-auth.json'));
    f.requests.length = 0;
    await main([...f.argv, '--resume']);
    assert.equal(f.requests.length, 0, 'Completed Ready must not start another round');
  } finally { globalThis.fetch = oldFetch; rmSync(f.root, { recursive: true }); }
});
test('shared emitter keeps both opaque pool IDs across page resume, choosing newest evidence', async () => {
  const f = fixture(true), oldFetch = globalThis.fetch; globalThis.fetch = f.fetcher;
  try {
    await main([...f.argv, '--max-pages', '1']);
    await main([...f.argv, '--resume']);
    const retained = JSON.parse(readFileSync(f.out + '/reverse.json'));
    assert.equal(retained.length, 2);
    assert.deepEqual(retained.map(log => log.topics[1]).sort(), ['0x'+'c'.repeat(64),'0x'+'d'.repeat(64)]);
    assert(retained.every(log => log.blockNumber === 123));
  } finally { globalThis.fetch = oldFetch; rmSync(f.root, { recursive: true }); }
});
test('table mutation and truncated terminal page cannot publish Ready', async () => {
  const f = fixture(), oldFetch = globalThis.fetch; globalThis.fetch = f.fetcher;
  try {
    await main([...f.argv, '--max-pages', '1']);
    f.meta.lastModifiedTime = 'changed';
    await assert.rejects(main([...f.argv, '--resume']), /Input table changed/);
    assert(!existsSync(f.out + '/checkpoint.json'));
    f.meta.lastModifiedTime = '1';
    globalThis.fetch = async raw => String(raw).includes('/data?') ? Response.json({ totalRows: '2', rows: [] }) : f.fetcher(raw);
    await assert.rejects(main([...f.argv, '--resume']), /Incomplete terminal page/);
    assert(!existsSync(f.out + '/checkpoint.json'));
  } finally { globalThis.fetch = oldFetch; rmSync(f.root, { recursive: true }); }
});

test('new BigQuery run inherits a completed Ready through the existing store, never same-run negative resume', async () => {
  const f = fixture(), oldFetch = globalThis.fetch; globalThis.fetch = f.fetcher;
  try {
    const source = f.root + '/previous-checkpoint.json';
    const previous = { checkpointFingerprint: 'prior-proof', verifiedMemos: { a: {} },
      retryableAttemptsByCandidateKey: {}, inProgressRun: null, readyGeneration: { cutoff: { number: 100 } } };
    writeFileSync(source, JSON.stringify(previous));
    const argv = [...f.argv, '--reuse-checkpoint', source];
    await main([...argv, '--max-pages', '1']);
    assert(!existsSync(f.out + '/checkpoint.json'), 'discovery alone must not import or start strict');
    await assert.rejects(main([...f.argv, '--reuse-checkpoint', f.root + '/other.json', '--resume']), /Run code\/config changed/);
    await main([...argv, '--resume']);
    const current = JSON.parse(readFileSync(f.out + '/checkpoint.json'));
    assert.equal(current.inheritedFingerprint, 'prior-proof');
    assert.deepEqual(current.range, { fromBlock: 123, toBlock: 123 }, 'old coverage must not substitute for new coverage');
    assert.deepEqual(JSON.parse(readFileSync(source)), previous);
    assert.equal(JSON.parse(readFileSync(f.out + '/run-identity.json')).reuseCheckpoint, source);
  } finally { globalThis.fetch = oldFetch; rmSync(f.root, { recursive: true }); }
});

test('reuse checkpoint requires an explicit separate absolute path', async () => {
  const f = fixture();
  try {
    await assert.rejects(main([...f.argv, '--reuse-checkpoint', 'relative.json']), /absolute path/);
    await assert.rejects(main([...f.argv, '--reuse-checkpoint', f.out + '/checkpoint.json']), /must differ/);
    assert(!existsSync(f.out + '/input-pin.json'), 'invalid reuse options fail before any table read');
  } finally { rmSync(f.root, { recursive: true }); }
});

function seedPreviousReady(f) {
  const path = f.root + '/previous-checkpoint.json';
  writeFileSync(path, JSON.stringify({ checkpointFingerprint: 'previous-proof', verifiedMemos: {},
    retryableAttemptsByCandidateKey: {}, inProgressRun: null, readyGeneration: { cutoff: { number: 100 } } }));
  const profilePath = f.root + '/profile.json';
  writeFileSync(profilePath, JSON.stringify({ ...JSON.parse(readFileSync(profilePath)), ready: path }));
  return path;
}

function nextRun(f, name) {
  const out = f.root + '/' + name, argv = [...f.argv];
  mkdirSync(out);
  writeFileSync(out + '/bigquery-auth.json', JSON.stringify({ token: 'fixture-token', expiresAt: Date.now() + 60000 }));
  argv[argv.indexOf('--out') + 1] = out;
  return { out, argv };
}

function sqlFixture(withOpaque = false) {
  const f = fixture(withOpaque), directory = f.root + '/sql';
  const hashBytes = value => createHash('sha256').update(value).digest('hex');
  const save = (name, value) => writeFileSync(directory + '/' + name, JSON.stringify(value));
  mkdirSync(directory); mkdirSync(directory + '/source-packages');
  mkdirSync(f.root + '/listener/src/searcher/generated');
  const familyIds = withOpaque ? ['test', 'opaque'] : ['test'];
  const catalog = { format: 'adapter-family-capability-shadow-v1', complete: true, issues: [], legacy: [],
    exact: familyIds.map(familyId => ({ identity: { familyId, capability: 'discovery', contentHash: 'fixture-' + familyId } })) };
  const packageBytes = JSON.stringify(catalog);
  writeFileSync(directory + '/source-packages/00001.json', packageBytes);
  writeFileSync(f.root + '/listener/src/searcher/generated/family-capability-shadow.generated.json', packageBytes);
  const sql = 'SELECT fixture'; writeFileSync(directory + '/full-query.sql', sql);
  const candidate = { familyId: 'test', address: 'pool-one', blockNumber: 123, blockHash, transactionHash: hash };
  const entries = [{ kind: 'candidate', family: 'test', instance_key: 'pool-one', source_block: '123', fingerprint: 'pool-one', snapshot: JSON.stringify(candidate), tx_hash: hash }];
  if (withOpaque) for (const id of ['c', 'd']) {
    const poolId = '0x' + id.repeat(64), log = { address: 'shared-emitter', blockNumber: 123, blockHash, transactionHash: hash, topics: ['0x' + 'e'.repeat(64), poolId], data: '0x', logIndex: 0 };
    entries.push({ kind: 'opaque', family: 'opaque', instance_key: 'opaque|shared-emitter|' + poolId, source_block: '123', fingerprint: '', snapshot: JSON.stringify(log), tx_hash: hash });
  }
  const fields = Object.keys(entries[0]).map(name => ({ name, type: 'STRING' }));
  const page = { jobComplete: true, jobReference: { jobId: 'fixture-job' }, totalRows: String(entries.length), schema: { fields }, rows: entries.map(entry => ({ f: fields.map(field => ({ v: entry[field.name] })) })) };
  save('full-result-page-00001.json', page);
  save('plan.json', { packageFiles: [{ sha256: hashBytes(packageBytes) }], familyCount: familyIds.length, sqlSha256: hashBytes(sql), rangeStart: 'start', rangeEnd: 'end', blockRange: {fromBlock: 100,toBlock: 123}, cutoff: {number:123,hash:blockHash} });
  save('full-job.json', { jobReference: { jobId: 'fixture-job' }, status: { state: 'DONE' }, configuration: { query: { query: sql } } });
  save('full-download-state.json', { jobId: 'fixture-job', complete: true, nextPageToken: null, pages: 1, rows: entries.length, totalRows: String(entries.length) });
  save('result-pages-manifest.json', { jobId: 'fixture-job', rows: entries.length, pages: [{ name: 'full-result-page-00001.json', rows: entries.length, sha256: hashBytes(JSON.stringify(page)) }] });
  const argv = f.argv.slice(2);
  argv.push('--discovery-results', directory);
  return { ...f, directory, sqlArgv: argv, save, catalog };
}

test('completed SQL results enter normal strict and default checkpoint reuse without fetching raw transactions', async () => {
  const f = sqlFixture(), oldFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw Error('No BigQuery read permitted'); };
  try {
    seedPreviousReady(f); unlinkSync(f.out + '/bigquery-auth.json');
    await main(f.sqlArgv);
    const ready = JSON.parse(readFileSync(f.out + '/checkpoint.json'));
    assert.equal(ready.inheritedFingerprint, 'previous-proof');
    assert.deepEqual(ready.candidates.map(item => item.address), ['pool-one']);
    assert.deepEqual(ready.range, { fromBlock: 123, toBlock: 123 });
    assert.equal(JSON.parse(readFileSync(f.out + '/sql-input-verified.json')).rows, 1);
    assert.equal(JSON.parse(readFileSync(f.out + '/input-pin.json')).kind, 'discovery-sql-results-v1');
    await main([...f.sqlArgv, '--resume']);
  } finally { globalThis.fetch = oldFetch; rmSync(f.root, { recursive: true }); }
});

test('SQL opaque records retain each shared-entry instance and enter the existing reverse binder', async () => {
  const f = sqlFixture(true);
  try {
    await main(f.sqlArgv);
    const reverse = JSON.parse(readFileSync(f.out + '/reverse.json'));
    assert.equal(reverse.length, 2);
    assert.deepEqual(reverse.map(log => log.topics[1]).sort(), ['0x' + 'c'.repeat(64), '0x' + 'd'.repeat(64)]);
    assert.equal(JSON.parse(readFileSync(f.out + '/checkpoint.json')).candidates.length, 3);
  } finally { rmSync(f.root, { recursive: true }); }
});

test('incomplete SQL downloads and discovery-version drift fail before strict', async () => {
  for (const mode of ['incomplete', 'changed-discovery']) {
    const f = sqlFixture();
    try {
      if (mode === 'incomplete') {
        const state = JSON.parse(readFileSync(f.directory + '/full-download-state.json')); state.complete = false;
        f.save('full-download-state.json', state);
      } else {
        f.catalog.exact[0].identity.contentHash = 'changed';
        writeFileSync(f.root + '/listener/src/searcher/generated/family-capability-shadow.generated.json', JSON.stringify(f.catalog));
      }
      await assert.rejects(main(f.sqlArgv), mode === 'incomplete' ? /download is incomplete/ : /definitions differ/);
      assert(!existsSync(f.out + '/checkpoint.json'));
    } finally { rmSync(f.root, { recursive: true }); }
  }
});

test('a changed SQL page fails its hash check and cannot publish Ready', async () => {
  const f = sqlFixture();
  try {
    f.save('full-result-page-00001.json', { tampered: true });
    await assert.rejects(main(f.sqlArgv), /page hash mismatch/);
    assert(!existsSync(f.out + '/checkpoint.json'));
    assert(!existsSync(f.root + '/profile.json.latest-ready.json'));
  } finally { rmSync(f.root, { recursive: true }); }
});

test('default inherits the configured Ready, then the latest completed result without any reuse flag', async () => {
  const f = fixture(), oldFetch = globalThis.fetch; globalThis.fetch = f.fetcher;
  try {
    seedPreviousReady(f);
    await main(f.argv);
    const first = JSON.parse(readFileSync(f.out + '/checkpoint.json'));
    assert.equal(first.inheritedFingerprint, 'previous-proof');
    assert.equal(JSON.parse(readFileSync(f.out + '/run-identity.json')).checkpointReuse, true);
    assert.equal(JSON.parse(readFileSync(f.root + '/profile.json.latest-ready.json')).checkpoint, f.out + '/checkpoint.json');
    const next = nextRun(f, 'next');
    await main(next.argv);
    assert.equal(JSON.parse(readFileSync(next.out + '/checkpoint.json')).inheritedFingerprint, first.checkpointFingerprint);
    assert.equal(JSON.parse(readFileSync(f.root + '/profile.json.latest-ready.json')).checkpoint, next.out + '/checkpoint.json');
    await main([...f.argv, '--resume']);
    assert.equal(JSON.parse(readFileSync(f.root + '/profile.json.latest-ready.json')).checkpoint, next.out + '/checkpoint.json',
      'looking at an older completed run cannot move the latest reference backwards');
  } finally { globalThis.fetch = oldFetch; rmSync(f.root, { recursive: true }); }
});

test('only explicit opt-out starts without previous results, and omission on resume keeps that choice', async () => {
  const f = fixture(), oldFetch = globalThis.fetch; globalThis.fetch = f.fetcher;
  try {
    seedPreviousReady(f);
    await main([...f.argv, '--no-reuse-checkpoint', '--max-pages', '1']);
    assert.equal(JSON.parse(readFileSync(f.out + '/run-identity.json')).checkpointReuse, false);
    await main([...f.argv, '--resume']);
    assert.equal(JSON.parse(readFileSync(f.out + '/checkpoint.json')).inheritedFingerprint, undefined);
    const next = nextRun(f, 'next');
    await main(next.argv);
    assert.equal(JSON.parse(readFileSync(next.out + '/run-identity.json')).reuseCheckpoint, f.out + '/checkpoint.json',
      'an opt-out result remains reusable in the following default run');
  } finally { globalThis.fetch = oldFetch; rmSync(f.root, { recursive: true }); }
});

test('resume retains its selected result when optional flags are omitted or the latest reference advances', async () => {
  const f = fixture(), oldFetch = globalThis.fetch; globalThis.fetch = f.fetcher;
  try {
    const source = seedPreviousReady(f);
    await main([...f.argv, '--reuse-checkpoint', source, '--max-pages', '1']);
    writeFileSync(f.root + '/profile.json.latest-ready.json', JSON.stringify({ checkpoint: f.root + '/different.json' }));
    await assert.rejects(main([...f.argv, '--resume', '--no-reuse-checkpoint']), /Cannot disable checkpoint reuse/);
    await main([...f.argv, '--resume']);
    assert.equal(JSON.parse(readFileSync(f.out + '/checkpoint.json')).inheritedFingerprint, 'previous-proof');
  } finally { globalThis.fetch = oldFetch; rmSync(f.root, { recursive: true }); }
});

test('bad references stop instead of silently rebuilding; opt-out can deliberately ignore them', async () => {
  const f = fixture(), oldFetch = globalThis.fetch; globalThis.fetch = f.fetcher;
  try {
    seedPreviousReady(f);
    const latest = f.root + '/profile.json.latest-ready.json';
    writeFileSync(latest, JSON.stringify({ checkpoint: f.root + '/missing.json' }));
    await assert.rejects(main(f.argv), /Previous Ready checkpoint is missing/);
    writeFileSync(latest, '{}');
    await assert.rejects(main(f.argv), /Invalid latest Ready reference/);
    assert.equal(f.requests.length, 0, 'invalid references fail before any BigQuery read');
    await assert.rejects(main([...f.argv, '--reuse-checkpoint', f.root + '/previous-checkpoint.json', '--no-reuse-checkpoint']), /options conflict/);
    await main([...f.argv, '--no-reuse-checkpoint']);
    assert.equal(JSON.parse(readFileSync(f.out + '/checkpoint.json')).inheritedFingerprint, undefined);
  } finally { globalThis.fetch = oldFetch; rmSync(f.root, { recursive: true }); }
});

test('failed strict never publishes a latest result', async () => {
  const f = fixture(), oldFetch = globalThis.fetch; globalThis.fetch = f.fetcher;
  try {
    const source = seedPreviousReady(f), latest = f.root + '/profile.json.latest-ready.json';
    const reference = JSON.stringify({ checkpoint: source });
    writeFileSync(latest, reference); writeFileSync(f.root + '/fail-strict', '1');
    await assert.rejects(main(f.argv), /fixture strict failed/);
    assert.equal(readFileSync(latest, 'utf8'), reference);
    assert(!existsSync(f.out + '/result.json'));
  } finally { globalThis.fetch = oldFetch; rmSync(f.root, { recursive: true }); }
});

test('publication failure after strict recovers without re-reading or re-running strict', async () => {
  const f = fixture(), oldFetch = globalThis.fetch; globalThis.fetch = f.fetcher;
  try {
    writeFileSync(f.root + '/fail-publication', '1');
    await assert.rejects(main(f.argv), /EISDIR/);
    assert(existsSync(f.out + '/result.json'));
    const checkpoint = readFileSync(f.out + '/checkpoint.json', 'utf8');
    rmSync(f.root + '/profile.json.latest-ready.json', { recursive: true });
    unlinkSync(f.root + '/fail-publication'); writeFileSync(f.root + '/fail-strict', '1');
    f.requests.length = 0;
    unlinkSync(f.out + '/checkpoint.json');
    await assert.rejects(main([...f.argv, '--resume']), /Completed Ready checkpoint is missing/);
    writeFileSync(f.out + '/checkpoint.json', checkpoint);
    await main([...f.argv, '--resume']);
    assert.equal(f.requests.length, 0);
    assert.equal(readFileSync(f.out + '/checkpoint.json', 'utf8'), checkpoint);
    assert.equal(JSON.parse(readFileSync(f.out + '/status.json')).phase, 'ready');
    assert.equal(JSON.parse(readFileSync(f.root + '/profile.json.latest-ready.json')).checkpoint, f.out + '/checkpoint.json');
  } finally { globalThis.fetch = oldFetch; rmSync(f.root, { recursive: true }); }
});

function updateSqlPlan(f, update) {
  const plan = JSON.parse(readFileSync(f.directory + '/plan.json'));
  f.save('plan.json', { ...plan, ...update });
}
test('fixed SQL cutoff remains requested end block even when last candidate is earlier', async () => {
  const f = sqlFixture();
  try {
    updateSqlPlan(f, {blockRange:{fromBlock:100,toBlock:125},cutoff:{number:125,hash:blockHash}});
    await main(f.sqlArgv);
    const result = JSON.parse(readFileSync(f.out + '/result.json'));
    assert.deepEqual(JSON.parse(readFileSync(f.out + '/checkpoint.json')).range,{fromBlock:125,toBlock:125});
    assert.deepEqual(result.inputRange,{fromBlock:100,toBlock:125});
    assert.deepEqual(result.observedInputRange,{fromBlock:123,toBlock:123});
    assert.deepEqual(result.productionActivityCoverage,{fromBlock:125,toBlock:125});
  } finally {rmSync(f.root,{recursive:true});}
});
test('SQL rows outside range, mismatching cutoff hash, and malformed range fail before strict', async () => {
  for (const [update, pattern] of [
    [{blockRange:{fromBlock:124,toBlock:125},cutoff:{number:125,hash:blockHash}},/outside requested range/],
    [{blockRange:{fromBlock:100,toBlock:122},cutoff:{number:122,hash:blockHash}},/outside requested range/],
    [{cutoff:{number:123,hash:'0x'+'c'.repeat(64)}},/cutoff row hash/],
    [{cutoff:{number:124,hash:blockHash}},/cutoff must equal/],
    [{blockRange:null},/invalid SQL block range/],
  ]) {
    const f=sqlFixture();
    try {
      updateSqlPlan(f,update);
      await assert.rejects(main(f.sqlArgv),pattern);
      assert(!existsSync(f.out+'/checkpoint.json'));
    } finally {rmSync(f.root,{recursive:true});}
  }
});
test('public configuration preserves disabled families and accounts for their SQL rows without activating them', async () => {
  const f=sqlFixture();
  try {
    const familyDir=f.root+'/listener/src/searcher/venues/production-families/';
    writeFileSync(familyDir+'test.production.ts', "export const activation={envKey:'SEARCHER_FAMILY_TEST_ENABLED'};");
    writeFileSync(f.root+'/listener/src/searcher/venues/production-family-composition.ts',`export const PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG={listAll:()=>process.env.SEARCHER_FAMILY_TEST_ENABLED==='1'?[{plugin:{manifest:{familyId:'test'}}}]:[],matches:()=>[]};`);
    const bin=f.root+'/configured-simulator';writeFileSync(bin,'fixture');
    const env={SEARCHER_FAMILY_TEST_ENABLED:'0',BOTVM_ADDRESS:'public-executor',BOTVM_OWNER:'public-owner',SEARCHER_REVM_SIM_BIN:bin,SEARCHER_DRY_RUN:'1',SEARCHER_BLOCKSCAN_SUBMIT:'0'};
    writeFileSync(f.root+'/public.json',JSON.stringify(env));
    await main([...f.sqlArgv,'--public-env',f.root+'/public.json']);
    const result=JSON.parse(readFileSync(f.out+'/result.json'));
    assert.equal(result.nominatedCandidates,0);assert.deepEqual(result.read.counts.inactiveRecords,{test:1});
    const identity=JSON.parse(readFileSync(f.out+'/run-identity.json'));
    assert.deepEqual(identity.activations,[['SEARCHER_FAMILY_TEST_ENABLED','0']]);
    assert.deepEqual(identity.executionIdentity,{executor:'public-executor',transactionOrigin:'public-owner'});
    assert.equal(identity.simulator,bin);
  } finally {delete process.env.SEARCHER_FAMILY_TEST_ENABLED;rmSync(f.root,{recursive:true});}
});
test('missing explicit family activation fails rather than silently enabling it',async()=>{
  const f=sqlFixture();
  try {
    writeFileSync(f.root+'/listener/src/searcher/venues/production-families/test.production.ts',"export const activation={envKey:'SEARCHER_FAMILY_TEST_ENABLED'};");
    await assert.rejects(main(f.sqlArgv),/explicitly configure SEARCHER_FAMILY_TEST_ENABLED/);
    assert(!existsSync(f.out+'/checkpoint.json'));
  } finally {rmSync(f.root,{recursive:true});}
});

function seedPartialProofs(f) {
  const parentPath=f.root+'/parent-checkpoint.json', partialDir=f.root+'/partial-id';mkdirSync(partialDir);
  const memo={familyId:'test',familyCandidateKey:'pool-one',fingerprint:'old-proof'};
  const parent={revision:7,checkpointFingerprint:'parent-proof',verifiedMemos:{one:memo},retryableAttemptsByCandidateKey:{},readyGeneration:{cutoff:{number:123,hash:blockHash}},inProgressRun:null};
  const partial={...parent,checkpointFingerprint:'partial-proof',verifiedMemos:{one:{...memo,fingerprint:'new-proof'},two:{familyId:'test',familyCandidateKey:'pool-two'}},inProgressRun:{fromBlock:100,cutoff:{number:123,hash:blockHash},familyUpdateScope:{parentCheckpointFingerprint:'parent-proof',familyIds:['test']},completedOutcomes:{bad:'terminal'}}};
  const metadata={schema:'ready-family-supplement/v1',identity:'partial-id',range:{fromBlock:100,toBlock:123},source:{number:123,hash:blockHash},parentRevision:7,parentCheckpointFingerprint:'parent-proof',familyIds:['test']};
  writeFileSync(parentPath,JSON.stringify(parent));writeFileSync(partialDir+'/checkpoint.json',JSON.stringify(partial));writeFileSync(partialDir+'/parent.json',JSON.stringify(metadata));
  return {parentPath,partialDir,parent,partial,metadata,argv:[...f.sqlArgv,'--reuse-proofs-checkpoint',partialDir+'/checkpoint.json','--reuse-proofs-parent',parentPath]};
}
test('proof-only SQL inheritance verifies parent linkage and preserves checkpoints without copying coverage/outcomes',async()=>{
  const f=sqlFixture();
  try {
    const p=seedPartialProofs(f);writeFileSync(f.root+'/fail-strict','1');
    await assert.rejects(main(p.argv),/fixture strict failed/);
    const imported=JSON.parse(readFileSync(f.out+'/checkpoint.json'));
    assert.equal(imported.readyGeneration,null);assert.equal(imported.inProgressRun,null);
    assert.deepEqual(imported.verifiedMemos,p.partial.verifiedMemos);
    assert.deepEqual(JSON.parse(readFileSync(p.parentPath)),p.parent);
    assert.deepEqual(JSON.parse(readFileSync(p.partialDir+'/checkpoint.json')),p.partial);
    const receipt=JSON.parse(readFileSync(f.out+'/proof-inheritance.json'));
    assert.equal(receipt.parentMemos,1);assert.equal(receipt.inheritedMemos,2);assert.equal(receipt.copiedCoverage,false);
  } finally {rmSync(f.root,{recursive:true});}
});
test('proof-only inheritance rejects changed parent identity, scope, and lost memo before writing target',async()=>{
  for (const mode of ['parent','scope','memo']) {
    const f=sqlFixture();
    try {
      const p=seedPartialProofs(f);
      if(mode==='parent')p.parent.checkpointFingerprint='changed';
      if(mode==='scope')p.partial.inProgressRun.familyUpdateScope.familyIds=['other'];
      if(mode==='memo')delete p.partial.verifiedMemos.one;
      writeFileSync(p.parentPath,JSON.stringify(p.parent));writeFileSync(p.partialDir+'/checkpoint.json',JSON.stringify(p.partial));
      await assert.rejects(main(p.argv),mode==='parent'?/parent fingerprint changed/:mode==='scope'?/scope differs/:/memo identity/);
      assert(!existsSync(f.out+'/checkpoint.json'));
    } finally {rmSync(f.root,{recursive:true});}
  }
});
test('canonical hash changing between import preflight and production strict freeze cannot publish Ready',async()=>{
  const f=sqlFixture();
  try {
    const path=f.root+'/listener/src/searcher/universe-rebuild-production.ts';
    const source=readFileSync(path,'utf8').replace(/freezeCanonicalHead: async n => \(\{number:n,hash:'[^']+',generation:n\}\),/,`freezeCanonicalHead: async n => ({number:n,hash:++freezes>1?'0x'+'c'.repeat(64):'${blockHash}',generation:n}),`);
    writeFileSync(path,'let freezes=0;\n'+source);
    await assert.rejects(main(f.sqlArgv),/Strict cutoff hash changed/);
    assert(!existsSync(f.out+'/result.json'));assert(!existsSync(f.root+'/profile.json.latest-ready.json'));
  } finally {rmSync(f.root,{recursive:true});}
});
