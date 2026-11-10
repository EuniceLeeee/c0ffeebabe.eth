import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, chmod, symlink, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { remoteCatchupAuth, ensureCatchupBigQueryAuth } from './cloud-bigquery-auth.mjs';

const token = 'fixture-private-token-' + 'a'.repeat(40);
const options = { resumePrices: '1', catchupSource: 'bigquery', minValidityMs: 900_000 };
const config = { configuration: 'existing-ready', instance: 'fixture', project: 'fixture', zone: 'fixture',
  node: '/fixture/node', launcher: '/fixture/current/launcher.mjs' };

async function fixture(context, expiresAt = Date.now() - 1000) {
  const root = await mkdtemp(join(tmpdir(), 'mev-startup-auth-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'catchup-auth'), path = join(directory, 'bigquery-auth.json');
  const release = join(root, 'release');
  await mkdir(directory, { mode: 0o700 }); await mkdir(release);
  await writeFile(path, JSON.stringify({ token, expiresAt }), { mode: 0o600 });
  const bytes = JSON.stringify({ config: { SEARCHER_BLOCKSCAN_LIVE_CONTINUATION_ENABLED: '1',
    SEARCHER_BLOCKSCAN_CATCHUP_BIGQUERY_AUTH: 'token-file', SEARCHER_BLOCKSCAN_CATCHUP_BIGQUERY_TOKEN_FILE: path } });
  await writeFile(join(release, 'release.json'), bytes);
  const releaseSha256 = createHash('sha256').update(bytes).digest('hex');
  const profilePath = join(root, 'profile.json'); await writeFile(profilePath, JSON.stringify({ release, releaseSha256 }));
  return { path, directory, profilePath, releaseSha256 };
}

test('expired credential is detected and atomically replaced, token never returned', async context => {
  const f = await fixture(context);
  const before = await remoteCatchupAuth(f.profilePath, { ...options, action: 'inspect' });
  assert.equal(before.needsRefresh, true); assert(!JSON.stringify(before).includes(token));
  const credential = { token: token + 'new', expiresAt: Date.now() + 3_600_000 };
  const after = await remoteCatchupAuth(f.profilePath, { ...options, action: 'install', releaseSha256: f.releaseSha256, credential });
  assert.equal(after.needsRefresh, false); assert.deepEqual(JSON.parse(await readFile(f.path, 'utf8')), credential);
  assert(!JSON.stringify(after).includes(token));
});

test('near-expiry token refreshes before startup, fresh token is reused', async context => {
  for (const [remaining, expected] of [[899_000, true], [3_500_000, false]]) {
    const f = await fixture(context, Date.now() + remaining);
    assert.equal((await remoteCatchupAuth(f.profilePath, { ...options, action: 'inspect' })).needsRefresh, expected);
  }
});

test('missing credential can be provisioned; unsafe credential paths remain rejected', async context => {
  const f = await fixture(context); await rm(f.path);
  assert.equal((await remoteCatchupAuth(f.profilePath, { ...options, action: 'inspect' })).needsRefresh, true);
  await symlink(join(f.directory, 'absent'), f.path);
  await assert.rejects(remoteCatchupAuth(f.profilePath, { ...options, action: 'inspect' }));
  await rm(f.path); await writeFile(f.path, JSON.stringify({ token, expiresAt: Date.now() + 3_600_000 }), { mode: 0o600 });
  await chmod(f.path, 0o644);
  await assert.rejects(remoteCatchupAuth(f.profilePath, { ...options, action: 'inspect' }));
});

test('release drift and already-short replacement expiry fail without replacing old token', async context => {
  const f = await fixture(context); const before = await readFile(f.path, 'utf8');
  for (const request of [{ releaseSha256: 'wrong', credential: { token, expiresAt: Date.now() + 3_600_000 } },
    { releaseSha256: f.releaseSha256, credential: { token, expiresAt: Date.now() + 10_000 } }]) {
    await assert.rejects(remoteCatchupAuth(f.profilePath, { ...options, action: 'install', ...request }));
    assert.equal(await readFile(f.path, 'utf8'), before);
  }
});

test('RPC or disabled continuation never inspect or alter the credential file', async context => {
  const f = await fixture(context); await chmod(f.path, 0o644);
  for (const delta of [{ catchupSource: 'rpc' }, { resumePrices: '0' }]) {
    assert.deepEqual(await remoteCatchupAuth(f.profilePath, { ...options, ...delta, action: 'inspect' }), { required: false });
  }
});

test('startup client refreshes existing Ready account with real expiry and stdin-only transfer', async () => {
  const calls = []; const expiresAt = Date.now() + 3_600_000;
  const result = await ensureCatchupBigQueryAuth(config, { resumePrices: '1' }, { run: async (command, argv, input) => {
    calls.push({ command, argv, input });
    assert(!argv.join(' ').includes(token));
    if (calls.length === 1) return JSON.stringify({ required: true, needsRefresh: true, releaseSha256: 'frozen' });
    if (calls.length === 2) {
      assert.equal(input, undefined); assert(argv.includes('--configuration=existing-ready'));
      assert(argv.includes('--force-auth-refresh'));
      return JSON.stringify({ credential: { access_token: token, token_expiry: new Date(expiresAt).toISOString() } });
    }
    const request = JSON.parse(input); assert.equal(request.releaseSha256, 'frozen');
    assert.deepEqual(request.credential, { token, expiresAt });
    return JSON.stringify({ required: true, needsRefresh: false, expiresAt });
  } });
  assert.equal(calls.length, 3); assert.equal(result.refreshed, true); assert(!JSON.stringify(result).includes(token));
});

test('valid token avoids gcloud refresh; error messages never include subprocess secrets', async () => {
  let calls = 0;
  const result = await ensureCatchupBigQueryAuth(config, {}, { run: async () => { calls++; return JSON.stringify({ required: true, needsRefresh: false }); } });
  assert.equal(calls, 1); assert.equal(result.refreshed, false);
  await assert.rejects(ensureCatchupBigQueryAuth(config, {}, { run: async () => { throw new Error(token); } }), error => {
    assert(!String(error.stack).includes(token)); assert.equal(error.cause, undefined); return true;
  });
});
