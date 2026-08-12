import type {
  AdapterFamilyDiscoveryCheckpointReceipt,
  AdapterFamilyDiscoveryCheckpointStore,
} from "./adapter-family-discovery-checkpoint.js";
import type { FamilyId } from
  "./venues/adapter-family-identifiers.js";
import type {
  DiscoverySourceKind,
  Hex32,
  UnifiedObservation,
} from "./venues/adapter-family-plugin.js";
import type { CanonicalSource } from
  "./venues/adapter-request-program.js";
import {
  hashCanonical,
  type CanonicalValue,
} from "./venues/canonical-value.js";
import type { FamilyCapabilityCatalog } from
  "./venues/family-capability-catalog.js";

const CLOSURE_FORMAT = "adapter-family-snapshot-inventory-closure-v1";
const EVENT_SOURCE_IDS: ReadonlySet<DiscoverySourceKind> = new Set([
  "factory-log",
  "landed-log",
  "observed-call",
]);

export type AdapterFamilySnapshotInventoryObservation =
  | Extract<UnifiedObservation, { readonly kind: "address-surface" }>
  | Extract<UnifiedObservation, { readonly kind: "factory-log" }>;

export interface AdapterFamilySnapshotInventoryClosureBinding {
  readonly chainId: string;
  readonly catalogHash: string;
  readonly sourceRegistryFingerprint: string;
}

export interface AdapterFamilySnapshotTerminalCandidateInput {
  readonly candidateKey: string;
  readonly status: "terminal" | "partial";
  readonly outcomeFingerprint: string;
  readonly evidenceRefs: readonly string[];
  readonly admittedInstancePublicationKeys: readonly string[];
  readonly publicationFingerprints: readonly string[];
}

export interface AdapterFamilySnapshotInventoryIncumbentInput {
  readonly inventoryKey: string;
  readonly address: string;
  readonly currentSurface: AdapterFamilySnapshotInventoryObservation;
  readonly terminalCandidates:
    readonly AdapterFamilySnapshotTerminalCandidateInput[];
}

export interface AdapterFamilySnapshotInventoryFamilyInput {
  readonly familyId: FamilyId;
  readonly inventoryKeys: readonly string[];
  readonly inventoryCount: number;
  readonly inventoryHash: string;
  readonly incumbents:
    readonly AdapterFamilySnapshotInventoryIncumbentInput[];
}

export interface AdapterFamilySnapshotInventoryClosureCandidateInput {
  readonly source: CanonicalSource;
  readonly families: readonly AdapterFamilySnapshotInventoryFamilyInput[];
}

export interface AdapterFamilySnapshotInventoryEnumerationIncumbentInput {
  readonly inventoryKey: string;
  readonly address: string;
  readonly currentSurface: AdapterFamilySnapshotInventoryObservation;
}

export interface AdapterFamilySnapshotInventoryEnumerationFamilyInput {
  readonly familyId: FamilyId;
  readonly inventoryKeys: readonly string[];
  readonly inventoryCount: number;
  readonly inventoryHash: string;
  readonly incumbents:
    readonly AdapterFamilySnapshotInventoryEnumerationIncumbentInput[];
}

export interface AdapterFamilySnapshotInventoryEnumerationInput {
  readonly source: CanonicalSource;
  readonly families:
    readonly AdapterFamilySnapshotInventoryEnumerationFamilyInput[];
}

export interface AdapterFamilySnapshotCatalogPublicationPointer {
  readonly revision: number;
  readonly publicationFingerprint: string | null;
}

declare const snapshotInventoryClosureAuthorityBrand: unique symbol;
export interface AdapterFamilySnapshotInventoryClosureAuthority {
  readonly [snapshotInventoryClosureAuthorityBrand]: true;
}

declare const preparedSnapshotInventoryClosureBrand: unique symbol;
export interface PreparedAdapterFamilySnapshotInventoryClosure {
  readonly [preparedSnapshotInventoryClosureBrand]: true;
}

declare const snapshotInventoryClosureReceiptBrand: unique symbol;
export interface AdapterFamilySnapshotInventoryClosureReceipt {
  readonly [snapshotInventoryClosureReceiptBrand]: true;
}

export interface AdapterFamilySnapshotInventoryClosureCandidateIssuer {
  readonly authority: AdapterFamilySnapshotInventoryClosureAuthority;
  readonly binding: AdapterFamilySnapshotInventoryClosureBinding;
  prepare(
    input: AdapterFamilySnapshotInventoryClosureCandidateInput,
  ): PreparedAdapterFamilySnapshotInventoryClosure;
}

export interface ResolvedAdapterFamilySnapshotInventoryClosureFamily {
  readonly familyId: FamilyId;
  readonly declaredSourceIds: readonly DiscoverySourceKind[];
  readonly inventoryCount: number;
  readonly inventoryHash: string;
  readonly inventoryKeys: readonly string[];
  readonly admittedInstancePublicationKeys: readonly string[];
  readonly terminalEvidenceFingerprint: string;
}

export interface ResolvedAdapterFamilySnapshotInventoryClosure {
  readonly chainId: string;
  readonly catalogHash: string;
  readonly sourceRegistryFingerprint: string;
  readonly source: CanonicalSource;
  readonly checkpointFingerprint: string;
  readonly expectedRevision: number;
  readonly expectedPublicationFingerprint: string | null;
  readonly inventoryMatrixFingerprint: string;
  readonly matrixFingerprint: string;
  readonly closureFingerprint: string;
  readonly families:
    readonly ResolvedAdapterFamilySnapshotInventoryClosureFamily[];
}

interface ExpectedFamily {
  readonly familyId: FamilyId;
  readonly declaredSourceIds: readonly DiscoverySourceKind[];
  readonly supportsSnapshotBootstrap: boolean;
}

interface SnapshotTerminalCandidate
  extends AdapterFamilySnapshotTerminalCandidateInput {}

interface SnapshotIncumbent {
  readonly inventoryKey: string;
  readonly address: string;
  readonly currentSurface: AdapterFamilySnapshotInventoryObservation;
  readonly currentSurfaceFingerprint: string;
  readonly terminalCandidates: readonly SnapshotTerminalCandidate[];
}

interface SnapshotFamily {
  readonly familyId: FamilyId;
  readonly declaredSourceIds: readonly DiscoverySourceKind[];
  readonly inventoryKeys: readonly string[];
  readonly inventoryCount: number;
  readonly inventoryHash: string;
  readonly incumbents: readonly SnapshotIncumbent[];
  readonly admittedInstancePublicationKeys: readonly string[];
  readonly terminalEvidenceFingerprint: string;
}

interface PreparedRecord {
  readonly authority: AdapterFamilySnapshotInventoryClosureAuthority;
  readonly binding: AdapterFamilySnapshotInventoryClosureBinding;
  readonly source: CanonicalSource;
  readonly inventoryMatrixFingerprint: string;
  readonly matrixFingerprint: string;
  readonly families: readonly SnapshotFamily[];
}

interface ReceiptRecord {
  readonly authority: AdapterFamilySnapshotInventoryClosureAuthority;
  readonly checkpointReceipt: AdapterFamilyDiscoveryCheckpointReceipt;
  readonly resolved: ResolvedAdapterFamilySnapshotInventoryClosure;
}

const preparedRecords = new WeakMap<object, PreparedRecord>();
const receiptRecords = new WeakMap<object, ReceiptRecord>();

/**
 * Process-local snapshot inventory verifier. Its receipt is deliberately not
 * a CatalogDiscoverySourceAnchor or CatalogTerminalRemovalProof: a later
 * catalog composition must consume it through this exact authority.
 */
export class AdapterFamilySnapshotInventoryClosureVerifier {
  readonly authority: AdapterFamilySnapshotInventoryClosureAuthority;
  readonly #binding: AdapterFamilySnapshotInventoryClosureBinding;
  readonly #catalog: FamilyCapabilityCatalog;
  readonly #expectedFamilies: readonly ExpectedFamily[];
  readonly #checkpointStore: AdapterFamilyDiscoveryCheckpointStore;
  readonly #enumerateSnapshotInventory: (
    source: CanonicalSource,
  ) => AdapterFamilySnapshotInventoryEnumerationInput |
    Promise<AdapterFamilySnapshotInventoryEnumerationInput>;
  readonly #captureCatalogPublication: () =>
    AdapterFamilySnapshotCatalogPublicationPointer;
  readonly #verifyCanonicalSource: (
    source: CanonicalSource,
  ) => void | Promise<void>;
  readonly #assertGenerationCurrent: (source: CanonicalSource) => void;
  #candidateIssuer:
    AdapterFamilySnapshotInventoryClosureCandidateIssuer | null;

  constructor(input: {
    readonly catalog: FamilyCapabilityCatalog;
    readonly chainId: string;
    readonly sourceRegistryFingerprint: string;
    readonly checkpointStore: AdapterFamilyDiscoveryCheckpointStore;
    readonly enumerateSnapshotInventory: (
      source: CanonicalSource,
    ) => AdapterFamilySnapshotInventoryEnumerationInput |
      Promise<AdapterFamilySnapshotInventoryEnumerationInput>;
    readonly captureCatalogPublication: () =>
      AdapterFamilySnapshotCatalogPublicationPointer;
    readonly verifyCanonicalSource: (
      source: CanonicalSource,
    ) => void | Promise<void>;
    readonly assertGenerationCurrent: (source: CanonicalSource) => void;
  }) {
    if (
      typeof input.enumerateSnapshotInventory !== "function" ||
      typeof input.captureCatalogPublication !== "function" ||
      typeof input.verifyCanonicalSource !== "function" ||
      typeof input.assertGenerationCurrent !== "function"
    ) {
      throw new Error(
        "snapshot inventory closure requires fixed inventory, publication, canonical and generation gates",
      );
    }
    this.#binding = freezeBinding({
      chainId: input.chainId,
      catalogHash: input.catalog.catalogHash,
      sourceRegistryFingerprint: input.sourceRegistryFingerprint,
    });
    if (!sameBinding(input.checkpointStore.binding(), this.#binding)) {
      throw new Error("snapshot inventory checkpoint store binding mismatch");
    }
    this.#catalog = input.catalog;
    this.#expectedFamilies = expectedFamilies(input.catalog);
    this.#checkpointStore = input.checkpointStore;
    this.#enumerateSnapshotInventory = input.enumerateSnapshotInventory;
    this.#captureCatalogPublication = input.captureCatalogPublication;
    this.#verifyCanonicalSource = input.verifyCanonicalSource;
    this.#assertGenerationCurrent = input.assertGenerationCurrent;
    this.authority = Object.freeze({}) as
      AdapterFamilySnapshotInventoryClosureAuthority;
    this.#candidateIssuer = Object.freeze({
      authority: this.authority,
      binding: this.#binding,
      prepare: (
        candidate: AdapterFamilySnapshotInventoryClosureCandidateInput,
      ): PreparedAdapterFamilySnapshotInventoryClosure => {
        const source = freezeSource(candidate.source);
        const families = validateAndFreezeFamilies({
          catalog: this.#catalog,
          expected: this.#expectedFamilies,
          source,
          families: candidate.families,
        });
        const matrixFingerprint = snapshotMatrixFingerprint({
          binding: this.#binding,
          source,
          families,
        });
        const inventoryMatrixFingerprint = snapshotInventoryMatrixFingerprint({
          binding: this.#binding,
          source,
          families,
        });
        const prepared = Object.freeze({}) as
          PreparedAdapterFamilySnapshotInventoryClosure;
        preparedRecords.set(prepared, Object.freeze({
          authority: this.authority,
          binding: this.#binding,
          source,
          inventoryMatrixFingerprint,
          matrixFingerprint,
          families,
        }));
        return prepared;
      },
    });
  }

  takeCandidateIssuer():
    AdapterFamilySnapshotInventoryClosureCandidateIssuer {
    const issuer = this.#candidateIssuer;
    if (issuer === null) {
      throw new Error("snapshot inventory candidate issuer was already taken");
    }
    this.#candidateIssuer = null;
    return issuer;
  }

  async verifyAndIssue(input: {
    readonly candidate: PreparedAdapterFamilySnapshotInventoryClosure;
    readonly checkpointReceipt: AdapterFamilyDiscoveryCheckpointReceipt;
  }): Promise<AdapterFamilySnapshotInventoryClosureReceipt> {
    const candidate = preparedRecords.get(input.candidate);
    if (candidate === undefined || candidate.authority !== this.authority) {
      throw new Error("snapshot inventory candidate is forged or foreign");
    }
    preparedRecords.delete(input.candidate);
    const publication = freezePublicationPointer(
      this.#captureCatalogPublication(),
    );
    if (this.#checkpointStore.capture() !== input.checkpointReceipt) {
      throw new Error("snapshot inventory checkpoint receipt is not current");
    }
    const checkpoint = this.#checkpointStore.checkpointSnapshot(
      input.checkpointReceipt,
    );
    if (checkpoint === null) {
      throw new Error("snapshot inventory closure requires a trusted checkpoint");
    }
    if (!sameBinding(checkpoint, this.#binding)) {
      throw new Error("snapshot inventory checkpoint escaped its binding");
    }
    assertSameSource(checkpoint.source, candidate.source);
    assertEventContinuity(
      candidate.families,
      checkpoint.watermarks,
      candidate.source,
    );

    await this.#verifyCanonicalSource(candidate.source);
    const enumerated = await this.#enumerateSnapshotInventory(candidate.source);
    const authoritativeFamilies = validateAuthoritativeInventory({
      catalog: this.#catalog,
      expected: this.#expectedFamilies,
      source: candidate.source,
      candidateFamilies: candidate.families,
      enumeration: enumerated,
    });
    const authoritativeInventoryMatrixFingerprint =
      snapshotInventoryMatrixFingerprint({
        binding: this.#binding,
        source: candidate.source,
        families: authoritativeFamilies,
      });
    if (
      authoritativeInventoryMatrixFingerprint !==
        candidate.inventoryMatrixFingerprint
    ) {
      throw new Error(
        "snapshot inventory candidate disagrees with authoritative enumeration",
      );
    }
    if (this.#checkpointStore.capture() !== input.checkpointReceipt) {
      throw new Error("snapshot inventory checkpoint changed during verification");
    }
    this.#assertGenerationCurrent(candidate.source);
    if (this.#checkpointStore.capture() !== input.checkpointReceipt) {
      throw new Error("snapshot inventory checkpoint changed before issuance");
    }
    if (!samePublicationPointer(
      publication,
      freezePublicationPointer(this.#captureCatalogPublication()),
    )) {
      throw new Error("catalog publication changed during inventory verification");
    }

    const families = Object.freeze(candidate.families.map((family) =>
      Object.freeze({
        familyId: family.familyId,
        declaredSourceIds: family.declaredSourceIds,
        inventoryCount: family.inventoryCount,
        inventoryHash: family.inventoryHash,
        inventoryKeys: family.inventoryKeys,
        admittedInstancePublicationKeys:
          family.admittedInstancePublicationKeys,
        terminalEvidenceFingerprint: family.terminalEvidenceFingerprint,
      })
    ));
    const checkpointFingerprint = checkpoint.checkpointFingerprint;
    const closureFingerprint = hashCanonical({
      format: CLOSURE_FORMAT,
      ...this.#binding,
      source: candidate.source,
      checkpointFingerprint,
      expectedRevision: publication.revision,
      expectedPublicationFingerprint: publication.publicationFingerprint,
      inventoryMatrixFingerprint: candidate.inventoryMatrixFingerprint,
      matrixFingerprint: candidate.matrixFingerprint,
      families,
    } as unknown as CanonicalValue);
    const resolved = Object.freeze({
      ...this.#binding,
      source: candidate.source,
      checkpointFingerprint,
      expectedRevision: publication.revision,
      expectedPublicationFingerprint: publication.publicationFingerprint,
      inventoryMatrixFingerprint: candidate.inventoryMatrixFingerprint,
      matrixFingerprint: candidate.matrixFingerprint,
      closureFingerprint,
      families,
    });
    const receipt = Object.freeze({}) as
      AdapterFamilySnapshotInventoryClosureReceipt;
    receiptRecords.set(receipt, Object.freeze({
      authority: this.authority,
      checkpointReceipt: input.checkpointReceipt,
      resolved,
    }));
    return receipt;
  }

  consumeForCatalog(
    receipt: AdapterFamilySnapshotInventoryClosureReceipt,
    expected: {
      readonly source: CanonicalSource;
    },
  ): ResolvedAdapterFamilySnapshotInventoryClosure {
    const record = receiptRecords.get(receipt);
    if (record === undefined || record.authority !== this.authority) {
      throw new Error("snapshot inventory closure receipt is forged or foreign");
    }
    assertSameSource(record.resolved.source, expected.source);
    if (this.#checkpointStore.capture() !== record.checkpointReceipt) {
      throw new Error("snapshot inventory checkpoint changed before consumption");
    }
    this.#assertGenerationCurrent(record.resolved.source);
    const publication = freezePublicationPointer(
      this.#captureCatalogPublication(),
    );
    if (
      record.resolved.expectedRevision !== publication.revision ||
      record.resolved.expectedPublicationFingerprint !==
        publication.publicationFingerprint
    ) {
      throw new Error("snapshot inventory closure prior publication mismatch");
    }
    receiptRecords.delete(receipt);
    return record.resolved;
  }

  /** Read-only evidence projection; the opaque receipt remains the authority. */
  closureSnapshot(
    receipt: AdapterFamilySnapshotInventoryClosureReceipt,
  ): ResolvedAdapterFamilySnapshotInventoryClosure {
    const record = receiptRecords.get(receipt);
    if (record === undefined || record.authority !== this.authority) {
      throw new Error("snapshot inventory closure receipt is forged or foreign");
    }
    return record.resolved;
  }
}

export function adapterFamilySnapshotInventoryHash(input: {
  readonly familyId: FamilyId;
  readonly source: CanonicalSource;
  readonly incumbents: readonly {
    readonly inventoryKey: string;
    readonly address: string;
    readonly currentSurface: AdapterFamilySnapshotInventoryObservation;
  }[];
}): string {
  const source = freezeSource(input.source);
  const incumbents = input.incumbents.map((incumbent) => {
    const inventoryKey = nonempty(incumbent.inventoryKey, "inventory key");
    const address = canonicalAddress(incumbent.address);
    const surface = freezeSurface(incumbent.currentSurface, source, address);
    return Object.freeze({
      inventoryKey,
      address,
      incumbentKind: surface.kind,
      currentSurfaceFingerprint: currentSurfaceFingerprint(surface),
      ...(surface.kind === "factory-log"
        ? {
            factory: surface.factory,
            poolKeyProjection: surface.poolKeyProjection,
            lastFactoryLogBlock: surface.lastFactoryLogBlock,
            topic: surface.topic,
          }
        : {}),
    });
  }).sort((left, right) => compareText(left.inventoryKey, right.inventoryKey));
  assertUnique(incumbents.map((item) => item.inventoryKey), "inventory key");
  return hashCanonical({
    format: "adapter-family-snapshot-inventory-v3",
    familyId: nonempty(input.familyId, "inventory Family id"),
    source,
    incumbents,
  } as unknown as CanonicalValue);
}

/**
 * Pure point-in-time inventory enumerator core. Re-enumerates a frozen
 * per-Family incumbent inventory against one canonical source: normalizes
 * addresses and address-surface observations, sorts/dedupes inventory keys,
 * rejects duplicate keys/unknown surfaces, and derives the same
 * source-bound inventory hash used by the snapshot inventory verifier.
 *
 * This is the reusable core the production bootstrap will feed with real
 * discovery outputs; it deliberately takes plain incumbent records instead
 * of a live backend so the verification-side re-enumeration can be re-run
 * against the exact same canonical source.
 */
export function enumeratePointInTimeInventory(input: {
  readonly source: CanonicalSource;
  readonly families: readonly {
    readonly familyId: FamilyId;
    readonly incumbents: readonly {
      readonly inventoryKey: string;
      readonly address: string;
      readonly currentSurface: AdapterFamilySnapshotInventoryObservation;
    }[];
  }[];
}): AdapterFamilySnapshotInventoryEnumerationInput {
  const source = freezeSource(input.source);
  const families = input.families.map((family) => {
    const familyId = nonempty(
      family.familyId,
      "enumeration Family id",
    ) as FamilyId;
    const incumbents = family.incumbents.map((incumbent) => {
      const inventoryKey = nonempty(
        incumbent.inventoryKey,
        "enumeration inventory key",
      );
      const address = canonicalAddress(incumbent.address);
      const currentSurface = freezeSurface(
        incumbent.currentSurface,
        source,
        address,
      );
      return Object.freeze({
        inventoryKey,
        address,
        currentSurface,
      });
    }).sort((left, right) => compareText(left.inventoryKey, right.inventoryKey));
    assertUnique(
      incumbents.map((incumbent) => incumbent.inventoryKey),
      "enumeration inventory key",
    );
    return Object.freeze({
      familyId,
      inventoryKeys: Object.freeze(
        incumbents.map((incumbent) => incumbent.inventoryKey),
      ),
      inventoryCount: incumbents.length,
      inventoryHash: adapterFamilySnapshotInventoryHash({
        familyId,
        source,
        incumbents,
      }),
      incumbents: Object.freeze(incumbents),
    });
  }).sort((left, right) => compareText(left.familyId, right.familyId));
  assertUnique(
    families.map((family) => family.familyId),
    "enumeration Family id",
  );
  return Object.freeze({
    source,
    families: Object.freeze(families),
  });
}

/**
 * Fail-closed coupling between a resolved snapshot inventory closure and the
 * staged publication keys of the strict catalog. Every closure Family must
 * stage exactly its admitted instance publication keys (sorted comparison,
 * no extras, no missing), and no extra staged Family may appear. This is the
 * `staged exact-set` half of the closure-receipt consumption gate; the strict
 * shadow catalog keeps refusing `complete-snapshot` until the production
 * point-in-time enumerator and the scan/bootstrap admitted-key exact union
 * land, so this contract is exercised as a standalone shadow gate.
 */
export function assertClosureStagedExactSetCoupling(input: {
  readonly closure: ResolvedAdapterFamilySnapshotInventoryClosure;
  readonly stagedByFamily: ReadonlyMap<FamilyId, readonly string[]>;
}): void {
  const staged = new Map<string, readonly string[]>();
  for (const [familyId, keys] of input.stagedByFamily) {
    if (new Set(keys).size !== keys.length) {
      throw new Error(
        `closure staged exact-set mismatch: duplicate staged key in ${familyId}`,
      );
    }
    staged.set(
      familyId,
      Object.freeze(
        [...keys].map((key) => nonempty(key, "staged publication key")).sort(),
      ),
    );
  }
  const expectedFamilies = new Set<string>();
  for (const family of input.closure.families) {
    if (expectedFamilies.has(family.familyId)) {
      throw new Error(
        `closure staged exact-set mismatch: duplicate Family ${family.familyId}`,
      );
    }
    expectedFamilies.add(family.familyId);
    const expected = [...family.admittedInstancePublicationKeys]
      .map((key) => nonempty(key, "admitted publication key"))
      .sort();
    const actual = staged.get(family.familyId) ?? [];
    if (actual.length !== expected.length) {
      throw new Error(
        `closure staged exact-set mismatch for ${family.familyId}: ` +
          `expected ${expected.length} keys, staged ${actual.length}`,
      );
    }
    for (let index = 0; index < expected.length; index++) {
      if (actual[index] !== expected[index]) {
        const missing = expected.filter((key) => !actual.includes(key));
        const extra = actual.filter((key) => !expected.includes(key));
        throw new Error(
          `closure staged exact-set mismatch for ${family.familyId}: ` +
            `missing=${missing.join(",")} extra=${extra.join(",")}`,
        );
      }
    }
  }
  for (const familyId of staged.keys()) {
    if (!expectedFamilies.has(familyId)) {
      throw new Error(
        `closure staged exact-set mismatch: unexpected Family ${familyId}`,
      );
    }
  }
}

function expectedFamilies(
  catalog: FamilyCapabilityCatalog,
): readonly ExpectedFamily[] {
  const sourcesWithinSnapshotScope =
    (sources: readonly DiscoverySourceKind[]) =>
      sources.every((sourceId) =>
        EVENT_SOURCE_IDS.has(sourceId) || sourceId === "address-surface"
      );
  const families = catalog.listAll().flatMap((family) => {
    if (!("discovery" in family.plugin)) return [];
    return [Object.freeze({
      familyId: family.plugin.manifest.familyId,
      declaredSourceIds: Object.freeze(
        [...family.plugin.discovery.sources].sort(compareText),
      ),
      supportsSnapshotBootstrap: sourcesWithinSnapshotScope(
        family.plugin.discovery.sources,
      ) && (
        (
          family.plugin.discovery.sources.includes("address-surface") &&
          (family.plugin.discovery.addressSurfaces?.length ?? 0) > 0
        ) || (
          family.plugin.discovery.sources.includes("factory-log") &&
          (family.plugin.discovery.logPatterns?.length ?? 0) > 0
        )
      ),
    })];
  }).sort((left, right) => compareText(left.familyId, right.familyId));
  assertUnique(families.map((family) => family.familyId), "discovery Family");
  if (families.length === 0) {
    throw new Error("snapshot inventory closure requires discovery Families");
  }
  return Object.freeze(families);
}

function validateAndFreezeFamilies(input: {
  readonly catalog: FamilyCapabilityCatalog;
  readonly expected: readonly ExpectedFamily[];
  readonly source: CanonicalSource;
  readonly families: readonly AdapterFamilySnapshotInventoryFamilyInput[];
}): readonly SnapshotFamily[] {
  if (!Array.isArray(input.families as unknown)) {
    throw new Error("snapshot inventory families must be an array");
  }
  const expectedById = new Map(input.expected.map((family) => [
    family.familyId,
    family,
  ]));
  const seen = new Set<FamilyId>();
  const families = input.families.map((raw) => {
    const expected = expectedById.get(raw.familyId);
    if (expected === undefined) {
      throw new Error(`unknown snapshot inventory Family ${raw.familyId}`);
    }
    if (seen.has(raw.familyId)) {
      throw new Error(`duplicate snapshot inventory Family ${raw.familyId}`);
    }
    seen.add(raw.familyId);
    if (!expected.supportsSnapshotBootstrap) {
      throw new Error(
        `snapshot inventory Family ${raw.familyId} lacks snapshot bootstrap coverage`,
      );
    }
    const inventoryKeys = sortedUnique(raw.inventoryKeys, "inventory keys");
    if (
      !Number.isSafeInteger(raw.inventoryCount) ||
      Object.is(raw.inventoryCount, -0) ||
      raw.inventoryCount < 0 ||
      raw.inventoryCount !== inventoryKeys.length
    ) {
      throw new Error(`snapshot inventory count mismatch for ${raw.familyId}`);
    }
    if (!Array.isArray(raw.incumbents as unknown)) {
      throw new Error(`snapshot incumbents must be an array for ${raw.familyId}`);
    }
    const family = input.catalog.forStrictFamily(raw.familyId);
    const incumbents = raw.incumbents.map((incumbent) => {
      const inventoryKey = nonempty(incumbent.inventoryKey, "inventory key");
      const address = canonicalAddress(incumbent.address);
      const currentSurface = freezeSurface(
        incumbent.currentSurface,
        input.source,
        address,
      );
      const decodeObservation: UnifiedObservation =
        currentSurface.kind === "factory-log"
          ? Object.freeze({
              kind: "log" as const,
              source: currentSurface.source,
              address: currentSurface.factory,
              topics: currentSurface.topics,
              data: currentSurface.data,
            })
          : currentSurface;
      const expectedCandidates = input.catalog.matches(currentSurface)
        .filter((match) => match.familyId === raw.familyId)
        .map((match) => {
          if (!("discovery" in family.plugin)) {
            throw new Error(`Family ${raw.familyId} has no discovery contract`);
          }
          const candidate = family.plugin.discovery.decodeCandidate({
            observation: decodeObservation,
            matchedPatternId: match.patternId,
          });
          return candidate === null
            ? null
            : nonempty(
              family.plugin.discovery.candidateKey(candidate),
              "snapshot candidate key",
            );
        }).filter((candidate): candidate is string => candidate !== null)
        .sort(compareText);
      const uniqueExpectedCandidates = sortedUnique(
        expectedCandidates,
        "snapshot candidate keys",
      );
      if (uniqueExpectedCandidates.length === 0) {
        throw new Error(
          `snapshot surface does not match Family ${raw.familyId}`,
        );
      }
      if (
        currentSurface.kind === "factory-log" &&
        !uniqueExpectedCandidates.includes(inventoryKey)
      ) {
        throw new Error(
          `snapshot factory-log surface does not close ${inventoryKey}`,
        );
      }
      const terminalCandidates = incumbent.terminalCandidates.map(
        freezeTerminalCandidate,
      ).sort((left, right) => compareText(left.candidateKey, right.candidateKey));
      assertUnique(
        terminalCandidates.map((candidate) => candidate.candidateKey),
        "terminal candidate key",
      );
      if (!sameTextArray(
        terminalCandidates.map((candidate) => candidate.candidateKey),
        uniqueExpectedCandidates,
      )) {
        throw new Error(
          `snapshot terminal candidates do not close ${inventoryKey}`,
        );
      }
      if (terminalCandidates.some((candidate) => candidate.status !== "terminal")) {
        throw new Error(`snapshot terminal evidence is partial for ${inventoryKey}`);
      }
      return Object.freeze({
        inventoryKey,
        address,
        currentSurface,
        currentSurfaceFingerprint: currentSurfaceFingerprint(currentSurface),
        terminalCandidates: Object.freeze(terminalCandidates),
      });
    }).sort((left, right) => compareText(left.inventoryKey, right.inventoryKey));
    assertUnique(incumbents.map((item) => item.inventoryKey), "incumbent key");
    if (!sameTextArray(
      incumbents.map((item) => item.inventoryKey),
      inventoryKeys,
    )) {
      throw new Error(`snapshot inventory keys do not match ${raw.familyId}`);
    }
    const inventoryHash = adapterFamilySnapshotInventoryHash({
      familyId: raw.familyId,
      source: input.source,
      incumbents,
    });
    if (raw.inventoryHash !== inventoryHash) {
      throw new Error(`snapshot inventory hash mismatch for ${raw.familyId}`);
    }
    const terminalEvidenceFingerprint = hashCanonical({
      format: "adapter-family-snapshot-terminal-evidence-v1",
      familyId: raw.familyId,
      source: input.source,
      incumbents: incumbents.map((item) => ({
        inventoryKey: item.inventoryKey,
        terminalCandidates: item.terminalCandidates,
      })),
    } as unknown as CanonicalValue);
    const admittedInstancePublicationKeys = sortedUnique(
      incumbents.flatMap((item) => item.terminalCandidates.flatMap(
        (candidate) => candidate.admittedInstancePublicationKeys,
      )),
      "admitted instance publication keys",
    );
    return Object.freeze({
      familyId: raw.familyId,
      declaredSourceIds: expected.declaredSourceIds,
      inventoryKeys,
      inventoryCount: raw.inventoryCount,
      inventoryHash,
      incumbents: Object.freeze(incumbents),
      admittedInstancePublicationKeys,
      terminalEvidenceFingerprint,
    });
  }).sort((left, right) => compareText(left.familyId, right.familyId));
  if (seen.size === 0) {
    throw new Error("snapshot inventory is missing discovery Family rows");
  }
  return Object.freeze(families);
}

function freezeTerminalCandidate(
  input: AdapterFamilySnapshotTerminalCandidateInput,
): SnapshotTerminalCandidate {
  if (input.status !== "terminal" && input.status !== "partial") {
    throw new Error("invalid snapshot terminal status");
  }
  return Object.freeze({
    candidateKey: nonempty(input.candidateKey, "terminal candidate key"),
    status: input.status,
    outcomeFingerprint: canonicalFingerprint(
      input.outcomeFingerprint,
      "terminal outcome fingerprint",
    ),
    evidenceRefs: sortedUnique(input.evidenceRefs, "terminal evidence refs"),
    admittedInstancePublicationKeys: sortedUnique(
      input.admittedInstancePublicationKeys,
      "admitted instance publication keys",
    ),
    publicationFingerprints: Object.freeze(sortedUnique(
      input.publicationFingerprints,
      "publication fingerprints",
    ).map((fingerprint) =>
      canonicalFingerprint(fingerprint, "publication fingerprint")
    )),
  });
}

function validateAuthoritativeInventory(input: {
  readonly catalog: FamilyCapabilityCatalog;
  readonly expected: readonly ExpectedFamily[];
  readonly source: CanonicalSource;
  readonly candidateFamilies: readonly SnapshotFamily[];
  readonly enumeration: AdapterFamilySnapshotInventoryEnumerationInput;
}): readonly SnapshotFamily[] {
  if (input.enumeration === null || typeof input.enumeration !== "object") {
    throw new Error("snapshot inventory enumerator returned no inventory");
  }
  assertSameSource(input.enumeration.source, input.source);
  if (!Array.isArray(input.enumeration.families as unknown)) {
    throw new Error("snapshot inventory enumeration families must be an array");
  }
  const candidatesByFamily = new Map(input.candidateFamilies.map((family) => [
    family.familyId,
    family,
  ]));
  // Mixed-mode (per-Family) closures cover exactly the candidate Families;
  // the authoritative enumeration is authoritative for that covered subset.
  // Families outside the receipt stay append-only by construction.
  const combined = input.enumeration.families.filter((family) =>
    candidatesByFamily.has(family.familyId)
  ).map((family) => {
    const candidateFamily = candidatesByFamily.get(family.familyId);
    const candidatesByInventoryKey = new Map(
      candidateFamily?.incumbents.map((incumbent) => [
        incumbent.inventoryKey,
        incumbent.terminalCandidates,
      ]) ?? [],
    );
    return Object.freeze({
      familyId: family.familyId,
      inventoryKeys: family.inventoryKeys,
      inventoryCount: family.inventoryCount,
      inventoryHash: family.inventoryHash,
      incumbents: Object.freeze(family.incumbents.map((incumbent) =>
        Object.freeze({
          ...incumbent,
          terminalCandidates:
            candidatesByInventoryKey.get(incumbent.inventoryKey) ?? [],
        })
      )),
    });
  });
  return validateAndFreezeFamilies({
    catalog: input.catalog,
    expected: input.expected,
    source: input.source,
    families: combined,
  });
}

function snapshotInventoryMatrixFingerprint(input: {
  readonly binding: AdapterFamilySnapshotInventoryClosureBinding;
  readonly source: CanonicalSource;
  readonly families: readonly SnapshotFamily[];
}): string {
  return hashCanonical({
    format: "adapter-family-snapshot-inventory-authority-matrix-v1",
    ...input.binding,
    source: input.source,
    families: input.families.map((family) => ({
      familyId: family.familyId,
      declaredSourceIds: family.declaredSourceIds,
      inventoryCount: family.inventoryCount,
      inventoryHash: family.inventoryHash,
      inventoryKeys: family.inventoryKeys,
      incumbents: family.incumbents.map((incumbent) => ({
        inventoryKey: incumbent.inventoryKey,
        address: incumbent.address,
        currentSurfaceFingerprint: incumbent.currentSurfaceFingerprint,
      })),
    })),
  } as unknown as CanonicalValue);
}

function snapshotMatrixFingerprint(input: {
  readonly binding: AdapterFamilySnapshotInventoryClosureBinding;
  readonly source: CanonicalSource;
  readonly families: readonly SnapshotFamily[];
}): string {
  return hashCanonical({
    format: "adapter-family-snapshot-inventory-matrix-v1",
    ...input.binding,
    source: input.source,
    families: input.families.map((family) => ({
      familyId: family.familyId,
      declaredSourceIds: family.declaredSourceIds,
      inventoryCount: family.inventoryCount,
      inventoryHash: family.inventoryHash,
      inventoryKeys: family.inventoryKeys,
      admittedInstancePublicationKeys: family.admittedInstancePublicationKeys,
      terminalEvidenceFingerprint: family.terminalEvidenceFingerprint,
    })),
  } as unknown as CanonicalValue);
}

function assertEventContinuity(
  families: readonly SnapshotFamily[],
  watermarks: readonly {
    readonly familyId: FamilyId;
    readonly sourceId: DiscoverySourceKind;
    readonly coverageAuthority: "append-only" | "contiguous-history";
    readonly completeThroughBlock: number;
    readonly completeThroughHash: string | null;
  }[],
  source: CanonicalSource,
): void {
  const byKey = new Map(watermarks.map((watermark) => [
    familySourceKey(watermark.familyId, watermark.sourceId),
    watermark,
  ]));
  for (const family of families) {
    for (const sourceId of family.declaredSourceIds) {
      if (!EVENT_SOURCE_IDS.has(sourceId)) continue;
      const watermark = byKey.get(familySourceKey(family.familyId, sourceId));
      if (
        watermark === undefined ||
        watermark.coverageAuthority !== "contiguous-history" ||
        watermark.completeThroughBlock !== source.number ||
        watermark.completeThroughHash !== source.hash
      ) {
        throw new Error(
          `snapshot inventory lacks current event continuity for ${family.familyId}/${sourceId}`,
        );
      }
    }
  }
}

function validateExpectedPublication(
  revision: number,
  fingerprint: string | null,
): string | null {
  if (
    !Number.isSafeInteger(revision) ||
    Object.is(revision, -0) ||
    revision < 0
  ) {
    throw new Error("invalid expected catalog publication revision");
  }
  if ((revision === 0) !== (fingerprint === null)) {
    throw new Error("expected publication fingerprint/revision mismatch");
  }
  return fingerprint === null
    ? null
    : canonicalFingerprint(fingerprint, "expected publication fingerprint");
}

function freezePublicationPointer(
  pointer: AdapterFamilySnapshotCatalogPublicationPointer,
): AdapterFamilySnapshotCatalogPublicationPointer {
  if (pointer === null || typeof pointer !== "object") {
    throw new Error("snapshot inventory catalog publication pointer is missing");
  }
  return Object.freeze({
    revision: pointer.revision,
    publicationFingerprint: validateExpectedPublication(
      pointer.revision,
      pointer.publicationFingerprint,
    ),
  });
}

function samePublicationPointer(
  left: AdapterFamilySnapshotCatalogPublicationPointer,
  right: AdapterFamilySnapshotCatalogPublicationPointer,
): boolean {
  return left.revision === right.revision &&
    left.publicationFingerprint === right.publicationFingerprint;
}

function freezeBinding(
  input: AdapterFamilySnapshotInventoryClosureBinding,
): AdapterFamilySnapshotInventoryClosureBinding {
  const chainId = nonempty(input.chainId, "chain id");
  if (!/^[1-9][0-9]*$/.test(chainId)) {
    throw new Error(`invalid chain id ${chainId}`);
  }
  return Object.freeze({
    chainId: BigInt(chainId).toString(),
    catalogHash: canonicalFingerprint(input.catalogHash, "catalog hash"),
    sourceRegistryFingerprint: nonempty(
      input.sourceRegistryFingerprint,
      "source registry fingerprint",
    ),
  });
}

function freezeSource(source: CanonicalSource): CanonicalSource {
  if (
    !Number.isSafeInteger(source.number) ||
    Object.is(source.number, -0) ||
    source.number < 0 ||
    !Number.isSafeInteger(source.generation) ||
    Object.is(source.generation, -0) ||
    source.generation < 0
  ) {
    throw new Error("snapshot inventory source must be canonical");
  }
  return Object.freeze({
    number: source.number,
    hash: canonicalHash(source.hash, "source hash"),
    generation: source.generation,
  });
}

function freezeSurface(
  surface: AdapterFamilySnapshotInventoryObservation,
  source: CanonicalSource,
  address: string,
): AdapterFamilySnapshotInventoryObservation {
  if (surface === null || typeof surface !== "object") {
    throw new Error("snapshot inventory requires a current incumbent surface");
  }
  if (surface.kind !== "address-surface" && surface.kind !== "factory-log") {
    throw new Error(
      "snapshot inventory requires an address-surface or factory-log surface",
    );
  }
  assertSameSource(surface.source, source);
  if (surface.kind === "factory-log") {
    const factory = canonicalAddress(surface.factory);
    const poolKeyProjection = nonempty(
      surface.poolKeyProjection,
      "factory-log pool key projection",
    );
    if (
      !Number.isSafeInteger(surface.lastFactoryLogBlock) ||
      Object.is(surface.lastFactoryLogBlock, -0) ||
      surface.lastFactoryLogBlock < 0 ||
      surface.lastFactoryLogBlock > source.number
    ) {
      throw new Error(
        "snapshot factory-log surface block must not exceed its source",
      );
    }
    const topic = canonicalHash(surface.topic, "factory-log topic") as Hex32;
    const topics = surface.topics.map((value) =>
      canonicalHash(value, "factory-log topic")
    );
    if (!topics.includes(topic)) {
      throw new Error("snapshot factory-log surface topic not in topics");
    }
    if (typeof surface.data !== "string" || !/^0x[0-9a-fA-F]*$/.test(
      surface.data,
    )) {
      throw new Error("snapshot factory-log surface data must be hex");
    }
    return Object.freeze({
      kind: "factory-log" as const,
      source,
      factory,
      poolKeyProjection,
      lastFactoryLogBlock: surface.lastFactoryLogBlock,
      topic,
      topics: Object.freeze(topics),
      data: surface.data.toLowerCase(),
    });
  }
  if (canonicalAddress(surface.address) !== address) {
    throw new Error("snapshot inventory surface address mismatch");
  }
  const interfaceFingerprints = surface.interfaceFingerprints === undefined
    ? undefined
    : sortedUnique(
      surface.interfaceFingerprints,
      "surface interface fingerprints",
    );
  return Object.freeze({
    kind: "address-surface" as const,
    source,
    address,
    codeHash: canonicalHash(surface.codeHash, "surface code hash"),
    implementationWord: canonicalHash(
      surface.implementationWord,
      "surface implementation word",
    ),
    ...(interfaceFingerprints === undefined
      ? {}
      : { interfaceFingerprints }),
  });
}

function currentSurfaceFingerprint(
  surface: AdapterFamilySnapshotInventoryObservation,
): string {
  if (surface.kind === "factory-log") {
    return hashCanonical({
      kind: surface.kind,
      factory: surface.factory,
      poolKeyProjection: surface.poolKeyProjection,
      lastFactoryLogBlock: surface.lastFactoryLogBlock,
      topic: surface.topic,
      topics: surface.topics,
      data: surface.data,
    });
  }
  return hashCanonical({
    kind: surface.kind,
    address: surface.address,
    codeHash: surface.codeHash,
    implementationWord: surface.implementationWord,
    interfaceFingerprints: surface.interfaceFingerprints ?? [],
  });
}

function sortedUnique(values: readonly string[], label: string): readonly string[] {
  if (!Array.isArray(values)) throw new Error(`${label} must be an array`);
  const sorted = values.map((value) => nonempty(value, label)).sort(compareText);
  assertUnique(sorted, label);
  return Object.freeze(sorted);
}

function assertUnique(values: readonly string[], label: string): void {
  for (let index = 1; index < values.length; index += 1) {
    if (values[index] === values[index - 1]) {
      throw new Error(`duplicate ${label} ${values[index]}`);
    }
  }
}

function nonempty(value: string, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be non-empty`);
  }
  return value;
}

function canonicalAddress(value: string): string {
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) {
    throw new Error(`invalid snapshot inventory address ${value}`);
  }
  return value.toLowerCase();
}

function canonicalHash(value: string, label: string): string {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error(`invalid ${label}`);
  }
  return value.toLowerCase();
}

function canonicalFingerprint(value: string, label: string): string {
  if (!/^[0-9a-f]{64}$/.test(value)) {
    throw new Error(`invalid ${label}`);
  }
  return value;
}

function assertSameSource(actual: CanonicalSource, expected: CanonicalSource): void {
  const frozen = freezeSource(actual);
  if (
    frozen.number !== expected.number ||
    frozen.hash !== expected.hash ||
    frozen.generation !== expected.generation
  ) {
    throw new Error("snapshot inventory canonical source mismatch");
  }
}

function sameBinding(
  left: AdapterFamilySnapshotInventoryClosureBinding,
  right: AdapterFamilySnapshotInventoryClosureBinding,
): boolean {
  return left.chainId === right.chainId &&
    left.catalogHash === right.catalogHash &&
    left.sourceRegistryFingerprint === right.sourceRegistryFingerprint;
}

function sameTextArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length &&
    left.every((value, index) => value === right[index]);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function familySourceKey(familyId: FamilyId, sourceId: DiscoverySourceKind): string {
  return JSON.stringify([familyId, sourceId]);
}
