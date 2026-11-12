import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { setImmediate as yieldTurn } from "node:timers/promises";
import { collectBlockTraceTouchedStateKeys, type BlockTouchedObservation,
  type BlockTouchedStateKeyResolver } from "./blockscan-touched-state.js";
import { BlockScanShadowTraceError, createBlockScanShadowTraceReader,
  type BlockScanShadowTraceRead, type BlockScanShadowTraceErrorCategory } from "./blockscan-trace-shadow.js";

interface TraceProjection {
  readonly kind: "validated-trace-projection";
  readonly blockNumber: number;
  readonly blockHash: string;
  readonly stateKeys: readonly string[];
  readonly observations: readonly BlockTouchedObservation[];
}

/** One persistent worker keeps buffers, parsing, validation and irrelevant
 * calldata off the live heap. Root metadata is sent once, never per block.
 * Cancellation terminates physical work before releasing diagnostic slots. */
export function createWorkerBlockScanShadowTraceReader(endpoint: string, input: {
  readonly knownStateKeys: Iterable<string>;
  readonly dependencyAddresses: Iterable<string>;
}): BlockScanShadowTraceRead & { close(): void } {
  const knownStateKeys = [...input.knownStateKeys];
  const dependencyAddresses = [...input.dependencyAddresses];
  let worker: Worker | undefined, closed = false, nextId = 0;
  const pending = new Map<number, { finish(error?: BlockScanShadowTraceError, value?: TraceProjection): void }>();
  const source = import.meta.url;
  const registerUrl = source.endsWith(".ts")
    ? pathToFileURL(createRequire(import.meta.url).resolve("tsx/esm/api")).href : undefined;
  const stop = (category: BlockScanShadowTraceErrorCategory) => {
    const old = worker; worker = undefined;
    const entries = [...pending.values()]; pending.clear();
    void (old ? old.terminate().catch(() => undefined) : Promise.resolve()).then(() => {
      for (const entry of entries) entry.finish(new BlockScanShadowTraceError(category));
    });
  };
  const ensureWorker = () => {
    if (worker) return worker;
    const current = new Worker(`const {workerData}=require("node:worker_threads");
      (async()=>{if(workerData.registerUrl){const {register}=await import(workerData.registerUrl);register();}
      await import(workerData.moduleUrl);})().catch(()=>process.exit(1));`, {
      eval: true, execArgv: [], resourceLimits: { maxOldGenerationSizeMb: 256 },
      workerData: { shadowTraceWorker: true, moduleUrl: source, registerUrl, endpoint, knownStateKeys, dependencyAddresses },
    });
    worker = current;
    current.on("message", (message: { id: number; value?: TraceProjection; error?: BlockScanShadowTraceErrorCategory }) => {
      if (worker !== current) return;
      pending.get(message.id)?.finish(message.error ? new BlockScanShadowTraceError(message.error) : undefined, message.value);
    });
    current.on("error", () => { if (worker === current) stop("transport"); });
    current.on("exit", () => { if (worker === current) stop("transport"); });
    current.unref();
    return current;
  };
  const read: BlockScanShadowTraceRead = (hash, control) => {
    if (closed || control.signal.aborted) return Promise.reject(new BlockScanShadowTraceError("aborted"));
    if (!control.anchor || control.blockNumber === undefined || control.anchor.hash.toLowerCase() !== hash.toLowerCase()) {
      return Promise.reject(new BlockScanShadowTraceError("invalid-anchor"));
    }
    const remaining = control.deadlineAtMs - Date.now();
    if (remaining <= 0) return Promise.reject(new BlockScanShadowTraceError("timeout"));
    return new Promise((resolve, reject) => {
      const id = ++nextId;
      let settled = false;
      const finish = (error?: BlockScanShadowTraceError, value?: TraceProjection) => {
        if (settled) return;
        settled = true; clearTimeout(timer); pending.delete(id);
        control.signal.removeEventListener("abort", abort);
        error ? reject(error) : resolve(value);
      };
      const abort = () => { if (!settled) stop("aborted"); };
      const timer = setTimeout(() => { if (!settled) stop("timeout"); }, remaining);
      timer.unref(); control.signal.addEventListener("abort", abort, { once: true });
      pending.set(id, { finish });
      try {
        ensureWorker().postMessage({ id, hash, blockNumber: control.blockNumber, anchor: control.anchor, deadlineAtMs: control.deadlineAtMs });
        if (closed || control.signal.aborted) abort();
      } catch { stop("transport"); }
    });
  };
  return Object.assign(read, { close() { closed = true; stop("aborted"); } });
}

/** Family semantics stay with the existing root resolver. Cooperative batches
 * bound diagnostic occupancy; neither results nor failures enter live state. */
export async function resolveShadowTraceProjection(raw: unknown, number: number, hash: string,
  resolver: BlockTouchedStateKeyResolver, signal?: AbortSignal): Promise<ReadonlySet<string>> {
  const value = raw as TraceProjection;
  if (!value || value.kind !== "validated-trace-projection" || value.blockNumber !== number ||
      value.blockHash !== hash.toLowerCase() || !Array.isArray(value.stateKeys) || !Array.isArray(value.observations)) {
    throw new BlockScanShadowTraceError("classification");
  }
  const keys = new Set(value.stateKeys);
  for (let offset = 0; offset < value.observations.length; offset += 16) {
    await yieldTurn(); signal?.throwIfAborted();
    for (const observation of value.observations.slice(offset, offset + 16)) {
      const resolved = resolver(observation, { number, hash });
      if (!Array.isArray(resolved) || resolved.some(key => typeof key !== "string" || !key)) {
        throw new BlockScanShadowTraceError("classification");
      }
      for (const key of resolved) keys.add(key.toLowerCase());
    }
  }
  return keys;
}

if (!isMainThread && workerData?.shadowTraceWorker === true) {
  const reader = createBlockScanShadowTraceReader(workerData.endpoint);
  const targets = new Set<string>(workerData.dependencyAddresses);
  const known = new Set<string>(workerData.knownStateKeys);
  parentPort!.on("message", async request => {
    try {
      const raw = await reader(request.hash, { signal: new AbortController().signal, deadlineAtMs: request.deadlineAtMs });
      const observations: BlockTouchedObservation[] = [];
      const addresses = collectBlockTraceTouchedStateKeys(raw, request.blockNumber, request.anchor,
        observation => {
          const address = observation.kind === "call" ? observation.target : observation.address;
          if (targets.has(address.toLowerCase())) observations.push(observation);
          return [];
        });
      parentPort!.postMessage({ id: request.id, value: { kind: "validated-trace-projection", blockNumber: request.blockNumber,
        blockHash: request.hash.toLowerCase(), stateKeys: [...addresses].filter(key => known.has(key)), observations } });
    } catch (error) {
      parentPort!.postMessage({ id: request.id, error: error instanceof BlockScanShadowTraceError ? error.category : "classification" });
    }
  });
}
