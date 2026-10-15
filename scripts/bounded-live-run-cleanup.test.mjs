import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, linkSync, mkdirSync, mkdtempSync, openSync, readFileSync,
  readdirSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanupOldRunLogs, LIVE_LOG_NAMES, runHasOpenFiles } from './bounded-live-run-cleanup.mjs';

const OLD = 'live-2026-10-12T09-34-32-190Z-0e71b5c5';
const NEW = 'live-2026-10-15T09-34-32-190Z-0e71b5c5';
function fixture(t) {
  const temp = mkdtempSync(join(realpathSync(tmpdir()), 'mev-cleanup-test-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const root = join(temp, 'runs'), run = join(root, OLD), current = join(root, NEW);
  mkdirSync(root, { mode: 0o700 }); mkdirSync(run, { mode: 0o700 }); mkdirSync(current, { mode: 0o700 });
  const save = (name, value) => writeFileSync(join(run, name), JSON.stringify(value), { mode: 0o600 });
  save('request.json', { schemaVersion: 1, runId: OLD, userInitiated: true });
  save('ended.json', { reason: 'completed_source_window', at: '2026-10-12T18:03:29.342Z' });
  save('permit.json', { runId: OLD, status: 'stopped', validUntilMs: 0 });
  save('process.json', { pid: 2147483647, unit: 'mev-manual-bounded-live.service' });
  for (const name of LIVE_LOG_NAMES) writeFileSync(join(run, name), 'fixture-live-log', { mode: 0o600 });
  for (const name of ['checkpoint.json', 'config.json', 'window.json', 'run-contract.json', 'old-runs-cleanup.jsonl', 'evidence.json']) save(name, { preserve: true });
  mkdirSync(join(run, 'diagnostics')); writeFileSync(join(run, 'diagnostics/events.jsonl'), 'independent-evidence');
  const options = { inUse: () => false };
  return { temp, root, run, current, save, options };
}
const linux = { skip: process.platform !== 'linux' };

test('preview is read-only and includes only six exact direct log names', t => {
  const f = fixture(t), before = readdirSync(f.run);
  const r = cleanupOldRunLogs(f.root, f.current, f.options);
  assert.equal(r.mode, 'preview'); assert.equal(r.files.length, 6); assert.equal(r.deletedFiles, 0);
  assert(r.eligibleBytes > 0); assert(r.eligibleAllocatedBytes > 0);
  assert.deepEqual(readdirSync(f.run), before); assert.deepEqual(readdirSync(f.current), []);
});
test('apply deletes only allowlisted logs and leaves checkpoints, metadata and nested evidence', linux, t => {
  const f = fixture(t), kept = readdirSync(f.run).filter(name => !LIVE_LOG_NAMES.includes(name));
  const checkpoint = readFileSync(join(f.run, 'checkpoint.json'));
  const r = cleanupOldRunLogs(f.root, f.current, { ...f.options, apply: true });
  assert.equal(r.deletedFiles, 6); assert.equal(r.deletedBytes, r.eligibleBytes);
  assert.deepEqual(readdirSync(f.run), kept); assert.deepEqual(readFileSync(join(f.run, 'checkpoint.json')), checkpoint);
  assert.equal(readFileSync(join(f.run, 'diagnostics/events.jsonl'), 'utf8'), 'independent-evidence');
  const audit = readFileSync(r.audit, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(audit[0].type, 'plan'); assert.equal(audit.filter(x => x.type === 'delete-intent').length, 6);
  assert.equal(audit.filter(x => x.type === 'deleted').length, 6); assert.equal(audit.at(-1).type, 'completed');
});
for (const mode of ['unfinished', 'active-permit', 'pid-exists', 'malformed', 'request-mismatch', 'occupied']) {
  test('preserve uncertain or occupied old run: ' + mode, t => {
    const f = fixture(t);
    if (mode === 'unfinished') rmSync(join(f.run, 'ended.json'));
    if (mode === 'active-permit') f.save('permit.json', { runId: OLD, status: 'active', validUntilMs: 0 });
    if (mode === 'pid-exists') f.save('process.json', { pid: process.pid, unit: 'mev-manual-bounded-live.service' });
    if (mode === 'malformed') writeFileSync(join(f.run, 'ended.json'), 'bad-json');
    if (mode === 'request-mismatch') f.save('request.json', { schemaVersion: 1, runId: NEW, userInitiated: true });
    if (mode === 'occupied') f.options.inUse = () => true;
    const r = cleanupOldRunLogs(f.root, f.current, f.options);
    assert.equal(r.files.length, 0); assert(existsSync(join(f.run, 'live.log')));
  });
}
test('current run is protected even with completed metadata', t => {
  const f = fixture(t), r = cleanupOldRunLogs(f.root, f.run, f.options);
  assert.equal(r.files.length, 0); assert(r.skipped.some(x => x.run === f.run && x.reason === 'current-run'));
});
test('unrecognized directories and directory symlinks are never traversed', t => {
  const f = fixture(t); renameSync(f.run, join(f.root, 'independent-replay'));
  symlinkSync(join(f.root, 'independent-replay'), f.run);
  const r = cleanupOldRunLogs(f.root, f.current, f.options);
  assert.equal(r.files.length, 0); assert(existsSync(join(f.root, 'independent-replay/live.log')));
});
test('root symlink and current path escape are refused', t => {
  const f = fixture(t), alias = join(f.temp, 'alias'); symlinkSync(f.root, alias);
  assert.throws(() => cleanupOldRunLogs(alias, undefined, f.options));
  assert.throws(() => cleanupOldRunLogs(f.root, f.temp, f.options));
});
test('symlink metadata cannot establish terminal identity', t => {
  const f = fixture(t), original = join(f.run, 'ended.json');
  renameSync(original, join(f.temp, 'ended.json')); symlinkSync(join(f.temp, 'ended.json'), original);
  assert.equal(cleanupOldRunLogs(f.root, f.current, f.options).files.length, 0);
});
test('FIFO metadata is skipped without blocking preview or startup', t => {
  const f = fixture(t), path = join(f.run, 'request.json'); rmSync(path);
  assert.equal(spawnSync('mkfifo', [path]).status, 0);
  const script = `import {cleanupOldRunLogs} from ${JSON.stringify(new URL('./bounded-live-run-cleanup.mjs', import.meta.url).href)};
    const r=cleanupOldRunLogs(process.argv[1],process.argv[2],{inUse:()=>false});console.log(r.files.length);`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script, f.root, f.current],
    { encoding: 'utf8', timeout: 3000 });
  assert.equal(result.error, undefined); assert.equal(result.status, 0); assert.equal(result.stdout.trim(), '0');
  assert(existsSync(join(f.run, 'live.log')));
});
test('symlink, hardlinked and nonregular log targets are protected', t => {
  const f = fixture(t);
  rmSync(join(f.run, 'live.log')); symlinkSync(join(f.run, 'checkpoint.json'), join(f.run, 'live.log'));
  rmSync(join(f.run, 'events.jsonl')); linkSync(join(f.run, 'checkpoint.json'), join(f.run, 'events.jsonl'));
  rmSync(join(f.run, 'routes.jsonl')); mkdirSync(join(f.run, 'routes.jsonl'));
  const r = cleanupOldRunLogs(f.root, f.current, f.options);
  assert.equal(r.files.length, 3); assert.equal(r.skipped.filter(x => x.reason === 'unsafe-log-file').length, 3);
});
test('occupancy query errors are fail closed', t => {
  const f = fixture(t);
  for (const result of [{ status: null, signal: 'SIGTERM' }, { status: 2 },
    { status: 1, stderr: 'permission denied' }, { status: 1, error: new Error('missing lsof') }]) {
    assert.throws(() => runHasOpenFiles(f.run, () => result));
  }
  assert.equal(runHasOpenFiles(f.run, () => ({ status: 1, stdout: '', stderr: '' })), false);
  assert.equal(runHasOpenFiles(f.run, () => ({ status: 0, stdout: 'p123\nnlog\n', stderr: '' })), true);
  assert.throws(() => cleanupOldRunLogs(f.root, f.current, { apply: true, inUse() { throw new Error('unknown occupancy'); } }));
  assert(existsSync(join(f.run, 'live.log'))); assert.deepEqual(readdirSync(f.current), []);
});
test('real lsof detects an open log, then allows read-only preview after close', linux, t => {
  const f = fixture(t), fd = openSync(join(f.run, 'live.log'), 'r');
  try { assert(runHasOpenFiles(f.run)); assert.equal(cleanupOldRunLogs(f.root, f.current).files.length, 0); }
  finally { closeSync(fd); }
  assert.equal(cleanupOldRunLogs(f.root, f.current).files.length, 6);
});
test('new occupancy at deletion recheck preserves the run', linux, t => {
  const f = fixture(t); let calls = 0;
  const r = cleanupOldRunLogs(f.root, f.current, { apply: true, inUse: () => ++calls > 1 });
  assert.equal(r.deletedFiles, 0); assert(existsSync(join(f.run, 'live.log')));
});
test('changed file aborts without deleting its replacement', linux, t => {
  const f = fixture(t); let calls = 0;
  assert.throws(() => cleanupOldRunLogs(f.root, f.current, { apply: true, inUse() {
    if (++calls === 2) writeFileSync(join(f.run, 'live.log'), 'changed-after-plan');
    return false;
  } }));
  assert.equal(readFileSync(join(f.run, 'live.log'), 'utf8'), 'changed-after-plan');
});
test('unlink failure is recorded and prevents success', linux, t => {
  const f = fixture(t);
  assert.throws(() => cleanupOldRunLogs(f.root, f.current, { ...f.options, apply: true,
    remove() { throw Object.assign(new Error('denied'), { code: 'EACCES' }); } }));
  assert(existsSync(join(f.run, 'live.log')));
  assert.match(readFileSync(join(f.current, 'old-runs-cleanup.jsonl'), 'utf8'), /"type":"failed","code":"EACCES"/);
});
test('cannot overwrite cleanup evidence; failure precedes any deletion', t => {
  const f = fixture(t); writeFileSync(join(f.current, 'old-runs-cleanup.jsonl'), 'preserved');
  assert.throws(() => cleanupOldRunLogs(f.root, f.current, { ...f.options, apply: true }));
  assert(existsSync(join(f.run, 'live.log')));
  assert.equal(readFileSync(join(f.current, 'old-runs-cleanup.jsonl'), 'utf8'), 'preserved');
});
test('audit file and both new directory entries are persisted before deletion', linux, t => {
  const f = fixture(t), persisted = [];
  const r = cleanupOldRunLogs(f.root, f.current, { ...f.options, apply: true,
    persistDirectory(path) {
      assert.match(readFileSync(join(f.current, 'old-runs-cleanup.jsonl'), 'utf8'), /"type":"plan"/);
      assert(existsSync(join(f.run, 'live.log'))); persisted.push(path);
    },
    remove(path) { assert.deepEqual(persisted, [f.current, f.root]); unlinkSync(path); },
  });
  assert.equal(r.deletedFiles, 6);
});
test('directory persistence failure aborts before any deletion', t => {
  const f = fixture(t); let removed = 0;
  assert.throws(() => cleanupOldRunLogs(f.root, f.current, { ...f.options, apply: true,
    persistDirectory() { throw new Error('mock sync failure'); }, remove() { removed++; },
  }));
  assert.equal(removed, 0); assert(existsSync(join(f.run, 'live.log')));
});
