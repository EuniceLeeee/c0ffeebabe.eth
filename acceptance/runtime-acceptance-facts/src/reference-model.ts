import {
  decodeLegacyAuthorityClosureFacts,
  decodeLegacyAuthorityZeroAggregateFacts,
  decodeRuntimeRestartFacts,
  LEGACY_CLOSURE_ROOT_ROLES,
  type LegacyAuthorityClosureFactsV1,
  type LegacyAuthorityClosureReceiptV1,
  type LegacyClosureRawArtifactV1,
  type LegacyClosureRawEdgeV1,
  type LegacyClosureRootRoleV1,
} from "../../../specs/runtime-acceptance-facts/src/index.ts";
import { encodeCanonicalJson, hashDomain, type Hash } from "../../../packages/canonical-codec/src/index.ts";
import { hashReadOnlyArtifactLocator, type ReadOnlyArtifactLocatorV1 } from "../../../specs/core-envelope/src/index.ts";
import {
  LEGACY_SHAPED_AUTHORITY_ZERO_PREDICATE_SPEC_DIGEST,
  SOURCE_REPOSITORY_PRODUCTION_CLOSURE_ZERO_PREDICATE_SPEC_DIGEST,
} from "./spec.ts";

export type RuntimeAcceptanceReferenceVerdict = "pass" | "fail" | "invalid";

export interface RuntimeRestartReferenceResultV1 {
  readonly verdict: RuntimeAcceptanceReferenceVerdict;
  readonly reasons: readonly string[];
}

export interface LegacyZeroReferenceResultV1 {
  readonly verdict: RuntimeAcceptanceReferenceVerdict;
  readonly reasons: readonly string[];
}

function one(reason: string, verdict: RuntimeAcceptanceReferenceVerdict = "invalid"): RuntimeRestartReferenceResultV1 {
  return Object.freeze({ verdict, reasons: Object.freeze([reason]) });
}

function restartSemanticError(message: string): string | null {
  if (message.includes("process anchor") || message.includes("process host") || message.includes("process/systemd") || message.includes("restart did not")) return "process-anchor-violation";
  if (message.includes("release root") || message.includes("runtime SHA")) return "release-root-violation";
  if (message.includes("graph reuse") || message.includes("source must") || message.includes("generation")) return "graph-reuse-violation";
  if (message.includes("delta") || message.includes("accounting") || message.includes("memo") || message.includes("retryable") || message.includes("rejection")) return "difference-accounting-violation";
  if (message.includes("single target")) return "single-target-violation";
  if (message.includes("SIGTERM") || message.includes("durable")) return "sigterm-durability-violation";
  return null;
}

function asOne(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  if (value.length !== 1) throw new TypeError("exactly one fact bundle");
  return value[0];
}

/**
 * Qualification-only reference model. It rechecks the observed joins rather
 * than importing the live predicate or using a producer verdict. The model
 * intentionally stays data-only: no runtime, process, or network calls.
 */
export function evaluateRuntimeRestartReferenceModel(value: unknown): RuntimeRestartReferenceResultV1 {
  try {
    const facts = decodeRuntimeRestartFacts(asOne(value) as object);
    const beforeKeys = new Set(facts.difference.previousCandidates.items.map((item) => item.runCandidateKey));
    const afterKeys = new Set(facts.difference.currentCandidates.items.map((item) => item.runCandidateKey));
    if (beforeKeys.size === 0 || afterKeys.size === 0) return one("empty-candidate-universe");
    if (facts.before.processAnchorHash === facts.after.processAnchorHash) return one("process-anchor-not-changed");
    if (facts.before.runtimeCommitSha !== facts.after.runtimeCommitSha) return one("runtime-sha-splice");
    if (facts.graphReuse.mode === "direct-reuse" && (facts.before.graphRoot !== facts.after.graphRoot || facts.before.readyRecordHash !== facts.after.readyRecordHash)) return one("graph-reuse-mismatch");
    if (facts.graphReuse.graphViewLeaseObservations.length === 0) return one("graph-lease-observation-missing");
    if (facts.graphReuse.graphViewLeaseRoot !== hashDomain("aloha/runtime-acceptance/graph-view-lease-observation-root/v1", facts.graphReuse.graphViewLeaseObservations)) return one("graph-lease-root-mismatch");
    for (const observation of facts.graphReuse.graphViewLeaseObservations) {
      if (observation.processAnchorHash !== facts.after.processAnchorHash
        || observation.pid !== facts.after.processAnchor.pid
        || observation.processStartTicks !== facts.after.processAnchor.processStartTicks
        || observation.generationId !== facts.after.generationId
        || observation.graphRoot !== facts.after.graphRoot
        || observation.readyRecordHash !== facts.after.readyRecordHash
        || observation.sourceCoverageRoot !== facts.after.sourceCoverageRoot) return one("graph-lease-anchor-mismatch");
    }
    if (facts.singleTargetProbe.changedRunCandidateKeys.items.length !== 1) return one("single-target-cardinality");
    if (facts.sigtermRecovery.flushedOutcomes.root !== facts.sigtermRecovery.afterRestartOutcomes.root) return one("sigterm-durable-root-mismatch");
    return Object.freeze({ verdict: "pass", reasons: Object.freeze([]) });
  } catch (error) {
    const message = error instanceof Error ? error.message : "malformed-fact";
    const semantic = restartSemanticError(message);
    return one(semantic ?? message, semantic === null ? "invalid" : "fail");
  }
}

function asFacts(value: unknown): LegacyAuthorityClosureFactsV1 {
  const candidate = asOne(value);
  if (candidate !== null && typeof candidate === "object" && !Array.isArray(candidate) && "aggregateId" in candidate) {
    return decodeLegacyAuthorityZeroAggregateFacts(candidate as object).facts;
  }
  return decodeLegacyAuthorityClosureFacts(candidate as object);
}

const referenceRootField: Readonly<Record<LegacyClosureRootRoleV1, keyof LegacyAuthorityClosureReceiptV1>> = Object.freeze({
  "consumer-object-lineage": "consumerObjectLineageRoot",
  "deploy-manifest-systemd-exec": "deployManifestAndSystemdExecRoot",
  "executable-loaded-object": "executableLoadedObjectRoot",
  "generated-package-alias-closure": "generatedAndPackageAliasClosureRoot",
  "production-entrypoint-denominator": "productionEntrypointDenominatorRoot",
  "release-intent": "releaseIntentRoot",
  "runtime-log-window": "runtimeLogWindowRoot",
  "rust-binary-closure": "rustBinaryClosureRoot",
  "solidity-deployment-abi-ownership": "solidityDeploymentAndAbiOwnershipRoot",
  "ts-js-ast-module-closure": "tsJsAstModuleClosureRoot",
  "worker-child-dynamic-entrypoint": "workerChildDynamicEntrypointRoot",
});

function canonicalEqual(left: unknown, right: unknown): boolean {
  return encodeCanonicalJson(left) === encodeCanonicalJson(right);
}

function locatorSet(items: readonly ReadOnlyArtifactLocatorV1[]): readonly ReadOnlyArtifactLocatorV1[] {
  const indexed = new Map(items.map((item) => [hashReadOnlyArtifactLocator(item), item]));
  return [...indexed].sort(([left], [right]) => left.localeCompare(right)).map(([, locator]) => locator);
}

interface ReferenceLegacyDerivationV1 {
  readonly unresolved: readonly ReadOnlyArtifactLocatorV1[];
  readonly oldRepository: readonly ReadOnlyArtifactLocatorV1[];
  readonly forbidden: readonly ReadOnlyArtifactLocatorV1[];
  readonly fallback: readonly ReadOnlyArtifactLocatorV1[];
}

function independentlyCheckConsumerGraph(facts: LegacyAuthorityClosureFactsV1): void {
  const role = facts.denominator.closures.filter((item) => item.role === "consumer-object-lineage");
  if (role.length !== 1) throw new TypeError("consumer lineage role is not unique");
  const selected = role[0]!;
  const artifactIndex = new Map<Hash, LegacyClosureRawArtifactV1>(facts.denominator.artifacts.map((item) => [item.artifactId, item]));
  const selectedArtifacts = new Set<Hash>(selected.artifactIds);
  const selectedEdges = new Map<Hash, LegacyClosureRawEdgeV1>(facts.denominator.edges.filter((item) => selected.edgeIds.includes(item.edgeId)).map((item) => [item.edgeId, item]));
  if (selectedEdges.size !== selected.edgeIds.length) throw new TypeError("consumer lineage edge set is incomplete");
  for (const edge of selectedEdges.values()) {
    if (edge.targetArtifactId === null || !selectedArtifacts.has(edge.sourceArtifactId) || !selectedArtifacts.has(edge.targetArtifactId)) {
      throw new TypeError("consumer lineage edge escapes its role denominator");
    }
  }
  const kindOf = (artifact: LegacyClosureRawArtifactV1): string => {
    const parts = artifact.logicalKey.split("/");
    if (parts.length < 4) throw new TypeError("consumer lineage logical key is malformed");
    return parts[2]!;
  };
  const byKind = new Map<string, LegacyClosureRawArtifactV1[]>();
  for (const id of selected.artifactIds) {
    const artifact = artifactIndex.get(id);
    if (artifact === undefined) throw new TypeError("consumer lineage artifact is absent");
    const values = byKind.get(kindOf(artifact)) ?? [];
    values.push(artifact);
    byKind.set(kindOf(artifact), values);
  }
  const exactly = (kind: string): LegacyClosureRawArtifactV1 => {
    const values = byKind.get(kind) ?? [];
    if (values.length !== 1) throw new TypeError(`consumer lineage endpoint is not unique:${kind}`);
    return values[0]!;
  };
  const consumerEntrypoints = selected.entrypointIds.map((id) => facts.denominator.entrypoints.find((item) => item.entrypointId === id))
    .filter((item) => item?.entrypointKind === "consumer");
  if (consumerEntrypoints.length !== 1 || consumerEntrypoints[0]!.artifactId === null
    || !selectedArtifacts.has(consumerEntrypoints[0]!.artifactId)) throw new TypeError("consumer lineage entrypoint is not exact");
  const ready = artifactIndex.get(consumerEntrypoints[0]!.artifactId)!;
  if (!ready.logicalKey.split("/").slice(2).join("/").startsWith("runtime-event/aloha.runtime-process-ready-")) throw new TypeError("consumer lineage entrypoint is not a ready event");

  const edgeExists = (from: LegacyClosureRawArtifactV1, relation: LegacyClosureRawEdgeV1["relation"], to: LegacyClosureRawArtifactV1): boolean =>
    [...selectedEdges.values()].some((edge) => edge.sourceArtifactId === from.artifactId && edge.targetArtifactId === to.artifactId && edge.relation === relation);
  const boundary = exactly("boundary");
  const binding = exactly("runtime-release-binding");
  const approval = exactly("release-authority-approval");
  const manifest = exactly("deployment-manifest");
  const bundle = exactly("runtime-bundle");
  const composition = exactly("deployment-composition");
  const sourceConfig = exactly("deployment-source");
  const runtimePolicy = exactly("runtime-policy");
  const executorState = exactly("executor-state");
  const releaseIntent = exactly("release-intent");
  const candidateProof = exactly("candidate-proof-verifier");
  const releaseEnvironment = exactly("release-environment");
  const unit = exactly("systemd-unit");
  const database = exactly("runtime-sqlite");
  const main = exactly("main-executable");
  const log = exactly("runtime-log-window");
  const required: readonly [LegacyClosureRawArtifactV1, LegacyClosureRawEdgeV1["relation"], LegacyClosureRawArtifactV1][] = [
    [boundary, "binds", binding], [binding, "binds", approval], [approval, "binds", manifest],
    [manifest, "binds", bundle], [manifest, "binds", composition], [manifest, "binds", sourceConfig],
    [manifest, "binds", runtimePolicy], [manifest, "binds", executorState], [manifest, "binds", releaseIntent],
    [manifest, "binds", candidateProof], [manifest, "binds", releaseEnvironment], [manifest, "deploys", unit], [unit, "executes", main],
    [database, "emits", ready], [ready, "binds", main], [ready, "binds", bundle], [ready, "emits", log],
  ];
  if (required.some(([from, relation, to]) => !edgeExists(from, relation, to))) throw new TypeError("consumer lineage required chain is broken");
  const children = byKind.get("child-executable") ?? [];
  const loaded = byKind.get("loaded-object") ?? [];
  if (children.length === 0 || loaded.length === 0) throw new TypeError("consumer runtime topology is incomplete");
  const executableIds = new Set([main, ...children].map((item) => item.artifactId));
  const spawned = new Set<Hash>();
  const parents = [main.artifactId];
  while (parents.length !== 0) {
    const parent = parents.pop()!;
    for (const edge of selectedEdges.values()) {
      if (edge.relation === "spawns" && edge.sourceArtifactId === parent && edge.targetArtifactId !== null
        && executableIds.has(edge.targetArtifactId) && !spawned.has(edge.targetArtifactId)) {
        spawned.add(edge.targetArtifactId);
        parents.push(edge.targetArtifactId);
      }
    }
  }
  if (children.some((child) => !spawned.has(child.artifactId))) throw new TypeError("consumer child is not spawned by main");
  if (loaded.some((object) => ![main, ...children].some((executable) => edgeExists(executable, "loads", object)))) throw new TypeError("consumer loaded object has no executable owner");
  if ([main, ...children].some((executable) => !loaded.some((object) => edgeExists(executable, "loads", object)))) throw new TypeError("consumer executable has no loaded object");

  const neighbors = new Map<Hash, Hash[]>(selected.artifactIds.map((id) => [id, []]));
  for (const edge of selectedEdges.values()) {
    neighbors.get(edge.sourceArtifactId)!.push(edge.targetArtifactId!);
    neighbors.get(edge.targetArtifactId!)!.push(edge.sourceArtifactId);
  }
  const reached = new Set<Hash>();
  const frontier = [ready.artifactId];
  while (frontier.length !== 0) {
    const id = frontier.pop()!;
    if (reached.has(id)) continue;
    reached.add(id);
    frontier.push(...neighbors.get(id)!);
  }
  if (reached.size !== selectedArtifacts.size) throw new TypeError("consumer lineage has an isolated artifact");
}

export interface LegacyQualificationBindingReferenceV1 {
  readonly predicateId: string;
  readonly predicateSpecDigest: Hash;
  readonly verifierQualificationId: Hash;
}

/** Qualification-only cross-check of the receipt pair against the signed V3
 * release requirement projection. This is deliberately separate from the
 * GateCore adapter implementation. */
export function evaluateLegacyQualificationPairReferenceModel(
  value: unknown,
  bindings: readonly LegacyQualificationBindingReferenceV1[],
): LegacyZeroReferenceResultV1 {
  try {
    const facts = asFacts(value);
    const orderedPredicateIds = [
      "aloha.source-repository-production-closure-zero",
      "aloha.legacy-shaped-authority-zero",
    ] as const;
    const selected = orderedPredicateIds.map(predicateId => {
      const matches = bindings.filter(binding => binding.predicateId === predicateId);
      if (matches.length !== 1) throw new TypeError(`qualification requirement is not exact:${predicateId}`);
      return matches[0]!;
    });
    const expectedSpecDigests = [
      SOURCE_REPOSITORY_PRODUCTION_CLOSURE_ZERO_PREDICATE_SPEC_DIGEST,
      LEGACY_SHAPED_AUTHORITY_ZERO_PREDICATE_SPEC_DIGEST,
    ];
    if (!canonicalEqual(facts.receipt.predicateSpecDigests, expectedSpecDigests)
      || !canonicalEqual(facts.receipt.predicateSpecDigests, selected.map(binding => binding.predicateSpecDigest))
      || !canonicalEqual(facts.receipt.qualificationCertificateIds, selected.map(binding => binding.verifierQualificationId))) {
      throw new TypeError("ordered qualification pair mismatch");
    }
    return Object.freeze({ verdict: "pass", reasons: Object.freeze([]) });
  } catch (error) {
    return Object.freeze({ verdict: "invalid", reasons: Object.freeze([error instanceof Error ? error.message : "malformed-fact"]) });
  }
}

/** Qualification-only algorithm, intentionally separate from the live implementation. */
function independentlyDeriveLegacy(facts: LegacyAuthorityClosureFactsV1): ReferenceLegacyDerivationV1 {
  const artifactIds = facts.denominator.artifacts.map((artifact) => {
    const { artifactId: _artifactId, ...payload } = artifact;
    const expected = hashDomain("aloha/legacy-authority-closure/raw-artifact/v1", payload);
    if (artifact.artifactId !== expected) throw new TypeError("artifact identity mismatch");
    return expected;
  });
  const edgeIds = facts.denominator.edges.map((edge) => {
    const { edgeId: _edgeId, ...payload } = edge;
    const expected = hashDomain("aloha/legacy-authority-closure/raw-edge/v1", payload);
    if (edge.edgeId !== expected) throw new TypeError("edge identity mismatch");
    return expected;
  });
  const entrypointIds = facts.denominator.entrypoints.map((entrypoint) => {
    const { entrypointId: _entrypointId, ...payload } = entrypoint;
    const expected = hashDomain("aloha/legacy-authority-closure/raw-entrypoint/v1", payload);
    if (entrypoint.entrypointId !== expected) throw new TypeError("entrypoint identity mismatch");
    return expected;
  });
  const computedRoots = new Map<LegacyClosureRootRoleV1, Hash>();
  for (const closure of facts.denominator.closures) {
    const expected = hashDomain("aloha/legacy-authority-closure/role-root/v2", {
      role: closure.role,
      entrypointIds: closure.entrypointIds,
      artifactIds: closure.artifactIds,
      edgeIds: closure.edgeIds,
    });
    if (closure.observedRoot !== expected) throw new TypeError("role root mismatch");
    computedRoots.set(closure.role, expected);
  }
  for (const role of LEGACY_CLOSURE_ROOT_ROLES) if (computedRoots.get(role) !== facts.receipt[referenceRootField[role]]) throw new TypeError(`receipt root mismatch:${role}`);
  const all = facts.denominator.closures.find((closure) => closure.role === "production-entrypoint-denominator");
  if (all === undefined || !canonicalEqual(all.artifactIds, artifactIds) || !canonicalEqual(all.edgeIds, edgeIds) || !canonicalEqual(all.entrypointIds, entrypointIds)) throw new TypeError("entrypoint denominator mismatch");
  const denominatorPayload = {
    artifacts: facts.denominator.artifacts,
    edges: facts.denominator.edges,
    entrypoints: facts.denominator.entrypoints,
    closures: facts.denominator.closures.map((closure) => {
      const { factRefId: _factRefId, ...payload } = closure;
      return payload;
    }),
  };
  const rawRoot = hashDomain("aloha/legacy-authority-closure/raw-denominator/v1", denominatorPayload);
  if (facts.denominator.denominatorId !== rawRoot || facts.receipt.rawDenominatorRoot !== rawRoot) throw new TypeError("raw denominator root mismatch");
  const unresolved = locatorSet([
    ...facts.denominator.entrypoints.filter(({ artifactId }) => artifactId === null).map(({ locator }) => locator),
    ...facts.denominator.edges.filter(({ targetArtifactId }) => targetArtifactId === null).map(({ locator }) => locator),
  ]);
  const oldRepository = locatorSet(facts.denominator.artifacts.filter(({ logicalKey }) => logicalKey.split("/")[0] === "reference").map(({ locator }) => locator));
  const forbidden = locatorSet(facts.denominator.artifacts.filter(({ logicalKey }) => logicalKey.split("/")[1] === "legacy-shaped-authority").map(({ locator }) => locator));
  const fallback = locatorSet(facts.denominator.artifacts.filter(({ logicalKey }) => logicalKey.split("/")[1] === "compatibility-facade-or-fallback").map(({ locator }) => locator));
  if (!canonicalEqual(unresolved, facts.receipt.unresolvedEntrypointRefs) || !canonicalEqual(oldRepository, facts.receipt.oldRepositoryLoadBearingRefs) || !canonicalEqual(forbidden, facts.receipt.forbiddenAuthorityRefs) || !canonicalEqual(fallback, facts.receipt.compatibilityFacadeOrFallbackRefs)) throw new TypeError("derived locator mismatch");
  independentlyCheckConsumerGraph(facts);
  return Object.freeze({ unresolved, oldRepository, forbidden, fallback });
}

export function evaluateSourceRepositoryProductionClosureReferenceModel(value: unknown): LegacyZeroReferenceResultV1 {
  try {
    const derived = independentlyDeriveLegacy(asFacts(value));
    if (derived.unresolved.length !== 0) return Object.freeze({ verdict: "invalid", reasons: Object.freeze(["unresolved-entrypoint-ref"]) });
    if (derived.oldRepository.length !== 0) return Object.freeze({ verdict: "fail", reasons: Object.freeze(["old-repository-load-bearing-ref"]) });
    return Object.freeze({ verdict: "pass", reasons: Object.freeze([]) });
  } catch (error) {
    return Object.freeze({ verdict: "invalid", reasons: Object.freeze([error instanceof Error ? error.message : "malformed-fact"]) });
  }
}

export function evaluateLegacyShapedAuthorityReferenceModel(value: unknown): LegacyZeroReferenceResultV1 {
  try {
    const derived = independentlyDeriveLegacy(asFacts(value));
    if (derived.unresolved.length !== 0) return Object.freeze({ verdict: "invalid", reasons: Object.freeze(["unresolved-entrypoint-ref"]) });
    if (derived.forbidden.length !== 0 || derived.fallback.length !== 0) return Object.freeze({ verdict: "fail", reasons: Object.freeze(["legacy-shaped-authority-ref"]) });
    return Object.freeze({ verdict: "pass", reasons: Object.freeze([]) });
  } catch (error) {
    return Object.freeze({ verdict: "invalid", reasons: Object.freeze([error instanceof Error ? error.message : "malformed-fact"]) });
  }
}

export function evaluateLegacyAuthorityZeroReferenceModel(value: unknown): LegacyZeroReferenceResultV1 {
  try {
    const facts = decodeLegacyAuthorityZeroAggregateFacts(asOne(value) as object);
    const source = evaluateSourceRepositoryProductionClosureReferenceModel(facts.facts);
    const shaped = evaluateLegacyShapedAuthorityReferenceModel(facts.facts);
    if (source.verdict === "invalid" || shaped.verdict === "invalid") return Object.freeze({ verdict: "invalid", reasons: Object.freeze([...source.reasons, ...shaped.reasons]) });
    if (source.verdict === "fail" || shaped.verdict === "fail") return Object.freeze({ verdict: "fail", reasons: Object.freeze([...source.reasons, ...shaped.reasons]) });
    return Object.freeze({ verdict: "pass", reasons: Object.freeze([]) });
  } catch (error) {
    return Object.freeze({ verdict: "invalid", reasons: Object.freeze([error instanceof Error ? error.message : "malformed-fact"]) });
  }
}
