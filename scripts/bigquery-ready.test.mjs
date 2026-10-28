import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, unlinkSync, symlinkSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  mkdirSync(root + '/listener/revm-sim/target/release', { recursive: true });
  writeFileSync(root + '/listener/revm-sim/target/release/revm-sim-ready', 'fixture');
  writeFileSync(root + '/rpc.json', JSON.stringify({ MAINNET_RPC_URL: 'https://unused.invalid' }));
  writeFileSync(root + '/profile.json', JSON.stringify({ rpcFile: root + '/rpc.json', release: root + '/release', executor: 'executor', wallet: 'wallet' }));
  writeFileSync(out + '/bigquery-auth.json', JSON.stringify({ token: 'fixture-token', expiresAt: Date.now() + 60000 }));
  writeFileSync(root + '/listener/src/searcher/universe-rebuild-production.ts', `import {writeFileSync} from 'node:fs';
export const rebuildFamilyInstanceDedupeKey = c => c.address;
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
    ? `export const PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG={listAll:()=>[{plugin:{manifest:{familyId:'opaque'},discovery:{reverseBinding:{kind:'implementation'},logPatterns:[{id:'pool-id',emitter:{mode:'singleton-indexed-bytes32',topicIndex:1}}]}}}],matches:o=>o.topics.length===2?[{familyId:'opaque',patternId:'pool-id'}]:[]};`
    : 'export const PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG={listAll:()=>[],matches:()=>[]};');
  writeFileSync(root + '/listener/src/searcher/universe-rebuild-checkpoint.ts', `import {existsSync,readFileSync,writeFileSync} from 'node:fs';
export class UniverseRebuildCheckpointStore {
 constructor(input){this.path=input.path;}
 async load(){return existsSync(this.path)?JSON.parse(readFileSync(this.path,'utf8')):null;}
 async inheritReadyFrom(source){const prior=await source.load();if(!prior?.readyGeneration||prior.inProgressRun)throw Error('Ready inheritance requires a completed source checkpoint');writeFileSync(this.path,JSON.stringify(prior),{flag:'wx'});return prior;}
}`);
  writeFileSync(root + '/listener/src/searcher/universe-rebuild-runner.ts', `import {writeFileSync,existsSync,mkdirSync} from 'node:fs'; export async function rebuildUniverse(input){if(input.resumeCompletedOutcomes)throw Error('completed-outcome resume requires a sealed unfinished run');if(existsSync('${root}/fail-strict'))throw Error('fixture strict failed');const prior=await input.store.load();writeFileSync(input.store.path,JSON.stringify({candidates:input.startupCandidates,range:input.observationRange,inheritedFingerprint:prior?.checkpointFingerprint,checkpointFingerprint:'result:'+input.runId,verifiedMemos:{},retryableAttemptsByCandidateKey:{},inProgressRun:null,readyGeneration:{cutoff:{number:123,hash:'${blockHash}'}}}));if(existsSync('${root}/fail-publication'))mkdirSync('${root}/profile.json.latest-ready.json');return {cutoff:{number:123,hash:'${blockHash}'},generation:1,candidateAccounting:{total:2,verified:2,retryable:0}};}`);
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

test('Ready simulator identity pins the real file and cannot inherit another simulator from the environment', async () => {
  const f = fixture(), oldFetch = globalThis.fetch, oldBin = process.env.SEARCHER_REVM_SIM_BIN,
    oldReady = process.env.SEARCHER_READY_REVM_SIM_BIN;
  globalThis.fetch = f.fetcher;
  const alias = f.root + '/listener/revm-sim/target/release/revm-sim-ready', real = f.root + '/ready-v1';
  try {
    writeFileSync(real, 'immutable-ready-fixture'); unlinkSync(alias); symlinkSync(real, alias);
    process.env.SEARCHER_READY_REVM_SIM_BIN = '/unrelated-inherited-simulator';
    await main([...f.argv, '--max-pages', '1']);
    const identity = JSON.parse(readFileSync(f.out + '/run-identity.json'));
    assert.equal(identity.simulator, realpathSync(real));
    assert.equal(identity.simulatorSha256, createHash('sha256').update(readFileSync(real)).digest('hex'));
    assert.equal(process.env.SEARCHER_REVM_SIM_BIN, realpathSync(real));
    assert.equal(process.env.SEARCHER_READY_REVM_SIM_BIN, realpathSync(real));
    writeFileSync(f.root + '/ready-v2', 'different-ready-fixture');
    unlinkSync(alias); symlinkSync(f.root + '/ready-v2', alias);
    await assert.rejects(main([...f.argv, '--resume']), /Run code\/config changed/);
    assert(!existsSync(f.out + '/checkpoint.json'));
  } finally {
    globalThis.fetch = oldFetch;
    if (oldBin === undefined) delete process.env.SEARCHER_REVM_SIM_BIN; else process.env.SEARCHER_REVM_SIM_BIN = oldBin;
    if (oldReady === undefined) delete process.env.SEARCHER_READY_REVM_SIM_BIN; else process.env.SEARCHER_READY_REVM_SIM_BIN = oldReady;
    rmSync(f.root, { recursive: true });
  }
});
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
