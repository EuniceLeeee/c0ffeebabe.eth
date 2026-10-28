// Linux-only startup housekeeping. No recursion, no default deletion, no runtime/RPC dependencies.
import assert from 'node:assert/strict';
import { closeSync, constants, fsyncSync, fstatSync, lstatSync, openSync,
  readFileSync, readdirSync, realpathSync, unlinkSync, writeSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

export const MANUAL_RUNS = '/opt/mev-cloud/manual-live/runs';
export const LIVE_LOG_NAMES = Object.freeze([
  // Price baselines/deltas are retained replay inputs, not disposable live logs.
  'live.log', 'events.jsonl', 'routes.jsonl', 'reverts.jsonl', 'solver-inputs.jsonl',
]);
const RUN_NAME = /^live-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[a-f0-9]{8}$/;
const UNIT = 'mev-manual-bounded-live.service';
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs;
const regular = s => s.isFile() && s.nlink === 1 && s.uid === process.getuid();
function directory(path) {
  const s = lstatSync(path);
  assert(s.isDirectory() && s.uid === process.getuid() && !(s.mode & 0o022), 'untrusted cleanup directory');
  assert.equal(realpathSync(path), path, 'cleanup path must be physical');
  return s;
}
function metadata(path) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const s = fstatSync(fd); assert(regular(s) && s.size <= 64 * 1024, 'unsafe run metadata');
    return JSON.parse(readFileSync(fd, 'utf8'));
  } finally { closeSync(fd); }
}
function terminal(run) {
  try {
    const request = metadata(join(run, 'request.json')), permit = metadata(join(run, 'permit.json'));
    const ended = metadata(join(run, 'ended.json')), proc = metadata(join(run, 'process.json'));
    if (request.schemaVersion !== 1 || request.runId !== basename(run) || request.userInitiated !== true ||
        permit.runId !== request.runId || permit.status !== 'stopped' || permit.validUntilMs !== 0 ||
        !Number.isFinite(Date.parse(ended.at)) || typeof ended.reason !== 'string' || !ended.reason ||
        !Number.isSafeInteger(proc.pid) || proc.pid <= 1 || proc.unit !== UNIT) return 'not-confirmed-ended';
    // A reused PID is conservatively retained too; it is not proof the old process has gone.
    try { process.kill(proc.pid, 0); return 'recorded-pid-exists'; }
    catch (error) { if (error.code !== 'ESRCH') return 'recorded-pid-unknown'; }
    return null;
  } catch { return 'not-confirmed-ended'; }
}
export function runHasOpenFiles(run, invoke = spawnSync) {
  const result = invoke('/usr/bin/lsof', ['-nP', '-Fpn', '+D', run],
    { encoding: 'utf8', timeout: 10000, maxBuffer: 4 * 1024 ** 2 });
  assert(!result.error && !result.signal && [0, 1].includes(result.status) && !result.stderr?.trim(),
    'cannot establish old-run file occupancy');
  return result.status === 0 || Boolean(result.stdout?.trim());
}
function syncDirectory(path) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

// Tests use isolated roots and mocked occupancy; the launcher pins MANUAL_RUNS before calling.
export function cleanupOldRunLogs(root, currentRun, { apply = false, inUse = runHasOpenFiles,
  remove = unlinkSync, persistDirectory = syncDirectory } = {}) {
  assert.equal(resolve(root), root); const rootStat = directory(root);
  if (currentRun !== undefined) assert.equal(dirname(currentRun), root);
  const report = { schemaVersion: 1, root, currentRun: currentRun ?? null, mode: apply ? 'apply' : 'preview',
    files: [], skipped: [], deletedFiles: 0, deletedBytes: 0, deletedAllocatedBytes: 0 };
  const runs = [];
  for (const name of readdirSync(root).sort()) {
    const run = join(root, name);
    if (run === currentRun) { report.skipped.push({ run, reason: 'current-run' }); continue; }
    if (!RUN_NAME.test(name)) { report.skipped.push({ run, reason: 'unknown-entry' }); continue; }
    let s;
    try { s = directory(run); assert.equal(s.dev, rootStat.dev); }
    catch { report.skipped.push({ run, reason: 'unsafe-directory' }); continue; }
    const reason = terminal(run);
    if (reason) { report.skipped.push({ run, reason }); continue; }
    if (inUse(run)) { report.skipped.push({ run, reason: 'open-files' }); continue; }
    const files = [];
    for (const name of LIVE_LOG_NAMES) {
      const path = join(run, name); let file;
      try { file = lstatSync(path); }
      catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      if (!regular(file) || file.dev !== rootStat.dev) {
        report.skipped.push({ path, reason: 'unsafe-log-file' }); continue;
      }
      files.push({ path, name, bytes: file.size, allocatedBytes: file.blocks * 512, stat: file });
    }
    runs.push({ run, stat: s, files });
    report.files.push(...files.map(({ stat, ...file }) => file));
  }
  report.eligibleBytes = report.files.reduce((sum, file) => sum + file.bytes, 0);
  report.eligibleAllocatedBytes = report.files.reduce((sum, file) => sum + file.allocatedBytes, 0);
  if (!apply) return report;
  assert(currentRun && RUN_NAME.test(basename(currentRun)), 'new run required for cleanup audit');
  directory(currentRun);
  const audit = join(currentRun, 'old-runs-cleanup.jsonl');
  const auditFd = openSync(audit, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  const record = value => {
    const bytes = Buffer.from(JSON.stringify({ at: new Date().toISOString(), ...value }) + '\n');
    let offset = 0;
    while (offset < bytes.length) { const n = writeSync(auditFd, bytes, offset); assert(n > 0); offset += n; }
    fsyncSync(auditFd);
  };
  try {
    record({ type: 'plan', ...report });
    // Persist both new directory entries before making any old-log deletion durable.
    persistDirectory(currentRun); persistDirectory(root);
    for (const item of runs) {
      const currentRoot = directory(root);
      assert.equal(currentRoot.ino, rootStat.ino, 'cleanup root changed'); assert.equal(currentRoot.dev, rootStat.dev);
      const s = directory(item.run); assert.equal(s.ino, item.stat.ino); assert.equal(s.dev, item.stat.dev);
      assert.equal(terminal(item.run), null, 'old run is no longer terminal');
      if (inUse(item.run)) {
        const skipped = { run: item.run, reason: 'open-files-on-recheck' };
        report.skipped.push(skipped); record({ type: 'skip', ...skipped }); continue;
      }
      // Pin the checked directory: a replaced path cannot redirect unlink into another tree.
      const fd = openSync(item.run, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try {
        const pinned = fstatSync(fd); assert.equal(pinned.ino, s.ino); assert.equal(pinned.dev, s.dev);
        for (const file of item.files) {
          const path = '/proc/self/fd/' + fd + '/' + file.name;
          const now = lstatSync(path);
          assert(regular(now) && sameFile(now, file.stat), 'old log changed during cleanup');
          record({ type: 'delete-intent', path: file.path, bytes: file.bytes, allocatedBytes: file.allocatedBytes });
          remove(path);
          report.deletedFiles++; report.deletedBytes += file.bytes; report.deletedAllocatedBytes += file.allocatedBytes;
          record({ type: 'deleted', path: file.path, bytes: file.bytes, allocatedBytes: file.allocatedBytes });
        }
        fsyncSync(fd);
      } finally { closeSync(fd); }
    }
    record({ type: 'completed', deletedFiles: report.deletedFiles, deletedBytes: report.deletedBytes,
      deletedAllocatedBytes: report.deletedAllocatedBytes });
    return { ...report, audit };
  } catch (error) {
    try { record({ type: 'failed', code: error.code ?? 'cleanup-check-failed', deletedFiles: report.deletedFiles }); }
    catch { /* Never launch if either deletion or its durable audit failed. */ }
    throw new Error('Old-run cleanup failed; inspect ' + audit);
  } finally { closeSync(auditFd); }
}
