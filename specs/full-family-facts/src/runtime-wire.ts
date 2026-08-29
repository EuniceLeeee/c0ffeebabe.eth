import {
  assertDecimalString,
  assertExactKeys,
  assertHash,
  assertNonEmptyString,
  decodeCanonicalJson,
  decodeExactObject,
  deepFreeze,
  encodeCanonicalBytes,
  encodeCanonicalJson,
  fieldArray,
  hashCanonicalPartition,
  hashDomain,
  type CanonicalJson,
  type Hash,
} from "../../../packages/canonical-codec/src/index.ts";
import {
  decodeFullFamilyCanonicalCutoff,
  decodeFullFamilySourcePlanRef,
  type CanonicalCutoffV1,
  type SourcePlanRefV1,
} from "./source-wire.ts";

export interface FullFamilyStageCapabilityRefV1 {
  readonly familyId: string;
  readonly familyDefinitionHash: Hash;
  readonly stage: "nomination" | "identity" | "materialization" | "projection" | "rehydration" | "capability";
  readonly capabilityId: string;
  readonly version: string;
  readonly schemaHash: Hash;
  readonly interpreterHash: Hash;
  readonly ownerRef: Hash;
}

export function decodeFullFamilyStageCapabilityRef(value: unknown, path = "stageCapabilityRef"): FullFamilyStageCapabilityRefV1 {
  return deepFreeze(decodeExactObject(value, {
    familyId: (field, itemPath) => {
      const familyId = assertNonEmptyString(field, itemPath);
      if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(familyId)) throw new TypeError(`${itemPath} is invalid`);
      return familyId;
    },
    familyDefinitionHash: (field, itemPath) => assertHash(field, itemPath),
    stage: (field, itemPath) => {
      if (field !== "nomination" && field !== "identity" && field !== "materialization"
        && field !== "projection" && field !== "rehydration" && field !== "capability") {
        throw new TypeError(`${itemPath} is invalid`);
      }
      return field;
    },
    capabilityId: (field, itemPath) => assertNonEmptyString(field, itemPath),
    version: (field, itemPath) => assertNonEmptyString(field, itemPath),
    schemaHash: (field, itemPath) => assertHash(field, itemPath),
    interpreterHash: (field, itemPath) => assertHash(field, itemPath),
    ownerRef: (field, itemPath) => assertHash(field, itemPath),
  }, path));
}

/** Release-local declaration of one generated Family action owner.  This is
 * the Full-Family matrix denominator; actual exact/action execution remains
 * a separate Six-Step fact and is never synthesized here. */
export interface FullFamilyActionOwnerArtifactV1 {
  readonly schemaVersion: 1;
  readonly kind: "aloha.full-family-action-owner-artifact";
  readonly familyId: string;
  readonly familyDefinitionHash: Hash;
  readonly actionOwnerRef: Hash;
}

export function decodeFullFamilyActionOwnerArtifact(
  value: unknown,
  path = "fullFamilyActionOwnerArtifact",
): FullFamilyActionOwnerArtifactV1 {
  return deepFreeze(decodeExactObject(value, {
    schemaVersion: (field, itemPath) => field === 1 ? (1 as const) : (() => { throw new TypeError(`${itemPath} is invalid`); })(),
    kind: (field, itemPath) => field === "aloha.full-family-action-owner-artifact"
      ? ("aloha.full-family-action-owner-artifact" as const)
      : (() => { throw new TypeError(`${itemPath} is invalid`); })(),
    familyId: (field, itemPath) => {
      const familyId = assertNonEmptyString(field, itemPath);
      if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(familyId)) throw new TypeError(`${itemPath} is invalid`);
      return familyId;
    },
    familyDefinitionHash: (field, itemPath) => assertHash(field, itemPath),
    actionOwnerRef: (field, itemPath) => assertHash(field, itemPath),
  }, path));
}

export function encodeFullFamilyActionOwnerArtifact(
  value: FullFamilyActionOwnerArtifactV1,
): Uint8Array {
  return encodeCanonicalBytes(decodeFullFamilyActionOwnerArtifact(value));
}

export interface FullFamilySourcePlanRpcRequestV1 {
  readonly kind: "family-source-plan-rpc";
  readonly version: 1;
  readonly method: string;
  readonly params: CanonicalJson;
  readonly target: CanonicalJson;
  readonly manager: CanonicalJson;
  readonly topic: CanonicalJson;
  readonly lookback: CanonicalJson;
  readonly chunk: CanonicalJson;
}

export interface FullFamilySourcePlanPhysicalObservationV1 {
  readonly kind: "family-source-plan-physical-observation";
  readonly version: 1;
  readonly requestId: Hash;
  readonly releaseBindingId: Hash;
  readonly releaseProvenanceHash: Hash;
  readonly sourceAuthorityRoot: Hash;
  readonly sourceAnchorRoot: Hash;
  readonly provider: string;
  readonly backendEpoch: string;
  readonly familyDefinitionHash: Hash;
  readonly plan: SourcePlanRefV1;
  readonly cutoff: CanonicalCutoffV1;
  readonly requestSchemaHash: Hash;
  readonly request: FullFamilySourcePlanRpcRequestV1;
  readonly response: CanonicalJson;
}

function canonical(value: unknown): CanonicalJson {
  return deepFreeze(decodeCanonicalJson(encodeCanonicalJson(value)));
}

function decodeRpcRequest(value: unknown, path: string): FullFamilySourcePlanRpcRequestV1 {
  return deepFreeze(decodeExactObject(value, {
    kind: (field, itemPath) => field === "family-source-plan-rpc" ? ("family-source-plan-rpc" as const) : (() => { throw new TypeError(`${itemPath} is invalid`); })(),
    version: (field, itemPath) => field === 1 ? (1 as const) : (() => { throw new TypeError(`${itemPath} is invalid`); })(),
    method: (field, itemPath) => assertNonEmptyString(field, itemPath),
    params: field => canonical(field),
    target: field => canonical(field),
    manager: field => canonical(field),
    topic: field => canonical(field),
    lookback: field => canonical(field),
    chunk: field => canonical(field),
  }, path));
}

export function decodeFullFamilySourcePlanPhysicalObservation(
  value: unknown,
  path = "familySourcePlanPhysicalObservation",
): FullFamilySourcePlanPhysicalObservationV1 {
  return deepFreeze(decodeExactObject(value, {
    kind: (field, itemPath) => field === "family-source-plan-physical-observation" ? ("family-source-plan-physical-observation" as const) : (() => { throw new TypeError(`${itemPath} is invalid`); })(),
    version: (field, itemPath) => field === 1 ? (1 as const) : (() => { throw new TypeError(`${itemPath} is invalid`); })(),
    requestId: (field, itemPath) => assertHash(field, itemPath),
    releaseBindingId: (field, itemPath) => assertHash(field, itemPath),
    releaseProvenanceHash: (field, itemPath) => assertHash(field, itemPath),
    sourceAuthorityRoot: (field, itemPath) => assertHash(field, itemPath),
    sourceAnchorRoot: (field, itemPath) => assertHash(field, itemPath),
    provider: (field, itemPath) => assertNonEmptyString(field, itemPath),
    backendEpoch: (field, itemPath) => assertNonEmptyString(field, itemPath),
    familyDefinitionHash: (field, itemPath) => assertHash(field, itemPath),
    plan: (field, itemPath) => decodeFullFamilySourcePlanRef(field, itemPath),
    cutoff: (field, itemPath) => decodeFullFamilyCanonicalCutoff(field, itemPath),
    requestSchemaHash: (field, itemPath) => assertHash(field, itemPath),
    request: (field, itemPath) => decodeRpcRequest(field, itemPath),
    response: field => canonical(field),
  }, path));
}

export interface FullFamilyAssetIdentityV1 {
  readonly chainId: string;
  readonly kind: "native" | "erc20";
  readonly address: string | null;
}

export interface FullFamilyAssetPortV1 {
  readonly assetIdentity: FullFamilyAssetIdentityV1;
  readonly assetRef: Hash;
  readonly portRef: Hash;
  readonly ordinal: string;
}

export interface FullFamilyTransitionProjectionV1 {
  readonly inputAssetPorts: readonly FullFamilyAssetPortV1[];
  readonly outputAssetPorts: readonly FullFamilyAssetPortV1[];
  readonly opaqueTransitionRef: Hash;
  readonly constraintRefs: readonly Hash[];
  readonly staticProjectionHash: Hash;
  readonly projectionHash: Hash;
}

export interface FullFamilyInstancePublicationV1 {
  readonly familyId: string;
  readonly familyDefinitionHash: Hash;
  readonly familyCandidateKey: Hash;
  readonly instanceKey: string;
  readonly cutoff: CanonicalCutoffV1;
  readonly identityMemo: CanonicalJson;
  readonly identityMemoHash: Hash;
  readonly descriptorHash: Hash;
  readonly staticProjectionMemoHash: Hash;
  readonly requestedArtifactDependencyRoot: Hash;
  readonly validityDependencyRoot: Hash;
  readonly transitions: readonly FullFamilyTransitionProjectionV1[];
  readonly evidenceRoot: Hash;
  readonly instancePublicationHash: Hash;
}

function assetIdentity(value: unknown, path: string): FullFamilyAssetIdentityV1 {
  const decoded = decodeExactObject(value, {
    chainId: (field, itemPath) => assertDecimalString(field, itemPath),
    kind: (field, itemPath) => field === "native" || field === "erc20" ? field : (() => { throw new TypeError(`${itemPath} is invalid`); })(),
    address: field => field === null ? null : assertNonEmptyString(field, `${path}.address`),
  }, path);
  if (decoded.kind === "native" ? decoded.address !== null
    : typeof decoded.address !== "string" || !/^0x[0-9a-f]{40}$/.test(decoded.address)
      || decoded.address === "0x0000000000000000000000000000000000000000") throw new TypeError(`${path} is invalid`);
  return deepFreeze(decoded);
}

function assetPort(value: unknown, path: string): FullFamilyAssetPortV1 {
  const decoded = decodeExactObject(value, {
    assetIdentity: (field, itemPath) => assetIdentity(field, itemPath),
    assetRef: (field, itemPath) => assertHash(field, itemPath),
    portRef: (field, itemPath) => assertHash(field, itemPath),
    ordinal: (field, itemPath) => assertDecimalString(field, itemPath),
  }, path);
  if (decoded.assetRef !== hashDomain("aloha/asset-ref/v1", decoded.assetIdentity)) throw new TypeError(`${path}.assetRef mismatch`);
  return deepFreeze(decoded);
}

function transition(value: unknown, path: string, chainId: string): FullFamilyTransitionProjectionV1 {
  const decoded = decodeExactObject(value, {
    inputAssetPorts: (field, itemPath) => fieldArray(field, (entry, entryPath) => assetPort(entry, entryPath), itemPath),
    outputAssetPorts: (field, itemPath) => fieldArray(field, (entry, entryPath) => assetPort(entry, entryPath), itemPath),
    opaqueTransitionRef: (field, itemPath) => assertHash(field, itemPath),
    constraintRefs: (field, itemPath) => fieldArray(field, (entry, entryPath) => assertHash(entry, entryPath), itemPath),
    staticProjectionHash: (field, itemPath) => assertHash(field, itemPath),
    projectionHash: (field, itemPath) => assertHash(field, itemPath),
  }, path);
  if (decoded.inputAssetPorts.length === 0 || decoded.outputAssetPorts.length === 0
    || [...decoded.inputAssetPorts, ...decoded.outputAssetPorts].some(port => port.assetIdentity.chainId !== chainId)
    || new Set(decoded.constraintRefs).size !== decoded.constraintRefs.length
    || decoded.constraintRefs.some((ref, index) => index > 0 && decoded.constraintRefs[index - 1]! >= ref)) {
    throw new TypeError(`${path} partition invalid`);
  }
  const { projectionHash, ...payload } = decoded;
  if (projectionHash !== hashDomain("aloha/static-transition-projection/v1", payload)) throw new TypeError(`${path}.projectionHash mismatch`);
  return deepFreeze(decoded);
}

export function decodeFullFamilyInstancePublication(value: unknown, path = "instancePublication"): FullFamilyInstancePublicationV1 {
  const raw = decodeExactObject(value, {
    familyId: (field, itemPath) => assertNonEmptyString(field, itemPath),
    familyDefinitionHash: (field, itemPath) => assertHash(field, itemPath),
    familyCandidateKey: (field, itemPath) => assertHash(field, itemPath),
    instanceKey: (field, itemPath) => assertNonEmptyString(field, itemPath),
    cutoff: (field, itemPath) => decodeFullFamilyCanonicalCutoff(field, itemPath),
    identityMemo: field => canonical(field),
    identityMemoHash: (field, itemPath) => assertHash(field, itemPath),
    descriptorHash: (field, itemPath) => assertHash(field, itemPath),
    staticProjectionMemoHash: (field, itemPath) => assertHash(field, itemPath),
    requestedArtifactDependencyRoot: (field, itemPath) => assertHash(field, itemPath),
    validityDependencyRoot: (field, itemPath) => assertHash(field, itemPath),
    transitions: (field, itemPath) => {
      if (!Array.isArray(field)) throw new TypeError(`${itemPath} must be an array`);
      return field;
    },
    evidenceRoot: (field, itemPath) => assertHash(field, itemPath),
    instancePublicationHash: (field, itemPath) => assertHash(field, itemPath),
  }, path);
  const transitions = raw.transitions.map((entry, index) => transition(entry, `${path}.transitions[${index}]`, raw.cutoff.chainId));
  if (new Set(transitions.map(entry => entry.projectionHash)).size !== transitions.length
    || transitions.some((entry, index) => index > 0 && transitions[index - 1]!.projectionHash >= entry.projectionHash)) {
    throw new TypeError(`${path}.transitions must be unique canonical order`);
  }
  const payload = deepFreeze({ ...raw, transitions });
  const { instancePublicationHash, ...withoutHash } = payload;
  if (withoutHash.identityMemoHash !== hashDomain("aloha/identity-memo/v1", withoutHash.identityMemo)
    || instancePublicationHash !== hashDomain("aloha/instance-publication/v1", withoutHash)) {
    throw new TypeError(`${path} hash mismatch`);
  }
  return deepFreeze({ ...withoutHash, instancePublicationHash });
}

export interface FullFamilyInstanceCatalogV1 {
  readonly cutoff: CanonicalCutoffV1;
  readonly publications: readonly FullFamilyInstancePublicationV1[];
  readonly instanceCount: string;
  readonly instanceCatalogRoot: Hash;
}

export function sealFullFamilyInstanceCatalog(
  cutoffValue: CanonicalCutoffV1,
  publicationValues: readonly FullFamilyInstancePublicationV1[],
): FullFamilyInstanceCatalogV1 {
  const cutoff = decodeFullFamilyCanonicalCutoff(cutoffValue);
  const seen = new Set<string>();
  const publications = publicationValues.map((value, index) => {
    const publication = decodeFullFamilyInstancePublication(value, `instanceCatalog.publications[${index}]`);
    if (encodeCanonicalJson(publication.cutoff) !== encodeCanonicalJson(cutoff)) throw new TypeError("publication cutoff mismatch");
    const identity = `${publication.familyDefinitionHash}:${publication.instanceKey}`;
    if (seen.has(identity)) throw new TypeError("duplicate instance publication");
    seen.add(identity);
    return publication;
  }).sort((left, right) => left.instancePublicationHash.localeCompare(right.instancePublicationHash));
  const instanceCount = String(publications.length);
  return deepFreeze({
    cutoff,
    publications,
    instanceCount,
    instanceCatalogRoot: hashDomain("aloha/instance-catalog/v2", {
      cutoff,
      instanceCount,
      publicationSequenceRoot: hashCanonicalPartition(
        "aloha/instance-catalog-publication-sequence/v1",
        publications.map(value => value.instancePublicationHash),
        128,
      ),
    }),
  });
}

export interface FullFamilyPersistedGraphEdgeV1 {
  readonly edgeId: Hash;
  readonly inputAssetPorts: readonly FullFamilyAssetPortV1[];
  readonly outputAssetPorts: readonly FullFamilyAssetPortV1[];
  readonly opaqueTransitionRef: Hash;
  readonly constraintRefs: readonly Hash[];
  readonly owningFamilyId: string;
  readonly owningFamilyDefinitionHash: Hash;
  readonly owningInstanceKey: string;
  readonly instancePublicationHash: Hash;
  readonly staticProjectionHash: Hash;
  readonly projectionHash: Hash;
  readonly rehydrationRef: Readonly<{
    readonly familyDefinitionHash: Hash;
    readonly instanceKey: string;
    readonly instancePublicationHash: Hash;
    readonly staticProjectionMemoHash: Hash;
    readonly requestedArtifactDependencyRoot: Hash;
  }>;
}

export function decodeFullFamilyPersistedGraphEdge(value: unknown, path = "persistedGraphEdge"): FullFamilyPersistedGraphEdgeV1 {
  const decoded = decodeExactObject(value, {
    edgeId: (field, itemPath) => assertHash(field, itemPath),
    inputAssetPorts: (field, itemPath) => fieldArray(field, (entry, entryPath) => assetPort(entry, entryPath), itemPath),
    outputAssetPorts: (field, itemPath) => fieldArray(field, (entry, entryPath) => assetPort(entry, entryPath), itemPath),
    opaqueTransitionRef: (field, itemPath) => assertHash(field, itemPath),
    constraintRefs: (field, itemPath) => fieldArray(field, (entry, entryPath) => assertHash(entry, entryPath), itemPath),
    owningFamilyId: (field, itemPath) => assertNonEmptyString(field, itemPath),
    owningFamilyDefinitionHash: (field, itemPath) => assertHash(field, itemPath),
    owningInstanceKey: (field, itemPath) => assertNonEmptyString(field, itemPath),
    instancePublicationHash: (field, itemPath) => assertHash(field, itemPath),
    staticProjectionHash: (field, itemPath) => assertHash(field, itemPath),
    projectionHash: (field, itemPath) => assertHash(field, itemPath),
    rehydrationRef: (field, itemPath) => deepFreeze(decodeExactObject(field, {
      familyDefinitionHash: (entry, entryPath) => assertHash(entry, entryPath),
      instanceKey: (entry, entryPath) => assertNonEmptyString(entry, entryPath),
      instancePublicationHash: (entry, entryPath) => assertHash(entry, entryPath),
      staticProjectionMemoHash: (entry, entryPath) => assertHash(entry, entryPath),
      requestedArtifactDependencyRoot: (entry, entryPath) => assertHash(entry, entryPath),
    }, itemPath)),
  }, path);
  const { edgeId, ...payload } = decoded;
  if (decoded.inputAssetPorts.length === 0 || decoded.outputAssetPorts.length === 0
    || new Set(decoded.constraintRefs).size !== decoded.constraintRefs.length
    || decoded.constraintRefs.some((ref, index) => index > 0 && decoded.constraintRefs[index - 1]! >= ref)
    || decoded.rehydrationRef.familyDefinitionHash !== decoded.owningFamilyDefinitionHash
    || decoded.rehydrationRef.instanceKey !== decoded.owningInstanceKey
    || decoded.rehydrationRef.instancePublicationHash !== decoded.instancePublicationHash
    || edgeId !== hashDomain("aloha/persisted-graph-edge/v1", payload)) {
    throw new TypeError(`${path} lineage mismatch`);
  }
  return deepFreeze({ edgeId, ...payload });
}

export function buildFullFamilyPersistedGraph(catalog: FullFamilyInstanceCatalogV1) {
  const edges = catalog.publications.flatMap(publication => publication.transitions.map(projection => {
    const rehydrationRef = deepFreeze({
      familyDefinitionHash: publication.familyDefinitionHash,
      instanceKey: publication.instanceKey,
      instancePublicationHash: publication.instancePublicationHash,
      staticProjectionMemoHash: publication.staticProjectionMemoHash,
      requestedArtifactDependencyRoot: publication.requestedArtifactDependencyRoot,
    });
    const payload = deepFreeze({
      inputAssetPorts: projection.inputAssetPorts,
      outputAssetPorts: projection.outputAssetPorts,
      opaqueTransitionRef: projection.opaqueTransitionRef,
      constraintRefs: projection.constraintRefs,
      owningFamilyId: publication.familyId,
      owningFamilyDefinitionHash: publication.familyDefinitionHash,
      owningInstanceKey: publication.instanceKey,
      instancePublicationHash: publication.instancePublicationHash,
      staticProjectionHash: projection.staticProjectionHash,
      projectionHash: projection.projectionHash,
      rehydrationRef,
    });
    return deepFreeze({ edgeId: hashDomain("aloha/persisted-graph-edge/v1", payload), ...payload });
  })).sort((left, right) => left.edgeId.localeCompare(right.edgeId));
  if (new Set(edges.map(edge => edge.edgeId)).size !== edges.length) throw new TypeError("duplicate graph edge");
  const edgeCount = String(edges.length);
  return deepFreeze({
    cutoff: catalog.cutoff,
    instanceCatalogRoot: catalog.instanceCatalogRoot,
    edges,
    edgeCount,
    graphRoot: hashDomain("aloha/persisted-graph/v2", {
      cutoff: catalog.cutoff,
      instanceCatalogRoot: catalog.instanceCatalogRoot,
      edgeCount,
      edgeSequenceRoot: hashCanonicalPartition(
        "aloha/persisted-graph-edge-sequence/v1",
        edges.map(value => value.edgeId),
        128,
      ),
    }),
  });
}

export interface FullFamilySearchSourceV1 extends CanonicalCutoffV1 {}

export interface FullFamilySearchCoarseArtifactV1 {
  readonly kind: "coarse";
  readonly status: "rankable" | "unavailable";
  readonly source: FullFamilySearchSourceV1;
  readonly routeBindingHash: Hash;
  readonly objectiveRef: Hash;
  readonly amountHash: Hash;
  readonly payload: CanonicalJson;
  readonly payloadHash: Hash;
  readonly artifactHash: Hash;
  readonly projectionHash: Hash;
  readonly stateFactsRoot: Hash;
  readonly input: unknown;
  readonly output: unknown;
  readonly conservativeOutputUpperBound: string | null;
  readonly inputCapacityUpperBound: string | null;
  readonly rankKey: Hash | null;
  readonly reasonCode: string | null;
}

export function decodeFullFamilySearchSource(value: unknown, path = "source"): FullFamilySearchSourceV1 {
  assertExactKeys(value, ["chainId", "number", "hash", "stateRoot"], path);
  return decodeFullFamilyCanonicalCutoff(value, path);
}

export function fullFamilySearchPayloadHash(kind: "coarse", payload: CanonicalJson): Hash {
  return hashDomain("aloha/family-search-payload/v1", { kind, payload: canonical(payload) });
}

export function fullFamilySearchArtifactHash(input: Readonly<{
  readonly kind: "coarse";
  readonly source: FullFamilySearchSourceV1;
  readonly routeBindingHash: Hash;
  readonly objectiveRef: Hash | null;
  readonly amountHash: Hash | null;
  readonly payloadHash: Hash;
}>): Hash {
  return hashDomain("aloha/family-search-artifact/v1", {
    kind: input.kind,
    source: decodeFullFamilySearchSource(input.source),
    routeBindingHash: assertHash(input.routeBindingHash, "routeBindingHash"),
    objectiveRef: input.objectiveRef === null ? null : assertHash(input.objectiveRef, "objectiveRef"),
    amountHash: input.amountHash === null ? null : assertHash(input.amountHash, "amountHash"),
    payloadHash: assertHash(input.payloadHash, "payloadHash"),
  });
}
