import { closeSync, fsyncSync, openSync, writeSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { queryTitanBundleStats, redactBuilderText } from "./shared/builder-observations.js";

/** One read-only query, explicitly requested offline. No wallet, polling or live import. */
export async function runBuilderStatsCli(argv: string[], fetchImpl: typeof fetch = globalThis.fetch): Promise<boolean> {
  const options = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i], value = argv[i + 1];
    if (!["--tx-hash", "--bundle-hash", "--out"].includes(key) || !value || options.has(key)) {
      throw new Error("usage: builder-stats --tx-hash 0x... --bundle-hash 0x... --out /absolute/new.jsonl");
    }
    options.set(key, value);
  }
  const txHash = options.get("--tx-hash") ?? "", bundleHash = options.get("--bundle-hash") ?? "";
  const out = options.get("--out") ?? "";
  if (![txHash, bundleHash].every(value => /^0x[0-9a-f]{64}$/i.test(value)) ||
      !isAbsolute(out) || !out.endsWith(".jsonl")) {
    throw new Error("valid transaction/bundle hashes and an absolute new .jsonl output path are required");
  }
  // Exclusive creation rejects an existing file or symlink; never truncate evidence.
  const fd = openSync(out, "wx", 0o600);
  try {
    const result = await queryTitanBundleStats({ txHash, bundleHash, fetch: fetchImpl,
      evidence: event => {
        const row = Buffer.from(JSON.stringify({ ...event, schema_version: 1, emitted_at_ms: Date.now() }) + "\n");
        let offset = 0;
        while (offset < row.length) {
          const written = writeSync(fd, row, offset, row.length - offset);
          if (!written) throw new Error("builder stats evidence write failed");
          offset += written;
        }
      },
    });
    console.log(JSON.stringify({ ok: result.ok, builder: "titan", tx_hash: txHash,
      bundle_hash: bundleHash, request_id: result.requestId, out }));
    return result.ok;
  } finally {
    try { fsyncSync(fd); } finally { closeSync(fd); }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runBuilderStatsCli(process.argv.slice(2)).then(ok => { if (!ok) process.exitCode = 1; }).catch(error => {
    console.error(redactBuilderText(error instanceof Error ? error.message : String(error)));
    process.exitCode = 1;
  });
}
