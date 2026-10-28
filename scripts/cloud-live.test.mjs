// Dummy credentials and an in-memory SSH stub only. No real signing, network or service startup.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { parseEnv } from 'node:util';
import { normalizeOwnerPrivateKey, parseClientArgs } from './cloud-live.mjs';

const dummyKey = '12'.repeat(32);
test('bare and prefixed keys produce the same canonical value', () => {
  for (const input of [dummyKey, '0x' + dummyKey, '0X' + dummyKey]) {
    assert.equal(normalizeOwnerPrivateKey(input), '0x' + dummyKey);
  }
});
test('missing, malformed or wrong-length keys remain rejected', () => {
  for (const input of [undefined, null, '', '0x', '1'.repeat(63), '1'.repeat(65), 'g'.repeat(64), '0x0x' + dummyKey]) {
    assert.throws(() => normalizeOwnerPrivateKey(input));
  }
});

const source = readFileSync(new URL('./cloud-live.mjs', import.meta.url), 'utf8');
const start = source.indexOf('export async function main(');
const end = source.indexOf('\nif (process.argv[1]', start);
assert(start >= 0 && end > start);
const mainSource = source.slice(start, end).replace('export ', '')
  .replaceAll('import.meta.url', JSON.stringify(new URL('./cloud-live.mjs', import.meta.url).href));

async function runMock({ args, key = dummyKey, answer = 'START 2500', tty = true, envReadable = true }) {
  const reads = [], commands = [], payloads = [];
  const profile = { configuration: 'fixture', instance: 'fixture', project: 'fixture', zone: 'fixture',
    node: '/fixture/node', launcher: '/fixture/launcher.mjs', envFile: '/fixture/owner.env' };
  const deps = {
    assert, dirname, join, URL, JSON, Promise, parseEnv, normalizeOwnerPrivateKey, parseClientArgs,
    process: { stdin: { isTTY: tty }, stdout: { isTTY: tty } },
    readFileSync(path) {
      reads.push(path);
      if (path.endsWith('cloud-live-client.json')) return JSON.stringify(profile);
      assert.equal(path, profile.envFile);
      assert(envReadable, 'fixture forbids credential read');
      return `export OWNER_PRIVATE_KEY=${key}\nUNRELATED_KEY=do-not-forward\n`;
    },
    createInterface() { return { async question() { return answer; }, close() {} }; },
    spawn(command, argv, options) {
      commands.push({ command, argv, options });
      const child = new EventEmitter();
      child.stdin = { end(payload) { payloads.push(payload); } };
      queueMicrotask(() => child.emit('close', 0));
      return child;
    },
  };
  const fn = new Function(...Object.keys(deps), `let failureStage; return (${mainSource});`)(...Object.values(deps));
  let error;
  try { await fn(args); } catch (failure) { error = failure; }
  return { reads, commands, payloads, error };
}
test('confirmed dummy bare key reaches mocked SSH as prefixed JSON, never argv', async () => {
  const result = await runMock({ args: ['--broadcast'], answer: 'START 2500 ' });
  assert.equal(result.error, undefined); assert.equal(result.commands.length, 1);
  assert.equal(result.commands[0].command, 'gcloud');
  assert.equal(result.commands[0].argv.join(' ').includes(dummyKey), false);
  assert.deepEqual(JSON.parse(result.payloads[0]), { OWNER_PRIVATE_KEY: '0x' + dummyKey, confirmation: 'human-start' });
  assert.equal(result.payloads[0].includes('UNRELATED_KEY'), false);
});
test('wrong confirmation cannot read credentials or connect', async () => {
  const result = await runMock({ args: ['--broadcast'], answer: '2500', envReadable: false });
  assert(result.error); assert.equal(result.commands.length, 0); assert.equal(result.reads.length, 1);
});
test('resume switch is forwarded with the exact human-confirmed 1250 block limit', async () => {
  const result = await runMock({ args: ['--broadcast', '--blocks', '1250', '--resume-prices', '1'], answer: 'START 1250' });
  assert.equal(result.error, undefined);
  assert(result.commands[0].argv.join(' ').includes('--broadcast --blocks 1250 --resume-prices 1'));
  assert(!result.commands[0].argv.join(' ').includes(dummyKey));
});
test('noninteractive start cannot read credentials or connect', async () => {
  const result = await runMock({ args: ['--broadcast'], tty: false, envReadable: false });
  assert(result.error); assert.equal(result.commands.length, 0); assert.equal(result.reads.length, 1);
});
test('positive-gross-profit needs explicit confirmation and is forwarded without changing the block cap', async () => {
  const args = ['--broadcast', '--blocks', '500', '--profit-mode', 'positive-gross-profit'];
  const cancelled = await runMock({ args, answer: 'START 500', envReadable: false });
  assert(cancelled.error); assert.equal(cancelled.commands.length, 0); assert.equal(cancelled.reads.length, 1);
  const started = await runMock({ args, answer: 'START 500 POSITIVE-GROSS-PROFIT' });
  assert.equal(started.error, undefined);
  assert(started.commands[0].argv.join(' ').includes('--broadcast --blocks 500 --profit-mode positive-gross-profit'));
  assert(!started.commands[0].argv.join(' ').includes(dummyKey));
});
test('check and status never read or send credentials', async () => {
  for (const mode of ['--check', '--status']) {
    const result = await runMock({ args: [mode], envReadable: false });
    assert.equal(result.error, undefined); assert.equal(result.reads.length, 1);
    assert.equal(result.commands.length, 1); assert.equal(result.commands[0].options.stdio[0], 'ignore');
    assert.deepEqual(result.payloads, []);
  }
});
test('malformed dummy key is refused before cloud connection', async () => {
  const result = await runMock({ args: ['--broadcast'], key: 'bad-fixture' });
  assert(result.error); assert.equal(result.commands.length, 0); assert.deepEqual(result.payloads, []);
});
