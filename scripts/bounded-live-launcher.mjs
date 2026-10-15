// Reusable, explicitly human-started bounded session. Importing this file has no side effects.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, copyFileSync, existsSync, lstatSync, mkdirSync,
  openSync, readFileSync, readlinkSync, readdirSync, realpathSync, renameSync,
  statfsSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { cleanupOldRunLogs, MANUAL_RUNS } from './bounded-live-run-cleanup.mjs';

const DEFAULT_PROFILE = '/opt/mev-cloud/manual-live/profile.json';
const UNIT = 'mev-manual-bounded-live.service';
const MARKER = '/opt/MEV/.deploy-live';
const MAX_WALLET = 200000000000000000n;
const RESERVE = 500000000000000n;
const WALL_MS = 12 * 60 * 60 * 1000;
export const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const json = file => JSON.parse(readFileSync(file, 'utf8'));
const exclusiveJson = (file, value) => writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
const writeAtomic = (file, value) => {
  const next = file + '.' + randomUUID();
  exclusiveJson(next, value);
  renameSync(next, file);
};

export function parseArguments(args) {
  let mode = 'check', blocks = 2500, profile = DEFAULT_PROFILE, run;
  const seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    assert(!seen.has(key), 'duplicate option'); seen.add(key);
    if (['--check', '--broadcast', '--status', '--stop', '--supervise'].includes(key)) {
      assert(mode === 'check' && !seen.has('mode'), 'one mode only');
      seen.add('mode'); mode = key.slice(2);
    } else if (key === '--blocks') {
      assert(/^[1-9][0-9]*$/.test(args[i + 1] ?? ''), 'invalid block limit');
      blocks = Number(args[++i]);
    } else if (key === '--profile') profile = args[++i];
    else if (key === '--run') run = args[++i];
    else throw new Error('unknown option');
  }
  assert(Number.isSafeInteger(blocks) && blocks >= 1 && blocks <= 2500, 'block limit must be 1..2500');
  assert(typeof profile === 'string' && isAbsolute(profile), 'absolute profile required');
  assert(mode === 'supervise' ? typeof run === 'string' && isAbsolute(run) : run === undefined, 'invalid run option');
  return { mode, blocks, profile, run };
}

export function makeRunConfig(base, profile, run) {
  // The frozen base contains only public, reviewed options; no inherited process environment.
  const result = { ...base,
    SEARCHER_DRY_RUN: '0', SEARCHER_BLOCKSCAN_SUBMIT: '1', SEARCHER_EV_GATE: '1',
    SEARCHER_USE_READY_GENERATION: '1', SEARCHER_DRY_RUN_USE_READY_GENERATION: '0',
    SEARCHER_DRY_RUN_BOTVM_CODE_OVERRIDE: '0', SEARCHER_TEST_DISABLE_DOTENV: '1',
    SEARCHER_ENABLE_BACKRUN: '0', SEARCHER_ENABLE_MEMPOOL: '0',
    SEARCHER_ENABLE_MEV_SHARE: '0', SEARCHER_ENABLE_HASH_ONLY: '0',
    SEARCHER_BRIBE_BPS: '9900', SEARCHER_BRIBE_ALL_ABOVE_GAS: '0',
    SEARCHER_BRIBE_GAS_BASIS: 'measured-gas',
    MEV_LIVE_MAX_WALLET_ETH: '0.2', BOTVM_OWNER: profile.wallet, BOTVM_ADDRESS: profile.executor,
    SEARCHER_UNIVERSE_REBUILD_CHECKPOINT_PATH: join(run, 'checkpoint.json'),
    SEARCHER_REVM_SIM_BIN: join(profile.release, 'runtime/listener/revm-sim/target/release/revm-sim'),
    SEARCHER_EVENTS_PATH: join(run, 'events.jsonl'),
    SEARCHER_BLOCKSCAN_ROUTE_EVENTS_PATH: join(run, 'routes.jsonl'),
    SEARCHER_BLOCKSCAN_MID_HISTORY_PATH: join(run, 'mids.jsonl'),
    SEARCHER_BLOCKSCAN_SOLVER_INPUTS_PATH: join(run, 'solver-inputs.jsonl'),
    SEARCHER_BLOCKSCAN_SOLVER_INPUTS_MAX_BYTES: String(10 * 1024 ** 3),
    SEARCHER_SIM_REVERT_DIAGNOSTICS_PATH: join(run, 'reverts.jsonl'),
    SEARCHER_CREDIT_LIVE_MARKER_PATH: join(run, 'standing-credit-not-authorized'),
    SEARCHER_LIVE_SESSION_PATH: join(run, 'permit.json'),
    SEARCHER_LIVE_SESSION_ID: basename(run),
  };
  for (const [key, value] of Object.entries(result)) {
    assert(typeof value === 'string', 'config values must be strings');
    assert(!/PRIVATE_KEY|RPC_URL|SECRET|PASSWORD/.test(key), 'public config cannot contain credentials');
  }
  assert.equal(result.SEARCHER_BLOCKSCAN_EFFECTIVE_WETH_INPUT, '0.02');
  assert.equal(result.SEARCHER_BLOCKSCAN_MAX_CANDIDATES, '10');
  assert.equal(result.SEARCHER_BLOCKSCAN_REFINE_CANDIDATES, '512');
  assert.equal(result.SEARCHER_BLOCKSCAN_SINGLE_FUNDING_ENABLED, '1');
  assert.equal(result.SEARCHER_BLOCKSCAN_POOL_REVERT_FILTER, '1');
  return result;
}

export class RunWindow {
  constructor({ runId, profile, blocks, balance, now }) {
    assert(Number.isSafeInteger(blocks) && blocks >= 1 && blocks <= 2500);
    assert(balance > 2n * RESERVE && balance <= MAX_WALLET, 'wallet outside bounded range');
    this.blocks = blocks; this.first = null; this.last = null;
    this.ready = false; this.mode = false; this.transitions = new Map();
    this.permit = { schemaVersion: 1, runId, mode: 'standalone', wallet: profile.wallet,
      executor: profile.executor, chainId: 1, status: 'pending',
      firstTargetBlock: 1, lastTargetBlock: blocks, maxBlocks: blocks,
      startedAtMs: now, deadlineAtMs: now + WALL_MS, validUntilMs: now + 12000,
      baselineBalanceWei: balance.toString(), minimumBalanceWei: ((balance + 1n) / 2n).toString(),
      maxWalletWei: MAX_WALLET.toString() };
  }
  renew(now, balance) {
    assert(this.permit.status !== 'stopped');
    assert(now >= this.permit.startedAtMs && now < this.permit.deadlineAtMs, 'wall limit');
    assert(balance >= BigInt(this.permit.minimumBalanceWei) && balance <= MAX_WALLET, 'wallet circuit breaker');
    this.permit.validUntilMs = Math.min(now + 12000, this.permit.deadlineAtMs);
    return { ...this.permit };
  }
  observe(line, generation) {
    if (line === '[searcher/live] mode=live-submit') this.mode = true;
    if (line === '[searcher/live] mode=dry-run') throw new Error('unexpected dry-run mode');
    if (line.startsWith('[searcher/live] strict ready catalog loaded:')) {
      assert(!this.ready && line.includes('generation=' + generation + ' '), 'unexpected Ready generation');
      this.ready = true;
    }
    if (line.includes('strict producer Graph differs from ready edge objects') ||
        line.includes('"type":"strict_simulation_fatal"') || /\brevm-sim fatal (?:source-fault|protocol-fault)\b/.test(line)) {
      throw new Error('runtime safety failure');
    }
    if (line.startsWith('[searcher/rpc-throttle-observation] ')) {
      const value = JSON.parse(line.slice(line.indexOf('{')));
      assert(['observe', 'recovered', 'stop'].includes(value.action) && value.limit === 5);
      if (value.action === 'stop') throw new Error('terminal RPC throttle');
    }
    if (line.startsWith('[searcher/blockscan-activity-range] ')) {
      const value = JSON.parse(line.slice(line.indexOf('{')));
      assert(Number.isSafeInteger(value.sourceBlock) && Number.isSafeInteger(value.transitions));
      this.transitions.set(value.sourceBlock, value.transitions);
      for (const height of this.transitions.keys()) if (height < value.sourceBlock - 64) this.transitions.delete(height);
    }
    if (!line.includes('"type":"block_scan_timing"')) return null;
    const event = JSON.parse(line.slice(line.indexOf('{')));
    if (event.startup_warm) return null;
    assert(Number.isSafeInteger(event.source_block) && event.source_block > 0);
    this.last = event.source_block;
    if (this.first === null) {
      if (!this.ready || !this.mode || event.stages?.state?.status !== 'ran' || this.transitions.get(this.last) !== 1) return null;
      // Authorization starts on the NEXT height: this observation is after the current pipeline pass.
      this.first = this.last + 1;
      this.permit.firstTargetBlock = this.first + 1;
      this.permit.lastTargetBlock = this.first + this.blocks;
      this.permit.status = 'active';
      return { activated: true, from: this.first, to: this.first + this.blocks - 1, count: this.blocks };
    }
    return this.last >= this.first + this.blocks - 1 ? { completed: true } : null;
  }
  stop() { this.permit.status = 'stopped'; this.permit.validUntilMs = 0; return { ...this.permit }; }
}

function privateRegular(file) {
  const info = lstatSync(file);
  assert(info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && (info.mode & 0o077) === 0, 'private regular file required');
}
function assertStartDisk(runs) {
  const disk = statfsSync(runs);
  assert(disk.bavail * disk.bsize >= 4 * 1024 ** 3, 'at least 4 GiB free required');
}
function verifyRelease(profile, checkDisk = true) {
  assert.equal(profile.schemaVersion, 1); assert.equal(profile.chainId, 1);
  assert(/^0x[0-9a-f]{40}$/i.test(profile.wallet) && /^0x[0-9a-f]{40}$/i.test(profile.executor));
  for (const key of ['release', 'ready', 'runs', 'node', 'rpcFile']) assert(isAbsolute(profile[key]));
  assert.equal(realpathSync(profile.release), profile.release, 'release path must be physical');
  const release = json(join(profile.release, 'release.json'));
  assert.equal(sha(readFileSync(join(profile.release, 'release.json'))), profile.releaseSha256, 'release manifest changed');
  for (const [path, expected] of release.files) {
    assert(!isAbsolute(path) && !path.split('/').includes('..'));
    const file = join(profile.release, path);
    const bytes = lstatSync(file).isSymbolicLink() ? Buffer.from(readlinkSync(file)) : readFileSync(file);
    assert.equal(sha(bytes), expected, 'release file changed: ' + path);
  }
  assert.equal(sha(readFileSync(profile.ready)), release.readySha256, 'Ready reference changed');
  assert.equal(json(join(profile.release, 'checks.json')).passed, true, 'release checks incomplete');
  if (checkDisk) assertStartDisk(profile.runs);
  return release;
}
function assertNoSearcher() {
  for (const pid of readdirSync('/proc').filter(name => /^\d+$/.test(name))) {
    let cmd;
    try { cmd = readFileSync('/proc/' + pid + '/cmdline', 'utf8').split('\0').join(' '); }
    catch (error) { if (error.code === 'ENOENT' || error.code === 'ESRCH') continue; throw error; }
    assert(!/(?:src|dist)\/searcher\/(?:main|index)\.(?:ts|js)/.test(cmd), 'another searcher is running');
  }
}
async function inspector(profile) {
  privateRegular(profile.rpcFile);
  const endpoint = json(profile.rpcFile).MAINNET_RPC_URL;
  assert(typeof endpoint === 'string' && endpoint.length > 0);
  const ethers = await import(pathToFileURL(join(profile.release, 'runtime/listener/node_modules/ethers/lib.esm/index.js')).href);
  const req = new ethers.FetchRequest(endpoint); req.timeout = 8000;
  const provider = new ethers.JsonRpcProvider(req);
  try {
    assert.equal(BigInt(await provider.send('eth_chainId', [])), 1n);
    const head = await provider.getBlock('latest'); assert(head?.hash);
    const pin = { blockHash: head.hash, requireCanonical: true };
    const [code, owner, balance] = await Promise.all([
      provider.send('eth_getCode', [profile.executor, pin]),
      provider.send('eth_call', [{ to: profile.executor, data: '0x8da5cb5b' }, pin]),
      provider.send('eth_getBalance', [profile.wallet, pin]),
    ]);
    assert.equal(ethers.keccak256(code), profile.executorCodeHash, 'deployed executor changed');
    assert.equal(ethers.AbiCoder.defaultAbiCoder().decode(['address'], owner)[0].toLowerCase(), profile.wallet.toLowerCase(), 'owner mismatch');
    assert(BigInt(balance) > 2n * RESERVE && BigInt(balance) <= MAX_WALLET, 'wallet outside bounded range');
    return { provider, endpoint, ethers, balance: BigInt(balance), head: head.number };
  } catch (error) { provider.destroy(); throw error; }
}

async function receiveKey() {
  // Only the user-operated client invokes this mode. Never put credentials in argv or output.
  let input = '';
  for await (const data of process.stdin) { input += data; assert(input.length <= 1024, 'credential input too large'); }
  const value = JSON.parse(input);
  assert.deepEqual(Object.keys(value).sort(), ['OWNER_PRIVATE_KEY', 'confirmation']);
  assert.equal(value.confirmation, 'human-start');
  assert(/^0x[0-9a-f]{64}$/i.test(value.OWNER_PRIVATE_KEY), 'invalid key format');
  return value.OWNER_PRIVATE_KEY;
}

async function start(options, profile, release) {
  assert.equal(process.getuid(), 0, 'root required');
  assert.equal(profile.runs, MANUAL_RUNS, 'cleanup is limited to the manual-live runs directory');
  assertNoSearcher(); assert(!existsSync(MARKER), 'existing live marker: review active owner first');
  const check = await inspector(profile);
  try {
    const key = await receiveKey();
    assert.equal(new check.ethers.Wallet(key).address.toLowerCase(), profile.wallet.toLowerCase(), 'signer mismatch');
    // Repeat after network/human input waits; never clean while a previous supervisor is starting/stopping.
    assertNoSearcher(); assert(!existsSync(MARKER), 'existing live marker');
    const service = spawnSync('/usr/bin/systemctl', ['show', UNIT, '-p', 'MainPID', '-p', 'ActiveState'],
      { encoding: 'utf8', timeout: 10000 });
    assert.equal(service.status, 0, 'cannot establish previous service state');
    assert(service.stdout.split('\n').includes('MainPID=0') &&
      service.stdout.split('\n').includes('ActiveState=inactive'), 'previous service is not inactive');
    const runId = 'live-' + new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID().slice(0, 8);
    const run = join(profile.runs, runId); mkdirSync(run, { mode: 0o700 });
    const cleanup = cleanupOldRunLogs(profile.runs, run, { apply: true });
    console.log(JSON.stringify({ oldRunCleanup: true, deletedFiles: cleanup.deletedFiles,
      deletedBytes: cleanup.deletedBytes, deletedAllocatedBytes: cleanup.deletedAllocatedBytes, audit: cleanup.audit }));
    // Cleanup may recover a low disk, but it never bypasses the existing startup/renewal disk guards.
    assertStartDisk(profile.runs);
    const credential = '/run/' + runId + '.credential.json';
    exclusiveJson(credential, { OWNER_PRIVATE_KEY: key });
    try {
      copyFileSync(profile.ready, join(run, 'checkpoint.json'), constants.COPYFILE_EXCL);
      assert.equal(sha(readFileSync(join(run, 'checkpoint.json'))), release.readySha256);
      exclusiveJson(join(run, 'request.json'), { schemaVersion: 1, runId, profilePath: options.profile,
        profileSha256: sha(readFileSync(options.profile)), releaseSha256: profile.releaseSha256,
        blocks: options.blocks, credentialName: 'owner', userInitiated: true, requestedAt: new Date().toISOString() });
      exclusiveJson(join(run, 'config.json'), makeRunConfig(release.config, profile, run));
      const result = spawnSync('/usr/bin/systemd-run', ['--quiet', '--collect', '--unit=' + UNIT,
        '--property=Restart=no', '--property=Type=exec', '--property=RuntimeMaxSec=43200',
        '--property=TimeoutStopSec=10', '--property=KillMode=control-group', '--property=UMask=0077',
        '--property=LoadCredential=owner:' + credential,
        profile.node, join(profile.release, 'bounded-live-launcher.mjs'), '--supervise', '--profile', options.profile, '--run', run],
        { encoding: 'utf8', timeout: 15000 });
      assert.equal(result.status, 0, 'supervisor did not start');
      console.log(JSON.stringify({ requested: true, unit: UNIT, run, blocks: options.blocks, automaticRestart: false }));
    } finally {
      // Type=exec returns only after systemd loaded its private credential copy.
      // Its copy is removed by systemd even if the supervisor fails before JS cleanup.
      if (existsSync(credential)) unlinkSync(credential);
    }
  } finally { check.provider.destroy(); }
}

async function supervise(options, profile, release) {
  const run = options.run;
  assert.equal(dirname(run), profile.runs); assert.equal(realpathSync(run), run);
  const request = json(join(run, 'request.json'));
  assert.equal(request.profileSha256, sha(readFileSync(options.profile)));
  assert.equal(request.releaseSha256, profile.releaseSha256);
  assert.equal(request.credentialName, 'owner');
  assert.equal(join(profile.runs, request.runId), run);
  assert.equal(request.userInitiated, true);
  assert(!existsSync(join(run, 'run-contract.json')), 'a run cannot be started twice');
  assertNoSearcher(); assert(!existsSync(MARKER), 'existing live marker');
  let child, check, window, timer, hardTimer, killTimer, fd, markerContent, stopping = false, reason = null;
  const permitPath = join(run, 'permit.json');
  const record = (name, value) => exclusiveJson(join(run, name + '.json'), value);
  const stop = why => {
    if (stopping) return; stopping = true; reason = why;
    let revokeFailed = false;
    try { if (window) writeAtomic(permitPath, window.stop()); }
    catch {
      revokeFailed = true;
      // Missing permit also denies every captured guard; stopping must never reject a timer callback.
      try { unlinkSync(permitPath); } catch { /* The child is killed immediately below. */ }
    }
    try { child?.kill(revokeFailed ? 'SIGKILL' : 'SIGTERM'); } catch { /* Already gone. */ }
    killTimer = setTimeout(() => { try { child?.kill('SIGKILL'); } catch { /* Already gone. */ } }, 5000);
  };
  const onSignal = () => stop('user_or_systemd_stop');
  process.on('SIGTERM', onSignal); process.on('SIGINT', onSignal);
  try {
    check = await inspector(profile);
    const credentialDirectory = process.env.CREDENTIALS_DIRECTORY;
    assert.equal(credentialDirectory, '/run/credentials/' + UNIT);
    const credential = join(credentialDirectory, request.credentialName);
    privateRegular(credential);
    const secret = json(credential).OWNER_PRIVATE_KEY;
    assert.equal(new check.ethers.Wallet(secret).address.toLowerCase(), profile.wallet.toLowerCase());
    const config = makeRunConfig(release.config, profile, run);
    assert.deepEqual(config, json(join(run, 'config.json')));
    assert(!existsSync(config.SEARCHER_CREDIT_LIVE_MARKER_PATH));
    assert.equal(sha(readFileSync(config.SEARCHER_UNIVERSE_REBUILD_CHECKPOINT_PATH)), release.readySha256);
    assert(!stopping, 'stopped during preflight');
    const now = Date.now();
    window = new RunWindow({ runId: request.runId, profile, blocks: request.blocks, balance: check.balance, now });
    exclusiveJson(permitPath, window.permit);
    markerContent = JSON.stringify({ runId: request.runId, permitPath });
    writeFileSync(MARKER, markerContent, { flag: 'wx', mode: 0o600 });
    record('run-contract', { schemaVersion: 1, runId: request.runId, broadcast: true, signing: true,
      userInitiated: true, blockLimit: request.blocks, maxWallMs: WALL_MS, wallet: profile.wallet,
      executor: profile.executor, config, baselineBalanceWei: check.balance.toString(),
      minimumBalanceWei: window.permit.minimumBalanceWei, releaseSha256: profile.releaseSha256,
      sourceBundleSha256: release.sourceBundleSha256, readySha256: release.readySha256,
      counting: 'source heights beginning after first state-ready single-transition pass; gaps count',
      createdAt: new Date(now).toISOString() });
    fd = openSync(join(run, 'live.log'), 'wx', 0o600);
    const env = { PATH: '/usr/local/bin:/usr/bin:/bin', ...config, MAINNET_RPC_URL: check.endpoint,
      OWNER_PRIVATE_KEY: secret, SEARCHER_RUNTIME_COMMIT: release.head };
    child = spawn(profile.node, ['--max-old-space-size=2048', '--import', 'tsx', 'src/searcher/main.ts'],
      { cwd: join(profile.release, 'runtime/listener'), env, stdio: ['ignore', 'pipe', 'pipe'] });
    record('process', { pid: child.pid, unit: UNIT, startedAt: new Date().toISOString() });
    const redact = line => line.replaceAll(secret, '[KEY_REDACTED]').replaceAll(check.endpoint, '[RPC_REDACTED]')
      .replace(/https?:\/\/[^\s"<>]+/g, '[URL_REDACTED]');
    for (const input of [child.stdout, child.stderr]) {
      createInterface({ input }).on('line', line => {
        try {
          writeFileSync(fd, redact(line) + '\n');
          if (stopping) return;
          const observed = window.observe(line, release.readyGeneration);
          if (observed?.activated) { writeAtomic(permitPath, window.permit); record('window', observed); }
          if (observed?.completed) stop('completed_source_window');
        } catch { stop('observer_failed'); }
      });
    }
    // Sequential renewal: a hung/failed read expires the permit without a background request backlog.
    const renew = async () => {
      try {
        if (stopping) return;
        assert.equal(readFileSync(MARKER, 'utf8'), markerContent);
        assert(!existsSync(config.SEARCHER_CREDIT_LIVE_MARKER_PATH));
        const disk = statfsSync(run); assert(disk.bavail * disk.bsize >= 2 * 1024 ** 3);
        const balance = BigInt(await check.provider.send('eth_getBalance', [profile.wallet, 'latest']));
        if (stopping) return;
        writeAtomic(permitPath, window.renew(Date.now(), balance));
        timer = setTimeout(renew, 3000);
      } catch { stop('renewal_safety_failed'); }
    };
    timer = setTimeout(renew, 3000);
    hardTimer = setTimeout(() => stop('wall_limit'), WALL_MS);
    const ended = await new Promise((resolveResult, reject) => {
      child.once('close', (code, signal) => resolveResult({ code, signal })); child.once('error', reject);
    });
    stop(reason ?? 'searcher_exited');
    record('ended', { ...ended, reason, first: window.first, last: window.last, at: new Date().toISOString() });
    if (reason !== 'completed_source_window') process.exitCode = 1;
  } catch {
    stop('supervisor_failed');
    if (!existsSync(join(run, 'ended.json'))) record('ended', { reason, at: new Date().toISOString() });
    process.exitCode = 1;
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await new Promise(done => {
        const timeout = setTimeout(done, 2000);
        child.once('close', () => { clearTimeout(timeout); done(); });
      });
    }
    clearTimeout(timer); clearTimeout(hardTimer); clearTimeout(killTimer);
    check?.provider.destroy();
    if (markerContent && existsSync(MARKER) && readFileSync(MARKER, 'utf8') === markerContent) unlinkSync(MARKER);
    if (fd !== undefined) closeSync(fd);
    process.off('SIGTERM', onSignal); process.off('SIGINT', onSignal);
  }
}

export async function main(args) {
  const options = parseArguments(args);
  if (options.mode === 'stop') {
    const result = spawnSync('/usr/bin/systemctl', ['stop', UNIT], { stdio: 'ignore', timeout: 20000 });
    assert.equal(result.status, 0, 'stop failed'); console.log('Stopped the bounded session; no next run scheduled.'); return;
  }
  if (options.mode === 'status') {
    const result = spawnSync('/usr/bin/systemctl', ['show', UNIT, '-p', 'ActiveState', '-p', 'SubState', '-p', 'MainPID'], { encoding: 'utf8' });
    console.log(result.stdout.trim()); return;
  }
  const profile = json(options.profile), release = verifyRelease(profile, options.mode !== 'broadcast');
  assert.equal(realpathSync(process.argv[1]), join(profile.release, 'bounded-live-launcher.mjs'), 'entry point differs from configured release');
  if (options.mode === 'supervise') return supervise(options, profile, release);
  assertNoSearcher(); assert(!existsSync(MARKER), 'existing live marker');
  if (options.mode === 'broadcast') return start(options, profile, release);
  assert.equal(profile.runs, MANUAL_RUNS);
  const cleanup = cleanupOldRunLogs(profile.runs);
  const check = await inspector(profile);
  try { console.log(JSON.stringify({ checkOnly: true, signing: false, broadcast: false, head: check.head,
    blocks: options.blocks, walletBalanceWei: check.balance.toString(), release: profile.release,
    bribeBps: 9900, bribeGasBasis: 'measured-gas', gasLimitBufferBps: 3000,
    readyGeneration: release.readyGeneration, readyReused: true, automaticRestart: false,
    oldRunCleanup: { mode: 'preview', eligibleFiles: cleanup.files.length,
      eligibleAllocatedBytes: cleanup.eligibleAllocatedBytes, skipped: cleanup.skipped } })); }
  finally { check.provider.destroy(); }
}

if (process.argv[1] && pathToFileURL(realpathSync(resolve(process.argv[1]))).href === import.meta.url) {
  main(process.argv.slice(2)).catch(() => { console.error('Bounded launcher check failed; no credential details printed.'); process.exitCode = 1; });
}
