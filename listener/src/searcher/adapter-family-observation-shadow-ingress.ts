import type {
  AdapterGenerationFence,
  CentralAdapterRuntime,
} from "./adapter-work-intent.js";
import {
  advanceDiscoveryFamilySourceWatermarks,
  createDiscoveryFamilySourceWatermarks,
  discoveryFamilySourceKey,
  type DiscoveryFamilySources,
  type DiscoveryRange,
} from "./discovery-source-watermark.js";
import type { FamilyId } from
  "./venues/adapter-family-identifiers.js";
import type {
  DiscoverySourceKind,
  FamilyDomain,
  UnifiedObservation,
} from "./venues/adapter-family-plugin.js";
import type { CanonicalSource } from
  "./venues/adapter-request-program.js";
import {
  hashCanonical,
  type CanonicalValue,
} from "./venues/canonical-value.js";
import {
  executeAdapterFamilyLifecycleBatch,
  executeCreditFamilyInstanceLifecycle,
  type AdapterFamilyPublication,
  type AdapterInstanceOutcome,
  type FamilyLifecycleMatch,
} from "./venues/adapter-family-runtime.js";
import {
  type FamilyCapabilityCatalog,
  type LoadedFamilyBox,
  type LoadedFamilyPlugin,
} from "./venues/family-capability-catalog.js";

export type AdapterFamilyShadowScanMode =
  | "contiguous"
  | "positive-only"
  | "snapshot";

export type AdapterFamilyShadowAddressObservation = Extract<
  UnifiedObservation,
  { readonly kind: "address-surface" }
>;

export interface AdapterFamilyShadowSourceScanInput {
  readonly sourceId: DiscoverySourceKind;
  readonly mode: AdapterFamilyShadowScanMode;
  readonly status: "complete" | "partial";
  readonly source: CanonicalSource;
  readonly range: DiscoveryRange;
  readonly observations: readonly UnifiedObservation[];
}

export interface AdapterFamilyShadowIncumbentNomination {
  readonly incumbentKey: string;
  readonly address: string;
  readonly currentSurface: AdapterFamilyShadowAddressObservation | null;
}

export interface AdapterFamilyShadowFamilyInventoryInput {
  readonly familyId: FamilyId;
  readonly inventoryKeys: readonly string[];
  readonly inventoryCount: number;
  readonly inventoryHash: string;
  readonly incumbents: readonly AdapterFamilyShadowIncumbentNomination[];
}

export interface AdapterFamilyShadowBootstrapInput {
  readonly inventoryMode: "complete-snapshot" | "partial";
  readonly source: CanonicalSource;
  readonly range: DiscoveryRange;
  readonly families: readonly AdapterFamilyShadowFamilyInventoryInput[];
}

export interface AdapterFamilyShadowWatermarkSeedInput {
  readonly familyId: FamilyId;
  readonly sourceId: DiscoverySourceKind;
  /**
   * A process-local input issuer is not a durable checkpoint authority. It may
   * restore an observation cursor, but never negative/completeness authority.
   */
  readonly coverageAuthority: "append-only";
  readonly completeThroughBlock: number;
  readonly completeThroughHash: string | null;
}

export type AdapterFamilyShadowCoverageKind =
  | "append-only"
  | "contiguous-history"
  | "snapshot";

export interface AdapterFamilyShadowWatermarkSnapshot {
  readonly familyId: FamilyId;
  readonly sourceId: DiscoverySourceKind;
  readonly coverageAuthority: AdapterFamilyShadowCoverageKind;
  readonly completeThroughBlock: number;
  readonly completeThroughHash: string | null;
}

declare const shadowInputAuthorityBrand: unique symbol;
export interface AdapterFamilyShadowInputAuthority {
  readonly [shadowInputAuthorityBrand]: true;
}

declare const shadowScanReceiptBrand: unique symbol;
export interface AdapterFamilyShadowSourceScanReceipt {
  readonly [shadowScanReceiptBrand]: true;
}

declare const shadowBootstrapReceiptBrand: unique symbol;
export interface AdapterFamilyShadowBootstrapReceipt {
  readonly [shadowBootstrapReceiptBrand]: true;
}

declare const shadowWatermarkSeedBrand: unique symbol;
export interface AdapterFamilyShadowWatermarkSeed {
  readonly [shadowWatermarkSeedBrand]: true;
}

export interface AdapterFamilyShadowInputIssuer {
  readonly authority: AdapterFamilyShadowInputAuthority;
  sealSourceScan(
    input: AdapterFamilyShadowSourceScanInput,
  ): AdapterFamilyShadowSourceScanReceipt;
  sealBootstrap(
    input: AdapterFamilyShadowBootstrapInput,
  ): AdapterFamilyShadowBootstrapReceipt;
  sealWatermarkSeed(
    input: AdapterFamilyShadowWatermarkSeedInput,
  ): AdapterFamilyShadowWatermarkSeed;
}

declare const shadowAncestryAuthorityBrand: unique symbol;
export interface AdapterFamilyShadowAncestryAuthority {
  readonly [shadowAncestryAuthorityBrand]: true;
}

declare const shadowAncestryProofBrand: unique symbol;
export interface AdapterFamilyShadowAncestryProof {
  readonly [shadowAncestryProofBrand]: true;
}

export interface AdapterFamilyShadowAncestryIssuer {
  readonly authority: AdapterFamilyShadowAncestryAuthority;
  issue(input: {
    readonly previous: {
      readonly number: number;
      readonly hash: string;
    };
    readonly current: CanonicalSource;
    readonly status: "canonical-descendant" | "unresolved";
    readonly evidenceRef: string;
  }): AdapterFamilyShadowAncestryProof;
}

export interface AdapterFamilyShadowReattestationInput {
  readonly family: LoadedFamilyBox;
  readonly sourceId: DiscoverySourceKind;
  readonly source: CanonicalSource;
  readonly subjectKey: string;
  readonly candidateKeys: readonly string[];
  readonly matches: readonly FamilyLifecycleMatch[];
}

export interface AdapterFamilyShadowReattestationResult {
  readonly familyId: FamilyId;
  readonly sourceId: DiscoverySourceKind;
  readonly source: CanonicalSource;
  readonly subjectKey: string;
  readonly candidateTerminalKeys: readonly string[];
  readonly outcomes: readonly AdapterInstanceOutcome[];
  readonly admittedInstanceKeys: readonly string[];
  readonly publicationFingerprints: readonly string[];
}

export interface AdapterFamilyShadowReattestor {
  reattest(
    input: AdapterFamilyShadowReattestationInput,
  ): Promise<AdapterFamilyShadowReattestationResult>;
}

export interface AdapterFamilyShadowCandidateResult {
  readonly origin: "scan" | "bootstrap";
  readonly subjectKey: string;
  readonly familyId: FamilyId;
  readonly sourceId: DiscoverySourceKind;
  readonly candidateKey: string;
  readonly matchCount: number;
  readonly status: "terminal" | "partial";
  readonly outcomes: readonly AdapterInstanceOutcome[];
  readonly admittedInstanceKeys: readonly string[];
  readonly publicationFingerprints: readonly string[];
}

export type AdapterFamilyShadowBootstrapStatus =
  | "reattested"
  | "reattest-partial"
  | "missing-current-surface"
  | "family-has-no-address-surface"
  | "surface-not-matched";

export interface AdapterFamilyShadowBootstrapResult {
  readonly incumbentKey: string;
  readonly familyId: FamilyId;
  readonly address: string;
  readonly status: AdapterFamilyShadowBootstrapStatus;
}

export interface AdapterFamilyShadowBootstrapFamilyResult {
  readonly familyId: FamilyId;
  readonly inventoryKeys: readonly string[];
  readonly inventoryCount: number;
  readonly inventoryHash: string;
  readonly status: "resolved" | "partial";
}

export interface AdapterFamilyShadowFamilyResult {
  readonly familyId: FamilyId;
  readonly domain: FamilyDomain;
  readonly status: "resolved" | "partial" | "not-applicable";
  readonly sourceIdsCompleteThisRound: readonly DiscoverySourceKind[];
}

/**
 * Shadow diagnostic evidence only. Deliberately not structurally compatible
 * with CatalogDiscoverySourceAnchor: no field in this projection can grant
 * complete-snapshot omission or deletion authority.
 */
export interface AdapterFamilyShadowSourceCoverage {
  readonly familyId: FamilyId;
  readonly sourceId: DiscoverySourceKind;
  readonly coverageFingerprint: string;
  readonly coverageKind: AdapterFamilyShadowCoverageKind;
  readonly status: "complete" | "partial";
  readonly completeThroughBlock: number;
  readonly completeThroughHash: string | null;
}

export interface AdapterFamilyObservationShadowIssue {
  readonly code:
    | "source-not-declared"
    | "candidate-decode"
    | "candidate-key"
    | "reattest-threw"
    | "reattest-invalid-result";
  readonly familyId: FamilyId;
  readonly sourceId: DiscoverySourceKind;
  readonly subjectKey: string;
  readonly detail: string;
}

export interface AdapterFamilyObservationShadowRound {
  readonly authority: "shadow-only";
  readonly status: "shadow-complete" | "shadow-partial";
  readonly chainId: string;
  readonly catalogHash: string;
  readonly sourceRegistryFingerprint: string;
  readonly source: CanonicalSource;
  readonly ranges: readonly {
    readonly sourceId: DiscoverySourceKind;
    readonly range: DiscoveryRange;
  }[];
  readonly familyResults: readonly AdapterFamilyShadowFamilyResult[];
  readonly candidateResults: readonly AdapterFamilyShadowCandidateResult[];
  readonly sourceCoverage: readonly AdapterFamilyShadowSourceCoverage[];
  readonly bootstrap: {
    readonly status: "complete" | "partial" | "not-run";
    readonly families: readonly AdapterFamilyShadowBootstrapFamilyResult[];
    readonly incumbents: readonly AdapterFamilyShadowBootstrapResult[];
  };
  readonly issues: readonly AdapterFamilyObservationShadowIssue[];
}

interface InputBinding {
  readonly chainId: string;
  readonly catalogHash: string;
  readonly sourceRegistryFingerprint: string;
}

interface SourceScanRecord extends AdapterFamilyShadowSourceScanInput {
  readonly authority: AdapterFamilyShadowInputAuthority;
}

interface BootstrapFamilyRecord {
  readonly familyId: FamilyId;
  readonly inventoryKeys: readonly string[];
  readonly inventoryCount: number;
  readonly inventoryHash: string;
  readonly incumbents: readonly AdapterFamilyShadowIncumbentNomination[];
}

interface BootstrapRecord {
  readonly authority: AdapterFamilyShadowInputAuthority;
  readonly inventoryMode: "complete-snapshot" | "partial";
  readonly source: CanonicalSource;
  readonly range: DiscoveryRange;
  readonly families: readonly BootstrapFamilyRecord[];
}

interface WatermarkSeedRecord extends AdapterFamilyShadowWatermarkSeedInput {
  readonly authorityIssuer: AdapterFamilyShadowInputAuthority;
}

interface AncestryBinding {
  readonly chainId: string;
}

interface AncestryProofRecord {
  readonly authority: AdapterFamilyShadowAncestryAuthority;
  readonly chainId: string;
  readonly previous: { readonly number: number; readonly hash: string };
  readonly current: CanonicalSource;
  readonly status: "canonical-descendant" | "unresolved";
  readonly evidenceRef: string;
}

interface CandidateWork {
  readonly origin: "scan" | "bootstrap";
  readonly subjectKey: string;
  readonly familyId: FamilyId;
  readonly sourceId: DiscoverySourceKind;
  readonly candidateKey: string;
  readonly matches: FamilyLifecycleMatch[];
  readonly fingerprints: Set<string>;
}

interface PendingIncumbent {
  readonly familyId: FamilyId;
  readonly nomination: AdapterFamilyShadowIncumbentNomination;
  readonly candidateWorkKeys: readonly string[];
  readonly fixedStatus: Exclude<
    AdapterFamilyShadowBootstrapStatus,
    "reattested"
  > | null;
}

interface StoredWatermark {
  readonly hash: string | null;
  readonly coverageAuthority: AdapterFamilyShadowCoverageKind;
}

const inputAuthorityRecords = new WeakMap<object, InputBinding>();
const scanReceiptRecords = new WeakMap<object, SourceScanRecord>();
const bootstrapReceiptRecords = new WeakMap<object, BootstrapRecord>();
const watermarkSeedRecords = new WeakMap<object, WatermarkSeedRecord>();
const ancestryAuthorityRecords = new WeakMap<object, AncestryBinding>();
const ancestryProofRecords = new WeakMap<object, AncestryProofRecord>();

const EVENT_SOURCE_IDS: readonly DiscoverySourceKind[] = Object.freeze([
  "factory-log",
  "landed-log",
  "observed-call",
]);
const SNAPSHOT_SOURCE_IDS: readonly DiscoverySourceKind[] = Object.freeze([
  "address-surface",
  "canonical-registry",
]);

export function createAdapterFamilyShadowInputIssuer(
  rawBinding: InputBinding,
): AdapterFamilyShadowInputIssuer {
  const binding = freezeInputBinding(rawBinding);
  const authority = Object.freeze({}) as AdapterFamilyShadowInputAuthority;
  inputAuthorityRecords.set(authority, binding);
  return Object.freeze({
    authority,
    sealSourceScan(
      input: AdapterFamilyShadowSourceScanInput,
    ): AdapterFamilyShadowSourceScanReceipt {
      const source = snapshotSource(input.source);
      const range = snapshotRange(input.range, source);
      validateScanMode(input.sourceId, input.mode, range);
      if (input.status !== "complete" && input.status !== "partial") {
        throw new Error(`invalid shadow source scan status ${input.status}`);
      }
      const observations = Object.freeze(input.observations.map((observation) => {
        assertObservationKind(input.sourceId, observation);
        assertSameSource(observation.source, source);
        return snapshotObservation(observation);
      }));
      const receipt = Object.freeze({}) as AdapterFamilyShadowSourceScanReceipt;
      scanReceiptRecords.set(receipt, Object.freeze({
        authority,
        sourceId: input.sourceId,
        mode: input.mode,
        status: input.status,
        source,
        range,
        observations,
      }));
      return receipt;
    },
    sealBootstrap(
      input: AdapterFamilyShadowBootstrapInput,
    ): AdapterFamilyShadowBootstrapReceipt {
      if (
        input.inventoryMode !== "complete-snapshot" &&
        input.inventoryMode !== "partial"
      ) {
        throw new Error("invalid shadow bootstrap inventory mode");
      }
      if (input.families.length === 0) {
        throw new Error("shadow bootstrap requires explicit per-Family inventory");
      }
      const source = snapshotSource(input.source);
      const range = snapshotRange(input.range, source);
      if (range.fromBlock !== range.toBlock) {
        throw new Error("shadow bootstrap requires a point-in-time range");
      }
      const seenFamilies = new Set<FamilyId>();
      const families = input.families.map((family) => {
        if (seenFamilies.has(family.familyId)) {
          throw new Error(`duplicate bootstrap Family ${family.familyId}`);
        }
        seenFamilies.add(family.familyId);
        const inventoryKeys = sortedUniqueExact(
          family.inventoryKeys,
          "bootstrap inventory keys",
        );
        if (family.inventoryCount !== inventoryKeys.length) {
          throw new Error(`bootstrap inventory count mismatch for ${family.familyId}`);
        }
        const expectedHash = adapterFamilyShadowInventoryHash(
          family.familyId,
          inventoryKeys,
        );
        if (family.inventoryHash !== expectedHash) {
          throw new Error(`bootstrap inventory hash mismatch for ${family.familyId}`);
        }
        const seenIncumbents = new Set<string>();
        const incumbents = family.incumbents.map((incumbent) => {
          nonempty(incumbent.incumbentKey, "incumbent key");
          nonempty(incumbent.address, "incumbent address");
          if (seenIncumbents.has(incumbent.incumbentKey)) {
            throw new Error(`duplicate incumbent ${incumbent.incumbentKey}`);
          }
          seenIncumbents.add(incumbent.incumbentKey);
          if (incumbent.currentSurface !== null) {
            assertSameSource(incumbent.currentSurface.source, source);
            if (
              incumbent.currentSurface.address.toLowerCase() !==
                incumbent.address.toLowerCase()
            ) {
              throw new Error(
                `incumbent ${incumbent.incumbentKey} surface address mismatch`,
              );
            }
          }
          return snapshotNomination(incumbent);
        }).sort((left, right) =>
          left.incumbentKey.localeCompare(right.incumbentKey)
        );
        const incumbentKeys = incumbents.map((item) => item.incumbentKey);
        if (!sameStringArray(inventoryKeys, incumbentKeys)) {
          throw new Error(`bootstrap inventory keys do not match ${family.familyId}`);
        }
        return Object.freeze({
          familyId: family.familyId,
          inventoryKeys,
          inventoryCount: family.inventoryCount,
          inventoryHash: family.inventoryHash,
          incumbents: Object.freeze(incumbents),
        });
      }).sort((left, right) => left.familyId.localeCompare(right.familyId));
      const receipt = Object.freeze({}) as AdapterFamilyShadowBootstrapReceipt;
      bootstrapReceiptRecords.set(receipt, Object.freeze({
        authority,
        inventoryMode: input.inventoryMode,
        source,
        range,
        families: Object.freeze(families),
      }));
      return receipt;
    },
    sealWatermarkSeed(
      input: AdapterFamilyShadowWatermarkSeedInput,
    ): AdapterFamilyShadowWatermarkSeed {
      validateWatermark(input);
      const seed = Object.freeze({}) as AdapterFamilyShadowWatermarkSeed;
      watermarkSeedRecords.set(seed, Object.freeze({
        ...input,
        completeThroughHash: input.completeThroughHash === null
          ? null
          : input.completeThroughHash.toLowerCase(),
        authorityIssuer: authority,
      }));
      return seed;
    },
  });
}

export function createAdapterFamilyShadowAncestryIssuer(input: {
  readonly chainId: string;
}): AdapterFamilyShadowAncestryIssuer {
  const chainId = canonicalChainId(input.chainId);
  const authority = Object.freeze({}) as AdapterFamilyShadowAncestryAuthority;
  ancestryAuthorityRecords.set(authority, Object.freeze({ chainId }));
  return Object.freeze({
    authority,
    issue(raw: {
      readonly previous: { readonly number: number; readonly hash: string };
      readonly current: CanonicalSource;
      readonly status: "canonical-descendant" | "unresolved";
      readonly evidenceRef: string;
    }): AdapterFamilyShadowAncestryProof {
      const previous = snapshotBlockAnchor(raw.previous);
      const current = snapshotSource(raw.current);
      nonempty(raw.evidenceRef, "canonical ancestry evidence ref");
      if (
        raw.status !== "canonical-descendant" &&
        raw.status !== "unresolved"
      ) {
        throw new Error("invalid canonical ancestry status");
      }
      const proof = Object.freeze({}) as AdapterFamilyShadowAncestryProof;
      ancestryProofRecords.set(proof, Object.freeze({
        authority,
        chainId,
        previous,
        current,
        status: raw.status,
        evidenceRef: raw.evidenceRef,
      }));
      return proof;
    },
  });
}

export function adapterFamilyShadowInventoryHash(
  familyId: FamilyId,
  inventoryKeys: readonly string[],
): string {
  const keys = sortedUniqueExact(inventoryKeys, "bootstrap inventory keys");
  return hashCanonical(adapterFamilyShadowInventoryProjection(familyId, keys));
}

/**
 * Shadow-only observation ingress. Raw observations, incumbent inventories,
 * seeds and chain transitions are rejected: every one must arrive in a
 * process-local receipt from the exact authority bound at construction.
 */
export class AdapterFamilyObservationShadowIngress {
  readonly #catalog: FamilyCapabilityCatalog;
  readonly #reattestor: AdapterFamilyShadowReattestor;
  readonly #generationFence: AdapterGenerationFence;
  readonly #inputAuthority: AdapterFamilyShadowInputAuthority;
  readonly #ancestryAuthority: AdapterFamilyShadowAncestryAuthority;
  readonly #binding: InputBinding;
  readonly #families: readonly DiscoveryFamilySources[];
  #watermarks: Map<string, number>;
  #watermarkMetadata: Map<string, StoredWatermark>;
  #lastSource: CanonicalSource | null = null;
  #running = false;

  constructor(input: {
    readonly catalog: FamilyCapabilityCatalog;
    readonly reattestor: AdapterFamilyShadowReattestor;
    readonly generationFence: AdapterGenerationFence;
    readonly inputAuthority: AdapterFamilyShadowInputAuthority;
    readonly ancestryAuthority: AdapterFamilyShadowAncestryAuthority;
    readonly initialWatermarks?: readonly AdapterFamilyShadowWatermarkSeed[];
  }) {
    const binding = inputAuthorityRecords.get(input.inputAuthority);
    if (binding === undefined || binding.catalogHash !== input.catalog.catalogHash) {
      throw new Error("shadow input authority is foreign to the Family catalog");
    }
    const ancestry = ancestryAuthorityRecords.get(input.ancestryAuthority);
    if (ancestry === undefined || ancestry.chainId !== binding.chainId) {
      throw new Error("shadow ancestry authority is foreign to the chain");
    }
    if (
      typeof input.reattestor?.reattest !== "function" ||
      typeof input.generationFence?.assertCurrent !== "function"
    ) {
      throw new Error("shadow ingress requires central re-attestor and fence");
    }
    this.#catalog = input.catalog;
    this.#reattestor = input.reattestor;
    this.#generationFence = input.generationFence;
    this.#inputAuthority = input.inputAuthority;
    this.#ancestryAuthority = input.ancestryAuthority;
    this.#binding = binding;
    this.#families = Object.freeze(input.catalog.listAll().flatMap((family) => {
      if (!("discovery" in family.plugin)) return [];
      return [Object.freeze({
        familyId: family.plugin.manifest.familyId,
        sourceIds: Object.freeze([...family.plugin.discovery.sources]),
      })];
    }));
    this.#watermarks = createDiscoveryFamilySourceWatermarks(this.#families);
    this.#watermarkMetadata = new Map([...this.#watermarks].map(([key]) => [
      key,
      Object.freeze({
        hash: null,
        coverageAuthority: "append-only" as const,
      }),
    ]));
    const seen = new Set<string>();
    for (const seed of input.initialWatermarks ?? []) {
      const record = watermarkSeedRecords.get(seed);
      if (record === undefined || record.authorityIssuer !== this.#inputAuthority) {
        throw new Error("shadow watermark seed was not issued by this ingress authority");
      }
      const key = discoveryFamilySourceKey(record.familyId, record.sourceId);
      if (seen.has(key)) throw new Error(`duplicate shadow watermark seed ${key}`);
      seen.add(key);
      this.#restoreWatermark(record);
    }
    assertConsistentSeedHashes(this.watermarkSnapshot());
  }

  async run(input: {
    readonly sourceScans: readonly AdapterFamilyShadowSourceScanReceipt[];
    readonly bootstrap?: AdapterFamilyShadowBootstrapReceipt;
    readonly ancestryProofs: readonly AdapterFamilyShadowAncestryProof[];
  }): Promise<AdapterFamilyObservationShadowRound> {
    if (this.#running) {
      throw new Error("adapter Family observation shadow ingress is already running");
    }
    this.#running = true;
    try {
      return await this.#run(input);
    } finally {
      this.#running = false;
    }
  }

  watermarkSnapshot(): readonly AdapterFamilyShadowWatermarkSnapshot[] {
    return Object.freeze(this.#families.flatMap((family) =>
      family.sourceIds.map((sourceId) => {
        const key = discoveryFamilySourceKey(family.familyId, sourceId);
        const block = this.#watermarks.get(key) ?? -1;
        const metadata = this.#watermarkMetadata.get(key)!;
        return Object.freeze({
          familyId: family.familyId as FamilyId,
          sourceId: sourceId as DiscoverySourceKind,
          coverageAuthority: metadata.coverageAuthority,
          completeThroughBlock: block,
          completeThroughHash: block < 0 ? null : metadata.hash,
        });
      })
    ).sort(compareWatermark));
  }

  async #run(input: {
    readonly sourceScans: readonly AdapterFamilyShadowSourceScanReceipt[];
    readonly bootstrap?: AdapterFamilyShadowBootstrapReceipt;
    readonly ancestryProofs: readonly AdapterFamilyShadowAncestryProof[];
  }): Promise<AdapterFamilyObservationShadowRound> {
    const scans = this.#resolveScans(input.sourceScans);
    const first = scans.values().next().value as SourceScanRecord;
    const source = first.source;
    const bootstrap = input.bootstrap === undefined
      ? null
      : this.#resolveBootstrap(input.bootstrap, source);
    this.#assertCanonicalAncestry(source, input.ancestryProofs);

    const issues: AdapterFamilyObservationShadowIssue[] = [];
    const works = new Map<string, CandidateWork>();
    const sourceFaults = new Set<string>();
    for (const scan of scans.values()) {
      for (const observation of scan.observations) {
        this.#routeObservation({
          origin: "scan",
          subjectKey: `scan:${scan.sourceId}`,
          sourceId: scan.sourceId,
          observation,
          works,
          sourceFaults,
          issues,
        });
      }
    }
    const pendingIncumbents = this.#routeBootstrap({
      bootstrap,
      works,
      sourceFaults,
      issues,
    });
    const candidateResults = await Promise.all(
      [...works.entries()].sort(([left], [right]) => left.localeCompare(right))
        .map(([, work]) => this.#reattestWork(work, source, issues)),
    );
    const candidateResultByWork = new Map(candidateResults.map((result) => [
      candidateWorkKey(result),
      result,
    ]));
    const bootstrapIncumbents = pendingIncumbents.map((pending) => {
      if (pending.fixedStatus !== null) {
        return freezeBootstrapResult(pending, pending.fixedStatus);
      }
      const terminal = pending.candidateWorkKeys.length > 0 &&
        pending.candidateWorkKeys.every((key) =>
          candidateResultByWork.get(key)?.status === "terminal"
        );
      return freezeBootstrapResult(
        pending,
        terminal ? "reattested" : "reattest-partial",
      );
    });
    const bootstrapFamilies = this.#bootstrapFamilyResults(
      bootstrap,
      bootstrapIncumbents,
    );

    const currentComplete = this.#currentFamilySourceCompleteness({
      scans,
      sourceFaults,
      candidateResults,
      bootstrap,
      bootstrapFamilies,
    });
    let nextWatermarks = new Map(this.#watermarks);
    for (const scan of scans.values()) {
      const advanced = advanceDiscoveryFamilySourceWatermarks({
        current: nextWatermarks,
        families: this.#families,
        range: scan.range,
        familyComplete: new Map(this.#families.map((family) => [
          family.familyId,
          true,
        ])),
        familySourceComplete: currentComplete,
        sourceComplete: new Map([[scan.sourceId, scan.status === "complete"]]),
        sourceIssues: [],
        contiguousSourceIds: scan.mode === "contiguous"
          ? new Set([scan.sourceId])
          : new Set(),
        positiveOnlySourceIds: scan.mode === "positive-only"
          ? new Set([scan.sourceId])
          : new Set(),
      });
      nextWatermarks = advanced.watermarks;
    }
    const nextMetadata = new Map(this.#watermarkMetadata);
    for (const [key, complete] of currentComplete) {
      if (!complete || nextWatermarks.get(key) !== source.number) continue;
      const sourceId = sourceIdFromFamilySourceKey(key, this.#families);
      nextMetadata.set(key, Object.freeze({
        hash: source.hash.toLowerCase(),
        coverageAuthority:
          (SNAPSHOT_SOURCE_IDS as readonly string[]).includes(sourceId)
            ? "snapshot" as const
            : "contiguous-history" as const,
      }));
    }

    // The shadow watermark is still state: a stale generation must not write it.
    this.#generationFence.assertCurrent(source.generation, source);
    this.#watermarks = nextWatermarks;
    this.#watermarkMetadata = nextMetadata;
    this.#lastSource = source;

    const sourceCoverage = this.#sourceCoverage(source, currentComplete);
    const bootstrapStatus = bootstrap === null
      ? "not-run" as const
      : bootstrap.inventoryMode === "complete-snapshot" &&
          this.#bootstrapMatrixComplete(bootstrap) &&
          bootstrapFamilies.every((family) => family.status === "resolved")
      ? "complete" as const
      : "partial" as const;
    const familyResults = this.#familyResults({
      currentComplete,
      sourceCoverage,
      bootstrap,
      bootstrapFamilies,
    });
    const status = familyResults.every((family) =>
      family.status === "resolved" || family.status === "not-applicable"
    )
      ? "shadow-complete" as const
      : "shadow-partial" as const;
    return Object.freeze({
      authority: "shadow-only" as const,
      status,
      chainId: this.#binding.chainId,
      catalogHash: this.#binding.catalogHash,
      sourceRegistryFingerprint: this.#binding.sourceRegistryFingerprint,
      source,
      ranges: Object.freeze([...scans.values()]
        .map((scan) => Object.freeze({
          sourceId: scan.sourceId,
          range: scan.range,
        }))
        .sort((left, right) => left.sourceId.localeCompare(right.sourceId))),
      familyResults,
      candidateResults: Object.freeze(candidateResults),
      sourceCoverage,
      bootstrap: Object.freeze({
        status: bootstrapStatus,
        families: bootstrapFamilies,
        incumbents: Object.freeze(bootstrapIncumbents),
      }),
      issues: Object.freeze(issues),
    });
  }

  #resolveScans(
    receipts: readonly AdapterFamilyShadowSourceScanReceipt[],
  ): ReadonlyMap<DiscoverySourceKind, SourceScanRecord> {
    if (receipts.length === 0) {
      throw new Error("shadow round requires at least one sealed source scan");
    }
    const scans = new Map<DiscoverySourceKind, SourceScanRecord>();
    let source: CanonicalSource | null = null;
    for (const receipt of receipts) {
      const record = scanReceiptRecords.get(receipt);
      if (record === undefined || record.authority !== this.#inputAuthority) {
        throw new Error("shadow source scan receipt is forged or foreign");
      }
      if (scans.has(record.sourceId)) {
        throw new Error(`duplicate shadow source scan ${record.sourceId}`);
      }
      source ??= record.source;
      assertSameSource(record.source, source);
      scans.set(record.sourceId, record);
    }
    return scans;
  }

  #resolveBootstrap(
    receipt: AdapterFamilyShadowBootstrapReceipt,
    source: CanonicalSource,
  ): BootstrapRecord {
    const record = bootstrapReceiptRecords.get(receipt);
    if (record === undefined || record.authority !== this.#inputAuthority) {
      throw new Error("shadow bootstrap receipt is forged or foreign");
    }
    assertSameSource(record.source, source);
    return record;
  }

  #assertCanonicalAncestry(
    current: CanonicalSource,
    proofs: readonly AdapterFamilyShadowAncestryProof[],
  ): void {
    const previous = this.#lastSource === null
      ? uniqueSeedAnchors(this.watermarkSnapshot())
      : [snapshotBlockAnchor(this.#lastSource)];
    const required = new Map(previous.map((anchor) => [anchorKey(anchor), anchor]));
    const seen = new Set<string>();
    for (const proof of proofs) {
      const record = ancestryProofRecords.get(proof);
      if (record === undefined || record.authority !== this.#ancestryAuthority) {
        throw new Error("canonical ancestry proof is forged or foreign");
      }
      if (record.chainId !== this.#binding.chainId) {
        throw new Error("canonical ancestry proof escaped its chain");
      }
      assertSameSource(record.current, current);
      const key = anchorKey(record.previous);
      if (!required.has(key) || seen.has(key)) {
        throw new Error("canonical ancestry proof does not match a required anchor");
      }
      assertDescendantTransition(record.previous, current);
      if (record.status !== "canonical-descendant") {
        throw new Error("canonical ancestry remains unresolved");
      }
      seen.add(key);
    }
    if (seen.size !== required.size) {
      throw new Error("shadow round lacks canonical ancestry proof");
    }
  }

  #routeObservation(input: {
    readonly origin: "scan" | "bootstrap";
    readonly subjectKey: string;
    readonly sourceId: DiscoverySourceKind;
    readonly observation: UnifiedObservation;
    readonly expectedFamilyId?: FamilyId;
    readonly works: Map<string, CandidateWork>;
    readonly sourceFaults: Set<string>;
    readonly issues: AdapterFamilyObservationShadowIssue[];
  }): readonly string[] {
    const workKeys: string[] = [];
    for (const match of this.#catalog.matches(input.observation)) {
      if (
        input.expectedFamilyId !== undefined &&
        match.familyId !== input.expectedFamilyId
      ) continue;
      const family = this.#catalog.forStrictFamily(match.familyId);
      if (
        !("discovery" in family.plugin) ||
        !family.plugin.discovery.sources.includes(input.sourceId)
      ) {
        input.issues.push(issue({
          code: "source-not-declared",
          familyId: match.familyId,
          sourceId: input.sourceId,
          subjectKey: input.subjectKey,
          detail: `${match.patternId} matched an undeclared source`,
        }));
        continue;
      }
      let candidate: { readonly candidateKind: string } | null;
      try {
        candidate = family.plugin.discovery.decodeCandidate({
          observation: input.observation,
          matchedPatternId: match.patternId,
        });
      } catch (error) {
        input.sourceFaults.add(familySourceKey(match.familyId, input.sourceId));
        input.issues.push(issue({
          code: "candidate-decode",
          familyId: match.familyId,
          sourceId: input.sourceId,
          subjectKey: input.subjectKey,
          detail: errorMessage(error),
        }));
        continue;
      }
      if (candidate === null) continue;
      let candidateKey: string;
      try {
        candidateKey = nonempty(
          family.plugin.discovery.candidateKey(candidate),
          "strict Family candidate key",
        );
      } catch (error) {
        input.sourceFaults.add(familySourceKey(match.familyId, input.sourceId));
        input.issues.push(issue({
          code: "candidate-key",
          familyId: match.familyId,
          sourceId: input.sourceId,
          subjectKey: input.subjectKey,
          detail: errorMessage(error),
        }));
        continue;
      }
      const key = candidateWorkKey({
        origin: input.origin,
        subjectKey: input.subjectKey,
        familyId: match.familyId,
        sourceId: input.sourceId,
        candidateKey,
      });
      const work = input.works.get(key) ?? {
        origin: input.origin,
        subjectKey: input.subjectKey,
        familyId: match.familyId,
        sourceId: input.sourceId,
        candidateKey,
        matches: [],
        fingerprints: new Set<string>(),
      };
      const fingerprint = hashCanonical({
        observation: input.observation,
        matchedPatternId: match.patternId,
      } as unknown as CanonicalValue);
      if (!work.fingerprints.has(fingerprint)) {
        work.matches.push(Object.freeze({
          observation: input.observation,
          matchedPatternId: match.patternId,
        }));
        work.fingerprints.add(fingerprint);
      }
      input.works.set(key, work);
      workKeys.push(key);
    }
    return Object.freeze([...new Set(workKeys)].sort());
  }

  #routeBootstrap(input: {
    readonly bootstrap: BootstrapRecord | null;
    readonly works: Map<string, CandidateWork>;
    readonly sourceFaults: Set<string>;
    readonly issues: AdapterFamilyObservationShadowIssue[];
  }): readonly PendingIncumbent[] {
    if (input.bootstrap === null) return [];
    const pending: PendingIncumbent[] = [];
    for (const inventory of input.bootstrap.families) {
      const family = this.#catalog.forStrictFamily(inventory.familyId);
      for (const nomination of inventory.incumbents) {
        let fixedStatus: PendingIncumbent["fixedStatus"] = null;
        let candidateWorkKeys: readonly string[] = [];
        if (
          !("discovery" in family.plugin) ||
          !family.plugin.discovery.sources.includes("address-surface") ||
          (family.plugin.discovery.addressSurfaces?.length ?? 0) === 0
        ) {
          fixedStatus = "family-has-no-address-surface";
        } else if (nomination.currentSurface === null) {
          fixedStatus = "missing-current-surface";
        } else {
          const issueCount = input.issues.length;
          candidateWorkKeys = this.#routeObservation({
            origin: "bootstrap",
            subjectKey: nomination.incumbentKey,
            sourceId: "address-surface",
            observation: nomination.currentSurface,
            expectedFamilyId: inventory.familyId,
            works: input.works,
            sourceFaults: input.sourceFaults,
            issues: input.issues,
          });
          if (candidateWorkKeys.length === 0) {
            fixedStatus = input.issues.length === issueCount
              ? "surface-not-matched"
              : "reattest-partial";
          }
        }
        pending.push(Object.freeze({
          familyId: inventory.familyId,
          nomination,
          candidateWorkKeys,
          fixedStatus,
        }));
      }
    }
    return Object.freeze(pending);
  }

  async #reattestWork(
    work: CandidateWork,
    source: CanonicalSource,
    issues: AdapterFamilyObservationShadowIssue[],
  ): Promise<AdapterFamilyShadowCandidateResult> {
    const family = this.#catalog.forStrictFamily(work.familyId);
    let result: AdapterFamilyShadowReattestationResult;
    try {
      result = await this.#reattestor.reattest(Object.freeze({
        family,
        sourceId: work.sourceId,
        source,
        subjectKey: work.subjectKey,
        candidateKeys: Object.freeze([work.candidateKey]),
        matches: Object.freeze([...work.matches]),
      }));
    } catch (error) {
      issues.push(issue({
        code: "reattest-threw",
        familyId: work.familyId,
        sourceId: work.sourceId,
        subjectKey: work.subjectKey,
        detail: errorMessage(error),
      }));
      return partialCandidateResult(work);
    }
    try {
      validateReattestationResult(result, work, source);
    } catch (error) {
      issues.push(issue({
        code: "reattest-invalid-result",
        familyId: work.familyId,
        sourceId: work.sourceId,
        subjectKey: work.subjectKey,
        detail: errorMessage(error),
      }));
      return partialCandidateResult(work);
    }
    const outcomes = Object.freeze(result.outcomes.map(snapshotOutcome));
    const candidateOutcomes = outcomes.filter((outcome) =>
      outcome.candidateKey === work.candidateKey
    );
    const terminal = sameStringArray(
      sortedUniqueExact(result.candidateTerminalKeys, "candidate terminal keys"),
      [work.candidateKey],
    ) && candidateOutcomes.some((outcome) => outcome.status !== "candidate") &&
      candidateOutcomes.every((outcome) =>
        outcome.status !== "failed" && outcome.status !== "unresolved"
      );
    return Object.freeze({
      origin: work.origin,
      subjectKey: work.subjectKey,
      familyId: work.familyId,
      sourceId: work.sourceId,
      candidateKey: work.candidateKey,
      matchCount: work.matches.length,
      status: terminal ? "terminal" as const : "partial" as const,
      outcomes,
      admittedInstanceKeys: Object.freeze(sortedUnique(
        result.admittedInstanceKeys,
        "admitted instance keys",
      )),
      publicationFingerprints: Object.freeze(sortedUnique(
        result.publicationFingerprints,
        "publication fingerprints",
      )),
    });
  }

  #currentFamilySourceCompleteness(input: {
    readonly scans: ReadonlyMap<DiscoverySourceKind, SourceScanRecord>;
    readonly sourceFaults: ReadonlySet<string>;
    readonly candidateResults: readonly AdapterFamilyShadowCandidateResult[];
    readonly bootstrap: BootstrapRecord | null;
    readonly bootstrapFamilies: readonly AdapterFamilyShadowBootstrapFamilyResult[];
  }): ReadonlyMap<string, boolean> {
    const complete = new Map<string, boolean>();
    for (const family of this.#families) {
      for (const rawSourceId of family.sourceIds) {
        const familyId = family.familyId as FamilyId;
        const sourceId = rawSourceId as DiscoverySourceKind;
        const key = familySourceKey(familyId, sourceId);
        const scan = input.scans.get(sourceId);
        const candidates = input.candidateResults.filter((result) =>
          result.origin === "scan" &&
          result.familyId === familyId &&
          result.sourceId === sourceId
        );
        const bootstrapResolved = sourceId !== "address-surface" ||
          (input.bootstrap !== null &&
            input.bootstrap.inventoryMode === "complete-snapshot" &&
            this.#bootstrapMatrixComplete(input.bootstrap) &&
            input.bootstrapFamilies.some((result) =>
              result.familyId === familyId && result.status === "resolved"
            ));
        complete.set(
          key,
          scan !== undefined &&
            scan.status === "complete" &&
            scan.mode !== "positive-only" &&
            !input.sourceFaults.has(key) &&
            candidates.every((candidate) => candidate.status === "terminal") &&
            bootstrapResolved &&
            this.#scanCanEstablishCompleteness(key, scan),
        );
      }
    }
    return complete;
  }

  #scanCanEstablishCompleteness(
    key: string,
    scan: SourceScanRecord,
  ): boolean {
    // A sealed scan status is not an inventory-closure proof. Until a durable,
    // verifier-issued count/hash checkpoint exists, point-in-time sources may
    // nominate positives but can never establish negative completeness.
    if (scan.mode === "snapshot") return false;
    if (scan.mode !== "contiguous") return false;
    const current = this.#watermarks.get(key) ?? -1;
    const metadata = this.#watermarkMetadata.get(key)!;
    if (scan.range.fromBlock === 0) return true;
    return metadata.coverageAuthority === "contiguous-history" &&
      scan.range.fromBlock <= current + 1;
  }

  #sourceCoverage(
    source: CanonicalSource,
    currentComplete: ReadonlyMap<string, boolean>,
  ): readonly AdapterFamilyShadowSourceCoverage[] {
    return Object.freeze(this.#families.flatMap((family) =>
      family.sourceIds.map((rawSourceId) => {
        const familyId = family.familyId as FamilyId;
        const sourceId = rawSourceId as DiscoverySourceKind;
        const key = familySourceKey(familyId, sourceId);
        const block = this.#watermarks.get(key) ?? -1;
        const metadata = this.#watermarkMetadata.get(key)!;
        const hash = block < 0 ? null : metadata.hash;
        const complete = currentComplete.get(key) === true &&
          metadata.coverageAuthority !== "append-only" &&
          block === source.number &&
          hash?.toLowerCase() === source.hash.toLowerCase();
        return Object.freeze({
          familyId,
          sourceId,
          coverageFingerprint: adapterFamilyShadowCoverageFingerprint({
            familyId,
            sourceId,
            source,
          }),
          coverageKind: metadata.coverageAuthority,
          status: complete ? "complete" as const : "partial" as const,
          completeThroughBlock: block,
          completeThroughHash: hash,
        });
      })
    ).sort(compareSourceCoverage));
  }

  #bootstrapFamilyResults(
    bootstrap: BootstrapRecord | null,
    incumbents: readonly AdapterFamilyShadowBootstrapResult[],
  ): readonly AdapterFamilyShadowBootstrapFamilyResult[] {
    if (bootstrap === null) return Object.freeze([]);
    return Object.freeze(bootstrap.families.map((family) => {
      const familyIncumbents = incumbents.filter((item) =>
        item.familyId === family.familyId
      );
      const reconciledKeys = familyIncumbents
        .map((item) => item.incumbentKey).sort();
      const inventoryReconciled =
        familyIncumbents.length === family.inventoryCount &&
        sameStringArray(reconciledKeys, family.inventoryKeys);
      // A zero count is explicit authority, not Array#every vacuity: the
      // sealed receipt commits the Family row, count, keys and inventory hash.
      const terminal = family.inventoryCount === 0
        ? inventoryReconciled
        : inventoryReconciled && familyIncumbents.every((item) =>
          item.status === "reattested"
        );
      return Object.freeze({
        familyId: family.familyId,
        inventoryKeys: family.inventoryKeys,
        inventoryCount: family.inventoryCount,
        inventoryHash: family.inventoryHash,
        status: terminal ? "resolved" as const : "partial" as const,
      });
    }));
  }

  #bootstrapMatrixComplete(bootstrap: BootstrapRecord): boolean {
    const expected = this.#families.map((family) => family.familyId).sort();
    const actual = bootstrap.families.map((family) => family.familyId).sort();
    return sameStringArray(expected, actual);
  }

  #familyResults(input: {
    readonly currentComplete: ReadonlyMap<string, boolean>;
    readonly sourceCoverage: readonly AdapterFamilyShadowSourceCoverage[];
    readonly bootstrap: BootstrapRecord | null;
    readonly bootstrapFamilies: readonly AdapterFamilyShadowBootstrapFamilyResult[];
  }): readonly AdapterFamilyShadowFamilyResult[] {
    return Object.freeze(this.#catalog.listAll().map((family) => {
      const familyId = family.plugin.manifest.familyId;
      if (!("discovery" in family.plugin)) {
        return Object.freeze({
          familyId,
          domain: family.plugin.manifest.domain,
          status: "not-applicable" as const,
          sourceIdsCompleteThisRound: Object.freeze([]),
        });
      }
      const sourceIds = family.plugin.discovery.sources;
      const sourceIdsCompleteThisRound = Object.freeze(sourceIds.filter(
        (sourceId) => input.currentComplete.get(
          familySourceKey(familyId, sourceId),
        ) === true,
      ));
      const coverageComplete = sourceIds.every((sourceId) =>
        input.sourceCoverage.some((coverage) =>
          coverage.familyId === familyId &&
          coverage.sourceId === sourceId &&
          coverage.status === "complete"
        )
      );
      const bootstrapComplete = input.bootstrap !== null &&
        input.bootstrap.inventoryMode === "complete-snapshot" &&
        this.#bootstrapMatrixComplete(input.bootstrap) &&
        input.bootstrapFamilies.some((result) =>
          result.familyId === familyId && result.status === "resolved"
        );
      return Object.freeze({
        familyId,
        domain: family.plugin.manifest.domain,
        status:
          sourceIdsCompleteThisRound.length === sourceIds.length &&
            coverageComplete &&
            bootstrapComplete
            ? "resolved" as const
            : "partial" as const,
        sourceIdsCompleteThisRound,
      });
    }).sort((left, right) => left.familyId.localeCompare(right.familyId)));
  }

  #restoreWatermark(seed: WatermarkSeedRecord): void {
    const key = familySourceKey(seed.familyId, seed.sourceId);
    if (!this.#watermarks.has(key)) {
      throw new Error(`shadow watermark seed references unknown ${key}`);
    }
    this.#watermarks.set(key, seed.completeThroughBlock);
    this.#watermarkMetadata.set(key, Object.freeze({
      hash: seed.completeThroughHash,
      coverageAuthority: "append-only",
    }));
  }
}

/** Bind strict lifecycle to the shadow ingress without a production sink. */
export function createRuntimeAdapterFamilyShadowReattestor(
  runtime: CentralAdapterRuntime,
): AdapterFamilyShadowReattestor {
  return Object.freeze({
    async reattest(
      input: AdapterFamilyShadowReattestationInput,
    ): Promise<AdapterFamilyShadowReattestationResult> {
      const domain = input.family.plugin.manifest.domain;
      if (domain === "funding") {
        throw new Error("Funding Family has no observation lifecycle");
      }
      if (domain === "credit") {
        const results = await Promise.all(input.matches.map((match) =>
          executeCreditFamilyInstanceLifecycle({
            family: input.family,
            match,
            source: input.source,
            generation: input.source.generation,
            runtime,
          })
        ));
        const outcomes = Object.freeze(results.flatMap((result) => result.outcomes));
        return Object.freeze({
          familyId: input.family.plugin.manifest.familyId,
          sourceId: input.sourceId,
          source: snapshotSource(input.source),
          subjectKey: input.subjectKey,
          candidateTerminalKeys: terminalCandidateKeys(input.candidateKeys, outcomes),
          outcomes,
          admittedInstanceKeys: Object.freeze(sortedUnique(results.flatMap(
            (result) => result.instance === null
              ? []
              : [result.instance.instanceKey],
          ), "Credit instance keys")),
          publicationFingerprints: Object.freeze([]),
        });
      }
      let capturedFingerprint: string | null = null;
      const result = await executeAdapterFamilyLifecycleBatch({
        family: input.family as LoadedFamilyPlugin,
        matches: input.matches,
        source: input.source,
        generation: input.source.generation,
        runtime,
        publisher: Object.freeze({
          publish(publication: AdapterFamilyPublication): void {
            if (capturedFingerprint !== null) {
              throw new Error("shadow lifecycle published more than once");
            }
            capturedFingerprint = publication.publicationFingerprint;
          },
        }),
      });
      if (
        (result.publication === null) !== (capturedFingerprint === null) ||
        (result.publication !== null &&
          result.publication.publicationFingerprint !== capturedFingerprint)
      ) {
        throw new Error("shadow lifecycle publication capture diverged");
      }
      return Object.freeze({
        familyId: result.familyId,
        sourceId: input.sourceId,
        source: snapshotSource(result.source),
        subjectKey: input.subjectKey,
        candidateTerminalKeys: terminalCandidateKeys(
          input.candidateKeys,
          result.outcomes,
        ),
        outcomes: result.outcomes,
        admittedInstanceKeys: Object.freeze(sortedUnique(
          result.publication?.instances.map((instance) => instance.instanceKey)
            ?? [],
          "published instance keys",
        )),
        publicationFingerprints: capturedFingerprint === null
          ? Object.freeze([])
          : Object.freeze([capturedFingerprint]),
      });
    },
  });
}

function terminalCandidateKeys(
  candidateKeys: readonly string[],
  outcomes: readonly AdapterInstanceOutcome[],
): readonly string[] {
  return Object.freeze(candidateKeys.filter((candidateKey) => {
    const candidateOutcomes = outcomes.filter((outcome) =>
      outcome.candidateKey === candidateKey
    );
    return candidateOutcomes.some((outcome) => outcome.status !== "candidate") &&
      candidateOutcomes.every((outcome) =>
        outcome.status !== "failed" && outcome.status !== "unresolved"
      );
  }).sort());
}

function validateReattestationResult(
  result: AdapterFamilyShadowReattestationResult,
  work: CandidateWork,
  source: CanonicalSource,
): void {
  if (
    result.familyId !== work.familyId ||
    result.sourceId !== work.sourceId ||
    result.subjectKey !== work.subjectKey
  ) {
    throw new Error("shadow re-attestation escaped its candidate binding");
  }
  assertSameSource(result.source, source);
  if (
    !Array.isArray(result.outcomes) ||
    !Array.isArray(result.candidateTerminalKeys) ||
    !Array.isArray(result.admittedInstanceKeys) ||
    !Array.isArray(result.publicationFingerprints)
  ) {
    throw new Error("shadow re-attestation returned malformed evidence arrays");
  }
  const expected = new Set([work.candidateKey]);
  for (const key of result.candidateTerminalKeys) {
    if (!expected.has(key)) throw new Error("foreign candidate terminal evidence");
  }
  for (const outcome of result.outcomes) {
    if (outcome.familyId !== work.familyId || !expected.has(outcome.candidateKey)) {
      throw new Error("shadow outcome escaped its candidate");
    }
    assertSameSource(outcome.source, source);
  }
}

function partialCandidateResult(
  work: CandidateWork,
): AdapterFamilyShadowCandidateResult {
  return Object.freeze({
    origin: work.origin,
    subjectKey: work.subjectKey,
    familyId: work.familyId,
    sourceId: work.sourceId,
    candidateKey: work.candidateKey,
    matchCount: work.matches.length,
    status: "partial",
    outcomes: Object.freeze([]),
    admittedInstanceKeys: Object.freeze([]),
    publicationFingerprints: Object.freeze([]),
  });
}

function candidateWorkKey(input: {
  readonly origin: "scan" | "bootstrap";
  readonly subjectKey: string;
  readonly familyId: FamilyId;
  readonly sourceId: DiscoverySourceKind;
  readonly candidateKey: string;
}): string {
  return JSON.stringify([
    input.origin,
    input.subjectKey,
    input.familyId,
    input.sourceId,
    input.candidateKey,
  ]);
}

function familySourceKey(
  familyId: FamilyId,
  sourceId: DiscoverySourceKind,
): string {
  return discoveryFamilySourceKey(familyId, sourceId);
}

function sourceIdFromFamilySourceKey(
  key: string,
  families: readonly DiscoveryFamilySources[],
): DiscoverySourceKind {
  for (const family of families) {
    for (const sourceId of family.sourceIds) {
      if (discoveryFamilySourceKey(family.familyId, sourceId) === key) {
        return sourceId as DiscoverySourceKind;
      }
    }
  }
  throw new Error(`unknown Family/source watermark ${key}`);
}

function adapterFamilyShadowInventoryProjection(
  familyId: FamilyId,
  inventoryKeys: readonly string[],
): CanonicalValue {
  return {
    format: "adapter-family-shadow-bootstrap-inventory-v1",
    familyId,
    inventoryKeys,
  };
}

function adapterFamilyShadowCoverageFingerprint(input: {
  readonly familyId: FamilyId;
  readonly sourceId: DiscoverySourceKind;
  readonly source: CanonicalSource;
}): string {
  return hashCanonical({
    format: "adapter-family-shadow-source-coverage-v1",
    familyId: input.familyId,
    sourceId: input.sourceId,
    source: input.source,
  } as unknown as CanonicalValue);
}

function freezeInputBinding(input: InputBinding): InputBinding {
  return Object.freeze({
    chainId: canonicalChainId(input.chainId),
    catalogHash: nonempty(input.catalogHash, "Family catalog hash"),
    sourceRegistryFingerprint: nonempty(
      input.sourceRegistryFingerprint,
      "source registry fingerprint",
    ),
  });
}

function canonicalChainId(value: string): string {
  if (!/^[1-9][0-9]*$/.test(value)) throw new Error(`invalid chain id ${value}`);
  return BigInt(value).toString();
}

function validateScanMode(
  sourceId: DiscoverySourceKind,
  mode: AdapterFamilyShadowScanMode,
  range: DiscoveryRange,
): void {
  if ((EVENT_SOURCE_IDS as readonly string[]).includes(sourceId)) {
    if (mode !== "contiguous" && mode !== "positive-only") {
      throw new Error(`${sourceId} cannot claim snapshot authority`);
    }
    return;
  }
  if ((SNAPSHOT_SOURCE_IDS as readonly string[]).includes(sourceId)) {
    if (mode !== "snapshot" || range.fromBlock !== range.toBlock) {
      throw new Error(`${sourceId} requires a point-in-time snapshot`);
    }
    return;
  }
  throw new Error(`unknown discovery source ${sourceId}`);
}

function assertObservationKind(
  sourceId: DiscoverySourceKind,
  observation: UnifiedObservation,
): void {
  if (
    (sourceId === "observed-call" && observation.kind !== "call") ||
    ((sourceId === "factory-log" || sourceId === "landed-log") &&
      observation.kind !== "log") ||
    ((sourceId === "address-surface" || sourceId === "canonical-registry") &&
      observation.kind !== "address-surface")
  ) {
    throw new Error(`${sourceId} received incompatible ${observation.kind}`);
  }
}

function validateWatermark(input: AdapterFamilyShadowWatermarkSeedInput): void {
  const eventSource = (EVENT_SOURCE_IDS as readonly string[]).includes(
    input.sourceId,
  );
  const snapshotSource = (SNAPSHOT_SOURCE_IDS as readonly string[]).includes(
    input.sourceId,
  );
  if (
    (!eventSource && !snapshotSource) ||
    !Number.isSafeInteger(input.completeThroughBlock) ||
    input.completeThroughBlock < -1 ||
    (input.completeThroughBlock === -1) !==
      (input.completeThroughHash === null) ||
    (input.completeThroughHash !== null &&
      !/^0x[0-9a-fA-F]{64}$/.test(input.completeThroughHash)) ||
    input.coverageAuthority !== "append-only"
  ) {
    throw new Error(
      "invalid adapter Family shadow watermark seed: durable checkpoint authority required",
    );
  }
}

function snapshotObservation(input: UnifiedObservation): UnifiedObservation {
  const source = snapshotSource(input.source);
  if (input.kind === "log") {
    return Object.freeze({ ...input, source, topics: Object.freeze([...input.topics]) });
  }
  if (input.kind === "address-surface") {
    return Object.freeze({
      ...input,
      source,
      ...(input.interfaceFingerprints === undefined
        ? {}
        : { interfaceFingerprints: Object.freeze([...input.interfaceFingerprints]) }),
    });
  }
  return Object.freeze({ ...input, source });
}

function snapshotNomination(
  input: AdapterFamilyShadowIncumbentNomination,
): AdapterFamilyShadowIncumbentNomination {
  return Object.freeze({
    incumbentKey: input.incumbentKey,
    address: input.address,
    currentSurface: input.currentSurface === null
      ? null
      : snapshotObservation(input.currentSurface) as
        AdapterFamilyShadowAddressObservation,
  });
}

function snapshotOutcome(outcome: AdapterInstanceOutcome): AdapterInstanceOutcome {
  return Object.freeze({
    ...outcome,
    source: snapshotSource(outcome.source),
    evidenceRefs: Object.freeze([...outcome.evidenceRefs]),
  });
}

function snapshotSource(source: CanonicalSource): CanonicalSource {
  if (
    !Number.isSafeInteger(source.number) || source.number < 0 ||
    !Number.isSafeInteger(source.generation) || source.generation < 0 ||
    !/^0x[0-9a-fA-F]{64}$/.test(source.hash)
  ) {
    throw new Error("adapter Family shadow source must be canonical");
  }
  return Object.freeze({
    number: source.number,
    hash: source.hash.toLowerCase(),
    generation: source.generation,
  });
}

function snapshotRange(
  range: DiscoveryRange,
  source: CanonicalSource,
): DiscoveryRange {
  if (
    !Number.isSafeInteger(range.fromBlock) || range.fromBlock < 0 ||
    !Number.isSafeInteger(range.toBlock) || range.toBlock < range.fromBlock ||
    range.toBlock !== source.number
  ) {
    throw new Error("shadow discovery range must end at its canonical source");
  }
  return Object.freeze({ ...range });
}

function snapshotBlockAnchor(input: {
  readonly number: number;
  readonly hash: string;
}): { readonly number: number; readonly hash: string } {
  if (
    !Number.isSafeInteger(input.number) || input.number < 0 ||
    !/^0x[0-9a-fA-F]{64}$/.test(input.hash)
  ) {
    throw new Error("invalid canonical block anchor");
  }
  return Object.freeze({ number: input.number, hash: input.hash.toLowerCase() });
}

function assertSameSource(actual: CanonicalSource, expected: CanonicalSource): void {
  if (
    actual.number !== expected.number ||
    actual.generation !== expected.generation ||
    actual.hash.toLowerCase() !== expected.hash.toLowerCase()
  ) {
    throw new Error("shadow evidence escaped its canonical source");
  }
}

function assertDescendantTransition(
  previous: { readonly number: number; readonly hash: string },
  current: CanonicalSource,
): void {
  if (current.number < previous.number) {
    throw new Error("canonical ancestry moved backwards");
  }
  if (
    current.number === previous.number &&
    current.hash.toLowerCase() !== previous.hash.toLowerCase()
  ) {
    throw new Error("same-height canonical source hash changed");
  }
}

function uniqueSeedAnchors(
  seeds: readonly AdapterFamilyShadowWatermarkSnapshot[],
): readonly { readonly number: number; readonly hash: string }[] {
  const values = new Map<string, { readonly number: number; readonly hash: string }>();
  for (const seed of seeds) {
    if (seed.completeThroughBlock < 0 || seed.completeThroughHash === null) continue;
    const anchor = snapshotBlockAnchor({
      number: seed.completeThroughBlock,
      hash: seed.completeThroughHash,
    });
    values.set(anchorKey(anchor), anchor);
  }
  return Object.freeze([...values.values()].sort((left, right) =>
    left.number - right.number || left.hash.localeCompare(right.hash)
  ));
}

function assertConsistentSeedHashes(
  seeds: readonly AdapterFamilyShadowWatermarkSnapshot[],
): void {
  const byHeight = new Map<number, string>();
  for (const seed of seeds) {
    if (seed.completeThroughHash === null) continue;
    const prior = byHeight.get(seed.completeThroughBlock);
    if (
      prior !== undefined &&
      prior.toLowerCase() !== seed.completeThroughHash.toLowerCase()
    ) {
      throw new Error("shadow watermark seeds disagree at one block height");
    }
    byHeight.set(seed.completeThroughBlock, seed.completeThroughHash);
  }
}

function anchorKey(anchor: { readonly number: number; readonly hash: string }): string {
  return `${anchor.number}:${anchor.hash.toLowerCase()}`;
}

function freezeBootstrapResult(
  pending: PendingIncumbent,
  status: AdapterFamilyShadowBootstrapStatus,
): AdapterFamilyShadowBootstrapResult {
  return Object.freeze({
    incumbentKey: pending.nomination.incumbentKey,
    familyId: pending.familyId,
    address: pending.nomination.address,
    status,
  });
}

function issue(
  input: AdapterFamilyObservationShadowIssue,
): AdapterFamilyObservationShadowIssue {
  return Object.freeze(input);
}

function compareSourceCoverage(
  left: AdapterFamilyShadowSourceCoverage,
  right: AdapterFamilyShadowSourceCoverage,
): number {
  return left.familyId.localeCompare(right.familyId) ||
    left.sourceId.localeCompare(right.sourceId);
}

function compareWatermark(
  left: AdapterFamilyShadowWatermarkSnapshot,
  right: AdapterFamilyShadowWatermarkSnapshot,
): number {
  return left.familyId.localeCompare(right.familyId) ||
    left.sourceId.localeCompare(right.sourceId);
}

function sortedUniqueExact(
  values: readonly string[],
  label: string,
): readonly string[] {
  const normalized = sortedUnique(values, label);
  if (!sameStringArray(normalized, values)) {
    throw new Error(`${label} must be unique and sorted`);
  }
  return Object.freeze(normalized);
}

function sortedUnique(values: readonly string[], label: string): string[] {
  for (const value of values) nonempty(value, label);
  return [...new Set(values)].sort();
}

function sameStringArray(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return left.length === right.length &&
    left.every((value, index) => value === right[index]);
}

function nonempty(value: string, label: string): string {
  if (value.trim().length === 0) throw new Error(`${label} must be non-empty`);
  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
