import type { CanonicalSource } from "./venues/adapter-request-program.js";
import type { FamilyId } from "./venues/adapter-family-identifiers.js";
import type { FamilyDomain } from "./venues/adapter-family-plugin.js";
import type { FamilyCapabilityCatalog } from "./venues/family-capability-catalog.js";
import { hashCanonical } from "./venues/canonical-value.js";

export type CatalogFamilyStageStatus =
  | "resolved"
  | "partial"
  | "unsupported";

export type CatalogInventoryMode =
  | "append-only-delta"
  | "complete-snapshot";

export type CatalogDiscoveryAuthority =
  | "append-only-nomination"
  | "complete-snapshot";

export interface CatalogFamilyExpectation {
  readonly familyId: FamilyId;
  readonly domain: FamilyDomain;
  readonly sourceIds: readonly string[];
  readonly requiresGraphProjection: boolean;
  readonly requiresPricingProjection: boolean;
}

export interface AdapterFamilyCatalogDefinition {
  readonly catalogHash: string;
  readonly families: readonly CatalogFamilyExpectation[];
  readonly terminalRemovalAuthority: CatalogTerminalRemovalAuthority;
  readonly sourceTransitionAuthority: CatalogSourceTransitionAuthority;
}

export interface CatalogDiscoverySourceAnchor {
  readonly familyId: FamilyId;
  readonly sourceId: string;
  readonly sourceFingerprint: string;
  readonly authority: CatalogDiscoveryAuthority;
  readonly status: "complete" | "partial";
  readonly completeThroughBlock: number;
  readonly completeThroughHash: string | null;
}

export interface CatalogStagedInstance<Value> {
  readonly familyId: FamilyId;
  readonly lineageId: string;
  readonly instanceKey: string;
  readonly fingerprint: string;
  readonly value: Value;
}

export interface CatalogStagedOpaqueEntry<Value> {
  readonly fingerprint: string;
  readonly value: Value;
}

export interface CatalogStagedInstanceBundle<
  Instance,
  RouteHandle,
  GraphEntry,
  PricingEntry,
> {
  /** Must equal catalogInstancePublicationKey(instance). */
  readonly instancePublicationKey: string;
  /** Every staged value is sealed against this exact source. */
  readonly source: CanonicalSource;
  readonly instance: CatalogStagedInstance<Instance>;
  readonly routeHandles: ReadonlyMap<
    string,
    CatalogStagedOpaqueEntry<RouteHandle>
  >;
  readonly graphEntries: ReadonlyMap<string, CatalogStagedOpaqueEntry<GraphEntry>>;
  readonly pricingEntries: ReadonlyMap<
    string,
    CatalogStagedOpaqueEntry<PricingEntry>
  >;
}

declare const catalogTerminalRemovalProofBrand: unique symbol;

/** Runtime-opaque proof. Only its issuing authority can resolve its payload. */
export interface CatalogTerminalRemovalProof {
  readonly [catalogTerminalRemovalProofBrand]: true;
}

export type CatalogTerminalEvidenceStatus = "terminal" | "unresolved";

declare const catalogTerminalRemovalAuthorityBrand: unique symbol;

export interface CatalogTerminalRemovalAuthority {
  readonly [catalogTerminalRemovalAuthorityBrand]: true;
}

export interface CatalogTerminalRemovalIssuer {
  readonly authority: CatalogTerminalRemovalAuthority;
  issue(input: {
    readonly familyId: FamilyId;
    readonly lineageId: string;
    readonly instanceKey: string;
    readonly source: CanonicalSource;
    readonly status: CatalogTerminalEvidenceStatus;
    readonly reason: string;
    readonly evidenceRef: string;
  }): CatalogTerminalRemovalProof;
}

declare const catalogSourceTransitionProofBrand: unique symbol;

/** Runtime-opaque canonical ancestry proof. */
export interface CatalogSourceTransitionProof {
  readonly [catalogSourceTransitionProofBrand]: true;
}

declare const catalogSourceTransitionAuthorityBrand: unique symbol;

export interface CatalogSourceTransitionAuthority {
  readonly [catalogSourceTransitionAuthorityBrand]: true;
}

export interface CatalogSourceTransitionIssuer {
  readonly authority: CatalogSourceTransitionAuthority;
  issue(input: {
    readonly previous: CanonicalSource;
    readonly current: CanonicalSource;
    readonly status: "canonical-descendant" | "unresolved";
    readonly evidenceRef: string;
  }): CatalogSourceTransitionProof;
}

export type CatalogValueKind =
  | "instance"
  | "route-handle"
  | "graph-entry"
  | "pricing-entry";

export interface CatalogValueBinding {
  readonly kind: CatalogValueKind;
  readonly key: string;
  readonly instancePublicationKey: string;
  readonly familyId: FamilyId;
  readonly lineageId: string;
  readonly instanceKey: string;
  readonly source: CanonicalSource;
}

export interface CatalogValueCarryBinding {
  readonly previous: CatalogValueBinding;
  readonly current: CatalogValueBinding;
}

export interface CatalogValueContract<Value> {
  /** Return an immutable snapshot or an issuer-bound opaque value. */
  readonly seal: (value: Value, binding: CatalogValueBinding) => Value;
  /** Reissue/rebind a carried value; wrapper-only source rewriting is invalid. */
  readonly carry: (
    value: Value,
    binding: CatalogValueCarryBinding,
  ) => Value;
  /** Fail closed unless value and issuer binding match this exact publication. */
  readonly assertValid: (
    value: Value,
    binding: CatalogValueBinding,
  ) => void;
}

declare const catalogPublicationValueAuthorityBrand: unique symbol;

/**
 * Opaque validation authority pinned into a prepared publication. This is
 * mandatory because route/exact handles cannot safely be deep-cloned.
 */
export interface CatalogPublicationValueAuthority<
  Instance,
  RouteHandle,
  GraphEntry,
  PricingEntry,
> {
  readonly [catalogPublicationValueAuthorityBrand]: {
    readonly instance: Instance;
    readonly routeHandle: RouteHandle;
    readonly graphEntry: GraphEntry;
    readonly pricingEntry: PricingEntry;
  };
}

export interface CatalogFamilyStage<
  Instance,
  RouteHandle,
  GraphEntry,
  PricingEntry,
> {
  readonly familyId: FamilyId;
  readonly domain: FamilyDomain;
  readonly source: CanonicalSource;
  readonly status: CatalogFamilyStageStatus;
  readonly inventoryMode: CatalogInventoryMode;
  readonly instances: readonly CatalogStagedInstanceBundle<
    Instance,
    RouteHandle,
    GraphEntry,
    PricingEntry
  >[];
  readonly terminalRemovals?: readonly CatalogTerminalRemovalProof[];
  readonly outcomeRefs?: readonly string[];
}

export interface CatalogOpaqueEntry<Value> {
  readonly instancePublicationKey: string;
  readonly familyId: FamilyId;
  readonly lineageId: string;
  readonly instanceKey: string;
  readonly source: CanonicalSource;
  readonly fingerprint: string;
  readonly value: Value;
}

export interface CatalogPublishedInstance<Value> {
  readonly key: string;
  readonly familyId: FamilyId;
  readonly lineageId: string;
  readonly instanceKey: string;
  readonly fingerprint: string;
  readonly value: Value;
  readonly publishedRevision: number;
}

export interface CatalogTombstone {
  readonly key: string;
  readonly familyId: FamilyId;
  readonly lineageId: string;
  readonly instanceKey: string;
  readonly removedFingerprint: string;
  readonly removedAtRevision: number;
  readonly removedAtSource: CanonicalSource;
  readonly reason: string;
  readonly outcomeRef: string | null;
}

export interface CatalogFamilyPublicationStatus {
  readonly familyId: FamilyId;
  readonly domain: FamilyDomain;
  readonly status: CatalogFamilyStageStatus;
  readonly inventoryMode: CatalogInventoryMode;
  readonly instanceCount: number;
  readonly outcomeRefs: readonly string[];
}

export interface CatalogCarriedInstance {
  readonly key: string;
  readonly familyId: FamilyId;
  readonly reason:
    | "append-only-omission"
    | "partial-omission"
    | "unsupported-family";
}

export interface AdapterFamilyCatalogPublicationEnvelope<
  Instance,
  RouteHandle,
  GraphEntry,
  PricingEntry,
> {
  readonly snapshot: {
    readonly revision: number;
    readonly chainId: string;
    readonly catalogHash: string;
    readonly source: CanonicalSource;
    readonly sourceTransition: {
      readonly previous: CanonicalSource;
      readonly current: CanonicalSource;
      readonly status: "canonical-descendant" | "unresolved";
      readonly evidenceRef: string;
    } | null;
    readonly status: "shadow-complete" | "shadow-partial";
    readonly familyStatuses: ReadonlyMap<
      FamilyId,
      CatalogFamilyPublicationStatus
    >;
    readonly sourceAnchors: ReadonlyMap<
      string,
      CatalogDiscoverySourceAnchor
    >;
    readonly delta: {
      readonly added: readonly string[];
      readonly changed: readonly string[];
      readonly removed: readonly string[];
      readonly tombstones: readonly CatalogTombstone[];
      readonly carried: readonly CatalogCarriedInstance[];
    };
    readonly publicationFingerprint: string;
  };
  readonly privateState: {
    readonly instances: ReadonlyMap<string, CatalogPublishedInstance<Instance>>;
    readonly tombstones: ReadonlyMap<string, CatalogTombstone>;
    readonly routeHandles: ReadonlyMap<
      string,
      CatalogOpaqueEntry<RouteHandle>
    >;
    readonly graphEntries: ReadonlyMap<string, CatalogOpaqueEntry<GraphEntry>>;
    readonly pricingEntries: ReadonlyMap<
      string,
      CatalogOpaqueEntry<PricingEntry>
    >;
  };
}

interface CatalogTerminalRemovalRecord {
  readonly familyId: FamilyId;
  readonly lineageId: string;
  readonly instanceKey: string;
  readonly source: CanonicalSource;
  readonly status: CatalogTerminalEvidenceStatus;
  readonly reason: string;
  readonly evidenceRef: string;
}

interface CatalogSourceTransitionRecord {
  readonly previous: CanonicalSource;
  readonly current: CanonicalSource;
  readonly status: "canonical-descendant" | "unresolved";
  readonly evidenceRef: string;
}

interface CatalogPublicationValueAuthorityRecord {
  readonly instance: CatalogValueContract<unknown>;
  readonly routeHandle: CatalogValueContract<unknown>;
  readonly graphEntry: CatalogValueContract<unknown>;
  readonly pricingEntry: CatalogValueContract<unknown>;
}

interface CatalogPublicationIssue {
  readonly previous: object | null;
  readonly valueAuthority: object;
  readonly terminalRemovalAuthority: object;
  readonly sourceTransitionAuthority: object;
  readonly definitionFingerprint: string;
  readonly assertContentValid: () => void;
}

const terminalRemovalAuthorityRecords = new WeakMap<
  object,
  WeakMap<object, CatalogTerminalRemovalRecord>
>();
const sourceTransitionAuthorityRecords = new WeakMap<
  object,
  WeakMap<object, CatalogSourceTransitionRecord>
>();
const publicationValueAuthorityRecords = new WeakMap<
  object,
  CatalogPublicationValueAuthorityRecord
>();
const publicationIssues = new WeakMap<object, CatalogPublicationIssue>();

export function createCatalogTerminalRemovalIssuer():
  CatalogTerminalRemovalIssuer {
  const proofs = new WeakMap<object, CatalogTerminalRemovalRecord>();
  const authority = Object.freeze({}) as CatalogTerminalRemovalAuthority;
  const issuer: CatalogTerminalRemovalIssuer = Object.freeze({
    authority,
    issue(input: {
      readonly familyId: FamilyId;
      readonly lineageId: string;
      readonly instanceKey: string;
      readonly source: CanonicalSource;
      readonly status: CatalogTerminalEvidenceStatus;
      readonly reason: string;
      readonly evidenceRef: string;
    }): CatalogTerminalRemovalProof {
      nonempty(input.familyId, "terminal proof familyId");
      nonempty(input.lineageId, "terminal proof lineageId");
      nonempty(input.instanceKey, "terminal proof instanceKey");
      assertCanonicalSource(input.source);
      if (input.status !== "terminal" && input.status !== "unresolved") {
        throw new Error(`invalid terminal evidence status ${String(input.status)}`);
      }
      nonempty(input.reason, "terminal proof reason");
      nonempty(input.evidenceRef, "terminal proof evidence ref");
      const proof = Object.freeze({}) as CatalogTerminalRemovalProof;
      proofs.set(proof, Object.freeze({
        familyId: input.familyId,
        lineageId: input.lineageId,
        instanceKey: input.instanceKey,
        source: freezeCanonicalSource(input.source),
        status: input.status,
        reason: input.reason,
        evidenceRef: input.evidenceRef,
      }));
      return proof;
    },
  });
  terminalRemovalAuthorityRecords.set(authority, proofs);
  return issuer;
}

export function createCatalogSourceTransitionIssuer():
  CatalogSourceTransitionIssuer {
  const proofs = new WeakMap<object, CatalogSourceTransitionRecord>();
  const authority = Object.freeze({}) as CatalogSourceTransitionAuthority;
  const issuer: CatalogSourceTransitionIssuer = Object.freeze({
    authority,
    issue(input: {
      readonly previous: CanonicalSource;
      readonly current: CanonicalSource;
      readonly status: "canonical-descendant" | "unresolved";
      readonly evidenceRef: string;
    }): CatalogSourceTransitionProof {
      assertCanonicalSource(input.previous);
      assertCanonicalSource(input.current);
      if (
        input.status !== "canonical-descendant" &&
        input.status !== "unresolved"
      ) {
        throw new Error(`invalid source transition status ${String(input.status)}`);
      }
      nonempty(input.evidenceRef, "source transition evidence ref");
      const proof = Object.freeze({}) as CatalogSourceTransitionProof;
      proofs.set(proof, Object.freeze({
        previous: freezeCanonicalSource(input.previous),
        current: freezeCanonicalSource(input.current),
        status: input.status,
        evidenceRef: input.evidenceRef,
      }));
      return proof;
    },
  });
  sourceTransitionAuthorityRecords.set(authority, proofs);
  return issuer;
}

export function createCatalogPublicationValueAuthority<
  Instance,
  RouteHandle,
  GraphEntry,
  PricingEntry,
>(input: {
  readonly instance: CatalogValueContract<Instance>;
  readonly routeHandle: CatalogValueContract<RouteHandle>;
  readonly graphEntry: CatalogValueContract<GraphEntry>;
  readonly pricingEntry: CatalogValueContract<PricingEntry>;
}): CatalogPublicationValueAuthority<
  Instance,
  RouteHandle,
  GraphEntry,
  PricingEntry
> {
  const authority = Object.freeze({}) as CatalogPublicationValueAuthority<
    Instance,
    RouteHandle,
    GraphEntry,
    PricingEntry
  >;
  publicationValueAuthorityRecords.set(authority, {
    instance: assertValueContract(input.instance, "instance"),
    routeHandle: assertValueContract(input.routeHandle, "route handle"),
    graphEntry: assertValueContract(input.graphEntry, "Graph entry"),
    pricingEntry: assertValueContract(input.pricingEntry, "pricing entry"),
  });
  return authority;
}

export function catalogPublicationDefinition(
  catalog: Pick<FamilyCapabilityCatalog, "catalogHash" | "listAll">,
  authorities: {
    readonly terminalRemovalAuthority: CatalogTerminalRemovalAuthority;
    readonly sourceTransitionAuthority: CatalogSourceTransitionAuthority;
  },
): AdapterFamilyCatalogDefinition {
  nonempty(catalog.catalogHash, "catalog hash");
  assertTerminalRemovalAuthority(authorities.terminalRemovalAuthority);
  assertSourceTransitionAuthority(authorities.sourceTransitionAuthority);
  const seen = new Set<FamilyId>();
  const families = catalog.listAll().map((family) => {
    const { familyId, domain } = family.plugin.manifest;
    if (seen.has(familyId)) {
      throw new Error(`catalog publication duplicates Family ${familyId}`);
    }
    seen.add(familyId);
    const sourceIds = "discovery" in family.plugin
      ? uniqueSorted(family.plugin.discovery.sources)
      : [];
    return Object.freeze({
      familyId,
      domain,
      sourceIds: Object.freeze(sourceIds),
      requiresGraphProjection:
        domain === "swap" || domain === "protocol" || domain === "credit",
      requiresPricingProjection: domain === "swap" || domain === "protocol",
    });
  });
  families.sort((left, right) => left.familyId.localeCompare(right.familyId));
  return Object.freeze({
    catalogHash: catalog.catalogHash,
    families: Object.freeze(families),
    terminalRemovalAuthority: authorities.terminalRemovalAuthority,
    sourceTransitionAuthority: authorities.sourceTransitionAuthority,
  });
}

/** Collision-free logical key; no delimiter restrictions leak into Family ids. */
export function catalogInstancePublicationKey(input: {
  readonly familyId: FamilyId;
  readonly lineageId: string;
  readonly instanceKey: string;
}): string {
  nonempty(input.familyId, "instance familyId");
  nonempty(input.lineageId, "instance lineageId");
  nonempty(input.instanceKey, "instance key");
  return lengthPrefixed([
    input.familyId,
    input.lineageId,
    input.instanceKey,
  ]);
}

export function catalogFamilySourceAnchorKey(
  familyId: FamilyId,
  sourceId: string,
): string {
  nonempty(familyId, "source anchor familyId");
  nonempty(sourceId, "source anchor sourceId");
  return lengthPrefixed([familyId, sourceId]);
}

/**
 * Binds a Family/source claim to one canonical publication generation. The
 * authority and coverage status remain explicit fields on the anchor.
 */
export function catalogDiscoverySourceFingerprint(input: {
  readonly familyId: FamilyId;
  readonly sourceId: string;
  readonly source: CanonicalSource;
}): string {
  assertCanonicalSource(input.source);
  nonempty(input.familyId, "source fingerprint familyId");
  nonempty(input.sourceId, "source fingerprint sourceId");
  return hashCanonical({
    format: "adapter-family-catalog-source-v1",
    familyId: input.familyId,
    sourceId: input.sourceId,
    source: canonicalSourceProjection(input.source),
  });
}

export function prepareAdapterFamilyCatalogPublication<
  Instance,
  RouteHandle,
  GraphEntry,
  PricingEntry,
>(input: {
  readonly definition: AdapterFamilyCatalogDefinition;
  readonly chainId: string;
  readonly source: CanonicalSource;
  readonly previous: AdapterFamilyCatalogPublicationEnvelope<
    Instance,
    RouteHandle,
    GraphEntry,
    PricingEntry
  > | null;
  readonly stages: readonly CatalogFamilyStage<
    Instance,
    RouteHandle,
    GraphEntry,
    PricingEntry
  >[];
  readonly sourceAnchors: readonly CatalogDiscoverySourceAnchor[];
  readonly valueAuthority: CatalogPublicationValueAuthority<
    Instance,
    RouteHandle,
    GraphEntry,
    PricingEntry
  >;
  readonly sourceTransitionProof?: CatalogSourceTransitionProof;
}): AdapterFamilyCatalogPublicationEnvelope<
  Instance,
  RouteHandle,
  GraphEntry,
  PricingEntry
> {
  const definition = sealCatalogDefinition(input.definition);
  nonempty(input.chainId, "publication chainId");
  assertCanonicalSource(input.source);
  assertPreviousCompatible(input.previous, definition, input.chainId);
  const valueAuthority = resolvePublicationValueAuthority(input.valueAuthority);
  if (input.previous === null) {
    assertNoUnexpectedTransitionProof(input.sourceTransitionProof);
  } else {
    const priorIssue = assertIssuedPublication(input.previous);
    if (priorIssue.valueAuthority !== input.valueAuthority) {
      throw new Error("publication successor changes value authority");
    }
    if (
      priorIssue.terminalRemovalAuthority !==
        definition.terminalRemovalAuthority ||
      priorIssue.sourceTransitionAuthority !==
        definition.sourceTransitionAuthority
    ) {
      throw new Error("publication successor changes proof authority");
    }
    if (
      priorIssue.definitionFingerprint !==
        catalogDefinitionFingerprint(definition)
    ) {
      throw new Error("publication successor changes catalog definition");
    }
    priorIssue.assertContentValid();
  }
  const transition = input.previous === null
    ? null
    : resolveSourceTransitionProof({
      authority: definition.sourceTransitionAuthority,
      proof: input.sourceTransitionProof,
      previous: input.previous.snapshot.source,
      current: input.source,
    });

  const revision = (input.previous?.snapshot.revision ?? 0) + 1;
  const expectedFamilies = new Map(
    definition.families.map((family) => [family.familyId, family]),
  );
  const stageByFamily = validateStageMatrix(
    input.stages,
    expectedFamilies,
    input.source,
  );
  const anchors = validateSourceAnchorMatrix(
    input.sourceAnchors,
    definition.families,
    input.source,
  );

  const nextInstances = new Map(input.previous?.privateState.instances ?? []);
  const nextTombstones = new Map(
    input.previous?.privateState.tombstones ?? [],
  );
  const nextRouteHandles = new Map<
    string,
    CatalogOpaqueEntry<RouteHandle>
  >();
  const nextGraphEntries = new Map<string, CatalogOpaqueEntry<GraphEntry>>();
  const nextPricingEntries = new Map<
    string,
    CatalogOpaqueEntry<PricingEntry>
  >();
  const added: string[] = [];
  const changed: string[] = [];
  const removed: string[] = [];
  const newTombstones: CatalogTombstone[] = [];
  const carried: CatalogCarriedInstance[] = [];
  const familyStatuses = new Map<FamilyId, CatalogFamilyPublicationStatus>();

  for (const expectation of definition.families) {
    const stage = stageByFamily.get(expectation.familyId)!;
    const familyAnchors = expectation.sourceIds.map((sourceId) =>
      anchors.get(catalogFamilySourceAnchorKey(expectation.familyId, sourceId))!
    );
    validateStageAuthority(stage, familyAnchors, input.source);

    const priorFamilyKeys = new Set(
      [...nextInstances]
        .filter(([, instance]) => instance.familyId === expectation.familyId)
        .map(([key]) => key),
    );
    const stagedKeys = new Set<string>();
    const stageOutcomeRefs = validateOutcomeRefs(stage.outcomeRefs ?? []);

    for (const bundle of stage.instances) {
      const stagedInstance = bundle.instance;
      validateStagedInstance(stagedInstance, expectation.familyId);
      const key = catalogInstancePublicationKey(stagedInstance);
      validateStagedBundleBinding(bundle, key, input.source);
      if (stagedKeys.has(key)) {
        throw new Error(`Family ${expectation.familyId} duplicates instance ${key}`);
      }
      stagedKeys.add(key);
      const prior = nextInstances.get(key);
      const sealed = sealStagedBundle({
        bundle,
        expectation,
        key,
        source: input.source,
        valueAuthority,
      });
      if (prior === undefined) {
        added.push(key);
        nextInstances.set(
          key,
          freezePublishedInstance(key, sealed.instance, revision),
        );
      } else if (prior.fingerprint !== stagedInstance.fingerprint) {
        changed.push(key);
        nextInstances.set(
          key,
          freezePublishedInstance(key, sealed.instance, revision),
        );
      } else {
        assertOpaqueBundleUnchanged(input.previous!, key, sealed);
        nextInstances.set(
          key,
          freezePublishedInstance(key, sealed.instance, prior.publishedRevision),
        );
      }
      appendOpaqueBundle(
        sealed,
        nextRouteHandles,
        nextGraphEntries,
        nextPricingEntries,
      );
      // A successful re-admission supersedes an active tombstone. An
      // unchanged live record is also authoritative over malformed old state.
      nextTombstones.delete(key);
    }

    const removalKeys = new Set<string>();
    for (const proof of stage.terminalRemovals ?? []) {
      const terminal = resolveTerminalRemovalProof({
        authority: definition.terminalRemovalAuthority,
        proof,
        familyId: expectation.familyId,
        source: input.source,
      });
      const key = catalogInstancePublicationKey(terminal);
      if (removalKeys.has(key)) {
        throw new Error(
          `Family ${expectation.familyId} duplicates terminal removal ${key}`,
        );
      }
      if (stagedKeys.has(key)) {
        throw new Error(
          `Family ${expectation.familyId} both stages and removes ${key}`,
        );
      }
      removalKeys.add(key);
      const prior = nextInstances.get(key);
      if (prior === undefined) {
        throw new Error(`terminal removal does not name a published instance ${key}`);
      }
      if (
        prior.lineageId !== terminal.lineageId ||
        prior.instanceKey !== terminal.instanceKey
      ) {
        throw new Error(`terminal proof binding does not match ${key}`);
      }
      if (!stageOutcomeRefs.includes(terminal.evidenceRef)) {
        throw new Error(
          `terminal proof evidence ${terminal.evidenceRef} is missing from Family outcomeRefs`,
        );
      }
      removeAndTombstone({
        key,
        prior,
        reason: terminal.reason,
        outcomeRef: terminal.evidenceRef,
        revision,
        source: input.source,
        nextInstances,
        nextTombstones,
        removed,
        newTombstones,
      });
    }

    for (const key of priorFamilyKeys) {
      if (stagedKeys.has(key) || removalKeys.has(key)) continue;
      const prior = nextInstances.get(key);
      if (prior === undefined) continue;
      if (stage.inventoryMode === "complete-snapshot") {
        removeAndTombstone({
          key,
          prior,
          reason: "complete-snapshot-omission",
          outcomeRef: null,
          revision,
          source: input.source,
          nextInstances,
          nextTombstones,
          removed,
          newTombstones,
        });
      } else {
        carried.push(Object.freeze({
          key,
          familyId: expectation.familyId,
          reason: carryReason(stage.status),
        }));
        const carriedInstance = carryPublishedInstance({
          previous: input.previous!,
          instance: prior,
          source: input.source,
          contract: valueAuthority.instance,
        });
        nextInstances.set(key, carriedInstance);
        carryOpaqueBundle({
          previous: input.previous!,
          instance: carriedInstance,
          source: input.source,
          expectation,
          valueAuthority,
          nextRouteHandles,
          nextGraphEntries,
          nextPricingEntries,
        });
      }
    }

    const familyInstanceCount = [...nextInstances.values()].filter(
      (instance) => instance.familyId === expectation.familyId,
    ).length;
    if (
      expectation.domain === "funding" &&
      stage.status === "resolved" &&
      familyInstanceCount === 0
    ) {
      throw new Error(
        `resolved funding Family ${expectation.familyId} lacks atomic instance state`,
      );
    }
    familyStatuses.set(expectation.familyId, Object.freeze({
      familyId: expectation.familyId,
      domain: expectation.domain,
      status: stage.status,
      inventoryMode: stage.inventoryMode,
      instanceCount: familyInstanceCount,
      outcomeRefs: Object.freeze(stageOutcomeRefs),
    }));
  }

  added.sort();
  changed.sort();
  removed.sort();
  newTombstones.sort((left, right) => left.key.localeCompare(right.key));
  carried.sort((left, right) => left.key.localeCompare(right.key));

  const frozenInstances = new SealedReadonlyMap(nextInstances);
  const frozenTombstones = new SealedReadonlyMap(nextTombstones);
  const frozenFamilyStatuses = new SealedReadonlyMap(familyStatuses);
  const frozenAnchors = new SealedReadonlyMap(anchors);
  const routeHandles = new SealedReadonlyMap(nextRouteHandles);
  const graphEntries = new SealedReadonlyMap(nextGraphEntries);
  const pricingEntries = new SealedReadonlyMap(nextPricingEntries);
  assertOpaqueStateComplete({
    definition,
    source: input.source,
    instances: frozenInstances,
    routeHandles,
    graphEntries,
    pricingEntries,
  });
  const status = definition.families.every((expectation) => {
    const stage = stageByFamily.get(expectation.familyId)!;
    return stage.status === "resolved" &&
      expectation.sourceIds.every(
        (sourceId) => anchors.get(
          catalogFamilySourceAnchorKey(expectation.familyId, sourceId),
        )!.status === "complete",
      ) &&
      hasCompleteInventoryAuthority({
        expectation,
        stage,
        anchors,
        previous: input.previous,
        transition,
      });
  })
    ? "shadow-complete"
    : "shadow-partial";
  const delta = Object.freeze({
    added: Object.freeze(added),
    changed: Object.freeze(changed),
    removed: Object.freeze(removed),
    tombstones: Object.freeze(newTombstones),
    carried: Object.freeze(carried),
  });
  const source = freezeCanonicalSource(input.source);
  const sourceTransition = transition === null
    ? null
    : Object.freeze({
      previous: freezeCanonicalSource(transition.previous),
      current: freezeCanonicalSource(transition.current),
      status: transition.status,
      evidenceRef: transition.evidenceRef,
    });
  const publicationFingerprint = hashCanonical({
    format: "adapter-family-catalog-publication-v1",
    revision,
    chainId: input.chainId,
    catalogHash: definition.catalogHash,
    source: canonicalSourceProjection(source),
    sourceTransition: sourceTransition === null
      ? null
      : {
        previous: canonicalSourceProjection(sourceTransition.previous),
        current: canonicalSourceProjection(sourceTransition.current),
        status: sourceTransition.status,
        evidenceRef: sourceTransition.evidenceRef,
      },
    status,
    familyStatuses: sortedEntries(frozenFamilyStatuses).map(([, family]) => ({
      familyId: family.familyId,
      domain: family.domain,
      status: family.status,
      inventoryMode: family.inventoryMode,
      instanceCount: family.instanceCount,
      outcomeRefs: family.outcomeRefs,
    })),
    sourceAnchors: sortedEntries(frozenAnchors).map(([key, anchor]) => ({
      key,
      familyId: anchor.familyId,
      sourceId: anchor.sourceId,
      sourceFingerprint: anchor.sourceFingerprint,
      authority: anchor.authority,
      status: anchor.status,
      completeThroughBlock: anchor.completeThroughBlock,
      completeThroughHash: anchor.completeThroughHash,
    })),
    delta: {
      added,
      changed,
      removed,
      tombstones: newTombstones.map(tombstoneProjection),
      carried: carried.map((item) => ({
        key: item.key,
        familyId: item.familyId,
        reason: item.reason,
      })),
    },
    instances: sortedEntries(frozenInstances).map(([key, instance]) => ({
      key,
      familyId: instance.familyId,
      lineageId: instance.lineageId,
      instanceKey: instance.instanceKey,
      fingerprint: instance.fingerprint,
      publishedRevision: instance.publishedRevision,
    })),
    tombstones: sortedEntries(frozenTombstones).map(([, item]) =>
      tombstoneProjection(item)
    ),
    routeHandles: opaqueFingerprintProjection(routeHandles),
    graphEntries: opaqueFingerprintProjection(graphEntries),
    pricingEntries: opaqueFingerprintProjection(pricingEntries),
  });

  const envelope = Object.freeze({
    snapshot: Object.freeze({
      revision,
      chainId: input.chainId,
      catalogHash: definition.catalogHash,
      source,
      sourceTransition,
      status,
      familyStatuses: frozenFamilyStatuses,
      sourceAnchors: frozenAnchors,
      delta,
      publicationFingerprint,
    }),
    privateState: Object.freeze({
      instances: frozenInstances,
      tombstones: frozenTombstones,
      routeHandles,
      graphEntries,
      pricingEntries,
    }),
  });
  publicationIssues.set(envelope, Object.freeze({
    previous: input.previous,
    valueAuthority: input.valueAuthority,
    terminalRemovalAuthority: definition.terminalRemovalAuthority,
    sourceTransitionAuthority: definition.sourceTransitionAuthority,
    definitionFingerprint: catalogDefinitionFingerprint(definition),
    assertContentValid: () => {
      assertPublishedContentValid(envelope, definition, valueAuthority);
    },
  }));
  return envelope;
}

export class AdapterFamilyCatalogPublicationStore<
  Instance,
  RouteHandle,
  GraphEntry,
  PricingEntry,
> {
  readonly #chainId: string;
  readonly #catalogHash: string;
  readonly #definitionFingerprint: string;
  readonly #terminalRemovalAuthority: object;
  readonly #sourceTransitionAuthority: object;
  readonly #valueAuthority: object;
  private published: AdapterFamilyCatalogPublicationEnvelope<
    Instance,
    RouteHandle,
    GraphEntry,
    PricingEntry
  > | null = null;

  constructor(input: {
    readonly definition: AdapterFamilyCatalogDefinition;
    readonly chainId: string;
    readonly valueAuthority: CatalogPublicationValueAuthority<
      Instance,
      RouteHandle,
      GraphEntry,
      PricingEntry
    >;
  }) {
    const definition = sealCatalogDefinition(input.definition);
    nonempty(input.chainId, "publication store chainId");
    resolvePublicationValueAuthority(input.valueAuthority);
    this.#chainId = input.chainId;
    this.#catalogHash = definition.catalogHash;
    this.#definitionFingerprint = catalogDefinitionFingerprint(definition);
    this.#terminalRemovalAuthority = definition.terminalRemovalAuthority;
    this.#sourceTransitionAuthority = definition.sourceTransitionAuthority;
    this.#valueAuthority = input.valueAuthority;
  }

  capture(): AdapterFamilyCatalogPublicationEnvelope<
    Instance,
    RouteHandle,
    GraphEntry,
    PricingEntry
  > | null {
    return this.published;
  }

  async compareAndPublish(input: {
    readonly expected: AdapterFamilyCatalogPublicationEnvelope<
      Instance,
      RouteHandle,
      GraphEntry,
      PricingEntry
    > | null;
    readonly staged: AdapterFamilyCatalogPublicationEnvelope<
      Instance,
      RouteHandle,
      GraphEntry,
      PricingEntry
    >;
    readonly verifyCanonicalSource: (
      source: CanonicalSource,
    ) => void | Promise<void>;
    readonly assertGenerationCurrent: (source: CanonicalSource) => void;
  }): Promise<boolean> {
    if (this.published !== input.expected) return false;
    const issue = assertIssuedSuccessor(input.expected, input.staged);
    if (
      issue.valueAuthority !== this.#valueAuthority ||
      issue.terminalRemovalAuthority !== this.#terminalRemovalAuthority ||
      issue.sourceTransitionAuthority !== this.#sourceTransitionAuthority ||
      issue.definitionFingerprint !== this.#definitionFingerprint ||
      input.staged.snapshot.chainId !== this.#chainId ||
      input.staged.snapshot.catalogHash !== this.#catalogHash
    ) {
      throw new Error("staged publication does not match store authority");
    }
    assertPublishSuccessor(input.expected, input.staged);
    issue.assertContentValid();
    await input.verifyCanonicalSource(input.staged.snapshot.source);
    if (this.published !== input.expected) return false;
    issue.assertContentValid();
    input.assertGenerationCurrent(input.staged.snapshot.source);
    if (this.published !== input.expected) return false;
    issue.assertContentValid();
    this.published = input.staged;
    return true;
  }
}

function sealCatalogDefinition(
  definition: AdapterFamilyCatalogDefinition,
): AdapterFamilyCatalogDefinition {
  validateDefinition(definition);
  return Object.freeze({
    catalogHash: definition.catalogHash,
    families: Object.freeze(definition.families.map((family) =>
      Object.freeze({
        familyId: family.familyId,
        domain: family.domain,
        sourceIds: Object.freeze([...family.sourceIds]),
        requiresGraphProjection: family.requiresGraphProjection,
        requiresPricingProjection: family.requiresPricingProjection,
      })
    )),
    terminalRemovalAuthority: definition.terminalRemovalAuthority,
    sourceTransitionAuthority: definition.sourceTransitionAuthority,
  });
}

function catalogDefinitionFingerprint(
  definition: AdapterFamilyCatalogDefinition,
): string {
  return hashCanonical({
    format: "adapter-family-catalog-definition-v1",
    catalogHash: definition.catalogHash,
    families: [...definition.families]
      .sort((left, right) => left.familyId.localeCompare(right.familyId))
      .map((family) => ({
        familyId: family.familyId,
        domain: family.domain,
        sourceIds: [...family.sourceIds].sort(),
        requiresGraphProjection: family.requiresGraphProjection,
        requiresPricingProjection: family.requiresPricingProjection,
      })),
  });
}

function validateDefinition(definition: AdapterFamilyCatalogDefinition): void {
  nonempty(definition.catalogHash, "catalog definition hash");
  assertTerminalRemovalAuthority(definition.terminalRemovalAuthority);
  assertSourceTransitionAuthority(definition.sourceTransitionAuthority);
  const seen = new Set<FamilyId>();
  for (const family of definition.families) {
    nonempty(family.familyId, "catalog Family id");
    assertFamilyDomain(family.domain);
    if (seen.has(family.familyId)) {
      throw new Error(`catalog definition duplicates Family ${family.familyId}`);
    }
    seen.add(family.familyId);
    if (new Set(family.sourceIds).size !== family.sourceIds.length) {
      throw new Error(`Family ${family.familyId} duplicates a discovery source`);
    }
    for (const sourceId of family.sourceIds) {
      nonempty(sourceId, `Family ${family.familyId} source id`);
    }
    if (typeof family.requiresGraphProjection !== "boolean") {
      throw new Error(`Family ${family.familyId} Graph requirement must be boolean`);
    }
    if (typeof family.requiresPricingProjection !== "boolean") {
      throw new Error(`Family ${family.familyId} pricing requirement must be boolean`);
    }
  }
}

function validateStageMatrix<Instance, RouteHandle, GraphEntry, PricingEntry>(
  stages: readonly CatalogFamilyStage<
    Instance,
    RouteHandle,
    GraphEntry,
    PricingEntry
  >[],
  expectedFamilies: ReadonlyMap<FamilyId, CatalogFamilyExpectation>,
  source: CanonicalSource,
): Map<FamilyId, CatalogFamilyStage<
  Instance,
  RouteHandle,
  GraphEntry,
  PricingEntry
>> {
  const byFamily = new Map<FamilyId, CatalogFamilyStage<
    Instance,
    RouteHandle,
    GraphEntry,
    PricingEntry
  >>();
  for (const stage of stages) {
    const expectation = expectedFamilies.get(stage.familyId);
    if (expectation === undefined) {
      throw new Error(`catalog publication has extra Family ${stage.familyId}`);
    }
    if (byFamily.has(stage.familyId)) {
      throw new Error(`catalog publication duplicates Family ${stage.familyId}`);
    }
    if (stage.domain !== expectation.domain) {
      throw new Error(`Family ${stage.familyId} publication domain mismatch`);
    }
    assertSameSource(stage.source, source, `Family ${stage.familyId} stage`);
    assertStageStatus(stage.status);
    assertInventoryMode(stage.inventoryMode);
    byFamily.set(stage.familyId, stage);
  }
  for (const familyId of expectedFamilies.keys()) {
    if (!byFamily.has(familyId)) {
      throw new Error(`catalog publication is missing Family ${familyId}`);
    }
  }
  return byFamily;
}

function validateSourceAnchorMatrix(
  staged: readonly CatalogDiscoverySourceAnchor[],
  families: readonly CatalogFamilyExpectation[],
  source: CanonicalSource,
): Map<string, CatalogDiscoverySourceAnchor> {
  const expected = new Map<string, CatalogFamilyExpectation>();
  for (const family of families) {
    for (const sourceId of family.sourceIds) {
      expected.set(catalogFamilySourceAnchorKey(family.familyId, sourceId), family);
    }
  }
  const anchors = new Map<string, CatalogDiscoverySourceAnchor>();
  for (const anchor of staged) {
    const key = catalogFamilySourceAnchorKey(anchor.familyId, anchor.sourceId);
    if (!expected.has(key)) {
      throw new Error(
        `catalog publication has extra source anchor ${anchor.familyId}/${anchor.sourceId}`,
      );
    }
    if (anchors.has(key)) {
      throw new Error(
        `catalog publication duplicates source anchor ${anchor.familyId}/${anchor.sourceId}`,
      );
    }
    validateSourceAnchor(anchor, source);
    anchors.set(key, Object.freeze({
      ...anchor,
      completeThroughHash: anchor.completeThroughHash === null
        ? null
        : canonicalBlockHash(
          anchor.completeThroughHash,
          "source anchor hash",
        ),
    }));
  }
  for (const key of expected.keys()) {
    if (!anchors.has(key)) {
      throw new Error(`catalog publication is missing source anchor ${key}`);
    }
  }
  return anchors;
}

function validateSourceAnchor(
  anchor: CatalogDiscoverySourceAnchor,
  source: CanonicalSource,
): void {
  const expectedFingerprint = catalogDiscoverySourceFingerprint({
    familyId: anchor.familyId,
    sourceId: anchor.sourceId,
    source,
  });
  if (anchor.sourceFingerprint !== expectedFingerprint) {
    throw new Error(
      `source fingerprint mismatch for ${anchor.familyId}/${anchor.sourceId}`,
    );
  }
  if (
    anchor.authority !== "append-only-nomination" &&
    anchor.authority !== "complete-snapshot"
  ) {
    throw new Error(`invalid source authority ${String(anchor.authority)}`);
  }
  if (anchor.status !== "complete" && anchor.status !== "partial") {
    throw new Error(`invalid source anchor status ${String(anchor.status)}`);
  }
  if (
    !Number.isSafeInteger(anchor.completeThroughBlock) ||
    anchor.completeThroughBlock < -1 ||
    anchor.completeThroughBlock > source.number
  ) {
    throw new Error(
      `invalid source anchor block ${anchor.completeThroughBlock}`,
    );
  }
  if (
    (anchor.completeThroughBlock === -1) !==
      (anchor.completeThroughHash === null)
  ) {
    throw new Error("source anchor hash must be null iff block is -1");
  }
  if (anchor.completeThroughHash !== null) {
    canonicalBlockHash(anchor.completeThroughHash, "source anchor hash");
  }
  if (anchor.completeThroughBlock === source.number) {
    if (!sameBlockHash(anchor.completeThroughHash, source.hash)) {
      throw new Error("source anchor hash does not match publication source");
    }
  }
  if (
    anchor.status === "complete" &&
    (anchor.completeThroughBlock !== source.number ||
      !sameBlockHash(anchor.completeThroughHash, source.hash))
  ) {
    throw new Error("complete source anchor must cover the publication source");
  }
}

function validateStageAuthority<Instance, RouteHandle, GraphEntry, PricingEntry>(
  stage: CatalogFamilyStage<Instance, RouteHandle, GraphEntry, PricingEntry>,
  anchors: readonly CatalogDiscoverySourceAnchor[],
  source: CanonicalSource,
): void {
  if (stage.status === "resolved") {
    for (const anchor of anchors) {
      if (
        anchor.status !== "complete" ||
        anchor.completeThroughBlock !== source.number ||
        !sameBlockHash(anchor.completeThroughHash, source.hash)
      ) {
        throw new Error(
          `resolved Family ${stage.familyId} lacks complete source authority`,
        );
      }
    }
  }
  if (
    stage.inventoryMode === "complete-snapshot" &&
    stage.status !== "resolved"
  ) {
    throw new Error(
      `${stage.status} Family ${stage.familyId} cannot claim a complete snapshot`,
    );
  }
  if (
    stage.inventoryMode === "complete-snapshot" &&
    anchors.some((anchor) => anchor.authority !== "complete-snapshot")
  ) {
    throw new Error(
      `Family ${stage.familyId} lacks complete-snapshot source authority`,
    );
  }
  if (stage.status === "unsupported") {
    if (stage.instances.length > 0 || (stage.terminalRemovals?.length ?? 0) > 0) {
      throw new Error(`unsupported Family ${stage.familyId} cannot stage changes`);
    }
  }
}

function validateStagedInstance<Value>(
  instance: CatalogStagedInstance<Value>,
  familyId: FamilyId,
): void {
  if (instance.familyId !== familyId) {
    throw new Error(`Family ${familyId} staged a foreign instance`);
  }
  nonempty(instance.lineageId, `Family ${familyId} lineage id`);
  nonempty(instance.instanceKey, `Family ${familyId} instance key`);
  nonempty(instance.fingerprint, `Family ${familyId} instance fingerprint`);
}

function freezePublishedInstance<Value>(
  key: string,
  instance: CatalogStagedInstance<Value>,
  revision: number,
): CatalogPublishedInstance<Value> {
  return Object.freeze({
    key,
    familyId: instance.familyId,
    lineageId: instance.lineageId,
    instanceKey: instance.instanceKey,
    fingerprint: instance.fingerprint,
    value: instance.value,
    publishedRevision: revision,
  });
}

function removeAndTombstone<Value>(input: {
  readonly key: string;
  readonly prior: CatalogPublishedInstance<Value>;
  readonly reason: string;
  readonly outcomeRef: string | null;
  readonly revision: number;
  readonly source: CanonicalSource;
  readonly nextInstances: Map<string, CatalogPublishedInstance<Value>>;
  readonly nextTombstones: Map<string, CatalogTombstone>;
  readonly removed: string[];
  readonly newTombstones: CatalogTombstone[];
}): void {
  const tombstone = Object.freeze({
    key: input.key,
    familyId: input.prior.familyId,
    lineageId: input.prior.lineageId,
    instanceKey: input.prior.instanceKey,
    removedFingerprint: input.prior.fingerprint,
    removedAtRevision: input.revision,
    removedAtSource: freezeCanonicalSource(input.source),
    reason: input.reason,
    outcomeRef: input.outcomeRef,
  });
  input.nextInstances.delete(input.key);
  input.nextTombstones.set(input.key, tombstone);
  input.removed.push(input.key);
  input.newTombstones.push(tombstone);
}

interface SealedCatalogInstanceBundle<
  Instance,
  RouteHandle,
  GraphEntry,
  PricingEntry,
> {
  readonly instance: CatalogStagedInstance<Instance>;
  readonly routeHandles: ReadonlyMap<string, CatalogOpaqueEntry<RouteHandle>>;
  readonly graphEntries: ReadonlyMap<string, CatalogOpaqueEntry<GraphEntry>>;
  readonly pricingEntries: ReadonlyMap<string, CatalogOpaqueEntry<PricingEntry>>;
}

interface ResolvedPublicationValueAuthority<
  Instance,
  RouteHandle,
  GraphEntry,
  PricingEntry,
> {
  readonly instance: CatalogValueContract<Instance>;
  readonly routeHandle: CatalogValueContract<RouteHandle>;
  readonly graphEntry: CatalogValueContract<GraphEntry>;
  readonly pricingEntry: CatalogValueContract<PricingEntry>;
}

function resolvePublicationValueAuthority<
  Instance,
  RouteHandle,
  GraphEntry,
  PricingEntry,
>(authority: CatalogPublicationValueAuthority<
  Instance,
  RouteHandle,
  GraphEntry,
  PricingEntry
>): ResolvedPublicationValueAuthority<
  Instance,
  RouteHandle,
  GraphEntry,
  PricingEntry
> {
  const record = publicationValueAuthorityRecords.get(authority);
  if (record === undefined) {
    throw new Error("publication value authority was not centrally issued");
  }
  return record as ResolvedPublicationValueAuthority<
    Instance,
    RouteHandle,
    GraphEntry,
    PricingEntry
  >;
}

function validateStagedBundleBinding<
  Instance,
  RouteHandle,
  GraphEntry,
  PricingEntry,
>(
  bundle: CatalogStagedInstanceBundle<
    Instance,
    RouteHandle,
    GraphEntry,
    PricingEntry
  >,
  expectedKey: string,
  source: CanonicalSource,
): void {
  if (bundle.instancePublicationKey !== expectedKey) {
    throw new Error(
      `staged bundle publication key ${bundle.instancePublicationKey} does not match ${expectedKey}`,
    );
  }
  assertSameSource(bundle.source, source, `staged bundle ${expectedKey}`);
}

function sealStagedBundle<Instance, RouteHandle, GraphEntry, PricingEntry>(
  input: {
    readonly bundle: CatalogStagedInstanceBundle<
      Instance,
      RouteHandle,
      GraphEntry,
      PricingEntry
    >;
    readonly expectation: CatalogFamilyExpectation;
    readonly key: string;
    readonly source: CanonicalSource;
    readonly valueAuthority: ResolvedPublicationValueAuthority<
      Instance,
      RouteHandle,
      GraphEntry,
      PricingEntry
    >;
  },
): SealedCatalogInstanceBundle<
  Instance,
  RouteHandle,
  GraphEntry,
  PricingEntry
> {
  const identity = {
    instancePublicationKey: input.key,
    familyId: input.bundle.instance.familyId,
    lineageId: input.bundle.instance.lineageId,
    instanceKey: input.bundle.instance.instanceKey,
    source: input.source,
  };
  const instanceBinding = freezeValueBinding({
    kind: "instance",
    key: input.key,
    ...identity,
  });
  const instanceValue = sealValue(
    input.bundle.instance.value,
    input.valueAuthority.instance,
    `instance ${input.key}`,
    instanceBinding,
  );
  const instance = Object.freeze({
    familyId: input.bundle.instance.familyId,
    lineageId: input.bundle.instance.lineageId,
    instanceKey: input.bundle.instance.instanceKey,
    fingerprint: nonempty(
      input.bundle.instance.fingerprint,
      `instance ${input.key} fingerprint`,
    ),
    value: instanceValue,
  });
  const routeHandles = sealStagedOpaqueMap(
    input.bundle.routeHandles,
    input.valueAuthority.routeHandle,
    identity,
    "route-handle",
    "route handle",
  );
  const graphEntries = sealStagedOpaqueMap(
    input.bundle.graphEntries,
    input.valueAuthority.graphEntry,
    identity,
    "graph-entry",
    "Graph entry",
  );
  const pricingEntries = sealStagedOpaqueMap(
    input.bundle.pricingEntries,
    input.valueAuthority.pricingEntry,
    identity,
    "pricing-entry",
    "pricing entry",
  );
  if (input.expectation.requiresGraphProjection && routeHandles.size === 0) {
    throw new Error(`instance ${input.key} has no route handles`);
  }
  if (input.expectation.requiresGraphProjection && graphEntries.size === 0) {
    throw new Error(`instance ${input.key} has no required Graph projection`);
  }
  if (graphEntries.size > 0 || input.expectation.requiresGraphProjection) {
    assertExactOpaqueKeySet(routeHandles, graphEntries, input.key);
  }
  if (input.expectation.requiresPricingProjection && pricingEntries.size === 0) {
    throw new Error(`instance ${input.key} has no required pricing projection`);
  }
  return Object.freeze({
    instance,
    routeHandles,
    graphEntries,
    pricingEntries,
  });
}

function sealStagedOpaqueMap<Value>(
  values: ReadonlyMap<string, CatalogStagedOpaqueEntry<Value>>,
  contract: CatalogValueContract<Value>,
  identity: {
    readonly instancePublicationKey: string;
    readonly familyId: FamilyId;
    readonly lineageId: string;
    readonly instanceKey: string;
    readonly source: CanonicalSource;
  },
  kind: Exclude<CatalogValueKind, "instance">,
  label: string,
): ReadonlyMap<string, CatalogOpaqueEntry<Value>> {
  const copied = new Map<string, CatalogOpaqueEntry<Value>>();
  for (const [key, entry] of values) {
    nonempty(key, `${label} key`);
    if (copied.has(key)) throw new Error(`duplicate ${label} key ${key}`);
    const binding = freezeValueBinding({
      kind,
      key,
      ...identity,
    });
    const value = sealValue(
      entry.value,
      contract,
      `${label} ${key}`,
      binding,
    );
    copied.set(key, Object.freeze({
      instancePublicationKey: identity.instancePublicationKey,
      familyId: identity.familyId,
      lineageId: identity.lineageId,
      instanceKey: identity.instanceKey,
      source: freezeCanonicalSource(identity.source),
      fingerprint: nonempty(entry.fingerprint, `${label} fingerprint`),
      value,
    }));
  }
  return new SealedReadonlyMap(copied);
}

function sealValue<Value>(
  value: Value,
  contract: CatalogValueContract<Value>,
  label: string,
  binding: CatalogValueBinding,
): Value {
  const sealed = contract.seal(value, binding);
  contract.assertValid(sealed, binding);
  assertValueShallowSealed(sealed, label);
  return sealed;
}

function carryValue<Value>(
  value: Value,
  contract: CatalogValueContract<Value>,
  label: string,
  previous: CatalogValueBinding,
  current: CatalogValueBinding,
): Value {
  contract.assertValid(value, previous);
  const carried = contract.carry(value, Object.freeze({ previous, current }));
  contract.assertValid(carried, current);
  assertValueShallowSealed(carried, label);
  return carried;
}

function assertValueValid<Value>(
  value: Value,
  contract: CatalogValueContract<Value>,
  label: string,
  binding: CatalogValueBinding,
): void {
  contract.assertValid(value, binding);
  assertValueShallowSealed(value, label);
}

function assertValueShallowSealed(value: unknown, label: string): void {
  if (
    value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    !Object.isFrozen(value)
  ) {
    throw new Error(`${label} authority returned an unsealed value`);
  }
}

function instanceValueBinding(
  instance: Pick<
    CatalogPublishedInstance<unknown>,
    "key" | "familyId" | "lineageId" | "instanceKey"
  >,
  source: CanonicalSource,
): CatalogValueBinding {
  return freezeValueBinding({
    kind: "instance",
    key: instance.key,
    instancePublicationKey: instance.key,
    familyId: instance.familyId,
    lineageId: instance.lineageId,
    instanceKey: instance.instanceKey,
    source,
  });
}

function opaqueValueBinding<Value>(
  kind: Exclude<CatalogValueKind, "instance">,
  key: string,
  entry: CatalogOpaqueEntry<Value>,
  source: CanonicalSource,
): CatalogValueBinding {
  return freezeValueBinding({
    kind,
    key,
    instancePublicationKey: entry.instancePublicationKey,
    familyId: entry.familyId,
    lineageId: entry.lineageId,
    instanceKey: entry.instanceKey,
    source,
  });
}

function freezeValueBinding(binding: CatalogValueBinding): CatalogValueBinding {
  nonempty(binding.key, `${binding.kind} value key`);
  return Object.freeze({
    kind: binding.kind,
    key: binding.key,
    instancePublicationKey: binding.instancePublicationKey,
    familyId: binding.familyId,
    lineageId: binding.lineageId,
    instanceKey: binding.instanceKey,
    source: freezeCanonicalSource(binding.source),
  });
}

function assertOpaqueBundleUnchanged<
  Instance,
  RouteHandle,
  GraphEntry,
  PricingEntry,
>(
  previous: AdapterFamilyCatalogPublicationEnvelope<
    Instance,
    RouteHandle,
    GraphEntry,
    PricingEntry
  >,
  instancePublicationKey: string,
  staged: SealedCatalogInstanceBundle<
    Instance,
    RouteHandle,
    GraphEntry,
    PricingEntry
  >,
): void {
  assertOpaqueFingerprintSetEqual(
    entriesForInstance(previous.privateState.routeHandles, instancePublicationKey),
    staged.routeHandles,
    `${instancePublicationKey} route handles`,
  );
  assertOpaqueFingerprintSetEqual(
    entriesForInstance(previous.privateState.graphEntries, instancePublicationKey),
    staged.graphEntries,
    `${instancePublicationKey} Graph entries`,
  );
  assertOpaqueFingerprintSetEqual(
    entriesForInstance(previous.privateState.pricingEntries, instancePublicationKey),
    staged.pricingEntries,
    `${instancePublicationKey} pricing entries`,
  );
}

function assertOpaqueFingerprintSetEqual<Left, Right>(
  previous: ReadonlyMap<string, CatalogOpaqueEntry<Left>>,
  staged: ReadonlyMap<string, CatalogOpaqueEntry<Right>>,
  label: string,
): void {
  if (previous.size !== staged.size) {
    throw new Error(`unchanged instance changes ${label}`);
  }
  for (const [key, entry] of previous) {
    if (staged.get(key)?.fingerprint !== entry.fingerprint) {
      throw new Error(`unchanged instance changes ${label} at ${key}`);
    }
  }
}

function appendOpaqueBundle<RouteHandle, GraphEntry, PricingEntry>(
  bundle: SealedCatalogInstanceBundle<unknown, RouteHandle, GraphEntry, PricingEntry>,
  routeHandles: Map<string, CatalogOpaqueEntry<RouteHandle>>,
  graphEntries: Map<string, CatalogOpaqueEntry<GraphEntry>>,
  pricingEntries: Map<string, CatalogOpaqueEntry<PricingEntry>>,
): void {
  appendOpaqueEntries(bundle.routeHandles, routeHandles, "route handle");
  appendOpaqueEntries(bundle.graphEntries, graphEntries, "Graph entry");
  appendOpaqueEntries(bundle.pricingEntries, pricingEntries, "pricing entry");
}

function appendOpaqueEntries<Value>(
  source: ReadonlyMap<string, CatalogOpaqueEntry<Value>>,
  target: Map<string, CatalogOpaqueEntry<Value>>,
  label: string,
): void {
  for (const [key, entry] of source) {
    if (target.has(key)) {
      throw new Error(`${label} key ${key} is owned by multiple instances`);
    }
    target.set(key, entry);
  }
}

function carryPublishedInstance<Instance, RouteHandle, GraphEntry, PricingEntry>(
  input: {
    readonly previous: AdapterFamilyCatalogPublicationEnvelope<
      Instance,
      RouteHandle,
      GraphEntry,
      PricingEntry
    >;
    readonly instance: CatalogPublishedInstance<Instance>;
    readonly source: CanonicalSource;
    readonly contract: CatalogValueContract<Instance>;
  },
): CatalogPublishedInstance<Instance> {
  const previousBinding = instanceValueBinding(
    input.instance,
    input.previous.snapshot.source,
  );
  const currentBinding = instanceValueBinding(input.instance, input.source);
  const value = carryValue(
    input.instance.value,
    input.contract,
    `instance ${input.instance.key}`,
    previousBinding,
    currentBinding,
  );
  return Object.freeze({
    ...input.instance,
    value,
  });
}

function carryOpaqueBundle<Instance, RouteHandle, GraphEntry, PricingEntry>(
  input: {
    readonly previous: AdapterFamilyCatalogPublicationEnvelope<
      Instance,
      RouteHandle,
      GraphEntry,
      PricingEntry
    >;
    readonly instance: CatalogPublishedInstance<Instance>;
    readonly source: CanonicalSource;
    readonly expectation: CatalogFamilyExpectation;
    readonly valueAuthority: ResolvedPublicationValueAuthority<
      Instance,
      RouteHandle,
      GraphEntry,
      PricingEntry
    >;
    readonly nextRouteHandles: Map<string, CatalogOpaqueEntry<RouteHandle>>;
    readonly nextGraphEntries: Map<string, CatalogOpaqueEntry<GraphEntry>>;
    readonly nextPricingEntries: Map<string, CatalogOpaqueEntry<PricingEntry>>;
  },
): void {
  const routeHandles = rebindOpaqueEntries(
    entriesForInstance(input.previous.privateState.routeHandles, input.instance.key),
    input.instance,
    input.source,
    input.valueAuthority.routeHandle,
    "route-handle",
    "route handle",
  );
  const graphEntries = rebindOpaqueEntries(
    entriesForInstance(input.previous.privateState.graphEntries, input.instance.key),
    input.instance,
    input.source,
    input.valueAuthority.graphEntry,
    "graph-entry",
    "Graph entry",
  );
  const pricingEntries = rebindOpaqueEntries(
    entriesForInstance(input.previous.privateState.pricingEntries, input.instance.key),
    input.instance,
    input.source,
    input.valueAuthority.pricingEntry,
    "pricing-entry",
    "pricing entry",
  );
  if (input.expectation.requiresGraphProjection && routeHandles.size === 0) {
    throw new Error(`carried instance ${input.instance.key} lost its route handles`);
  }
  if (input.expectation.requiresGraphProjection) {
    assertExactOpaqueKeySet(routeHandles, graphEntries, input.instance.key);
  }
  if (
    input.expectation.requiresPricingProjection &&
    pricingEntries.size === 0
  ) {
    throw new Error(`carried instance ${input.instance.key} lost pricing`);
  }
  appendOpaqueEntries(routeHandles, input.nextRouteHandles, "route handle");
  appendOpaqueEntries(graphEntries, input.nextGraphEntries, "Graph entry");
  appendOpaqueEntries(pricingEntries, input.nextPricingEntries, "pricing entry");
}

function entriesForInstance<Value>(
  entries: ReadonlyMap<string, CatalogOpaqueEntry<Value>>,
  instancePublicationKey: string,
): ReadonlyMap<string, CatalogOpaqueEntry<Value>> {
  return new Map(
    [...entries].filter(([, entry]) =>
      entry.instancePublicationKey === instancePublicationKey
    ),
  );
}

function rebindOpaqueEntries<Value>(
  entries: ReadonlyMap<string, CatalogOpaqueEntry<Value>>,
  instance: CatalogPublishedInstance<unknown>,
  source: CanonicalSource,
  contract: CatalogValueContract<Value>,
  kind: Exclude<CatalogValueKind, "instance">,
  label: string,
): ReadonlyMap<string, CatalogOpaqueEntry<Value>> {
  return new Map([...entries].map(([key, entry]) => {
    const previousBinding = opaqueValueBinding(kind, key, entry, entry.source);
    const currentBinding = freezeValueBinding({
      kind,
      key,
      instancePublicationKey: instance.key,
      familyId: instance.familyId,
      lineageId: instance.lineageId,
      instanceKey: instance.instanceKey,
      source,
    });
    const value = carryValue(
      entry.value,
      contract,
      `${label} ${key}`,
      previousBinding,
      currentBinding,
    );
    return [key, Object.freeze({
      instancePublicationKey: instance.key,
      familyId: instance.familyId,
      lineageId: instance.lineageId,
      instanceKey: instance.instanceKey,
      source: freezeCanonicalSource(source),
      fingerprint: entry.fingerprint,
      value,
    })] as const;
  }));
}

function assertExactOpaqueKeySet<Left, Right>(
  routeHandles: ReadonlyMap<string, CatalogOpaqueEntry<Left>>,
  graphEntries: ReadonlyMap<string, CatalogOpaqueEntry<Right>>,
  instancePublicationKey: string,
): void {
  if (routeHandles.size !== graphEntries.size) {
    throw new Error(
      `route-handle and Graph key sets differ for ${instancePublicationKey}`,
    );
  }
  for (const key of routeHandles.keys()) {
    if (!graphEntries.has(key)) {
      throw new Error(
        `Graph is missing route-handle key ${key} for ${instancePublicationKey}`,
      );
    }
  }
}

function assertOpaqueStateComplete<
  Instance,
  RouteHandle,
  GraphEntry,
  PricingEntry,
>(input: {
  readonly definition: AdapterFamilyCatalogDefinition;
  readonly source: CanonicalSource;
  readonly instances: ReadonlyMap<string, CatalogPublishedInstance<Instance>>;
  readonly routeHandles: ReadonlyMap<string, CatalogOpaqueEntry<RouteHandle>>;
  readonly graphEntries: ReadonlyMap<string, CatalogOpaqueEntry<GraphEntry>>;
  readonly pricingEntries: ReadonlyMap<string, CatalogOpaqueEntry<PricingEntry>>;
}): void {
  const expectations = new Map(
    input.definition.families.map((family) => [family.familyId, family]),
  );
  assertOpaqueMapBindings(
    input.routeHandles,
    input.instances,
    input.source,
    "route handle",
  );
  assertOpaqueMapBindings(
    input.graphEntries,
    input.instances,
    input.source,
    "Graph entry",
  );
  assertOpaqueMapBindings(
    input.pricingEntries,
    input.instances,
    input.source,
    "pricing entry",
  );
  for (const [key, instance] of input.instances) {
    const expectation = expectations.get(instance.familyId);
    if (expectation === undefined) {
      throw new Error(`published instance ${key} belongs to an unknown Family`);
    }
    const routes = entriesForInstance(input.routeHandles, key);
    const graph = entriesForInstance(input.graphEntries, key);
    const pricing = entriesForInstance(input.pricingEntries, key);
    if (expectation.requiresGraphProjection && routes.size === 0) {
      throw new Error(`published instance ${key} has no route handles`);
    }
    if (expectation.requiresGraphProjection) {
      assertExactOpaqueKeySet(routes, graph, key);
    } else if (graph.size > 0) {
      assertExactOpaqueKeySet(routes, graph, key);
    }
    if (expectation.requiresPricingProjection && pricing.size === 0) {
      throw new Error(`published instance ${key} has no required pricing`);
    }
  }
}

function assertOpaqueMapBindings<Instance, Value>(
  entries: ReadonlyMap<string, CatalogOpaqueEntry<Value>>,
  instances: ReadonlyMap<string, CatalogPublishedInstance<Instance>>,
  source: CanonicalSource,
  label: string,
): void {
  for (const [key, entry] of entries) {
    nonempty(key, `${label} key`);
    nonempty(entry.fingerprint, `${label} fingerprint`);
    const instance = instances.get(entry.instancePublicationKey);
    if (instance === undefined) {
      throw new Error(
        `${label} ${key} is bound to removed or missing instance ` +
          entry.instancePublicationKey,
      );
    }
    if (
      entry.familyId !== instance.familyId ||
      entry.lineageId !== instance.lineageId ||
      entry.instanceKey !== instance.instanceKey
    ) {
      throw new Error(`${label} ${key} instance binding mismatch`);
    }
    assertSameSource(entry.source, source, `${label} ${key}`);
    if (!Object.isFrozen(entry)) {
      throw new Error(`${label} ${key} binding is not frozen`);
    }
  }
}

function resolveTerminalRemovalProof(input: {
  readonly authority: CatalogTerminalRemovalAuthority;
  readonly proof: CatalogTerminalRemovalProof;
  readonly familyId: FamilyId;
  readonly source: CanonicalSource;
}): CatalogTerminalRemovalRecord {
  const proofs = terminalRemovalAuthorityRecords.get(input.authority);
  if (proofs === undefined) {
    throw new Error("terminal removal authority was not centrally issued");
  }
  const record = proofs.get(input.proof);
  if (record === undefined) {
    throw new Error("terminal removal proof is forged or foreign");
  }
  if (record.familyId !== input.familyId) {
    throw new Error(`Family ${input.familyId} staged a foreign terminal proof`);
  }
  assertSameSource(record.source, input.source, "terminal removal proof");
  if (record.status !== "terminal") {
    throw new Error("terminal removal proof is unresolved");
  }
  return record;
}

function resolveSourceTransitionProof(input: {
  readonly authority: CatalogSourceTransitionAuthority;
  readonly proof: CatalogSourceTransitionProof | undefined;
  readonly previous: CanonicalSource;
  readonly current: CanonicalSource;
}): CatalogSourceTransitionRecord | null {
  if (input.proof === undefined) return null;
  const proofs = sourceTransitionAuthorityRecords.get(input.authority);
  if (proofs === undefined) {
    throw new Error("source transition authority was not centrally issued");
  }
  const record = proofs.get(input.proof);
  if (record === undefined) {
    throw new Error("source transition proof is forged or foreign");
  }
  assertSameSource(record.previous, input.previous, "source transition predecessor");
  assertSameSource(record.current, input.current, "source transition successor");
  return record;
}

function assertNoUnexpectedTransitionProof(
  proof: CatalogSourceTransitionProof | undefined,
): void {
  if (proof !== undefined) {
    throw new Error("first publication cannot carry a source transition proof");
  }
}

function assertTerminalRemovalAuthority(
  authority: CatalogTerminalRemovalAuthority,
): void {
  if (
    authority === null ||
    typeof authority !== "object" ||
    !terminalRemovalAuthorityRecords.has(authority)
  ) {
    throw new Error("terminal removal authority was not centrally issued");
  }
}

function assertSourceTransitionAuthority(
  authority: CatalogSourceTransitionAuthority,
): void {
  if (
    authority === null ||
    typeof authority !== "object" ||
    !sourceTransitionAuthorityRecords.has(authority)
  ) {
    throw new Error("source transition authority was not centrally issued");
  }
}

function assertValueContract<Value>(
  contract: CatalogValueContract<Value>,
  label: string,
): CatalogValueContract<unknown> {
  if (
    contract === null ||
    typeof contract !== "object" ||
    typeof contract.seal !== "function" ||
    typeof contract.carry !== "function" ||
    typeof contract.assertValid !== "function"
  ) {
    throw new Error(`${label} value contract is incomplete`);
  }
  return Object.freeze({
    seal: contract.seal as (
      value: unknown,
      binding: CatalogValueBinding,
    ) => unknown,
    carry: contract.carry as (
      value: unknown,
      binding: CatalogValueCarryBinding,
    ) => unknown,
    assertValid: contract.assertValid as (
      value: unknown,
      binding: CatalogValueBinding,
    ) => void,
  });
}

function assertIssuedPublication(envelope: object): CatalogPublicationIssue {
  const issue = publicationIssues.get(envelope);
  if (issue === undefined) {
    throw new Error("publication predecessor was not centrally issued");
  }
  return issue;
}

function assertIssuedSuccessor(
  expected: object | null,
  staged: object,
): CatalogPublicationIssue {
  const issue = publicationIssues.get(staged);
  if (issue === undefined) {
    throw new Error("staged publication was not centrally issued");
  }
  if (issue.previous !== expected) {
    throw new Error("staged publication is bound to a foreign predecessor");
  }
  if (expected !== null) assertIssuedPublication(expected);
  return issue;
}

function assertPublishedContentValid<
  Instance,
  RouteHandle,
  GraphEntry,
  PricingEntry,
>(
  envelope: AdapterFamilyCatalogPublicationEnvelope<
    Instance,
    RouteHandle,
    GraphEntry,
    PricingEntry
  >,
  definition: AdapterFamilyCatalogDefinition,
  authority: ResolvedPublicationValueAuthority<
    Instance,
    RouteHandle,
    GraphEntry,
    PricingEntry
  >,
): void {
  if (!Object.isFrozen(envelope) ||
    !Object.isFrozen(envelope.snapshot) ||
    !Object.isFrozen(envelope.privateState) ||
    !Object.isFrozen(envelope.snapshot.delta)) {
    throw new Error("publication envelope wrappers are not sealed");
  }
  assertOpaqueStateComplete({
    definition,
    source: envelope.snapshot.source,
    instances: envelope.privateState.instances,
    routeHandles: envelope.privateState.routeHandles,
    graphEntries: envelope.privateState.graphEntries,
    pricingEntries: envelope.privateState.pricingEntries,
  });
  for (const [key, instance] of envelope.privateState.instances) {
    if (!Object.isFrozen(instance)) {
      throw new Error(`published instance ${key} is not frozen`);
    }
    assertValueValid(
      instance.value,
      authority.instance,
      `instance ${key}`,
      instanceValueBinding(instance, envelope.snapshot.source),
    );
  }
  for (const [key, entry] of envelope.privateState.routeHandles) {
    assertValueValid(
      entry.value,
      authority.routeHandle,
      `route handle ${key}`,
      opaqueValueBinding("route-handle", key, entry, envelope.snapshot.source),
    );
  }
  for (const [key, entry] of envelope.privateState.graphEntries) {
    assertValueValid(
      entry.value,
      authority.graphEntry,
      `Graph entry ${key}`,
      opaqueValueBinding("graph-entry", key, entry, envelope.snapshot.source),
    );
  }
  for (const [key, entry] of envelope.privateState.pricingEntries) {
    assertValueValid(
      entry.value,
      authority.pricingEntry,
      `pricing entry ${key}`,
      opaqueValueBinding("pricing-entry", key, entry, envelope.snapshot.source),
    );
  }
}

function hasCompleteInventoryAuthority<
  Instance,
  RouteHandle,
  GraphEntry,
  PricingEntry,
>(input: {
  readonly expectation: CatalogFamilyExpectation;
  readonly stage: CatalogFamilyStage<
    Instance,
    RouteHandle,
    GraphEntry,
    PricingEntry
  >;
  readonly anchors: ReadonlyMap<string, CatalogDiscoverySourceAnchor>;
  readonly previous: AdapterFamilyCatalogPublicationEnvelope<
    Instance,
    RouteHandle,
    GraphEntry,
    PricingEntry
  > | null;
  readonly transition: CatalogSourceTransitionRecord | null;
}): boolean {
  if (input.stage.inventoryMode === "complete-snapshot") return true;
  if (input.previous?.snapshot.status !== "shadow-complete") return false;
  if (
    input.previous.snapshot.familyStatuses.get(input.expectation.familyId)
      ?.status !== "resolved"
  ) return false;
  if (input.transition?.status !== "canonical-descendant") return false;
  return input.expectation.sourceIds.every((sourceId) => {
    const key = catalogFamilySourceAnchorKey(
      input.expectation.familyId,
      sourceId,
    );
    const prior = input.previous!.snapshot.sourceAnchors.get(key);
    const current = input.anchors.get(key);
    if (
      prior?.status !== "complete" ||
      current?.status !== "complete" ||
      prior.completeThroughBlock > current.completeThroughBlock
    ) return false;
    return prior.completeThroughBlock !== current.completeThroughBlock ||
      sameBlockHash(prior.completeThroughHash, current.completeThroughHash);
  });
}

function assertPreviousCompatible<Instance, RouteHandle, GraphEntry, PricingEntry>(
  previous: AdapterFamilyCatalogPublicationEnvelope<
    Instance,
    RouteHandle,
    GraphEntry,
    PricingEntry
  > | null,
  definition: AdapterFamilyCatalogDefinition,
  chainId: string,
): void {
  if (previous === null) return;
  if (previous.snapshot.catalogHash !== definition.catalogHash) {
    throw new Error("cannot carry publication across catalog hashes");
  }
  if (previous.snapshot.chainId !== chainId) {
    throw new Error("cannot carry publication across chain ids");
  }
}

function assertPublishSuccessor<Instance, RouteHandle, GraphEntry, PricingEntry>(
  expected: AdapterFamilyCatalogPublicationEnvelope<
    Instance,
    RouteHandle,
    GraphEntry,
    PricingEntry
  > | null,
  staged: AdapterFamilyCatalogPublicationEnvelope<
    Instance,
    RouteHandle,
    GraphEntry,
    PricingEntry
  >,
): void {
  assertCanonicalSource(staged.snapshot.source);
  const expectedRevision = (expected?.snapshot.revision ?? 0) + 1;
  if (staged.snapshot.revision !== expectedRevision) {
    throw new Error(
      `staged publication revision ${staged.snapshot.revision} is not ${expectedRevision}`,
    );
  }
  if (expected !== null) {
    if (staged.snapshot.chainId !== expected.snapshot.chainId) {
      throw new Error("staged publication changes chain id");
    }
    if (staged.snapshot.catalogHash !== expected.snapshot.catalogHash) {
      throw new Error("staged publication changes catalog hash");
    }
    if (
      staged.snapshot.source.generation <=
        expected.snapshot.source.generation
    ) {
      throw new Error("staged publication generation is not newer");
    }
  }
  if (
    staged.snapshot.status !== "shadow-complete" &&
    staged.snapshot.status !== "shadow-partial"
  ) {
    throw new Error("catalog publication coordinator is shadow-only");
  }
}

function assertCanonicalSource(source: CanonicalSource): void {
  if (!Number.isSafeInteger(source.number) || source.number < 0) {
    throw new Error(`invalid canonical source block ${source.number}`);
  }
  canonicalBlockHash(source.hash, "canonical source hash");
  if (!Number.isSafeInteger(source.generation) || source.generation < 0) {
    throw new Error(`invalid canonical source generation ${source.generation}`);
  }
}

function assertSameSource(
  actual: CanonicalSource,
  expected: CanonicalSource,
  label: string,
): void {
  assertCanonicalSource(actual);
  if (
    actual.number !== expected.number ||
    !sameBlockHash(actual.hash, expected.hash) ||
    actual.generation !== expected.generation
  ) {
    throw new Error(`${label} canonical source mismatch`);
  }
}

function assertFamilyDomain(domain: FamilyDomain): void {
  if (
    domain !== "swap" &&
    domain !== "protocol" &&
    domain !== "funding" &&
    domain !== "credit"
  ) {
    throw new Error(`invalid Family domain ${String(domain)}`);
  }
}

function assertStageStatus(status: CatalogFamilyStageStatus): void {
  if (status !== "resolved" && status !== "partial" && status !== "unsupported") {
    throw new Error(`invalid Family stage status ${String(status)}`);
  }
}

function assertInventoryMode(mode: CatalogInventoryMode): void {
  if (mode !== "append-only-delta" && mode !== "complete-snapshot") {
    throw new Error(`invalid Family inventory mode ${String(mode)}`);
  }
}

function validateOutcomeRefs(refs: readonly string[]): string[] {
  const output = refs.map((ref) => nonempty(ref, "Family outcome ref"));
  if (new Set(output).size !== output.length) {
    throw new Error("Family outcome refs must be unique");
  }
  return output.sort();
}

function carryReason(
  status: CatalogFamilyStageStatus,
): CatalogCarriedInstance["reason"] {
  if (status === "partial") return "partial-omission";
  if (status === "unsupported") return "unsupported-family";
  return "append-only-omission";
}

function canonicalSourceProjection(source: CanonicalSource): {
  readonly number: number;
  readonly hash: string;
  readonly generation: number;
} {
  return {
    number: source.number,
    hash: canonicalBlockHash(source.hash, "canonical source hash"),
    generation: source.generation,
  };
}

function freezeCanonicalSource(source: CanonicalSource): CanonicalSource {
  assertCanonicalSource(source);
  return Object.freeze(canonicalSourceProjection(source));
}

function canonicalBlockHash(value: string, label: string): string {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error(`${label} must be a 32-byte hex value`);
  }
  return value.toLowerCase();
}

function sameBlockHash(
  left: string | null,
  right: string | null,
): boolean {
  if (left === null || right === null) return left === right;
  return canonicalBlockHash(left, "block hash") ===
    canonicalBlockHash(right, "block hash");
}

function tombstoneProjection(tombstone: CatalogTombstone) {
  return {
    key: tombstone.key,
    familyId: tombstone.familyId,
    lineageId: tombstone.lineageId,
    instanceKey: tombstone.instanceKey,
    removedFingerprint: tombstone.removedFingerprint,
    removedAtRevision: tombstone.removedAtRevision,
    removedAtSource: canonicalSourceProjection(tombstone.removedAtSource),
    reason: tombstone.reason,
    outcomeRef: tombstone.outcomeRef,
  };
}

function opaqueFingerprintProjection<Value>(
  values: ReadonlyMap<string, CatalogOpaqueEntry<Value>>,
) {
  return sortedEntries(values).map(([key, entry]) => ({
    key,
    instancePublicationKey: entry.instancePublicationKey,
    familyId: entry.familyId,
    lineageId: entry.lineageId,
    instanceKey: entry.instanceKey,
    source: canonicalSourceProjection(entry.source),
    fingerprint: entry.fingerprint,
  }));
}

function sortedEntries<Key extends string, Value>(
  values: ReadonlyMap<Key, Value>,
): readonly (readonly [Key, Value])[] {
  return [...values.entries()].sort(([left], [right]) =>
    left.localeCompare(right)
  );
}

function uniqueSorted(values: readonly string[]): string[] {
  const output = [...new Set(values)];
  for (const value of output) nonempty(value, "discovery source id");
  return output.sort();
}

function lengthPrefixed(values: readonly string[]): string {
  return values.map((value) => `${value.length}:${value}`).join("");
}

function nonempty(value: string, label: string): string {
  if (value.trim().length === 0 || value !== value.trim()) {
    throw new Error(`${label} must be non-empty without surrounding whitespace`);
  }
  return value;
}

class SealedReadonlyMap<Key, Value> implements ReadonlyMap<Key, Value> {
  readonly #values: Map<Key, Value>;

  constructor(values: ReadonlyMap<Key, Value>) {
    this.#values = new Map(values);
    Object.freeze(this);
  }

  get size(): number {
    return this.#values.size;
  }

  get(key: Key): Value | undefined {
    return this.#values.get(key);
  }

  has(key: Key): boolean {
    return this.#values.has(key);
  }

  entries(): MapIterator<[Key, Value]> {
    return this.#values.entries();
  }

  keys(): MapIterator<Key> {
    return this.#values.keys();
  }

  values(): MapIterator<Value> {
    return this.#values.values();
  }

  forEach(
    callbackfn: (value: Value, key: Key, map: ReadonlyMap<Key, Value>) => void,
    thisArg?: unknown,
  ): void {
    for (const [key, value] of this.#values) {
      callbackfn.call(thisArg, value, key, this);
    }
  }

  [Symbol.iterator](): MapIterator<[Key, Value]> {
    return this.#values[Symbol.iterator]();
  }

  get [Symbol.toStringTag](): string {
    return "SealedReadonlyMap";
  }
}
