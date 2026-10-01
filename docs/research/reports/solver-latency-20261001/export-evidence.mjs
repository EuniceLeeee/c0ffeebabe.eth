// Evidence-only exporter. No RPC, subprocess launch of searcher, or production writes.
// Rewrites local diagnostic artifacts into explicitly redacted review copies.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline';
import { createGzip } from 'node:zlib';
import { once } from 'node:events';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../../..');
const evidence = 'logs/solver-prefix-policy-20260930.MKk8Vk';
const sha = value => createHash('sha256').update(value).digest('hex');
const audit = { url: 0, credentialField: 0, credentialAssignment: 0, localPath: 0, largeHex: 0 };
const publicHosts = new Set(['github.com', 'raw.githubusercontent.com', 'docs.uniswap.org', 'etherscan.io']);
const credentialKey = key => /privatekey|apikey|authkey|accesstoken|authtoken|refreshtoken|githubtoken|alchemykey|infurakey|authorization|secret|password|mnemonic|seedphrase/.test(key.replace(/[^a-z0-9]/gi, '').toLowerCase());

export function redactText(text) {
  // Decode only a complete serialized payload. Never globally unescape quotes:
  // an escaped quote inside a password is part of that password, not its end.
  const trimmed = text.trim();
  if (/^[\[{]/.test(trimmed)) {
    try { return JSON.stringify(redact(JSON.parse(trimmed))); } catch {}
    if (/^[\[{]\\+"/.test(trimmed)) {
      try { return redactText(JSON.parse('"' + trimmed + '"')); } catch {}
    }
  }
  return text
    .replace(/\\+\//g, '/')
    .replace(/-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?-----END [^-\r\n]*PRIVATE KEY-----/g,
      value => { audit.credentialAssignment++; return value.split('\n').map(() => '<redacted-private-key-line>').join('\n'); })
    .replace(/\b(?:https?|wss?):\/\/[^\s<>"'`\\)\]}]+/gi, value => {
      try {
        const u = new URL(value);
        if (publicHosts.has(u.hostname) && !u.username && !u.password && !u.search &&
            (!u.hash || /^#L\d+(?:-L\d+)?$/.test(u.hash))) return value;
      } catch {}
      audit.url++;
      return '<redacted-endpoint>';
    })
    .replace(/\b(Bearer|Basic)\s+[^\s,"'}]+/gi, (_, type) => { audit.credentialAssignment++; return `${type} <redacted-secret>`; })
    .replace(/(--(?:private-key|api-key|access-token|auth-token|password|mnemonic)(?:=|\s+))(?:"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|[^\s,;}]+)/gi,
      (_, prefix) => { audit.credentialAssignment++; return prefix + '<redacted-secret>'; })
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]{16,}|AKIA[A-Z0-9]{16})\b/g,
      () => { audit.credentialAssignment++; return '<redacted-secret>'; })
    .replace(/([A-Z_][A-Z0-9_.-]*)(["']?\s*[=:]\s*)("(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|[^\s,;}]+)/gi,
      (original, key, separator, value) => {
        if (credentialKey(key)) {
          audit.credentialAssignment++; return key + separator + '"<redacted-secret>"';
        }
        const quoted = value[0] === '"' || value[0] === "'";
        let inner = quoted ? value.slice(1, -1) : value;
        if (value[0] === '"') { try { inner = JSON.parse(value); } catch {} }
        const cleaned = redactText(inner);
        if (cleaned === inner) return original;
        return key + separator + (quoted ? JSON.stringify(cleaned) : cleaned);
      })
    .replaceAll(root, '<repo>')
    .replace(/\/Users\/[^\s/"']+/g, () => { audit.localPath++; return '<user>'; })
    .replace(/\b0x[0-9a-fA-F]{128,}\b/g, value => {
      audit.largeHex++;
      return `<redacted-hex bytes=${(value.length - 2) / 2} sha256=${sha(value)}>`;
    });
}

export function redact(value, key = '') {
  if (credentialKey(key)) {
    audit.credentialField++;
    return '<redacted-secret>';
  }
  if (typeof value === 'string') return redactText(value);
  if (Array.isArray(value)) return value.map(item => redact(item));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => {
    const cleaned = redactText(k);
    return [cleaned === k ? k : `${cleaned}#key-sha256:${sha(k)}`, redact(v, k)];
  }));
  return value;
}

function redactLine(line) {
  const at = line.indexOf('{');
  if (at >= 0) {
    try { return redactText(line.slice(0, at)) + JSON.stringify(redact(JSON.parse(line.slice(at)))); }
    catch {}
  }
  return redactText(line);
}

async function digestFile(file) {
  const h = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) h.update(chunk);
  return h.digest('hex');
}

const artifacts = [];
const omitted = [];

async function exportLog(source, destination) {
  const absolute = path.join(root, source);
  const size = fs.statSync(absolute).size;
  const original = createHash('sha256');
  const redacted = createHash('sha256');
  const input = fs.createReadStream(absolute);
  input.on('data', chunk => original.update(chunk));
  const shards = [];
  let lines = 0, shardLines = 0, shardBytes = 0, gzip, output, filename, insidePrivateKey = false;
  const start = () => {
    filename = `${destination}.part-${String(shards.length + 1).padStart(3, '0')}.redacted.log.gz`;
    fs.mkdirSync(path.dirname(path.join(here, filename)), { recursive: true });
    output = fs.createWriteStream(path.join(here, filename), { flags: 'wx' });
    gzip = createGzip({ level: 6 });
    gzip.pipe(output);
    shardLines = 0; shardBytes = 0;
  };
  const finish = async () => {
    const finished = once(output, 'finish');
    gzip.end(); await finished;
    shards.push({ file: filename, lines: shardLines, uncompressedBytes: shardBytes,
      bytes: fs.statSync(path.join(here, filename)).size, sha256: await digestFile(path.join(here, filename)) });
  };
  start();
  for await (const line of createInterface({ input, crlfDelay: Infinity })) {
    if (/-----BEGIN [^-\r\n]*PRIVATE KEY-----/.test(line)) insidePrivateKey = true;
    let sanitized;
    if (insidePrivateKey) {
      const before = line.split(/-----BEGIN [^-\r\n]*PRIVATE KEY-----/)[0];
      const after = line.split(/-----END [^-\r\n]*PRIVATE KEY-----/)[1];
      if ((/-----BEGIN [^-\r\n]*PRIVATE KEY-----/.test(line) && before.trim() !== '') ||
          (after !== undefined && after.trim() !== '')) {
        throw Error(`mixed-content private-key line needs manual redaction in ${source}`);
      }
      sanitized = '<redacted-private-key-line>\n'; audit.credentialAssignment++;
      if (/-----END [^-\r\n]*PRIVATE KEY-----/.test(line)) insidePrivateKey = false;
    } else {
      // Fail closed on an unsupported multiline credential assignment. No
      // manifest is sealed and no artifact is approved for publication.
      const open = line.match(/([A-Z_][A-Z0-9_.-]*)["']?\s*[=:]\s*(["'])([^"']*)$/i);
      if (open && credentialKey(open[1])) throw Error(`unclosed credential assignment in ${source}`);
      sanitized = redactLine(line) + '\n';
    }
    if (shardBytes >= 64 * 1024 * 1024) { await finish(); start(); }
    lines++; shardLines++; shardBytes += Buffer.byteLength(sanitized);
    redacted.update(sanitized);
    if (!gzip.write(sanitized)) await once(gzip, 'drain');
  }
  await finish();
  if (insidePrivateKey) throw Error(`unterminated private-key block in ${source}`);
  if (fs.statSync(absolute).size !== size) throw Error(`source changed during export: ${source}`);
  artifacts.push({ source, sourceBytes: size, sourceSha256: original.digest('hex'), type: 'redacted-line-preserving-log',
    lines, redactedSha256: redacted.digest('hex'), note: 'Concatenate decompressed shards in filename order. All original lines retained; sensitive values rewritten.', shards });
  console.log(JSON.stringify({ exported: source, lines, compressedBytes: shards.reduce((n, s) => n + s.bytes, 0) }));
}

function exportFile(source, destination) {
  const bytes = fs.readFileSync(path.join(root, source));
  const json = source.endsWith('.json');
  const content = json ? JSON.stringify(redact(JSON.parse(bytes.toString())), null, 2) + '\n' : redactText(bytes.toString());
  const target = path.join(here, destination);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, { flag: 'wx' });
  artifacts.push({ source, sourceBytes: bytes.length, sourceSha256: sha(bytes), type: json ? 'redacted-json' : 'redacted-text',
    file: destination, bytes: Buffer.byteLength(content), sha256: sha(content) });
}

async function main() {
  if (fs.existsSync(path.join(here, 'manifest.json'))) throw Error('immutable export exists; do not overwrite');
  for (const e of fs.readdirSync(path.join(root, evidence), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const source = `${evidence}/${e.name}`;
    if (e.isFile() && e.name.endsWith('.json')) exportFile(source, `evidence/${e.name}`);
    else if (e.isFile() && e.name.endsWith('.log')) await exportLog(source, `evidence/${e.name}`);
    else if (e.isFile() && /\.(?:mjs|mts)$/.test(e.name)) exportFile(source, `harnesses/${e.name}.txt`);
    else if (e.isDirectory() && fs.existsSync(path.join(root, source, 'results.json'))) {
      for (const name of ['declaration.json', 'results.json']) {
        if (fs.existsSync(path.join(root, source, name))) exportFile(`${source}/${name}`, `experiments/${e.name}/${name}`);
      }
    } else omitted.push({ source, reason: e.isDirectory() ? 'runtime/source/binary copy, not a diagnostic result directory' : 'not in diagnostic JSON/log/harness allowlist' });
  }
  const runs = [
    'live-raw-ready-250.ajvb1j',
    'live-solver-unique-pools-250.YgUfBJ',
    'live-solver-batched-prefix-250.I49DJ4',
    'live-solver-skip-settle-250.7MsLu8',
  ];
  for (const run of runs) {
    const dir = path.join(root, 'logs', run);
    for (const name of ['live.log', 'events.jsonl', 'routes.jsonl']) {
      if (fs.existsSync(path.join(dir, name))) await exportLog(`logs/${run}/${name}`, `live/${run}/${name}`);
    }
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!e.isFile()) { omitted.push({ source: `logs/${run}/${e.name}`, reason: 'runtime copy' }); continue; }
      if (e.name.endsWith('.json') && e.name !== 'checkpoint.json') exportFile(`logs/${run}/${e.name}`, `live/${run}/${e.name}`);
      else if (!['live.log', 'events.jsonl', 'routes.jsonl'].includes(e.name)) omitted.push({ source: `logs/${run}/${e.name}`, bytes: fs.statSync(path.join(dir, e.name)).size, reason: 'Ready/full price-table/runtime artifact; excluded from latency review bundle' });
    }
  }
  const diff = execFileSync('git', ['diff', '--binary', '--', 'listener'], { cwd: root, maxBuffer: 16 * 1024 * 1024 });
  const sanitizedDiff = redactText(diff.toString());
  fs.mkdirSync(path.join(here, 'code-review'), { recursive: true });
  fs.writeFileSync(path.join(here, 'code-review/current-uncommitted.review.patch'), sanitizedDiff, { flag: 'wx' });
  artifacts.push({ source: 'git diff --binary -- listener', sourceBytes: diff.length, sourceSha256: sha(diff), type: 'redacted-review-patch',
    file: 'code-review/current-uncommitted.review.patch', bytes: Buffer.byteLength(sanitizedDiff), sha256: sha(sanitizedDiff) });
  exportFile('listener/src/searcher/venues/swaps/univ4-family/local-state.ts', 'code-review/unintegrated-v4-local-state.ts.txt');
  const manifest = {
    schemaVersion: 1, generatedAt: new Date().toISOString(), purpose: 'User-requested independent Solver latency handoff; not acceptance, deployment, or performance approval',
    baseCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    sourceBranch: execFileSync('git', ['branch', '--show-current'], { cwd: root, encoding: 'utf8' }).trim(),
    scope: '2026-09-30 Asia/Shanghai live diagnostics plus continuation experiments through 2026-10-01; no new chain access',
    chainRpcCalls: 0, externalCuSpent: 0,
    redaction: { policy: 'Endpoints except allowlisted public source links, credential fields/assignments, user paths, large raw hex. Public chain addresses/hash IDs and numeric timing/results retained.', counts: audit,
      notRawLogs: true, originalFilesRemainLocal: true },
    artifacts, omitted,
    warnings: [
      'Archived plans/status JSON reflect the moment written; HANDOFF.md owns the current status. Some older records say V4 permission pending; user subsequently approved investigation/implementation.',
      'Current 13-file patch is not all deployed in any one measured live window. Use each run-contract and frozen source manifest, not current working files, to attribute behavior.',
      'Unintegrated V4 state-reader draft imports an absent local-math module; it is not functional production code and has no tests or quote parity evidence.',
      'Cancelled/missing/failed trials are retained. Offline recorded-response request reduction is not proof of live latency improvement.',
      'Code/harness text is a redacted review snapshot, not a standalone execution package; historical runtime, Ready, binaries and price tables are not uploaded.',
    ],
  };
  fs.writeFileSync(path.join(here, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ artifacts: artifacts.length, omitted: omitted.length, redactions: audit }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
