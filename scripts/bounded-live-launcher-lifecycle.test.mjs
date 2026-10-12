// Independent review regressions. Every process, credential, filesystem mutation and RPC is mocked.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { RunWindow, makeRunConfig, sha } from './bounded-live-launcher.mjs';

const source = readFileSync(new URL('./bounded-live-launcher.mjs', import.meta.url), 'utf8');
function between(start, end) {
  const a = source.indexOf(start), b = source.indexOf(end, a);
  assert(a >= 0 && b > a, 'review extraction boundary changed');
  return source.slice(a, b).trim();
}
const superviseSource = between('async function supervise(', '\nexport async function main(');
const startSource = between('async function start(', '\nasync function supervise(');
const base = {
  SEARCHER_BLOCKSCAN_EFFECTIVE_WETH_INPUT: '0.02', SEARCHER_BLOCKSCAN_MAX_CANDIDATES: '10',
  SEARCHER_BLOCKSCAN_REFINE_CANDIDATES: '512', SEARCHER_BLOCKSCAN_SINGLE_FUNDING_ENABLED: '1',
  SEARCHER_BLOCKSCAN_POOL_REVERT_FILTER: '1',
};
const bind = (body, deps) => new Function(...Object.keys(deps), `return (${body});`)(...Object.values(deps));
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

async function lifecycle(scenario) {
  const run = '/mock/runs/session', marker = '/mock/live-marker', unit = 'mock.service';
  const profile = { wallet: '0x' + '1'.repeat(40), executor: '0x' + '2'.repeat(40),
    release: '/mock/release', releaseSha256: 'manifest-sha', runs: '/mock/runs', node: '/mock/node' };
  const options = { run, profile: '/mock/profile.json' };
  const release = { config: base, readySha256: sha('ready'), head: 'fixture-head',
    sourceBundleSha256: 'fixture-source', readyGeneration: 6 };
  const config = makeRunConfig(base, profile, run);
  const request = { runId: 'session', profileSha256: sha('profile'), releaseSha256: profile.releaseSha256,
    credentialName: 'owner', userInitiated: true, blocks: 3 };
  const credential = '/run/credentials/' + unit + '/owner';
  const files = new Map([[options.profile, 'profile'], [join(run, 'request.json'), request],
    [join(run, 'config.json'), config], [credential, { OWNER_PRIVATE_KEY: 'mock-not-a-key' }],
    [config.SEARCHER_UNIVERSE_REBUILD_CHECKPOINT_PATH, 'ready']]);
  const events = [], timers = new Map(); let timerId = 0, spawnCount = 0, closeScheduled = false;
  const proc = new EventEmitter(); proc.exitCode = 0;
  proc.env = { CREDENTIALS_DIRECTORY: '/run/credentials/' + unit };
  const child = new EventEmitter();
  Object.assign(child, { pid: 123, exitCode: null, signalCode: null, stdout: {}, stderr: {}, closed: false });
  child.kill = signal => {
    events.push('signal:' + signal);
    if (signal === 'SIGKILL' && !closeScheduled) {
      closeScheduled = true;
      queueMicrotask(() => { child.signalCode = signal; child.closed = true;
        events.push('child-close'); child.emit('close', null, signal); });
    }
    return true;
  };
  const check = { balance: 2_000_000_000_000_000n, endpoint: 'mock-no-network',
    ethers: { Wallet: class { constructor() { this.address = profile.wallet; } } },
    provider: { destroy() { events.push('provider-destroy'); }, async send() {
      if (scenario === 'renewal-failure') throw new Error('mock RPC failure');
      return '2000000000000000';
    } } };
  const deps = { dirname, join, assert, sha, RunWindow, makeRunConfig,
    UNIT: unit, MARKER: marker, WALL_MS: 43_200_000, process: proc,
    json: file => { assert(files.has(file)); return structuredClone(files.get(file)); },
    realpathSync: file => file, readFileSync: file => { assert(files.has(file)); return files.get(file); },
    existsSync: file => files.has(file), assertNoSearcher() {}, privateRegular() {}, inspector: async () => check,
    exclusiveJson(file, value) {
      if (scenario === 'record-failure' && file === join(run, 'process.json')) throw new Error('mock record failure');
      assert(!files.has(file)); files.set(file, structuredClone(value));
    },
    writeAtomic(file, value) {
      if (scenario.startsWith('revoke-')) throw new Error('mock ENOSPC');
      files.set(file, structuredClone(value)); events.push('permit:' + value.status);
    },
    writeFileSync(file, value, flags) {
      if (typeof file === 'number') return;
      if (flags?.flag === 'wx') assert(!files.has(file));
      files.set(file, value);
    },
    openSync() { return 7; }, closeSync() { events.push('fd-close'); },
    unlinkSync(file) {
      if (scenario === 'revoke-and-unlink-failure' && file === join(run, 'permit.json')) throw new Error('mock unlink failure');
      events.push('unlink:' + file + ':closed=' + child.closed); files.delete(file);
    },
    spawn() { spawnCount++; return child; }, createInterface() { return new EventEmitter(); },
    statfsSync() { return { bavail: 10, bsize: 1024 ** 3 }; },
    setTimeout(fn, ms) { const id = ++timerId; timers.set(id, { fn, ms }); return id; },
    clearTimeout(id) { timers.delete(id); },
  };
  const pending = bind(superviseSource, deps)(options, profile, release);
  await flush();
  let expectedReason = 'supervisor_failed';
  if (scenario === 'renewal-failure' || scenario.startsWith('revoke-')) {
    expectedReason = 'renewal_safety_failed';
    const renew = [...timers.values()].find(t => t.ms === 3000); assert(renew);
    await assert.doesNotReject(renew.fn(), 'timer renewal must never reject while stopping');
    if (scenario === 'renewal-failure') {
      const kill = [...timers.values()].find(t => t.ms === 5000); assert(kill); kill.fn();
    }
  } else if (scenario === 'child-error') child.emit('error', new Error('mock spawn error'));
  await pending;
  assert.equal(spawnCount, 1); assert(child.closed); assert.equal(proc.exitCode, 1);
  assert(events.includes('signal:SIGKILL'));
  assert(events.indexOf('child-close') < events.findIndex(e => e.startsWith('unlink:' + marker)));
  assert.equal(files.has(marker), false); assert.equal(timers.size, 0);
  assert.equal(files.get(join(run, 'ended.json')).reason, expectedReason);
  assert.equal(files.has(credential), true, 'systemd owns its credential; supervisor must not unlink it');
  if (!scenario.startsWith('revoke-')) assert.equal(files.get(join(run, 'permit.json')).status, 'stopped');
  if (scenario === 'revoke-write-failure') assert.equal(files.has(join(run, 'permit.json')), false);
  if (scenario.startsWith('revoke-')) assert.equal(events.find(e => e.startsWith('signal:')), 'signal:SIGKILL');
}
for (const scenario of ['record-failure', 'renewal-failure', 'revoke-write-failure', 'revoke-and-unlink-failure', 'child-error']) {
  test('supervisor cleanup: ' + scenario, { timeout: 1000 }, () => lifecycle(scenario));
}

test('real timer callback does not leak rejection when both revoke writes and unlink fail', async () => {
  const stopSource = between('  const stop = why => {', '\n  const onSignal').replace(/^const stop = /, '');
  const renewSource = between('    const renew = async () => {', '\n    timer = setTimeout(renew, 3000);').replace(/^const renew = /, '');
  const signals = [], observed = [];
  const deps = { assert, permitPath: '/mock/permit', MARKER: '/mock/marker', markerContent: 'owned',
    config: { SEARCHER_CREDIT_LIVE_MARKER_PATH: '/mock/credit' }, run: '/mock/run',
    readFileSync: () => 'owned', existsSync: () => false, statfsSync: () => ({ bavail: 10, bsize: 1024 ** 3 }),
    window: { renew: () => ({ status: 'active' }), stop: () => ({ status: 'stopped' }) },
    writeAtomic() { throw new Error('mock ENOSPC'); }, unlinkSync() { throw new Error('mock EACCES'); },
    child: { kill: signal => signals.push(signal) }, check: { provider: { send: async () => '2000000000000000' } },
    setTimeout() { return 1; } };
  const harness = new Function(...Object.keys(deps), `let stopping=false,reason=null,timer,killTimer;
    const stop=${stopSource}\nconst renew=${renewSource}\nreturn {renew};`)(...Object.values(deps));
  const onUnhandled = error => observed.push(error);
  process.on('unhandledRejection', onUnhandled);
  try {
    setTimeout(harness.renew, 0); // Deliberately do not await/catch the returned promise: this matches production.
    await new Promise(done => setTimeout(done, 25));
    assert.deepEqual(observed, []); assert.deepEqual(signals, ['SIGKILL']);
  } finally { process.off('unhandledRejection', onUnhandled); }
});

for (const outcome of ['success', 'nonzero', 'throws']) {
  test('systemd credential input cleanup: ' + outcome, async () => {
    const profile = { wallet: '0x' + '1'.repeat(40), executor: '0x' + '2'.repeat(40),
      release: '/mock/release', releaseSha256: 'manifest-sha', ready: '/mock/ready', runs: '/mock/runs', node: '/mock/node' };
    const options = { profile: '/mock/profile.json', blocks: 3 }, release = { config: base, readySha256: sha('ready') };
    const files = new Map([[options.profile, 'profile'], [profile.ready, 'ready']]);
    let destroyed = 0, invoked = 0; const logged = [];
    const deps = { assert, join, sha, makeRunConfig, MARKER: '/mock/marker', UNIT: 'mock.service',
      process: { getuid: () => 0 }, assertNoSearcher() {}, existsSync: file => files.has(file),
      inspector: async () => ({ provider: { destroy() { destroyed++; } },
        ethers: { Wallet: class { constructor() { this.address = profile.wallet; } } } }),
      receiveKey: async () => 'mock-not-a-key', randomUUID: () => '00000000-0000-0000-0000-000000000000',
      mkdirSync() {}, constants: { COPYFILE_EXCL: 1 },
      exclusiveJson(file, value) { assert(!files.has(file)); files.set(file, structuredClone(value)); },
      copyFileSync(from, to) { assert(!files.has(to)); files.set(to, files.get(from)); },
      readFileSync: file => files.get(file), unlinkSync: file => files.delete(file),
      console: { log: value => logged.push(value) },
      spawnSync(command, args) {
        invoked++; assert.equal(command, '/usr/bin/systemd-run');
        assert(args.includes('--property=Type=exec')); assert(args.includes('--property=Restart=no'));
        const credentialArg = args.find(arg => arg.startsWith('--property=LoadCredential=owner:')); assert(credentialArg);
        assert(files.has(credentialArg.slice('--property=LoadCredential=owner:'.length)));
        assert(!args.some(arg => arg.includes('mock-not-a-key')));
        if (outcome === 'throws') throw new Error('mock systemd failure');
        return { status: outcome === 'success' ? 0 : 1 };
      },
    };
    const pending = bind(startSource, deps)(options, profile, release);
    if (outcome === 'success') await pending; else await assert.rejects(pending);
    assert.equal(invoked, 1); assert.equal(destroyed, 1);
    assert.equal([...files.keys()].filter(file => file.endsWith('.credential.json')).length, 0);
    assert(!JSON.stringify([...files.values()]).includes('mock-not-a-key'));
    assert(!logged.join('').includes('mock-not-a-key'));
  });
}
