import { hashDomain, type Hash } from "../../../packages/canonical-codec/src/index.ts";
import { hashProcessAnchor } from "../../../specs/core-envelope/src/index.ts";
import {
  deriveLegacyAuthorityClosureReceipt,
  hashRuntimeGraphViewLeaseObservations,
  sealLegacyAuthorityClosureFacts,
  sealLegacyClosureFact,
  sealLegacyClosureRawArtifact,
  sealLegacyClosureRawDenominator,
  sealLegacyClosureRawEdge,
  sealLegacyClosureRawEntrypoint,
  type LegacyAuthorityClosureFactsV1,
  type LegacyAuthorityClosureReceiptV1,
  type LegacyClosureRawArtifactV1,
  type LegacyClosureRawEdgeV1,
  type RuntimeRestartFactsV1,
} from "../../../specs/runtime-acceptance-facts/src/index.ts";
import {
  LEGACY_SHAPED_AUTHORITY_ZERO_CRITICAL_MUTATION_IDS,
  RUNTIME_RESTART_CRITICAL_MUTATION_IDS,
  SOURCE_REPOSITORY_PRODUCTION_CLOSURE_ZERO_CRITICAL_MUTATION_IDS,
} from "./spec.ts";

const MUTATION_HASH = hashDomain("aloha/runtime-acceptance/critical-mutation", "mutated") as Hash;
const MUTATION_SHA = "f".repeat(40);

function first<T>(values: readonly T[], name: string): T {
  const value = values[0];
  if (value === undefined) throw new Error(`fixture requires ${name}`);
  return value;
}

function patchRestart(input: RuntimeRestartFactsV1, patch: Partial<RuntimeRestartFactsV1>): RuntimeRestartFactsV1 {
  return { ...input, ...patch } as RuntimeRestartFactsV1;
}

function spliceLeaseObservation(input: RuntimeRestartFactsV1): RuntimeRestartFactsV1["graphReuse"] {
  const observations = input.graphReuse.graphViewLeaseObservations.map((item, index) => index === 0
    ? { ...item, graphRoot: MUTATION_HASH }
    : item);
  return {
    ...input.graphReuse,
    graphViewLeaseObservations: observations,
    graphViewLeaseRoot: hashRuntimeGraphViewLeaseObservations(observations),
  };
}

const restartDefinitions: Record<(typeof RUNTIME_RESTART_CRITICAL_MUTATION_IDS)[number], (input: RuntimeRestartFactsV1) => unknown> = {
  "process-anchor-before": input => patchRestart(input, { before: { ...input.before, processAnchorHash: MUTATION_HASH } }),
  "process-anchor-after": input => patchRestart(input, { after: { ...input.after, processAnchorHash: MUTATION_HASH } }),
  "same-exact-runtime-sha": input => patchRestart(input, { after: { ...input.after, runtimeCommitSha: MUTATION_SHA } }),
  "release-root-splice": input => patchRestart(input, { after: { ...input.after, releaseIntentRoot: MUTATION_HASH } }),
  "ready-root-splice": input => patchRestart(input, { after: { ...input.after, readyRecordHash: MUTATION_HASH } }),
  "graph-reuse-mode": input => patchRestart(input, { graphReuse: { ...input.graphReuse, mode: "fail-closed" } }),
  "graph-lease-root-splice": input => patchRestart(input, { graphReuse: { ...input.graphReuse, graphViewLeaseRoot: MUTATION_HASH } }),
  "graph-lease-field-splice": input => patchRestart(input, { graphReuse: spliceLeaseObservation(input) }),
  "graph-lease-missing": input => patchRestart(input, { graphReuse: { ...input.graphReuse, graphViewLeaseObservations: [], graphViewLeaseRoot: hashDomain("aloha/runtime-acceptance/graph-view-lease-observation-root/v1", []) } }),
  "graph-root-splice": input => {
    const graphReuse = spliceLeaseObservation(input);
    return patchRestart(input, {
      after: { ...input.after, graphRoot: MUTATION_HASH },
      graphReuse: { ...graphReuse, afterGraphRoot: MUTATION_HASH },
    });
  },
  "systemd-executable-splice": input => {
    const processAnchor = { ...input.after.processAnchor, executableHash: MUTATION_HASH };
    return patchRestart(input, {
      after: {
        ...input.after,
        processAnchor,
        processAnchorHash: hashProcessAnchor(processAnchor),
        executableHash: MUTATION_HASH,
        systemdExecStartHash: MUTATION_HASH,
      },
    });
  },
  "memo-reuse-accounting": input => patchRestart(input, { difference: { ...input.difference, memoReused: { ...input.difference.memoReused, items: input.difference.memoReused.items.map(item => ({ ...item, currentDependencyClosureRoot: MUTATION_HASH })) } } }),
  "new-candidate-accounting": input => patchRestart(input, { difference: { ...input.difference, newCandidates: { ...input.difference.newCandidates, items: [] } } }),
  "invalidated-dependency-accounting": input => patchRestart(input, { difference: { ...input.difference, invalidatedDependencyClosure: { ...input.difference.invalidatedDependencyClosure, items: input.difference.invalidatedDependencyClosure.items.map(item => ({ ...item, currentDependencyClosureRoot: item.previousDependencyClosureRoot })) } } }),
  "retryable-accounting": input => patchRestart(input, { difference: { ...input.difference, retryable: { ...input.difference.retryable, items: [] } } }),
  "rejection-not-reused-accounting": input => patchRestart(input, { difference: { ...input.difference, rejectionNotReused: { ...input.difference.rejectionNotReused, items: [] } } }),
  "unchanged-old-instance-attestation": input => patchRestart(input, { difference: { ...input.difference, unchangedOldInstanceAttestations: { ...input.difference.unchangedOldInstanceAttestations, items: [first(input.difference.memoReused.items, "memo item")] as never } } }),
  "single-target-probe": input => patchRestart(input, { singleTargetProbe: { ...input.singleTargetProbe, changedRunCandidateKeys: { ...input.singleTargetProbe.changedRunCandidateKeys, items: [first(input.singleTargetProbe.beforeOutcomes.items, "probe outcome").runCandidateKey, input.singleTargetProbe.targetRunCandidateKey] } as never } }),
  "sigterm-durable-outcomes": input => patchRestart(input, { sigtermRecovery: { ...input.sigtermRecovery, durableOutcomeRoot: MUTATION_HASH } }),
  "fact-ref-locator": input => patchRestart(input, { factRefs: input.factRefs.map((ref, index) => index === 0 ? { ...ref, locatorId: MUTATION_HASH } : ref) }),
  "fact-ref-content": input => patchRestart(input, { factRefs: input.factRefs.map((ref, index) => index === 0 ? { ...ref, contentSha256: MUTATION_HASH } : ref) }),
  "source-change-reuse": input => patchRestart(input, { after: { ...input.after, sourceAnchor: { ...input.after.sourceAnchor, hash: MUTATION_HASH } } }),
  "producer-verdict-injection": input => ({ ...input, producerVerdict: "pass" }),
};

export interface RuntimeRestartMutationDefinitionV1 {
  readonly id: (typeof RUNTIME_RESTART_CRITICAL_MUTATION_IDS)[number];
  readonly apply: (input: RuntimeRestartFactsV1) => unknown;
}
export interface RuntimeRestartMutationRunV1 {
  readonly id: RuntimeRestartMutationDefinitionV1["id"];
  readonly mutated: unknown;
}

export const RUNTIME_RESTART_MUTATION_REGISTRY: readonly RuntimeRestartMutationDefinitionV1[] = Object.freeze(
  RUNTIME_RESTART_CRITICAL_MUTATION_IDS.map(id => Object.freeze({ id, apply: restartDefinitions[id] })),
);

export function runRuntimeRestartMutationRegistry(input: RuntimeRestartFactsV1): readonly RuntimeRestartMutationRunV1[] {
  return Object.freeze(RUNTIME_RESTART_MUTATION_REGISTRY.map(definition => Object.freeze({ id: definition.id, mutated: definition.apply(input) })));
}

function rebuildLegacyReceipt(input: LegacyAuthorityClosureReceiptV1, patch: Partial<Omit<LegacyAuthorityClosureReceiptV1, "receiptId">>): LegacyAuthorityClosureReceiptV1 {
  const { receiptId: _receiptId, ...base } = input;
  const payload = { ...base, ...patch } as Omit<LegacyAuthorityClosureReceiptV1, "receiptId">;
  const receiptId = hashDomain("aloha/legacy-authority-closure/receipt/v1", payload);
  return { ...payload, receiptId };
}

function withReceipt(input: LegacyAuthorityClosureFactsV1, receipt: LegacyAuthorityClosureReceiptV1): unknown {
  const withoutEvidence = { ...input, receipt };
  const { evidenceId: _evidenceId, ...payload } = withoutEvidence;
  return { ...payload, evidenceId: hashDomain("aloha/legacy-authority-closure/facts/v1", payload) };
}

function forgedRoot(input: LegacyAuthorityClosureFactsV1, patch: Partial<Omit<LegacyAuthorityClosureReceiptV1, "receiptId">>): unknown {
  return withReceipt(input, rebuildLegacyReceipt(input.receipt, patch));
}

interface RebuiltGraphV1 {
  readonly artifacts: readonly LegacyClosureRawArtifactV1[];
  readonly denominator: LegacyAuthorityClosureFactsV1["denominator"];
}

function rebuildGraph(
  input: LegacyAuthorityClosureFactsV1,
  artifacts: readonly LegacyClosureRawArtifactV1[],
  mutateFirstEntrypointToUnresolved = false,
): RebuiltGraphV1 {
  const artifactMap = new Map(input.denominator.artifacts.map((artifact, index) => [artifact.artifactId, artifacts[index]!.artifactId]));
  const edges = input.denominator.edges.map((edge) => {
    const { edgeId: _edgeId, ...payload } = edge;
    return sealLegacyClosureRawEdge({
      ...payload,
      sourceArtifactId: artifactMap.get(edge.sourceArtifactId)!,
      targetArtifactId: edge.targetArtifactId === null ? null : artifactMap.get(edge.targetArtifactId)!,
    });
  });
  const edgeMap = new Map(input.denominator.edges.map((edge, index) => [edge.edgeId, edges[index]!.edgeId]));
  const entrypoints = input.denominator.entrypoints.map((entrypoint, index) => {
    const { entrypointId: _entrypointId, ...payload } = entrypoint;
    return sealLegacyClosureRawEntrypoint({
      ...payload,
      artifactId: mutateFirstEntrypointToUnresolved && index === 0 ? null : entrypoint.artifactId === null ? null : artifactMap.get(entrypoint.artifactId)!,
    });
  });
  const entrypointMap = new Map(input.denominator.entrypoints.map((entrypoint, index) => [entrypoint.entrypointId, entrypoints[index]!.entrypointId]));
  const closures = input.denominator.closures.map((closure) => {
    const { observedRoot: _observedRoot, ...payload } = closure;
    return sealLegacyClosureFact({
      ...payload,
      artifactIds: closure.artifactIds.map((id) => artifactMap.get(id)!),
      edgeIds: closure.edgeIds.map((id) => edgeMap.get(id)!),
      entrypointIds: closure.entrypointIds.map((id) => entrypointMap.get(id)!),
    });
  });
  return {
    artifacts,
    denominator: sealLegacyClosureRawDenominator({ artifacts, edges, entrypoints, closures }),
  };
}

function mutateArtifact(
  input: LegacyAuthorityClosureFactsV1,
  patch: Partial<Omit<LegacyClosureRawArtifactV1, "artifactId">>,
): LegacyAuthorityClosureFactsV1 {
  const current = first(input.denominator.artifacts, "raw artifact");
  const { artifactId: _artifactId, ...payload } = current;
  const replacement = sealLegacyClosureRawArtifact({ ...payload, ...patch });
  const rebuilt = rebuildGraph(input, input.denominator.artifacts.map((artifact, index) => index === 0 ? replacement : artifact));
  const receipt = deriveLegacyAuthorityClosureReceipt(input.receipt.predicateSpecDigests, input.receipt.qualificationCertificateIds, rebuilt.denominator);
  return sealLegacyAuthorityClosureFacts(receipt, input.factRefs, rebuilt.denominator);
}

function unresolvedEntrypoint(input: LegacyAuthorityClosureFactsV1): LegacyAuthorityClosureFactsV1 {
  const rebuilt = rebuildGraph(input, input.denominator.artifacts, true);
  const receipt = deriveLegacyAuthorityClosureReceipt(input.receipt.predicateSpecDigests, input.receipt.qualificationCertificateIds, rebuilt.denominator);
  return sealLegacyAuthorityClosureFacts(receipt, input.factRefs, rebuilt.denominator);
}

function rawReplacement(input: LegacyAuthorityClosureFactsV1): unknown {
  const current = first(input.denominator.artifacts, "raw artifact");
  const { artifactId: _artifactId, ...payload } = current;
  const replacement = sealLegacyClosureRawArtifact({ ...payload, contentSha256: MUTATION_HASH });
  const rebuilt = rebuildGraph(input, input.denominator.artifacts.map((artifact, index) => index === 0 ? replacement : artifact));
  const receipt = deriveLegacyAuthorityClosureReceipt(input.receipt.predicateSpecDigests, input.receipt.qualificationCertificateIds, rebuilt.denominator);
  const mutatedFacts = { ...input, receipt, denominator: rebuilt.denominator, closureFactsRoot: hashDomain("aloha/legacy-authority-closure/facts-root/v2", rebuilt.denominator.closures) };
  const { evidenceId: _evidenceId, ...withoutEvidence } = mutatedFacts;
  return { ...withoutEvidence, evidenceId: hashDomain("aloha/legacy-authority-closure/facts/v1", withoutEvidence) };
}

function logicalKind(artifact: LegacyClosureRawArtifactV1): string {
  return artifact.logicalKey.split("/")[2] ?? "";
}

function selfConsistentTopologyMutation(
  input: LegacyAuthorityClosureFactsV1,
  mutate: (edge: LegacyClosureRawEdgeV1, artifacts: ReadonlyMap<Hash, LegacyClosureRawArtifactV1>) => LegacyClosureRawEdgeV1 | null,
): LegacyAuthorityClosureFactsV1 {
  const artifacts = new Map(input.denominator.artifacts.map((artifact) => [artifact.artifactId, artifact]));
  const replacements = new Map<Hash, Hash | null>();
  const edges: LegacyClosureRawEdgeV1[] = [];
  for (const edge of input.denominator.edges) {
    const replacement = mutate(edge, artifacts);
    replacements.set(edge.edgeId, replacement?.edgeId ?? null);
    if (replacement !== null && !edges.some((item) => item.edgeId === replacement.edgeId)) edges.push(replacement);
  }
  const closures = input.denominator.closures.map((closure) => {
    const { observedRoot: _observedRoot, ...payload } = closure;
    return sealLegacyClosureFact({
      ...payload,
      edgeIds: closure.edgeIds.flatMap((id) => {
        const replacement = replacements.get(id);
        return replacement === null || replacement === undefined ? [] : [replacement];
      }),
    });
  });
  const denominator = sealLegacyClosureRawDenominator({ artifacts: input.denominator.artifacts, edges, entrypoints: input.denominator.entrypoints, closures });
  const receipt = deriveLegacyAuthorityClosureReceipt(input.receipt.predicateSpecDigests, input.receipt.qualificationCertificateIds, denominator);
  return sealLegacyAuthorityClosureFacts(receipt, input.factRefs, denominator);
}

function requiredLineageEdge(input: LegacyAuthorityClosureFactsV1): LegacyClosureRawEdgeV1 {
  const artifacts = new Map(input.denominator.artifacts.map((artifact) => [artifact.artifactId, artifact]));
  const edge = input.denominator.edges.find((item) => logicalKind(artifacts.get(item.sourceArtifactId)!) === "boundary"
    && item.targetArtifactId !== null && logicalKind(artifacts.get(item.targetArtifactId)!) === "runtime-release-binding"
    && item.relation === "binds");
  if (edge === undefined) throw new Error("fixture requires boundary-to-binding edge");
  return edge;
}

function lineageEdgeDeletion(input: LegacyAuthorityClosureFactsV1): LegacyAuthorityClosureFactsV1 {
  const selected = requiredLineageEdge(input);
  return selfConsistentTopologyMutation(input, (edge) => edge.edgeId === selected.edgeId ? null : edge);
}

function lineageEndpointReplacement(input: LegacyAuthorityClosureFactsV1): LegacyAuthorityClosureFactsV1 {
  const selected = requiredLineageEdge(input);
  return selfConsistentTopologyMutation(input, (edge, artifacts) => {
    if (edge.edgeId !== selected.edgeId) return edge;
    const replacement = [...artifacts.values()].find((artifact) => logicalKind(artifact) === "deployment-manifest");
    if (replacement === undefined) throw new Error("fixture requires deployment manifest");
    return sealLegacyClosureRawEdge({
      relation: edge.relation,
      sourceArtifactId: edge.sourceArtifactId,
      targetArtifactId: replacement.artifactId,
      targetLogicalKey: replacement.logicalKey,
      locatorId: edge.locatorId,
      locator: edge.locator,
    });
  });
}

function lineageDirectionSplice(input: LegacyAuthorityClosureFactsV1): LegacyAuthorityClosureFactsV1 {
  const selected = requiredLineageEdge(input);
  return selfConsistentTopologyMutation(input, (edge, artifacts) => {
    if (edge.edgeId !== selected.edgeId || edge.targetArtifactId === null) return edge;
    const source = artifacts.get(edge.sourceArtifactId)!;
    const target = artifacts.get(edge.targetArtifactId)!;
    return sealLegacyClosureRawEdge({
      relation: edge.relation,
      sourceArtifactId: target.artifactId,
      targetArtifactId: source.artifactId,
      targetLogicalKey: source.logicalKey,
      locatorId: edge.locatorId,
      locator: edge.locator,
    });
  });
}

function lineageOrphanEndpoint(input: LegacyAuthorityClosureFactsV1): LegacyAuthorityClosureFactsV1 {
  const log = input.denominator.artifacts.find((artifact) => logicalKind(artifact) === "runtime-log-window");
  if (log === undefined) throw new Error("fixture requires runtime log endpoint");
  return selfConsistentTopologyMutation(input, (edge) => edge.sourceArtifactId === log.artifactId || edge.targetArtifactId === log.artifactId ? null : edge);
}

function hiddenViolation(input: LegacyAuthorityClosureFactsV1, kind: "source" | "shaped"): unknown {
  const violated = kind === "source"
    ? mutateArtifact(input, { logicalKey: replaceLogicalNamespace(first(input.denominator.artifacts, "raw artifact").logicalKey, "reference", null) })
    : mutateArtifact(input, { logicalKey: replaceLogicalNamespace(first(input.denominator.artifacts, "raw artifact").logicalKey, null, "legacy-shaped-authority") });
  const receipt = kind === "source"
    ? rebuildLegacyReceipt(violated.receipt, { oldRepositoryLoadBearingRefs: [] })
    : rebuildLegacyReceipt(violated.receipt, { forbiddenAuthorityRefs: [] });
  return withReceipt(violated, receipt);
}

function replaceLogicalNamespace(value: string, origin: string | null, authorityShape: string | null): string {
  const segments = value.split("/");
  if (origin !== null) segments[0] = origin;
  if (authorityShape !== null) segments[1] = authorityShape;
  return segments.join("/");
}

const rootForgeries = {
  "release-intent-root": (input: LegacyAuthorityClosureFactsV1) => forgedRoot(input, { releaseIntentRoot: MUTATION_HASH }),
  "entrypoint-denominator": (input: LegacyAuthorityClosureFactsV1) => forgedRoot(input, { productionEntrypointDenominatorRoot: MUTATION_HASH }),
  "ts-js-ast-closure-root": (input: LegacyAuthorityClosureFactsV1) => forgedRoot(input, { tsJsAstModuleClosureRoot: MUTATION_HASH }),
  "generated-package-alias-root": (input: LegacyAuthorityClosureFactsV1) => forgedRoot(input, { generatedAndPackageAliasClosureRoot: MUTATION_HASH }),
  "worker-child-dynamic-entrypoint-root": (input: LegacyAuthorityClosureFactsV1) => forgedRoot(input, { workerChildDynamicEntrypointRoot: MUTATION_HASH }),
  "rust-binary-closure-root": (input: LegacyAuthorityClosureFactsV1) => forgedRoot(input, { rustBinaryClosureRoot: MUTATION_HASH }),
  "solidity-deployment-abi-root": (input: LegacyAuthorityClosureFactsV1) => forgedRoot(input, { solidityDeploymentAndAbiOwnershipRoot: MUTATION_HASH }),
  "deploy-systemd-exec-root": (input: LegacyAuthorityClosureFactsV1) => forgedRoot(input, { deployManifestAndSystemdExecRoot: MUTATION_HASH }),
  "executable-loaded-object-root": (input: LegacyAuthorityClosureFactsV1) => forgedRoot(input, { executableLoadedObjectRoot: MUTATION_HASH }),
  "consumer-object-lineage-root": (input: LegacyAuthorityClosureFactsV1) => forgedRoot(input, { consumerObjectLineageRoot: MUTATION_HASH }),
  "runtime-log-window-root": (input: LegacyAuthorityClosureFactsV1) => forgedRoot(input, { runtimeLogWindowRoot: MUTATION_HASH }),
} as const;

const sourceDefinitions: Record<(typeof SOURCE_REPOSITORY_PRODUCTION_CLOSURE_ZERO_CRITICAL_MUTATION_IDS)[number], (input: LegacyAuthorityClosureFactsV1) => unknown> = {
  ...rootForgeries,
  "consumer-lineage-edge-deletion": lineageEdgeDeletion,
  "consumer-lineage-endpoint-replacement": lineageEndpointReplacement,
  "consumer-lineage-direction-splice": lineageDirectionSplice,
  "consumer-lineage-orphan-endpoint": lineageOrphanEndpoint,
  "unresolved-entrypoint-ref": unresolvedEntrypoint,
  "old-repository-load-bearing-ref": input => mutateArtifact(input, { logicalKey: replaceLogicalNamespace(first(input.denominator.artifacts, "raw artifact").logicalKey, "reference", null) }),
  "raw-denominator-deletion": input => ({ ...input, denominator: { ...input.denominator, artifacts: input.denominator.artifacts.slice(1) } }),
  "raw-denominator-replacement": rawReplacement,
  "violation-hiding": input => hiddenViolation(input, "source"),
  "producer-verdict-injection": input => ({ ...input, producerVerdict: "pass" }),
};

const shapedDefinitions: Record<(typeof LEGACY_SHAPED_AUTHORITY_ZERO_CRITICAL_MUTATION_IDS)[number], (input: LegacyAuthorityClosureFactsV1) => unknown> = {
  ...rootForgeries,
  "consumer-lineage-edge-deletion": lineageEdgeDeletion,
  "consumer-lineage-endpoint-replacement": lineageEndpointReplacement,
  "consumer-lineage-direction-splice": lineageDirectionSplice,
  "consumer-lineage-orphan-endpoint": lineageOrphanEndpoint,
  "unresolved-entrypoint-ref": unresolvedEntrypoint,
  "forbidden-authority-ref": input => mutateArtifact(input, { logicalKey: replaceLogicalNamespace(first(input.denominator.artifacts, "raw artifact").logicalKey, null, "legacy-shaped-authority") }),
  "compatibility-facade-or-fallback-ref": input => mutateArtifact(input, { logicalKey: replaceLogicalNamespace(first(input.denominator.artifacts, "raw artifact").logicalKey, null, "compatibility-facade-or-fallback") }),
  "raw-denominator-deletion": sourceDefinitions["raw-denominator-deletion"],
  "raw-denominator-replacement": rawReplacement,
  "violation-hiding": input => hiddenViolation(input, "shaped"),
  "producer-verdict-injection": sourceDefinitions["producer-verdict-injection"],
};

export interface LegacyZeroMutationDefinitionV1 {
  readonly id: string;
  readonly apply: (input: LegacyAuthorityClosureFactsV1) => unknown;
}
export interface LegacyZeroMutationRunV1 {
  readonly id: string;
  readonly mutated: unknown;
}

export const SOURCE_REPOSITORY_PRODUCTION_CLOSURE_ZERO_MUTATION_REGISTRY: readonly LegacyZeroMutationDefinitionV1[] = Object.freeze(
  SOURCE_REPOSITORY_PRODUCTION_CLOSURE_ZERO_CRITICAL_MUTATION_IDS.map(id => Object.freeze({ id, apply: sourceDefinitions[id] })),
);
export const LEGACY_SHAPED_AUTHORITY_ZERO_MUTATION_REGISTRY: readonly LegacyZeroMutationDefinitionV1[] = Object.freeze(
  LEGACY_SHAPED_AUTHORITY_ZERO_CRITICAL_MUTATION_IDS.map(id => Object.freeze({ id, apply: shapedDefinitions[id] })),
);

export function runSourceRepositoryProductionClosureZeroMutationRegistry(input: LegacyAuthorityClosureFactsV1): readonly LegacyZeroMutationRunV1[] {
  return Object.freeze(SOURCE_REPOSITORY_PRODUCTION_CLOSURE_ZERO_MUTATION_REGISTRY.map(definition => Object.freeze({ id: definition.id, mutated: definition.apply(input) })));
}

export function runLegacyShapedAuthorityZeroMutationRegistry(input: LegacyAuthorityClosureFactsV1): readonly LegacyZeroMutationRunV1[] {
  return Object.freeze(LEGACY_SHAPED_AUTHORITY_ZERO_MUTATION_REGISTRY.map(definition => Object.freeze({ id: definition.id, mutated: definition.apply(input) })));
}
