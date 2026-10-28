import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync,
  readFileSync, renameSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

interface WarmSource { readonly number: number; readonly hash: string }
interface WarmPin extends WarmSource {
  readonly schemaVersion: 1;
  readonly namespace: string;
  readonly topologyKey: string;
}

/** Only raw source-pinned RPC bytes survive restart. Sessions, admission,
 * effective authority and transaction inputs are always rebuilt normally. */
export class BlockScanStartupCache {
  private readonly directory: string;
  constructor(directory: string, namespace: string) {
    if (!isAbsolute(directory) || !/^[a-f0-9]{64}$/.test(namespace)) {
      throw new Error("invalid startup cache directory or namespace");
    }
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    assertPrivate(directory, true);
    this.directory = join(directory, namespace);
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    assertPrivate(this.directory, true);
    this.namespace = namespace;
  }
  private readonly namespace: string;

  restore(head: number, topologyKey: string, maxHeadGap: number): WarmSource | null {
    const path = join(this.directory, "pin.json");
    if (!existsSync(path)) return null;
    assertPrivate(path, false);
    const pin: WarmPin = JSON.parse(readFileSync(path, "utf8"));
    if (pin.schemaVersion !== 1 || pin.namespace !== this.namespace ||
        !Number.isSafeInteger(pin.number) || pin.number < 0 ||
        typeof pin.hash !== "string" || !/^0x[a-f0-9]{64}$/.test(pin.hash)) {
      throw new Error("invalid startup cache pin");
    }
    if (pin.topologyKey !== topologyKey || pin.number > head ||
        head - pin.number > maxHeadGap || !existsSync(this.path(pin.hash))) return null;
    return Object.freeze({ number: pin.number, hash: pin.hash });
  }

  begin(source: WarmSource, topologyKey: string): string {
    if (!Number.isSafeInteger(source.number) || source.number < 0 ||
        !/^0x[a-f0-9]{64}$/.test(source.hash)) throw new Error("invalid startup cache source");
    const pin: WarmPin = { schemaVersion: 1, namespace: this.namespace,
      topologyKey, number: source.number, hash: source.hash };
    const temp = join(this.directory, `pin-${randomUUID()}.tmp`);
    const fd = openSync(temp, "wx", 0o600);
    try { writeFileSync(fd, JSON.stringify(pin) + "\n"); fsyncSync(fd); }
    finally { closeSync(fd); }
    renameSync(temp, join(this.directory, "pin.json"));
    const dir = openSync(this.directory, "r");
    try { fsyncSync(dir); } finally { closeSync(dir); }
    return this.path(source.hash);
  }

  private path(hash: string): string { return join(this.directory, `calls-${hash}.jsonl`); }
}

export function startupCacheNamespace(context: unknown): string {
  return createHash("sha256").update(JSON.stringify(context)).digest("hex");
}

function assertPrivate(path: string, directory: boolean): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1) ||
      (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) {
    throw new Error("startup cache must be owner-only and not a symlink");
  }
}
