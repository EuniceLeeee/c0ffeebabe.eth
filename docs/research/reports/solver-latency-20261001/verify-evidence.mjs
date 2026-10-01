// Read-only, network-free verification of the exported review bundle.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createGunzip } from 'node:zlib';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const base = path.dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(fs.readFileSync(path.join(base, 'manifest.json')));
const urls = new Set(['github.com', 'raw.githubusercontent.com', 'docs.uniswap.org', 'etherscan.io']);
let files = 0, lines = 0, failures = 0;
const seen = new Set();
const fail = (file, reason) => { failures++; if (failures < 20) console.error(JSON.stringify({ file, reason })); };

function inspect(text, file) {
  if (/\/Users\/eunice|\b0x[0-9a-fA-F]{128,}\b/.test(text)) fail(file, 'unredacted personal path or large raw hex');
  for (const [candidate] of text.matchAll(/\b(?:https?|wss?):\/\/[^\s<>"'`\\)\]}]+/gi)) {
    try {
      const u = new URL(candidate);
      if (!urls.has(u.hostname) || u.username || u.password || u.search || (u.hash && !/^#L\d+(?:-L\d+)?$/.test(u.hash))) fail(file, 'unredacted endpoint or non-source URL');
    } catch { fail(file, 'unparseable URL'); }
  }
  if (/\b(?:gh[pousr]_[A-Za-z0-9_]{10,}|github_pat_[A-Za-z0-9_]{10,}|sk-[A-Za-z0-9_-]{16,}|AKIA[A-Z0-9]{16})\b/.test(text)) fail(file, 'credential-like token');
}

async function verifyFile(file, bytes, expectedHash) {
  assert(!seen.has(file), `duplicate artifact: ${file}`); seen.add(file);
  const absolute = path.resolve(base, file);
  assert(absolute.startsWith(base + path.sep));
  assert.equal(fs.lstatSync(absolute).isSymbolicLink(), false);
  assert.equal(fs.statSync(absolute).size, bytes, file);
  assert(bytes < 50 * 1024 * 1024, `GitHub review shard exceeds50MiB: ${file}`);
  const h = createHash('sha256');
  for await (const chunk of fs.createReadStream(absolute)) h.update(chunk);
  assert.equal(h.digest('hex'), expectedHash, file); files++;
  return absolute;
}

for (const entry of manifest.artifacts) {
  if (entry.shards) {
    let total = 0;
    const digest = createHash('sha256');
    for (const shard of entry.shards) {
      const file = await verifyFile(shard.file, shard.bytes, shard.sha256);
      let n = 0, bytes = 0;
      const stream = fs.createReadStream(file).pipe(createGunzip());
      stream.on('data', chunk => { digest.update(chunk); bytes += chunk.length; });
      for await (const line of createInterface({ input: stream, crlfDelay: Infinity })) { n++; inspect(line, shard.file); }
      assert.equal(n, shard.lines, shard.file);
      assert.equal(bytes, shard.uncompressedBytes, shard.file);
      total += n;
    }
    assert.equal(total, entry.lines, entry.source);
    assert.equal(digest.digest('hex'), entry.redactedSha256, entry.source);
    lines += total;
  } else {
    const file = await verifyFile(entry.file, entry.bytes, entry.sha256);
    const value = fs.readFileSync(file, 'utf8');
    inspect(value, entry.file);
    if (entry.type === 'redacted-json') JSON.parse(value);
  }
}
assert.equal(failures, 0, 'secret-scan anomalies require investigation before publication');
console.log(JSON.stringify({ status: 'pass', files, redactedLogLines: lines, artifacts: manifest.artifacts.length,
  verified: ['file and decompressed hashes', 'sizes and50MiB shard ceiling', 'line counts', 'JSON parse', 'endpoint/token/personal-path/raw-hex scan'],
  caveat: 'Secrecy patterns are defense-in-depth, not proof against arbitrary secret encodings. Original/source provenance and numerical preservation receive a separate independent audit.' }, null, 2));
