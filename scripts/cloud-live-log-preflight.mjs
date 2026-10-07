import { lstat, readdir, readFile, realpath, stat, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Only raw run logs, never Ready, checkpoints, manifests or derived evidence.
const logNames = ['live.log', 'events.jsonl', 'mids.jsonl', 'routes.jsonl', 'reverts.jsonl', 'resources.log'];
const ignoredDirectories = new Set(['.git', 'node_modules', 'target', 'docs']);
const missing = error => error.code === 'ENOENT';
const inside = (path, root) => path === root || path.startsWith(root + '/');

async function regular(path) {
  try {
    const stat = await lstat(path);
    return stat.isFile() && stat.nlink === 1 ? stat : null;
  } catch (error) {
    if (missing(error)) return null;
    throw error;
  }
}

const inode = stat => `${stat.dev}:${stat.ino}`;
async function openInodes() {
  if (process.platform !== 'linux') throw new Error('Cloud log cleanup requires Linux process checks');
  const paths = new Set();
  for (const pid of await readdir('/proc')) {
    if (!/^\d+$/.test(pid)) continue;
    let descriptors;
    try { descriptors = await readdir(`/proc/${pid}/fd`); }
    catch (error) { if (missing(error)) continue; throw error; }
    for (const fd of descriptors) {
      try { paths.add(inode(await stat(`/proc/${pid}/fd/${fd}`))); }
      catch (error) { if (!missing(error)) throw error; }
    }
  }
  return paths;
}

export async function pruneCloudLiveLogs({ root, currentRun, apply = false }) {
  root = resolve(root);
  if (root === '/' || dirname(root) === '/') throw new Error('Refusing a broad cleanup root');
  if (await realpath(root) !== root) throw new Error('Cleanup root must not contain symlinks');
  if (currentRun) {
    currentRun = resolve(currentRun);
    if (currentRun === root || !inside(currentRun, root) || await realpath(currentRun) !== currentRun)
      throw new Error('Current run must be a physical child directory');
  }
  const candidates = [];
  const skipped = [];
  const opened = await openInodes();
  const runInodes = new Map();
  async function visit(directory) {
    if (currentRun && inside(directory, currentRun)) return;
    // Existing cloud supervisors create both documents before any live log.
    // Their presence identifies a run, not an arbitrary directory named live.
    const contractPath = join(directory, 'run-contract.json');
    if (await regular(contractPath) && await regular(join(directory, 'launch.mjs'))) {
      const contract = JSON.parse(await readFile(contractPath, 'utf8'));
      if (contract.broadcast !== false || contract.signing !== false ||
          !Number.isSafeInteger(contract.blockLimit) || contract.blockLimit <= 0)
        throw new Error(`Unrecognized live run contract: ${directory}`);
      const logs = [];
      const activeInodes = new Set();
      for (const name of logNames) {
        const path = join(directory, name);
        // Activity checks include aliases and hardlinks, even though those
        // files are deliberately not eligible for deletion.
        try { activeInodes.add(inode(await stat(path))); }
        catch (error) { if (!missing(error)) throw error; }
        const value = await regular(path);
        if (value) logs.push({ path, bytes: value.size, dev: value.dev, ino: value.ino, mtimeMs: value.mtimeMs });
      }
      if ([...activeInodes].some(value => opened.has(value))) {
        skipped.push({ directory, reason: 'active_log_file' });
      } else {
        runInodes.set(directory, activeInodes);
        candidates.push(...logs);
      }
    }
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && !ignoredDirectories.has(entry.name)) await visit(join(directory, entry.name));
    }
  }
  await visit(root);
  const deleted = [];
  if (apply) {
    // Recheck process handles and identity immediately before exact unlinks.
    const nowOpen = await openInodes();
    for (const [directory, inodes] of runInodes) {
      if ([...inodes].some(value => nowOpen.has(value))) throw new Error(`Run became active: ${directory}`);
    }
    for (const file of candidates) {
      if (nowOpen.has(inode(file))) throw new Error(`Log became active: ${file.path}`);
      const stat = await regular(file.path);
      if (!stat || stat.dev !== file.dev || stat.ino !== file.ino || stat.size !== file.bytes || stat.mtimeMs !== file.mtimeMs)
        throw new Error(`Log changed after inspection: ${file.path}`);
    }
    for (const file of candidates) { await unlink(file.path); deleted.push(file.path); }
  }
  return { schemaVersion: 1, root, currentRun: currentRun ?? null, apply,
    candidates: candidates.map(({ path, bytes }) => ({ path, bytes })), skipped, deleted,
    bytes: candidates.reduce((sum, file) => sum + file.bytes, 0) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  let root, currentRun, apply = false;
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--root') root = args[++index];
    else if (args[index] === '--current-run') currentRun = args[++index];
    else if (args[index] === '--apply') apply = true;
    else throw new Error(`Unknown cleanup option: ${args[index]}`);
  }
  if (!root) throw new Error('--root is required');
  console.log(JSON.stringify(await pruneCloudLiveLogs({ root, currentRun, apply }), null, 2));
}
