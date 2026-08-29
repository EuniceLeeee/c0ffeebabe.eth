import type { Hash } from "../../canonical-codec/src/index.ts";
import type {
  CpuMemoryEventLoopSampleV1,
  WorkerRestartSampleV1,
} from "../../../specs/performance/src/index.ts";

export type ProcessResourceScopeCapabilityV1 = object;
export type ProcessResourceScopeReaderPortV1 = object;
export type ProcessResourceObservationHandleV1 = object;
export type ProcessResourceObservationCapabilityV1 = object;
export type ProcessResourceObservationClaimCapabilityV1 = object;
export type ProcessResourceObservationReaderPortV1 = object;

export interface ProcessResourceScopeFactV1 {
  readonly schemaVersion: 1;
  readonly kind: "aloha.process-resource-scope";
  readonly scopeId: Hash;
  readonly processLogAnchorHash: Hash;
  readonly windowId: Hash;
  readonly generationId: string;
  readonly admissionId: Hash;
  readonly ordinal: string;
}

export interface ProcessResourceObservationV1 {
  readonly schemaVersion: 1;
  readonly kind: "aloha.process-resource-observation";
  readonly observationId: Hash;
  readonly observerInstanceId: Hash;
  readonly sampleSequence: string;
  readonly scope: ProcessResourceScopeFactV1;
  readonly openedMonotonicNs: string;
  readonly sealedMonotonicNs: string;
  readonly elapsedUs: string;
  readonly availableParallelism: string;
  readonly cpuUserStartUs: string;
  readonly cpuSystemStartUs: string;
  readonly cpuUserDeltaUs: string;
  readonly cpuSystemDeltaUs: string;
  readonly rssStartBytes: string;
  readonly rssEndBytes: string;
  readonly eventLoopObservationCount: string;
  readonly eventLoopMaxNs: string;
  readonly workerStartObservationId: Hash;
  readonly workerEndObservationId: Hash;
  readonly workerPoolInstanceId: Hash;
  readonly workerStartSequence: string;
  readonly workerEndSequence: string;
  readonly workerCountStart: string;
  readonly workerCountEnd: string;
  readonly workerSpawnedStart: string;
  readonly workerSpawnedEnd: string;
  readonly workerRestartedStart: string;
  readonly workerRestartedEnd: string;
  readonly workerReapedStart: string;
  readonly workerReapedEnd: string;
  readonly workerOrphanedStart: string;
  readonly workerOrphanedEnd: string;
  readonly workerReapedDelta: string;
  readonly workerStateRootStart: Hash;
  readonly workerStateRootEnd: Hash;
  readonly cpuMemoryEventLoop: CpuMemoryEventLoopSampleV1;
  readonly workerRestart: WorkerRestartSampleV1;
  readonly cpuMemoryEventLoopRoot: Hash;
  readonly workerRestartRoot: Hash;
}
