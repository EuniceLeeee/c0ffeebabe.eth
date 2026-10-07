import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { pruneCloudLiveLogs } from './cloud-live-log-preflight.mjs';

const linux = { skip: process.platform !== 'linux' };
async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), 'mev-live-cleanup-test-'));
  try { await run(root); } finally { await rm(root, { recursive: true, force: true }); }
}
async function live(root, name) {
  const directory = join(root, name);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'launch.mjs'), '// bounded live launcher');
  await writeFile(join(directory, 'run-contract.json'), JSON.stringify({ broadcast: false, signing: false, blockLimit: 250 }));
  await writeFile(join(directory, 'live.log'), 'raw-live');
  await writeFile(join(directory, 'mids.jsonl'), 'raw-price');
  await writeFile(join(directory, 'checkpoint.json'), 'ready-evidence');
  return directory;
}

test('dry-run then exact cleanup preserves current run, Ready and independent evidence', linux, async () => {
  await fixture(async root => {
    const old = await live(root, 'old'), current = await live(root, 'current');
    const audit = join(root, 'audit');
    await mkdir(audit);
    await writeFile(join(audit, 'events.jsonl'), 'diagnostic-evidence');
    const first = await pruneCloudLiveLogs({ root, currentRun: current });
    assert.deepEqual(first.candidates.map(file => file.path).sort(), [join(old, 'live.log'), join(old, 'mids.jsonl')]);
    assert.equal(first.deleted.length, 0);
    assert.equal(await readFile(join(old, 'live.log'), 'utf8'), 'raw-live');
    const result = await pruneCloudLiveLogs({ root, currentRun: current, apply: true });
    assert.equal(result.deleted.length, 2);
    await assert.rejects(readFile(join(old, 'live.log')), { code: 'ENOENT' });
    assert.equal(await readFile(join(old, 'checkpoint.json'), 'utf8'), 'ready-evidence');
    assert.equal(await readFile(join(current, 'live.log'), 'utf8'), 'raw-live');
    assert.equal(await readFile(join(audit, 'events.jsonl'), 'utf8'), 'diagnostic-evidence');
    assert.equal((await pruneCloudLiveLogs({ root, currentRun: current, apply: true })).deleted.length, 0);
  });
});

test('active file handles preserve the entire old run', linux, async () => {
  await fixture(async root => {
    const active = await live(root, 'active');
    const child = spawn(process.execPath, ['-e', 'require("node:fs").openSync(process.argv[1], "r"); process.stdout.write("ready"); setInterval(() => {}, 1000)', join(active, 'live.log')]);
    try {
      await once(child.stdout, 'data');
      const result = await pruneCloudLiveLogs({ root, apply: true });
      assert.equal(result.deleted.length, 0);
      assert.deepEqual(result.skipped, [{ directory: active, reason: 'active_log_file' }]);
      assert.equal(await readFile(join(active, 'mids.jsonl'), 'utf8'), 'raw-price');
    } finally { child.kill(); await once(child, 'exit'); }
  });
});

test('active hardlink or symlink aliases protect every log in their run', linux, async () => {
  await fixture(async root => {
    for (const kind of ['hardlink', 'symlink']) {
      const active = await live(root, kind), alias = join(root, `${kind}-alias.log`);
      if (kind === 'hardlink') await link(join(active, 'live.log'), alias);
      else await symlink(alias, join(active, 'events.jsonl'));
      if (kind === 'symlink') await writeFile(alias, 'symlink-target');
      const child = spawn(process.execPath, ['-e', 'require("node:fs").openSync(process.argv[1], "r"); process.stdout.write("ready"); setInterval(() => {}, 1000)', alias]);
      try {
        await once(child.stdout, 'data');
        const result = await pruneCloudLiveLogs({ root });
        assert(!result.candidates.some(file => file.path.startsWith(active + '/')));
        assert(result.skipped.some(run => run.directory === active && run.reason === 'active_log_file'));
        assert.equal(await readFile(join(active, 'mids.jsonl'), 'utf8'), 'raw-price');
      } finally { child.kill(); await once(child, 'exit'); }
    }
  });
});

test('symlink and hardlink logs are never deleted; unsafe roots and unrecognized contracts reject', linux, async () => {
  await fixture(async root => {
    const old = await live(root, 'old');
    await link(join(old, 'live.log'), join(old, 'saved-evidence.log'));
    await symlink(join(old, 'checkpoint.json'), join(old, 'events.jsonl'));
    await symlink(old, join(root, 'alias'));
    const result = await pruneCloudLiveLogs({ root, apply: true });
    assert.deepEqual(result.deleted, [join(old, 'mids.jsonl')]);
    assert.equal(await readFile(join(old, 'live.log'), 'utf8'), 'raw-live');
    assert.equal(await readFile(join(old, 'events.jsonl'), 'utf8'), 'ready-evidence');
    await assert.rejects(pruneCloudLiveLogs({ root: '/' }), /broad cleanup root/);
    await assert.rejects(pruneCloudLiveLogs({ root, currentRun: root }), /physical child/);
    await assert.rejects(pruneCloudLiveLogs({ root: join(root, 'alias') }), /symlinks/);
    await writeFile(join(old, 'run-contract.json'), JSON.stringify({ broadcast: true, blockLimit: 250 }));
    await assert.rejects(pruneCloudLiveLogs({ root, apply: true }), /Unrecognized live run/);
  });
});
