import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { copyFile, link, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import type { DaemonResponse, RevmRequestControl, StrictSimulateRequest } from "../revm-sim-client.js";

const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const absent = (error: unknown) => (error as NodeJS.ErrnoException)?.code === "ENOENT";
// Requests are wire JSON. Preserve arrays and all defined fields; object key order is immaterial.
export function familyFactCacheKey(value: unknown): string {
  const sort = (v: any): any => Array.isArray(v) ? v.map(sort) : v && typeof v === "object"
    ? Object.fromEntries(Object.keys(v).sort().map(key => [key, sort(v[key])])) : v;
  return sha(JSON.stringify(sort(JSON.parse(JSON.stringify(value)))));
}
export function familyFactCacheDirectory(): string {
  return resolve(process.env.SEARCHER_FAMILY_FACT_CACHE_DIR || fileURLToPath(new URL("../../../../logs/family-facts-cache", import.meta.url)));
}

/** Local test cache only. A live writer is never displaced by an elapsed timeout. */
export async function withFamilyFactCacheLock<T>(path: string, run: () => Promise<T>, control?: RevmRequestControl): Promise<T> {
  await mkdir(dirname(path), { recursive: true });
  const owner = JSON.stringify({ pid: process.pid, host: hostname(), nonce: randomUUID() });
  const temporary = `${path}.${randomUUID()}`;
  await writeFile(temporary, owner, { flag: "wx", mode: 0o600 });
  let acquired = false;
  const deadline = control?.deadlineAtMs ?? Date.now() + 30 * 60_000;
  try {
    while (!acquired) {
      control?.signal?.throwIfAborted(); assert(Date.now() < deadline, "test cache writer wait expired");
      try { await link(temporary, path); acquired = true; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        let text: string;
        try { text = await readFile(path, "utf8"); } catch (error) { if (absent(error)) continue; throw error; }
        const previous = JSON.parse(text);
        assert(previous.host === hostname() && Number.isSafeInteger(previous.pid) && previous.pid > 0, "foreign/invalid test cache writer");
        try { process.kill(previous.pid, 0); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
          // Preserve the checkpoint and require explicit stale-lock recovery.
          // Blind unlink after a PID check races a different process acquiring it.
          throw new Error(`test cache writer exited; inspect retained checkpoint and lock: ${path}`);
        }
        await delay(100, undefined, control?.signal ? { signal: control.signal } : {});
      }
    }
    return await run();
  } finally {
    if (acquired) {
      assert.equal(await readFile(path, "utf8"), owner, "test cache lock ownership changed");
      await unlink(path);
    }
    await unlink(temporary);
  }
}

export async function writeFamilyFactCache(path: string, binding: unknown, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const data = JSON.stringify(value), temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify({ version: 1, key: familyFactCacheKey(binding),
      recordedAt: new Date().toISOString(), sha256: sha(data), data }), { flag: "wx", mode: 0o600 });
    await rename(temporary, path);
  } finally { await unlink(temporary).catch(error => { if (!absent(error)) throw error; }); }
}
export async function readFamilyFactCache(path: string, binding: unknown): Promise<{ value: any; recordedAt: string } | null> {
  let bytes: string;
  try { bytes = await readFile(path, "utf8"); } catch (error) { if (absent(error)) return null; throw error; }
  const row = JSON.parse(bytes);
  assert(row.version === 1 && row.key === familyFactCacheKey(binding) && typeof row.data === "string" &&
    row.sha256 === sha(row.data) && Number.isFinite(Date.parse(row.recordedAt)), "test cache integrity/binding mismatch");
  return { value: JSON.parse(row.data), recordedAt: row.recordedAt };
}

/** The production checkpoint store remains the sole writer/parser of Ready.
 * An interrupted build has no seal and resumes from its original working file. */
export async function cachedFamilyReady(input: {
  directory: string; binding: unknown; out: string; build: (path: string) => Promise<void>;
}) {
  const key = familyFactCacheKey(input.binding), path = resolve(input.directory, "ready", key, "ready.json");
  return withFamilyFactCacheLock(`${path}.fact-cache-lock`, async () => {
    let seal = await readFamilyFactCache(`${path}.complete.json`, input.binding);
    const reused = seal !== null;
    if (!seal) {
      await input.build(path);
      await writeFamilyFactCache(`${path}.complete.json`, input.binding, { sha256: sha(await readFile(path)) });
      seal = await readFamilyFactCache(`${path}.complete.json`, input.binding);
    }
    assert.equal(sha(await readFile(path)), seal!.value.sha256, "cached Ready changed after publication");
    // Each report owns a snapshot; subsequent tests cannot rewrite its evidence.
    await copyFile(path, input.out);
    return { status: reused ? "reused" : "built", key, recordedAt: seal!.recordedAt };
  });
}

export interface FamilySimulationCacheContext {
  readonly executor: string;
  readonly owner: string;
  readonly executorCodeHash: string;
  readonly executorArtifactSha256: string;
  readonly sourceTreeSha256: string;
  readonly executorProvisioning: unknown;
  readonly executionEnvironment: unknown;
}

/** Decorates the live NodeStrictClient; never substitutes a simulator or an acceptance verdict. */
export async function cachedFamilySimulation(input: {
  directory: string; context: FamilySimulationCacheContext; request: StrictSimulateRequest;
  control?: RevmRequestControl; execute: (request: StrictSimulateRequest) => Promise<DaemonResponse>;
}) {
  const { rpcUrl, ...publicRequest } = input.request;
  const binding = JSON.parse(JSON.stringify({ version: 1, context: input.context, request: publicRequest }));
  const request: Omit<StrictSimulateRequest, "rpcUrl"> = binding.request;
  assert(request.sourcePin?.blockHash && request.sourcePin.stateRoot, "simulation cache requires a full state pin");
  const key = familyFactCacheKey(binding), path = resolve(input.directory, "simulation", `${key}.json`);
  const completed = (response: DaemonResponse) => {
    if (!response.ok || !response.strict || !["Success", "Revert"].includes(response.strict.outcome.kind)) return false;
    if (response.strict.outcome.kind === "Revert" && response.strict.outcome.nestedHalt) return false;
    const pin = response.sourceAttestation;
    assert(pin?.kind === "node-attested" && pin.chainId === request.sourcePin!.chainId &&
      pin.blockNumber === request.blockNumber && pin.blockHash.toLowerCase() === request.sourcePin!.blockHash.toLowerCase() &&
      pin.stateRoot.toLowerCase() === request.sourcePin!.stateRoot!.toLowerCase(), "simulation cache source mismatch");
    return true;
  };
  return withFamilyFactCacheLock(`${path}.fact-cache-lock`, async () => {
    const cached = await readFamilyFactCache(path, binding);
    if (cached) {
      assert(completed(cached.value), "simulation cache contains an incomplete result");
      return { response: cached.value as DaemonResponse, cache: { status: "reused", key, recordedAt: cached.recordedAt } };
    }
    const response = await input.execute({ ...request, rpcUrl });
    input.control?.signal?.throwIfAborted();
    if (completed(response)) await writeFamilyFactCache(path, binding, response);
    return { response, cache: { status: "executed", key } };
  }, input.control);
}
