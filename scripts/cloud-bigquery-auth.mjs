// Startup-only credential maintenance. No wallet access, service start or broadcast.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { dirname, join } from 'node:path';

const MIN_VALIDITY_MS = 15 * 60_000;

// Self-contained so the launcher can use its reviewed copy over SSH without
// modifying an immutable release. Credential contents travel only on stdin.
export async function remoteCatchupAuth(profilePath, request) {
  const fs = await import('node:fs/promises');
  const { constants } = await import('node:fs');
  const { dirname, join } = await import('node:path');
  const { createHash, randomUUID } = await import('node:crypto');
  const check = condition => { if (!condition) throw new Error('BigQuery startup credential check failed'); };
  check(['inspect', 'install'].includes(request.action));
  const profile = JSON.parse(await fs.readFile(profilePath, 'utf8'));
  const bytes = await fs.readFile(join(profile.release, 'release.json'));
  check(createHash('sha256').update(bytes).digest('hex') === profile.releaseSha256);
  const config = JSON.parse(bytes).config;
  const required = (request.resumePrices ?? config.SEARCHER_BLOCKSCAN_LIVE_CONTINUATION_ENABLED ?? '0') === '1'
    && (request.catchupSource ?? 'bigquery') === 'bigquery'
    && config.SEARCHER_BLOCKSCAN_CATCHUP_BIGQUERY_AUTH === 'token-file';
  if (!required) { check(request.action === 'inspect'); return { required: false }; }
  const directory = join(dirname(profilePath), 'catchup-auth');
  const path = join(directory, 'bigquery-auth.json');
  check(config.SEARCHER_BLOCKSCAN_CATCHUP_BIGQUERY_TOKEN_FILE === path);
  check(Number.isSafeInteger(request.minValidityMs) && request.minValidityMs >= 300_000 && request.minValidityMs <= 1_800_000);
  const safe = stat => stat.uid === process.getuid() && (stat.mode & 0o077) === 0;
  const credentialValid = value => typeof value?.token === 'string' && /^[A-Za-z0-9._~-]{30,8192}$/.test(value.token)
    && Number.isSafeInteger(value.expiresAt);
  let directoryExists = true;
  try { const stat = await fs.lstat(directory); check(stat.isDirectory() && !stat.isSymbolicLink() && safe(stat)); }
  catch (error) { if (error.code !== 'ENOENT') throw error; directoryExists = false; }
  let expiresAt = null;
  if (directoryExists) {
    let handle;
    try {
      handle = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const stat = await handle.stat();
      check(stat.isFile() && stat.nlink === 1 && safe(stat) && (stat.mode & 0o400) !== 0 && stat.size > 0 && stat.size <= 16_384);
      const value = JSON.parse(await handle.readFile('utf8')); check(credentialValid(value)); expiresAt = value.expiresAt;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    finally { await handle?.close(); }
  }
  if (request.action === 'install') {
    check(request.releaseSha256 === profile.releaseSha256);
    check(credentialValid(request.credential) && request.credential.expiresAt > Date.now() + request.minValidityMs);
    if (!directoryExists) await fs.mkdir(directory, { mode: 0o700 });
    const temporary = path + '.refresh-' + randomUUID();
    const handle = await fs.open(temporary, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(request.credential)); await handle.sync(); }
    finally { await handle.close(); }
    try { await fs.rename(temporary, path); }
    catch (error) { await fs.unlink(temporary); throw error; }
    expiresAt = request.credential.expiresAt;
  }
  return { required: true, releaseSha256: profile.releaseSha256, expiresAt,
    needsRefresh: expiresAt === null || expiresAt <= Date.now() + request.minValidityMs };
}

function privateCommand(command, argv, input) {
  return new Promise((resolve, reject) => {
    const child = execFile(command, argv, { encoding: 'utf8', timeout: 60_000, maxBuffer: 1024 * 1024 }, (error, stdout) => {
      if (error) reject(new Error('BigQuery credential command failed; credential details withheld'));
      else resolve(stdout);
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

export async function ensureCatchupBigQueryAuth(config, options = {}, dependencies = {}) {
  const run = dependencies.run ?? privateCommand;
  try {
    for (const name of ['configuration', 'instance', 'project', 'zone']) assert(/^[a-zA-Z0-9._-]+$/.test(config[name]));
    for (const name of ['node', 'launcher']) assert(/^\/[a-zA-Z0-9/_.-]+$/.test(config[name]));
    const profilePath = join(dirname(dirname(config.launcher)), 'profile.json');
    const code = `const fs=await import('node:fs');try{const raw=fs.readFileSync(0,'utf8');if(raw.length>16384)throw Error();const result=await (${remoteCatchupAuth.toString()})(${JSON.stringify(profilePath)},JSON.parse(raw));console.log(JSON.stringify(result));}catch{console.error('BigQuery startup credential check failed');process.exitCode=1;}`;
    const remote = `sudo -n ${config.node} --input-type=module -e '${code.replaceAll("'", "'\\''")}'`;
    const argv = ['--configuration=' + config.configuration, 'compute', 'ssh', config.instance,
      '--project=' + config.project, '--zone=' + config.zone, '--tunnel-through-iap', '--quiet', '--command=' + remote, '--', '-T'];
    const request = { action: 'inspect', ...options, minValidityMs: MIN_VALIDITY_MS };
    const inspect = JSON.parse(await run('gcloud', argv, JSON.stringify(request)));
    if (!inspect.required || !inspect.needsRefresh) return { ...inspect, refreshed: false };
    // Same existing account/configuration as Ready; actual Google expiry, not an
    // assumed hour from the moment a cached token happens to be read.
    const auth = JSON.parse(await run('gcloud', ['--configuration=' + config.configuration,
      'config', 'config-helper', '--force-auth-refresh', '--format=json']));
    const credential = { token: auth.credential?.access_token, expiresAt: Date.parse(auth.credential?.token_expiry) };
    assert(typeof credential.token === 'string' && /^[A-Za-z0-9._~-]{30,8192}$/.test(credential.token));
    assert(credential.expiresAt > Date.now() + MIN_VALIDITY_MS);
    const installed = JSON.parse(await run('gcloud', argv, JSON.stringify({ ...request, action: 'install',
      releaseSha256: inspect.releaseSha256, credential })));
    assert(installed.required && !installed.needsRefresh && installed.expiresAt === credential.expiresAt);
    return { ...installed, refreshed: true };
  } catch {
    throw new Error('BigQuery startup authentication unavailable; launch blocked and credential details withheld');
  }
}
