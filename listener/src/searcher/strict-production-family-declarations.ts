import { ethers } from "ethers";
import type { TokenEdge } from "./planner/token-graph.js";
import {
  createPendingTransactionEvidenceProjection,
  type PendingTransactionEvidenceObserverRegistration,
  type PendingTransactionEvidenceProjection,
} from "./venues/adapter-family-registry.js";
import type {
  DiscoveryCandidateSourceKind,
  DiscoverySemantics,
  FamilyCandidate,
  OracleVictimSpec,
  RuntimeEvidence,
  UnifiedObservation,
} from "./venues/adapter-family-plugin.js";
import type { CanonicalSource } from
  "./venues/adapter-request-program.js";
import type { FamilyId } from "./venues/adapter-family-identifiers.js";
import type { FamilyCapabilityCatalog } from
  "./venues/family-capability-catalog.js";
import { PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG } from
  "./venues/production-family-composition.js";
import type {
  AllowedTaxonomy,
  ExecutionFamilyId,
  PendingExecutionEvidence,
  PendingTransactionEvidenceContext,
  PendingTransactionEvidenceInput,
} from "./venues/route-leg-adapter.js";
import type { StrictOracleVictimDescriptor } from
  "./detector/victim-effect.js";

const FAMILY_WIDE_ACTIVATION_SCOPE = "family-wide";
const ZERO_HASH = `0x${"00".repeat(32)}`;

export type StrictLivePoolStateKind =
  | "constant-product-v2"
  | "concentrated-v3"
  | "singleton-v4";

/** Minimal, inert Family metadata needed by the frozen blind comparator. */
export interface StrictRouteFamilyDeclaration {
  readonly id: string;
  readonly kind: "swap" | "protocol-conversion" | "credit";
  readonly poolAdapters: readonly string[];
  readonly edgeAdapterIds: readonly string[];
  readonly ownedActionAdapterIds: readonly string[];
  readonly requiredInfraActionAdapterIds: readonly string[];
  readonly allowedTaxonomy: readonly AllowedTaxonomy[];
  readonly candidateSources: readonly DiscoveryCandidateSourceKind[];
  readonly requiresProtocolEdgesFlag: boolean;
}

export interface StrictLandedLog {
  readonly address: string;
  readonly topics: readonly string[];
  readonly data: string;
  readonly blockNumber?: number;
  readonly blockHash?: string;
  readonly transactionHash?: string;
}

type RoutePluginProjection = {
  readonly manifest: {
    readonly familyId: FamilyId;
    readonly domain: "swap" | "protocol" | "credit" | "funding";
    readonly poolAdapterIds?: readonly string[];
    readonly edgeAdapterIds?: readonly string[];
    readonly ownedActionAdapterIds: readonly string[];
    readonly requiredInfraActionAdapterIds: readonly string[];
    readonly allowedTaxonomy: readonly AllowedTaxonomy[];
    readonly fundingPriority?: {
      readonly planningPriority: number;
      readonly liquidityPriority: number;
    };
    readonly requiresProtocolEdgesFlag?: boolean;
    readonly livePoolStateKind?: StrictLivePoolStateKind;
  };
  readonly discovery?: DiscoverySemantics<FamilyCandidate>;
  readonly swap?: {
    readonly landedEvents: {
      classify(input: {
        readonly observation: UnifiedObservation;
      }): "swap" | "mutation" | null;
    };
  };
  readonly protocol?: {
    readonly oracleVictim?: OracleVictimSpec;
  };
};

export class StrictProductionFamilyDeclarations {
  readonly pendingEvidence: PendingTransactionEvidenceProjection;
  readonly canonicalIntakeTargets: readonly string[];
  readonly routeFamilies: readonly StrictRouteFamilyDeclaration[];
  readonly fundingActionIds: readonly string[];
  readonly creditActionIds: readonly string[];
  readonly oracleVictims: readonly StrictOracleVictimDescriptor[];

  readonly #catalog: FamilyCapabilityCatalog;
  readonly #activationByFamily: ReadonlySet<string>;
  readonly #livePoolStateKindByEdge: ReadonlyMap<
    string,
    StrictLivePoolStateKind
  >;

  constructor(catalog: FamilyCapabilityCatalog) {
    this.#catalog = catalog;
    const activationByFamily = new Set<string>();
    const livePoolStateKindByEdge = new Map<string, StrictLivePoolStateKind>();
    const canonicalTargets: string[] = [];
    const canonicalTargetSet = new Set<string>();
    const observers: PendingTransactionEvidenceObserverRegistration[] = [];
    const routeFamilies: StrictRouteFamilyDeclaration[] = [];
    const fundingActions: Array<{
      readonly familyId: string;
      readonly actionId: string;
      readonly planningPriority: number;
    }> = [];
    const creditActionIds: string[] = [];
    const oracleVictims: StrictOracleVictimDescriptor[] = [];
    const oracleVictimIds = new Set<string>();

    for (const loaded of catalog.listAll()) {
      const plugin = loaded.plugin as unknown as RoutePluginProjection;
      const manifest = plugin.manifest;
      if (manifest.domain === "funding") {
        const planningPriority = manifest.fundingPriority?.planningPriority;
        if (
          planningPriority === undefined ||
          !Number.isSafeInteger(planningPriority) ||
          planningPriority < 0
        ) {
          throw new Error(
            `strict declarations: ${manifest.familyId} has invalid funding priority`,
          );
        }
        fundingActions.push(...manifest.ownedActionAdapterIds.map(
          (actionId) => Object.freeze({
            familyId: manifest.familyId,
            actionId,
            planningPriority,
          }),
        ));
        continue;
      }
      if (manifest.domain !== "swap" && manifest.domain !== "protocol" &&
          manifest.domain !== "credit") {
        continue;
      }
      if (manifest.domain === "credit") {
        creditActionIds.push(...manifest.ownedActionAdapterIds);
      }
      routeFamilies.push(Object.freeze({
        id: manifest.familyId,
        kind: manifest.domain === "protocol"
          ? "protocol-conversion"
          : manifest.domain,
        poolAdapters: Object.freeze([...(manifest.poolAdapterIds ?? [])]),
        edgeAdapterIds: Object.freeze([...(manifest.edgeAdapterIds ?? [])]),
        ownedActionAdapterIds: Object.freeze([
          ...manifest.ownedActionAdapterIds,
        ]),
        requiredInfraActionAdapterIds: Object.freeze([
          ...manifest.requiredInfraActionAdapterIds,
        ]),
        allowedTaxonomy: Object.freeze(
          manifest.allowedTaxonomy.map((entry) => Object.freeze({ ...entry })),
        ),
        candidateSources: Object.freeze([
          ...(plugin.discovery?.candidateSources ?? []),
        ]),
        requiresProtocolEdgesFlag:
          manifest.requiresProtocolEdgesFlag ?? false,
      }));
      for (const edgeAdapterId of manifest.edgeAdapterIds ?? []) {
        if (catalog.ownerOfAction(edgeAdapterId) !== manifest.familyId) {
          throw new Error(
            `strict declarations: ${edgeAdapterId} ownership mismatch`,
          );
        }
        if (manifest.livePoolStateKind !== undefined) {
          const incumbent = livePoolStateKindByEdge.get(edgeAdapterId);
          if (incumbent !== undefined) {
            throw new Error(
              `strict declarations: duplicate live state for ${edgeAdapterId}`,
            );
          }
          livePoolStateKindByEdge.set(
            edgeAdapterId,
            manifest.livePoolStateKind,
          );
        }
      }

      const discovery = plugin.discovery;
      appendCanonicalTargets(
        manifest.familyId,
        discovery?.canonicalIntakeTargets ?? [],
        canonicalTargets,
        canonicalTargetSet,
      );
      appendCanonicalTargets(
        manifest.familyId,
        plugin.protocol?.oracleVictim?.canonicalIntakeTargets ?? [],
        canonicalTargets,
        canonicalTargetSet,
      );
      if (plugin.protocol?.oracleVictim !== undefined) {
        const descriptor = createStrictOracleVictimDescriptor(
          manifest.familyId,
          plugin.protocol.oracleVictim,
        );
        if (oracleVictimIds.has(descriptor.id)) {
          throw new Error(
            `strict declarations: duplicate oracle victim ${descriptor.id}`,
          );
        }
        oracleVictimIds.add(descriptor.id);
        oracleVictims.push(descriptor);
      }
      const activation = discovery?.runtimeEvidenceRouteActivation;
      const derive = discovery?.pendingRuntimeEvidenceFromObservation;
      if (activation === undefined && derive === undefined) continue;
      if (
        activation?.mode !== "current-head-block-scan" ||
        activation.scope !== "family" ||
        derive === undefined
      ) {
        throw new Error(
          `strict declarations: invalid runtime evidence activation for ` +
            manifest.familyId,
        );
      }
      if (activationByFamily.has(manifest.familyId)) {
        throw new Error(
          `strict declarations: duplicate activation for ${manifest.familyId}`,
        );
      }
      activationByFamily.add(manifest.familyId);
      observers.push(createPendingObserver(catalog, plugin, derive));
    }

    this.#activationByFamily = activationByFamily;
    this.#livePoolStateKindByEdge = livePoolStateKindByEdge;
    this.canonicalIntakeTargets = Object.freeze(canonicalTargets);
    this.fundingActionIds = uniqueActionIds(
      "funding",
      fundingActions.sort((left, right) =>
        left.planningPriority - right.planningPriority ||
        left.familyId.localeCompare(right.familyId) ||
        left.actionId.localeCompare(right.actionId)
      ).map((entry) => entry.actionId),
    );
    this.creditActionIds = uniqueActionIds("credit", creditActionIds);
    this.oracleVictims = Object.freeze(oracleVictims);
    this.routeFamilies = Object.freeze(routeFamilies);
    this.pendingEvidence = createPendingTransactionEvidenceProjection(
      observers,
    );
    Object.freeze(this);
  }

  familyIdForEdge(edgeAdapterId: string): ExecutionFamilyId {
    return this.#catalog.ownerOfAction(edgeAdapterId) as unknown as
      ExecutionFamilyId;
  }

  familyIdForPool(poolAdapterId: string): ExecutionFamilyId {
    return this.#catalog.ownerOfPoolAdapter(poolAdapterId) as unknown as
      ExecutionFamilyId;
  }

  requiresProtocolEdgesForPool(poolAdapterId: string): boolean {
    const familyId = this.#catalog.ownerOfPoolAdapter(poolAdapterId);
    return this.#catalog.requiresProtocolEdgesFlagFor(familyId);
  }

  currentHeadEvidenceFamilyForEdge(
    edgeAdapterId: string,
  ): ExecutionFamilyId | null {
    const familyId = this.familyIdForEdge(edgeAdapterId);
    return this.#activationByFamily.has(familyId) ? familyId : null;
  }

  currentHeadEvidenceScopeKeyForEdge(edge: TokenEdge): string | null {
    return this.currentHeadEvidenceFamilyForEdge(edge.adapterId) === null
      ? null
      : FAMILY_WIDE_ACTIVATION_SCOPE;
  }

  currentHeadEvidenceScopeKeys(
    evidence: PendingExecutionEvidence,
  ): readonly string[] {
    return this.#activationByFamily.has(evidence.familyId)
      ? Object.freeze([FAMILY_WIDE_ACTIVATION_SCOPE])
      : Object.freeze([]);
  }

  isCurrentHeadEvidenceFamily(familyId: ExecutionFamilyId): boolean {
    return this.#activationByFamily.has(familyId);
  }

  livePoolStateKindForEdge(
    edgeAdapterId: string,
  ): StrictLivePoolStateKind | null {
    return this.#livePoolStateKindByEdge.get(edgeAdapterId) ?? null;
  }

  isSwapLog(log: StrictLandedLog): boolean {
    const observation = landedLogObservation(log);
    if (observation === null) return false;
    const visited = new Set<string>();
    for (const match of this.#catalog.matches(observation)) {
      if (visited.has(match.familyId)) continue;
      visited.add(match.familyId);
      const plugin = this.#catalog.forStrictFamily(match.familyId).plugin as
        unknown as RoutePluginProjection;
      if (plugin.manifest.domain !== "swap" || plugin.swap === undefined) {
        continue;
      }
      if (plugin.swap.landedEvents.classify({ observation }) === "swap") {
        return true;
      }
    }
    return false;
  }
}

function createStrictOracleVictimDescriptor(
  familyId: FamilyId,
  oracle: OracleVictimSpec,
): StrictOracleVictimDescriptor {
  const runtime = oracle.runtimeDetection;
  return Object.freeze({
    id: runtime.id,
    affectedEdges: Object.freeze(runtime.affectedEdges.map((edge) =>
      Object.freeze({ ...edge })
    )),
    priceProbe: Object.freeze({ ...runtime.priceProbe }),
    maxSearchHops: runtime.maxSearchHops,
    matches(input: {
      readonly to: string | null;
      readonly data: string;
      readonly blockNumber: number;
    }) {
      if (
        input.to === null ||
        !ethers.isAddress(input.to) ||
        !ethers.isHexString(input.data) ||
        !Number.isSafeInteger(input.blockNumber) ||
        input.blockNumber < 0
      ) {
        return false;
      }
      try {
        return oracle.decode({
          observation: Object.freeze({
            kind: "call" as const,
            source: Object.freeze({
              number: input.blockNumber,
              hash: ZERO_HASH,
              generation: 0,
            }),
            target: ethers.getAddress(input.to),
            data: input.data,
          }),
        }) !== null;
      } catch (error) {
        throw new Error(
          `strict oracle victim ${familyId}/${runtime.id} failed: ` +
            `${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },
  });
}

function uniqueActionIds(
  domain: "funding" | "credit",
  actionIds: readonly string[],
): readonly string[] {
  const unique = [...new Set(actionIds)];
  if (
    unique.length !== actionIds.length ||
    unique.some((actionId) => actionId.trim().length === 0)
  ) {
    throw new Error(`strict declarations: invalid ${domain} action ownership`);
  }
  return Object.freeze(unique);
}

function createPendingObserver(
  catalog: FamilyCapabilityCatalog,
  plugin: RoutePluginProjection,
  derive: NonNullable<
    DiscoverySemantics<FamilyCandidate>["pendingRuntimeEvidenceFromObservation"]
  >,
): PendingTransactionEvidenceObserverRegistration {
  const familyId = plugin.manifest.familyId as unknown as ExecutionFamilyId;
  return Object.freeze({
    familyId,
    mightMatch(tx: PendingTransactionEvidenceInput): boolean {
      const observation = pendingCallObservation(tx, null);
      return observation !== null && catalog.matches(observation).some(
        (match) => match.familyId === plugin.manifest.familyId,
      );
    },
    async observe(
      tx: PendingTransactionEvidenceInput,
      context: PendingTransactionEvidenceContext,
    ) {
      const source: CanonicalSource = Object.freeze({
        number: context.head.number,
        hash: context.head.hash.toLowerCase(),
        generation: 0,
      });
      const observation = pendingCallObservation(tx, source);
      if (
        observation === null ||
        !catalog.matches(observation).some(
          (match) => match.familyId === plugin.manifest.familyId,
        )
      ) {
        return null;
      }
      const evidence = await derive({
        observation,
        source,
        call: (read) => context.call(read),
      });
      const valid = evidence.filter((item) =>
        pendingEvidenceMatches(item, plugin.manifest.familyId, tx.hash, source)
      );
      if (valid.length === 0) return null;
      if (valid.length !== 1 || valid.length !== evidence.length) {
        throw new Error(
          `strict pending evidence escaped ${plugin.manifest.familyId}/source`,
        );
      }
      return Object.freeze({ canonicalPayload: valid[0].sealedPayloadRef });
    },
  });
}

function pendingCallObservation(
  tx: PendingTransactionEvidenceInput,
  source: CanonicalSource | null,
): UnifiedObservation | null {
  if (tx.to === null || !ethers.isAddress(tx.to)) return null;
  return Object.freeze({
    kind: "call" as const,
    source: source ?? Object.freeze({
      number: 0,
      hash: ZERO_HASH,
      generation: 0,
    }),
    target: ethers.getAddress(tx.to),
    data: tx.data,
    transactionHash: tx.hash.toLowerCase(),
  });
}

function pendingEvidenceMatches(
  evidence: RuntimeEvidence,
  familyId: FamilyId,
  txHash: string,
  source: CanonicalSource,
): boolean {
  return evidence.familyId === familyId &&
    evidence.scope === "transaction" &&
    evidence.txHash?.toLowerCase() === txHash.toLowerCase() &&
    evidence.source.number === source.number &&
    evidence.source.hash.toLowerCase() === source.hash.toLowerCase() &&
    evidence.source.generation === source.generation &&
    ethers.isHexString(evidence.evidenceHash, 32) &&
    ethers.isHexString(evidence.sealedPayloadRef);
}

function appendCanonicalTargets(
  familyId: FamilyId,
  targets: readonly string[],
  output: string[],
  globalSeen: Set<string>,
): void {
  const localSeen = new Set<string>();
  for (const target of targets) {
    if (!ethers.isAddress(target)) {
      throw new Error(
        `strict declarations: ${familyId} has invalid intake target ${target}`,
      );
    }
    const canonical = ethers.getAddress(target);
    const key = canonical.toLowerCase();
    if (canonical === ethers.ZeroAddress || localSeen.has(key)) {
      throw new Error(
        `strict declarations: ${familyId} duplicates/zeros intake target`,
      );
    }
    localSeen.add(key);
    if (globalSeen.has(key)) continue;
    globalSeen.add(key);
    output.push(canonical);
  }
}

function landedLogObservation(log: StrictLandedLog): UnifiedObservation | null {
  if (
    !ethers.isAddress(log.address) ||
    !Number.isSafeInteger(log.blockNumber) ||
    (log.blockNumber ?? -1) < 0 ||
    !ethers.isHexString(log.blockHash, 32) ||
    !ethers.isHexString(log.data) ||
    log.topics.some((topic) => !ethers.isHexString(topic, 32)) ||
    (log.transactionHash !== undefined &&
      !ethers.isHexString(log.transactionHash, 32))
  ) {
    return null;
  }
  return Object.freeze({
    kind: "log" as const,
    source: Object.freeze({
      number: log.blockNumber!,
      hash: log.blockHash!.toLowerCase(),
      generation: 0,
    }),
    address: ethers.getAddress(log.address),
    topics: Object.freeze([...log.topics]),
    data: log.data,
    ...(log.transactionHash === undefined
      ? {}
      : { transactionHash: log.transactionHash.toLowerCase() }),
  });
}

export const PRODUCTION_STRICT_FAMILY_DECLARATIONS =
  new StrictProductionFamilyDeclarations(
    PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG,
  );
