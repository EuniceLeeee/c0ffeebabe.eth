import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { deserialize, serialize } from "node:v8";
import {
  decodeCanonicalJson,
  encodeCanonicalBytes,
  encodeCanonicalJson,
  hashDomain,
  sha256Hex,
  type CanonicalJsonObject,
  type Hash,
} from "../../../canonical-codec/src/index.ts";
import {
  createReadOnlyArtifactRef,
  type ProcessAnchorV1,
  type ReadOnlyArtifactLocatorV1,
} from "../../../../specs/core-envelope/src/index.ts";
import {
  createArtifactResolutionClaim,
} from "../../../../specs/artifact-resolution/src/index.ts";
import type { CapabilityRefV1 } from "../../../../specs/evidence/src/index.ts";
import {
  decodeSixStepStageFacts,
  hashOrderedInstanceBindingsRoot,
  SIX_STEP_SCHEMA_MANIFESTS,
  type SixStepStageFactsV1,
  type SixStepStageId,
} from "../../../../specs/evidence/src/six-step.ts";
import type { ContentAddressedObserverSinkV1 } from "../../../../acceptance/collectors/src/content-addressed-sink.ts";
import {
  ProductionSixStepArtifactOwnerV1,
  issueProductionSixStepArtifactStoreV1,
} from "../../../evidence-emitter/src/internal/six-step-production-owner.ts";
import type { EvidenceAppendRequestV1 } from "../../../evidence-emitter/src/index.ts";
import type {
  ProductionSixStepArtifactMaterialV1,
  ProductionSixStepArtifactStoreV1,
  ProductionSixStepEmissionCapabilityV1,
  ProductionSixStepStableContextV1,
  ProductionSixStepStoredArtifactV1,
  ProductionSixStepWitnessCapabilityV1,
} from "../../../evidence-emitter/src/index.ts";
import {
  productionSixStepBoundaryKeyV1,
  readProductionSixStepArtifactMaterialV1,
  readProductionSixStepWitnessV1,
} from "../../../evidence-emitter/src/index.ts";
import type {
  CheckpointSixStepArtifactCapabilityV1,
  CheckpointSixStepArtifactPortV1,
  CheckpointSixStepReadyEdgeInputV1,
  CheckpointSixStepVerifiedOutcomeInputV1,
} from "../../../checkpoint/src/index.ts";
import { issueCheckpointSixStepArtifactPortV1 } from "../../../checkpoint/src/internal/six-step-artifact-port-owner.ts";
import type {
  ProductionSixStepStage12ParentCapabilitiesV1,
  ProductionSixStepTailEmissionPortV1,
  ResolvedRoutePipelineInputV1,
  RouteCapabilityV1,
  SearchStageTimingFactV1,
} from "../../../search-pipeline/src/index.ts";
import { issueProductionSixStepTailEmissionPortV1 } from "../../../search-pipeline/src/internal/six-step-tail-port-owner.ts";
import {
  issueStartupSixStepRouteParentInvocationV1,
  readStartupSixStepRouteParentInvocationMaterialV1,
  type StartupSixStepRouteParentCapabilityV1,
} from "../../../startup-runtime/src/internal/six-step-route-parent-owner.ts";

interface ProductionSixStepOwnerBindingV1 {
  readonly process: ProcessAnchorV1;
  readonly emitterCodeHash: Hash;
  readonly directory: string;
  readonly sink: ContentAddressedObserverSinkV1;
  readonly strategyCatalogRoot: Hash;
  readonly definitionCatalogRoot: Hash;
  readonly releaseProvenanceHash: Hash;
  readonly generationRefreshPolicyHash: Hash;
  readonly capabilities: readonly CapabilityRefV1[];
  readonly semanticConfigDigest: Hash;
  readonly resourceMetricsHash: Hash;
}

export interface RuntimeReleaseSixStepProductionInputV1 extends ProductionSixStepOwnerBindingV1 {
  /** Existing release-owned service identity. It is the only public lookup key
   * for the process-local tail authority. */
  readonly strategyRuntime: object;
}

export interface RuntimeReleaseSixStepProductionV1 {
  readonly checkpoint: CheckpointSixStepArtifactPortV1;
}

const productionByStrategyRuntime = new WeakMap<object, ProductionSixStepCompositionStateV1>();
let temporarySequence = 0;

function canonicalObject(value: unknown, path: string): CanonicalJsonObject {
  try {
    const canonical = decodeCanonicalJson(encodeCanonicalBytes(value));
    if (canonical === null || typeof canonical !== "object" || Array.isArray(canonical)) {
      throw new TypeError(`${path} must be a canonical object`);
    }
    return canonical as CanonicalJsonObject;
  } catch (error) {
    throw new TypeError(`${path} is not canonical: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function same(left: unknown, right: unknown): boolean {
  return encodeCanonicalJson(left) === encodeCanonicalJson(right);
}

function concreteDirectory(value: string): string {
  if (typeof value !== "string" || value.includes("\0") || !value.startsWith("/") || resolve(value) !== value) {
    throw new TypeError("production Six-Step directory must be canonical and absolute");
  }
  mkdirSync(value, { recursive: true, mode: 0o700 });
  const observed = statSync(value, { bigint: true });
  if (!observed.isDirectory() || observed.isSymbolicLink()) throw new TypeError("production Six-Step directory is not physical");
  return value;
}

function safePath(directory: string, name: string): string {
  const path = join(directory, name);
  if (dirname(path) !== directory || basename(path) !== name) throw new TypeError("production Six-Step path escaped its directory");
  return path;
}

function syncDirectory(directory: string): void {
  const fd = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

class NativeSixStepEvidenceLogV1 {
  readonly #fd: number;
  readonly #systemId: string;
  readonly #bootIdHash: Hash;
  readonly device: string;
  readonly inode: string;
  #nextEventSequence: bigint;

  constructor(directory: string, process: ProcessAnchorV1) {
    const path = safePath(directory, "evidence.jsonl");
    this.#fd = openSync(
      path,
      constants.O_CREAT | constants.O_RDWR | constants.O_APPEND | constants.O_NOFOLLOW,
      0o600,
    );
    const stat = fstatSync(this.#fd, { bigint: true });
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n) {
      closeSync(this.#fd);
      throw new TypeError("production Six-Step evidence log is not a physical file");
    }
    this.device = stat.dev.toString();
    this.inode = stat.ino.toString();
    this.#systemId = process.systemId;
    this.#bootIdHash = process.bootIdHash;
    this.#nextEventSequence = this.#recoverSequence(stat.size);
  }

  #recoverSequence(size: bigint): bigint {
    if (size === 0n) return 0n;
    if (size > BigInt(Number.MAX_SAFE_INTEGER)) throw new TypeError("production Six-Step evidence log is too large to recover");
    const bytes = Buffer.alloc(Number(size));
    let offset = 0;
    while (offset < bytes.byteLength) {
      const read = readSync(this.#fd, bytes, offset, bytes.byteLength - offset, offset);
      if (read === 0) throw new TypeError("production Six-Step evidence log truncated during recovery");
      offset += read;
    }
    if (bytes[bytes.byteLength - 1] !== 0x0a) throw new TypeError("production Six-Step evidence log has an incomplete record");
    let events = 0n;
    for (const line of bytes.toString("utf8").split("\n").slice(0, -1)) {
      const value = decodeCanonicalJson(line);
      if (value !== null && typeof value === "object" && !Array.isArray(value)
        && (value as Record<string, unknown>).kind === "aloha.evidence-event") {
        events += 1n;
      }
    }
    return events;
  }

  get initialSequence(): string {
    return this.#nextEventSequence.toString();
  }

  #assertIdentity(): bigint {
    const stat = fstatSync(this.#fd, { bigint: true });
    if (!stat.isFile() || stat.dev.toString() !== this.device || stat.ino.toString() !== this.inode) {
      throw new TypeError("production Six-Step evidence log identity changed");
    }
    return stat.size;
  }

  #appendRecord(bytes: Uint8Array): Readonly<{ readonly start: string; readonly end: string }> {
    const start = this.#assertIdentity();
    const record = Buffer.concat([Buffer.from(bytes), Buffer.from("\n")]);
    const written = writeSync(this.#fd, record);
    if (written !== record.byteLength) throw new TypeError("production Six-Step evidence log append was partial");
    fsyncSync(this.#fd);
    const finalSize = this.#assertIdentity();
    if (finalSize !== start + BigInt(record.byteLength)) throw new TypeError("production Six-Step evidence log offset changed");
    return Object.freeze({ start: start.toString(), end: (start + BigInt(bytes.byteLength)).toString() });
  }

  appendNative(bytes: Uint8Array): ReadOnlyArtifactLocatorV1 {
    const range = this.#appendRecord(bytes);
    return Object.freeze({
      kind: "file-range",
      systemId: this.#systemId,
      bootIdHash: this.#bootIdHash,
      device: this.device,
      inode: this.inode,
      startInclusive: range.start,
      endExclusive: range.end,
    });
  }

  readonly append = Object.freeze({
    appendFsyncMonotonic: async (request: EvidenceAppendRequestV1) => {
      if (request.sequence !== this.#nextEventSequence.toString()) {
        throw new TypeError("production Six-Step evidence sequence is not monotonic");
      }
      if (sha256Hex(request.bytes) !== request.contentSha256) {
        throw new TypeError("production Six-Step evidence content hash mismatch");
      }
      const range = this.#appendRecord(request.bytes);
      this.#nextEventSequence += 1n;
      return Object.freeze({
        sequence: request.sequence,
        eventId: request.eventId,
        contentSha256: request.contentSha256,
        byteLength: String(request.bytes.byteLength),
        offsetStart: range.start,
        offsetEnd: range.end,
        fsynced: true as const,
      });
    },
  });
}

class DurableProductionSixStepStoreV1 implements ProductionSixStepArtifactStoreV1 {
  readonly #sink: ContentAddressedObserverSinkV1;
  readonly #boundaryDirectory: string;

  constructor(sink: ContentAddressedObserverSinkV1, directory: string) {
    this.#sink = sink;
    this.#boundaryDirectory = concreteDirectory(join(directory, "boundaries"));
  }

  async seal(input: Parameters<ProductionSixStepArtifactStoreV1["seal"]>[0]): Promise<ProductionSixStepStoredArtifactV1> {
    if (input.schema === null) throw new TypeError("production Six-Step artifact schema is required");
    const observed = await this.#sink.write({
      bytes: Uint8Array.from(input.bytes),
      mediaType: input.mediaType,
      schema: input.schema,
    });
    const ref = createReadOnlyArtifactRef({
      locator: input.locator,
      immutableMirrorLocator: observed.ref.immutableMirrorLocator,
      contentSha256: observed.contentSha256,
      byteLength: observed.ref.byteLength,
      mediaType: input.mediaType,
      schema: input.schema,
      resolverPolicyHash: observed.ref.resolverPolicyHash,
      retentionLeaseReceiptId: observed.lease.receiptId,
    });
    if (observed.claim.observedMirror === null) throw new TypeError("release-owned observer sink did not return a mirror");
    const claim = createArtifactResolutionClaim({
      artifactRefId: ref.artifactRefId,
      resolverPolicyHash: ref.resolverPolicyHash,
      observedMirror: observed.claim.observedMirror,
      outcome: "content-observed",
    });
    return Object.freeze({ bytes: Uint8Array.from(observed.bytes), ref, claim, lease: observed.lease });
  }

  #path(boundaryKey: Hash): string {
    if (!/^0x[0-9a-f]{64}$/.test(boundaryKey)) throw new TypeError("production Six-Step boundary key is invalid");
    return safePath(this.#boundaryDirectory, `${boundaryKey.slice(2)}.v8`);
  }

  async loadBoundary(boundaryKey: Hash): Promise<ProductionSixStepArtifactMaterialV1 | null> {
    const path = this.#path(boundaryKey);
    let fd: number;
    try {
      fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    try {
      const stat = fstatSync(fd, { bigint: true });
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n || stat.size > 64n * 1024n * 1024n) {
        throw new TypeError("production Six-Step boundary material is not an immutable physical file");
      }
      const bytes = Buffer.alloc(Number(stat.size));
      let offset = 0;
      while (offset < bytes.byteLength) {
        const read = readSync(fd, bytes, offset, bytes.byteLength - offset, offset);
        if (read === 0) throw new TypeError("production Six-Step boundary material was truncated");
        offset += read;
      }
      return deserialize(bytes) as ProductionSixStepArtifactMaterialV1;
    } finally {
      closeSync(fd);
    }
  }

  async persistBoundary(boundaryKey: Hash, material: ProductionSixStepArtifactMaterialV1): Promise<void> {
    if (material.boundaryKey !== boundaryKey) throw new TypeError("production Six-Step boundary persistence key mismatch");
    const destination = this.#path(boundaryKey);
    const temporary = safePath(
      this.#boundaryDirectory,
      `.${boundaryKey.slice(2)}.${process.pid}.${temporarySequence++}.tmp`,
    );
    let fd: number | null = null;
    try {
      fd = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o400);
      const bytes = serialize(material);
      const written = writeSync(fd, bytes);
      if (written !== bytes.byteLength) throw new TypeError("production Six-Step boundary persistence was partial");
      fsyncSync(fd);
      closeSync(fd);
      fd = null;
      try {
        linkSync(temporary, destination);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const existing = await this.loadBoundary(boundaryKey);
        if (existing === null || existing.boundaryFingerprint !== material.boundaryFingerprint) {
          throw new TypeError("production Six-Step durable boundary conflicts with an existing record");
        }
      }
      syncDirectory(this.#boundaryDirectory);
    } finally {
      if (fd !== null) closeSync(fd);
      try { unlinkSync(temporary); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }
}

function sourceAnchorHash(cutoff: Readonly<{ chainId: string; number: string; hash: Hash; stateRoot: Hash }>): Hash {
  return hashDomain("aloha/production-six-step-source-anchor/v1", cutoff);
}

function stageId(ordinal: 1 | 2 | 3 | 4 | 5 | 6): SixStepStageId {
  return ([
    "universe_instance",
    "edge_ready_generation",
    "planner_consumption",
    "current_source_exact",
    "execution_program",
    "final_simulation",
  ] as const)[ordinal - 1];
}

class ProductionSixStepCompositionStateV1 {
  readonly #binding: ProductionSixStepOwnerBindingV1;
  readonly #log: NativeSixStepEvidenceLogV1;
  readonly #store: ProductionSixStepArtifactStoreV1;
  readonly #owner: ProductionSixStepArtifactOwnerV1;
  readonly #stage1PublicationWitnesses = new WeakMap<object, ProductionSixStepWitnessCapabilityV1>();
  readonly #stage12ByStage3 = new WeakMap<object, ProductionSixStepStage12ParentCapabilitiesV1>();
  readonly #singleFlight = new Map<Hash, Promise<ProductionSixStepEmissionCapabilityV1>>();

  constructor(binding: ProductionSixStepOwnerBindingV1) {
    this.#binding = binding;
    const directory = concreteDirectory(binding.directory);
    this.#log = new NativeSixStepEvidenceLogV1(directory, binding.process);
    this.#store = issueProductionSixStepArtifactStoreV1(new DurableProductionSixStepStoreV1(binding.sink, directory));
    this.#owner = new ProductionSixStepArtifactOwnerV1({
      process: binding.process,
      emitterCodeHash: binding.emitterCodeHash,
      evidenceLog: { device: this.#log.device, inode: this.#log.inode },
      append: this.#log.append,
      store: this.#store,
      initialAppendSequence: this.#log.initialSequence,
    });
  }

  #context(input: Readonly<{
    scope: ProductionSixStepStableContextV1["scope"];
    correlationId: string;
    runSequence: string;
    cutoff: Readonly<{ chainId: string; number: string; hash: Hash; stateRoot: Hash }>;
    definitionCatalogRoot: Hash;
    instanceCatalogRoot: Hash | null;
    graphRoot: Hash | null;
    familyId: string;
    candidateKey: string;
    familyDefinitionHash: Hash;
    instanceKey: string | null;
  }>): ProductionSixStepStableContextV1 {
    return Object.freeze({
      scope: input.scope,
      correlationId: input.correlationId,
      runSequence: input.runSequence,
      cutoff: Object.freeze({ number: input.cutoff.number, hash: input.cutoff.hash, stateRoot: input.cutoff.stateRoot }),
      definitionCatalogRoot: input.definitionCatalogRoot,
      strategyCatalogRoot: input.scope.kind === "producer-session" ? this.#binding.strategyCatalogRoot : null,
      instanceCatalogRoot: input.instanceCatalogRoot,
      graphRoot: input.graphRoot,
      familyId: input.familyId,
      candidateKey: input.candidateKey,
      familyDefinitionHash: input.familyDefinitionHash,
      capabilities: this.#binding.capabilities,
      instanceKey: input.instanceKey,
      sourceAnchorHash: sourceAnchorHash(input.cutoff),
      semanticConfigDigest: this.#binding.semanticConfigDigest,
      resourceMetricsHash: this.#binding.resourceMetricsHash,
    });
  }

  async #witness(stage: SixStepStageId, role: string, payload: unknown): Promise<ProductionSixStepWitnessCapabilityV1> {
    const canonical = canonicalObject(payload, `production Six-Step ${stage}.${role}`);
    const bytes = encodeCanonicalBytes({ schemaVersion: 1, kind: "aloha.six-step-evidence-witness", stageId: stage, role, payload: canonical });
    return this.#owner.sealWitness({
      artifactKey: hashDomain("aloha/production-six-step-witness-key/v1", { stage, role, payload: canonical }),
      stageId: stage,
      role,
      payload: canonical,
      locator: {
        kind: "content-object",
        storeIdentityHash: this.#binding.sink.storeIdentityHash,
        objectKey: sha256Hex(bytes),
      },
    });
  }

  async #emit(input: Readonly<{
    context: ProductionSixStepStableContextV1;
    ordinal: 1 | 2 | 3 | 4 | 5 | 6;
    facts: SixStepStageFactsV1;
    witnesses: readonly ProductionSixStepWitnessCapabilityV1[];
    parents: readonly ProductionSixStepEmissionCapabilityV1[];
    rawPayload: unknown;
    timing: Readonly<{ startedMonotonicNs: string; finishedMonotonicNs: string }>;
    outcome: "verified" | "success";
  }>): Promise<ProductionSixStepEmissionCapabilityV1> {
    const parentEventIds = input.parents.map(parent => readProductionSixStepArtifactMaterialV1(parent).event.eventId);
    const boundaryKey = productionSixStepBoundaryKeyV1({
      context: input.context,
      stage: { ordinal: input.ordinal, id: stageId(input.ordinal), version: 1 },
      facts: input.facts,
      parentEventIds,
    });
    let pending = this.#singleFlight.get(boundaryKey);
    if (pending !== undefined) return pending;
    pending = (async () => {
      if (await this.#store.loadBoundary(boundaryKey) !== null) return this.#owner.reopenBoundary(boundaryKey);
      const stage = stageId(input.ordinal);
      const rawPayload = canonicalObject(input.rawPayload, `production Six-Step ${stage} raw boundary`);
      const rawBytes = encodeCanonicalBytes({
        schemaVersion: 1,
        kind: "aloha.six-step-native-boundary-record",
        stageId: stage,
        role: "raw-boundary",
        payload: rawPayload,
      });
      const rawBoundary = await this.#owner.sealArtifact({
        artifactKey: hashDomain("aloha/production-six-step-raw-boundary/v1", { boundaryKey, payload: rawPayload }),
        bytes: rawBytes,
        locator: {
          kind: "content-object",
          storeIdentityHash: this.#binding.sink.storeIdentityHash,
          objectKey: sha256Hex(rawBytes),
        },
        mediaType: "application/json",
        schema: {
          id: SIX_STEP_SCHEMA_MANIFESTS.nativeBoundaryRecord.id,
          version: SIX_STEP_SCHEMA_MANIFESTS.nativeBoundaryRecord.version,
          schemaHash: SIX_STEP_SCHEMA_MANIFESTS.nativeBoundaryRecord.schemaHash,
        },
      });
      const logBytes = encodeCanonicalBytes({
        schemaVersion: 1,
        kind: "aloha.six-step-native-boundary-record",
        stageId: stage,
        role: "native-log",
        payload: { boundaryKey, rawBoundaryContentSha256: sha256Hex(rawBytes) },
      });
      const logRange = await this.#owner.sealArtifact({
        artifactKey: hashDomain("aloha/production-six-step-native-log/v1", { boundaryKey, contentSha256: sha256Hex(logBytes) }),
        bytes: logBytes,
        locator: this.#log.appendNative(logBytes),
        mediaType: "application/json",
        schema: {
          id: SIX_STEP_SCHEMA_MANIFESTS.nativeBoundaryRecord.id,
          version: SIX_STEP_SCHEMA_MANIFESTS.nativeBoundaryRecord.version,
          schemaHash: SIX_STEP_SCHEMA_MANIFESTS.nativeBoundaryRecord.schemaHash,
        },
      });
      return this.#owner.emitStage({
        context: input.context,
        stage: { ordinal: input.ordinal, id: stage, version: 1 },
        facts: decodeSixStepStageFacts(input.facts),
        outcome: input.outcome,
        reasonCode: null,
        startedMonotonicNs: input.timing.startedMonotonicNs,
        finishedMonotonicNs: input.timing.finishedMonotonicNs,
        rawBoundary,
        logRange,
        witnesses: input.witnesses,
        parents: input.parents,
      });
    })();
    this.#singleFlight.set(boundaryKey, pending);
    try {
      return await pending;
    } finally {
      if (this.#singleFlight.get(boundaryKey) === pending) this.#singleFlight.delete(boundaryKey);
    }
  }

  readonly checkpoint = issueCheckpointSixStepArtifactPortV1({
    emitVerifiedOutcome: async (input: CheckpointSixStepVerifiedOutcomeInputV1) => {
      const publication = await this.#witness("universe_instance", "instance-publication", input.outcome.publication);
      const witnesses = Object.freeze([
        await this.#witness("universe_instance", "candidate-partition", {
          runId: input.runId,
          candidatePartitionRoot: input.candidatePartitionRoot,
          candidate: input.candidate,
        }),
        publication,
        await this.#witness("universe_instance", "identity-proof", input.outcome.identityProof),
        await this.#witness("universe_instance", "source-coverage", input.sourceCoverage),
      ]);
      const facts: SixStepStageFactsV1 = {
        schemaVersion: 1,
        kind: "aloha.six-step-stage-facts",
        stageId: "universe_instance",
        candidatePartition: readProductionSixStepWitnessV1(witnesses[0]!),
        instancePublication: readProductionSixStepWitnessV1(witnesses[1]!),
        identityProof: readProductionSixStepWitnessV1(witnesses[2]!),
        sourceCoverage: readProductionSixStepWitnessV1(witnesses[3]!),
      };
      const proofSequence = BigInt(input.outcome.identityProof.sequence);
      const result = await this.#emit({
        context: this.#context({
          scope: {
            kind: "builder-run",
            builderRunId: input.runId,
            producerSessionId: null,
            generationId: null,
            generationRefreshPolicyHash: this.#binding.generationRefreshPolicyHash,
          },
          correlationId: input.outcome.runCandidateKey,
          runSequence: (proofSequence * 2n).toString(),
          cutoff: input.cutoff,
          definitionCatalogRoot: this.#binding.definitionCatalogRoot,
          instanceCatalogRoot: null,
          graphRoot: null,
          familyId: input.candidate.familyId,
          candidateKey: input.candidate.familyCandidateKey,
          familyDefinitionHash: input.candidate.familyDefinitionHash,
          instanceKey: input.outcome.instanceKey,
        }),
        ordinal: 1,
        facts,
        witnesses,
        parents: [],
        rawPayload: { runId: input.runId, candidate: input.candidate, outcome: input.outcome },
        timing: { startedMonotonicNs: input.outcome.identityProof.sequence, finishedMonotonicNs: (BigInt(input.outcome.identityProof.sequence) + 1n).toString() },
        outcome: "verified",
      });
      this.#stage1PublicationWitnesses.set(result, publication);
      return result as CheckpointSixStepArtifactCapabilityV1;
    },
    emitReadyEdge: async (input: CheckpointSixStepReadyEdgeInputV1) => {
      const parent = input.parent as ProductionSixStepEmissionCapabilityV1;
      const publication = this.#stage1PublicationWitnesses.get(parent);
      if (publication === undefined) throw new TypeError("production Six-Step Stage 1 publication witness is unavailable");
      const origin = input.outcome.identityProof.identityOrigin as Readonly<{ readonly kind: string }>;
      const mode = origin.kind === "verified-memo-reuse" ? "memo-reuse" as const : "fresh" as const;
      const witnesses = Object.freeze([
        publication,
        await this.#witness("edge_ready_generation", "edge", input.edge),
        await this.#witness("edge_ready_generation", "coverage", {
          sourceCoverage: input.sourceCoverage,
          sourceCoverageRoot: input.ready.sourceCoverageRoot,
        }),
        await this.#witness("edge_ready_generation", "memo-reuse-proof", input.outcome.identityProof.identityOrigin),
      ]);
      const facts: SixStepStageFactsV1 = {
        schemaVersion: 1,
        kind: "aloha.six-step-stage-facts",
        stageId: "edge_ready_generation",
        instancePublication: readProductionSixStepWitnessV1(witnesses[0]!),
        edge: readProductionSixStepWitnessV1(witnesses[1]!),
        coverage: readProductionSixStepWitnessV1(witnesses[2]!),
        promotionRevision: input.ready.promotionRevision,
        generationId: input.ready.generationId,
        attestationMode: mode,
        memoReuseProof: readProductionSixStepWitnessV1(witnesses[3]!),
      };
      const parentMaterial = readProductionSixStepArtifactMaterialV1(parent);
      const context = this.#context({
        scope: {
          kind: "ready-generation",
          builderRunId: parentMaterial.event.scope.builderRunId,
          producerSessionId: null,
          generationId: input.ready.generationId,
          generationRefreshPolicyHash: input.ready.generationRefreshPolicyHash,
        },
        correlationId: parentMaterial.event.correlationId,
        runSequence: (BigInt(parentMaterial.event.runSequence) + 1n).toString(),
        cutoff: input.ready.cutoff,
        definitionCatalogRoot: input.ready.definitionCatalogRoot,
        instanceCatalogRoot: input.ready.instanceCatalogRoot,
        graphRoot: input.ready.graphRoot,
        familyId: input.candidate.familyId,
        candidateKey: input.candidate.familyCandidateKey,
        familyDefinitionHash: input.candidate.familyDefinitionHash,
        instanceKey: input.publication.instanceKey,
      });
      return this.#emit({
        context,
        ordinal: 2,
        facts,
        witnesses,
        parents: [parent],
        rawPayload: { ready: input.ready, publication: input.publication, edge: input.edge },
        timing: {
          startedMonotonicNs: input.ready.promotedAtMonotonicNs,
          finishedMonotonicNs: (BigInt(input.ready.promotedAtMonotonicNs) + 1n).toString(),
        },
        outcome: "success",
      }) as Promise<CheckpointSixStepArtifactCapabilityV1>;
    },
  });

  tail(routeParents: StartupSixStepRouteParentCapabilityV1): ProductionSixStepTailEmissionPortV1 {
    const emitTail = async (
      ordinal: 3 | 4 | 5 | 6,
      pipeline: ResolvedRoutePipelineInputV1,
      route: RouteCapabilityV1,
      payload: CanonicalJsonObject,
      timing: SearchStageTimingFactV1,
      parents: readonly ProductionSixStepEmissionCapabilityV1[],
    ) => {
      const roles = ordinal === 3
        ? ["route-set", "coarse-projection", "admission-receipt"]
        : ordinal === 4
          ? ["exact-output"]
          : ordinal === 5
            ? ["program", "pre-calls", "observation-pairs", "action-owner"]
            : ["final-simulation-receipt", "economic-receipt", "safety-receipt"];
      const stage = stageId(ordinal);
      const rolePayloads = (payload.rolePayloads as unknown as readonly CanonicalJsonObject[] | undefined) ?? roles.map(role => ({ role, payload }));
      if (rolePayloads.length !== roles.length) throw new TypeError(`production Six-Step Stage ${ordinal} witness payload denominator mismatch`);
      const witnesses = await Promise.all(roles.map((role, index) => this.#witness(stage, role, rolePayloads[index]!)));
      const witnessRefs = witnesses.map(readProductionSixStepWitnessV1);
      let facts: SixStepStageFactsV1;
      if (ordinal === 3) {
        const materials = parents.map(readProductionSixStepArtifactMaterialV1);
        const bindings = materials.map((material, index) => {
          const parentFacts = decodeSixStepStageFacts(material.event.facts);
          if (parentFacts.stageId !== "edge_ready_generation" || material.event.instanceKey === null) {
            throw new TypeError(`production Six-Step route parent ${index} is not Stage 2`);
          }
          return Object.freeze({
            edgeId: route.legs[index]!.edgeId,
            instanceKey: material.event.instanceKey,
            stage1EventId: material.event.parentEventIds[0]!,
            stage2EventId: material.event.eventId,
            instancePublicationRoot: parentFacts.instancePublication.contentRoot,
          });
        });
        facts = {
          schemaVersion: 1,
          kind: "aloha.six-step-stage-facts",
          stageId: "planner_consumption",
          orderedInstanceBindings: bindings,
          orderedInstanceBindingsRoot: hashOrderedInstanceBindingsRoot(bindings),
          routeSet: witnessRefs[0]!,
          coarseProjection: witnessRefs[1]!,
          admissionReceipt: witnessRefs[2]!,
          admissionClass: payload.admissionClass === "ranked" ? "ranked" : "bounded-unranked",
        };
      } else if (ordinal === 4) {
        facts = {
          schemaVersion: 1,
          kind: "aloha.six-step-stage-facts",
          stageId: "current_source_exact",
          currentSource: { ...pipeline.currentSource.source, hash: pipeline.currentSource.source.hash as Hash, stateRoot: pipeline.currentSource.source.stateRoot as Hash },
          exactOutput: witnessRefs[0]!,
          fallback: false,
        };
      } else if (ordinal === 5) {
        facts = {
          schemaVersion: 1,
          kind: "aloha.six-step-stage-facts",
          stageId: "execution_program",
          program: witnessRefs[0]!,
          callerMode: String(payload.callerMode),
          preCalls: witnessRefs[1]!,
          observationPairs: witnessRefs[2]!,
          actionOwner: witnessRefs[3]!,
          fallback: false,
        };
      } else {
        facts = {
          schemaVersion: 1,
          kind: "aloha.six-step-stage-facts",
          stageId: "final_simulation",
          finalSimulationReceipt: witnessRefs[0]!,
          simulationSourceAnchor: { ...pipeline.currentSource.source, hash: pipeline.currentSource.source.hash as Hash, stateRoot: pipeline.currentSource.source.stateRoot as Hash },
          economicReceipt: witnessRefs[1]!,
          safetyReceipt: witnessRefs[2]!,
          dryRun: true,
        };
      }
      const firstParent = readProductionSixStepArtifactMaterialV1(parents[0]!);
      const context = this.#context({
        scope: {
          kind: "producer-session",
          builderRunId: firstParent.event.scope.builderRunId,
          producerSessionId: pipeline.currentSource.sessionId,
          generationId: pipeline.lease.binding.generationId,
          generationRefreshPolicyHash: pipeline.lease.binding.generationRefreshPolicyHash,
        },
        correlationId: pipeline.correlationId,
        runSequence: ordinal.toString(),
        cutoff: pipeline.lease.binding.cutoff,
        definitionCatalogRoot: pipeline.lease.binding.definitionCatalogRoot,
        instanceCatalogRoot: pipeline.lease.binding.instanceCatalogRoot,
        graphRoot: pipeline.lease.binding.graphRoot,
        familyId: ordinal === 3 ? firstParent.event.familyId : firstParent.event.familyId,
        candidateKey: pipeline.routeCandidateId,
        familyDefinitionHash: firstParent.event.familyDefinitionHash,
        instanceKey: route.legs[0]?.ownerRef ?? null,
      });
      return this.#emit({ context, ordinal, facts, witnesses, parents, rawPayload: payload, timing, outcome: "success" });
    };

    return issueProductionSixStepTailEmissionPortV1({
      emitPlanner: async ({ pipeline, route, coarse, planned, timing }) => {
        const invocation = issueStartupSixStepRouteParentInvocationV1(routeParents, {
          lease: pipeline.lease,
          binding: pipeline.lease.binding,
          orderedEdgeIds: pipeline.orderedEdgeIds,
        });
        const opaque = readStartupSixStepRouteParentInvocationMaterialV1(invocation);
        const stage1 = Object.freeze([...opaque.stage1] as ProductionSixStepEmissionCapabilityV1[]);
        const stage2 = Object.freeze([...opaque.stage2] as ProductionSixStepEmissionCapabilityV1[]);
        if (stage1.length === 0 || stage1.length !== route.legs.length || stage2.length !== route.legs.length) {
          throw new TypeError("production Six-Step route parent denominator is incomplete");
        }
        const cutoff = pipeline.lease.binding.cutoff;
        for (const [index, parent] of stage2.entries()) {
          const material = readProductionSixStepArtifactMaterialV1(parent);
          const stage1Material = readProductionSixStepArtifactMaterialV1(stage1[index]!);
          if (material.event.stage.ordinal !== 2
            || material.event.scope.kind !== "ready-generation"
            || material.event.scope.generationId !== pipeline.lease.binding.generationId
            || material.event.graphRoot !== pipeline.lease.binding.graphRoot
            || material.event.instanceCatalogRoot !== pipeline.lease.binding.instanceCatalogRoot
            || material.event.definitionCatalogRoot !== pipeline.lease.binding.definitionCatalogRoot
            || material.event.cutoff.number !== cutoff.number
            || material.event.cutoff.hash !== cutoff.hash
            || material.event.cutoff.stateRoot !== cutoff.stateRoot
            || material.event.parentEventIds.length !== 1
            || material.event.parentEventIds[0] !== stage1Material.event.eventId
            || stage1Material.event.cutoff.number !== cutoff.number
            || stage1Material.event.cutoff.hash !== cutoff.hash
            || stage1Material.event.cutoff.stateRoot !== cutoff.stateRoot) {
            throw new TypeError(`production Six-Step Stage 2 route parent ${index} changed Ready scope/generation/graph/cutoff`);
          }
        }
        const admissionClass = (coarse as Readonly<{ readonly kind?: string }>).kind === "rankable" ? "ranked" : "bounded-unranked";
        const payload = canonicalObject({
          routeCandidateId: pipeline.routeCandidateId,
          orderedEdgeIds: pipeline.orderedEdgeIds,
          routeHash: route.routeHash,
          routeBindingHash: route.routeBindingHash,
          coarse,
          planned,
          admissionClass,
          rolePayloads: [
            { routeCandidateId: pipeline.routeCandidateId, orderedEdgeIds: pipeline.orderedEdgeIds, routeHash: route.routeHash },
            { coarse },
            { planned, admissionClass },
          ],
        }, "production Six-Step Stage 3 payload");
        const stage3 = await emitTail(3, pipeline, route, payload, timing, stage2);
        this.#stage12ByStage3.set(stage3, Object.freeze({ stage1, stage2 }));
        return stage3;
      },
      emitExact: async ({ parent, pipeline, route, exact, timing }) => emitTail(4, pipeline, route, canonicalObject({ exact, rolePayloads: [{ exact }] }, "production Six-Step Stage 4 payload"), timing, [parent]),
      emitExecutionProgram: async ({ parent, pipeline, route, program, ownerEvidence, timing }) => {
        const facts = canonicalObject(ownerEvidence.facts, "production Six-Step execution owner facts");
        return emitTail(5, pipeline, route, canonicalObject({
          program,
          ownerEvidence,
          callerMode: facts.callerMode,
          rolePayloads: [
            { program },
            { preCalls: facts.preCalls },
            { observationPairs: facts.observationPairs },
            { actionOwners: facts.actionOwners },
          ],
        }, "production Six-Step Stage 5 payload"), timing, [parent]);
      },
      emitFinalSimulation: async ({ parent, pipeline, route, program, simulation, ownerEvidence, economicSafety, timing }) => emitTail(6, pipeline, route, canonicalObject({
        program,
        simulation,
        ownerEvidence,
        economicSafety,
        rolePayloads: [
          { simulation, ownerEvidence },
          { economic: economicSafety.economic },
          { safety: economicSafety.safety },
        ],
      }, "production Six-Step Stage 6 payload"), timing, [parent]),
      readStage12Parents: stage3 => {
        const parents = this.#stage12ByStage3.get(stage3);
        if (parents === undefined) throw new TypeError("production Six-Step Stage 3 capability was not issued by this lease authority");
        return parents;
      },
    });
  }
}

export function issueRuntimeReleaseSixStepProductionV1(
  input: RuntimeReleaseSixStepProductionInputV1,
): RuntimeReleaseSixStepProductionV1 {
  if (input.strategyRuntime === null || typeof input.strategyRuntime !== "object") {
    throw new TypeError("runtime-release Six-Step Strategy service is required");
  }
  if (productionByStrategyRuntime.has(input.strategyRuntime)) {
    throw new TypeError("runtime-release Six-Step production authority was already issued");
  }
  const state = new ProductionSixStepCompositionStateV1(Object.freeze({
    process: input.process,
    emitterCodeHash: input.emitterCodeHash,
    directory: input.directory,
    sink: input.sink,
    strategyCatalogRoot: input.strategyCatalogRoot,
    definitionCatalogRoot: input.definitionCatalogRoot,
    releaseProvenanceHash: input.releaseProvenanceHash,
    generationRefreshPolicyHash: input.generationRefreshPolicyHash,
    capabilities: Object.freeze([...input.capabilities]),
    semanticConfigDigest: input.semanticConfigDigest,
    resourceMetricsHash: input.resourceMetricsHash,
  }));
  productionByStrategyRuntime.set(input.strategyRuntime, state);
  return Object.freeze({ checkpoint: state.checkpoint });
}

export function readRuntimeReleaseSixStepTailEmissionPortV1(
  strategyRuntime: object,
  routeParents: StartupSixStepRouteParentCapabilityV1,
): ProductionSixStepTailEmissionPortV1 {
  const state = productionByStrategyRuntime.get(strategyRuntime);
  if (state === undefined) throw new TypeError("runtime-release Six-Step production authority was not issued");
  return state.tail(routeParents);
}
