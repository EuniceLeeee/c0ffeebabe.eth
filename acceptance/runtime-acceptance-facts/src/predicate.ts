import {
  decodeLegacyAuthorityClosureFacts,
  decodeLegacyAuthorityZeroAggregateFacts,
  decodeRuntimeRestartFacts,
  LEGACY_CLOSURE_ROOT_ROLES,
  type LegacyAuthorityClosureFactsV1,
  type LegacyAuthorityClosureReceiptV1,
  type LegacyAuthorityZeroAggregateFactsV1,
  type LegacyClosureRawArtifactV1,
  type LegacyClosureRawEdgeV1,
  type LegacyClosureRawEntrypointV1,
  type LegacyClosureRootRoleV1,
  type RuntimeRestartFactsV1,
} from "../../../specs/runtime-acceptance-facts/src/index.ts";
import { encodeCanonicalJson, hashDomain, type Hash } from "../../../packages/canonical-codec/src/index.ts";
import { hashReadOnlyArtifactLocator, type ReadOnlyArtifactLocatorV1 } from "../../../specs/core-envelope/src/index.ts";

export type RuntimeAcceptancePredicateVerdict = "pass" | "fail" | "invalid";

export type RuntimeAcceptanceReasonCode =
  | "malformed-fact"
  | "content-addressed-fact-missing"
  | "process-anchor-violation"
  | "release-root-violation"
  | "graph-reuse-violation"
  | "difference-accounting-violation"
  | "single-target-violation"
  | "sigterm-durability-violation"
  | "source-repository-violation"
  | "legacy-shaped-authority-violation"
  | "aggregate-mismatch";

export interface RuntimeAcceptanceReasonV1 {
  readonly code: RuntimeAcceptanceReasonCode;
  readonly path: string;
}

export interface RuntimeRestartPredicateResultV1 {
  readonly verdict: RuntimeAcceptancePredicateVerdict;
  readonly reasons: readonly RuntimeAcceptanceReasonV1[];
  readonly facts: RuntimeRestartFactsV1 | null;
}

export interface LegacyZeroPredicateResultV1 {
  readonly predicateId: "aloha.source-repository-production-closure-zero" | "aloha.legacy-shaped-authority-zero";
  readonly verdict: RuntimeAcceptancePredicateVerdict;
  readonly reasons: readonly RuntimeAcceptanceReasonV1[];
  readonly receipt: LegacyAuthorityClosureReceiptV1 | null;
}

export interface LegacyZeroAggregateResultV1 {
  readonly verdict: RuntimeAcceptancePredicateVerdict;
  readonly reasons: readonly RuntimeAcceptanceReasonV1[];
  readonly facts: LegacyAuthorityZeroAggregateFactsV1 | null;
  readonly source: LegacyZeroPredicateResultV1;
  readonly shaped: LegacyZeroPredicateResultV1;
}

function one(code: RuntimeAcceptanceReasonCode, path: string): readonly RuntimeAcceptanceReasonV1[] {
  return Object.freeze([{ code, path }]);
}

function asOne(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  if (value.length !== 1) throw new TypeError("exactly one runtime fact bundle is required");
  return value[0];
}

function semanticRestartReason(message: string): RuntimeAcceptanceReasonCode | null {
  if (message.includes("process anchor") || message.includes("process host") || message.includes("process/systemd") || message.includes("restart did not")) return "process-anchor-violation";
  if (message.includes("release root") || message.includes("runtime SHA")) return "release-root-violation";
  if (message.includes("graph reuse") || message.includes("source must") || message.includes("generation")) return "graph-reuse-violation";
  if (message.includes("delta") || message.includes("accounting") || message.includes("memo") || message.includes("retryable") || message.includes("rejection")) return "difference-accounting-violation";
  if (message.includes("single target")) return "single-target-violation";
  if (message.includes("SIGTERM") || message.includes("durable")) return "sigterm-durability-violation";
  return null;
}

/**
 * Live restart acceptance. The schema decoder supplies structural and
 * content-address identity checks; semantic violations are deliberately
 * reported as fail, while missing/unknown/malformed input remains invalid.
 */
export function evaluateRuntimeRestartPredicate(value: unknown): RuntimeRestartPredicateResultV1 {
  try {
    const facts = decodeRuntimeRestartFacts(asOne(value) as object);
    return Object.freeze({ verdict: "pass", reasons: Object.freeze([]), facts });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const semantic = semanticRestartReason(message);
    return Object.freeze({
      verdict: semantic === null ? "invalid" : "fail",
      reasons: one(semantic ?? (message.includes("fact ref") ? "content-addressed-fact-missing" : "malformed-fact"), "$.predicateFacts"),
      facts: null,
    });
  }
}

const rootFieldByRole: Readonly<Record<LegacyClosureRootRoleV1, keyof LegacyAuthorityClosureReceiptV1>> = Object.freeze({
  "release-intent": "releaseIntentRoot",
  "production-entrypoint-denominator": "productionEntrypointDenominatorRoot",
  "ts-js-ast-module-closure": "tsJsAstModuleClosureRoot",
  "generated-package-alias-closure": "generatedAndPackageAliasClosureRoot",
  "worker-child-dynamic-entrypoint": "workerChildDynamicEntrypointRoot",
  "rust-binary-closure": "rustBinaryClosureRoot",
  "solidity-deployment-abi-ownership": "solidityDeploymentAndAbiOwnershipRoot",
  "deploy-manifest-systemd-exec": "deployManifestAndSystemdExecRoot",
  "executable-loaded-object": "executableLoadedObjectRoot",
  "consumer-object-lineage": "consumerObjectLineageRoot",
  "runtime-log-window": "runtimeLogWindowRoot",
});

function rawArtifactId(value: LegacyClosureRawArtifactV1): Hash {
  const { artifactId: _artifactId, ...payload } = value;
  return hashDomain("aloha/legacy-authority-closure/raw-artifact/v1", payload);
}

function rawEdgeId(value: LegacyClosureRawEdgeV1): Hash {
  const { edgeId: _edgeId, ...payload } = value;
  return hashDomain("aloha/legacy-authority-closure/raw-edge/v1", payload);
}

function rawEntrypointId(value: LegacyClosureRawEntrypointV1): Hash {
  const { entrypointId: _entrypointId, ...payload } = value;
  return hashDomain("aloha/legacy-authority-closure/raw-entrypoint/v1", payload);
}

function sortedLocators(values: readonly ReadOnlyArtifactLocatorV1[]): readonly ReadOnlyArtifactLocatorV1[] {
  const byId = new Map<Hash, ReadOnlyArtifactLocatorV1>();
  for (const value of values) byId.set(hashReadOnlyArtifactLocator(value), value);
  return [...byId.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([, value]) => value);
}

function same(left: unknown, right: unknown): boolean {
  return encodeCanonicalJson(left) === encodeCanonicalJson(right);
}

interface LiveLegacyRecomputationV1 {
  readonly unresolved: readonly ReadOnlyArtifactLocatorV1[];
  readonly oldRepository: readonly ReadOnlyArtifactLocatorV1[];
  readonly forbiddenAuthority: readonly ReadOnlyArtifactLocatorV1[];
  readonly compatibility: readonly ReadOnlyArtifactLocatorV1[];
}

function artifactKind(value: LegacyClosureRawArtifactV1): string {
  const segments = value.logicalKey.split("/");
  if (segments.length < 4) throw new TypeError("consumer-lineage-artifact-key-mismatch");
  return segments[2]!;
}

function assertConnectedConsumerLineage(facts: LegacyAuthorityClosureFactsV1): void {
  const closure = facts.denominator.closures.find((item) => item.role === "consumer-object-lineage");
  if (closure === undefined) throw new TypeError("consumer-lineage-role-missing");
  const artifactById = new Map(facts.denominator.artifacts.map((item) => [item.artifactId, item]));
  const roleArtifacts = new Set(closure.artifactIds);
  const roleEdges = closure.edgeIds.map((id) => {
    const edge = facts.denominator.edges.find((item) => item.edgeId === id);
    if (edge === undefined || edge.targetArtifactId === null
      || !roleArtifacts.has(edge.sourceArtifactId) || !roleArtifacts.has(edge.targetArtifactId)) {
      throw new TypeError("consumer-lineage-edge-endpoint-mismatch");
    }
    return edge;
  });
  const roleEntrypoints = closure.entrypointIds.map((id) => {
    const entrypoint = facts.denominator.entrypoints.find((item) => item.entrypointId === id);
    if (entrypoint === undefined || entrypoint.artifactId === null || !roleArtifacts.has(entrypoint.artifactId)) {
      throw new TypeError("consumer-lineage-entrypoint-mismatch");
    }
    return entrypoint;
  });
  const consumers = roleEntrypoints.filter((item) => item.entrypointKind === "consumer");
  if (consumers.length !== 1 || consumers[0]!.artifactId === null
    || !artifactById.get(consumers[0]!.artifactId)!.logicalKey.split("/").slice(2).join("/").startsWith("runtime-event/aloha.runtime-process-ready-")) {
    throw new TypeError("consumer-lineage-ready-entrypoint-mismatch");
  }

  const unique = (kind: string): LegacyClosureRawArtifactV1 => {
    const matches = closure.artifactIds.map((id) => artifactById.get(id)!).filter((item) => artifactKind(item) === kind);
    if (matches.length !== 1) throw new TypeError(`consumer-lineage-required-endpoint-mismatch:${kind}`);
    return matches[0]!;
  };
  const boundary = unique("boundary");
  const binding = unique("runtime-release-binding");
  const approval = unique("release-authority-approval");
  const manifest = unique("deployment-manifest");
  const bundle = unique("runtime-bundle");
  const composition = unique("deployment-composition");
  const sourceConfig = unique("deployment-source");
  const runtimePolicy = unique("runtime-policy");
  const executorState = unique("executor-state");
  const releaseIntent = unique("release-intent");
  const candidateProof = unique("candidate-proof-verifier");
  const releaseEnvironment = unique("release-environment");
  const unit = unique("systemd-unit");
  const database = unique("runtime-sqlite");
  const main = unique("main-executable");
  const log = unique("runtime-log-window");
  const ready = artifactById.get(consumers[0]!.artifactId)!;
  const children = closure.artifactIds.map((id) => artifactById.get(id)!).filter((item) => artifactKind(item) === "child-executable");
  const loaded = closure.artifactIds.map((id) => artifactById.get(id)!).filter((item) => artifactKind(item) === "loaded-object");
  if (children.length === 0 || loaded.length === 0) throw new TypeError("consumer-lineage-runtime-denominator-missing");

  const has = (source: LegacyClosureRawArtifactV1, relation: LegacyClosureRawEdgeV1["relation"], target: LegacyClosureRawArtifactV1): boolean =>
    roleEdges.some((edge) => edge.sourceArtifactId === source.artifactId && edge.relation === relation && edge.targetArtifactId === target.artifactId);
  for (const [source, relation, target] of [
    [boundary, "binds", binding],
    [binding, "binds", approval],
    [approval, "binds", manifest],
    [manifest, "binds", bundle],
    [manifest, "binds", composition],
    [manifest, "binds", sourceConfig],
    [manifest, "binds", runtimePolicy],
    [manifest, "binds", executorState],
    [manifest, "binds", releaseIntent],
    [manifest, "binds", candidateProof],
    [manifest, "binds", releaseEnvironment],
    [manifest, "deploys", unit],
    [unit, "executes", main],
    [database, "emits", ready],
    [ready, "binds", main],
    [ready, "binds", bundle],
    [ready, "emits", log],
  ] as const) if (!has(source, relation, target)) throw new TypeError("consumer-lineage-required-edge-missing");
  const executableIds = new Set([main, ...children].map((item) => item.artifactId));
  const spawned = new Set<Hash>();
  const spawnQueue: Hash[] = [main.artifactId];
  while (spawnQueue.length > 0) {
    const parent = spawnQueue.shift()!;
    for (const edge of roleEdges) {
      if (edge.relation === "spawns" && edge.sourceArtifactId === parent && edge.targetArtifactId !== null
        && executableIds.has(edge.targetArtifactId) && !spawned.has(edge.targetArtifactId)) {
        spawned.add(edge.targetArtifactId);
        spawnQueue.push(edge.targetArtifactId);
      }
    }
  }
  if (children.some((child) => !spawned.has(child.artifactId))) throw new TypeError("consumer-lineage-child-edge-missing");
  for (const object of loaded) {
    if (![main, ...children].some((executable) => has(executable, "loads", object))) {
      throw new TypeError("consumer-lineage-loaded-object-edge-missing");
    }
  }
  for (const executable of [main, ...children]) {
    if (!loaded.some((object) => has(executable, "loads", object))) throw new TypeError("consumer-lineage-executable-loaded-object-missing");
  }

  const adjacency = new Map<Hash, Set<Hash>>(closure.artifactIds.map((id) => [id, new Set()]));
  for (const edge of roleEdges) {
    adjacency.get(edge.sourceArtifactId)!.add(edge.targetArtifactId!);
    adjacency.get(edge.targetArtifactId!)!.add(edge.sourceArtifactId);
  }
  const visited = new Set<Hash>();
  const queue: Hash[] = [consumers[0]!.artifactId];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (visited.has(current)) continue;
    visited.add(current);
    queue.push(...adjacency.get(current)!);
  }
  if (visited.size !== roleArtifacts.size) throw new TypeError("consumer-lineage-disconnected");
}

/** Live implementation: recompute solely from the architecture-neutral raw denominator. */
function recomputeLiveLegacyFacts(facts: LegacyAuthorityClosureFactsV1): LiveLegacyRecomputationV1 {
  for (const artifact of facts.denominator.artifacts) if (artifact.artifactId !== rawArtifactId(artifact)) throw new TypeError("raw-artifact-identity-mismatch");
  for (const edge of facts.denominator.edges) if (edge.edgeId !== rawEdgeId(edge)) throw new TypeError("raw-edge-identity-mismatch");
  for (const entrypoint of facts.denominator.entrypoints) if (entrypoint.entrypointId !== rawEntrypointId(entrypoint)) throw new TypeError("raw-entrypoint-identity-mismatch");
  const closureRoots = new Map<LegacyClosureRootRoleV1, Hash>();
  for (const closure of facts.denominator.closures) {
    const observedRoot = hashDomain("aloha/legacy-authority-closure/role-root/v2", {
      role: closure.role,
      entrypointIds: closure.entrypointIds,
      artifactIds: closure.artifactIds,
      edgeIds: closure.edgeIds,
    });
    if (closure.observedRoot !== observedRoot) throw new TypeError("raw-role-root-mismatch");
    closureRoots.set(closure.role, observedRoot);
  }
  if (closureRoots.size !== LEGACY_CLOSURE_ROOT_ROLES.length) throw new TypeError("raw-role-denominator-mismatch");
  for (const role of LEGACY_CLOSURE_ROOT_ROLES) {
    const root = closureRoots.get(role);
    if (root === undefined || facts.receipt[rootFieldByRole[role]] !== root) throw new TypeError(`raw-role-receipt-mismatch:${role}`);
  }
  const denominatorPayload = {
    artifacts: facts.denominator.artifacts,
    edges: facts.denominator.edges,
    entrypoints: facts.denominator.entrypoints,
    closures: facts.denominator.closures.map(({ factRefId: _factRefId, ...payload }) => payload),
  };
  const denominatorRoot = hashDomain("aloha/legacy-authority-closure/raw-denominator/v1", denominatorPayload);
  if (facts.denominator.denominatorId !== denominatorRoot || facts.receipt.rawDenominatorRoot !== denominatorRoot) throw new TypeError("raw-denominator-root-mismatch");
  const denominator = facts.denominator.closures.find((closure) => closure.role === "production-entrypoint-denominator");
  if (denominator === undefined || !same(denominator.entrypointIds, facts.denominator.entrypoints.map((item) => item.entrypointId)) || !same(denominator.artifactIds, facts.denominator.artifacts.map((item) => item.artifactId)) || !same(denominator.edgeIds, facts.denominator.edges.map((item) => item.edgeId))) throw new TypeError("entrypoint-denominator-mismatch");
  const unresolved = sortedLocators([
    ...facts.denominator.entrypoints.filter((item) => item.artifactId === null).map((item) => item.locator),
    ...facts.denominator.edges.filter((item) => item.targetArtifactId === null).map((item) => item.locator),
  ]);
  const oldRepository = sortedLocators(facts.denominator.artifacts.filter((item) => item.logicalKey.split("/")[0] === "reference").map((item) => item.locator));
  const forbiddenAuthority = sortedLocators(facts.denominator.artifacts.filter((item) => item.logicalKey.split("/")[1] === "legacy-shaped-authority").map((item) => item.locator));
  const compatibility = sortedLocators(facts.denominator.artifacts.filter((item) => item.logicalKey.split("/")[1] === "compatibility-facade-or-fallback").map((item) => item.locator));
  if (!same(facts.receipt.unresolvedEntrypointRefs, unresolved) || !same(facts.receipt.oldRepositoryLoadBearingRefs, oldRepository) || !same(facts.receipt.forbiddenAuthorityRefs, forbiddenAuthority) || !same(facts.receipt.compatibilityFacadeOrFallbackRefs, compatibility)) throw new TypeError("raw-derived-locator-mismatch");
  assertConnectedConsumerLineage(facts);
  return Object.freeze({ unresolved, oldRepository, forbiddenAuthority, compatibility });
}

function asLegacyFacts(value: unknown): LegacyAuthorityClosureFactsV1 {
  const candidate = asOne(value);
  if (candidate !== null && typeof candidate === "object" && !Array.isArray(candidate) && "aggregateId" in candidate) return decodeLegacyAuthorityZeroAggregateFacts(candidate as object).facts;
  return decodeLegacyAuthorityClosureFacts(candidate as object);
}

function evaluateLegacy(
  value: unknown,
  predicateId: LegacyZeroPredicateResultV1["predicateId"],
): LegacyZeroPredicateResultV1 {
  let facts: LegacyAuthorityClosureFactsV1;
  let derived: LiveLegacyRecomputationV1;
  try {
    facts = asLegacyFacts(value);
    derived = recomputeLiveLegacyFacts(facts);
  } catch {
    return Object.freeze({ predicateId, verdict: "invalid", reasons: one("malformed-fact", "$.predicateFacts"), receipt: null });
  }
  const refs = predicateId === "aloha.source-repository-production-closure-zero"
    ? derived.oldRepository
    : derived.forbiddenAuthority.concat(derived.compatibility);
  if (derived.unresolved.length !== 0) return Object.freeze({ predicateId, verdict: "invalid", reasons: one("malformed-fact", "$.denominator"), receipt: facts.receipt });
  if (refs.length !== 0) {
    return Object.freeze({
      predicateId,
      verdict: "fail",
      reasons: one(predicateId === "aloha.source-repository-production-closure-zero" ? "source-repository-violation" : "legacy-shaped-authority-violation", predicateId === "aloha.source-repository-production-closure-zero" ? "$.denominator.artifacts" : "$.denominator.artifacts"),
      receipt: facts.receipt,
    });
  }
  return Object.freeze({ predicateId, verdict: "pass", reasons: Object.freeze([]), receipt: facts.receipt });
}

export function evaluateSourceRepositoryProductionClosureZero(value: unknown): LegacyZeroPredicateResultV1 {
  return evaluateLegacy(value, "aloha.source-repository-production-closure-zero");
}

export function evaluateLegacyShapedAuthorityZero(value: unknown): LegacyZeroPredicateResultV1 {
  return evaluateLegacy(value, "aloha.legacy-shaped-authority-zero");
}

/** Aggregate is intentionally only the AND of the two independent leaves. */
export function evaluateLegacyAuthorityZeroAggregate(value: unknown): LegacyZeroAggregateResultV1 {
  let facts: LegacyAuthorityZeroAggregateFactsV1;
  try {
    facts = decodeLegacyAuthorityZeroAggregateFacts(asOne(value) as object);
  } catch {
    const invalidSource: LegacyZeroPredicateResultV1 = Object.freeze({ predicateId: "aloha.source-repository-production-closure-zero", verdict: "invalid", reasons: one("malformed-fact", "$.predicateFacts"), receipt: null });
    const invalidShaped: LegacyZeroPredicateResultV1 = Object.freeze({ predicateId: "aloha.legacy-shaped-authority-zero", verdict: "invalid", reasons: one("malformed-fact", "$.predicateFacts"), receipt: null });
    return Object.freeze({ verdict: "invalid", reasons: one("malformed-fact", "$.predicateFacts"), facts: null, source: invalidSource, shaped: invalidShaped });
  }
  const source = evaluateSourceRepositoryProductionClosureZero(facts.facts);
  const shaped = evaluateLegacyShapedAuthorityZero(facts.facts);
  const reasons = Object.freeze([...source.reasons, ...shaped.reasons]);
  const verdict: RuntimeAcceptancePredicateVerdict = source.verdict === "invalid" || shaped.verdict === "invalid"
    ? "invalid"
    : source.verdict === "fail" || shaped.verdict === "fail"
      ? "fail"
      : "pass";
  return Object.freeze({ verdict, reasons, facts, source, shaped });
}
