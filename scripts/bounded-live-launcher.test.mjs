import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { closeSync, ftruncateSync, mkdtempSync, openSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { RunWindow, makeRunConfig, parseArguments, shaFile, classifyStopReason, failureEvidence,
  readWalletBalance } from './bounded-live-launcher.mjs';
import { parseClientArgs } from './cloud-live.mjs';
import { captureBoundedLiveSession } from '../listener/src/shared/bounded-live-session.ts';

const profile = { wallet: '0x' + '1'.repeat(40), executor: '0x' + '2'.repeat(40), release: '/release' };
const baseConfig = {
  SEARCHER_BLOCKSCAN_EFFECTIVE_WETH_INPUT: '0.02', SEARCHER_BLOCKSCAN_MAX_CANDIDATES: '10',
  SEARCHER_BLOCKSCAN_REFINE_CANDIDATES: '512', SEARCHER_BLOCKSCAN_SINGLE_FUNDING_ENABLED: '1',
  SEARCHER_BLOCKSCAN_POOL_REVERT_FILTER: '1',
};
const baseline = 2500000000000000n;
test('live release uses both shared revert filters, no repeated pools, and protocol-only token reentry', () => {
  const config = makeRunConfig({ ...baseConfig, SEARCHER_BLOCKSCAN_ALLOW_REPEATED_POOLS_ENABLED: '1',
    SEARCHER_BLOCKSCAN_STARTUP_REVERT_FILTER: '0' }, profile, '/runs/test', '1');
  assert.equal(config.SEARCHER_BLOCKSCAN_ALLOW_REPEATED_POOLS_ENABLED, '0');
  assert.equal(config.SEARCHER_BLOCKSCAN_ALLOW_REPEATED_TOKENS_ENABLED, '0');
  assert.equal(config.SEARCHER_BLOCKSCAN_ALLOW_PROTOCOL_REPEATS_ENABLED, '1');
  assert.equal(config.SEARCHER_BLOCKSCAN_STARTUP_REVERT_FILTER, '1');
  assert.equal(config.SEARCHER_BLOCKSCAN_POOL_REVERT_FILTER, '1');
});
const fresh = (id = 'run-1', blocks = 2500) => new RunWindow({ runId: id, profile, blocks, balance: baseline, now: 100000 });
function activate(window, source = 100) {
  window.observe('[searcher/live] mode=live-submit', 6);
  window.observe('[searcher/live] strict ready catalog loaded: generation=6 valid', 6);
  window.observe('[searcher/blockscan-activity-range] ' + JSON.stringify({ sourceBlock: source, transitions: 1 }), 6);
  return window.observe(JSON.stringify({ type: 'block_scan_timing', source_block: source, stages: { state: { status: 'ran' } } }), 6);
}

test('stop attribution requires new kernel OOM evidence and never exposes raw RPC error text', () => {
  const baseline = { events: { oom_kill: 3 } };
  assert.equal(classifyStopReason('supervisor_signal', baseline, { events: { oom_kill: 4 } }), 'memory_oom_kill');
  assert.equal(classifyStopReason('supervisor_signal', baseline, baseline), 'supervisor_signal');
  assert.equal(classifyStopReason('searcher_signal', {}, { events: { oom_kill: 4 } }), 'searcher_signal');
  const evidence = failureEvidence(Object.assign(new Error('secret RPC URL and payload'),
    { code: 'SERVER_ERROR', status: 429 }), 'wallet_balance_rpc');
  assert.deepEqual(evidence, { phase: 'wallet_balance_rpc', name: 'Error', code: 'SERVER_ERROR', httpStatus: 429 });
  assert(!JSON.stringify(evidence).includes('secret'));
});

test('safety RPC may wait 20 seconds inside a 30-second permit', () => {
  const source = readFileSync(new URL('./bounded-live-launcher.mjs', import.meta.url), 'utf8');
  assert.match(source, /req\.timeout = 20000;/);
  const window = fresh();
  assert.equal(window.permit.validUntilMs - window.permit.startedAtMs, 30000);
  assert.equal(window.renew(120000, baseline).validUntilMs, 150000);
  assert.throws(() => window.renew(150000, baseline), /permit expired/);
});

test('default is read-only; explicit bounded block count only', () => {
  assert.equal(parseArguments([]).mode, 'check'); assert.equal(parseClientArgs([]).mode, 'check');
  for (const parse of [parseArguments, parseClientArgs]) {
    assert.equal(parse(['--broadcast']).blocks, 2500);
    assert.equal(parse(['--broadcast', '--blocks', '250']).blocks, 250);
    assert.equal(parse(['--broadcast', '--blocks', '500']).blocks, 500);
    for (const n of ['0', '-1', '2501', '1.5', '1e3', '2500junk']) assert.throws(() => parse(['--blocks', n]));
    assert.throws(() => parse(['--check', '--broadcast']));
    assert.throws(() => parse(['--broadcast', '--broadcast']));
    assert.throws(() => parse(['--whatever']));
  }
});
test('continuation is explicit, persisted in config, and cannot alter trading guards', () => {
  for (const parse of [parseArguments, parseClientArgs]) {
    assert.equal(parse(['--broadcast', '--blocks', '1250', '--resume-prices', '1']).resumePrices, '1');
    assert.equal(parse(['--resume-prices', '0', '--check']).resumePrices, '0');
    for (const value of ['2', 'true', '']) assert.throws(() => parse(['--resume-prices', value]));
    assert.throws(() => parse(['--resume-prices', '1', '--resume-prices', '0']));
    assert.throws(() => parse(['--stop', '--resume-prices', '1']));
  }
  const run = '/opt/mev-cloud/manual-live/runs/live-fixture';
  const off = makeRunConfig(baseConfig, profile, run, '0');
  const on = makeRunConfig(baseConfig, profile, run, '1');
  assert.equal(on.SEARCHER_BLOCKSCAN_LIVE_CONTINUATION_DIR, '/opt/mev-cloud/manual-live/price-continuation');
  assert.deepEqual({ ...on, SEARCHER_BLOCKSCAN_LIVE_CONTINUATION_ENABLED: '0' }, off);
  assert.equal(makeRunConfig(baseConfig, profile, run).SEARCHER_BLOCKSCAN_LIVE_CONTINUATION_ENABLED, '0');
});
test('fresh 2500 source heights begin AFTER state-ready observation', () => {
  const window = fresh();
  assert.equal(window.permit.status, 'pending');
  assert.deepEqual(activate(window), { activated: true, from: 101, to: 2600, count: 2500 });
  assert.equal(window.permit.firstTargetBlock, 102); assert.equal(window.permit.lastTargetBlock, 2601);
  assert.equal(window.permit.lastTargetBlock - window.permit.firstTargetBlock + 1, 2500);
  const timing = n => JSON.stringify({ type: 'block_scan_timing', source_block: n });
  assert.equal(window.observe(timing(2599), 6), null);
  assert.deepEqual(window.observe(timing(2600), 6), { completed: true });
});
test('positive-gross-profit is explicit per run, keeps 99%, and binds the permit', () => {
  for (const parse of [parseArguments, parseClientArgs]) {
    assert.equal(parse([]).profitMode, undefined);
    assert.equal(parse(['--check', '--profit-mode', 'positive-gross-profit']).profitMode, 'positive-gross-profit');
    for (const mode of ['', 'off', 'net-ev', 'gross-profit']) assert.throws(() => parse(['--profit-mode', mode]));
    assert.throws(() => parse(['--stop', '--profit-mode', 'positive-gross-profit']));
    assert.throws(() => parse(['--profit-mode', 'positive-ev', '--profit-mode', 'positive-gross-profit']));
  }
  const inherited = { ...baseConfig, SEARCHER_BLOCKSCAN_PROFIT_MODE: 'positive-gross-profit' };
  assert.equal(makeRunConfig(inherited, profile, '/runs/test').SEARCHER_BLOCKSCAN_PROFIT_MODE, 'positive-ev');
  const config = makeRunConfig(baseConfig, profile, '/runs/test', undefined, 'positive-gross-profit');
  assert.equal(config.SEARCHER_BLOCKSCAN_PROFIT_MODE, 'positive-gross-profit');
  assert.equal(config.SEARCHER_BRIBE_BPS, '9900');
  assert.equal(config.SEARCHER_BRIBE_ALL_ABOVE_GAS, '0');
  assert.equal(config.SEARCHER_EV_GATE, '1');
  assert.equal(config.SEARCHER_PROFIT_HAIRCUT_BPS, '0');
  assert.equal(config.SEARCHER_BRIBE_GAS_BASIS, 'measured-gas');
  const window = new RunWindow({ runId: 'gross-run', profile, blocks: 500, balance: baseline, now: 100000,
    profitMode: config.SEARCHER_BLOCKSCAN_PROFIT_MODE });
  activate(window);
  assert.equal(window.renew(101000, baseline).profitMode, 'positive-gross-profit');
  assert.equal(window.stop().profitMode, 'positive-gross-profit');
});

test('requested 500-source-block run stops at its exact boundary without a restart', () => {
  const window = fresh('run-500', 500);
  assert.deepEqual(activate(window), { activated: true, from: 101, to: 600, count: 500 });
  assert.equal(window.permit.firstTargetBlock, 102); assert.equal(window.permit.lastTargetBlock, 601);
  assert.equal(window.observe('{"type":"block_scan_timing","source_block":599}', 6), null);
  assert.deepEqual(window.observe('{"type":"block_scan_timing","source_block":600}', 6), { completed: true });
  window.stop(); assert.equal(window.permit.status, 'stopped');
});
test('warmup, catchup and failed state preparation do not activate', () => {
  for (const [startup_warm, status, transitions] of [[true, 'ran', 1], [false, 'ran', 2], [false, 'failed', 1]]) {
    const window = fresh();
    window.observe('[searcher/live] mode=live-submit', 6);
    window.observe('[searcher/live] strict ready catalog loaded: generation=6 valid', 6);
    window.observe('[searcher/blockscan-activity-range] {"sourceBlock":100,"transitions":' + transitions + '}', 6);
    assert.equal(window.observe(JSON.stringify({ type: 'block_scan_timing', source_block: 100, startup_warm, stages: { state: { status } } }), 6), null);
    assert.equal(window.permit.status, 'pending');
  }
});
test('second run has independent baseline, permit and counter; no cross-run blacklist path', () => {
  const first = fresh(); activate(first); first.stop();
  const second = fresh('run-2'); assert.equal(second.first, null); assert.equal(second.permit.status, 'pending');
  assert.equal(second.permit.runId, 'run-2');
  const base = baseConfig;
  const a = makeRunConfig(base, profile, '/runs/one'), b = makeRunConfig(base, profile, '/runs/two');
  assert.equal(a.SEARCHER_BLOCKSCAN_STARTUP_CACHE_DIR, b.SEARCHER_BLOCKSCAN_STARTUP_CACHE_DIR);
  assert.equal(a.SEARCHER_BLOCKSCAN_STARTUP_CACHE_NAMESPACE, b.SEARCHER_BLOCKSCAN_STARTUP_CACHE_NAMESPACE);
  assert.notEqual(makeRunConfig(base, { ...profile, release: '/other-release' }, '/runs/two')
    .SEARCHER_BLOCKSCAN_STARTUP_CACHE_NAMESPACE, a.SEARCHER_BLOCKSCAN_STARTUP_CACHE_NAMESPACE);
  assert.equal(a.SEARCHER_LIVE_SESSION_PATH, '/runs/one/permit.json');
  assert.equal(b.SEARCHER_LIVE_SESSION_ID, 'two');
  for (const key of ['SEARCHER_EVENTS_PATH', 'SEARCHER_BLOCKSCAN_ROUTE_EVENTS_PATH', 'SEARCHER_BLOCKSCAN_SOLVER_INPUTS_PATH', 'SEARCHER_SIM_REVERT_DIAGNOSTICS_PATH', 'SEARCHER_UNIVERSE_REBUILD_CHECKPOINT_PATH']) assert.notEqual(a[key], b[key]);
  assert.equal(a.SEARCHER_BLOCKSCAN_MID_HISTORY_PATH, '');
  assert.equal(makeRunConfig({ ...base, SEARCHER_BLOCKSCAN_MID_HISTORY_PATH: '/old/mids.jsonl' }, profile, '/runs/two')
    .SEARCHER_BLOCKSCAN_MID_HISTORY_PATH, '');
  assert.equal(b.SEARCHER_DRY_RUN_BOTVM_CODE_OVERRIDE, '0');
  assert.equal(b.SEARCHER_DRY_RUN_USE_READY_GENERATION, '0');
  assert.equal(b.SEARCHER_USE_READY_GENERATION, '1');
  assert.equal(b.SEARCHER_BRIBE_BPS, '9900');
  assert.equal(b.SEARCHER_BRIBE_ALL_ABOVE_GAS, '0');
  assert.equal(b.SEARCHER_BRIBE_GAS_BASIS, 'measured-gas');
  assert.equal(b.SEARCHER_BLOCKSCAN_MIN_SPREAD_BPS, '10');
  assert.equal(b.SEARCHER_BLOCKSCAN_SOLVER_INPUTS_PATH, '/runs/two/solver-inputs.jsonl');
  assert.equal(b.SEARCHER_BLOCKSCAN_SOLVER_INPUTS_MAX_BYTES, String(10 * 1024 ** 3));
  assert.equal(b.SEARCHER_BLOCKSCAN_EFFECTIVE_WETH_INPUT, '0.02');
  assert.equal(b.SEARCHER_BLOCKSCAN_MAX_CANDIDATES, '10');
  assert.equal(b.SEARCHER_BLOCKSCAN_REFINE_CANDIDATES, '512');
});
test('balance, stop and wall expiry fail closed', () => {
  const window = fresh(); activate(window);
  assert.equal(window.renew(101000, baseline).validUntilMs, 131000);
  assert.throws(() => window.renew(101000, baseline / 2n - 1n));
  assert.throws(() => window.renew(101000, 200000000000000001n));
  assert.throws(() => window.renew(100000 + 43200000, baseline));
  window.stop(); assert.equal(window.permit.status, 'stopped'); assert.equal(window.permit.validUntilMs, 0);
  assert.throws(() => window.renew(102000, baseline));
});
test('one RPC jitter is observed; terminal fifth failure stops', () => {
  const window = fresh();
  for (const action of ['observe', 'recovered']) assert.equal(window.observe('[searcher/rpc-throttle-observation] ' + JSON.stringify({ action, limit: 5 }), 6), null);
  assert.throws(() => window.observe('[searcher/rpc-throttle-observation] {"action":"stop","limit":5}', 6));
  assert.throws(() => window.observe('[searcher/live] strict ready catalog loaded: generation=7 invalid', 6));
  assert.throws(() => window.observe('{"type":"strict_simulation_fatal"}', 6));
});
test('noninteractive real start is refused before credentials/SSH', () => {
  const result = spawnSync(process.execPath, [new URL('./cloud-live.mjs', import.meta.url).pathname, '--broadcast'], { encoding: 'utf8', env: { PATH: '' } });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /did not complete/);
  assert.equal(result.stdout, '');
});
test('actual launcher environment engages guard; pending, out-of-window, victim and revoked calls denied', () => {
  const run = mkdtempSync(join(tmpdir(), 'mev-launcher-guard-'));
  const oldPath = process.env.SEARCHER_LIVE_SESSION_PATH, oldId = process.env.SEARCHER_LIVE_SESSION_ID;
  try {
    const base = baseConfig;
    const config = makeRunConfig(base, profile, run);
    process.env.SEARCHER_LIVE_SESSION_PATH = config.SEARCHER_LIVE_SESSION_PATH;
    process.env.SEARCHER_LIVE_SESSION_ID = config.SEARCHER_LIVE_SESSION_ID;
    const window = new RunWindow({ runId: config.SEARCHER_LIVE_SESSION_ID, profile, blocks: 2500, balance: baseline, now: Date.now() });
    const save = () => writeFileSync(config.SEARCHER_LIVE_SESSION_PATH, JSON.stringify(window.permit), { mode: 0o600 });
    const params = { wallet: profile.wallet, executor: profile.executor, chainId: 1, targetBlock: 102, mode: 'standalone' };
    save(); assert.throws(() => captureBoundedLiveSession(params));
    activate(window); save();
    const guard = captureBoundedLiveSession(params); assert(guard !== null);
    guard.assertActive({ walletBalanceWei: baseline, worstGasCostWei: 1n });
    assert.throws(() => captureBoundedLiveSession({ ...params, targetBlock: 2602 }));
    assert.throws(() => captureBoundedLiveSession({ ...params, targetBlock: 101 }));
    assert.throws(() => captureBoundedLiveSession({ ...params, mode: 'victim' }));
    window.permit.validUntilMs = Date.now() - 1; save();
    assert.throws(() => guard.assertActive());
    assert.throws(() => captureBoundedLiveSession(params));
    assert.throws(() => window.renew(Date.now(), baseline), /permit expired/);
    window.stop(); save(); assert.throws(() => guard.assertActive());
  } finally {
    if (oldPath === undefined) delete process.env.SEARCHER_LIVE_SESSION_PATH; else process.env.SEARCHER_LIVE_SESSION_PATH = oldPath;
    if (oldId === undefined) delete process.env.SEARCHER_LIVE_SESSION_ID; else process.env.SEARCHER_LIVE_SESSION_ID = oldId;
    rmSync(run, { recursive: true });
  }
});
test('Ready SHA streams a file larger than the V8 string limit', () => {
  const directory = mkdtempSync(join(tmpdir(), 'mev-ready-hash-'));
  const path = join(directory, 'checkpoint.json'), size = 600 * 1024 * 1024;
  const fd = openSync(path, 'wx', 0o600);
  try { ftruncateSync(fd, size); } finally { closeSync(fd); }
  try {
    const zeros = Buffer.alloc(1024 * 1024), expected = createHash('sha256');
    for (let left = size; left > 0;) {
      const length = Math.min(left, zeros.length);
      expected.update(zeros.subarray(0, length)); left -= length;
    }
    assert.equal(shaFile(path), expected.digest('hex'));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
for (const name of ['bounded-live-launcher.mjs', 'cloud-live.mjs']) {
  test('stable symlink entry point executes CLI instead of silently returning: ' + name, () => {
    const directory = mkdtempSync(join(tmpdir(), 'mev-launcher-link-'));
    try {
      const alias = join(directory, 'current.mjs');
      symlinkSync(new URL('./' + name, import.meta.url).pathname, alias);
      // Invalid args stop before config/key/network access, but require the entry point to execute.
      const result = spawnSync(process.execPath, [alias, '--invalid-option'], { encoding: 'utf8', env: { PATH: '' } });
      assert.equal(result.status, 1); assert(result.stderr.length > 0); assert.equal(result.stdout, '');
    } finally { rmSync(directory, { recursive: true }); }
  });
}

test('balance deadline cancels the socket instead of only abandoning the await', async () => {
  // A settled promise is not a cancelled request. Hold the response open and
  // require the client to tear the connection down when the deadline fires,
  // otherwise every retry leaves another live request on the provider's meter.
  let requests = 0, aborted = false;
  const server = createServer((request, response) => {
    requests++;
    request.on('close', () => { aborted = true; });
    request.on('data', () => {});
    // Deliberately never respond.
    void response;
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  try {
    const { port } = server.address();
    const started = Date.now();
    await assert.rejects(
      readWalletBalance('http://127.0.0.1:' + port + '/', '0x' + '1'.repeat(40), 200),
      error => error.code === 'TIMEOUT');
    const elapsed = Date.now() - started;
    assert(elapsed < 2000, 'the deadline must settle promptly, took ' + elapsed + 'ms');
    await new Promise(done => setTimeout(done, 150));
    assert.equal(requests, 1);
    assert(aborted, 'the deadline must destroy the connection, not leave it running');
  } finally {
    server.closeAllConnections?.();
    await new Promise(done => server.close(done));
  }
});
