import {
  assertExactKeys,
  assertGitSha40,
  assertHash,
  decodeCanonicalJson,
  encodeCanonicalBytes,
  encodeCanonicalJson,
  hashDomain,
  sha256Hex,
  type Hash,
} from "../../../packages/canonical-codec/src/index.ts";
import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import {
  assertIssuedCheckpointStore,
  type CheckpointProbeEvidenceV1,
  type CheckpointRuntimeRestartSnapshotV1,
  type CheckpointStore,
} from "../../../packages/checkpoint/src/index.ts";
import {
  readStartupStage12Evidence,
  verifyStartupStage12Evidence,
  type StartupRuntimeV1,
} from "../../../packages/startup-runtime/src/index.ts";
import {
  createSqliteDurableStore,
  type SQLiteDurableStore,
} from "../../../packages/durable-store/src/index.ts";
import { candidateFinalOutcomeHash } from "../../../packages/attestation/src/index.ts";
import { decodeReleaseIntent } from "../../../specs/release-intent/src/index.ts";
import { hashProcessAnchor, type ProcessAnchorV1 } from "../../../specs/core-envelope/src/index.ts";
import { decodeDeploymentManifestV1, type RuntimeAnchorReceiptV1 } from "./deployment.ts";

const STORE_ROLE = "searcher-production-evidence";
const NAMESPACE_PREFIX = "runtime-acceptance-process-v1";
const EVENT_DOMAIN = "aloha/runtime-acceptance-process-event/v1";
const PRE_RELEASE_ENTRYPOINT_PATH = "/var/lib/aloha/pre-release/artifacts/pre-release-owner.mjs";

interface ReleaseIdentityV1 {
  readonly bindingId: Hash;
  readonly releaseProvenanceHash: Hash;
  readonly candidateReleaseCommit: string;
}

interface StaticArtifactFactsV1 {
  readonly phaseManifest: Readonly<{
    readonly kind: "production-deployment-manifest" | "pre-release-staging-manifest";
    readonly contentSha256: Hash;
    readonly byteLength: string;
    readonly semanticRoot: Hash;
    readonly processCommandSha256: Hash;
  }>;
  readonly releaseIntent: Readonly<{ readonly contentSha256: Hash; readonly byteLength: string; readonly releaseIntentRoot: Hash }>;
  readonly systemdUnit: Readonly<{ readonly contentSha256: Hash; readonly byteLength: string }>;
  readonly releaseEnvironment: Readonly<{ readonly contentSha256: Hash; readonly byteLength: string }>;
}

export interface RuntimeAcceptanceProcessEventV1 extends Readonly<Record<string, unknown>> {
  readonly schemaVersion: 1;
  readonly kind: "aloha.runtime-process-ready" | "aloha.runtime-sigterm-observed" | "aloha.runtime-sigterm-drained";
  readonly sequence: string;
  readonly release: ReleaseIdentityV1;
  readonly processAnchorHash: Hash;
  readonly eventId: Hash;
}

export interface PreReleaseRestartTerminalV1 extends Readonly<Record<string, unknown>> {
  readonly schemaVersion: 1;
  readonly kind: "aloha.pre-release-restart-terminal";
  readonly sequence: "0";
  readonly release: ReleaseIdentityV1;
  readonly stagingArtifactSetRoot: Hash;
  readonly stagingManifestRoot: Hash;
  readonly authorizationId: Hash;
  readonly authorizationClaimId: Hash;
  readonly processReadyEventId: Hash;
  readonly sigtermObservedEventId: Hash;
  readonly sigtermDrainedEventId: Hash;
  readonly processReadyContentSha256: Hash;
  readonly sigtermObservedContentSha256: Hash;
  readonly sigtermDrainedContentSha256: Hash;
  readonly processAnchorHash: Hash;
  readonly evidenceStore: Readonly<{ readonly path: string; readonly device: string; readonly inode: string }>;
  readonly checkpointStore: Readonly<{ readonly path: string; readonly device: string; readonly inode: string }>;
  readonly checkpointRevision: string;
  readonly checkpointRootEnvelopeHash: Hash;
  readonly runId: string;
  readonly cutoff: unknown;
  readonly candidatePartitionRoot: Hash;
  readonly outcomePartitionRoot: Hash;
  readonly flushedOutcomeHashes: readonly Hash[];
  readonly terminalId: Hash;
}

export type ProductionRuntimeAcceptanceEvidenceOwnerV1 = object;

interface OwnerInputV1 {
  readonly databasePath: string;
  readonly release: ReleaseIdentityV1;
  readonly runtimeAnchor: RuntimeEvidenceAnchorV1;
  readonly checkpoint: CheckpointStore;
  readonly strategy: Readonly<{
    readonly definitionCatalogRoot: Hash;
    readonly strategyCatalogRoot: Hash;
    readonly releaseProvenanceHash: Hash;
    readonly compositionRoot: Hash;
  }>;
  readonly phaseManifest:
    | Readonly<{ readonly kind: "production"; readonly bytes: Uint8Array }>
    | Readonly<{ readonly kind: "pre-release"; readonly bytes: Uint8Array; readonly semanticRoot: Hash }>;
  readonly releaseIntentBytes: Uint8Array;
  readonly systemdUnitBytes: Uint8Array;
  readonly releaseEnvironmentBytes: Uint8Array;
  readonly logPath: string;
}

type RuntimeEvidenceAnchorV1 = Pick<RuntimeAnchorReceiptV1,
  | "bindingId" | "releaseProvenanceHash" | "candidateReleaseCommit" | "nodeExecutableSha256"
  | "serviceName" | "systemdUnit" | "bootId" | "invocationId" | "logDevice" | "logInode"
  | "pid" | "processStartTicks"> & Readonly<{ readonly kind: string }>;

function canonicalClone<T>(value: T): T {
  return decodeCanonicalJson(encodeCanonicalBytes(value)) as T;
}

function sameCanonical(left: unknown, right: unknown): boolean {
  return Buffer.from(encodeCanonicalBytes(left)).equals(Buffer.from(encodeCanonicalBytes(right)));
}

function exactRelease(value: ReleaseIdentityV1, path: string): ReleaseIdentityV1 {
  assertExactKeys(value, ["bindingId", "releaseProvenanceHash", "candidateReleaseCommit"], path);
  return Object.freeze({
    bindingId: assertHash(value.bindingId, `${path}.bindingId`),
    releaseProvenanceHash: assertHash(value.releaseProvenanceHash, `${path}.releaseProvenanceHash`),
    candidateReleaseCommit: assertGitSha40(value.candidateReleaseCommit, `${path}.candidateReleaseCommit`),
  });
}

function concreteBytes(value: Uint8Array, path: string): Uint8Array {
  if (!(value instanceof Uint8Array) || Object.getPrototypeOf(value) !== Uint8Array.prototype) {
    throw new TypeError(`${path} must be a concrete Uint8Array`);
  }
  return Uint8Array.from(value);
}

function artifact(bytes: Uint8Array): Readonly<{ readonly contentSha256: Hash; readonly byteLength: string }> {
  return Object.freeze({ contentSha256: sha256Hex(bytes), byteLength: String(bytes.byteLength) });
}

function withoutEventId(value: RuntimeAcceptanceProcessEventV1): Readonly<Record<string, unknown>> {
  const { eventId: _eventId, ...payload } = value;
  return payload;
}

function eventId(value: Omit<RuntimeAcceptanceProcessEventV1, "eventId">): Hash {
  return hashDomain(EVENT_DOMAIN, value as never);
}

function decodeStoredEvent(value: unknown, expectedRelease: ReleaseIdentityV1): RuntimeAcceptanceProcessEventV1 {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError("runtime acceptance event must be an object");
  const record = value as RuntimeAcceptanceProcessEventV1;
  const common = ["schemaVersion", "kind", "sequence", "release", "processAnchorHash", "eventId"];
  const fields = record.kind === "aloha.runtime-process-ready"
      ? [...common, "runtimeAnchor", "staticArtifacts", "strategy", "checkpointRoot", "checkpointStore", "stage12", "checkpointProbeEvidence", "processAnchor", "logStart"]
    : record.kind === "aloha.runtime-sigterm-observed"
      ? [...common, "processReadyEventId", "checkpointRootBefore", "checkpointRestartBefore", "outcomePartitionRootBefore", "outcomeHashesBefore"]
      : record.kind === "aloha.runtime-sigterm-drained"
        ? [...common, "sigtermObservedEventId", "checkpointRootAfter", "checkpointRestartAfter", "outcomePartitionRootAfter", "outcomeHashesAfter", "flushedOutcomeHashes", "logWindow"]
        : [];
  if (fields.length === 0) throw new TypeError("runtime acceptance event kind is invalid");
  assertExactKeys(record, fields, "runtimeAcceptanceEvent");
  if (record.schemaVersion !== 1 || !/^(0|[1-9][0-9]*)$/.test(record.sequence)) throw new TypeError("runtime acceptance event header is invalid");
  if (!sameCanonical(exactRelease(record.release, "runtimeAcceptanceEvent.release"), expectedRelease)) throw new TypeError("runtime acceptance event release mismatch");
  assertHash(record.processAnchorHash, "runtimeAcceptanceEvent.processAnchorHash");
  const observedId = assertHash(record.eventId, "runtimeAcceptanceEvent.eventId");
  if (observedId !== hashDomain(EVENT_DOMAIN, withoutEventId(record) as never)) throw new TypeError("runtime acceptance event id mismatch");
  return canonicalClone(record);
}

class OwnerStateV1 {
  readonly #store: SQLiteDurableStore;
  readonly #release: ReleaseIdentityV1;
  readonly #runtimeAnchor: RuntimeEvidenceAnchorV1;
  readonly #processAnchorHash: Hash;
  readonly #processAnchor: ProcessAnchorV1;
  readonly #checkpoint: CheckpointStore;
  readonly #strategy: OwnerInputV1["strategy"];
  readonly #staticArtifacts: StaticArtifactFactsV1;
  readonly #namespace: string;
  readonly #logPath: string;
  readonly #systemId: string;
  readonly #logStart: Readonly<{ readonly device: string; readonly inode: string; readonly startInclusive: string }>;
  #processReadyEventId: Hash | null = null;
  #closed = false;

  constructor(input: OwnerInputV1) {
    assertExactKeys(input, [
      "databasePath", "release", "runtimeAnchor", "checkpoint", "strategy",
      "phaseManifest", "releaseIntentBytes", "systemdUnitBytes", "releaseEnvironmentBytes", "logPath",
    ], "runtimeAcceptanceOwner");
    if (typeof input.databasePath !== "string" || !input.databasePath.startsWith("/")) throw new TypeError("runtime acceptance database path must be absolute");
    this.#release = exactRelease(input.release, "runtimeAcceptanceOwner.release");
    this.#namespace = `${NAMESPACE_PREFIX}:${this.#release.releaseProvenanceHash.slice(2)}`;
    this.#checkpoint = assertIssuedCheckpointStore(input.checkpoint);
    const runtimeAnchor = canonicalClone(input.runtimeAnchor);
    if (runtimeAnchor.bindingId !== this.#release.bindingId
      || runtimeAnchor.releaseProvenanceHash !== this.#release.releaseProvenanceHash
      || runtimeAnchor.candidateReleaseCommit !== this.#release.candidateReleaseCommit) {
      throw new TypeError("runtime acceptance process anchor release mismatch");
    }
    this.#runtimeAnchor = runtimeAnchor;
    const strategy = canonicalClone(input.strategy);
    assertExactKeys(strategy, ["definitionCatalogRoot", "strategyCatalogRoot", "releaseProvenanceHash", "compositionRoot"], "runtimeAcceptanceOwner.strategy");
    assertHash(strategy.definitionCatalogRoot, "runtimeAcceptanceOwner.strategy.definitionCatalogRoot");
    assertHash(strategy.strategyCatalogRoot, "runtimeAcceptanceOwner.strategy.strategyCatalogRoot");
    assertHash(strategy.compositionRoot, "runtimeAcceptanceOwner.strategy.compositionRoot");
    if (strategy.releaseProvenanceHash !== this.#release.releaseProvenanceHash) throw new TypeError("runtime acceptance strategy release mismatch");
    this.#strategy = strategy;
    if (typeof input.logPath !== "string" || !input.logPath.startsWith("/") || realpathSync(input.logPath) !== input.logPath || !lstatSync(input.logPath).isFile()) {
      throw new TypeError("runtime acceptance log path is not a canonical regular file");
    }
    const log = statSync(input.logPath, { bigint: true });
    if (String(log.dev) !== runtimeAnchor.logDevice || String(log.ino) !== runtimeAnchor.logInode) {
      throw new TypeError("runtime acceptance log identity mismatch");
    }
    this.#logPath = input.logPath;
    // Bind the process/log lineage to the independently observed boot rather
    // than opening a second host-identity source here.  Production obtains
    // bootId from the system runtime observer; this also keeps the fact owner
    // portable to non-systemd test hosts without accepting a caller systemId.
    this.#systemId = hashDomain("aloha/runtime-system-boot-identity/v1", runtimeAnchor.bootId);
    this.#logStart = Object.freeze({ device: String(log.dev), inode: String(log.ino), startInclusive: String(log.size) });
    if (input.phaseManifest === null || typeof input.phaseManifest !== "object") {
      throw new TypeError("runtime acceptance phase manifest is required");
    }
    const releaseIntentBytes = concreteBytes(input.releaseIntentBytes, "runtimeAcceptanceOwner.releaseIntentBytes");
    const systemdUnitBytes = concreteBytes(input.systemdUnitBytes, "runtimeAcceptanceOwner.systemdUnitBytes");
    const releaseEnvironmentBytes = concreteBytes(input.releaseEnvironmentBytes, "runtimeAcceptanceOwner.releaseEnvironmentBytes");
    const releaseIntent = decodeReleaseIntent(decodeCanonicalJson(releaseIntentBytes));
    let phaseManifest: StaticArtifactFactsV1["phaseManifest"];
    if (input.phaseManifest.kind === "production") {
      assertExactKeys(input.phaseManifest, ["kind", "bytes"], "runtimeAcceptanceOwner.phaseManifest");
      const bytes = concreteBytes(input.phaseManifest.bytes, "runtimeAcceptanceOwner.phaseManifest.bytes");
      const manifest = decodeDeploymentManifestV1(decodeCanonicalJson(bytes));
      if (manifest.bindingId !== this.#release.bindingId
        || manifest.releaseProvenanceHash !== this.#release.releaseProvenanceHash
        || manifest.candidateReleaseCommit !== this.#release.candidateReleaseCommit
        || manifest.searcherRuntimeNodeExecutableSha256 !== this.#runtimeAnchor.nodeExecutableSha256
        || manifest.systemdUnit !== this.#runtimeAnchor.systemdUnit) {
        throw new TypeError("runtime acceptance deployment manifest anchor mismatch");
      }
      phaseManifest = Object.freeze({
        kind: "production-deployment-manifest",
        ...artifact(bytes),
        semanticRoot: manifest.manifestHash,
        processCommandSha256: manifest.processCommandSha256,
      });
    } else if (input.phaseManifest.kind === "pre-release") {
      assertExactKeys(input.phaseManifest, ["kind", "bytes", "semanticRoot"], "runtimeAcceptanceOwner.phaseManifest");
      const bytes = concreteBytes(input.phaseManifest.bytes, "runtimeAcceptanceOwner.phaseManifest.bytes");
      const semanticRoot = assertHash(input.phaseManifest.semanticRoot, "runtimeAcceptanceOwner.phaseManifest.semanticRoot");
      const manifestValue = decodeCanonicalJson(bytes);
      if (manifestValue === null || typeof manifestValue !== "object" || Array.isArray(manifestValue)) {
        throw new TypeError("runtime acceptance pre-release manifest must be a canonical object");
      }
      const manifest = manifestValue as Readonly<Record<string, unknown>>;
      const recomputedRoot = hashDomain("aloha/pre-release-staging-manifest/root/v1", {
        contentSha256: sha256Hex(bytes),
        byteLength: String(bytes.byteLength),
      });
      if (semanticRoot !== recomputedRoot
        || manifest.runtimeBindingId !== this.#release.bindingId
        || manifest.releaseProvenanceHash !== this.#release.releaseProvenanceHash
        || manifest.candidateReleaseCommit !== this.#release.candidateReleaseCommit
        || manifest.searcherRuntimeNodeExecutableSha256 !== this.#runtimeAnchor.nodeExecutableSha256
        || manifest.systemdUnit !== this.#runtimeAnchor.systemdUnit) {
        throw new TypeError("runtime acceptance pre-release staging manifest anchor mismatch");
      }
      phaseManifest = Object.freeze({
        kind: "pre-release-staging-manifest",
        ...artifact(bytes),
        semanticRoot,
        processCommandSha256: sha256Hex(Buffer.from([
          "/usr/bin/node",
          PRE_RELEASE_ENTRYPOINT_PATH,
          "",
        ].join("\0"))),
      });
    } else {
      throw new TypeError("runtime acceptance phase manifest kind is invalid");
    }
    this.#staticArtifacts = Object.freeze({
      phaseManifest,
      releaseIntent: Object.freeze({ ...artifact(releaseIntentBytes), releaseIntentRoot: releaseIntent.releaseIntentRoot }),
      systemdUnit: artifact(systemdUnitBytes),
      releaseEnvironment: artifact(releaseEnvironmentBytes),
    });
    this.#processAnchor = Object.freeze({
      systemId: this.#systemId,
      commitSha: this.#release.candidateReleaseCommit,
      executableHash: this.#runtimeAnchor.nodeExecutableSha256,
      deploymentManifestHash: this.#staticArtifacts.phaseManifest.semanticRoot,
      serviceIdentityHash: hashDomain("aloha/runtime-service-identity/v1", {
        serviceName: this.#runtimeAnchor.serviceName,
        systemdUnit: this.#runtimeAnchor.systemdUnit,
        bindingId: this.#release.bindingId,
      }),
      pid: this.#runtimeAnchor.pid,
      processStartTicks: this.#runtimeAnchor.processStartTicks,
      bootIdHash: hashDomain("aloha/runtime-boot-id/v1", this.#runtimeAnchor.bootId),
    });
    this.#processAnchorHash = hashProcessAnchor(this.#processAnchor);
    this.#store = createSqliteDurableStore(input.databasePath);
    try {
      this.#store.bindStoreRole(STORE_ROLE);
      for (const record of this.#store.readAppendLog(this.#namespace)) {
        const decoded = decodeStoredEvent(decodeCanonicalJson(record.bytes), this.#release);
        if (decoded.sequence !== record.sequence || decoded.eventId !== record.eventId || sha256Hex(record.bytes) !== record.contentSha256) {
          throw new TypeError("runtime acceptance durable append binding mismatch");
        }
        if (decoded.kind === "aloha.runtime-process-ready") this.#processReadyEventId = decoded.eventId;
      }
    } catch (error) {
      this.#store.close();
      throw error;
    }
  }

  #assertOpen(): void {
    if (this.#closed) throw new TypeError("runtime acceptance evidence owner is closed");
  }

  #append(payload: Omit<RuntimeAcceptanceProcessEventV1, "eventId">): RuntimeAcceptanceProcessEventV1 {
    this.#assertOpen();
    const event = canonicalClone({ ...payload, eventId: eventId(payload) }) as RuntimeAcceptanceProcessEventV1;
    const bytes = encodeCanonicalBytes(event);
    const receipt = this.#store.appendFsyncMonotonic({
      namespace: this.#namespace,
      sequence: event.sequence,
      eventId: event.eventId,
      contentSha256: sha256Hex(bytes),
      bytes,
    });
    if (receipt.fsynced !== true) throw new TypeError("runtime acceptance event was not fsynced");
    return decodeStoredEvent(event, this.#release);
  }

  async #writeLogMarker(event: RuntimeAcceptanceProcessEventV1): Promise<void> {
    const line = `${encodeCanonicalJson({
      schemaVersion: 1,
      kind: "aloha.runtime-process-log-marker",
      eventKind: event.kind,
      eventId: event.eventId,
      processAnchorHash: event.processAnchorHash,
      releaseProvenanceHash: this.#release.releaseProvenanceHash,
      sequence: event.sequence,
    })}\n`;
    await new Promise<void>((resolve, reject) => {
      process.stdout.write(line, error => error ? reject(error) : resolve());
    });
  }

  async recordProcessReady(startup: StartupRuntimeV1): Promise<RuntimeAcceptanceProcessEventV1> {
    this.#assertOpen();
    const observed = await readStartupStage12Evidence(startup);
    const stage12 = await verifyStartupStage12Evidence(startup, observed);
    if (stage12.binding.releaseProvenanceHash !== this.#release.releaseProvenanceHash
      || startup.releaseBindingId !== this.#release.bindingId
      || startup.candidateReleaseCommit !== this.#release.candidateReleaseCommit
      || startup.generationId !== stage12.binding.generationId
      || startup.graphRoot !== stage12.binding.graphRoot) {
      throw new TypeError("runtime process-ready Stage 1/2 binding mismatch");
    }
    const checkpointRoot = await this.#checkpoint.loadAndValidateRoot();
    if (checkpointRoot.readyGenerationId !== stage12.binding.generationId
      || checkpointRoot.readyGenerationRecordHash !== stage12.binding.readyRecordHash) {
      throw new TypeError("runtime process-ready checkpoint root mismatch");
    }
    const sequence = this.#store.readAppendLog(this.#namespace).length.toString();
    const event = this.#append({
      schemaVersion: 1,
      kind: "aloha.runtime-process-ready",
      sequence,
      release: this.#release,
      processAnchorHash: this.#processAnchorHash,
      runtimeAnchor: this.#runtimeAnchor,
      staticArtifacts: this.#staticArtifacts,
      strategy: this.#strategy,
      checkpointRoot,
      checkpointStore: this.#checkpoint.loadRuntimeStoreAnchor(),
      stage12,
      checkpointProbeEvidence: this.#checkpoint.loadLatestProbeEvidence() as CheckpointProbeEvidenceV1 | null,
      processAnchor: this.#processAnchor,
      logStart: { ...this.#logStart, path: this.#logPath, systemId: this.#systemId },
    } as never);
    this.#processReadyEventId = event.eventId;
    await this.#writeLogMarker(event);
    return event;
  }

  async recordSigtermObserved(): Promise<RuntimeAcceptanceProcessEventV1> {
    this.#assertOpen();
    if (this.#processReadyEventId === null) throw new TypeError("SIGTERM observation requires current process-ready evidence");
    const checkpointRootBefore = await this.#checkpoint.loadAndValidateRoot();
    const checkpointRestartBefore = await this.#checkpoint.loadRuntimeRestartSnapshot();
    if (checkpointRestartBefore.checkpointRevision !== checkpointRootBefore.revision
      || checkpointRestartBefore.runId !== checkpointRootBefore.inProgressRunId) {
      throw new TypeError("runtime SIGTERM checkpoint snapshot is not the observed root");
    }
    const outcomeHashesBefore = checkpointRestartBefore.outcomes.map(candidateFinalOutcomeHash).sort();
    const event = this.#append({
      schemaVersion: 1,
      kind: "aloha.runtime-sigterm-observed",
      sequence: this.#store.readAppendLog(this.#namespace).length.toString(),
      release: this.#release,
      processAnchorHash: this.#processAnchorHash,
      processReadyEventId: this.#processReadyEventId,
      checkpointRootBefore,
      checkpointRestartBefore,
      outcomePartitionRootBefore: checkpointRestartBefore.outcomePartitionRoot,
      outcomeHashesBefore,
    } as never);
    await this.#writeLogMarker(event);
    return event;
  }

  async recordSigtermDrained(observed: RuntimeAcceptanceProcessEventV1): Promise<RuntimeAcceptanceProcessEventV1> {
    this.#assertOpen();
    if (observed.kind !== "aloha.runtime-sigterm-observed" || observed.processAnchorHash !== this.#processAnchorHash) {
      throw new TypeError("SIGTERM drain requires this owner's observed signal event");
    }
    const checkpointRootAfter = await this.#checkpoint.loadAndValidateRoot();
    const checkpointRestartAfter = await this.#checkpoint.loadRuntimeRestartSnapshot();
    if (checkpointRestartAfter.checkpointRevision !== checkpointRootAfter.revision
      || checkpointRestartAfter.runId !== checkpointRootAfter.inProgressRunId) {
      throw new TypeError("runtime SIGTERM drained snapshot is not the observed root");
    }
    const beforeSnapshot = (observed as Record<string, unknown>).checkpointRestartBefore as CheckpointRuntimeRestartSnapshotV1;
    if (checkpointRestartAfter.runId !== beforeSnapshot.runId
      || checkpointRestartAfter.candidatePartitionRoot !== beforeSnapshot.candidatePartitionRoot
      || encodeCanonicalJson(checkpointRestartAfter.cutoff) !== encodeCanonicalJson(beforeSnapshot.cutoff)) {
      throw new TypeError("runtime SIGTERM changed run, cutoff, or candidate partition while draining");
    }
    const outcomeHashesAfter = checkpointRestartAfter.outcomes.map(candidateFinalOutcomeHash).sort();
    // The shutdown proof covers the complete FULL-sync partition at the drain
    // boundary, not only rows that happened to be appended after signal
    // delivery.  The fresh process must recover this exact entire set.
    const flushedOutcomeHashes = [...outcomeHashesAfter];
    const logBefore = statSync(this.#logPath, { bigint: true });
    const logBytes = new Uint8Array(readFileSync(this.#logPath));
    const logAfter = statSync(this.#logPath, { bigint: true });
    if (logBefore.dev !== logAfter.dev || logBefore.ino !== logAfter.ino || logBefore.size !== logAfter.size
      || String(logAfter.dev) !== this.#logStart.device || String(logAfter.ino) !== this.#logStart.inode
      || BigInt(this.#logStart.startInclusive) > logAfter.size) {
      throw new TypeError("runtime SIGTERM log changed while observed");
    }
    const startBigInt = BigInt(this.#logStart.startInclusive);
    if (startBigInt > BigInt(Number.MAX_SAFE_INTEGER) || logAfter.size > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new TypeError("runtime SIGTERM log range exceeds the exact byte-offset denominator");
    }
    const start = Number(startBigInt);
    const end = Number(logAfter.size);
    const range = logBytes.slice(start, end);
    const logWindow = range.byteLength === 0 ? null : Object.freeze({
      systemId: this.#systemId,
      bootIdHash: hashDomain("aloha/runtime-boot-id/v1", this.#runtimeAnchor.bootId),
      device: this.#logStart.device,
      inode: this.#logStart.inode,
      startInclusive: this.#logStart.startInclusive,
      endExclusive: String(end),
      contentSha256: sha256Hex(range),
    });
    return this.#append({
      schemaVersion: 1,
      kind: "aloha.runtime-sigterm-drained",
      sequence: this.#store.readAppendLog(this.#namespace).length.toString(),
      release: this.#release,
      processAnchorHash: this.#processAnchorHash,
      sigtermObservedEventId: observed.eventId,
      checkpointRootAfter,
      checkpointRestartAfter,
      outcomePartitionRootAfter: checkpointRestartAfter.outcomePartitionRoot,
      outcomeHashesAfter,
      flushedOutcomeHashes,
      logWindow,
    } as never);
  }

  readEvents(): readonly RuntimeAcceptanceProcessEventV1[] {
    this.#assertOpen();
    return Object.freeze(this.#store.readAppendLog(this.#namespace).map(record => decodeStoredEvent(decodeCanonicalJson(record.bytes), this.#release)));
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#store.close();
  }
}

const owners = new WeakMap<object, OwnerStateV1>();

function state(value: ProductionRuntimeAcceptanceEvidenceOwnerV1): OwnerStateV1 {
  if (value === null || typeof value !== "object") throw new TypeError("runtime acceptance evidence owner is invalid");
  const owner = owners.get(value);
  if (owner === undefined) throw new TypeError("runtime acceptance evidence owner was not issued");
  return owner;
}

export function issueProductionRuntimeAcceptanceEvidenceOwnerV1(input: OwnerInputV1): ProductionRuntimeAcceptanceEvidenceOwnerV1 {
  const token = Object.freeze(Object.create(null));
  owners.set(token, new OwnerStateV1(input));
  return token;
}

export function recordProductionRuntimeProcessReadyV1(owner: ProductionRuntimeAcceptanceEvidenceOwnerV1, startup: StartupRuntimeV1): Promise<RuntimeAcceptanceProcessEventV1> {
  return state(owner).recordProcessReady(startup);
}

export interface ProductionRuntimeSigtermBindingV1 {
  readonly task: () => Promise<void> | null;
  readonly uninstall: () => void;
}

/** Register the actual process SIGTERM listener. No public method can mint a
 * signal event or turn an ordinary stop into SIGTERM evidence. */
export function installProductionRuntimeSigtermEvidenceV1(input: Readonly<{
  readonly owner: ProductionRuntimeAcceptanceEvidenceOwnerV1;
  readonly stop: () => Promise<void>;
}>): ProductionRuntimeSigtermBindingV1 {
  assertExactKeys(input, ["owner", "stop"], "runtimeSigtermEvidence");
  const ownerState = state(input.owner);
  if (typeof input.stop !== "function") throw new TypeError("runtime SIGTERM stop owner is required");
  let task: Promise<void> | null = null;
  const handler = (): void => {
    if (task !== null) return;
    task = (async () => {
      let observed: RuntimeAcceptanceProcessEventV1 | null = null;
      let observationError: unknown = null;
      try {
        observed = await ownerState.recordSigtermObserved();
      } catch (error) {
        observationError = error;
      }
      let stopError: unknown = null;
      try {
        await input.stop();
      } catch (error) {
        stopError = error;
      }
      if (observationError !== null || stopError !== null) {
        if (observationError !== null && stopError !== null) {
          throw new AggregateError([observationError, stopError], "SIGTERM evidence observation and runtime stop both failed");
        }
        throw observationError ?? stopError;
      }
      if (observed === null) throw new TypeError("SIGTERM observation was not produced");
      await ownerState.recordSigtermDrained(observed);
    })();
    // The service `done` owner joins the original task and propagates its
    // rejection. Attach an immediate observer so a fast evidence failure is
    // never reported as an unhandled rejection before that join occurs.
    void task.catch(() => undefined);
  };
  process.once("SIGTERM", handler);
  return Object.freeze({
    task: () => task,
    uninstall: () => process.off("SIGTERM", handler),
  });
}

export function readProductionRuntimeAcceptanceEventsV1(owner: ProductionRuntimeAcceptanceEvidenceOwnerV1): readonly RuntimeAcceptanceProcessEventV1[] {
  return state(owner).readEvents();
}

export function closeProductionRuntimeAcceptanceEvidenceV1(owner: ProductionRuntimeAcceptanceEvidenceOwnerV1): void {
  state(owner).close();
}
