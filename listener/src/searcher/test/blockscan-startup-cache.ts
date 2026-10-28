import assert from "node:assert/strict";
import { test } from "node:test";
import { once } from "node:events";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { BlockScanStartupCache, startupCacheNamespace } from "../blockscan-startup-cache.js";

const hash = (n: number) => "0x" + n.toString(16).padStart(64, "0");
const namespace = startupCacheNamespace([1, "ready-v1", "executor-v1", "code-v1"]);

await test("startup pin is private, namespaced, topology-bound and age bounded", () => {
  const directory = mkdtempSync(join(tmpdir(), "warm-pin-"));
  try {
    const cache = new BlockScanStartupCache(directory, namespace);
    assert.equal(cache.restore(101, "graph-v1", 100), null);
    const path = cache.begin({ number: 100, hash: hash(100) }, "graph-v1");
    assert.equal(cache.restore(101, "graph-v1", 100), null, "missing payload is not a checkpoint");
    writeFileSync(path, "", { mode: 0o600 });
    assert.deepEqual(new BlockScanStartupCache(directory, namespace).restore(102, "graph-v1", 100),
      { number: 100, hash: hash(100) });
    assert.equal(cache.restore(99, "graph-v1", 100), null);
    assert.equal(cache.restore(201, "graph-v1", 100), null);
    assert.equal(cache.restore(101, "graph-v2", 100), null);
    assert.equal(new BlockScanStartupCache(directory, startupCacheNamespace([2])).restore(101, "graph-v1", 100), null);
    assert.throws(() => new BlockScanStartupCache(directory, "../escape"));
    const link = join(directory, "link"); symlinkSync(directory, link);
    assert.throws(() => new BlockScanStartupCache(link, namespace), /owner-only/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

await test("real process interruption retains timed-flushed RPC bytes, not sessions", async () => {
  const directory = mkdtempSync(join(tmpdir(), "warm-restart-"));
  let requests = 0;
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", b => chunks.push(b));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString());
      const rows = Array.isArray(body) ? body : [body];
      requests += rows.length;
      const replies = rows.map((r: { id: number }) => ({ jsonrpc: "2.0", id: r.id, result: "0x1234" }));
      res.end(JSON.stringify(Array.isArray(body) ? replies : replies[0]));
    });
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert(address && typeof address === "object");
  const base = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const loader = resolve(base, "../..", "node_modules/tsx/dist/loader.mjs");
  const code = (first: boolean) => `
    import { BlockScanStartupCache } from ${JSON.stringify(pathToFileURL(base + "/blockscan-startup-cache.ts").href)};
    import { PinnedRethQuoteBackend } from ${JSON.stringify(pathToFileURL(base + "/pinned-reth-quote-backend.ts").href)};
    const cache = new BlockScanStartupCache(${JSON.stringify(directory)}, ${JSON.stringify(namespace)});
    const backend = new PinnedRethQuoteBackend("http://127.0.0.1:${address.port}", ${JSON.stringify(hash(100))}, {
      persistentEthCallCachePath: cache.begin({ number:100, hash:${JSON.stringify(hash(100))} }, "graph-v1") });
    await backend.call({ to:"0x"+"11".repeat(20), data:"0xcafe" });
    ${first ? 'setInterval(()=>{},1000); setTimeout(()=>console.log("SAVED"),1400);'
      : 'await backend.closeAndDrain(); console.log(JSON.stringify(backend.stats()));'}
  `;
  let child: ReturnType<typeof spawn> | undefined;
  try {
    child = spawn(process.execPath, ["--import", loader, "--input-type=module", "-e", code(true)],
      { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stderr!.on("data", b => { stderr += b; });
    await new Promise<void>((done, fail) => {
      const timer = setTimeout(() => fail(new Error("first process did not checkpoint: " + stderr)), 10000);
      child!.stdout!.on("data", b => { stdout += b; if (stdout.includes("SAVED")) { clearTimeout(timer); done(); } });
      child!.once("error", fail);
      child!.once("exit", code => { if (!stdout.includes("SAVED")) { clearTimeout(timer); fail(new Error("first process exited: " + code + stderr)); } });
    });
    child.kill("SIGKILL"); await once(child, "close"); child = undefined;
    assert.equal(requests, 1);
    child = spawn(process.execPath, ["--import", loader, "--input-type=module", "-e", code(false)],
      { stdio: ["ignore", "pipe", "pipe"] });
    stdout = ""; stderr = "";
    child.stdout!.on("data", b => { stdout += b; }); child.stderr!.on("data", b => { stderr += b; });
    const [exit] = await once(child, "close"); child = undefined;
    assert.equal(exit, 0, stderr);
    assert.equal(requests, 1, "restart must not repeat the upstream read");
    const stats = JSON.parse(stdout.trim().split("\n").at(-1)!);
    assert.equal(stats.persistentCacheHits, 1);
    assert.equal(stats.totalCalls, 0);
    if (process.env.SEARCHER_STARTUP_CACHE_LARGE_TEST === "1") {
      const path = join(directory, namespace, `calls-${hash(100)}.jsonl`);
      const row = readFileSync(path, "utf8").trimEnd().split("\n")[1]! + "\n";
      // Repeated identical rows are valid; they stress the file boundary
      // without manufacturing a huge in-memory state table.
      const chunk = row.repeat(Math.ceil(1024 * 1024 / row.length));
      while (statSync(path).size <= 540 * 1024 * 1024) appendFileSync(path, chunk);
      child = spawn(process.execPath, ["--max-old-space-size=256", "--import", loader,
        "--input-type=module", "-e", code(false)], { stdio: ["ignore", "pipe", "pipe"] });
      stdout = ""; stderr = "";
      child.stdout!.on("data", b => { stdout += b; }); child.stderr!.on("data", b => { stderr += b; });
      const [largeExit] = await once(child, "close"); child = undefined;
      assert.equal(largeExit, 0, stderr);
      assert.equal(requests, 1, "a cache larger than the JS string limit still avoids upstream calls");
      assert.equal(JSON.parse(stdout.trim().split("\n").at(-1)!).persistentCacheHits, 1);
      console.log(`large startup cache: ${statSync(path).size} bytes restored with a 256 MiB heap`);
    }
  } finally {
    if (child && child.exitCode === null) { child.kill("SIGKILL"); await once(child, "close"); }
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  }
});
