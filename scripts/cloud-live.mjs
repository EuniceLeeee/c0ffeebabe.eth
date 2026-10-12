#!/usr/bin/env node
// Human-operated entry point. No trading process starts without --broadcast AND terminal confirmation.
import assert from 'node:assert/strict';
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseEnv } from 'node:util';
import { createInterface } from 'node:readline/promises';
import { spawn } from 'node:child_process';

let failureStage = 'argument validation';

export function normalizeOwnerPrivateKey(value) {
  assert(typeof value === 'string' && /^(?:0x)?[0-9a-f]{64}$/i.test(value), 'primary OWNER_PRIVATE_KEY must be 64 hexadecimal digits, optionally prefixed by 0x');
  return '0x' + value.replace(/^0x/i, '');
}

export function parseClientArgs(args) {
  let mode = 'check', blocks = 2500;
  const modes = args.filter(value => ['--check', '--broadcast', '--status', '--stop'].includes(value));
  assert(modes.length <= 1, 'choose one mode');
  if (modes.length) mode = modes[0].slice(2);
  const other = args.filter(value => !modes.includes(value));
  if (other.length) {
    assert(other.length === 2 && other[0] === '--blocks' && /^[1-9][0-9]*$/.test(other[1]), 'usage: [--check|--broadcast|--status|--stop] [--blocks 1..2500]');
    blocks = Number(other[1]);
  }
  assert(Number.isSafeInteger(blocks) && blocks >= 1 && blocks <= 2500);
  return { mode, blocks };
}

export async function main(args) {
  failureStage = 'argument validation';
  const { mode, blocks } = parseClientArgs(args);
  failureStage = 'reading public launcher configuration';
  const folder = dirname(new URL(import.meta.url).pathname);
  const config = JSON.parse(readFileSync(join(folder, 'cloud-live-client.json'), 'utf8'));
  // Only public deployment coordinates are read for check/status/stop.
  for (const key of ['configuration', 'instance', 'project', 'zone']) assert(/^[a-zA-Z0-9._-]+$/.test(config[key]));
  for (const key of ['node', 'launcher']) assert(/^\/[a-zA-Z0-9/_.-]+$/.test(config[key]));
  let input;
  if (mode === 'broadcast') {
    failureStage = 'human confirmation';
    assert(process.stdin.isTTY && process.stdout.isTTY, 'start requires a human terminal');
    const prompt = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const answer = await prompt.question(`This will start real, EV-gated trading for at most ${blocks} source blocks. No auto-restart. Type START ${blocks} to continue: `);
      assert.equal(answer.trim(), `START ${blocks}`, 'start cancelled');
    } finally { prompt.close(); }
    failureStage = 'reading local credentials';
    const secrets = parseEnv(readFileSync(config.envFile, 'utf8'));
    failureStage = 'validating credential format';
    input = JSON.stringify({ OWNER_PRIVATE_KEY: normalizeOwnerPrivateKey(secrets.OWNER_PRIVATE_KEY), confirmation: 'human-start' });
  }
  failureStage = 'connecting to cloud';
  const remote = ['sudo', '-n', config.node, config.launcher, '--' + mode, '--blocks', String(blocks)].join(' ');
  const child = spawn('gcloud', ['--configuration=' + config.configuration, 'compute', 'ssh', config.instance,
    '--project=' + config.project, '--zone=' + config.zone, '--tunnel-through-iap', '--quiet', '--command=' + remote, '--', '-T'],
    { stdio: [input === undefined ? 'ignore' : 'pipe', 'inherit', 'inherit'] });
  if (input !== undefined) child.stdin.end(input);
  const result = await new Promise((done, fail) => { child.once('close', done); child.once('error', fail); });
  failureStage = 'cloud command response';
  assert.equal(result, 0, 'cloud command failed');
}

if (process.argv[1] && pathToFileURL(realpathSync(resolve(process.argv[1]))).href === import.meta.url) {
  main(process.argv.slice(2)).catch(() => { console.error(`Launch/check did not complete during ${failureStage}. Credentials have not been printed.`); process.exitCode = 1; });
}
