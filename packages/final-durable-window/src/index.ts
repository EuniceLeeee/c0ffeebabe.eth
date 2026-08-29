import type { Hash } from "../../canonical-codec/src/index.ts";
import {
  decodeTerminalPhaseInvalidFactCapabilityV1,
  readFinalDurableWindowBindingCapabilityV1,
} from "./internal/owner.ts";

export interface FinalDurableWindowReleaseV1 {
  readonly bindingId: Hash;
  readonly releaseProvenanceHash: Hash;
  readonly candidateReleaseCommit: string;
}

export interface FinalDurableWindowRuntimeAnchorV1 {
  readonly kind: "aloha.searcher-runtime-anchor-v1";
  readonly manifestHash: Hash;
  readonly manifestArtifactSha256: Hash;
  readonly bindingId: Hash;
  readonly releaseProvenanceHash: Hash;
  readonly candidateReleaseCommit: string;
  readonly runtimeArtifactRoot: Hash;
  readonly implementationClosureDigest: Hash;
  readonly entrypointSha256: Hash;
  readonly nodeExecutableSha256: Hash;
  readonly bundleModulePath: string;
  readonly bundleModuleSha256: Hash;
  readonly serviceName: string;
  readonly systemdUnit: string;
  readonly bootId: string;
  readonly invocationId: string;
  readonly logDevice: string;
  readonly logInode: string;
  readonly pid: string;
  readonly processStartTicks: string;
  readonly dryRun: true;
}

export interface FinalDurableWindowServingV1 {
  readonly generationId: string;
  readonly graphRoot: Hash;
  readonly readyRecordHash: Hash;
  readonly sourceCoverageRoot: Hash;
}

export interface FinalDurableWindowHeadV1 {
  readonly chainId: string;
  readonly number: string;
  readonly hash: Hash;
  readonly parentHash: Hash;
  readonly stateRoot: Hash;
}

export interface FinalDurableEventAppendBindingV1 {
  readonly namespace: string;
  readonly sequence: string;
  readonly eventId: Hash;
  readonly contentSha256: Hash;
  readonly byteLength: string;
  readonly offsetStart: string;
  readonly offsetEnd: string;
}

export interface FinalDurableWindowDraftV1 {
  readonly release: FinalDurableWindowReleaseV1;
  readonly runtimeAnchor: FinalDurableWindowRuntimeAnchorV1;
  readonly serving: FinalDurableWindowServingV1;
  readonly windowId: Hash;
  readonly targetCount: "100";
  readonly ordinal: "100";
  readonly head: FinalDurableWindowHeadV1;
  readonly revision: string;
  readonly terminalId: Hash;
  readonly terminalBindingRoot: Hash;
  readonly performanceFactStatus: "complete" | "incomplete";
  readonly performanceAppend: FinalDurableEventAppendBindingV1;
  readonly producerTerminalAppend: FinalDurableEventAppendBindingV1;
}

export interface FinalDurableWindowBindingV1 extends FinalDurableWindowDraftV1 {
  readonly kind: "aloha.final-durable-window-binding-v1";
  readonly finalDurableWindowId: Hash;
}

export type FinalDurableWindowCapabilityV1 = object;

export type TerminalPhaseInvalidReasonV1 =
  | "terminal-phase-process-anchor-changed"
  | "terminal-phase-current-source-moved";

export interface TerminalPhaseHeadObservationV1 {
  readonly head: FinalDurableWindowHeadV1;
  readonly journalEpoch: string;
  readonly canonicalJournalRoot: Hash;
  readonly observedMonotonicNs: string;
  readonly observationId: Hash;
}

export interface TerminalPhaseInvalidDraftV1 {
  readonly finalDurableWindowId: Hash;
  readonly reasonCode: TerminalPhaseInvalidReasonV1;
  readonly observed: TerminalPhaseHeadObservationV1 | null;
  readonly recordedMonotonicNs: string;
}

export interface TerminalPhaseInvalidFactV1 extends TerminalPhaseInvalidDraftV1 {
  readonly kind: "aloha.terminal-phase-invalid-v1";
  readonly factId: Hash;
}

/** Fixed read-only consumer. A replay DTO or structural clone cannot be
 * upgraded into terminal-phase authority. */
export function readFinalDurableWindowBindingV1(
  capability: FinalDurableWindowCapabilityV1,
): FinalDurableWindowBindingV1 {
  return readFinalDurableWindowBindingCapabilityV1(capability);
}

/** Fixed architecture-neutral decoder used by both the application replay
 * owner and independent observers. Self-consistent unknown bytes are never
 * accepted merely because they occupy the terminal-phase namespace. */
export function decodeTerminalPhaseInvalidFactV1(
  value: unknown,
): TerminalPhaseInvalidFactV1 {
  return decodeTerminalPhaseInvalidFactCapabilityV1(value);
}
