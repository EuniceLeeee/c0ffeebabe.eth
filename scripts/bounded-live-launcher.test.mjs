import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RunWindow, makeRunConfig, parseArguments } from './bounded-live-launcher.mjs';
import { parseClientArgs } from './cloud-live.mjs';
import { captureBoundedLiveSession } from '../listener/src/shared/bounded-live-session.ts';

const profile = { wallet: '0x' + '1'.repeat(40), executor: '0x' + '2'.repeat(40), release: '/release' };
const baseConfig = {
  SEARCHER_BLOCKSCAN_EFFECTIVE_WETH_INPUT: '0.02', SEARCHER_BLOCKSCAN_MAX_CANDIDATES: '10',
  SEARCHER_BLOCKSCAN_REFINE_CANDIDATES: '512', SEARCHER_BLOCKSCAN_SINGLE_FUNDING_ENABLED: '1',
  SEARCHER_BLOCKSCAN_POOL_REVERT_FILTER: '1',
};
const baseline = 2500000000000000n;
const fresh = (id = 'run-1', blocks = 2500) => new RunWindow({ runId: id, profile, blocks, balance: baseline, now: 100000 });
function activate(window, source = 100) {
  window.observe('[searcher/live] mode=live-submit', 6);
  window.observe('[searcher/live] strict ready catalog loaded: generation=6 valid', 6);
  window.observe('[searcher/blockscan-activity-range] ' + JSON.stringify({ sourceBlock: source, transitions: 1 }), 6);
  return window.observe(JSON.stringify({ type: 'block_scan_timing', source_block: source, stages: { state: { status: 'ran' } } }), 6);
}

test('default is read-only; explicit bounded block count only', () => {
  assert.equal(parseArguments([]).mode, 'check'); assert.equal(parseClientArgs([]).mode, 'check');
  for (const parse of [parseArguments, parseClientArgs]) {
    assert.equal(parse(['--broadcast']).blocks, 2500);
    assert.equal(parse(['--broadcast', '--blocks', '250']).blocks, 250);
    for (const n of ['0', '-1', '2501', '1.5', '1e3', '2500junk']) assert.throws(() => parse(['--blocks', n]));
    assert.throws(() => parse(['--check', '--broadcast']));
    assert.throws(() => parse(['--broadcast', '--broadcast']));
    assert.throws(() => parse(['--whatever']));
  }
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
  assert.equal(a.SEARCHER_LIVE_SESSION_PATH, '/runs/one/permit.json');
  assert.equal(b.SEARCHER_LIVE_SESSION_ID, 'two');
  for (const key of ['SEARCHER_EVENTS_PATH', 'SEARCHER_BLOCKSCAN_ROUTE_EVENTS_PATH', 'SEARCHER_BLOCKSCAN_MID_HISTORY_PATH', 'SEARCHER_SIM_REVERT_DIAGNOSTICS_PATH', 'SEARCHER_UNIVERSE_REBUILD_CHECKPOINT_PATH']) assert.notEqual(a[key], b[key]);
  assert.equal(b.SEARCHER_DRY_RUN_BOTVM_CODE_OVERRIDE, '0');
  assert.equal(b.SEARCHER_DRY_RUN_USE_READY_GENERATION, '0');
  assert.equal(b.SEARCHER_USE_READY_GENERATION, '1');
  assert.equal(b.SEARCHER_BRIBE_BPS, '5000');
  assert.equal(b.SEARCHER_BRIBE_ALL_ABOVE_GAS, '0');
  assert.equal(b.SEARCHER_BLOCKSCAN_EFFECTIVE_WETH_INPUT, '0.02');
  assert.equal(b.SEARCHER_BLOCKSCAN_MAX_CANDIDATES, '10');
  assert.equal(b.SEARCHER_BLOCKSCAN_REFINE_CANDIDATES, '512');
});
test('balance, stop and wall expiry fail closed', () => {
  const window = fresh(); activate(window);
  assert.equal(window.renew(101000, baseline).validUntilMs, 113000);
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
    window.stop(); save(); assert.throws(() => guard.assertActive());
  } finally {
    if (oldPath === undefined) delete process.env.SEARCHER_LIVE_SESSION_PATH; else process.env.SEARCHER_LIVE_SESSION_PATH = oldPath;
    if (oldId === undefined) delete process.env.SEARCHER_LIVE_SESSION_ID; else process.env.SEARCHER_LIVE_SESSION_ID = oldId;
    rmSync(run, { recursive: true });
  }
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
