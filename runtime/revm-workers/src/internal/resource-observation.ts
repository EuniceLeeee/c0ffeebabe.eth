import { randomUUID } from "node:crypto";
import { hashDomain, type Hash } from "../../../../packages/canonical-codec/src/index.ts";
import { RevmWorkerPool, type RevmWorkerPoolSnapshot, type RevmWorkerState } from "../lifecycle.ts";

export type RevmWorkerResourceObservationPortV1 = object;
export type RevmWorkerResourceObservationCapabilityV1 = object;

export interface RevmWorkerResourceObservationFactV1 {
  readonly schemaVersion: 1;
  readonly kind: "aloha.revm-worker-resource-observation";
  readonly observationId: Hash;
  readonly poolInstanceId: Hash;
  readonly sequence: string;
  readonly observedMonotonicNs: string;
  readonly workerCount: string;
  readonly startingWorkers: string;
  readonly readyWorkers: string;
  readonly busyWorkers: string;
  readonly retiringWorkers: string;
  readonly queued: string;
  readonly spawned: string;
  readonly restarted: string;
  readonly reaped: string;
  readonly orphanedWorkers: string;
  readonly workerStateRoot: Hash;
}

interface PortState {
  readonly pool: RevmWorkerPool;
  readonly poolInstanceId: Hash;
  nextSequence: bigint;
}

interface CapabilityState {
  readonly port: RevmWorkerResourceObservationPortV1;
  readonly fact: RevmWorkerResourceObservationFactV1;
  consumed: boolean;
}

const ports = new WeakMap<object, PortState>();
const portsByPool = new WeakMap<RevmWorkerPool, RevmWorkerResourceObservationPortV1>();
const capabilities = new WeakMap<object, CapabilityState>();

function countState(snapshot: RevmWorkerPoolSnapshot, state: RevmWorkerState): string {
  return snapshot.workers.filter((worker) => worker.state === state).length.toString();
}

function assertCounter(value: number, path: string): string {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${path} is not a non-negative safe integer`);
  return value.toString();
}

function payload(value: RevmWorkerResourceObservationFactV1): Omit<RevmWorkerResourceObservationFactV1, "observationId"> {
  const { observationId: _observationId, ...rest } = value;
  return rest;
}

function factFor(state: PortState, snapshot: RevmWorkerPoolSnapshot): RevmWorkerResourceObservationFactV1 {
  const body = Object.freeze({
    schemaVersion: 1 as const,
    kind: "aloha.revm-worker-resource-observation" as const,
    poolInstanceId: state.poolInstanceId,
    sequence: state.nextSequence.toString(),
    observedMonotonicNs: process.hrtime.bigint().toString(),
    workerCount: assertCounter(snapshot.workers.length + snapshot.starting, "workerCount"),
    startingWorkers: assertCounter(Number(countState(snapshot, "starting")) + snapshot.starting, "startingWorkers"),
    readyWorkers: countState(snapshot, "ready"),
    busyWorkers: countState(snapshot, "busy"),
    retiringWorkers: countState(snapshot, "retiring"),
    queued: assertCounter(snapshot.queued, "queued"),
    spawned: assertCounter(snapshot.spawned, "spawned"),
    restarted: assertCounter(snapshot.restarted, "restarted"),
    reaped: assertCounter(snapshot.reaped, "reaped"),
    orphanedWorkers: assertCounter(snapshot.orphanedWorkers, "orphanedWorkers"),
    workerStateRoot: hashDomain("aloha/revm-worker-state-root/v1", {
      pendingSpawnCount: snapshot.starting.toString(),
      workers: snapshot.workers.map((worker) => ({
        epoch: worker.epoch,
        state: worker.state,
        pending: worker.pending.toString(),
        staleResponses: worker.staleResponses.toString(),
        retireReason: worker.retireReason,
        reaped: worker.reaped,
        orphaned: worker.orphaned,
        engineBuildFingerprint: worker.engineBuildFingerprint,
        executableFingerprint: worker.executableFingerprint,
      })),
    }),
  });
  const observationId = hashDomain("aloha/revm-worker-resource-observation/v1", body);
  return Object.freeze({ ...body, observationId });
}

/**
 * Release composition calls this narrow owner seam with the concrete pool.
 * The resulting object has no structural read method and cannot be cloned.
 */
export function issueRevmWorkerResourceObservationPort(
  pool: RevmWorkerPool,
): RevmWorkerResourceObservationPortV1 {
  if (!(pool instanceof RevmWorkerPool)) throw new TypeError("REVM resource observation requires a real worker pool");
  if (portsByPool.has(pool)) throw new TypeError("REVM resource observation port is already issued for this pool");
  const port = Object.freeze(Object.create(null)) as RevmWorkerResourceObservationPortV1;
  const poolInstanceId = hashDomain("aloha/revm-worker-pool-instance/v1", {
    processId: process.pid.toString(),
    issuedMonotonicNs: process.hrtime.bigint().toString(),
    nonce: randomUUID(),
  });
  ports.set(port, { pool, poolInstanceId, nextSequence: 0n });
  portsByPool.set(pool, port);
  return port;
}

export function captureRevmWorkerResourceObservation(
  port: RevmWorkerResourceObservationPortV1,
): RevmWorkerResourceObservationCapabilityV1 {
  if (port === null || typeof port !== "object") throw new TypeError("REVM resource observation port is invalid");
  const state = ports.get(port);
  if (state === undefined) throw new TypeError("REVM resource observation port is not owner-issued");
  const fact = factFor(state, state.pool.snapshot());
  state.nextSequence += 1n;
  const capability = Object.freeze(Object.create(null)) as RevmWorkerResourceObservationCapabilityV1;
  capabilities.set(capability, { port, fact, consumed: false });
  return capability;
}

export function readRevmWorkerResourceObservation(
  port: RevmWorkerResourceObservationPortV1,
  capability: RevmWorkerResourceObservationCapabilityV1,
): RevmWorkerResourceObservationFactV1 {
  if (port === null || typeof port !== "object" || !ports.has(port)) {
    throw new TypeError("REVM resource observation port is not owner-issued");
  }
  if (capability === null || typeof capability !== "object") {
    throw new TypeError("REVM resource observation capability is invalid");
  }
  const state = capabilities.get(capability);
  if (state === undefined) throw new TypeError("REVM resource observation capability is not owner-issued");
  if (state.port !== port) throw new TypeError("REVM resource observation capability belongs to another pool");
  if (state.consumed) throw new TypeError("REVM resource observation capability is already consumed");
  const expected = hashDomain("aloha/revm-worker-resource-observation/v1", payload(state.fact));
  if (expected !== state.fact.observationId) throw new TypeError("REVM resource observation identity mismatch");
  state.consumed = true;
  return state.fact;
}
