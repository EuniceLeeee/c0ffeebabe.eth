// Independent review regressions. Every process, credential, filesystem mutation and RPC is mocked.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { RunWindow, makeRunConfig, sha, shaFile, classifyStopReason, failureEvidence,
  retryableBalanceFailure, RENEW_RPC_DEADLINE_MS, RENEW_RETRY_MS, RENEW_INTERVAL_MS } from './bounded-live-launcher.mjs';

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
  const events = [], timers = new Map(); let timerId = 0, spawnCount = 0, closeScheduled = false, oom = false;
  let now = 100000, resolveRpc, rejectRpc, rpcCalls = 0;
  const deadlines = [], renewals = [];
  const deferred = ['slow-renewal', 'renewal-timeout', 'expired-renewal', 'expired-rejection', 'delayed-expiry-callback'].includes(scenario);
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
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
    provider: { destroy() { events.push('provider-destroy'); } } };
  // Only the balance reader is mocked: everything that decides retry vs stop
  // (retryableBalanceFailure, failureEvidence, the deadlines) is the real code.
  const readWalletBalance = async (endpoint, wallet, timeoutMs) => {
    rpcCalls++; deadlines.push(timeoutMs);
    if (deferred) return await new Promise((resolve, reject) => {
      resolveRpc = value => resolve(BigInt(value));
      rejectRpc = reject;
    });
    if (scenario === 'renewal-failure') {
      throw Object.assign(new Error('mock RPC failure'), { code: 'TIMEOUT' });
    }
    if (scenario === 'renewal-permanent') {
      throw Object.assign(new Error('mock unauthorized'), { code: 'HTTP_401', httpStatus: 401 });
    }
    return 2_000_000_000_000_000n;
  };
  const deps = { dirname, join, assert, sha, shaFile: file => sha(files.get(file)), RunWindow, makeRunConfig,
    prepareRunReady: async () => {
      events.push('ready-activation');
      assert(!files.has(marker)&&!files.has(join(run,'permit.json')));
      if(scenario==='activation-failure')throw new Error('mock activation failure');
      return {readySha256:release.readySha256,generation:release.readyGeneration+1,cacheHit:false};
    },
    Date: Clock,
    classifyStopReason, failureEvidence, readMemoryState: () => ({ events: { oom_kill: oom ? 1 : 0 } }),
    readWalletBalance, retryableBalanceFailure,
    RENEW_RPC_DEADLINE_MS, RENEW_RETRY_MS, RENEW_INTERVAL_MS,
    recordRenewal: (target, value) => renewals.push(value),
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
    spawn(command, args) { spawnCount++; assert.equal(command, profile.node); assert(args.includes('--max-old-space-size=11264')); return child; }, createInterface() { return new EventEmitter(); },
    statfsSync() { return { bavail: 10, bsize: 1024 ** 3 }; },
    setTimeout(fn, ms) { const id = ++timerId; timers.set(id, { fn: () => { timers.delete(id); return fn(); }, ms }); return id; },
    clearTimeout(id) { timers.delete(id); },
  };
  const pending = bind(superviseSource, deps)(options, profile, release);
  await flush();
  if(scenario==='activation-failure'){
    await pending;assert.equal(spawnCount,0);assert(!files.has(marker));assert(!files.has(join(run,'permit.json')));
    assert.equal(files.get(join(run,'ended.json')).reason,'supervisor_failed');return;
  }
  let expectedReason = 'supervisor_failed';
  if (deferred) {
    const expiry = [...timers.values()].find(t => t.ms === 30000); assert(expiry);
    const renew = [...timers.values()].find(t => t.ms === 3000); assert(renew);
    now += 3000;
    const renewing = renew.fn(); await flush(); assert.equal(rpcCalls, 1);
    if (scenario === 'slow-renewal') {
      now += 15000; resolveRpc('2000000000000000'); await renewing;
      assert.equal(events.filter(e => e.startsWith('signal:')).length, 0);
      assert.equal(files.get(join(run, 'permit.json')).validUntilMs, now + 30000);
      assert(![...timers.values()].includes(expiry), 'old expiry timer must be cancelled');
      expectedReason = 'supervisor_signal'; proc.emit('SIGTERM', 'SIGTERM');
    } else if (scenario === 'renewal-timeout') {
      // A rejected balance read is a throughput signal, not a safety failure:
      // the supervisor records it and retries inside the permit. The permit
      // expiry timer remains the only fail-closed stop for a starved renewal.
      now += 20000; rejectRpc(Object.assign(new Error('mock timeout'), { code: 'TIMEOUT' })); await renewing;
      assert(!files.has(join(run, 'stop-reason.json')), 'one rejected read must not stop the run');
      const retry = [...timers.values()].find(t => t.ms === 1000); assert(retry);
      now = 230000;
      await assert.doesNotReject(retry.fn(), 'the retry must fail closed on expiry, not reject');
      expectedReason = 'permit_expired';
      assert.equal(files.get(join(run, 'stop-reason.json')).details.phase, 'permit_expiry');
    } else {
      now = 130000;
      if (scenario !== 'delayed-expiry-callback') expiry.fn();
      if (scenario === 'expired-rejection') rejectRpc(Object.assign(new Error('late rejection'), { code: 'TIMEOUT' }));
      else resolveRpc('2000000000000000');
      await renewing;
      expectedReason = 'permit_expired';
      assert.equal(files.get(join(run, 'stop-reason.json')).details.phase, 'permit_expiry');
      assert.equal(files.get(join(run, 'permit.json')).validUntilMs, 0, 'late RPC cannot revive an expired run');
    }
    assert.equal(rpcCalls, 1, 'no automatic retry or new session');
    const kill = [...timers.values()].find(t => t.ms === 60000); assert(kill); kill.fn();
  } else if (scenario.startsWith('revoke-')) {
    expectedReason = 'renewal_safety_failed';
    const renew = [...timers.values()].find(t => t.ms === 3000); assert(renew);
    await assert.doesNotReject(renew.fn(), 'timer renewal must never reject while stopping');
  } else if (scenario === 'renewal-failure') {
    // A refused balance read is retried inside the permit; only expiry stops.
    expectedReason = 'permit_expired';
    const renew = [...timers.values()].find(t => t.ms === 3000); assert(renew);
    await assert.doesNotReject(renew.fn(), 'timer renewal must never reject while retrying');
    assert(!files.has(join(run, 'stop-reason.json')), 'one RPC refusal must not stop the run');
    const retry = [...timers.values()].find(t => t.ms === 1000); assert(retry);
    now = 130000;
    await assert.doesNotReject(retry.fn(), 'the retry must fail closed on expiry, not reject');
    assert.equal(files.get(join(run, 'stop-reason.json')).details.phase, 'permit_expiry');
    const kill = [...timers.values()].find(t => t.ms === 60000); assert(kill); kill.fn();
  } else if (scenario === 'renewal-permanent') {
    // A permanent answer (bad credentials, malformed balance) stays fail-closed:
    // it must not be retried as if it were throughput pressure.
    expectedReason = 'renewal_safety_failed';
    const renew = [...timers.values()].find(t => t.ms === 3000); assert(renew);
    await assert.doesNotReject(renew.fn());
    assert(![...timers.values()].some(t => t.ms === 1000), 'a permanent failure must not schedule a retry');
    assert.equal(files.get(join(run, 'stop-reason.json')).details.code, 'HTTP_401');
    const kill = [...timers.values()].find(t => t.ms === 60000); assert(kill); kill.fn();
  } else if (scenario === 'oom-signal') {
    expectedReason = 'memory_oom_kill'; oom = true; proc.emit('SIGTERM', 'SIGTERM');
    const kill = [...timers.values()].find(t => t.ms === 60000); assert(kill); kill.fn();
  } else if (scenario === 'child-error') child.emit('error', new Error('mock spawn error'));
  await pending;
  assert.equal(spawnCount, 1); assert(child.closed); assert.equal(proc.exitCode, 1);
  assert(events.includes('signal:SIGKILL'));
  assert(events.indexOf('child-close') < events.findIndex(e => e.startsWith('unlink:' + marker)));
  assert.equal(files.has(marker), false); assert.equal(timers.size, 0);
  assert.equal(files.get(join(run, 'ended.json')).reason, expectedReason);
  if (scenario === 'renewal-failure' || scenario === 'renewal-timeout') {
    // The renewed-attempt failure never becomes the stop reason; expiry does.
    assert.equal(files.get(join(run, 'ended.json')).details.phase, 'permit_expiry');
  }
  assert(deadlines.every(ms => ms === 8000), 'every balance read must carry the 8 second deadline');
  if (['renewal-failure', 'renewal-timeout', 'renewal-permanent', 'slow-renewal',
    'expired-renewal', 'delayed-expiry-callback'].includes(scenario)) {
    assert(renewals.some(r => r.phase === 'wallet_balance_rpc'), 'a balance read outcome must be recorded');
  }
  if (['renewal-failure', 'renewal-timeout', 'renewal-permanent'].includes(scenario)) {
    const failed = renewals.find(r => r.ok === false);
    assert(failed, 'a failed balance read must be recorded');
    assert.equal(failed.deadlineMs, 8000);
    assert.equal(failed.retryable, scenario !== 'renewal-permanent');
  }
  if (scenario === 'oom-signal') {
    const evidence = files.get(join(run, 'stop-reason.json'));
    assert.equal(evidence.requestedReason, 'supervisor_signal');
    assert.equal(evidence.memory.events.oom_kill, 1);
  }
  assert.equal(files.has(credential), true, 'systemd owns its credential; supervisor must not unlink it');
  if (!scenario.startsWith('revoke-')) assert.equal(files.get(join(run, 'permit.json')).status, 'stopped');
  if (scenario === 'revoke-write-failure') assert.equal(files.has(join(run, 'permit.json')), false);
  if (scenario.startsWith('revoke-')) assert.equal(events.find(e => e.startsWith('signal:')), 'signal:SIGKILL');
}
for (const scenario of ['activation-failure', 'record-failure', 'renewal-failure', 'renewal-permanent', 'revoke-write-failure', 'revoke-and-unlink-failure', 'child-error', 'oom-signal',
  'slow-renewal', 'renewal-timeout', 'expired-renewal', 'expired-rejection', 'delayed-expiry-callback']) {
  test('supervisor cleanup: ' + scenario, { timeout: 1000 }, () => lifecycle(scenario));
}

test('real timer callback does not leak rejection when both revoke writes and unlink fail', async () => {
  const stopSource = between('  const stop = why => {', '\n  const onSignal').replace(/^const stop = /, '');
  const renewSource = between('    const renew = async () => {', '\n    timer = setTimeout(renew, 3000);').replace(/^const renew = /, '');
  const signals = [], observed = [];
  const deps = { assert, permitPath: '/mock/permit', MARKER: '/mock/marker', markerContent: 'owned',
    checkPermitExpiry: () => false, armPermitExpiry() {},
    readMemoryState: () => ({}), classifyStopReason, failureEvidence, memoryBaseline: {}, stopDetails: null,
    record() {},
    config: { SEARCHER_CREDIT_LIVE_MARKER_PATH: '/mock/credit' }, run: '/mock/run',
    readFileSync: () => 'owned', existsSync: () => false, statfsSync: () => ({ bavail: 10, bsize: 1024 ** 3 }),
    window: { renew: () => ({ status: 'active' }), stop: () => ({ status: 'stopped' }) },
    writeAtomic() { throw new Error('mock ENOSPC'); }, unlinkSync() { throw new Error('mock EACCES'); },
    child: { kill: signal => signals.push(signal) }, check: { endpoint: 'mock-no-network' },
    readWalletBalance: async () => 2_000_000_000_000_000n, retryableBalanceFailure,
    RENEW_RPC_DEADLINE_MS, RENEW_RETRY_MS, RENEW_INTERVAL_MS, recordRenewal() {},
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

for (const outcome of ['success', 'nonzero', 'throws', 'active-service', 'cleanup-failure', 'low-disk', 'no-confirmation']) {
  test('systemd credential input cleanup: ' + outcome, async () => {
    const profile = { wallet: '0x' + '1'.repeat(40), executor: '0x' + '2'.repeat(40),
      release: '/mock/release', releaseSha256: 'manifest-sha', ready: '/mock/ready', runs: '/mock/runs', node: '/mock/node' };
    const options = { profile: '/mock/profile.json', blocks: 3 }, release = { config: base, readySha256: sha('ready') };
    const files = new Map([[options.profile, 'profile'], [profile.ready, 'ready']]);
    let destroyed = 0, invoked = 0, cleaned = 0, diskChecked = 0; const logged = [];
    const deps = { assert, join, sha, shaFile: file => sha(files.get(file)), makeRunConfig, MARKER: '/mock/marker', UNIT: 'mock.service',
      MANUAL_RUNS: profile.runs,
      process: { getuid: () => 0 }, assertNoSearcher() {}, existsSync: file => files.has(file),
      inspector: async () => ({ provider: { destroy() { destroyed++; } },
        ethers: { Wallet: class { constructor() { this.address = profile.wallet; } } } }),
      receiveKey: async () => { if (outcome === 'no-confirmation') throw new Error('not confirmed'); return 'mock-not-a-key'; },
      randomUUID: () => '00000000-0000-0000-0000-000000000000',
      statfsSync: () => ({ bavail: ['low-disk', 'cleanup-failure'].includes(outcome) ? 3 : 80, bsize: 1024 ** 3 }),
      cleanupOldRunLogs(root, current, options) {
        cleaned++; assert.equal(root, profile.runs); assert(current.startsWith(root + '/live-'));
        assert.deepEqual(options, { apply: ['low-disk', 'cleanup-failure'].includes(outcome) }); assert.equal(invoked, 0);
        assert(![...files.keys()].some(path => path.endsWith('.credential.json')));
        if (outcome === 'cleanup-failure') throw new Error('mock cleanup failure');
        return { deletedFiles: 6, deletedBytes: 123, deletedAllocatedBytes: 4096, audit: current + '/old-runs-cleanup.jsonl' };
      },
      assertStartDisk(root) {
        diskChecked++; assert.equal(root, profile.runs); assert.equal(cleaned, 1); assert.equal(invoked, 0);
        if (outcome === 'low-disk') throw new Error('mock low disk');
      },
      mkdirSync() {}, constants: { COPYFILE_EXCL: 1 },
      exclusiveJson(file, value) { assert(!files.has(file)); files.set(file, structuredClone(value)); },
      copyFileSync(from, to) { assert(!files.has(to)); files.set(to, files.get(from)); },
      readFileSync: file => files.get(file), unlinkSync: file => files.delete(file),
      console: { log: value => logged.push(value) },
      spawnSync(command, args) {
        if (command === '/usr/bin/systemctl') return { status: 0,
          stdout: outcome === 'active-service' ? 'MainPID=123\nActiveState=active\n' : 'MainPID=0\nActiveState=inactive\n' };
        invoked++; assert.equal(command, '/usr/bin/systemd-run');
        assert.equal(cleaned, 1); assert.equal(diskChecked, 1);
        assert(args.includes('--property=Type=exec')); assert(args.includes('--property=Restart=no'));
        assert(args.includes('--property=MemoryMax=13G')); assert(args.includes('--property=MemorySwapMax=0'));
        assert(args.includes('--property=OOMScoreAdjust=-900'));
        const credentialArg = args.find(arg => arg.startsWith('--property=LoadCredential=owner:')); assert(credentialArg);
        assert(files.has(credentialArg.slice('--property=LoadCredential=owner:'.length)));
        assert(!args.some(arg => arg.includes('mock-not-a-key')));
        if (outcome === 'throws') throw new Error('mock systemd failure');
        return { status: outcome === 'success' ? 0 : 1 };
      },
    };
    const pending = bind(startSource, deps)(options, profile, release);
    if (outcome === 'success') await pending; else await assert.rejects(pending);
    assert.equal(invoked, ['success', 'nonzero', 'throws'].includes(outcome) ? 1 : 0); assert.equal(destroyed, 1);
    assert.equal(cleaned, ['active-service', 'no-confirmation'].includes(outcome) ? 0 : 1);
    assert.equal([...files.keys()].filter(file => file.endsWith('.credential.json')).length, 0);
    assert(!JSON.stringify([...files.values()]).includes('mock-not-a-key'));
    assert(!logged.join('').includes('mock-not-a-key'));
  });
}

test('read-only modes cannot apply cleanup; disk guard moves only for explicit broadcast', () => {
  const main = source.slice(source.indexOf('export async function main('));
  assert(main.indexOf("options.mode === 'status'") < main.indexOf('verifyRelease('));
  assert(main.includes("verifyRelease(profile, options.mode !== 'broadcast')"));
  assert(main.includes("if (options.mode === 'broadcast') return start(options, profile, release);"));
  assert(main.includes('cleanupOldRunLogs(profile.runs);'));
  assert(!main.includes('apply: true'));
  assert(startSource.includes("assert.equal(profile.runs, MANUAL_RUNS"));
});
