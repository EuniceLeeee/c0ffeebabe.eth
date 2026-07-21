import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) out[key] = true;
    else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

/** Resolve read-only RPC without requiring credentials in process argv. */
export function resolveRpcUrl(
  args: Readonly<Record<string, string | boolean>>,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const explicit = args.rpc;
  if (typeof explicit === "string" && explicit.trim()) return explicit.trim();
  for (const name of ["READONLY_RPC_URL", "MAINNET_RPC_URL", "SEARCHER_LIVE_RPC_URL"] as const) {
    const value = env[name];
    if (value?.trim()) return value.trim();
  }
  return "";
}

export async function writeText(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

export function uniq<T>(items: T[]): T[] {
  return [...new Set(items)];
}

export function sumBigints(items: bigint[]): bigint {
  return items.reduce((a, b) => a + b, 0n);
}

export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
